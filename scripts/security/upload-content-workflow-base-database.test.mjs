// Current SQL workflow integration, fictional identities and inert fixture bytes.
// The bridge executes the current upload endpoint and byte validator against
// actual SQL RPCs and inert bytes. Only the external Storage HTTP/blob transport
// is synthetic: its candidate/version comes from the actual object row.
// It never contacts production, providers, email, or a remote database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = process.env.XELAY_AUDIT_SOURCE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const { createTeachingScopedFixture } = await import(pathToFileURL(path.join(root, 'scripts/security/teaching-scoped-fixture.mjs')))
const { verifyStoredBytes } = await import(pathToFileURL(path.join(root, 'scripts/security/upload-content-workflow-bridge.mjs')))
const migration = name => readFile(path.join(root, 'supabase/migrations', name), 'utf8')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const inertText = label => Buffer.from(`Synthetic local ${label}. No scripts, macros or executable content.\n`, 'utf8')
function inertPdf(_label) {
  // The same genuine classic-xref three-object PDF structure as the parser suite.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']
  let value = '%PDF-1.7\n'; const offsets = [0]
  for (const [at, object] of objects.entries()) { offsets.push(Buffer.byteLength(value, 'latin1')); value += `${at + 1} 0 obj\n${object}\nendobj\n` }
  const start = Buffer.byteLength(value, 'latin1')
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(value, 'latin1')
}
const rights = { rights_accepted: true, rights_terms_version: '2026-10-27.1' }

