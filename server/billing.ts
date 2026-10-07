import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { legalMerchant } from '../src/lib/legal.js'
import { SUPPORT_ORDER_REFERENCE } from '../src/lib/teamSupport.js'

export type BillingMode = 'disabled' | 'test' | 'live'
export class BillingError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const ORDER_REFERENCE = /^xelay_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const PROVIDER_RESPONSE_LIMIT = 32_768

export function billingConfiguration() {
  const requested = process.env.BILLING_MODE || 'disabled'
  const mode: BillingMode = requested === 'live' || requested === 'test' ? requested : 'disabled'
  const originText = process.env.XELAY_PUBLIC_URL || ''
  let origin = ''
  try {
    const parsed = new URL(originText)
    if (parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password) origin = parsed.origin
  } catch { /* Invalid/incomplete configuration stays unavailable. */ }
  const merchant = process.env.WAYFORPAY_MERCHANT_ACCOUNT || ''
  const secret = process.env.WAYFORPAY_SECRET_KEY || ''
  const domain = process.env.WAYFORPAY_MERCHANT_DOMAIN || ''
  const serverReady = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY))
  const isolatedTest = process.env.BILLING_TEST_ISOLATED === 'true' && process.env.VERCEL_ENV !== 'production'
  // A test merchant is never permitted to masquerade as a live merchant.
  const testMerchant = /^test[_-]/i.test(merchant)
  const credentialsReady = serverReady && Boolean(merchant && secret)
    && (mode === 'test' ? isolatedTest && testMerchant : mode === 'live' && !testMerchant)
  const domainMatches = Boolean(origin) && domain === new URL(origin).hostname
  const checkoutAvailable = credentialsReady && Boolean(origin && domainMatches)
    && process.env.BILLING_CHECKOUT_ENABLED === 'true'
    && (mode === 'test' || process.env.WAYFORPAY_LIVE_APPROVED === 'true')
  // Pausing new orders must not prevent callbacks or completed refunds from
  // updating existing orders. Keep BILLING_MODE/merchant credentials unchanged.
  return { mode, checkoutAvailable, callbacksAvailable: credentialsReady, origin, merchant, secret, domain }
}

export function publicBillingConfiguration() {
  const config = billingConfiguration()
  return { mode: config.mode, checkoutAvailable: config.checkoutAvailable && legalMerchant.ready, groupAccessFree: true, groupLicenseAvailable: false, prices: { participant: 100, group: 0 }, periods: { participantMonths: 1, groupMonths: 0, groupTrialDays: 0 }, automaticRenewal: false }
}

export function serverSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new BillingError(503, 'Платіжний сервіс ще не налаштовано.')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export async function authenticateRequest(req: any, optional = false) {
  const authorization = req.headers?.authorization
  if (typeof authorization !== 'string') {
    if (optional) return null
    throw new BillingError(401, 'Увійдіть у свій обліковий запис.')
  }
  const token = authorization.match(/^Bearer ([^\s]+)$/)?.[1]
  if (!token) throw new BillingError(401, 'Не вдалося підтвердити вхід.')
  const client = serverSupabase()
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw new BillingError(401, 'Сесію завершено. Увійдіть ще раз.')
  // PostgREST uses the caller JWT for auth.uid() even though this server client
  // uses the service key only for getUser/admin operations elsewhere.
  const userClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } },
  })
  return { user: data.user, userClient, service: client }
}

export function requestBody(req: any): Record<string, any> {
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > 32_768) throw new BillingError(413, 'Запит завеликий.')
    try {
      const parsed = JSON.parse(req.body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { throw new BillingError(400, 'Некоректний запит.') }
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 32_768) throw new BillingError(413, 'Запит завеликий.')
    return req.body
  }
  throw new BillingError(400, 'Некоректний запит.')
}

export function enforceSameOrigin(req: any) {
  const origin = req.headers?.origin
  if (origin && origin !== billingConfiguration().origin) throw new BillingError(403, 'Недозволене джерело запиту.')
}

