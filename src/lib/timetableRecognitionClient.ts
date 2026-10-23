import { supabase } from './supabase'
import {
  MAX_RECOGNITION_IMAGE_BYTES, MAX_RECOGNITION_PHOTO_BYTES,
  normalizeTimetableRecognition, normalizeTimetableSourceAnalysis, normalizeTimetableSourceClarifications, timetableSourceMatchesSelection,
  type TimetableRecognitionResult, type TimetableSourceAnalysis, type TimetableSourceSelection, type TimetableSourceClarification,
} from './timetableRecognition'
import {
  normalizeTimetableRecognitionPackage, timetableRecognitionPackageByteLength, TIMETABLE_RECOGNITION_MAX_BODY_BYTES,
  type TimetableRecognitionSource, type TimetableRecognitionTarget,
} from './timetableRecognitionSources'
export { loadTimetableSpreadsheet } from './timetableSpreadsheet'

const ENDPOINT = '/api/groups/recognize-timetable'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type TimetableRecognitionAvailability = { available: boolean; reason?: string }
export type TimetablePhotoOptions = {
  rotation?: 0 | 90 | 180 | 270
  crop?: { left: number; top: number; right: number; bottom: number }
  maximumBytes?: number
}
const NOT_CONNECTED = 'Розпізнавання фото ще не підключено. Можна заповнити таблицю вручну або вставити її з Excel.'
const TIMED_OUT = 'Розпізнавання триває задовго. Спробуйте ще раз або обріжте фото до потрібної групи.'

export class TimetableRecognitionRequestError extends Error {
  constructor(message: string, readonly status: number, readonly clarifications: TimetableSourceClarification[] = [], readonly requiresAnalysis = false) { super(message); this.name = 'TimetableRecognitionRequestError' }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Скасовано', 'AbortError')
}

// Bound session lookup, image decoding and fetch alike. A late response cannot
// continue to the next stage after a deadline or a user cancellation.
async function withDeadline<T>(signal: AbortSignal | undefined, milliseconds: number, operation: (activeSignal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const timer = setTimeout(() => controller.abort(new Error(TIMED_OUT)), milliseconds)
  let abort: (() => void) | undefined
  try {
    checkAbort(controller.signal)
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => {
        try { checkAbort(controller.signal) } catch (problem) { reject(problem) }
      }
      controller.signal.addEventListener('abort', abort, { once: true })
    })
    return await Promise.race([operation(controller.signal), interrupted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
    if (abort) controller.signal.removeEventListener('abort', abort)
  }
}

async function authorization(groupId: string, signal?: AbortSignal): Promise<string> {
  checkAbort(signal)
  if (!UUID.test(groupId)) throw new Error('Не вдалося визначити навчальну групу. Оновіть сторінку.')
  const { data, error } = await supabase.auth.getSession()
  checkAbort(signal)
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
function safeError(body: Record<string, unknown> | null, fallback: string, status: number): Error {
  let clarifications: TimetableSourceClarification[] = []
  try { clarifications = normalizeTimetableSourceClarifications(body?.clarifications) } catch { /* Ignore malformed optional provider diagnostics. */ }
  return new TimetableRecognitionRequestError(typeof body?.error === 'string' && body.error.length <= 400 ? body.error : fallback, status, clarifications, body?.requires_analysis === true)
}
export async function timetableRecognitionAvailability(groupId: string, signal?: AbortSignal): Promise<TimetableRecognitionAvailability> {
  return withDeadline(signal, 15000, async (activeSignal) => {
    const header = await authorization(groupId, activeSignal)
    const response = await fetch(`${ENDPOINT}?group_id=${encodeURIComponent(groupId)}`, {
      method: 'GET', headers: { Authorization: header }, cache: 'no-store', signal: activeSignal,
    })
    const body = await responseBody(response)
    checkAbort(activeSignal)
    if (response.status === 401 || response.status === 403) throw safeError(body, 'Розпізнавати розклад може староста або заступник із правом керування розкладом.', response.status)
    if (!response.ok) throw safeError(body, 'Сервіс розпізнавання тимчасово недоступний. Натисніть «Перевірити ще раз».', response.status)
    if (!body || typeof body.available !== 'boolean') throw new TimetableRecognitionRequestError('Не вдалося перевірити доступність розпізнавання. Натисніть «Перевірити ще раз».', response.status)
    return {
      available: body.available,
      reason: typeof body.reason === 'string' && body.reason.length <= 400 ? body.reason : body.available ? undefined : NOT_CONNECTED,
    }
  })
}

function detectMime(header: Uint8Array): string | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value)) return 'image/png'
  if (String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}
function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не вдалося підготувати фото. Оберіть інший файл.')), mime, quality))
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

