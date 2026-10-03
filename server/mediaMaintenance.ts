import { createHash, timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export class MaintenanceError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function authorizeMediaMaintenance(req: any) {
  const secret = process.env.SECURITY_MAINTENANCE_SECRET || ''
  if (secret.length < 32 || /\s/.test(secret)) throw new MaintenanceError(503, 'Maintenance unavailable')
  const header = req.headers?.authorization
  const supplied = typeof header === 'string' && header.length < 1024 ? /^Bearer ([^\s]+)$/.exec(header)?.[1] : undefined
  const hash = (value: string) => createHash('sha256').update(value).digest()
  if (!supplied || !timingSafeEqual(hash(supplied), hash(secret))) throw new MaintenanceError(401, 'Unauthorized')
}

export function mediaMaintenanceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!url || !key) throw new MaintenanceError(503, 'Maintenance unavailable')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, options) => fetch(input, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) },
  })
}

type Candidate = { bucket_id: string; name: string; object_id: string }
export async function cleanDetachedMedia(service: ReturnType<typeof mediaMaintenanceClient>, deadline = Date.now() + 53000) {
  const summary = { candidates: 0, claimed: 0, removed: 0, skipped: 0, failed: 0, attemptedScopes: [] as string[], deferredScopes: [] as string[] }
  if (Date.now() + 8000 > deadline) { summary.deferredScopes = ['private', 'public']; return summary }
  const next = await service.rpc('xelay_media_cleanup_next_scope')
  if (next.error || !['private', 'public'].includes(next.data)) throw new MaintenanceError(503, 'Maintenance unavailable')
  const scopes = next.data === 'public' ? ['public', 'private'] as const : ['private', 'public'] as const
  for (const scope of scopes) {
    if (Date.now() + 32000 > deadline) { summary.deferredScopes.push(scope); continue }
    summary.attemptedScopes.push(scope)
    const maintenance = await service.rpc(`xelay_${scope}_media_maintenance`)
    if (maintenance.error) { summary.failed += 1; continue }
    const result = await service.rpc(`xelay_${scope}_media_cleanup_candidates`, { p_before: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), p_limit: 20 })
    if (result.error) { summary.failed += 1; continue }
    const candidates = (result.data || []) as Candidate[]
    summary.candidates += candidates.length
    for (const candidate of candidates) {
      if (Date.now() + 16000 > deadline) break
      // SQL binds a short lease to the exact current object and rechecks every
      // DELETE. A path reused or attached after listing must never be removed.
      const claim = await service.rpc(`xelay_${scope}_media_cleanup_claim`, { p_bucket_id: candidate.bucket_id, p_storage_path: candidate.name, p_object_id: candidate.object_id })
      if (claim.error) { summary.failed += 1; continue }
      if (claim.data !== true) { summary.skipped += 1; continue }
      summary.claimed += 1
      const removed = await service.storage.from(candidate.bucket_id).remove([candidate.name])
      if (removed.error || !removed.data?.some((object) => object.name === candidate.name)) summary.failed += 1
      else summary.removed += 1
    }
  }
  return summary
}
