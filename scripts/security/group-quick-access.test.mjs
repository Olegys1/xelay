import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('src/lib/groupQuickAccess.ts', root), 'utf8')
const ui = await readFile(new URL('src/components/GroupQuickAccess.tsx', root), 'utf8')
const menu = await readFile(new URL('src/components/BurgerMenu.tsx', root), 'utf8')
const user = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const group = '33333333-3333-4333-8333-333333333333'
const owned = '44444444-4444-4444-8444-444444444444'
const plain = value => JSON.parse(JSON.stringify(value))
const summary = (id, name = 'МА-2') => ({ id, group_name: name, specialty: 'Економіка', cohort_start_year: 2026, study_level: 'bachelor' })
const visibility = load(await readFile(new URL('src/lib/studyGroupVisibility.ts', root), 'utf8'), {})

function load(text, imports, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, DOMException, ...globals, require(name) { assert.ok(name in imports, `Known import ${name}`); return imports[name] } })
  return module.exports
}
function fixture({ result, storage } = {}) {
  const calls = [], saved = storage || new Map()
  const api = load(source, {
    './supabase': { supabase: { from(table) {
      const call = { table, operations: [] }; calls.push(call)
      const q = {}
      for (const method of ['select', 'eq', 'in', 'is', 'abortSignal']) q[method] = (...args) => { call.operations.push([method, ...args]); return q }
      q.then = (resolve, reject) => Promise.resolve().then(() => result ? result(call) : ({ data: [], error: null })).then(resolve, reject)
      return q
    } } },
    './studyGroupIdentity': { studyGroupIdentityLabel: () => '1 курс · Бакалаврат' },
    './studyGroupVisibility': visibility,
  }, { localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } })
  return { api, calls, saved }
}
const operation = (call, method, field) => call.operations.find(item => item[0] === method && item[1] === field)?.[2]
const signal = () => new AbortController().signal

test('schedule options union accepted membership and representative ownership, deduplicated', async () => {
  const fx = fixture({ result: call => ({ data: call.table === 'study_group_members' ? [{ group_id: group }, { group_id: group }]
    : operation(call, 'eq', 'representative_id') ? [summary(owned, 'Власна група'), summary(group)] : [summary(group)], error: null }) })
  const options = plain(await fx.api.loadScheduleQuickAccess(user, signal()))
  assert.equal(options.length, 2)
  assert.deepEqual(new Set(options.map(item => item.id)), new Set([group, owned]))
  assert.equal(operation(fx.calls[0], 'eq', 'status'), 'accepted')
  assert.equal(operation(fx.calls[0], 'eq', 'user_id'), user)
  assert.equal(operation(fx.calls[1], 'eq', 'representative_id'), user)
  assert.deepEqual(plain(operation(fx.calls[2], 'in', 'id')), [group])
  assert.ok(options.every(item => item.detail.includes('1 курс') && item.detail.includes('Економіка')))
  assert.ok(fx.calls.every(call => call.operations.some(item => item[0] === 'abortSignal')))
})

test('owner without membership works and empty memberships never request unrestricted metadata', async () => {
  const fx = fixture({ result: call => ({ data: call.table === 'study_group_members' ? [] : [summary(owned)], error: null }) })
  assert.deepEqual(plain(await fx.api.loadScheduleQuickAccess(user, signal())).map(item => item.id), [owned])
  assert.equal(fx.calls.length, 2)
  const empty = fixture()
  assert.deepEqual(plain(await empty.api.loadScheduleQuickAccess(user, signal())), [])
  assert.equal(empty.calls.length, 2)
})

test('test groups are absent from schedule shortcuts while a real same-name group stays available', async () => {
  const hiddenOwned = '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'
  const hiddenJoined = '445fcadc-95e2-4f8c-bfb3-6d0998030a01'
  const realSameName = 'd54d0a4e-eb72-4ac4-8f5f-cc0bcc3bcab4'
  const fx = fixture({ result: call => ({ data: call.table === 'study_group_members'
    ? [{ group_id: hiddenJoined }, { group_id: realSameName }]
    : operation(call, 'eq', 'representative_id') ? [summary(hiddenOwned, 'ооо 1')]
      : [summary(realSameName, 'ЕУБ-4')], error: null }) })
  const options = plain(await fx.api.loadScheduleQuickAccess(user, signal()))
  assert.deepEqual(options.map(item => [item.id, item.name]), [[realSameName, 'ЕУБ-4']])
  assert.deepEqual(plain(operation(fx.calls[2], 'in', 'id')), [realSameName])
})

test('an old schedule selection cannot reopen a hidden group; chat and direct paths remain independent', () => {
  const hidden = '445fcadc-95e2-4f8c-bfb3-6d0998030a01'
  const fx = fixture({ storage: new Map([[`xelay:group-quick-access:${user}:schedule`, hidden], [`xelay:group-quick-access:${user}:chat`, hidden]]) })
  assert.equal(fx.api.readGroupQuickAccess(user, 'schedule'), null)
  assert.equal(fx.api.saveGroupQuickAccess(user, 'schedule', hidden), false)
  assert.equal(fx.api.readGroupQuickAccess(user, 'chat'), hidden)
  assert.equal(fx.api.groupQuickAccessPath('schedule', hidden), `/groups/${hidden}?tab=schedule`)
})