export function signature(values: Array<string | number>, secret: string) {
  return createHmac('md5', secret).update(values.map(String).join(';'), 'utf8').digest('hex')
}
export function signatureMatches(received: unknown, expected: string) {
  if (typeof received !== 'string' || !/^[a-fA-F0-9]{32}$/.test(received)) return false
  return timingSafeEqual(Buffer.from(received.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'))
}

export function signedCheckout(order: any, clientEmail: string | undefined) {
  // Previously opened group payments still settle through the webhook and
  // reconciliation. Never issue a new payable form for the now-free groups.
  if (order.product === 'group') throw new BillingError(409, 'Навчальні групи тепер безкоштовні. Оплата не потрібна.')
  const config = billingConfiguration()
  if (!config.checkoutAvailable) throw new BillingError(503, 'Оплату ще не активовано.')
  const orderDate = Math.floor(new Date(order.created_at).getTime() / 1000)
  if (!ORDER_REFERENCE.test(order.order_reference) || !Number.isFinite(orderDate)
    || order.product !== 'participant' || order.mode !== config.mode
    || order.currency !== 'UAH' || Number(order.amount) !== 100 || order.group_id !== null) {
    throw new BillingError(500, 'Не вдалося підготувати замовлення. Спробуйте пізніше.')
  }
  const productName = 'Xelay Учасник — доступ на один місяць'
  const amount = Number(order.amount)
  const fields: Record<string, string | number | string[] | number[]> = {
    merchantAccount: config.merchant,
    merchantAuthType: 'SimpleSignature',
    merchantDomainName: config.domain,
    merchantTransactionType: 'AUTO',
    merchantTransactionSecureType: 'AUTO',
    apiVersion: 1,
    orderReference: order.order_reference,
    orderDate,
    amount,
    currency: 'UAH',
    productName: [productName],
    productCount: [1],
    productPrice: [amount],
    language: 'UA',
    orderTimeout: 3600,
    orderLifetime: 3600,
    regularMode: 'none',
    serviceUrl: `${config.origin}/api/billing/webhook`,
    returnUrl: `${config.origin}/api/billing/return?orderReference=${encodeURIComponent(order.order_reference)}`,
    merchantSignature: signature([config.merchant, config.domain, order.order_reference, orderDate, amount, 'UAH', productName, 1, amount], config.secret),
  }
  if (clientEmail) fields.clientEmail = clientEmail
  return { action: 'https://secure.wayforpay.com/pay', fields }
}

export function newOrderReference() { return `xelay_${randomUUID()}` }

export function verifyPaymentPayload(payload: Record<string, any>, expectedReference?: string) {
  const config = billingConfiguration()
  if (!config.callbacksAvailable) throw new BillingError(503, 'Обробку платежів ще не налаштовано.')
  const fields = ['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode']
  for (const field of fields) {
    if (!['string', 'number'].includes(typeof payload[field]) || String(payload[field]).length > 250 || String(payload[field]).includes(';')) {
      throw new BillingError(400, 'Некоректне повідомлення платіжного сервісу.')
    }
  }
  if (payload.merchantAccount !== config.merchant) throw new BillingError(403, 'Невідомий продавець.')
  const expected = signature(fields.map((field) => payload[field]), config.secret)
  if (!signatureMatches(payload.merchantSignature, expected)) throw new BillingError(403, 'Некоректний підпис платежу.')
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount) || amount <= 0 || payload.currency !== 'UAH') throw new BillingError(400, 'Некоректна сума платежу.')
  const reference = String(payload.orderReference)
  if ((!ORDER_REFERENCE.test(reference) && !SUPPORT_ORDER_REFERENCE.test(reference)) || (expectedReference && reference !== expectedReference)) throw new BillingError(400, 'Невідоме замовлення.')
  return { config, amount, reference, expected }
}

