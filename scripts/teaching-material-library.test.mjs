// Regression checks for the local material-library preview only. No provider,
// working database, audit environment or network listener is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url)), native = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const modules = new Map(), storage = new Map(), events = new EventTarget()
  const clock = { value: Date.parse('2026-10-27T10:00:00Z') }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.value])) }
    static now() { return clock.value }
  }
  Object.assign(events, { setTimeout, clearTimeout, setInterval, clearInterval })
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    vm.runInNewContext(code, {
      module, exports: module.exports, structuredClone, crypto, Date: ClockDate, URL, Blob, File,
      AbortController, DOMException, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval, clearInterval, window: events,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      fetch(url, options) {
        assert.ok(String(url).startsWith('blob:'), 'Only in-memory fixture file bytes may be read')
        return fetch(url, options)
      },
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw new Error('No provider traffic allowed') } }) }
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (name.endsWith('.ts') || name.endsWith('.tsx') ? '' : '.ts')))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  const api = load('src/lib/localTeachingRepository.ts')
  const legal = load('src/lib/legal.ts')
  const owner = api.createLocalTeachingRepository('teacher'), colleague = api.createLocalTeachingRepository('colleague')
  const student = api.createLocalTeachingRepository('student')
  // The canonical fixture already contains this second-group student. The app
  // preview has no role button for them, so only this test adapter selects it.
  const previous = api.LOCAL_TEACHING_IDENTITIES.head
  api.LOCAL_TEACHING_IDENTITIES.head = { userId: '00000000-0000-4000-8000-000000000005', fullName: 'Second synthetic student' }
  const otherStudent = api.createLocalTeachingRepository('head')
  api.LOCAL_TEACHING_IDENTITIES.head = previous
  return { api, load, legal, owner, colleague, student, otherStudent,
    ownerId: api.LOCAL_TEACHING_IDENTITIES.teacher.userId,
    colleagueId: api.LOCAL_TEACHING_IDENTITIES.colleague.userId,
    advance(hours) { clock.value += hours * 3600000 }, now: () => clock.value,
  }
}

async function context(fx) {
  const workspace = await fx.owner.workspace()
  const course = workspace.courses.find(item => !item.archived_at && item.owner_id === fx.ownerId)
  assert.ok(course, 'Owner has a current synthetic subject')
  const snapshot = await fx.owner.course(course.id)
  const groups = snapshot.groups.filter(item => item.status === 'accepted')
  assert.equal(groups.length, 2)
  return { course, groups, snapshot }
}
async function create(fx, options = {}) {
  const { course, groups } = await context(fx)
  const payload = {
    id: crypto.randomUUID(), version: 0, expected_user_id: fx.ownerId, course_id: course.id,
    title: 'Synthetic library material', body: 'One canonical source for both groups.', links: [], attachments: [],
    target_group_ids: groups.map(group => group.group_id), status: 'published', publish_at: null, access_until: null,
    allow_download: true, rights_accepted: true, rights_terms_version: fx.legal.TEACHING_MATERIAL_TERMS_VERSION,
    ...options,
  }
  const saved = await fx.owner.mutate('save_library_material', payload)
  const material = (await fx.owner.materialLibrary()).materials.find(item => item.id === (saved.id || payload.id))
  assert.ok(material, 'The saved canonical material is listed')
  return material
}
async function item(repository, id) {
  return (await repository.materialLibrary()).materials.find(material => material.id === id)
}
async function edit(fx, repository, material, patch, expectedUser = fx.ownerId) {
  const contentChange = Object.keys(patch).some(key => key !== 'target_group_ids')
  return repository.mutate('save_library_material', {
    id: material.id, version: material.version, course_id: material.course_id,
    expected_user_id: expectedUser,
    ...(contentChange ? { rights_accepted: true, rights_terms_version: fx.legal.TEACHING_MATERIAL_TERMS_VERSION } : {}),
    ...patch,
  })
}
async function delegate(fx, material, rights) {
  const result = await fx.owner.mutate('set_material_collaborators', {
    id: material.id, version: material.version, expected_user_id: fx.ownerId,
    grants: rights ? [{ user_id: fx.colleagueId, can_edit: false, can_delete: false, can_manage_groups: false, ...rights }] : [],
  })
  return item(fx.owner, result.id || material.id)
}

