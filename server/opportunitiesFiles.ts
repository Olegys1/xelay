import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { billingConfiguration } from './billing.js'

const BUCKET = 'opportunities-private'
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_BODY_BYTES = 2048
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const FILE_PATH = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(resume|company|opportunity)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.pdf$/i
const UNAVAILABLE = 'Перевірку PDF ще не підключено. Спробуйте пізніше.'
const INVALID_FILE = 'Не вдалося перевірити PDF. Оберіть справжній PDF до 10 МБ і завантажте його ще раз.'

class OpportunitiesFileError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

type Settings = { url: string; serviceKey: string; origin: string }
type FileProbe = { object_id: string; updated_at: string; size: number; mime: string }

function settings(): Settings {
  // Keep this broker dormant independently of the public workspace switch.
  if (process.env.OPPORTUNITIES_FILE_VALIDATION_ENABLED !== 'true') throw new OpportunitiesFileError(503, UNAVAILABLE)
  const origin = billingConfiguration().origin
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  let url: URL
  try { url = new URL(process.env.SUPABASE_URL || '') } catch { throw new OpportunitiesFileError(503, UNAVAILABLE) }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || (url.port && url.port !== '443') || !origin || !serviceKey || /\s/.test(serviceKey)) {
    throw new OpportunitiesFileError(503, UNAVAILABLE)
  }
  return { url: url.origin, serviceKey, origin }
}

function sameOrigin(req: any, origin: string) {
  // No CORS permission is granted. Browser POST requests must originate from
  // the configured application, including when the caller supplies a JWT.
  if (typeof req.headers?.origin !== 'string' || req.headers.origin !== origin
    || (typeof req.headers?.['sec-fetch-site'] === 'string' && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new OpportunitiesFileError(403, 'Недозволене джерело запиту.')
  }
}

function requestedPath(req: any): string {
  const type = req.headers?.['content-type']
  if (typeof type !== 'string' || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new OpportunitiesFileError(415, 'Надішліть запит у форматі JSON.')
  }
  const declaredLength = req.headers?.['content-length']
  if (declaredLength !== undefined && (typeof declaredLength !== 'string' || !/^\d+$/.test(declaredLength))) {
    throw new OpportunitiesFileError(400, 'Некоректний запит.')
  }
  if (Number(declaredLength || 0) > MAX_BODY_BYTES) throw new OpportunitiesFileError(413, 'Запит завеликий.')
  let body: unknown = req.body
  try {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new OpportunitiesFileError(413, 'Запит завеликий.')
      body = JSON.parse(body.toString())
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_BODY')
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) throw new OpportunitiesFileError(413, 'Запит завеликий.')
  } catch (error) {
    if (error instanceof OpportunitiesFileError) throw error
    throw new OpportunitiesFileError(400, 'Некоректний запит.')
  }
  const value = body as Record<string, unknown>
  if (Object.keys(value).length !== 1 || typeof value.path !== 'string' || !FILE_PATH.test(value.path)) {
    throw new OpportunitiesFileError(400, 'Некоректний шлях файлу.')
  }
  return value.path
}

function serviceClient(config: Settings): SupabaseClient {
  return createClient(config.url, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, options) => fetch(input, {
      ...options,
      signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    }) },
  })
}

async function verifiedOwner(req: any, service: SupabaseClient): Promise<string> {
  const authorization = req.headers?.authorization
  const token = typeof authorization === 'string' && authorization.length <= 8192
    ? /^Bearer ([^\s]+)$/.exec(authorization)?.[1] : undefined
  if (!token) throw new OpportunitiesFileError(401, 'Увійдіть у свій обліковий запис.')
  // getUser validates the supplied token with Auth rather than trusting claims
  // from a decoded JWT or any identity included in the request body.
  const authenticated = await service.auth.getUser(token)
  if (authenticated.error || !authenticated.data.user?.id) throw new OpportunitiesFileError(401, 'Сесію завершено. Увійдіть ще раз.')
  const canonical = await service.auth.admin.getUserById(authenticated.data.user.id)
  const user = canonical.data.user as (typeof canonical.data.user & { deleted_at?: string | null; banned_until?: string | null })
  if (canonical.error || !user || !UUID.test(user.id) || !user.email || !user.email_confirmed_at || user.deleted_at
    || (user.banned_until && Date.parse(user.banned_until) > Date.now())) {
    throw new OpportunitiesFileError(401, 'Підтвердьте електронну пошту та увійдіть знову.')
  }
  return user.id
}

