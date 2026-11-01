import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createConfirmedAssistantWrites, createLocalConfirmedWriteStore } from '../../server/assistant-v2/confirmedWrites.ts'

// Entire caller transport is in memory. No Supabase, providers, real accounts,
// key discovery, environment or network. File persistence uses output test IDs.
const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const USER = uid(1), OTHER = uid(2), GROUP = uid(101), FOREIGN = uid(102), LESSON = uid(201), HW = uid(301)
const CREDENTIAL = 'synthetic-credential-no-network'
const NOW = Date.parse('2026-11-02T10:00:00Z'), STAMP = '2026-11-02T09:00:00Z'
const scope = { groupId: GROUP, date: '2026-11-03' }
const lesson = overrides => ({ id: LESSON, group_id: GROUP, weekday: 2, starts_at: '08:30:00', ends_at: '09:50:00', subject: 'Math', teacher_name: '', lesson_type: 'lecture', location: '', valid_from: '2026-11-03', valid_until: '2026-11-03', week_pattern: 'every', week_anchor_date: null, excluded_dates: [], updated_at: STAMP, created_by: USER, online_url: null, online_url_secondary: null, online_links_extra: [], conference_id: null, conference_access_code: null, ...overrides })
const schedulePayload = { date: '2026-11-03', subject: 'Synthetic lesson', startsAt: '11:20', endsAt: '12:40', lessonType: 'lecture', location: 'Test room' }
const binding = draft => ({ id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken })
const denied = (operation, code) => assert.rejects(operation, error => error.code === code)

