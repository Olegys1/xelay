import { supabase } from './supabase'
import type { TeachingFile, TeachingPublication } from './teaching'

export const TEACHING_MATERIAL_CHUNK_BYTES = 1024 * 1024
export const TEACHING_MATERIAL_PREVIEW_MAX_BYTES = 50 * 1024 * 1024
const ENDPOINT = '/api/security/media-cleanup?xelay_media_route=teaching-material-view'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export type TeachingMaterialFileInfo = {
  item_id: string; storage_path: string; name: string; mime_type: string; size: number;
  allow_download: boolean; download_allowed: boolean; author_name: string; viewer_name: string;
  version: number; preview_kind: 'pdf' | 'image' | 'text';
}

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

async function authorizedRequest(publication: TeachingPublication, file: TeachingFile, extra: Record<string, number>, signal?: AbortSignal) {
  if (!UUID.test(publication.id) || !file.storage_path || signal?.aborted) {
    if (signal?.aborted) throw new DOMException('Перегляд скасовано.', 'AbortError')
    throw new Error('Не вдалося визначити файл матеріалу.')
  }
  const current = await supabase.auth.getSession()
  if (current.error || !current.data.session?.access_token) throw new Error('Увійдіть знову, щоб переглянути матеріал.')
  if (signal?.aborted) throw new DOMException('Перегляд скасовано.', 'AbortError')
  const response = await fetch(ENDPOINT, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.data.session.access_token}` },
    body: JSON.stringify({ item_id: publication.id, path: file.storage_path, ...extra }),
  })
  if (!response.ok) {
    let message = ''
    try {
      const bytes = await boundedBody(response, 8192)
      const value = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown }
      if (typeof value.error === 'string' && value.error.length <= 500) message = value.error
    } catch { /* A provider response is never shown as HTML. */ }
    throw new Error(message || 'Матеріал більше недоступний. Оновіть список і спробуйте ще раз.')
  }
  return response
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
  const response = await authorizedRequest(publication, file, {}, signal)
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
  return item as TeachingMaterialFileInfo
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
