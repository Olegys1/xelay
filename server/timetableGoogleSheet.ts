import { requireTimetableScheduleActor, TimetableRecognitionError } from './timetableRecognition.js'

// Keep binary responses below the synchronous hosting response limit. Manual
// local-file imports retain their existing 8 MiB limit and are not proxied.
export const TIMETABLE_GOOGLE_SHEET_MAX_BYTES = 4 * 1024 * 1024
const MAX_BODY_BYTES = 4096
const DOWNLOAD_TIMEOUT_MS = 20000
const MAX_REDIRECTS = 3
const MAX_THROTTLE_ENTRIES = 2000
const PRIVATE_SHEET = 'Таблиця недоступна без входу в Google або її власник заборонив завантаження. Використайте доступну для перегляду таблицю або самостійно завантажте XLSX і додайте файл.'
const LARGE_SHEET = 'Таблиця за посиланням завелика: максимум 4 МБ. Завантажте потрібні аркуші як XLSX і додайте файл вручну (до 8 МБ) або скриншоти.'
const INVALID_SHEET = 'Google не повернув придатну таблицю XLSX. Перевірте посилання та доступ до завантаження або додайте файл вручну.'
const GOOGLE_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SheetRequest = { groupId: string; sheetId: string }
type DownloadBudget = { startedAt: number; attempts: number; active: number }
// Best-effort protection for each warm function instance; not a durable/global
// quota. Link downloads never spend or reset the separate paid AI allowance.
const downloadBudgets = new Map<string, DownloadBudget>()
let activeDownloads = 0

function requestBody(req: any): SheetRequest {
  const contentType = req.headers?.['content-type']
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new TimetableRecognitionError(415, 'Надішліть посилання у форматі JSON.')
  }
  const declaredLength = req.headers?.['content-length']
  if (declaredLength !== undefined && (typeof declaredLength !== 'string' || !/^\d+$/.test(declaredLength))) {
    throw new TimetableRecognitionError(400, 'Некоректний запит завантаження таблиці.')
  }
  if (Number(declaredLength || 0) > MAX_BODY_BYTES) throw new TimetableRecognitionError(413, 'Посилання завелике.')
  let body: unknown = req.body
  try {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new TimetableRecognitionError(413, 'Посилання завелике.')
      body = JSON.parse(body.toString())
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_BODY')
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new TimetableRecognitionError(413, 'Посилання завелике.')
  } catch (error) {
    if (error instanceof TimetableRecognitionError) throw error
    throw new TimetableRecognitionError(400, 'Не вдалося прочитати посилання на таблицю.')
  }
  const value = body as Record<string, unknown>
  if (Object.keys(value).length !== 2 || Object.keys(value).some(key => !['group_id', 'google_sheet_url'].includes(key))
    || typeof value.group_id !== 'string' || !GROUP_ID.test(value.group_id)) {
    throw new TimetableRecognitionError(400, 'Оберіть навчальну групу й додайте посилання на Google Таблицю.')
  }
  return { groupId: value.group_id, sheetId: googleSheetId(value.google_sheet_url) }
}

function googleSheetId(value: unknown): string {
  const invalid = () => new TimetableRecognitionError(400, 'Вставте звичайне посилання https://docs.google.com/spreadsheets/d/… на Google Таблицю. Посилання на опубліковану сторінку, окремий діапазон або інший сайт не підтримується.')
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value.trim())) throw invalid()
  let url: URL
  try { url = new URL(value.trim()) } catch { throw invalid() }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password || url.port) throw invalid()
  const match = /^\/spreadsheets\/(?:u\/\d{1,3}\/)?d\/([A-Za-z0-9_-]{20,120})(?:\/(?:edit|view|preview|export))?\/?$/.exec(url.pathname)
  if (!match) throw invalid()
  // Tracking/share parameters are deliberately ignored, never forwarded to a
  // network request. Range-specific links would hide omitted cells, so reject.
  if (url.searchParams.has('range') || url.searchParams.has('ranges') || url.searchParams.has('sheet')
    || url.searchParams.has('url') || url.searchParams.has('redirect') || url.searchParams.has('redirect_uri')) throw invalid()
  const gids = url.searchParams.getAll('gid')
  if (gids.length > 1 || gids.some(gid => !/^\d{1,10}$/.test(gid))) throw invalid()
  if (url.hash && !/^#gid=\d{1,10}$/.test(url.hash)) throw invalid()
  if (gids.length && url.hash && url.hash.slice(5) !== gids[0]) throw invalid()
  return match[1]
}

