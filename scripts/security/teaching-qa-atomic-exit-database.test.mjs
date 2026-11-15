import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { personalRetakesFixture } from './teaching-test-personal-retakes-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'

const migration = '202611150010_teaching_qa_atomic_exit.sql'
const current = ['202611140110_teaching_publication_revisions.sql', '202611140120_teaching_first_exit_submission.sql']

test('owner QA first exit accepts UI scope and atomic answers while preserving ordinary access, published grades and history', async t => {
  const fx = await personalRetakesFixture()
  t.after(() => fx.close())
  const { db, ids, groups, rpc, testMutate: act, testDetail } = fx
  for (const name of current) await db.exec(await readCourseModuleMigration(name))
  const ordinary = await fx.createTest({ restrict_tab_switch: false, variants: [] })
  await fx.complete(ids.studentA, ordinary.definition.id)
  await fx.publishOriginal(ordinary.definition.id)
  const seed = await fx.createQaTest()
  const qa = (who, action, payload, options) => rpc(who, 'xelay_teaching_test_qa',
    [action, JSON.stringify({ expected_user_id: who, ...payload })], options)
  async function create(patch = {}) {
    const input = { ...seed.definition, id: randomUUID(), version: 0, status: 'draft', qa_own_attempt: true,
      restrict_tab_switch: true, max_points: 5, duration_seconds: 1200,
      questions: [seed.definition.questions[0]], variants: [], ...patch }
    let saved = await act(seed.owner, 'save_test', input)
    saved = await act(seed.owner, 'save_test', { ...input, version: saved.test.version, status: 'published' })
    const started = await qa(seed.owner, 'start', { id: input.id, group_id: seed.group })
    return { id: input.id, attempt: started.attempt, event: randomUUID() }
  }
  const pending = run => ({ question_id: run.attempt.current_question.id, answer: 'b', version: run.attempt.version })
  const exit = (run, patch = {}, who = seed.owner) => qa(who, 'record_tab_exit', {
    id: run.id, group_id: seed.group, attempt_id: run.attempt.id, event_id: run.event, ...patch,
  })
  const state = async run => (await db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [run.attempt.id])).rows[0].state
  const normalSnapshot = async () => ({
    journal: await fx.journalState(),
    data: (await db.query("select jsonb_build_object('attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from teaching_test_attempts a join teaching_tests t on t.id=a.test_id where not t.qa_own_attempt),'notifications',(select coalesce(jsonb_agg(to_jsonb(n) order by id),'[]') from notifications n),'outbox',(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]') from notification_email_outbox o)) state")).rows[0].state,
  })
  const run = await create(), last = pending(run)
  const before = await normalSnapshot(), beforeAttempt = await state(run)

  await t.test('pre-fix UI group and atomic QA answer reproduce distinct failures without consuming data', async () => {
    await assert.rejects(exit(run, { pending_answer: last }), /TEST_INVALID_INPUT/)
    await assert.rejects(qa(seed.owner, 'record_tab_exit', { id: run.id, attempt_id: run.attempt.id, event_id: run.event, pending_answer: last }), /TEST_FORBIDDEN/)
    assert.deepEqual(await state(run), beforeAttempt)
  })
  await t.test('an unexpected handler definition rolls the whole migration back before any wrapper change commits', async () => {
    const definition = async signature => (await db.query('select pg_get_functiondef($1::regprocedure) source', [signature])).rows[0].source
    const qaSignature = 'public.xelay_teaching_test_qa(text,jsonb)'
    const exitSignature = 'public.xelay_private_test_mutate_before_manual_variants(text,jsonb)'
    const qaBefore = await definition(qaSignature), exitBefore = await definition(exitSignature)
    const changed = exitBefore.replace("perform public.xelay_teaching_test_mutate('save_answer',jsonb_build_object(", "perform public.xelay_teaching_test_mutate( 'save_answer',jsonb_build_object(")
    assert.notEqual(changed, exitBefore)
    await db.exec(changed)
    await assert.rejects(db.exec(await readCourseModuleMigration(migration)), /TEST_QA_EXIT_SOURCE_CHANGED/)
    await db.exec('rollback')
    assert.equal(await definition(qaSignature), qaBefore, 'the earlier wrapper patch must not partially commit')
    assert.equal(await definition(exitSignature), changed)
    await db.exec(exitBefore)
  })
  await db.exec((await readCourseModuleMigration(migration)).replace(/\r?\n/g, '\r\n'))
  assert.deepEqual(await state(run), beforeAttempt, 'migration never rewrites the active attempt')
  assert.deepEqual(await normalSnapshot(), before, 'migration preserves the pre-existing published journal')

  await t.test('old UI scope now saves the newest answer and submits once; retry cannot replace it', async () => {
    const done = await exit(run, { pending_answer: last })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.completion_reason, 'tab_switch')
    assert.equal(done.attempt.tab_exit_count, 1)
    assert.equal(done.attempt.answers[last.question_id], 'b')
    assert.equal(done.attempt.current_question, null)
    assert.deepEqual(done.test.questions, [])
    assert.deepEqual(done.attempts, [])
    assert.equal(done.test.can_review, false)
    assert.equal(done.attempt.final_score, undefined)
    assert.equal(done.attempt.tab_exit_events, undefined)
    assert.deepEqual((await exit(run, { pending_answer: { ...last, answer: 'a' } })).attempt, done.attempt)
    assert.equal((await testDetail(seed.owner, run.id)).attempts[0].auto_score, 5)
  })

  await t.test('new UI without group or pending edit submits an acknowledged saved answer', async () => {
    const next = await create()
    await qa(seed.owner, 'save_answer', { id: next.id, group_id: seed.group, attempt_id: next.attempt.id,
      version: next.attempt.version, question_id: next.attempt.current_question.id, answer: 'b' })
    const done = await qa(seed.owner, 'record_tab_exit', { id: next.id, attempt_id: next.attempt.id, event_id: next.event })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.answers[next.attempt.current_question.id], 'b')
    assert.equal(done.attempt.tab_exit_count, 1)
  })

  await t.test('text answers over the former 2KB QA envelope retain normal answer validation', async () => {
    const next = await create({ questions: [{ id: 'essay', kind: 'essay', text: 'Synthetic explanation',
      points: 1, time_limit_seconds: null, partial_credit: false, options: [], buckets: [] }] })
    const answer = 'Synthetic explanation. '.repeat(150)
    assert.ok(answer.length > 2000 && answer.length < 10000)
    const done = await exit(next, { pending_answer: { question_id: 'essay', answer, version: next.attempt.version } })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.answers.essay, answer)
  })

  await t.test('unknown keys, internal markers and foreign scope cannot be sanitized into permission', async () => {
    const next = await create(), unchanged = await state(next)
    for (const patch of [{ unexpected: true }, { qa_internal_session: true }, { qa_internal_session: false },
      { pending_answer: { ...pending(next), qa_internal_session: true } }, { expected_user_id: ids.studentA }]) {
      await assert.rejects(exit(next, patch), /TEST_INVALID_INPUT/)
      assert.deepEqual(await state(next), unchanged)
    }
    await assert.rejects(exit(next, { group_id: groups[0] }), /TEST_QA_FORBIDDEN/)
    await assert.rejects(exit(next, {}, ids.studentA), /TEST_QA_FORBIDDEN/)
    await assert.rejects(exit(next, {}, ids.owner), /TEST_QA_FORBIDDEN/)
    await assert.rejects(exit(next, { id: ordinary.definition.id }), /TEST_QA_FORBIDDEN/)
    await assert.rejects(exit(next, { attempt_id: run.attempt.id }), /TEST_ATTEMPT_CHANGED|TEST_FORBIDDEN/)
    assert.deepEqual(await state(next), unchanged)
    await exit(next)
  })

  await t.test('malformed and oversized pending edits never consume the event', async () => {
    const next = await create(), unchanged = await state(next)
    for (const answer of [null, [], { question_id: 'base_one', answer: 'b', version: '1' },
      { question_id: 'base_one', answer: 'b', version: 1, extra: true }]) {
      await assert.rejects(exit(next, { pending_answer: answer }), /TEST_INVALID_INPUT/)
      assert.deepEqual(await state(next), unchanged)
    }
    await assert.rejects(exit(next, { pending_answer: { ...pending(next), answer: 'x'.repeat(100000) } }), /TEST_INVALID_INPUT/)
    assert.deepEqual(await state(next), unchanged)
    await exit(next)
  })

  await t.test('version conflict rolls back answer and exit, then the same event can reconcile', async () => {
    const next = await create()
    await assert.rejects(exit(next, { pending_answer: { ...pending(next), version: next.attempt.version + 1 } }), /TEST_CONFLICT/)
    const unchanged = await state(next)
    assert.equal(unchanged.status, 'in_progress')
    assert.deepEqual(unchanged.answers, {})
    assert.deepEqual(unchanged.tab_exit_events, [])
    const done = await exit(next, { pending_answer: pending(next) })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.tab_exit_count, 1)
  })

  await t.test('an edit after its question deadline cannot replace the previously accepted answer', async () => {
    const next = await create(), question = next.attempt.current_question.id
    await qa(seed.owner, 'save_answer', { id: next.id, version: next.attempt.version, question_id: question, answer: 'a' })
    await db.query("update teaching_test_attempts set opened_at=jsonb_set(opened_at,array[$2],to_jsonb((clock_timestamp()-interval '10 minutes')::text)), questions=(select jsonb_agg(q||jsonb_build_object('time_limit_seconds',30)) from jsonb_array_elements(questions) q) where id=$1", [next.attempt.id, question])
    const fresh = await qa(seed.owner, 'detail', { id: next.id })
    const done = await exit(next, { pending_answer: { question_id: question, answer: 'b', version: fresh.attempt.version } })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.answers[question], 'a')
    assert.equal(done.attempt.tab_exit_count, 1)
  })

  await t.test('a timely QA last edit survives processing that crosses the server attempt deadline', async () => {
    const next = await create()
    await db.exec("create function public.synthetic_qa_exit_delay() returns trigger language plpgsql as $$ begin if new.id=tg_argv[0]::uuid then perform pg_sleep(0.25);end if;return new;end $$")
    await db.exec("create trigger synthetic_qa_exit_delay before update of answers on teaching_test_attempts for each row execute function public.synthetic_qa_exit_delay('" + next.attempt.id + "')")
    try {
      await db.query("update teaching_test_attempts set expires_at=clock_timestamp()+interval '150 milliseconds' where id=$1", [next.attempt.id])
      const done = await exit(next, { pending_answer: pending(next) })
      assert.equal(done.attempt.status, 'submitted')
      assert.equal(done.attempt.answers[next.attempt.current_question.id], 'b')
      assert.equal(done.attempt.tab_exit_count, 1)
      assert.equal((await db.query('select clock_timestamp()>expires_at crossed from teaching_test_attempts where id=$1', [next.attempt.id])).rows[0].crossed, true)
    } finally {
      await db.exec('drop trigger synthetic_qa_exit_delay on teaching_test_attempts')
      await db.exec('drop function public.synthetic_qa_exit_delay()')
    }
  })

  await t.test('a late edit after total expiry cannot overwrite a saved answer', async () => {
    const next = await create(), question = next.attempt.current_question.id
    const saved = await qa(seed.owner, 'save_answer', { id: next.id, version: next.attempt.version, question_id: question, answer: 'a' })
    await db.query("update teaching_test_attempts set expires_at=clock_timestamp()-interval '1 second' where id=$1", [next.attempt.id])
    const done = await exit(next, { pending_answer: { question_id: question, answer: 'b', version: saved.attempt.version } })
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.answers[question], 'a')
    assert.equal(done.attempt.tab_exit_count, 0)
  })

  await t.test('manual correction, review and QA-only publication remain durable and outside the journal', async () => {
    let teacher = await testDetail(seed.owner, run.id)
    teacher = await act(seed.owner, 'save_review', { id: run.id, attempt_id: run.attempt.id,
      version: teacher.attempts[0].version, marks: [{ question_id: last.question_id, mode: 'zero', reason: 'Synthetic correction' }] })
    assert.equal((await testDetail(seed.owner, run.id)).attempts[0].score, 0)
    teacher = await act(seed.owner, 'save_review', { id: run.id, attempt_id: run.attempt.id,
      version: teacher.attempts[0].version, marks: [{ question_id: last.question_id, mode: 'full', reason: 'Synthetic full mark restored' }] })
    assert.equal(teacher.attempts[0].score, 5)
    teacher = await act(seed.owner, 'close_test', { id: run.id, version: teacher.test.version, confirm_close_all: true })
    teacher = await act(seed.owner, 'finalize_results', { id: run.id, version: teacher.test.version })
    await assert.rejects(act(seed.owner, 'review_results', { id: run.id, version: teacher.test.version }), /TEST_QA_PUBLICATION_REQUIRED/)
    teacher = await act(seed.owner, 'qa_publish', { id: run.id, version: teacher.test.version, confirm_qa_publish: true })
    assert.equal(teacher.attempts[0].published_score, 5)
    const reopened = await qa(seed.owner, 'detail', { id: run.id, group_id: seed.group })
    assert.equal(reopened.attempt.published_score, 5)
    assert.ok(reopened.attempt.grade_published_at)
    assert.equal(reopened.test.my_attempt.published_score, 5)
    assert.deepEqual(reopened.attempts, [])
    assert.equal((await state(run)).grade_id, null)
  })

  await t.test('private helpers stay private and neither ordinary endpoint nor client marker grants author privilege', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await db.query("select has_function_privilege($1,'public.xelay_private_test_mutate_before_manual_variants(text,jsonb)','execute') allowed", [role])).rows[0].allowed, false)
    }
    await assert.rejects(qa(null, 'detail', { id: run.id }, { role: 'anon' }), /permission denied/)
    const next = await create()
    await assert.rejects(act(seed.owner, 'save_answer', { id: next.id, attempt_id: next.attempt.id, version: next.attempt.version,
      question_id: next.attempt.current_question.id, answer: 'b', qa_internal_session: true }), /TEST_FORBIDDEN/)
    await assert.rejects(qa(seed.owner, 'save_answer', { id: next.id, version: next.attempt.version,
      question_id: next.attempt.current_question.id, answer: 'b', qa_internal_session: true }), /TEST_INVALID_INPUT/)
    const unchanged = await state(next)
    await db.query('update study_groups set representative_id=$1 where id=$2', [ids.studentA, seed.group])
    await assert.rejects(exit(next, { pending_answer: pending(next) }), /TEST_QA_FORBIDDEN/)
    assert.deepEqual(await state(next), unchanged)
    await db.query('update study_groups set representative_id=$1 where id=$2', [seed.owner, seed.group])
    await exit(next)
  })

  assert.deepEqual(await normalSnapshot(), before, 'all ordinary published grades, audit, attempts, notifications and outbox rows remain unchanged')
  assert.equal((await db.query('select count(*)::int n from teaching_test_activities a join teaching_tests t on t.id=a.test_id where t.qa_own_attempt')).rows[0].n, 0)

  await t.test('ordinary student atomic exit still works and its original strict schema is not broadened', async () => {
    const normal = await fx.createTest({ restrict_tab_switch: true, variants: [] })
    const started = await act(ids.studentA, 'start', { id: normal.definition.id, group_id: groups[0] })
    const payload = { id: normal.definition.id, attempt_id: started.attempt.id, event_id: randomUUID(),
      pending_answer: { question_id: started.attempt.current_question.id, answer: 'b', version: started.attempt.version } }
    await assert.rejects(act(ids.studentA, 'record_tab_exit', { ...payload, group_id: groups[0] }), /TEST_INVALID_INPUT/)
    const done = await act(ids.studentA, 'record_tab_exit', payload)
    assert.equal(done.attempt.status, 'submitted')
    assert.equal(done.attempt.completion_reason, 'tab_switch')
    assert.equal(done.attempt.tab_exit_count, 1)
    assert.equal(done.attempt.answers[started.attempt.current_question.id], 'b')
    assert.equal((await testDetail(ids.owner, normal.definition.id)).attempts[0].auto_score, 5)
  })
})