export async function processVerifiedPayment(payload: Record<string, any>, expectedReference?: string) {
  const { config, amount, reference, expected } = verifyPaymentPayload(payload, expectedReference)
  const fingerprint = createHash('sha256').update(`${config.mode};${reference};${String(payload.transactionStatus)};${expected}`).digest('hex')
  const support = SUPPORT_ORDER_REFERENCE.test(reference)
  const { error } = await serverSupabase().rpc(support ? 'xelay_apply_support_event' : 'xelay_apply_billing_event', {
    p_reference: reference, p_mode: config.mode, p_fingerprint: fingerprint,
    p_status: String(payload.transactionStatus), p_amount: amount, p_currency: 'UAH',
    // The callback HMAC does not cover fee; never treat it as audited revenue.
    ...(support ? {} : { p_fee: null }),
  })
  if (error) throw new BillingError(409, 'Платіж не відповідає замовленню або потребує повторної перевірки.')
  const time = Math.floor(Date.now() / 1000)
  return { orderReference: reference, status: 'accept', time, signature: signature([reference, 'accept', time], config.secret) }
}

/** Recovery when a callback is delayed: only the order's owner may initiate it. */
export async function reconcileOwnedOrder(auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>, reference: unknown) {
  const config = billingConfiguration()
  if (!config.callbacksAvailable) throw new BillingError(503, 'Перевірку платежів ще не налаштовано.')
  if (typeof reference !== 'string' || (!ORDER_REFERENCE.test(reference) && !SUPPORT_ORDER_REFERENCE.test(reference))) throw new BillingError(400, 'Оберіть своє замовлення для перевірки.')
  const support = SUPPORT_ORDER_REFERENCE.test(reference)
  const { data: order, error: orderError } = await auth.service.from(support ? 'support_orders' : 'billing_orders')
    .select('order_reference').eq('order_reference', reference).eq('user_id', auth.user.id).eq('mode', config.mode).maybeSingle()
  if (orderError) throw new BillingError(503, 'Не вдалося перевірити замовлення. Спробуйте пізніше.')
  if (!order) throw new BillingError(404, 'Замовлення не знайдено у вашому акаунті.')
  // Database lock/cooldown applies across server instances and browser tabs.
  const { data: claimed, error: claimError } = await auth.service.rpc(support ? 'xelay_claim_support_reconciliation' : 'xelay_claim_billing_reconciliation', {
    p_user_id: auth.user.id, p_reference: reference, p_mode: config.mode,
  })
  if (claimError) throw new BillingError(503, 'Повторну перевірку ще не підключено. Спробуйте пізніше.')
  if (!claimed) return { checked: false, retryAfter: 60 }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch('https://api.wayforpay.com/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      redirect: 'error',
      body: JSON.stringify({ transactionType: 'CHECK_STATUS', merchantAccount: config.merchant,
        orderReference: reference, merchantSignature: signature([config.merchant, reference], config.secret), apiVersion: 1 }),
    })
    if (!response.ok || !response.body) throw new BillingError(502, 'Платіжний сервіс тимчасово не відповідає. Спробуйте за хвилину.')
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > PROVIDER_RESPONSE_LIMIT) {
      await response.body.cancel()
      throw new BillingError(502, 'Некоректна відповідь платіжного сервісу.')
    }
    // Bound the actual body too: content-length may be omitted or incorrect.
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > PROVIDER_RESPONSE_LIMIT) {
        await reader.cancel()
        throw new BillingError(502, 'Некоректна відповідь платіжного сервісу.')
      }
      chunks.push(part.value)
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BillingError(502, 'Некоректна відповідь платіжного сервісу.')
    // The provider may report a form never submitted as Order Not Found. This
    // does not prove a payment failed and never changes the local order status.
    if (Number(payload.reasonCode) === 1127) return { checked: false, retryAfter: 60 }
    await processVerifiedPayment(payload, reference)
    return { checked: true, retryAfter: 60 }
  } catch (error) {
    if (error instanceof BillingError) throw error
    throw new BillingError(502, 'Не вдалося отримати підтвердження оплати. Спробуйте за хвилину.')
  } finally { clearTimeout(timeout) }
}

export function sendError(res: any, error: unknown) {
  // Never print provider payloads, JWTs, card information or merchant secrets.
  const known = error instanceof BillingError
  return res.status(known ? error.status : 500).json({ error: known ? error.message : 'Не вдалося обробити запит. Спробуйте пізніше.' })
}

export function privateResponse(res: any) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}
