import { selectHomeDashboard, type HomeDashboardData, type HomeDashboardLesson, type HomeDashboardSelection } from './homeDashboardModel'
import { normalizeScheduleConferenceAccess, safeLessonUrl, type StudyGroupLessonLinkSource } from './studyGroupLinks'

type HomeConference = NonNullable<HomeDashboardLesson['conference']>

/** Only an explicitly supplied web URL can open a meeting. An identifier or
 * passcode never implies Zoom, Meet, or any other provider. */
function conferenceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return undefined
  const href = safeLessonUrl(value)
  if (!href) return undefined
  const url = new URL(href)
  return url.username || url.password ? undefined : href
}

function credential(value: unknown, field: 'conference_id' | 'conference_access_code'): string | undefined {
  if (typeof value !== 'string') return undefined
  try { return normalizeScheduleConferenceAccess({ [field]: value })[field] || undefined }
  catch { return undefined }
}

/** Revalidate display data at the join action as well as at its repository.
 * This function deliberately never accepts the lesson's internal group href. */
export function homeConferenceAccess(value?: HomeDashboardLesson['conference']): HomeConference | undefined {
  if (!value) return undefined
  const href = conferenceUrl(value.href)
  const meetingId = credential(value.meetingId, 'conference_id')
  const passcode = credential(value.passcode, 'conference_access_code')
  return href || meetingId || passcode ? { href, meetingId, passcode } : undefined
}

/** Copied lessons already contain their authorized inherited access tuple,
 * maintained by the schedule's server triggers. Read that exact row; matching
 * subjects by title or borrowing another group's link would leak access. */
export function homeLessonConference(row: StudyGroupLessonLinkSource): HomeConference | undefined {
  return homeConferenceAccess({
    href: conferenceUrl(row.online_url) || conferenceUrl(row.online_url_secondary),
    meetingId: row.conference_id || undefined,
    passcode: row.conference_access_code || undefined,
  })
}

/** An open access panel follows the currently visible role, group and date.
 * Changing context or losing a grant cannot leave a previous meeting visible. */
export function visibleHomeLessonConference(data: HomeDashboardData, selection: HomeDashboardSelection, lessonId: string) {
  if (data.status !== 'ready') return null
  const view = selectHomeDashboard(data, selection)
  const lesson = view.lessons.find(item => item.id === lessonId)
  const conference = homeConferenceAccess(lesson?.conference)
  return lesson && conference ? { lesson, conference } : null
}
