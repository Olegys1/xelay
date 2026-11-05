import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { teachingTestAdmissionFixture } from './teaching-test-admission-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

function setIndex(attemptId, setCount) {
  return Number.parseInt(createHash('md5').update(`${attemptId}:manual-variant`).digest('hex').slice(0, 8), 16) % setCount
}

test('manually authored variants are validated, staff-only and frozen for student scoring and review', async t => {
  const fx = await teachingTestAdmissionFixture()
  t.after(() => fx.close())
  for (const name of ['202611050061_teaching_test_explicit_close.sql', '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql', '202611060030_teaching_test_question_images.sql']) {
    await fx.db.exec(await readCourseModuleMigration(name))
  }
  const { db, ids, groups, testDetail, testMutate, testList } = fx
  const base = syntheticTest(ids.course, [groups[0]])
  const question = (id, answer) => ({ ...base.questions[0], id, text: `Запитання ${id}`, answer, time_limit_seconds: null })
  const definition = {
    ...base, draw_count: 1, questions: [question('first-a', 'a'), question('first-b', 'a')],
    variants: Array.from({ length: 24 }, (_, index) => ({
      id: `authored-${index + 2}`, title: `Варіант ${index + 2}`, questions: [question(`question-${index + 2}`, 'b')],
    })),
  }
  const act = (who, action, payload = {}) => testMutate(who, action, { id: definition.id, ...payload })

  const teacher = await act(ids.owner, 'save_test', definition)
  assert.deepEqual(teacher.test.variants, definition.variants)
  assert.deepEqual((await testDetail(ids.owner, definition.id)).test.variants, definition.variants)
  assert.equal((await testDetail(ids.studentA, definition.id)).test.variants, undefined)
  assert.equal((await testList(ids.studentA, ids.course, groups[0])).tests[0].variants, undefined)
  assert.equal((await db.query("select has_table_privilege('authenticated', 'public.teaching_test_manual_variants', 'select') as allowed")).rows[0].allowed, false)

  const change = { ...definition, version: teacher.test.version }
  await assert.rejects(act(ids.owner, 'save_test', { ...change, draw_count: 2 }), /TEST_INVALID_INPUT/)
  await assert.rejects(act(ids.owner, 'save_test', { ...change, draw_count: null }), /TEST_INVALID_INPUT/)
  await assert.rejects(act(ids.owner, 'save_test', { ...change, variants: [definition.variants[0], definition.variants[0]] }), /TEST_INVALID_INPUT/)
  await assert.rejects(act(ids.owner, 'save_test', { ...change, variants: [{ ...definition.variants[0], questions: [definition.questions[0]] }] }), /TEST_INVALID_INPUT/)
  await assert.rejects(act(ids.owner, 'save_test', { ...change, variants: [{ ...definition.variants[0], questions: [question('unsafe', 'missing')] }] }), /TEST_INVALID_INPUT/)
  await assert.rejects(act(ids.studentA, 'save_test', change), /FORBIDDEN|TEACHING_ACCESS_EXPIRED_OR_UNVERIFIED/)
  const { variants: _omitted, ...legacyPayload } = change
  const saved = await act(ids.owner, 'save_test', legacyPayload)
  assert.equal(saved.test.version, teacher.test.version + 1)
  assert.deepEqual(saved.test.variants, definition.variants)

  // Deterministically exercise a distinct variant, in addition to real RPC starts.
  let exampleId = randomUUID()
  while (setIndex(exampleId, 25) !== 4) exampleId = randomUUID()
  const { questions: sample } = (await db.query('select public.xelay_private_assessment_snapshot(t,$2) as questions from public.teaching_tests t where t.id=$1', [definition.id, exampleId])).rows[0]
  assert.equal(sample[0].id, 'question-5')
  assert.equal(sample[0].answer, 'b')

  for (const user of [ids.studentA, ids.headA]) {
    const started = await act(user, 'start', { group_id: groups[0] })
    const own = started.attempt
    const expectedSet = [definition.questions, ...definition.variants.map(item => item.questions)][setIndex(own.id, 25)]
    const expected = expectedSet.find(item => item.id === own.current_question.id)
    assert.ok(expected)
    assert.equal(own.question_count, 1)
    assert.equal(own.current_question.answer, undefined)
    assert.equal(own.questions, undefined)
    assert.equal(started.test.variants, undefined)
    const repeat = await act(user, 'start', { group_id: groups[0] })
    assert.equal(repeat.attempt.id, own.id)
    assert.deepEqual(repeat.attempt.current_question, own.current_question)
    const answered = await act(user, 'save_answer', { version: own.version, question_id: expected.id, answer: expected.answer })
    await act(user, 'finish', { version: answered.attempt.version })
    const staffDetail = await testDetail(ids.owner, definition.id)
    const attempt = staffDetail.attempts.find(item => item.id === own.id)
    assert.equal(attempt.auto_score, definition.max_points)
    assert.equal(attempt.questions[0].id, expected.id)
    assert.equal(attempt.question_results[0].question_id, expected.id)
    const reviewed = await act(ids.owner, 'save_review', {
      attempt_id: attempt.id, version: attempt.version, marks: [{ question_id: expected.id, mode: 'zero', reason: 'Контрольна перевірка' }],
    })
    assert.equal(reviewed.attempts.find(item => item.id === own.id).score, 0)
  }
  const { test: final } = await testDetail(ids.owner, definition.id)
  await assert.rejects(act(ids.owner, 'save_test', { ...definition, version: final.version, variants: [] }), /TEST_IMMUTABLE/)
})
