import { notificationCenterFixture } from './notification-center-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'
import { randomUUID } from 'node:crypto'

export const personalRetakesMigration = '202611110030_teaching_personal_retakes.sql'
// A synthetic 4 x 4 JPEG. It contains no user files or personal content.
export const syntheticRetakeJpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q=='

// Synthetic local PostgreSQL only. No provider, account or production access.
export async function personalRetakesFixture({ applyRetakes = true } = {}) {
  const fx = await notificationCenterFixture()
  try {
    for (const name of [
      '202611060010_teaching_test_integrity.sql', '202611060020_teaching_test_manual_variants.sql',
      '202611060030_teaching_test_question_images.sql', '202611060040_teaching_module_lectures.sql',
      '202611060041_teaching_lecture_upload_guard.sql', '202611060050_teaching_test_rich_content.sql',
      '202611060080_teaching_test_concurrency.sql', '202611060120_teaching_test_isolated_qa.sql',
      '202611110010_teaching_sequence_select.sql', '202611110020_teaching_test_variant_identity.sql',
      ...(applyRetakes ? [personalRetakesMigration] : []),
    ]) await fx.db.exec(await readCourseModuleMigration(name))
    const { db, ids, groups, rpc, mutate } = fx
    const testMutate = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate',
      [action, JSON.stringify({ ...payload, expected_user_id: who })])
    const testDetail = (who, id) => rpc(who, 'xelay_teaching_test', [id])
    const testList = (who, course = ids.course, group = groups[0]) => rpc(who, 'xelay_teaching_tests', [course, group])
    const question = id => ({ id, kind: 'choice', text: 'Оберіть число два · ' + id, points: 1,
      time_limit_seconds: null, partial_credit: false,
      options: ['a', 'b', 'c', 'd'].map((value, index) => ({ id: value, text: String(index + 1) })), buckets: [], answer: 'b' })
    const definition = (overrides = {}) => syntheticTest(ids.course, [groups[0]], {
      max_points: 10, bonus_percent: 0, bonus_points: 0, base_variant_title: 'Основний набір',
      questions: ['base_one', 'base_two'].map(question),
      variants: [
        { id: 'chapter_b', title: 'Додатковий набір Б', questions: ['b_one', 'b_two'].map(question) },
        { id: 'chapter_c', title: 'Додатковий набір В', questions: ['c_one', 'c_two'].map(question) },
      ], ...overrides,
    })
    async function createTest(overrides = {}) {
      const input = definition(overrides)
      const detail = await testMutate(ids.owner, 'save_test', input)
      return { definition: input, detail }
    }
    async function complete(who, id, { group = groups[0], correctCount = Infinity, accessCode } = {}) {
      let detail = await testMutate(who, 'start', { id, group_id: group, ...(accessCode ? { access_code: accessCode } : {}) })
      if (!detail.attempt || detail.attempt.status !== 'in_progress') throw new Error('Synthetic attempt did not start: ' + JSON.stringify(detail))
      const first = detail.attempt
      const count = first.question_count
      for (let index = 0; index < count; index++) {
        const questionId = detail.attempt.current_question.id
        detail = await testMutate(who, 'save_answer', { id, attempt_id: first.id, version: detail.attempt.version,
          question_id: questionId, answer: index < correctCount ? 'b' : 'a' })
        if (index + 1 < count) detail = await testMutate(who, 'navigate', { id, attempt_id: first.id,
          version: detail.attempt.version, index: index + 1 })
      }
      return testMutate(who, 'finish', { id, attempt_id: first.id, version: detail.attempt.version })
    }
    async function finalize(id) {
      let detail = await testDetail(ids.owner, id)
      if (detail.test.status !== 'closed') detail = await testMutate(ids.owner, 'close_test', {
        id, version: detail.test.version, confirm_close_all: true,
      })
      return testMutate(ids.owner, 'finalize_results', { id, version: detail.test.version })
    }
    async function grade(id, user = ids.studentA) {
      return (await db.query(`select g.*,g.draft_score::float draft_score_number,g.published_score::float published_score_number
        from teaching_test_activities l join teaching_entries e on e.group_id=l.group_id and e.user_id=$2
        join teaching_activities a on a.id=l.activity_id and a.course_id=e.course_id
        join teaching_grades g on g.activity_id=a.id and g.entry_id=e.id where l.test_id=$1 and l.group_id=$3`,
      [id, user, groups[0]])).rows[0]
    }
    async function publishOriginal(id, user = ids.studentA) {
      let detail = await finalize(id)
      detail = await testMutate(ids.owner, 'review_results', { id, version: detail.test.version })
      const saved = await grade(id, user)
      await mutate(ids.owner, 'publish_grades', { activity_id: saved.activity_id,
        expected_versions: [{ entry_id: saved.entry_id, version: saved.version }] })
      return testDetail(ids.owner, id)
    }
    async function journalState() {
      return (await db.query(`select jsonb_build_object(
        'activities',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from teaching_activities a),
        'grades',(select coalesce(jsonb_agg(to_jsonb(g) order by id),'[]') from teaching_grades g),
        'grade_audit',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from teaching_grade_audit h)
      ) state`)).rows[0].state
    }
    async function createQaTest() {
      // The narrow QA IDs refer to wholly fictional fixture rows here.
      const owner = '04f587f8-1604-4f53-aabc-d1699c938b1d'
      const group = '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'
      const course = randomUUID(), request = randomUUID()
      await fx.seedUser(owner, { full_name: 'Synthetic private QA owner', username: 'synthetic_retake_qa',
        university_id: fx.scope.university_id, academic_unit_id: fx.scope.id, account_type: 'teacher', categories: [], experience: '' })
      await db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,status,reviewed_at,contact_telegram)
        values($1,'Synthetic QA owner',$2,$3,'Synthetic department','Synthetic lecturer','approved',now(),'synthetic_qa')`, [owner, fx.scope.university_id, fx.scope.id])
      await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
        values($1,$2,'Synthetic QA owner',$3,$4,'Synthetic programme','Synthetic QA group','synthetic_qa','approved',$5,now())`,
      [request, owner, fx.scope.university_id, fx.scope.id, ids.admin])
      await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
        values($1,$2,$3,$4,$5,'Synthetic programme','Synthetic QA group')`, [group, request, owner, fx.scope.university_id, fx.scope.id])
      await db.query(`insert into study_group_members(group_id,user_id,invited_by,status,accepted_at)
        values($1,$2,$3,'accepted',now())`, [group, ids.studentA, owner])
      await mutate(owner, 'create_course', { id: course, version: 0, title: 'Synthetic QA subject', semester: 'Synthetic semester',
        starts_on: fx.dates.start, ends_on: fx.dates.finish })
      await db.query(`insert into teaching_course_groups(course_id,group_id,status,invited_by,accepted_at)
        values($1,$2,'accepted',$3,now())`, [course, group, owner])
      const input = definition({ course_id: course, targets: [{ group_id: group, audience_mode: 'all', subgroup_ids: [] }], status: 'draft', variants: [] })
      let saved = await testMutate(owner, 'save_test', input)
      saved = await testMutate(owner, 'save_test', { ...input, version: saved.test.version, qa_own_attempt: true })
      saved = await testMutate(owner, 'save_test', { ...input, version: saved.test.version, status: 'published' })
      return { owner, group, course, definition: input, detail: saved }
    }
    return { ...fx, testMutate, testDetail, testList, definition, createTest, complete, finalize, grade, publishOriginal, journalState, createQaTest }
  } catch (failure) { await fx.close(); throw failure }
}
