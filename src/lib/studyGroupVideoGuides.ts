import groupGuideVideo from '../assets/guides/study-group-guide-20261017.mp4'
import groupGuidePoster from '../assets/guides/study-group-guide-20261017.webp'

export type StudyGroupGuideTarget = 'schedule' | 'seminars' | 'timetable' | 'materials' | 'members' | 'deputies'

export type StudyGroupVideoGuide = {
  id: string
  title: string
  description: string
  videoUrl: string
  posterUrl?: string
}

// One curated catalogue is shared by representatives and deputies in all groups.
// Vite publishes versioned media assets; the player loads the video only on demand.
export const STUDY_GROUP_VIDEO_GUIDES: readonly StudyGroupVideoGuide[] = [{
  id: 'study-group-guide-1-20261017',
  title: 'Гайд 1. Робота з навчальною групою',
  description: 'Покрокове відео від команди Xelay для старост і заступників. Зупиняйте перегляд і повертайтеся до потрібного моменту. Тривалість — 6 хв 13 с.',
  videoUrl: groupGuideVideo,
  posterUrl: groupGuidePoster,
}]

export function canViewStudyGroupVideoGuides({ groupId, loadedGroupId, userId, representativeId, memberStatus, approvedDeputyIds }: {
  groupId: string; loadedGroupId?: string; userId?: string; representativeId?: string
  memberStatus?: string; approvedDeputyIds: readonly string[]
}): boolean {
  if (!groupId || loadedGroupId !== groupId || !userId) return false
  if (userId === representativeId) return true
  return memberStatus === 'accepted' && approvedDeputyIds.includes(userId)
}

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
