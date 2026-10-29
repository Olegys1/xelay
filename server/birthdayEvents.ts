import { createClient } from '@supabase/supabase-js'

export interface BirthdayEventsResult {
  enabled: boolean
  status: 'disabled' | 'processed' | 'unavailable' | 'waiting_for_migration' | 'deadline'
  processed: number
  giftsOffered: number
  groupNotifications: number
  hasMore: boolean
}
const result = (status: BirthdayEventsResult['status'], enabled = true): BirthdayEventsResult => ({ enabled, status, processed: 0, giftsOffered: 0, groupNotifications: 0, hasMore: false })
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max

/** Optional work in the existing authorized minute worker. No new scheduler,
 * provider, credential or email is created. Only sanitized counters leave here. */
export async function processBirthdayEvents(deadline: number): Promise<BirthdayEventsResult> {
  if (process.env.BIRTHDAY_EVENTS_ENABLED !== 'true') return result('disabled', false)
  const budget = Math.min(5000, deadline - Date.now() - 1500)
  if (!Number.isFinite(budget) || budget < 500) return result('deadline')
  const endpoint = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !secret) return result('unavailable')
  } catch { return result('unavailable') }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const service = createClient(endpoint, secret, { auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: controller.signal }) } })
    const interrupted = new Promise<null>(resolve => { timeout = setTimeout(() => { controller.abort(); resolve(null) }, budget) })
    const response = await Promise.race([service.rpc('xelay_process_due_birthdays', { p_limit: 25 }).abortSignal(controller.signal), interrupted])
    if (!response) return result('deadline')
    if (response.error) return result(['PGRST202', '42883'].includes(response.error.code) ? 'waiting_for_migration' : 'unavailable')
    const data = response.data
    if (!data || typeof data !== 'object' || Array.isArray(data) || !integer(data.processed, 25) || !integer(data.gifts_offered, 25)
      || data.gifts_offered > data.processed || !integer(data.group_notifications, 25) || typeof data.has_more !== 'boolean'
      || typeof data.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.today)) return result('unavailable')
    return { enabled: true, status: 'processed', processed: data.processed, giftsOffered: data.gifts_offered, groupNotifications: data.group_notifications, hasMore: data.has_more }
  } catch { return result('unavailable') }
  finally { if (timeout) clearTimeout(timeout); controller.abort() }
}
