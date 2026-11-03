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
  teaching_course_id?: string | null
  teaching_event_key?: string | null
  shared_organizer_workspace_id?: string | null
  shared_organizer_invitation_id?: string | null
}
export interface NotificationEmailContextResult {
  eligible: boolean
  error: string | null
  path?: string
  academicDeadline?: AcademicDeadline
  teachingDeadlineChange?: { dueAt: number | null }
}
export interface NotificationEmailContextLease { id: string; lock_token: string }
export type AcademicDeadline = { kind: 'teaching' | 'homework' | 'long_term'; dueAt: number }

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

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T12:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function parseDeadlineInstant(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !isCalendarDate(value.slice(0, 10))) return NaN
  return Date.parse(value)
}

async function academicDeadlineContext(
  service: SupabaseClient,
  notification: NotificationEmailContextRecord,
  job?: NotificationEmailContextLease,
): Promise<NotificationEmailContextResult> {
  if (!job || !recordId(job.id) || !recordId(job.lock_token)) return no('context_lease_required')
  const { data, error } = await service.rpc('xelay_academic_deadline_email_context', {
    p_job_id: job.id, p_lock_token: job.lock_token,
  })
  if (error) return no('context_lookup_failed')
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.eligible !== 'boolean') return no('context_payload_invalid')
  if (!data.eligible) return no(typeof data.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(data.reason)
    ? data.reason : 'academic_deadline_unavailable')

  const { kind, group_id: groupId, source_id: sourceId, due_at: dueAtValue, lesson_date: lessonDate } = data
  const dueAt = parseDeadlineInstant(dueAtValue)
  if ((kind !== 'teaching' && kind !== 'homework' && kind !== 'long_term')
    || !recordId(groupId) || !recordId(notification.study_group_id)
    || groupId.toLowerCase() !== notification.study_group_id.toLowerCase() || !recordId(sourceId)
    || !Number.isFinite(dueAt)
    || (lessonDate != null && !isCalendarDate(lessonDate)) || (kind === 'homework' && !isCalendarDate(lessonDate))) {
    return no('context_payload_invalid')
  }
  let path = '/groups/' + groupId.toLowerCase() + '?tab=schedule'
  if (kind === 'homework') path += '&date=' + lessonDate + '&assignment=' + sourceId.toLowerCase() + '&kind=homework'
  if (kind === 'teaching') {
    // Unplaced assignments with a deadline appear on its Kyiv calendar day.
    const date = lessonDate ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(dueAt)
    path += '&date=' + date
  }
  return { ...yes(path), academicDeadline: { kind, dueAt } }
}

async function teachingDeadlineChangeContext(
  service: SupabaseClient,
  notification: NotificationEmailContextRecord,
  job?: NotificationEmailContextLease,
): Promise<NotificationEmailContextResult> {
  if (!job || !recordId(job.id) || !recordId(job.lock_token)) return no('context_lease_required')
  const { data, error } = await service.rpc('xelay_teaching_deadline_change_email_context', {
    p_job_id: job.id, p_lock_token: job.lock_token,
  })
  if (error) return no('context_lookup_failed')
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.eligible !== 'boolean') return no('context_payload_invalid')
  if (!data.eligible) return no(typeof data.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(data.reason)
    ? data.reason : 'teaching_deadline_change_unavailable')
  const { group_id: group, source_id: source, due_at: due, lesson_date: lesson } = data
  const dueAt = due === null ? null : parseDeadlineInstant(due)
  if (!recordId(group) || !recordId(notification.study_group_id)
    || group.toLowerCase() !== notification.study_group_id.toLowerCase()
    || !recordId(source) || source.toLowerCase() !== notification.teaching_event_key?.split(':')[1]?.toLowerCase()
    || (dueAt !== null && !Number.isFinite(dueAt)) || (lesson != null && !isCalendarDate(lesson))) return no('context_payload_invalid')
  const date = lesson ?? (dueAt === null ? null : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(dueAt))
  return {
    ...yes('/groups/' + group.toLowerCase() + '?tab=schedule' + (date ? '&date=' + date : '')),
    teachingDeadlineChange: { dueAt },
  }
}

async function teachingEmailContext(
  service: SupabaseClient,
  notification: NotificationEmailContextRecord,
  job: NotificationEmailContextLease | undefined,
  home: 'requests' | 'assignments' | null,
) {
  if (!job || !recordId(job.id) || !recordId(job.lock_token)) return no('context_lease_required')
  let path = '/teaching'
  if (home) {
    const { teaching_course_id: course, study_group_id: group } = notification
    if (!recordId(course) || !recordId(group)) return no('context_payload_invalid')
    path += `?course=${course.toLowerCase()}&group=${group.toLowerCase()}&home=${home}`
  }
  const { data, error } = await service.rpc(home ? 'xelay_teaching_action_email_context' : 'xelay_teaching_followup_email_context', {
    p_job_id: job.id, p_lock_token: job.lock_token,
  })
  if (error) return no('context_lookup_failed')
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.eligible !== 'boolean') return no('context_payload_invalid')
  if (!data.eligible) return no(typeof data.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(data.reason)
    ? data.reason : 'teaching_action_unavailable')
  return yes(path)
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
  const deadlineChange = notification.type === 'teaching_update' && notification.teaching_event_key?.startsWith('teaching-deadline:')
  const teachingHome = notification.type !== 'teaching_update' ? null
    : notification.teaching_event_key?.startsWith('grade-request:') ? 'requests'
      : notification.teaching_event_key?.startsWith('classroom-submit:') ? 'assignments' : null
  const scoped = notification.type.startsWith('chat_') || notification.type.startsWith('group_')
    || deadlineChange || teachingHome !== null || notification.type === 'teaching_followup'
    || ['study_group_update', 'organizer_reminder', 'shared_organizer_invite', 'shared_organizer_update', 'academic_deadline'].includes(notification.type)
  if (!scoped) return yes()
  if (!recordId(notification.recipient_id)) return no('recipient_reference_invalid')
  try {
    if (notification.type === 'academic_deadline') return await academicDeadlineContext(service, notification, job)
    if (deadlineChange) return await teachingDeadlineChangeContext(service, notification, job)
    if (teachingHome || notification.type === 'teaching_followup') return await teachingEmailContext(service, notification, job, teachingHome)
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
