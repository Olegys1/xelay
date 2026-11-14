import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { publicationRevisionsFixture } from './teaching-test-publication-revisions-fixture.mjs'
import { syntheticRetakeJpeg } from './teaching-test-personal-retakes-fixture.mjs'

test('published settings drafts remain private and republish preserves issued work', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, testMutate: act, testDetail: detail, testList: list } = fx
  const original = await fx.createTest()
  const id = original.definition.id
  const completed = await fx.complete(ids.studentA, id)
  const active = await act(ids.headA, 'start', { id, group_id: groups[0] })
  const attempts = async () => (await db.query('select to_jsonb(a) state from teaching_test_attempts a where test_id=$1 order by id', [id])).rows.map(row => row.state)
  const before = await attempts(), journal = await fx.journalState()
  await t.test('draft save leaves live definition, attempts and journal untouched', async () => {
    const current = await detail(ids.owner, id)
    assert.equal(current.test.can_republish, true)
    const staged = await fx.stage(id, { description: 'PRIVATE_EDIT_DRAFT', closes_at: new Date(Date.now() + 2 * 86400000).toISOString() })
    assert.equal(staged.test.description, original.definition.description)
    assert.equal(staged.test.publication_draft.definition.description, 'PRIVATE_EDIT_DRAFT')
    assert.equal(staged.test.publication_draft.change_kind, 'settings')
    assert.deepEqual(await attempts(), before)
    assert.deepEqual(await fx.journalState(), journal)
    const student = await detail(ids.headA, id)
    assert.equal(student.test.can_republish, false)
    assert.ok(!JSON.stringify(student).includes('PRIVATE_EDIT_DRAFT'))
    assert.equal((await list(ids.owner)).tests.length, 1)
    const resources = (await fx.rpc(ids.owner, 'xelay_teaching_course_modules', [ids.course])).resources
    assert.equal(resources.filter(row => row.resource_type === 'test').length, 1)
    assert.ok(!JSON.stringify(resources).includes('PRIVATE_EDIT_DRAFT'))
  })
  await t.test('keep republishes same id without touching attempts or adding a column', async () => {
    const published = await fx.publish(id)
    assert.equal(published.detail.test.id, id)
    assert.equal(published.detail.republish_result.created_retakes, 0)
    assert.equal(published.detail.republish_result.new_grade_columns, 0)
    assert.deepEqual(await attempts(), before)
    assert.deepEqual(await fx.journalState(), journal)
    const replay = await act(ids.owner, 'republish_test', published.payload)
    assert.deepEqual(replay.republish_result, published.detail.republish_result)
  })
  await t.test('all completed creates one private fresh attempt and preserves the live attempt', async () => {
    await fx.stage(id, { description: 'Second publication' })
    const published = await fx.publish(id, { reset_policy: 'all_completed' })
    assert.equal(published.detail.republish_result.created_retakes, 1)
    assert.equal(published.detail.republish_result.skipped_active, 1)
    assert.deepEqual(await attempts(), before)
    const studentList = await list(ids.studentA)
    assert.equal(studentList.tests.length, 1)
    assert.equal(studentList.tests[0].is_personal_retake, true)
    const child = await detail(ids.studentA, id)
    assert.notEqual(child.test.id, id)
    assert.equal(child.attempt, null)
    assert.deepEqual((await detail(ids.headA, id)).attempt.id, active.attempt.id)
    const old = (await db.query('select answers from teaching_test_attempts where id=$1', [completed.attempt.id])).rows[0]
    assert.deepEqual(old.answers, completed.attempt.answers)
  })
  await t.test('a cached unbound tab cannot save or finish a later family opportunity', async () => {
    const fresh = await act(ids.studentA, 'start', { id, group_id: groups[0] })
    const frozen = (await db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [fresh.attempt.id])).rows[0].state
    for (const action of ['save_answer', 'finish']) {
      await assert.rejects(act(ids.studentA, action, { id, version: fresh.attempt.version,
        question_id: fresh.attempt.current_question.id, answer: 'b' }), /ATTEMPT_CHANGED/)
    }
    assert.deepEqual((await db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [fresh.attempt.id])).rows[0].state, frozen)
  })
})

