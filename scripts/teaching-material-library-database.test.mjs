// Real PostgreSQL/RLS integration for the material library; fictional identities only.
// This in-memory fixture never connects to Supabase, paid APIs, WSL or Darkmoon.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './security/teaching-scoped-fixture.mjs'

const readMigration = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')
const TERMS = '2026-10-27.1'
const denied = /FORBIDDEN|AUTHOR_REQUIRED|ACTOR_CHANGED|ACCESS_EXPIRED|UNVERIFIED|permission denied/i

test('canonical teacher material library: real SQL grants, updates, audiences and file access', async t => {
  const fx = await createTeachingScopedFixture()
  t.after(() => fx.close())
  const { db, ids, groups, rpc, mutate, item, asUser } = fx
  const [groupA, groupB] = groups
  const oldAcl = (await db.query(`select p.oid::regprocedure::text signature,p.proacl::text acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in('xelay_teaching_mutate','xelay_classroom_mutate','xelay_teaching_course','xelay_teaching_group') order by 1`)).rows
  for (const name of ['202610270001_teaching_group_scopes.sql', '202610270002_teaching_multi_group_assignments.sql']) {
    await db.exec((await readMigration(name)).replace(/\r?\n/g, '\r\n'))
  }
  const catalog = async () => (await db.query(`select p.oid::regprocedure::text signature,
    md5(replace(p.prosrc,chr(13),'')) body_md5,
    md5(replace(pg_get_functiondef(p.oid),chr(13),'')) definition_md5,
    p.proacl::text acl,p.prosecdef security_definer,p.provolatile::text volatility,l.lanname language,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' and p.prokind='f' and (p.proname like '%teaching%' or p.proname like '%material%')
    order by 1`)).rows
  const beforeCatalog = await catalog()
  const migrationHashes = []
  for (const name of ['202610270003_teaching_material_library.sql', '202610270004_teaching_material_library_access.sql']) {
    const source = await readMigration(name)
    migrationHashes.push({ file: name, sha256: createHash('sha256').update(source).digest('hex') })
    await db.exec(source.replace(/\r?\n/g, '\r\n'))
  }
  const afterCatalog = await catalog()
  const changed = afterCatalog.filter(row => !beforeCatalog.some(old => old.signature === row.signature && old.body_md5 === row.body_md5 && old.acl === row.acl))
  const artifactDirectory = new URL('../artifacts/material-library-20261027/', import.meta.url)
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(new URL('db-expected-catalog.json', artifactDirectory), JSON.stringify({
    fictionalFixtureOnly: true, productionTouched: false, migrations: migrationHashes,
    before: beforeCatalog.filter(row => changed.some(item => item.signature === row.signature)), after: changed,
  }, null, 2))
  const library = who => rpc(who, 'xelay_teaching_material_library')
  const inLibrary = async (who, id) => (await library(who)).materials.find(candidate => candidate.id === id)
  const save = (who, payload) => mutate(who, 'save_library_material', { expected_user_id: who, course_id: ids.course, ...payload })
  const update = async (who, id, patch) => save(who, { id, version: (await item(id)).version, ...patch })
  const rights = { rights_accepted: true, rights_terms_version: TERMS }
  const publish = patch => ({ id: randomUUID(), version: 0, title: 'Synthetic lecture', body: 'Fictional material content',
    links: [], link_labels: {}, attachments: [], target_group_ids: groups, status: 'published', publish_at: null,
    access_until: null, allow_download: true, ...rights, ...patch })
  const delegate = async (id, flags, who = ids.owner, recipient = ids.colleague) => mutate(who, 'set_material_collaborators', {
    id, version: (await item(id)).version, expected_user_id: who,
    grants: flags ? [{ user_id: recipient, can_edit: false, can_delete: false, can_manage_groups: false, ...flags }] : [],
  })
  const storedFile = async (owner, name = 'lecture.txt', size = 128) => {
    const file = { storage_path: `${ids.course}/${owner}/${randomUUID()}.txt`, name, mime_type: 'text/plain', size }
    await db.query(`insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
      values('xelay-teaching-files',$1,$2::uuid,$2::uuid::text,$3::jsonb)`, [file.storage_path, owner, JSON.stringify({ size, mimetype: file.mime_type })])
    return file
  }
  const info = (who, id, file) => rpc(who, 'xelay_teaching_material_file_access', [id, file.storage_path])
  const groupMaterials = async (who, group) => (await rpc(who, 'xelay_group_teacher_materials', [group])).materials
  const legacyMaterials = async (who, group) => (await rpc(who, 'xelay_teaching_group', [group])).materials
  const storageRead = async (who, file) => (await asUser(who,
    "select name from storage.objects where bucket_id='xelay-teaching-files' and name=$1", [file.storage_path])).rows
  let primary, ownerFile, colleagueLink

  await t.test('migration preserves existing entrypoint ACLs and adds only the intended authenticated library RPC', async () => {
    const acl = (await db.query(`select p.oid::regprocedure::text signature,p.proacl::text acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
        and p.proname in('xelay_teaching_mutate','xelay_classroom_mutate','xelay_teaching_course','xelay_teaching_group') order by 1`)).rows
    assert.deepEqual(acl, oldAcl)
    for (const table of ['teaching_material_grants', 'teaching_material_change_receipts']) {
      const relation = (await db.query('select relrowsecurity from pg_class where oid=$1::regclass', ['public.' + table])).rows[0]
      assert.equal(relation.relrowsecurity, true)
      for (const who of [ids.studentA, ids.outsider]) await assert.rejects(asUser(who, 'select * from ' + table), error => error.code === '42501')
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const grants = (await db.query(`select
        has_table_privilege($1,'public.teaching_material_grants','select') as direct_select,
        has_table_privilege($1,'public.teaching_material_grants','insert') as direct_insert,
        has_table_privilege($1,'public.teaching_material_grants','update') as direct_update,
        has_table_privilege($1,'public.teaching_material_grants','delete') as direct_delete,
        has_function_privilege($1,'public.xelay_teaching_material_permissions(uuid,uuid)','execute') as private_helper,
        has_function_privilege($1,'public.xelay_teaching_material_library()','execute') as library`, [role])).rows[0]
      assert.deepEqual(grants, { direct_select: false, direct_insert: false, direct_update: false, direct_delete: false, private_helper: false, library: role === 'authenticated' })
    }
    for (const fn of afterCatalog.filter(row => !beforeCatalog.some(old => old.signature === row.signature))) {
      assert.equal(fn.anon_execute, false, fn.signature)
      assert.equal(fn.public_execute, false, fn.signature)
      assert.equal(fn.service_execute, false, fn.signature)
      assert.equal(fn.authenticated_execute, fn.signature === 'xelay_teaching_material_library()', fn.signature)
    }
  })

  await t.test('anonymous and unrelated users cannot write or disclose another teacher library', async () => {
    await assert.rejects(rpc(null, 'xelay_teaching_material_library', [], { role: 'anon' }), error => error.code === '42501')
    await assert.rejects(save(ids.owner, { ...publish(), expected_user_id: ids.colleague }), /ACTOR_CHANGED/)
    for (const who of [ids.studentA, ids.outsider, ids.otherTeacher]) {
      await assert.rejects(save(who, publish()), denied)
      try { assert.deepEqual((await library(who)).materials, []) } catch (error) { assert.match(error.message, denied) }
    }
  })

  await t.test('a zero-group draft remains private and can be edited before group publication', async () => {
    const payload = publish({ title: 'Private synthetic draft', status: 'draft', target_group_ids: [], rights_accepted: false })
    await save(ids.owner, payload)
    const draft = await inLibrary(ids.owner, payload.id)
    assert.equal(draft.status, 'draft'); assert.deepEqual(draft.targets, [])
    assert.equal(draft.can_edit, true); assert.equal(draft.is_owner, true)
    await update(ids.owner, payload.id, { title: 'Private synthetic draft updated' })
    for (const [student, group] of [[ids.studentA, groupA], [ids.studentB, groupB]]) {
      assert.ok(!(await groupMaterials(student, group)).some(row => row.id === payload.id))
      assert.ok(!(await legacyMaterials(student, group)).some(row => row.id === payload.id))
    }
  })

  await t.test('one protected canonical material appears under the subject in both group projections', async () => {
    ownerFile = await storedFile(ids.owner, 'Original fictional lecture.txt')
    primary = publish({ attachments: [ownerFile], allow_download: false })
    const result = await save(ids.owner, primary)
    assert.equal(result.id, primary.id); assert.equal(result.version, 1)
    const author = await inLibrary(ids.owner, primary.id)
    assert.equal(author.is_owner, true); assert.equal(author.can_edit, true); assert.equal(author.can_delete, true)
    assert.equal(author.can_manage_groups, true); assert.equal(author.can_manage_collaborators, true)
    assert.deepEqual(new Set(author.targets.map(target => target.group_id)), new Set(groups))
    for (const [student, group] of [[ids.studentA, groupA], [ids.studentB, groupB]]) {
      const projected = (await groupMaterials(student, group)).find(row => row.id === primary.id)
      assert.equal(projected.source, 'teacher'); assert.equal(projected.author_name, 'Synthetic owner')
      assert.ok(projected.subject_name); assert.deepEqual(projected.targets.map(target => target.group_id), [group])
      assert.ok((await legacyMaterials(student, group)).some(row => row.id === primary.id))
      const access = await info(student, primary.id, ownerFile)
      assert.equal(access.download_allowed, false); assert.equal(access.version, 1)
      assert.deepEqual(await storageRead(student, ownerFile), [], 'A restricted student view does not expose original Storage bytes')
    }
    await assert.rejects(info(ids.outsider, primary.id, ownerFile), denied)
  })

  await t.test('canonical content and file replacement updates every selected group without creating assignments', async () => {
    const before = (await db.query("select count(*)::int n from teaching_items where kind='assignment'")).rows[0].n
    const replacement = await storedFile(ids.owner, 'Updated fictional lecture.txt', 192)
    await update(ids.owner, primary.id, { title: 'Synthetic lecture updated once', body: 'Updated for both groups', attachments: [replacement], ...rights })
    for (const [student, group] of [[ids.studentA, groupA], [ids.studentB, groupB]]) {
      const projected = (await groupMaterials(student, group)).find(row => row.id === primary.id)
      assert.equal(projected.title, 'Synthetic lecture updated once'); assert.equal(projected.body, 'Updated for both groups')
      assert.deepEqual(projected.attachments, [replacement])
      assert.equal((await info(student, primary.id, replacement)).name, replacement.name)
      await assert.rejects(info(student, primary.id, ownerFile), /FORBIDDEN/)
    }
    assert.equal((await db.query("select count(*)::int n from teaching_items where kind='assignment'")).rows[0].n, before)
    assert.equal((await db.query('select count(*)::int n from teaching_items where id=$1', [primary.id])).rows[0].n, 1)
    ownerFile = replacement
  })

  await t.test('group removal revokes fresh views and media access only for the removed group', async () => {
    await update(ids.owner, primary.id, { target_group_ids: [groupB] })
    assert.ok(!(await groupMaterials(ids.studentA, groupA)).some(row => row.id === primary.id))
    assert.ok(!(await legacyMaterials(ids.studentA, groupA)).some(row => row.id === primary.id))
    await assert.rejects(info(ids.studentA, primary.id, ownerFile), denied)
    assert.ok((await groupMaterials(ids.studentB, groupB)).some(row => row.id === primary.id))
    assert.equal((await info(ids.studentB, primary.id, ownerFile)).item_id, primary.id)
    await update(ids.owner, primary.id, { target_group_ids: groups })
  })

  await t.test('selected-group colleague receives opaque scoped rights and cannot edit/delete an audience outside that scope', async () => {
    const invite = await mutate(ids.owner, 'invite_teacher', { id: randomUUID(), course_id: ids.course,
      user_id: ids.colleague, permissions: ['materials'], group_scope: 'selected', group_ids: [groupA] })
    colleagueLink = invite.id
    await mutate(ids.colleague, 'respond_teacher', { teacher_link_id: colleagueLink, accept: true })
    await delegate(primary.id, { can_edit: true, can_delete: true, can_manage_groups: true })
    const scoped = await inLibrary(ids.colleague, primary.id)
    assert.equal(scoped.is_owner, false); assert.equal(scoped.can_edit, false); assert.equal(scoped.can_delete, false)
    assert.equal(scoped.can_manage_groups, true); assert.equal(scoped.can_manage_collaborators, false)
    assert.equal(scoped.hidden_target_count, 1)
    assert.deepEqual(scoped.targets.map(target => target.group_id), [groupA])
    assert.ok(!JSON.stringify(scoped).includes(groupB), 'No hidden group UUID leaks through nested metadata')
    await assert.rejects(update(ids.colleague, primary.id, { title: 'Forbidden outside-scope change', ...rights }), denied)
    await assert.rejects(mutate(ids.colleague, 'withdraw_material', { id: primary.id, version: (await item(primary.id)).version }), denied)
    await assert.rejects(update(ids.colleague, primary.id, { target_group_ids: [groupB] }), denied)
    await assert.rejects(delegate(primary.id, { can_edit: true }, ids.colleague, ids.otherTeacher), denied)
  })

  await t.test('a scoped group manager preserves hidden targets and can remove then restore the last visible group', async () => {
    await update(ids.colleague, primary.id, { target_group_ids: [] })
    const remaining = await inLibrary(ids.colleague, primary.id)
    assert.ok(remaining, 'An explicit group-management grant must remain reachable after the last visible target is removed')
    assert.deepEqual(remaining.targets, []); assert.equal(remaining.hidden_target_count, 1)
    assert.deepEqual((await db.query('select group_id from teaching_item_targets where item_id=$1', [primary.id])).rows, [{ group_id: groupB }])
    await update(ids.colleague, primary.id, { target_group_ids: [groupA] })
    assert.equal((await db.query('select count(*)::int n from teaching_item_targets where item_id=$1', [primary.id])).rows[0].n, 2)
    assert.ok((await groupMaterials(ids.studentA, groupA)).some(row => row.id === primary.id))
  })

  await t.test('editing, deletion and group selection are independently delegated and authorship never changes', async () => {
    const single = publish({ title: 'Delegated single-group material', target_group_ids: [groupA], allow_download: false })
    const original = await storedFile(ids.owner, 'Original delegated material.txt')
    single.attachments = [original]
    await save(ids.owner, single)
    await delegate(single.id, { can_edit: true })
    const replacement = await storedFile(ids.colleague, 'Colleague replacement.txt', 144)
    await update(ids.colleague, single.id, { body: 'Changed by explicitly authorized colleague', attachments: [replacement], ...rights })
    const canonical = await item(single.id)
    assert.equal(canonical.created_by, ids.owner)
    assert.equal((await info(ids.studentA, single.id, replacement)).author_name, 'Synthetic owner')
    assert.deepEqual((await groupMaterials(ids.studentA, groupA)).find(row => row.id === single.id).attachments, [replacement])
    await assert.rejects(info(ids.studentA, single.id, original), /FORBIDDEN/)
    await assert.rejects(update(ids.colleague, single.id, { target_group_ids: [groupA] }), denied)
    await assert.rejects(mutate(ids.colleague, 'withdraw_material', { id: single.id, version: canonical.version }), denied)
    await delegate(single.id, { can_manage_groups: true })
    await assert.rejects(update(ids.colleague, single.id, { body: 'No edit grant', ...rights }), denied)
    await update(ids.colleague, single.id, { target_group_ids: [groupA] })
    await delegate(single.id, { can_delete: true })
    await mutate(ids.colleague, 'withdraw_material', { id: single.id, version: (await item(single.id)).version })
    assert.ok((await item(single.id)).withdrawn_at)
    await assert.rejects(info(ids.studentA, single.id, replacement), denied)
  })

  await t.test('a colleague author may explicitly delegate their own material to the subject owner, without transferring authorship', async () => {
    const draft = publish({ title: 'Colleague-authored private draft', status: 'draft', target_group_ids: [], rights_accepted: false })
    await save(ids.colleague, draft)
    assert.equal(await inLibrary(ids.owner, draft.id), undefined)
    const ownerCourse = await rpc(ids.owner, 'xelay_teaching_course', [ids.course])
    assert.ok(!ownerCourse.materials.some(row => row.id === draft.id), 'Course ownership does not expose an unshared author draft')
    await assert.rejects(update(ids.owner, draft.id, { title: 'No material grant' }), denied)
    await delegate(draft.id, { can_edit: true }, ids.colleague, ids.owner)
    await update(ids.owner, draft.id, { title: 'Authorized subject-owner edit' })
    assert.equal((await item(draft.id)).created_by, ids.colleague)
    assert.equal((await inLibrary(ids.owner, draft.id)).can_manage_collaborators, false)
  })

  await t.test('grant revocation and underlying subject-scope removal immediately invalidate colleague control', async () => {
    await delegate(primary.id, null)
    assert.equal(await inLibrary(ids.colleague, primary.id), undefined)
    await assert.rejects(update(ids.colleague, primary.id, { target_group_ids: [groupA] }), denied)
    await delegate(primary.id, { can_manage_groups: true })
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: colleagueLink, permissions: ['assignments'], group_scope: 'selected', group_ids: [groupA] })
    assert.equal(await inLibrary(ids.colleague, primary.id), undefined)
    await assert.rejects(update(ids.colleague, primary.id, { target_group_ids: [groupA] }), denied)
    await mutate(ids.owner, 'update_teacher', { teacher_link_id: colleagueLink, permissions: ['materials'], group_scope: 'selected', group_ids: [groupA] })
  })

  await t.test('optimistic version, actor and attachment ownership checks reject stale or forged updates atomically', async () => {
    const stale = await item(primary.id)
    await update(ids.owner, primary.id, { title: 'Current saved revision', ...rights })
    await assert.rejects(save(ids.owner, { id: primary.id, version: stale.version, title: 'Stale overwrite', ...rights }), /CONFLICT/)
    await assert.rejects(save(ids.owner, { id: primary.id, version: (await item(primary.id)).version, expected_user_id: ids.colleague, title: 'Changed actor', ...rights }), /ACTOR_CHANGED/)
    const foreign = await storedFile(ids.otherTeacher, 'Foreign unshared file.txt')
    await assert.rejects(update(ids.owner, primary.id, { attachments: [foreign], ...rights }), /FILE_FORBIDDEN/)
    assert.equal((await item(primary.id)).title, 'Current saved revision')
    assert.deepEqual((await item(primary.id)).attachments, [ownerFile])
  })

  await t.test('access expiry and withdrawal close fresh media access and both student material views', async () => {
    // Advance only this fictional material's expiry to represent elapsed time.
    await db.query("update teaching_items set access_until=clock_timestamp()-interval '1 second' where id=$1", [primary.id])
    for (const [student, group] of [[ids.studentA, groupA], [ids.studentB, groupB]]) {
      assert.ok(!(await groupMaterials(student, group)).some(row => row.id === primary.id))
      assert.ok(!(await legacyMaterials(student, group)).some(row => row.id === primary.id))
      await assert.rejects(info(student, primary.id, ownerFile), denied)
    }
    assert.ok(await inLibrary(ids.owner, primary.id), 'Author retains expired material history in their private library')
    await update(ids.owner, primary.id, { access_until: null, ...rights })
    assert.ok((await groupMaterials(ids.studentA, groupA)).some(row => row.id === primary.id))
    await mutate(ids.owner, 'withdraw_material', { id: primary.id, version: (await item(primary.id)).version })
    assert.ok((await item(primary.id)).withdrawn_at)
    await assert.rejects(info(ids.studentA, primary.id, ownerFile), denied)
    assert.ok(!(await legacyMaterials(ids.studentA, groupA)).some(row => row.id === primary.id))
  })

  await t.test('scheduled publication rechecks material delegation and sends no early or unauthorized notification', async () => {
    await db.exec("create or replace function public.xelay_private_teaching_scheduler_ready() returns boolean language sql stable security definer set search_path='' as $$select true$$")
    const unaccepted = publish({ title: 'Author has not accepted rights yet', target_group_ids: [groupA], status: 'draft', rights_accepted: false })
    await save(ids.owner, unaccepted)
    await delegate(unaccepted.id, { can_edit: true })
    await assert.rejects(update(ids.colleague, unaccepted.id, { status: 'scheduled', publish_at: new Date(Date.now() + 3600_000).toISOString(), ...rights }), /AUTHOR_ACCEPTANCE_REQUIRED/)
    const scheduled = publish({ title: 'Scheduled delegated lecture', target_group_ids: [groupA] })
    await save(ids.owner, scheduled)
    await delegate(scheduled.id, { can_edit: true })
    const beforeNotifications = Number((await db.query('select count(*) n from notifications')).rows[0].n)
    await update(ids.colleague, scheduled.id, { status: 'scheduled', publish_at: new Date(Date.now() + 3600_000).toISOString(), ...rights })
    assert.equal((await item(scheduled.id)).scheduled_by, ids.colleague)
    assert.equal(Number((await db.query('select count(*) n from notifications')).rows[0].n), beforeNotifications)
    assert.ok(!(await groupMaterials(ids.studentA, groupA)).some(row => row.id === scheduled.id))
    await delegate(scheduled.id, null)
    await db.query("update teaching_items set publish_at=clock_timestamp()-interval '1 second' where id=$1", [scheduled.id])
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n, 0)
    assert.equal((await item(scheduled.id)).status, 'scheduled')
    assert.equal(Number((await db.query('select count(*) n from notifications')).rows[0].n), beforeNotifications)
    await delegate(scheduled.id, { can_edit: true })
    await db.query("update teaching_scheduled_publication_checks set next_attempt_at=clock_timestamp()-interval '1 second' where item_id=$1", [scheduled.id])
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n, 1)
    assert.equal((await item(scheduled.id)).status, 'published')
    assert.ok((await groupMaterials(ids.studentA, groupA)).some(row => row.id === scheduled.id))
  })
})
