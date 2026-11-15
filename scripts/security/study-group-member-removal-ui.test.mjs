// Execute the real permission helper and member-list component with synthetic
// identities. No provider, browser storage, live account or network is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const permissionSource = await readFile(new URL('src/lib/studyGroupDeputies.ts', root), 'utf8')
const componentSource = await readFile(new URL('src/components/StudyGroupMembers.tsx', root), 'utf8')
const pageSource = await readFile(new URL('src/pages/StudyGroupsPage.tsx', root), 'utf8')
const pageAst = ts.createSourceFile('StudyGroupsPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const workspace = pageAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'StudyGroupWorkspace')
const removalDeclaration = workspace.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(pageAst) === 'canRemoveMembers')
const removalExpression = removalDeclaration.initializer.getText(pageAst)
const permissionModule = { exports: {} }
vm.runInNewContext(compile(permissionSource), {
  module: permissionModule, exports: permissionModule.exports,
  require(name) {
    if (name === './supabase') return { supabase: { rpc() { throw Error('No provider traffic') } } }
    if (name === './profiles') return { getPublicProfiles() { throw Error('No provider traffic') } }
    if (name === './databaseCompatibility') return { isMissingDatabaseFunction: () => false }
    throw Error('Unexpected dependency ' + name)
  },
})
const canRemove = input => permissionModule.exports.canRemoveStudyGroupMembers(input)
const groupId = 'synthetic-group-a', userId = 'synthetic-deputy', representativeId = 'synthetic-head'
const appointment = (extra = {}) => ({ group_id: groupId, user_id: userId, status: 'approved', permissions: ['remove_members'], ...extra })
const input = (extra = {}) => ({ groupId, userId, representativeId, memberStatus: 'accepted', deputies: [appointment()], ...extra })

function nodes(value) {
  if (!value || typeof value !== 'object') return []
  return Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
}
function member(user, status = 'accepted', extra = {}) {
  return { id: 'row-' + user, group_id: groupId, user_id: user, status, profile: { full_name: user, username: user }, ...extra }
}
function componentFixture(overrides = {}) {
  const events = [], module = { exports: {} }
  const props = {
    groupId, currentUserId: representativeId, representativeId,
    members: [member(representativeId), member('student-a'), member(userId), member('pending-student', 'pending')],
    canManage: true, canViewInvitations: true, canRemoveMembers: true, deputyIds: [userId],
    onRemove: async row => { events.push(['remove', row.id]) }, ...overrides,
  }
  const react = {
    useState(initial) { const cell = { value: typeof initial === 'function' ? initial() : initial }; return [cell.value, value => { cell.value = typeof value === 'function' ? value(cell.value) : value }] },
    useRef: value => ({ current: value }),
    useMemo: fn => fn(), useCallback: fn => fn,
    // The isolated render needs neither live subscriptions nor polling timers.
    useEffect() {},
  }
  const modules = {
    react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '@tanstack/react-router': { Link: 'a', useNavigate: () => value => events.push(['navigate', value]) },
    'lucide-react': new Proxy({}, { get: () => 'synthetic-icon' }),
    '../lib/supabase': { supabase: { rpc() { throw Error('Unexpected live RPC') } } },
    '../lib/studyGroupMembers': { loadMemberConnections: async () => ({}) },
    '../lib/connectionRequests': { connectionRequestError: () => 'Synthetic error' },
  }
  vm.runInNewContext(compile(componentSource), {
    module, exports: module.exports, console,
    require(name) { assert.ok(name in modules, 'Unexpected dependency ' + name); return modules[name] },
  })
  const tree = module.exports.StudyGroupMembers(props)
  const buttons = () => nodes(tree).filter(node => node.type === 'button' && /^(Видалити з групи|Скасувати запрошення):/.test(node.props['aria-label'] || ''))
  return { events, props, tree, buttons, buttonFor: id => buttons().find(node => node.props['aria-label'].endsWith(': ' + id)) }
}

test('actual representative can remove members without a deputy appointment or legacy membership row', () => {
  assert.equal(canRemove(input({ userId: representativeId, memberStatus: undefined, deputies: null })), true)
  for (const missing of ['groupId', 'userId', 'representativeId']) assert.equal(canRemove(input({ [missing]: '' })), false)
})

test('ordinary member, teacher or platform administrator alone cannot inherit removal permission', () => {
  for (const metadata of [{}, { role: 'ADMIN' }, { isAdmin: true }, { teaching: true }, { permissions: ['remove_members', 'invite_members'] }]) {
    assert.equal(canRemove(input({ deputies: [], ...metadata })), false)
  }
  assert.equal(canRemove(input({ deputies: null })), false)
  assert.equal(canRemove(input({ deputies: { permissions: ['remove_members'] } })), false)
})

