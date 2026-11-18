import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { publicationRevisionsFixture } from '../scripts/security/teaching-test-publication-revisions-fixture.mjs'

test('student archive is personal, scoped to submitted attempts and preserves assessments', { timeout: 120000 }, async t => {
  const fx = await publicationRevisionsFixture(); t.after(() => fx.close())
  const { db, ids, groups } = fx
  const first = (await fx.createTest({ targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })) })).definition.id, second = (await fx.createTest()).definition.id
  const active = (await fx.createTest()).definition.id, untouched = (await fx.createTest()).definition.id
  await fx.complete(ids.studentA, first, { correctCount: 1 }); await fx.complete(ids.studentB, first, { group: groups[1] }); await fx.publishOriginal(first)
  await fx.complete(ids.studentA, second)
  const current = await fx.testMutate(ids.studentA, 'start', { id: active, group_id: groups[0] })
  const beforeList = await fx.testList(ids.studentA)
  const attempt = beforeList.tests.find(x => x.id === first).my_attempt.id
  const otherAttempt = (await fx.testList(ids.studentB, ids.course, groups[1])).tests.find(x => x.id === first).my_attempt.id
  const snapshot = async () => (await db.query(`select jsonb_build_object(
    'tests',(select jsonb_agg(to_jsonb(x)order by id)from teaching_tests x),
    'attempts',(select jsonb_agg(to_jsonb(x)order by id)from teaching_test_attempts x),
    'grades',(select jsonb_agg(to_jsonb(x)order by id)from teaching_grades x),
    'gradeAudit',(select jsonb_agg(to_jsonb(x)order by id)from teaching_grade_audit x))v`)).rows[0].v
  const baseline = await snapshot()
  await db.exec(await readFile(new URL('../supabase/migrations/20261118221828_student_completed_test_archive.sql', import.meta.url), 'utf8'))
  const archive = (action, attemptId = null, { user = ids.studentA, group = groups[0], course = ids.course, expectedUser = user } = {}) => fx.rpc(user, 'xelay_student_test_archive', [action, group, expectedUser, attemptId, course])
  await t.test('migration keeps visibility, answers, timers and grades intact and exposes no archive table', async () => {
    assert.deepEqual(await snapshot(), baseline)
    const actual = await fx.testList(ids.studentA)
    assert.deepEqual(actual.tests.map(({ my_archived, ...rest }) => rest), beforeList.tests)
    assert.ok(actual.tests.every(x => x.my_archived === false))
    await assert.rejects(fx.asUser(ids.studentA, 'select * from xelay_student_private.completed_test_archives'), e => e.code === '42501')
    assert.equal((await db.query("select has_function_privilege('anon','public.xelay_student_test_archive(text,uuid,uuid,uuid,uuid)','execute') allowed")).rows[0].allowed, false)
  })
  await t.test('one call archives all own submitted works, including a grade awaiting publication, and no active/unstarted work', async () => {
    const result = await archive('archive_all')
    assert.equal(result.archive_user_id, ids.studentA)
    assert.deepEqual(result.tests.filter(x => x.my_archived).map(x => x.id).sort(), [first, second].sort())
    assert.equal(result.tests.find(x => x.id === active).my_archived, false)
    assert.equal(result.tests.find(x => x.id === untouched).my_archived, false)
    assert.ok((await fx.testList(ids.studentB, ids.course, groups[1])).tests.every(x => !x.my_archived))
    assert.ok((await fx.testList(ids.owner)).tests.every(x => !x.my_archived))
    assert.deepEqual(await snapshot(), baseline)
    assert.equal((await archive('archive_all')).tests.filter(x => x.my_archived).length, 2, 'safe retry is idempotent')
  })
  await t.test('archive survives a fresh read and restore returns exactly one item with its original published result', async () => {
    assert.equal((await fx.testList(ids.studentA)).tests.filter(x => x.my_archived).length, 2)
    let result = await archive('restore', attempt)
    assert.equal(result.tests.find(x => x.id === first).my_archived, false)
    assert.equal(result.tests.find(x => x.id === second).my_archived, true)
    assert.deepEqual(result.tests.find(x => x.id === first).my_attempt, beforeList.tests.find(x => x.id === first).my_attempt)
    result = await archive('archive', attempt); assert.equal(result.tests.find(x => x.id === first).my_archived, true)
    assert.deepEqual(await snapshot(), baseline)
  })
  await t.test('cannot file a foreign, active, missing, wrong-group or stale-account attempt', async () => {
    const cases = [() => archive('archive', otherAttempt), () => archive('restore', attempt, { user: ids.studentB }),
      () => archive('archive', current.attempt.id), () => archive('archive', randomUUID()),
      () => archive('restore', attempt, { group: groups[1] }), () => archive('archive_all', null, { expectedUser: ids.studentB }),
      () => archive('archive', attempt, { user: ids.outsider }), () => archive('archive', attempt, { course: randomUUID() })]
    for (const run of cases) await assert.rejects(run)
    assert.deepEqual(await snapshot(), baseline)
    assert.equal((await fx.testList(ids.studentA)).tests.filter(x => x.my_archived).length, 2)
  })
  await t.test('normal test detail remains available from archive and does not restart or finish a work', async () => {
    const detail = await fx.testDetail(ids.studentA, first)
    assert.equal(detail.attempt.id, attempt); assert.equal(detail.attempt.status, 'submitted')
    assert.equal((await fx.testDetail(ids.studentA, active)).attempt.status, 'in_progress')
    assert.deepEqual(await snapshot(), baseline)
  })
  await t.test('a newly granted personal retake is visible while the old completed attempt remains archived', async () => {
    const teacher = await fx.testDetail(ids.owner, first)
    await fx.testMutate(ids.owner, 'grant_retake', { id: first, version: teacher.test.version,
      source_attempt_id: attempt, request_id: randomUUID(), confirm_retake: true, user_id: ids.studentA, group_id: groups[0], variant_choice: 'random',
      opens_at: new Date(Date.now() - 60000).toISOString(), closes_at: new Date(Date.now() + 3600000).toISOString(), duration_seconds: 900 })
    const list = await fx.testList(ids.studentA), retake = list.tests.find(x => x.retake_parent_id === first)
    assert.ok(retake); assert.equal(retake.my_archived, false)
    assert.equal(list.tests.find(x => x.id === first).my_archived, true)
  })
  await t.test('an attempt reset or a different completion timestamp cannot inherit an old archive marker', async () => {
    await db.query("update teaching_test_attempts set status='in_progress' where id=$1", [attempt])
    assert.equal((await fx.testList(ids.studentA)).tests.find(x => x.id === first).my_archived, false)
    await db.query("update teaching_test_attempts set status='submitted',submitted_at=submitted_at+interval '1 second' where id=$1", [attempt])
    assert.equal((await fx.testList(ids.studentA)).tests.find(x => x.id === first).my_archived, false)
  })
})
