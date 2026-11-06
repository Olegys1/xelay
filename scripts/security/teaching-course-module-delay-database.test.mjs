import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

test('module delay starts at the last student completion and guards video and tests until expiry', async t => {
  const fx = await courseModulesFixture({ additionalMigrations: [
    '202611040060_teaching_test_admission.sql', '202611050061_teaching_test_explicit_close.sql',
    '202611060010_teaching_test_integrity.sql', '202611060020_teaching_test_manual_variants.sql',
    '202611060030_teaching_test_question_images.sql', '202611060040_teaching_module_lectures.sql',
    '202611060041_teaching_lecture_upload_guard.sql', '202611060050_teaching_test_rich_content.sql',
    '202611060055_teaching_module_prerequisite_diagnostics.sql',
    '202611060060_teaching_course_module_delay.sql',
  ] })
  t.after(() => fx.close())
  const { ids, groups, db, rpc, mutate, asUser } = fx
  const group = groups[0]
  const testAction = (user, action, body) => rpc(user, 'xelay_teaching_test_mutate', [action, JSON.stringify({ ...body, expected_user_id: user })])
  const save = body => rpc(ids.owner, 'xelay_teaching_course_module_save', [JSON.stringify({ ...body, expected_user_id: ids.owner })])
  const learning = async (id, who = ids.studentA) => (await rpc(who, 'xelay_student_course_modules', [ids.course, group])).modules.find(module => module.id === id)
  const start = (testId, who = ids.studentA) => testAction(who, 'start', { id: testId, group_id: group })
  const item = (resource_type, resource_id, completion, position) => ({ id: randomUUID(), resource_type, resource_id, completion, position,
    required: true, pass_percent: null, prerequisite_item_ids: [] })

  const reading = item('material', randomUUID(), 'acknowledged', 0)
  await mutate(ids.owner, 'save_library_material', { id: reading.resource_id, version: 0, expected_user_id: ids.owner, course_id: ids.course,
    title: 'Synthetic module delay reading', body: 'Local testing only.', links: [], attachments: [], status: 'published',
    rights_accepted: true, rights_terms_version: '2026-10-27.1', target_group_ids: [group] })
  const firstTest = syntheticTest(ids.course, [group], { bonus_percent: 0, bonus_points: 0 })
  const nextTest = syntheticTest(ids.course, [group], { bonus_percent: 0, bonus_points: 0 })
  await testAction(ids.owner, 'save_test', firstTest)
  await testAction(ids.owner, 'save_test', nextTest)
  const firstExam = item('test', firstTest.id, 'submitted', 1)
  const nextExam = item('test', nextTest.id, 'submitted', 0)
  const first = { id: randomUUID(), course_id: ids.course, title: 'Module one', status: 'published', group_ids: [group],
    position: 0, version: 0, prerequisite_item_ids: [], items: [reading, firstExam] }

  const file = { storage_path: `${ids.course}/${ids.owner}/${randomUUID()}.mp4`, name: 'Synthetic lecture.mp4', mime_type: 'video/mp4', size: 32 }
  await asUser(ids.owner, "insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values('xelay-teaching-files',$1,$2::uuid,$2::text,$3::jsonb)",
    [file.storage_path, ids.owner, JSON.stringify({ size: file.size, mimetype: file.mime_type })])
  const candidate = await rpc(ids.owner, 'xelay_upload_scan_candidate', ['xelay-teaching-files', file.storage_path])
  const receipt = await asUser(null, 'select public.xelay_record_upload_content_verification($1::jsonb,$2,$3,$4,1) value',
    [JSON.stringify(candidate), 'a'.repeat(64), 'b'.repeat(64), file.mime_type], { role: 'service_role' })
  assert.equal(receipt.rows[0].value, true)

  const next = { ...first, id: randomUUID(), position: 1, title: 'Delayed lecture', description: 'Hidden until release',
    prerequisite_item_ids: [reading.id, firstExam.id], items: [nextExam], release_delay_days: 5,
    lecture: { file, duration_seconds: 30, test_item_id: nextExam.id } }
  assert.equal((await save(first)).modules.find(m => m.id === first.id).release_delay_days, 0)
  await assert.rejects(save({ ...next, release_delay_days: 366 }), /COURSE_MODULE_DELAY_INVALID/)
  await assert.rejects(save({ ...next, release_delay_days: 1.5 }), /COURSE_MODULE_DELAY_INVALID/)
  await assert.rejects(save({ ...next, prerequisite_item_ids: [] }), /COURSE_MODULE_DELAY_REQUIRES_STEPS/)
  assert.equal((await save(next)).modules.find(m => m.id === next.id).release_delay_days, 5)
  assert.equal((await learning(next.id)).available_at, null)
  await assert.rejects(rpc(ids.studentA, 'xelay_private_module_delay_until', [next.id, group, ids.headA]), { code: '42501' })

  await rpc(ids.studentA, 'xelay_student_module_acknowledge', [reading.id, group, ids.studentA])
  await db.query("update public.teaching_course_module_acknowledgements set acknowledged_at=statement_timestamp()-interval '10 days' where item_id=$1", [reading.id])
  assert.equal((await learning(next.id)).available_at, null, 'one completion does not start the delay')
  const started = await start(firstTest.id)
  const submitted = await testAction(ids.studentA, 'finish', { id: firstTest.id, version: started.attempt.version })
  const waiting = await learning(next.id)
  assert.equal(waiting.locked, true)
  assert.equal(waiting.description, '')
  assert.equal(waiting.lecture.file, null)
  assert.equal(waiting.items[0].locked, true)
  assert.equal(Date.parse(waiting.available_at), Date.parse(submitted.attempt.submitted_at) + 5 * 86400000)
  assert.equal((await learning(next.id, ids.headA)).available_at, null, 'the clock is personal')
  assert.equal(await rpc(ids.studentA, 'xelay_teaching_can_read_file', [file.storage_path]), false)
  await assert.rejects(start(nextTest.id), /FORBIDDEN/)
  await assert.rejects(rpc(ids.studentA, 'xelay_student_module_lecture_progress', [next.id, group, ids.studentA, 1, file.storage_path]), /COURSE_MODULE_LOCKED/)

  await db.query("update public.teaching_test_attempts set submitted_at=statement_timestamp()-interval '6 days' where id=$1", [submitted.attempt.id])
  const opened = await learning(next.id)
  assert.equal(opened.locked, false)
  assert.equal(opened.description, 'Hidden until release')
  assert.equal(opened.lecture.file.storage_path, file.storage_path)
  assert.equal(await rpc(ids.studentA, 'xelay_teaching_can_read_file', [file.storage_path]), true)
  await assert.rejects(start(nextTest.id), /FORBIDDEN/, 'watching the video still applies')
  const watch = seconds => rpc(ids.studentA, 'xelay_student_module_lecture_progress', [next.id, group, ids.studentA, seconds, file.storage_path])
  await watch(0)
  await db.query("update public.teaching_course_module_lecture_progress set heartbeat_at=clock_timestamp()-interval '15 seconds' where module_id=$1 and user_id=$2", [next.id, ids.studentA])
  assert.equal((await watch(27)).modules.find(m => m.id === next.id).lecture.completed, true)
  assert.equal((await start(nextTest.id)).attempt.status, 'in_progress')

  const { release_delay_days, ...oldClientPayload } = next
  assert.equal((await save({ ...oldClientPayload, version: 1 })).modules.find(m => m.id === next.id).release_delay_days, 5)
  assert.equal((await save({ ...next, version: 2, release_delay_days: 0, prerequisite_item_ids: [] })).modules.find(m => m.id === next.id).release_delay_days, 0)
})
