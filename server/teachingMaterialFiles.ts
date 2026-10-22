import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { billingConfiguration } from './billing.js'

const BUCKET = 'xelay-teaching-files'
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_CHUNK_BYTES = 1024 * 1024
const MAX_BODY_BYTES = 2048
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const FILE_PATH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]{1,5}$/i
const UNAVAILABLE = 'Перегляд матеріалу тимчасово недоступний. Спробуйте ще раз.'

class MaterialViewError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

type Settings = { url: string; serviceKey: string; callerKey: string; origin: string }
type ViewRequest = { item_id: string; path: string; offset?: number; length?: number }
type FileAccess = {
  item_id: string; storage_path: string; name: string; mime_type: string; size: number;
  allow_download: boolean; download_allowed: boolean; author_name: string; viewer_name: string; version: number;
  preview_kind: 'pdf' | 'image' | 'text';
}

function settings(): Settings {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  const callerKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || serviceKey
  const origin = billingConfiguration().origin
  let url: URL
  try { url = new URL(process.env.SUPABASE_URL || '') } catch { throw new MaterialViewError(503, UNAVAILABLE) }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || (url.port && url.port !== '443') || !origin || !serviceKey || /\s/.test(serviceKey) || !callerKey) {
    throw new MaterialViewError(503, UNAVAILABLE)
  }
  return { url: url.origin, serviceKey, callerKey, origin }
}

function sameOrigin(req: any, origin: string) {
  if (typeof req.headers?.origin !== 'string' || req.headers.origin !== origin
    || (typeof req.headers?.['sec-fetch-site'] === 'string' && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new MaterialViewError(403, 'Недозволене джерело запиту.')
  }
}

function bodyValue(req: any): ViewRequest {
  const contentType = req.headers?.['content-type']
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new MaterialViewError(415, 'Надішліть запит у форматі JSON.')
  }
  const declared = req.headers?.['content-length']
  if (declared !== undefined && (typeof declared !== 'string' || !/^\d+$/.test(declared))) {
    throw new MaterialViewError(400, 'Некоректний запит.')
  }
  if (Number(declared || 0) > MAX_BODY_BYTES) throw new MaterialViewError(413, 'Запит завеликий.')
  let body: unknown = req.body
  try {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new MaterialViewError(413, 'Запит завеликий.')
      body = JSON.parse(body.toString())
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) throw new MaterialViewError(413, 'Запит завеликий.')
  } catch (error) {
    if (error instanceof MaterialViewError) throw error
    throw new MaterialViewError(400, 'Некоректний запит.')
  }
  const value = body as Record<string, unknown>
  if (Object.keys(value).some(key => !['item_id', 'path', 'offset', 'length'].includes(key))
    || typeof value.item_id !== 'string' || !UUID.test(value.item_id)
    || typeof value.path !== 'string' || !FILE_PATH.test(value.path)) {
    throw new MaterialViewError(400, 'Некоректний файл матеріалу.')
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'offset')) {
    if (Object.prototype.hasOwnProperty.call(value, 'length')) throw new MaterialViewError(400, 'Некоректний фрагмент файлу.')
    return { item_id: value.item_id, path: value.path }
  }
  if (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0
    || !Number.isSafeInteger(value.length) || Number(value.length) < 1 || Number(value.length) > MAX_CHUNK_BYTES) {
    throw new MaterialViewError(400, 'Фрагмент файлу має бути не більшим за 1 МБ.')
  }
  return { item_id: value.item_id, path: value.path, offset: Number(value.offset), length: Number(value.length) }
}

function client(config: Settings, token?: string): SupabaseClient {
  return createClient(config.url, token ? config.callerKey : config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      fetch: (input, options) => fetch(input, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      }),
    },
  })
}

async function activeToken(req: any, service: SupabaseClient): Promise<string> {
  const authorization = req.headers?.authorization
  const token = typeof authorization === 'string' && authorization.length <= 8192
    ? /^Bearer ([^\s]+)$/.exec(authorization)?.[1] : undefined
  if (!token) throw new MaterialViewError(401, 'Увійдіть до свого акаунта.')
  const authenticated = await service.auth.getUser(token)
  if (authenticated.error || !authenticated.data.user?.id) throw new MaterialViewError(401, 'Сесію завершено. Увійдіть ще раз.')
  const canonical = await service.auth.admin.getUserById(authenticated.data.user.id)
  const user = canonical.data.user as (typeof canonical.data.user & { deleted_at?: string | null; banned_until?: string | null })
  if (canonical.error || !user || !UUID.test(user.id) || !user.email_confirmed_at || user.deleted_at
    || (user.banned_until && (!Number.isFinite(Date.parse(user.banned_until)) || Date.parse(user.banned_until) > Date.now()))) {
    throw new MaterialViewError(401, 'Підтвердьте електронну пошту та увійдіть ще раз.')
  }
  return token
}