test('one canonical update replaces title, body, links and file for every selected group without copying homework', async () => {
  const fx = fixture(), { course, groups } = await context(fx)
  const before = plain((await fx.owner.course(course.id)).assignments)
  const firstFile = await fx.owner.upload(course.id, fx.ownerId, new File(['First synthetic note'], 'lecture-v1.txt', { type: 'text/plain' }))
  const material = await create(fx, { attachments: [firstFile] })
  for (const [repository, group] of [[fx.student, groups[0]], [fx.otherStudent, groups[1]]]) {
    assert.ok((await repository.groupMaterials(group.group_id)).materials.some(item => item.id === material.id))
  }
  const replacement = await fx.owner.upload(course.id, fx.ownerId, new File(['Second synthetic note'], 'lecture-v2.txt', { type: 'text/plain' }))
  await edit(fx, fx.owner, material, { title: 'Updated lecture', body: 'Corrected source', links: ['https://example.test/reference'], attachments: [replacement] })
  const current = await item(fx.owner, material.id)
  assert.equal(current.created_by, fx.ownerId); assert.equal(current.targets.length, 2)
  for (const [repository, group] of [[fx.student, groups[0]], [fx.otherStudent, groups[1]]]) {
    const visible = (await repository.groupMaterials(group.group_id)).materials.filter(item => item.id === material.id)
    assert.equal(visible.length, 1); assert.equal(visible[0].title, 'Updated lecture')
    assert.equal(visible[0].body, 'Corrected source'); assert.equal(visible[0].attachments[0].name, replacement.name)
    assert.deepEqual(plain(visible[0].links), ['https://example.test/reference'])
  }
  assert.equal((await fx.owner.materialLibrary()).materials.filter(item => item.id === material.id).length, 1)
  assert.deepEqual(plain((await fx.owner.course(course.id)).assignments), before)
  await assert.rejects(fx.student.fileUrl(firstFile), /FORBIDDEN/)
  await assert.rejects(fx.student.materialFileInfo(material, firstFile), /CONFLICT|FORBIDDEN/)
  assert.equal((await fx.student.materialFileInfo(current, replacement)).name, replacement.name)
})

test('removing a selected group revokes its legacy list and file preview while the other group retains access', async () => {
  const fx = fixture(), { course, groups } = await context(fx)
  const file = await fx.owner.upload(course.id, fx.ownerId, new File(['Synthetic note'], 'group-note.txt', { type: 'text/plain' }))
  const material = await create(fx, { attachments: [file] })
  await edit(fx, fx.owner, material, { target_group_ids: [groups[1].group_id] })
  const current = await item(fx.owner, material.id)
  assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), false)
  assert.equal((await fx.student.group(groups[0].group_id)).materials.some(item => item.id === material.id), false)
  await assert.rejects(fx.student.fileUrl(file), /FORBIDDEN/)
  await assert.rejects(fx.student.materialFileInfo(current, file), /FORBIDDEN/)
  assert.equal((await fx.otherStudent.materialFileInfo(current, file)).name, file.name)
})

test('a no-group private draft can be updated before publication and does not appear to students', async () => {
  const fx = fixture(), { groups } = await context(fx)
  const material = await create(fx, { target_group_ids: [], status: 'draft' })
  assert.equal(material.targets.length, 0)
  await edit(fx, fx.owner, material, { title: 'Private corrected draft' })
  assert.equal((await item(fx.owner, material.id)).title, 'Private corrected draft')
  assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), false)
})

test('edit, delete and group management grants remain independent, and delegates cannot grant permissions', async () => {
  const fx = fixture(), { groups } = await context(fx)
  let material = await create(fx, { target_group_ids: [groups[0].group_id] })
  material = await delegate(fx, material, { can_edit: true })
  let delegated = await item(fx.colleague, material.id)
  assert.equal(delegated.can_edit, true); assert.equal(delegated.can_delete, false); assert.equal(delegated.can_manage_groups, false)
  assert.equal(delegated.can_manage_collaborators, false)
  await edit(fx, fx.colleague, delegated, { title: 'Corrected by named colleague' }, fx.colleagueId)
  material = await item(fx.owner, material.id)
  assert.equal(material.created_by, fx.ownerId); assert.equal(material.author_name, 'Олена Прикладенко')
  await assert.rejects(edit(fx, fx.colleague, await item(fx.colleague, material.id), { target_group_ids: [] }, fx.colleagueId), /FORBIDDEN/)
  await assert.rejects(fx.colleague.withdrawMaterial(material.id, material.version), /FORBIDDEN|AUTHOR_REQUIRED/)
  await assert.rejects(fx.colleague.mutate('set_material_collaborators', { id: material.id, version: material.version, expected_user_id: fx.colleagueId, grants: [] }), /FORBIDDEN|AUTHOR_REQUIRED/)
  material = await delegate(fx, material, { can_delete: true })
  delegated = await item(fx.colleague, material.id)
  assert.equal(delegated.can_edit, false); assert.equal(delegated.can_delete, true); assert.equal(delegated.can_manage_groups, false)
  await assert.rejects(edit(fx, fx.colleague, delegated, { body: 'Unauthorized edit' }, fx.colleagueId), /FORBIDDEN/)
  await fx.colleague.withdrawMaterial(delegated.id, delegated.version)
  assert.ok((await item(fx.owner, material.id)).withdrawn_at)
  assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), false)
})

