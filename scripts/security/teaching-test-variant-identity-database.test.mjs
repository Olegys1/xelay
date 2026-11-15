import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { notificationCenterFixture } from './notification-center-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

const migration = '202611110020_teaching_test_variant_identity.sql'
const setIndex = (id, count) => Number.parseInt(createHash('md5').update(`${id}:manual-variant`).digest('hex').slice(0, 8), 16) % count

test('named random variants persist through resume/review, backfill shuffled draws, and stay teacher-only', async t => {
  const fx = await notificationCenterFixture()
  t.after(() => fx.close())
  for (const name of [
    '202611060010_teaching_test_integrity.sql', '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql', '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql', '202611060050_teaching_test_rich_content.sql',
    '202611060080_teaching_test_concurrency.sql', '202611060120_teaching_test_isolated_qa.sql',
    '202611110010_teaching_sequence_select.sql',
  ]) await fx.db.exec(await readCourseModuleMigration(name))
  const { db, ids, groups, rpc } = fx
  const mutate = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...payload, expected_user_id: who })])
  const detail = (who, id) => rpc(who, 'xelay_teaching_test', [id])
  const definition = () => {
    const draft = syntheticTest(ids.course, [groups[0]], { draw_count: 1, shuffle_questions: true, shuffle_answers: true })
    const question = id => ({ ...draft.questions[0], id, text: 'Запитання ' + id, time_limit_seconds: null })
    return { ...draft, questions: ['base-a','base-b','base-c'].map(question), variants: [
      { id: 'chapter-b', title: 'Група Б · повторення', questions: ['extra-a','extra-b'].map(question) },
      { id: 'chapter-c', title: 'Група В · практика', questions: ['third-a','third-b','third-c'].map(question) },
    ] }
  }
  const expected = (test, attempt) => {
    const index = setIndex(attempt.id, 3)
    return { variant_id: index ? test.variants[index - 1].id : null, variant_number: index + 1,
      variant_title: index ? test.variants[index - 1].title : test.base_variant_title || 'Варіант 1' }
  }

  const legacy = definition()
  await mutate(ids.owner, 'save_test', legacy)
  const startedBefore = await mutate(ids.studentA, 'start', { id: legacy.id, group_id: groups[0] })
  const before = (await db.query('select to_jsonb(a) state from public.teaching_test_attempts a where id=$1', [startedBefore.attempt.id])).rows[0].state
  const unknownLegacy = definition()
  await mutate(ids.owner, 'save_test', unknownLegacy)
  const unknown = await mutate(ids.headA, 'start', { id: unknownLegacy.id, group_id: groups[0] })
  // Historical definition drift must remain explicitly unknown, never a
  // misleading default. Only this synthetic snapshot is changed by the test.
  await db.query("update public.teaching_test_attempts set questions=jsonb_set(questions,'{0,id}','\"obsolete-question\"') where id=$1", [unknown.attempt.id])
  await db.exec((await readCourseModuleMigration(migration)).replace(/\r?\n/g, '\r\n'))
  const restored = (await detail(ids.owner, legacy.id)).attempts[0]
  for (const [key, value] of Object.entries(expected(legacy, restored))) assert.equal(restored[key], value)
  const after = (await db.query("select to_jsonb(a)-array['variant_id','variant_number','variant_title'] state from public.teaching_test_attempts a where id=$1", [restored.id])).rows[0].state
  assert.deepEqual(after, before)
  assert.equal((await detail(ids.studentA, legacy.id)).attempt.variant_title, undefined)
  const unnamed = (await detail(ids.owner, unknownLegacy.id)).attempts[0]
  assert.equal(unnamed.variant_title, null)
  assert.equal(unnamed.variant_number, null)
  const driftedStudent = await mutate(ids.headA, 'start', { id: unknownLegacy.id, group_id: groups[0] })
  assert.equal(driftedStudent.attempt.id, unknown.attempt.id)

  const named = { ...definition(), base_variant_title: 'Основний · вступ' }
  let saved = await mutate(ids.owner, 'save_test', named)
  assert.equal(saved.test.base_variant_title, named.base_variant_title)
  assert.equal((await detail(ids.owner, named.id)).test.base_variant_title, named.base_variant_title)
  assert.equal((await detail(ids.studentA, named.id)).test.base_variant_title, undefined)
  for (const value of ['', ' '.repeat(3), 'x'.repeat(121), null, 4]) {
    await assert.rejects(mutate(ids.owner, 'save_test', { ...named, version: saved.test.version, base_variant_title: value }), /TEST_INVALID_INPUT/)
    assert.equal((await detail(ids.owner, named.id)).test.version, saved.test.version)
  }
  const { base_variant_title: _omitted, ...withoutTitle } = named
  saved = await mutate(ids.owner, 'save_test', { ...withoutTitle, version: saved.test.version })
  assert.equal(saved.test.base_variant_title, named.base_variant_title)

  // Exercise the exact unsigned hash for every authored set, including the base.
  for (let index = 0; index < 3; index++) {
    let id = randomUUID()
    while (setIndex(id, 3) !== index) id = randomUUID()
    const state = (await db.query(`select public.xelay_private_test_variant_identity(t,$2,
      public.xelay_private_assessment_snapshot(t,$2)) as identity from public.teaching_tests t where id=$1`, [named.id, id])).rows[0].identity
    assert.deepEqual(state, expected(named, { id }))
  }
  for (const user of [ids.studentA, ids.headA]) {
    let live = await mutate(user, 'start', { id: named.id, group_id: groups[0] })
    const own = live.attempt, issued = own.current_question
    assert.equal(own.variant_id, undefined)
    assert.equal(own.variant_title, undefined)
    assert.equal(own.variant_number, undefined)
    assert.equal(live.test.variants, undefined)
    assert.equal(live.test.base_variant_title, undefined)
    const again = await mutate(user, 'start', { id: named.id, group_id: groups[0] })
    assert.equal(again.attempt.id, own.id)
    assert.deepEqual(again.attempt.current_question, issued)
    live = await mutate(user, 'save_answer', { id: named.id, version: own.version, question_id: issued.id, answer: 'b' })
    await mutate(user, 'finish', { id: named.id, version: live.attempt.version })
    const teacher = (await detail(ids.owner, named.id)).attempts.find(a => a.id === own.id)
    for (const [key, value] of Object.entries(expected(named, teacher))) assert.equal(teacher[key], value)
    assert.equal(teacher.questions[0].id, issued.id)
    await assert.rejects(db.query('update public.teaching_test_attempts set variant_title=$2 where id=$1', [own.id, 'Підміна']), /TEST_VARIANT_IMMUTABLE/)
    const reviewed = await mutate(ids.owner, 'save_review', { id: named.id, attempt_id: own.id, version: teacher.version,
      marks: [{ question_id: issued.id, mode: 'full', reason: 'Синтетична перевірка' }] })
    assert.equal(reviewed.attempts.find(a => a.id === own.id).variant_title, teacher.variant_title)
  }
  const current = (await detail(ids.owner, named.id)).test
  await assert.rejects(mutate(ids.owner, 'save_test', { ...named, version: current.version, base_variant_title: 'Перейменовано' }), /TEST_IMMUTABLE/)
  await assert.rejects(mutate(ids.studentA, 'save_test', { ...named, version: current.version }), /FORBIDDEN|TEACHING_ACCESS/)
  const privileges = (await db.query(`select
    has_table_privilege('authenticated','public.teaching_test_variant_labels','select') as labels,
    has_function_privilege('authenticated','public.xelay_private_test_variant_identity(public.teaching_tests,uuid,jsonb)','execute') as helper,
    has_function_privilege('authenticated','public.xelay_private_test_mutate_before_variant_identity(text,jsonb)','execute') as bypass`)).rows[0]
  assert.deepEqual(privileges, { labels: false, helper: false, bypass: false })
})
