import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { syntheticTest, teachingTestsFixture } from './teaching-tests-fixture.mjs'

const close = (db, id) => db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second',opens_at=clock_timestamp()-interval '1 day' where id=$1", [id])
const attemptFor = (detail, user) => detail.attempts.find(attempt => attempt.user_id === user)

test('a test-linked journal maximum changes only through the constructor before any attempt', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  const { ids, groups, dates, db, rpc, mutate, testMutate, testDetail } = fx
  const definition = syntheticTest(ids.course, [groups[0]], { bonus_percent: 0 })
  let detail = await testMutate(ids.owner, 'save_test', definition)
  const activity = async () => (await db.query('select a.*,a.activity_date::text journal_date from teaching_test_activities l join teaching_activities a on a.id=l.activity_id where l.test_id=$1', [definition.id])).rows[0]
  let column = await activity()
  const journalPayload = row => ({ id: row.id, version: row.version, expected_user_id: ids.owner,
    course_id: row.course_id, group_id: row.group_id, title: row.title, category: row.category,
    work_type: row.work_type, activity_date: row.journal_date, max_points: Number(row.max_points) })
  const edit = payload => rpc(ids.owner, 'xelay_teaching_classified_activity', [JSON.stringify(payload)])
  await assert.rejects(edit({ ...journalPayload(column), max_points: 19 }), /TEACHING_TEST_MAX_POINTS_LOCKED/)
  assert.equal((await activity()).max_points, '20.00')

  detail = await testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, max_points: 16 })
  let next = await activity()
  assert.equal(next.id, column.id); assert.equal(next.max_points, '16.00')
  await edit({ ...journalPayload(next), title: 'Уточнена назва в журналі', activity_date: dates.lesson_b, work_type: 'МКР' })
  column = await activity()
  assert.equal(column.title, 'Уточнена назва в журналі'); assert.equal(column.work_type, 'МКР')
  assert.equal(column.journal_date, dates.lesson_b)

  let attempt = await testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
  attempt = await testMutate(ids.studentA, 'save_answer', { id: definition.id, version: attempt.attempt.version, question_id: 'choice', answer: 'b' })
  await testMutate(ids.studentA, 'finish', { id: definition.id, version: attempt.attempt.version })
  await assert.rejects(edit({ ...journalPayload(column), max_points: 3 }), /TEACHING_TEST_MAX_POINTS_LOCKED/)
  await assert.rejects(mutate(ids.owner, 'save_activity', { ...journalPayload(column), max_points: 3 }), /TEACHING_TEST_MAX_POINTS_LOCKED/)
  await assert.rejects(testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, max_points: 12 }), /TEST_IMMUTABLE/)
  assert.equal((await testDetail(ids.owner, definition.id)).test.max_points, 16)
  assert.equal((await activity()).max_points, '16.00')

  await close(db, definition.id)
  detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: detail.test.version })
  await testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version })
  assert.equal((await db.query('select draft_score from teaching_grades where activity_id=$1', [column.id])).rows[0].draft_score, '4.00')

  const ordinary = await mutate(ids.owner, 'save_activity', { id: randomUUID(), version: 0, course_id: ids.course,
    group_id: groups[0], title: 'Звичайна робота', category: '', activity_date: dates.lesson_a, max_points: 20 })
  await mutate(ids.owner, 'save_activity', { ...ordinary, course_id: ids.course, group_id: groups[0], title: 'Звичайна робота', category: '', activity_date: dates.lesson_a, max_points: 10 })
  assert.equal((await db.query('select max_points from teaching_activities where id=$1', [ordinary.id])).rows[0].max_points, '10.00')
})

test('removing a test target deletes only its empty column and refuses removal after a grade was recorded', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  const { ids, groups, db, testMutate, testDetail, testList, mutate } = fx
  const definition = syntheticTest(ids.course, groups)
  let detail = await testMutate(ids.owner, 'save_test', definition)
  const columns = async () => (await db.query('select group_id,activity_id from teaching_test_activities where test_id=$1 order by group_id', [definition.id])).rows
  const initial = await columns()
  const removedId = initial.find(row => row.group_id === groups[1]).activity_id
  detail = await testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, targets: [definition.targets[0]] })
  assert.deepEqual(await columns(), initial.filter(row => row.group_id === groups[0]))
  assert.equal((await db.query('select count(*)::int n from teaching_activities where id=$1', [removedId])).rows[0].n, 0)
  assert.equal((await testList(ids.studentB, null, groups[1])).tests.length, 0)
  detail = await testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version })
  const restored = await columns()
  const restoredId = restored.find(row => row.group_id === groups[1]).activity_id
  assert.notEqual(restoredId, removedId)
  const entry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, groups[1], ids.studentB])).rows[0]
  await mutate(ids.owner, 'save_grade', { activity_id: restoredId, entry_id: entry.id, version: 0, score: 3, comment: '', reason: '' })
  await assert.rejects(testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, targets: [definition.targets[0]] }), /TEST_TARGET_HAS_GRADES/)
  assert.deepEqual(await columns(), restored)
  assert.equal((await testDetail(ids.owner, definition.id)).test.version, detail.test.version)
  assert.equal((await db.query('select draft_score::float score from teaching_grades where activity_id=$1', [restoredId])).rows[0].score, 3)
})

