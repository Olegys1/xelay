import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const [profileSource, groupSource] = await Promise.all(['ProfileBirthdaySettings.tsx', 'GroupBirthdays.tsx'].map(name => readFile(new URL('../../src/components/birthday/' + name, import.meta.url), 'utf8')))
const notificationSource = await readFile(new URL('../../src/components/NotificationPanel.tsx', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const empty = { day: null, month: null, showToGroup: false }
const birthday = { day: 29, month: 10, showToGroup: true }
const member = name => [{ userId: 'fictional-member', name, avatarUrl: null, day: 29, month: 10, isToday: true, daysUntil: 0 }]
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function events() { const listeners = new Map(); return { addEventListener(name, callback) { const handlers = listeners.get(name) || new Set(); handlers.add(callback); listeners.set(name, handlers) }, removeEventListener(name, callback) { listeners.get(name)?.delete(callback) }, dispatchEvent(event) { for (const callback of [...listeners.get(event.type) || []]) callback(event) }, count() { return [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0) } } }
function hooks() {
  const cells = [], effects = []; let at = 0, dirty = false, component, tree
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) { const index = at++; if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[index].value, next => { const value = typeof next === 'function' ? next(cells[index].value) : next; if (!Object.is(value, cells[index].value)) { cells[index].value = value; dirty = true } }] },
    useRef(initial) { const index = at++; cells[index] ||= { current: initial }; return cells[index] },
    useEffect(callback, dependencies) { const index = at++; if (!cells[index] || !equal(cells[index].dependencies, dependencies)) { const before = cells[index]; cells[index] = { dependencies }; effects.push(() => { before?.cleanup?.(); cells[index].cleanup = callback() }) } },
  }
  const render = () => { for (let attempt = 0; attempt < 30; attempt++) { at = 0; dirty = false; tree = component(); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Unexpected render loop') }
  return { react, render, start(callback) { component = callback; return render() }, unmount() { cells.forEach(cell => cell?.cleanup?.()) } }
}
function descendants(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(descendants); return [node, ...descendants(node.props?.children)] }

function fixture(t, kind, initialProps, hash = '') {
  const run = hooks(), browser = events(), document = { ...events(), visibilityState: 'visible' }
  const calls = { loads: [], saves: [], groups: [], saved: 0, busy: [], dispatched: [], scrolled: [], focused: [] }
  const frames = new Map(); let frameId = 0
  browser.location = { hash }
  browser.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id }
  browser.cancelAnimationFrame = id => frames.delete(id)
  const anchor = { isConnected: true, scrollIntoView: options => calls.scrolled.push(plain(options)), focus: options => calls.focused.push(plain(options)) }
  const Fields = () => null, GroupList = () => null
  const signalCall = (list, values, signal) => { const pending = { ...deferred(), values, signal }; list.push(pending); return pending.promise }
  const api = { BIRTHDAY_PROFILE_CHANGED: 'birthday-profile-changed',
    loadBirthdayProfile: (actor, signal) => signalCall(calls.loads, [actor], signal),
    saveBirthdayProfile: (actor, value, signal) => signalCall(calls.saves, [actor, plain(value)], signal),
    loadGroupBirthdays: (actor, group, signal) => signalCall(calls.groups, [actor, group], signal),
  }
  let now = 100000, props = { onSaved: () => calls.saved++, onBusyChange: busy => calls.busy.push(busy), ...initialProps }
  const OriginalDate = Date
  class Clock extends OriginalDate { static now() { return now } }
  const dispatch = browser.dispatchEvent
  browser.dispatchEvent = event => { calls.dispatched.push(event); dispatch(event) }
  const module = { exports: {} }
  const source = kind === 'profile' ? profileSource : groupSource
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const modules = { react: run.react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }, '../../lib/birthdayProfile': api, './BirthdayProfileSettings': { BirthdayProfileSettings: Fields }, './GroupBirthdayList': { GroupBirthdayList: GroupList } }
  runInNewContext(code, { module, exports: module.exports, window: browser, document, AbortController, Error, Date: Clock, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }, require(name) { assert.ok(name in modules, 'Unexpected dependency: ' + name); return modules[name] } })
  const Component = kind === 'profile' ? module.exports.ProfileBirthdaySettings : module.exports.GroupBirthdays
  run.start(() => { const tree = Component(props); if (tree?.props.ref) tree.props.ref.current = anchor; return tree })
  t.after(() => run.unmount())
  return { calls, browser, document, get ui() { const node = descendants(run.render()).find(node => node.type === (kind === 'profile' ? Fields : GroupList)); assert.ok(node); return node.props },
    update(next) { props = { ...props, ...next }; run.render() },
    async settle() { await Promise.resolve(); await Promise.resolve(); run.render() },
    advance(milliseconds) { now += milliseconds },
    event(type, target = browser) { target.dispatchEvent({ type }) },
    changed() { browser.dispatchEvent({ type: api.BIRTHDAY_PROFILE_CHANGED }) },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) },
    get pendingFrames() { return frames.size },
    unmount() { run.unmount() },
  }
}

