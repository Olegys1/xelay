import { supabase } from './supabase'
import { MAX_NEWS_ATTACHMENTS, MAX_NEWS_FILE_SIZE, MAX_NEWS_FILES_TOTAL_SIZE, NewsAttachment } from './news'

const NEWS_MEDIA_BUCKET = 'xelay-news-media'
const MAX_NEWS_IMAGE_SIZE = 10 * 1024 * 1024
const NEWS_IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
])

export const NEWS_IMAGE_ACCEPT = [...NEWS_IMAGE_EXTENSIONS.keys()].join(',')

export function validateNewsImage(file: File): void {
  if (!NEWS_IMAGE_EXTENSIONS.has(file.type)) {
    throw new Error('Оберіть фото у форматі JPEG, PNG, WebP, GIF або AVIF.')
  }
  if (file.size === 0) {
    throw new Error('Цей файл порожній. Оберіть інше фото.')
  }
  if (file.size > MAX_NEWS_IMAGE_SIZE) {
    throw new Error('Фото завелике. Максимальний розмір — 10 МБ.')
  }
}

export async function uploadNewsImage(userId: string, file: File): Promise<{ path: string }> {
  validateNewsImage(file)
  if (!userId) {
    throw new Error('Увійдіть в обліковий запис, щоб додати фото.')
  }

  const extension = NEWS_IMAGE_EXTENSIONS.get(file.type)
  const path = `${userId}/${crypto.randomUUID()}.${extension}`
  const storage = supabase.storage.from(NEWS_MEDIA_BUCKET)

  try {
    const { error } = await storage.upload(path, file, {
      contentType: file.type,
      upsert: false,
    })
    if (error) throw error

    return { path }
  } catch (error) {
    console.error('Could not upload news image:', error)
    throw new Error('Не вдалося завантажити фото. Спробуйте ще раз.')
  }
}

export async function removeNewsImage(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(NEWS_MEDIA_BUCKET).remove([path])
    if (error) console.error('Could not remove unused news image:', error)
  } catch (error) {
    console.error('Could not remove unused news image:', error)
  }
}

const NEWS_FILES_BUCKET = 'xelay-news-files'
const NEWS_FILE_MIMES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
}
export const NEWS_FILES_ACCEPT = Object.keys(NEWS_FILE_MIMES).map((extension) => `.${extension}`).join(',')

export function newsFileName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/g, '').trim()
  const extension = cleaned.match(/\.[a-z0-9]{1,10}$/i)?.[0] || ''
  return (cleaned.length > 180 && extension
    ? `${cleaned.slice(0, 180 - extension.length)}${extension}`
    : cleaned.slice(0, 180)) || 'Файл'
}

export function formatNewsFileSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} КБ` : `${(size / (1024 * 1024)).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} МБ`
}

function newsFileFormat(file: File): { extension: string; mime: string } {
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  const mime = NEWS_FILE_MIMES[extension]
  const aliases = extension === 'zip' ? ['application/x-zip-compressed', 'application/x-zip']
    : extension === 'csv' ? ['application/vnd.ms-excel', 'text/plain']
      : ['docx', 'xlsx', 'pptx'].includes(extension) ? ['application/zip', 'application/x-zip-compressed'] : []
  if (typeof mime !== 'string' || (file.type && file.type !== 'application/octet-stream' && file.type !== mime && !aliases.includes(file.type))) {
    throw new Error('Оберіть PDF, документ Word, Excel, PowerPoint, TXT, CSV, ZIP або фото JPEG, PNG, WebP, GIF чи AVIF.')
  }
  if (!file.size) throw new Error(`Файл «${newsFileName(file.name)}» порожній.`)
  if (file.size > MAX_NEWS_FILE_SIZE) throw new Error(`Файл «${newsFileName(file.name)}» завеликий. Максимальний розмір — 20 МБ.`)
  return { extension, mime }
}

export function validateNewsFiles(files: File[], existing: NewsAttachment[] = []): void {
  if (files.length + existing.length > MAX_NEWS_ATTACHMENTS) throw new Error(`Додайте не більше ${MAX_NEWS_ATTACHMENTS} файлів до однієї новини.`)
  files.forEach(newsFileFormat)
  const total = files.reduce((size, file) => size + file.size, 0) + existing.reduce((size, file) => size + file.file_size, 0)
  if (total > MAX_NEWS_FILES_TOTAL_SIZE) throw new Error('Загальний розмір вкладень має бути не більше 50 МБ.')
}

export async function uploadNewsFiles(userId: string, files: File[]): Promise<NewsAttachment[]> {
  validateNewsFiles(files)
  if (!userId) throw new Error('Увійдіть в обліковий запис, щоб додати файли.')
  const uploaded: NewsAttachment[] = []
  const attempted: string[] = []
  try {
    for (const file of files) {
      const { extension, mime } = newsFileFormat(file)
      const path = `${userId}/${crypto.randomUUID()}.${extension}`
      attempted.push(path)
      const { error } = await supabase.storage.from(NEWS_FILES_BUCKET).upload(path, file, { contentType: mime, upsert: false })
      if (error) throw error
      uploaded.push({ path, file_name: newsFileName(file.name), mime_type: mime, file_size: file.size })
    }
    return uploaded
  } catch (error) {
    await removeNewsFiles(attempted)
    console.error('Could not upload news attachments:', error)
    if (error && typeof error === 'object' && 'message' in error && String(error.message).includes('NEWS_FILE_STORAGE_QUOTA')) {
      throw new Error('Досягнуто ліміту вкладень у новинах: 200 МБ або 500 файлів для одного автора. Приберіть непотрібні вкладення або зверніться до підтримки.')
    }
    throw new Error('Не вдалося завантажити файли. Перевірте з’єднання та спробуйте ще раз.')
  }
}

// Retire unused UUID paths before Storage's separate permission and deletion steps.
// A lost save response cannot retire an object that was successfully attached.
export async function removeNewsFiles(paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    const claimed: string[] = []
    for (const path of new Set(paths)) {
      const { data, error } = await supabase.rpc('xelay_claim_news_file_cleanup', { p_path: path })
      if (error) console.error('Could not claim unused news attachment:', error)
      else if (data === true) claimed.push(path)
    }
    if (!claimed.length) return
    const { error } = await supabase.storage.from(NEWS_FILES_BUCKET).remove(claimed)
    if (error) console.error('Could not remove unused news attachments:', error)
  } catch (error) {
    console.error('Could not remove unused news attachments:', error)
  }
}

export async function createNewsFileDownloadUrl(attachment: NewsAttachment): Promise<string> {
  const { data, error } = await supabase.storage.from(NEWS_FILES_BUCKET).createSignedUrl(attachment.path, 60, { download: newsFileName(attachment.file_name) })
  if (error || !data?.signedUrl) {
    console.error('Could not open news attachment:', error)
    throw new Error('Не вдалося відкрити файл. Оновіть сторінку та спробуйте ще раз.')
  }
  return data.signedUrl
}
