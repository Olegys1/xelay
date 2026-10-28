import { homeKyivClock, homeShiftDate } from './homeDashboardModel'
import type { HomeDashboardData, HomeDashboardGroup, HomeDashboardLesson, HomeDashboardPermission } from './homeDashboardModel'
import type { TeachingCalendarLesson, TeachingCourse, TeachingPermission, TeachingRepository, TeachingWorkspaceData } from './teaching'
import type { HomeTeachingSummary } from './homeDashboardRepository'

export type HomeTeacherDashboardSlice = Pick<HomeDashboardData, 'groups' | 'lessons' | 'tasks' | 'updates' | 'publications' | 'teachingVerified'> & {
  /** Existing read APIs expose grade enquiries, not a submission-review total. */
  reviewCountsAvailable: boolean
  warnings: string[]
}

export type HomeTeacherDashboardInput = {
  userId: string
  clockIso: string
  repository?: TeachingRepository
  /** Reuse an already loaded workspace only within this authenticated account. */
  workspace?: TeachingWorkspaceData
  /** Optional one-call summary shared with the learning-context loader. */
  summary?: HomeTeachingSummary | null
  signal?: AbortSignal
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const teachingActions: TeachingPermission[] = ['materials', 'assignments', 'grades', 'manage']
const typeLabels = {
  lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне', lab: 'Лабораторна',
  makeup: 'Відпрацювання', replacement: 'Заміна', module: 'Модуль',
  final_assessment: 'Підсумкова робота', test: 'Контрольна робота', other: 'Заняття',
} as const

type Grant = { course: TeachingCourse; group: HomeDashboardGroup; permissions: TeachingPermission[] }
const grantKey = (courseId: string, groupId: string) => `${courseId}:${groupId}`
const teacherHref = (courseId: string, groupId: string, home: 'calendar' | 'assignments' | 'requests' | 'scheduled' = 'assignments', date?: string) => home === 'assignments'
  ? `/groups/${groupId}?teaching=${courseId}&home=assignments`
  : `/teaching?course=${courseId}&group=${groupId}&home=${home}${date ? `&date=${date}` : ''}`
const emptySlice = (teachingVerified: boolean): HomeTeacherDashboardSlice => ({ groups: [], lessons: [], tasks: [], updates: [], publications: [], teachingVerified, reviewCountsAvailable: false, warnings: [] })

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Home dashboard loading was cancelled', 'AbortError')
}

function isDate(date: string): boolean {
  try { return homeShiftDate(date, 0) === date } catch { return false }
}

