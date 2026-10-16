// Real component callbacks and rendering; synthetic data and no provider traffic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('src/components/AdminStudyGroups.tsx', root), 'utf8')
const parse = ts.createSourceFile('AdminStudyGroups.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const functions = ['StudyGroupDirectory', 'StudyGroupMembers', 'GroupIdentity', 'GroupCounts', 'MemberRow', 'Pagination', 'LoadError', 'accessDenied']
let auth = { authUser: { id: 'admin' }, xelayUser: { id: 'admin', isPlatformAdmin: true }, isLoading: false }
const renderer = {}
vm.runInNewContext(compile(source) + `\nexports.__test={${functions.join(',')}};`, {
  exports: renderer, Date, Intl, window: {}, document: {},
  require(name) {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return runtime
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => React.createElement('svg') })
    if (name === '../context/AuthContext') return { useAuth: () => auth }
    if (name === '../lib/adminStudyGroups') return { adminStudyGroupsError: () => 'Synthetic request error', loadAdminStudyGroups() { throw new Error('No provider traffic') }, loadAdminStudyGroupMembers() { throw new Error('No provider traffic') } }
    if (name === '../lib/studyGroupIdentity') return { studyGroupIdentityLabel: group => `${2026 - group.cohort_start_year + 1} курс · Бакалаврат` }
    if (name === './CommunityChatPrimitives') return {
      ChatDialog: ({ title, children }) => React.createElement('div', { role: 'dialog', 'aria-label': title }, children),
      chatButton: 'button', chatInput: 'input', chatPrimary: 'primary',
    }
    throw new Error('Unexpected live import ' + name)
  },
})
const ui = renderer.__test
const group = {
  id: '11111111-1111-4111-8111-111111111111', group_name: 'МА-2', specialty: 'Менеджмент', cohort_start_year: 2026, study_level: 'bachelor',
  university_id: '22222222-2222-4222-8222-222222222222', university_name: 'КНУ', academic_unit_id: '33333333-3333-4333-8333-333333333333', unit_name: 'Економічний факультет',
  representative: { id: '44444444-4444-4444-8444-444444444444', full_name: 'Тестова староста', username: 'representative' },
  accepted_count: 63, pending_count: 2, inactive_count: 3, created_at: '2026-10-16T10:00:00Z',
}
const member = { user_id: group.representative.id, full_name: 'Тестова староста', username: 'representative', status: 'accepted', is_representative: true, invited_at: null, accepted_at: '2026-10-16T10:00:00Z' }
function callback(component, name, context) {
  const fn = parse.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === component)
  const init = fn.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(parse) === name)?.initializer
  assert.ok(init, 'Actual callback exists: ' + component + '.' + name)
  const expression = ts.isCallExpression(init) ? init.arguments[0] : init
  return vm.runInNewContext(compile(`(context)=>{const {${Object.keys(context).join(',')}}=context;return ${expression.getText(parse)}}`), { Date, JSON })(context)
}
function listFixture(overrides = {}) {
  const events = [], scope = { query: '', sort: 'name', offset: 0 }
  const context = {
    GROUP_PAGE_SIZE: 20, current: () => true, busy: { current: null }, generation: { current: 0 }, lastRefresh: { current: 0 },
    scope, scopeKey: JSON.stringify(scope), latestScope: { current: JSON.stringify(scope) },
    setLoading: value => events.push(['loading', value]), setPage: value => events.push(['page', plain(value)]),
    setError: value => events.push(['error', value]), setStale: value => events.push(['stale', value]), setSelectedGroup: value => events.push(['selected', value]),
    loadAdminStudyGroups: async (...args) => { events.push(['request', args]); return { items: [group], total: 45 } },
    adminStudyGroupsError: () => 'Synthetic request error', accessDenied: ui.accessDenied, ...overrides,
  }
  return { events, context, load: () => callback('StudyGroupDirectory', 'load', context)() }
}
function membersFixture(overrides = {}) {
  const events = [], scope = { query: '', status: 'accepted', offset: 0 }
  const context = {
    MEMBER_PAGE_SIZE: 50, initialGroup: group, current: () => true, busy: { current: null }, generation: { current: 0 }, lastRefresh: { current: 0 },
    scope, scopeKey: JSON.stringify(scope), latestScope: { current: JSON.stringify(scope) },
    setLoading: value => events.push(['loading', value]), setPage: value => events.push(['page', plain(value)]),
    setError: value => events.push(['error', value]), setStale: value => events.push(['stale', value]), onAccessDenied: value => events.push(['denied', value]), onGroupLoaded: value => events.push(['group', plain(value)]),
    loadAdminStudyGroupMembers: async (...args) => { events.push(['request', args]); return { group, items: [member], total: 63 } },
    adminStudyGroupsError: () => 'Synthetic request error', accessDenied: ui.accessDenied, ...overrides,
  }
  return { events, context, load: () => callback('StudyGroupMembers', 'load', context)() }
}

