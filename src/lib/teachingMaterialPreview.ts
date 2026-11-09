import { supabase } from './supabase'
import type { TeachingFile, TeachingPublication } from './teaching'

export const TEACHING_MATERIAL_CHUNK_BYTES = 1024 * 1024
export const TEACHING_MATERIAL_PREVIEW_MAX_BYTES = 50 * 1024 * 1024
export const TEACHING_MATERIAL_PAGE_MAX_BYTES = 3.5 * 1024 * 1024
export const TEACHING_MATERIAL_MAX_PAGES = 1000
const ENDPOINT = '/api/security/media-cleanup?xelay_media_route=teaching-material-view'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const BUSY_RETRY_MS = [1000, 1500, 2000]

export type TeachingMaterialFileInfo = {
  item_id: string; storage_path: string; name: string; mime_type: string; size: number;
  allow_download: boolean; author_name: string; viewer_name: string;
  version: number; preview_kind: 'pdf' | 'image' | 'text';
} & ({ render_mode: 'source'; download_allowed: true; page_count?: never }
  | { render_mode: 'raster'; download_allowed: false; page_count: number })

export const TEACHING_MATERIAL_PREVIEW_MIME_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv',
  'application/vnd.ms-excel', 'application/csv', 'text/x-csv',
] as const

export function isTeachingMaterialPreviewFile(file: Pick<TeachingFile, 'name' | 'mime_type'>): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension === 'pdf' && file.mime_type === 'application/pdf'
    || ['jpg', 'jpeg'].includes(extension || '') && file.mime_type === 'image/jpeg'
    || extension === 'png' && file.mime_type === 'image/png'
    || extension === 'webp' && file.mime_type === 'image/webp'
    || extension === 'txt' && file.mime_type === 'text/plain'
    || extension === 'csv' && ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'text/x-csv'].includes(file.mime_type)
}

/** Native File MIME is normalized by the existing upload validator. */
export function canPreviewTeachingMaterial(file: Pick<TeachingFile, 'name' | 'mime_type'> | Pick<File, 'name' | 'type'>): boolean {
  return 'mime_type' in file ? isTeachingMaterialPreviewFile(file) : /\.(pdf|jpe?g|png|webp|txt|csv)$/i.test(file.name)
}

function waitForRenderer(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new DOMException('Перегляд скасовано.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function authorizedRequest(publication: TeachingPublication, file: TeachingFile, extra: Record<string, number>, signal?: AbortSignal, retryBusy = false) {
  if (!UUID.test(publication.id) || !file.storage_path || signal?.aborted) {
    if (signal?.aborted) throw new DOMException('Перегляд скасовано.', 'AbortError')
    throw new Error('Не вдалося визначити файл матеріалу.')
  }
  let actor: string | undefined
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    const current = await supabase.auth.getSession()
    const session = current.data?.session
    if (current.error || !session?.access_token) throw new Error('Увійдіть знову, щоб переглянути матеріал.')
    if (attempt === 0) actor = session.user?.id
    else if (session.user?.id !== actor) throw new Error('Акаунт змінився. Відкрийте матеріал ще раз.')
    signal?.throwIfAborted()
    const response = await fetch(ENDPOINT, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ item_id: publication.id, path: file.storage_path, ...extra }),
    })
    if (response.ok) return response
    if (retryBusy && response.status === 429 && response.headers.get('retry-after') === '1' && attempt < BUSY_RETRY_MS.length) {
      await response.body?.cancel().catch(() => {})
      await waitForRenderer(BUSY_RETRY_MS[attempt], signal)
      continue
    }
    let message = ''
    try {
      const bytes = await boundedBody(response, 8192)
      const value = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown }
      if (typeof value.error === 'string' && value.error.length <= 500) message = value.error
    } catch { /* A provider response is never shown as HTML. */ }
    throw new Error(message || 'Матеріал більше недоступний. Оновіть список і спробуйте ще раз.')
  }
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Перевищено розмір фрагмента матеріалу.')
  }
  if (!response.body) throw new Error('Фрагмент матеріалу недоступний.')
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw new Error('Перевищено розмір фрагмента матеріалу.')
      pieces.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of pieces) { output.set(part, offset); offset += part.byteLength }
  return output
}

