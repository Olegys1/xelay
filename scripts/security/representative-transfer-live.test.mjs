import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/components/StudyGroupRepresentativeTransfer.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const actor = 'synthetic-actor', group = 'synthetic-group'
const members = [
  { id: 'membership-actor', user_id: actor, group_id: group, status: 'accepted', profile: { full_name: 'Current Headman', username: 'headman' } },
  { id: 'membership-first', user_id: 'target-a', group_id: group, status: 'accepted', profile: { full_name: 'First Member', username: 'first' } },
  { id: 'membership-second', user_id: 'target-b', group_id: group, status: 'accepted', profile: { full_name: 'Second Member', username: 'second' } },
  { id: 'membership-pending', user_id: 'pending-member', group_id: group, status: 'pending', profile: { full_name: 'Pending Member' } },
  { id: 'membership-foreign', user_id: 'foreign-member', group_id: 'another-group', status: 'accepted', profile: { full_name: 'Foreign Member' } },
]
const receipt = target => ({ groupId: group, previousRepresentativeId: actor, representativeId: target, requestId: 'synthetic-operation', transferredAt: '2026-10-29T12:00:00Z', replayed: false })
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture(t, overrides = {}) {
  const cells = [], effects = [], requests = [], transferred = []
  let at = 0, props, refreshes = 0, uuidCount = 0
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    useRef(initial) { const index = at++; cells[index] ||= { current: initial }; return cells[index] },
    useEffect(callback, deps) { const index = at++; if (!cells[index] || !equal(cells[index].deps, deps)) { const before = cells[index]; cells[index] = { deps }; effects.push(() => { before?.cleanup?.(); cells[index].cleanup = callback() }) } },
  }
  const Panel = () => null
  const modules = { react: hooks, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) }, './representative-transfer/RepresentativeTransferPanel': { RepresentativeTransferPanel: Panel }, '../lib/studyGroupRepresentativeTransfer': {
    transferStudyGroupRepresentative(...args) { const request = { ...deferred(), args, signal: args[5] }; requests.push(request); return request.promise },
  } }
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, Error, AbortController, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}` }, require(name) { assert.ok(name in modules, 'Unexpected live dependency: ' + name); return modules[name] } })
  props = { groupId: group, groupName: 'Synthetic Group', currentUserId: actor, representativeId: actor, members, onTransferred: value => transferred.push(value), onRefresh: () => refreshes++, ...overrides }
  const render = () => { at = 0; const tree = module.exports.StudyGroupRepresentativeTransfer(props); effects.splice(0).forEach(effect => effect()); return tree.props }
  render(); const unmount = () => cells.forEach(cell => cell?.cleanup?.()); t.after(unmount)
  return { requests, transferred, get refreshes() { return refreshes }, get ui() { return render() }, get uuidCount() { return uuidCount }, update(next) { props = { ...props, ...next }; render() }, unmount }
}

test('the live adapter uses user IDs rather than membership IDs and omits pending rows', t => {
  const fx = fixture(t)
  assert.ok(fx.ui.members.some(member => member.id === 'target-a' && member.groupId === group))
  assert.ok(fx.ui.members.every(member => member.status === 'accepted'))
  assert.ok(!fx.ui.members.some(member => member.id === 'membership-first' || member.id === 'pending-member'))
})

test('retry after an uncertain result reuses the same operation UUID and refreshes only the current group', async t => {
  const fx = fixture(t)
  const first = fx.ui.onTransfer('target-a')
  const firstId = fx.requests[0].args[4]
  fx.requests[0].reject(new Error('Friendly uncertain result'))
  await assert.rejects(first, /Friendly uncertain result/)
  assert.equal(fx.refreshes, 1)
  const retry = fx.ui.onTransfer('target-a')
  assert.equal(fx.requests[1].args[4], firstId)
  assert.equal(fx.uuidCount, 1)
  fx.requests[1].resolve(receipt('target-a')); await retry
  assert.equal(fx.transferred.length, 1)
  assert.equal(fx.refreshes, 1)
})

test('overlapping final callbacks cannot issue a second transfer request', async t => {
  const fx = fixture(t)
  const first = fx.ui.onTransfer('target-a')
  await assert.rejects(fx.ui.onTransfer('target-a'), /Оновіть групу/)
  assert.equal(fx.requests.length, 1)
  fx.requests[0].resolve(receipt('target-a')); await first
  assert.equal(fx.transferred.length, 1)
})

test('a different recipient receives a fresh operation ID after the prior attempt fails', async t => {
  const fx = fixture(t)
  const first = fx.ui.onTransfer('target-a')
  fx.requests[0].reject(new Error('Friendly failure')); await assert.rejects(first)
  const second = fx.ui.onTransfer('target-b')
  assert.notEqual(fx.requests[1].args[4], fx.requests[0].args[4])
  assert.equal(fx.uuidCount, 2)
  fx.requests[1].resolve(receipt('target-b')); await second
})

test('account, group or representative change aborts the prior request and fences its late success', async t => {
  for (const next of [{ currentUserId: 'another-actor' }, { groupId: 'another-group' }, { representativeId: 'another-headman' }]) {
    const fx = fixture(t)
    const pending = fx.ui.onTransfer('target-a')
    fx.update(next)
    assert.equal(fx.requests[0].signal.aborted, true)
    fx.requests[0].resolve(receipt('target-a')); await pending
    assert.equal(fx.transferred.length, 0)
    assert.equal(fx.refreshes, 0)
  }
})

test('late errors after scope change or unmount cannot refresh or report another group result', async t => {
  for (const change of ['group', 'unmount']) {
    const fx = fixture(t)
    const pending = fx.ui.onTransfer('target-a')
    if (change === 'group') fx.update({ groupId: 'another-group' }); else fx.unmount()
    assert.equal(fx.requests[0].signal.aborted, true)
    fx.requests[0].reject(new Error('Friendly stale request'))
    await assert.rejects(pending, /Friendly stale request/)
    assert.equal(fx.refreshes, 0)
    assert.equal(fx.transferred.length, 0)
  }
})

test('loading, disabled, non-owner and unavailable-member attempts never reach the API', async t => {
  for (const options of [{ loading: true }, { disabled: true }, { representativeId: 'another-headman' }]) {
    const fx = fixture(t, options)
    await assert.rejects(fx.ui.onTransfer('target-a'), /Оновіть групу/)
    assert.equal(fx.requests.length, 0)
  }
  const fx = fixture(t)
  for (const target of ['pending-member', 'foreign-member', 'missing-member']) await assert.rejects(fx.ui.onTransfer(target), /Оновіть групу/)
  assert.equal(fx.requests.length, 0)
})
