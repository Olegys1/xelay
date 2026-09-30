import { supabase } from './supabase'

export type HomeworkAttachment = {
  storage_path: string
  file_name: string
  mime_type: string
  file_size: number
}

export const HOMEWORK_FILES_BUCKET = 'xelay-homework-files'
export const MAX_HOMEWORK_FILES = 10
export const MAX_HOMEWORK_LINKS = 10
export const MAX_HOMEWORK_FILE_BYTES = 20 * 1024 * 1024

const FILE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  zip: 'application/zip',
}

export const HOMEWORK_FILE_ACCEPT = Object.keys(FILE_MIME_TYPES).map(extension => `.${extension}`).join(',')

const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'text/x-csv'])
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,255}$/
const SAFE_PATH_PART = /^[A-Za-z0-9_-]+$/

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function acceptsMime(extension: string, mime: string): boolean {
  return mime === FILE_MIME_TYPES[extension]
    || (extension === 'csv' && CSV_MIME_TYPES.has(mime))
    || (extension === 'zip' && mime === 'application/x-zip-compressed')
}

function isSafeStoragePath(path: string): boolean {
  const parts = path.split('/')
  return parts.length === 3
    && SAFE_PATH_PART.test(parts[0])
    && SAFE_PATH_PART.test(parts[1])
    && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(parts[2])
    && parts[2].length <= 255
}

export function validateHomeworkFile(file: File): void {
  const extension = fileExtension(file.name)
  if (!SAFE_FILE_NAME.test(file.name) || !Object.prototype.hasOwnProperty.call(FILE_MIME_TYPES, extension)) {
    throw new Error('Оберіть файл PDF, Word, Excel, PowerPoint, TXT, CSV, JPG, PNG, WebP або ZIP. Назва має містити не більше 255 символів.')
  }

  const mime = file.type.trim().toLowerCase()
  if (mime && mime !== 'application/octet-stream' && !acceptsMime(extension, mime)) {
    throw new Error(`Тип файлу «${file.name}» не відповідає його розширенню. Оберіть інший файл.`)
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error(`Файл «${file.name}» порожній. Оберіть інший файл.`)
  }
  if (file.size > MAX_HOMEWORK_FILE_BYTES) {
    throw new Error(`Файл «${file.name}» завеликий. Максимальний розмір — 20 МБ.`)
  }
}

export function normalizeHomeworkLinks(values: string[]): string[] {
  const links = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new Error('Введіть повне посилання, що починається з https:// або http://.')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Посилання має починатися з https:// або http://.')
    }
    const normalized = url.href
    if (trimmed.length > 2048 || normalized.length > 2048) {
      throw new Error('Посилання завелике. Максимальна довжина — 2048 символів.')
    }
    links.add(normalized)
    if (links.size > MAX_HOMEWORK_LINKS) {
      throw new Error('До домашнього завдання можна додати щонайбільше 10 посилань.')
    }
  }
  return [...links]
}

export function getHomeworkLinks(item: { url?: string | null; resource_links?: unknown }): string[] {
  const candidates: unknown[] = [item.url, ...(Array.isArray(item.resource_links) ? item.resource_links : [])]
  const links = new Set<string>()
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    try {
      for (const link of normalizeHomeworkLinks([value])) links.add(link)
    } catch {
      continue
    }
    if (links.size === MAX_HOMEWORK_LINKS) break
  }
  return [...links]
}

export function getHomeworkAttachments(value: unknown): HomeworkAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: HomeworkAttachment[] = []
  const paths = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const item = candidate as Record<string, unknown>
    if (typeof item.storage_path !== 'string' || !isSafeStoragePath(item.storage_path)
      || typeof item.file_name !== 'string' || !SAFE_FILE_NAME.test(item.file_name)
      || typeof item.mime_type !== 'string' || item.mime_type.length > 120
      || !acceptsMime(fileExtension(item.file_name), item.mime_type)
      || typeof item.file_size !== 'number' || !Number.isSafeInteger(item.file_size)
      || item.file_size <= 0 || item.file_size > MAX_HOMEWORK_FILE_BYTES
      || paths.has(item.storage_path)) continue

    attachments.push({
      storage_path: item.storage_path,
      file_name: item.file_name,
      mime_type: item.mime_type,
      file_size: item.file_size,
    })
    paths.add(item.storage_path)
    if (attachments.length === MAX_HOMEWORK_FILES) break
  }
  return attachments
}