function transport() {
  const state = { userId: USER, active: true, rights: ['schedule', 'homework', 'seminars'], participant: true, writes: [], reads: [], failAfterWrite: false, beforeWrite: null, tokenChecks: 0,
    tables: { study_group_schedule: [lesson()], study_group_homework: [], organizer_tasks: [], study_groups: [{ id: GROUP, representative_id: USER }], study_group_members: [], study_group_seminars: [], study_group_seminar_questions: [], study_group_seminar_teams: [], study_group_seminar_reservations: [], teaching_items: [] } }
  class Query {
    constructor(table) { this.table = table; this.filters = {}; this.bounds = []; this.op = 'read'; this.maximum = Infinity; this.singular = false }
    select(columns) { this.columns = columns; return this }
    eq(key, value) { this.filters[key] = value; return this }
    lte(key, value) { this.bounds.push(row => row[key] <= value); return this }
    gte(key, value) { this.bounds.push(row => row[key] >= value); return this }
    order() { return this }
    limit(number) { this.maximum = number; return this }
    single() { this.singular = true; return this }
    insert(value) { this.op = 'insert'; this.value = value; return this }
    update(value) { this.op = 'update'; this.value = value; return this }
    then(resolve, reject) { return this.execute().then(resolve, reject) }
    async execute() {
      const table = state.tables[this.table]
      assert.ok(table, 'allowlisted actual table: ' + this.table)
      if (this.op !== 'read') {
        await state.beforeWrite?.(this)
        state.writes.push({ table: this.table, operation: this.op, values: structuredClone(this.value), filters: { ...this.filters } })
        let value
        if (this.op === 'insert') { value = { ...structuredClone(this.value), updated_at: '2026-11-02T10:01:00Z' }; if (value.due_at) value.due_at = new Date(value.due_at).toISOString().replace('Z', '+00:00'); table.push(value) }
        else { value = table.find(row => Object.entries(this.filters).every(([k, v]) => row[k] === v)); if (!value) return { data: null, error: { code: 'PGRST116' } }; Object.assign(value, this.value, { updated_at: '2026-11-02T10:01:00Z' }) }
        if (state.failAfterWrite) throw new Error('RAW_PRIVATE_PROVIDER_KEY')
        return { data: { id: value.id }, error: null }
      }
      state.reads.push({ table: this.table, filters: { ...this.filters }, columns: this.columns })
      const matched = table.filter(row => Object.entries(this.filters).every(([k, v]) => row[k] === v) && this.bounds.every(predicate => predicate(row))).slice(0, this.maximum)
      return { data: structuredClone(this.singular ? matched[0] ?? null : matched), error: null }
    }
  }
  const client = { from: table => new Query(table), async rpc(name, args = {}) {
    if (name === 'xelay_study_group_permissions') return { data: args.p_group_id === GROUP ? state.rights : [], error: null }
    if (name === 'xelay_has_participant_access') { assert.equal(args.p_user_id, state.userId); return { data: state.participant, error: null } }
    if (name === 'xelay_reserve_seminar') {
      state.writes.push({ rpc: name, args })
      const row = { id: uid(700), seminar_id: args.p_seminar_id, user_id: state.userId, role: args.p_role, question_id: args.p_role === 'team' ? null : args.p_target_id, team_id: args.p_role === 'team' ? args.p_target_id : null }
      state.tables.study_group_seminar_reservations = [row]
      return { data: null, error: null }
    }
    if (name === 'xelay_set_seminar_selection_deadline') {
      state.writes.push({ rpc: name, args }); const row = state.tables.study_group_seminars.find(s => s.id === args.p_seminar_id)
      row.selection_deadline_at = args.p_deadline; row.selection_version++
      return { data: { seminar_id: row.id, selection_deadline_at: row.selection_deadline_at, selection_version: row.selection_version }, error: null }
    }
    if (name === 'xelay_teaching_group_context') return { data: { courses: [{ id: uid(800), archived_at: null, permissions: ['assignments'], version: 1 }] }, error: null }
    if (name === 'xelay_teaching_classified_assignment' || name === 'xelay_teaching_save_multi_assignment') {
      state.writes.push({ rpc: name, args }); return { data: { id: args.p_payload.id, version: 1 }, error: null }
    }
    assert.fail('Unmapped RPC: ' + name)
  } }
  const verifySession = async credential => { assert.equal(credential, CREDENTIAL); state.tokenChecks++; return { userId: state.userId, expiresAt: '2026-11-02T12:00:00Z', accountActive: state.active, emailConfirmed: true, sessionId: 'test-session' } }
  return { state, client, verifySession }
}
async function setup(options = {}) {
  const app = transport(), store = options.store ?? await createLocalConfirmedWriteStore()
  const dependencies = { verifySession: app.verifySession, createCallerClient: (_session, credential) => { assert.equal(credential, CREDENTIAL); return app.client }, store, now: () => NOW, ...options }
  return { ...app, store, service: createConfirmedAssistantWrites(dependencies), remake: () => createConfirmedAssistantWrites(dependencies), prepare: (action, payload, customScope = scope) => createConfirmedAssistantWrites(dependencies).prepare(CREDENTIAL, { action, scope: customScope, payload }) }
}

test('preparation, editing and cancellation never mutate the caller database', async () => {
  const h = await setup(); const first = await h.prepare('schedule.create', schedulePayload)
  assert.equal(first.status, 'draft'); assert.equal(h.state.writes.length, 0)
  assert.ok(first.draft.confirmationToken.length === 48)
  assert.equal('plan' in first.draft, false); assert.equal('userId' in first.draft, false)
  const edited = await h.service.edit(CREDENTIAL, { ...binding(first.draft), payload: { ...schedulePayload, location: 'Changed test room' } })
  assert.equal(edited.draft.revision, 2); assert.notEqual(edited.draft.confirmationToken, first.draft.confirmationToken)
  await denied(h.service.confirm(CREDENTIAL, binding(first.draft)), 'draft_changed')
  assert.equal((await h.service.cancel(CREDENTIAL, binding(edited.draft))).status, 'cancelled')
  await denied(h.service.confirm(CREDENTIAL, binding(edited.draft)), 'draft_unavailable')
  assert.equal(h.state.writes.length, 0)
})

