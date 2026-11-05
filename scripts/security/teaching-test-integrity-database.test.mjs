import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {courseModulesFixture} from './teaching-course-modules-fixture.mjs'
import {syntheticTest} from './teaching-tests-fixture.mjs'

test('test codes and tab exits are private, persisted, and enforced by the attempt server', async t => {
  const fx = await courseModulesFixture({additionalMigrations: [
    '202611040060_teaching_test_admission.sql',
    '202611050061_teaching_test_explicit_close.sql',
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
  ]})
  t.after(() => fx.close())
  const {ids, groups, rpc, db} = fx
  const mutate = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify({expected_user_id: who, ...payload})])
  const detail = (who, id) => rpc(who, 'xelay_teaching_test', [id])
  const {id, ...definition} = syntheticTest(ids.course, groups, {
    require_access_code: true, restrict_tab_switch: true, discourage_capture: true,
  })
  definition.variants = [{id: 'variant-two', title: 'Варіант 2',
    questions: definition.questions.map(question => ({...question, id: `v2-${question.id}`, text: `Варіант 2. ${question.text}`}))}]
  const start = (who, code, group_id = groups[0]) => mutate(who, 'start', {id, group_id, access_code: code})
  let firstCode, currentCode, attempt

  await t.test('saving code protection creates a code visible only to an authorized editor', async () => {
    await assert.rejects(mutate(ids.owner, 'save_test', {id, ...definition, require_access_code: 'true'}), /TEST_INVALID_INPUT/)
    const saved = await mutate(ids.owner, 'save_test', {id, ...definition})
    assert.equal(saved.test.require_access_code, true)
    assert.equal(saved.test.restrict_tab_switch, true)
    assert.equal(saved.test.discourage_capture, true)
    assert.equal(saved.access_code, undefined)
    const staff = await mutate(ids.owner, 'read_access_code', {id})
    firstCode = staff.access_code.current
    assert.match(firstCode, /^[0-9A-F]{8}$/)
    assert.equal(staff.access_code.previous, null)
    assert.ok(staff.access_code.rotated_at)

    const student = await detail(ids.studentA, id)
    const list = await rpc(ids.studentA, 'xelay_teaching_tests', [ids.course, groups[0]])
    for (const view of [student, list, await detail(ids.owner, id)]) {
      assert.ok(!JSON.stringify(view).includes(firstCode))
      assert.equal(view.access_code, undefined)
    }
    assert.equal(student.test.require_access_code, true)
    assert.deepEqual(await start(ids.studentA), {access_error: 'TEST_CODE_INVALID'})
    for (const action of ['read_access_code', 'rotate_access_code']) {
      await assert.rejects(mutate(ids.studentA, action, {id}), /TEST_FORBIDDEN/)
      await assert.rejects(mutate(ids.owner, action, {id, expected_user_id: ids.studentA}), /TEST_INVALID_INPUT/)
    }
    await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_test_access_codes'), /permission denied/)
    await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_test_code_attempts'), /permission denied/)
    await assert.rejects(rpc(ids.studentA, 'xelay_private_test_rotate_access_code', [id]), /permission denied/)
    const exposedHelpers = await db.query(`select proname from pg_proc
      where pronamespace='public'::regnamespace and proname<>'xelay_teaching_test_mutate'
      and (proname like '%test%mutate%' or proname like 'xelay_private_test%code%' or proname='xelay_private_test_finish')
      and (has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute')
        or has_function_privilege('service_role',oid,'execute'))`)
    assert.deepEqual(exposedHelpers.rows, [])
  })

  await t.test('rotation invalidates the old code, caps guesses, and leaves valid attempts resumable', async () => {
    const rotated = await mutate(ids.owner, 'rotate_access_code', {id})
    currentCode = rotated.access_code.current
    assert.notEqual(currentCode, firstCode)
    assert.equal(rotated.access_code.previous, firstCode)
    assert.equal(rotated.test.version, 1)
    await assert.rejects(start(ids.outsider, currentCode), /TEST_FORBIDDEN/)
    for (let guess = 0; guess < 5; guess++) {
      assert.deepEqual(await start(ids.studentA, firstCode), {access_error: 'TEST_CODE_INVALID'})
    }
    assert.deepEqual(await start(ids.studentA, currentCode), {access_error: 'TEST_CODE_RATE_LIMITED'})
    assert.equal((await detail(ids.studentA, id)).attempt, null)
    assert.equal((await db.query('select failures from teaching_test_code_attempts where test_id=$1 and user_id=$2', [id, ids.studentA])).rows[0].failures, 5)
    await db.query("update teaching_test_code_attempts set window_started_at=now()-interval '2 minutes' where test_id=$1 and user_id=$2", [id, ids.studentA])
    attempt = (await start(ids.studentA, ' '+currentCode.toLowerCase()+' ')).attempt
    assert.equal(attempt.status, 'in_progress')
    assert.equal(attempt.tab_exit_count, 0)
    assert.equal(attempt.completion_reason, null)
    assert.ok([definition.questions[0].text, definition.variants[0].questions[0].text].includes(attempt.current_question.text))
    const rotatedAgain = await mutate(ids.owner, 'rotate_access_code', {id})
    assert.equal(rotatedAgain.access_code.previous, currentCode)
    assert.deepEqual(await start(ids.headA, currentCode), {access_error: 'TEST_CODE_INVALID'})
    assert.equal((await start(ids.studentA)).attempt.id, attempt.id)
    assert.equal((await start(ids.studentA, firstCode)).attempt.id, attempt.id)
    await assert.rejects(mutate(ids.owner, 'save_test', {id, ...definition, version: 1, restrict_tab_switch: false}), /TEST_IMMUTABLE/)
  })

  await t.test('first distinct exit warns, retry stays idempotent, second exit submits saved answers only once', async () => {
    const exit = (who, event_id) => mutate(who, 'record_tab_exit', {id, attempt_id: attempt.id, event_id})
    const first = randomUUID(), second = randomUUID()
    await assert.rejects(mutate(ids.studentA, null, {id, attempt_id: attempt.id, event_id: first, expected_user_id: ids.headA}), /TEST_INVALID_INPUT/)
    await assert.rejects(exit(ids.headA, first), /TEST_FORBIDDEN/)
    await assert.rejects(exit(ids.owner, first), /TEST_FORBIDDEN/)
    const warning = await exit(ids.studentA, first)
    assert.equal(warning.attempt.tab_exit_count, 1)
    assert.equal(warning.attempt.status, 'in_progress')
    assert.equal(warning.attempt.version, attempt.version)
    assert.equal(warning.attempt.tab_exit_events, undefined)
    assert.equal((await exit(ids.studentA, first)).attempt.tab_exit_count, 1)
    assert.equal((await detail(ids.studentA, id)).attempt.tab_exit_count, 1)

    const answered = await mutate(ids.studentA, 'save_answer', {id, version: attempt.version, question_id: attempt.current_question.id, answer: 'b'})
    const submitted = await exit(ids.studentA, second)
    assert.equal(submitted.attempt.status, 'submitted')
    assert.equal(submitted.attempt.tab_exit_count, 2)
    assert.equal(submitted.attempt.completion_reason, 'tab_switch')
    assert.equal(submitted.attempt.version, answered.attempt.version + 1)
    assert.equal(submitted.attempt.current_question, null)
    assert.equal(submitted.attempt.score, undefined)
    for (const event of [first, second, randomUUID()]) {
      assert.deepEqual((await exit(ids.studentA, event)).attempt, submitted.attempt)
    }
    const reviewed = (await detail(ids.owner, id)).attempts.find(row => row.id === attempt.id)
    assert.equal(reviewed.auto_score, 5)
    assert.equal(reviewed.completion_reason, 'tab_switch')
    assert.equal(reviewed.tab_exit_events, undefined)
    assert.equal((await start(ids.studentA)).attempt.id, attempt.id)
  })

  await t.test('opt-out and excluded students preserve the existing access rules', async () => {
    const basic = syntheticTest(ids.course, [groups[0]])
    const saved = await mutate(ids.owner, 'save_test', basic)
    assert.equal(saved.test.restrict_tab_switch, false)
    assert.equal(saved.test.require_access_code, false)
    const started = await mutate(ids.studentA, 'start', {id: basic.id, group_id: groups[0]})
    const unchanged = await mutate(ids.studentA, 'record_tab_exit', {id: basic.id, attempt_id: started.attempt.id, event_id: randomUUID()})
    assert.equal(unchanged.attempt.tab_exit_count, 0)
    assert.equal(unchanged.attempt.status, 'in_progress')

    const excluded = syntheticTest(ids.course, [groups[0]], {require_access_code: true,
      overrides: [{user_id: ids.studentA, group_id: groups[0], excluded: true}]})
    await mutate(ids.owner, 'save_test', excluded)
    const code = (await mutate(ids.owner, 'read_access_code', {id: excluded.id})).access_code.current
    await assert.rejects(mutate(ids.studentA, 'start', {id: excluded.id, group_id: groups[0], access_code: code}), /TEST_NOT_ADMITTED/)
    assert.equal((await detail(ids.studentA, excluded.id)).attempt, null)
  })
})