export function formatHomeworkFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б'
  if (bytes < 1024) return `${Math.round(bytes)} Б`
  const megabytes = bytes >= 1024 * 1024
  const value = bytes / (megabytes ? 1024 * 1024 : 1024)
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(value)} ${megabytes ? 'МБ' : 'КБ'}`
}

function asciiSafeFilename(name: string): string {
  const extension = fileExtension(name)
  const stem = name.slice(0, -(extension.length + 1))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '')
    .slice(0, 150) || 'file'
  return `${stem}.${extension}`
}

export async function uploadHomeworkFiles(
  groupId: string,
  userId: string,
  files: File[],
  onProgress?: (completed: number, total: number) => void,
): Promise<HomeworkAttachment[]> {
  if (files.length > MAX_HOMEWORK_FILES) {
    throw new Error('До домашнього завдання можна додати щонайбільше 10 файлів.')
  }
  for (const file of files) validateHomeworkFile(file)
  if (!files.length) return []
  if (!SAFE_PATH_PART.test(groupId) || !SAFE_PATH_PART.test(userId)) {
    throw new Error('Не вдалося визначити групу або обліковий запис для завантаження файлів.')
  }

  const uploaded: HomeworkAttachment[] = []
  const storage = supabase.storage.from(HOMEWORK_FILES_BUCKET)
  try {
    for (const file of files) {
      const path = `${groupId}/${userId}/${crypto.randomUUID()}-${asciiSafeFilename(file.name)}`
      const mime = FILE_MIME_TYPES[fileExtension(file.name)]
      const { error } = await storage.upload(path, file, { contentType: mime, upsert: false })
      if (error) throw error
      uploaded.push({ storage_path: path, file_name: file.name, mime_type: mime, file_size: file.size })
      onProgress?.(uploaded.length, files.length)
    }
    return uploaded
  } catch (cause) {
    console.error('Could not upload homework files:', cause)
    const uploadedPaths = uploaded.map(file => file.storage_path)
    const removed = await removeHomeworkFiles(uploadedPaths)
    const error = new Error(removed
      ? 'Не вдалося завантажити файли. Перевірте доступ до групи та спробуйте ще раз.'
      : 'Не вдалося завантажити файли й видалити частину тимчасових файлів. Спробуйте ще раз; для очищення може знадобитися допомога адміністратора.') as Error & { orphanedPaths?: string[] }
    if (!removed) error.orphanedPaths = uploadedPaths
    throw error
  }
}

export async function removeHomeworkFiles(paths: string[]): Promise<boolean> {
  const requested = [...new Set(paths)].sort()
  if (!requested.length) return true
  if (requested.some(path => !isSafeStoragePath(path))) {
    console.error('Could not remove homework files: invalid storage path.')
    return false
  }
  let complete = true
  // One object per request keeps Storage's locks from conflicting across files.
  for (const path of requested) {
    try {
      const { data, error } = await supabase.storage.from(HOMEWORK_FILES_BUCKET).remove([path])
      if (error) throw error
      if (!(data ?? []).some(file => file.name === path)) {
        console.error('Could not confirm removal of homework file:', path)
        complete = false
      }
    } catch (error) {
      console.error('Could not remove homework file:', error)
      complete = false
    }
  }
  return complete
}

export async function getHomeworkFileUrl(path: string, fileName: string): Promise<string> {
  if (!isSafeStoragePath(path) || !SAFE_FILE_NAME.test(fileName)) {
    throw new Error('Цей файл має некоректні дані. Зверніться до представника групи.')
  }
  try {
    const { data, error } = await supabase.storage.from(HOMEWORK_FILES_BUCKET)
      .createSignedUrl(path, 60, { download: fileName })
    if (error || !data?.signedUrl) throw error ?? new Error('Missing signed download URL')
    return data.signedUrl
  } catch (error) {
    console.error('Could not create homework file download URL:', error)
    throw new Error('Не вдалося завантажити файл. Перевірте доступ до групи та спробуйте ще раз.')
  }
}
