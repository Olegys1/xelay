import { randomUUID } from 'node:crypto'
import { syntheticTest } from './teaching-tests-fixture.mjs'

export async function seedPersonalRetakesPreview(fx) {
  const { db, ids, groups, testMutate, mutate } = fx
  const makeQuestion = (id, number) => ({
    id, kind: 'choice', text: `Оберіть число ${number}.`, points: 1, time_limit_seconds: null,
    partial_credit: false, options: [1, 2, 3, 4].map(value => ({ id: `n${value}`, text: String(value) })), buckets: [], answer: `n${number}`,
  })
  const definition = syntheticTest(ids.course, [groups[0]], {
    id: randomUUID(), title: 'Особиста повторна спроба · два варіанти',
    description: 'У Марії вже є опубліковані 5 із 10 балів. Дозвольте їй повторну спробу у «Допуск та індивідуальні умови». Після перевірки кращий результат оновить цю саму колонку журналу, гірший залишиться лише в історії.',
    max_points: 10, bonus_percent: 0, bonus_points: 0, base_variant_title: 'Числа 2 і 4',
    questions: [makeQuestion('two', 2), makeQuestion('four', 4)],
    variants: [{ id: 'odd-numbers', title: 'Числа 1 і 3', questions: [makeQuestion('one', 1), makeQuestion('three', 3)] }],
  })
  await testMutate(ids.owner, 'save_test', definition)
  let attempt = await testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
  const issued = (await db.query('select questions from teaching_test_attempts where id=$1', [attempt.attempt.id])).rows[0].questions
  attempt = await testMutate(ids.studentA, 'save_answer', {
    id: definition.id, attempt_id: attempt.attempt.id, version: attempt.attempt.version, question_id: issued[0].id, answer: issued[0].answer,
  })
  await testMutate(ids.studentA, 'finish', { id: definition.id, attempt_id: attempt.attempt.id, version: attempt.attempt.version })
  await db.query("update teaching_tests set closes_at=greatest(clock_timestamp()-interval '1 second',opens_at+interval '1 second') where id=$1", [definition.id])
  let teacher = await fx.rpc(ids.owner, 'xelay_teaching_test', [definition.id])
  teacher = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: teacher.test.version })
  await testMutate(ids.owner, 'review_results', { id: definition.id, version: teacher.test.version })
  const grade = (await db.query('select g.* from teaching_grades g join teaching_test_activities l on l.activity_id=g.activity_id join teaching_entries e on e.id=g.entry_id where l.test_id=$1 and e.user_id=$2', [definition.id, ids.studentA])).rows[0]
  if (!grade || Number(grade.draft_score) !== 5) throw new Error('Personal retake preview needs a 5-point original draft')
  await mutate(ids.owner, 'publish_grades', { activity_id: grade.activity_id, expected_versions: [{ entry_id: grade.entry_id, version: grade.version }] })
}
