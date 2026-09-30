import { authenticateRequest, BillingError, privateResponse, publicBillingConfiguration, sendError } from '../../server/billing'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const config = publicBillingConfiguration()
    const auth = await authenticateRequest(req, true)
    if (!auth) return res.status(200).json(config)
    const [status, orders] = await Promise.all([
      auth.userClient.rpc('xelay_billing_status'),
      auth.service.from('billing_orders').select('id,product,group_id,order_reference,amount,currency,mode,status,created_at,approved_at').eq('user_id', auth.user.id).order('created_at', { ascending: false }).limit(20),
    ])
    if (status.error || orders.error) throw new BillingError(503, 'Історію оплати ще не підключено. Перевірте міграцію підписок.')
    return res.status(200).json({ ...config, ...status.data, orders: orders.data || [] })
  } catch (error) { return sendError(res, error) }
}