test('only the current accepted deputy with the explicit removal permission is authorized', () => {
  assert.equal(canRemove(input()), true)
  for (const permissions of [[], ['invite_members'], ['schedule', 'seminar_comments'], null, 'remove_members']) {
    assert.equal(canRemove(input({ deputies: [appointment({ permissions })] })), false)
  }
  for (const memberStatus of ['pending', 'removed', 'rejected', undefined]) assert.equal(canRemove(input({ memberStatus })), false)
  for (const status of ['pending', 'rejected', 'revoked', 'cancelled', undefined]) assert.equal(canRemove(input({ deputies: [appointment({ status })] })), false)
})

test('appointments for another group or another account and malformed rows do not authorize removal', () => {
  for (const row of [null, false, 'approved', {}, appointment({ group_id: 'other-group' }), appointment({ user_id: 'other-user' })]) {
    assert.equal(canRemove(input({ deputies: [row] })), false)
  }
  assert.equal(canRemove(input({ groupId: 'new-group' })), false)
  assert.equal(canRemove(input({ userId: 'new-user' })), false)
  assert.equal(canRemove(input({ deputies: [null, appointment({ group_id: 'other-group' }), appointment()] })), true)
})

test('the real workspace requires both server permission and a matching current account/group role receipt', () => {
  const evaluate = (extra = {}) => Boolean(vm.runInNewContext(removalExpression, {
    hasPermission: permission => permission === 'remove_members', group: { id: groupId }, id: groupId,
    authUser: { id: userId }, contentGrant: { groupId, userId, memberRemovalAllowed: true }, ...extra,
  }))
  assert.equal(evaluate(), true)
  for (const override of [
    { contentGrant: null },
    { contentGrant: { groupId, userId, memberRemovalAllowed: false } },
    { contentGrant: { groupId: 'old-group', userId, memberRemovalAllowed: true } },
    { contentGrant: { groupId, userId: 'old-user', memberRemovalAllowed: true } },
    { authUser: { id: 'new-user' } }, { group: { id: 'old-group' } },
    { hasPermission: () => false }, { group: null },
  ]) assert.equal(evaluate(override), false)
})

test('invitation management without an explicit removal grant renders no delete or cancellation buttons', () => {
  for (const grant of [false, undefined]) {
    const fx = componentFixture({ currentUserId: 'student-a', canManage: true, canViewInvitations: true, canRemoveMembers: grant })
    assert.equal(fx.buttons().length, 0)
    assert.equal(fx.events.length, 0)
  }
})

test('ordinary roles cannot see removal controls even if an older server grants administrative capabilities', () => {
  for (const extra of [{ role: 'ADMIN' }, { isAdmin: true }, { role: 'TEACHER' }, {}]) {
    const grant = canRemove(input({ userId: 'student-a', deputies: [], ...extra }))
    const fx = componentFixture({ currentUserId: 'student-a', canRemoveMembers: grant, ...extra })
    assert.equal(fx.buttons().length, 0)
  }
})

test('representative can cancel a pending invitation and remove another deputy but never self or representative', async () => {
  const fx = componentFixture()
  assert.equal(fx.buttons().length, 3)
  assert.ok(fx.buttonFor(userId))
  assert.ok(fx.buttonFor('pending-student'))
  assert.equal(fx.buttonFor(representativeId), undefined)
  fx.buttonFor('pending-student').props.onClick()
  await Promise.resolve()
  assert.deepEqual(fx.events, [['remove', 'row-pending-student']])
})

test('permitted deputy can remove an ordinary member but not head, self or another deputy', () => {
  const fx = componentFixture({ currentUserId: userId, deputyIds: [userId, 'student-a'] })
  assert.equal(fx.buttons().length, 1)
  assert.ok(fx.buttonFor('pending-student'))
  for (const user of [representativeId, userId, 'student-a']) assert.equal(fx.buttonFor(user), undefined)
})

test('stale roster from another group cannot expose its removal control', () => {
  const fx = componentFixture({ members: [member('foreign-student', 'accepted', { group_id: 'other-group' })] })
  assert.equal(fx.buttons().length, 0)
})

test('rapid repeated removal clicks send one request while the first action is pending', async () => {
  let finish
  const events = []
  const fx = componentFixture({ onRemove: row => { events.push(row.id); return new Promise(resolve => { finish = resolve }) } })
  const button = fx.buttonFor('student-a')
  button.props.onClick(); button.props.onClick()
  assert.deepEqual(events, ['row-student-a'])
  finish(); await Promise.resolve(); await Promise.resolve()
})