function authorizedFile(value: unknown, requested: ViewRequest): FileAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MaterialViewError(403, 'Матеріал більше недоступний.')
  const item = value as Record<string, unknown>
  if (item.item_id !== requested.item_id || item.storage_path !== requested.path
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 240 || /[\u0000-\u001f\u007f]/.test(item.name)
    || typeof item.mime_type !== 'string' || !Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > MAX_FILE_BYTES
    || typeof item.allow_download !== 'boolean' || typeof item.download_allowed !== 'boolean'
    || !Number.isSafeInteger(item.version) || Number(item.version) < 1
    || typeof item.author_name !== 'string' || typeof item.viewer_name !== 'string') {
    throw new MaterialViewError(403, 'Не вдалося підтвердити файл матеріалу.')
  }
  const extension = requested.path.split('.').pop()!.toLowerCase()
  let kind: FileAccess['preview_kind']
  if (extension === 'pdf' && item.mime_type === 'application/pdf') kind = 'pdf'
  else if ((extension === 'png' && item.mime_type === 'image/png')
    || (['jpg', 'jpeg'].includes(extension) && item.mime_type === 'image/jpeg')
    || (extension === 'webp' && item.mime_type === 'image/webp')) kind = 'image'
  else if (extension === 'txt' && item.mime_type === 'text/plain') kind = 'text'
  else if (extension === 'csv' && ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'text/x-csv'].includes(item.mime_type)) kind = 'text'
  else throw new MaterialViewError(415, 'На платформі можна переглядати PDF, зображення, TXT та CSV. Для цього формату потрібен інший файл.')
  return {
    item_id: requested.item_id, storage_path: requested.path,
    name: item.name, mime_type: item.mime_type, size: Number(item.size),
    allow_download: item.allow_download, download_allowed: item.download_allowed,
    author_name: item.author_name.slice(0, 160), viewer_name: item.viewer_name.slice(0, 160),
    version: Number(item.version), preview_kind: kind,
  }
}

async function access(config: Settings, token: string, requested: ViewRequest): Promise<FileAccess> {
  // Every metadata/chunk request authorizes the exact current source as the user.
  // The service credential is reserved for reading already authorized bytes.
  const result = await client(config, token).rpc('xelay_teaching_material_file_access', {
    p_item_id: requested.item_id, p_storage_path: requested.path,
  })
  if (result.error) {
    if (result.error.code === '42501' || /FORBIDDEN|WITHDRAWN|NOT_FOUND|AUTHOR_REQUIRED/.test(result.error.message || '')) {
      throw new MaterialViewError(403, 'Матеріал більше недоступний. Оновіть список.')
    }
    if (['PGRST202', '42883'].includes(result.error.code || '')) throw new MaterialViewError(503, 'Перегляд матеріалів ще підключається. Спробуйте пізніше.')
    throw new MaterialViewError(503, UNAVAILABLE)
  }
  return authorizedFile(result.data, requested)
}

async function chunk(config: Settings, file: FileAccess, offset: number, length: number, req: any): Promise<Buffer> {
  if (offset >= file.size) throw new MaterialViewError(416, 'Цього фрагмента файлу немає.')
  const expected = Math.min(length, file.size - offset)
  const end = offset + expected - 1
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once?.('aborted', abort)
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const url = `${config.url}/storage/v1/object/${BUCKET}/${file.storage_path.split('/').map(encodeURIComponent).join('/')}`
    response = await fetch(url, {
      method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      headers: { Authorization: `Bearer ${config.serviceKey}`, apikey: config.serviceKey,
        Range: `bytes=${offset}-${end}`, Accept: file.mime_type, 'Accept-Encoding': 'identity' },
    })
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
    const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    const declared = response.headers.get('content-length')
    // A provider ignoring Range must not cause a 50 MiB response to be buffered.
    // A complete object is allowed only when it is itself this <=1 MiB chunk.
    const wholeSmallObject = response.status === 200 && offset === 0 && expected === file.size && file.size <= MAX_CHUNK_BYTES
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    if (!(wholeSmallObject || response.status === 206 && range && Number(range[1]) === offset && Number(range[2]) === end && Number(range[3]) === file.size)
      || !response.body || mime !== file.mime_type || (encoding && encoding !== 'identity')
      || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expected))) {
      controller.abort()
      throw new MaterialViewError(response.status === 404 ? 404 : 409, 'Файл змінився або перегляд фрагментами недоступний. Оновіть матеріал.')
    }
    reader = response.body.getReader()
    const output = Buffer.alloc(expected)
    let received = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      received += part.value.byteLength
      if (received > expected || received > MAX_CHUNK_BYTES) {
        controller.abort()
        throw new MaterialViewError(413, 'Перевищено розмір фрагмента файлу.')
      }
      output.set(part.value, received - part.value.byteLength)
    }
    if (received !== expected) throw new MaterialViewError(409, 'Файл змінився під час перегляду. Відкрийте матеріал ще раз.')
    return output
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    if (!reader) await response?.body?.cancel().catch(() => {})
    controller.abort()
    req.off?.('aborted', abort)
  }
}

export async function handleTeachingMaterialFileView(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin, Authorization')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const config = settings()
    sameOrigin(req, config.origin)
    const requested = bodyValue(req)
    const token = await activeToken(req, client(config))
    const file = await access(config, token, requested)
    if (req.aborted || res.destroyed || res.writableEnded) return
    if (requested.offset === undefined) return res.status(200).json(file)
    const bytes = await chunk(config, file, requested.offset, requested.length!, req)
    if (req.aborted || res.destroyed || res.writableEnded) return
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(bytes.byteLength))
    res.setHeader('Content-Range', `bytes ${requested.offset}-${requested.offset + bytes.byteLength - 1}/${file.size}`)
    res.setHeader('X-Teaching-Material-Version', String(file.version))
    return res.status(206).send(bytes)
  } catch (error) {
    if (req.aborted || res.destroyed || res.writableEnded) return
    return res.status(error instanceof MaterialViewError ? error.status : 503).json({
      error: error instanceof MaterialViewError ? error.message : UNAVAILABLE,
    })
  }
}