test('republish selection binds the latest completed attempts, teacher scopes and one durable request', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, testMutate: act, testDetail: detail } = fx
  const original = await fx.createTest({ targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })) })
  const id = original.definition.id
  const a = await fx.complete(ids.studentA, id)
  const b = await fx.complete(ids.studentB, id, { group: groups[1] })
  const active = await act(ids.headA, 'start', { id, group_id: groups[0] })
  const rows = async () => (await db.query('select to_jsonb(a) state from teaching_test_attempts a where test_id=$1 order by id', [id])).rows.map(row => row.state)
  const before = await rows()
  await t.test('student, platform admin and a colleague outside a target group cannot stage publication', async () => {
    for (const who of [ids.studentA, ids.admin, ids.colleague]) {
      await assert.rejects(fx.stage(id, { description: 'UNAUTHORIZED' }, who), /FORBIDDEN|ACTOR_CHANGED/)
    }
    assert.equal((await detail(ids.owner, id)).test.publication_draft, undefined)
  })
  await fx.stage(id, { description: 'SELECTED_ONLY' })
  await t.test('selecting an active or missing source rolls back the entire publication', async () => {
    for (const selected_attempt_ids of [[active.attempt.id], [randomUUID()]]) {
      await assert.rejects(fx.publish(id, { reset_policy: 'selected_completed', selected_attempt_ids }), /SELECTION_CHANGED/)
    }
    assert.equal((await detail(ids.owner, id)).test.description, original.definition.description)
    assert.deepEqual(await rows(), before)
    assert.equal((await db.query('select count(*)::int n from teaching_test_retake_grants')).rows[0].n, 0)
  })
  let published
  await t.test('only the selected completed student receives a recipient-private fresh opportunity', async () => {
    published = await fx.publish(id, { reset_policy: 'selected_completed', selected_attempt_ids: [b.attempt.id] })
    assert.equal(published.detail.republish_result.created_retakes, 1)
    const grants = (await db.query('select user_id,source_attempt_id,child_test_id from teaching_test_retake_grants')).rows
    assert.equal(grants.length, 1)
    assert.equal(grants[0].user_id, ids.studentB)
    assert.equal(grants[0].source_attempt_id, b.attempt.id)
    const aList = await fx.testList(ids.studentA)
    const bList = await fx.testList(ids.studentB, ids.course, groups[1])
    assert.ok(!aList.tests[0].publication_alias_ids.includes(grants[0].child_test_id))
    assert.ok(bList.tests[0].publication_alias_ids.includes(grants[0].child_test_id))
    await assert.rejects(detail(ids.studentA, grants[0].child_test_id), /FORBIDDEN/)
    assert.equal((await detail(ids.studentA, id)).attempt.id, a.attempt.id)
    assert.deepEqual(await rows(), before)
  })
  await t.test('replay returns its receipt and changing a replay payload is rejected', async () => {
    await act(ids.owner, 'republish_test', published.payload)
    await assert.rejects(act(ids.owner, 'republish_test', { ...published.payload, extend_active_attempts: true }), /CONFLICT/)
    assert.equal((await db.query('select count(*)::int n from teaching_test_retake_grants')).rows[0].n, 1)
  })
  await t.test('all completed skips a pending opportunity and an active attempt', async () => {
    await fx.stage(id, { description: 'ALL_COMPLETED' })
    const next = await fx.publish(id, { reset_policy: 'all_completed' })
    assert.equal(next.detail.republish_result.created_retakes, 1)
    assert.equal(next.detail.republish_result.skipped_pending, 1)
    assert.equal(next.detail.republish_result.skipped_active, 1)
    assert.deepEqual(await rows(), before)
  })
  await t.test('an explicit clock extension only changes active expiry, never answers or the question clock', async () => {
    const deadline = new Date(Date.now() + 3 * 86400000).toISOString()
    await fx.stage(id, { closes_at: deadline })
    const next = await fx.publish(id, { extend_active_attempts: true })
    assert.equal(next.detail.republish_result.extended_active_attempts, 1)
    const after = await rows()
    for (const previous of before) {
      const current = after.find(row => row.id === previous.id)
      if (previous.id === active.attempt.id) {
        assert.equal(Date.parse(current.expires_at), Date.parse(deadline))
        assert.deepEqual({ ...current, expires_at: previous.expires_at }, previous)
      } else assert.deepEqual(current, previous)
    }
  })
})

