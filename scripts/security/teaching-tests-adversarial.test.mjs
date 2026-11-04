// Adversarial tests use isolated PostgreSQL and synthetic teaching accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'

test('test attempts enforce current group access, staff separation and server deadlines', async t => {
  const fx = await audienceFixture()
  t.after(() => fx.close())
  const { db, ids, groups, rpc, mutate } = fx
  for (const name of ['202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql', '202611040001_fix_teaching_gradebook_dispatch.sql', '202611040010_teaching_tests.sql']) {
    await db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
  }
  const times = (await db.query("select (clock_timestamp()-interval '1 minute')::text opens_at,(clock_timestamp()+interval '1 hour')::text closes_at")).rows[0]
  const definition = () => ({
    id: randomUUID(), version: 0, course_id: ids.course, title: 'Synthetic security test', description: 'Synthetic instructions', status: 'published',
    ...times, duration_seconds: 1200, max_points: 20, category: '', allow_skip: true, allow_return: true,
    question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 20, bonus_points: 2,
    targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })),
    questions: [{ id: 'question1', kind: 'choice', text: 'Choose an answer', points: 1, time_limit_seconds: 30, partial_credit: false,
      options: ['a', 'b', 'c', 'd'].map(id => ({ id, text: 'Synthetic option ' + id })), buckets: [], answer: 'b' }],
  })
  const command = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify(payload)])
  const detail = (who, id) => rpc(who, 'xelay_teaching_test', [id])
  const create = async () => {
    const payload = definition()
    await command(ids.owner, 'save_test', payload)
    return payload
  }

  await t.test('students receive no answer key, only one current question, and cannot use private table/helper access', async () => {
    const payload = await create()
    const before = await detail(ids.studentA, payload.id)
    assert.deepEqual(before.test.questions, [])
    assert.deepEqual(before.attempts, [])
    assert.equal(before.attempt, null)
    const started = await command(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })
    assert.equal(started.attempt.current_question.id, 'question1')
    assert.ok(!('answer' in started.attempt.current_question))
    assert.ok(!('score' in started.attempt))
    assert.ok(!('final_score' in started.attempt))
    await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_tests'), error => error.code === '42501')
    await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_test_attempts'), error => error.code === '42501')
    await assert.rejects(fx.asUser(ids.studentA, "select xelay_private_test_score('[]','{}',20)"), error => error.code === '42501')
    await assert.rejects(command(ids.studentB, 'start', { id: payload.id, group_id: groups[0] }), /FORBIDDEN/)
  })

  await t.test('repeated start resumes one immutable attempt without resetting timers', async () => {
    const payload = await create()
    const first = await command(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })
    const second = await command(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })
    assert.equal(second.attempt.id, first.attempt.id)
    assert.equal(second.attempt.started_at, first.attempt.started_at)
    assert.equal(second.attempt.expires_at, first.attempt.expires_at)
    assert.deepEqual(second.attempt.opened_at, first.attempt.opened_at)
    await assert.rejects(command(ids.owner, 'save_test', { ...payload, version: first.test.version, questions: [{ ...payload.questions[0], answer: 'a' }] }), /IMMUTABLE/)
    assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1 and user_id=$2', [payload.id, ids.studentA])).rows[0].n, 1)
  })

  await t.test('losing the original group blocks an old attempt even with access to another target group', async () => {
    const payload = await create()
    const started = await command(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groups[1], ids.studentA, ids.headB])
    await db.query('delete from study_group_members where group_id=$1 and user_id=$2', [groups[0], ids.studentA])
    await assert.rejects(detail(ids.studentA, payload.id), /FORBIDDEN/)
    await assert.rejects(command(ids.studentA, 'save_answer', { id: payload.id, version: started.attempt.version, question_id: 'question1', answer: 'b' }), /FORBIDDEN/)
    await assert.rejects(command(ids.studentA, 'start', { id: payload.id, group_id: groups[1] }), /FORBIDDEN/)
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groups[0], ids.studentA, ids.headA])
    assert.equal((await detail(ids.studentA, payload.id)).attempt.id, started.attempt.id)
  })

  await t.test('a course teacher who is also a group member cannot create a graded self-attempt', async () => {
    const payload = await create()
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groups[0], ids.owner, ids.headA])
    await assert.rejects(command(ids.owner, 'start', { id: payload.id, group_id: groups[0] }), /FORBIDDEN/)
    assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1 and user_id=$2', [payload.id, ids.owner])).rows[0].n, 0)
    assert.equal((await detail(ids.owner, payload.id)).test.questions[0].answer, 'b')
    await db.query('delete from study_group_members where group_id=$1 and user_id=$2', [groups[0], ids.owner])
  })

  await t.test('server question expiry rejects a late answer and total expiry submits without accepting a late change', async () => {
    const payload = await create()
    const started = await command(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })
    await db.query("update teaching_test_attempts set opened_at=jsonb_build_object('question1',clock_timestamp()-interval '31 seconds') where id=$1", [started.attempt.id])
    await assert.rejects(command(ids.studentA, 'save_answer', { id: payload.id, version: started.attempt.version, question_id: 'question1', answer: 'b' }), /ANSWER_LOCKED/)
    await db.query("update teaching_test_attempts set expires_at=clock_timestamp()-interval '1 second' where id=$1", [started.attempt.id])
    const finished = await command(ids.studentA, 'save_answer', { id: payload.id, version: started.attempt.version, question_id: 'question1', answer: 'b' })
    assert.equal(finished.attempt.status, 'submitted')
    assert.deepEqual(finished.attempt.answers, {})
    assert.equal((await db.query('select score::float from teaching_test_attempts where id=$1', [started.attempt.id])).rows[0].score, 0)
    assert.equal((await command(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })).attempt.id, started.attempt.id)
  })

  await t.test('authoring permissions match server requirements and a malformed question kind is rejected', async () => {
    const payload = await create()
    const link = await mutate(ids.owner, 'invite_teacher', { course_id: ids.course, user_id: ids.colleague, permissions: ['assignments'], group_scope: 'selected', group_ids: [...groups] })
    await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: link.id, accept: true })
    assert.equal((await detail(ids.colleague, payload.id)).test.can_edit, false)
    const broken = definition()
    broken.questions = [{ id: 'sorting1', text: 'Sort options', points: 1, time_limit_seconds: null, partial_credit: true,
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], buckets: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }], answer: { a: 'x', b: 'y' } }]
    await assert.rejects(command(ids.owner, 'save_test', broken), /INVALID_INPUT/)
  })

  await t.test('revoked participants retain history without blocking review or taking a bonus from eligible students', async () => {
    const payload = definition()
    payload.targets = [payload.targets[0]]
    payload.questions.push({ ...payload.questions[0], id: 'question2' })
    await command(ids.owner, 'save_test', payload)
    for (const who of [ids.studentA, ids.headA]) {
      let state = await command(who, 'start', { id: payload.id, group_id: groups[0] })
      state = await command(who, 'save_answer', { id: payload.id, version: state.attempt.version, question_id: 'question1', answer: 'b' })
      if (who === ids.studentA) {
        state = await command(who, 'navigate', { id: payload.id, version: state.attempt.version, index: 1 })
        state = await command(who, 'save_answer', { id: payload.id, version: state.attempt.version, question_id: 'question2', answer: 'b' })
      }
      await command(who, 'finish', { id: payload.id, version: state.attempt.version })
    }
    await db.query('delete from study_group_members where group_id=$1 and user_id=$2', [groups[0], ids.studentA])
    await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second',opens_at=clock_timestamp()-interval '1 day' where id=$1", [payload.id])
    const finalized = await command(ids.owner, 'finalize_results', { id: payload.id, version: 1 })
    const eligible = finalized.attempts.find(attempt => attempt.user_id === ids.headA)
    const revoked = finalized.attempts.find(attempt => attempt.user_id === ids.studentA)
    assert.equal(eligible.final_score, 12)
    assert.equal(eligible.bonus_score, 2)
    assert.equal(revoked.score, 20)
    assert.equal(revoked.bonus_score, 0)
    const reviewed = await command(ids.owner, 'review_results', { id: payload.id, version: finalized.test.version })
    const held = reviewed.attempts.find(attempt => attempt.user_id === ids.studentA)
    assert.equal(held.reviewed_at, null)
    assert.match(held.review_note, /Доступ учасника змінився/)
    assert.ok(reviewed.attempts.find(attempt => attempt.user_id === ids.headA).reviewed_at)
    const gradeRows = (await db.query('select e.user_id,g.draft_score::float score,g.published_at from teaching_grades g join teaching_entries e on e.id=g.entry_id join teaching_test_activities a on a.activity_id=g.activity_id where a.test_id=$1', [payload.id])).rows
    assert.deepEqual(gradeRows.map(row => [row.user_id, row.score, row.published_at]), [[ids.headA, 12, null]])
    const replay = await command(ids.owner, 'review_results', { id: payload.id, version: finalized.test.version })
    assert.equal(replay.attempts.find(attempt => attempt.user_id === ids.studentA).version, held.version)
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groups[0], ids.studentA, ids.headA])
    const restored = await command(ids.owner, 'review_results', { id: payload.id, version: finalized.test.version })
    assert.ok(restored.attempts.find(attempt => attempt.user_id === ids.studentA).reviewed_at)
    assert.equal(restored.attempts.find(attempt => attempt.user_id === ids.studentA).review_note, '')
    assert.equal(restored.attempts.find(attempt => attempt.user_id === ids.headA).final_score, 12)
    assert.equal(restored.attempts.find(attempt => attempt.user_id === ids.studentA).final_score, 20)
  })
})
