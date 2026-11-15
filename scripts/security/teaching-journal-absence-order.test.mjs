import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'
import { syntheticTest, teachingTestsFixture } from './teaching-tests-fixture.mjs'

async function fixture() {
  const result = await audienceFixture()
  for (const name of ['202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql',
    '202611040001_fix_teaching_gradebook_dispatch.sql', '202611040011_teaching_journal_preferences_absence.sql']) {
    await result.db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
  }
  return result
}
test('absence replaces the grade through drafts, corrections, atomic batch and own publication', async t => {
  const fx = await fixture(); t.after(() => fx.close())
  const { ids, groups, dates, mutate, rpc, db } = fx
  const activity = await mutate(ids.owner, 'save_activity', { id: randomUUID(), version: 0, course_id: ids.course, group_id: groups[0], title: 'Synthetic attendance', category: '', activity_date: dates.lesson_a, max_points: 20 })
  const entries = (await db.query('select id,user_id from teaching_entries where course_id=$1 and group_id=$2', [ids.course, groups[0]])).rows
  const student = entries.find(e => e.user_id === ids.studentA).id, head = entries.find(e => e.user_id === ids.headA).id
  const base = { activity_id: activity.id, entry_id: student, score: null, absent: true, comment: '', reason: '', version: 0 }
  let grade = await mutate(ids.owner, 'save_grade', base)
  let row = (await db.query('select * from teaching_grades where id=$1', [grade.id])).rows[0]
  assert.equal(row.draft_absent, true); assert.equal(row.draft_score, null); assert.equal(row.published_absent, false)
  assert.equal((await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades.length, 0)
  const count = async () => Number((await db.query('select count(*) n from teaching_grade_audit where activity_id=$1', [activity.id])).rows[0].n)
  const firstCount = await count()
  assert.deepEqual(await mutate(ids.owner, 'save_grade', { ...base, version: grade.version }), grade)
  assert.equal(await count(), firstCount)
  await mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: student, version: grade.version }] })
  const own = (await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades[0]
  assert.equal(own.published_absent, true); assert.equal(own.published_score, null); assert.equal(own.draft_absent, undefined)
  row = (await db.query('select * from teaching_grades where id=$1', [grade.id])).rows[0]
  await assert.rejects(mutate(ids.owner, 'save_grade', { ...base, absent: false, version: row.version }), /REVISION_REASON_REQUIRED/)
  grade = await mutate(ids.owner, 'save_grade', { ...base, absent: false, score: 5, reason: 'Відпрацював', version: row.version })
  assert.equal((await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades[0].published_absent, true)
  await mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: student, version: grade.version }] })
  const changed = (await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades[0]
  assert.equal(changed.published_absent, false); assert.equal(changed.published_score, 5)
  row = (await db.query('select * from teaching_grades where id=$1', [grade.id])).rows[0]
  const request = randomUUID(), rows = [{ entry_id: student, score: null, absent: true, comment: '', reason: 'Виправлено відвідування', version: row.version },
    { entry_id: head, score: 0, absent: false, comment: '', reason: '', version: 0 }]
  const args = [request, ids.course, groups[0], activity.id, ids.owner, JSON.stringify(rows)]
  const batch = await rpc(ids.owner, 'xelay_save_teaching_grades_batch', args)
  const afterBatch = await count(); assert.deepEqual(await rpc(ids.owner, 'xelay_save_teaching_grades_batch', args), batch); assert.equal(await count(), afterBatch)
  const drafts = (await db.query('select entry_id,version from teaching_grades where activity_id=$1', [activity.id])).rows
  await mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: drafts })
  assert.equal((await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades[0].published_absent, true)
  assert.equal((await rpc(ids.headA, 'xelay_teaching_group', [groups[0]])).grades[0].published_score, 0)
  assert.equal((await rpc(ids.studentB, 'xelay_teaching_group', [groups[1]])).grades.length, 0)
  const audit = (await db.query('select old_absent,new_absent,event from teaching_grade_audit where activity_id=$1 order by created_at', [activity.id])).rows
  assert.ok(audit.some(a => a.new_absent && a.event === 'publication'))
  assert.ok(audit.some(a => a.old_absent && !a.new_absent && a.event === 'draft'))
  await assert.rejects(mutate(ids.studentA, 'save_grade', { ...base, version: 999 }), /FORBIDDEN|EXPIRED/)
  await assert.rejects(mutate(ids.owner, 'save_grade', { ...base, score: 5, version: 999 }), /INVALID_INPUT/)
})

