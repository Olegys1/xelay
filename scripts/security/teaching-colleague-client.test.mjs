import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

const root = fileURLToPath(new URL('../../', import.meta.url)), native = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const modules = new Map(), storage = new Map(), events = new EventTarget()
  Object.assign(events, { setTimeout, clearTimeout, setInterval, clearInterval })
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, structuredClone, crypto, Date, URL, Blob, AbortController, DOMException, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, window: events,
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw new Error('No provider traffic allowed') } }) }
        if (name === 'react') return React
        if (name === 'react/jsx-runtime') return jsx
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (name.endsWith('.ts') || name.endsWith('.tsx') ? '' : '.ts')))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  return { load }
}

test('nickname normalization accepts one exact handle and rejects searches, links and ambiguous input', () => {
  const api = fixture().load('src/lib/teachingColleagues.ts')
  assert.equal(api.normalizeTeachingNickname(' @Taras.Example '), 'taras.example')
  for (const value of ['ta','@','@@taras','taras example','https://example.test/taras','taras%','taras,olena']) assert.throws(() => api.normalizeTeachingNickname(value), /нікнейм/)
})

test('actual group controls submit explicit current IDs and never opt into future groups or transfer authorship', () => {
  const fx = fixture()
  const api = fx.load('src/components/teaching/TeachingColleagueScope.tsx')
  const groups = ['a','b','c'].map(group_id => ({ id: group_id, group_id, group_name: group_id, status: 'accepted' }))
  let next
  const tree = api.TeachingColleagueScope({ groups, scope: { group_scope: 'selected', group_ids: ['a'] }, onScope: value => { next = plain(value) }, permissions: ['materials'], onPermissions() {} })
  function* nodes(node = tree) { if (!React.isValidElement(node)) return; yield node; for (const child of React.Children.toArray(node.props.children)) yield* nodes(child) }
  const boxes = [...nodes()].filter(node => node.type === 'input')
  assert.deepEqual(boxes.slice(0,3).map(node => node.props.checked), [true,false,false])
  boxes[1].props.onChange({ target: { checked: true } }); assert.deepEqual(next, { group_scope: 'selected', group_ids: ['a','b'] })
  const all = [...nodes()].find(node => node.type === 'button'); all.props.onClick()
  assert.deepEqual(next, { group_scope: 'selected', group_ids: ['a','b','c'] })
  assert.equal([...nodes()].some(node => node.type === 'input' && node.props.type === 'radio'), false)
})

test('colleague group controls hide exact test IDs and preserve their existing scope when selecting visible groups', () => {
  const api = fixture().load('src/components/teaching/TeachingColleagueScope.tsx')
  const hidden = '445fcadc-95e2-4f8c-bfb3-6d0998030a01'
  const real = 'd54d0a4e-eb72-4ac4-8f5f-cc0bcc3bcab4'
  const groups = Object.freeze([
    Object.freeze({ id: 'test-link', group_id: hidden, group_name: 'ЕУБ-4', status: 'accepted' }),
    Object.freeze({ id: 'real-link', group_id: real, group_name: 'ЕУБ-4', status: 'accepted' }),
  ])
  const scope = Object.freeze({ group_scope: 'selected', group_ids: Object.freeze([hidden]) })
  let next
  const tree = api.TeachingColleagueScope({ groups, scope, onScope: value => { next = plain(value) }, permissions: ['materials'], onPermissions() {} })
  function* nodes(node = tree) { if (!React.isValidElement(node)) return; yield node; for (const child of React.Children.toArray(node.props.children)) yield* nodes(child) }
  const groupBoxes = [...nodes()].filter(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange)
  assert.equal(groupBoxes[0].props.checked, false)
  groupBoxes[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(next.group_ids, [hidden, real])
  ;[...nodes()].find(node => node.type === 'button').props.onClick()
  assert.deepEqual(next.group_ids, [hidden, real])
  assert.equal(scope.group_ids.length, 1)
  assert.equal(groups.length, 2)
})

test('local colleague demo has only group1 while owner keeps both groups and all student grades intact', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingRepository.ts')
  const owner = api.createLocalTeachingRepository('teacher'), colleague = api.createLocalTeachingRepository('colleague')
  const workspace = await owner.workspace(), course = workspace.courses.find(course => !course.archived_at)
  const full = await owner.course(course.id), limited = await colleague.course(course.id)
  assert.equal(full.groups.length, 2); assert.equal(limited.groups.length, 1)
  const other = full.groups.find(group => group.group_id !== limited.groups[0].group_id)
  assert.ok(limited.entries.every(entry => entry.group_id !== other.group_id))
  assert.ok(limited.activities.every(activity => activity.group_id !== other.group_id))
  assert.ok(limited.assignments.every(item => item.targets.every(target => target.group_id !== other.group_id)))
  await assert.rejects(colleague.groupContext(other.group_id), /FORBIDDEN/)
  await assert.rejects(colleague.mutate('sync_roster', { course_id: course.id, group_id: other.group_id }), /FORBIDDEN/)
  assert.deepEqual(plain((await owner.course(course.id)).grades), plain(full.grades))
})

test('local canonical creation replays are denied after selective revocation and batch validates every target', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingRepository.ts')
  const owner = api.createLocalTeachingRepository('teacher'), colleague = api.createLocalTeachingRepository('colleague')
  const course = (await owner.workspace()).courses[0], full = await owner.course(course.id), limited = await colleague.course(course.id)
  const a = limited.groups[0].group_id, b = full.groups.find(group => group.group_id !== a).group_id, teacher = full.teachers[0]
  const draft = { id: crypto.randomUUID(), version: 0, course_id: course.id, title: 'Synthetic scoped draft', body: '', status: 'draft', max_points: null, category: '', links: [], attachments: [], targets: [{ group_id: a }] }
  await colleague.mutate('save_assignment', draft)
  const batch = { ...draft, id: crypto.randomUUID(), expected_user_id: api.LOCAL_TEACHING_IDENTITIES.colleague.userId, targets: [{ group_id: a },{ group_id: b }] }
  await assert.rejects(colleague.classroomMutate('save_multi_group_assignment', batch), /FORBIDDEN/)
  await owner.mutate('update_teacher', { teacher_link_id: teacher.id, permissions: teacher.permissions, group_scope: 'selected', group_ids: [b] })
  await assert.rejects(colleague.mutate('save_assignment', draft), /FORBIDDEN/)
  assert.deepEqual(plain((await colleague.course(course.id)).groups.map(group => group.group_id)), [b])
  const before = (await owner.course(course.id)).grades
  await owner.classroomMutate('save_multi_group_assignment', { ...batch, id: crypto.randomUUID(), expected_user_id: api.LOCAL_TEACHING_IDENTITIES.teacher.userId })
  assert.deepEqual(plain((await owner.course(course.id)).grades), plain(before))
})
