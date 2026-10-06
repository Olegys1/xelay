import { authenticateRequest, BillingError, enforceSameOrigin, privateResponse, requestBody, sendError } from '../../server/billing.js'
import { newSupportReference, publicSupportConfiguration, signedSupportCheckout } from '../../server/teamSupport.js'
import { SUPPORT_TERMS_VERSION, validSupportAmount } from '../../src/lib/teamSupport.js'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Метод не підтримується.' })
  }
  try {
    const config = publicSupportConfiguration()
    if (req.method === 'GET') {
      const auth = await authenticateRequest(req, true)
      if (!auth) return res.status(200).json({ ...config, orders: [] })
      const { data, error } = await auth.service.from('support_orders')
        .select('id,order_reference,amount_kopiykas,currency,mode,status,created_at,approved_at')
        .eq('user_id', auth.user.id).eq('mode', config.mode).order('created_at', { ascending: false }).limit(20)
      if (error) {
        if (!config.checkoutAvailable && ['42P01', 'PGRST205'].includes(error.code)) {
          return res.status(200).json({ ...config, checkoutAvailable: false, orders: [] })
        }
        throw new BillingError(503, 'Не вдалося завантажити платежі підтримки. Спробуйте пізніше.')
      }
      return res.status(200).json({ ...config, orders: data || [] })
    }
    if (!config.checkoutAvailable) throw new BillingError(503, 'Підтримку через оплату ще не підключено.')
    enforceSameOrigin(req)
    const auth = await authenticateRequest(req)
    const body = requestBody(req)
    if (!validSupportAmount(body.amountKopiykas)) throw new BillingError(400, 'Вкажіть суму від 1 до 149 999 грн, не більше двох знаків після коми.')
    if (body.acceptedTerms !== true || body.termsVersion !== SUPPORT_TERMS_VERSION) {
      throw new BillingError(400, 'Ознайомтеся з умовами підтримки й повернення та підтвердьте згоду.')
    }
    if (body.recurring === true) throw new BillingError(400, 'Підтримка є одноразовою. Регулярних списань немає.')
    const { data: order, error } = await auth!.service.rpc('xelay_create_support_order', {
      p_user_id: auth!.user.id, p_mode: config.mode, p_reference: newSupportReference(),
      p_amount_kopiykas: body.amountKopiykas, p_terms_version: SUPPORT_TERMS_VERSION,
    })
    if (error || !order) {
      if (error?.message.includes('CHECKOUT_RATE_LIMIT')) throw new BillingError(429, 'Забагато спроб оплати. Спробуйте через годину.')
      throw new BillingError(503, 'Не вдалося підготувати підтримку. Спробуйте пізніше.')
    }
    return res.status(200).json({ checkout: signedSupportCheckout(order, auth!.user.email), mode: config.mode, orderReference: order.order_reference })
  } catch (error) { return sendError(res, error) }
}
