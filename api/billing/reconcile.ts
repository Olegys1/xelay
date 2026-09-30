import { authenticateRequest, enforceSameOrigin, privateResponse, reconcileOwnedOrder, requestBody, sendError } from '../../server/billing'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    enforceSameOrigin(req)
    const auth = await authenticateRequest(req)
    const body = requestBody(req)
    return res.status(200).json(await reconcileOwnedOrder(auth!, body.orderReference))
  } catch (error) { return sendError(res, error) }
}