test('structural publication freezes old definitions and media while one family routes new starters', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, rpc, testMutate: act, testDetail: detail, testList: list } = fx
  const upload = await rpc(ids.owner, 'xelay_teaching_test_question_image_upload', [ids.course, ids.owner, syntheticRetakeJpeg])
  const image = { id: upload.id, mime_type: 'image/jpeg', alt: 'Synthetic frozen photograph' }
  const base = fx.definition()
  base.questions[0].images = [image]
  base.variants = []
  base.targets = groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] }))
  await act(ids.owner, 'save_test', base)
  const old = await act(ids.studentA, 'start', { id: base.id, group_id: groups[0] })
  const oldAttempt = (await db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [old.attempt.id])).rows[0].state
  const oldDefinition = (await db.query('select to_jsonb(t) state from teaching_tests t where id=$1', [base.id])).rows[0].state
  const journal = await fx.journalState()
  const nextQuestions = structuredClone(base.questions).map((question, index) => ({ ...question, id: 'new_' + index, text: 'NEW_PRIVATE_CONTENT_' + index }))
  const staged = await fx.stage(base.id, { questions: nextQuestions })
  assert.equal(staged.test.publication_draft.change_kind, 'definition')
  assert.deepEqual(await fx.journalState(), journal)
  const published = await fx.publish(base.id)
  const newId = published.detail.test.id
  assert.notEqual(newId, base.id)
  assert.equal(published.detail.republish_result.new_grade_columns, 0)
  assert.equal(published.detail.republish_result.same_grade_scale, true)
  assert.deepEqual((await db.query('select to_jsonb(t) state from teaching_tests t where id=$1', [base.id])).rows[0].state, oldDefinition)
  assert.deepEqual((await db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [old.attempt.id])).rows[0].state, oldAttempt)
  assert.equal((await list(ids.studentA)).tests.length, 1)
  assert.equal((await list(ids.studentA)).tests[0].id, base.id)
  assert.deepEqual(new Set((await list(ids.studentA)).tests[0].publication_alias_ids), new Set([base.id, newId]))
  assert.equal((await detail(ids.studentA, newId)).attempt.id, old.attempt.id)
  assert.equal((await list(ids.studentB, ids.course, groups[1])).tests.length, 1)
  assert.equal((await detail(ids.studentB, base.id)).test.id, newId)
  const started = await act(ids.studentB, 'start', { id: base.id, group_id: groups[1] })
  assert.equal(started.test.id, newId)
  assert.match(started.attempt.current_question.text, /NEW_PRIVATE_CONTENT/)
  const saved = await act(ids.studentB, 'save_answer', { id: base.id, attempt_id: started.attempt.id,
    version: started.attempt.version, question_id: started.attempt.current_question.id, answer: 'b' })
  assert.equal(saved.attempt.answers[started.attempt.current_question.id], 'b')
  assert.equal(await rpc(ids.studentA, 'xelay_teaching_test_question_image', [image.id]), syntheticRetakeJpeg)
  assert.equal(await rpc(ids.studentB, 'xelay_teaching_test_question_image', [image.id]), syntheticRetakeJpeg)
  const teacherOld = await detail(ids.owner, base.id)
  assert.deepEqual(teacherOld.test.questions, base.questions)
  assert.equal(teacherOld.test.can_republish, false)
  assert.ok(published.detail.test.previous_revisions.some(row => row.id === base.id))
})

