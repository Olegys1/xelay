import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

test('module test retries wait for a low result and cooldown, then preserve one current grade and immutable history', async t => {
  const fx = await courseModulesFixture({ additionalMigrations: [
    '202611040060_teaching_test_admission.sql',
    '202611050061_teaching_test_explicit_close.sql',
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
    '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql',
    '202611060050_teaching_test_rich_content.sql',
    '202611060055_teaching_module_prerequisite_diagnostics.sql',
    '202611060060_teaching_course_module_delay.sql',
    '202611060070_teaching_module_test_retries.sql',
  ] })
  t.after(() => fx.close())
  const { db, ids, groups, rpc } = fx
  const group = groups[0]
  const action = (actor, verb, data) => rpc(actor, 'xelay_teaching_test_mutate', [verb, JSON.stringify({
    expected_user_id: actor, ...data,
  })])
  const definition = syntheticTest(ids.course, [group], {
    closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    retry_days: 5, retry_pass_percent: 60, require_access_code: true, bonus_percent: 0, bonus_points: 0,
  })
  definition.questions = [{ ...definition.questions[0], time_limit_seconds: null }]
  const id = definition.id
  const act = (actor, verb, payload = {}) => action(actor, verb, { id, group_id: group, ...payload })
  const own = () => rpc(ids.studentA, 'xelay_teaching_test', [id])
  const staff = () => rpc(ids.owner, 'xelay_teaching_test', [id])
  const pointer = attempt => ({ attempt_id: attempt.id, version: attempt.version })
  const submit = async (attempt, answer) => {
    const saved = await act(ids.studentA, 'save_answer', { ...pointer(attempt), question_id: 'choice', answer })
    return (await act(ids.studentA, 'finish', pointer(saved.attempt))).attempt
  }

  assert.deepEqual((await db.query("select has_table_privilege('authenticated','public.teaching_test_attempts','select') allowed")).rows, [{ allowed: false }])
  await assert.rejects(action(ids.owner, 'save_test', { ...definition, retry_days: 1.5 }), /TEST_INVALID_INPUT/)
  await assert.rejects(action(ids.owner, 'save_test', { ...definition, retry_days: 8 }), /TEST_RETRY_WINDOW_TOO_SHORT/)
  const created = await action(ids.owner, 'save_test', definition)
  assert.equal(created.test.retry_days, 5)
  const { access_code: { current: code } } = await action(ids.owner, 'read_access_code', { id })
  assert.equal((await own()).test.retry_days, undefined, 'a standalone test keeps a single attempt')

  const saveModule = module => rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify(module)])
  const prerequisiteTest = syntheticTest(ids.course, [group], { bonus_percent: 0, bonus_points: 0 })
  await action(ids.owner, 'save_test', prerequisiteTest)
  const prerequisite = randomUUID()
  const moduleWithTest = (testId, itemId, position) => ({
    id: randomUUID(), course_id: ids.course, expected_user_id: ids.owner, title: 'Контрольна в модулі', description: '',
    status: 'published', group_ids: [group], position, version: 0, prerequisite_item_ids: [],
    items: [{ id: itemId, resource_type: 'test', resource_id: testId, required: true, completion: 'submitted',
      pass_percent: null, prerequisite_item_ids: [], position: 0 }],
  })
  await saveModule(moduleWithTest(prerequisiteTest.id, prerequisite, 0))
  const module = moduleWithTest(id, randomUUID(), 1)
  const moduleSaved = (await saveModule(module)).modules.find(item => item.id === module.id)
  assert.equal((await own()).test.retry_pass_percent, 60)
  const first = (await act(ids.studentA, 'start', { access_code: code })).attempt
  assert.equal(first.attempt_number, 1)
  const low = await submit(first, 'a')
  assert.equal(Date.parse(low.retry_available_at) - Date.parse(low.submitted_at), 5 * 86400000)
  assert.equal(Date.parse(low.retry_closes_at), Date.parse(definition.closes_at))
  assert.equal(low.score, undefined, 'student receives only own retry date, not provisional score')
  await assert.rejects(act(ids.studentA, 'retry', { ...pointer(low), access_code: code }), /TEST_RETRY_TOO_EARLY/)
  assert.equal((await act(ids.studentA, 'start', { access_code: code })).attempt.id, first.id)
  await db.query("update public.teaching_test_attempts set submitted_at=clock_timestamp()-interval '5 days 1 minute' where id=$1", [first.id])
  await saveModule({ ...module, version: moduleSaved.version, prerequisite_item_ids: [prerequisite], release_delay_days: 5 })
  assert.equal((await own()).attempt.id, first.id, 'an existing receipt stays visible after a module rule changes')
  await assert.rejects(act(ids.studentA, 'retry', { ...pointer(low), access_code: code }), /TEST_RETRY_NOT_AVAILABLE/)
  const preceding = (await action(ids.studentA, 'start', { id: prerequisiteTest.id, group_id: group })).attempt
  await action(ids.studentA, 'finish', { id: prerequisiteTest.id, ...pointer(preceding) })
  await assert.rejects(act(ids.studentA, 'retry', { ...pointer(low), access_code: code }), /TEST_RETRY_NOT_AVAILABLE/)
  await db.query("update public.teaching_test_attempts set submitted_at=clock_timestamp()-interval '5 days 1 minute' where id=$1", [preceding.id])
  const invalid = await act(ids.studentA, 'retry', { ...pointer(low), access_code: 'zzzzzzzz' })
  assert.equal(invalid.access_error, 'TEST_CODE_INVALID')
  assert.equal((await own()).attempt.id, first.id)

  const second = (await act(ids.studentA, 'retry', { ...pointer(low), access_code: code })).attempt
  assert.notEqual(second.id, first.id)
  assert.equal(second.attempt_number, 2)
  assert.deepEqual(second.answers, {})
  assert.equal((await own()).test.my_attempt.id, second.id)
  const attempts = (await staff()).attempts
  const preserved = attempts.find(attempt => attempt.id === first.id)
  assert.ok(preserved.superseded_at)
  assert.deepEqual(preserved.answers, { choice: 'a' })
  assert.equal(preserved.score, 0)
  await assert.rejects(act(ids.studentA, 'retry', { ...pointer(low), access_code: code }), /TEST_CONFLICT/)
  await assert.rejects(act(ids.studentA, 'save_answer', { version: second.version, question_id: 'choice', answer: 'a' }), /TEST_CONFLICT/)
  await assert.rejects(act(ids.studentA, 'finish', { attempt_id: first.id, version: second.version }), /TEST_CONFLICT/)
  await assert.rejects(action(ids.owner, 'save_review', { id, ...pointer(preserved),
    marks: [{ question_id: 'choice', mode: 'full', reason: 'Перевірка історії' }],
  }), /TEST_IMMUTABLE/)

  const passing = await submit(second, 'b')
  assert.equal(passing.retry_available_at, undefined)
  await assert.rejects(act(ids.studentA, 'retry', { ...pointer(passing), access_code: code }), /TEST_RETRY_NOT_AVAILABLE/)
  const result = await staff()
  const closed = await action(ids.owner, 'close_test', { id, version: result.test.version, confirm_close_all: true })
  const finalized = await action(ids.owner, 'finalize_results', { id, version: closed.test.version })
  const transferred = await action(ids.owner, 'review_results', { id, version: finalized.test.version })
  assert.deepEqual(transferred.attempts.map(attempt => [attempt.attempt_number, attempt.rank, attempt.final_score, Boolean(attempt.grade_id)]),
    [[1, null, null, false], [2, 1, definition.max_points, true]])
})