test('late profile response from a previous account cannot populate the next account settings', async t => {
  const fx = fixture(t, 'profile', { userId: 'actor-a' })
  assert.equal(fx.calls.loads.length, 1)
  fx.update({ userId: 'actor-b' })
  assert.equal(fx.calls.loads[0].signal.aborted, true)
  assert.equal(fx.ui.loading, true)
  assert.deepEqual(plain(fx.ui.value), empty)
  fx.calls.loads[1].resolve({ day: 5, month: 3, showToGroup: false }); await fx.settle()
  fx.calls.loads[0].resolve(birthday); await fx.settle()
  assert.deepEqual(plain(fx.ui.value), { day: 5, month: 3, showToGroup: false })
  assert.equal(fx.ui.loading, false)
})

test('a profile save that finishes after account change cannot show a success or emit another account event', async t => {
  const fx = fixture(t, 'profile', { userId: 'actor-a' })
  fx.calls.loads[0].resolve(birthday); await fx.settle()
  const saving = fx.ui.onSave(); assert.equal(fx.ui.saving, true)
  fx.update({ userId: 'actor-b' })
  assert.equal(fx.calls.saves[0].signal.aborted, true)
  fx.calls.saves[0].resolve(birthday); await saving; await fx.settle()
  assert.equal(fx.calls.saved, 0)
  assert.equal(fx.calls.dispatched.length, 0)
  assert.equal(fx.ui.saved, false)
  assert.deepEqual(plain(fx.ui.value), empty)
  fx.calls.loads[1].resolve(empty); await fx.settle()
  assert.equal(fx.ui.loading, false)
})

test('removing the date waits for server acknowledgement and clears both the date and group opt-in once', async t => {
  const fx = fixture(t, 'profile', { userId: 'actor-a' })
  fx.calls.loads[0].resolve(birthday); await fx.settle()
  const remove = fx.ui.onRemove()
  assert.deepEqual(plain(fx.calls.saves[0].values), ['actor-a', empty])
  assert.equal(fx.ui.saving, true)
  assert.deepEqual(plain(fx.ui.value), birthday)
  assert.equal(fx.calls.saved, 0)
  await fx.ui.onRemove(); assert.equal(fx.calls.saves.length, 1)
  fx.calls.saves[0].resolve(empty); await remove; await fx.settle()
  assert.deepEqual(plain(fx.ui.value), empty)
  assert.equal(fx.ui.onRemove, undefined)
  assert.equal(fx.ui.saving, false)
  assert.equal(fx.ui.saved, true)
  assert.equal(fx.calls.saved, 1)
  assert.equal(fx.calls.dispatched.length, 1)
  assert.deepEqual(plain(fx.calls.dispatched[0].detail), { userId: 'actor-a' })
  assert.equal(fx.calls.busy.at(-1), false)
})