test('same-scale reissued results retain published best scores and a changed scale gets a new journal column', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, db, testMutate: act, testDetail: detail } = fx
  const original = await fx.createTest()
  const first = await fx.complete(ids.studentA, original.definition.id, { correctCount: 1 })
  await fx.publishOriginal(original.definition.id)
  const oldGrade = await fx.grade(original.definition.id)
  assert.equal(oldGrade.published_score_number, 5)
  await fx.stage(original.definition.id, { closes_at: new Date(Date.now() + 2 * 86400000).toISOString() })
  const same = await fx.publish(original.definition.id, { reset_policy: 'all_completed' })
  assert.notEqual(same.detail.test.id, original.definition.id, 'finalized definitions remain immutable even for a new settings publication')
  assert.equal(same.detail.republish_result.new_grade_columns, 0)
  const opportunity = await detail(ids.studentA, original.definition.id)
  const childId = opportunity.test.id
  await fx.complete(ids.studentA, childId, { correctCount: 0 })
  const ready = await fx.finalize(childId)
  await act(ids.owner, 'publish_retake', { id: childId, version: ready.test.version,
    expected_grade_version: ready.attempts[0].current_grade.version, confirm_retake_publish: true })
  assert.equal((await fx.grade(original.definition.id)).published_score_number, 5)
  const childReceipt = await detail(ids.studentA, childId)
  assert.ok(childReceipt.attempt_history.some(row => row.id === first.attempt.id && Number(row.published_score) === 5))
  assert.equal(Number(childReceipt.attempt.published_score), 0)
  const currentId = same.detail.test.id
  await fx.stage(currentId, { max_points: 20 })
  const scaled = await fx.publish(currentId, { reset_policy: 'all_completed' })
  assert.equal(scaled.detail.republish_result.same_grade_scale, false)
  assert.equal(scaled.detail.republish_result.new_grade_columns, 1)
  assert.equal((await fx.grade(original.definition.id)).published_score_number, 5)
  assert.equal((await db.query('select count(*)::int n from teaching_activities')).rows[0].n, 2)
})

test('draft concurrency, media ownership and private database boundaries fail closed', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, asUser, testMutate: act, testDetail: detail } = fx
  const original = await fx.createTest()
  const id = original.definition.id
  const submitted = await fx.complete(ids.studentA, id)
  const first = await fx.stage(id, { description: 'FIRST_PRIVATE_EDITOR' })
  const stale = { id, version: first.test.version, draft_version: first.test.publication_draft.version,
    definition: { ...first.test, description: 'STALE_WRITE' } }
  await fx.stage(id, { description: 'SECOND_PRIVATE_EDITOR' })
  await assert.rejects(act(ids.owner, 'save_published_draft', stale), /DRAFT_CONFLICT/)
  assert.equal((await detail(ids.owner, id)).test.publication_draft.definition.description, 'SECOND_PRIVATE_EDITOR')
  const stageId = (await db.query('select draft_test_id from teaching_test_publication_drafts where test_id=$1', [id])).rows[0].draft_test_id
  await assert.rejects(detail(ids.studentA, stageId), /FORBIDDEN/)
  await assert.rejects(act(ids.owner, 'save_test', { ...original.definition, id: stageId, version: 2 }), /IMMUTABLE/)
  for (const table of ['teaching_test_publication_families', 'teaching_test_publication_members', 'teaching_test_publication_drafts',
    'teaching_test_publication_history', 'teaching_test_republish_receipts']) {
    await assert.rejects(asUser(ids.studentA, 'select * from public.' + table), /permission denied/)
  }
  for (const signature of ['public.xelay_private_test_mutate_before_publication_20261114(text,jsonb)',
    'public.xelay_private_tests_before_publication_20261114(uuid,uuid)',
    'public.xelay_private_test_detail_before_publication_20261114(uuid)',
    'public.xelay_private_publication_grant(uuid,uuid,uuid,uuid)']) {
    const result = await db.query("select has_function_privilege('authenticated',$1,'execute') allowed", [signature])
    assert.equal(result.rows[0].allowed, false)
  }
  const current = await detail(ids.owner, id)
  await act(ids.owner, 'grant_retake', { id, version: current.test.version, request_id: randomUUID(),
    user_id: ids.studentA, group_id: groups[0], source_attempt_id: submitted.attempt.id, variant_choice: 'random',
    opens_at: new Date(Date.now() - 1000).toISOString(), closes_at: new Date(Date.now() + 3600000).toISOString(),
    duration_seconds: 1200, confirm_retake: true })
  await assert.rejects(fx.publish(id), /DRAFT_CONFLICT/)
  const changed = await detail(ids.owner, id)
  const discarded = await act(ids.owner, 'discard_published_draft', { id, version: changed.test.version,
    draft_version: changed.test.publication_draft.version })
  assert.equal(discarded.test.publication_draft, undefined)
  assert.equal((await db.query('select count(*)::int n from teaching_tests where id=$1', [stageId])).rows[0].n, 0)
})

