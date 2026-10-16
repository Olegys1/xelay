import { supabase } from './supabase'

export const SECRET_BADGE_ANNOUNCEMENT_ID = 'secret-six-seven-2026-10-17'
const seen = new Set<string>()
const synced = new Set<string>()
const writes = new Map<string, Promise<void>>()
export const secretBadgeReceiptKey = (userId?: string) => `xelay:announcement:${SECRET_BADGE_ANNOUNCEMENT_ID}:${userId || 'guest'}`

export function hasSeenSecretBadgeAnnouncement(userId?: string) {
  const key = secretBadgeReceiptKey(userId)
  if (seen.has(key)) return true
  try { return localStorage.getItem(key) === 'seen' } catch { return false }
}
export function rememberSecretBadgeAnnouncement(userId?: string) {
  const key = secretBadgeReceiptKey(userId)
  seen.add(key)
  try { localStorage.setItem(key, 'seen') } catch { /* In-memory receipt remains available. */ }
}
export async function loadSecretBadgeAnnouncementSeen(userId: string | undefined, signal: AbortSignal) {
  if (!userId) return hasSeenSecretBadgeAnnouncement()
  const result = await supabase.from('account_announcement_receipts').select('announcement_id')
    .eq('user_id', userId).eq('announcement_id', SECRET_BADGE_ANNOUNCEMENT_ID).abortSignal(signal).maybeSingle()
  if (result.error) throw result.error
  if (signal.aborted) throw new Error('ANNOUNCEMENT_ABORTED')
  if (result.data && result.data.announcement_id !== SECRET_BADGE_ANNOUNCEMENT_ID) throw new Error('ANNOUNCEMENT_INVALID')
  if (result.data) { synced.add(userId); rememberSecretBadgeAnnouncement(userId) }
  return Boolean(result.data)
}
export async function persistSecretBadgeAnnouncement(userId?: string) {
  if (!userId || synced.has(userId)) return
  const pending = writes.get(userId)
  if (pending) return pending
  const write = (async () => {
    const { error } = await supabase.from('account_announcement_receipts').upsert({ user_id: userId, announcement_id: SECRET_BADGE_ANNOUNCEMENT_ID },
      { onConflict: 'user_id,announcement_id', ignoreDuplicates: true })
    if (error) throw error
    synced.add(userId)
  })()
  writes.set(userId, write)
  try { await write } finally { writes.delete(userId) }
}
