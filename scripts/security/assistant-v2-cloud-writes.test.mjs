import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createCloudConfirmedAssistantWrites } from '../../server/assistant-v2/cloudWrites.ts'
import { ConfirmedWriteError } from '../../server/assistant-v2/confirmedWrites.ts'

// Synthetic caller transport and shared durable-journal port; no environment,
// real credentials, network, model or live database is accessed by these tests.
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
  let scheduleQueue = Promise.resolve()
  const client = { from: table => new Query(table), async rpc(name, args = {}) {
    if (name === 'xelay_assistant_create_schedule') {
      const operation = scheduleQueue.then(async () => {
        const value = args.p_values
        const overlapping = state.tables.study_group_schedule.some(row => row.group_id === value.group_id && row.weekday === value.weekday
          && row.valid_from <= value.valid_from && row.valid_until >= value.valid_from && !row.excluded_dates?.includes(value.valid_from)
          && row.starts_at.slice(0, 5) < value.ends_at && row.ends_at.slice(0, 5) > value.starts_at)
        if (overlapping) return { data: null, error: { code: 'PT409' } }
        return await client.from('study_group_schedule').insert(value).select('id').single()
      })
      scheduleQueue = operation.then(() => undefined, () => undefined)
      return operation
    }
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

// This fake models the repository contract, not Supabase business mutations.
// Claim/replace are atomic within the shared Map. Each service instance has its
// own domain/client and shares only this journal, as separate cloud workers do.
function sharedJournal() {
  const records = new Map(), calls = [], secret = randomBytes(32)
  const digest = value => createHash('sha256').update(value).digest('hex')
  const token = row => createHmac('sha256', secret).update(`${row.id}:${row.userId}:${row.revision}`).digest('hex').slice(0, 48)
  const reject = (code, status = 409) => { throw new ConfirmedWriteError(code, status) }
  const owned = (userId, id) => { const row = records.get(id); if (!row || row.userId !== userId) reject('draft_not_found', 404); return row }
  const envelope = row => {
    const { confirmationHash, claimHash, ...rest } = structuredClone(row)
    return { ...rest, confirmationToken: token(row) }
  }
  const binding = (row, revision, confirmationToken) => {
    if (row.revision !== revision) reject('draft_changed')
    if (digest(confirmationToken) !== row.confirmationHash) reject('invalid_binding', 403)
  }
  const journal = {
    mode: 'supabase-service-journal', calls, records, failFinish: false, failClaimAfterSave: false,
    async create(userId, document) {
      calls.push({ method: 'create', userId })
      const { id, ...privateDocument } = structuredClone(document)
      const row = { id, userId, revision: 1, status: 'pending', createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 900_000).toISOString(), document: privateDocument }
      row.confirmationHash = digest(token(row)); records.set(id, row); return envelope(row)
    },
    async get(userId, id) { calls.push({ method: 'get', userId }); return envelope(owned(userId, id)) },
    async list(userId, limit = 30) { calls.push({ method: 'list', userId }); return [...records.values()].filter(row => row.userId === userId).slice(-limit).reverse().map(envelope) },
    async replace(userId, id, revision, confirmationToken, document) {
      calls.push({ method: 'replace', userId }); const row = owned(userId, id); binding(row, revision, confirmationToken)
      if (row.status !== 'pending') reject('draft_unavailable')
      Object.assign(row, { document: structuredClone(document), revision: row.revision + 1 }); row.confirmationHash = digest(token(row)); return envelope(row)
    },
    async cancel(userId, id, revision, confirmationToken) {
      calls.push({ method: 'cancel', userId }); const row = owned(userId, id); binding(row, revision, confirmationToken)
      if (row.status !== 'pending') reject('draft_unavailable')
      row.status = 'cancelled'; return envelope(row)
    },
    async claim(userId, id, revision, confirmationToken) {
      calls.push({ method: 'claim', userId }); const row = owned(userId, id); binding(row, revision, confirmationToken)
      if (row.status !== 'pending') return { claimed: false, record: envelope(row) }
      if (Date.parse(row.expiresAt) <= NOW) reject('draft_expired')
      const claimToken = randomBytes(24).toString('hex'); row.status = 'committing'; row.claimHash = digest(claimToken)
      if (journal.failClaimAfterSave) throw Error('synthetic dropped claim response')
      return { claimed: true, record: envelope(row), claimToken }
    },
    async finish(userId, id, claimToken, outcome, receipt) {
      calls.push({ method: 'finish', userId }); const row = owned(userId, id)
      if (journal.failFinish) throw Error('synthetic journal unavailable')
      if (row.status !== 'committing' || row.claimHash !== digest(claimToken)) reject('invalid_claim', 403)
      row.status = outcome; if (receipt) row.receipt = structuredClone(receipt)
      return envelope(row)
    },
  }
  return journal
}

function setup(options = {}) {
  const app = transport(), journal = options.journal ?? sharedJournal()
  const dependencies = {
    verifySession: app.verifySession,
    createCallerClient: (session, credential) => { assert.equal(credential, CREDENTIAL); assert.equal(session.userId, app.state.userId); return app.client },
    journal, now: () => NOW, ...options,
  }
  const make = overrides => createCloudConfirmedAssistantWrites({ ...dependencies, ...overrides })
  return { ...app, journal, service: make(), make, prepare: (action, payload, customScope = scope) => make().prepare(CREDENTIAL, { action, scope: customScope, payload }) }
}

test('cloud preparation/edit/cancel persists only private journal drafts and projects no trusted execution plan', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  assert.equal(h.state.writes.length, 0)
  for (const key of ['plan', 'fingerprint', 'recordId', 'userId', 'receipt', 'document']) assert.equal(key in draft, false)
  const persisted = h.journal.records.get(draft.id)
  assert.equal(persisted.confirmationHash.length, 64); assert.equal('confirmationToken' in persisted, false)
  assert.equal(persisted.document.plan.table, 'study_group_schedule')
  const edited = await h.make().edit(CREDENTIAL, { ...binding(draft), payload: { ...schedulePayload, teacherName: 'Synthetic colleague' } })
  assert.equal(edited.draft.revision, 2); assert.notEqual(edited.draft.confirmationToken, draft.confirmationToken)
  await denied(h.make().confirm(CREDENTIAL, binding(draft)), 'draft_changed')
  const listed = await h.make().list(CREDENTIAL)
  assert.equal(listed.drafts[0].draft.confirmationToken, edited.draft.confirmationToken)
  assert.equal((await h.make().cancel(CREDENTIAL, binding(edited.draft))).status, 'cancelled')
  assert.equal((await h.make().get(CREDENTIAL, draft.id)).status, 'cancelled')
  await denied(h.make().confirm(CREDENTIAL, binding(edited.draft)), 'draft_unavailable')
  assert.equal(h.state.writes.length, 0)
})