function probeValue(value: unknown): FileProbe {
  const probe = value as Partial<FileProbe> | null
  if (!probe || typeof probe !== 'object' || typeof probe.object_id !== 'string' || !UUID.test(probe.object_id)
    || typeof probe.updated_at !== 'string' || !Number.isFinite(Date.parse(probe.updated_at))
    || typeof probe.size !== 'number' || !Number.isSafeInteger(probe.size) || probe.size < 5 || probe.size > MAX_FILE_BYTES
    || probe.mime !== 'application/pdf') throw new OpportunitiesFileError(400, INVALID_FILE)
  return probe as FileProbe
}

function databaseError(error: { message?: string } | null | undefined): never {
  if (error?.message?.includes('OPPORTUNITIES_DEVELOPMENT')) throw new OpportunitiesFileError(503, UNAVAILABLE)
  if (error?.message?.includes('OPPORTUNITIES_LIMIT')) throw new OpportunitiesFileError(429, 'На сьогодні використано ліміт завантажень. Спробуйте завтра.')
  if (error?.message?.includes('OPPORTUNITIES_FILE_INVALID')) throw new OpportunitiesFileError(400, INVALID_FILE)
  throw new OpportunitiesFileError(503, 'Не вдалося перевірити файл. Спробуйте пізніше.')
}

async function inspectStoredPdf(config: Settings, path: string, expectedSize: number): Promise<{ size: number; sha256: string }> {
  // The destination is constructed exclusively from trusted server settings
  // and the already validated own-file path. Never accept a download URL.
  const url = `${config.url}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetch(url, {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${config.serviceKey}`, apikey: config.serviceKey, Accept: 'application/pdf', 'Accept-Encoding': 'identity' },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 404) throw new OpportunitiesFileError(400, INVALID_FILE)
    throw new OpportunitiesFileError(503, 'Не вдалося прочитати файл. Завантажте його ще раз.')
  }
  const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  const declaredLength = response.headers.get('content-length')
  if (mime !== 'application/pdf' || (encoding && encoding !== 'identity') || !response.body
    || (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedSize))) {
    await response.body?.cancel().catch(() => {})
    throw new OpportunitiesFileError(400, INVALID_FILE)
  }
  const reader = response.body.getReader()
  const digest = createHash('sha256')
  const signature = Buffer.alloc(5)
  let signatureLength = 0
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_FILE_BYTES || size > expectedSize) throw new OpportunitiesFileError(413, INVALID_FILE)
      if (signatureLength < 5) {
        const prefix = value.subarray(0, Math.min(5 - signatureLength, value.byteLength))
        signature.set(prefix, signatureLength)
        signatureLength += prefix.byteLength
        if (signatureLength === 5 && signature.toString('ascii') !== '%PDF-') throw new OpportunitiesFileError(400, INVALID_FILE)
      }
      digest.update(value)
    }
    if (size !== expectedSize || signatureLength !== 5 || signature.toString('ascii') !== '%PDF-') {
      throw new OpportunitiesFileError(400, INVALID_FILE)
    }
    return { size, sha256: digest.digest('hex') }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function handleOpportunitiesFileValidation(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }) }
  try {
    const config = settings()
    sameOrigin(req, config.origin)
    const path = requestedPath(req)
    const service = serviceClient(config)
    const ownerId = await verifiedOwner(req, service)
    if (path.split('/')[0] !== ownerId) throw new OpportunitiesFileError(403, 'Можна перевірити лише власний файл.')
    const probeResult = await service.rpc('xelay_opportunities_file_probe', { p_path: path })
    if (probeResult.error) databaseError(probeResult.error)
    const probe = probeValue(probeResult.data)
    const inspected = await inspectStoredPdf(config, path, probe.size)
    // Registering the upload requires this short-lived marker and rechecks its
    // immutable Storage object ID/version, preventing replace-between-checks.
    const verified = await service.rpc('xelay_opportunities_verify_file', {
      p_path: path, p_size: inspected.size, p_sha256: inspected.sha256,
      p_object_id: probe.object_id, p_updated_at: probe.updated_at,
    })
    if (verified.error) databaseError(verified.error)
    if (verified.data !== true) throw new OpportunitiesFileError(409, 'Файл змінився під час перевірки. Завантажте його ще раз.')
    return res.status(200).json({ ok: true })
  } catch (error) {
    if (res.writableEnded || res.destroyed) return
    // Raw provider responses, bearer tokens, paths and PDF bytes never enter
    // logs or the browser response, including on unexpected failures.
    return res.status(error instanceof OpportunitiesFileError ? error.status : 503).json({
      error: error instanceof OpportunitiesFileError ? error.message : 'Не вдалося перевірити файл. Спробуйте пізніше.',
    })
  }
}
