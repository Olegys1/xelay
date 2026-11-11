import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { personalRetakesFixture, syntheticRetakeJpeg } from './teaching-test-personal-retakes-fixture.mjs'

const forbidden = /TEST_(?:FORBIDDEN|RETAKE|INVALID|CONFLICT|NOT_OPEN|NOT_ADMITTED|IMMUTABLE|ATTEMPT_CHANGED)|TEACHING_(?:FORBIDDEN|GROUP_FORBIDDEN|ACCESS|ACTOR_CHANGED)/
const attemptRow = async (fx, id) => (await fx.db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [id])).rows[0].state

test('personal retakes retain original attempts, isolate recipients and publish only the best result in the original journal column', async t => {
  const fx = await personalRetakesFixture()
  t.after(() => fx.close())
  const { db, ids, groups, testMutate: act, testDetail: detail, testList: list } = fx
  const childGrant = response => {
    const grants = response.test.retake_grants
    assert.ok(Array.isArray(grants) && grants.length > 0, 'grant response must retain the original test and expose its staff-only grants')
    return grants[grants.length - 1]
  }
  async function fields(parentId, source, overrides = {}) {
    const parent = await detail(ids.owner, parentId)
    return { id: parentId, version: parent.test.version, expected_user_id: ids.owner,
      request_id: randomUUID(), user_id: ids.studentA, group_id: groups[0], source_attempt_id: source,
      variant_choice: 'random', opens_at: new Date(Date.now() - 1000).toISOString(),
      closes_at: new Date(Date.now() + 3600000).toISOString(), duration_seconds: 1200,
      confirm_retake: true, ...overrides }
  }
  async function grant(parentId, source, overrides = {}) {
    const payload = await fields(parentId, source, overrides)
    const response = await act(ids.owner, 'grant_retake', payload)
    assert.equal(response.test.id, parentId)
    return { payload, response, grant: childGrant(response), childId: childGrant(response).child_test_id }
  }
  async function publishChild(id) {
    const ready = await fx.finalize(id)
    const attempt = ready.attempts.find(row => row.user_id === ids.studentA)
    return act(ids.owner, 'publish_retake', { id, version: ready.test.version,
      expected_grade_version: attempt.current_grade?.version ?? 0, confirm_retake_publish: true })
  }
  const original = await fx.createTest()
  const submitted = await fx.complete(ids.studentA, original.definition.id, { correctCount: 1 })
  const oldAttemptId = submitted.attempt.id
  await fx.publishOriginal(original.definition.id)
  const originalGrade = await fx.grade(original.definition.id)
  assert.equal(originalGrade.published_score_number, 5)
  const originalAttempt = await attemptRow(fx, oldAttemptId)
  const originalJournal = await fx.journalState()
  const moduleItem = { id: randomUUID(), resource_type: 'test', resource_id: original.definition.id,
    required: true, completion: 'passed', pass_percent: 60, prerequisite_item_ids: [], position: 0 }
  const module = { id: randomUUID(), course_id: ids.course, title: 'Synthetic retake module', description: '',
    status: 'published', group_ids: [groups[0]], position: 0, version: 0, prerequisite_item_ids: [], items: [moduleItem] }
  const saveModule = value => fx.rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify({ ...value, expected_user_id: ids.owner })])
  await saveModule(module)
  const moduleProgress = async () => {
    const data = await fx.rpc(ids.studentA, 'xelay_student_course_modules', [ids.course, groups[0]])
    return data.modules.flatMap(row => row.items).find(row => row.id === moduleItem.id)
  }
  assert.equal((await moduleProgress()).completed, false, 'published 50% cannot satisfy a 60% module threshold')
  let fixed

  await t.test('only current teachers for the student group may grant, with explicit confirmation and a valid source attempt', async () => {
    await db.query(`insert into teaching_course_teachers(course_id,user_id,permissions,status,invited_by,group_scope,group_ids)
      values($1,$2,array['assignments','grades'],'accepted',$3,'selected',$4::uuid[]),
            ($1,$5,array['grades'],'accepted',$3,'selected',$6::uuid[])`,
    [ids.course, ids.colleague, ids.owner, '{' + groups[1] + '}', ids.otherTeacher, '{' + groups[0] + '}'])
    const payload = await fields(original.definition.id, oldAttemptId)
    await assert.rejects(fx.rpc(ids.owner, 'xelay_teaching_test_mutate', ['grant_retake',
      JSON.stringify({ ...payload, expected_user_id: ids.studentA })]), /ACTOR_CHANGED/)
    await assert.rejects(fx.rpc(ids.studentA, 'xelay_teaching_test_mutate', ['grant_retake',
      JSON.stringify({ ...payload, expected_user_id: ids.owner })]), /ACTOR_CHANGED/)
    for (const actor of [ids.studentA, ids.headA, ids.outsider, ids.colleague, ids.otherTeacher]) {
      await assert.rejects(act(actor, 'grant_retake', payload), forbidden)
    }
    for (const change of [
      { confirm_retake: false }, { confirm_retake: undefined }, { source_attempt_id: randomUUID() },
      { user_id: ids.headA }, { group_id: groups[1] }, { variant_choice: 'unknown_variant' },
      { variant_choice: null }, { opens_at: payload.closes_at }, { duration_seconds: 1 },
      { duration_seconds: 1200.5 }, { duration_seconds: 86401 },
    ]) await assert.rejects(act(ids.owner, 'grant_retake', { ...payload, ...change }), forbidden)
    assert.deepEqual(await attemptRow(fx, oldAttemptId), originalAttempt)
    assert.deepEqual(await fx.journalState(), originalJournal)
  })

  await t.test('one explicit grant is idempotent, recipient-private and adds no journal column or grade', async () => {
    fixed = await grant(original.definition.id, oldAttemptId, { variant_choice: 'chapter_c' })
    assert.ok(fixed.childId && fixed.childId !== original.definition.id)
    assert.equal(fixed.grant.retake_number, 2)
    const replay = await act(ids.owner, 'grant_retake', fixed.payload)
    assert.equal(childGrant(replay).child_test_id, fixed.childId)
    await assert.rejects(act(ids.owner, 'grant_retake', { ...fixed.payload, variant_choice: 'base' }), forbidden)
    await assert.rejects(act(ids.owner, 'grant_retake', await fields(original.definition.id, oldAttemptId)), forbidden)
    assert.deepEqual(await attemptRow(fx, oldAttemptId), originalAttempt)
    assert.deepEqual(await fx.journalState(), originalJournal)
    for (const other of [ids.headA, ids.studentB, ids.outsider, ids.colleague]) {
      assert.equal((await list(other)).tests.some(row => row.id === fixed.childId), false)
      await assert.rejects(detail(other, fixed.childId), forbidden)
      await assert.rejects(act(other, 'start', { id: fixed.childId, group_id: groups[0] }), forbidden)
    }
    const beforeModuleFence = (await db.query(`select
      public.xelay_private_test_allows_before_modules_20261104(t,$2,$3) as intended,
      public.xelay_private_test_allows_before_modules_20261104(t,$4,$3) as peer
      from teaching_tests t where id=$1`, [fixed.childId, ids.studentA, groups[0], ids.headA])).rows[0]
    assert.deepEqual(beforeModuleFence, { intended: true, peer: false })
    const notes = async () => (await db.query(`select recipient_id,teaching_event_key from notifications
      where teaching_event_key like '%'||$1||'%' order by id`, [fixed.childId])).rows
    const notices = await notes()
    assert.equal(notices.length, 1, 'only one publication notice is created for the personal opportunity')
    assert.ok(notices.every(row => row.recipient_id === ids.studentA))
    await act(ids.owner, 'grant_retake', fixed.payload)
    assert.deepEqual(await notes(), notices, 'replaying a grant cannot resend notices')
    const child = await detail(ids.owner, fixed.childId)
    assert.equal(child.test.is_personal_retake, true)
    assert.equal(child.test.retake_parent_id, original.definition.id)
    assert.equal(child.test.bonus_percent, 0)
    assert.equal(child.test.bonus_points, 0)
    assert.equal(child.test.can_edit, false)
    await assert.rejects(act(ids.owner, 'save_test', { ...child.test, title: 'Changed private opportunity' }), forbidden)
    await assert.rejects(db.query('delete from teaching_tests where id=$1', [original.definition.id]), /foreign key|violates.*constraint/,
      'deleting a parent must not orphan its published child and remove the recipient fence')
    await assert.rejects(detail(ids.headA, fixed.childId), forbidden)
    const resources = await fx.rpc(ids.owner, 'xelay_teaching_course_modules', [ids.course])
    assert.ok(!JSON.stringify(resources.resources).includes(fixed.childId), 'personal opportunities must not be selectable as group module resources')
    await assert.rejects(saveModule({ ...module, id: randomUUID(), version: 0,
      items: [{ ...moduleItem, id: randomUUID(), resource_id: fixed.childId }] }), /COURSE_MODULE_(?:PRIVATE_RETAKE|INVALID|FORBIDDEN)/)
  })

  await t.test('fixed variants retain original authored identity, one stable snapshot and no private key leakage', async () => {
    let student = await act(ids.studentA, 'start', { id: fixed.childId, group_id: groups[0] })
    const issued = student.attempt
    assert.equal(issued.attempt_number, 2)
    assert.equal(issued.current_question.answer, undefined)
    assert.equal(student.test.variants, undefined)
    assert.equal(student.test.base_variant_title, undefined)
    assert.ok(issued.current_question.id.startsWith('c_'))
    const resume = await act(ids.studentA, 'start', { id: fixed.childId, group_id: groups[0] })
    assert.equal(resume.attempt.id, issued.id)
    assert.deepEqual(resume.attempt.current_question, issued.current_question)
    const teacher = (await detail(ids.owner, fixed.childId)).attempts[0]
    assert.equal(teacher.variant_number, 3)
    assert.equal(teacher.variant_title, 'Додатковий набір В')
    assert.equal(teacher.variant_id, 'chapter_c')
    const frozen = await attemptRow(fx, oldAttemptId)
    // Old parent tabs keep addressing the old test. They cannot act on the
    // newly issued child even when the attempt version and option IDs match.
    await act(ids.studentA, 'finish', { id: original.definition.id, attempt_id: oldAttemptId, version: 1 })
    for (const action of ['save_answer', 'navigate', 'finish']) {
      const payload = { id: fixed.childId, attempt_id: oldAttemptId, version: issued.version,
        question_id: issued.current_question.id, answer: 'a', index: 1 }
      await assert.rejects(act(ids.studentA, action, payload), forbidden)
    }
    const legacySave = await act(ids.studentA, 'save_answer', { id: fixed.childId, version: issued.version,
      question_id: issued.current_question.id, answer: 'a' })
    assert.equal(legacySave.attempt.id, issued.id, 'cached clients without attempt_id retain their one canonical child attempt')
    assert.deepEqual(await attemptRow(fx, oldAttemptId), frozen)
    assert.equal((await detail(ids.studentA, fixed.childId)).attempt.status, 'in_progress')
    await assert.rejects(act(ids.owner, 'grant_retake', await fields(original.definition.id, issued.id)), forbidden)
    student = await fx.complete(ids.studentA, fixed.childId)
    assert.equal(student.attempt.status, 'submitted')
  })

  await t.test('publication needs completed approved review and explicit confirmation, then updates only the original column', async () => {
    let child = await detail(ids.owner, fixed.childId)
    const before = await fx.journalState()
    await assert.rejects(act(ids.studentA, 'publish_retake', { id: fixed.childId, version: child.test.version,
      expected_grade_version: originalGrade.version, confirm_retake_publish: true }), forbidden)
    await assert.rejects(act(ids.owner, 'publish_retake', { id: fixed.childId, version: child.test.version,
      expected_grade_version: originalGrade.version, confirm_retake_publish: true }), /TEST_.*(?:REVIEW|READY|IMMUTABLE)/)
    child = await fx.finalize(fixed.childId)
    for (const confirm of [undefined, false]) await assert.rejects(act(ids.owner, 'publish_retake', { id: fixed.childId,
      version: child.test.version, expected_grade_version: originalGrade.version, confirm_retake_publish: confirm }), forbidden)
    assert.deepEqual(await fx.journalState(), before)
    await publishChild(fixed.childId)
    const best = await fx.grade(original.definition.id)
    assert.equal(best.id, originalGrade.id)
    assert.equal(best.activity_id, originalGrade.activity_id)
    assert.equal(best.published_score_number, 10)
    assert.equal((await db.query('select count(*)::int n from teaching_activities')).rows[0].n, originalJournal.activities.length)
    assert.equal((await db.query('select count(*)::int n from teaching_test_activities where test_id=$1', [fixed.childId])).rows[0].n, 0)
    assert.deepEqual(await attemptRow(fx, oldAttemptId), originalAttempt)
    assert.equal((await detail(ids.studentA, original.definition.id)).attempt.published_score, 5, 'the original attempt keeps its own published outcome')
    assert.equal((await detail(ids.studentA, original.definition.id)).attempt.published_comment, originalGrade.published_comment,
      'the original attempt retains its own published feedback rather than borrowing a retake comment')
    const ownRoot = await detail(ids.studentA, original.definition.id)
    const ownHistory = ownRoot.attempt_history.find(a => a.id === oldAttemptId)
    assert.equal(ownHistory.published_score, 5)
    assert.equal(ownHistory.published_comment, originalGrade.published_comment)
    assert.equal(ownRoot.test.my_attempt.published_score, 10, 'the root summary deliberately shows the overall best published grade')
    assert.equal((await list(ids.studentA)).tests.find(row => row.id === original.definition.id).my_attempt.published_score, 10)
    assert.doesNotMatch(JSON.stringify(ownRoot.attempt_history), /"(?:questions|answers|question_reviews|current_grade|grade_snapshot)"/,
      'history metadata does not re-issue old question keys or answers')
    assert.equal((await detail(ids.studentA, fixed.childId)).attempt.published_score, 10)
    assert.equal((await moduleProgress()).completed, true, 'best published retake unlocks the original module condition')
    assert.equal((await moduleProgress()).score, 10)
  })

  await t.test('a lower repeated result publishes its own history without reducing the best grade or creating a duplicate sum', async () => {
    const firstChildAttempt = (await detail(ids.owner, fixed.childId)).attempts[0]
    const second = await grant(original.definition.id, firstChildAttempt.id, { variant_choice: 'base' })
    assert.equal(second.grant.retake_number, 3)
    await fx.complete(ids.studentA, second.childId, { correctCount: 0 })
    const before = await fx.grade(original.definition.id)
    await publishChild(second.childId)
    assert.deepEqual(await fx.grade(original.definition.id), before)
    assert.equal((await detail(ids.studentA, second.childId)).attempt.published_score, 0)
    assert.equal((await detail(ids.studentA, fixed.childId)).attempt.published_score, 10)
    const named = (await detail(ids.owner, second.childId)).attempts[0]
    assert.equal(named.variant_number, 1)
    assert.equal(named.variant_title, 'Основний набір')
    assert.equal((await db.query('select count(*)::int n from teaching_activities')).rows[0].n, originalJournal.activities.length)
    assert.equal((await fx.grade(original.definition.id)).published_score_number, 10)
    assert.equal((await moduleProgress()).completed, true, 'a worse retake cannot revoke completed module progress')
    assert.equal((await moduleProgress()).score, 10)
    assert.ok(!JSON.stringify(await detail(ids.headA, original.definition.id)).includes(second.childId), 'peer history must not enumerate personal opportunities')
  })

  await t.test('retake tables and private bypass helpers remain inaccessible directly to client roles', async () => {
    const relations = (await db.query(`select c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'select,insert,update,delete') as anon,
      has_table_privilege('authenticated',c.oid,'select,insert,update,delete') as authenticated,
      has_table_privilege('service_role',c.oid,'select,insert,update,delete') as service
      from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
        and c.relname in('teaching_test_retake_grants','teaching_test_attempt_publications')`)).rows
    assert.equal(relations.length, 2)
    for (const row of relations) assert.deepEqual(row, { relname: row.relname, relrowsecurity: true, anon: false, authenticated: false, service: false })
    const bypass = (await db.query(`select proname from pg_proc where pronamespace='public'::regnamespace
      and proname like '%retake%' and (has_function_privilege('anon',oid,'execute')
        or has_function_privilege('authenticated',oid,'execute') or has_function_privilege('service_role',oid,'execute'))`)).rows
    assert.deepEqual(bypass, [])
  })

  await t.test('random retakes choose an original authored variant once, then freeze that identity and allow explicit replay only', async () => {
    const parent = await fx.createTest()
    const first = await fx.complete(ids.studentA, parent.definition.id, { correctCount: 1 })
    await fx.publishOriginal(parent.definition.id)
    const issued = await grant(parent.definition.id, first.attempt.id)
    const run = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })
    const staff = (await detail(ids.owner, issued.childId)).attempts[0]
    const expected = staff.variant_number === 1 ? parent.definition.questions : parent.definition.variants[staff.variant_number - 2].questions
    assert.ok([1, 2, 3].includes(staff.variant_number))
    assert.deepEqual(staff.questions.map(q => q.id).sort(), expected.map(q => q.id).sort())
    assert.equal(staff.variant_title, staff.variant_number === 1 ? parent.definition.base_variant_title : parent.definition.variants[staff.variant_number - 2].title)
    assert.equal(staff.variant_id, staff.variant_number === 1 ? null : parent.definition.variants[staff.variant_number - 2].id)
    const frozen = await attemptRow(fx, run.attempt.id)
    for (let retry = 0; retry < 3; retry++) assert.equal((await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })).attempt.id, run.attempt.id)
    assert.deepEqual(await attemptRow(fx, run.attempt.id), frozen)
    await fx.complete(ids.studentA, issued.childId)
    await publishChild(issued.childId)
    const publishedState = await fx.journalState()
    const child = await detail(ids.owner, issued.childId)
    await act(ids.owner, 'publish_retake', { id: issued.childId, version: child.test.version - 1,
      expected_grade_version: 0, confirm_retake_publish: true })
    assert.deepEqual(await fx.journalState(), publishedState, 'an explicit publication retry cannot add another grade/audit record')
    await assert.rejects(act(ids.owner, 'save_review', { id: issued.childId, attempt_id: run.attempt.id,
      version: child.attempts[0].version, marks: [] }), forbidden)
  })

  await t.test('authored variant IDs that resemble selection modes are selected explicitly without changing original identity', async () => {
    const input = fx.definition()
    input.variants = input.variants.map((v, i) => ({ ...v, id: i === 0 ? 'base' : 'random' }))
    await act(ids.owner, 'save_test', input)
    const first = await fx.complete(ids.studentA, input.id)
    const fixedBase = await grant(input.id, first.attempt.id, { variant_choice: 'variant:base' })
    const second = await fx.complete(ids.studentA, fixedBase.childId)
    let view = (await detail(ids.owner, fixedBase.childId)).attempts[0]
    assert.equal(view.variant_id, 'base')
    assert.equal(view.variant_number, 2)
    assert.ok(view.questions.every(q => q.id.startsWith('b_')))
    const fixedRandom = await grant(input.id, second.attempt.id, { variant_choice: 'variant:random' })
    await fx.complete(ids.studentA, fixedRandom.childId)
    view = (await detail(ids.owner, fixedRandom.childId)).attempts[0]
    assert.equal(view.variant_id, 'random')
    assert.equal(view.variant_number, 3)
    assert.ok(view.questions.every(q => q.id.startsWith('c_')))
  })

  await t.test('unpublished manual journal work and changed grade versions block publication atomically', async () => {
    const parent = await fx.createTest()
    const first = await fx.complete(ids.studentA, parent.definition.id, { correctCount: 1 })
    await fx.publishOriginal(parent.definition.id)
    const issued = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'base' })
    await fx.complete(ids.studentA, issued.childId)
    let cell = await fx.grade(parent.definition.id)
    await fx.mutate(ids.owner, 'save_grade', { activity_id: cell.activity_id, entry_id: cell.entry_id,
      version: cell.version, score: 5, absent: false, comment: 'PRIVATE_PENDING_MANUAL_FEEDBACK', reason: 'Synthetic teacher edit' })
    let child = await fx.finalize(issued.childId)
    cell = await fx.grade(parent.definition.id)
    const before = await fx.journalState()
    const payload = { id: issued.childId, version: child.test.version,
      expected_grade_version: cell.version, confirm_retake_publish: true }
    await assert.rejects(fx.rpc(ids.owner, 'xelay_teaching_test_mutate', ['publish_retake',
      JSON.stringify({ ...payload, expected_user_id: ids.studentA })]), /ACTOR_CHANGED/)
    await assert.rejects(fx.rpc(ids.studentA, 'xelay_teaching_test_mutate', ['publish_retake',
      JSON.stringify({ ...payload, expected_user_id: ids.owner })]), /ACTOR_CHANGED/)
    await assert.rejects(act(ids.owner, 'publish_retake', payload), /TEST_RETAKE_PENDING_GRADE/)
    assert.deepEqual(await fx.journalState(), before)
    assert.equal((await detail(ids.studentA, issued.childId)).attempt.published_score, undefined)
    await fx.mutate(ids.owner, 'publish_grades', { activity_id: cell.activity_id,
      expected_versions: [{ entry_id: cell.entry_id, version: cell.version }] })
    cell = await fx.grade(parent.definition.id)
    await assert.rejects(act(ids.owner, 'publish_retake', { ...payload, expected_grade_version: cell.version }), /TEST_GRADE_CONFLICT/)
    child = await fx.finalize(issued.childId)
    await act(ids.owner, 'publish_retake', { ...payload, version: child.test.version, expected_grade_version: cell.version })
    assert.equal((await fx.grade(parent.definition.id)).published_score_number, 10)
  })

  await t.test('expired unused opportunities keep their private fence and do not consume another attempt number', async () => {
    const parent = await fx.createTest()
    const first = await fx.complete(ids.studentA, parent.definition.id)
    const stale = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'chapter_b' })
    await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second' where id=$1", [stale.childId])
    const next = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'base' })
    assert.equal(next.grant.retake_number, 2)
    assert.ok((await db.query('select revoked_at from teaching_test_retake_grants where child_test_id=$1', [stale.childId])).rows[0].revoked_at)
    await assert.rejects(detail(ids.studentA, stale.childId), forbidden)
    await assert.rejects(detail(ids.headA, stale.childId), forbidden)
    assert.ok((await list(ids.studentA)).tests.some(row => row.id === next.childId))
    assert.ok(!(await list(ids.headA)).tests.some(row => row.id === next.childId || row.id === stale.childId))
  })

  await t.test('automatic re-transfer retains ledger best while explicit manual journal edits remain possible', async () => {
    const parent = await fx.createTest()
    const first = await fx.complete(ids.studentA, parent.definition.id, { correctCount: 1 })
    await fx.publishOriginal(parent.definition.id)
    const better = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'chapter_b' })
    await fx.complete(ids.studentA, better.childId)
    await publishChild(better.childId)
    let staff = await detail(ids.owner, parent.definition.id)
    const old = staff.attempts.find(a => a.user_id === ids.studentA)
    await act(ids.owner, 'save_review', { id: parent.definition.id, attempt_id: old.id, version: old.version,
      marks: old.questions.map(q => ({ question_id: q.id, mode: 'zero', reason: 'Synthetic correction of original review' })) })
    staff = await fx.finalize(parent.definition.id)
    assert.equal(staff.attempts[0].final_score, 0)
    await act(ids.owner, 'review_results', { id: parent.definition.id, version: staff.test.version })
    let cell = await fx.grade(parent.definition.id)
    assert.equal(cell.draft_score_number, 10, 'routine transfer cannot overwrite a higher explicitly published retake')
    await fx.mutate(ids.owner, 'publish_grades', { activity_id: cell.activity_id,
      expected_versions: [{ entry_id: cell.entry_id, version: cell.version }] })
    cell = await fx.grade(parent.definition.id)
    assert.equal(cell.published_score_number, 10)
    await fx.mutate(ids.owner, 'save_grade', { activity_id: cell.activity_id, entry_id: cell.entry_id,
      version: cell.version, score: 2, absent: false, comment: 'Synthetic explicit manual correction', reason: 'Deliberate manual journal override' })
    cell = await fx.grade(parent.definition.id)
    await fx.mutate(ids.owner, 'publish_grades', { activity_id: cell.activity_id,
      expected_versions: [{ entry_id: cell.entry_id, version: cell.version }] })
    assert.equal((await fx.grade(parent.definition.id)).published_score_number, 2, 'ordinary reasoned manual journal edits retain their existing behavior')
    const latest = (await detail(ids.owner, better.childId)).attempts[0]
    const lower = await grant(parent.definition.id, latest.id, { variant_choice: 'base' })
    await fx.complete(ids.studentA, lower.childId, { correctCount: 0 })
    await publishChild(lower.childId)
    assert.equal((await fx.grade(parent.definition.id)).published_score_number, 10, 'next test publication remembers the ledger maximum, not just a newer low manual value')
    assert.equal((await detail(ids.studentA, lower.childId)).attempt.published_score, 0)
    assert.equal((await detail(ids.studentA, better.childId)).attempt.published_score, 10)
  })

  await t.test('the same student in two targeted groups keeps each journal cell and its drafts separate', async () => {
    await db.query(`insert into study_group_members(group_id,user_id,invited_by,status,accepted_at)
      values($1,$2,$3,'accepted',now())`, [groups[1], ids.studentA, ids.headB])
    try {
      const parent = await fx.createTest({ targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })) })
      const first = await fx.complete(ids.studentA, parent.definition.id, { correctCount: 0 })
      await db.query(`insert into teaching_entries(course_id,group_id,user_id,full_name) values($1,$2,$3,'Synthetic dual-group student')
        on conflict do nothing`, [ids.course, groups[1], ids.studentA])
      const otherEntry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, groups[1], ids.studentA])).rows[0].id
      const otherActivity = (await db.query('select activity_id from teaching_test_activities where test_id=$1 and group_id=$2', [parent.definition.id, groups[1]])).rows[0].activity_id
      let other = await fx.mutate(ids.owner, 'save_grade', { activity_id: otherActivity, entry_id: otherEntry,
        version: 0, score: 10, absent: false, comment: 'Synthetic other-group result', reason: '' })
      await fx.mutate(ids.owner, 'publish_grades', { activity_id: otherActivity, expected_versions: [{ entry_id: otherEntry, version: other.version }] })
      other = (await db.query('select * from teaching_grades where activity_id=$1 and entry_id=$2', [otherActivity, otherEntry])).rows[0]
      await fx.publishOriginal(parent.definition.id)
      await fx.mutate(ids.owner, 'save_grade', { activity_id: otherActivity, entry_id: otherEntry,
        version: other.version, score: 7, absent: false, comment: 'PRIVATE_OTHER_GROUP_PENDING', reason: 'Synthetic independent draft' })
      const frozenOther = (await db.query('select to_jsonb(g) state from teaching_grades g where activity_id=$1 and entry_id=$2', [otherActivity, otherEntry])).rows[0].state
      const issued = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'base' })
      await fx.complete(ids.studentA, issued.childId, { correctCount: 1 })
      await publishChild(issued.childId)
      assert.equal((await fx.grade(parent.definition.id)).published_score_number, 5, 'another group cannot supply a higher score to this attempt')
      assert.deepEqual((await db.query('select to_jsonb(g) state from teaching_grades g where activity_id=$1 and entry_id=$2', [otherActivity, otherEntry])).rows[0].state,
        frozenOther, 'an unrelated group draft remains untouched and cannot block publication here')
    } finally { await db.query('delete from study_group_members where group_id=$1 and user_id=$2', [groups[1], ids.studentA]) }
  })

  await t.test('required access code, tab protection and child identifiers remain scoped throughout a repeat attempt', async () => {
    const parent = await fx.createTest({ require_access_code: true, restrict_tab_switch: true, discourage_capture: true })
    const rootCode = (await act(ids.owner, 'read_access_code', { id: parent.definition.id })).access_code.current
    const first = await fx.complete(ids.studentA, parent.definition.id, { accessCode: rootCode })
    const issued = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'base' })
    const noCode = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })
    assert.equal(noCode.access_error, 'TEST_CODE_INVALID')
    assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1', [issued.childId])).rows[0].n, 0)
    const rotated = await act(ids.owner, 'rotate_access_code', { id: issued.childId })
    assert.notEqual(rotated.access_code.current, rootCode)
    assert.equal((await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0], access_code: rootCode })).access_error, 'TEST_CODE_INVALID')
    let run = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0], access_code: rotated.access_code.current })
    assert.equal(run.attempt.attempt_number, 2)
    await act(ids.owner, 'rotate_access_code', { id: issued.childId })
    assert.equal((await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })).attempt.id, run.attempt.id,
      'rotating the code cannot interrupt an already started attempt')
    await assert.rejects(act(ids.studentA, 'record_tab_exit', { id: issued.childId, attempt_id: first.attempt.id, event_id: randomUUID() }), forbidden)
    await act(ids.studentA, 'record_tab_exit', { id: parent.definition.id, attempt_id: first.attempt.id, event_id: randomUUID() })
    assert.equal((await detail(ids.studentA, issued.childId)).attempt.tab_exit_count, 0)
    const event = randomUUID()
    run = await act(ids.studentA, 'record_tab_exit', { id: issued.childId, attempt_id: run.attempt.id, event_id: event })
    assert.equal(run.attempt.tab_exit_count, 1)
    run = await act(ids.studentA, 'record_tab_exit', { id: issued.childId, attempt_id: run.attempt.id, event_id: event })
    assert.equal(run.attempt.tab_exit_count, 1, 'a replayed visibility event is not another violation')
    run = await act(ids.studentA, 'record_tab_exit', { id: issued.childId, attempt_id: run.attempt.id, event_id: randomUUID() })
    assert.equal(run.attempt.status, 'submitted')
    assert.equal((await attemptRow(fx, run.attempt.id)).completion_reason, 'tab_switch')
    assert.equal((await attemptRow(fx, first.attempt.id)).tab_exit_events.length, 0)
  })

  await t.test('manual answers require a reviewed rubric before a private repeat result can be published', async () => {
    const essay = { id: 'essay', kind: 'essay', text: 'Synthetic explanation', points: 10, time_limit_seconds: null,
      partial_credit: false, options: [], buckets: [], rubric: { criteria: [{ id: 'reason', title: 'Reasoning',
        levels: [{ id: 'none', label: 'Missing', points: 0 }, { id: 'half', label: 'Partial', points: 5 }, { id: 'full', label: 'Complete', points: 10 }] }] } }
    const parent = await fx.createTest({ questions: [essay], variants: [] })
    const first = await fx.complete(ids.studentA, parent.definition.id)
    let staff = await detail(ids.owner, parent.definition.id)
    await act(ids.owner, 'save_review', { id: parent.definition.id, attempt_id: first.attempt.id, version: staff.attempts[0].version,
      marks: [{ question_id: 'essay', mode: 'custom', reason: 'Synthetic original rubric', rubric_levels: { reason: 'half' } }] })
    await fx.publishOriginal(parent.definition.id)
    const issued = await grant(parent.definition.id, first.attempt.id, { variant_choice: 'base' })
    const finished = await fx.complete(ids.studentA, issued.childId)
    staff = await detail(ids.owner, issued.childId)
    await assert.rejects(publishChild(issued.childId), /TEST_.*(?:REVIEW|READY|REQUIRED)/)
    assert.equal((await fx.grade(parent.definition.id)).published_score_number, 5)
    await assert.rejects(act(ids.owner, 'save_review', { id: issued.childId, attempt_id: finished.attempt.id,
      version: staff.attempts[0].version, marks: [{ question_id: 'essay', mode: 'custom', points: 10, reason: 'Without required rubric' }] }), /RUBRIC_INVALID_INPUT/)
    staff = await detail(ids.owner, issued.childId)
    await act(ids.owner, 'save_review', { id: issued.childId, attempt_id: finished.attempt.id, version: staff.attempts[0].version,
      marks: [{ question_id: 'essay', mode: 'custom', reason: 'Synthetic reviewed repeat rubric', rubric_levels: { reason: 'full' } }] })
    assert.equal((await detail(ids.studentA, issued.childId)).attempt.published_score, undefined)
    await publishChild(issued.childId)
    assert.equal((await detail(ids.studentA, issued.childId)).attempt.published_score, 10)
    assert.equal((await fx.grade(parent.definition.id)).published_score_number, 10)
  })

  await t.test('current-question photos survive fixed retakes without granting peers or future questions access', async () => {
    const pictures = []
    for (let i = 0; i < 4; i++) pictures.push({ id: (await fx.rpc(ids.owner, 'xelay_teaching_test_question_image_upload',
      [ids.course, ids.owner, syntheticRetakeJpeg])).id, mime_type: 'image/jpeg', alt: 'Synthetic diagram' })
    const input = fx.definition()
    input.questions = input.questions.map((q, i) => ({ ...q, images: [pictures[i]] }))
    input.variants[1].questions = input.variants[1].questions.map((q, i) => ({ ...q, images: [pictures[i + 2]] }))
    await act(ids.owner, 'save_test', input)
    const first = await fx.complete(ids.studentA, input.id)
    const issued = await grant(input.id, first.attempt.id, { variant_choice: 'chapter_c' })
    let run = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })
    const read = (who, image) => fx.rpc(who, 'xelay_teaching_test_question_image', [image])
    assert.equal(await read(ids.studentA, pictures[2].id), syntheticRetakeJpeg)
    for (const image of [pictures[0], pictures[1], pictures[3]]) await assert.rejects(read(ids.studentA, image.id), /TEST_FORBIDDEN/)
    await assert.rejects(read(ids.headA, pictures[2].id), /TEST_FORBIDDEN/)
    run = await act(ids.studentA, 'navigate', { id: issued.childId, attempt_id: run.attempt.id, version: run.attempt.version, index: 1 })
    assert.equal(await read(ids.studentA, pictures[3].id), syntheticRetakeJpeg)
    await assert.rejects(read(ids.studentA, pictures[2].id), /TEST_FORBIDDEN/)
    await act(ids.studentA, 'finish', { id: issued.childId, attempt_id: run.attempt.id, version: run.attempt.version })
    await assert.rejects(read(ids.studentA, pictures[3].id), /TEST_FORBIDDEN/)
  })

  await t.test('assignments-only staff may inspect definitions without receiving private grades or history', async () => {
    await db.query("update teaching_course_teachers set permissions=array['assignments'] where course_id=$1 and user_id=$2", [ids.course, ids.otherTeacher])
    const assignmentStaff = await detail(ids.otherTeacher, fixed.childId)
    assert.equal(assignmentStaff.test.retake_published_score, null)
    assert.equal(assignmentStaff.test.retake_best_published_score, null)
    assert.deepEqual(assignmentStaff.attempts, [])
    assert.deepEqual(assignmentStaff.attempt_history, [])
    assert.deepEqual((await detail(ids.otherTeacher, original.definition.id)).test.retake_grants, [])
    await db.query("update teaching_course_teachers set permissions=array['grades'] where course_id=$1 and user_id=$2", [ids.course, ids.otherTeacher])
    const gradesStaff = await detail(ids.otherTeacher, fixed.childId)
    assert.equal(gradesStaff.test.retake_published_score, 10)
    assert.ok(gradesStaff.attempt_history.length > 0)
  })

  await t.test('membership and teacher verification revocation take effect for grants and existing child access', async () => {
    const parent = await fx.createTest()
    const first = await fx.complete(ids.studentA, parent.definition.id)
    const issued = await grant(parent.definition.id, first.attempt.id)
    const run = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })
    const frozen = await attemptRow(fx, run.attempt.id)
    await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2", [groups[0], ids.studentA])
    try {
      await assert.rejects(detail(ids.studentA, issued.childId), forbidden)
      await assert.rejects(act(ids.studentA, 'save_answer', { id: issued.childId, attempt_id: run.attempt.id,
        version: run.attempt.version, question_id: run.attempt.current_question.id, answer: 'b' }), forbidden)
      await assert.rejects(act(ids.owner, 'grant_retake', await fields(parent.definition.id, run.attempt.id)), forbidden)
      assert.deepEqual(await attemptRow(fx, run.attempt.id), frozen)
    } finally { await db.query("update study_group_members set status='accepted' where group_id=$1 and user_id=$2", [groups[0], ids.studentA]) }
    await db.query("update teacher_verification_requests set status='rejected' where user_id=$1", [ids.owner])
    try {
      await assert.rejects(detail(ids.owner, issued.childId), /FORBIDDEN|UNVERIFIED/)
      await assert.rejects(act(ids.owner, 'grant_retake', { ...issued.payload, request_id: randomUUID() }), /FORBIDDEN|UNVERIFIED/)
    } finally { await db.query("update teacher_verification_requests set status='approved' where user_id=$1", [ids.owner]) }
  })

  await t.test('a personal grant cannot outlive the original subgroup audience and revoked reads never erase an active snapshot', async () => {
    const subgroup = { id: randomUUID(), course_id: ids.course, group_id: groups[0], name: 'Synthetic original audience', user_ids: [ids.studentA], version: 0 }
    const saveAudience = payload => fx.rpc(ids.owner, 'xelay_teaching_audience_mutate', ['save_subgroup', JSON.stringify({ ...payload, expected_user_id: ids.owner })])
    await saveAudience(subgroup)
    const image = { id: (await fx.rpc(ids.owner, 'xelay_teaching_test_question_image_upload', [ids.course, ids.owner, syntheticRetakeJpeg])).id,
      mime_type: 'image/jpeg', alt: 'Synthetic audience diagram' }
    const input = fx.definition({ targets: [{ group_id: groups[0], audience_mode: 'subgroups', subgroup_ids: [subgroup.id] }], variants: [] })
    input.questions = input.questions.map(q => ({ ...q, images: [image] }))
    await act(ids.owner, 'save_test', input)
    const first = await fx.complete(ids.studentA, input.id)
    const issued = await grant(input.id, first.attempt.id, { variant_choice: 'base' })
    await saveAudience({ ...subgroup, version: 1, user_ids: [ids.headA] })
    await assert.rejects(detail(ids.studentA, issued.childId), forbidden)
    await assert.rejects(act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] }), forbidden)
    assert.ok(!(await list(ids.studentA)).tests.some(row => row.id === issued.childId))
    await saveAudience({ ...subgroup, version: 2 })
    let run = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })
    run = await act(ids.studentA, 'save_answer', { id: issued.childId, attempt_id: run.attempt.id, version: run.attempt.version,
      question_id: run.attempt.current_question.id, answer: 'b' })
    const frozen = await attemptRow(fx, run.attempt.id)
    assert.equal(await fx.rpc(ids.studentA, 'xelay_teaching_test_question_image', [image.id]), syntheticRetakeJpeg)
    await saveAudience({ ...subgroup, version: 3, user_ids: [ids.headA] })
    await assert.rejects(detail(ids.studentA, issued.childId), forbidden)
    await assert.rejects(fx.rpc(ids.studentA, 'xelay_teaching_test_question_image', [image.id]), /TEST_FORBIDDEN/)
    assert.deepEqual(await attemptRow(fx, run.attempt.id), frozen, 'revocation cannot discard already saved answers or reset timing')
    await saveAudience({ ...subgroup, version: 4 })
    const resumed = await act(ids.studentA, 'start', { id: issued.childId, group_id: groups[0] })
    assert.equal(resumed.attempt.id, run.attempt.id)
    assert.equal(resumed.attempt.expires_at, run.attempt.expires_at)
    assert.equal((await attemptRow(fx, run.attempt.id)).answers[run.attempt.current_question.id], 'b')
  })

  await t.test('genuine isolated QA tests cannot become ordinary personal student retakes', async () => {
    const qa = await fx.createQaTest()
    assert.equal(qa.detail.test.qa_own_attempt, true)
    const start = await fx.rpc(qa.owner, 'xelay_teaching_test_qa', ['start', JSON.stringify({ id: qa.definition.id,
      group_id: qa.group, expected_user_id: qa.owner })])
    const finished = await fx.rpc(qa.owner, 'xelay_teaching_test_qa', ['finish', JSON.stringify({ id: qa.definition.id,
      attempt_id: start.attempt.id, version: start.attempt.version, expected_user_id: qa.owner })])
    const staff = await detail(qa.owner, qa.definition.id)
    await assert.rejects(act(qa.owner, 'grant_retake', { id: qa.definition.id, version: staff.test.version,
      request_id: randomUUID(), user_id: qa.owner, group_id: qa.group, source_attempt_id: finished.attempt.id,
      variant_choice: 'base', opens_at: new Date(Date.now() - 1000).toISOString(), closes_at: new Date(Date.now() + 3600000).toISOString(),
      duration_seconds: 1200, confirm_retake: true }), /TEST_INVALID_INPUT|TEST_QA_FORBIDDEN/)
    assert.equal((await db.query('select count(*)::int n from teaching_test_retake_grants where parent_test_id=$1', [qa.definition.id])).rows[0].n, 0)
  })
})
