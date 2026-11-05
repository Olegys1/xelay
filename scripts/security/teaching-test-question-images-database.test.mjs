import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { teachingTestAdmissionFixture } from './teaching-test-admission-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

// A synthetic 4 × 4 JPEG, with no personal content.
const jpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q=='

test('question images are validated, private and scoped to the current assigned question', async t => {
  const fx = await teachingTestAdmissionFixture()
  t.after(() => fx.close())
  const { db, ids, groups, dates, mutate, rpc, testMutate, testDetail, testList } = fx
  for (const migration of [
    '202611050061_teaching_test_explicit_close.sql',
    '202611060010_teaching_test_integrity.sql',
    '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql',
  ]) await db.exec(await readCourseModuleMigration(migration))

  const upload = (actor, data = jpeg, course = ids.course, expectedActor = actor) =>
    rpc(actor, 'xelay_teaching_test_question_image_upload', [course, expectedActor, data])
  const read = (actor, image) => rpc(actor, 'xelay_teaching_test_question_image', [image])
  const photo = id => ({ id, mime_type: 'image/jpeg', alt: 'Схема до завдання' })
  const otherCourse = randomUUID()
  await mutate(ids.otherTeacher, 'create_course', {
    id: otherCourse, version: 0, title: 'Synthetic private course', semester: 'Synthetic semester',
    starts_on: dates.start, ends_on: dates.finish,
  })
  const wrongCourse = photo((await upload(ids.otherTeacher, jpeg, otherCourse)).id)
  const regular = [photo((await upload(ids.owner)).id), photo((await upload(ids.owner)).id)]
  const variant = [photo((await upload(ids.owner)).id), photo((await upload(ids.owner)).id)]
  const unattached = photo((await upload(ids.owner)).id)

  await t.test('only a teacher with current course access uploads valid bounded raster bytes', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
    const oversizedFrame = Buffer.from(jpeg, 'base64')
    const frame = oversizedFrame.indexOf(Buffer.from([255, 192]))
    oversizedFrame.writeUInt16BE(2000, frame + 7)
    const polyglot = Buffer.concat([Buffer.from(jpeg, 'base64'), Buffer.from('<html>other content</html>'), Buffer.from([255, 217])])
    for (const badData of [svg, 'A'.repeat(350000), oversizedFrame.toString('base64'), jpeg.slice(0, -4), polyglot.toString('base64')]) {
      await assert.rejects(upload(ids.owner, badData), /TEST_INVALID_INPUT/)
    }
    await assert.rejects(upload(ids.owner, jpeg, ids.course, ids.studentA), /ACTOR_CHANGED/)
    await assert.rejects(upload(ids.studentA), /FORBIDDEN|EXPIRED_OR_UNVERIFIED/)
    await assert.rejects(upload(ids.otherTeacher), /FORBIDDEN/)
    await assert.rejects(read(ids.studentA, regular[0].id), /TEST_FORBIDDEN/)
    assert.equal(await read(ids.owner, regular[0].id), jpeg)
    assert.deepEqual((await db.query("select has_table_privilege('authenticated','public.teaching_test_question_images','select') allowed")).rows, [{ allowed: false }])
  })

  const definition = syntheticTest(ids.course, [groups[0]], { bonus_percent: 0, bonus_points: 0 })
  const questions = definition.questions.slice(0, 2).map((q, index) => ({ ...q, time_limit_seconds: null, images: [regular[index]] }))
  const variants = [{ id: 'form_b', title: 'Варіант Б', questions: questions.map((q, index) => ({ ...q, id: `form_b_${q.id}`, images: [variant[index]] })) }]
  const authoredTest = { ...definition, questions, variants }

  await t.test('untrusted image metadata and links from other courses cannot be saved', async () => {
    for (const invalid of [wrongCourse, { ...regular[0], url: 'https://example.com/a' }, { ...regular[0], mime_type: 'image/svg+xml' }]) {
      const badQuestions = [{ ...questions[0], images: [invalid] }, questions[1]]
      await assert.rejects(testMutate(ids.owner, 'save_test', { ...authoredTest, questions: badQuestions }), /TEST_INVALID_INPUT/)
    }
    const badVariants = [{ ...variants[0], questions: [{ ...variants[0].questions[0], images: [wrongCourse] }, variants[0].questions[1]] }]
    await assert.rejects(testMutate(ids.owner, 'save_test', { ...authoredTest, variants: badVariants }), /TEST_INVALID_INPUT/)
    const bankPayload = { course_id: ids.course, expected_user_id: ids.owner, question: questions[0], id: randomUUID() }
    const bank = await rpc(ids.owner, 'xelay_teaching_question_bank_mutate', ['save_entry', JSON.stringify(bankPayload)])
    assert.deepEqual(bank.entries[0].question.images, [regular[0]])
    await assert.rejects(rpc(ids.owner, 'xelay_teaching_question_bank_mutate', ['save_entry', JSON.stringify({
      ...bankPayload, id: randomUUID(), question: { ...questions[0], images: [wrongCourse] },
    })]), /TEST_INVALID_INPUT/)
  })

  await t.test('student loads only the visible photo, while staff reviews metadata without duplicating bytes', async () => {
    const saved = await testMutate(ids.owner, 'save_test', authoredTest)
    assert.deepEqual(saved.test.questions[0].images, [regular[0]])
    assert.deepEqual(saved.test.variants[0].questions[0].images, [variant[0]])
    assert.equal(await read(ids.owner, variant[0].id), jpeg)
    assert.doesNotMatch(JSON.stringify(saved), /\/9j\//)
    assert.doesNotMatch(JSON.stringify(await testList(ids.studentA)), new RegExp(regular[0].id))
    for (const image of [...regular, ...variant, unattached]) await assert.rejects(read(ids.studentA, image.id), /TEST_FORBIDDEN/)

    let run = await testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
    const issued = run.attempt.current_question.id.startsWith('form_b_') ? variant : regular
    const unissued = issued === regular ? variant : regular
    assert.deepEqual(run.attempt.current_question.images, [issued[0]])
    assert.equal(run.attempt.current_question.answer, undefined)
    assert.equal(run.attempt.questions, undefined)
    assert.equal(await read(ids.studentA, issued[0].id), jpeg)
    for (const image of [issued[1], ...unissued, unattached]) await assert.rejects(read(ids.studentA, image.id), /TEST_FORBIDDEN/)
    await assert.rejects(read(ids.outsider, issued[0].id), /TEST_FORBIDDEN/)
    run = await testMutate(ids.studentA, 'navigate', { id: definition.id, version: run.attempt.version, index: 1 })
    assert.deepEqual(run.attempt.current_question.images, [issued[1]])
    assert.equal(await read(ids.studentA, issued[1].id), jpeg)
    await assert.rejects(read(ids.studentA, issued[0].id), /TEST_FORBIDDEN/)

    run = await testMutate(ids.studentA, 'finish', { id: definition.id, version: run.attempt.version })
    assert.equal(run.attempt.current_question, null)
    await assert.rejects(read(ids.studentA, issued[1].id), /TEST_FORBIDDEN/)
    const staff = await testDetail(ids.owner, definition.id)
    assert.deepEqual(staff.attempts[0].questions[1].images, [issued[1]])
    assert.doesNotMatch(JSON.stringify(staff), /\/9j\//)
  })
})
