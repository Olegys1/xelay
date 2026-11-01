import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { VerifiedAssistantSession } from './authenticatedRead.ts'
import { EXPANDED_ASSISTANT_WRITE_ACTIONS, expandedWriteForm, inspectExpandedWrite, type ExpandedAssistantWriteAction } from './cloudExpandedWrites.ts'

/** Business operations always carry the verified caller's JWT. The shared
 * inspector is used by local and durable cloud journals. The file store below
 * serializes ONE local process and must never back a cloud deployment. */
export const CONFIRMED_ASSISTANT_WRITE_ACTIONS = ['schedule.create', 'schedule.update', 'homework.upsert', 'organizer.task.create', 'seminar.book', 'seminar.team.join', 'seminar.reopen', 'teaching.assignment.upsert', 'teaching.publication.schedule', ...EXPANDED_ASSISTANT_WRITE_ACTIONS] as const
export type ConfirmedAssistantWriteAction = typeof CONFIRMED_ASSISTANT_WRITE_ACTIONS[number]
export type ConfirmedWriteScope = { groupId?: string; courseId?: string; date?: string }
type Row = Record<string, any>
export interface CallerWriteClient { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }> }
export type ConfirmedWriteStatus = 'pending' | 'committing' | 'confirmed' | 'cancelled' | 'stale' | 'unknown'
export interface ConfirmedWriteDraft {
  id: string; action: ConfirmedAssistantWriteAction; title: string; revision: number; status: ConfirmedWriteStatus;
  createdAt: string; expiresAt: string; scope: ConfirmedWriteScope; payload: Row; confirmationToken: string;
  fields: { key: string; label: string; value: string; type: string; required?: boolean }[];
  items: { id: string; label: string; before?: string; after: string }[];
  requiresMaterialRights?: boolean;
}
export interface ConfirmedWriteReceipt { draftId: string; action: ConfirmedAssistantWriteAction; savedAt: string; affectedIds: string[]; syntheticOnly: false; path: string }
export type StoredDraft = ConfirmedWriteDraft & { userId: string; recordId: string; fingerprint: string; plan: WritePlan; receipt?: ConfirmedWriteReceipt; targetSummary?: HomeworkTargetSummary }
export type HomeworkTargetSummary = { subject: string; date: string; startsAt: string; endsAt: string }
export type InspectedWrite = { fingerprint: string; plan: WritePlan; targetSummary?: HomeworkTargetSummary }
type WriteState = { schema: 1; drafts: StoredDraft[] }
export interface ConfirmedWriteStore { readonly mode: 'local-single-process'; transaction<T>(operation: (state: WriteState) => T | Promise<T>): Promise<T> }
export type WritePlan = { table?: string; operation?: 'insert' | 'update'; values?: Row; where?: Row; rpc?: string; args?: Row; path: string; affectedIds: string[]; verification?: { table: string; where: Row; expected: Row }; materialRights?: boolean; reviewItems?: { id: string; label: string; before?: string; after: string }[] }
export class ConfirmedWriteError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); this.name = 'ConfirmedWriteError' }
}
function fail(code: string, status = 400): never { throw new ConfirmedWriteError(code, status) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Row, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
const id = (v: unknown) => typeof v === 'string' && UUID.test(v) && v !== '00000000-0000-0000-0000-000000000000' ? v.toLowerCase() : fail('invalid_identifier')
const text = (v: unknown, n: number, required = false) => typeof v === 'string' && v.length <= n && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && (!required || !!v.trim()) ? v : fail('invalid_text')
const inlineText = (v: unknown, n: number, required = false) => {
  const value = text(v, n, required)
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) fail('invalid_text')
  return value.trim()
}
const date = (v: unknown): v is string => typeof v === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
const time = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)
function kyivWallInstant(day: string, wallTime: string) {
  const target = Date.parse(`${day}T${wallTime}:00Z`); let guess = target
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess))
    const part = (key: string) => parts.find(item => item.type === key)!.value
    const represented = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00Z`)
    const next = target - (represented - guess); if (next === guess) return guess; guess = next
  }
  return guess
}
const clone = <T>(v: T): T => structuredClone(v)
// PostgreSQL jsonb changes object key order. Hash semantic JSON consistently
// across a local inspection and durable cloud reload; array order still matters.
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v, (_key, value) => object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex')
const jsonSafe = (v: unknown, maximum = 150_000) => {
  let serialized: string; try { serialized = JSON.stringify(v) } catch { return false }
  return typeof serialized === 'string' && serialized.length <= maximum && !/"(?:__proto__|constructor|prototype|authorization|access_token|refresh_token|password|apiKey|serviceRoleKey|cookie)"\s*:/.test(serialized)
}
const links = (value: unknown) => {
  if (value === undefined) return [] as string[]
  if (!Array.isArray(value) || value.length > 22) return fail('invalid_links')
  return value.map(v => { const s = inlineText(v, 2000, true); let u: URL; try { u = new URL(s) } catch { return fail('invalid_links') }; if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('invalid_links'); return s })
}
function scopeOf(value: unknown): ConfirmedWriteScope {
  if (!object(value) || !exact(value, ['groupId', 'courseId', 'date'])) fail('invalid_scope')
  if (value.date !== undefined && !date(value.date)) fail('invalid_date')
  return { ...(value.groupId ? { groupId: id(value.groupId) } : {}), ...(value.courseId ? { courseId: id(value.courseId) } : {}), ...(value.date ? { date: value.date } : {}) }
}
function apiResult(result: any) {
  if (!result || result.error) {
    const code = result?.error?.code
    if (code === '42501') fail('permission_required', 403)
    if (['23505', '23514', '22023', 'PT409'].includes(code)) fail('conflict', 409)
    fail('database_unavailable', 503)
  }
  return result.data
}
async function rows(client: CallerWriteClient, table: string, columns: string, where: Row, limit = 251): Promise<Row[]> {
  let q = client.from(table).select(columns)
  for (const [key, value] of Object.entries(where)) q = q.eq(key, value)
  const data = apiResult(await q.order('id', { ascending: true }).limit(limit))
  if (!Array.isArray(data) || data.length >= limit || data.some(v => !object(v))) fail('bounded_read_required', 503)
  return data
}
async function one(client: CallerWriteClient, table: string, columns: string, where: Row) {
  const data = await rows(client, table, columns, where, 2)
  if (data.length !== 1) fail('target_unavailable', 409)
  return data[0]
}
async function scheduleOnDay(client: CallerWriteClient, groupId: string, day: string): Promise<Row[]> {
  const data = apiResult(await client.from('study_group_schedule').select(scheduleColumns).eq('group_id', groupId)
    .lte('valid_from', day).gte('valid_until', day).order('id', { ascending: true }).limit(251))
  if (!Array.isArray(data) || data.length >= 251 || data.some(row => !object(row) || row.group_id !== groupId)) fail('bounded_read_required', 503)
  return data.filter(row => occurs(row, day))
}
async function rpc(client: CallerWriteClient, name: string, args: Row = {}) { return apiResult(await client.rpc(name, args)) }
const scheduleColumns = 'id,group_id,weekday,starts_at,ends_at,subject,teacher_name,lesson_type,location,online_url,online_url_secondary,online_url_label,online_url_secondary_label,online_links_extra,conference_id,conference_access_code,valid_from,valid_until,week_pattern,week_anchor_date,excluded_dates,copied_from_schedule_id,inherit_source_links,updated_at,created_by'
function occurs(row: Row, day: string) {
  if ((new Date(day + 'T12:00:00Z').getUTCDay() || 7) !== row.weekday || row.valid_from > day || row.valid_until < day || row.excluded_dates?.includes(day)) return false
  if (!row.week_pattern || row.week_pattern === 'every') return true
  if (!date(row.week_anchor_date)) return false
  const offset = Math.floor((Date.parse(day + 'T12:00:00Z') - Date.parse(row.week_anchor_date + 'T12:00:00Z')) / 604800000)
  return (((offset % 2) + 2) % 2 === 0 ? 'upper' : 'lower') === row.week_pattern
}

export async function createLocalConfirmedWriteStore(options: { filePath?: string } = {}): Promise<ConfirmedWriteStore> {
  let state: WriteState = { schema: 1, drafts: [] }
  const filePath = options.filePath
  if (filePath && (!path.isAbsolute(filePath) || !/[\\/]output[\\/]/i.test(filePath) || !filePath.endsWith('.json'))) fail('local_store_path_required')
  if (filePath) try {
    const raw = await readFile(filePath, 'utf8')
    if (Buffer.byteLength(raw) > 10_000_000) fail('local_store_too_large')
    const parsed = JSON.parse(raw)
    if (parsed?.schema !== 1 || !Array.isArray(parsed.drafts) || parsed.drafts.length > 500 || !jsonSafe(parsed, 10_000_000)) fail('local_store_invalid')
    state = parsed
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let chain: Promise<unknown> = Promise.resolve()
  return { mode: 'local-single-process', transaction<T>(operation: (draft: WriteState) => T | Promise<T>): Promise<T> {
    const task = chain.then(async () => {
      const next = clone(state); const result = await operation(next)
      if (next.drafts.length > 500) fail('draft_store_full', 429)
      if (filePath) { await mkdir(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.pending`; await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, filePath) }
      state = next; return result
    }); chain = task.catch(() => {}); return task
  } }
}

