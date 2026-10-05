import { supabase } from './supabase'

export type MaterialAttachment = { path: string; file_name: string; mime_type: string; file_size: number }
export type MaterialLink = { label: string; url: string }

export const MAX_MATERIAL_FILES = 10
export const MAX_MATERIAL_LINKS = 10
export const MAX_MATERIAL_FILE_SIZE = 50 * 1024 * 1024
export const MAX_MATERIAL_FILES_TOTAL_SIZE = 200 * 1024 * 1024

const MATERIAL_FILES_BUCKET = 'xelay-study-materials'
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, 'i')
const MATERIAL_PATH_REGEX = new RegExp(`^${UUID_PATTERN}/${UUID_PATTERN}/${UUID_PATTERN}\\.([a-z0-9]+)$`)
const MATERIAL_FILE_MIMES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}
const MATERIAL_FILE_MIME_ALIASES: Record<string, readonly string[]> = {
  zip: ['application/x-zip-compressed', 'application/x-zip'],
  csv: ['application/vnd.ms-excel', 'text/plain'],
  docx: ['application/zip', 'application/x-zip-compressed'],
  xlsx: ['application/zip', 'application/x-zip-compressed'],
  pptx: ['application/zip', 'application/x-zip-compressed'],
  jpg: ['image/jpg', 'image/pjpeg'], jpeg: ['image/jpg', 'image/pjpeg'],
  mp3: ['audio/mp3', 'audio/x-mp3', 'audio/x-mpeg'],
  wav: ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  m4a: ['audio/x-m4a', 'video/mp4'],
  ogg: ['application/ogg'],
  mp4: ['application/mp4'], webm: ['audio/webm'],
  mov: ['video/x-quicktime'],
}
export const MATERIAL_FILES_ACCEPT = Object.keys(MATERIAL_FILE_MIMES).map((extension) => `.${extension}`).join(',')

function fileMime(extension: string): string | null {
  return Object.prototype.hasOwnProperty.call(MATERIAL_FILE_MIMES, extension) ? MATERIAL_FILE_MIMES[extension] : null
}

export function materialFileName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f/\\\u202a-\u202e\u2066-\u2069]/g, '').trim()
  const extension = cleaned.match(/\.[a-z0-9]{1,10}$/i)?.[0] || ''
  return (cleaned.length > 180 && extension
    ? `${cleaned.slice(0, 180 - extension.length)}${extension}`
    : cleaned.slice(0, 180)) || 'Файл'
}

