import { supabase } from './supabase'
import {
  HOMEWORK_FILE_ACCEPT,
  MAX_HOMEWORK_FILE_BYTES,
  MAX_HOMEWORK_FILES,
  MAX_HOMEWORK_LINKS,
  formatHomeworkFileSize,
  getHomeworkAttachments,
  normalizeHomeworkLinks,
  validateHomeworkFile,
  type HomeworkAttachment,
} from './homeworkResources'

export type SeminarAttachment = HomeworkAttachment
export const SEMINAR_FILES_BUCKET = 'xelay-seminar-files'
export const SEMINAR_FILE_ACCEPT = HOMEWORK_FILE_ACCEPT
export const MAX_SEMINAR_FILES = MAX_HOMEWORK_FILES
export const MAX_SEMINAR_LINKS = MAX_HOMEWORK_LINKS
export const MAX_SEMINAR_FILE_BYTES = MAX_HOMEWORK_FILE_BYTES
export const formatSeminarFileSize = formatHomeworkFileSize

const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_PATTERN = new RegExp(`^${UUID_PART}$`)
const STORAGE_PATTERN = new RegExp(`^${UUID_PART}/${UUID_PART}/${UUID_PART}-[A-Za-z0-9][A-Za-z0-9._-]{0,179}$`)
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,255}$/
const FILE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', zip: 'application/zip',
}
const SCHEMA_ERROR_CODES = new Set(['PGRST205', 'PGRST202', 'PGRST204', '42P01', '42703', '42883'])
const RESOURCE_ERRORS: Record<string, string> = {
  SEMINAR_RESOURCE_INVALID_INPUT: 'Перевірте посилання та файли. До завдання можна додати 10 посилань і 10 файлів розміром до 20 МБ кожен.',
  SEMINAR_RESOURCE_FORBIDDEN: 'Додавати та видаляти матеріали може лише староста цієї групи. Оновіть сторінку та перевірте свій доступ.',
  SEMINAR_RESOURCE_UPLOAD_MISSING: 'Завантаження одного з файлів не завершилося. Виберіть його повторно та збережіть завдання.',
  SEMINAR_RESOURCE_METADATA_MISMATCH: 'Дані одного з файлів не відповідають завантаженню. Приберіть його й додайте повторно.',
  SEMINAR_RESOURCE_CLEANUP_PENDING: 'Файл ще не вдалося видалити. Його очищення буде повторено під час наступного відкриття семінарів.',
  SEMINAR_RESOURCE_ALREADY_ATTACHED: 'Цей файл уже прикріплено до іншого завдання. Щоб додати його сюди, виберіть і завантажте файл повторно.',
  GROUP_LICENSE_REQUIRED: 'Для редагування матеріалів потрібен активний доступ навчальної групи.',
}

function isSchemaError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && SCHEMA_ERROR_CODES.has(code)
}

function extension(name: string) {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

function isSafeStoragePath(path: string) {
  return path.length <= 512 && STORAGE_PATTERN.test(path)
    && Object.prototype.hasOwnProperty.call(FILE_MIME_TYPES, extension(path))
}

export function validateSeminarFile(file: File): void {
  validateHomeworkFile(file)
}

export function normalizeSeminarLinks(values: string[]): string[] {
  if (values.some((value) => {
    try {
      const url = new URL(value.trim())
      return !url.hostname || Boolean(url.username || url.password)
    } catch { return false }
  })) throw new Error('Використайте посилання без логіна або пароля в адресі.')
  try {
    return normalizeHomeworkLinks(values)
  } catch (error) {
    if (error instanceof Error) throw new Error(error.message.replace('домашнього завдання', 'завдання семінару'))
    throw error
  }
}

export function getSeminarLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const links = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    try { normalizeSeminarLinks([item]).forEach((link) => links.add(link)) } catch { continue }
    if (links.size >= MAX_SEMINAR_LINKS) break
  }
  return [...links]
}

export function getSeminarAttachments(value: unknown): SeminarAttachment[] {
  return getHomeworkAttachments(value).filter((item) => isSafeStoragePath(item.storage_path))
}

export function validateSeminarResources(links: string[], files: File[], attachments: SeminarAttachment[]) {
  if (attachments.length + files.length > MAX_SEMINAR_FILES) {
    throw new Error(`До завдання семінару можна додати щонайбільше ${MAX_SEMINAR_FILES} файлів.`)
  }
  const validAttachments = getSeminarAttachments(attachments)
  if (validAttachments.length !== attachments.length) {
    throw new Error('Збережений файл має некоректні дані. Оновіть завдання та спробуйте ще раз.')
  }
  files.forEach(validateSeminarFile)
  return { links: normalizeSeminarLinks(links), attachments: validAttachments }
}

function safeFilename(name: string) {
  const fileExtension = extension(name)
  const stem = name.slice(0, -(fileExtension.length + 1)).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '').slice(0, 150) || 'file'
  return `${stem}.${fileExtension}`
}