test('stable module links retain prerequisites and count submitted work from a new definition', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, rpc, testMutate: act, testDetail: detail } = fx
  const prerequisite = await fx.createTest({ title: 'Synthetic prerequisite' })
  const original = await fx.createTest({ title: 'Synthetic versioned module work', variants: [] })
  const priorItem = randomUUID(), targetItem = randomUUID(), moduleId = randomUUID()
  await rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify({ id: moduleId, course_id: ids.course,
    expected_user_id: ids.owner, title: 'Synthetic module', description: '', status: 'published',
    group_ids: [groups[0]], position: 0, version: 0, prerequisite_item_ids: [], items: [
      { id: priorItem, resource_type: 'test', resource_id: prerequisite.definition.id, required: true,
        completion: 'submitted', pass_percent: null, prerequisite_item_ids: [], position: 0 },
      { id: targetItem, resource_type: 'test', resource_id: original.definition.id, required: true,
        completion: 'submitted', pass_percent: null, prerequisite_item_ids: [priorItem], position: 1 },
    ] })])
  const questions = original.definition.questions.map(question => ({ ...question, text: 'REVISED_MODULE_' + question.id }))
  await fx.stage(original.definition.id, { questions, title: 'Revised module work' })
  const publication = await fx.publish(original.definition.id)
  const currentId = publication.detail.test.id
  const resources = (await rpc(ids.owner, 'xelay_teaching_course_modules', [ids.course])).resources
  assert.deepEqual(resources.filter(row => [original.definition.id, currentId].includes(row.id)).map(row => row.id), [currentId])
  await assert.rejects(act(ids.studentA, 'start', { id: currentId, group_id: groups[0] }), /FORBIDDEN|MODULE_LOCKED/)
  await fx.complete(ids.studentA, prerequisite.definition.id)
  const completed = await fx.complete(ids.studentA, original.definition.id)
  assert.equal(completed.test.id, currentId)
  const learning = await rpc(ids.studentA, 'xelay_student_course_modules', [ids.course, groups[0]])
  const item = learning.modules.flatMap(module => module.items).find(item => item.id === targetItem)
  assert.equal(item.completed, true)
  assert.equal(item.locked, false)
  assert.equal(item.title, 'Revised module work')
  assert.equal((await detail(ids.studentA, original.definition.id)).attempt.id, completed.attempt.id)
})

test('republishing cannot withdraw the whole-group test required by an already published lecture', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, rpc } = fx
  const original = await fx.createTest({ targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })) })
  const moduleId = randomUUID(), itemId = randomUUID()
  await rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify({ id: moduleId, course_id: ids.course,
    expected_user_id: ids.owner, title: 'Synthetic lecture module', description: '', status: 'published',
    group_ids: [groups[0]], position: 0, version: 0, prerequisite_item_ids: [], items: [
      { id: itemId, resource_type: 'test', resource_id: original.definition.id, required: true,
        completion: 'submitted', pass_percent: null, prerequisite_item_ids: [], position: 0 },
    ] })])
  // The attachment boundary has its own byte-verification suite; this local
  // row establishes only the real foreign-key lecture/test dependency.
  await db.query(`insert into teaching_course_module_lectures(module_id,test_item_id,file,duration_seconds)
    values($1,$2,$3::jsonb,30)`, [moduleId, itemId, JSON.stringify({ storage_path: 'synthetic/' + randomUUID() + '.mp4' })])
  await fx.stage(original.definition.id, { targets: [{ group_id: groups[1], audience_mode: 'all', subgroup_ids: [] }] })
  await assert.rejects(fx.publish(original.definition.id), /COURSE_MODULE_LECTURE_TEST_REQUIRED/)
  assert.equal((await db.query('select count(*)::int n from teaching_test_publication_families')).rows[0].n, 0)
  assert.deepEqual((await fx.testDetail(ids.owner, original.definition.id)).test.targets, original.definition.targets)
})

