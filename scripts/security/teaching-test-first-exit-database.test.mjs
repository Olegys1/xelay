import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { personalRetakesFixture } from './teaching-test-personal-retakes-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'

test('first-exit submission is atomic, idempotent, recipient-bound and respects server answer deadlines', async t => {
  const fx = await personalRetakesFixture()
  t.after(() => fx.close())
  const legacyTest = await fx.createTest({ restrict_tab_switch: true, variants: [] })
  const legacyAttempt = (await fx.testMutate(fx.ids.studentA, 'start', { id: legacyTest.definition.id, group_id: fx.groups[0] })).attempt
  await fx.testMutate(fx.ids.studentA, 'record_tab_exit', { id: legacyTest.definition.id, attempt_id: legacyAttempt.id, event_id: randomUUID() })
  const legacyBefore = (await fx.db.query('select md5(to_jsonb(a)::text) hash from teaching_test_attempts a where id=$1', [legacyAttempt.id])).rows[0].hash
  await fx.db.exec(await readCourseModuleMigration('202611140110_teaching_publication_revisions.sql'))
  await fx.db.exec(await readCourseModuleMigration('202611140120_teaching_first_exit_submission.sql'))
  assert.equal((await fx.db.query('select md5(to_jsonb(a)::text) hash from teaching_test_attempts a where id=$1', [legacyAttempt.id])).rows[0].hash, legacyBefore, 'migration never rewrites historical attempt data')
  const { ids, groups, db, testMutate: act, testDetail } = fx
  const create = async (patch = {}) => {
    const saved = await fx.createTest({ restrict_tab_switch: true, variants: [], ...patch })
    const run = await act(ids.studentA, 'start', { id: saved.definition.id, group_id: groups[0] })
    return { id: saved.definition.id, attempt: run.attempt }
  }
  const exit = (run, patch = {}, who = ids.studentA) => act(who, 'record_tab_exit', {
    id: run.id, attempt_id: run.attempt.id, event_id: run.event || randomUUID(), ...patch,
  })

  await t.test('a pre-existing warning remains intact across migration and its next exit submits once', async () => {
    const done = await exit({ id: legacyTest.definition.id, attempt: legacyAttempt })
    assert.equal(done.attempt.status, 'submitted'); assert.equal(done.attempt.tab_exit_count, 2)
    assert.equal(done.attempt.completion_reason, 'tab_switch')
  })

  await t.test('one event saves the valid last answer before submitting; retries cannot replay or alter it', async () => {
    const run = await create(); run.event = randomUUID()
    const before = await fx.journalState()
    const done = await exit(run, { pending_answer: { question_id: run.attempt.current_question.id, answer: 'b', version: run.attempt.version } })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.tab_exit_count, 1)
    assert.equal(done.attempt.completion_reason, 'tab_switch')
    assert.equal(done.attempt.answers[run.attempt.current_question.id], 'b')
    assert.equal(done.attempt.tab_exit_events, undefined)
    const again = await exit(run, { pending_answer: { question_id: run.attempt.current_question.id, answer: 'a', version: run.attempt.version } })
    assert.deepEqual(again.attempt, done.attempt)
    assert.deepEqual(await fx.journalState(), before)
    assert.equal((await testDetail(ids.owner, run.id)).attempts[0].auto_score, 5)
  })

  await t.test('a stale version rolls back both answer and event; reconciliation can retry that same identity', async () => {
    const run = await create(); run.event = randomUUID()
    await assert.rejects(exit(run, { pending_answer: { question_id: run.attempt.current_question.id, answer: 'b', version: run.attempt.version + 1 } }), /TEST_CONFLICT/)
    const unchanged = (await testDetail(ids.studentA, run.id)).attempt
    assert.equal(unchanged.status, 'in_progress'); assert.equal(unchanged.tab_exit_count, 0)
    assert.deepEqual(unchanged.answers, {})
    const saved = await exit(run, { pending_answer: { question_id: run.attempt.current_question.id, answer: 'b', version: unchanged.version } })
    assert.equal(saved.attempt.status, 'submitted'); assert.equal(saved.attempt.tab_exit_count, 1)
  })

  await t.test('another user cannot submit or write the owner’s attempt; malformed atomic payloads cannot consume the event', async () => {
    const run = await create(); run.event = randomUUID()
    await assert.rejects(exit(run, {}, ids.headA), /TEST_FORBIDDEN|TEST_ATTEMPT_CHANGED/)
    for (const pending_answer of [null, [], { answer: 'b', version: 1 }, { question_id: 'x', answer: 'b', version: 1, extra: true }, { question_id: 'x', answer: 'b', version: '1' }]) {
      await assert.rejects(exit(run, { pending_answer }), /TEST_INVALID_INPUT/)
    }
    const unchanged = (await testDetail(ids.studentA, run.id)).attempt
    assert.equal(unchanged.status, 'in_progress'); assert.equal(unchanged.tab_exit_count, 0)
    assert.deepEqual(unchanged.answers, {})
  })

  await t.test('an edit after the question deadline is rejected while already-saved answers are still submitted', async () => {
    const run = await create()
    const question = run.attempt.current_question.id
    await act(ids.studentA, 'save_answer', { id: run.id, attempt_id: run.attempt.id, version: run.attempt.version, question_id: question, answer: 'a' })
    await db.query(`update teaching_test_attempts set opened_at=jsonb_set(opened_at,array[$2],to_jsonb((clock_timestamp()-interval '10 minutes')::text)) where id=$1`, [run.attempt.id, question])
    // Use a frozen question timer rather than browser-provided timing values.
    await db.query(`update teaching_test_attempts set questions=(select jsonb_agg(q||jsonb_build_object('time_limit_seconds',30)) from jsonb_array_elements(questions)q) where id=$1`, [run.attempt.id])
    const fresh = (await testDetail(ids.studentA, run.id)).attempt
    const done = await exit(run, { pending_answer: { question_id: question, answer: 'b', version: fresh.version } })
    assert.equal(done.attempt.status, 'submitted'); assert.equal(done.attempt.answers[question], 'a')
    assert.equal(done.attempt.tab_exit_count, 1)
  })

  await t.test('a timely last answer remains accepted when its transaction finishes after the server timer', async () => {
    const run = await create()
    await db.exec(`create function public.synthetic_exit_save_delay() returns trigger language plpgsql as $$
      begin if new.id=tg_argv[0]::uuid then perform pg_sleep(0.25);end if;return new;end $$`)
    await db.exec(`create trigger synthetic_exit_save_delay before update of answers on teaching_test_attempts
      for each row execute function public.synthetic_exit_save_delay('${run.attempt.id}')`)
    try {
      await db.query(`update teaching_test_attempts set expires_at=clock_timestamp()+interval '150 milliseconds' where id=$1`, [run.attempt.id])
      const done = await exit(run, { pending_answer: { question_id: run.attempt.current_question.id, answer: 'b', version: run.attempt.version } })
      assert.equal(done.attempt.status, 'submitted')
      assert.equal(done.attempt.answers[run.attempt.current_question.id], 'b')
      assert.equal(done.attempt.tab_exit_count, 1)
      assert.equal((await db.query('select clock_timestamp()>expires_at delayed_past_deadline from teaching_test_attempts where id=$1', [run.attempt.id])).rows[0].delayed_past_deadline, true)
    } finally {
      await db.exec('drop trigger synthetic_exit_save_delay on teaching_test_attempts;drop function public.synthetic_exit_save_delay()')
    }
  })

  await t.test('opt-out ignores an exit payload, including its proposed edit', async () => {
    const run = await create({ restrict_tab_switch: false })
    const unchanged = await exit(run, { pending_answer: { question_id: run.attempt.current_question.id, answer: 'b', version: run.attempt.version } })
    assert.equal(unchanged.attempt.status, 'in_progress'); assert.equal(unchanged.attempt.tab_exit_count, 0)
    assert.deepEqual(unchanged.attempt.answers, {})
  })
})