export function timetablePhotoGeometry(width: number, height: number, options: TimetablePhotoOptions = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 60_000_000) throw new Error('Зображення завелике. Зменште його роздільну здатність.')
  const rotation = options.rotation ?? 0
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('Не вдалося повернути фото.')
  const crop = options.crop ?? { left: 0, top: 0, right: 100, bottom: 100 }
  if ((['left', 'top', 'right', 'bottom'] as const).some((side) => !Number.isFinite(crop[side]) || crop[side] < 0 || crop[side] > 100) || crop.right <= crop.left || crop.bottom <= crop.top) throw new Error('Перевірте межі обрізання: права й нижня мають бути більшими за ліву та верхню.')
  const left = Math.min(width - 1, Math.floor(width * crop.left / 100))
  const top = Math.min(height - 1, Math.floor(height * crop.top / 100))
  const cropWidth = Math.max(1, Math.ceil(width * crop.right / 100) - left)
  const cropHeight = Math.max(1, Math.ceil(height * crop.bottom / 100) - top)
  const rotated = rotation === 90 || rotation === 270
  return { left, top, cropWidth, cropHeight, rotation, width: rotated ? cropHeight : cropWidth, height: rotated ? cropWidth : cropHeight,
    unchanged: rotation === 0 && left === 0 && top === 0 && cropWidth === width && cropHeight === height }
}

export async function prepareTimetablePhoto(file: File, options: TimetablePhotoOptions = {}, signal?: AbortSignal): Promise<string> {
  return withDeadline(signal, 30000, async (activeSignal) => {
    if (!file.size || file.size > MAX_RECOGNITION_PHOTO_BYTES) throw new Error('Оберіть фото JPG, PNG або WebP до 8 МБ.')
    const mime = detectMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()))
    if (!mime) throw new Error('Оберіть зображення у форматі JPG, PNG або WebP.')
    const maximumBytes = options.maximumBytes ?? MAX_RECOGNITION_IMAGE_BYTES
    if (!Number.isInteger(maximumBytes) || maximumBytes < 256 * 1024 || maximumBytes > MAX_RECOGNITION_IMAGE_BYTES) throw new Error('Не вдалося визначити розмір комплекту фото.')
    checkAbort(activeSignal)
    const url = URL.createObjectURL(file)
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { image.src = ''; cleanup(); reject(new DOMException('Скасовано', 'AbortError')) }
        const cleanup = () => { image.onload = null; image.onerror = null; activeSignal.removeEventListener('abort', abort) }
        image.onload = () => { cleanup(); resolve() }
        image.onerror = () => { cleanup(); reject(new Error('Фото пошкоджене або його не вдалося відкрити.')) }
        activeSignal.addEventListener('abort', abort, { once: true })
        if (activeSignal.aborted) return abort()
        image.src = url
      })
      checkAbort(activeSignal)
      const geometry = timetablePhotoGeometry(image.naturalWidth, image.naturalHeight, options)
      // Preserve small source files byte-for-byte: screenshots keep fine table
      // borders and text instead of suffering an unnecessary JPEG conversion.
      if (geometry.unchanged && Math.max(geometry.width, geometry.height) <= 4096 && file.size <= maximumBytes) return await dataUrl(file.slice(0, file.size, mime), activeSignal)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Не вдалося підготувати фото у цьому браузері.')
      for (const maximum of [4096, 3584, 3072, 2560]) {
        const scale = Math.min(1, maximum / Math.max(geometry.width, geometry.height))
        canvas.width = Math.max(1, Math.round(geometry.width * scale))
        canvas.height = Math.max(1, Math.round(geometry.height * scale))
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
        context.save()
        context.translate(canvas.width / 2, canvas.height / 2)
        context.rotate(geometry.rotation * Math.PI / 180)
        const drawWidth = geometry.cropWidth * scale, drawHeight = geometry.cropHeight * scale
        context.drawImage(image, geometry.left, geometry.top, geometry.cropWidth, geometry.cropHeight, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
        context.restore()
        checkAbort(activeSignal)
        if (mime === 'image/png') {
          const png = await canvasBlob(canvas, 'image/png')
          checkAbort(activeSignal)
          if (png.size <= maximumBytes) return await dataUrl(png, activeSignal)
        }
        const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.9)
        checkAbort(activeSignal)
        if (jpeg.size <= maximumBytes) return await dataUrl(jpeg, activeSignal)
      }
      throw new Error('Фото містить забагато дрібних деталей. Обріжте його до заголовків і розкладу потрібної групи або завантажте ближчий знімок.')
    } finally { image.src = ''; URL.revokeObjectURL(url) }
  })
}

async function sourcesRequest(groupId: string, sources: TimetableRecognitionSource[], target: TimetableRecognitionTarget, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return withDeadline(signal, 115000, async activeSignal => {
    const sourcePackage = normalizeTimetableRecognitionPackage(sources, target)
    const requestBody = { ...payload, group_id: groupId, ...sourcePackage }
    if (timetableRecognitionPackageByteLength(requestBody) > TIMETABLE_RECOGNITION_MAX_BODY_BYTES) {
      throw new Error('Комплект файлів завеликий. Обріжте скриншоти до потрібної групи або оберіть менше аркушів.')
    }
    const header = await authorization(groupId, activeSignal)
    const response = await fetch(ENDPOINT, {
      method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody), cache: 'no-store', signal: activeSignal,
    })
    const body = await responseBody(response)
    checkAbort(activeSignal)
    if (!response.ok) throw safeError(body, response.status === 404 ? NOT_CONNECTED : 'Не вдалося розпізнати комплект файлів. Перевірте заголовки й чіткість розкладу.', response.status)
    return body
  })
}

