import {
  authorizeNotificationWorker, deliverNotificationEmail, notificationEmailConfiguration,
  notificationEmailAvailability, notificationEmailWorkerDisable, notificationPrivateResponse, notificationWebhookJobId, sendNotificationEmailError,
} from '../../server/notificationEmail.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  notificationPrivateResponse(res)
  if (req.method === 'GET') return res.status(200).json(await notificationEmailAvailability())
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  let settings: ReturnType<typeof notificationEmailConfiguration> | undefined
  try {
    authorizeNotificationWorker(req)
    const jobId = notificationWebhookJobId(req)
    settings = notificationEmailConfiguration({ deadline: Date.now() + 53000 })
    const result = await deliverNotificationEmail(settings, jobId)
    if ((result.status === 'pending' && !result.deferred) || result.status === 'failed') await notificationEmailWorkerDisable(settings)
    // A temporary provider failure is persisted as pending for the retry worker.
    // A repeated webhook cannot claim an already sent or currently leased job.
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    if (settings) await notificationEmailWorkerDisable(settings)
    return sendNotificationEmailError(res, error)
  }
}
