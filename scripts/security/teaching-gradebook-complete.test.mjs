// Real teaching RPCs and current dispatcher migrations, synthetic identities only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'

test('current gradebook preserves drafts, publication, corrections, scopes and account links', async t => {
  const fx = await audienceFixture()
  t.after(() => fx.close())
  const { db, ids, groups: [groupA, groupB], dates, mutate, rpc, classroom } = fx
  for (const name of ['202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql', '202611040001_fix_teaching_gradebook_dispatch.sql']) {
    await db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
  }
  const activity = async (group, title) => mutate(ids.owner, 'save_activity', {
    id: randomUUID(), version: 0, course_id: ids.course, group_id: group, title,
    category: '', activity_date: dates.lesson_a, max_points: 10,
  })
  const firstActivity = await activity(groupA, 'Synthetic gradebook oral response')
  const secondActivity = await activity(groupB, 'Synthetic other group activity')
  const entries = (await db.query('select id,user_id from teaching_entries where course_id=$1 and group_id=$2', [ids.course, groupA])).rows
  const studentEntry = entries.find(row => row.user_id === ids.studentA).id
  const headEntry = entries.find(row => row.user_id === ids.headA).id
  const groupBEntry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, groupB, ids.studentB])).rows[0].id
  const save = (who, entry, version, score, reason = '', comment = '', id = firstActivity.id) => mutate(who, 'save_grade', { activity_id: id, entry_id: entry, version, score, reason, comment })
  const gradeRow = async entry => (await db.query('select * from teaching_grades where activity_id=$1 and entry_id=$2', [firstActivity.id, entry])).rows[0]
  const own = async who => (await rpc(who, 'xelay_teaching_group', [groupA])).grades
  const publish = rows => mutate(ids.owner, 'publish_grades', { activity_id: firstActivity.id, expected_versions: rows })
  let saved

  await t.test('zero and empty score are distinct drafts and persist across independent reads', async () => {
    saved = await save(ids.owner, studentEntry, 0, 0)
    assert.equal(Number((await gradeRow(studentEntry)).draft_score), 0)
    assert.equal((await own(ids.studentA)).length, 0)
    saved = await save(ids.owner, studentEntry, saved.version, null)
    assert.equal((await gradeRow(studentEntry)).draft_score, null)
    saved = await save(ids.owner, studentEntry, saved.version, 3, '', 'Private draft comment')
    const reloaded = await rpc(ids.owner, 'xelay_teaching_course', [ids.course])
    assert.equal(reloaded.grades.find(row => row.entry_id === studentEntry).draft_score, 3)
    assert.equal((await own(ids.headA)).length, 0)
    assert.doesNotMatch(JSON.stringify(await rpc(ids.studentA, 'xelay_teaching_course', [ids.course])), /Private draft comment/)
    for (const score of [-1, 11, 0.001]) await assert.rejects(save(ids.owner, studentEntry, saved.version, score), /INVALID_INPUT/)
  })

  await t.test('publication validates the captured version and students receive only their own result', async () => {
    await assert.rejects(publish([{ entry_id: studentEntry, version: saved.version - 1 }]), /CONFLICT/)
    assert.equal((await gradeRow(studentEntry)).published_at, null)
    await publish([{ entry_id: studentEntry, version: saved.version }])
    assert.equal((await own(ids.studentA))[0].published_score, 3)
    assert.equal((await own(ids.studentA))[0].published_comment, 'Private draft comment')
    assert.equal((await own(ids.headA)).length, 0)
    assert.equal((await rpc(ids.studentB, 'xelay_teaching_group', [groupB])).grades.length, 0)
    assert.ok((await own(ids.studentA)).every(row => !('draft_score' in row) && !('draft_comment' in row)))
  })

  await t.test('published corrections need a reason and stay private until a new publication', async () => {
    const row = await gradeRow(studentEntry)
    await assert.rejects(save(ids.owner, studentEntry, row.version, 4), /REVISION_REASON_REQUIRED/)
    saved = await save(ids.owner, studentEntry, row.version, 4, 'Synthetic correction', 'New private comment')
    assert.equal((await own(ids.studentA))[0].published_score, 3)
    assert.equal((await own(ids.studentA))[0].published_comment, 'Private draft comment')
    const auditBefore = (await db.query('select count(*)::int n from teaching_grade_audit')).rows[0].n
    assert.deepEqual(await save(ids.owner, studentEntry, saved.version, 4, 'Synthetic correction', 'New private comment'), saved)
    assert.equal((await db.query('select count(*)::int n from teaching_grade_audit')).rows[0].n, auditBefore)
    await publish([{ entry_id: studentEntry, version: saved.version }])
    assert.equal((await own(ids.studentA))[0].published_score, 4)
    assert.equal((await own(ids.studentA))[0].published_comment, 'New private comment')
  })

  let batch
  await t.test('batch save is atomic on stale rows and exact replay adds no duplicate history', async () => {
    const row = await gradeRow(studentEntry)
    const before = (await db.query('select to_jsonb(g) data from teaching_grades g where activity_id=$1 order by entry_id', [firstActivity.id])).rows
    const args = [randomUUID(), ids.course, groupA, firstActivity.id, ids.owner]
    await assert.rejects(rpc(ids.owner, 'xelay_save_teaching_grades_batch', [...args, JSON.stringify([
      { entry_id: studentEntry, version: row.version, score: 5, comment: '', reason: 'Batch correction' },
      { entry_id: headEntry, version: 9, score: 0, comment: '', reason: '' },
    ])]), /CONFLICT/)
    assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g where activity_id=$1 order by entry_id', [firstActivity.id])).rows, before)
    batch = [...args, JSON.stringify([
      { entry_id: studentEntry, version: row.version, score: 5, comment: '', reason: 'Batch correction' },
      { entry_id: headEntry, version: 0, score: 0, comment: '', reason: '' },
    ])]
    const result = await rpc(ids.owner, 'xelay_save_teaching_grades_batch', batch)
    const auditBefore = (await db.query('select count(*)::int n from teaching_grade_audit')).rows[0].n
    assert.deepEqual(await rpc(ids.owner, 'xelay_save_teaching_grades_batch', batch), result)
    assert.equal((await db.query('select count(*)::int n from teaching_grade_audit')).rows[0].n, auditBefore)
    assert.equal((await own(ids.studentA))[0].published_score, 4)
    assert.equal((await own(ids.headA)).length, 0)
    await publish([{ entry_id: studentEntry, version: (await gradeRow(studentEntry)).version }, { entry_id: headEntry, version: (await gradeRow(headEntry)).version }])
    assert.equal((await own(ids.studentA))[0].published_score, 5)
    assert.equal((await own(ids.headA))[0].published_score, 0)
  })

  await t.test('a colleague grades only the selected group and revocation also blocks receipt replay', async () => {
    const link = await mutate(ids.owner, 'invite_teacher', { course_id: ids.course, user_id: ids.colleague, permissions: ['grades'], group_scope: 'selected', group_ids: [groupA] })
    await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: link.id, accept: true })
    await assert.rejects(save(ids.colleague, groupBEntry, 0, 1, '', '', secondActivity.id), /FORBIDDEN/)
    await assert.rejects(mutate(ids.studentA, 'publish_grades', { activity_id: firstActivity.id, expected_versions: [{ entry_id: studentEntry, version: (await gradeRow(studentEntry)).version }] }), /FORBIDDEN|EXPIRED/)
    const row = await gradeRow(studentEntry)
    const colleagueBatch = [randomUUID(), ids.course, groupA, firstActivity.id, ids.colleague, JSON.stringify([{ entry_id: studentEntry, version: row.version, score: 6, comment: '', reason: 'Colleague correction' }])]
    await rpc(ids.colleague, 'xelay_save_teaching_grades_batch', colleagueBatch)
    assert.equal((await own(ids.studentA))[0].published_score, 5)
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: link.id, permissions: ['materials'], group_scope: 'selected', group_ids: [groupA] })
    await assert.rejects(rpc(ids.colleague, 'xelay_save_teaching_grades_batch', colleagueBatch), /FORBIDDEN/)
    assert.equal(Number((await gradeRow(studentEntry)).draft_score), 6)
  })

  await t.test('manual student records, roster refresh and explicit account confirmation keep the grade attached once', async () => {
    const entryPayload = { id: randomUUID(), version: 0, course_id: ids.course, group_id: groupA, full_name: 'Synthetic student without account' }
    const manual = await mutate(ids.owner, 'save_entry', entryPayload)
    assert.deepEqual(await mutate(ids.owner, 'save_entry', entryPayload), manual)
    const renamed = await mutate(ids.owner, 'save_entry', { ...entryPayload, version: manual.version, full_name: 'Synthetic corrected name' })
    await assert.rejects(mutate(ids.owner, 'save_entry', { ...entryPayload, version: manual.version, full_name: 'Stale name' }), /CONFLICT/)
    assert.equal(renamed.version, manual.version + 1)
    const grade = await save(ids.owner, manual.id, 0, 7)
    await publish([{ entry_id: manual.id, version: grade.version }])
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groupA, ids.outsider, ids.headA])
    await mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: groupA })
    assert.equal((await own(ids.outsider)).length, 0)
    const claim = await mutate(ids.owner, 'request_roster_link', { entry_id: manual.id, user_id: ids.outsider })
    await assert.rejects(mutate(ids.studentA, 'respond_roster_link', { claim_id: claim.id, accept: true }), /FORBIDDEN/)
    await mutate(ids.outsider, 'respond_roster_link', { claim_id: claim.id, accept: true })
    assert.equal((await own(ids.outsider))[0].published_score, 7)
    assert.equal((await db.query('select count(*)::int n from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, groupA, ids.outsider])).rows[0].n, 1)
    await mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: groupA })
    assert.equal((await own(ids.outsider)).length, 1)
    assert.equal((await own(ids.studentA))[0].published_score, 5)
  })

  for (const teamMode of [false, true]) await t.test(`${teamMode ? 'team' : 'individual'} submitted work saves grade drafts and publishes explicit results through the same journal`, async () => {
    const item = { id: randomUUID(), version: 0, course_id: ids.course, title: 'Synthetic submitted work', body: 'Synthetic task', links: [], attachments: [], status: 'published', max_points: 10, category: '', submission_mode: teamMode ? 'team' : 'individual', targets: [{ group_id: groupA, placement_mode: 'unplaced', lesson_date: dates.lesson_a, audience_mode: 'all', subgroup_ids: [], team_ids: [] }] }
    await classroom(ids.owner, 'save_group_assignment', item)
    if (teamMode) await rpc(ids.owner, 'xelay_teaching_audience_mutate', ['save_lab_team', JSON.stringify({ id: randomUUID(), version: 0, course_id: ids.course, group_id: groupA, item_id: item.id, name: 'Synthetic lab team', user_ids: [ids.studentA, ids.headA] })])
    const reserved = await classroom(ids.studentA, 'reserve_submission', { id: randomUUID(), version: 0, item_id: item.id, group_id: groupA })
    const savedWork = await classroom(ids.studentA, 'save_submission', { id: reserved.id, version: reserved.version, item_id: item.id, group_id: groupA, body: 'Synthetic answer', links: [], attachments: [] })
    const submitted = await classroom(ids.studentA, 'submit_submission', { id: savedWork.id, version: savedWork.version })
    const staff = await rpc(ids.owner, 'xelay_classroom_assignment', [item.id, groupA])
    const work = staff.submissions.find(row => row.id === submitted.id)
    if (teamMode) {
      const payload = { id: submitted.id, version: submitted.version, score: 8, feedback: 'Synthetic checked team answer', publish: false, confirm_team: true, expected_user_id: ids.owner, grade_versions: Object.fromEntries(work.team_members.map(member => [member.entry_id, member.grade_version])) }
      const reviewed = await classroom(ids.owner, 'grade_team_submission', payload)
      assert.deepEqual(await classroom(ids.owner, 'grade_team_submission', payload), reviewed)
      assert.equal((await rpc(ids.studentA, 'xelay_classroom_assignment', [item.id, groupA])).my_submission.published_score, null)
      const activityId = (await db.query('select id from teaching_activities where item_id=$1 and group_id=$2', [item.id, groupA])).rows[0].id
      const gradeRows = (await db.query('select entry_id,version from teaching_grades where activity_id=$1', [activityId])).rows
      assert.equal(gradeRows.length, 2)
      await mutate(ids.owner, 'publish_grades', { activity_id: activityId, expected_versions: gradeRows })
      for (const who of [ids.studentA, ids.headA]) assert.equal((await rpc(who, 'xelay_classroom_assignment', [item.id, groupA])).my_submission.published_score, 8)
    } else {
      const reviewed = await classroom(ids.owner, 'review_submission', { id: submitted.id, version: submitted.version, status: 'reviewed', feedback: 'Synthetic checked answer', score: 9, grade_version: 0 })
      assert.equal(reviewed.version, submitted.version + 1)
      assert.equal((await rpc(ids.studentA, 'xelay_classroom_assignment', [item.id, groupA])).my_submission.published_score, 9)
      assert.equal((await rpc(ids.headA, 'xelay_classroom_assignment', [item.id, groupA])).my_submission, null)
    }
    assert.equal((await rpc(ids.outsider, 'xelay_classroom_assignment', [item.id, groupA])).my_submission, null)
  })

  await t.test('clearing a published zero requires a reason and preserves the old result until publication', async () => {
    const work = await activity(groupA, 'Synthetic score removal')
    const grade = await save(ids.owner, studentEntry, 0, 0, '', '', work.id)
    await mutate(ids.owner, 'publish_grades', { activity_id: work.id, expected_versions: [{ entry_id: studentEntry, version: grade.version }] })
    const version = (await db.query('select version from teaching_grades where id=$1', [grade.id])).rows[0].version
    await assert.rejects(save(ids.owner, studentEntry, version, null, '', '', work.id), /REVISION_REASON_REQUIRED/)
    const cleared = await save(ids.owner, studentEntry, version, null, 'Synthetic ungrading', '', work.id)
    assert.equal((await own(ids.studentA)).find(row => row.activity_id === work.id).published_score, 0)
    await mutate(ids.owner, 'publish_grades', { activity_id: work.id, expected_versions: [{ entry_id: studentEntry, version: cleared.version }] })
    assert.equal((await own(ids.studentA)).find(row => row.activity_id === work.id).published_score, null)
    const events = (await db.query('select event,old_score,new_score,reason from teaching_grade_audit where activity_id=$1 order by created_at,id', [work.id])).rows
    assert.equal(events.filter(row => row.event === 'draft').length, 2)
    assert.equal(events.filter(row => row.event === 'publication').length, 2)
    assert.ok(events.some(row => row.reason === 'Synthetic ungrading' && row.new_score === null))
  })
})
