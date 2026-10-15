export const STUDY_GROUP_LINK_LABEL_MAX_LENGTH = 80

export type StudyGroupLessonLinkSource = {
  online_url?: string | null
  online_url_secondary?: string | null
  online_url_label?: string | null
  online_url_secondary_label?: string | null
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