export async function getTeachingMaterialFileInfo(publication: TeachingPublication, file: TeachingFile, signal?: AbortSignal): Promise<TeachingMaterialFileInfo> {
  const response = await authorizedRequest(publication, file, {}, signal, true)
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(await boundedBody(response, 8192))) }
  catch { throw new Error('Не вдалося прочитати дані матеріалу.') }
  const item = value as Partial<TeachingMaterialFileInfo> | null
  if (!item || item.item_id !== publication.id || item.storage_path !== file.storage_path
    || typeof item.name !== 'string' || typeof item.mime_type !== 'string'
    || !Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > TEACHING_MATERIAL_PREVIEW_MAX_BYTES
    || !Number.isSafeInteger(item.version) || Number(item.version) < 1
    || typeof item.allow_download !== 'boolean' || typeof item.download_allowed !== 'boolean'
    || typeof item.author_name !== 'string' || typeof item.viewer_name !== 'string'
    || !['pdf', 'image', 'text'].includes(item.preview_kind || '')) {
    throw new Error('Не вдалося підтвердити файл матеріалу.')
  }
  if (item.version !== publication.version) throw new Error('Матеріал змінився. Оновіть список і відкрийте файл ще раз.')
  if (item.download_allowed
    ? item.render_mode !== 'source' || item.page_count !== undefined
    : item.render_mode !== 'raster' || !Number.isSafeInteger(item.page_count) || Number(item.page_count) < 1 || Number(item.page_count) > TEACHING_MATERIAL_MAX_PAGES) {
    throw new Error('Не вдалося підтвердити режим перегляду матеріалу.')
  }
  return item as TeachingMaterialFileInfo
}

export async function getTeachingMaterialFilePage(publication: TeachingPublication, file: TeachingFile, page: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(page) || page < 1 || page > TEACHING_MATERIAL_MAX_PAGES) throw new Error('Некоректна сторінка матеріалу.')
  const response = await authorizedRequest(publication, file, { page }, signal, true)
  if (response.headers.get('x-teaching-material-version') !== String(publication.version)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Матеріал змінився. Оновіть список і відкрийте файл ще раз.')
  }
  const pages = response.headers.get('x-teaching-material-pages') || ''
  const declared = response.headers.get('content-length') || ''
  const length = Number(declared)
  if (response.status !== 200 || response.headers.get('content-type') !== 'image/webp'
    || response.headers.get('x-teaching-material-page') !== String(page)
    || !/^[1-9]\d{0,3}$/.test(pages) || Number(pages) < page || Number(pages) > TEACHING_MATERIAL_MAX_PAGES
    || !/^[1-9]\d*$/.test(declared) || length < 12 || length > TEACHING_MATERIAL_PAGE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Не вдалося підтвердити сторінку матеріалу.')
  }
  const bytes = await boundedBody(response, TEACHING_MATERIAL_PAGE_MAX_BYTES)
  const header = new DataView(bytes.buffer)
  if (bytes.byteLength !== length || header.getUint32(0) !== 0x52494646 || header.getUint32(4, true) !== length - 8 || header.getUint32(8) !== 0x57454250) {
    throw new Error('Не вдалося підтвердити зображення сторінки.')
  }
  return bytes.buffer
}

export async function getTeachingMaterialFileChunk(
  publication: TeachingPublication, file: TeachingFile, offset: number, length: number, signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > TEACHING_MATERIAL_CHUNK_BYTES) {
    throw new Error('Некоректний фрагмент матеріалу.')
  }
  const response = await authorizedRequest(publication, file, { offset, length }, signal)
  if (response.headers.get('x-teaching-material-version') !== String(publication.version)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Матеріал змінився. Оновіть список і відкрийте файл ще раз.')
  }
  const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  if (response.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) < offset
    || Number(range[2]) - offset + 1 > length || Number(range[2]) >= Number(range[3])
    || Number(range[3]) < 1 || Number(range[3]) > TEACHING_MATERIAL_PREVIEW_MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Не вдалося підтвердити фрагмент матеріалу.')
  }
  const bytes = await boundedBody(response, length)
  if (bytes.byteLength !== Number(range[2]) - offset + 1) throw new Error('Фрагмент матеріалу змінився. Відкрийте файл ще раз.')
  return bytes.buffer
}