test('only explicit current confirmation persists one-off schedule and verifies all connection fields', async () => {
  const h = await setup()
  const payload = { ...schedulePayload, teacherName: 'Synthetic teacher', links: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'], conferenceId: '123 456', accessCode: 'TEST' }
  const { draft } = await h.prepare('schedule.create', payload)
  const result = await h.service.confirm(CREDENTIAL, binding(draft))
  assert.equal(result.status, 'confirmed'); assert.equal(result.receipt.syntheticOnly, false)
  assert.equal(h.state.writes.length, 1)
  const saved = h.state.tables.study_group_schedule.find(row => row.id === result.receipt.affectedIds[0])
  assert.equal(saved.created_by, USER); assert.equal(saved.group_id, GROUP); assert.equal(saved.weekday, 2)
  assert.equal(saved.valid_from, saved.valid_until); assert.equal(saved.teacher_name, payload.teacherName)
  assert.equal(saved.conference_access_code, 'TEST'); assert.deepEqual(saved.online_links_extra, [{ url: payload.links[2], label: '' }])
  assert.equal((await h.remake().confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  assert.equal(h.state.writes.length, 1)
  assert.equal((await h.service.get(CREDENTIAL, draft.id)).receipt.draftId, draft.id)
})

test('foreign actors, role spoofing, wrong confirmation tokens and forbidden groups never dispatch', async () => {
  const h = await setup({ allowedWriteGroupIds: [GROUP] })
  await denied(h.service.prepare(CREDENTIAL, { action: 'schedule.create', scope, payload: schedulePayload, actorId: OTHER }), 'unsupported_action')
  await denied(h.prepare('schedule.create', schedulePayload, { ...scope, groupId: FOREIGN }), 'local_test_group_required')
  const { draft } = await h.prepare('schedule.create', schedulePayload)
  await denied(h.service.confirm(CREDENTIAL, { ...binding(draft), confirmationToken: 'x'.repeat(48) }), 'invalid_binding')
  h.state.userId = OTHER
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'draft_not_found')
  assert.deepEqual((await h.service.list(CREDENTIAL)).drafts, [])
  assert.equal(h.state.writes.length, 0)
})

test('Unicode confirmation tokens cannot reach timingSafeEqual with mismatched byte lengths', async () => {
  const h = await setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  for (const confirmationToken of ['а'.repeat(48), '💛'.repeat(24), 'Ａ'.repeat(48), 'g'.repeat(48), 'A'.repeat(48), 'a'.repeat(47)]) {
    await denied(h.service.confirm(CREDENTIAL, { ...binding(draft), confirmationToken }), 'invalid_binding')
  }
  assert.equal(h.state.writes.length, 0)
  assert.equal((await h.service.get(CREDENTIAL, draft.id)).status, 'pending')
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  assert.equal(h.state.writes.length, 1)
})

test('public change summaries use Ukrainian labels and human types without exposing internal IDs', async () => {
  const h = await setup()
  const { draft } = await h.prepare('schedule.create', { ...schedulePayload, teacherName: ' Teacher ', links: ['https://example.com/a', 'https://example.com/b'], recurring: false, week: 'both' })
  const byId = Object.fromEntries(draft.items.map(item => [item.id, item]))
  assert.equal(byId.subject.label, 'Предмет')
  assert.equal(byId.lessonType.label, 'Тип заняття'); assert.equal(byId.lessonType.after, 'Лекція')
  assert.equal(byId.teacherName.after, 'Teacher')
  assert.equal(byId.recurring.after, 'Лише одна дата'); assert.equal(byId.week.after, 'Щотижня')
  assert.equal(byId.links.after, 'https://example.com/a\nhttps://example.com/b')
  assert.ok(byId.date.after.includes('листопада'))
  assert.ok(!draft.fields.some(field => ['id', 'lessonId', 'groupIds'].includes(field.key)))
  assert.equal(h.state.writes.length, 0)
})

test('revoked permissions, account expiry and changed targets invalidate pending confirmation', async () => {
  const h = await setup(); const { draft } = await h.prepare('schedule.create', schedulePayload)
  h.state.rights = ['homework']
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'permission_required')
  h.state.rights = ['schedule']; h.state.active = false
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'session_invalid')
  h.state.active = true; h.state.tables.study_group_schedule[0].updated_at = '2026-11-02T10:03:00Z'
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'draft_conflict')
  assert.equal(h.state.writes.length, 0)
})

