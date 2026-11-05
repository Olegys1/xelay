// The local preview runs the actual migration chain, never a separate fake API.
import test from 'node:test'
import assert from 'node:assert/strict'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
import { seedCourseModulesPreview } from './course-modules-preview-seed.mjs'

test('advanced local preview preserves original modules and offers admission, twenty-to-three, separate review and lecture/seminar journal data', async t => {
  const fx = await courseModulesFixture({ additionalMigrations: ['202611040060_teaching_test_admission.sql', '202611050061_teaching_test_explicit_close.sql', '202611050070_teaching_personal_journal_view.sql'] })
  t.after(() => fx.close())
  const seed = await seedCourseModulesPreview(fx, { advanced: true }), { ids, groups, db, rpc } = fx
  const detail = (actor, id) => rpc(actor, 'xelay_teaching_test', [id])
  const original = await rpc(ids.studentA, 'xelay_student_course_modules', [ids.course, groups[0]])
  assert.equal(original.modules.length, 2); assert.equal(original.modules[0].items[0].available, true)
  assert.equal(original.modules[0].items[1].locked, true); assert.equal(original.modules[1].locked, true)
  const owner = await detail(ids.owner, seed.poolTestId)
  assert.equal(owner.test.questions.length, 20); assert.equal(owner.test.draw_count, 3)
  const denied = await detail(ids.studentA, seed.poolTestId)
  assert.equal(denied.test.my_admission.allowed, false); assert.match(denied.test.my_admission.reason, /для допуску/)
  assert.deepEqual(denied.test.questions, []); assert.equal(denied.test.description, '')
  await assert.rejects(rpc(ids.studentA, 'xelay_teaching_test_mutate', ['start', JSON.stringify({ id: seed.poolTestId, group_id: groups[0], expected_user_id: ids.studentA })]), /NOT_ADMITTED/)
  const started = await rpc(ids.headA, 'xelay_teaching_test_mutate', ['start', JSON.stringify({ id: seed.poolTestId, group_id: groups[0], expected_user_id: ids.headA })])
  assert.equal(started.attempt.question_count, 3); assert.equal(started.attempt.current_question.answer, undefined)
  const actual = (await db.query('select questions from teaching_test_attempts where id=$1', [started.attempt.id])).rows[0].questions
  assert.equal(actual.length, 3); assert.equal(new Set(actual.map(question => question.id)).size, 3)
  assert.equal((await detail(ids.headA, seed.poolTestId)).attempt.id, started.attempt.id)
  const review = await detail(ids.owner, seed.reviewTestId)
  assert.equal(review.test.status, 'closed'); assert.ok(review.test.closed_early_at)
  assert.equal(review.test.results_finalized_at, null); assert.equal(review.attempts.length, 2)
  assert.ok(review.attempts.every(attempt => attempt.status === 'submitted'))
  const grades = await db.query('select g.* from teaching_grades g join teaching_activities a on a.id=g.activity_id join teaching_test_activities l on l.activity_id=a.id where l.test_id=$1', [seed.reviewTestId])
  assert.equal(grades.rows.length, 0, 'Seed does not approve, transfer or publish these results')
  const snapshot = await rpc(ids.owner, 'xelay_teaching_course', [ids.course])
  assert.ok(snapshot.activities.some(activity => activity.schedule_lesson_type === 'lecture'))
  assert.ok(snapshot.activities.some(activity => activity.schedule_lesson_type === 'seminar'))
  assert.ok(snapshot.activities.some(activity => activity.schedule_lesson_type === 'lab'))
  const before = snapshot.activities.map(activity => activity.id).sort()
  const view = await rpc(ids.owner, 'xelay_teaching_save_journal_view', [ids.course, groups[0], JSON.stringify({ layout: 'separate', show_lectures: false, section: 'seminars' }), 0, ids.owner])
  assert.equal(view.view_settings.show_lectures, false)
  assert.deepEqual((await rpc(ids.owner, 'xelay_teaching_course', [ids.course])).activities.map(activity => activity.id).sort(), before)
})