test('a real 160-recipient completed roster receives exactly one private opportunity each on an idempotent publication', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, testMutate: act, testList: list } = fx
  const original = await fx.createTest({ variants: [] })
  const seed = (await db.query('select account_type,experience,categories,university_id,academic_unit_id,specialty_id from profiles where id=$1', [ids.studentA])).rows[0]
  const students = Array.from({ length: 160 }, () => randomUUID())
  for (const [index, student] of students.entries()) {
    await fx.seedUser(student, { ...seed, full_name: 'Synthetic bulk student ' + index })
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groups[0], student, ids.owner])
  }
  await db.query(`with recipients as(select value user_id,gen_random_uuid() attempt_id from unnest($1::uuid[])value),
    snapshots as(select r.*,public.xelay_private_assessment_snapshot(t,r.attempt_id) questions from recipients r cross join teaching_tests t where t.id=$2)
    insert into teaching_test_attempts(id,test_id,group_id,user_id,status,started_at,expires_at,submitted_at,questions)
    select attempt_id,$2,$3,user_id,'submitted',now()-interval '2 minutes',now()+interval '15 minutes',now()-interval '1 minute',questions from snapshots`,
  [students, original.definition.id, groups[0]])
  const old = (await db.query('select to_jsonb(a) state from teaching_test_attempts a order by id')).rows
  await fx.stage(original.definition.id, { description: 'Synthetic batch publication' })
  const published = await fx.publish(original.definition.id, { reset_policy: 'all_completed' })
  assert.equal(published.detail.republish_result.created_retakes, 160)
  assert.equal((await db.query('select count(distinct user_id)::int n from teaching_test_retake_grants')).rows[0].n, 160)
  assert.equal((await db.query('select count(*)::int n from teaching_test_retake_grants where retake_number=2')).rows[0].n, 160)
  assert.deepEqual((await db.query('select to_jsonb(a) state from teaching_test_attempts a order by id')).rows, old)
  await act(ids.owner, 'republish_test', published.payload)
  assert.equal((await db.query('select count(*)::int n from teaching_test_retake_grants')).rows[0].n, 160)
  const visible = await list(students[0])
  assert.equal(visible.tests.length, 1)
  assert.equal(visible.tests[0].is_personal_retake, true)
  assert.equal(visible.tests[0].retake_number, 2)
})

test('draft recipients are authoritative for reset selection before publication', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups } = fx
  const original = await fx.createTest({ targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })) })
  const a = await fx.complete(ids.studentA, original.definition.id)
  const b = await fx.complete(ids.studentB, original.definition.id, { group: groups[1] })
  const staged = await fx.stage(original.definition.id, { targets: [{ group_id: groups[0], audience_mode: 'all', subgroup_ids: [] }] })
  assert.equal(staged.republish_candidates.find(row => row.source_attempt_id === a.attempt.id).eligible, true)
  const removed = staged.republish_candidates.find(row => row.source_attempt_id === b.attempt.id)
  assert.equal(removed.eligible, false)
  assert.equal(removed.reason, 'not_admitted')
  await assert.rejects(fx.publish(original.definition.id, { reset_policy: 'selected_completed', selected_attempt_ids: [b.attempt.id] }), /SELECTION_CHANGED/)
})

test('a group-scoped editor cannot extend historical live attempts in a different group', async t => {
  const fx = await publicationRevisionsFixture()
  t.after(() => fx.close())
  const { ids, groups, db, testMutate: act } = fx
  const original = await fx.createTest({ targets: groups.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })) })
  const own = await act(ids.studentA, 'start', { id: original.definition.id, group_id: groups[0] })
  const other = await act(ids.studentB, 'start', { id: original.definition.id, group_id: groups[1] })
  const row = async attemptId => (await db.query('select to_jsonb(a) state from teaching_test_attempts a where id=$1', [attemptId])).rows[0].state
  const otherBefore = await row(other.attempt.id)
  await fx.stage(original.definition.id, { targets: [{ group_id: groups[0], audience_mode: 'all', subgroup_ids: [] }] })
  const revision = await fx.publish(original.definition.id)
  await db.query(`insert into teaching_course_teachers(course_id,user_id,permissions,status,invited_by,group_scope,group_ids)
    values($1,$2,array['assignments','grades'],'accepted',$3,'selected',$4::uuid[])`, [ids.course, ids.colleague, ids.owner, [groups[0]]])
  await fx.stage(revision.detail.test.id, { closes_at: new Date(Date.now() + 3 * 86400000).toISOString() }, ids.colleague)
  const updated = await fx.publish(revision.detail.test.id, { extend_active_attempts: true }, ids.colleague)
  assert.equal(updated.detail.republish_result.extended_active_attempts, 1)
  assert.deepEqual(await row(other.attempt.id), otherBefore)
  assert.ok(Date.parse((await row(own.attempt.id)).expires_at) > Date.parse(own.attempt.expires_at))
})
