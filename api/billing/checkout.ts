import { authenticateRequest, billingConfiguration, BillingError, enforceSameOrigin, newOrderReference, privateResponse, requestBody, sendError, signedCheckout } from '../../server/billing.js'
import { LEGAL_TERMS_VERSION, legalMerchant } from '../../src/lib/legal.js'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const config = billingConfiguration()
    if (!config.checkoutAvailable) throw new BillingError(503, 'Оплату ще не активовано. Ми повідомимо, коли покупки стануть доступними.')
    if (!legalMerchant.ready) throw new BillingError(503, 'Оплата ще не підключена.')
    enforceSameOrigin(req)
    const auth = await authenticateRequest(req)
    const body = requestBody(req)
    if (body.acceptedTerms !== true || body.termsVersion !== LEGAL_TERMS_VERSION) {
      throw new BillingError(400, 'Ознайомтеся з чинними умовами та правилами повернення і підтвердьте згоду перед оплатою.')
    }
    const product = body.product ?? body.plan
    if (!['participant', 'group'].includes(product)) throw new BillingError(400, 'Оберіть доступний тариф.')
    if (body.recurring === true) throw new BillingError(400, 'Автоматичне продовження поки не підключено.')
    if (product === 'group' && (typeof body.groupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.groupId))) throw new BillingError(400, 'Оберіть створену вами групу.')
    const { data: order, error } = await auth!.service.rpc('xelay_create_billing_order', {
      p_user_id: auth!.user.id, p_product: product, p_mode: config.mode,
      p_order_reference: newOrderReference(), p_group_id: product === 'group' ? body.groupId : null,
    })
    if (error || !order) {
      if (error?.message.includes('CHECKOUT_RATE_LIMIT')) throw new BillingError(429, 'Забагато спроб оплати. Спробуйте через годину.')
      if (error?.message.includes('GROUP_ALREADY_ACTIVE')) throw new BillingError(409, 'Доступ до цієї групи вже активовано.')
      if (error?.message.includes('GROUP_CHECKOUT_PENDING')) throw new BillingError(409, 'Оплату групи вже розпочато. Перевірте попереднє замовлення або спробуйте через годину.')
      throw new BillingError(403, 'Не вдалося створити замовлення. Перевірте профіль і права на групу.')
    }
    // Prepare the form before recording consent; an older annual billing schema
    // must never sell a lifetime order under the new yearly terms.
    const checkout = signedCheckout(order, auth!.user.email)
    const { data: consent, error: consentError } = await auth!.service.from('billing_orders')
      .update({ terms_version: LEGAL_TERMS_VERSION, terms_accepted_at: new Date().toISOString() })
      .eq('id', order.id).eq('user_id', auth!.user.id).eq('status', 'pending').select('id').single()
    if (consentError || !consent) throw new BillingError(409, 'Не вдалося підготувати замовлення. Перевірте попередню оплату або спробуйте пізніше.')
    return res.status(200).json({ checkout, mode: config.mode, orderReference: order.order_reference })
  } catch (error) { return sendError(res, error) }
}
