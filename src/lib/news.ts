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

export function formatNewsDate(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value))
}
