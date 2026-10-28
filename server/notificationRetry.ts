import {
  authorizeNotificationWorker, deliverNotificationEmail, notificationEmailConfiguration,
  notificationEmailWorkerDisable, notificationEmailWorkerHeartbeat, notificationEmailWorkerSchemaReady,
  notificationPrivateResponse, sendNotificationEmailError,
} from './notificationEmail.js'
import { deliverAdminRepresentativeAlert, type AdminRepresentativeAlertResult } from './adminRepresentativeAlerts.js'
import { deliverOpportunitiesDigest, type OpportunitiesDigestResult } from './opportunitiesDigest.js'
import { deliverAdminSecurityAlerts } from './securityMonitor.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  notificationPrivateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  let settings: ReturnType<typeof notificationEmailConfiguration> | undefined
  let adminAlerts: Promise<AdminRepresentativeAlertResult> | undefined
  let opportunitiesDigest: Promise<OpportunitiesDigestResult> | undefined
  let securityMonitor: Promise<Awaited<ReturnType<typeof deliverAdminSecurityAlerts>> | null> | undefined
  try {
    authorizeNotificationWorker(req)
    const deadline = Date.now() + 53000
    // Telegram has its own configuration, queue and failure handling. Start it
    // before Resend configuration so a mail outage cannot silence admin alerts.
    adminAlerts = deliverAdminRepresentativeAlert(deadline)
    // Security delivery uses the same authorized recurring worker, with its own
    // default-off flag, durable queue and budget. A monitoring failure must not
    // interrupt existing notifications or depend on Resend configuration.
    securityMonitor = deliverAdminSecurityAlerts(deadline).catch(() => null)
    settings = notificationEmailConfiguration({ deadline })
    // This optional module has a separate default-off flag and isolated errors.
    // Running it in parallel preserves the original message-delivery deadline.
    opportunitiesDigest = deliverOpportunitiesDigest(settings, deadline - 5000)
    if (!await notificationEmailWorkerSchemaReady(settings)) {
      await notificationEmailWorkerHeartbeat(settings)
      return res.status(200).json({ ok: true, healthy: false, waiting_for_migration: true, processed: 0,
        admin_alerts: await adminAlerts, opportunities_digest: await opportunitiesDigest,
        security_monitor: await securityMonitor })
    }
    // Each delivery has its own bounded budget. A fast queue can drain many
    // events; one slow request cannot consume the entire minute-long worker.
    const worstCaseJobDuration = 12000
    const heartbeatReserve = 5000
    const results: Array<Awaited<ReturnType<typeof deliverNotificationEmail>>> = []
    let healthy = true
    for (let i = 0; i < 80 && Date.now() + worstCaseJobDuration + heartbeatReserve <= deadline; i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 300))
      const jobSettings = notificationEmailConfiguration({
        deadline: Math.min(deadline - heartbeatReserve, Date.now() + worstCaseJobDuration), silent: true,
      })
      const result = await deliverNotificationEmail(jobSettings)
      if (!result.processed) break
      results.push(result)
      if (result.stop) break
      if (result.status === 'pending' && !result.deferred) { healthy = false; break }
    }
    // This endpoint must be invoked even with an empty queue. A webhook for one
    // event cannot prove that the recurring worker will process future mail.
    if (healthy) await notificationEmailWorkerHeartbeat(settings)
    else await notificationEmailWorkerDisable(settings)
    return res.status(200).json({ ok: true, healthy, processed: results.length, results, admin_alerts: await adminAlerts,
      opportunities_digest: await opportunitiesDigest, security_monitor: await securityMonitor })
  } catch (error) {
    if (settings) await notificationEmailWorkerDisable(settings)
    // The delivery function only returns sanitized status and always resolves.
    // Finish independent work even when mail settings or its queue failed.
    if (adminAlerts) await adminAlerts
    if (opportunitiesDigest) await opportunitiesDigest
    if (securityMonitor) await securityMonitor
    return sendNotificationEmailError(res, error)
  }
}
