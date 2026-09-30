import { privateResponse, serverSupabase } from '../../server/billing'

/** Accept the provider's browser POST and return to the SPA with a GET.
 * Return parameters never grant access: only a verified callback/status does.
 */
export default async function handler(req: any, res: any) {
  privateResponse(res)
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).end()
  }
  let destination = '/subscription?payment=returned'
  const reference = req.query?.orderReference
  if (typeof reference === 'string' && /^xelay_[a-f0-9-]{36}$/.test(reference)) {
    try {
      const { data: order, error } = await serverSupabase().from('billing_orders')
        .select('product, group_id, order_reference').eq('order_reference', reference).maybeSingle()
      if (!error && order) {
        const path = order.product === 'group' && typeof order.group_id === 'string'
          && /^[a-f0-9-]{36}$/i.test(order.group_id) ? `/groups/${order.group_id}` : '/subscription'
        destination = `${path}?payment=returned&orderReference=${encodeURIComponent(order.order_reference)}`
      }
    } catch { /* The frontend can explain unavailable configuration safely. */ }
  }
  res.setHeader('Location', destination)
  return res.status(303).end()
}