test('scoped group manager preserves hidden targets and cannot use a material grant to expand course scope', async () => {
  const fx = fixture(), { groups } = await context(fx)
  let material = await create(fx)
  material = await delegate(fx, material, { can_edit: true, can_delete: true, can_manage_groups: true })
  let delegated = await item(fx.colleague, material.id)
  assert.equal(delegated.can_edit, false); assert.equal(delegated.can_delete, false)
  assert.equal(delegated.can_manage_groups, true); assert.equal(delegated.hidden_target_count, 1)
  assert.deepEqual(plain(delegated.targets).map(target => target.group_id), [groups[0].group_id])
  assert.equal(JSON.stringify(delegated).includes(groups[1].group_id), false)
  await assert.rejects(edit(fx, fx.colleague, delegated, { target_group_ids: [groups[1].group_id] }, fx.colleagueId), /FORBIDDEN/)
  await edit(fx, fx.colleague, delegated, { target_group_ids: [] }, fx.colleagueId)
  material = await item(fx.owner, material.id)
  assert.deepEqual(plain(material.targets).map(target => target.group_id), [groups[1].group_id])
  assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), false)
  assert.equal((await fx.otherStudent.groupMaterials(groups[1].group_id)).materials.some(item => item.id === material.id), true)
  delegated = await item(fx.colleague, material.id)
  assert.ok(delegated, 'Explicit group manager can restore their own group later')
  assert.equal(delegated.targets.length, 0); assert.equal(delegated.hidden_target_count, 1)
  await edit(fx, fx.colleague, delegated, { target_group_ids: [groups[0].group_id] }, fx.colleagueId)
  assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), true)
  assert.equal((await item(fx.owner, material.id)).targets.length, 2)
})

test('a colleague author can explicitly delegate their material to the subject owner without transferring authorship', async () => {
  const fx = fixture(), { course, groups } = await context(fx)
  const saved = await fx.colleague.mutate('save_library_material', {
    id: crypto.randomUUID(), version: 0, expected_user_id: fx.colleagueId, course_id: course.id,
    title: 'Colleague-authored note', body: 'Shared with the subject owner by explicit grant.',
    links: [], attachments: [], target_group_ids: [groups[0].group_id], status: 'draft', allow_download: true,
  })
  let authored = await item(fx.colleague, saved.id)
  assert.equal(authored.created_by, fx.colleagueId)
  const ownCourse = (await fx.colleague.materialLibrary()).courses.find(item => item.course.id === course.id)
  assert.ok(ownCourse.colleagues.some(person => person.user_id === fx.ownerId), 'Subject owner appears as an eligible explicit collaborator')
  assert.equal(await item(fx.owner, authored.id), undefined, 'Subject ownership alone does not take over a colleague material')
  await fx.colleague.mutate('set_material_collaborators', {
    id: authored.id, version: authored.version, expected_user_id: fx.colleagueId,
    grants: [{ user_id: fx.ownerId, can_edit: true, can_delete: false, can_manage_groups: false }],
  })
  const delegated = await item(fx.owner, authored.id)
  assert.ok(delegated); assert.equal(delegated.can_edit, true); assert.equal(delegated.can_manage_collaborators, false)
  await edit(fx, fx.owner, delegated, { title: 'Owner edited by granted permission' })
  authored = await item(fx.colleague, authored.id)
  assert.equal(authored.created_by, fx.colleagueId); assert.equal(authored.title, 'Owner edited by granted permission')
})