export interface ConfirmedWriteDomainDependencies {
  verifySession(credential: string): Promise<VerifiedAssistantSession | null>;
  createCallerClient(session: VerifiedAssistantSession, credential: string): Promise<CallerWriteClient> | CallerWriteClient;
  now?: () => number; allowedWriteGroupIds?: string[];
}
/** Server-only helpers. Never serialize an inspected plan to a client. */
export function createConfirmedWriteDomain(dependencies: ConfirmedWriteDomainDependencies) {
  const sourceClock = dependencies.now ?? Date.now
  const clock = () => { const value = sourceClock(); if (!Number.isFinite(value)) fail('clock_unavailable', 503); return value }
  const allowedGroups = dependencies.allowedWriteGroupIds ? new Set(dependencies.allowedWriteGroupIds.map(id)) : null
  async function sessionOf(credential: string) {
    if (typeof credential !== 'string' || credential.length < 16 || credential.length > 8192 || /\s/.test(credential)) fail('session_invalid', 401)
    let s: VerifiedAssistantSession | null; try { s = await dependencies.verifySession(credential) } catch { return fail('session_unavailable', 503) }
    if (!s || !UUID.test(s.userId) || s.accountActive !== true || s.emailConfirmed !== true || !instant(s.expiresAt) || Date.parse(s.expiresAt) <= clock()) fail('session_invalid', 401)
    return { ...s, userId: id(s.userId) }
  }
  function guardGroup(groupId: string | undefined) { if (!groupId) fail('group_required'); if (allowedGroups && !allowedGroups.has(groupId)) fail('local_test_group_required', 403); return groupId }
  async function permissions(client: CallerWriteClient, groupId: string, right?: string) {
    const value = await rpc(client, 'xelay_study_group_permissions', { p_group_id: groupId })
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) fail('permission_unavailable', 503)
    if (right && !value.includes(right)) fail('permission_required', 403)
    return [...value].sort()
  }
  async function member(client: CallerWriteClient, userId: string, groupId: string) {
    const group = await one(client, 'study_groups', 'id,representative_id', { id: groupId })
    const memberships = await rows(client, 'study_group_members', 'id,group_id,user_id,status', { group_id: groupId, user_id: userId, status: 'accepted' }, 2)
    if (group.representative_id !== userId && !memberships.length) fail('membership_required', 403)
    return { representativeId: group.representative_id, accepted: memberships.length > 0 }
  }
  async function inspect(client: CallerWriteClient, session: VerifiedAssistantSession, action: ConfirmedAssistantWriteAction, scope: ConfirmedWriteScope, payload: Row, recordId: string): Promise<InspectedWrite> {
    if (!object(payload) || !jsonSafe(payload)) fail('invalid_payload')
    const group = action === 'organizer.task.create' ? scope.groupId : guardGroup(scope.groupId)
    if (group && allowedGroups && !allowedGroups.has(group)) fail('local_test_group_required', 403)
    if ((EXPANDED_ASSISTANT_WRITE_ACTIONS as readonly string[]).includes(action)) return inspectExpandedWrite(action as ExpandedAssistantWriteAction, {
      client, session, scope, payload, recordId, clock, fail, id, text, inlineText, date, instant, time, object, exact, links, fingerprint,
      guardGroup, permissions, rows, one, rpc, scheduleOnDay,
    })
    let baseline: unknown, plan: WritePlan, targetSummary: HomeworkTargetSummary | undefined
    if (action === 'schedule.create' || action === 'schedule.update') {
      if (!exact(payload, ['id', 'date', 'subject', 'startsAt', 'endsAt', 'lessonType', 'location', 'teacherName', 'links', 'conferenceId', 'accessCode', 'week', 'recurring', 'weekday', 'validFrom', 'validUntil', 'weekPattern', 'weekAnchorDate'])) fail('invalid_payload')
      const day = payload.date ?? scope.date
      if (!date(day) || !time(payload.startsAt) || !time(payload.endsAt) || payload.startsAt >= payload.endsAt || !['lecture', 'seminar', 'practical', 'lab', 'makeup', 'replacement', 'module', 'final_assessment', 'test', 'other'].includes(payload.lessonType)) fail('invalid_schedule')
      const recurring = payload.recurring === true, validFrom = recurring ? payload.validFrom ?? day : day, validUntil = recurring ? payload.validUntil : day
      const weekPattern = recurring ? payload.weekPattern ?? (payload.week === 'upper' || payload.week === 'lower' ? payload.week : 'every') : 'every'
      const weekday = recurring ? payload.weekday ?? (new Date(day + 'T12:00:00Z').getUTCDay() || 7) : new Date(day + 'T12:00:00Z').getUTCDay() || 7
      if (!date(validFrom) || !date(validUntil) || validUntil < validFrom || (Date.parse(validUntil) - Date.parse(validFrom)) / 86400000 > 366
        || !Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !['every', 'upper', 'lower'].includes(weekPattern)
        || weekPattern !== 'every' && (!date(payload.weekAnchorDate) || new Date(payload.weekAnchorDate + 'T12:00:00Z').getUTCDay() !== 1) || !recurring && (payload.week && payload.week !== 'both' || payload.weekPattern && payload.weekPattern !== 'every')) fail('invalid_recurrence')
      const rights = await permissions(client, group!, 'schedule')
      const entries = recurring ? apiResult(await client.from('study_group_schedule').select(scheduleColumns).eq('group_id', group!)
        .lte('valid_from', validUntil).gte('valid_until', validFrom).order('id', { ascending: true }).limit(1001)) : await scheduleOnDay(client, group!, day)
      if (!Array.isArray(entries) || entries.length >= 1001 || entries.some(row => !object(row) || row.group_id !== group)) fail('bounded_read_required', 503)
      const previous = action === 'schedule.update' ? entries.find(row => row.id === id(payload.id)) : undefined
      if (action === 'schedule.update' && (!previous || !instant(previous.updated_at) || !recurring && (previous.valid_from !== day || previous.valid_until !== day))) fail('explicit_series_scope_required', 422)
      const candidate = { weekday, valid_from: validFrom, valid_until: validUntil, week_pattern: weekPattern, week_anchor_date: weekPattern === 'every' ? null : payload.weekAnchorDate, excluded_dates: previous?.excluded_dates ?? [] }
      let occurrenceCount = 0
      for (let stamp = Date.parse(validFrom + 'T12:00:00Z'); stamp <= Date.parse(validUntil + 'T12:00:00Z'); stamp += 86400000) {
        const occurrenceDay = new Date(stamp).toISOString().slice(0, 10)
        if (!occurs(candidate, occurrenceDay)) continue
        occurrenceCount++
        if (entries.some(row => row.id !== previous?.id && occurs(row, occurrenceDay) && String(row.starts_at).slice(0, 5) < payload.endsAt && String(row.ends_at).slice(0, 5) > payload.startsAt)) fail('schedule_overlap', 409)
      }
      if (!occurrenceCount) fail('schedule_has_no_occurrences')
      const urls = links(payload.links)
      const preserveLinks = previous && payload.links === undefined
      const values = { group_id: group, weekday, starts_at: payload.startsAt, ends_at: payload.endsAt,
        subject: inlineText(payload.subject, 120, true), teacher_name: inlineText(payload.teacherName ?? previous?.teacher_name ?? '', 180).replace(/\s+/g, ' '), lesson_type: payload.lessonType, location: inlineText(payload.location ?? previous?.location ?? '', 160),
        online_url: preserveLinks ? previous.online_url ?? null : urls[0] ?? null, online_url_secondary: preserveLinks ? previous.online_url_secondary ?? null : urls[1] ?? null,
        online_url_label: preserveLinks ? previous.online_url_label ?? null : null, online_url_secondary_label: preserveLinks ? previous.online_url_secondary_label ?? null : null,
        online_links_extra: preserveLinks ? previous.online_links_extra ?? [] : urls.slice(2).map(url => ({ url, label: '' })),
        conference_id: inlineText(payload.conferenceId ?? previous?.conference_id ?? '', 120) || null, conference_access_code: inlineText(payload.accessCode ?? previous?.conference_access_code ?? '', 120) || null,
        valid_from: validFrom, valid_until: validUntil, week_pattern: weekPattern, week_anchor_date: weekPattern === 'every' ? null : payload.weekAnchorDate, created_by: previous?.created_by ?? session.userId }
      baseline = { rights, entries }
      plan = { table: 'study_group_schedule', operation: previous ? 'update' : 'insert', values: previous ? values : { id: recordId, ...values },
        ...(previous ? { where: { id: previous.id, group_id: group, updated_at: previous.updated_at } } : {}),
        path: `/groups/${group}?tab=schedule&date=${day}`, affectedIds: [previous?.id ?? recordId], verification: { table: 'study_group_schedule', where: { id: previous?.id ?? recordId, group_id: group }, expected: values } }
    } else if (action === 'homework.upsert') {
      if (!exact(payload, ['lessonId', 'date', 'topic', 'body', 'dueAt'])) fail('invalid_payload')
      if (payload.dueAt != null && !instant(payload.dueAt)) fail('invalid_deadline')
      const day = payload.date ?? scope.date; if (!date(day)) fail('invalid_date')
      const scheduleId = id(payload.lessonId), rights = await permissions(client, group!, 'homework')
      const lesson = await one(client, 'study_group_schedule', scheduleColumns, { id: scheduleId, group_id: group })
      if (!occurs(lesson, day)) fail('lesson_not_on_date', 409)
      targetSummary = { subject: text(lesson.subject, 120, true), date: day, startsAt: String(lesson.starts_at).slice(0, 5), endsAt: String(lesson.ends_at).slice(0, 5) }
      const existing = await rows(client, 'study_group_homework', 'id,group_id,schedule_item_id,lesson_date,lesson_topic,body,due_at,url,resource_links,resource_link_labels,attachments,updated_at,created_by', { group_id: group, schedule_item_id: scheduleId, lesson_date: day }, 2)
      const previous = existing[0]
      if (previous && !instant(previous.updated_at)) fail('conflict_version_required', 409)
      const topic = text(payload.topic ?? '', 240), body = text(payload.body ?? '', 10000)
      if (!topic.trim() && !body.trim()) fail('empty_homework')
      const values = { group_id: group, schedule_item_id: scheduleId, lesson_date: day, lesson_topic: topic || null, body, created_by: previous?.created_by ?? session.userId,
        ...(payload.dueAt !== undefined ? { due_at: payload.dueAt } : previous?.due_at !== undefined ? { due_at: previous.due_at } : {}),
        url: previous?.url ?? null, resource_links: previous?.resource_links ?? [], resource_link_labels: previous?.resource_link_labels ?? {}, attachments: previous?.attachments ?? [] }
      baseline = { rights, lesson, previous: previous ?? null }
      plan = { table: 'study_group_homework', operation: previous ? 'update' : 'insert', values: previous ? values : { id: recordId, ...values },
        ...(previous ? { where: { id: previous.id, group_id: group, lesson_date: day, updated_at: previous.updated_at } } : {}),
        path: `/groups/${group}?tab=schedule&date=${day}`, affectedIds: [previous?.id ?? recordId], verification: { table: 'study_group_homework', where: { id: previous?.id ?? recordId, group_id: group }, expected: values } }
    } else if (action === 'organizer.task.create') {
      if (!exact(payload, ['title', 'body', 'notes', 'subject', 'dueAt', 'dueDate', 'reminderAt', 'reminderOffsetsMinutes', 'recurrence', 'recurrenceUntil', 'space', 'memberIds']) || payload.space && payload.space !== 'personal' || payload.memberIds?.length) fail('shared_organizer_requires_platform_editor', 422)
      if (payload.dueAt != null && !instant(payload.dueAt)) fail('invalid_deadline')
      if (payload.dueDate != null && !date(payload.dueDate) || payload.dueDate != null && payload.dueAt != null) fail('invalid_deadline')
      if (payload.reminderAt != null && (!instant(payload.reminderAt) || Date.parse(payload.reminderAt) <= clock() || !payload.dueAt && !payload.dueDate)) fail('invalid_reminder')
      const givenOffsets = payload.reminderOffsetsMinutes ?? []
      if (!Array.isArray(givenOffsets) || givenOffsets.length > 5 || new Set(givenOffsets).size !== givenOffsets.length || givenOffsets.some(v => ![15, 60, 180, 1440, 10080].includes(v)) || givenOffsets.length && !payload.dueAt && !payload.dueDate) fail('invalid_reminder')
      const offsets = [...givenOffsets].sort((left, right) => left - right)
      const dueBase = payload.dueAt ? Date.parse(payload.dueAt) : payload.dueDate ? kyivWallInstant(payload.dueDate, '18:00') : null
      if (offsets.some(value => dueBase === null || dueBase - value * 60000 <= clock())) fail('invalid_reminder')
      const dueDay = payload.dueDate ?? (payload.dueAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(payload.dueAt)) : '')
      const recurrence = payload.recurrence ?? 'none'
      if (!['none', 'daily', 'weekly', 'monthly'].includes(recurrence) || recurrence !== 'none' && !payload.dueAt && !payload.dueDate
        || payload.recurrenceUntil != null && (!date(payload.recurrenceUntil) || recurrence === 'none' || payload.recurrenceUntil < dueDay)) fail('invalid_recurrence')
      const active = await rpc(client, 'xelay_has_participant_access', { p_user_id: session.userId })
      if (active !== true) fail('participant_required', 403)
      const values = { id: recordId, user_id: session.userId, title: inlineText(payload.title, 200, true), notes: text(payload.notes ?? payload.body ?? '', 10000), subject: inlineText(payload.subject ?? '', 120), due_at: payload.dueAt ?? null, due_date: payload.dueDate ?? null, reminder_at: payload.reminderAt ?? null, ...(offsets.length ? { reminder_offsets_minutes: offsets } : {}), recurrence_rule: recurrence, recurrence_until: payload.recurrenceUntil ?? null, completed: false }
      baseline = { participant: true }
      plan = { table: 'organizer_tasks', operation: 'insert', values, path: '/organizer', affectedIds: [recordId], verification: { table: 'organizer_tasks', where: { id: recordId, user_id: session.userId }, expected: values } }
    } else if (['seminar.book', 'seminar.team.join', 'seminar.reopen'].includes(action)) {
      if (!exact(payload, action === 'seminar.reopen' ? ['id', 'closesAt'] : action === 'seminar.book' ? ['id', 'questionId', 'role'] : ['id', 'teamId'])) fail('invalid_payload')
      const seminarId = id(payload.id)
      const seminar = await one(client, 'study_group_seminars', 'id,group_id,subject_id,title,lesson_date,starts_at,ends_at,format,selection_deadline_at,selection_version', { id: seminarId, group_id: group })
      const seminarSummary = [
        { id: 'authoritative-seminar', label: 'Семінар', after: inlineText(seminar.title ?? 'Семінар', 160, true) },
        { id: 'seminar-date', label: 'Дата й час семінару', after: `${date(seminar.lesson_date) ? reviewDate(seminar.lesson_date) : text(seminar.lesson_date, 10, true)} · ${String(seminar.starts_at).slice(0, 5)}–${String(seminar.ends_at).slice(0, 5)}` },
      ]
      if (action === 'seminar.reopen') {
        const rights = await permissions(client, group!, 'seminars')
        if (!instant(payload.closesAt) || Date.parse(payload.closesAt) <= clock() || !Number.isInteger(seminar.selection_version)) fail('invalid_selection_deadline')
        baseline = { rights, seminar }
        plan = { rpc: 'xelay_set_seminar_selection_deadline', args: { p_group_id: group, p_seminar_id: seminarId, p_deadline: payload.closesAt, p_expected_version: seminar.selection_version }, path: `/groups/${group}?tab=seminars`, affectedIds: [seminarId],
          reviewItems: [...seminarSummary, { id: 'selection-change', label: 'Дія', after: 'Повторно відкрити запис. Наявні питання, команди й вибір учасників збережуться.' }] }
      } else {
        const membership = await member(client, session.userId, group!)
        if (instant(seminar.selection_deadline_at) && Date.parse(seminar.selection_deadline_at) <= clock()) fail('seminar_selection_closed', 409)
        const isTeam = action === 'seminar.team.join', targetId = id(isTeam ? payload.teamId : payload.questionId)
        const target = await one(client, isTeam ? 'study_group_seminar_teams' : 'study_group_seminar_questions', isTeam ? 'id,seminar_id,name,capacity' : 'id,seminar_id,body,primary_capacity,supplement_capacity', { id: targetId, seminar_id: seminarId })
        const own = await rows(client, 'study_group_seminar_reservations', 'id,seminar_id,user_id,role,question_id,team_id', { seminar_id: seminarId, user_id: session.userId }, 2)
        const role = isTeam ? 'team' : payload.role ?? (seminar.format === 'booking' ? 'booking' : 'primary')
        if (!['primary', 'supplement', 'booking', 'team'].includes(role) || isTeam && seminar.format !== 'teams' || !isTeam && seminar.format === 'teams') fail('invalid_seminar_format')
        if (!isTeam && (seminar.format === 'booking' ? role !== 'booking' : !['primary', 'supplement'].includes(role))) fail('invalid_seminar_format')
        baseline = { membership, seminar, target, own }
        plan = { rpc: 'xelay_reserve_seminar', args: { p_seminar_id: seminarId, p_role: role, p_target_id: targetId }, path: `/groups/${group}?tab=seminars`, affectedIds: [seminarId],
          reviewItems: [...seminarSummary,
            { id: 'selected-seminar-target', label: isTeam ? 'Команда' : 'Питання', after: text(isTeam ? target.name : target.body, isTeam ? 80 : 2000, true) },
            { id: 'selection-role', label: 'Ваша роль', after: ({ primary: 'Доповідач', supplement: 'Доповнювач', booking: 'Бронювання питання', team: 'Учасник команди' } as Row)[role] },
            ...(own.length ? [{ id: 'previous-selection', label: 'Попередній вибір', after: 'Поточний вибір у цьому семінарі буде замінено на показаний.' }] : []),
          ],
          verification: { table: 'study_group_seminar_reservations', where: { seminar_id: seminarId, user_id: session.userId }, expected: { seminar_id: seminarId, user_id: session.userId, role, question_id: isTeam ? null : targetId, team_id: isTeam ? targetId : null } } }
      }
    } else if (action === 'teaching.assignment.upsert' || action === 'teaching.publication.schedule') {
      if (!exact(payload, ['id', 'version', 'title', 'body', 'groupIds', 'targets', 'dueAt', 'kind', 'publishAt', 'submissionFormat', 'workType', 'links', 'maxPoints', 'category']) || payload.kind !== undefined && payload.kind !== 'assignment') fail('invalid_payload')
      const courseId = id(scope.courseId)
      const groupIds = Array.isArray(payload.groupIds) ? payload.groupIds.map(id) : [group!]
      if (!groupIds.length || groupIds.length > 30 || new Set(groupIds).size !== groupIds.length || !groupIds.includes(group!)) fail('invalid_targets')
      const contexts: Row[] = []
      for (const targetGroup of groupIds) {
        guardGroup(targetGroup)
        const context = await rpc(client, 'xelay_teaching_group_context', { p_group_id: targetGroup })
        const course = context?.courses?.find((c: Row) => c.id === courseId)
        if (!course || course.archived_at || !course.permissions?.includes('assignments')) fail('permission_required', 403)
        contexts.push({ groupId: targetGroup, course, groupName: context?.group?.group_name ?? context?.group?.name ?? 'Підключена група' })
      }
      const previous = payload.id ? await one(client, 'teaching_items', 'id,course_id,kind,version,status,title,body,links,link_labels,attachments,submission_format,work_type,max_points,category,publish_at,created_by', { id: id(payload.id), course_id: courseId, kind: 'assignment' }) : null
      if (previous && (payload.version !== previous.version || groupIds.length > 1)) fail('conflict', 409)
      if (payload.dueAt != null && !instant(payload.dueAt)) fail('invalid_deadline')
      const targets = Array.isArray(payload.targets) ? payload.targets.map((target: unknown) => {
        if (!object(target) || !exact(target, ['groupId', 'lessonDate', 'lessonId', 'dueAt', 'closesAt', 'placementMode'])) fail('invalid_targets')
        const targetGroup = id(target.groupId); if (!groupIds.includes(targetGroup) || !date(target.lessonDate)) fail('invalid_targets')
        if (target.dueAt != null && !instant(target.dueAt) || target.closesAt != null && !instant(target.closesAt)) fail('invalid_deadline')
        const mode = target.placementMode ?? (target.lessonId ? 'lesson' : 'unplaced'); if (!['lesson', 'unplaced'].includes(mode)) fail('invalid_targets')
        return { group_id: targetGroup, lesson_date: target.lessonDate, schedule_item_id: mode === 'lesson' ? id(target.lessonId) : null, placement_mode: mode, due_at: target.dueAt === undefined ? payload.dueAt ?? null : target.dueAt, closes_at: target.closesAt ?? null }
      }) : groupIds.map((group_id: string) => { if (!date(scope.date)) fail('assignment_date_required'); return { group_id, lesson_date: scope.date, schedule_item_id: null, placement_mode: 'unplaced', due_at: payload.dueAt ?? null, closes_at: null } })
      if (targets.length !== groupIds.length || new Set(targets.map((t: Row) => t.group_id)).size !== groupIds.length) fail('invalid_targets')
      for (const target of targets) if (target.placement_mode === 'lesson') {
        const current = await rpc(client, 'xelay_teaching_assignment_lessons', { p_course_id: courseId, p_group_id: target.group_id, p_lesson_date: target.lesson_date })
        if (!Array.isArray(current?.lessons) || !current.lessons.some((lesson: Row) => lesson.id === target.schedule_item_id && lesson.group_id === target.group_id)) fail('lesson_not_on_date', 409)
        contexts.push({ groupId: target.group_id, boundLesson: current.lessons.find((lesson: Row) => lesson.id === target.schedule_item_id) })
      }
      const scheduled = action === 'teaching.publication.schedule'
      if (scheduled && (!instant(payload.publishAt) || Date.parse(payload.publishAt) <= clock())) fail('invalid_publication_time')
      if (scheduled && previous?.status === 'published') fail('published_cannot_schedule', 409)
      if (payload.maxPoints != null && (!Number.isFinite(payload.maxPoints) || payload.maxPoints <= 0 || payload.maxPoints > 10000 || Math.round(payload.maxPoints * 100) / 100 !== payload.maxPoints)) fail('invalid_max_points')
      const format = payload.submissionFormat ?? previous?.submission_format ?? 'written'; if (!['written', 'oral', 'defense'].includes(format)) fail('invalid_submission_format')
      const data = { id: previous?.id ?? recordId, course_id: courseId, expected_user_id: session.userId, version: previous?.version ?? 0, title: text(payload.title, 240, true), body: text(payload.body ?? '', 50000),
        links: payload.links === undefined ? previous?.links ?? [] : links(payload.links), link_labels: previous?.link_labels ?? {}, attachments: previous?.attachments ?? [], targets,
        status: scheduled ? 'scheduled' : 'published', publish_at: scheduled ? payload.publishAt : null, submission_format: format, work_type: text(payload.workType ?? previous?.work_type ?? '', 100), max_points: payload.maxPoints === undefined ? previous?.max_points ?? null : payload.maxPoints, category: inlineText(payload.category ?? previous?.category ?? '', 100) }
      baseline = { contexts, previous }
      plan = { rpc: groupIds.length > 1 ? 'xelay_teaching_save_multi_assignment' : 'xelay_teaching_classified_assignment', args: groupIds.length > 1 ? { p_payload: data } : { p_action: 'save_group_assignment', p_payload: data }, path: `/teaching`, affectedIds: [data.id],
        reviewItems: targets.map((target: Row, index: number) => { const context = contexts.find(row => row.groupId === target.group_id && row.course), bound = contexts.find(row => row.groupId === target.group_id && row.boundLesson)?.boundLesson
          return { id: `assignment-target-${index}`, label: inlineText(context?.groupName ?? 'Підключена група', 240, true), after: `${reviewDate(target.lesson_date)} · ${bound ? `${String(bound.starts_at).slice(0, 5)}–${String(bound.ends_at).slice(0, 5)} · ${bound.subject}` : 'Без прив’язки до пари'}\nТермін здачі: ${target.due_at ? reviewValue('dueAt', target.due_at) : 'Вільний термін'}${target.closes_at ? `\nПрийом робіт до: ${reviewValue('closesAt', target.closes_at)}` : ''}` }
        }) }
    } else {
      // File replacement/delegation must reuse the current private upload and
      // rights-acceptance UI, not accept fixture refs or invented storage paths.
      return fail('material_update_requires_verified_upload_and_rights', 422)
    }
    return { fingerprint: fingerprint(baseline), plan, ...(targetSummary ? { targetSummary } : {}) }
  }
  function publicDraft(draft: StoredDraft): ConfirmedWriteDraft {
    const { userId, recordId, fingerprint: hidden, plan, receipt, targetSummary, ...view } = clone(draft)
    return { ...view, ...review(draft.action, draft.payload, targetSummary, plan), ...(plan.materialRights ? { requiresMaterialRights: true } : {}) }
  }
  function owned(state: WriteState, session: VerifiedAssistantSession, value: unknown, bind = true) {
    if (!object(value) || !exact(value, ['id', 'revision', 'confirmationToken', 'payload', 'acceptMaterialRights']) || !Number.isInteger(value.revision)) fail('invalid_binding')
    const draft = state.drafts.find(row => row.id === id(value.id) && row.userId === session.userId)
    if (!draft) fail('draft_not_found', 404)
    if (draft.revision !== value.revision) fail('draft_changed', 409)
    if (bind) {
      const token = value.confirmationToken
      if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token) || !/^[a-f0-9]{48}$/.test(draft.confirmationToken)
        || !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(draft.confirmationToken, 'hex'))) fail('invalid_binding', 403)
    }
    return draft
  }
  const reviewLabels: Record<string, string> = { topic: 'Тема домашнього завдання', body: 'Повний текст завдання', title: 'Назва', notes: 'Нотатки', date: 'Дата заняття', subject: 'Предмет', startsAt: 'Початок', endsAt: 'Завершення', lessonType: 'Тип заняття', location: 'Аудиторія або місце', teacherName: 'Викладач', links: 'Посилання на заняття', conferenceId: 'Ідентифікатор конференції', accessCode: 'Код доступу', dueAt: 'Термін виконання', closesAt: 'Запис відкрито до', publishAt: 'Час публікації', submissionFormat: 'Формат здачі', workType: 'Вид роботи', week: 'Тиждень', recurring: 'Повторення', space: 'Органайзер' }
  Object.assign(reviewLabels, { sourceDate: 'Поточна дата', targetDate: 'Нова дата', validFrom: 'Повторювати з', validUntil: 'Повторювати до', weekPattern: 'Чергування тижнів', weekAnchorDate: 'Початок верхнього тижня', weekday: 'День тижня', instructions: 'Умови семінару', format: 'Розподіл завдань', firstShiftStart: 'Початок першої пари', timeMode: 'Час перенесення', rememberFirstShiftStart: 'Запам’ятати для субот', status: 'Стан публікації', allowDownload: 'Дозволити завантаження', accessUntil: 'Доступ до', materialDate: 'Дата матеріалу', maxPoints: 'Максимум балів', category: 'Категорія журналу', dueDate: 'Дата виконання', reminderAt: 'Нагадати', reminderOffsetsMinutes: 'Нагадування за хвилин', recurrence: 'Повторення', recurrenceUntil: 'Повторювати до', allow: 'Дозвіл на пояснення ШІ' })
  const lessonNames: Record<string, string> = { lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне заняття', lab: 'Лабораторна', makeup: 'Відпрацювання', replacement: 'Заміна', module: 'Модуль', final_assessment: 'Підсумкова робота', test: 'Контрольна робота', other: 'Інше заняття' }
  const reviewDate = (value: string) => new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value + 'T12:00:00Z'))
  function reviewValue(key: string, value: unknown): string {
    if (value === null || value === undefined || value === '') return key === 'dueAt' ? 'Не встановлено' : key === 'links' ? 'Не додано' : 'Не вказано'
    if (key === 'lessonType') return lessonNames[String(value)] ?? String(value)
    if (['date', 'sourceDate', 'targetDate', 'validFrom', 'validUntil', 'weekAnchorDate', 'dueDate', 'recurrenceUntil', 'materialDate'].includes(key) && date(value)) return reviewDate(value)
    if (['dueAt', 'closesAt', 'publishAt', 'reminderAt', 'accessUntil'].includes(key) && instant(value)) return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
    if (key === 'week' || key === 'weekPattern') return ({ both: 'Щотижня', every: 'Щотижня', upper: 'Верхній тиждень', lower: 'Нижній тиждень' } as Row)[String(value)] ?? String(value)
    if (key === 'space') return value === 'personal' ? 'Особистий' : 'Спільний'
    if (key === 'recurring') return value ? 'Повторюється' : 'Лише одна дата'
    if (key === 'submissionFormat') return ({ written: 'Письмово', oral: 'Усно', defense: 'Захист' } as Row)[String(value)] ?? String(value)
    if (key === 'format') return ({ questions: 'Доповідачі та доповнювачі', booking: 'Бронювання', teams: 'Команди' } as Row)[String(value)] ?? String(value)
    if (key === 'status') return ({ draft: 'Чернетка', published: 'Опублікувати', scheduled: 'Запланувати' } as Row)[String(value)] ?? String(value)
    if (key === 'timeMode') return value === 'first_shift' ? 'Перша зміна' : 'Залишити час'
    if (key === 'recurrence') return ({ none: 'Без повторення', daily: 'Щодня', weekly: 'Щотижня', monthly: 'Щомісяця' } as Row)[String(value)] ?? String(value)
    if (typeof value === 'boolean') return value ? 'Так' : 'Ні'
    if (Array.isArray(value)) return value.length ? value.map(item => object(item) ? JSON.stringify(item, null, 2) : String(item)).join('\n') : 'Не додано'
    if (object(value)) return JSON.stringify(value, null, 2)
    return String(value)
  }
  function review(action: string, payload: Row, target?: HomeworkTargetSummary, plan?: WritePlan) {
    const entries = Object.entries(payload).filter(([key]) => Object.prototype.hasOwnProperty.call(reviewLabels, key))
    const columns: Record<string, string> = { subject: 'subject', teacherName: 'teacher_name', location: 'location', conferenceId: 'conference_id', accessCode: 'conference_access_code', title: 'title', notes: 'notes' }
    const savedValue = (key: string, value: unknown) => plan?.values && columns[key] && Object.prototype.hasOwnProperty.call(plan.values, columns[key]) ? plan.values[columns[key]] : value
    const items = entries.map(([key, value]) => ({ id: key, label: reviewLabels[key], after: reviewValue(key, savedValue(key, value)) }))
    for (const item of plan?.reviewItems ?? []) { const previous = items.findIndex(row => row.id === item.id); if (previous >= 0) items[previous] = clone(item); else items.push(clone(item)) }
    if (action === 'homework.upsert') items.unshift({ id: 'authoritative-lesson', label: 'Пара, до якої додається ДЗ', after: target ? `${target.subject} · ${reviewDate(target.date)} · ${target.startsAt}–${target.endsAt}` : 'Оновіть чернетку, щоб перевірити назву, дату й час пари.' })
    return { title: action.startsWith('homework.') ? 'Домашнє завдання' : action.startsWith('schedule.') ? 'Зміна розкладу' : action.startsWith('seminar.') ? 'Семінар' : action.startsWith('teaching.material.') ? 'Матеріал викладача' : action === 'teaching.grades.save' ? 'Внести вказані вами бали' : action === 'teaching.grading.save' ? 'Правила оцінювання' : action.startsWith('teaching.') ? 'Завдання викладача' : 'Завдання в органайзері',
      fields: entries.filter(([, value]) => typeof value === 'string' || value === null).map(([key, value]) => ({ key, label: reviewLabels[key], value: value == null ? '' : String(value), type: key === 'body' || key === 'notes' ? 'textarea' : key === 'date' ? 'date' : ['startsAt', 'endsAt'].includes(key) ? 'time' : 'text' })), items }
  }
  async function form(credential: string, value: unknown) {
    if (!object(value) || !exact(value, ['action', 'scope', 'payload']) || !CONFIRMED_ASSISTANT_WRITE_ACTIONS.includes(value.action)
      || value.payload !== undefined && (!object(value.payload) || !jsonSafe(value.payload))) fail('unsupported_action', 422)
    const session = await sessionOf(credential), client = await dependencies.createCallerClient(session, credential), scope = scopeOf(value.scope)
    const result = await expandedWriteForm(value.action, { client, session, scope, payload: value.payload ?? {}, recordId: randomUUID(), clock, fail, id, text, inlineText, date, instant, time, object, exact, links, fingerprint,
      guardGroup, permissions, rows, one, rpc, scheduleOnDay })
    const latest = await sessionOf(credential); if (latest.userId !== session.userId || latest.sessionId !== session.sessionId) fail('session_changed', 401)
    return { form: result }
  }
  return { clock, sessionOf, inspect, publicDraft, owned, review, scopeOf, fingerprint, id, jsonSafe, object, exact, form }
}