test('schedule failures and malformed records reject rather than pretend there are no groups', async () => {
  for (const result of [call => ({ data: [], error: call.table === 'study_group_members' ? new Error('offline') : null }),
    call => ({ data: call.table === 'study_group_members' ? [{ group_id: '../bad' }] : [], error: null }),
    call => ({ data: call.table === 'study_groups' ? [{ ...summary(group), group_name: '' }] : [], error: null })]) {
    const fx = fixture({ result })
    await assert.rejects(fx.api.loadScheduleQuickAccess(user, signal()))
  }
})

test('chat list reads own active membership and ordinary GROUP metadata only, without inbox or join RPC', async () => {
  const fx = fixture({ result: call => ({ data: call.table === 'chat_members' ? [{ space_id: group }]
    : [{ id: group, name: 'Чат МА-2', kind: 'group', system_kind: null }], error: null }) })
  assert.deepEqual(plain(await fx.api.loadChatQuickAccess(user, signal())).map(item => item.name), ['Чат МА-2'])
  assert.equal(operation(fx.calls[0], 'eq', 'status'), 'active')
  assert.equal(operation(fx.calls[0], 'eq', 'user_id'), user)
  assert.deepEqual(plain(operation(fx.calls[1], 'in', 'id')), [group])
  assert.equal(operation(fx.calls[1], 'eq', 'kind'), 'group')
  assert.equal(operation(fx.calls[1], 'is', 'system_kind'), null)
  assert.deepEqual(fx.calls.map(call => call.table), ['chat_members', 'chat_spaces'])
  assert.equal(fx.calls[1].operations.find(item => item[0] === 'select')[1], 'id,name,kind,system_kind')
})

test('chat options cannot include a channel, faculty/system chat, or a space outside own membership', async () => {
  for (const row of [{ id: group, name: 'Channel', kind: 'channel', system_kind: null },
    { id: group, name: 'Faculty', kind: 'group', system_kind: 'faculty' },
    { id: other, name: 'Other', kind: 'group', system_kind: null }]) {
    const fx = fixture({ result: call => ({ data: call.table === 'chat_members' ? [{ space_id: group }] : [row], error: null }) })
    await assert.rejects(fx.api.loadChatQuickAccess(user, signal()))
  }
  const fx = fixture()
  assert.deepEqual(plain(await fx.api.loadChatQuickAccess(user, signal())), [])
  assert.equal(fx.calls.length, 1)
})

