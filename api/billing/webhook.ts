import { privateResponse, processVerifiedPayment, requestBody, sendError } from '../../server/billing'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try { return res.status(200).json(await processVerifiedPayment(requestBody(req))) }
  catch (error) { return sendError(res, error) }
}