test('same-account admin gate immediately hides stale, loading, absent and nonadmin profiles', () => {
  for (const next of [
    { authUser: null, xelayUser: { id: 'old', isPlatformAdmin: true } },
    { authUser: { id: 'new' }, xelayUser: { id: 'old', isPlatformAdmin: true } },
    { authUser: { id: 'user' }, xelayUser: { id: 'user', isPlatformAdmin: false } },
    { authUser: { id: 'admin' }, xelayUser: { id: 'admin', isPlatformAdmin: true }, isLoading: true },
  ]) { auth = next; assert.equal(renderToStaticMarkup(React.createElement(renderer.AdminStudyGroups)), '') }
  auth = { authUser: { id: 'admin' }, xelayUser: { id: 'admin', isPlatformAdmin: true }, isLoading: false }
  const html = renderToStaticMarkup(React.createElement(renderer.AdminStudyGroups))
  assert.match(html, /Навчальні групи/); assert.match(html, /Завантажуємо навчальні групи/)
  assert.match(html, /Завантаження…/); assert.doesNotMatch(html, /Усього: 0|<dd/)
})

test('summary identity separates same-name cohorts and renders authoritative counters safely', () => {
  const first = renderToStaticMarkup(React.createElement(ui.GroupIdentity, { group }))
  const second = renderToStaticMarkup(React.createElement(ui.GroupIdentity, { group: { ...group, cohort_start_year: 2025 } }))
  assert.match(first, /1 курс/); assert.match(second, /2 курс/)
  assert.match(first, /Економічний факультет/); assert.match(first, /Менеджмент/)
  const counts = renderToStaticMarkup(React.createElement(ui.GroupCounts, { group }))
  assert.match(counts, /У групі/); assert.match(counts, />63</); assert.match(counts, /Очікують/); assert.match(counts, />2</)
  const unsafe = renderToStaticMarkup(React.createElement(ui.GroupIdentity, { group: { ...group, group_name: '<script>unsafe</script>' } }))
  assert.match(unsafe, /&lt;script&gt;/); assert.doesNotMatch(unsafe, /<script>/)
})

test('directory requests server search/sort and bounded twenty-item pages with no client-wide membership fetch', async () => {
  const scope = { query: 'МА-2', sort: 'members_desc', offset: 20 }
  const fx = listFixture({ scope, scopeKey: JSON.stringify(scope), latestScope: { current: JSON.stringify(scope) } })
  await fx.load()
  assert.deepEqual(fx.events.find(([name]) => name === 'request')[1], ['МА-2', 'members_desc', 20, 20])
  assert.equal(fx.events.find(([name]) => name === 'page')[1].total, 45)
  assert.equal(fx.context.busy.current, null)
})

test('roster requests only the selected group, status, literal query and fifty-item page', async () => {
  const scope = { query: 'Тест', status: 'pending', offset: 50 }
  const fx = membersFixture({ scope, scopeKey: JSON.stringify(scope), latestScope: { current: JSON.stringify(scope) } })
  await fx.load()
  assert.deepEqual(fx.events.find(([name]) => name === 'request')[1], [group.id, 'pending', 'Тест', 50, 50])
  assert.equal(fx.events.find(([name]) => name === 'page')[1].group.id, group.id)
})

test('transport errors preserve the existing page and flag it stale instead of inventing zero', async () => {
  for (const fixture of [listFixture, membersFixture]) {
    const api = fixture === listFixture ? 'loadAdminStudyGroups' : 'loadAdminStudyGroupMembers'
    const fx = fixture({ [api]: async () => { throw new Error('Network') } })
    await fx.load()
    assert.equal(fx.events.some(([name]) => name === 'page'), false)
    assert.equal(fx.events.some(([name, value]) => name === 'stale' && value === true), true)
    assert.equal(fx.events.some(([name, value]) => name === 'loading' && value === false), true)
  }
  const html = renderToStaticMarkup(React.createElement(ui.LoadError, { error: 'Network', stale: true, retry() {}, disabled: false }))
  assert.match(html, /можуть бути застарілими/); assert.match(html, /Повторити завантаження/)
})

