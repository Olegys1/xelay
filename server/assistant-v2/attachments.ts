import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { validateUploadContent } from '../uploadContentValidation.ts'

/** Local synthetic preview only. These helpers do not upload or store a file. */
export const ASSISTANT_ATTACHMENT_LIMITS = Object.freeze({ files: 10, eachBytes: 8 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, tableCharacters: 48_000, tableRows: 1000, tableColumns: 40, sheets: 5, sheetDownloadBytes: 2 * 1024 * 1024, sheetTimeoutMs: 15_000 })
export interface IncomingAssistantAttachment { name: string; mimeType?: string; base64: string }
export interface AssistantInlineImage { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
export interface IngestedAssistantAttachments {
  textChunks: { name: string; text: string }[]
  inlineData: AssistantInlineImage[]
  files: { ref: string; name: string; mimeType: string; size: number; kind: 'image' | 'table' | 'material' }[]
}
export class AssistantAttachmentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AssistantAttachmentError' }
}
function fail(code: string, message: string): never { throw new AssistantAttachmentError(code, message) }
const cleanName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[\x00-\x1f\x7f/\\]/.test(value)) fail('attachment_name_invalid', 'Назва файлу має бути звичайним коротким ім’ям без шляху.')
  return value.trim()
}
const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() || ''
const imageMime: Record<string, AssistantInlineImage['mimeType']> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const tableMime: Record<string, string> = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', tsv: 'text/tab-separated-values' }
const materialMime: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
const noControl = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(ASSISTANT_ATTACHMENT_LIMITS.eachBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('attachment_encoding_invalid', 'Файл не вдалося прочитати. Додайте його ще раз.')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > ASSISTANT_ATTACHMENT_LIMITS.eachBytes || bytes.toString('base64') !== value) fail('attachment_size_invalid', 'Додайте непорожній файл розміром до 8 МБ.')
  return bytes
}

function tableText(bytes: Buffer, extension: string): string {
  let workbook: XLSX.WorkBook
  try {
    workbook = extension === 'xlsx'
      ? XLSX.read(bytes, { type: 'buffer', sheetRows: ASSISTANT_ATTACHMENT_LIMITS.tableRows + 1, cellFormula: false, cellHTML: false, cellDates: false, bookVBA: false })
      : XLSX.read(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { type: 'string', raw: true, FS: extension === 'tsv' ? '\t' : undefined, sheetRows: ASSISTANT_ATTACHMENT_LIMITS.tableRows + 1, cellFormula: false, cellHTML: false })
  } catch { return fail('table_invalid', 'Не вдалося прочитати таблицю. Експортуйте її у звичайний XLSX, CSV або TSV.') }
  if (!workbook.SheetNames.length || workbook.SheetNames.length > ASSISTANT_ATTACHMENT_LIMITS.sheets) fail('table_sheet_limit', 'Залиште у файлі від 1 до 5 потрібних аркушів.')
  const pieces: string[] = []
  let characters = 0
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const reference = sheet['!fullref'] || sheet['!ref']
    if (!reference) continue
    let range: XLSX.Range
    try { range = XLSX.utils.decode_range(reference) } catch { return fail('table_invalid', 'Межі таблиці не вдалося прочитати.') }
    if (range.e.r - range.s.r + 1 > ASSISTANT_ATTACHMENT_LIMITS.tableRows || range.e.c - range.s.c + 1 > ASSISTANT_ATTACHMENT_LIMITS.tableColumns) fail('table_dimensions_limit', 'Залиште потрібну частину таблиці: до 1000 рядків і 40 стовпців.')
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: true, defval: '', range })
    const lines = rows.map((row, index) => `${range.s.r + index + 1}: ${row.map(cell => noControl(String(cell ?? '')).slice(0, 2000)).join('\t')}`)
    const merges = (sheet['!merges'] || []).map(merge => XLSX.utils.encode_range(merge)).join(', ')
    const text = `Аркуш: ${noControl(sheetName)}\nСтовпці починаються з ${XLSX.utils.encode_col(range.s.c)}. Номер перед рядком є номером у таблиці.\nОб’єднані клітинки: ${merges || 'немає'}\n${lines.join('\n')}`
    characters += text.length
    if (characters > ASSISTANT_ATTACHMENT_LIMITS.tableCharacters) fail('table_text_limit', 'Таблиця містить забагато тексту. Залиште потрібні групи та тижні.')
    pieces.push(text)
  }
  if (!pieces.length) fail('table_empty', 'У таблиці не знайдено заповнених клітинок.')
  return pieces.join('\n\n')
}

