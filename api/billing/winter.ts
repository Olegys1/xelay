import { authenticateRequest, billingConfiguration, BillingError, newOrderReference, privateResponse, requestBody, sendError } from '../../server/billing.js'
import { signedWinterCheckout, validWinterSelection } from '../../server/winterBilling.js'
import { studentPlansEnabled } from '../../server/student-learning/studentPlanPrices.js'
import { teacherPlansEnabled } from '../../server/teacher-learning/teacherPlanPrices.js'
import { legalMerchant } from '../../src/lib/legal.js'
import { WINTER_BENEFITS_TERMS_VERSION } from '../../src/lib/aiCreditTerms.js'
export const config = { maxDuration: 30 }

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const auth = await authenticateRequest(req)
    let sessionId: string | undefined
    try { sessionId = JSON.parse(Buffer.from(String(req.headers.authorization).split(' ')[1].split('.')[1], 'base64url').toString('utf8')).session_id } catch { /* getUser above verifies the token; malformed claims still fail closed. */ }
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) throw new BillingError(401, 'Увійдіть до акаунта ще раз.')
    if (req.method === 'POST') {
      const allowed = [billingConfiguration().origin]
      if (process.env.VERCEL_ENV === 'preview' && /^[a-z0-9-]+\.vercel\.app$/i.test(process.env.VERCEL_URL || '')) allowed.push(`https://${process.env.VERCEL_URL}`)
      if (typeof req.headers.origin !== 'string' || !allowed.includes(req.headers.origin)) throw new BillingError(403, 'Недозволене джерело запиту.')
    }
    const call = async (name: string, values: Record<string, unknown> = {}) => {
      const { data, error } = await auth!.service.rpc('xelay_winter_billing_request', { p_user_id: auth!.user.id, p_session_id: sessionId, p_action: name, p_payload: values })
      if (error) {
        const message = String(error.message)
        if (message.includes('WINTER_SESSION_REQUIRED')) throw new BillingError(401, 'Сесію завершено. Увійдіть ще раз.')
        if (message.includes('WINTER_CHECKOUT_RESERVED')) throw new BillingError(409, 'Пропозицію вже закріплено за відкритим замовленням. Поверніться до обраного тарифу, щоб продовжити оплату.')
        if (message.includes('WINTER_PAUSED')) throw new BillingError(409, 'Спочатку відновіть підписку з паузи.')
        if (message.includes('WINTER_AUDIENCE')) throw new BillingError(409, 'Оберіть тариф для свого типу акаунта.')
        throw new BillingError(409, 'Пропозиція недоступна, вже використана або її строк минув. Оновіть список подарунків.')
      }
      return data
    }
    if (req.method === 'GET') return res.status(200).json(await call('xelay_winter_billing_offers'))
    const body = requestBody(req)
    if (body.action === 'issue_friend_token' || body.action === 'accept_friend_token') {
      if (Object.keys(body).some(k => !['action', 'token', 'acceptedTerms', 'termsVersion'].includes(k)) || body.acceptedTerms !== true || body.termsVersion !== WINTER_BENEFITS_TERMS_VERSION
        || body.action === 'accept_friend_token' && (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token))) throw new BillingError(400, 'Підтвердьте умови та перевірте код подарунка.')
      return res.status(200).json(await call(body.action === 'issue_friend_token' ? 'xelay_winter_friend_issue' : 'xelay_winter_friend_accept', body.action === 'accept_friend_token' ? { p_token: body.token } : {}))
    }
    if (!['quote', 'checkout'].includes(body.action) || Object.keys(body).some(k => !['action', 'audience', 'planId', 'termMonths', 'source', 'acceptedTerms', 'termsVersion'].includes(k)) || !validWinterSelection(body)) throw new BillingError(400, 'Оберіть тариф, строк і одну знижку.')
    if (body.audience === 'teacher' ? !teacherPlansEnabled() : !studentPlansEnabled()) throw new BillingError(503, 'Ці тарифи ще не активовано.')
    const values = { p_audience: body.audience, p_plan: body.planId, p_months: body.termMonths, p_source: body.source }
    if (body.action === 'quote') return res.status(200).json(await call('xelay_winter_subscription_quote', values))
    if (body.acceptedTerms !== true || body.termsVersion !== WINTER_BENEFITS_TERMS_VERSION) throw new BillingError(400, 'Підтвердьте умови разової оплати без автопродовження.')
    const config = billingConfiguration()
    if (!config.checkoutAvailable || !legalMerchant.ready) throw new BillingError(503, 'Оплату ще не активовано.')
    const order = await call('xelay_winter_subscription_order', { ...values, p_mode: config.mode, p_reference: newOrderReference(), p_terms: WINTER_BENEFITS_TERMS_VERSION })
    return res.status(200).json({ mode: config.mode, orderReference: order.order_reference, checkout: signedWinterCheckout(order, auth!.user, body, WINTER_BENEFITS_TERMS_VERSION) })
  } catch (error) { return sendError(res, error) }
}