function reserveDownload(userId: string): () => void {
  const now = Date.now()
  for (const [key, budget] of downloadBudgets) {
    if (!budget.active && now - budget.startedAt >= 60000) downloadBudgets.delete(key)
  }
  let budget = downloadBudgets.get(userId)
  if (!budget) {
    if (downloadBudgets.size >= MAX_THROTTLE_ENTRIES) throw new TimetableRecognitionError(503, 'Завантаження таблиць тимчасово зайняте. Спробуйте трохи пізніше.')
    budget = { startedAt: now, attempts: 0, active: 0 }
    downloadBudgets.set(userId, budget)
  }
  if (budget.active >= 2 || budget.attempts >= 12 || activeDownloads >= 32) {
    throw new TimetableRecognitionError(429, 'Забагато завантажень таблиці. Зачекайте хвилину й спробуйте ще раз.')
  }
  budget.attempts++
  budget.active++
  activeDownloads++
  let released = false
  return () => {
    if (released) return
    released = true
    budget.active--
    activeDownloads--
  }
}

function allowedRedirect(url: URL, sheetId: string): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href.length > 8192) return false
  if (url.hostname === 'docs.google.com') return url.pathname === `/spreadsheets/d/${sheetId}/export`
  // Google-generated Sheets export URLs only. Never follow an arbitrary
  // googleusercontent subdomain, account/login page, or supplied remote URL.
  return /^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(url.hostname) && /^\/export\//.test(url.pathname)
}

function validateXlsxEnvelope(bytes: Buffer) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new TimetableRecognitionError(422, INVALID_SHEET)
  let end = -1
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) {
      end = position
      break
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new TimetableRecognitionError(422, INVALID_SHEET)
  const entries = bytes.readUInt16LE(end + 10)
  const directoryStart = bytes.readUInt32LE(end + 16)
  if (!entries || entries > 2048 || entries !== bytes.readUInt16LE(end + 8)
    || directoryStart + bytes.readUInt32LE(end + 12) !== end) throw new TimetableRecognitionError(422, INVALID_SHEET)
  let position = directoryStart
  let expandedTotal = 0
  const names = new Set<string>()
  for (let entry = 0; entry < entries; entry++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw new TimetableRecognitionError(422, INVALID_SHEET)
    const flags = bytes.readUInt16LE(position + 8)
    const compression = bytes.readUInt16LE(position + 10)
    const compressed = bytes.readUInt32LE(position + 20)
    const expanded = bytes.readUInt32LE(position + 24)
    const nameLength = bytes.readUInt16LE(position + 28)
    const extraLength = bytes.readUInt16LE(position + 30)
    const local = bytes.readUInt32LE(position + 42)
    const next = position + 46 + nameLength + extraLength + bytes.readUInt16LE(position + 32)
    if (next > end || !nameLength || bytes.readUInt16LE(position + 34) || (flags & 0x2041)
      || ![0, 8].includes(compression) || expanded > 12 * 1024 * 1024
      || local + 30 > directoryStart || compressed > bytes.length
      || bytes.readUInt32LE(local) !== 0x04034b50) throw new TimetableRecognitionError(422, INVALID_SHEET)
    const contentStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (contentStart + compressed > directoryStart || contentStart > directoryStart) throw new TimetableRecognitionError(422, INVALID_SHEET)
    const name = bytes.toString('utf8', position + 46, position + 46 + nameLength)
    if (names.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$)|[\u0000-\u001f\u007f])/.test(name)) throw new TimetableRecognitionError(422, INVALID_SHEET)
    names.add(name)
    expandedTotal += expanded
    if (expandedTotal > 32 * 1024 * 1024) throw new TimetableRecognitionError(413, 'Таблиця завелика після розпакування. Збережіть потрібні аркуші в окремий файл.')
    position = next
  }
  if (position !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new TimetableRecognitionError(422, INVALID_SHEET)
  // Full local/central consistency and actual inflated-size validation happen
  // in the existing disposable browser worker before any cell reaches AI.
}

