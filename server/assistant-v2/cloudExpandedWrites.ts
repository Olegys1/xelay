import type { CallerWriteClient, ConfirmedWriteScope, InspectedWrite } from './confirmedWrites.ts'
import type { VerifiedAssistantSession } from './authenticatedRead.ts'
import { validateTeachingGradingRules } from '../../src/lib/teachingGrading.ts'
import { firstShiftSlotTime } from '../../src/lib/scheduleCopyTimes.ts'

type Row = Record<string, any>
/** Only this fixed set can dispatch an existing caller/RLS business command. */
export const EXPANDED_ASSISTANT_WRITE_ACTIONS = ['schedule.copy', 'schedule.move', 'seminar.prepare', 'seminar.subject.upsert', 'seminar.schedule.upsert', 'teaching.grades.save', 'teaching.grading.save', 'teaching.material.upsert', 'teaching.material.visibility', 'teaching.material.collaborators', 'teaching.material.ai'] as const
export type ExpandedAssistantWriteAction = typeof EXPANDED_ASSISTANT_WRITE_ACTIONS[number]
export interface ExpandedWriteContext {
  client: CallerWriteClient; session: VerifiedAssistantSession; scope: ConfirmedWriteScope; payload: Row; recordId: string;
  clock(): number; fail(code: string, status?: number): never;
  id(value: unknown): string; text(value: unknown, maximum: number, required?: boolean): string;
  inlineText(value: unknown, maximum: number, required?: boolean): string;
  date(value: unknown): value is string; instant(value: unknown): value is string; time(value: unknown): value is string;
  object(value: unknown): value is Row; exact(value: Row, keys: string[]): boolean;
  links(value: unknown): string[]; fingerprint(value: unknown): string;
  guardGroup(value: string | undefined): string;
  permissions(client: CallerWriteClient, groupId: string, right?: string): Promise<string[]>;
  rows(client: CallerWriteClient, table: string, columns: string, where: Row, limit?: number): Promise<Row[]>;
  one(client: CallerWriteClient, table: string, columns: string, where: Row): Promise<Row>;
  rpc(client: CallerWriteClient, name: string, args?: Row): Promise<any>;
  scheduleOnDay(client: CallerWriteClient, groupId: string, day: string): Promise<Row[]>;
}

