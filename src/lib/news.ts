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
  event_starts_at: string | null
  event_location: string | null
  organizer: string | null
  registration_url: string | null
  status: 'draft' | 'published' | 'archived'
  is_pinned: boolean
  published_by: string
  published_at: string
}

export function formatNewsDate(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value))
}
