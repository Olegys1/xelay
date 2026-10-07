import { authenticateRequest, billingConfiguration, BillingError, enforceSameOrigin, newOrderReference, privateResponse, requestBody, sendError, signedCheckout } from '../../server/billing.js'
import { LEGAL_TERMS_VERSION, legalMerchant } from '../../src/lib/legal.js'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const body = requestBody(req)
    const product = body.product ?? body.plan
    if (product === 'group') throw new BillingError(409, 'Навчальні групи тепер безкоштовні. Оплата не потрібна.')
    const config = billingConfiguration()
    if (!config.checkoutAvailable) throw new BillingError(503, 'Оплату ще не активовано. Ми повідомимо, коли покупки стануть доступними.')
    if (!legalMerchant.ready) throw new BillingError(503, 'Оплата ще не підключена.')
    enforceSameOrigin(req)
    const auth = await authenticateRequest(req)
    if (body.acceptedTerms !== true || body.termsVersion !== LEGAL_TERMS_VERSION) {
      throw new BillingError(400, 'Ознайомтеся з чинними умовами та правилами повернення і підтвердьте згоду перед оплатою.')
    }
    if (product !== 'participant') throw new BillingError(400, 'Оберіть доступний тариф.')
    if (body.recurring === true) throw new BillingError(400, 'Автоматичне продовження поки не підключено.')
    if (body.groupId != null) throw new BillingError(400, 'Підписка «Учасник» не потребує вибору групи.')
    const { data: order, error } = await auth!.service.rpc('xelay_create_billing_order', {
      p_user_id: auth!.user.id, p_product: product, p_mode: config.mode,
      p_order_reference: newOrderReference(), p_group_id: null,
    })
    if (error || !order) {
      if (error?.message.includes('CHECKOUT_RATE_LIMIT')) throw new BillingError(429, 'Забагато спроб оплати. Спробуйте через годину.')
      throw new BillingError(403, 'Не вдалося створити замовлення. Перевірте профіль і повторіть спробу.')
    }
    // Prepare the validated participant form before recording consent.
    const checkout = signedCheckout(order, auth!.user.email)
    const { data: consent, error: consentError } = await auth!.service.from('billing_orders')
      .update({ terms_version: LEGAL_TERMS_VERSION, terms_accepted_at: new Date().toISOString() })
      .eq('id', order.id).eq('user_id', auth!.user.id).eq('status', 'pending').select('id').single()
    if (consentError || !consent) throw new BillingError(409, 'Не вдалося підготувати замовлення. Перевірте попередню оплату або спробуйте пізніше.')
    return res.status(200).json({ checkout, mode: config.mode, orderReference: order.order_reference })
  } catch (error) { return sendError(res, error) }
}