export function createConfirmedAssistantWrites(dependencies: ConfirmedWriteDomainDependencies & { store: ConfirmedWriteStore }) {
  const { clock, sessionOf, inspect, publicDraft, owned, review, form } = createConfirmedWriteDomain(dependencies)
  return {
    supportedActions: [...CONFIRMED_ASSISTANT_WRITE_ACTIONS],
    form,
    async list(credential: string) {
      const session = await sessionOf(credential)
      return dependencies.store.transaction(state => ({ drafts: state.drafts.filter(row => row.userId === session.userId).slice(-100).reverse().map(row => ({ draft: publicDraft(row), ...(row.receipt ? { receipt: clone(row.receipt) } : {}) })) }))
    },
    async get(credential: string, draftId: string) {
      const session = await sessionOf(credential), targetId = id(draftId)
      return dependencies.store.transaction(state => { const draft = state.drafts.find(row => row.id === targetId && row.userId === session.userId); if (!draft) fail('draft_not_found', 404); return { status: draft.status, draft: publicDraft(draft), ...(draft.receipt ? { receipt: clone(draft.receipt) } : {}) } })
    },
    async prepare(credential: string, value: unknown) {
      if (!object(value) || !exact(value, ['action', 'scope', 'payload']) || !CONFIRMED_ASSISTANT_WRITE_ACTIONS.includes(value.action)) fail('unsupported_action', 422)
      const action = value.action as ConfirmedAssistantWriteAction, scope = scopeOf(value.scope), payload = clone(value.payload)
      const session = await sessionOf(credential), client = await dependencies.createCallerClient(session, credential), recordId = randomUUID()
      const inspected = await inspect(client, session, action, scope, payload, recordId)
      const latest = await sessionOf(credential); if (latest.userId !== session.userId || latest.sessionId !== session.sessionId) fail('session_changed', 401)
      return dependencies.store.transaction(state => {
        if (state.drafts.filter(row => row.userId === session.userId && row.status === 'pending' && Date.parse(row.expiresAt) > clock()).length >= 20) fail('draft_limit', 429)
        const draft: StoredDraft = { id: randomUUID(), action, revision: 1, status: 'pending', createdAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 900000).toISOString(), scope, payload,
          confirmationToken: randomBytes(24).toString('hex'), userId: session.userId, recordId, ...review(action, payload, inspected.targetSummary, inspected.plan), ...inspected }
        state.drafts.push(draft); return { status: 'draft' as const, draft: publicDraft(draft) }
      })
    },
    async edit(credential: string, value: unknown) {
      const session = await sessionOf(credential), client = await dependencies.createCallerClient(session, credential)
      return dependencies.store.transaction(async state => {
        const draft = owned(state, session, value)
        if (draft.status !== 'pending' || Date.parse(draft.expiresAt) <= clock()) fail('draft_unavailable', 409)
        const payload = clone((value as Row).payload), inspected = await inspect(client, session, draft.action, draft.scope, payload, draft.recordId)
        Object.assign(draft, { payload, revision: draft.revision + 1, confirmationToken: randomBytes(24).toString('hex'), ...review(draft.action, payload, inspected.targetSummary, inspected.plan), ...inspected })
        return { status: 'draft' as const, draft: publicDraft(draft) }
      })
    },
    async cancel(credential: string, value: unknown) {
      const session = await sessionOf(credential)
      return dependencies.store.transaction(state => { const draft = owned(state, session, value); if (draft.status !== 'pending') fail('draft_unavailable', 409); draft.status = 'cancelled'; return { status: 'cancelled' as const, draft: publicDraft(draft) } })
    },
    async confirm(credential: string, value: unknown) {
      const session = await sessionOf(credential), client = await dependencies.createCallerClient(session, credential)
      const prepared = await dependencies.store.transaction(async state => {
        const draft = owned(state, session, value)
        if (draft.status === 'confirmed' && draft.receipt) return { duplicate: true as const, draft: publicDraft(draft), receipt: draft.receipt }
        if (draft.status !== 'pending') fail(draft.status === 'committing' || draft.status === 'unknown' ? 'execution_unknown' : 'draft_unavailable', 409)
        if (Date.parse(draft.expiresAt) <= clock()) fail('draft_expired', 409)
        if (draft.action === 'homework.upsert' && !draft.targetSummary) fail('draft_review_required', 409)
        if (draft.plan.materialRights && (value as Row).acceptMaterialRights !== true) fail('material_rights_acceptance_required', 422)
        const inspected = await inspect(client, session, draft.action, draft.scope, draft.payload, draft.recordId)
        if (inspected.fingerprint !== draft.fingerprint || fingerprint(inspected.plan) !== fingerprint(draft.plan)) fail('draft_conflict', 409)
        const latest = await sessionOf(credential); if (latest.userId !== session.userId || latest.sessionId !== session.sessionId) fail('session_changed', 401)
        draft.status = 'committing'
        return { duplicate: false as const, id: draft.id, action: draft.action, plan: clone(inspected.plan) }
      })
      if (prepared.duplicate) return { status: 'confirmed' as const, draft: prepared.draft, receipt: prepared.receipt }
      // The committed local journal precedes the first mutation. A lost response
      // remains unknown and can never dispatch the same draft a second time.
      const success = await executeConfirmedWritePlan(client, prepared.plan, { acceptMaterialRights: (value as Row).acceptMaterialRights === true })
      return dependencies.store.transaction(state => {
        const draft = state.drafts.find(row => row.id === prepared.id && row.userId === session.userId)
        if (!draft || draft.status !== 'committing') fail('execution_unknown', 409)
        draft.status = success ? 'confirmed' : 'unknown'
        if (!success) return { status: 'unknown' as const, draft: publicDraft(draft), text: 'Результат збереження не підтверджено. Повтор вимкнено; перевірте запис у групі.' }
        draft.receipt = { draftId: draft.id, action: draft.action, savedAt: new Date(clock()).toISOString(), affectedIds: prepared.plan.affectedIds, path: prepared.plan.path, syntheticOnly: false }
        return { status: 'confirmed' as const, draft: publicDraft(draft), receipt: draft.receipt }
      })
    },
  }
}

