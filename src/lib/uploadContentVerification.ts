import { supabase } from './supabase'

export const UPLOAD_CONTENT_VERIFY_LABEL = 'Перевіряємо вміст файлу'
export const ACADEMIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
// This list describes new uploads only. Historical attachment descriptors keep
// their original readers and do not become trusted content-verification receipts.
export const ACADEMIC_UPLOAD_MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  txt: 'text/plain', csv: 'text/csv',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}
export const ACADEMIC_UPLOAD_ACCEPT = Object.keys(ACADEMIC_UPLOAD_MIME_TYPES).map(extension => `.${extension}`).join(',')
const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  docx: ['application/zip', 'application/x-zip-compressed'],
  xlsx: ['application/zip', 'application/x-zip-compressed'],
  pptx: ['application/zip', 'application/x-zip-compressed'],
  csv: ['application/vnd.ms-excel', 'application/csv', 'text/plain', 'text/x-csv'],
  jpg: ['image/jpg', 'image/pjpeg'], jpeg: ['image/jpg', 'image/pjpeg'],
  zip: ['application/x-zip-compressed', 'application/x-zip'],
  mp3: ['audio/mp3', 'audio/x-mp3', 'audio/x-mpeg'], wav: ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  m4a: ['audio/x-m4a', 'video/mp4'], ogg: ['application/ogg'], mp4: ['application/mp4', 'audio/mp4'], webm: ['audio/webm'], mov: ['video/x-quicktime'],
}
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID = new RegExp(`^${UUID_PART}$`, 'i')
const PATH = new RegExp(`^${UUID_PART}/(${UUID_PART})/${UUID_PART}\\.([a-z0-9]{1,5})$`, 'i')
const BUCKETS = new Set(['xelay-teaching-files', 'xelay-submission-files', 'xelay-group-presentations', 'xelay-study-materials'])
const ENDPOINT = '/api/security/media-cleanup?xelay_upload_route=verify'
const UNSUPPORTED = 'Цей формат поки не підтримує перевірку вмісту. Збережіть документ у PDF або звичайному форматі Office без макросів; зображення у PNG, JPG, WebP, GIF чи AVIF. Також підтримуються TXT, CSV, ZIP із перевірюваними файлами та звичайні аудіо/відео. Для інших форматів додайте посилання.'
const NOT_VERIFIED = 'Не вдалося завершити перевірку вмісту файлу. Він не буде доданий до матеріалу або роботи. Вибраний файл залишився у формі; спробуйте ще раз.'
const CONTENT_REJECTED = 'Файл не пройшов перевірку вмісту: він може бути пошкоджений, зашифрований, містити макроси або непідтримуване кодування. Максимум 50 МБ на файл. Для ZIP: до 50 файлів, до 16 МБ кожен і до 64 МБ сумарного внутрішнього обсягу обробки, без вкладених архівів. Перезбережіть документ, зображення, аудіо чи відео у звичайному підтримуваному форматі або додайте посилання.'
const ACCOUNT_CHANGED = 'Акаунт змінився. Файл не буде доданий. Збережіть текст і відкрийте форму зі свого акаунта.'

export class UploadContentVerificationError extends Error {
  constructor(public readonly reason: 'format' | 'content' | 'unavailable' | 'account' | 'request', message: string) {
    super(message)
    this.name = 'UploadContentVerificationError'
  }
}