test('a recreated cloud worker returns a durable receipt and can never dispatch a confirmed draft twice', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', { ...schedulePayload, teacherName: 'Synthetic teacher', links: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'], conferenceId: '111 222', accessCode: 'test-only' })
  const result = await h.service.confirm(CREDENTIAL, binding(draft))
  assert.equal(result.status, 'confirmed'); assert.equal(result.receipt.syntheticOnly, false)
  const saved = h.state.tables.study_group_schedule.find(row => row.id === result.receipt.affectedIds[0])
  assert.equal(saved.group_id, GROUP); assert.equal(saved.created_by, USER)
  assert.equal(saved.conference_access_code, 'test-only'); assert.equal(saved.online_links_extra[0].url, 'https://example.com/c')
  const second = await h.make().confirm(CREDENTIAL, binding(draft))
  assert.deepEqual(second.receipt, result.receipt); assert.equal(h.state.writes.length, 1)
  assert.ok(h.journal.calls.every(call => call.userId === USER))
})

test('two independent cloud instances sharing a journal claim the same draft only once', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  let entered, release
  const writing = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  h.state.beforeWrite = async () => { entered(); await gate }
  const first = h.service.confirm(CREDENTIAL, binding(draft)); await writing
  const duplicate = await h.make().confirm(CREDENTIAL, binding(draft))
  assert.equal(duplicate.status, 'committing'); assert.equal(h.state.writes.length, 0)
  release(); assert.equal((await first).status, 'confirmed')
  assert.equal(h.state.writes.length, 1)
  assert.equal((await h.make().confirm(CREDENTIAL, binding(draft))).status, 'confirmed')
})