test('failed saving unlocks the form, preserves the edited date and allows a successful retry', async t => {
  const fx = fixture(t, 'profile', { userId: 'actor-a' })
  fx.calls.loads[0].resolve(birthday); await fx.settle()
  const edited = { day: 7, month: 11, showToGroup: false }
  fx.ui.onChange(edited)
  const first = fx.ui.onSave(); await fx.ui.onSave()
  assert.equal(fx.calls.saves.length, 1)
  fx.calls.saves[0].reject(new Error('Synthetic save failure')); await first; await fx.settle()
  assert.equal(fx.ui.saving, false)
  assert.equal(fx.ui.error, 'Synthetic save failure')
  assert.deepEqual(plain(fx.ui.value), edited)
  assert.equal(fx.calls.saved, 0)
  const retry = fx.ui.onSave()
  assert.equal(fx.calls.saves.length, 2)
  assert.equal(fx.ui.error, '')
  fx.calls.saves[1].resolve(edited); await retry; await fx.settle()
  assert.equal(fx.ui.saved, true)
  assert.equal(fx.ui.saving, false)
  assert.equal(fx.calls.saved, 1)
})

test('changing group or account hides old members immediately and ignores late responses', async t => {
  const fx = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' })
  fx.update({ groupId: 'group-b' })
  assert.equal(fx.calls.groups[0].signal.aborted, true)
  assert.deepEqual(plain(fx.ui.members), [])
  assert.equal(fx.ui.loading, true)
  fx.calls.groups[1].resolve(member('Current group')); await fx.settle()
  fx.calls.groups[0].resolve(member('Previous group')); await fx.settle()
  assert.equal(fx.ui.members[0].name, 'Current group')
  fx.update({ userId: 'actor-b' })
  assert.deepEqual(plain(fx.ui.members), [])
  fx.calls.groups[2].resolve(member('Current account')); await fx.settle()
  assert.equal(fx.ui.members[0].name, 'Current account')
})

test('concurrent focus, online and visibility events deduplicate an expired group refresh', async t => {
  const fx = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' })
  fx.calls.groups[0].resolve(member('Initial')); await fx.settle()
  fx.event('focus'); assert.equal(fx.calls.groups.length, 1)
  fx.advance(60001)
  fx.event('focus'); fx.event('online'); fx.event('visibilitychange', fx.document)
  assert.equal(fx.calls.groups.length, 2)
  fx.calls.groups[1].resolve(member('Refreshed')); await fx.settle()
  fx.event('focus'); assert.equal(fx.calls.groups.length, 2)
  fx.advance(60001); fx.document.visibilityState = 'hidden'; fx.event('focus'); fx.event('visibilitychange', fx.document)
  assert.equal(fx.calls.groups.length, 2)
  fx.document.visibilityState = 'visible'; fx.event('visibilitychange', fx.document)
  assert.equal(fx.calls.groups.length, 3)
})

test('forced refresh cancels an older response; failed reload clears members and retry recovers', async t => {
  const fx = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' })
  fx.calls.groups[0].resolve(member('Initial')); await fx.settle()
  fx.advance(60001); fx.event('focus'); fx.changed()
  assert.equal(fx.calls.groups.length, 3)
  assert.equal(fx.calls.groups[1].signal.aborted, true)
  assert.equal(fx.ui.loading, true)
  assert.deepEqual(plain(fx.ui.members), [])
  fx.calls.groups[2].resolve(member('Fresh')); await fx.settle()
  fx.calls.groups[1].resolve(member('Stale')); await fx.settle()
  assert.equal(fx.ui.members[0].name, 'Fresh')
  fx.changed()
  assert.equal(fx.ui.loading, true)
  assert.deepEqual(plain(fx.ui.members), [])
  fx.calls.groups[3].reject(new Error('Synthetic group failure')); await fx.settle()
  assert.deepEqual(plain(fx.ui.members), [])
  assert.ok(fx.ui.error)
  fx.ui.onRetry(); assert.equal(fx.ui.loading, true)
  fx.calls.groups[4].resolve(member('Retry')); await fx.settle()
  assert.equal(fx.ui.error, '')
  assert.equal(fx.ui.members[0].name, 'Retry')
})

