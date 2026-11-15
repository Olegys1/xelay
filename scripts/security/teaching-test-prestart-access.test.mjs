// Adversarial access checks use only fictional local PostgreSQL accounts and
// generated questions. No live assessment, key, account or provider is read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { personalRetakesFixture, syntheticRetakeJpeg } from './teaching-test-personal-retakes-fixture.mjs'

const denied = /TEST_(?:FORBIDDEN|INVALID|NOT_OPEN|NOT_ADMITTED|ATTEMPT_CHANGED)|TEACHING_(?:FORBIDDEN|GROUP_FORBIDDEN|ACCESS|ACTOR_CHANGED|AUTH_REQUIRED)|permission denied|requires? authentication|AUTH_REQUIRED/i
const noDefinition = value => {
  const text = JSON.stringify(value)
  assert.doesNotMatch(text, /PRESTART_PRIVATE_(?:PROMPT|OPTION|VARIANT|BANK)/)
  assert.doesNotMatch(text, /"(?:answer|calculation|gaps|question_reviews|grade_snapshot)"\s*:/)
}

test('future test remains private despite one legitimate early individual window', async t => {
  const fx = await personalRetakesFixture()
  t.after(() => fx.close())
  const { db, ids, groups, rpc, testMutate: act, testDetail: detail, testList: list } = fx
  const now = Date.now(), day = 86400000
  const commonOpen = new Date(now + 3 * day).toISOString()
  const commonClose = new Date(now + 3 * day + 20 * 60000).toISOString()
  const upload = () => rpc(ids.owner, 'xelay_teaching_test_question_image_upload', [ids.course, ids.owner, syntheticRetakeJpeg])
  const photo = row => ({ id: row.id, mime_type: 'image/jpeg', alt: 'Synthetic private assessment image' })
  const photos = [photo(await upload()), photo(await upload()), photo(await upload())]
  const question = (id, index = 0) => ({ id, kind: 'choice', text: 'PRESTART_PRIVATE_PROMPT_' + id,
    points: 1, time_limit_seconds: null, partial_credit: false, buckets: [], answer: 'b',
    images: [photos[index]], options: ['a', 'b', 'c', 'd'].map(key => ({ id: key,
      text: 'PRESTART_PRIVATE_OPTION_' + id + '_' + key,
      ...(key === 'b' ? { images: [photos[2]] } : {}),
    })),
  })
  const payload = fx.definition({ title: 'Synthetic future assessment', description: 'Public instructions only',
    opens_at: commonOpen, closes_at: commonClose,
    targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })),
    questions: [question('base_one'), question('base_two', 1)],
    variants: [{ id: 'future_variant', title: 'PRESTART_PRIVATE_VARIANT', questions: [question('variant_one'), question('variant_two', 1)] }],
    overrides: [{ user_id: ids.studentA, group_id: groups[0], excluded: false,
      opens_at: new Date(now - 60000).toISOString(), closes_at: new Date(now + day).toISOString(), duration_seconds: 900 }],
  })
  await act(ids.owner, 'save_test', payload)
  const frozen = async () => (await db.query(`select jsonb_build_object(
    'test',(select to_jsonb(t) from teaching_tests t where id=$1),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from teaching_test_attempts a where test_id=$1),
    'grades',(select coalesce(jsonb_agg(to_jsonb(g) order by id),'[]') from teaching_grades g)
  ) state`, [payload.id])).rows[0].state
  let before = await frozen(), earlyAttempt

  await t.test('future metadata contains no questions, options, keys, photos, variants or peer overrides', async () => {
    for (const who of [ids.studentB, ids.headB]) {
      const view = await detail(who, payload.id)
      assert.equal(view.attempt, null)
      assert.deepEqual(view.attempts, [])
      assert.deepEqual(view.test.questions, [])
      assert.ok(!view.test.variants?.length)
      assert.deepEqual(view.test.overrides, [])
      assert.equal(Date.parse(view.test.opens_at), Date.parse(commonOpen))
      noDefinition(view)
      const catalog = await list(who, ids.course, groups[1])
      assert.ok(catalog.tests.some(row => row.id === payload.id), 'the future announcement may be visible')
      noDefinition(catalog)
      for (const image of photos) assert.ok(!JSON.stringify(catalog).includes(image.id))
      assert.ok(!JSON.stringify(view).includes(ids.studentA), 'personal access is not disclosed to classmates')
    }
  })

  await t.test('direct start ignores forged client time, role, full-view and practice flags', async () => {
    for (const extra of [
      {}, { now: commonOpen, server_now: commonOpen, started_at: commonOpen, opens_at: new Date(now - day).toISOString() },
      { full: true, p_full: true, role: 'service_role', is_admin: true, is_staff: true },
      { practice: true, qa_own_attempt: true, qa: true },
      { user_id: ids.studentA, p_user: ids.studentA, current_user_id: ids.studentA, override: payload.overrides[0] },
    ]) await assert.rejects(act(ids.studentB, 'start', { id: payload.id, group_id: groups[1], ...extra }), /TEST_NOT_OPEN/)
    await assert.rejects(rpc(ids.studentB, 'xelay_teaching_test_mutate', ['start', JSON.stringify({
      id: payload.id, group_id: groups[1], expected_user_id: ids.studentA,
    })]), /ACTOR_CHANGED|INVALID_INPUT/)
    await assert.rejects(act(ids.studentB, 'start', { id: payload.id, group_id: groups[0] }), /TEST_FORBIDDEN/)
    for (const id of ['', 'not-a-uuid', payload.id + "';select 1;--", null, [payload.id]]) {
      await assert.rejects(act(ids.studentB, 'start', { id, group_id: groups[1] }), /TEST_INVALID_INPUT/)
    }
    assert.deepEqual(await frozen(), before)
  })

  await t.test('anonymous requests, direct tables and private view/scoring helpers deny access', async () => {
    for (const [name, args] of [
      ['xelay_teaching_tests', [ids.course, groups[1]]], ['xelay_teaching_test', [payload.id]],
      ['xelay_teaching_test_mutate', ['start', JSON.stringify({ id: payload.id, group_id: groups[1] })]],
    ]) await assert.rejects(rpc(null, name, args, { role: 'anon' }), denied)
    for (const table of ['teaching_tests', 'teaching_test_attempts', 'teaching_test_manual_variants',
      'teaching_test_access_codes', 'teaching_test_question_images', 'teaching_question_bank',
      'teaching_test_retake_grants', 'teaching_test_attempt_publications']) {
      await assert.rejects(fx.asUser(ids.studentB, 'select * from public.' + table), /permission denied/)
    }
    await assert.rejects(fx.asUser(ids.studentB, 'select public.xelay_private_test_view(null::public.teaching_tests,$1,true)', [ids.studentB]), /permission denied/)
    await assert.rejects(fx.asUser(ids.studentB, "select public.xelay_private_test_score('[]','{}',20)"), /permission denied/)
    const exposed = (await db.query(`select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace
      and proname like 'xelay_private_%test%' and (
        has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute')
        or has_function_privilege('service_role',oid,'execute'))`)).rows
    assert.deepEqual(exposed, [])
    assert.deepEqual(await frozen(), before)
  })

  await t.test('unrelated verified teacher and MFA administrator cannot read definitions or start', async () => {
    for (const who of [ids.otherTeacher, ids.colleague, ids.admin, ids.outsider]) {
      const options = who === ids.admin ? { aal: 'aal2' } : {}
      assert.equal((await rpc(who, 'xelay_teaching_tests', [ids.course, groups[1]], options)).tests.some(row => row.id === payload.id), false)
      await assert.rejects(rpc(who, 'xelay_teaching_test', [payload.id], options), denied)
      await assert.rejects(rpc(who, 'xelay_teaching_test_mutate', ['start', JSON.stringify({
        id: payload.id, group_id: groups[1], expected_user_id: who,
      })], options), denied)
    }
    assert.deepEqual(await frozen(), before)
  })

  await t.test('known question and answer-option image identifiers disclose no bytes before an attempt', async () => {
    for (const who of [ids.studentB, ids.headB, ids.studentA]) for (const image of photos) {
      await assert.rejects(rpc(who, 'xelay_teaching_test_question_image', [image.id]), /TEST_FORBIDDEN/)
    }
    assert.deepEqual(await frozen(), before)
  })

  await t.test('question bank, code access, editing and result/export-shaped requests cannot retrieve the definition', async () => {
    await assert.rejects(rpc(ids.studentB, 'xelay_teaching_question_bank', [ids.course]), denied)
    for (const action of ['read_access_code', 'rotate_access_code', 'save_test', 'save_override',
      'save_review', 'finalize_results', 'review_results', 'grant_retake', 'publish_retake',
      'export_results', 'export_answers', 'practice']) {
      await assert.rejects(act(ids.studentB, action, { ...payload, id: payload.id, expected_user_id: ids.studentB,
        version: 1, user_id: ids.studentA, group_id: groups[0], p_full: true, confirm_retake: true }), denied)
    }
    assert.deepEqual(await frozen(), before)
  })

  await t.test('legitimate personal early start uses a frozen current question without answer keys', async () => {
    const started = await act(ids.studentA, 'start', { id: payload.id, group_id: groups[0] })
    earlyAttempt = started.attempt
    assert.equal(earlyAttempt.status, 'in_progress')
    assert.equal(earlyAttempt.question_count, 2)
    assert.ok(earlyAttempt.current_question.text.startsWith('PRESTART_PRIVATE_PROMPT_'))
    assert.equal(earlyAttempt.current_question.answer, undefined)
    assert.equal(earlyAttempt.questions, undefined)
    assert.equal(started.test.variants, undefined)
    assert.deepEqual(started.test.questions, [])
    assert.equal(Date.parse(earlyAttempt.expires_at) - Date.parse(earlyAttempt.started_at), 900000)
    assert.equal(await rpc(ids.studentA, 'xelay_teaching_test_question_image', [earlyAttempt.current_question.images[0].id]), syntheticRetakeJpeg)
    assert.equal(await rpc(ids.studentA, 'xelay_teaching_test_question_image', [photos[2].id]), syntheticRetakeJpeg)
    before = await frozen()
  })

  await t.test('an early recipient cannot make a peer inherit the attempt, photos, answers or time window', async () => {
    for (const who of [ids.studentB, ids.headA, ids.headB]) {
      const group_id = who === ids.headA ? groups[0] : groups[1]
      noDefinition(await detail(who, payload.id))
      for (const action of ['save_answer', 'navigate', 'finish', 'record_tab_exit']) {
        await assert.rejects(act(who, action, { id: payload.id, group_id, attempt_id: earlyAttempt.id,
          version: earlyAttempt.version, question_id: earlyAttempt.current_question.id, answer: 'b', index: 1,
          user_id: ids.studentA, expected_user_id: who }), denied)
      }
      await assert.rejects(act(who, 'start', { id: payload.id, group_id, attempt_id: earlyAttempt.id,
        user_id: ids.studentA, override: payload.overrides[0] }), /TEST_NOT_OPEN|TEST_ATTEMPT_CHANGED/)
      for (const image of photos) await assert.rejects(rpc(who, 'xelay_teaching_test_question_image', [image.id]), /TEST_FORBIDDEN/)
    }
    assert.deepEqual(await frozen(), before)
    assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1', [payload.id])).rows[0].n, 1)
  })

  await t.test('even the currently valid access code cannot bypass a future personal time window', async () => {
    const protectedTest = { ...payload, id: randomUUID(), require_access_code: true }
    await act(ids.owner, 'save_test', protectedTest)
    const currentCode = (await act(ids.owner, 'read_access_code', { id: protectedTest.id })).access_code.current
    assert.ok(currentCode)
    await assert.rejects(act(ids.studentB, 'start', { id: protectedTest.id, group_id: groups[1] }), /TEST_NOT_OPEN/)
    await assert.rejects(act(ids.studentB, 'start', { id: protectedTest.id, group_id: groups[1], access_code: currentCode }), /TEST_NOT_OPEN/)
    assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1', [protectedTest.id])).rows[0].n, 0)
    const legitimate = await act(ids.studentA, 'start', { id: protectedTest.id, group_id: groups[0], access_code: currentCode })
    assert.equal(legitimate.attempt.status, 'in_progress')
    assert.equal(legitimate.attempt.current_question.answer, undefined)
    await assert.rejects(act(ids.studentB, 'start', { id: protectedTest.id, group_id: groups[1], access_code: currentCode,
      attempt_id: legitimate.attempt.id, user_id: ids.studentA }), /TEST_NOT_OPEN|TEST_ATTEMPT_CHANGED/)
  })
})