test('different confirmed create drafts cannot race to insert two overlapping lessons', async () => {
  const h = setup(), firstDraft = (await h.prepare('schedule.create', schedulePayload)).draft
  const secondDraft = (await h.prepare('schedule.create', { ...schedulePayload, subject: 'Competing synthetic lesson' })).draft
  let entered, release
  const writing = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  h.state.beforeWrite = async () => { entered(); await gate }
  const first = h.service.confirm(CREDENTIAL, binding(firstDraft)); await writing
  const second = h.make().confirm(CREDENTIAL, binding(secondDraft))
  // Both may claim their own journal, but only the narrow locked SQL operation
  // decides whether a new occurrence is still available at mutation time.
  for (let iteration = 0; iteration < 100 && h.journal.records.get(secondDraft.id).status === 'pending'; iteration++) await Promise.resolve()
  assert.equal(h.journal.records.get(secondDraft.id).status, 'committing'); release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map(result => result.status).sort(), ['confirmed', 'unknown'])
  assert.equal(h.state.writes.length, 1)
  assert.equal(h.state.tables.study_group_schedule.filter(row => row.starts_at === '11:20').length, 1)
})

test('a lost mutation response is durable unknown; another instance cannot retry it', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  h.state.failAfterWrite = true
  const result = await h.service.confirm(CREDENTIAL, binding(draft))
  assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes('RAW_PRIVATE_PROVIDER_KEY'))
  h.state.failAfterWrite = false
  assert.equal((await h.make().confirm(CREDENTIAL, binding(draft))).status, 'unknown')
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.tables.study_group_schedule.length, 2)
})

test('lost durable claim response prevents dispatch and restart cannot reclaim it', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  h.journal.failClaimAfterSave = true
  await assert.rejects(h.service.confirm(CREDENTIAL, binding(draft)))
  h.journal.failClaimAfterSave = false
  assert.equal((await h.make().confirm(CREDENTIAL, binding(draft))).status, 'committing')
  assert.equal(h.state.writes.length, 0)
})

test('journal finish outage cannot cause a second business mutation', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  h.journal.failFinish = true
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'unknown')
  h.journal.failFinish = false
  assert.equal((await h.make().confirm(CREDENTIAL, binding(draft))).status, 'committing')
  assert.equal(h.state.writes.length, 1)
})

test('fresh caller rights and changed authoritative records invalidate pending confirmation before claim', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  h.state.rights = ['homework']
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'permission_required')
  h.state.rights = ['schedule', 'homework', 'seminars']; h.state.tables.study_group_schedule[0].location = 'changed elsewhere'
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'draft_conflict')
  assert.equal(h.journal.records.get(draft.id).status, 'pending'); assert.equal(h.state.writes.length, 0)
})

test('expired/inactive sessions, changed auth identity and foreign owners cannot claim a draft', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  h.state.active = false
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'session_invalid')
  h.state.active = true; h.state.userId = OTHER
  await denied(h.make().confirm(CREDENTIAL, binding(draft)), 'draft_not_found')
  assert.deepEqual((await h.make().list(CREDENTIAL)).drafts, [])
  h.state.userId = USER
  let checks = 0
  const rotated = h.make({ verifySession: async credential => ({ ...await h.verifySession(credential), sessionId: ++checks === 1 ? 'first' : 'second' }) })
  await denied(rotated.confirm(CREDENTIAL, binding(draft)), 'session_changed')
  assert.equal(h.state.writes.length, 0)
})

test('wrong tokens, unicode bindings, arbitrary plans and unsupported browser actions are rejected', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  for (const confirmationToken of ['а'.repeat(48), 'g'.repeat(48), 'a'.repeat(48)]) await denied(h.service.confirm(CREDENTIAL, { ...binding(draft), confirmationToken }), 'invalid_binding')
  await denied(h.service.prepare(CREDENTIAL, { action: 'schedule.create', scope, payload: schedulePayload, plan: { table: 'profiles' } }), 'unsupported_action')
  await denied(h.service.prepare(CREDENTIAL, { action: 'rpc', scope, payload: { rpc: 'arbitrary' } }), 'unsupported_action')
  await denied(h.prepare('teaching.material.upsert', { title: 'unverified file', fileRef: 'not-a-real-upload' }), 'invalid_payload')
  assert.equal(h.state.writes.length, 0)
})