export function validateAcademicUploadFile(file: Pick<File, 'name' | 'type' | 'size'>): { extension: string; mime: string } {
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() || ''
  if (!Object.prototype.hasOwnProperty.call(ACADEMIC_UPLOAD_MIME_TYPES, extension)) throw new UploadContentVerificationError('format', UNSUPPORTED)
  if (!/^[^/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,240}$/.test(file.name)) {
    throw new UploadContentVerificationError('format', 'Перейменуйте файл: до 240 символів, без прихованих керувальних знаків або роздільників папок.')
  }
  const mime = ACADEMIC_UPLOAD_MIME_TYPES[extension]
  const provided = file.type.trim().toLowerCase().split(';', 1)[0]
  if (provided && provided !== 'application/octet-stream' && provided !== mime && !MIME_ALIASES[extension]?.includes(provided)) {
    throw new UploadContentVerificationError('format', 'Тип файлу не відповідає його розширенню. Повторно збережіть документ у підтримуваному форматі.')
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadContentVerificationError('format', 'Файл порожній або його розмір некоректний.')
  if (file.size > ACADEMIC_UPLOAD_MAX_BYTES) throw new UploadContentVerificationError('format', 'Максимальний розмір файлу — 50 МБ. Для більшого файлу додайте посилання на Google Drive.')
  return { extension, mime }
}

function cancelled() { return new DOMException('Перевірку файлу скасовано. Файл не буде доданий.', 'AbortError') }

export async function activeAcademicUploadSession(userId: string, signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled()
  if (!UUID.test(userId)) throw new UploadContentVerificationError('account', ACCOUNT_CHANGED)
  const current = await supabase.auth.getSession()
  if (signal?.aborted) throw cancelled()
  const session = current.data.session
  if (current.error || session?.user.id !== userId || !session.access_token || /\s/.test(session.access_token)) {
    throw new UploadContentVerificationError('account', ACCOUNT_CHANGED)
  }
  return session
}

/** Stored bytes remain quarantined until the server has recorded its receipt.
 * This is structural content validation, not an antivirus guarantee. */
export async function verifyUploadedContent({ bucket, path, userId, signal, onProgress, onStage }: {
  bucket: string; path: string; userId: string; signal?: AbortSignal
  onProgress?: (percent: number) => void; onStage?: (stage: string) => void
}): Promise<void> {
  const match = PATH.exec(path)
  if (!BUCKETS.has(bucket) || !match || match[1] !== userId || !Object.prototype.hasOwnProperty.call(ACADEMIC_UPLOAD_MIME_TYPES, match[2])) {
    throw new UploadContentVerificationError('request', 'Не вдалося визначити файл для перевірки. Оновіть форму й додайте файл знову.')
  }
  if (signal?.aborted) throw cancelled()
  const controller = new AbortController()
  let accountChanged = false
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(cancel, 90_000)
  let unsubscribe: (() => void) | undefined
  try {
    const subscription = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { accountChanged = true; controller.abort() }
    })
    unsubscribe = () => subscription.data.subscription.unsubscribe()
    const session = await activeAcademicUploadSession(userId, controller.signal)
    if (accountChanged) throw new UploadContentVerificationError('account', ACCOUNT_CHANGED)
    onStage?.(UPLOAD_CONTENT_VERIFY_LABEL)
    onProgress?.(99)
    const response = await fetch(ENDPOINT, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ bucket, path }),
    })
    if (!response.ok || response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      // Use reviewed status-specific copy, never arbitrary provider diagnostics.
      if (response.status === 401) throw new UploadContentVerificationError('account', 'Не вдалося підтвердити вхід для перевірки файлу. Текст і вибраний файл залишилися у формі. Увійдіть повторно та спробуйте ще раз.')
      if (response.status === 403) throw new UploadContentVerificationError('request', 'Не вдалося підтвердити доступ до перевірки файлу. Вибраний файл залишився у формі. Оновіть сторінку або зверніться до підтримки, якщо помилка повторюється.')
      if (response.status === 409) throw new UploadContentVerificationError('unavailable', 'Не вдалося підтвердити поточну версію файлу у сховищі. Вибраний файл залишився у формі. Спробуйте зберегти ще раз.')
      if (response.status === 429) throw new UploadContentVerificationError('unavailable', 'Перевірка файлів тимчасово зайнята або досягнуто ліміту спроб. Вибраний файл залишився у формі. Зачекайте приблизно 10 хвилин перед повторною спробою.')
      throw new UploadContentVerificationError(response.status === 422 || response.status === 415 ? 'content' : 'unavailable',
        response.status === 422 || response.status === 415
          ? CONTENT_REJECTED : NOT_VERIFIED)
    }
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel().catch(() => {})
      throw new UploadContentVerificationError('unavailable', NOT_VERIFIED)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new UploadContentVerificationError('unavailable', NOT_VERIFIED)
    const parts: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > 4096) throw new UploadContentVerificationError('unavailable', NOT_VERIFIED)
        parts.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    let result: unknown
    try { result = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new UploadContentVerificationError('unavailable', NOT_VERIFIED) }
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || (result as { verified?: unknown }).verified !== true || (result as { validation_version?: unknown }).validation_version !== 1) {
      throw new UploadContentVerificationError('unavailable', NOT_VERIFIED)
    }
    await activeAcademicUploadSession(userId, controller.signal)
    if (accountChanged) throw new UploadContentVerificationError('account', ACCOUNT_CHANGED)
    onProgress?.(100)
  } catch (error) {
    if (accountChanged) throw new UploadContentVerificationError('account', ACCOUNT_CHANGED)
    if (signal?.aborted) throw cancelled()
    if (error instanceof UploadContentVerificationError) throw error
    throw new UploadContentVerificationError('unavailable', NOT_VERIFIED)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    unsubscribe?.()
  }
}
