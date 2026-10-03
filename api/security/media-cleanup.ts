import { authorizeMediaMaintenance, cleanDetachedMedia, MaintenanceError, mediaMaintenanceClient } from '../../server/mediaMaintenance.js'

export const config = { maxDuration: 60 }
export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, private')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }) }
  try {
    authorizeMediaMaintenance(req)
    const summary = await cleanDetachedMedia(mediaMaintenanceClient())
    return res.status(summary.failed ? 503 : 200).json({ ok: summary.failed === 0, ...summary })
  } catch (error) {
    const known = error instanceof MaintenanceError
    return res.status(known ? error.status : 503).json({ error: known ? error.message : 'Maintenance unavailable' })
  }
}
