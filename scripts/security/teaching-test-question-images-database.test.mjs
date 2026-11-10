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
    '202611060050_teaching_test_rich_content.sql',
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
    assert.equal(saved.test.allow_external_links, false)
    assert.deepEqual(saved.test.questions[0].images, [regular[0]])
    assert.deepEqual(saved.test.variants[0].questions[0].images, [variant[0]])
    assert.equal(await read(ids.owner, variant[0].id), jpeg)
    assert.doesNotMatch(JSON.stringify(saved), /\/9j\//)
    assert.doesNotMatch(JSON.stringify(await testList(ids.studentA)), new RegExp(regular[0].id))
    for (const image of [...regular, ...variant, unattached]) await assert.rejects(read(ids.studentA, image.id), /TEST_FORBIDDEN/)

    let run = await testMutate(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
    assert.equal(run.attempt.watermark_surname, undefined)
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

  await t.test('a new subgroup retake reuses question photos without changing the closed test or admitting other group members', async () => {
    const original = await testDetail(ids.owner, definition.id)
    const closed = await testMutate(ids.owner, 'close_test', {
      id: definition.id, version: original.test.version, expected_user_id: ids.owner, confirm_close_all: true,
    })
    assert.equal(closed.test.status, 'closed')
    const subgroup = randomUUID()
    await rpc(ids.owner, 'xelay_teaching_audience_mutate', ['save_subgroup', JSON.stringify({
      id: subgroup, course_id: ids.course, group_id: groups[0], version: 0,
      name: 'Синтетична перездача', user_ids: [ids.studentA], expected_user_id: ids.owner,
    })])
    const retake = { ...authoredTest, id: randomUUID(), title: 'Синтетична перездача', status: 'draft',
      targets: [{ group_id: groups[0], audience_mode: 'subgroups', subgroup_ids: [subgroup] }] }
    const draft = await testMutate(ids.owner, 'save_test', retake)
    assert.equal(draft.test.status, 'draft')
    assert.equal((await testList(ids.studentA)).tests.some(test => test.id === retake.id), false)
    await testMutate(ids.owner, 'save_test', { ...retake, status: 'published', version: draft.test.version })
    await assert.rejects(testMutate(ids.headA, 'start', { id: retake.id, group_id: groups[0] }), /TEST_FORBIDDEN/)
    const attempt = await testMutate(ids.studentA, 'start', { id: retake.id, group_id: groups[0] })
    assert.equal(attempt.attempt.test_id, retake.id)
    assert.equal(await read(ids.studentA, attempt.attempt.current_question.images[0].id), jpeg)
    const preserved = await testDetail(ids.owner, definition.id)
    assert.equal(preserved.test.version, closed.test.version)
    assert.deepEqual(preserved.attempts, closed.attempts)
    const links = await db.query('select distinct activity_id from public.teaching_test_activities where test_id in ($1,$2)', [definition.id, retake.id])
    assert.equal(links.rows.length, 2)
  })

  await t.test('answer-option photos survive variants and shuffling and remain private to the issued question', async () => {
    const optionImages = [
      [photo((await upload(ids.owner)).id), photo((await upload(ids.owner)).id)],
      [photo((await upload(ids.owner)).id), photo((await upload(ids.owner)).id)],
    ]
    const definition = syntheticTest(ids.course, [groups[0]], {
      bonus_percent: 0, bonus_points: 0, shuffle_answers: true, discourage_capture: true, allow_external_links: true,
    })
    const optionQuestions = optionImages.map((set, variantIndex) => set.map((image, index) => {
      const question = structuredClone(definition.questions[0])
      return {
        ...question, id: `photo_${variantIndex}_${index}`, kind: index ? 'multiple' : 'choice',
        text: 'Порівняйте \\(x^2\\) та https://example.com/course', time_limit_seconds: null,
        options: question.options.map(option => option.id === 'b' ? { ...option, text: '', images: [image] } : option),
        answer: index ? ['b'] : 'b',
      }
    }))
    const test = {
      ...definition, questions: optionQuestions[0],
      variants: [{ id: 'option_form_b', title: 'Варіант Б із фото', questions: optionQuestions[1] }],
    }
    const editOptionImages = images => ({
      ...test, questions: test.questions.map((q, index) => index === 0
        ? { ...q, options: q.options.map(o => o.id === 'b' ? { ...o, images } : o) } : q),
    })
    for (const invalid of [[wrongCourse], [optionImages[0][0], optionImages[0][1]], [{ ...optionImages[0][0], url: 'https://example.com/private' }], {}]) {
      await assert.rejects(testMutate(ids.owner, 'save_test', editOptionImages(invalid)), /TEST_INVALID_INPUT/)
    }
    await assert.rejects(testMutate(ids.owner, 'save_test', { ...test, allow_external_links: 'true' }), /TEST_INVALID_INPUT/)
    await assert.rejects(testMutate(ids.studentA, 'save_test', test), /FORBIDDEN|EXPIRED_OR_UNVERIFIED/)

    const bankPayload = { course_id: ids.course, expected_user_id: ids.owner, question: test.questions[0], id: randomUUID() }
    const bank = await rpc(ids.owner, 'xelay_teaching_question_bank_mutate', ['save_entry', JSON.stringify(bankPayload)])
    assert.deepEqual(bank.entries.find(item => item.id === bankPayload.id).question.options.find(option => option.id === 'b').images, [optionImages[0][0]])
    await assert.rejects(rpc(ids.owner, 'xelay_teaching_question_bank_mutate', ['save_entry', JSON.stringify({
      ...bankPayload, id: randomUUID(), question: editOptionImages([wrongCourse]).questions[0],
    })]), /TEST_INVALID_INPUT/)

    const saved = await testMutate(ids.owner, 'save_test', test)
    assert.equal(saved.test.allow_external_links, true)
    assert.deepEqual(saved.test.questions, optionQuestions[0])
    assert.deepEqual(saved.test.variants[0].questions, optionQuestions[1])
    await db.query("update public.profiles set first_name='Марія',last_name='Прикладенко' where id=$1::uuid", [ids.studentA])
    for (const image of optionImages.flat()) await assert.rejects(read(ids.studentA, image.id), /TEST_FORBIDDEN/)

    let run = await testMutate(ids.studentA, 'start', { id: test.id, group_id: groups[0] })
    const issuedVariant = run.attempt.current_question.id.startsWith('photo_1_') ? 1 : 0
    const [first, second] = optionImages[issuedVariant]
    assert.equal(run.test.allow_external_links, true)
    assert.equal(run.attempt.attempt_number, 1)
    assert.equal(run.attempt.watermark_surname, 'Прикладенко')
    assert.equal(run.attempt.student_name, undefined)
    assert.equal(run.attempt.current_question.text, test.questions[0].text)
    assert.equal(run.attempt.current_question.answer, undefined)
    assert.equal(run.attempt.questions, undefined)
    assert.deepEqual(run.attempt.current_question.options.find(option => option.id === 'b').images, [first])
    assert.equal(await read(ids.studentA, first.id), jpeg)
    for (const image of [second, ...optionImages[1 - issuedVariant]]) {
      await assert.rejects(read(ids.studentA, image.id), /TEST_FORBIDDEN/)
    }
    await assert.rejects(read(ids.outsider, first.id), /TEST_FORBIDDEN/)
    await assert.rejects(testMutate(ids.owner, 'save_test', {
      ...test, version: saved.test.version, allow_external_links: false,
    }), /TEST_IMMUTABLE/)

    run = await testMutate(ids.studentA, 'save_answer', {
      id: test.id, version: run.attempt.version, question_id: run.attempt.current_question.id, answer: 'b',
    })
    run = await testMutate(ids.studentA, 'navigate', { id: test.id, version: run.attempt.version, index: 1 })
    assert.deepEqual(run.attempt.current_question.options.find(option => option.id === 'b').images, [second])
    assert.equal(await read(ids.studentA, second.id), jpeg)
    await assert.rejects(read(ids.studentA, first.id), /TEST_FORBIDDEN/)
    run = await testMutate(ids.studentA, 'save_answer', {
      id: test.id, version: run.attempt.version, question_id: run.attempt.current_question.id, answer: ['b'],
    })
    await testMutate(ids.studentA, 'finish', { id: test.id, version: run.attempt.version })
    await assert.rejects(read(ids.studentA, second.id), /TEST_FORBIDDEN/)
    const staff = await testDetail(ids.owner, test.id)
    assert.deepEqual(staff.attempts[0].questions[1].options.find(option => option.id === 'b').images, [second])
    assert.equal(staff.attempts[0].watermark_surname, 'Прикладенко')
    assert.equal(staff.attempts[0].auto_score, 20)
    assert.doesNotMatch(JSON.stringify(staff), /\/9j\//)
    const legacy = await testMutate(ids.headA, 'start', { id: test.id, group_id: groups[0] })
    assert.equal(legacy.attempt.watermark_surname, null)
    assert.equal(legacy.attempt.attempt_number, 1)
  })
})
