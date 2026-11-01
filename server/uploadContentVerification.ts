import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { UploadContentValidationError, validateUploadContent } from './uploadContentValidation.js'

const MAX_BYTES = 50 * 1024 * 1024
const MAX_BODY = 2048
const BUCKETS = new Set(['xelay-teaching-files', 'xelay-submission-files', 'xelay-group-presentations', 'xelay-study-materials'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/i
const UNAVAILABLE = 'Не вдалося перевірити вміст файлу. Файл не буде опубліковано. Спробуйте ще раз.'
// Keep whole-file inspection bounded in one server instance. There is no
// in-memory wait queue retaining request bodies; the database also limits actors.
let activeContentChecks = 0
function reserveContentCheck(): () => void {
  if (activeContentChecks >= 2) throw new VerificationError(429, 'Зараз перевіряються інші файли. Спробуйте ще раз за хвилину.')
  activeContentChecks += 1
  return () => { activeContentChecks -= 1 }
}
class VerificationError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
type Settings = { url: string; serviceKey: string; callerKey: string; origin: string }
type Candidate = {
  object_id: string; bucket_id: string; storage_path: string; owner_id: string;
  size: number; mime_type: string; created_at: string; updated_at: string;
  storage_version: string | null; already_verified: boolean;
}

function configuration(): Settings {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  const callerKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
  try {
    const url = new URL(process.env.SUPABASE_URL || '')
    const origin = new URL(process.env.XELAY_PUBLIC_URL || '')
    if ([url, origin].some(value => value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash || value.port && value.port !== '443')
      || !serviceKey || /\s/.test(serviceKey) || !callerKey || /\s/.test(callerKey)) throw Error()
    return { url: url.origin, origin: origin.origin, serviceKey, callerKey }
  } catch { throw new VerificationError(503, UNAVAILABLE) }
}
function body(req: any): { bucket: string; path: string } {
  if (typeof req.headers?.['content-type'] !== 'string' || req.headers['content-type'].split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new VerificationError(415, 'Надішліть запит у форматі JSON.')
  }
  const length = req.headers?.['content-length']
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) throw new VerificationError(400, 'Некоректний запит.')
  if (Number(length || 0) > MAX_BODY) throw new VerificationError(413, 'Запит завеликий.')
  let value: unknown = req.body
  try {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      if (Buffer.byteLength(value) > MAX_BODY) throw new VerificationError(413, 'Запит завеликий.')
      value = JSON.parse(value.toString())
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error()
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY) throw new VerificationError(413, 'Запит завеликий.')
  } catch (error) {
    if (error instanceof VerificationError) throw error
    throw new VerificationError(400, 'Некоректний запит.')
  }
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => key !== 'bucket' && key !== 'path')
    || typeof row.bucket !== 'string' || !BUCKETS.has(row.bucket) || typeof row.path !== 'string' || !PATH.test(row.path)) {
    throw new VerificationError(400, 'Некоректний файл для перевірки.')
  }
  return { bucket: row.bucket, path: row.path }
}
function client(config: Settings, token?: string): SupabaseClient {
  return createClient(config.url, token ? config.callerKey : config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}),
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }),
    },
  })
}
async function activeUser(req: any, service: SupabaseClient): Promise<{ id: string; token: string }> {
  const header = req.headers?.authorization
  const token = typeof header === 'string' && header.length <= 8192 ? /^Bearer ([^\s]+)$/.exec(header)?.[1] : undefined
  if (!token) throw new VerificationError(401, 'Увійдіть до свого акаунта.')
  const authenticated = await service.auth.getUser(token)
  if (authenticated.error || !UUID.test(authenticated.data.user?.id || '')) throw new VerificationError(401, 'Сесію завершено. Увійдіть ще раз.')
  const canonical = await service.auth.admin.getUserById(authenticated.data.user!.id)
  const user = canonical.data.user as (typeof canonical.data.user & { deleted_at?: string | null; banned_until?: string | null })
  if (canonical.error || !user || user.id !== authenticated.data.user!.id || !user.email_confirmed_at || user.deleted_at
    || user.banned_until && (!Number.isFinite(Date.parse(user.banned_until)) || Date.parse(user.banned_until) > Date.now())) {
    throw new VerificationError(401, 'Підтвердьте електронну пошту та увійдіть ще раз.')
  }
  return { id: user.id, token }
}
function candidateValue(value: unknown, requested: { bucket: string; path: string }, actor: string): Candidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VerificationError(403, 'Файл недоступний для перевірки.')
  const row = value as Record<string, unknown>
  if (typeof row.object_id !== 'string' || !UUID.test(row.object_id) || row.bucket_id !== requested.bucket || row.storage_path !== requested.path
    || row.owner_id !== actor || requested.path.split('/')[1] !== actor
    || !Number.isSafeInteger(row.size) || Number(row.size) < 1 || Number(row.size) > MAX_BYTES
    || typeof row.mime_type !== 'string' || !row.mime_type || row.mime_type.length > 160 || /[\r\n\0]/.test(row.mime_type)
    || ![row.created_at, row.updated_at].every(v => typeof v === 'string' && v.length < 80 && Number.isFinite(Date.parse(v)))
    || row.storage_version !== null && (typeof row.storage_version !== 'string' || row.storage_version.length > 160)
    || typeof row.already_verified !== 'boolean') throw new VerificationError(403, 'Не вдалося підтвердити власника та версію файлу.')
  return row as Candidate
}
async function download(config: Settings, file: Candidate, req: any): Promise<Buffer> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once?.('aborted', abort)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let response: Response | undefined
  try {
    if (req.aborted) throw new VerificationError(409, 'Перевірку скасовано.')
    response = await fetch(config.url + '/storage/v1/object/' + file.bucket_id + '/' + file.storage_path.split('/').map(encodeURIComponent).join('/'), {
      method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
      headers: { Authorization: 'Bearer ' + config.serviceKey, apikey: config.serviceKey, 'Accept-Encoding': 'identity' },
    })
    const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
    const length = response.headers.get('content-length')
    if (response.status !== 200 || !response.body || mime !== file.mime_type.toLowerCase()
      || encoding && encoding !== 'identity'
      || length !== null && (!/^\d+$/.test(length) || Number(length) !== file.size)) {
      throw new VerificationError(409, 'Файл змінився або сховище повернуло неправильний формат. Завантажте файл ще раз.')
    }
    reader = response.body.getReader()
    const bytes = Buffer.alloc(file.size)
    let offset = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      if (part.value.byteLength > file.size - offset) throw new VerificationError(413, 'Перевищено розмір файлу.')
      bytes.set(part.value, offset); offset += part.value.byteLength
      if (req.aborted) throw new VerificationError(409, 'Перевірку скасовано.')
    }
    if (offset !== file.size) throw new VerificationError(409, 'Файл змінився під час перевірки. Завантажте його ще раз.')
    return bytes
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    if (!reader) await response?.body?.cancel().catch(() => {})
    controller.abort(); req.off?.('aborted', abort)
  }
}

