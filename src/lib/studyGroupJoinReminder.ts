import { supabase } from './supabase'
import type { XelayUser } from '../types'

export const GROUP_JOIN_REMINDER_ID = 'join-study-group-2026-10-16'
const sessionReceipts = new Set<string>()
const syncedReceipts = new Set<string>()
const receiptWrites = new Map<string, Promise<void>>()
const receiptKey = (userId: string) => `xelay:announcement:${GROUP_JOIN_REMINDER_ID}:${userId}`

export function isGroupJoinReminderAudience(user: XelayUser) {
  return user.accountType !== 'teacher' && user.isTeacher !== true && user.isPlatformAdmin !== true
}

export function hasSeenGroupJoinReminder(userId: string) {
  if (sessionReceipts.has(userId)) return true
  try { return localStorage.getItem(receiptKey(userId)) === 'seen' } catch { return false }
}

export function rememberGroupJoinReminder(userId: string) {
  sessionReceipts.add(userId)
  try { localStorage.setItem(receiptKey(userId), 'seen') } catch { /* The in-memory receipt still works. */ }
}

export async function persistGroupJoinReminder(userId: string) {
  if (syncedReceipts.has(userId)) return
  const pending = receiptWrites.get(userId)
  if (pending) return pending
  const write = (async () => {
    const { error } = await supabase.from('account_announcement_receipts').upsert({
      user_id: userId, announcement_id: GROUP_JOIN_REMINDER_ID,
    }, { onConflict: 'user_id,announcement_id', ignoreDuplicates: true })
    if (error) throw error
    syncedReceipts.add(userId)
  })()
  receiptWrites.set(userId, write)
  try { await write } finally { receiptWrites.delete(userId) }
}

export type GroupJoinReminderState = { seen: boolean; inGroup: boolean; pendingInvites: boolean }

/** Own-account probes only. Failed/unknown reads must never mean "not in a group". */
export async function loadGroupJoinReminderState(userId: string, signal: AbortSignal): Promise<GroupJoinReminderState> {
  const [receipt, member, representative] = await Promise.all([
    supabase.from('account_announcement_receipts').select('announcement_id')
      .eq('user_id', userId).eq('announcement_id', GROUP_JOIN_REMINDER_ID).abortSignal(signal).maybeSingle(),
    supabase.from('study_group_members').select('group_id')
      .eq('user_id', userId).eq('status', 'accepted').limit(1).abortSignal(signal).maybeSingle(),
    supabase.from('study_groups').select('id')
      .eq('representative_id', userId).limit(1).abortSignal(signal).maybeSingle(),
  ])
  for (const result of [receipt, member, representative]) if (result.error) throw result.error
  if (signal.aborted) throw new Error('GROUP_JOIN_REMINDER_ABORTED')
  if (receipt.data && receipt.data.announcement_id !== GROUP_JOIN_REMINDER_ID
    || member.data && typeof member.data.group_id !== 'string'
    || representative.data && typeof representative.data.id !== 'string') {
    throw new Error('GROUP_JOIN_REMINDER_RESPONSE_INVALID')
  }
  const seen = Boolean(receipt.data)
  if (seen) syncedReceipts.add(userId)
  const inGroup = Boolean(member.data || representative.data)
  if (seen || inGroup) return { seen, inGroup, pendingInvites: false }

  const invitation = await supabase.from('study_group_members').select('group_id')
    .eq('user_id', userId).eq('status', 'pending').limit(1).abortSignal(signal).maybeSingle()
  if (invitation.error) throw invitation.error
  if (signal.aborted) throw new Error('GROUP_JOIN_REMINDER_ABORTED')
  if (invitation.data && typeof invitation.data.group_id !== 'string') throw new Error('GROUP_JOIN_REMINDER_RESPONSE_INVALID')
  return { seen: false, inGroup: false, pendingInvites: Boolean(invitation.data) }
}
