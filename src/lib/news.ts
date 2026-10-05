export type NewsPostType = 'news' | 'event' | 'opportunity' | 'announcement'
export type NewsScope = 'faculty' | 'university'

export type NewsLink = { label: string; url: string }
export type NewsAttachment = { path: string; file_name: string; mime_type: string; file_size: number }
export const MAX_NEWS_LINKS = 10
export const MAX_NEWS_ATTACHMENTS = 10
export const MAX_NEWS_FILE_SIZE = 20 * 1024 * 1024
export const MAX_NEWS_FILES_TOTAL_SIZE = 50 * 1024 * 1024

export function getUniversityNewsLabel(university?: { slug?: string; name?: string } | null): string {
  return university?.slug === 'knu' ? 'Загальні новини КНУ' : 'Загальні новини університету'
}

export const NEWS_TYPE_LABELS: Record<NewsPostType, string> = {
  news: 'Новина',
  event: 'Подія',
  opportunity: 'Можливість',
  announcement: 'Оголошення',
}

export interface NewsPost {
  id: string
  university_id: string
  academic_unit_id: string | null
  post_type: NewsPostType
  title: string
  excerpt: string
  body: string
  image_url: string | null
  image_path?: string | null
  link_url?: string | null
  links?: NewsLink[]
  attachments?: NewsAttachment[]
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

export function validateNewsLinks(links: NewsLink[]): NewsLink[] {
  if (links.length > MAX_NEWS_LINKS) throw new Error(`Додайте не більше ${MAX_NEWS_LINKS} посилань.`)
  return links.flatMap((link, index) => {
    const label = link.label.trim()
    const value = link.url.trim()
    if (!label && !value) return []
    if (label.length > 120) throw new Error(`Назва посилання №${index + 1} має містити до 120 символів.`)
    const url = validateNewsLink(value)
    if (!url) throw new Error(`Вкажіть адресу посилання №${index + 1} або видаліть його.`)
    return [{ label, url }]
  })
}

export function getNewsLinks(resource: { links?: unknown; link_url?: string | null }): NewsLink[] {
  const links: NewsLink[] = Array.isArray(resource.links) ? resource.links.flatMap((link) => {
    if (!link || typeof link !== 'object' || typeof link.url !== 'string' || typeof link.label !== 'string') return []
    const url = getNewsLink(link.url)
    if (!url || url.length > 2048 || link.label.length > 120) return []
    return [{ label: link.label.trim(), url }]
  }).slice(0, MAX_NEWS_LINKS) : []
  const legacyUrl = getNewsLink(resource.link_url)
  return links.length ? links : legacyUrl && legacyUrl.length <= 2048 ? [{ label: 'Відео або матеріали', url: legacyUrl }] : []
}

export function getNewsAttachments(value: unknown): NewsAttachment[] {
  if (!Array.isArray(value)) return []
  return value.filter((attachment): attachment is NewsAttachment => (
    attachment !== null && typeof attachment === 'object'
    && typeof attachment.path === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpe?g|png|webp|gif|avif|pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/.test(attachment.path)
    && typeof attachment.file_name === 'string' && attachment.file_name.length > 0 && attachment.file_name.length <= 180
    && typeof attachment.mime_type === 'string'
    && Number.isSafeInteger(attachment.file_size) && attachment.file_size > 0 && attachment.file_size <= MAX_NEWS_FILE_SIZE
  )).slice(0, MAX_NEWS_ATTACHMENTS)
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
