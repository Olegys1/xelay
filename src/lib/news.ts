export type NewsPostType = 'news' | 'event' | 'opportunity' | 'announcement'

export const NEWS_TYPE_LABELS: Record<NewsPostType, string> = {
  news: 'Новина',
  event: 'Подія',
  opportunity: 'Можливість',
  announcement: 'Оголошення',
}

export interface NewsPost {
  id: string
  university_id: string
  academic_unit_id: string
  post_type: NewsPostType
  title: string
  excerpt: string
  body: string
  image_url: string | null
  image_path?: string | null
  link_url?: string | null
  event_starts_at: string | null
  event_location: string | null
  organizer: string | null
  registration_url: string | null
  status: 'draft' | 'published' | 'archived'
  is_pinned: boolean
  published_by: string
  published_at: string
}

export function getNewsLink(value?: string | null): string | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

export function validateNewsLink(value: string): string | null {
  if (!value.trim()) return null
  const url = getNewsLink(value)
  if (!url || url.length > 2048) {
    throw new Error('Вкажіть коректне посилання, що починається з https:// або http:// (до 2048 символів).')
  }
  return url
}

export function toNewsDateTimeInput(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function parseNewsDateTime(value: string): string {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || toNewsDateTimeInput(date.toISOString()) !== value) {
    throw new Error('Оберіть коректну дату й час.')
  }
  return date.toISOString()
}

export function formatNewsDate(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value))
}
