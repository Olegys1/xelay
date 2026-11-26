import { createClient } from '@supabase/supabase-js'
import { WINTER_CAMPAIGN_ID, WINTER_STARTS_AT, WINTER_ADVENT_ENDS_AT } from '../src/lib/winterCampaign.js'

const PROJECT = 'https://baohfpadxvhqhhjjqtil.supabase.co'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Client = {
  auth: { getUser(token: string): PromiseLike<{ data: { user: any }; error: any }> }
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }>
}
type Dependencies = {
  environment?: Record<string, string | undefined>
  clientFactory?: (url: string, key: string, options: any) => Client
  now?: () => number
  fetcher?: typeof fetch
}
class AdventError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}
const fail = (status: number, code: string): never => { throw new AdventError(status, code) }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const messages: Record<string, string> = {
  forbidden: 'Цю дію можна виконати лише у Xelay.',
  signed_out: 'Увійдіть у свій акаунт, щоб відкрити подарунок.',
  email_unconfirmed: 'Спочатку підтвердьте електронну пошту.',
  invalid_request: 'Не вдалося розпізнати запит. Оновіть сторінку.',
  method_not_allowed: 'Цей метод не підтримується.',
  account_unavailable: 'Календар недоступний для цього акаунта.',
  day_unavailable: 'Цю клітинку зараз не можна відкрити.',
  rate_limited: 'Зачекайте хвилину й спробуйте ще раз.',
  unavailable: 'Не вдалося завантажити календар. Спробуйте ще раз.',
}
export function winterAdventConfiguration(env: Record<string, string | undefined>) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const publicKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
  const privateKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE || ''
  const origins = ['https://www.xelay.ink', 'https://xelay.ink']
  if (env.VERCEL_ENV === 'preview' && /^[a-z0-9-]+\.vercel\.app$/i.test(env.VERCEL_URL || '')) origins.push('https://' + env.VERCEL_URL)
  const enabled = env.WINTER_ADVENT_ENABLED !== 'false' && url === PROJECT && !!publicKey && !!privateKey
    && publicKey !== privateKey && !/\s/.test(publicKey + privateKey) && publicKey.length <= 8192 && privateKey.length <= 8192
  return { url, publicKey, privateKey, origins, enabled }
}
export function winterAdventClock(time: number) {
  const start = Date.parse(WINTER_STARTS_AT), end = Date.parse(WINTER_ADVENT_ENDS_AT)
  return {
    campaignId: WINTER_CAMPAIGN_ID, startsAt: WINTER_STARTS_AT, endsAt: WINTER_ADVENT_ENDS_AT,
    serverNow: new Date(time).toISOString(),
    currentDay: Math.max(0, Math.min(31, Math.floor((time - start) / 86400000) + 1)),
    phase: time < start ? 'upcoming' : time >= end ? 'ended' : 'active',
  }
}
async function readClaim(req: any): Promise<number> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers?.['content-type'] || ''))) return fail(415, 'invalid_request')
  let raw = req.body
  if (raw === undefined) {
    const chunks: Buffer[] = []; let size = 0
    for await (const part of req) {
      const chunk = Buffer.from(part); size += chunk.length
      if (size > 256) return fail(413, 'invalid_request')
      chunks.push(chunk)
    }
    raw = Buffer.concat(chunks)
  }
  if (Buffer.isBuffer(raw)) {
    if (raw.byteLength > 256) return fail(413, 'invalid_request')
    raw = raw.toString('utf8')
  }
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 256) return fail(413, 'invalid_request')
    try { raw = JSON.parse(raw) } catch { return fail(400, 'invalid_request') }
  }
  if (!object(raw) || Object.keys(raw).length !== 1 || !Object.prototype.hasOwnProperty.call(raw, 'day')
    || !Number.isInteger(raw.day) || raw.day < 1 || raw.day > 31) return fail(400, 'invalid_request')
  return raw.day
}
function checkedProgress(raw: unknown, claiming: boolean) {
  if (!object(raw) || typeof raw.serverNow !== 'string' || !Number.isFinite(Date.parse(raw.serverNow))) return fail(503, 'unavailable')
  const clock = winterAdventClock(Date.parse(raw.serverNow))
  if (raw.currentDay !== clock.currentDay || raw.phase !== clock.phase || typeof raw.eligible !== 'boolean'
    || (raw.eligible ? raw.ineligibleReason !== null : raw.ineligibleReason !== 'account_unavailable')
    || !Array.isArray(raw.claimedDays) || raw.claimedDays.length > 31
    || raw.claimedDays.some((day: unknown, index: number) => !Number.isInteger(day) || Number(day) < 1
      || Number(day) > clock.currentDay || (index > 0 && Number(day) <= raw.claimedDays[index - 1]))
    || (!raw.eligible && raw.claimedDays.length > 0)
    || (claiming && (typeof raw.newlyClaimed !== 'boolean' || !raw.eligible))) return fail(503, 'unavailable')
  return { ...clock, eligible: raw.eligible, ineligibleReason: raw.ineligibleReason, claimedDays: [...raw.claimedDays],
    ...(claiming ? { newlyClaimed: raw.newlyClaimed } : {}) }
}
export function createWinterAdventHandler(dependencies: Dependencies = {}) {
  const environment = dependencies.environment || process.env
  const config = winterAdventConfiguration(environment)
  const factory = dependencies.clientFactory || createClient as unknown as NonNullable<Dependencies['clientFactory']>
  const now = dependencies.now || Date.now
  const fetcher = dependencies.fetcher || fetch
  const boundedFetch: typeof fetch = (input, init) => fetcher(input, { ...init, redirect: 'error',
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
  // Only an instance preflight. Durable claim limits and idempotence live in SQL.
  const preflights = new Map<string, { started: number; hits: number; active: number }>()
  function enter(userId: string) {
    const time = now()
    for (const [id, row] of preflights) if (row.active === 0 && row.started <= time - 60000) preflights.delete(id)
    let row = preflights.get(userId)
    if (!row) {
      if (preflights.size >= 2000) return fail(429, 'rate_limited')
      row = { started: time, hits: 0, active: 0 }; preflights.set(userId, row)
    }
    if (row.active >= 4 || row.hits >= 90) return fail(429, 'rate_limited')
    row.hits++; row.active++
    return () => { row!.active = Math.max(0, row!.active - 1) }
  }
  return async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    const send = (status: number, value: unknown) => {
      if (res.writableEnded || res.destroyed) return
      res.statusCode = status; res.setHeader('Content-Type', 'application/json;charset=utf-8'); res.end(JSON.stringify(value))
    }
    let release: (() => void) | undefined
    try {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST'); return fail(405, 'method_not_allowed')
      }
      const origin = req.headers?.origin, fetchSite = req.headers?.['sec-fetch-site']
      if (origin !== undefined && (typeof origin !== 'string' || !config.origins.includes(origin))
        || fetchSite === 'cross-site' || (req.method === 'POST' && typeof origin !== 'string')) return fail(403, 'forbidden')
      let url: URL
      try { url = new URL(req.url || '/api/winter/advent', config.origins[0]) } catch { return fail(400, 'invalid_request') }
      if (url.search || (object(req.query) && Object.keys(req.query).length)) return fail(400, 'invalid_request')
      const day = req.method === 'POST' ? await readClaim(req) : null
      const authorization = req.headers?.authorization
      if (authorization === undefined) {
        if (day !== null) return fail(401, 'signed_out')
        return send(200, { ...winterAdventClock(now()), userId: null, eligible: false, ineligibleReason: 'guest', claimedDays: [] })
      }
      if (!config.enabled) return fail(503, 'unavailable')
      const token = typeof authorization === 'string' ? authorization.match(/^Bearer ([^\s]{16,8192})$/)?.[1] : null
      if (!token || token.split('.').length !== 3) return fail(401, 'signed_out')
      const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      const caller = factory(config.url, config.publicKey, { auth, global: { fetch: boundedFetch, headers: { Authorization: 'Bearer ' + token } } })
      const verified = await caller.auth.getUser(token)
      const user = verified.data?.user
      if (verified.error || !user || typeof user.id !== 'string' || !UUID.test(user.id) || user.is_anonymous === true) return fail(401, 'signed_out')
      let claims: any
      try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { return fail(401, 'signed_out') }
      if (!object(claims) || claims.sub !== user.id || claims.role !== 'authenticated'
        || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now()
        || typeof claims.session_id !== 'string' || !UUID.test(claims.session_id)) return fail(401, 'signed_out')
      const userId = user.id.toLowerCase()
      if (!user.email_confirmed_at) {
        if (day !== null) return fail(403, 'email_unconfirmed')
        return send(200, { ...winterAdventClock(now()), userId, eligible: false, ineligibleReason: 'email_unconfirmed', claimedDays: [] })
      }
      release = enter(userId)
      const service = factory(config.url, config.privateKey, { auth, global: { fetch: boundedFetch } })
      const result = await service.rpc('xelay_winter_advent', { p_user_id: userId, p_session_id: claims.session_id.toLowerCase(), p_claim_day: day })
      if (result.error) {
        const code = String(result.error.code || '')
        if (code === '42501') return fail(403, 'account_unavailable')
        if (code === 'PT409') return fail(409, 'day_unavailable')
        if (code === 'PT429') return fail(429, 'rate_limited')
        if (['22023', '22P02'].includes(code)) return fail(400, 'invalid_request')
        return fail(503, 'unavailable')
      }
      const progress = checkedProgress(result.data, day !== null)
      if (day !== null && !progress.claimedDays.includes(day)) return fail(503, 'unavailable')
      return send(200, { ...progress, userId })
    } catch (error) {
      const known = error instanceof AdventError
      const code = known ? error.code : 'unavailable'
      if (known && error.status === 429) res.setHeader('Retry-After', '60')
      return send(known ? error.status : 503, { code, error: messages[code] || messages.unavailable })
    } finally { release?.() }
  }
}
