import {
  authorizeNotificationWorker, notificationEmailConfiguration,
  notificationEmailAvailability, notificationEmailWorkerDisable, notificationPrivateResponse, notificationWebhookJobId, sendNotificationEmailError,
} from '../../server/notificationEmail.js'
import notificationRetryHandler from '../../server/notificationRetry.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  if (req.query?.xelay_notification_route === 'retry') return notificationRetryHandler(req, res)
  notificationPrivateResponse(res)
  if (req.method === 'GET') return res.status(200).json(await notificationEmailAvailability())
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  let settings: ReturnType<typeof notificationEmailConfiguration> | undefined
  try {
    authorizeNotificationWorker(req)
    notificationWebhookJobId(req)
    settings = notificationEmailConfiguration({ deadline: Date.now() + 53000 })
    // The trusted database trigger has already persisted the job. A single
    // recurring worker drains the queue so a news broadcast does not launch
    // hundreds of parallel provider requests. Repeated webhook receipts are safe.
    return res.status(200).json({ ok: true, queued: true })
  } catch (error) {
    if (settings) await notificationEmailWorkerDisable(settings)
    return sendNotificationEmailError(res, error)
  }
}
