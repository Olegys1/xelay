export const STUDY_GROUP_LINK_LABEL_MAX_LENGTH = 80
export const SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH = 120
export const STUDY_GROUP_LESSON_LINK_MAX_COUNT = 20
export const STUDY_GROUP_EXTRA_LINK_MAX_COUNT = STUDY_GROUP_LESSON_LINK_MAX_COUNT - 2
export type ScheduleExtraLink = { url: string; label: string }

export type StudyGroupLessonLinkSource = {
  online_url?: string | null
  online_url_secondary?: string | null
  online_url_label?: string | null
  online_url_secondary_label?: string | null
  online_links_extra?: unknown
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

export type StudyGroupLessonLink = { slot: number; url: string; label: string }

/** Validate editable rows before saving; never silently truncate a user's links. */
export function normalizeScheduleExtraLinks(value: unknown): ScheduleExtraLink[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > STUDY_GROUP_EXTRA_LINK_MAX_COUNT) throw new Error(`До заняття можна додати до ${STUDY_GROUP_LESSON_LINK_MAX_COUNT} посилань.`)
  return value.flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => key !== 'url' && key !== 'label')) throw new Error('Перевірте додаткові посилання на заняття.')
    const { url: rawUrl, label: rawLabel } = row as { url?: unknown; label?: unknown }
    if (typeof rawUrl !== 'string' || (rawLabel != null && typeof rawLabel !== 'string') || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(rawUrl + (rawLabel || ''))) throw new Error('Посилання та його назва мають бути звичайним текстом без прихованих символів.')
    const text = rawUrl.trim(), label = (rawLabel as string | undefined)?.trim() || ''
    if (!text && !label) return []
    const url = safeLessonUrl(text)
    if (!url || url.length > 2000 || new URL(url).username || new URL(url).password) throw new Error('Вкажіть коректне додаткове посилання http:// або https:// без логіна й пароля в адресі.')
    if (Array.from(label).length > STUDY_GROUP_LINK_LABEL_MAX_LENGTH) throw new Error(`Назва посилання має містити до ${STUDY_GROUP_LINK_LABEL_MAX_LENGTH} символів.`)
    return [{ url, label }]
  })
}

/** Defensive rendering must ignore malformed older/cache data without hiding
 * the two established links or conference credentials. */
export function displayScheduleExtraLinks(value: unknown): ScheduleExtraLink[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, STUDY_GROUP_EXTRA_LINK_MAX_COUNT).flatMap(row => {
    try { return normalizeScheduleExtraLinks([row]) } catch { return [] }
  })
}

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
    { slot: 1, url: lesson.online_url, label: lesson.online_url_label },
    { slot: 2, url: lesson.online_url_secondary, label: lesson.online_url_secondary_label },
    ...displayScheduleExtraLinks(lesson.online_links_extra).map((link, index) => ({ slot: index + 3, ...link })),
  ]
  return slots.flatMap((link) => {
    const url = safeLessonUrl(link.url)
    return url ? [{ slot: link.slot, url, label: link.label?.trim() || `Посилання ${link.slot}` }] : []
  })
}
