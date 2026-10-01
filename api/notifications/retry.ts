import {
  authorizeNotificationWorker, deliverNotificationEmail, notificationEmailConfiguration,
  notificationPrivateResponse, sendNotificationEmailError,
} from '../../server/notificationEmail.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  notificationPrivateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    authorizeNotificationWorker(req)
    const settings = notificationEmailConfiguration()
    const deadline = Date.now() + 53000
    // A job makes at most six sequential requests, each with an 8s timeout:
    // claim, notification, preferences, Auth user, provider and final state.
    // Reserve its full 48s before starting another job, leaving 7s below the
    // Vercel limit. Fast jobs can still drain a small batch in one invocation.
    const worstCaseJobDuration = 6 * 8000
    const results: Array<Awaited<ReturnType<typeof deliverNotificationEmail>>> = []
    for (let i = 0; i < 5 && Date.now() + worstCaseJobDuration <= deadline; i += 1) {
      const result = await deliverNotificationEmail(settings)
      if (!result.processed) break
      results.push(result)
    }
    return res.status(200).json({ ok: true, processed: results.length, results })
  } catch (error) { return sendNotificationEmailError(res, error) }
}