export async function uploadSeminarFiles(
  groupId: string,
  userId: string,
  files: File[],
  onProgress?: (completed: number, total: number) => void,
): Promise<SeminarAttachment[]> {
  if (files.length > MAX_SEMINAR_FILES) throw new Error('До завдання семінару можна додати щонайбільше 10 файлів.')
  files.forEach(validateSeminarFile)
  if (!files.length) return []
  if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(userId)) {
    throw new Error('Не вдалося визначити групу або обліковий запис для завантаження файлів.')
  }
  const uploaded: SeminarAttachment[] = []
  const attemptedPaths: string[] = []
  try {
    for (const file of files) {
      const storage_path = `${groupId}/${userId}/${crypto.randomUUID()}-${safeFilename(file.name)}`
      const mime_type = FILE_MIME_TYPES[extension(file.name)]
      attemptedPaths.push(storage_path)
      const { error } = await supabase.storage.from(SEMINAR_FILES_BUCKET)
        .upload(storage_path, file, { contentType: mime_type, upsert: false })
      if (error) throw error
      uploaded.push({ storage_path, file_name: file.name, mime_type, file_size: file.size })
      onProgress?.(uploaded.length, files.length)
    }
    return uploaded
  } catch (cause) {
    console.error('Could not upload seminar files:', cause)
    // Also try the in-flight path: an upload may complete even if its response
    // is lost before the client can add its descriptor to `uploaded`.
    const removed = await removeSeminarFiles(attemptedPaths)
    const error = new Error(removed
      ? 'Не вдалося завантажити файли. Перевірте доступ до групи та спробуйте ще раз.'
      : 'Не вдалося завантажити й очистити частину тимчасових файлів. Спробуйте ще раз; для очищення може знадобитися допомога адміністратора.') as Error & { orphanedPaths?: string[] }
    if (!removed) error.orphanedPaths = attemptedPaths
    throw error
  }
}

export async function removeSeminarFiles(paths: string[]): Promise<boolean> {
  const requested = [...new Set(paths)].sort()
  if (!requested.length) return true
  if (requested.some((path) => !isSafeStoragePath(path))) {
    console.error('Could not remove seminar files: invalid path.')
    return false
  }
  let complete = true
  // One object per request keeps Storage locks in the same order as attachment validation.
  for (const path of requested) {
    try {
      const { data, error } = await supabase.storage.from(SEMINAR_FILES_BUCKET).remove([path])
      if (error) throw error
      if (!(data ?? []).some((file) => file.name === path)) complete = false
    } catch (error) {
      console.error('Could not remove seminar file:', error)
      complete = false
    }
  }
  return complete
}

let cleanupInFlight: Promise<boolean> | null = null
export function cleanupPendingSeminarFiles(): Promise<boolean> {
  if (cleanupInFlight) return cleanupInFlight
  cleanupInFlight = (async () => {
    try {
      const { data, error } = await supabase.from('study_group_seminar_file_cleanup')
        .select('storage_path').order('created_at').limit(100)
      if (error) throw error
      let complete = true
      for (const item of data ?? []) {
        const path = item.storage_path as string
        if (!isSafeStoragePath(path)) { complete = false; continue }
        try {
          const removed = await supabase.storage.from(SEMINAR_FILES_BUCKET).remove([path])
          if (removed.error) throw removed.error
          // The acknowledgement verifies that the object is absent, including
          // retries where it was removed before a previous response was lost.
          const acknowledged = await supabase.rpc('xelay_ack_seminar_file_cleanup', { p_storage_path: path })
          if (acknowledged.error) throw acknowledged.error
        } catch (failure) {
          if (!isSchemaError(failure)) console.error('Could not finish detached seminar file cleanup:', failure)
          complete = false
        }
      }
      return complete
    } catch (error) {
      if (!isSchemaError(error)) console.error('Could not clean up detached seminar files:', error)
      return false
    } finally { cleanupInFlight = null }
  })()
  return cleanupInFlight
}

export async function getSeminarFileUrl(path: string, fileName: string): Promise<string> {
  if (!isSafeStoragePath(path) || !SAFE_FILE_NAME.test(fileName)) {
    throw new Error('Цей файл має некоректні дані. Зверніться до старости.')
  }
  try {
    const { data, error } = await supabase.storage.from(SEMINAR_FILES_BUCKET)
      .createSignedUrl(path, 60, { download: fileName })
    if (error || !data?.signedUrl) throw error ?? new Error('Missing signed file URL')
    return data.signedUrl
  } catch (error) {
    console.error('Could not create seminar file URL:', error)
    throw new Error('Не вдалося завантажити файл. Перевірте доступ до групи та спробуйте ще раз.')
  }
}

export function seminarResourceError(error: unknown): string {
  if (isSchemaError(error)) {
    return 'Матеріали семінарів ще не підключені до бази даних. Застосуйте нову міграцію семінарів та оновіть вкладку.'
  }
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message === 'string') {
    const code = Object.keys(RESOURCE_ERRORS).find((key) => message.includes(key))
    if (code) return RESOURCE_ERRORS[code]
    if (error instanceof Error) return message
  }
  return 'Не вдалося зберегти матеріали семінару. Перевірте з’єднання та спробуйте ще раз.'
}