test('verified content survives actual reserve/save/reopen/submit/grade and material/presentation replacement workflows', { timeout: 120000 }, async t => {
  const fx = await createTeachingScopedFixture()
  t.after(() => fx.close())
  const { db, ids, groups: [groupA, groupB], dates, rpc, mutate, classroom, asUser, item } = fx
  for (const name of [
    '202610270001_teaching_group_scopes.sql',
    '202610270002_teaching_multi_group_assignments.sql',
    '202610270003_teaching_material_library.sql',
    '202610270004_teaching_material_library_access.sql',
    '202610270010_student_group_presentations.sql',
    '202610300003_upload_content_quarantine.sql',
  ]) await db.exec(await migration(name))

  async function uploadRow(bucket, parent, owner, bytes, extension = 'txt', mime = 'text/plain') {
    const storagePath = `${parent}/${owner}/${randomUUID()}.${extension}`
    await asUser(owner, `insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
      values($1,$2,$3::uuid,$3::text,$4::jsonb)`, [bucket, storagePath, owner, JSON.stringify({ size: bytes.length, mimetype: mime })])
    const descriptor = { storage_path: storagePath, name: `Synthetic.${extension}`, mime_type: mime, size: bytes.length }
    return { bucket, bytes, owner, descriptor, material: { path: storagePath, file_name: descriptor.name, mime_type: mime, file_size: bytes.length } }
  }
  async function attest(upload) {
    const response = await verifyStoredBytes({ db, asUser, actor: upload.owner, bucket: upload.bucket, path: upload.descriptor.storage_path, bytes: upload.bytes })
    assert.equal(response.statusCode, 200, JSON.stringify(response.body))
    assert.equal(response.body.verified, true)
    const candidate = await rpc(upload.owner, 'xelay_upload_scan_candidate', [upload.bucket, upload.descriptor.storage_path])
    assert.equal(candidate.already_verified, true)
    assert.equal(candidate.owner_id, upload.owner)
    assert.equal(candidate.size, upload.bytes.length)
    const receipt = (await db.query('select content_sha256,validation_sha256,verification_kind,validation_version from public.xelay_upload_content_receipts where object_id=$1', [candidate.object_id])).rows[0]
    assert.equal(receipt.content_sha256, sha256(upload.bytes))
    assert.match(receipt.validation_sha256, /^[0-9a-f]{64}$/)
    assert.equal(receipt.verification_kind, 'content_verified')
    assert.equal(receipt.validation_version, 1)
    assert.equal((await rpc(upload.owner, 'xelay_upload_scan_candidate', [upload.bucket, upload.descriptor.storage_path])).already_verified, true)
  }
  async function storageRows(who, upload) {
    return (await asUser(who, 'select name from storage.objects where bucket_id=$1 and name=$2', [upload.bucket, upload.descriptor.storage_path])).rows
  }
  const rejectedByQuarantine = operation => assert.rejects(operation, /UPLOAD_VERIFICATION_REQUIRED/)

  await t.test('student draft is blocked before verification, reopens after save and hands in privately with a published grade', async () => {
    const assignmentId = randomUUID(), submissionId = randomUUID()
    await classroom(ids.owner, 'save_group_assignment', {
      expected_user_id: ids.owner, id: assignmentId, version: 0, course_id: ids.course,
      title: 'Synthetic content-verified assignment', body: 'Explain the calculation in plain text.', links: [], attachments: [],
      targets: [{ group_id: groupA, placement_mode: 'unplaced', lesson_date: dates.lesson_a, due_at: `${dates.lesson_a}T18:00:00Z` }],
      status: 'published', submission_format: 'written', max_points: 10, category: '',
    })
    const read = who => rpc(who, 'xelay_classroom_assignment', [assignmentId, groupA])
    const reserved = await classroom(ids.studentA, 'reserve_submission', { id: submissionId, item_id: assignmentId, group_id: groupA })
    const original = await uploadRow('xelay-submission-files', submissionId, ids.studentA, inertText('first answer'))
    assert.deepEqual(await storageRows(ids.studentA, original), [], 'Even the uploader cannot retrieve unverified bytes')
    assert.deepEqual(await storageRows(ids.owner, original), [])
    const payload = { id: submissionId, item_id: assignmentId, group_id: groupA, version: reserved.version, body: 'Private original answer', links: [], attachments: [original.descriptor] }
    await rejectedByQuarantine(classroom(ids.studentA, 'save_submission', payload))
    const untouched = await read(ids.studentA)
    assert.equal(untouched.my_submission.version, reserved.version)
    assert.deepEqual(untouched.my_submission.attachments, [])
    assert.equal((await read(ids.owner)).submissions.length, 0)

    await attest(original)
    let saved = await classroom(ids.studentA, 'save_submission', payload)
    let reopened = await read(ids.studentA)
    assert.equal(reopened.my_submission.body, payload.body)
    assert.deepEqual(reopened.my_submission.attachments, [original.descriptor])
    assert.equal(reopened.my_submission.version, saved.version)
    assert.equal((await read(ids.owner)).submissions.length, 0, 'A verified attachment does not publish its private draft')
    assert.deepEqual(await storageRows(ids.owner, original), [])

    saved = await classroom(ids.studentA, 'submit_submission', { id: submissionId, version: saved.version })
    const teacherView = await read(ids.owner)
    const handedIn = teacherView.submissions.find(row => row.id === submissionId)
    assert.equal(handedIn.body, payload.body)
    assert.deepEqual(handedIn.attachments, [original.descriptor])
    assert.equal((await storageRows(ids.owner, original)).length, 1)
    assert.deepEqual(await storageRows(ids.headA, original), [])
    assert.deepEqual(await storageRows(ids.studentB, original), [])
    await assert.rejects(read(ids.studentB), /FORBIDDEN|ACCESS/)
    assert.ok(!JSON.stringify(await read(ids.headA)).includes(payload.body))

    let reviewed = await classroom(ids.owner, 'review_submission', { id: submissionId, version: saved.version, status: 'reviewed', feedback: 'Synthetic private grading feedback', score: 8, grade_version: 0 })
    reopened = await read(ids.studentA)
    assert.equal(reopened.my_submission.published_score, 8)
    assert.equal(reopened.my_submission.status, 'reviewed')
    assert.equal(reopened.my_submission.feedback, 'Synthetic private grading feedback')
    assert.ok(reopened.history.some(row => row.attachments?.some(file => file.storage_path === original.descriptor.storage_path)))
    const gradeId = reopened.my_submission.grade_id

    reviewed = await classroom(ids.owner, 'review_submission', { id: submissionId, version: reviewed.version, status: 'returned', feedback: 'Please add a second explanation.' })
    const replacement = await uploadRow('xelay-submission-files', submissionId, ids.studentA, inertText('replacement answer'))
    const edit = { id: submissionId, item_id: assignmentId, group_id: groupA, version: reviewed.version, body: 'Private revised answer', links: [], attachments: [replacement.descriptor] }
    await rejectedByQuarantine(classroom(ids.studentA, 'save_submission', edit))
    assert.deepEqual((await read(ids.owner)).submissions.find(row => row.id === submissionId).attachments, [original.descriptor])
    await attest(replacement)
    saved = await classroom(ids.studentA, 'save_submission', edit)
    assert.equal((await read(ids.studentA)).my_submission.body, edit.body)
    assert.deepEqual((await read(ids.owner)).submissions.find(row => row.id === submissionId).attachments, [original.descriptor], 'Teacher retains the handed-in snapshot until resubmission')
    await classroom(ids.studentA, 'submit_submission', { id: submissionId, version: saved.version })
    const after = await read(ids.studentA)
    assert.deepEqual(after.my_submission.attachments, [replacement.descriptor])
    assert.equal(after.my_submission.attempt, 2)
    assert.equal(after.my_submission.published_score, 8)
    assert.equal(after.my_submission.grade_id, gradeId)
    assert.ok(after.history.some(row => row.attachments?.some(file => file.storage_path === original.descriptor.storage_path)))
    assert.equal((await storageRows(ids.owner, original)).length, 1, 'Staff can still access the genuine handed-in historical file')
    const illegalOverwrite = await asUser(ids.studentA, 'update storage.objects set metadata=$1::jsonb where bucket_id=$2 and name=$3 returning id', [JSON.stringify({ size: 1, mimetype: 'text/plain' }), original.bucket, original.descriptor.storage_path])
    assert.deepEqual(illegalOverwrite.rows, [])
  })

  await t.test('teacher material saves and reopens in both groups; a new verified file replaces it without losing audience or restricted-download rights', async () => {
    const materialId = randomUUID(), original = await uploadRow('xelay-teaching-files', ids.course, ids.owner, inertText('first lecture'))
    const save = payload => mutate(ids.owner, 'save_library_material', { expected_user_id: ids.owner, course_id: ids.course, ...payload })
    const payload = { id: materialId, version: 0, title: 'Synthetic shared lecture', body: 'Shared lecture fixture', links: [], link_labels: {}, attachments: [original.descriptor], target_group_ids: [groupA, groupB], status: 'published', publish_at: null, access_until: null, allow_download: false, ...rights }
    await rejectedByQuarantine(save(payload))
    assert.equal(await item(materialId), undefined)
    await attest(original)
    await save(payload)
    const libraryItem = async () => (await rpc(ids.owner, 'xelay_teaching_material_library')).materials.find(row => row.id === materialId)
    const groupItem = async (who, group) => (await rpc(who, 'xelay_group_teacher_materials', [group])).materials.find(row => row.id === materialId)
    let reopened = await libraryItem()
    assert.deepEqual(reopened.attachments, [original.descriptor])
    assert.deepEqual(new Set(reopened.targets.map(target => target.group_id)), new Set([groupA, groupB]))
    for (const [who, group] of [[ids.studentA, groupA], [ids.studentB, groupB]]) {
      const visible = await groupItem(who, group)
      assert.equal(visible.title, payload.title)
      assert.deepEqual(visible.attachments, [original.descriptor])
      assert.equal((await rpc(who, 'xelay_teaching_material_file_access', [materialId, original.descriptor.storage_path])).download_allowed, false)
    }
    assert.equal((await rpc(ids.owner, 'xelay_teaching_material_file_access', [materialId, original.descriptor.storage_path])).download_allowed, true)

    const replacement = await uploadRow('xelay-teaching-files', ids.course, ids.owner, inertText('revised lecture'))
    const update = { id: materialId, version: reopened.version, title: 'Synthetic revised shared lecture', attachments: [replacement.descriptor], ...rights }
    await rejectedByQuarantine(save(update))
    assert.deepEqual((await libraryItem()).attachments, [original.descriptor])
    await attest(replacement)
    await save(update)
    reopened = await libraryItem()
    assert.equal(reopened.version, 2)
    assert.deepEqual(reopened.attachments, [replacement.descriptor])
    assert.deepEqual(new Set(reopened.targets.map(target => target.group_id)), new Set([groupA, groupB]), 'Partial update preserves every prior group target')
    for (const [who, group] of [[ids.studentA, groupA], [ids.studentB, groupB]]) {
      assert.equal((await groupItem(who, group)).title, update.title)
      assert.deepEqual((await groupItem(who, group)).attachments, [replacement.descriptor])
      assert.equal((await rpc(who, 'xelay_teaching_material_file_access', [materialId, replacement.descriptor.storage_path])).download_allowed, false)
    }
    await assert.rejects(rpc(ids.outsider, 'xelay_teaching_material_file_access', [materialId, replacement.descriptor.storage_path]), /FORBIDDEN/)
  })

  await t.test('accepted student presentation saves, reopens for classmates and updates its own verified file with canonical authorship', async () => {
    const presentationId = randomUUID(), original = await uploadRow('xelay-group-presentations', groupA, ids.studentA, inertPdf('first presentation'), 'pdf', 'application/pdf')
    const draft = { subject: 'Synthetic subject', title: 'Synthetic student presentation', lesson_date: dates.lesson_a, description: 'Inert local presentation', links: [], attachments: [original.material] }
    const save = (version, value) => rpc(ids.studentA, 'xelay_save_group_presentation', [groupA, presentationId, version, value])
    const reopen = async who => (await rpc(who, 'xelay_group_presentations', [groupA])).presentations.find(row => row.id === presentationId)
    await rejectedByQuarantine(save(0, draft))
    assert.equal(await reopen(ids.headA), undefined)
    await attest(original)
    const first = await save(0, draft)
    assert.equal(first.created_by, ids.studentA)
    assert.deepEqual((await reopen(ids.headA)).attachments, [original.material])
    assert.equal((await storageRows(ids.headA, original)).length, 1)
    await assert.rejects(rpc(ids.owner, 'xelay_group_presentations', [groupA]), /GROUP_PRESENTATION_ACCESS/)
    await assert.rejects(rpc(ids.studentB, 'xelay_group_presentations', [groupA]), /GROUP_PRESENTATION_ACCESS/)

    const replacement = await uploadRow('xelay-group-presentations', groupA, ids.studentA, inertPdf('revised presentation'), 'pdf', 'application/pdf')
    const update = { ...draft, title: 'Synthetic revised student presentation', attachments: [replacement.material] }
    await rejectedByQuarantine(save(first.version, update))
    assert.deepEqual((await reopen(ids.headA)).attachments, [original.material])
    await attest(replacement)
    const next = await save(first.version, update)
    const reopened = await reopen(ids.headA)
    assert.equal(reopened.version, 2)
    assert.equal(reopened.created_by, first.created_by)
    assert.equal(reopened.created_at, first.created_at)
    assert.equal(reopened.title, update.title)
    assert.deepEqual(reopened.attachments, [replacement.material])
    assert.equal((await storageRows(ids.headA, replacement)).length, 1)
    assert.deepEqual(await storageRows(ids.headA, original), [], 'A removed attachment is not reopened to classmates by its old verification receipt')
    await assert.rejects(save(first.version, draft), /GROUP_PRESENTATION_CONFLICT/)
  })
})