test('personal journal order is private, scoped, versioned and never edits grades', async t => {
  const fx = await fixture(); t.after(() => fx.close())
  const { ids, groups, dates, mutate, rpc, db, asUser } = fx
  const activities = []
  for (const title of ['First', 'Second', 'Third']) activities.push((await mutate(ids.owner, 'save_activity', { id: randomUUID(), version: 0, course_id: ids.course,
    group_id: groups[0], title, category: '', activity_date: dates.lesson_a, max_points: 20 })).id)
  const before = (await db.query('select to_jsonb(g) data from teaching_grades g')).rows
  assert.deepEqual(await rpc(ids.owner, 'xelay_teaching_journal_preferences', [ids.course, groups[0]]), { activity_ids: [], version: 0 })
  const order = [...activities].reverse(), array = '{' + order.join(',') + '}'
  const saved = await rpc(ids.owner, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], array, 0, ids.owner])
  assert.deepEqual(saved.activity_ids, order); assert.equal(saved.version, 1)
  assert.deepEqual(await rpc(ids.owner, 'xelay_teaching_journal_preferences', [ids.course, groups[0]]), saved)
  const invitation = await mutate(ids.owner, 'invite_teacher', { course_id: ids.course, user_id: ids.colleague, permissions: ['grades'], group_scope: 'selected', group_ids: [groups[0]] })
  await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: invitation.id, accept: true })
  assert.deepEqual(await rpc(ids.colleague, 'xelay_teaching_journal_preferences', [ids.course, groups[0]]), { activity_ids: [], version: 0 })
  await rpc(ids.colleague, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], '{' + activities.join(',') + '}', 0, ids.colleague])
  assert.deepEqual(await rpc(ids.owner, 'xelay_teaching_journal_preferences', [ids.course, groups[0]]), saved)
  await assert.rejects(rpc(ids.colleague, 'xelay_teaching_journal_preferences', [ids.course, groups[1]]), /FORBIDDEN/)
  assert.deepEqual(await rpc(ids.owner, 'xelay_teaching_journal_preferences', [ids.course, groups[1]]), { activity_ids: [], version: 0 })
  await assert.rejects(rpc(ids.owner, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], '{' + activities.join(',') + '}', 0, ids.owner]), /CONFLICT/)
  await assert.rejects(rpc(ids.studentA, 'xelay_teaching_journal_preferences', [ids.course, groups[0]]), /FORBIDDEN/)
  await assert.rejects(rpc(ids.owner, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], array, 1, ids.studentA]), /ACTOR_CHANGED/)
  await assert.rejects(rpc(ids.owner, 'xelay_teaching_save_journal_preferences', [ids.course, groups[0], '{' + randomUUID() + '}', 1, ids.owner]), /INVALID_INPUT/)
  await assert.rejects(asUser(ids.owner, 'select * from teaching_journal_preferences'), /permission denied/)
  assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g')).rows, before)
})

test('quiz approval and journal absence cooperate without silently overwriting later changes', async t => {
  const fx = await teachingTestsFixture(); t.after(() => fx.close())
  await fx.db.exec(await readFile(new URL('../../supabase/migrations/202611040011_teaching_journal_preferences_absence.sql', import.meta.url), 'utf8'))
  const { ids, groups, dates, db, mutate, rpc, testMutate, testDetail } = fx
  const definition = syntheticTest(ids.course, [groups[0]], { bonus_percent: 0, work_type: 'МКР', journal_date: dates.lesson_a })
  await testMutate(ids.owner, 'save_test', definition)
  const activity = (await db.query('select a.* from teaching_test_activities t join teaching_activities a on a.id=t.activity_id where t.test_id=$1', [definition.id])).rows[0]
  assert.equal(activity.work_type, 'МКР')
  const started = await testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
  await testMutate(ids.studentA, 'finish', { id: definition.id, version: started.attempt.version })
  await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second',opens_at=clock_timestamp()-interval '1 day' where id=$1", [definition.id])
  let detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: 1 })
  const entry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, groups[0], ids.studentA])).rows[0]
  const absent = await mutate(ids.owner, 'save_grade', { activity_id: activity.id, entry_id: entry.id, version: 0, score: null, absent: true, comment: 'Відсутність перевірено', reason: '' })
  await mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: entry.id, version: absent.version }] })
  await assert.rejects(testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version }), /TEST_GRADE_CONFLICT/)
  detail = await testDetail(ids.owner, definition.id)
  assert.equal(detail.attempts[0].current_grade.draft_absent, true)
  detail = await testMutate(ids.owner, 'finalize_results', { id: definition.id, version: detail.test.version })
  assert.equal(detail.attempts[0].grade_snapshot.draft_absent, true)
  await testMutate(ids.owner, 'review_results', { id: definition.id, version: detail.test.version })
  const grade = (await db.query('select * from teaching_grades where id=$1', [absent.id])).rows[0]
  assert.equal(grade.draft_absent, false); assert.equal(Number(grade.draft_score), 0)
  assert.equal(grade.published_absent, true); assert.equal(grade.published_score, null)
  const studentDraft = (await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades[0]
  assert.equal(studentDraft.published_absent, true); assert.equal(studentDraft.draft_absent, undefined)
  await mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: entry.id, version: grade.version }] })
  const studentPublished = (await rpc(ids.studentA, 'xelay_teaching_group', [groups[0]])).grades[0]
  assert.equal(studentPublished.published_absent, false); assert.equal(studentPublished.published_score, 0)
})
