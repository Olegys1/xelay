export type StudyGroupGuideTarget = 'schedule' | 'seminars' | 'timetable' | 'materials' | 'members' | 'deputies'

export type StudyGroupVideoGuide = {
  id: string
  title: string
  description: string
  videoUrl: string
  posterUrl?: string
}

// One curated catalogue is shared by the headmen of all study groups.
// Add the approved video here when it is ready for publication.
export const STUDY_GROUP_VIDEO_GUIDES: readonly StudyGroupVideoGuide[] = []

export function safeStudyGroupGuideMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!url || /[\\\u0000-\u001f\u007f]/.test(url)) return null
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password
      ? parsed.href : null
  } catch {
    return null
  }
}