function timestamp(value?: string | null): number | null {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function time(value: string): string | null {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(value) ? value.slice(0, 5) : null
}

function mapLesson(row: TeachingCalendarLesson, grant: Grant, from: string, to: string): HomeDashboardLesson | null {
  // The legacy calendar type still permits seminar allocation rows. Only the
  // group's actual timetable is allowed on a teacher's personal home screen.
  if (row.source !== 'timetable' || !uuidPattern.test(row.id) || !isDate(row.lesson_date)
    || row.lesson_date < from || row.lesson_date > to
    || row.lesson_date < grant.course.starts_on || row.lesson_date > grant.course.ends_on) return null
  const startsAt = time(row.starts_at), endsAt = time(row.ends_at)
  if (!startsAt || !endsAt || startsAt >= endsAt) return null
  return {
    id: `teaching:${row.course_id}:${row.group_id}:${row.id}:${row.lesson_date}`,
    groupId: row.group_id,
    // A course is an exact subject/semester grant, including when a group link
    // has no legacy seminar-subject id. Do not infer authority from its title.
    subjectId: row.course_id,
    subject: row.subject_name || grant.course.title,
    date: row.lesson_date, startsAt, endsAt,
    type: typeLabels[row.lesson_type as keyof typeof typeLabels] || 'Заняття',
    ...(row.location?.trim() ? { room: row.location.trim() } : {}),
    ...(row.teacher_name?.trim() ? { teacherName: row.teacher_name.trim() } : {}),
    href: teacherHref(row.course_id, row.group_id, 'calendar', row.lesson_date),
    hrefByContext: { teaching: teacherHref(row.course_id, row.group_id, 'calendar', row.lesson_date) },
  }
}

/** Read-only adapter. All source RPCs already enforce teaching access; the
 * intersection below also discards stale/foreign group-course results before
 * returning a small display projection. No roster, works, seminar questions,
 * teams, reservations, materials' contents or draft grades are requested. */
export async function loadTeacherHomeDashboard(input: HomeTeacherDashboardInput): Promise<HomeTeacherDashboardSlice> {
  if (!input.userId.trim()) throw new Error('HOME_ACCOUNT_REQUIRED')
  const clock = homeKyivClock(input.clockIso)
  assertActive(input.signal)
  const repository = input.repository || (await import('./teaching')).supabaseTeachingRepository
  assertActive(input.signal)
  const workspace = input.workspace || await repository.workspace()
  assertActive(input.signal)
  const verified = workspace.teacher_status?.verified === true && workspace.teacher_status.has_current_access !== false
  if (!verified) return emptySlice(false)

  const academicYear = Number(clock.date.slice(0, 4)) - (Number(clock.date.slice(5, 7)) < 9 ? 1 : 0)
  const courses = new Map((workspace.courses || []).filter(course => uuidPattern.test(course.id)
    && !course.archived_at && isDate(course.starts_on) && isDate(course.ends_on)
    && course.starts_on <= course.ends_on && course.permissions?.some(permission => teachingActions.includes(permission)))
    .map(course => [course.id, course]))
  const result = emptySlice(true)
  const groups = new Map<string, HomeDashboardGroup>()
  const grants = new Map<string, Grant>()

  // classroom_workspace returns only accepted course/group links in the
  // caller's selected colleague scope. The broad group directory is not a grant.
  for (const classroom of workspace.classrooms || []) {
    if (!uuidPattern.test(classroom.group_id)) continue
    for (const link of classroom.courses || []) {
      const course = courses.get(link.course_id)
      if (link.status !== 'accepted' || !course) continue
      const permissions = course.permissions.filter(permission => teachingActions.includes(permission))
      if (!permissions.length) continue
      let group = groups.get(classroom.group_id)
      if (!group) {
        group = {
          id: classroom.group_id, name: classroom.group_name, program: classroom.specialty || '',
          studyYear: Number.isInteger(classroom.study_year) && (classroom.study_year || 0) > 0 ? classroom.study_year! : 0,
          academicYear: `${academicYear} / ${academicYear + 1}`, status: 'accepted', learning: false,
          teachingSubjectIds: [], gradingSubjectIds: [], permissions: [],
        }
        groups.set(group.id, group)
      }
      if (!group.teachingSubjectIds.includes(course.id)) group.teachingSubjectIds.push(course.id)
      if (permissions.includes('grades') && !group.gradingSubjectIds.includes(course.id)) group.gradingSubjectIds.push(course.id)
      const actions = permissions.filter((permission): permission is 'assignments' | 'materials' | 'grades' => permission !== 'manage')
      group.permissions = [...new Set<HomeDashboardPermission>([...group.permissions, ...actions])]
      grants.set(grantKey(course.id, group.id), { course, group, permissions })
    }
  }
  result.groups = [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'uk'))
  if (!grants.size) return result

  const weekday = new Date(`${clock.date}T12:00:00Z`).getUTCDay()
  const from = homeShiftDate(clock.date, -((weekday + 6) % 7))
  // Current calendar week plus enough future dates for the nearest-day view;
  // never exceeds the existing calendar RPC's 30-day range limit.
  const to = homeShiftDate(clock.date, 15)
  const canPublish = [...grants.values()].some(grant => grant.permissions.some(permission => permission === 'materials' || permission === 'assignments'))
  const canGrade = [...grants.values()].some(grant => grant.permissions.includes('grades'))
  const [calendar, scheduled, enquiries] = await Promise.all([
    repository.teacherCalendar(from, to),
    canPublish ? repository.scheduledItems() : Promise.resolve({ items: [] }),
    canGrade ? repository.gradeRequests() : Promise.resolve({ requests: [] }),
  ])
  assertActive(input.signal)
  const seenLessons = new Set<string>()
  for (const row of calendar.lessons || []) {
    const grant = grants.get(grantKey(row.course_id, row.group_id))
    if (!grant) continue
    const lesson = mapLesson(row, grant, from, to)
    if (lesson && !seenLessons.has(lesson.id)) { seenLessons.add(lesson.id); result.lessons.push(lesson) }
  }
  result.lessons.sort((left, right) => `${left.date}:${left.startsAt}:${left.id}`.localeCompare(`${right.date}:${right.startsAt}:${right.id}`))

  const seenRequests = new Set<string>()
  for (const request of enquiries.requests || []) {
    const grant = grants.get(grantKey(request.course_id, request.group_id))
    if (!grant || !grant.permissions.includes('grades') || request.status !== 'open'
      || request.can_manage !== true || request.can_resolve !== true || !uuidPattern.test(request.id) || seenRequests.has(request.id)) continue
    seenRequests.add(request.id)
    result.tasks.push({
      id: `teaching-grade-request:${request.id}`, groupId: request.group_id,
      subjectId: request.course_id, subject: grant.course.title,
      title: `${request.student_name || 'Студент'} уточнює результат`,
      description: request.message || request.activity_title || 'Запит щодо опублікованого результату.',
      kind: 'grade-request', audience: 'teaching', status: 'open',
      dueAt: null, href: teacherHref(request.course_id, request.group_id, 'requests'),
      actionLabel: 'Переглянути запити', requiredPermission: 'grades', count: 1,
    })
  }

  if (input.summary) {
    const seenReviews = new Set<string>()
    if (!Array.isArray(input.summary.teacher_reviews)) throw new Error('HOME_TEACHING_SUMMARY_INVALID')
    result.reviewCountsAvailable = true
    for (const review of input.summary.teacher_reviews) {
      const grant = grants.get(grantKey(review.course_id, review.group_id))
      if (!grant || !grant.permissions.some(permission => permission === 'assignments' || permission === 'grades')
        || !uuidPattern.test(review.item_id) || !Number.isSafeInteger(review.submitted_count) || review.submitted_count < 0
        || !Number.isSafeInteger(review.pending_count) || review.pending_count < review.submitted_count) continue
      const grading = grant.permissions.includes('grades')
      const count = grading ? review.pending_count : review.submitted_count
      const id = `teaching-review:${review.item_id}:${review.group_id}`
      if (!count || seenReviews.has(id)) continue
      seenReviews.add(id)
      const ungraded = grading && Number.isSafeInteger(review.ungraded_count) && (review.ungraded_count || 0) > 0
        ? ` Без опублікованої оцінки: ${review.ungraded_count}.` : ''
      result.tasks.unshift({
        id, groupId: review.group_id, subjectId: review.course_id, subject: grant.course.title,
        title: review.title, description: `Надісланих робіт на перевірку: ${review.submitted_count}.${ungraded}`,
        kind: 'review', audience: 'teaching', status: 'open', count, dueAt: null,
        href: teacherHref(review.course_id, review.group_id), actionLabel: 'Переглянути роботи',
        requiredPermission: grading ? 'grades' : 'assignments',
      })
    }
  } else result.warnings.push('Черга зданих робіт тимчасово недоступна.')

  const seenPublications = new Set<string>()
  for (const publication of scheduled.items || []) {
    const publishAt = timestamp(publication.publish_at)
    if (!uuidPattern.test(publication.id) || publication.status !== 'scheduled'
      || (publication.kind !== 'assignment' && publication.kind !== 'material') || publishAt === null || publishAt <= Date.parse(input.clockIso)) continue
    for (const target of publication.targets || []) {
      const grant = grants.get(grantKey(publication.course_id, target.group_id))
      const required = publication.kind === 'assignment' ? 'assignments' : 'materials'
      const id = `teaching-publication:${publication.id}:${target.group_id}`
      if (!grant || !grant.permissions.includes(required) || seenPublications.has(id)) continue
      seenPublications.add(id)
      result.publications.push({ id, groupId: target.group_id, subjectId: publication.course_id,
        title: publication.title, kind: publication.kind, publishAt: publication.publish_at!,
        href: teacherHref(publication.course_id, target.group_id, 'scheduled'),
      })
    }
  }
  result.publications.sort((left, right) => Date.parse(left.publishAt) - Date.parse(right.publishAt) || left.id.localeCompare(right.id))
  return result
}
