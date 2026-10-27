import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createTeachingScopedFixture } from './teaching-scoped-fixture.mjs'

test('selected-group colleagues retain only explicitly granted academic access and creator rights', async t => {
  const fx = await createTeachingScopedFixture(); t.after(() => fx.close())
  const { db, ids, groups: [a, b], dates, mutate, rpc } = fx
  const right = ['materials','assignments','grades']
  const legacy = await mutate(ids.owner, 'invite_teacher', { course_id: ids.course, user_id: ids.otherTeacher, permissions: right })
  await mutate(ids.otherTeacher, 'respond_teacher', { teacher_link_id: legacy.id, accept: true })
  const baseline = (await db.query('select (select count(*) from teaching_entries)::int entries,(select count(*) from study_group_members)::int members')).rows
  const migration = await readFile(new URL('../../supabase/migrations/202610270001_teaching_group_scopes.sql', import.meta.url), 'utf8')
  await db.exec(migration.replace(/\r?\n/g, '\r\n'))
  const invite = { course_id: ids.course, user_id: ids.colleague, permissions: right, group_scope: 'selected', group_ids: [a] }
  let link
  const activity = {}, entry = {}, assignment = {}, material = {}, file = {}
  for (const [key, group] of [['a', a], ['b', b]]) {
    activity[key] = (await mutate(ids.owner, 'save_activity', { id: randomUUID(), version: 0, course_id: ids.course, group_id: group, title: 'Private activity ' + key, category: '', activity_date: dates.lesson_a, max_points: 10 })).id
    entry[key] = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [ids.course, group, ids[key === 'a' ? 'studentA' : 'studentB']])).rows[0].id
    const grade = await mutate(ids.owner, 'save_grade', { activity_id: activity[key], entry_id: entry[key], version: 0, score: 7, comment: 'PRIVATE_GRADE_' + key, reason: '' })
    await mutate(ids.owner, 'publish_grades', { activity_id: activity[key], expected_versions: [{ entry_id: entry[key], version: grade.version }] })
    const payload = { id: randomUUID(), version: 0, course_id: ids.course, title: 'Private assignment ' + key, body: 'PRIVATE_ASSIGNMENT_' + key, status: 'published', max_points: null, links: [], attachments: [], targets: [{ group_id: group, placement_mode: 'unplaced', lesson_date: dates.lesson_a }] }
    assignment[key] = await mutate(ids.owner, 'save_assignment', payload)
    file[key] = `${ids.course}/${ids.owner}/${randomUUID()}.pdf`
    await db.query("insert into storage.objects(bucket_id,name,owner,metadata) values('xelay-teaching-files',$1,$2,$3::jsonb)", [file[key], ids.owner, JSON.stringify({ size: 10, mimetype: 'application/pdf' })])
    material[key] = await mutate(ids.owner, 'save_material', { id: randomUUID(), version: 0, course_id: ids.course, title: 'Private material ' + key, body: 'PRIVATE_MATERIAL_' + key, links: [], attachments: [{ storage_path: file[key], name: 'Synthetic.pdf', mime_type: 'application/pdf', size: 10 }], targets: [{ group_id: group }], status: 'published', rights_accepted: true, rights_terms_version: '2026-10-23.1', allow_download: true })
  }
  await t.test('CRLF installation changes no academic data and preserves explicit legacy all-group access', async () => {
    assert.equal((await db.query('select group_scope from teaching_course_teachers where id=$1', [legacy.id])).rows[0].group_scope, 'all')
    const snapshot = await rpc(ids.otherTeacher, 'xelay_teaching_course', [ids.course]); assert.equal(snapshot.groups.length, 2)
    const current = (await db.query('select (select count(*) from teaching_entries)::int entries,(select count(*) from study_group_members)::int members')).rows
    assert.deepEqual(current, baseline)
  })
  await t.test('nickname lookup is exact, owner-only, verified and contains no private application contacts', async () => {
    const name = (await db.query('select username from profiles where id=$1', [ids.colleague])).rows[0].username
    const found = await rpc(ids.owner, 'xelay_teaching_find_colleague', [ids.course, '@' + name.toUpperCase()])
    assert.equal(found.user_id, ids.colleague); assert.equal(found.status, 'available')
    assert.deepEqual(Object.keys(found).sort(), ['department','full_name','position','status','user_id','username'])
    assert.equal(await rpc(ids.owner, 'xelay_teaching_find_colleague', [ids.course, name.slice(0,-1)]), null)
    for (const who of [ids.colleague, ids.studentA, ids.outsider, ids.admin]) await assert.rejects(rpc(who, 'xelay_teaching_find_colleague', [ids.course, name]), /FORBIDDEN|EXPIRED|UNVERIFIED/)
  })
  await t.test('invitations require explicit accepted group IDs and grant nothing before acceptance', async () => {
    for (const patch of [{ group_scope: undefined, group_ids: undefined }, { group_scope: 'all', group_ids: [] }, { group_ids: [] }, { group_ids: [a,a] }, { group_ids: [randomUUID()] }]) await assert.rejects(mutate(ids.owner, 'invite_teacher', { ...invite, ...patch }), /SCOPE/)
    link = await mutate(ids.owner, 'invite_teacher', invite)
    await assert.rejects(rpc(ids.colleague, 'xelay_teaching_course', [ids.course]), /FORBIDDEN/)
    await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: link.id, accept: true })
  })
  await t.test('snapshots and export source exclude other groups, students, scores, history and publication targets', async () => {
    const snapshot = await rpc(ids.colleague, 'xelay_teaching_course', [ids.course])
    assert.deepEqual(snapshot.groups.map(row => row.group_id), [a]); assert.deepEqual(snapshot.groups[0].permissions.toSorted(), right.toSorted())
    for (const key of ['entries','activities','grades','members']) assert.ok(snapshot[key].every(row => row.group_id === a))
    assert.ok(snapshot.audit.every(row => row.entry_id === entry.a))
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_GRADE_b|PRIVATE_ASSIGNMENT_b|PRIVATE_MATERIAL_b/)
    assert.ok(snapshot.assignments.every(item => item.targets.every(target => target.group_id === a)))
    assert.deepEqual(snapshot.seminars.questions, []); assert.deepEqual(snapshot.seminars.teams, [])
    const workspace = await rpc(ids.colleague, 'xelay_classroom_workspace', [])
    assert.deepEqual(workspace.classrooms.map(row => row.group_id), [a])
    await assert.rejects(rpc(ids.colleague, 'xelay_teaching_group_context', [b]), /FORBIDDEN/)
  })
  await t.test('direct assignment, file, classroom and journal writes cannot bypass the selected audience', async () => {
    assert.equal((await fx.asUser(ids.colleague, 'select xelay_teaching_can_read_file($1) allowed', [file.a])).rows[0].allowed, true)
    assert.equal((await fx.asUser(ids.colleague, 'select xelay_teaching_can_read_file($1) allowed', [file.b])).rows[0].allowed, false)
    await assert.rejects(rpc(ids.colleague, 'xelay_classroom_assignment', [assignment.b.id, b]), /FORBIDDEN/)
    await assert.rejects(mutate(ids.colleague, 'sync_roster', { course_id: ids.course, group_id: b }), /FORBIDDEN/)
    await assert.rejects(mutate(ids.colleague, 'save_grade', { activity_id: activity.b, entry_id: entry.b, version: 2, score: 1, comment: '', reason: 'No access' }), /FORBIDDEN/)
    await assert.rejects(mutate(ids.colleague, 'save_assignment', { id: randomUUID(), version: 0, course_id: ids.course, title: 'Forbidden', status: 'draft', targets: [{ group_id: b }], links: [], attachments: [], max_points: null }), /FORBIDDEN/)
    await assert.rejects(rpc(ids.colleague, 'xelay_teaching_calendar_assign', [ids.course,b,randomUUID(),'timetable',true]), /FORBIDDEN/)
  })
  await t.test('student requests notify only graders for that group and out-of-scope requests cannot be resolved', async () => {
    const req = await rpc(ids.studentB, 'xelay_teaching_request_grade', [activity.b, 'Synthetic review request', randomUUID()])
    const requests = await rpc(ids.colleague, 'xelay_teaching_grade_requests', [ids.course]); assert.equal(requests.requests.length, 0)
    await assert.rejects(rpc(ids.colleague, 'xelay_teaching_resolve_grade_request', [req.id,req.version,'Forbidden reply']), /FORBIDDEN/)
    const rows = (await db.query("select recipient_id from notifications where teaching_event_key=$1", ['grade-request:' + req.id])).rows
    assert.ok(rows.some(row => row.recipient_id === ids.owner)); assert.equal(rows.some(row => row.recipient_id === ids.colleague), false)
    const contacts = await rpc(ids.studentB, 'xelay_academic_group_teachers', [b]); assert.equal(contacts.teachers.some(row => row.user_id === ids.colleague), false)
  })
  await t.test('revocation rejects historical extension, canonical creation and grade-batch receipts before replay', async () => {
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: link.id, permissions: right, group_scope: 'selected', group_ids: [a,b] })
    const token = randomUUID(), extension = { id: token, request_id: token, item_id: assignment.b.id, group_id: b, user_id: ids.studentB, closes_at: null, version: 0 }
    await fx.classroom(ids.colleague, 'set_submission_extension', extension)
    const created = { id: randomUUID(), course_id: ids.course, version: 0, title: 'Own scoped draft', status: 'draft', targets: [{ group_id: b }], max_points: null, links: [], attachments: [] }
    await mutate(ids.colleague, 'save_assignment', created)
    const version = (await db.query('select version from teaching_grades where activity_id=$1 and entry_id=$2', [activity.b,entry.b])).rows[0].version
    const batch = [randomUUID(),ids.course,b,activity.b,ids.colleague,JSON.stringify([{ entry_id: entry.b, version, score: 6, comment: 'Synthetic correction', reason: 'Synthetic scoped correction' }])]
    await rpc(ids.colleague, 'xelay_save_teaching_grades_batch', batch)
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: link.id, permissions: right, group_scope: 'selected', group_ids: [a] })
    await assert.rejects(fx.classroom(ids.colleague, 'set_submission_extension', extension), /FORBIDDEN/)
    await assert.rejects(mutate(ids.colleague, 'save_assignment', created), /FORBIDDEN/)
    await assert.rejects(rpc(ids.colleague, 'xelay_save_teaching_grades_batch', batch), /FORBIDDEN/)
  })
  await t.test('adding a group never expands selected access and selective revocation preserves other access and all data', async () => {
    const before = (await db.query('select (select count(*) from teaching_grades)::int grades,(select count(*) from teaching_grade_audit)::int audit,(select count(*) from teaching_items)::int items')).rows
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: link.id, permissions: right, group_scope: 'selected', group_ids: [a,b] })
    assert.equal((await rpc(ids.colleague, 'xelay_teaching_course', [ids.course])).groups.length, 2)
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: link.id, permissions: right, group_scope: 'selected', group_ids: [a] })
    assert.deepEqual((await rpc(ids.colleague, 'xelay_teaching_course', [ids.course])).groups.map(row => row.group_id), [a])
    await db.query("update teaching_course_groups set status='removed' where course_id=$1 and group_id=$2", [ids.course,b])
    await db.query("update teaching_course_groups set status='accepted' where course_id=$1 and group_id=$2", [ids.course,b])
    await assert.rejects(rpc(ids.colleague, 'xelay_teaching_group_context', [b]), /FORBIDDEN/)
    assert.deepEqual((await db.query('select (select count(*) from teaching_grades)::int grades,(select count(*) from teaching_grade_audit)::int audit,(select count(*) from teaching_items)::int items')).rows,before)
  })
  await t.test('material permission never transfers creator edit or withdrawal rights; owners retain their own withdrawal', async () => {
    await assert.rejects(mutate(ids.colleague, 'delete_material', { id: material.a.id, version: material.a.version, course_id: ids.course }), /AUTHOR_REQUIRED/)
    const own = await mutate(ids.colleague, 'save_material', { id: randomUUID(), version: 0, course_id: ids.course, title: 'Own material', status: 'published', targets: [{ group_id: a }], links: [], attachments: [], rights_accepted: true, rights_terms_version: '2026-10-23.1' })
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: link.id, permissions: right, status: 'removed' })
    await mutate(ids.colleague, 'delete_material', { id: own.id, version: own.version, course_id: ids.course })
    assert.ok((await fx.item(own.id)).withdrawn_at)
    for (const name of ['xelay_teaching_group_permissions(uuid,uuid,uuid)','xelay_private_teaching_mutation_scope(text,jsonb)']) await assert.rejects(fx.asUser(ids.colleague, `select ${name.split('(')[0]}(${name.startsWith('xelay_teaching_group') ? '$1,$2,$3' : '$1,$2::jsonb'})`, name.startsWith('xelay_teaching_group') ? [ids.course,a,ids.colleague] : ['save_assignment','{}']), error => error.code === '42501')
  })
})