test('parallel confirms dispatch once; duplicates become receipts or remain safely in progress', async () => {
  const h = await setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  const answers = await Promise.allSettled([h.service.confirm(CREDENTIAL, binding(draft)), h.service.confirm(CREDENTIAL, binding(draft))])
  assert.equal(answers.filter(a => a.status === 'fulfilled').length >= 1, true)
  assert.equal(h.state.writes.length, 1)
  for (const answer of answers) if (answer.status === 'rejected') assert.equal(answer.reason.code, 'execution_unknown')
})

test('lost post-commit response persists unknown status and can never retry the write', async () => {
  const filePath = path.resolve('../output/assistant-confirmed-writes-tests', randomUUID() + '.json')
  const store = await createLocalConfirmedWriteStore({ filePath }), h = await setup({ store })
  try {
    const { draft } = await h.prepare('schedule.create', schedulePayload)
    h.state.failAfterWrite = true
    assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'unknown')
    assert.equal(h.state.writes.length, 1)
    const restartedStore = await createLocalConfirmedWriteStore({ filePath })
    const restarted = createConfirmedAssistantWrites({ verifySession: h.verifySession, createCallerClient: () => h.client, store: restartedStore, now: () => NOW })
    await denied(restarted.confirm(CREDENTIAL, binding(draft)), 'execution_unknown')
    assert.equal((await restarted.get(CREDENTIAL, draft.id)).status, 'unknown')
    assert.equal(h.state.writes.length, 1)
    assert.ok(!(await restarted.list(CREDENTIAL)).drafts.some(d => JSON.stringify(d).includes('RAW_PRIVATE_PROVIDER_KEY')))
  } finally { await rm(filePath, { force: true }) }
})

test('homework preserves existing attachments, links and author instead of erasing them', async () => {
  const h = await setup()
  h.state.tables.study_group_homework.push({ id: HW, group_id: GROUP, schedule_item_id: LESSON, lesson_date: scope.date, lesson_topic: 'Old', body: 'Old body', url: 'https://example.com/material', resource_links: ['https://example.com/material'], resource_link_labels: { 'https://example.com/material': 'Original' }, attachments: [{ storage_path: 'existing/verified.pdf', name: 'Original.pdf' }], updated_at: STAMP, created_by: OTHER })
  const { draft } = await h.prepare('homework.upsert', { lessonId: LESSON, topic: 'New topic', body: 'Full conditional body\n1. A\n2. B', dueAt: null })
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  const saved = h.state.tables.study_group_homework[0]
  assert.equal(saved.body, 'Full conditional body\n1. A\n2. B'); assert.equal(saved.created_by, OTHER)
  assert.equal(saved.attachments[0].name, 'Original.pdf'); assert.equal(saved.resource_links.length, 1)
  assert.equal(h.state.writes[0].filters.updated_at, STAMP)
})

test('homework review identifies the authoritative lesson, date and time instead of an opaque UUID', async () => {
  const h = await setup()
  const first = await h.prepare('homework.upsert', { lessonId: LESSON, topic: 'Fake economics label in user text', body: 'Exact body' })
  const target = first.draft.items.find(item => item.id === 'authoritative-lesson')
  assert.equal(target.label, 'Пара, до якої додається ДЗ')
  assert.ok(target.after.startsWith('Math · ')); assert.ok(target.after.includes('листопада')); assert.ok(target.after.includes('08:30–09:50'))
  assert.ok(!JSON.stringify(first.draft.items).includes(LESSON)); assert.ok(!JSON.stringify(first.draft.items).includes(GROUP))
  assert.ok(!('targetSummary' in first.draft)); assert.ok(!('plan' in first.draft))
  h.state.tables.study_group_schedule[0].subject = 'Updated actual subject'
  const revised = await h.service.edit(CREDENTIAL, { ...binding(first.draft), payload: { ...first.draft.payload, body: 'Edited body' } })
  assert.ok(revised.draft.items.find(item => item.id === 'authoritative-lesson').after.startsWith('Updated actual subject · '))
  assert.equal(h.state.writes.length, 0)
})

