import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { teachingTestsFixture, syntheticTest } from './teaching-tests-fixture.mjs'

const rubric = { criteria: [
  { id: 'content', title: 'Зміст', levels: [{ id: 'none', label: 'Не розкрито', points: 0 }, { id: 'partial', label: 'Частково', points: 2 }, { id: 'equivalent', label: 'Альтернативне пояснення', points: 2 }, { id: 'full', label: 'Повністю', points: 4 }] },
  { id: 'reasoning', title: 'Аргументація', levels: [{ id: 'none', label: 'Немає', points: 0 }, { id: 'full', label: 'Обґрунтовано', points: 1 }] },
] }
const levels = { content: 'partial', reasoning: 'full' }

test('criterion marks are server-derived, versioned drafts and visible only to their owner after journal publication', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  for (const name of ['202611040020_assessment_bank_variants.sql', '202611040021_teaching_rubrics.sql']) await fx.db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
  const { ids, groups, db, rpc, classroom, mutate } = fx
  const change = (user, action, payload) => rpc(user, 'xelay_teaching_rubric_mutate', [action, JSON.stringify({ ...payload, expected_user_id: user })])
  const get = user => rpc(user, 'xelay_teaching_rubric', [assignment.id, groups[0]])
  const assignment = { id: randomUUID(), course_id: ids.course, version: 0, title: 'Synthetic rubric essay', body: 'Explain reasoning', links: [], attachments: [], status: 'published', submission_mode: 'individual', max_points: 10, category: '', targets: [{ group_id: groups[0], audience_mode: 'all', subgroup_ids: [], team_ids: [], placement_mode: 'unplaced', lesson_date: fx.dates.lesson_a, due_at: null, closes_at: null }] }
  await classroom(ids.owner, 'save_group_assignment', assignment)
  const context = { assignment_id: assignment.id, group_id: groups[0] }
  await assert.rejects(change(ids.studentA, 'save_rubric', { ...context, version: 0, rubric }), /FORBIDDEN|UNVERIFIED/)
  await assert.rejects(change(ids.owner, 'save_rubric', { ...context, version: 0, rubric: { criteria: [{ ...rubric.criteria[0], levels: [{ id: 'a', label: 'a', points: -5 }, { id: 'b', label: 'b', points: 0 }] }] } }), /RUBRIC_INVALID_INPUT/)
  const configured = await change(ids.owner, 'save_rubric', { ...context, version: 0, rubric })
  assert.equal(configured.version, 1)
  assert.deepEqual((await get(ids.studentA)).marks, [])
  await assert.rejects(get(ids.studentB), /FORBIDDEN/)
  let submission = await classroom(ids.studentA, 'reserve_submission', { id: randomUUID(), version: 0, item_id: assignment.id, group_id: groups[0] })
  submission = await classroom(ids.studentA, 'save_submission', { id: submission.id, version: submission.version, body: 'My synthetic reasoning', links: [], attachments: [] })
  submission = await classroom(ids.studentA, 'submit_submission', { id: submission.id, version: submission.version })
  await mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: groups[0] })
  const payload = { ...context, submission_id: submission.id, submission_version: submission.version, rubric_version: 1, version: 0, grade_version: 0, levels, feedback: 'Clear criteria', reason: 'Reviewed by criteria', score: 999 }
  await assert.rejects(change(ids.owner, 'assess_submission', { ...payload, levels: { ...levels, extra: 'full' } }), /RUBRIC_INVALID_INPUT/)
  await assert.rejects(change(ids.owner, 'assess_submission', { ...payload, levels: { content: 'not-a-level', reasoning: 'full' } }), /RUBRIC_INVALID_INPUT/)
  const assessed = await change(ids.owner, 'assess_submission', payload)
  assert.equal(assessed.marks[0].score, 6, 'posted score cannot override authoritative level score')
  assert.equal((await get(ids.studentA)).marks.length, 0, 'rubric remains private while its score is a draft')
  await assert.rejects(change(ids.owner, 'assess_submission', payload), /RUBRIC_CONFLICT|TEACHING_CONFLICT/)
  await assert.rejects(change(ids.owner, 'save_rubric', { ...context, version: 1, rubric }), /RUBRIC_LOCKED/)
  const grade = (await db.query('select g.* from teaching_grades g join teaching_activities a on a.id=g.activity_id where a.item_id=$1', [assignment.id])).rows[0]
  assert.equal(Number(grade.draft_score), 6); assert.equal(grade.published_score, null)
  await mutate(ids.owner, 'publish_grades', { activity_id: grade.activity_id, expected_versions: [{ entry_id: grade.entry_id, version: grade.version }] })
  const visible = await get(ids.studentA)
  assert.equal(visible.marks.length, 1); assert.deepEqual(visible.marks[0].levels, levels)
  assert.equal((await get(ids.headA)).marks.length, 0, 'a classmate cannot see the assessed student')
  await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_rubric_marks'), /permission denied/)
  assert.equal((await db.query('select count(*)::int n from teaching_rubric_mark_audit')).rows[0].n, 1)

  const essay = { id: 'essay', kind: 'essay', text: 'Explain the example.', points: 10, time_limit_seconds: null, partial_credit: false, options: [], buckets: [], rubric }
  const definition = syntheticTest(ids.course, [groups[0]], { questions: [essay], bonus_percent: 0 })
  await fx.testMutate(ids.owner, 'save_test', definition)
  let detail = await fx.testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
  assert.equal(detail.attempt.current_question.rubric, undefined)
  detail = await fx.testMutate(ids.studentA, 'save_answer', { id: definition.id, version: detail.attempt.version, question_id: 'essay', answer: 'Synthetic essay' })
  detail = await fx.testMutate(ids.studentA, 'finish', { id: definition.id, version: detail.attempt.version })
  await assert.rejects(fx.testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: detail.attempt.id, version: detail.attempt.version, marks: [{ question_id: 'essay', mode: 'custom', points: 10, reason: 'Without criteria' }] }), /RUBRIC_INVALID_INPUT/)
  const reviewed = await fx.testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: detail.attempt.id, version: detail.attempt.version, marks: [{ question_id: 'essay', mode: 'custom', points: 1000, reason: 'By criteria', rubric_levels: levels }] })
  assert.equal(reviewed.attempts[0].question_results[0].points, 6)
  assert.deepEqual(reviewed.attempts[0].question_results[0].rubric_levels, levels)
  const privateResult = await fx.testDetail(ids.studentA, definition.id)
  assert.equal(privateResult.attempt.question_results, undefined)
  assert.equal(privateResult.attempt.published_rubrics, undefined)
  const sameScore = await fx.testMutate(ids.owner, 'save_review', { id: definition.id, attempt_id: detail.attempt.id, version: reviewed.attempts[0].version, marks: [{ question_id: 'essay', mode: 'custom', reason: 'By criteria', rubric_levels: { content: 'equivalent', reasoning: 'full' } }] })
  assert.ok(sameScore.attempts[0].version > reviewed.attempts[0].version, 'same-score level correction still advances the version')
  assert.equal((await db.query('select count(*)::int n from teaching_test_rubric_audit')).rows[0].n, 2)
  await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second',opens_at=clock_timestamp()-interval '1 day' where id=$1", [definition.id])
  const approved = await fx.testMutate(ids.owner, 'finalize_results', { id: definition.id, version: sameScore.test.version })
  await fx.testMutate(ids.owner, 'review_results', { id: definition.id, version: approved.test.version })
  const testGrade = (await db.query('select g.* from teaching_grades g join teaching_test_activities a on a.activity_id=g.activity_id where a.test_id=$1', [definition.id])).rows[0]
  await mutate(ids.owner, 'publish_grades', { activity_id: testGrade.activity_id, expected_versions: [{ entry_id: testGrade.entry_id, version: testGrade.version }] })
  const ownPublished = await fx.testDetail(ids.studentA, definition.id)
  assert.equal(ownPublished.attempt.published_rubrics.length, 1)
  assert.equal(ownPublished.attempt.published_rubrics[0].points, 6)
  assert.equal(ownPublished.attempt.published_rubrics[0].rubric.criteria[0].title, 'Зміст')
  assert.equal(ownPublished.attempt.questions, undefined)
  const publishedTest=await fx.testDetail(ids.owner,definition.id)
  const correctedLevels={content:'partial',reasoning:'full'}
  const corrected=await fx.testMutate(ids.owner,'save_review',{id:definition.id,attempt_id:detail.attempt.id,version:publishedTest.attempts[0].version,
    marks:[{question_id:'essay',mode:'custom',reason:'Equivalent points, revised criteria',rubric_levels:correctedLevels}]})
  assert.equal(corrected.attempts[0].score,ownPublished.attempt.published_score,'rubric-only correction leaves the scaled total unchanged')
  assert.equal((await fx.testDetail(ids.studentA,definition.id)).attempt.published_rubrics,undefined,'saving revised criteria does not publish them')
  const correctedApproval=await fx.testMutate(ids.owner,'finalize_results',{id:definition.id,version:corrected.test.version})
  assert.equal((await fx.testDetail(ids.studentA,definition.id)).attempt.published_rubrics,undefined,'equal old published score cannot expose revised criteria after approval alone')
  await fx.testMutate(ids.owner,'review_results',{id:definition.id,version:correctedApproval.test.version})
  assert.equal((await fx.testDetail(ids.studentA,definition.id)).attempt.published_rubrics,undefined,'latest criteria transfer stays private until journal publication')
  const correctedGrade=(await db.query('select * from teaching_grades where id=$1',[testGrade.id])).rows[0]
  assert.notEqual(correctedGrade.draft_comment,correctedGrade.published_comment,'rubric-only correction is an explicit publishable draft, not a journal no-op')
  assert.equal(Number(correctedGrade.published_score),ownPublished.attempt.published_score,'previously published result remains intact')
  await mutate(ids.owner,'publish_grades',{activity_id:correctedGrade.activity_id,expected_versions:[{entry_id:correctedGrade.entry_id,version:correctedGrade.version}]})
  const republished=await fx.testDetail(ids.studentA,definition.id)
  assert.equal(republished.attempt.published_rubrics.length,1)
  assert.deepEqual(republished.attempt.published_rubrics[0].levels,correctedLevels,'revised equal-score criteria appear only after explicit journal re-publication')
})
