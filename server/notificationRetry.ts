import {
  authorizeNotificationWorker, deliverNotificationEmail, notificationEmailConfiguration,
  notificationEmailWorkerDisable, notificationEmailWorkerHeartbeat, notificationPrivateResponse, sendNotificationEmailError,
} from './notificationEmail.js'
import { deliverAdminRepresentativeAlert, type AdminRepresentativeAlertResult } from './adminRepresentativeAlerts.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  notificationPrivateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  let settings: ReturnType<typeof notificationEmailConfiguration> | undefined
  let adminAlerts: Promise<AdminRepresentativeAlertResult> | undefined
  try {
    authorizeNotificationWorker(req)
    const deadline = Date.now() + 53000
    // Telegram has its own configuration, queue and failure handling. Start it
    // before Resend configuration so a mail outage cannot silence admin alerts.
    adminAlerts = deliverAdminRepresentativeAlert(deadline)
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
    return res.status(200).json({ ok: true, healthy, processed: results.length, results, admin_alerts: await adminAlerts })
  } catch (error) {
    if (settings) await notificationEmailWorkerDisable(settings)
    // The delivery function only returns sanitized status and always resolves.
    // Finish independent work even when mail settings or its queue failed.
    if (adminAlerts) await adminAlerts
    return sendNotificationEmailError(res, error)
  }
}