export function formatMaterialFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 КБ'
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} КБ`
    : `${(size / (1024 * 1024)).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} МБ`
}

function materialFileFormat(file: File): { extension: string; mime: string } {
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() || ''
  const mime = fileMime(extension)
  const providedMime = file.type.toLowerCase().split(';', 1)[0].trim()
  const aliases = Object.prototype.hasOwnProperty.call(MATERIAL_FILE_MIME_ALIASES, extension) ? MATERIAL_FILE_MIME_ALIASES[extension] : []
  if (!mime || (providedMime && providedMime !== 'application/octet-stream' && providedMime !== mime && !aliases.includes(providedMime))) {
    throw new Error('Оберіть PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP, фото або аудіо чи відео у підтримуваному форматі.')
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`Файл «${materialFileName(file.name)}» порожній.`)
  if (file.size > MAX_MATERIAL_FILE_SIZE) throw new Error(`Файл «${materialFileName(file.name)}» завеликий. Максимальний розмір — 50 МБ.`)
  return { extension, mime }
}

export function getMaterialAttachments(value: unknown): MaterialAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: MaterialAttachment[] = []
  const seen = new Set<string>()
  let total = 0
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.path !== 'string' || typeof candidate.file_name !== 'string'
      || typeof candidate.mime_type !== 'string' || !Number.isSafeInteger(candidate.file_size)
      || candidate.file_size <= 0 || candidate.file_size > MAX_MATERIAL_FILE_SIZE) continue
    const extension = candidate.path.match(MATERIAL_PATH_REGEX)?.[1]
    const nameExtension = candidate.file_name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase()
    if (!extension || fileMime(extension) !== candidate.mime_type || !nameExtension
      || fileMime(nameExtension) !== candidate.mime_type || candidate.file_name !== materialFileName(candidate.file_name)
      || seen.has(candidate.path) || total + candidate.file_size > MAX_MATERIAL_FILES_TOTAL_SIZE) continue
    attachments.push({ path: candidate.path, file_name: candidate.file_name, mime_type: candidate.mime_type, file_size: candidate.file_size })
    seen.add(candidate.path)
    total += candidate.file_size
    if (attachments.length >= MAX_MATERIAL_FILES) break
  }
  return attachments
}

export function validateMaterialFiles(files: File[], existing: MaterialAttachment[] = []): void {
  if (files.length + existing.length > MAX_MATERIAL_FILES) throw new Error(`Додайте не більше ${MAX_MATERIAL_FILES} файлів до одного матеріалу.`)
  if (getMaterialAttachments(existing).length !== existing.length) throw new Error('Не вдалося перевірити поточні вкладення. Оновіть сторінку та спробуйте ще раз.')
  files.forEach(materialFileFormat)
  const total = files.reduce((size, file) => size + file.size, 0) + existing.reduce((size, file) => size + file.file_size, 0)
  if (total > MAX_MATERIAL_FILES_TOTAL_SIZE) throw new Error('Загальний розмір вкладень має бути не більше 200 МБ.')
}

function materialLinkUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null
  } catch {
    return null
  }
}

export function validateMaterialLinks(links: MaterialLink[]): MaterialLink[] {
  if (links.length > MAX_MATERIAL_LINKS) throw new Error(`Додайте не більше ${MAX_MATERIAL_LINKS} посилань.`)
  return links.flatMap((link, index) => {
    const label = link.label.trim()
    const value = link.url.trim()
    if (!label && !value) return []
    if (label.length > 120) throw new Error(`Назва посилання №${index + 1} має містити до 120 символів.`)
    const url = materialLinkUrl(value)
    if (!url) throw new Error(`Вкажіть коректну адресу посилання №${index + 1} з https:// або http://, до 2048 символів, або видаліть його.`)
    return [{ label, url }]
  })
}

export function getMaterialLinks(value: unknown): MaterialLink[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.label !== 'string'
      || typeof candidate.url !== 'string' || candidate.label.trim().length > 120) return []
    const url = materialLinkUrl(candidate.url)
    return url ? [{ label: candidate.label.trim(), url }] : []
  }).slice(0, MAX_MATERIAL_LINKS)
}

function materialPathInGroup(groupId: string, path: string): boolean {
  return MATERIAL_PATH_REGEX.test(path) && Boolean(fileMime(path.match(MATERIAL_PATH_REGEX)?.[1] || '')) && path.startsWith(`${groupId}/`)
}

export async function uploadMaterialFiles(groupId: string, userId: string, files: File[]): Promise<MaterialAttachment[]> {
  validateMaterialFiles(files)
  if (!UUID_REGEX.test(groupId)) throw new Error('Оберіть навчальну групу, щоб додати файли.')
  if (!UUID_REGEX.test(userId)) throw new Error('Увійдіть в обліковий запис, щоб додати файли.')
  const group = groupId.toLowerCase()
  const user = userId.toLowerCase()
  const uploaded: MaterialAttachment[] = []
  const attempted: string[] = []
  try {
    for (const file of files) {
      const { extension, mime } = materialFileFormat(file)
      const path = `${group}/${user}/${crypto.randomUUID()}.${extension}`
      attempted.push(path)
      const { error } = await supabase.storage.from(MATERIAL_FILES_BUCKET).upload(path, file, { contentType: mime, upsert: false })
      if (error) throw error
      uploaded.push({ path, file_name: materialFileName(file.name), mime_type: mime, file_size: file.size })
    }
    return uploaded
  } catch (error) {
    await removeMaterialFiles(group, attempted)
    console.error('Could not upload study group material files:', error)
    if (error && typeof error === 'object' && 'message' in error && String(error.message).includes('MATERIAL_FILE_STORAGE_QUOTA')) {
      throw new Error('Досягнуто ліміту матеріалів: 1 ГБ або 500 файлів для одного автора. Приберіть непотрібні вкладення або зверніться до підтримки.')
    }
    throw new Error('Не вдалося завантажити файли. Перевірте з’єднання та спробуйте ще раз.')
  }
}

