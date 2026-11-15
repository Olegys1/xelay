import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
import { seedCourseModulesPreview } from './course-modules-preview-seed.mjs'

test('course path uses actual ACK, submission, published grade and test attempt without resetting existing records', async () => {
  const fx = await courseModulesFixture()
  try {
    const { ids, groups, db, rpc } = fx
    const seed = await seedCourseModulesPreview(fx)
    const structure = await rpc(ids.owner, 'xelay_teaching_course_modules', [ids.course])
    const roundTrip = structure.modules.find(module => module.id === seed.moduleIds[0])
    await rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify({ ...roundTrip, title: 'Розібратися в основах', expected_user_id: ids.owner, items: roundTrip.items.map(({ title, ...item }) => item) })])
    const learning = () => rpc(ids.studentA, 'xelay_student_course_modules', [ids.course, groups[0]])
    const testStep = data => data.modules.flatMap(module => module.items).find(item => item.resource_id === seed.testId)
    let data = await learning()
    assert.equal(data.percent, 0)
    assert.equal(testStep(data).locked, true)
    const prior = (await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows
    await assert.rejects(rpc(ids.studentA, 'xelay_classroom_assignment', [seed.assignmentId, groups[0]]), /FORBIDDEN|MODULE_LOCKED/)
    await rpc(ids.studentA, 'xelay_student_module_acknowledge', [seed.itemIds[0], groups[0], ids.studentA])
    data = await learning()
    assert.equal(data.completed, 1)
    assert.equal(testStep(data).locked, true)
    assert.equal((await rpc(ids.studentA, 'xelay_classroom_assignment', [seed.assignmentId, groups[0]])).item.id, seed.assignmentId)
    const id = randomUUID()
    let saved = await fx.classroom(ids.studentA, 'reserve_submission', { id, item_id: seed.assignmentId, group_id: groups[0] })
    saved = await fx.classroom(ids.studentA, 'save_submission', { id, item_id: seed.assignmentId, group_id: groups[0], version: saved.version, body: 'Зростання доходу підвищило попит на книги за кожною ціною.', links: [], attachments: [] })
    assert.equal(testStep(await learning()).locked, true, 'a draft never counts as submitted or passed')
    await fx.classroom(ids.studentA, 'submit_submission', { id, version: saved.version })
    assert.equal(testStep(await learning()).locked, true, 'submitted alone does not meet the selected published 60% condition')
    const activity = (await db.query('select id from teaching_activities where item_id=$1 and group_id=$2', [seed.assignmentId, groups[0]])).rows[0]
    const entry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3 and active', [ids.course, groups[0], ids.studentA])).rows[0]
    const grade = await fx.mutate(ids.owner, 'save_grade', { activity_id: activity.id, entry_id: entry.id, version: 0, score: 6, comment: 'Умову виконано.', reason: '' })
    assert.equal(testStep(await learning()).locked, true, 'private draft score does not unlock anything')
    await fx.mutate(ids.owner, 'publish_grades', { activity_id: activity.id, expected_versions: [{ entry_id: entry.id, version: grade.version }] })
    data = await learning()
    assert.equal(data.completed, 2)
    assert.equal(testStep(data).locked, false)
    let detail = await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['start', JSON.stringify({ id: seed.testId, group_id: groups[0] })])
    for (const [questionId, answer] of [['demand', 'income'], ['equilibrium', 'true']]) {
      if (questionId === 'equilibrium') detail = await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['navigate', JSON.stringify({ id: seed.testId, version: detail.attempt.version, index: 1 })])
      detail = await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['save_answer', JSON.stringify({ id: seed.testId, version: detail.attempt.version, question_id: questionId, answer })])
    }
    await rpc(ids.studentA, 'xelay_teaching_test_mutate', ['finish', JSON.stringify({ id: seed.testId, version: detail.attempt.version })])
    data = await learning()
    assert.equal(data.percent, 100)
    assert.equal(testStep(data).completed, true)
    assert.equal(testStep(data).score, null, 'preliminary test score stays private until teacher publication')
    const progress = await rpc(ids.owner, 'xelay_teaching_course_modules', [ids.course])
    assert.equal(progress.progress.find(row => row.user_id === ids.studentA && row.group_id === groups[0]).percent, 100)
    const other = await rpc(ids.studentB, 'xelay_student_course_modules', [ids.course, groups[1]])
    assert.deepEqual(other.modules, [])
    const newRows = (await db.query('select to_jsonb(g) data from teaching_grades g where entry_id<>$1 order by id', [entry.id])).rows
    assert.deepEqual(newRows, prior, 'the existing published grade survives the entire student flow unchanged')
    assert.equal((await rpc(ids.studentA, 'xelay_classroom_assignment', [seed.assignmentId, groups[0]])).my_submission.status, 'submitted')
  } finally { await fx.close() }
})