test('a raced update uses updated_at CAS and cannot overwrite a newer row', async () => {
  const h = await setup()
  const { draft } = await h.prepare('schedule.update', { ...schedulePayload, id: LESSON, startsAt: '08:30', endsAt: '09:50' })
  h.state.beforeWrite = () => { h.state.tables.study_group_schedule[0].updated_at = '2026-11-02T10:09:00Z'; h.state.tables.study_group_schedule[0].subject = 'Newer external change' }
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'unknown')
  assert.equal(h.state.tables.study_group_schedule[0].subject, 'Newer external change')
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'execution_unknown')
})

test('updating a one-off lesson preserves omitted teacher, location and conference resources', async () => {
  const h = await setup()
  Object.assign(h.state.tables.study_group_schedule[0], { teacher_name: 'Existing teacher', location: 'Existing room', online_url: 'https://example.com/existing', online_url_label: 'Lecture', online_url_secondary: 'https://example.com/extra', online_url_secondary_label: 'Backup', online_links_extra: [{ url: 'https://example.com/third', label: 'Materials' }], conference_id: '321 654', conference_access_code: 'EXISTING' })
  const { draft } = await h.prepare('schedule.update', { id: LESSON, date: scope.date, subject: 'Renamed only', startsAt: '08:30', endsAt: '09:50', lessonType: 'lecture' })
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  const saved = h.state.tables.study_group_schedule[0]
  assert.equal(saved.teacher_name, 'Existing teacher'); assert.equal(saved.location, 'Existing room')
  assert.equal(saved.online_url_label, 'Lecture'); assert.equal(saved.online_url_secondary_label, 'Backup')
  assert.equal(saved.online_links_extra[0].label, 'Materials'); assert.equal(saved.conference_access_code, 'EXISTING')
})

test('invalid dates, bad links, overlap, recurring series and unsupported destructive/bulk actions are explicit denials', async () => {
  const h = await setup()
  await denied(h.prepare('schedule.create', { ...schedulePayload, links: ['javascript:alert(1)'] }), 'invalid_links')
  await denied(h.prepare('schedule.create', { ...schedulePayload, startsAt: '08:45', endsAt: '09:30' }), 'schedule_overlap')
  await denied(h.prepare('schedule.create', { ...schedulePayload, recurring: true }), 'invalid_recurrence')
  await denied(h.prepare('homework.upsert', { lessonId: LESSON, topic: 'X', body: 'Y', dueAt: 'not-a-date' }), 'invalid_deadline')
  for (const action of ['delete', 'homework.bulk', 'messages.send', 'set_role', 'teaching.grade.manual']) await denied(h.prepare(action, {}), 'unsupported_action')
  await denied(h.prepare('teaching.material.upsert', { fileRef: 'attachment-fake' }), 'invalid_payload')
  assert.equal(h.state.writes.length, 0)
})

test('actual database text limits are rejected before confirmation, and trigger-trimmed inline fields verify correctly', async () => {
  const h = await setup()
  for (const patch of [{ subject: 'x'.repeat(121) }, { location: 'x'.repeat(161) }, { conferenceId: 'x'.repeat(121) }, { accessCode: 'x'.repeat(121) }, { teacherName: 'Teacher\nNew line' }]) {
    await denied(h.prepare('schedule.create', { ...schedulePayload, ...patch }), 'invalid_text')
  }
  await denied(h.prepare('organizer.task.create', { title: 'x'.repeat(201) }, {}), 'invalid_text')
  assert.equal(h.state.writes.length, 0)
  const { draft } = await h.prepare('schedule.create', { ...schedulePayload, subject: ' Trimmed subject ', location: ' Room ', teacherName: ' Test   Teacher ', conferenceId: ' 321 ', accessCode: ' TEST ', links: [' https://example.com/trimmed '] })
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  const saved = h.state.tables.study_group_schedule.find(row => row.id !== LESSON)
  assert.equal(saved.subject, 'Trimmed subject'); assert.equal(saved.location, 'Room'); assert.equal(saved.teacher_name, 'Test Teacher')
  assert.equal(saved.conference_id, '321'); assert.equal(saved.conference_access_code, 'TEST'); assert.equal(saved.online_url, 'https://example.com/trimmed')
  const task = await h.prepare('organizer.task.create', { title: ' Task ', subject: ' Math ' }, {})
  assert.equal((await h.service.confirm(CREDENTIAL, binding(task.draft))).status, 'confirmed')
  assert.equal(h.state.tables.organizer_tasks[0].title, 'Task'); assert.equal(h.state.tables.organizer_tasks[0].subject, 'Math')
})

