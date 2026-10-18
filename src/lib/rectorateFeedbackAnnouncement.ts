import { supabase } from './supabase'

export const RECTORATE_FEEDBACK_ANNOUNCEMENT_ID = 'rectorate-feedback-2026-10-18'
export const XELAY_FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScrp2tt5nwJ4YHFmuw5AxeY93s7NnjFizm6ZEUdTKMnnHZOdA/viewform'

const seen = new Set<string>()
const synced = new Set<string>()
const writes = new Map<string, Promise<void>>()
export const feedbackReceiptKey = (userId?: string) =>
  `xelay:announcement:${RECTORATE_FEEDBACK_ANNOUNCEMENT_ID}:${userId || 'guest'}`

export function hasSeenFeedbackAnnouncement(userId?: string) {
  const key = feedbackReceiptKey(userId)
  if (seen.has(key)) return true
  try { return localStorage.getItem(key) === 'seen' } catch { return false }
}

export function rememberFeedbackAnnouncement(userId?: string) {
  const key = feedbackReceiptKey(userId)
  seen.add(key)
  try { localStorage.setItem(key, 'seen') } catch { /* Keep the in-memory receipt. */ }
}

export async function loadFeedbackAnnouncementSeen(userId: string | undefined, signal: AbortSignal) {
  if (signal.aborted) throw new Error('FEEDBACK_RECEIPT_ABORTED')
  if (!userId) return hasSeenFeedbackAnnouncement()
  const { data, error } = await supabase.from('account_announcement_receipts').select('announcement_id')
    .eq('user_id', userId).eq('announcement_id', RECTORATE_FEEDBACK_ANNOUNCEMENT_ID)
    .abortSignal(signal).maybeSingle()
  if (error) throw error
  if (signal.aborted) throw new Error('FEEDBACK_RECEIPT_ABORTED')
  if (data && data.announcement_id !== RECTORATE_FEEDBACK_ANNOUNCEMENT_ID) throw new Error('FEEDBACK_RECEIPT_INVALID')
  if (data) { synced.add(userId); rememberFeedbackAnnouncement(userId) }
  return Boolean(data)
}

export async function persistFeedbackAnnouncement(userId?: string) {
  if (!userId || synced.has(userId)) return
  const pending = writes.get(userId)
  if (pending) return pending
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  const write = (async () => {
    const { error } = await supabase.from('account_announcement_receipts').upsert({
      user_id: userId, announcement_id: RECTORATE_FEEDBACK_ANNOUNCEMENT_ID,
    }, { onConflict: 'user_id,announcement_id', ignoreDuplicates: true }).abortSignal(controller.signal)
    if (error) throw error
    if (controller.signal.aborted) throw new Error('FEEDBACK_RECEIPT_ABORTED')
    synced.add(userId)
  })()
  writes.set(userId, write)
  try { await write } finally { clearTimeout(timeout); writes.delete(userId) }
}