test('revoking a material grant removes delegated control without changing owner access or existing student publication', async () => {
  const fx = fixture(), { groups } = await context(fx)
  let material = await create(fx, { target_group_ids: [groups[0].group_id] })
  material = await delegate(fx, material, { can_edit: true, can_manage_groups: true })
  assert.equal((await item(fx.colleague, material.id)).can_edit, true)
  material = await delegate(fx, material, null)
  assert.equal(await item(fx.colleague, material.id), undefined)
  await assert.rejects(edit(fx, fx.colleague, material, { title: 'Stale revoked editor' }, fx.colleagueId), /FORBIDDEN/)
  assert.equal((await item(fx.owner, material.id)).can_edit, true)
  assert.ok((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id))
})

test('removing underlying subject permission invalidates an otherwise retained material grant and file access', async () => {
  const fx = fixture(), { course, groups, snapshot } = await context(fx)
  const file = await fx.owner.upload(course.id, fx.ownerId, new File(['Scoped note'], 'scoped.txt', { type: 'text/plain' }))
  let material = await create(fx, { target_group_ids: [groups[0].group_id], attachments: [file] })
  material = await delegate(fx, material, { can_edit: true, can_manage_groups: true })
  assert.equal((await item(fx.colleague, material.id)).can_edit, true)
  const link = snapshot.teachers.find(person => person.user_id === fx.colleagueId)
  assert.ok(link)
  await fx.owner.mutate('update_teacher', { course_id: course.id, teacher_link_id: link.id, permissions: ['assignments', 'grades'], group_scope: 'selected', group_ids: [groups[0].group_id] })
  assert.equal(await item(fx.colleague, material.id), undefined)
  await assert.rejects(edit(fx, fx.colleague, material, { title: 'Using an obsolete material grant' }, fx.colleagueId), /FORBIDDEN/)
  await assert.rejects(fx.colleague.fileUrl(file), /FORBIDDEN/)
  await assert.rejects(fx.colleague.materialFileInfo(material, file), /FORBIDDEN/)
  assert.equal((await item(fx.owner, material.id)).can_edit, true)
})

test('scheduled delegated publication waits for fresh material and group rights at its publication time', async () => {
  for (const revoke of ['material', 'group']) {
    const fx = fixture(), { course, groups, snapshot } = await context(fx)
    let material = await create(fx, { target_group_ids: [groups[0].group_id], status: 'draft' })
    material = await delegate(fx, material, { can_edit: true })
    // Scheduling an author's never-published draft needs the author's own
    // initial rights acceptance first; a colleague cannot create that receipt.
    await edit(fx, fx.owner, material, { status: 'published' })
    const delegated = await item(fx.colleague, material.id)
    await edit(fx, fx.colleague, delegated, { status: 'scheduled', publish_at: new Date(fx.now() + 3600000).toISOString() }, fx.colleagueId)
    material = await item(fx.owner, material.id)
    if (revoke === 'material') await delegate(fx, material, null)
    else {
      const link = snapshot.teachers.find(person => person.user_id === fx.colleagueId)
      await fx.owner.mutate('update_teacher', { course_id: course.id, teacher_link_id: link.id, group_scope: 'selected', group_ids: [groups[1].group_id] })
    }
    fx.advance(2)
    assert.equal((await item(fx.owner, material.id)).status, 'scheduled', `A stale ${revoke} authorization cannot publish`)
    assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), false)
  }
})