async function readWorkbook(response: Response, signal: AbortSignal): Promise<Buffer> {
  const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > TIMETABLE_GOOGLE_SHEET_MAX_BYTES)) {
    await response.body?.cancel().catch(() => {})
    throw new TimetableRecognitionError(413, LARGE_SHEET)
  }
  if (![GOOGLE_XLSX_MIME, 'application/octet-stream', 'application/zip'].includes(mime || '')
    || (encoding && encoding !== 'identity') || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new TimetableRecognitionError(422, mime === 'text/html' ? PRIVATE_SHEET : INVALID_SHEET)
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > TIMETABLE_GOOGLE_SHEET_MAX_BYTES) throw new TimetableRecognitionError(413, LARGE_SHEET)
      chunks.push(Buffer.from(value))
    }
    if (!size || (length !== null && Number(length) !== size)) throw new TimetableRecognitionError(422, INVALID_SHEET)
    const bytes = Buffer.concat(chunks, size)
    validateXlsxEnvelope(bytes)
    return bytes
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function downloadTimetableGoogleSheet(req: any): Promise<{ fileName: string; bytes: Buffer }> {
  const { groupId, sheetId } = requestBody(req)
  // Authorization is deliberately completed before the first Google request.
  // The service identity is used only by the established user verification;
  // no Xelay headers, credentials, cookies or Google login flow are forwarded.
  const { userId } = await requireTimetableScheduleActor(req, groupId)
  const release = reserveDownload(userId)
  const disconnected = new AbortController()
  const abort = () => disconnected.abort()
  req.once?.('aborted', abort)
  if (req.aborted) abort()
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
  try {
    let url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`)
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted()
      const response = await fetch(url, {
        method: 'GET', redirect: 'manual', cache: 'no-store', signal,
        headers: { Accept: GOOGLE_XLSX_MIME, 'Accept-Encoding': 'identity' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (!location || redirects >= MAX_REDIRECTS) throw new TimetableRecognitionError(422, INVALID_SHEET)
        let next: URL
        try { next = new URL(location, url) } catch { throw new TimetableRecognitionError(422, INVALID_SHEET) }
        if (!allowedRedirect(next, sheetId)) throw new TimetableRecognitionError(403, PRIVATE_SHEET)
        url = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if ([401, 403, 404].includes(response.status)) throw new TimetableRecognitionError(403, PRIVATE_SHEET)
        if (response.status === 429) throw new TimetableRecognitionError(429, 'Google тимчасово обмежив завантаження таблиці. Спробуйте пізніше або додайте XLSX вручну.')
        throw new TimetableRecognitionError(503, 'Google не зміг віддати таблицю. Спробуйте пізніше або додайте файл вручну.')
      }
      return { fileName: 'google-rozklad.xlsx', bytes: await readWorkbook(response, signal) }
    }
  } catch (error) {
    if (error instanceof TimetableRecognitionError) throw error
    if (signal.aborted) throw new TimetableRecognitionError(504, 'Завантаження таблиці тривало надто довго або було скасоване. Спробуйте ще раз або додайте XLSX вручну.')
    throw new TimetableRecognitionError(503, 'Не вдалося завантажити Google Таблицю. Перевірте посилання та спробуйте ще раз.')
  } finally {
    req.removeListener?.('aborted', abort)
    release()
  }
}