test('expired drafts and mismatched persisted server plans fail closed without a business call', async () => {
  const h = setup(), { draft } = await h.prepare('schedule.create', schedulePayload)
  const row = h.journal.records.get(draft.id)
  row.expiresAt = new Date(NOW - 1).toISOString()
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'draft_expired')
  row.expiresAt = new Date(NOW + 100_000).toISOString(); row.document.plan.table = 'profiles'
  await denied(h.service.confirm(CREDENTIAL, binding(draft)), 'draft_conflict')
  assert.equal(h.state.writes.length, 0)
})

test('homework readback preserves resources and uses the actual authoritative lesson in review', async () => {
  const h = setup()
  h.state.tables.study_group_homework.push({ id: HW, group_id: GROUP, schedule_item_id: LESSON, lesson_date: scope.date, lesson_topic: 'Old', body: 'Old body', created_by: OTHER, updated_at: STAMP, url: 'https://example.com/resource', resource_links: ['https://example.com/resource'], resource_link_labels: { 'https://example.com/resource': 'Resources' }, attachments: [{ path: 'synthetic-existing-resource' }] })
  const { draft } = await h.prepare('homework.upsert', { lessonId: LESSON, date: scope.date, topic: 'New', body: 'New body' })
  assert.ok(draft.items[0].after.includes('Math')); assert.ok(draft.items[0].after.includes('08:30'))
  const result = await h.make().confirm(CREDENTIAL, binding(draft))
  assert.equal(result.status, 'confirmed')
  const saved = h.state.tables.study_group_homework[0]
  assert.equal(saved.created_by, OTHER); assert.equal(saved.resource_links.length, 1); assert.equal(saved.attachments.length, 1)
})

test('a raced update uses actual updated_at compare-and-set instead of overwriting newer homework', async () => {
  const h = setup()
  h.state.tables.study_group_homework.push({ id: HW, group_id: GROUP, schedule_item_id: LESSON, lesson_date: scope.date, lesson_topic: 'Old', body: '', created_by: USER, updated_at: STAMP })
  const { draft } = await h.prepare('homework.upsert', { lessonId: LESSON, date: scope.date, topic: 'New', body: '' })
  h.state.beforeWrite = async () => { h.state.tables.study_group_homework[0].updated_at = '2026-11-02T10:05:00Z'; h.state.tables.study_group_homework[0].lesson_topic = 'Latest actual change' }
  assert.equal((await h.service.confirm(CREDENTIAL, binding(draft))).status, 'unknown')
  assert.equal(h.state.tables.study_group_homework[0].lesson_topic, 'Latest actual change')
  assert.equal((await h.make().confirm(CREDENTIAL, binding(draft))).status, 'unknown')
  assert.equal(h.state.writes.length, 1)
})

test('organizer is own personal access only, and teaching uses canonical actor/version RPC', async () => {
  const h = setup(), own = await h.prepare('organizer.task.create', { title: 'Synthetic own task', space: 'personal', dueAt: '2026-11-05T11:00:00+02:00' }, {})
  assert.equal((await h.service.confirm(CREDENTIAL, binding(own.draft))).status, 'confirmed')
  assert.equal(h.state.tables.organizer_tasks[0].user_id, USER)
  const teaching = await h.prepare('teaching.assignment.upsert', { title: 'Synthetic assignment', body: 'Only synthetic content', groupIds: [GROUP] }, { ...scope, courseId: uid(800) })
  assert.equal((await h.make().confirm(CREDENTIAL, binding(teaching.draft))).status, 'confirmed')
  const write = h.state.writes.find(row => row.rpc === 'xelay_teaching_classified_assignment')
  assert.equal(write.args.p_action, 'save_group_assignment'); assert.equal(write.args.p_payload.expected_user_id, USER); assert.equal(write.args.p_payload.version, 0)
})