test('unmount aborts requests, removes refresh listeners and ignores late birthday data', async t => {
  const fx = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' })
  assert.ok(fx.browser.count() > 0)
  fx.unmount()
  assert.equal(fx.calls.groups[0].signal.aborted, true)
  assert.equal(fx.browser.count(), 0)
  assert.equal(fx.document.count(), 0)
  fx.calls.groups[0].resolve(member('Late')); await fx.settle()
  assert.deepEqual(plain(fx.ui.members), [])
})

test('a birthday deep-link focuses the late-mounted authorized group card once after its DOM commit', async t => {
  const fx = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' }, '#group-birthdays-area')
  assert.equal(fx.ui.loading, true)
  assert.equal(fx.pendingFrames, 1)
  assert.equal(fx.calls.scrolled.length, 0)
  fx.flushFrames()
  assert.deepEqual(fx.calls.scrolled, [{ block: 'start', behavior: 'instant' }])
  assert.deepEqual(fx.calls.focused, [{ preventScroll: true }])
  fx.calls.groups[0].resolve(member('Loaded later')); await fx.settle()
  fx.flushFrames()
  assert.equal(fx.calls.scrolled.length, 1, 'ordinary data refresh must not pull focus back')
})

test('unrelated hashes and a cancelled or superseded birthday deep-link never move focus', t => {
  for (const hash of ['', '#group-members-area', '#group-birthdays-area-extra']) {
    const fx = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' }, hash)
    fx.flushFrames(); assert.equal(fx.calls.scrolled.length, 0); assert.equal(fx.calls.focused.length, 0)
  }
  const cancelled = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' }, '#group-birthdays-area')
  cancelled.unmount(); assert.equal(cancelled.pendingFrames, 0)
  cancelled.flushFrames(); assert.equal(cancelled.calls.scrolled.length, 0)
  const changed = fixture(t, 'group', { userId: 'actor-a', groupId: 'group-a' }, '#group-birthdays-area')
  changed.browser.location.hash = '#group-members-area'; changed.flushFrames()
  assert.equal(changed.calls.scrolled.length, 0)
})

test('the actual birthday notification callback requests the current Kyiv day and birthday anchor', () => {
  const parsed = ts.createSourceFile('NotificationPanel.tsx', notificationSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'NotificationPanel')
  const declaration = component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(parsed) === 'openNotification')
  const module = { exports: {} }
  const code = ts.transpileModule(`export function create(context:any) { const {navigate,onClose,groupTodayInKyiv,CONVERSATION_ID,openBirthdayGift,userId}=context;return ${declaration.initializer.getText(parsed)}; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(code, { module, exports: module.exports })
  const destinations = [], gifts = []; let closed = 0, dateReads = 0
  const userId = '10000000-0000-0000-0000-000000000001', groupId = '20000000-0000-0000-0000-000000000001'
  const open = module.exports.create({ navigate: value => destinations.push(plain(value)), onClose: () => closed++, groupTodayInKyiv: () => { dateReads++; return '2026-10-29' }, CONVERSATION_ID: /^[0-9a-f-]{36}$/i, openBirthdayGift: (...args) => gifts.push(args), userId })
  open({ type: 'group_birthday', study_group_id: groupId })
  assert.deepEqual(destinations, [{ to: '/groups/$id', params: { id: groupId }, search: { date: '2026-10-29' }, hash: 'group-birthdays-area' }])
  assert.equal(dateReads, 1)
  assert.equal(closed, 1)
  open({ type: 'birthday_gift', id: 'gift-notification' })
  assert.deepEqual(gifts, [[userId, 'gift-notification']])
  assert.equal(destinations.length, 1)
})