test('MFA/access denial clears the privileged list and closes detail rather than retaining a stale roster', async () => {
  for (const failure of [{ code: '42501', message: 'denied' }, { message: 'ADMIN_MFA_REQUIRED' }]) {
    const list = listFixture({ loadAdminStudyGroups: async () => { throw failure } })
    await list.load()
    assert.equal(list.events.some(([name, value]) => name === 'page' && value === null), true)
    assert.equal(list.events.some(([name, value]) => name === 'selected' && value === null), true)
    assert.equal(list.events.some(([name, value]) => name === 'stale' && value === true), false)
    const detail = membersFixture({ loadAdminStudyGroupMembers: async () => { throw failure } })
    await detail.load(); assert.equal(detail.events.some(([name]) => name === 'denied'), true)
    assert.equal(detail.events.some(([name]) => name === 'page'), false)
  }
})

test('late responses cannot populate a different search/filter, closed modal or switched admin account', async () => {
  for (const fixture of [listFixture, membersFixture]) for (const transition of ['scope', 'owner', 'unmount']) {
    let finish, active = true
    const api = fixture === listFixture ? 'loadAdminStudyGroups' : 'loadAdminStudyGroupMembers'
    const fx = fixture({ current: () => active, [api]: () => new Promise(resolve => { finish = resolve }) })
    const pending = fx.load()
    if (transition === 'scope') fx.context.latestScope.current = 'different scope'
    else active = false
    finish(fixture === listFixture ? { items: [group], total: 1 } : { group, items: [member], total: 1 })
    await pending
    assert.equal(fx.events.some(([name]) => name === 'page'), false, transition)
    assert.equal(fx.events.some(([name]) => name === 'error'), false, transition)
  }
})

test('in-flight refresh is deduplicated and StrictMode cleanup cannot let an old request unlock the new one', async () => {
  for (const fixture of [listFixture, membersFixture]) {
    const pending = [], api = fixture === listFixture ? 'loadAdminStudyGroups' : 'loadAdminStudyGroupMembers'
    const fx = fixture({ [api]: () => new Promise(resolve => pending.push(resolve)) })
    const load = callback(fixture === listFixture ? 'StudyGroupDirectory' : 'StudyGroupMembers', 'load', fx.context)
    const old = load(); await load(); assert.equal(pending.length, 1)
    // The actual mount-effect cleanup invalidates generation and releases busy for setup.
    fx.context.generation.current++; fx.context.busy.current = null
    const newer = load(), ticket = fx.context.busy.current
    const response = fixture === listFixture ? { items: [group], total: 1 } : { group, items: [member], total: 1 }
    pending[0](response); await old
    assert.equal(fx.context.busy.current, ticket); assert.equal(fx.events.some(([name]) => name === 'page'), false)
    pending[1](response); await newer
    assert.equal(fx.context.busy.current, null); assert.equal(fx.events.filter(([name]) => name === 'page').length, 1)
  }
  assert.equal(source.match(/mounted\.current = false; \+\+generation\.current; busy\.current = null/g)?.length, 2)
})

test('changing scope invalidates outstanding work, clears previous results and sets a loading page', () => {
  for (const name of ['StudyGroupDirectory', 'StudyGroupMembers']) {
    const events = [], next = name === 'StudyGroupDirectory' ? { query: 'МО', sort: 'members_asc', offset: 0 } : { query: '', status: 'inactive', offset: 0 }
    const context = { current: () => true, generation: { current: 7 }, busy: { current: 7 }, latestScope: { current: 'old' },
      setPage: value => events.push(['page', value]), setError() {}, setStale() {}, setLoading: value => events.push(['loading', value]), setScope: value => events.push(['scope', plain(value)]) }
    callback(name, 'changeScope', context)(next)
    assert.equal(context.generation.current, 8); assert.equal(context.busy.current, null)
    assert.equal(context.latestScope.current, JSON.stringify(next)); assert.deepEqual(events.find(([name]) => name === 'page'), ['page', null])
    assert.deepEqual(events.find(([name]) => name === 'scope')[1], next); assert.deepEqual(events.find(([name]) => name === 'loading'), ['loading', true])
  }
})