/** A single dispatch and read-back verification. Callers must durably claim
 * their private journal before invoking this with a freshly inspected plan.
 * Even a transport exception may follow a commit, so this never retries. */
export async function executeConfirmedWritePlan(client: CallerWriteClient, plan: WritePlan, options: { atomicScheduleCreate?: boolean; acceptMaterialRights?: boolean } = {}): Promise<boolean> {
  try {
    if (plan.rpc) {
      if (!['xelay_reserve_seminar', 'xelay_set_seminar_selection_deadline', 'xelay_teaching_classified_assignment', 'xelay_teaching_save_multi_assignment',
        'xelay_copy_study_group_schedule_day', 'xelay_copy_study_group_schedule_day_with_custom_times', 'xelay_assistant_move_schedule',
        'xelay_save_seminar_subject', 'xelay_save_seminar_schedule', 'xelay_save_seminar_with_resources', 'xelay_assistant_save_seminar', 'xelay_save_teaching_grades_batch',
        'xelay_teaching_save_group_grading', 'xelay_teaching_mutate', 'xelay_assistant_set_material_ai'].includes(plan.rpc)) fail('unsupported_write_plan', 503)
      let args = plan.args
      if (plan.rpc === 'xelay_teaching_mutate' && (!['save_library_material', 'set_material_collaborators'].includes(args?.p_action) || !object(args?.p_payload))) fail('unsupported_write_plan', 503)
      if (plan.materialRights) {
        if (!options.acceptMaterialRights || plan.rpc !== 'xelay_teaching_mutate') fail('material_rights_acceptance_required', 422)
        args = { ...args, p_payload: { ...args!.p_payload, rights_accepted: true, rights_terms_version: '2026-10-27.1' } }
      }
      const result = await rpc(client, plan.rpc, args)
      if (plan.rpc === 'xelay_set_seminar_selection_deadline' && (result?.seminar_id !== plan.args?.p_seminar_id
        || result.selection_version !== plan.args?.p_expected_version + 1 || !instant(result.selection_deadline_at)
        || Date.parse(result.selection_deadline_at) !== Date.parse(plan.args?.p_deadline))) fail('save_response_unknown', 503)
      if (['xelay_teaching_classified_assignment', 'xelay_teaching_save_multi_assignment', 'xelay_teaching_save_group_grading', 'xelay_teaching_mutate'].includes(plan.rpc)
        && (result?.id !== plan.affectedIds[0] || !Number.isInteger(result.version))) fail('save_response_unknown', 503)
      if (['xelay_save_seminar_subject', 'xelay_save_seminar_schedule', 'xelay_save_seminar_with_resources'].includes(plan.rpc)) {
        const target = plan.rpc === 'xelay_save_seminar_subject' ? 'p_subject_id' : plan.rpc === 'xelay_save_seminar_schedule' ? 'p_schedule_id' : 'p_seminar_id'
        if (plan.args?.[target] === null) { if (typeof result !== 'string' || !UUID.test(result)) fail('save_response_unknown', 503); plan.affectedIds = [id(result)] }
        else if (result !== plan.affectedIds[0]) fail('save_response_unknown', 503)
      }
      if (plan.rpc === 'xelay_assistant_save_seminar') {
        const target = plan.args?.p_action === 'subject' ? 'p_subject_id' : plan.args?.p_action === 'schedule' ? 'p_schedule_id' : plan.args?.p_action === 'seminar' ? 'p_seminar_id' : fail('unsupported_write_plan', 503)
        if (plan.args?.p_values?.[target] === null) { if (typeof result !== 'string' || !UUID.test(result)) fail('save_response_unknown', 503); plan.affectedIds = [id(result)] }
        else if (result !== plan.affectedIds[0]) fail('save_response_unknown', 503)
      }
      if (plan.rpc.startsWith('xelay_copy_') && (!Number.isSafeInteger(result?.copied) || result.copied < 0 || typeof result.source_signature !== 'string')) fail('save_response_unknown', 503)
      if (plan.rpc === 'xelay_assistant_move_schedule' && result?.id !== plan.affectedIds[0]) fail('save_response_unknown', 503)
      if (plan.rpc === 'xelay_save_teaching_grades_batch' && (result?.id !== plan.args?.p_activity_id || result?.request_id !== plan.args?.p_request_id || result?.count !== plan.args?.p_rows?.length)) fail('save_response_unknown', 503)
      if (plan.rpc === 'xelay_assistant_set_material_ai' && (result?.id !== plan.affectedIds[0] || result?.allowAi !== plan.args?.p_allow || !/^[a-f0-9]{32}$/.test(result.rightsVersion))) fail('save_response_unknown', 503)
    } else {
      if (!['study_group_schedule', 'study_group_homework', 'organizer_tasks'].includes(plan.table ?? '') || !['insert', 'update'].includes(plan.operation ?? '')) fail('unsupported_write_plan', 503)
      let result: any
      if (options.atomicScheduleCreate && plan.table === 'study_group_schedule' && plan.operation === 'insert') {
        // Cloud workers must check occurrence overlap while holding the same
        // database transaction lock as the insert, never with a read/POST gap.
        result = await rpc(client, plan.values?.valid_from === plan.values?.valid_until ? 'xelay_assistant_create_schedule' : 'xelay_assistant_create_recurring_schedule', { p_values: plan.values })
      } else if (options.atomicScheduleCreate && plan.table === 'study_group_schedule' && plan.operation === 'update') {
        result = await rpc(client, 'xelay_assistant_update_schedule', { p_id: plan.where?.id, p_group_id: plan.where?.group_id, p_expected_updated_at: plan.where?.updated_at, p_values: plan.values })
      } else {
        let q = plan.operation === 'insert' ? client.from(plan.table!).insert(plan.values) : client.from(plan.table!).update(plan.values)
        for (const [key, value] of Object.entries(plan.where ?? {})) q = q.eq(key, value)
        result = apiResult(await q.select('id').single())
      }
      if (result?.id !== plan.affectedIds[0]) fail('save_response_unknown', 503)
    }
    if (plan.verification) {
      const verify = plan.verification, row = await one(client, verify.table, Object.keys({ id: null, ...verify.expected }).join(','), verify.where)
      for (const [key, expected] of Object.entries(verify.expected)) {
        const actual = row[key]
        const matches = ['starts_at', 'ends_at'].includes(key) ? String(actual).slice(0, 5) === expected
          : ['due_at', 'reminder_at'].includes(key) ? expected === null ? actual === null : instant(actual) && instant(expected) && Date.parse(actual) === Date.parse(expected)
            : fingerprint(actual) === fingerprint(expected)
        if (!matches) fail('save_response_unknown', 503)
      }
    }
    return true
  } catch { return false }
}
