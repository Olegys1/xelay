import { createClient } from '@supabase/supabase-js'
import { winterAdventConfiguration } from './winter-advent.js'
import { parseWinterBenefitAction, parseWinterBenefitsState } from '../src/lib/winterBenefits.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Client = { auth: { getUser(token: string): PromiseLike<{ data: { user: any }; error: any }> }; rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: any }> }
type Dependencies = { environment?: Record<string, string | undefined>; now?: () => number; fetcher?: typeof fetch; clientFactory?: (url: string, key: string, options: any) => Client }
class BenefitError extends Error { constructor(public status: number, public code: string) { super(code) } }
const fail = (status: number, code: string): never => { throw new BenefitError(status, code) }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const messages: Record<string, string> = {
  signed_out: 'Увійдіть у свій акаунт, щоб використати подарунок.',
  forbidden: 'Ця дія доступна лише у Xelay.',
  email_unconfirmed: 'Спочатку підтвердьте електронну пошту.',
  invalid_request: 'Перевірте вибраний подарунок.',
  unavailable: 'Не вдалося перевірити подарунок. Спробуйте ще раз.',
  account_unavailable: 'Подарунки недоступні для цього акаунта.',
  benefit_unavailable: 'Цей подарунок ще не відкрито або строк його активації минув.',
  paid_plan_required: 'Подарунок чекає на активну оплачену підписку відповідного рівня.',
  subscription_paused: 'Спочатку відновіть підписку після паузи.',
  pending_request: 'Дочекайтеся завершення поточного запиту до помічника.',
  upgrade_active: 'Пауза стане доступною після завершення подарованого доступу до Макса.',
  upgrade_gift_active: 'Подарований Макс уже діє. Цей день збережено: активуйте його після завершення поточного подарованого доступу.',
  gift_active: 'Пауза стане доступною після завершення окремого подарованого доступу. Його час і ліміт залишаються без змін.',
  rate_limited: 'Зачекайте хвилину й спробуйте ще раз.',
}
async function actionBody(req: any) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers?.['content-type'] || ''))) return fail(415, 'invalid_request')
  let raw = req.body
  if (raw === undefined) {
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of req) { const part = Buffer.from(chunk); bytes += part.length; if (bytes > 512) return fail(413, 'invalid_request'); chunks.push(part) }
    raw = Buffer.concat(chunks)
  }
  if (Buffer.isBuffer(raw)) { if (raw.byteLength > 512) return fail(413, 'invalid_request'); raw = raw.toString('utf8') }
  if (typeof raw === 'string') { if (Buffer.byteLength(raw) > 512) return fail(413, 'invalid_request'); try { raw = JSON.parse(raw) } catch { return fail(400, 'invalid_request') } }
  try { return parseWinterBenefitAction(raw) } catch { return fail(400, 'invalid_request') }
}
/** Every privileged mutation revalidates the exact live session and benefits in SQL. */
export function createWinterBenefitsHandler(dependencies: Dependencies = {}) {
  const configuration = winterAdventConfiguration(dependencies.environment || process.env)
  const factory = dependencies.clientFactory || createClient as unknown as NonNullable<Dependencies['clientFactory']>
  const now = dependencies.now || Date.now, fetcher = dependencies.fetcher || fetch
  const boundedFetch: typeof fetch = (input, init) => fetcher(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
  return async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    const send = (status: number, value: unknown) => { if (res.writableEnded || res.destroyed) return; res.statusCode = status; res.setHeader('Content-Type', 'application/json;charset=utf-8'); res.end(JSON.stringify(value)) }
    try {
      if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return fail(405, 'invalid_request') }
      const origin = req.headers?.origin
      if (origin !== undefined && (typeof origin !== 'string' || !configuration.origins.includes(origin))
        || req.headers?.['sec-fetch-site'] === 'cross-site' || req.method === 'POST' && typeof origin !== 'string') return fail(403, 'forbidden')
      let url: URL; try { url = new URL(req.url || '/api/winter/benefits', configuration.origins[0]) } catch { return fail(400, 'invalid_request') }
      if (url.search || object(req.query) && Object.keys(req.query).length) return fail(400, 'invalid_request')
      const action = req.method === 'POST' ? await actionBody(req) : null
      if (!configuration.enabled) return fail(503, 'unavailable')
      const token = typeof req.headers?.authorization === 'string' ? req.headers.authorization.match(/^Bearer ([^\s]{16,8192})$/)?.[1] : null
      if (!token || token.split('.').length !== 3) return fail(401, 'signed_out')
      const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      const caller = factory(configuration.url, configuration.publicKey, { auth, global: { fetch: boundedFetch, headers: { Authorization: 'Bearer ' + token } } })
      const verified = await caller.auth.getUser(token), user = verified.data?.user
      if (verified.error || !user || typeof user.id !== 'string' || !UUID.test(user.id) || user.is_anonymous === true) return fail(401, 'signed_out')
      let claims: any; try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { return fail(401, 'signed_out') }
      if (!object(claims) || claims.sub !== user.id || claims.role !== 'authenticated' || !Number.isSafeInteger(claims.exp)
        || claims.exp * 1000 <= now() || typeof claims.session_id !== 'string' || !UUID.test(claims.session_id)) return fail(401, 'signed_out')
      if (!user.email_confirmed_at) return fail(403, 'email_unconfirmed')
      const service = factory(configuration.url, configuration.privateKey, { auth, global: { fetch: boundedFetch } })
      const result = await service.rpc('xelay_winter_benefits', { p_user_id: user.id.toLowerCase(), p_session_id: claims.session_id.toLowerCase(), p_action: action })
      if (result.error) {
        const code = String(result.error.code || ''), message = String(result.error.message || '')
        if (message.includes('PAID_PLAN_REQUIRED')) return fail(409, 'paid_plan_required')
        if (message.includes('SUBSCRIPTION_PAUSED')) return fail(409, 'subscription_paused')
        if (message.includes('PENDING_REQUEST')) return fail(409, 'pending_request')
        if (message.includes('UPGRADE_ACTIVE')) return fail(409, 'upgrade_active')
        if (message.includes('UPGRADE_GIFT_ACTIVE')) return fail(409, 'upgrade_gift_active')
        if (message.includes('GIFT_ACTIVE')) return fail(409, 'gift_active')
        if (code === 'PT429') { res.setHeader('Retry-After', '60'); return fail(429, 'rate_limited') }
        if (code === '42501') return fail(403, 'account_unavailable')
        if (code === 'PT409') return fail(409, 'benefit_unavailable')
        if (['22023', '22P02'].includes(code)) return fail(400, 'invalid_request')
        return fail(503, 'unavailable')
      }
      let state; try { state = parseWinterBenefitsState(result.data) } catch { return fail(503, 'unavailable') }
      return send(200, state)
    } catch (error) { const known = error instanceof BenefitError; const code = known ? error.code : 'unavailable'; return send(known ? error.status : 503, { code, error: messages[code] || messages.unavailable }) }
  }
}
