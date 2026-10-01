import {
  authorizeNotificationWorker, deliverNotificationEmail, notificationEmailConfiguration,
  notificationPrivateResponse, notificationWebhookJobId, sendNotificationEmailError,
} from '../../server/notificationEmail.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  notificationPrivateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    authorizeNotificationWorker(req)
    const jobId = notificationWebhookJobId(req)
    const result = await deliverNotificationEmail(notificationEmailConfiguration(), jobId)
    // A temporary provider failure is persisted as pending for the retry worker.
    // A repeated webhook cannot claim an already sent or currently leased job.
    return res.status(200).json({ ok: true, ...result })
  } catch (error) { return sendNotificationEmailError(res, error) }
}
