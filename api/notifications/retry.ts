import {
  authorizeNotificationWorker, deliverNotificationEmail, notificationEmailConfiguration,
  notificationEmailWorkerDisable, notificationEmailWorkerHeartbeat, notificationPrivateResponse, sendNotificationEmailError,
} from '../../server/notificationEmail.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  notificationPrivateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  let settings: ReturnType<typeof notificationEmailConfiguration> | undefined
  try {
    authorizeNotificationWorker(req)
    const deadline = Date.now() + 53000
    settings = notificationEmailConfiguration({ deadline })
    // Include claim, event, preferences, Auth, final preferences, actual unread
    // state, provider, and receipt. Keep another 5s for the runtime heartbeat.
    const worstCaseJobDuration = 8 * 5000
    const heartbeatReserve = 5000
    const results: Array<Awaited<ReturnType<typeof deliverNotificationEmail>>> = []
    let healthy = true
    for (let i = 0; i < 5 && Date.now() + worstCaseJobDuration + heartbeatReserve <= deadline; i += 1) {
      const result = await deliverNotificationEmail(settings)
      if (!result.processed) break
      results.push(result)
      if ((result.status === 'pending' && !result.deferred) || result.status === 'failed') { healthy = false; break }
    }
    // This endpoint must be invoked even with an empty queue. A webhook for one
    // event cannot prove that the recurring worker will process future mail.
    if (healthy) await notificationEmailWorkerHeartbeat(settings)
    else await notificationEmailWorkerDisable(settings)
    return res.status(200).json({ ok: true, healthy, processed: results.length, results })
  } catch (error) {
    if (settings) await notificationEmailWorkerDisable(settings)
    return sendNotificationEmailError(res, error)
  }
}