const removalQueues = new Map<string, Promise<void>>()
const cleanupRequests = new Map<string, Promise<void>>()

// The server retires an unused path before Storage's separate permission and
// byte-removal steps. A lost save response cannot retire an attached file.
export async function removeMaterialFiles(groupId: string, paths: string[]): Promise<void> {
  if (!UUID_REGEX.test(groupId) || !paths.length) return
  const group = groupId.toLowerCase()
  const safePaths = [...new Set(paths)].filter((path) => typeof path === 'string' && materialPathInGroup(group, path)).sort()
  if (!safePaths.length) return
  const previous = removalQueues.get(group) || Promise.resolve()
  const pending = previous.then(async () => {
    for (const path of safePaths) {
      try {
        const { data, error } = await supabase.rpc('xelay_claim_material_file_cleanup', { p_group_id: group, p_path: path })
        if (error) {
          console.error('Could not claim unused study group material file:', error)
          continue
        }
        if (data !== true) continue
        const { error: removeError } = await supabase.storage.from(MATERIAL_FILES_BUCKET).remove([path])
        if (removeError) console.error('Could not remove unused study group material file:', removeError)
      } catch (error) {
        console.error('Could not remove unused study group material file:', error)
      }
    }
  }).catch((error) => { console.error('Could not clean study group material files:', error) })
  removalQueues.set(group, pending)
  try { await pending }
  finally { if (removalQueues.get(group) === pending) removalQueues.delete(group) }
}

export async function cleanupMaterialFiles(groupId: string): Promise<void> {
  if (!UUID_REGEX.test(groupId)) return
  const group = groupId.toLowerCase()
  const existing = cleanupRequests.get(group)
  if (existing) return existing
  const pending = (async () => {
    try {
      const { data, error } = await supabase.rpc('xelay_material_file_cleanup_paths', { p_group_id: group })
      if (error) {
        console.error('Could not list study group material files for cleanup:', error)
        return
      }
      if (!Array.isArray(data)) {
        console.error('Study group material cleanup returned an unexpected response.')
        return
      }
      const paths = data.filter((path): path is string => typeof path === 'string' && materialPathInGroup(group, path)).slice(0, 100)
      await removeMaterialFiles(group, paths)
    } catch (error) {
      console.error('Could not clean study group material files:', error)
    }
  })()
  cleanupRequests.set(group, pending)
  try { await pending }
  finally { if (cleanupRequests.get(group) === pending) cleanupRequests.delete(group) }
}

export async function getMaterialFileUrl(attachment: MaterialAttachment): Promise<string> {
  const validated = getMaterialAttachments([attachment])[0]
  if (!validated) throw new Error('Не вдалося перевірити файл. Оновіть сторінку та спробуйте ще раз.')
  try {
    const { data, error } = await supabase.storage.from(MATERIAL_FILES_BUCKET).createSignedUrl(validated.path, 60, { download: materialFileName(validated.file_name) })
    if (error) throw error
    if (!data?.signedUrl) throw new Error('Study group material file URL is missing.')
    return data.signedUrl
  } catch (error) {
    console.error('Could not open study group material file:', error)
    throw new Error('Не вдалося відкрити файл. Оновіть сторінку та спробуйте ще раз.')
  }
}
