import { supabase } from './supabase'
import {
  MAX_RECOGNITION_IMAGE_BYTES, MAX_RECOGNITION_PHOTO_BYTES,
  normalizeTimetableRecognition, type TimetableRecognitionResult,
} from './timetableRecognition'

const ENDPOINT = '/api/groups/recognize-timetable'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type TimetableRecognitionAvailability = { available: boolean; reason?: string }
const NOT_CONNECTED = 'Розпізнавання фото ще не підключено. Можна заповнити таблицю вручну або вставити її з Excel.'

async function authorization(groupId: string): Promise<string> {
  if (!UUID.test(groupId)) throw new Error('Не вдалося визначити навчальну групу. Оновіть сторінку.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Увійдіть знову, щоб розпізнати розклад.')
  return `Bearer ${data.session.access_token}`
}
async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const type = response.headers.get('content-type') || ''
    if (!type.includes('application/json')) return null
    const value: unknown = await response.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}
function safeError(body: Record<string, unknown> | null, fallback: string): Error {
  return new Error(typeof body?.error === 'string' && body.error.length <= 400 ? body.error : fallback)
}
export async function timetableRecognitionAvailability(groupId: string, signal?: AbortSignal): Promise<TimetableRecognitionAvailability> {
  const header = await authorization(groupId)
  const response = await fetch(`${ENDPOINT}?group_id=${encodeURIComponent(groupId)}`, {
    method: 'GET', headers: { Authorization: header }, cache: 'no-store', signal,
  })
  const body = await responseBody(response)
  if (response.status === 401 || response.status === 403) throw safeError(body, 'Розпізнавати розклад може староста або заступник із правом керування розкладом.')
  if (!response.ok || !body || typeof body.available !== 'boolean') return { available: false, reason: NOT_CONNECTED }
  return {
    available: body.available,
    reason: typeof body.reason === 'string' && body.reason.length <= 400 ? body.reason : body.available ? undefined : NOT_CONNECTED,
  }
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Скасовано', 'AbortError')
}
function detectMime(header: Uint8Array): string | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value)) return 'image/png'
  if (String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}
function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не вдалося підготувати фото. Оберіть інший файл.')), 'image/jpeg', quality))
}
function dataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => { reader.abort(); cleanup(); reject(new DOMException('Скасовано', 'AbortError')) }
    reader.onload = () => { cleanup(); typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Не вдалося прочитати фото.')) }
    reader.onerror = () => { cleanup(); reject(new Error('Не вдалося прочитати фото.')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    reader.readAsDataURL(blob)
  })
}
async function prepareImage(file: File, signal?: AbortSignal): Promise<string> {
  checkAbort(signal)
  if (!file.size || file.size > MAX_RECOGNITION_PHOTO_BYTES) throw new Error('Оберіть фото JPG, PNG або WebP до 8 МБ.')
  const mime = detectMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()))
  if (!mime) throw new Error('Оберіть зображення у форматі JPG, PNG або WebP.')
  checkAbort(signal)
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { image.src = ''; cleanup(); reject(new DOMException('Скасовано', 'AbortError')) }
      const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort) }
      image.onload = () => { cleanup(); resolve() }
      image.onerror = () => { cleanup(); reject(new Error('Фото пошкоджене або його не вдалося відкрити.')) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      image.src = url
    })
    checkAbort(signal)
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000) throw new Error('Зображення завелике. Зменште його роздільну здатність.')
    const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не вдалося підготувати фото у цьому браузері.')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    let blob = await canvasBlob(canvas, 0.92)
    if (blob.size > MAX_RECOGNITION_IMAGE_BYTES) blob = await canvasBlob(canvas, 0.8)
    if (blob.size > MAX_RECOGNITION_IMAGE_BYTES) blob = await canvasBlob(canvas, 0.65)
    checkAbort(signal)
    if (blob.size > MAX_RECOGNITION_IMAGE_BYTES) throw new Error('Фото завелике для розпізнавання. Обріжте його до таблиці розкладу.')
    return await dataUrl(blob, signal)
  } finally { image.src = ''; URL.revokeObjectURL(url) }
}
export async function recognizeTimetablePhoto(groupId: string, file: File, signal?: AbortSignal): Promise<TimetableRecognitionResult> {
  const header = await authorization(groupId)
  const image_data_url = await prepareImage(file, signal)
  checkAbort(signal)
  const response = await fetch(ENDPOINT, {
    method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: groupId, image_data_url }), cache: 'no-store', signal,
  })
  const body = await responseBody(response)
  if (!response.ok) throw safeError(body, response.status === 404 ? NOT_CONNECTED : 'Не вдалося розпізнати фото. Спробуйте ще раз або заповніть таблицю вручну.')
  try { return normalizeTimetableRecognition(body) }
  catch { throw new Error('Результат розпізнавання неповний. Спробуйте чіткіше фото або заповніть таблицю вручну.') }
}