async function discardRejectedFile(service: SupabaseClient, file: Candidate): Promise<void> {
  // Only a confirmed structural rejection may retire an exact, still-unverified
  // object. SQL refuses legacy/verified/attached files and permanently reserves
  // the retired path. A Storage DELETE trigger rechecks the recorded object.
  try {
    const retired = await service.rpc('xelay_reject_unverified_upload', { p_candidate: file })
    if (!retired.error && retired.data === true) await service.storage.from(file.bucket_id).remove([file.storage_path])
  } catch { /* Keep the rejected object private; bounded maintenance retries. */ }
}

export async function handleUploadContentVerification(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin, Authorization')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  let releaseContentCheck: (() => void) | undefined
  let inspectedFile: Candidate | undefined
  let inspectionService: SupabaseClient | undefined
  try {
    const config = configuration()
    if (req.headers?.origin !== config.origin || typeof req.headers?.['sec-fetch-site'] === 'string' && req.headers['sec-fetch-site'] !== 'same-origin') {
      throw new VerificationError(403, 'Недозволене джерело запиту.')
    }
    const requested = body(req)
    const service = client(config)
    const actor = await activeUser(req, service)
    const result = await client(config, actor.token).rpc('xelay_upload_scan_candidate', { p_bucket: requested.bucket, p_path: requested.path })
    if (result.error) {
      if (result.error.code === 'PT429') throw new VerificationError(429, 'Забагато перевірок файлів. Спробуйте приблизно за 10 хвилин.')
      if (result.error.code === '42501') throw new VerificationError(403, 'У вас немає доступу до цього файлу.')
      throw new VerificationError(503, UNAVAILABLE)
    }
    const file = candidateValue(result.data, requested, actor.id)
    if (file.already_verified) return res.status(200).json({ verified: true, validation_version: 1 })
    releaseContentCheck = reserveContentCheck()
    inspectedFile = file; inspectionService = service
    const bytes = await download(config, file, req)
    const verdict = await validateUploadContent(bytes, file.storage_path.split('.').pop()!.toLowerCase(), file.mime_type)
    if (verdict.mime !== file.mime_type || verdict.validationVersion !== 1) throw new VerificationError(422, 'Формат вмісту не відповідає файлу. Збережіть його у підтримуваному форматі.')
    if (req.aborted || res.destroyed || res.writableEnded) return
    const digest = createHash('sha256').update(bytes).digest('hex')
    const validationDigest = createHash('sha256').update(JSON.stringify({ version: 1, object_id: file.object_id, bucket_id: file.bucket_id,
      storage_path: file.storage_path, owner_id: file.owner_id, size: file.size, mime_type: file.mime_type,
      updated_at: file.updated_at, storage_version: file.storage_version, content_sha256: digest })).digest('hex')
    // Only server-validated bytes can create a receipt. The database compares
    // this snapshot with the current Storage object under a row lock.
    const receipt = await service.rpc('xelay_record_upload_content_verification', {
      p_candidate: file, p_content_sha256: digest, p_validation_sha256: validationDigest,
      p_detected_mime: verdict.mime, p_validation_version: 1,
    })
    if (receipt.error || receipt.data !== true) throw new VerificationError(409, 'Файл змінився під час перевірки. Завантажте його ще раз.')
    return res.status(200).json({ verified: true, validation_version: 1 })
  } catch (error) {
    if (req.aborted || res.destroyed || res.writableEnded) return
    if (error instanceof UploadContentValidationError) {
      if (inspectedFile && inspectionService) await discardRejectedFile(inspectionService, inspectedFile)
      return res.status(422).json({ error: error.message })
    }
    return res.status(error instanceof VerificationError ? error.status : 503).json({ error: error instanceof VerificationError ? error.message : UNAVAILABLE })
  } finally {
    releaseContentCheck?.()
  }
}

