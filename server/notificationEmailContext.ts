import type { SupabaseClient } from '@supabase/supabase-js'

export interface NotificationEmailContextRecord {
  id: string
  recipient_id: string
  type: string
  actor_id?: string | null
  chat_space_id?: string | null
  study_group_id?: string | null
  study_group_member_id?: string | null
  organizer_task_id?: string | null
  academic_tab?: string | null
  shared_organizer_workspace_id?: string | null
  shared_organizer_invitation_id?: string | null
}
export interface NotificationEmailContextResult {
  eligible: boolean
  error: string | null
  path?: string
}
export interface NotificationEmailContextLease { id: string; lock_token: string }

type ContextRow = Record<string, unknown>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GROUP_TABS = new Set(['schedule', 'seminars', 'timetable', 'materials'])
const yes = (path?: string): NotificationEmailContextResult => ({ eligible: true, error: null, ...(path ? { path } : {}) })
const no = (error: string): NotificationEmailContextResult => ({ eligible: false, error })
const recordId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

// Only identifiers, membership and scope flags are read. Private text, names,
// work results and attachments are never included in the returned context.
async function lookup(service: SupabaseClient, table: string, fields: string, filters: Record<string, unknown>) {
  let query = service.from(table).select(fields)
  for (const [field, value] of Object.entries(filters)) query = query.eq(field, value)
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error('context_lookup_failed')
  return data as ContextRow | null
}

async function references(service: SupabaseClient, notification: NotificationEmailContextRecord, fields: string[]) {
  if (fields.every(field => notification[field as keyof NotificationEmailContextRecord] !== undefined)) return notification
  const row = await lookup(service, 'notifications', 'id,recipient_id,type,' + fields.join(','), { id: notification.id })
  if (!row) return null
  if (String(row.recipient_id) !== notification.recipient_id || row.type !== notification.type) return null
  return { ...notification, ...row } as NotificationEmailContextRecord
}

async function groupContext(service: SupabaseClient, notification: NotificationEmailContextRecord) {
  const fields = notification.type === 'study_group_update' ? ['study_group_id', 'academic_tab']
    : notification.type === 'group_invite' ? ['study_group_id', 'study_group_member_id'] : ['study_group_id']
  const current = await references(service, notification, fields)
  if (!current) return no('notification_removed')
  if (!recordId(current.study_group_id)) return no('group_reference_invalid')
  const group = await lookup(service, 'study_groups', 'id,representative_id', { id: current.study_group_id })
  if (!group) return no('group_unavailable')
  if (current.type === 'group_invite') {
    if (!recordId(current.study_group_member_id)) return no('group_reference_invalid')
    const invitation = await lookup(service, 'study_group_members', 'id,group_id,user_id,status', {
      id: current.study_group_member_id, group_id: current.study_group_id, user_id: current.recipient_id,
    })
    return invitation && ['pending', 'accepted'].includes(String(invitation.status)) ? yes('/groups') : no('group_invitation_unavailable')
  }
  if (group.representative_id !== current.recipient_id) {
    const member = await lookup(service, 'study_group_members', 'group_id,user_id,status', {
      group_id: current.study_group_id, user_id: current.recipient_id,
    })
    if (member?.status !== 'accepted') return no('group_access_removed')
  }
  const tab = typeof current.academic_tab === 'string' && GROUP_TABS.has(current.academic_tab) ? current.academic_tab : null
  return yes('/groups/' + current.study_group_id + (tab ? '?tab=' + tab : ''))
}

async function organizerContext(service: SupabaseClient, notification: NotificationEmailContextRecord) {
  const current = await references(service, notification, ['organizer_task_id'])
  if (!current) return no('notification_removed')
  if (!recordId(current.organizer_task_id)) return no('organizer_reference_invalid')
  const task = await lookup(service, 'organizer_tasks', 'id,user_id', { id: current.organizer_task_id, user_id: current.recipient_id })
  // Completion and in-app read status never cancel an email for an emitted event.
  return task ? yes('/organizer') : no('organizer_task_unavailable')
}

async function leasedContext(
  service: SupabaseClient,
  rpcName: string,
  pathPrefix: string,
  unavailableReason: string,
  expectedReference: unknown,
  job?: NotificationEmailContextLease,
) {
  if (!job || !recordId(job.id) || !recordId(job.lock_token)) return no('context_lease_required')
  // Private chat and shared-organizer tables deny service-role SELECT.
  // Scoped RPCs check the leased job, its recipient, current scope and mute.
  const { data, error } = await service.rpc(rpcName, {
    p_job_id: job.id, p_lock_token: job.lock_token,
  })
  if (error) return no('context_lookup_failed')
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.eligible !== 'boolean') return no('context_payload_invalid')
  if (!data.eligible) {
    return no(typeof data.reason === 'string' && /^[a-z0-9_]{1,64}$/i.test(data.reason)
      ? data.reason : unavailableReason)
  }
  if (typeof data.path !== 'string' || !data.path.startsWith(pathPrefix)) return no('context_payload_invalid')
  const reference = data.path.slice(pathPrefix.length)
  if (!recordId(reference) || (expectedReference != null
    && (!recordId(expectedReference) || expectedReference.toLowerCase() !== reference.toLowerCase()))) {
    return no('context_payload_invalid')
  }
  return yes(pathPrefix + reference.toLowerCase())
}

// Call immediately before provider delivery, after rechecking email preferences.
// Lookup/payload failures are retryable; eligibility failures safely skip mail.
export async function notificationEmailContext(
  service: SupabaseClient,
  notification: NotificationEmailContextRecord,
  job?: NotificationEmailContextLease,
): Promise<NotificationEmailContextResult> {
  const scoped = notification.type.startsWith('chat_') || notification.type.startsWith('group_')
    || ['study_group_update', 'organizer_reminder', 'shared_organizer_invite', 'shared_organizer_update'].includes(notification.type)
  if (!scoped) return yes()
  if (!recordId(notification.recipient_id)) return no('recipient_reference_invalid')
  try {
    if (notification.type.startsWith('chat_')) return await leasedContext(service,
      'xelay_chat_notification_email_context', '/messages?space=', 'chat_unavailable', notification.chat_space_id, job)
    if (notification.type.startsWith('group_') || notification.type === 'study_group_update') return await groupContext(service, notification)
    if (notification.type === 'organizer_reminder') return await organizerContext(service, notification)
    return await leasedContext(service, 'xelay_shared_organizer_notification_email_context',
      '/organizer?view=shared&workspace=', 'shared_organizer_unavailable', notification.shared_organizer_workspace_id, job)
  } catch {
    return no('context_lookup_failed')
  }
}