test('publication creates journal columns immediately and canonical edits retain their identity and independent date', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  const { ids, groups, dates, db, testMutate, testDetail, mutate } = fx
  const definition = syntheticTest(ids.course, groups, { status: 'draft', journal_date: dates.lesson_a, work_type: 'Залік' })
  let detail = await testMutate(ids.owner, 'save_test', definition)
  assert.equal((await db.query('select count(*)::int n from teaching_test_activities')).rows[0].n, 0)
  detail = await testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, status: 'published' })
  const activityRows = () => db.query('select l.group_id,a.id,a.title,a.work_type,a.activity_date::text,a.max_points,a.version from teaching_test_activities l join teaching_activities a on a.id=l.activity_id order by l.group_id')
  const initial = (await activityRows()).rows
  assert.equal(initial.length, 2)
  assert.ok(initial.every(activity => activity.work_type === 'Залік' && activity.activity_date === dates.lesson_a))
  assert.notEqual(dates.lesson_a, new Date(definition.closes_at).toISOString().slice(0, 10))
  detail = await testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, status: 'published', journal_date: dates.lesson_b, work_type: 'МКР', title: 'Модульна контрольна' })
  const updated = (await activityRows()).rows
  assert.deepEqual(updated.map(row => row.id), initial.map(row => row.id))
  assert.ok(updated.every(row => row.work_type === 'МКР' && row.activity_date === dates.lesson_b && row.title === 'Модульна контрольна'))
  detail = await testMutate(ids.owner, 'save_test', { ...definition, version: detail.test.version, status: 'published', journal_date: dates.lesson_b, work_type: 'МКР', title: 'Модульна контрольна' })
  assert.deepEqual((await activityRows()).rows.map(row => row.version), updated.map(row => row.version), 'unchanged publication metadata does not rewrite activity versions')
  const entry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, groups[0], ids.studentA])).rows[0]
  await mutate(ids.owner, 'save_grade', { activity_id: updated.find(row => row.group_id === groups[0]).id, entry_id: entry.id, version: 0, score: 5, comment: '', reason: '' })
  await assert.rejects(testMutate(ids.owner, 'save_test', { ...definition, status: 'published', version: detail.test.version, max_points: 4, bonus_points: 2 }), /TEACHING_MAX_BELOW_SCORE/)
  assert.equal((await testDetail(ids.owner, definition.id)).test.max_points, 20, 'failed canonical activity edit rolls back test metadata too')
})

