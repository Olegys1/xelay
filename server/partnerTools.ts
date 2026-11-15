import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { createClient } from '@supabase/supabase-js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cookieName = 'xelay_partner_browser'
export class PartnerClickError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function partnerClickHeaders(res: any) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
}
function header(req: any, name: string): string {
  const value = req.headers?.[name]
  return typeof value === 'string' ? value : ''
}
export function partnerClickOriginAllowed(req: any, env = process.env): boolean {
  const supplied = header(req, 'origin')
  const host = header(req, 'host').toLowerCase()
  const fetchSite = header(req, 'sec-fetch-site')
  if (!supplied || !host || fetchSite && fetchSite !== 'same-origin') return false
  try {
    const origin = new URL(supplied)
    if (origin.origin !== supplied || origin.host.toLowerCase() !== host || origin.username || origin.password) return false
    if (origin.protocol === 'https:' && ['www.xelay.ink', 'xelay.ink'].includes(origin.hostname) && (!origin.port || origin.port === '443')) return true
    const previewHost = env.VERCEL_ENV !== 'production' && env.VERCEL_URL?.toLowerCase()
    if (previewHost && /^[a-z0-9-]+\.vercel\.app$/.test(previewHost) && host === previewHost && origin.protocol === 'https:') return true
    return env.NODE_ENV !== 'production' && origin.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(origin.hostname)
  } catch { return false }
}
export function partnerClickPayload(req: any): { toolId: string; source: 'catalog' | 'home'; browserId?: string } {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, 'content-type'))) throw new PartnerClickError(415, 'Потрібен JSON-запит.')
  let body: any = req.body
  try {
    if (Buffer.isBuffer(body)) {
      if (body.byteLength > 1024) throw Error('size')
      body = JSON.parse(body.toString('utf8'))
    } else if (typeof body === 'string') {
      if (Buffer.byteLength(body) > 1024) throw Error('size')
      body = JSON.parse(body)
    }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body)) > 1024
      || Object.keys(body).some(k => !['toolId', 'source', 'browserId'].includes(k)) || typeof body.toolId !== 'string' || !uuid.test(body.toolId)
      || body.browserId !== undefined && (typeof body.browserId !== 'string' || !uuid.test(body.browserId))
      || !['catalog', 'home'].includes(body.source)) throw Error('input')
    return { toolId: body.toolId.toLowerCase(), source: body.source, ...(body.browserId ? { browserId: body.browserId.toLowerCase() } : {}) }
  } catch { throw new PartnerClickError(400, 'Некоректний запит.') }
}
export function partnerClickIsAutomated(req: any): boolean {
  const ua = header(req, 'user-agent')
  return !ua || ua.length > 1024 || /bot|crawler|spider|headless|preview|facebookexternalhit|curl\b|wget\b|python-requests/i.test(ua)
    || /prefetch|prerender/i.test(`${header(req, 'purpose')} ${header(req, 'sec-purpose')}`)
}
const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex')
function cookieSignature(secret: string, id: string) { return createHmac('sha256', secret).update('xelay:partner:cookie:' + id).digest('base64url') }
export function partnerClickIdentity(req: any, secret: string, now = new Date(), env = process.env, browserId?: string) {
  if (typeof secret !== 'string' || secret.length < 32) throw new PartnerClickError(503, 'Статистика поки недоступна.')
  const date = now.toISOString().slice(0, 10)
  const candidates = header(req, 'cookie').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '='))
  const value = candidates.length === 1 ? candidates[0].slice(cookieName.length + 1) : ''
  const match = value.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/)
  let id = ''
  if (match && uuid.test(match[1]) && timingSafeEqual(Buffer.from(match[2]), Buffer.from(cookieSignature(secret, match[1])))) id = match[1]
  if (!id) id = browserId && uuid.test(browserId) ? browserId.toLowerCase() : randomUUID()
  // Only the hosting platform's forwarded header is trusted in a deployed function.
  const forwarded = env.VERCEL === '1' ? header(req, 'x-forwarded-for').split(',')[0].trim() : ''
  const address = forwarded && isIP(forwarded) ? forwarded : String(req.socket?.remoteAddress || '')
  if (!isIP(address)) throw new PartnerClickError(400, 'Некоректний запит.')
  return {
    // Stable for the short-lived anonymous browser session, including UTC midnight.
    // The database removes inactive hashes after two days. Cookie values are never persisted.
    fingerprint: hmac(secret, `xelay:partner:browser:${id}`),
    networkFingerprint: hmac(secret, `xelay:partner:network:${date}:${address}`),
    cookie: `${cookieName}=${id}.${cookieSignature(secret, id)}; Max-Age=86400; Path=/api/partners; HttpOnly; SameSite=Lax${env.NODE_ENV === 'production' || header(req, 'origin').startsWith('https:') ? '; Secure' : ''}`,
  }
}
export function partnerClickService(env = process.env) {
  const url = env.SUPABASE_URL || ''
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE || ''
  if (!/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(url) || key.length < 32) throw new PartnerClickError(503, 'Статистика поки недоступна.')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
  })
}
/** Injectable for isolated endpoint tests; all persistence still passes through the service-only RPC. */
export async function collectPartnerClick(req: any, res: any, dependencies: {
  service?: ReturnType<typeof partnerClickService>; env?: typeof process.env; now?: Date;
} = {}) {
  partnerClickHeaders(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const env = dependencies.env || process.env
    if (!partnerClickOriginAllowed(req, env)) throw new PartnerClickError(403, 'Недозволений запит.')
    const payload = partnerClickPayload(req)
    if (partnerClickIsAutomated(req)) return res.status(200).json({ counted: false })
    const secret = env.PARTNER_CLICK_HASH_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE || ''
    const identity = partnerClickIdentity(req, secret, dependencies.now, env, payload.browserId)
    const service = dependencies.service || partnerClickService(env)
    const { data, error } = await service.rpc('xelay_record_partner_click', {
      p_tool_id: payload.toolId, p_source: payload.source, p_fingerprint: identity.fingerprint,
      p_network_fingerprint: identity.networkFingerprint,
    })
    if (error || typeof data?.counted !== 'boolean') throw new PartnerClickError(503, 'Статистика поки недоступна.')
    if (identity.cookie) res.setHeader('Set-Cookie', identity.cookie)
    return res.status(200).json({ counted: data.counted })
  } catch (error) {
    // Requests, identities, destination URLs and service credentials never enter logs or the response.
    return res.status(error instanceof PartnerClickError ? error.status : 503).json({
      error: error instanceof PartnerClickError ? error.message : 'Статистика поки недоступна.',
    })
  }
}
