export const STUDY_GROUP_LINK_LABEL_MAX_LENGTH = 80
export const SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH = 120

export type StudyGroupLessonLinkSource = {
  online_url?: string | null
  online_url_secondary?: string | null
  online_url_label?: string | null
  online_url_secondary_label?: string | null
  conference_id?: string | null
  conference_access_code?: string | null
}

/** Plain access details, independent of a join URL; never infer a provider. */
export function normalizeScheduleConferenceAccess(value: Pick<StudyGroupLessonLinkSource, 'conference_id' | 'conference_access_code'>) {
  const normalize = (raw: unknown): string | null => {
    if (raw == null) return null
    if (typeof raw !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw)) throw new Error('Ідентифікатор і код конференції мають бути звичайним текстом без прихованих символів.')
    const text = raw.trim()
    if (Array.from(text).length > SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH) throw new Error(`Ідентифікатор і код конференції мають містити до ${SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH} символів.`)
    return text || null
  }
  return { conference_id: normalize(value.conference_id), conference_access_code: normalize(value.conference_access_code) }
}

export type StudyGroupLessonLink = { slot: 1 | 2; url: string; label: string }

export function safeLessonUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) ? url.href : null
  } catch {
    return null
  }
}

export function getStudyGroupLessonLinks(lesson: StudyGroupLessonLinkSource): StudyGroupLessonLink[] {
  const slots = [
    { slot: 1 as const, url: lesson.online_url, label: lesson.online_url_label },
    { slot: 2 as const, url: lesson.online_url_secondary, label: lesson.online_url_secondary_label },
  ]
  return slots.flatMap((link) => {
    const url = safeLessonUrl(link.url)
    return url ? [{ slot: link.slot, url, label: link.label?.trim() || `Посилання ${link.slot}` }] : []
  })
}
