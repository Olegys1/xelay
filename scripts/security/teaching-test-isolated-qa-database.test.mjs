import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { notificationCenterFixture } from './notification-center-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

const qaOwner = '04f587f8-1604-4f53-aabc-d1699c938b1d'
const qaGroup = '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'
const migration = '202611060120_teaching_test_isolated_qa.sql'

test('same-account QA persists and publishes one private score without touching the ordinary journal', async t => {
  const fx = await notificationCenterFixture()
  t.after(() => fx.close())
  const { db, ids, groups, scope, dates, seedUser, rpc, mutate } = fx
  for (const name of [
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
    '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql',
    '202611060050_teaching_test_rich_content.sql',
    '202611060080_teaching_test_concurrency.sql',
  ]) await db.exec(await readCourseModuleMigration(name))
  // Exercise exactly what the SQL Editor can paste, including CRLF.
  await db.exec((await readCourseModuleMigration(migration)).replace(/\r?\n/g, '\r\n'))

  // The approved production IDs identify entirely fictional records in this
  // in-memory fixture. No production auth, records or services are read.
  await seedUser(qaOwner, { full_name: 'Synthetic QA owner', username: 'synthetic_qa_owner',
    university_id: scope.university_id, academic_unit_id: scope.id, account_type: 'teacher', categories: [], experience: '' })
  await db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,status,reviewed_at,contact_telegram)
    values($1,'Synthetic QA owner',$2,$3,'Synthetic department','Synthetic lecturer','approved',now(),'synthetic_qa')`,
  [qaOwner, scope.university_id, scope.id])
  const qaRequest = randomUUID(), course = randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    values($1,$2,'Synthetic QA owner',$3,$4,'Synthetic programme','Synthetic QA group','synthetic_qa','approved',$5,now())`,
  [qaRequest, qaOwner, scope.university_id, scope.id, ids.admin])
  await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
    values($1,$2,$3,$4,$5,'Synthetic programme','Synthetic QA group')`,
  [qaGroup, qaRequest, qaOwner, scope.university_id, scope.id])
  await db.query(`insert into study_group_members(group_id,user_id,invited_by,status,accepted_at)
    values($1,$2,$3,'accepted',now()),($1,$4,$3,'accepted',now())`, [qaGroup, ids.studentA, qaOwner, ids.colleague])
  await mutate(qaOwner, 'create_course', { id: course, version: 0, title: 'Synthetic QA subject',
    semester: 'Synthetic semester', starts_on: dates.start, ends_on: dates.finish })
  await db.query(`insert into teaching_course_groups(course_id,group_id,status,invited_by,accepted_at)
    values($1,$2,'accepted',$3,now()),($1,$4,'accepted',$3,now()),($5,$2,'accepted',$6,now())`,
  [course, qaGroup, qaOwner, groups[0], ids.course, ids.owner])
  await db.query(`insert into teaching_course_teachers(course_id,user_id,permissions,status,invited_by)
    values($1,$2,array['assignments','grades']::text[],'accepted',$3)`, [course, ids.colleague, qaOwner])
  const act = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...payload, expected_user_id: who })])
  const qa = (who, action, payload, options) => rpc(who, 'xelay_teaching_test_qa', [action, JSON.stringify({ ...payload, expected_user_id: who })], options)
  const detail = (who, id) => rpc(who, 'xelay_teaching_test', [id])
  const list = who => rpc(who, 'xelay_teaching_tests', [course, qaGroup])
  const create = (subject, targets, extra = {}) => syntheticTest(subject, targets, { status: 'draft', ...extra })
  const definition = create(course, [qaGroup], { title: 'Synthetic own attempt', max_points: 5,
    bonus_percent: 0, bonus_points: 0, require_access_code: true })
  definition.questions = [
    { ...definition.questions[0], time_limit_seconds: null },
    { id: 'essay', kind: 'essay', text: 'Синтетичне пояснення', points: 5, time_limit_seconds: null,
      partial_credit: false, options: [], buckets: [] },
  ]
  const longAnswer = 'Synthetic explanation. '.repeat(100)
  let teacher, student, code

  const ordinary = create(course, [qaGroup], { title: 'Synthetic ordinary grade', status: 'published' })
  await act(qaOwner, 'save_test', ordinary)
  let other = await act(ids.studentA, 'start', { id: ordinary.id, group_id: qaGroup })
  other = await act(ids.studentA, 'save_answer', { id: ordinary.id, version: other.attempt.version, question_id: 'choice', answer: 'b' })
  other = await act(ids.studentA, 'finish', { id: ordinary.id, version: other.attempt.version })
  let ordinaryReview = await detail(qaOwner, ordinary.id)
  ordinaryReview = await act(qaOwner, 'close_test', { id: ordinary.id, version: ordinaryReview.test.version, confirm_close_all: true })
  ordinaryReview = await act(qaOwner, 'finalize_results', { id: ordinary.id, version: ordinaryReview.test.version })
  ordinaryReview = await act(qaOwner, 'review_results', { id: ordinary.id, version: ordinaryReview.test.version })
  const ordinaryGrade = (await db.query('select activity_id,entry_id,version from teaching_grades where id=$1',
    [ordinaryReview.attempts[0].grade_id])).rows[0]
  await mutate(qaOwner, 'publish_grades', { activity_id: ordinaryGrade.activity_id,
    expected_versions: [{ entry_id: ordinaryGrade.entry_id, version: ordinaryGrade.version }] })

  const snapshot = async () => (await db.query(`
    select jsonb_build_object(
      'grades',(select coalesce(jsonb_agg(to_jsonb(g) order by id),'[]') from teaching_grades g),
      'activities',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from teaching_activities a),
      'notifications',(select coalesce(jsonb_agg(to_jsonb(n) order by id),'[]') from notifications n),
      'outbox',(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]') from notification_email_outbox o)
    ) as state`)).rows[0].state
  const before = await snapshot()

  await t.test('only the scoped owner may opt in a previously unlinked draft', async () => {
    assert.ok((await list(qaOwner)).tests.some(item => item.id === ordinary.id))
    await assert.rejects(qa(qaOwner, 'start', { id: ordinary.id, group_id: qaGroup }), /QA_FORBIDDEN/)
    await assert.rejects(act(qaOwner, 'save_test', { ...create(course, [qaGroup], { status: 'published' }), qa_own_attempt: true }), /QA_DRAFT_REQUIRED/)
    await assert.rejects(act(ids.owner, 'save_test', { ...create(ids.course, [qaGroup]), qa_own_attempt: true }), /QA_FORBIDDEN/)
    await assert.rejects(act(qaOwner, 'save_test', { ...create(course, [groups[0]]), qa_own_attempt: true }), /QA_FORBIDDEN/)
    await assert.rejects(act(qaOwner, 'save_test', { ...create(course, [qaGroup, groups[0]]), qa_own_attempt: true }), /QA_FORBIDDEN/)
    teacher = await act(qaOwner, 'save_test', definition)
    assert.equal(teacher.test.qa_own_attempt, false)
    assert.equal(teacher.test.qa_can_enable, true)
    await assert.rejects(act(qaOwner, 'save_test', { ...definition, version: teacher.test.version,
      status: 'published', qa_own_attempt: true }), /QA_DRAFT_REQUIRED/)
    assert.equal((await detail(qaOwner, definition.id)).test.status, 'draft')
    teacher = await act(qaOwner, 'save_test', { ...definition, version: teacher.test.version, qa_own_attempt: true })
    assert.equal(teacher.test.qa_own_attempt, true)
    assert.equal(teacher.test.qa_can_start, false)
    await assert.rejects(qa(qaOwner, 'detail', { id: definition.id }), /QA_FORBIDDEN/)
    assert.equal((await rpc(qaOwner, 'xelay_teaching_course_modules', [course])).resources.some(row => row.id === definition.id), false)
    await assert.rejects(rpc(qaOwner, 'xelay_teaching_course_module_save', [JSON.stringify({
      id: randomUUID(), course_id: course, expected_user_id: qaOwner, title: 'Synthetic module', status: 'draft',
      group_ids: [qaGroup], prerequisite_item_ids: [], version: 0, position: 0,
      items: [{ id: randomUUID(), resource_type: 'test', resource_id: definition.id, required: true,
        completion: 'submitted', prerequisite_item_ids: [], position: 0 }],
    })]), /QA_FORBIDDEN|COURSE_MODULE_INVALID/)
    teacher = await act(qaOwner, 'save_test', { ...definition, version: teacher.test.version, status: 'published' })
    assert.equal(teacher.test.qa_own_attempt, true)
    assert.equal(teacher.test.qa_can_start, true)
    assert.equal((await list(ids.studentA)).tests.some(item => item.id === definition.id), false)
    assert.equal((await list(ids.colleague)).tests.some(item => item.id === definition.id), false)
    await assert.rejects(detail(ids.studentA, definition.id), /FORBIDDEN/)
    await assert.rejects(detail(ids.colleague, definition.id), /FORBIDDEN/)
    await assert.rejects(act(ids.studentA, 'start', { id: definition.id, group_id: qaGroup }), /FORBIDDEN/)
    await assert.rejects(act(qaOwner, 'save_test', { ...definition, version: teacher.test.version, status: 'published', qa_own_attempt: false }), /QA_FORBIDDEN/)
    code = (await act(qaOwner, 'read_access_code', { id: definition.id })).access_code.current
    assert.ok(code)
  })

  await t.test('student route returns no answers, keys, reports or draft grades and persists a real attempt', async () => {
    await assert.rejects(qa(null, 'detail', { id: definition.id }, { role: 'anon' }), /permission denied/)
    await assert.rejects(qa(ids.studentA, 'detail', { id: definition.id }), /QA_FORBIDDEN/)
    await assert.rejects(qa(ids.colleague, 'detail', { id: definition.id }), /QA_FORBIDDEN/)
    await assert.rejects(qa(qaOwner, 'start', { id: definition.id, group_id: groups[0], access_code: code }), /QA_FORBIDDEN/)
    await assert.rejects(act(qaOwner, 'start', { id: definition.id, group_id: qaGroup, access_code: code, qa_internal_session: true }), /FORBIDDEN/)
    const wrongCode = code === '00000000' ? 'FFFFFFFF' : '00000000'
    assert.deepEqual(await qa(qaOwner, 'start', { id: definition.id, group_id: qaGroup, access_code: wrongCode }),
      { access_error: 'TEST_CODE_INVALID' })
    assert.equal((await db.query('select failures from teaching_test_code_attempts where test_id=$1 and user_id=$2',
      [definition.id, qaOwner])).rows[0].failures, 1)
    student = await qa(qaOwner, 'start', { id: definition.id, group_id: qaGroup, access_code: code })
    assert.equal(student.attempt.status, 'in_progress')
    assert.equal(student.attempt.current_question.answer, undefined)
    assert.equal(student.test.can_review, false)
    assert.equal(student.test.variants, undefined)
    assert.equal(student.access_code, undefined)
    assert.deepEqual(student.test.questions, [])
    assert.deepEqual(student.attempts, [])
    student = await qa(qaOwner, 'save_answer', { id: definition.id, version: student.attempt.version, question_id: 'choice', answer: 'b' })
    const reopened = await qa(qaOwner, 'detail', { id: definition.id })
    assert.equal(reopened.attempt.id, student.attempt.id)
    assert.deepEqual(reopened.attempt.answers, { choice: 'b' })
    student = await qa(qaOwner, 'navigate', { id: definition.id, version: student.attempt.version, index: 1 })
    student = await qa(qaOwner, 'save_answer', { id: definition.id, version: student.attempt.version, question_id: 'essay', answer: longAnswer })
    assert.equal(student.attempt.answers.essay, longAnswer)
    student = await qa(qaOwner, 'finish', { id: definition.id, version: student.attempt.version })
    assert.equal(student.attempt.status, 'submitted')
    assert.ok(student.attempt.submitted_at)
    assert.equal(student.attempt.published_score ?? null, null)
    assert.equal(student.attempt.final_score, undefined)
  })

  await t.test('teacher reviews and explicitly publishes one QA result, visible only in the student test view', async () => {
    teacher = await detail(qaOwner, definition.id)
    assert.equal(teacher.attempts.length, 1)
    assert.deepEqual(teacher.attempts[0].answers, { choice: 'b', essay: longAnswer })
    assert.equal(teacher.attempts[0].score, 2.5)
    teacher = await act(qaOwner, 'save_review', { id: definition.id, attempt_id: teacher.attempts[0].id,
      version: teacher.attempts[0].version, marks: [{ question_id: 'essay', mode: 'full', reason: 'Синтетична перевірка' }] })
    assert.equal(teacher.attempts[0].score, 5)
    const publish = () => ({ id: definition.id, version: teacher.test.version, confirm_qa_publish: true })
    await assert.rejects(act(qaOwner, 'qa_publish', publish()), /TEST_REVIEW_REQUIRED/)
    teacher = await act(qaOwner, 'close_test', { id: definition.id, version: teacher.test.version, confirm_close_all: true })
    teacher = await act(qaOwner, 'finalize_results', { id: definition.id, version: teacher.test.version })
    assert.equal((await qa(qaOwner, 'detail', { id: definition.id })).attempt.published_score ?? null, null)
    await assert.rejects(act(qaOwner, 'review_results', { id: definition.id, version: teacher.test.version }), /QA_PUBLICATION_REQUIRED/)
    await assert.rejects(act(ids.colleague, 'qa_publish', publish()), /QA_FORBIDDEN/)
    await assert.rejects(act(qaOwner, 'qa_publish', { ...publish(), confirm_qa_publish: false }), /INVALID_INPUT/)
    teacher = await act(qaOwner, 'qa_publish', publish())
    assert.equal(teacher.attempts[0].published_score, 5)
    assert.equal(teacher.test.qa_can_start, true)
    const verified = await qa(qaOwner, 'detail', { id: definition.id })
    assert.equal(verified.attempt.published_score, 5)
    assert.ok(verified.attempt.grade_published_at)
    assert.equal(verified.test.my_attempt.published_score, 5)
    assert.deepEqual(verified.attempts, [])
    assert.equal((await act(qaOwner, 'qa_publish', publish())).attempts[0].grade_published_at, verified.attempt.grade_published_at)
    assert.deepEqual(await snapshot(), before)
    assert.equal((await db.query('select count(*)::int n from teaching_test_qa_results')).rows[0].n, 1)
    await assert.rejects(qa(ids.studentA, 'detail', { id: definition.id }), /QA_FORBIDDEN/)
    await assert.rejects(fx.asUser(qaOwner, 'select * from teaching_test_qa_results'), /permission denied/)
    await db.query('update study_groups set representative_id=$1 where id=$2', [ids.studentA, qaGroup])
    await assert.rejects(qa(qaOwner, 'detail', { id: definition.id }), /QA_FORBIDDEN/)
  })
})