test('organizer creates an own personal task only while participant access is current', async () => {
  const h = await setup()
  h.state.participant = false
  await denied(h.prepare('organizer.task.create', { title: 'Test task' }, {}), 'participant_required')
  h.state.participant = true
  const { draft } = await h.prepare('organizer.task.create', { title: 'Test task', notes: 'Only local tests', dueAt: null }, {})
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  assert.equal(h.state.tables.organizer_tasks[0].user_id, USER)
  assert.equal(h.state.tables.organizer_tasks[0].title, 'Test task')
  await denied(h.prepare('organizer.task.create', { title: 'Shared forbidden', space: 'shared' }, {}), 'shared_organizer_requires_platform_editor')
})

test('a timed organizer task verifies the same instant after Supabase normalizes the timezone', async () => {
  const h = await setup()
  const { draft } = await h.prepare('organizer.task.create', { title: 'Timed task', dueAt: '2026-11-03T12:00:00+02:00' }, {})
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  assert.equal(h.state.tables.organizer_tasks[0].due_at, '2026-11-03T10:00:00.000+00:00')
  assert.equal(h.state.writes.length, 1)
})

test('seminar selection is bound to own membership and actual targets, while reopening uses selection version', async () => {
  const h = await setup(), SEMINAR = uid(601), QUESTION = uid(602)
  h.state.tables.study_group_seminars.push({ id: SEMINAR, group_id: GROUP, subject_id: uid(603), lesson_date: '2026-11-02', starts_at: '08:30:00', ends_at: '09:50:00', format: 'booking', selection_deadline_at: '2026-11-03T12:00:00Z', selection_version: 1 })
  h.state.tables.study_group_seminar_questions.push({ id: QUESTION, seminar_id: SEMINAR, body: 'Synthetic question', primary_capacity: 1, supplement_capacity: 2 })
  const { draft } = await h.prepare('seminar.book', { id: SEMINAR, questionId: QUESTION })
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  assert.equal(h.state.tables.study_group_seminar_reservations[0].user_id, USER)
  const reopened = await h.prepare('seminar.reopen', { id: SEMINAR, closesAt: '2026-11-03T13:00:00Z' })
  assert.equal((await h.service.confirm(CREDENTIAL, binding(reopened.draft))).status, 'confirmed')
  assert.equal(h.state.tables.study_group_seminars[0].selection_version, 2)
  assert.equal(h.state.writes[1].args.p_expected_version, 1)
})

test('teacher assignment uses canonical classified RPC and expected server-verified actor', async () => {
  const h = await setup(), courseId = uid(800)
  const { draft } = await h.prepare('teaching.assignment.upsert', { title: 'Synthetic teacher task', body: 'Exact text', dueAt: null }, { ...scope, courseId })
  assert.equal(h.state.writes.length, 0)
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
  const saved = h.state.writes[0]
  assert.equal(saved.rpc, 'xelay_teaching_classified_assignment'); assert.equal(saved.args.p_action, 'save_group_assignment')
  assert.equal(saved.args.p_payload.expected_user_id, USER); assert.equal(saved.args.p_payload.targets[0].group_id, GROUP)
  assert.equal(saved.args.p_payload.targets[0].placement_mode, 'unplaced'); assert.equal(saved.args.p_payload.targets[0].lesson_date, scope.date)
})

test('expired draft, changed session and malformed local persistence cannot invoke writes', async () => {
  const h = await setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  const expired = createConfirmedAssistantWrites({ verifySession: h.verifySession, createCallerClient: () => h.client, store: h.store, now: () => NOW + 901000 })
  await denied(expired.confirm(CREDENTIAL, binding(draft)), 'draft_expired')
  await denied(createLocalConfirmedWriteStore({ filePath: path.resolve('../not-output.json') }), 'local_store_path_required')
  assert.equal(h.state.writes.length, 0)
})