test('a delegate may edit an unaccepted author draft but cannot first publish or schedule it, and never rewrites author acceptance', async () => {
  const fx = fixture(), { groups } = await context(fx)
  let material = await create(fx, { target_group_ids: [groups[0].group_id], status: 'draft' })
  assert.equal(material.rights_accepted_at, undefined)
  material = await delegate(fx, material, { can_edit: true })
  let delegated = await item(fx.colleague, material.id)
  await edit(fx, fx.colleague, delegated, { body: 'Colleague corrected the private draft' }, fx.colleagueId)
  material = await item(fx.owner, material.id)
  assert.equal(material.status, 'draft'); assert.equal(material.rights_accepted_at, undefined)
  delegated = await item(fx.colleague, material.id)
  await assert.rejects(edit(fx, fx.colleague, delegated, { status: 'published' }, fx.colleagueId), /TEACHING_MATERIAL_AUTHOR_ACCEPTANCE_REQUIRED/)
  await assert.rejects(edit(fx, fx.colleague, delegated, { status: 'scheduled', publish_at: new Date(fx.now() + 3600000).toISOString() }, fx.colleagueId), /TEACHING_MATERIAL_AUTHOR_ACCEPTANCE_REQUIRED/)
  assert.equal((await item(fx.owner, material.id)).version, material.version)
  assert.equal((await fx.student.groupMaterials(groups[0].group_id)).materials.some(item => item.id === material.id), false)
  await edit(fx, fx.owner, material, { status: 'published' })
  material = await item(fx.owner, material.id)
  assert.ok(material.rights_accepted_at)
  assert.equal(material.rights_terms_version, fx.legal.TEACHING_MATERIAL_TERMS_VERSION)
  const acceptance = { at: material.rights_accepted_at, version: material.rights_terms_version }
  fx.advance(0.1)
  delegated = await item(fx.colleague, material.id)
  await edit(fx, fx.colleague, delegated, { title: 'Delegated update after author publication' }, fx.colleagueId)
  const updated = await item(fx.owner, material.id)
  assert.equal(updated.created_by, fx.ownerId)
  assert.equal(updated.rights_accepted_at, acceptance.at)
  assert.equal(updated.rights_terms_version, acceptance.version)
  assert.notEqual(updated.updated_at, acceptance.at)
})

test('expiry and withdrawal close old and new student views and fresh file authorization', async () => {
  const fx = fixture(), { course, groups } = await context(fx)
  const file = await fx.owner.upload(course.id, fx.ownerId, new File(['Synthetic expiring note'], 'expiring.txt', { type: 'text/plain' }))
  let material = await create(fx, { attachments: [file], access_until: new Date(fx.now() + 3600000).toISOString() })
  assert.equal((await fx.student.materialFileInfo(material, file)).name, file.name)
  fx.advance(2)
  for (const method of ['group', 'groupMaterials']) assert.equal((await fx.student[method](groups[0].group_id)).materials.some(item => item.id === material.id), false)
  await assert.rejects(fx.student.fileUrl(file), /FORBIDDEN/)
  await assert.rejects(fx.student.materialFileInfo(material, file), /FORBIDDEN/)
  assert.ok(await item(fx.owner, material.id), 'Owner retains the expired library entry')
  material = await create(fx, { attachments: [await fx.owner.upload(course.id, fx.ownerId, new File(['Withdrawn note'], 'withdrawn.txt', { type: 'text/plain' }))] })
  await fx.owner.withdrawMaterial(material.id, material.version)
  const withdrawn = await item(fx.owner, material.id)
  assert.ok(withdrawn.withdrawn_at)
  await assert.rejects(fx.student.fileUrl(material.attachments[0]), /FORBIDDEN/)
  await assert.rejects(fx.student.materialFileInfo(withdrawn, material.attachments[0]), /FORBIDDEN/)
})

test('optimistic version and actor checks reject stale or mismatched updates without overwriting the saved revision', async () => {
  const fx = fixture()
  const material = await create(fx)
  await edit(fx, fx.owner, material, { title: 'Saved revision' })
  await assert.rejects(edit(fx, fx.owner, material, { title: 'Stale overwritten revision' }), /CONFLICT/)
  const current = await item(fx.owner, material.id)
  await assert.rejects(edit(fx, fx.owner, current, { title: 'Wrong identity revision' }, fx.colleagueId), /ACTOR_CHANGED|FORBIDDEN/)
  assert.equal((await item(fx.owner, material.id)).title, 'Saved revision')
})

test('editor and local persistence use the existing subject-material text limits without truncating a valid source', async () => {
  const fx = fixture(), limits = fx.load('src/lib/teachingMaterialLibrary.ts')
  assert.equal(limits.TEACHING_MATERIAL_TITLE_LIMIT, 240)
  assert.equal(limits.TEACHING_MATERIAL_BODY_LIMIT, 50000)
  const material = await create(fx, { title: 'T'.repeat(240), body: 'B'.repeat(50000), status: 'draft' })
  assert.equal(material.title.length, 240); assert.equal(material.body.length, 50000)
  await assert.rejects(edit(fx, fx.owner, material, { title: 'T'.repeat(241) }), /INVALID_INPUT/)
  await assert.rejects(edit(fx, fx.owner, material, { body: 'B'.repeat(50001) }), /INVALID_INPUT/)
  const current = await item(fx.owner, material.id)
  assert.equal(current.version, material.version); assert.equal(current.body.length, 50000)
})
