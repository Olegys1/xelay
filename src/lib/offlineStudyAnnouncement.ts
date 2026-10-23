import { supabase } from './supabase'

export const OFFLINE_STUDY_ANNOUNCEMENT_ID = 'offline-study-2026-10-24'
const seen = new Set<string>()
const synced = new Set<string>()
const writes = new Map<string, Promise<void>>()
export const offlineStudyReceiptKey = (userId?: string) =>
  `xelay:announcement:${OFFLINE_STUDY_ANNOUNCEMENT_ID}:${userId || 'guest'}`

export function hasSeenOfflineStudyAnnouncement(userId?: string) {
  const key = offlineStudyReceiptKey(userId)
  if (seen.has(key)) return true
  try { return localStorage.getItem(key) === 'seen' } catch { return false }
}

export function rememberOfflineStudyAnnouncement(userId?: string) {
  const key = offlineStudyReceiptKey(userId)
  seen.add(key)
  try { localStorage.setItem(key, 'seen') } catch { /* The session receipt still prevents repeats. */ }
}

export async function loadOfflineStudyAnnouncementSeen(userId: string | undefined, signal: AbortSignal) {
  if (signal.aborted) throw new Error('OFFLINE_ANNOUNCEMENT_ABORTED')
  if (!userId) return hasSeenOfflineStudyAnnouncement()
  const { data, error } = await supabase.from('account_announcement_receipts').select('announcement_id')
    .eq('user_id', userId).eq('announcement_id', OFFLINE_STUDY_ANNOUNCEMENT_ID)
    .abortSignal(signal).maybeSingle()
  if (error) throw error
  if (signal.aborted) throw new Error('OFFLINE_ANNOUNCEMENT_ABORTED')
  if (data && data.announcement_id !== OFFLINE_STUDY_ANNOUNCEMENT_ID) throw new Error('OFFLINE_ANNOUNCEMENT_INVALID')
  if (data) { synced.add(userId); rememberOfflineStudyAnnouncement(userId) }
  return Boolean(data)
}

export async function persistOfflineStudyAnnouncement(userId?: string) {
  if (!userId || synced.has(userId)) return
  const pending = writes.get(userId)
  if (pending) return pending
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  const write = (async () => {
    const { error } = await supabase.from('account_announcement_receipts').upsert({
      user_id: userId, announcement_id: OFFLINE_STUDY_ANNOUNCEMENT_ID,
    }, { onConflict: 'user_id,announcement_id', ignoreDuplicates: true }).abortSignal(controller.signal)
    if (error) throw error
    if (controller.signal.aborted) throw new Error('OFFLINE_ANNOUNCEMENT_ABORTED')
    synced.add(userId)
  })()
  writes.set(userId, write)
  try { await write } finally { clearTimeout(timeout); writes.delete(userId) }
}
