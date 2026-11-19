import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTeacherBackendFixture } from './helpers/teacherBackendFixture.mjs'
import { teacherModuleLoader, apiCall, syntheticTeacherModel } from './helpers/loadTeacherModule.mjs'
import { syntheticTest } from '../scripts/security/teaching-tests-fixture.mjs'

test('teacher assistant tools: authorized insights, real draft export and scheduled own reminders', { timeout: 120000 }, async t => {
  const fx = await createTeacherBackendFixture({ currentAssessment: true }); t.after(() => fx.close())
  const { db, ids, groups } = fx, model = syntheticTeacherModel()
  const handler = teacherModuleLoader()('server/teacher-learning/teacherLearningProduction.ts').createTeacherLearningProduction({ environment: fx.environment, clientFactory: fx.clientFactory, fetcher: model.fetcher })
  const call = (action, extra = {}, user = ids.owner) => apiCall(handler, { action, ...extra }, { token: fx.token(user) })
  const req = (kind, extra = {}) => ({ requestId: randomUUID(), kind, courseId: ids.course, groupIds: [groups[0]], prompt: 'Synthetic teaching request', consent: true, ...extra })
  const scope = { courseId: ids.course, groupIds: [groups[0]], testId: null }
  const counts = async () => (await db.query(`select jsonb_build_object('grades',coalesce((select jsonb_agg(to_jsonb(g)order by g.id)from teaching_grades g),'[]'),'attempts',coalesce((select jsonb_agg(to_jsonb(a)order by a.id)from teaching_test_attempts a),'[]'))v`)).rows[0].v
  let testId, original, analysisId
  await t.test('plans, forged scope, student identity and unauthorized teacher are rejected before provider access', async () => {
    await fx.createPaidTeacher('teacher_start')
    assert.equal((await call('insights', { scope })).status, 403)
    await fx.createPaidTeacher('teacher_plus')
    assert.equal((await call('insights', { scope: { ...scope, groupIds: groups } })).status, 403)
    assert.equal((await call('insights', { scope: { ...scope, groupIds: [randomUUID()] } })).status, 403)
    assert.equal((await call('insights', { scope }, ids.studentA)).status, 403)
    await fx.createPaidTeacher('teacher_max', ids.otherTeacher)
    assert.equal((await call('insights', { scope }, ids.otherTeacher)).status, 403)
    assert.equal((await call('insights', { scope: { ...scope, impersonate: ids.owner } })).status, 400)
    assert.equal(model.calls.length, 0)
  })
  await t.test('active tests reveal no learner analysis; submitted wrong answers and ungraded essay remain distinct', async () => {
    await fx.mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: groups[0] })
    const definition = syntheticTest(ids.course, [groups[0]], { questions: [syntheticTest(ids.course, groups).questions[0], { id: 'essay', kind: 'essay', text: 'Explain the synthetic concept.', points: 5, time_limit_seconds: null, partial_credit: false, options: [], buckets: [], answer: null }], max_points: 10, bonus_points: 0, bonus_percent: 0 })
    await fx.rpc(ids.owner, 'xelay_teaching_test_mutate', ['save_test', JSON.stringify(definition)])
    testId = definition.id
    let attempt = await fx.rpc(ids.studentA, 'xelay_teaching_test_mutate', ['start', JSON.stringify({ id: testId, group_id: groups[0] })])
    assert.equal((await call('insights', { scope: { ...scope, testId } })).body.report.test.ready, false)
    attempt = await fx.rpc(ids.studentA, 'xelay_teaching_test_mutate', ['save_answer', JSON.stringify({ id: testId, version: attempt.attempt.version, question_id: 'choice', answer: 'a' })])
    await fx.rpc(ids.studentA, 'xelay_teaching_test_mutate', ['finish', JSON.stringify({ id: testId, version: attempt.attempt.version })])
    await db.query("update teaching_tests set closes_at=clock_timestamp()-interval'1 second' where id=$1", [testId])
    const result = await call('insights', { scope: { ...scope, testId } })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const report = result.body.report
    assert.equal(report.test.ready, true); assert.equal(report.test.submitted, 1)
    assert.equal(report.questions.find(q => q.kind === 'choice').mistakes, 1)
    assert.equal(report.questions.find(q => q.kind === 'essay').mistakes, 0)
    assert.equal(report.questions.find(q => q.kind === 'essay').pendingReview, 1)
    assert.equal(report.learners.length, 1); assert.equal(report.learners[0].weak.length, 1)
    original = await counts()
  })
  await t.test('model analysis has pseudonymous learners and no profile names, while teacher keeps the mapping', async () => {
    const r = req('insights', { testId }), generated = await call('generate', { request: r })
    assert.equal(generated.status, 200, JSON.stringify(generated.body)); analysisId = r.requestId
    const payload = model.calls.filter(c => c.url.endsWith('/responses')).at(-1).payload
    const context = JSON.parse(payload.input[0].content[0].text).context
    assert.equal(context.learners.length, 1); assert.equal(context.learners[0].name, undefined)
    assert.match(context.learners[0].code, /^S-/); assert.equal(JSON.stringify(context).includes(ids.studentA), false)
    assert.equal(context.questions.find(q => q.kind === 'essay').mistakes, 0)
    assert.deepEqual(await counts(), original)
    await assert.rejects(fx.ownerCall('xelay_teacher_ai_draft', [analysisId], ids.otherTeacher), e => e.code === '42501')
  })
  await t.test('conversation feeds authoring; accepted variants become one private test for both groups exactly once', async () => {
    await fx.createPaidTeacher('teacher_max')
    const chat = await call('generate', { request: req('chat', { courseId: '', groupIds: [], prompt: 'Use the supplied synthetic tasks and ask me to clarify the conditions.' }) })
    assert.equal(chat.status, 200)
    const generated = await call('generate', { request: req('variants', { groupIds: groups, variantCount: 2, questionCount: 2, parentId: chat.body.draft.id }) })
    assert.equal(generated.status, 200, JSON.stringify(generated.body))
    const d = generated.body.draft
    const conditions = { opensAt: new Date(Date.now()+3600000).toISOString(), closesAt: new Date(Date.now()+7200000).toISOString(), durationSeconds: 1200, allowSkip: true, allowReturn: true, restrictTabSwitch: true, requireAccessCode: true, shuffleQuestions: true, shuffleAnswers: true }
    assert.equal((await call('create_test', { draftId: d.id, conditions })).status, 403, 'unaccepted content cannot become a test')
    const accepted = await call('save_draft', { save: { id: d.id, expectedRevision: d.revision, bundle: { ...d.bundle, testConditions: conditions }, teacherNotes: 'Verified synthetic test', status: 'accepted' } })
    if (accepted.status !== 200) await fx.ownerCall('xelay_teacher_ai_draft_save', [d.id, d.revision, d.bundle, 'Verified synthetic test', 'accepted'])
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.deepEqual(accepted.body.draft.bundle.testConditions, conditions)
    assert.deepEqual((await fx.ownerCall('xelay_teacher_ai_draft', [d.id])).bundle.testConditions, conditions)
    assert.equal((await call('create_test', { draftId: d.id, conditions: { ...conditions, status: 'published' } })).status, 400)
    const saved = await call('create_test', { draftId: d.id, conditions })
    if (saved.status !== 200) await fx.ownerCall('xelay_teacher_ai_create_test', [d.id, conditions])
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const row = (await db.query('select*from teaching_tests where id=$1', [saved.body.testId])).rows[0]
    assert.equal(row.status, 'draft'); assert.equal(row.targets.length, 2); assert.equal(row.duration_seconds, 1200)
    assert.equal(row.questions.length, 2); assert.equal(row.questions[0].answer, 'option-1')
    const replay = await call('create_test', { draftId: d.id, conditions })
    assert.equal(replay.body.replayed, true); assert.equal(replay.body.testId, saved.body.testId)
    assert.equal((await call('create_test', { draftId: d.id, conditions: { ...conditions, durationSeconds: 300 } })).status, 409)
    assert.equal((await call('create_test', { draftId: d.id, conditions }, ids.otherTeacher)).status, 403)
    assert.deepEqual(await counts(), original, 'new private test does not mutate any attempt or grade')
  })
  await t.test('only owner can schedule, list and cancel; retries are idempotent and due notification dispatch is private', async () => {
    const id = randomUUID(), payload = { id, title: 'Check synthetic work', dueAt: new Date(Date.now()+120000).toISOString() }
    assert.equal((await call('reminders', { operation: 'create', payload }, ids.studentA)).status, 403)
    const created = await call('reminders', { operation: 'create', payload })
    assert.equal(created.status, 200, JSON.stringify(created.body)); assert.equal(created.body.reminders.length, 1)
    assert.equal((await call('reminders', { operation: 'create', payload })).body.reminders.length, 1)
    assert.equal((await call('reminders', { operation: 'list', payload: {} }, ids.otherTeacher)).body.reminders.length, 0)
    await call('reminders', { operation: 'cancel', payload: { id } }, ids.otherTeacher)
    assert.equal((await call('reminders', { operation: 'list', payload: {} })).body.reminders[0].state, 'pending')
    await db.query("update xelay_teacher_private.reminders set due_at=clock_timestamp()-interval'1 second'where id=$1", [id])
    assert.equal((await db.query('select xelay_teacher_private.dispatch_reminders()n')).rows[0].n, 1)
    assert.equal((await db.query('select xelay_teacher_private.dispatch_reminders()n')).rows[0].n, 0)
    const n = (await db.query("select*from notifications where type='teacher_assistant_organizer_reminder'")).rows
    assert.equal(n.length, 1); assert.equal(n[0].recipient_id, ids.owner)
    const access = (await db.query("select has_function_privilege('authenticated','xelay_teacher_private.dispatch_reminders()','execute')run,has_table_privilege('authenticated','xelay_teacher_private.reminders','select')read,has_table_privilege('authenticated','xelay_teacher_private.test_exports','insert')write")).rows[0]
    assert.deepEqual(access, { run: false, read: false, write: false })
    const cancelled = randomUUID()
    await call('reminders', { operation: 'create', payload: { ...payload, id: cancelled } })
    await call('reminders', { operation: 'cancel', payload: { id: cancelled } })
    assert.equal((await db.query('select state from xelay_teacher_private.reminders where id=$1', [cancelled])).rows[0].state, 'cancelled')
  })
  await t.test('saved analysis survives paid expiry, but revoked group permission immediately hides it', async () => {
    await db.query("update xelay_teacher_private.grants set revoked_at=clock_timestamp()where user_id=$1", [ids.owner])
    assert.equal((await call('history')).body.drafts.some(d => d.id === analysisId), true)
    await db.query("update teaching_course_groups set status='rejected'where course_id=$1 and group_id=$2", [ids.course, groups[0]])
    assert.equal((await call('history')).body.drafts.some(d => d.id === analysisId), false)
    assert.deepEqual(await counts(), original)
  })
})
