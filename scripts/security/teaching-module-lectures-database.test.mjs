import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

test('lecture video, sequential admission and private statistics use current course and group rights', async t => {
  const fx = await courseModulesFixture({ additionalMigrations: [
    '202611040060_teaching_test_admission.sql',
    '202611050061_teaching_test_explicit_close.sql',
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
    '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql',
  ] })
  t.after(() => fx.close())
  const { db, ids, groups, rpc, asUser } = fx
  const group = groups[0]
  const saveModule = (module, user = ids.owner) => rpc(user, 'xelay_teaching_course_module_save', [JSON.stringify({ ...module, expected_user_id: user })])
  const learning = (user = ids.studentA) => rpc(user, 'xelay_student_course_modules', [ids.course, group])
  const getModule = async (id, user = ids.studentA) => (await learning(user)).modules.find(module => module.id === id)
  const getProgress = (id, position, user = ids.studentA, expected = user) => rpc(user, 'xelay_student_module_lecture_progress', [id, group, expected, position])
  const stats = (id, user = ids.owner, target = group) => rpc(user, 'xelay_teaching_module_lecture_statistics', [id, target])
  const testAction = (user, action, payload) => rpc(user, 'xelay_teaching_test_mutate', [action, JSON.stringify({ expected_user_id: user, ...payload })])
  const canRead = (user, file) => rpc(user, 'xelay_teaching_can_read_file', [file.storage_path])
  const canDelete = (user, file) => rpc(user, 'xelay_teaching_can_remove_file', [file.storage_path])
  const insertStorage = (user, path, metadata) => asUser(user,
    "insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values('xelay-teaching-files',$1,$2,$3,$4::jsonb)",
    [path, user, user, JSON.stringify(metadata)])

  async function video(verified) {
    const file = { storage_path: `${ids.course}/${ids.owner}/${randomUUID()}.mp4`, name: 'Fictional lecture.mp4', mime_type: 'video/mp4', size: 32 }
    await insertStorage(ids.owner, file.storage_path, { size: file.size, mimetype: file.mime_type })
    if (verified) {
      const candidate = await rpc(ids.owner, 'xelay_upload_scan_candidate', ['xelay-teaching-files', file.storage_path])
      const receipt = await asUser(null, 'select public.xelay_record_upload_content_verification($1::jsonb,$2,$3,$4,1) value',
        [JSON.stringify(candidate), 'a'.repeat(64), 'b'.repeat(64), file.mime_type], { role: 'service_role' })
      assert.equal(receipt.rows[0].value, true)
    }
    return file
  }

  function moduleFor(testId, file, position, completion = 'submitted') {
    const itemId = randomUUID()
    return { id: randomUUID(), course_id: ids.course, title: `Лекція ${position + 1}`, description: 'Відеолекція та тест.',
      status: 'published', group_ids: [group], position, version: 0, prerequisite_item_ids: [],
      items: [{ id: itemId, resource_type: 'test', resource_id: testId, required: true, completion,
        pass_percent: completion === 'passed' ? 50 : null, prerequisite_item_ids: [], position: 0 }],
      lecture: { file, duration_seconds: 30, test_item_id: itemId } }
  }

  await t.test('Storage admits lecture preflight and final inserts only for the owner with the correct format and size', async () => {
    const path = (user, extension) => `${ids.course}/${user}/${randomUUID()}.${extension}`
    const denied = { code: '42501' }
    await insertStorage(ids.owner, path(ids.owner, 'mp4'), { contentLength: 100, mimetype: 'video/mp4' })
    await insertStorage(ids.owner, path(ids.owner, 'webm'), { size: 100, mimetype: 'video/webm' })
    await assert.rejects(insertStorage(ids.owner, path(ids.owner, 'mp4'), { size: 100, mimetype: 'application/pdf' }), denied)
    await assert.rejects(insertStorage(ids.owner, path(ids.owner, 'mp4'), { size: 52428801, mimetype: 'video/mp4' }), denied)
    await assert.rejects(insertStorage(ids.studentA, path(ids.studentA, 'mp4'), { size: 100, mimetype: 'video/mp4' }), denied)
  })

  const firstTest = syntheticTest(ids.course, [group], { bonus_percent: 0, bonus_points: 0 })
  const nextTest = syntheticTest(ids.course, [group], { bonus_percent: 0, bonus_points: 0 })
  await testAction(ids.owner, 'save_test', firstTest)
  await testAction(ids.owner, 'save_test', nextTest)
  const first = moduleFor(firstTest.id, await video(true), 0, 'passed')
  const next = moduleFor(nextTest.id, await video(true), 1)

  await t.test('only verified private video and valid group-wide linked tests may be published', async () => {
    const unverified = moduleFor(firstTest.id, await video(false), 0)
    await assert.rejects(saveModule(unverified), /COURSE_MODULE_LECTURE_FILE_UNVERIFIED/)
    assert.equal((await db.query('select count(*) from public.teaching_course_modules where id=$1', [unverified.id])).rows[0].count, 0)
    await assert.rejects(saveModule({ ...first, lecture: { ...first.lecture, test_item_id: randomUUID() } }), /COURSE_MODULE_LECTURE_TEST_REQUIRED/)
    await assert.rejects(saveModule(first, ids.studentA), /COURSE_MODULE_FORBIDDEN/)
    const saved = await saveModule(first)
    assert.equal(saved.modules.find(module => module.id === first.id).lecture.file.storage_path, first.lecture.file.storage_path)
    assert.deepEqual(saved.resources.find(resource => resource.id === firstTest.id).whole_group_ids, [group])
    await saveModule(next)
    await assert.rejects(testAction(ids.owner, 'save_test', { ...firstTest, status: 'draft', version: 1 }),
      /COURSE_MODULE_LECTURE_TEST_REQUIRED/)
    assert.equal(await canDelete(ids.owner, first.lecture.file), false)
    assert.equal(await canRead(ids.studentA, first.lecture.file), true)
    assert.equal(await canRead(ids.studentA, next.lecture.file), false)
    assert.equal(await canRead(ids.studentB, first.lecture.file), false)
    assert.equal(await canRead(ids.outsider, first.lecture.file), false)
    assert.equal((await getModule(next.id)).lecture.file, null)
  })

  await t.test('direct starts, media, skips and progress for other users are denied until prerequisites', async () => {
    assert.equal((await getModule(first.id)).items[0].locked, true)
    assert.equal((await getModule(next.id)).locked, true)
    await assert.rejects(testAction(ids.studentA, 'start', { id: firstTest.id, group_id: group }), /COURSE_MODULE_LOCKED|TEST_FORBIDDEN/)
    await assert.rejects(testAction(ids.studentA, 'start', { id: nextTest.id, group_id: group }), /COURSE_MODULE_LOCKED|TEST_FORBIDDEN/)
    await assert.rejects(getProgress(next.id, 0), /COURSE_MODULE_LOCKED/)
    await assert.rejects(getProgress(first.id, 0, ids.studentB), /COURSE_MODULE_FORBIDDEN/)
    await assert.rejects(getProgress(first.id, 0, ids.studentA, ids.headA), /TEACHING_ACTOR_CHANGED/)
    await assert.rejects(getProgress(first.id, 31), /COURSE_MODULE_INVALID/)
    await assert.rejects(rpc(ids.studentA, 'xelay_student_module_lecture_progress',
      [first.id, group, ids.studentA, 0, next.lecture.file.storage_path]), /COURSE_MODULE_CONFLICT/)
    await getProgress(first.id, 27)
    assert.equal((await getModule(first.id)).lecture.watched_seconds, 0)
    await db.query("update public.teaching_course_module_lecture_progress set heartbeat_at=clock_timestamp()-interval '6 seconds' where module_id=$1", [first.id])
    await getProgress(first.id, 27)
    assert.equal((await getModule(first.id)).lecture.watched_seconds, 0, 'elapsed clock prevents a skip')
    for (const seconds of [10, 20, 27]) {
      await db.query("update public.teaching_course_module_lecture_progress set heartbeat_at=clock_timestamp()-interval '6 seconds' where module_id=$1", [first.id])
      await getProgress(first.id, seconds)
    }
    const watched = await getModule(first.id)
    assert.equal(watched.lecture.completed, true)
    assert.equal(watched.items[0].locked, false)
    assert.equal((await getModule(first.id, ids.headA)).lecture.completed, false)
    assert.equal((await getModule(next.id)).locked, true)
  })

  await t.test('actual quiz score appears only in scoped teacher statistics; only published passing score opens the next lecture', async () => {
    const attempt = await testAction(ids.studentA, 'start', { id: firstTest.id, group_id: group })
    const answer = await testAction(ids.studentA, 'save_answer', { id: firstTest.id, version: attempt.attempt.version, question_id: 'choice', answer: 'b' })
    await testAction(ids.studentA, 'finish', { id: firstTest.id, version: answer.attempt.version })
    assert.equal((await getModule(first.id)).items[0].score, null)
    assert.equal((await getModule(next.id)).locked, true)
    let review = await stats(first.id)
    const learner = review.students.find(student => student.user_id === ids.studentA)
    assert.equal(learner.watched, true)
    assert.equal(learner.test_status, 'submitted')
    assert.equal(learner.score, 5)
    assert.equal(learner.published_score, null)
    assert.ok(review.questions.some(question => question.question_id === 'choice' && question.incorrect === 0 && question.attempted === 1))
    assert.ok(review.questions.some(question => question.question_id === 'boolean' && question.incorrect === 1))
    assert.ok(!JSON.stringify(review).includes('"answers"'))
    await assert.rejects(stats(first.id, ids.studentA), /COURSE_MODULE_FORBIDDEN/)
    await assert.rejects(stats(first.id, ids.owner, groups[1]), /COURSE_MODULE_FORBIDDEN/)

    await fx.mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: group })
    const activity = (await db.query('select activity_id id from public.teaching_test_activities where test_id=$1 and group_id=$2', [firstTest.id, group])).rows[0]
    const entry = (await db.query('select id from public.teaching_entries where course_id=$1 and group_id=$2 and user_id=$3 and active', [ids.course, group, ids.studentA])).rows[0]
    const grade = await fx.mutate(ids.owner, 'save_grade', { activity_id: activity.id, entry_id: entry.id, version: 0, score: 10, comment: 'Вигадана перевірка', reason: '' })
    assert.equal((await getModule(next.id)).locked, true)
    await fx.mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: entry.id, version: grade.version }] })
    assert.equal((await getModule(next.id)).locked, false)
    assert.equal(await canRead(ids.studentA, next.lecture.file), true)
    review = await stats(first.id)
    assert.equal(review.students.find(student => student.user_id === ids.studentA).published_score, 10)
  })

  await t.test('automatic ordering cannot form a cycle with manual prerequisites', async () => {
    const conflict = { ...first, version: 1, items: [{ ...first.items[0], prerequisite_item_ids: [next.items[0].id] }] }
    await assert.rejects(saveModule(conflict), /COURSE_MODULE_CYCLE/)
    assert.equal((await getModule(first.id)).version, 1)
  })
})
