import test from 'node:test'
import assert from 'node:assert/strict'
import { notificationCenterFixture } from './notification-center-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

test('ordered subset questions validate, keep their key private, and save and score only issued options', async t => {
  const fx = await notificationCenterFixture()
  t.after(() => fx.close())
  for (const migration of [
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
    '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql',
    '202611060050_teaching_test_rich_content.sql',
    '202611060080_teaching_test_concurrency.sql',
    '202611060120_teaching_test_isolated_qa.sql',
    '202611110010_teaching_sequence_select.sql',
  ]) await fx.db.exec(await readCourseModuleMigration(migration))
  const { ids, groups, db, rpc } = fx
  const question = {
    id: 'ordered-subset', kind: 'sequence_select', text: 'Оберіть три потрібні елементи та впорядкуйте їх.',
    points: 3, time_limit_seconds: null, partial_credit: true, selection_count: 3,
    options: ['a','b','c','d','e'].map(id => ({ id, text: 'Елемент ' + id })), buckets: [], answer: ['b','d','a'],
  }
  const check = async input => (await db.query('select public.xelay_private_test_validate_question($1::jsonb) valid', [JSON.stringify(input)])).rows[0].valid
  assert.equal(await check(question), true)
  for (const fields of [
    { answer: ['b','b','a'] }, { answer: ['b','foreign','a'] }, { answer: ['b','d'] },
    { selection_count: 5, answer: ['a','b','c','d','e'] }, { selection_count: 0, answer: [] },
    { selection_count: 2.5 }, { selection_count: null }, { answer: null }, { answer: ['b',3,'a'] },
    { id: null }, { kind: 'sequence', answer: ['b','d','a'] },
  ]) assert.equal(await check({ ...question, ...fields }), false, JSON.stringify(fields))
  assert.equal(await check({ ...question, kind: 'sequence', answer: ['b','d','a','c','e'] }), true)
  const score = async (answer, partial = true) => Number((await db.query(
    'select public.xelay_private_test_question_points($1::jsonb,$2::jsonb) points',
    [JSON.stringify({ ...question, partial_credit: partial }), JSON.stringify(answer)],
  )).rows[0].points)
  assert.equal(await score(['b','d','a']), 3)
  assert.equal(await score(['b']), 1)
  assert.equal(await score(['b','c','a']), 2)
  assert.equal(await score(['b','c','a'], false), 0)
  assert.equal(await score(['d','a','b']), 0)
  assert.equal(await score(['b','d','a','e']), 0)

  const definition = syntheticTest(ids.course, [groups[0]], {
    questions: [question], question_count: 1, max_points: 3, bonus_percent: 0,
  })
  const mutate = (who, action, fields = {}) => rpc(who, 'xelay_teaching_test_mutate',
    [action, JSON.stringify({ expected_user_id: who, id: definition.id, ...fields })])
  await mutate(ids.owner, 'save_test', definition)
  let detail = await mutate(ids.studentA, 'start', { group_id: groups[0] })
  const original = detail.attempt
  assert.equal(original.current_question.kind, 'sequence_select')
  assert.equal(original.current_question.selection_count, 3)
  assert.equal(original.current_question.answer, undefined)
  assert.equal(original.questions, undefined)
  assert.deepEqual([...original.current_question.options].map(option => option.id).sort(), ['a','b','c','d','e'])
  assert.deepEqual((await mutate(ids.studentA, 'start', { group_id: groups[0] })).attempt.current_question, original.current_question)
  for (const answer of [['b','b'], ['b','d','a','c'], ['b','foreign']]) {
    await assert.rejects(mutate(ids.studentA, 'save_answer', { version: original.version, question_id: question.id, answer }), /TEST_INVALID_INPUT/)
  }
  detail = await mutate(ids.studentA, 'save_answer', { version: original.version, question_id: question.id, answer: ['b'] })
  assert.deepEqual(detail.attempt.answers[question.id], ['b'])
  detail = await mutate(ids.studentA, 'save_answer', { version: detail.attempt.version, question_id: question.id, answer: question.answer })
  await mutate(ids.studentA, 'finish', { version: detail.attempt.version })
  const teacher = await rpc(ids.owner, 'xelay_teaching_test', [definition.id])
  assert.equal(teacher.attempts.find(attempt => attempt.id === original.id).auto_score, 3)
  assert.deepEqual(teacher.attempts.find(attempt => attempt.id === original.id).questions[0].answer, question.answer)
})
