// Full migration chain and real PostgreSQL functions, synthetic identities only.
// No Supabase connection, emails, real accounts, or paid API requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const migration = await readFile(new URL('../../supabase/migrations/202610180004_teaching_publication_editing.sql', import.meta.url), 'utf8')
test('publication names, legacy edits, copies, template assignment and unchanged private ACLs', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610180003', beforeMigrationsSql: `
    create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const acl = async () => (await db.query(`select p.oid::regprocedure::text as name,p.proacl::text as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in('xelay_teaching_mutate','xelay_classroom_mutate','xelay_classroom_assignment_mutate','xelay_teaching_course','xelay_teaching_group') order by 1`)).rows
  const originalAcl = await acl()
  await db.exec(migration)
  assert.deepEqual(await acl(), originalAcl)
  await db.exec(migration)
  assert.deepEqual(await acl(), originalAcl, 'Repeated migration must preserve original grants and guards')
  const [teacher, head, head2, outsider, admin, course, assignment, material] = Array.from({ length: 8 }, () => randomUUID())
  const scope = (await db.query('select id,university_id from academic_units where is_active limit 1')).rows[0]
  const specialty = randomUUID()
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'QA','Synthetic programme','Synthetic programme')`, [specialty, scope.university_id, scope.id])
  for (const id of [head, head2, outsider, admin]) await seedUser(id, { username: 'tpl_' + id.replaceAll('-', '').slice(0, 16), university_id: scope.university_id, academic_unit_id: scope.id, specialty_id: specialty, experience: 'bachelor', categories: ['General'] })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [admin])
  await db.query("insert into auth.mfa_factors(user_id,status,factor_type) values($1,'verified','totp')", [admin])
  const metadata = { xelay_registration_version: 1, xelay_privacy_consent: true, xelay_privacy_policy_version: '2026-10-15.1', xelay_privacy_consent_version: '2026-10-15.1', account_type: 'teacher', full_name: 'Synthetic publication teacher', username: 'tpl_' + teacher.replaceAll('-', '').slice(0, 16), country: 'Україна', city: 'Київ', bio: '', experience: '', categories: [], university_id: scope.university_id, academic_unit_id: scope.id, teacher_department: 'Synthetic department', teacher_position: 'Synthetic lecturer' }
  await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3::jsonb)', [teacher, teacher + '@example.test', JSON.stringify(metadata)])
  const request = (await db.query('select id from teacher_verification_requests where user_id=$1', [teacher])).rows[0]
  const rpc = async (who, name, args = [], options) => (await asUser(who, `select ${name}(${args.map((_, index) => '$' + (index + 1)).join(',')}) as value`, args, options)).rows[0].value
  const mutate = (who, action, payload, options) => rpc(who, 'xelay_teaching_mutate', [action, JSON.stringify(payload)], options)
  const classroom = (who, action, payload) => rpc(who, 'xelay_classroom_mutate', [action, JSON.stringify(payload)])
  const item = async id => (await db.query('select to_jsonb(i) as value from teaching_items i where id=$1', [id])).rows[0]?.value
  await mutate(admin, 'review_teacher', { request_id: request.id, status: 'approved' }, { aal: 'aal2' })
  const dates = (await db.query("select (current_date-30)::text as start,(current_date+180)::text as finish,(current_date+365)::text as next_start,(current_date+545)::text as next_finish")).rows[0]
  await mutate(teacher, 'create_course', { id: course, version: 0, title: 'Synthetic publication course', semester: 'Current', starts_on: dates.start, ends_on: dates.finish })
  const groups = []
  for (let index = 0; index < 2; index++) {
    const group = randomUUID(), repRequest = randomUUID()
    const representative = [head, head2][index]
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      values($1,$2,'Synthetic head',$3,$4,'Synthetic programme',$5,'synthetic_head','approved',$6,now())`, [repRequest, representative, scope.university_id, scope.id, 'QA publication ' + index, admin])
    await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
      values($1,$2,$3,$4,$5,'Synthetic programme',$6)`, [group, repRequest, representative, scope.university_id, scope.id, 'QA publication ' + index])
    const invitation = await mutate(teacher, 'invite_group', { course_id: course, group_id: group })
    await mutate(representative, 'respond_group', { link_id: invitation.id, accept: true }); groups.push(group)
  }
  const url = 'https://example.test/lecture', extraUrl = 'https://example.test/seminar'
  const initial = { id: assignment, version: 0, course_id: course, title: 'Synthetic assignment', body: 'Read the source', links: [url, extraUrl], link_labels: { [url]: ' Лекція ', [extraUrl]: 'Семінар' }, attachments: [], targets: [{ group_id: groups[0], due_at: null }], status: 'published', max_points: null, category: '' }

  await t.test('valid names save, Unicode counts as characters, and unknown or malformed names roll back', async () => {
    await classroom(teacher, 'save_group_assignment', initial)
    assert.deepEqual((await item(assignment)).links, initial.links)
    assert.deepEqual((await item(assignment)).link_labels, { [url]: 'Лекція', [extraUrl]: 'Семінар' })
    for (const bad of [{ 'https://example.test/other': 'Foreign URL' }, { [url]: 'x'.repeat(81) }, { [url]: 'line\nbreak' }, { [url]: 'control\u0085' }, { [url]: 42 }, [], null]) {
      await assert.rejects(classroom(teacher, 'save_group_assignment', { ...initial, id: randomUUID(), link_labels: bad }), /TEACHING_INVALID_INPUT/)
    }
    const emoji = { ...initial, id: randomUUID(), link_labels: { [url]: '🦛'.repeat(80) } }
    await classroom(teacher, 'save_group_assignment', emoji)
    assert.equal((await item(emoji.id)).link_labels[url], '🦛'.repeat(80))
    await mutate(teacher, 'save_material', { ...initial, id: material, title: 'Synthetic material', targets: [{ group_id: groups[0] }, { group_id: groups[1] }] })
    assert.equal((await item(material)).link_labels[url], 'Лекція')
  })
  await t.test('legacy payload preserves remaining URL names; explicit empty object clears them', async () => {
    const { link_labels: unused, ...legacy } = initial
    await classroom(teacher, 'save_group_assignment', { ...legacy, version: 1, links: [url] })
    assert.deepEqual((await item(assignment)).link_labels, { [url]: 'Лекція' })
    await classroom(teacher, 'save_group_assignment', { ...legacy, version: 2, links: [url], link_labels: {} })
    assert.deepEqual((await item(assignment)).link_labels, {})
    await classroom(teacher, 'save_group_assignment', { ...initial, version: 3 })
  })
  await t.test('copy_assignment preserves names and creates an independent private draft', async () => {
    const id = randomUUID()
    await classroom(teacher, 'copy_assignment', { id, source_item_id: assignment, source_version: 4, destination_group_id: groups[1] })
    const copied = await item(id)
    assert.deepEqual(copied.link_labels, { [url]: 'Лекція', [extraUrl]: 'Семінар' }); assert.equal(copied.status, 'draft')
    const targets = (await db.query('select group_id from teaching_item_targets where item_id=$1', [id])).rows
    assert.deepEqual(targets, [{ group_id: groups[1] }])
    const visible = await rpc(head2, 'xelay_teaching_group', [groups[1]])
    assert.ok(!visible.assignments.some(row => row.id === id), 'Representative cannot see a teacher draft')
  })
  await t.test('copy_course keeps assignment/material names as unassigned drafts, then permits explicit group assignment', async () => {
    const nextCourse = randomUUID()
    await mutate(teacher, 'copy_course', { id: nextCourse, version: 0, course_id: course, semester: 'Next', starts_on: dates.next_start, ends_on: dates.next_finish })
    const snapshot = await rpc(teacher, 'xelay_teaching_course', [nextCourse])
    assert.ok(snapshot.assignments.length >= 2); assert.equal(snapshot.materials.length, 1)
    for (const draft of [...snapshot.assignments, ...snapshot.materials]) { assert.equal(draft.status, 'draft'); assert.deepEqual(draft.targets, []); assert.ok(draft.link_labels[url]) }
    const draft = snapshot.assignments.find(row => row.title === initial.title)
    const payload = { ...initial, id: draft.id, version: draft.version, course_id: nextCourse, targets: [{ group_id: groups[0], due_at: null }] }
    await assert.rejects(classroom(teacher, 'save_group_assignment', payload), /FORBIDDEN/)
    const invitation = await mutate(teacher, 'invite_group', { course_id: nextCourse, group_id: groups[0] })
    await mutate(head, 'respond_group', { link_id: invitation.id, accept: true })
    await assert.rejects(classroom(outsider, 'save_group_assignment', payload), /FORBIDDEN|VERIFICATION/)
    await classroom(teacher, 'save_group_assignment', payload)
    assert.equal((await item(draft.id)).status, 'published')
    assert.deepEqual((await item(draft.id)).link_labels, { [url]: 'Лекція', [extraUrl]: 'Семінар' })
    assert.ok((await rpc(head, 'xelay_teaching_group', [groups[0]])).assignments.some(row => row.id === draft.id))
    assert.equal((await classroom(teacher, 'save_group_assignment', payload)).id, draft.id, 'Identical retry uses the existing receipt')
    await assert.rejects(classroom(teacher, 'save_group_assignment', { ...payload, title: 'Stale different write' }), /CONFLICT/)
  })
  await t.test('new label normalizer and private assignment dispatcher have no authenticated or anonymous execution', async () => {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      const result = (await db.query(`select has_function_privilege($1,'public.xelay_teaching_normalize_link_labels(jsonb,jsonb,boolean)','execute') as labels,
        has_function_privilege($1,'public.xelay_classroom_assignment_mutate(text,jsonb)','execute') as private`, [role])).rows[0]
      assert.equal(result.labels, false); assert.equal(result.private, false)
    }
    assert.deepEqual(await acl(), originalAcl)
  })
})