export async function ingestAssistantAttachments(input: unknown): Promise<IngestedAssistantAttachments> {
  if (!Array.isArray(input) || input.length > ASSISTANT_ATTACHMENT_LIMITS.files) fail('attachment_count_limit', 'За один запит можна додати до 10 файлів.')
  const estimatedTotal = input.reduce((sum, item) => sum + (item && typeof item.base64 === 'string' ? Math.floor(item.base64.length / 4) * 3 - (item.base64.endsWith('==') ? 2 : item.base64.endsWith('=') ? 1 : 0) : 0), 0)
  if (estimatedTotal > ASSISTANT_ATTACHMENT_LIMITS.totalBytes) fail('attachment_total_limit', 'Загальний розмір файлів має бути до 20 МБ.')
  const result: IngestedAssistantAttachments = { textChunks: [], inlineData: [], files: [] }
  let total = 0, totalText = 0
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['name', 'mimeType', 'base64'].includes(key))) fail('attachment_invalid', 'Некоректний файл.')
    const name = cleanName(item.name), extension = extensionOf(name)
    if (!imageMime[extension] && !tableMime[extension] && !materialMime[extension]) fail('attachment_format_unsupported', 'Для розкладу підтримуються PNG, JPG, WebP, XLSX, CSV і TSV. Матеріал можна додати у PDF або DOCX; його текст не надсилається моделі.')
    const bytes = decodeBase64(item.base64)
    total += bytes.length
    if (total > ASSISTANT_ATTACHMENT_LIMITS.totalBytes) fail('attachment_total_limit', 'Загальний розмір файлів має бути до 20 МБ.')
    const declared = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase().split(';')[0] : ''
    const expected = imageMime[extension] || tableMime[extension] || materialMime[extension]
    const compatible = !declared || declared === 'application/octet-stream' || declared === expected || extension === 'csv' && ['application/vnd.ms-excel', 'text/plain'].includes(declared) || extension === 'tsv' && ['text/plain', 'text/csv'].includes(declared)
    if (!compatible) fail('attachment_mime_mismatch', 'Тип файлу не відповідає його формату.')
    try { await validateUploadContent(bytes, extension === 'tsv' ? 'csv' : extension, extension === 'tsv' ? 'text/csv' : declared) }
    catch { return fail('attachment_content_invalid', 'Вміст файлу не пройшов перевірку. Збережіть звичайне зображення або таблицю без активних об’єктів і зовнішніх зв’язків.') }
    const ref = `attachment-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`
    if (imageMime[extension]) result.inlineData.push({ mimeType: imageMime[extension], data: bytes.toString('base64') })
    else if (tableMime[extension]) {
      const text = tableText(bytes, extension)
      totalText += text.length
      if (totalText > ASSISTANT_ATTACHMENT_LIMITS.tableCharacters) fail('table_text_limit', 'У файлах забагато тексту. Залиште потрібні групи та тижні.')
      result.textChunks.push({ name, text })
    }
    result.files.push({ ref, name, mimeType: expected, size: bytes.length, kind: imageMime[extension] ? 'image' : tableMime[extension] ? 'table' : 'material' })
  }
  return result
}

export function publicGoogleSheetExportUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) fail('sheet_url_invalid', 'Додайте звичайне посилання на Google-таблицю.')
  let url: URL
  try { url = new URL(value) } catch { return fail('sheet_url_invalid', 'Не вдалося прочитати посилання на таблицю.') }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password) fail('sheet_url_invalid', 'Підтримується лише HTTPS-посилання docs.google.com на Google-таблицю.')
  const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,150})(?:\/(?:edit|view|preview|copy|export))?\/?$/)
  if (!match) fail('sheet_url_invalid', 'Додайте посилання саме на Google-таблицю, а не на папку чи інший документ.')
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const gid = url.searchParams.get('gid') ?? fragment.get('gid') ?? '0'
  if (!/^\d{1,12}$/.test(gid)) fail('sheet_url_invalid', 'Номер аркуша у посиланні некоректний.')
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`
}

function allowedSheetRedirect(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && value.length <= 6000
    && (url.hostname === 'docs.google.com' && /^\/spreadsheets\//.test(url.pathname) || /^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(url.hostname))
}
async function boundedDownload(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > ASSISTANT_ATTACHMENT_LIMITS.sheetDownloadBytes)) fail('sheet_download_limit', 'Таблиця завелика. Виберіть окремий аркуш або потрібну частину.')
  if (!response.body) fail('sheet_download_invalid', 'Google не повернув таблицю.')
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > ASSISTANT_ATTACHMENT_LIMITS.sheetDownloadBytes) { await reader.cancel(); fail('sheet_download_limit', 'Таблиця завелика. Залиште потрібну частину.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}

/** Downloads public CSV only. No Google cookies, OAuth, sign-in, or arbitrary URL fetch. */
export async function ingestPublicGoogleSheet(value: unknown, { fetchImpl = globalThis.fetch, signal }: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<IngestedAssistantAttachments> {
  let target = publicGoogleSheetExportUrl(value)
  const controller = new AbortController(), abort = () => controller.abort()
  const timer = setTimeout(abort, ASSISTANT_ATTACHMENT_LIMITS.sheetTimeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) throw new Error('aborted')
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await fetchImpl(target, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: 'text/csv' }, signal: controller.signal })
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        let next = ''
        try { next = new URL(location || '', target).href } catch {}
        if (redirects === 2 || !location || !allowedSheetRedirect(next)) fail('sheet_public_access_required', 'Таблиця просить вхід або недоступна за відкритим посиланням. Надайте доступ на перегляд за посиланням або завантажте XLSX.')
        target = next
        continue
      }
      if ([401,403].includes(response.status)) fail('sheet_public_access_required', 'Таблиця закрита. Надайте доступ на перегляд за посиланням або завантажте XLSX.')
      if (!response.ok) fail('sheet_unavailable', 'Google-таблиця зараз недоступна. Спробуйте файл XLSX; автоматичних повторів немає.')
      const type = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
      if (!['text/csv','text/plain','application/octet-stream','application/csv'].includes(type)) fail('sheet_public_access_required', 'За посиланням отримано сторінку входу, а не таблицю. Додайте публічну таблицю або файл XLSX.')
      const bytes = await boundedDownload(response, controller.signal)
      return await ingestAssistantAttachments([{ name: 'Google-таблиця.csv', mimeType: 'text/csv', base64: bytes.toString('base64') }])
    }
    return fail('sheet_unavailable', 'Не вдалося отримати таблицю.')
  } catch (error) {
    if (error instanceof AssistantAttachmentError) throw error
    return fail(controller.signal.aborted || signal?.aborted ? 'sheet_download_timeout' : 'sheet_unavailable', 'Не вдалося отримати Google-таблицю. Спробуйте завантажити XLSX.')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
