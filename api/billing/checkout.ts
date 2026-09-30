import { authenticateRequest, billingConfiguration, BillingError, enforceSameOrigin, newOrderReference, privateResponse, requestBody, sendError, signedCheckout } from '../../server/billing'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const config = billingConfiguration()
    if (!config.checkoutAvailable) throw new BillingError(503, 'Оплату ще не активовано. Ми повідомимо, коли покупки стануть доступними.')
    enforceSameOrigin(req)
    const auth = await authenticateRequest(req)
    const body = requestBody(req)
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
    return res.status(200).json({ checkout: signedCheckout(order, auth!.user.email), mode: config.mode, orderReference: order.order_reference })
  } catch (error) { return sendError(res, error) }
}
