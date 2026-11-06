import assert from 'node:assert/strict'
import test from 'node:test'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

test('exam saves use database receipt time while preserving the original deadlines and RPC permissions', async t => {
  const fx = await courseModulesFixture({ additionalMigrations: [
    '202611040060_teaching_test_admission.sql',
    '202611050061_teaching_test_explicit_close.sql',
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
    '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql',
    '202611060050_teaching_test_rich_content.sql',
    '202611060080_teaching_test_concurrency.sql',
  ] })
  t.after(() => fx.close())
  const { db, ids, groups, rpc } = fx
  const group = groups[0]
  const act = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...payload, expected_user_id: who })])
  const detail = (who, id) => rpc(who, 'xelay_teaching_test', [id])

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const { rows: [{ allowed }] } = await db.query(
      "select has_function_privilege($1, 'public.xelay_private_test_student_lock_key(uuid,uuid)', 'execute') as allowed", [role],
    )
    assert.equal(allowed, false, role)
  }

  async function start() {
    const definition = syntheticTest(ids.course, [group])
    await act(ids.owner, 'save_test', definition)
    const { attempt } = await act(ids.studentA, 'start', { id: definition.id, group_id: group })
    return { id: definition.id, attempt_id: attempt.id, version: attempt.version, question_id: 'choice', answer: 'b' }
  }

  for (const boundary of ['attempt', 'question']) {
    await t.test(`a timely ${boundary} answer survives processing after expiry`, async () => {
      const payload = await start()
      const sql = boundary === 'attempt'
        ? "set expires_at=clock_timestamp()+interval '1 second' where id=$1 returning expires_at::text as deadline"
        : "set opened_at=jsonb_set(opened_at,'{choice}',to_jsonb(clock_timestamp()-interval '29 seconds')) where id=$1 returning ((opened_at->>'choice')::timestamptz+interval '30 seconds')::text as deadline"
      const { rows: [{ deadline }] } = await db.query('update public.teaching_test_attempts '+sql, [payload.attempt_id])
      const { rows: [{ receipt, before_expiry, after_expiry }] } = await fx.asUser(ids.studentA, `
        with delay as materialized (select pg_sleep(1.2))
        select public.xelay_teaching_test_mutate('save_answer',$1::jsonb) as receipt,
          statement_timestamp() < $2::timestamptz as before_expiry,
          clock_timestamp() >= $2::timestamptz as after_expiry
        from delay`, [JSON.stringify({ ...payload, expected_user_id: ids.studentA }), deadline])
      assert.equal(before_expiry, true)
      assert.equal(after_expiry, true)
      assert.deepEqual(receipt.attempt.answers, { choice: 'b' })
      assert.equal(receipt.attempt.status, boundary === 'attempt' ? 'submitted' : 'in_progress')
      if (boundary === 'question') await act(ids.studentA, 'finish', { ...payload, version: receipt.attempt.version })
      assert.equal((await detail(ids.owner, payload.id)).attempts[0].score, 5)
    })
  }

  await t.test('a late answer cannot use a client timestamp to reopen a test', async () => {
    const payload = await start()
    await db.query("update public.teaching_test_attempts set expires_at=clock_timestamp()-interval '1 second' where id=$1", [payload.attempt_id])
    const receipt = await act(ids.studentA, 'save_answer', { ...payload, received_at: new Date(0).toISOString() })
    assert.equal(receipt.attempt.status, 'submitted')
    assert.deepEqual(receipt.attempt.answers, {})
    assert.equal((await detail(ids.owner, payload.id)).attempts[0].score, 0)
  })
})