test('member rows distinguish invited/rejected/removed states, badge representative and escape names', () => {
  const html = renderToStaticMarkup(React.createElement(ui.MemberRow, { member: { ...member, full_name: '<unsafe>' } }))
  assert.match(html, /Староста/); assert.match(html, /Приєднання/); assert.match(html, /&lt;unsafe&gt;/); assert.doesNotMatch(html, /<unsafe>/)
  for (const [status, label] of [['pending', 'Очікує відповіді'], ['rejected', 'Відхилено'], ['removed', 'Видалено з групи']]) {
    const result = renderToStaticMarkup(React.createElement(ui.MemberRow, { member: { ...member, status, is_representative: false } }))
    assert.match(result, new RegExp(label)); assert.doesNotMatch(result, /Староста/)
  }
})

test('refreshed roster counters update its directory row and selected summary, guarded by the current admin', async () => {
  let page = { items: [group], total: 1 }, selected = group
  let active = true
  const context = { current: () => active, setPage: update => { page = update(page) }, setSelectedGroup: update => { selected = update(selected) } }
  const update = callback('StudyGroupDirectory', 'updateGroup', context)
  const refreshed = { ...group, accepted_count: 64 }
  const fx = membersFixture({ loadAdminStudyGroupMembers: async () => ({ group: refreshed, items: [member], total: 64 }), onGroupLoaded: update })
  await fx.load()
  assert.equal(page.items[0].accepted_count, 64); assert.equal(selected.accepted_count, 64)
  active = false; update({ ...group, accepted_count: 65 })
  assert.equal(page.items[0].accepted_count, 64); assert.equal(selected.accepted_count, 64)
})

test('pagination distinguishes unknown totals from real zero and bounds both navigation controls', () => {
  const props = { offset: 0, count: 0, total: null, loading: true, onPrevious() {}, onNext() {}, label: 'Test pages' }
  const unknown = renderToStaticMarkup(React.createElement(ui.Pagination, props))
  assert.match(unknown, /Завантаження/); assert.doesNotMatch(unknown, /Усього: 0/); assert.equal((unknown.match(/disabled=""/g) || []).length, 2)
  const failed = renderToStaticMarkup(React.createElement(ui.Pagination, { ...props, loading: false }))
  assert.match(failed, /Кількість недоступна/)
  const zero = renderToStaticMarkup(React.createElement(ui.Pagination, { ...props, loading: false, total: 0 }))
  assert.match(zero, /Усього: 0/)
  const last = renderToStaticMarkup(React.createElement(ui.Pagination, { ...props, offset: 50, count: 13, total: 63, loading: false }))
  assert.match(last, /51–63 із 63/); assert.equal((last.match(/disabled=""/g) || []).length, 1)
})

test('section remains read-only, modal is shared accessible primitive and visible focus refresh is bounded without polling', async () => {
  assert.match(source, /FOCUS_REFRESH_MS = 15_000/)
  assert.equal(source.match(/document\.visibilityState === 'visible'/g)?.length, 2)
  assert.doesNotMatch(source, /setInterval|supabase\.|\.insert\(|\.update\(|\.delete\(/)
  assert.equal(source.match(/removeEventListener\('visibilitychange', refresh\)/g)?.length, 2)
  assert.match(source, /!detailOpen\.current/)
  const modal = renderToStaticMarkup(React.createElement(ui.StudyGroupMembers, { initialGroup: group, isCurrentAdmin: () => true, onAccessDenied() {}, onGroupLoaded() {}, onClose() {} }))
  assert.match(modal, /role="dialog"/); assert.match(modal, /порівняйте зі списком академічної групи/)
  assert.match(modal, /Фільтр складу групи/); assert.match(modal, /Запрошення/); assert.match(modal, /Неактивні/)
  assert.doesNotMatch(modal, /href="\/groups\//)
  const primitives = await readFile(new URL('src/components/CommunityChatPrimitives.tsx', root), 'utf8')
  assert.match(primitives, /aria-modal="true"/); assert.match(primitives, /event\.key === 'Escape'/); assert.match(primitives, /event\.key !== 'Tab'/)
  const admin = await readFile(new URL('src/pages/AdminPage.tsx', root), 'utf8')
  assert.ok(admin.indexOf('<AdminStudyGroups') < admin.indexOf('<AdminProfileReports'))
})