test('question review records reasons and actors, invalidates approval and recalculates bonuses from corrected scores', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  const { ids, groups, db, testMutate, testDetail, testList, mutate } = fx
  const definition = syntheticTest(ids.course, [groups[0]])
  await testMutate(ids.owner, 'save_test', definition)
  const student = await testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
  await testMutate(ids.studentA, 'finish', { id: definition.id, version: student.attempt.version })
  let head = await testMutate(ids.headA, 'start', { id: definition.id, group_id: groups[0] })
  head = await testMutate(ids.headA, 'save_answer', { id: definition.id, version: head.attempt.version, question_id: 'choice', answer: 'b' })
  await testMutate(ids.headA, 'finish', { id: definition.id, version: head.attempt.version })
  await db.query('update teaching_test_attempts set elapsed_seconds=case when user_id=$1 then 1 else 2 end where test_id=$2', [ids.studentA, definition.id])
  await close(db, definition.id)
  let detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: 1 })
  assert.equal(attemptFor(detail, ids.headA).bonus_winner, true)
  const prior = attemptFor(detail, ids.studentA)
  const mark = { question_id: 'choice', mode: 'full', reason: 'Правильність підтверджено під час перевірки' }
  await assert.rejects(testMutate(ids.studentA, 'save_review', { id: definition.id, attempt_id: prior.id, version: prior.version, marks: [mark] }), /FORBIDDEN|UNVERIFIED/)
  await assert.rejects(testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: prior.id, version: prior.version, marks: [{ ...mark, reason: '' }] }), /TEST_REVIEW_REASON_REQUIRED/)
  detail = await testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: prior.id, version: prior.version, marks: [mark] })
  let reviewed = attemptFor(detail, ids.studentA)
  assert.equal(reviewed.auto_score, 0); assert.equal(reviewed.score, 5)
  assert.equal(detail.test.results_finalized_at, null); assert.equal(detail.test.approved_revision, null)
  assert.ok(detail.attempts.every(row => row.final_score === null && row.bonus_score === 0 && row.reviewed_at === null))
  assert.equal(reviewed.question_results[0].points, 5); assert.equal(reviewed.question_results[0].manual, true)
  assert.equal(reviewed.review_history[0].actor_name, 'Synthetic owner')
  assert.equal(reviewed.review_history[0].reason, mark.reason)
  await assert.rejects(testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: prior.id, version: prior.version, marks: [mark] }), /TEST_CONFLICT/)
  const replay = await testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: prior.id, version: reviewed.version, marks: [mark] })
  assert.equal(replay.test.version, detail.test.version); assert.equal(attemptFor(replay, ids.studentA).review_history.length, 1)
  for (const changed of [
    { question_id: 'sorting', mode: 'custom', points: 2.5, reason: 'Частину відповіді зараховано' },
    { question_id: 'sorting', mode: 'zero', reason: 'Відповідь не підтверджено' },
    { question_id: 'sorting', mode: 'auto', reason: 'Повернено автоматичну перевірку' },
  ]) {
    detail = await testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: prior.id, version: attemptFor(detail, ids.studentA).version, marks: [changed] })
  }
  assert.equal(attemptFor(detail, ids.studentA).review_history.length, 4)
  const hidden = await testDetail(ids.studentA, definition.id)
  for (const key of ['score', 'auto_score', 'question_results', 'question_reviews', 'review_history', 'grade_snapshot', 'current_grade', 'rank', 'bonus_winner']) assert.equal(hidden.attempt[key], undefined, key)
  await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_test_review_audit'), /permission denied/)
  await assert.rejects(fx.asUser(ids.studentA, 'select xelay_private_test_grade_snapshot($1,$2,$3)', [definition.id, groups[0], ids.headA]), /permission denied/)
  const summary = (await testList(ids.studentA, null, groups[0])).tests[0].my_attempt
  assert.equal(summary.status, 'submitted'); assert.equal(summary.published_score, null); assert.equal(summary.score, undefined)
  detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: detail.test.version })
  assert.equal(attemptFor(detail, ids.studentA).rank, 1); assert.equal(attemptFor(detail, ids.studentA).final_score, 7)
  assert.equal(attemptFor(detail, ids.headA).final_score, 5)
  detail = await testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version })
  const grade = (await db.query('select * from teaching_grades where id=$1', [(await db.query('select grade_id from teaching_test_attempts where id=$1', [prior.id])).rows[0].grade_id])).rows[0]
  await mutate(ids.owner, 'publish_grades', { activity_id: grade.activity_id, expected_versions: [{ entry_id: grade.entry_id, version: grade.version }] })
  assert.equal((await testList(ids.studentA, null, groups[0])).tests[0].my_attempt.published_score, 7)
  detail = await testDetail(ids.owner, definition.id)
  detail = await testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: prior.id, version: attemptFor(detail, ids.studentA).version, marks: [{ question_id: 'choice', mode: 'zero', reason: 'Виправлення після повторної перевірки' }] })
  await assert.rejects(testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version }), /TEST_REVIEW_REQUIRED/)
  assert.equal((await testDetail(ids.studentA, definition.id)).attempt.published_score, 7)
  detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: detail.test.version })
  await testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version })
  const changedGrade = (await db.query('select * from teaching_grades where id=$1', [grade.id])).rows[0]
  assert.equal(changedGrade.draft_score, '0.00'); assert.equal(changedGrade.published_score, '7.00')
})

test('approved journal snapshots prevent an atomic transfer from overwriting later manual grades', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  const { ids, groups, db, testMutate, testDetail, mutate } = fx
  const definition = syntheticTest(ids.course, [groups[0]], { bonus_percent: 0 })
  await testMutate(ids.owner, 'save_test', definition)
  for (const user of [ids.studentA, ids.headA]) {
    const detail = await testMutate(user, 'start', { id: definition.id, group_id: groups[0] })
    await testMutate(user, 'finish', { id: definition.id, version: detail.attempt.version })
  }
  await close(db, definition.id)
  let detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: 1 })
  const activity = (await db.query('select activity_id from teaching_test_activities where test_id=$1', [definition.id])).rows[0].activity_id
  const entries = (await db.query('select id,user_id from teaching_entries where course_id=$1 and group_id=$2', [ids.course, groups[0]])).rows
  const headEntry = entries.find(row => row.user_id === ids.headA)
  await mutate(ids.owner, 'save_grade', { activity_id: activity, entry_id: headEntry.id, version: 0, score: 4, comment: 'Окрема перевірка в журналі', reason: '' })
  await assert.rejects(testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version }), /TEST_GRADE_CONFLICT/)
  assert.equal((await db.query('select count(*)::int n from teaching_grades')).rows[0].n, 1)
  assert.ok((await testDetail(ids.owner, definition.id)).attempts.every(row => row.reviewed_at === null))
  detail = await testDetail(ids.owner, definition.id)
  assert.equal(attemptFor(detail, ids.headA).current_grade.draft_score, 4)
  detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: detail.test.version })
  assert.equal(attemptFor(detail, ids.headA).grade_snapshot.draft_score, 4)
  await testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version })
  assert.equal((await db.query('select count(*)::int n from teaching_grades')).rows[0].n, 2)
})