function positiveVersion(v: unknown, allowZero = false) { return Number.isSafeInteger(v) && (v as number) >= (allowZero ? 0 : 1) && (v as number) <= 999999999 }
function uniqueIds(c: ExpandedWriteContext, value: unknown, maximum = 30): string[] {
  if (!Array.isArray(value) || value.length > maximum) c.fail('invalid_targets')
  const ids = value.map(c.id); if (new Set(ids).size !== ids.length) c.fail('invalid_targets')
  ids.forEach(c.guardGroup); return ids
}
async function courseContext(c: ExpandedWriteContext, right: string) {
  const groupId = c.guardGroup(c.scope.groupId), courseId = c.id(c.scope.courseId)
  const context = await c.rpc(c.client, 'xelay_teaching_group_context', { p_group_id: groupId })
  const course = context?.courses?.find((row: Row) => row.id === courseId)
  if (!course || course.archived_at || !course.permissions?.includes(right)) c.fail('permission_required', 403)
  return { groupId, courseId, course }
}
function boundedArray(c: ExpandedWriteContext, value: unknown, maximum: number): Row[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(v => !c.object(v))) c.fail('invalid_payload')
  return value
}
function storedFile(c: ExpandedWriteContext, value: Row, courseId: string, previous: Row[]) {
  if (!c.exact(value, ['storage_path', 'name', 'mime_type', 'size'])) c.fail('invalid_attachment')
  const storage_path = c.inlineText(value.storage_path, 512, true), name = c.inlineText(value.name, 240, true)
  const mime_type = c.inlineText(value.mime_type, 180, true)
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > 50 * 1024 * 1024
    || !storage_path.startsWith(`${courseId}/`) || /(?:\.\.|\\|[?#])/.test(storage_path)) c.fail('invalid_attachment')
  const original = previous.find(file => file.storage_path === storage_path)
  if (original && c.fingerprint(original) !== c.fingerprint(value)) c.fail('attachment_metadata_immutable', 409)
  if (!original && !storage_path.startsWith(`${courseId}/${c.session.userId}/`)) c.fail('attachment_owner_required', 403)
  // The existing publication RPC checks the real Storage object, ownership,
  // immutable metadata and the server content-verification receipt in the same
  // transaction. A plausible path alone never authorizes an attachment.
  return { storage_path, name, mime_type, size: value.size }
}

export async function inspectExpandedWrite(action: ExpandedAssistantWriteAction, c: ExpandedWriteContext): Promise<InspectedWrite> {
  const { payload: p, client, scope, recordId, session } = c
  const groupId = c.guardGroup(scope.groupId)
  let baseline: unknown, plan: InspectedWrite['plan']
  if (action === 'schedule.copy') {
    if (!c.exact(p, ['sourceDate', 'targetDate', 'timeMode', 'firstShiftStart', 'rememberFirstShiftStart', 'slotAssignments'])
      || !c.date(p.sourceDate) || !c.date(p.targetDate) || p.sourceDate === p.targetDate) c.fail('invalid_schedule_copy')
    if (![6, 7].includes(new Date(p.targetDate + 'T12:00:00Z').getUTCDay() || 7)) c.fail('copy_weekend_target_required')
    const rights = await c.permissions(client, groupId, 'schedule'), mode = p.timeMode ?? 'original'
    if (!['original', 'first_shift'].includes(mode) || p.rememberFirstShiftStart !== undefined && typeof p.rememberFirstShiftStart !== 'boolean') c.fail('invalid_schedule_copy')
    if (mode === 'original' && (p.firstShiftStart !== undefined || p.rememberFirstShiftStart || p.slotAssignments?.length)) c.fail('invalid_schedule_copy')
    if (mode === 'first_shift' && !c.time(p.firstShiftStart)) c.fail('invalid_first_shift_start')
    if (p.rememberFirstShiftStart && new Date(p.targetDate + 'T12:00:00Z').getUTCDay() !== 6) c.fail('remember_saturday_only')
    const assignments = boundedArray(c, p.slotAssignments ?? [], 12).map(row => {
      if (!c.exact(row, ['source_starts_at', 'source_ends_at', 'target_lesson_number', 'target_starts_at', 'target_ends_at'])
        || !c.time(row.source_starts_at) || !c.time(row.source_ends_at) || row.source_starts_at >= row.source_ends_at
        || !Number.isInteger(row.target_lesson_number) || row.target_lesson_number < 1 || row.target_lesson_number > 5
        || (row.target_starts_at !== undefined || row.target_ends_at !== undefined)
          && (!c.time(row.target_starts_at) || !c.time(row.target_ends_at) || row.target_starts_at >= row.target_ends_at)) c.fail('invalid_slot_assignments')
      return row
    })
    if (new Set(assignments.map(row => `${row.source_starts_at}/${row.source_ends_at}`)).size !== assignments.length
      || new Set(assignments.map(row => row.target_lesson_number)).size !== assignments.length) c.fail('invalid_slot_assignments')
    const name = mode === 'original' ? 'xelay_copy_study_group_schedule_day' : 'xelay_copy_study_group_schedule_day_with_custom_times'
    const args = { p_group_id: groupId, p_source_date: p.sourceDate, p_target_date: p.targetDate, p_preview: true, p_expected_signature: null,
      ...(mode === 'first_shift' ? { p_time_mode: mode, p_slot_assignments: assignments, p_first_shift_start: p.firstShiftStart, p_remember_first_shift_start: p.rememberFirstShiftStart ?? false } : {}) }
    const preview = await c.rpc(client, name, args)
    if (!c.object(preview) || typeof preview.source_signature !== 'string' || !preview.source_signature
      || !Number.isSafeInteger(preview.copied) || preview.copied < 0 || preview.copied > 168
      || !Array.isArray(preview.lessons) || preview.lessons.length > 168) c.fail('copy_preview_unavailable', 503)
    if (preview.copied === 0) c.fail('copy_has_no_new_lessons', 409)
    // The existing RPC signature pins source, destination and time settings.
    baseline = { rights, preview }
    plan = { rpc: name, args: { ...args, p_preview: false, p_expected_signature: preview.source_signature }, affectedIds: [groupId], path: `/groups/${groupId}?tab=schedule&date=${p.targetDate}` }
  } else if (action === 'schedule.move') {
    if (!c.exact(p, ['id', 'sourceDate', 'date', 'startsAt', 'endsAt']) || !c.date(p.sourceDate) || !c.date(p.date)
      || !c.time(p.startsAt) || !c.time(p.endsAt) || p.startsAt >= p.endsAt) c.fail('invalid_schedule_move')
    const rights = await c.permissions(client, groupId, 'schedule'), sourceId = c.id(p.id)
    const source = (await c.scheduleOnDay(client, groupId, p.sourceDate)).find(row => row.id === sourceId)
    if (!source || !c.instant(source.updated_at)) c.fail('target_unavailable', 409)
    const target = await c.scheduleOnDay(client, groupId, p.date)
    if (target.some(row => !(row.id === sourceId && p.date === p.sourceDate) && String(row.starts_at).slice(0, 5) < p.endsAt && String(row.ends_at).slice(0, 5) > p.startsAt)) c.fail('schedule_overlap', 409)
    const homework = await c.rows(client, 'study_group_homework', 'id,updated_at,schedule_item_id,lesson_date', { group_id: groupId, schedule_item_id: sourceId, lesson_date: p.sourceDate }, 2)
    baseline = { rights, source, target, homework }
    const targetId = p.sourceDate === p.date && source.valid_from === source.valid_until ? sourceId : recordId
    plan = { rpc: 'xelay_assistant_move_schedule', args: { p_group_id: groupId, p_schedule_id: sourceId, p_source_date: p.sourceDate, p_target_date: p.date,
      p_starts_at: p.startsAt, p_ends_at: p.endsAt, p_expected_updated_at: source.updated_at, p_new_id: targetId }, affectedIds: [targetId], path: `/groups/${groupId}?tab=schedule&date=${p.date}` }
  } else if (action === 'seminar.subject.upsert') {
    if (!c.exact(p, ['id', 'name'])) c.fail('invalid_payload')
    const rights = await c.permissions(client, groupId, 'seminars'), subjectId = p.id ? c.id(p.id) : recordId
    const previous = p.id ? await c.one(client, 'study_group_seminar_subjects', 'id,group_id,name,updated_at', { id: subjectId, group_id: groupId }) : null
    baseline = { rights, previous }
    plan = { rpc: 'xelay_save_seminar_subject', args: { p_group_id: groupId, p_subject_id: p.id ? subjectId : null, p_name: c.inlineText(p.name, 120, true) }, affectedIds: [subjectId], path: `/groups/${groupId}?tab=seminars` }
  } else if (action === 'seminar.schedule.upsert') {
    if (!c.exact(p, ['id', 'subjectId', 'weekday', 'startsAt', 'endsAt', 'validFrom', 'validUntil']) || !Number.isInteger(p.weekday) || p.weekday < 1 || p.weekday > 7
      || !c.time(p.startsAt) || !c.time(p.endsAt) || p.startsAt >= p.endsAt || !c.date(p.validFrom) || !c.date(p.validUntil) || p.validFrom > p.validUntil) c.fail('invalid_seminar_schedule')
    const rights = await c.permissions(client, groupId, 'seminars'), subjectId = c.id(p.subjectId), scheduleId = p.id ? c.id(p.id) : recordId
    const subject = await c.one(client, 'study_group_seminar_subjects', 'id,group_id,name', { id: subjectId, group_id: groupId })
    const previous = p.id ? await c.one(client, 'study_group_seminar_schedule', '*', { id: scheduleId, group_id: groupId }) : null
    baseline = { rights, subject, previous }
    plan = { rpc: 'xelay_save_seminar_schedule', args: { p_group_id: groupId, p_schedule_id: p.id ? scheduleId : null, p_subject_id: subjectId, p_weekday: p.weekday,
      p_starts_at: p.startsAt, p_ends_at: p.endsAt, p_valid_from: p.validFrom, p_valid_until: p.validUntil }, affectedIds: [scheduleId], path: `/groups/${groupId}?tab=seminars` }
  } else if (action === 'seminar.prepare') {
    if (!c.exact(p, ['id', 'scheduleId', 'date', 'title', 'instructions', 'format', 'questions', 'teams']) || !c.date(p.date)
      || !['questions', 'booking', 'teams'].includes(p.format)) c.fail('invalid_seminar')
    const rights = await c.permissions(client, groupId, 'seminars'), scheduleId = c.id(p.scheduleId), seminarId = p.id ? c.id(p.id) : recordId
    const schedule = await c.one(client, 'study_group_seminar_schedule', '*', { id: scheduleId, group_id: groupId })
    if (schedule.valid_from > p.date || schedule.valid_until < p.date || schedule.weekday !== (new Date(p.date + 'T12:00:00Z').getUTCDay() || 7)) c.fail('lesson_not_on_date', 409)
    const prior = await c.rows(client, 'study_group_seminars', '*', { group_id: groupId, schedule_id: scheduleId, lesson_date: p.date }, 2)
    const previous = prior[0] ?? null
    if (previous && previous.id !== seminarId || p.id && !previous) c.fail('seminar_conflict', 409)
    const questions = boundedArray(c, p.questions ?? [], 30).map(row => {
      if (!c.exact(row, ['id', 'body', 'primaryCapacity', 'supplementCapacity']) || !Number.isSafeInteger(row.primaryCapacity)
        || row.primaryCapacity < 1 || row.primaryCapacity > 30 || !Number.isSafeInteger(row.supplementCapacity) || row.supplementCapacity < 0 || row.supplementCapacity > 30) c.fail('invalid_questions')
      return { ...(row.id ? { id: c.id(row.id) } : {}), body: c.text(row.body, 2000, true), primary_capacity: row.primaryCapacity, supplement_capacity: row.supplementCapacity }
    })
    const teams = boundedArray(c, p.teams ?? [], 30).map(row => {
      if (!c.exact(row, ['id', 'name', 'capacity']) || !Number.isSafeInteger(row.capacity) || row.capacity < 1 || row.capacity > 50) c.fail('invalid_teams')
      return { ...(row.id ? { id: c.id(row.id) } : {}), name: c.inlineText(row.name, 80, true), capacity: row.capacity }
    })
    if (p.format === 'teams' ? questions.length || !teams.length : teams.length || !questions.length) c.fail('invalid_seminar_format')
    const retainedIds = [...questions, ...teams].flatMap(row => row.id ? [row.id] : [])
    if (new Set(retainedIds).size !== retainedIds.length) c.fail('invalid_seminar_targets')
    const oldQuestions = previous ? await c.rows(client, 'study_group_seminar_questions', '*', { seminar_id: seminarId }, 101) : []
    const oldTeams = previous ? await c.rows(client, 'study_group_seminar_teams', '*', { seminar_id: seminarId }, 101) : []
    if (questions.some(row => row.id && !oldQuestions.some(old => old.id === row.id)) || teams.some(row => row.id && !oldTeams.some(old => old.id === row.id))) c.fail('invalid_seminar_targets')
    if (previous && previous.selection_deadline_at && Date.parse(previous.selection_deadline_at) <= c.clock()) c.fail('seminar_reopen_required', 409)
    baseline = { rights, schedule, previous, oldQuestions, oldTeams }
    plan = { rpc: 'xelay_save_seminar_with_resources', args: { p_group_id: groupId, p_seminar_id: previous ? seminarId : null, p_schedule_id: scheduleId, p_lesson_date: p.date,
      p_title: c.inlineText(p.title, 160, true), p_instructions: c.text(p.instructions ?? '', 10000), p_format: p.format, p_questions: questions, p_teams: teams,
      p_resource_links: previous?.resource_links ?? [], p_resource_attachments: previous?.resource_attachments ?? [] }, affectedIds: [seminarId], path: `/groups/${groupId}?tab=seminars` }
  } else if (action === 'teaching.grades.save') {
    if (!c.exact(p, ['activityId', 'rows'])) c.fail('invalid_payload')
    const { courseId, course } = await courseContext(c, 'grades'), activityId = c.id(p.activityId)
    const snapshot = await c.rpc(client, 'xelay_teaching_course', { p_course_id: courseId })
    const activity = snapshot?.activities?.find((row: Row) => row.id === activityId && row.group_id === groupId)
    if (!activity || !Number.isFinite(activity.max_points)) c.fail('activity_unavailable', 409)
    const entries: Row[] = snapshot.entries ?? [], grades: Row[] = snapshot.grades ?? []
    const selectedEntries: Row[] = [], selectedGrades: Row[] = []
    const input = boundedArray(c, p.rows, 500); if (!input.length) c.fail('empty_grades')
    const values = input.flatMap(row => {
      if (!c.exact(row, ['entryId', 'score', 'comment', 'reason', 'version']) || !positiveVersion(row.version, true)
        || row.score !== null && (!Number.isFinite(row.score) || row.score < 0 || row.score > activity.max_points || Math.round(row.score * 100) / 100 !== row.score)) c.fail('invalid_grade')
      const entryId = c.id(row.entryId), entry = entries.find(item => item.id === entryId && item.course_id === courseId && item.group_id === groupId && item.active)
      if (!entry) c.fail('permission_required', 403)
      const previous = grades.find(item => item.activity_id === activityId && item.entry_id === entryId)
      if ((previous?.version ?? 0) !== row.version) c.fail('grade_conflict', 409)
      const comment = c.text(row.comment ?? '', 3000), reason = c.inlineText(row.reason ?? '', 3000)
      if (previous?.published_at && (previous.published_score !== row.score || previous.published_comment !== comment) && reason.length < 2) c.fail('grade_revision_reason_required')
      selectedEntries.push({ id: entry.id, active: entry.active, version: entry.version, full_name: entry.full_name }); selectedGrades.push(previous ?? null as any)
      if (row.score === (previous?.draft_score ?? previous?.published_score ?? null) && comment === (previous?.draft_comment ?? previous?.published_comment ?? '')) return []
      return [{ entry_id: entryId, score: row.score, comment, reason, version: row.version }]
    })
    if (!values.length) c.fail('grades_have_no_changes')
    if (new Set(values.map(row => row.entry_id)).size !== values.length) c.fail('duplicate_grade_entry')
    baseline = { course, activity, entries: selectedEntries, grades: selectedGrades }
    plan = { rpc: 'xelay_save_teaching_grades_batch', args: { p_request_id: recordId, p_course_id: courseId, p_group_id: groupId, p_activity_id: activityId,
      p_expected_user_id: session.userId, p_rows: values }, affectedIds: [activityId], path: '/teaching' }
  } else if (action === 'teaching.grading.save') {
    if (!c.exact(p, ['rules']) || p.rules !== null && !c.object(p.rules)) c.fail('invalid_grading_rules')
    if (p.rules !== null) { try { validateTeachingGradingRules(p.rules as any) } catch { c.fail('invalid_grading_rules') } }
    const { courseId, course } = await courseContext(c, 'manage')
    const link = await c.one(client, 'teaching_course_groups', 'id,course_id,group_id,status,grading_version,grading_rules_override', { course_id: courseId, group_id: groupId, status: 'accepted' })
    if (!positiveVersion(course.version) || !positiveVersion(link.grading_version, true)) c.fail('conflict_version_required', 409)
    baseline = { course, link }
    plan = { rpc: 'xelay_teaching_save_group_grading', args: { p_course_id: courseId, p_group_id: groupId, p_version: link.grading_version,
      p_course_version: course.version, p_rules: p.rules, p_expected_user_id: session.userId }, affectedIds: [link.id], path: '/teaching' }
  } else if (action === 'teaching.material.collaborators') {
    if (!c.exact(p, ['id', 'version', 'grants']) || !positiveVersion(p.version)) c.fail('invalid_payload')
    const materialId = c.id(p.id), courseId = c.id(scope.courseId), library = await c.rpc(client, 'xelay_teaching_material_library')
    const previous = library?.materials?.find((row: Row) => row.id === materialId && row.course_id === courseId)
    if (!previous || previous.created_by !== session.userId || previous.can_manage_collaborators !== true) c.fail('material_author_required', 403)
    if (previous.version !== p.version) c.fail('material_conflict', 409)
    const course = library?.courses?.find((row: Row) => row.course?.id === courseId)
    if (!course || course.course.archived_at || previous.withdrawn_at || !course.groups?.some((row: Row) => row.group_id === groupId && row.status === 'accepted' && row.permissions?.includes('materials'))) c.fail('permission_required', 403)
    const colleagues: Row[] = (course.colleagues ?? []).filter((row: Row) => row.user_id !== session.userId && row.status === 'accepted' && row.permissions?.includes('materials'))
    const oldGrants: Row[] = previous.collaborators ?? []
    const input = boundedArray(c, p.grants, 100), seen = new Set<string>()
    const grants = input.flatMap(row => {
      if (!c.exact(row, ['userId', 'canEdit', 'canDelete', 'canManageGroups']) || [row.canEdit, row.canDelete, row.canManageGroups].some(value => typeof value !== 'boolean')) c.fail('invalid_material_grant')
      const userId = c.id(row.userId)
      if (userId === session.userId || seen.has(userId)) c.fail('invalid_material_grant'); seen.add(userId)
      const colleague = colleagues.find(value => value.user_id === userId), existing = oldGrants.find(value => value.user_id === userId)
      if (!colleague && !existing || !colleague && (row.canEdit || row.canDelete || row.canManageGroups)) c.fail('permission_required', 403)
      return row.canEdit || row.canDelete || row.canManageGroups ? [{ user_id: userId, can_edit: row.canEdit, can_delete: row.canDelete, can_manage_groups: row.canManageGroups }] : []
    })
    baseline = { previous, course: course.course, colleagues }
    const descriptions: NonNullable<InspectedWrite['plan']['reviewItems']> = [{ id: 'authoritative-material', label: 'Матеріал', after: c.inlineText(previous.title, 240, true) }]
    for (const [index, grant] of grants.entries()) { const colleague = colleagues.find(row => row.user_id === grant.user_id)!; descriptions.push({ id: `material-grant-${index}`, label: c.inlineText(colleague.full_name, 240, true), after: `Редагування: ${grant.can_edit ? 'так' : 'ні'}; видалення: ${grant.can_delete ? 'так' : 'ні'}; вибір груп: ${grant.can_manage_groups ? 'так' : 'ні'}` }) }
    for (const [index, old] of oldGrants.filter(row => !grants.some(grant => grant.user_id === row.user_id)).entries()) descriptions.push({ id: `material-revoke-${index}`, label: c.inlineText(old.full_name ?? colleagues.find(row => row.user_id === old.user_id)?.full_name ?? 'Колега', 240, true), after: 'Відкликати всі окремі права на цей матеріал.' })
    if (descriptions.length === 1) descriptions.push({ id: 'material-no-grants', label: 'Доступ колег', after: 'Окремі права на цей матеріал нікому не видано.' })
    plan = { rpc: 'xelay_teaching_mutate', args: { p_action: 'set_material_collaborators', p_payload: { id: materialId, course_id: courseId, version: previous.version, expected_user_id: session.userId, grants } }, affectedIds: [materialId], path: '/teaching', reviewItems: descriptions }
  } else if (action === 'teaching.material.ai') {
    if (!c.exact(p, ['id', 'rightsVersion', 'allow', 'kind']) || typeof p.allow !== 'boolean' || !/^[a-f0-9]{32}$/.test(p.rightsVersion)
      || !['study', 'teaching'].includes(p.kind ?? 'teaching')) c.fail('invalid_material_ai')
    const materialId = c.id(p.id), kind = p.kind ?? 'teaching'
    const permission = await c.rpc(client, 'xelay_assistant_material_ai', { p_kind: kind, p_material_id: materialId })
    if (permission?.id !== materialId || permission.sourceKind !== kind || permission.canChange !== true) c.fail('material_author_required', 403)
    if (permission.rightsVersion !== p.rightsVersion) c.fail('material_conflict', 409)
    baseline = permission
    plan = { rpc: 'xelay_assistant_set_material_ai', args: { p_kind: kind, p_material_id: materialId, p_allow: p.allow, p_expected_version: p.rightsVersion }, affectedIds: [materialId], path: kind === 'teaching' ? '/teaching' : `/groups/${groupId}?tab=materials` }
  } else {
    const visibilityOnly = action === 'teaching.material.visibility'
    if (!c.exact(p, visibilityOnly ? ['id', 'version', 'groupIds'] : ['id', 'version', 'title', 'body', 'groupIds', 'links', 'attachments', 'status', 'publishAt', 'accessUntil', 'allowDownload', 'materialDate'])) c.fail('invalid_payload')
    const courseId = c.id(scope.courseId), library = await c.rpc(client, 'xelay_teaching_material_library')
    const previous = p.id ? library?.materials?.find((row: Row) => row.id === c.id(p.id) && row.course_id === courseId) : null
    if (p.id && !previous) c.fail('target_unavailable', 409)
    if (previous && (!positiveVersion(p.version) || previous.version !== p.version) || !previous && p.version != null && p.version !== 0) c.fail('material_conflict', 409)
    if (previous?.withdrawn_at || previous?.course_archived_at) c.fail('material_unavailable', 409)
    const allowedCourse = library?.courses?.find((row: Row) => row.course?.id === courseId)
    if (!allowedCourse || allowedCourse.course.archived_at) c.fail('permission_required', 403)
    const allowedGroups: Row[] = allowedCourse.groups?.filter((row: Row) => row.status === 'accepted' && row.permissions?.includes('materials')) ?? []
    if (!allowedGroups.some(row => row.group_id === groupId)) c.fail('permission_required', 403)
    const groups = p.groupIds === undefined ? undefined : uniqueIds(c, p.groupIds, 30)
    if (groups?.some(g => !allowedGroups.some(row => row.group_id === g))) c.fail('permission_required', 403)
    if (previous && groups !== undefined && previous.can_manage_groups !== true) c.fail('material_group_permission_required', 403)
    const metadata = !visibilityOnly && Object.keys(p).some(key => !['id', 'version', 'groupIds'].includes(key))
    if (!previous && (!metadata || groups === undefined) || visibilityOnly && (!previous || groups === undefined) || !metadata && groups === undefined) c.fail('invalid_material')
    if (metadata && previous && previous.can_edit !== true) c.fail('material_edit_permission_required', 403)
    const data: Row = { id: previous?.id ?? recordId, course_id: courseId, version: previous?.version ?? 0, expected_user_id: session.userId,
      ...(groups !== undefined ? { target_group_ids: groups } : {}) }
    if (metadata) {
      if (p.title !== undefined || !previous) data.title = c.inlineText(p.title, 240, true)
      if (p.body !== undefined || !previous) data.body = c.text(p.body ?? '', 50000)
      if (p.links !== undefined || !previous) { data.links = c.links(p.links); data.link_labels = Object.fromEntries(Object.entries(previous?.link_labels ?? {}).filter(([url]) => data.links.includes(url))) }
      if (p.attachments !== undefined || !previous) data.attachments = boundedArray(c, p.attachments ?? [], 20).map(file => storedFile(c, file, courseId, previous?.attachments ?? []))
      if (data.attachments && new Set(data.attachments.map((file: Row) => file.storage_path)).size !== data.attachments.length) c.fail('duplicate_attachment')
      const status = p.status ?? previous?.status ?? 'draft'
      if (!['draft', 'scheduled', 'published'].includes(status)) c.fail('invalid_material_status')
      data.status = status
      if (status === 'scheduled') { if (!c.instant(p.publishAt ?? previous?.publish_at) || Date.parse(p.publishAt ?? previous.publish_at) <= c.clock()) c.fail('invalid_publication_time'); data.publish_at = p.publishAt ?? previous.publish_at }
      else if (p.publishAt != null) c.fail('invalid_publication_time')
      if (p.accessUntil !== undefined) { if (p.accessUntil !== null && (!c.instant(p.accessUntil) || Date.parse(p.accessUntil) <= c.clock() || data.publish_at && Date.parse(p.accessUntil) <= Date.parse(data.publish_at))) c.fail('invalid_material_expiry'); data.access_until = p.accessUntil }
      if (p.materialDate !== undefined) { if (p.materialDate !== null && !c.date(p.materialDate)) c.fail('invalid_date'); data.material_date = p.materialDate }
      if (p.allowDownload !== undefined) { if (typeof p.allowDownload !== 'boolean') c.fail('invalid_payload'); data.allow_download = p.allowDownload }
      if ((data.allow_download ?? previous?.allow_download ?? true) === false) {
        const urls = data.links ?? previous?.links ?? [], files: Row[] = data.attachments ?? previous?.attachments ?? []
        if (urls.length || files.some(file => !['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv'].includes(file.mime_type))) c.fail('material_preview_format_required')
      }
    }
    baseline = { course: allowedCourse.course, groups: allowedGroups.map(row => ({ id: row.id, group_id: row.group_id, group_name: row.group_name, permissions: row.permissions, status: row.status })), previous }
    plan = { rpc: 'xelay_teaching_mutate', args: { p_action: 'save_library_material', p_payload: data }, materialRights: metadata && data.status !== 'draft', affectedIds: [data.id], path: '/teaching' }
  }
  const human: NonNullable<typeof plan.reviewItems> = []
  if (action === 'schedule.move') human.push({ id: 'moving-lesson', label: 'Пара', after: c.text((baseline as Row).source.subject, 120, true) })
  if (action === 'schedule.copy') human.push({ id: 'copied-lessons', label: 'Буде скопійовано', after: (baseline as Row).preview.lessons.map((row: Row) => `${row.subject} · ${String(row.starts_at).slice(0, 5)}–${String(row.ends_at).slice(0, 5)}`).join('\n') })
  if (action === 'seminar.subject.upsert') human.push({ id: 'seminar-subject', label: 'Предмет семінарів', ...((baseline as Row).previous ? { before: (baseline as Row).previous.name } : {}), after: plan.args!.p_name })
  if (action === 'seminar.schedule.upsert') human.push({ id: 'seminar-subject', label: 'Предмет семінарів', after: (baseline as Row).subject.name })
  if (action === 'seminar.prepare') human.push({ id: 'seminar-items', label: p.format === 'teams' ? 'Команди' : 'Питання', after: (p.format === 'teams' ? plan.args!.p_teams : plan.args!.p_questions).map((row: Row, index: number) => `${index + 1}. ${row.name ?? row.body} (${row.capacity ?? row.primary_capacity} місць${row.supplement_capacity ? `; доповнювачів ${row.supplement_capacity}` : ''})`).join('\n') })
  if (action === 'teaching.grades.save') {
    const before = baseline as Row
    human.push({ id: 'activity', label: 'Робота', after: `${before.activity.title} · до ${before.activity.max_points} балів` })
    for (const [index, row] of plan.args!.p_rows.entries()) { const entry = before.entries.find((value: Row) => value.id === row.entry_id), old = before.grades.find((grade: Row | null) => grade?.entry_id === row.entry_id); human.push({ id: `manual-grade-${index}`, label: entry.full_name, before: String(old?.draft_score ?? old?.published_score ?? 'Не оцінено'), after: `${row.score ?? 'Без оцінки'}${row.comment ? ` · ${row.comment}` : ''}${row.reason ? ` · Причина: ${row.reason}` : ''}` }) }
    human.push({ id: 'grade-state', label: 'Видимість', after: 'Чернетки балів. Публікація студентам виконується окремо в журналі.' })
  }
  if (action === 'teaching.grading.save') human.push({ id: 'grading-rules', label: 'Коефіцієнти та максимуми', after: p.rules === null ? 'Використовувати загальні правила предмета' : `${p.rules.categories.map((row: Row) => `${row.name}: коефіцієнт ${row.coefficient ?? 1}, максимум ${row.max_points}`).join('\n')}\nЗагальний максимум: ${p.rules.total_max ?? 'Не встановлено'}` })
  if (['teaching.material.upsert', 'teaching.material.visibility'].includes(action)) {
    const current = baseline as Row
    human.push({ id: 'authoritative-material', label: current.previous ? 'Матеріал для оновлення' : 'Новий матеріал', after: c.inlineText(current.previous?.title ?? p.title, 240, true) })
    if (p.groupIds !== undefined) human.push({ id: 'material-groups', label: 'Показувати групам', after: p.groupIds.length ? p.groupIds.map((group: string) => current.groups.find((row: Row) => row.group_id === group)?.group_name ?? 'Підключена група').join(', ') : 'Прибрати з доступних груп; приховані для вас групи залишаються без змін' })
    if (p.attachments !== undefined) human.push({ id: 'material-files', label: 'Файли після оновлення', after: p.attachments.length ? p.attachments.map((file: Row) => `${file.name} · ${file.size} байт`).join('\n') : 'Файли не прикріплено' })
  }
  if (action === 'teaching.material.ai') human.push({ id: 'authoritative-material', label: 'Матеріал', after: c.inlineText((baseline as Row).title ?? 'Матеріал викладача', 240, true) }, { id: 'material-ai-scope', label: 'Дозвіл', after: p.allow ? 'Дозволити ШІ пояснювати поточну версію цього матеріалу. Після зміни вмісту чи файлів потрібна нова згода автора.' : 'Заборонити передавання вмісту цього матеріалу ШІ.' })
  if (human.length) plan.reviewItems = human
  if (['seminar.prepare', 'seminar.subject.upsert', 'seminar.schedule.upsert'].includes(action)) {
    const previous = (baseline as Row).previous
    if (previous && !c.instant(previous.updated_at)) c.fail('conflict_version_required', 409)
    plan = { ...plan, rpc: 'xelay_assistant_save_seminar', args: { p_action: action === 'seminar.prepare' ? 'seminar' : action === 'seminar.subject.upsert' ? 'subject' : 'schedule', p_expected_updated_at: previous?.updated_at ?? null, p_values: plan.args } }
  }
  return { fingerprint: c.fingerprint(baseline), plan }
}

export interface AssistantWriteFormField { key: string; label: string; type: string; required?: boolean; options?: { value: string; label: string }[]; lessonOptions?: { value: string; label: string; groupId: string; date: string }[] }
export interface AssistantWriteForm { action: string; title: string; scope: ConfirmedWriteScope; payload: Row; fields: AssistantWriteFormField[] }

/** Form data is sent directly to the authenticated UI, never to the planner.
 * Options are re-read under the caller JWT and are still revalidated at save. */
export async function expandedWriteForm(action: string, c: ExpandedWriteContext): Promise<AssistantWriteForm> {
  const { client, scope, payload: input } = c, groupId = action === 'organizer.task.create' && !scope.groupId ? '' : c.guardGroup(scope.groupId)
  const payload = structuredClone(input), fields: AssistantWriteFormField[] = []
  const field = (key: string, label: string, type = 'text', required = false, options?: { value: string; label: string }[]) => fields.push({ key, label, type, ...(required ? { required } : {}), ...(options ? { options } : {}) })
  const choices = (rows: Row[], label: (row: Row) => string, key = 'id') => rows.map(row => ({ value: c.id(row[key]), label: c.inlineText(label(row), 240, true) }))
  let title = 'Перевірте поля'
  if (action.startsWith('schedule.') || action === 'homework.upsert') {
    await c.permissions(client, groupId, action === 'homework.upsert' ? 'homework' : 'schedule')
    const day = action === 'schedule.move' && c.date(payload.sourceDate) ? payload.sourceDate : c.date(payload.date) ? payload.date : c.date(scope.date) ? scope.date : null
    const lessons = day ? await c.scheduleOnDay(client, groupId, day) : []
    const opts = choices(lessons, row => `${row.subject} · ${String(row.starts_at).slice(0, 5)}–${String(row.ends_at).slice(0, 5)}`)
    if (['schedule.update', 'schedule.move'].includes(action) && payload.id) {
      const previous = lessons.find(row => row.id === payload.id); if (!previous) c.fail('target_unavailable', 409)
      for (const [key, db] of Object.entries({ subject: 'subject', startsAt: 'starts_at', endsAt: 'ends_at', lessonType: 'lesson_type', teacherName: 'teacher_name', location: 'location', conferenceId: 'conference_id', accessCode: 'conference_access_code' })) {
        if (action === 'schedule.move' && !['startsAt', 'endsAt'].includes(key)) continue
        payload[key] ??= ['startsAt', 'endsAt'].includes(key) ? String(previous[db]).slice(0, 5) : previous[db] ?? ''
      }
      if (action === 'schedule.update') { payload.recurring ??= false; payload.validFrom ??= previous.valid_from; payload.validUntil ??= previous.valid_until; payload.weekday ??= previous.weekday; payload.weekPattern ??= previous.week_pattern ?? 'every'; if (previous.week_anchor_date) payload.weekAnchorDate ??= previous.week_anchor_date }
    }
    if (action === 'homework.upsert') {
      title = 'Домашнє завдання'; field('date', 'Дата пари', 'date', true); field('lessonId', 'Пара', 'select', true, opts)
      field('topic', 'Тема'); field('body', 'Повний текст', 'textarea'); field('dueAt', 'Термін виконання (необов’язково)', 'datetime-local')
    } else if (action === 'schedule.copy') {
      title = 'Копіювання розкладу'; field('sourceDate', 'З якої дати', 'date', true); field('targetDate', 'На суботу або неділю', 'date', true)
      field('timeMode', 'Час', 'select', true, [{ value: 'original', label: 'Залишити час' }, { value: 'first_shift', label: 'Перша зміна' }]); payload.timeMode ??= 'original'
      field('firstShiftStart', 'Початок першої пари', 'time'); field('rememberFirstShiftStart', 'Запам’ятати для субот', 'checkbox'); field('slotAssignments', 'Час окремих пар', 'copy-slots')
      if (payload.timeMode === 'first_shift' && c.date(payload.sourceDate) && c.time(payload.firstShiftStart)) {
        const source = await c.scheduleOnDay(client, groupId, payload.sourceDate), slots = [...new Set(source.map(row => `${String(row.starts_at).slice(0, 5)}/${String(row.ends_at).slice(0, 5)}`))].sort()
        if (slots.length > 5) c.fail('copy_first_shift_too_many_slots', 422)
        const old = Array.isArray(payload.slotAssignments) ? payload.slotAssignments : []
        payload.slotAssignments = slots.map((key, index) => { const [start, end] = key.split('/'), previous = old.find((row: Row) => row.source_starts_at === start && row.source_ends_at === end)
          let target: ReturnType<typeof firstShiftSlotTime>; try { target = firstShiftSlotTime(payload.firstShiftStart, index + 1) } catch { return c.fail('invalid_first_shift_start') }
          return previous ?? { source_starts_at: start, source_ends_at: end, target_lesson_number: index + 1, target_starts_at: target.starts_at, target_ends_at: target.ends_at }
        })
      }
    } else if (action === 'schedule.move') {
      title = 'Перенесення пари'; field('sourceDate', 'Поточна дата', 'date', true); field('id', 'Пара', 'select', true, opts)
      field('date', 'Нова дата', 'date', true); field('startsAt', 'Початок', 'time', true); field('endsAt', 'Кінець', 'time', true)
    } else {
      title = 'Пара в розкладі'; if (action === 'schedule.update') field('id', 'Пара', 'select', true, opts)
      field('date', 'Дата', 'date', true); field('subject', 'Предмет', 'text', true); field('startsAt', 'Початок', 'time', true); field('endsAt', 'Кінець', 'time', true)
      field('lessonType', 'Тип заняття', 'select', true, Object.entries({ lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне', lab: 'Лабораторна', makeup: 'Відпрацювання', replacement: 'Заміна', module: 'Модуль', final_assessment: 'Підсумкова робота', test: 'Контрольна робота', other: 'Заняття' }).map(([value, label]) => ({ value, label })))
      field('teacherName', 'Викладач'); field('location', 'Аудиторія'); field('links', 'Посилання', 'json'); field('conferenceId', 'Ідентифікатор конференції'); field('accessCode', 'Код доступу')
      payload.lessonType ??= 'other'
      field('recurring', 'Повторювати заняття (для редагування зміниться вся серія)', 'checkbox'); field('validFrom', 'Повторювати з', 'date'); field('validUntil', 'Повторювати до', 'date'); field('weekday', 'День тижня (1–7)', 'number')
      field('weekPattern', 'Чергування', 'select', false, [{ value: 'every', label: 'Щотижня' }, { value: 'upper', label: 'Верхній тиждень' }, { value: 'lower', label: 'Нижній тиждень' }]); field('weekAnchorDate', 'Понеділок верхнього тижня', 'date')
    }
    if (day) payload.date ??= day
  } else if (action.startsWith('seminar.')) {
    if (['seminar.prepare', 'seminar.subject.upsert', 'seminar.schedule.upsert', 'seminar.reopen'].includes(action)) await c.permissions(client, groupId, 'seminars')
    else {
      const group = await c.one(client, 'study_groups', 'id,representative_id', { id: groupId })
      const members = await c.rows(client, 'study_group_members', 'id', { group_id: groupId, user_id: c.session.userId, status: 'accepted' }, 2)
      if (group.representative_id !== c.session.userId && !members.length) c.fail('membership_required', 403)
    }
    const seminars = await c.rows(client, 'study_group_seminars', '*', { group_id: groupId }, 101)
    title = 'Семінар'
    if (action === 'seminar.subject.upsert') {
      const subjects = await c.rows(client, 'study_group_seminar_subjects', 'id,name', { group_id: groupId }, 101)
      field('id', 'Предмет для оновлення (або створіть новий)', 'select', false, choices(subjects, row => row.name))
      if (payload.id) { const previous = subjects.find(row => row.id === payload.id); if (!previous) c.fail('target_unavailable', 409); payload.name ??= previous.name }
      field('name', 'Назва предмета', 'text', true)
    }
    else if (action === 'seminar.schedule.upsert') {
      const schedules = await c.rows(client, 'study_group_seminar_schedule', '*', { group_id: groupId }, 101)
      const subjects = await c.rows(client, 'study_group_seminar_subjects', 'id,name', { group_id: groupId }, 101)
      field('id', 'Заняття для оновлення (або створіть нове)', 'select', false, choices(schedules, row => `${subjects.find(subject => subject.id === row.subject_id)?.name ?? 'Семінар'} · день ${row.weekday} · ${String(row.starts_at).slice(0, 5)}`))
      if (payload.id) { const previous = schedules.find(row => row.id === payload.id); if (!previous) c.fail('target_unavailable', 409); for (const [key, db] of Object.entries({ subjectId: 'subject_id', weekday: 'weekday', startsAt: 'starts_at', endsAt: 'ends_at', validFrom: 'valid_from', validUntil: 'valid_until' })) payload[key] ??= ['startsAt', 'endsAt'].includes(key) ? String(previous[db]).slice(0, 5) : previous[db] }
      field('subjectId', 'Предмет', 'select', true, choices(subjects, row => row.name)); field('weekday', 'День тижня (1–7)', 'number', true)
      field('startsAt', 'Початок', 'time', true); field('endsAt', 'Кінець', 'time', true); field('validFrom', 'З дати', 'date', true); field('validUntil', 'До дати', 'date', true)
    } else if (action === 'seminar.prepare') {
      field('id', 'Семінар для оновлення (або створіть новий)', 'select', false, choices(seminars, row => `${row.title} · ${row.lesson_date}`))
      if (payload.id) {
        const previous = seminars.find(row => row.id === payload.id); if (!previous) c.fail('target_unavailable', 409)
        for (const [key, db] of Object.entries({ scheduleId: 'schedule_id', date: 'lesson_date', title: 'title', instructions: 'instructions', format: 'format' })) payload[key] ??= previous[db]
        payload.questions ??= (await c.rows(client, 'study_group_seminar_questions', '*', { seminar_id: previous.id }, 101)).map(row => ({ id: row.id, body: row.body, primaryCapacity: row.primary_capacity, supplementCapacity: row.supplement_capacity ?? 0 }))
        payload.teams ??= (await c.rows(client, 'study_group_seminar_teams', '*', { seminar_id: previous.id }, 101)).map(row => ({ id: row.id, name: row.name, capacity: row.capacity }))
      }
      const schedules = await c.rows(client, 'study_group_seminar_schedule', '*', { group_id: groupId }, 101)
      const subjects = await c.rows(client, 'study_group_seminar_subjects', 'id,name', { group_id: groupId }, 101)
      field('scheduleId', 'Заняття семінару', 'select', true, choices(schedules, row => `${subjects.find(subject => subject.id === row.subject_id)?.name ?? 'Семінар'} · день ${row.weekday} · ${String(row.starts_at).slice(0, 5)}`))
      field('date', 'Дата', 'date', true); field('title', 'Тема', 'text', true); field('instructions', 'Умови та підготовка', 'textarea')
      field('format', 'Формат', 'select', true, [{ value: 'questions', label: 'Доповідачі та доповнювачі' }, { value: 'booking', label: 'Бронювання' }, { value: 'teams', label: 'Команди' }]); payload.format ??= 'questions'
      field('questions', 'Питання та кількість місць', 'json'); field('teams', 'Команди та кількість місць', 'json')
    } else {
      const selectable = seminars.filter(row => action === 'seminar.team.join' ? row.format === 'teams' : action === 'seminar.book' ? row.format !== 'teams' : true)
      field('id', 'Семінар', 'select', true, choices(selectable, row => `${row.title} · ${row.lesson_date} · ${String(row.starts_at).slice(0, 5)}`))
      if (action === 'seminar.reopen') field('closesAt', 'Відкрити запис до', 'datetime-local', true)
      else if (payload.id) {
        const seminarId = c.id(payload.id); if (!seminars.some(row => row.id === seminarId)) c.fail('target_unavailable', 409)
        const team = action === 'seminar.team.join'
        const options = await c.rows(client, team ? 'study_group_seminar_teams' : 'study_group_seminar_questions', '*', { seminar_id: seminarId }, 101)
        field(team ? 'teamId' : 'questionId', team ? 'Команда' : 'Питання', 'select', true, choices(options, row => team ? row.name : row.body))
        if (!team) field('role', 'Роль', 'select', true, seminars.find(row => row.id === seminarId)?.format === 'booking' ? [{ value: 'booking', label: 'Бронювання' }] : [{ value: 'primary', label: 'Доповідач' }, { value: 'supplement', label: 'Доповнювач' }])
      }
    }
  } else if (action === 'teaching.material.collaborators') {
    title = 'Окремі права колег на матеріал'
    const courseId = c.id(scope.courseId), library = await c.rpc(client, 'xelay_teaching_material_library'), course = library?.courses?.find((row: Row) => row.course?.id === courseId && !row.course.archived_at)
    if (!course?.groups?.some((row: Row) => row.group_id === groupId && row.status === 'accepted' && row.permissions?.includes('materials'))) c.fail('permission_required', 403)
    const owned: Row[] = (library.materials ?? []).filter((row: Row) => row.course_id === courseId && row.created_by === c.session.userId && row.can_manage_collaborators === true && !row.withdrawn_at)
    field('id', 'Ваш матеріал', 'select', true, choices(owned, row => row.title))
    if (payload.id) {
      const previous = owned.find(row => row.id === payload.id); if (!previous) c.fail('material_author_required', 403)
      const colleagues: Row[] = (course.colleagues ?? []).filter((row: Row) => row.user_id !== c.session.userId && row.status === 'accepted' && row.permissions?.includes('materials'))
      payload.version = previous.version
      payload.grants ??= (previous.collaborators ?? []).filter((row: Row) => colleagues.some(colleague => colleague.user_id === row.user_id)).map((row: Row) => ({ userId: row.user_id, canEdit: row.can_edit, canDelete: row.can_delete, canManageGroups: row.can_manage_groups }))
      field('grants', 'Права колег (авторство залишається за вами)', 'material-grants', false, choices(colleagues, row => row.full_name, 'user_id'))
    }
  } else if (action === 'teaching.material.ai') {
    title = 'Дозвіл автора на пояснення матеріалу'
    const kind = payload.kind ?? 'teaching'; if (!['study', 'teaching'].includes(kind)) c.fail('invalid_material_ai')
    let materials: Row[]
    if (kind === 'teaching') {
      const courseId = c.id(scope.courseId), library = await c.rpc(client, 'xelay_teaching_material_library'), course = library?.courses?.find((row: Row) => row.course?.id === courseId && !row.course.archived_at)
      if (!course?.groups?.some((row: Row) => row.group_id === groupId && row.status === 'accepted' && row.permissions?.includes('materials'))) c.fail('permission_required', 403)
      materials = (library.materials ?? []).filter((row: Row) => row.course_id === courseId && row.created_by === c.session.userId && !row.withdrawn_at)
    } else materials = await c.rows(client, 'study_group_materials', 'id,title,created_by', { group_id: groupId, created_by: c.session.userId }, 101)
    field('id', 'Ваш матеріал', 'select', true, choices(materials, row => row.title)); payload.kind = kind
    if (payload.id) {
      if (!materials.some(row => row.id === payload.id)) c.fail('material_author_required', 403)
      const permission = await c.rpc(client, 'xelay_assistant_material_ai', { p_kind: kind, p_material_id: c.id(payload.id) })
      if (permission?.canChange !== true) c.fail('material_author_required', 403)
      payload.rightsVersion = permission.rightsVersion; payload.allow ??= permission.allowAi
      field('allow', 'Дозволити ШІ пояснювати цей матеріал студентам', 'checkbox')
    }
  } else if (action.startsWith('teaching.material.')) {
    title = 'Матеріал викладача'
    const courseId = c.id(scope.courseId), library = await c.rpc(client, 'xelay_teaching_material_library'), course = library?.courses?.find((row: Row) => row.course?.id === courseId && !row.course.archived_at)
    const groups = course?.groups?.filter((row: Row) => row.status === 'accepted' && row.permissions?.includes('materials')) ?? []
    if (!groups.some((row: Row) => row.group_id === groupId)) c.fail('permission_required', 403)
    const materials = (library?.materials ?? []).filter((row: Row) => row.course_id === courseId && !row.withdrawn_at && (action === 'teaching.material.visibility' ? row.can_manage_groups : row.can_edit))
    field('id', 'Збережений матеріал (для оновлення)', 'select', action === 'teaching.material.visibility', choices(materials, row => row.title))
    const previous = payload.id ? materials.find((row: Row) => row.id === payload.id) : null
    if (payload.id && !previous) c.fail('permission_required', 403)
    if (previous) { payload.version = previous.version; if (previous.can_manage_groups) payload.groupIds ??= (previous.targets ?? []).map((row: Row) => row.group_id).filter((id: string) => groups.some((group: Row) => group.group_id === id)) }
    if (!previous || previous.can_manage_groups) field('groupIds', 'Показувати групам', 'multiselect', true, choices(groups, row => row.group_name, 'group_id'))
    if (action !== 'teaching.material.visibility') {
      if (previous) for (const [key, db] of Object.entries({ title: 'title', body: 'body', links: 'links', attachments: 'attachments', status: 'status', publishAt: 'publish_at', accessUntil: 'access_until', allowDownload: 'allow_download', materialDate: 'material_date' })) payload[key] ??= previous[db]
      else { payload.status ??= 'draft'; payload.allowDownload ??= true; payload.groupIds ??= [groupId] }
      field('title', 'Назва', 'text', true); field('body', 'Текст', 'textarea'); field('links', 'Посилання', 'json'); field('attachments', 'Файли', 'files')
      field('status', 'Публікація', 'select', true, [{ value: 'draft', label: 'Чернетка' }, { value: 'published', label: 'Опублікувати' }, { value: 'scheduled', label: 'Запланувати' }])
      field('publishAt', 'Коли опублікувати', 'datetime-local'); field('accessUntil', 'Доступ до', 'datetime-local'); field('allowDownload', 'Дозволити завантаження', 'checkbox')
    }
  } else if (['teaching.grades.save', 'teaching.grading.save'].includes(action)) {
    const { courseId, course } = await courseContext(c, action === 'teaching.grades.save' ? 'grades' : 'manage')
    if (action === 'teaching.grading.save') {
      const link = await c.one(client, 'teaching_course_groups', '*', { course_id: courseId, group_id: groupId, status: 'accepted' })
      title = 'Коефіцієнти та правила балів'; payload.rules ??= link.grading_rules_override ?? course.grading_rules; field('rules', 'Правила оцінювання', 'json', true)
    } else {
      title = 'Внести вказані вами бали'; const snapshot = await c.rpc(client, 'xelay_teaching_course', { p_course_id: courseId })
      const activities = (snapshot.activities ?? []).filter((row: Row) => row.group_id === groupId)
      field('activityId', 'Робота', 'select', true, choices(activities, row => `${row.title} · ${row.activity_date} · до ${row.max_points} балів`))
      if (payload.activityId) {
        if (!activities.some((row: Row) => row.id === payload.activityId)) c.fail('activity_unavailable', 409)
        const entries = (snapshot.entries ?? []).filter((row: Row) => row.group_id === groupId && row.active)
        if (entries.length > 500) c.fail('grade_form_group_too_large', 422)
        payload.rows ??= entries.map((entry: Row) => { const grade = snapshot.grades?.find((row: Row) => row.activity_id === payload.activityId && row.entry_id === entry.id); return { entryId: entry.id, score: grade?.draft_score ?? grade?.published_score ?? null, comment: grade?.draft_comment ?? grade?.published_comment ?? '', reason: '', version: grade?.version ?? 0 } })
        field('rows', 'Бали та коментарі (без автоматичного оцінювання)', 'grade-rows', true, choices(entries, row => row.full_name))
      }
    }
  } else if (['teaching.assignment.upsert', 'teaching.publication.schedule'].includes(action)) {
    title = 'Завдання викладача'; const { courseId } = await courseContext(c, 'assignments')
    const snapshot = await c.rpc(client, 'xelay_teaching_course', { p_course_id: courseId })
    const groups: Row[] = (snapshot.groups ?? []).filter((row: Row) => row.status === 'accepted' && row.permissions?.includes('assignments'))
    field('title', 'Назва', 'text', true); field('body', 'Повний текст', 'textarea'); field('groupIds', 'Групи', 'multiselect', true, choices(groups, row => row.group_name, 'group_id')); field('targets', 'Дата і пара для кожної групи', 'assignment-targets', true, choices(groups, row => row.group_name, 'group_id'))
    payload.groupIds ??= [groupId]
    if (c.date(scope.date)) payload.targets ??= payload.groupIds.map((targetGroup: string) => ({ groupId: targetGroup, lessonDate: scope.date, placementMode: 'unplaced', lessonId: null, dueAt: null, closesAt: null }))
    if (Array.isArray(payload.targets) && payload.targets.length <= 30) {
      const lessonOptions: NonNullable<AssistantWriteFormField['lessonOptions']> = []
      for (const target of payload.targets) {
        if (!c.object(target) || !c.date(target.lessonDate) || !groups.some(row => row.group_id === target.groupId)) continue
        const current = await c.rpc(client, 'xelay_teaching_assignment_lessons', { p_course_id: courseId, p_group_id: target.groupId, p_lesson_date: target.lessonDate })
        if (!Array.isArray(current?.lessons) || current.lessons.length > 50) c.fail('bounded_read_required', 503)
        lessonOptions.push(...current.lessons.filter((row: Row) => row.group_id === target.groupId).map((row: Row) => ({ value: c.id(row.id), label: c.inlineText(`${groups.find(group => group.group_id === target.groupId)!.group_name} · ${String(row.starts_at).slice(0, 5)} · ${row.subject}`, 240, true), groupId: target.groupId, date: target.lessonDate })))
      }
      fields.find(row => row.key === 'targets')!.lessonOptions = lessonOptions
    }
    field('dueAt', 'Термін здачі (можна залишити вільним)', 'datetime-local'); field('submissionFormat', 'Формат здачі', 'select', true, [{ value: 'written', label: 'Письмово' }, { value: 'oral', label: 'Усно' }, { value: 'defense', label: 'Захист' }]); payload.submissionFormat ??= 'written'
    field('workType', 'Вид роботи'); field('maxPoints', 'Максимум балів (необов’язково)', 'number'); field('category', 'Категорія журналу'); field('links', 'Посилання', 'json'); if (action === 'teaching.publication.schedule') field('publishAt', 'Час публікації', 'datetime-local', true)
  } else if (action === 'organizer.task.create') {
    if (await c.rpc(client, 'xelay_has_participant_access', { p_user_id: c.session.userId }) !== true) c.fail('participant_required', 403)
    title = 'Особисте завдання'; field('title', 'Назва', 'text', true); field('notes', 'Нотатки', 'textarea'); field('subject', 'Предмет'); field('dueAt', 'Термін', 'datetime-local'); field('dueDate', 'Або лише дата', 'date'); field('reminderAt', 'Нагадати', 'datetime-local')
    field('reminderOffsetsMinutes', 'Нагадати за: 15, 60, 180, 1440 або 10080 хвилин', 'json'); field('recurrence', 'Повторення', 'select', true, ['none', 'daily', 'weekly', 'monthly'].map((value, index) => ({ value, label: ['Без повторення', 'Щодня', 'Щотижня', 'Щомісяця'][index] }))); field('recurrenceUntil', 'Повторювати до', 'date'); payload.recurrence ??= 'none'
  } else c.fail('unsupported_action', 422)
  return { action, title, scope: structuredClone(scope), payload, fields }
}