test('invalid user IDs and aborted loads never issue reads', async () => {
  const fx = fixture()
  for (const id of ['', '../other', null]) {
    await assert.rejects(fx.api.loadScheduleQuickAccess(id, signal()))
    await assert.rejects(fx.api.loadChatQuickAccess(id, signal()))
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(fx.api.loadScheduleQuickAccess(user, controller.signal))
  await assert.rejects(fx.api.loadChatQuickAccess(user, controller.signal))
  assert.equal(fx.calls.length, 0)
})

test('an abort after an in-flight membership read prevents follow-up metadata and use of stale results', async () => {
  let resolve
  const pending = new Promise(yes => { resolve = yes })
  const fx = fixture({ result: call => call.table === 'chat_members' ? pending : ({ data: [], error: null }) })
  const controller = new AbortController()
  const read = fx.api.loadChatQuickAccess(user, controller.signal)
  await Promise.resolve(); await Promise.resolve()
  controller.abort()
  resolve({ data: [{ space_id: group }], error: null })
  await assert.rejects(read)
  assert.equal(fx.calls.length, 1)
})

test('selection storage separates account and shortcut kind, and removal affects only that choice', () => {
  const { api, saved } = fixture()
  assert.equal(api.saveGroupQuickAccess(user, 'schedule', group), true)
  assert.equal(api.saveGroupQuickAccess(user, 'chat', owned), true)
  assert.equal(api.readGroupQuickAccess(user, 'schedule'), group)
  assert.equal(api.readGroupQuickAccess(user, 'chat'), owned)
  assert.equal(api.readGroupQuickAccess(other, 'schedule'), null)
  assert.equal(api.saveGroupQuickAccess(user, 'schedule', null), true)
  assert.equal(api.readGroupQuickAccess(user, 'schedule'), null)
  assert.equal(api.readGroupQuickAccess(user, 'chat'), owned)
  assert.equal(saved.size, 1)
  assert.equal(api.saveGroupQuickAccess(user, 'schedule', '../wrong'), false)
})

test('invalid stored IDs are ignored and unavailable storage degrades without throwing', () => {
  const fx = fixture()
  fx.saved.set(`xelay:group-quick-access:${user}:schedule`, 'javascript:bad')
  assert.equal(fx.api.readGroupQuickAccess(user, 'schedule'), null)
  const api = load(source, { './supabase': {}, './studyGroupIdentity': {}, './studyGroupVisibility': visibility }, { localStorage: {
    getItem() { throw new Error('disabled') }, setItem() { throw new Error('disabled') }, removeItem() { throw new Error('disabled') },
  } })
  assert.equal(api.readGroupQuickAccess(user, 'chat'), null)
  assert.equal(api.saveGroupQuickAccess(user, 'chat', group), false)
})

test('only UUID routes can be opened, with explicit schedule and group chat destinations', () => {
  const { api } = fixture()
  assert.equal(api.groupQuickAccessPath('schedule', group), `/groups/${group}?tab=schedule`)
  assert.equal(api.groupQuickAccessPath('chat', group), `/messages?kind=groups&space=${group}`)
  assert.throws(() => api.groupQuickAccessPath('chat', 'https://evil'))
})

test('installed router parses quicklink hrefs into clean routes and validated search parameters', async () => {
  const { api } = fixture()
  const rootRoute = createRootRoute()
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/' })
  const academic = createRoute({ getParentRoute: () => rootRoute, path: '/groups/$id',
    validateSearch: search => ({ tab: search.tab === 'schedule' ? 'schedule' : undefined }) })
  const chats = createRoute({ getParentRoute: () => rootRoute, path: '/messages',
    validateSearch: search => ({ kind: search.kind === 'groups' ? 'groups' : undefined,
      space: typeof search.space === 'string' && /^[0-9a-f-]{36}$/i.test(search.space) ? search.space : undefined }) })
  const router = createRouter({ routeTree: rootRoute.addChildren([index, academic, chats]),
    history: createMemoryHistory({ initialEntries: ['/'] }) })
  const commits = []
  router.commitLocation = async location => { commits.push(location) }

  await router.navigate({ href: api.groupQuickAccessPath('schedule', group) })
  assert.equal(commits[0].pathname, `/groups/${group}`)
  // Current router versions use a prototype-free search record. Compare its
  // own values; both supported representations must retain the exact query.
  assert.deepEqual({ ...commits[0].search }, { tab: 'schedule' })
  const matched = router.getMatchedRoutes(commits[0].pathname)
  assert.equal(matched.foundRoute.id, academic.id)
  assert.equal(matched.routeParams.id, group)

  await router.navigate({ href: api.groupQuickAccessPath('chat', owned) })
  assert.equal(commits[1].pathname, '/messages')
  assert.deepEqual({ ...commits[1].search }, { kind: 'groups', space: owned })
  assert.equal(router.getMatchedRoutes(commits[1].pathname).foundRoute.id, chats.id)
  assert.equal(commits.length, 2)
})

test('compact picker renders within menu, with change/clear controls and explicit empty teacher/chat states', () => {
  function render({ teacher = false, rows = [], phase = 'ready' } = {}) {
    let cursor = 0
    const state = [group, rows, phase, true, '', false, null, [], phase, true, '', false]
    const icons = new Proxy({}, { get: (_, key) => props => jsx.jsx('svg', { ...props, 'data-icon': key }) })
    const api = load(ui, {
      react: { ...React, useState: () => [state[cursor++], () => {}], useRef: value => ({ current: value }), useEffect() {}, useCallback: fn => fn },
      'react/jsx-runtime': jsx, 'lucide-react': icons,
      '../lib/groupQuickAccess': { GROUP_QUICK_ACCESS_TIMEOUT_MS: 12000, readGroupQuickAccess: () => null },
    })
    return renderToStaticMarkup(jsx.jsx(api.GroupQuickAccess, { userId: user, isTeacher: teacher, onNavigate() {} }))
  }
  const markup = render({ teacher: true })
  assert.match(markup, /Швидкий доступ/)
  assert.match(markup, /Змінити групу для розкладу/)
  assert.match(markup, /Змінити груповий чат/)
  assert.match(markup, /Прибрати вибір/)
  assert.match(markup, /лише для вас у цьому браузері/)
  assert.match(markup, /Підключені групи викладача/)
  assert.match(markup, /Ви ще не берете участі у групових чатах/)
  assert.doesNotMatch(markup, /role="dialog"|aria-modal|fixed inset/)
  assert.match(render({ phase: 'error' }), /Не вдалося завантажити/)
  assert.doesNotMatch(render({ phase: 'error' }), /Попередня група більше не доступна/)
  assert.match(render({ rows: Array.from({ length: 6 }, (_, index) => ({ id: String(index), name: `Група ${index}`, detail: '1 курс' })) }), /Знайти групу/)
  assert.match(menu, /<GroupQuickAccess key=\{authUser\.id\}/)
  assert.match(menu, /xelayUser\?\.id === authUser\.id/)
  assert.match(menu, /navigate\(\{ href: path \}\)/)
  assert.match(ui, /request\.current\?\.abort\(\)/)
  assert.match(ui, /current !== generation\.current/)
  assert.match(ui, /const available = await load\(\)/)
  assert.match(ui, /available\.some\(option => option\.id === id\)/)
})