export async function analyzeTimetableSources(groupId: string, sources: TimetableRecognitionSource[], target: TimetableRecognitionTarget, signal?: AbortSignal): Promise<TimetableSourceAnalysis> {
  const body = await sourcesRequest(groupId, sources, target, { action: 'analyze' }, signal)
  try {
    const analysis = normalizeTimetableSourceAnalysis(body)
    if (analysis.clarifications?.some(question => question.source_index > sources.length)) throw new Error('SOURCE_INDEX')
    return analysis
  }
  catch { throw new Error('Не вдалося відокремити групи в цих файлах. Перевірте курс, групу й заголовки таблиці або завантажте чіткіші знімки.') }
}

export async function recognizeTimetableSources(groupId: string, sources: TimetableRecognitionSource[], target: TimetableRecognitionTarget, selection: TimetableSourceSelection, analysisToken: string, signal?: AbortSignal): Promise<TimetableRecognitionResult> {
  if (!selection || !analysisToken) throw new Error('Спочатку проаналізуйте файли та оберіть розклад своєї групи.')
  const body = await sourcesRequest(groupId, sources, target, { action: 'extract', source_selection: selection, analysis_token: analysisToken }, signal)
  let result: TimetableRecognitionResult
  try { result = normalizeTimetableRecognition(body) }
  catch { throw new Error('Результат розпізнавання неповний. Завантажте чіткіші знімки або окремий аркуш таблиці.') }
  if (!timetableSourceMatches(result, selection)) throw new Error('У файлах не підтверджено розклад обраної групи. Перевірте заголовки та оберіть групу ще раз.')
  return result
}

async function photoRequest(groupId: string, imageDataUrl: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return withDeadline(signal, 115000, async (activeSignal) => {
    if (typeof imageDataUrl !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(imageDataUrl) || imageDataUrl.length > Math.ceil(MAX_RECOGNITION_IMAGE_BYTES * 4 / 3) + 100) throw new Error('Спочатку підготуйте фото для розпізнавання.')
    const header = await authorization(groupId, activeSignal)
    const response = await fetch(ENDPOINT, {
      method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, group_id: groupId, image_data_url: imageDataUrl }), cache: 'no-store', signal: activeSignal,
    })
    const body = await responseBody(response)
    checkAbort(activeSignal)
    if (!response.ok) throw safeError(body, response.status === 404 ? NOT_CONNECTED : 'Не вдалося розпізнати фото. Спробуйте ще раз або заповніть таблицю вручну.', response.status)
    return body
  })
}

export async function analyzeTimetablePhoto(groupId: string, imageDataUrl: string, signal?: AbortSignal): Promise<TimetableSourceAnalysis> {
  const body = await photoRequest(groupId, imageDataUrl, { action: 'analyze' }, signal)
  try { return normalizeTimetableSourceAnalysis(body) }
  catch { throw new Error('Не вдалося визначити групи на фото. Спробуйте чіткіший знімок із заголовками груп і курсів.') }
}

export function timetableSourceMatches(result: TimetableRecognitionResult, selection: TimetableSourceSelection): boolean {
  const match = result.source_match
  if (!match || !['matched', 'single_unlabelled'].includes(match.status)) return false
  const isUnlabelled = selection.id === 'single' && !selection.group_name && selection.study_year === null && selection.study_level === null && !selection.program && !selection.section_label
  if (match.status === 'single_unlabelled' && !isUnlabelled) return false
  if (match.status === 'matched' && isUnlabelled) return false
  return timetableSourceMatchesSelection(selection, match)
}

export async function recognizeTimetablePhoto(groupId: string, imageDataUrl: string, selection: TimetableSourceSelection, analysisToken: string, signal?: AbortSignal): Promise<TimetableRecognitionResult> {
  if (!selection || typeof analysisToken !== 'string' || !analysisToken) throw new Error('Спочатку визначте та оберіть групу на фото.')
  const body = await photoRequest(groupId, imageDataUrl, { action: 'extract', source_selection: selection, analysis_token: analysisToken }, signal)
  let result: TimetableRecognitionResult
  try { result = normalizeTimetableRecognition(body) }
  catch { throw new Error('Результат розпізнавання неповний. Спробуйте чіткіше фото або заповніть таблицю вручну.') }
  if (!timetableSourceMatches(result, selection)) throw new Error('На фото не підтверджено розклад обраної групи. Перевірте заголовки та оберіть групу ще раз.')
  return result
}