test('cloud seminar booking/team selection stays bound to the member and reopening sends the actual selection version', async () => {
  const h = setup(), seminarId = uid(600), questionId = uid(601), teamId = uid(602)
  h.state.tables.study_group_seminars.push({ id: seminarId, group_id: GROUP, subject_id: uid(603), title: 'Похідна: питання до семінару', lesson_date: scope.date, starts_at: '11:20:00', ends_at: '12:40:00', format: 'booking', selection_deadline_at: '2026-11-03T10:00:00Z', selection_version: 1 })
  h.state.tables.study_group_seminar_questions.push({ id: questionId, seminar_id: seminarId, body: 'Synthetic question', primary_capacity: 1, supplement_capacity: 1 })
  const booking = await h.prepare('seminar.book', { id: seminarId, questionId })
  const shown = booking.draft.items.map(item => item.after).join('\n')
  assert.match(shown, /Похідна: питання до семінару/); assert.match(shown, /Synthetic question/)
  assert.match(shown, /Бронювання питання/); assert.match(shown, /листопада 2026/); assert.match(shown, /11:20–12:40/)
  assert.ok(!shown.includes(questionId) && !shown.includes(seminarId))
  const restored = await h.make().get(CREDENTIAL, booking.draft.id)
  assert.deepEqual(restored.draft.items, booking.draft.items)
  assert.equal((await h.make().confirm(CREDENTIAL, binding(booking.draft))).status, 'confirmed')
  assert.equal(h.state.tables.study_group_seminar_reservations[0].user_id, USER)
  const reopening = await h.prepare('seminar.reopen', { id: seminarId, closesAt: '2026-11-03T13:00:00Z' })
  assert.ok(reopening.draft.items.some(item => item.after.includes('Похідна: питання до семінару')))
  assert.ok(reopening.draft.items.some(item => item.after.includes('Наявні питання, команди й вибір учасників збережуться.')))
  assert.ok(reopening.draft.items.some(item => item.label === 'Запис відкрито до' && item.after.includes('листопада')))
  assert.equal((await h.make().confirm(CREDENTIAL, binding(reopening.draft))).status, 'confirmed')
  assert.equal(h.state.writes[1].args.p_expected_version, 1); assert.equal(h.state.tables.study_group_seminars[0].selection_version, 2)
  h.state.tables.study_group_seminars[0].format = 'teams'
  h.state.tables.study_group_seminar_teams.push({ id: teamId, seminar_id: seminarId, name: 'Synthetic team', capacity: 3 })
  const team = await h.prepare('seminar.team.join', { id: seminarId, teamId })
  assert.ok(team.draft.items.some(item => item.label === 'Команда' && item.after === 'Synthetic team'))
  assert.ok(team.draft.items.some(item => item.label === 'Ваша роль' && item.after === 'Учасник команди'))
  assert.equal((await h.make().confirm(CREDENTIAL, binding(team.draft))).status, 'confirmed')
  assert.equal(h.state.tables.study_group_seminar_reservations[0].team_id, teamId)
})

test('scheduled multi-group teaching rechecks each group and preserves the scheduled publication time', async () => {
  const h = setup(), courseId = uid(800), publishAt = '2026-11-03T12:00:00Z'
  const publication = await h.prepare('teaching.publication.schedule', { title: 'Synthetic scheduled task', groupIds: [GROUP, FOREIGN], publishAt }, { ...scope, courseId })
  assert.equal((await h.make().confirm(CREDENTIAL, binding(publication.draft))).status, 'confirmed')
  const write = h.state.writes[0]
  assert.equal(write.rpc, 'xelay_teaching_save_multi_assignment'); assert.equal(write.args.p_payload.status, 'scheduled')
  assert.equal(write.args.p_payload.publish_at, publishAt); assert.deepEqual(write.args.p_payload.targets.map(row => row.group_id), [GROUP, FOREIGN])
})

test('cloud initialization rejects local, missing or incomplete journals rather than falling back', () => {
  const h = setup()
  for (const journal of [undefined, {}, { mode: 'local-single-process' }, { mode: 'supabase-service-journal' }]) assert.throws(() => h.make({ journal }), error => error.code === 'cloud_write_journal_required')
})
