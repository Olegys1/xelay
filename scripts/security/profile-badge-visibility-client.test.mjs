import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const read = name => readFile(new URL('../../' + name, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const source = await read('src/lib/profileBadgePreferences.ts')
const hookSource = await read('src/hooks/useProfileBadgeVisibility.ts')
const changedEvent = 'xelay:profile-badges-changed'
const visible = { showParticipant: true, showTeacher: true }
const hidden = { showParticipant: false, showTeacher: false }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function load(sourceText, imports, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, ...globals, require(name) { assert.ok(name in imports, 'Known import: ' + name); return imports[name] } })
  return module.exports
}

function fixture(respond = call => ({ data: call.name === 'xelay_set_my_profile_badges'
  ? { showParticipant: call.args.p_show_participant, showTeacher: call.args.p_show_teacher }
  : visible, error: null })) {
  const calls = []
  const api = load(source, { './supabase': { supabase: { rpc(name, args) {
    const call = { name, args }; calls.push(call)
    return {
      abortSignal(signal) { call.signal = signal; return this },
      then(resolve, reject) { return Promise.resolve().then(() => respond(call)).then(resolve, reject) },
    }
  } } } })
  return { api, calls }
}

test('display parser accepts only boolean switches and strips unrelated server fields', () => {
  const { api } = fixture()
  for (const showParticipant of [false, true]) for (const showTeacher of [false, true]) {
    assert.deepEqual(plain(api.parseProfileBadgePreferences({ showParticipant, showTeacher, is_premium: true, verified: true, email: 'private' })), { showParticipant, showTeacher })
  }
  for (const value of [null, undefined, true, [], {}, { showParticipant: true }, { showParticipant: true, showTeacher: 1 }, { showParticipant: 'false', showTeacher: true }]) assert.throws(() => api.parseProfileBadgePreferences(value))
})

test('public read names the target, while own save sends only the two switches and no owner or access flags', async () => {
  const fx = fixture()
  assert.deepEqual(plain(await fx.api.loadProfileBadgePreferences(alice)), visible)
  assert.deepEqual(plain(await fx.api.saveMyProfileBadgePreferences(false, true)), { showParticipant: false, showTeacher: true })
  assert.deepEqual(plain(fx.calls), [
    { name: 'xelay_profile_badge_preferences', args: { p_user_id: alice } },
    { name: 'xelay_set_my_profile_badges', args: { p_show_participant: false, p_show_teacher: true } },
  ])
})

test('invalid targets and nonboolean switches reject before sending any request', async () => {
  const fx = fixture()
  for (const id of ['', 'alice', null, undefined, alice + '/other', '11111111-1111-4111-8111-11111111111z']) await assert.rejects(fx.api.loadProfileBadgePreferences(id))
  for (const pair of [[null, true], [true, undefined], [1, false], [false, 'true'], [{}, true]]) await assert.rejects(fx.api.saveMyProfileBadgePreferences(...pair))
  assert.equal(fx.calls.length, 0)
})

test('request errors and malformed replies cannot pretend display preferences were loaded or saved', async () => {
  for (const result of [{ data: visible, error: { code: '42501' } }, { data: null, error: null }, { data: { showParticipant: true }, error: null }]) {
    const fx = fixture(() => result)
    await assert.rejects(fx.api.loadProfileBadgePreferences(alice))
    await assert.rejects(fx.api.saveMyProfileBadgePreferences(false, false))
    assert.equal(fx.calls.length, 2)
  }
  const offline = fixture(() => { throw new Error('offline') })
  await assert.rejects(offline.api.loadProfileBadgePreferences(alice), /offline/)
})

test('a save rejects a well-formed response that does not confirm both requested switches', async () => {
  for (const data of [visible, { showParticipant: false, showTeacher: true }, { showParticipant: true, showTeacher: false }]) {
    const fx = fixture(() => ({ data, error: null }))
    await assert.rejects(fx.api.saveMyProfileBadgePreferences(false, false), /підтвердити збереження/)
    assert.equal(fx.calls.length, 1)
  }
  const fx = fixture(() => ({ data: hidden, error: null }))
  assert.deepEqual(plain(await fx.api.saveMyProfileBadgePreferences(false, false)), hidden)
})

test('both operations pass the exact abort signal to Supabase', async () => {
  const fx = fixture(), readSignal = new AbortController().signal, writeSignal = new AbortController().signal
  await fx.api.loadProfileBadgePreferences(alice, readSignal)
  await fx.api.saveMyProfileBadgePreferences(true, false, writeSignal)
  assert.equal(fx.calls[0].signal, readSignal)
  assert.equal(fx.calls[1].signal, writeSignal)
})

test('preaborted reads and saves perform no RPC; abort after a server reply still rejects', async () => {
  const fx = fixture(), cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(fx.api.loadProfileBadgePreferences(alice, cancelled.signal), { name: 'AbortError' })
  await assert.rejects(fx.api.saveMyProfileBadgePreferences(true, true, cancelled.signal), { name: 'AbortError' })
  assert.equal(fx.calls.length, 0)
  for (const operation of ['read', 'save']) {
    const controller = new AbortController()
    const late = fixture(() => { controller.abort(); return { data: visible, error: null } })
    await assert.rejects(operation === 'read' ? late.api.loadProfileBadgePreferences(alice, controller.signal) : late.api.saveMyProfileBadgePreferences(false, false, controller.signal), { name: 'AbortError' })
    assert.equal(late.calls.length, 1)
  }
})

// Execute the real hook with deterministic effects, event targets and deferred reads.
// This harness makes no network requests and never touches a real account.
function hookFixture(initialUser = alice) {
  let user = initialUser, index = 0, dirty = false, value, sequence = 0, writes = 0
  const cells = [], effects = [], calls = [], timers = new Map(), intervals = new Map()
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
  const hooks = {
    useState(initial) { const i = index++; if (!cells[i]) cells[i] = { value: initial }; return [cells[i].value, update => { writes++; const next = typeof update === 'function' ? update(cells[i].value) : update; if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true } }] },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps, callback, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const target = () => { const listeners = new Map(); return {
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    emit(name, event = {}) { for (const callback of [...(listeners.get(name) || [])]) callback(event) },
    listenerCount() { return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0) },
  } }
  const window = { ...target(), setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) }, setInterval(callback, delay) { const id = ++sequence; intervals.set(id, { callback, delay }); return id }, clearInterval(id) { intervals.delete(id) } }
  const document = { ...target(), visibilityState: 'visible' }
  const api = load(hookSource, { react: hooks, '../lib/profileBadgePreferences': {
    PROFILE_BADGES_CHANGED: changedEvent,
    loadProfileBadgePreferences(userId, signal) { const request = { userId, signal, ...deferred() }; calls.push(request); return request.promise },
  } }, { window, document, AbortController })
  function render() {
    for (let turn = 0; turn < 20; turn++) { dirty = false; index = 0; value = api.useProfileBadgeVisibility(user); effects.splice(0).forEach(effect => effect()); if (!dirty) return value }
    throw new Error('Hook rendered too often')
  }
  const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); return render() }
  render()
  return { calls, window, document, timers, intervals, render, flush, get value() { return value }, get writes() { return writes },
    switchUser(next) { user = next; return render() },
    strictReplay() { cells.forEach(cell => cell.cleanup?.()); cells.forEach(cell => { if (cell.callback) cell.cleanup = cell.callback() }); return render() },
    unmount() { cells.forEach(cell => cell.cleanup?.()) },
  }
}

test('unknown display preferences remain hidden until the server confirms the current profile', async () => {
  const fx = hookFixture()
  assert.equal(fx.value, null); assert.equal(fx.calls.length, 1)
  fx.calls[0].resolve(hidden); await fx.flush()
  assert.deepEqual(plain(fx.value), hidden)
  fx.unmount()
  const empty = hookFixture(null)
  assert.equal(empty.calls.length, 0)
  // Passing no profile must not send a query.
  empty.switchUser(undefined)
  assert.equal(empty.value, null); assert.equal(empty.calls.length, 0)
  empty.unmount()
})

test('switching the target aborts the old read and ignores its late success or failure', async () => {
  const fx = hookFixture()
  fx.switchUser(bob)
  assert.equal(fx.calls[0].signal.aborted, true); assert.equal(fx.value, null)
  assert.equal(fx.calls[1].userId, bob)
  fx.calls[1].resolve(hidden); await fx.flush()
  fx.calls[0].resolve(visible); await fx.flush()
  assert.deepEqual(plain(fx.value), hidden)
  fx.switchUser(alice); fx.switchUser(bob)
  fx.calls[3].resolve(visible); await fx.flush()
  fx.calls[2].reject(new Error('late previous account')); await fx.flush()
  assert.deepEqual(plain(fx.value), visible)
  fx.unmount()
})

test('a newer refresh wins over an earlier same-profile request', async () => {
  const fx = hookFixture()
  fx.window.emit('focus')
  assert.equal(fx.calls.length, 2); assert.equal(fx.calls[0].signal.aborted, true)
  fx.calls[1].resolve(hidden); await fx.flush()
  fx.calls[0].reject(new Error('obsolete aborted request')); await fx.flush()
  assert.deepEqual(plain(fx.value), hidden)
  fx.unmount()
})

test('local changes refresh only the affected profile; focus, visible-state and polling reconcile other devices', async () => {
  const fx = hookFixture(); fx.calls[0].resolve(visible); await fx.flush()
  fx.window.emit(changedEvent, { detail: { userId: bob } }); assert.equal(fx.calls.length, 1)
  fx.window.emit(changedEvent, { detail: { userId: alice } }); fx.render()
  assert.equal(fx.value, null); assert.equal(fx.calls.length, 2)
  fx.calls[1].resolve(hidden); await fx.flush()
  fx.document.visibilityState = 'hidden'
  fx.document.emit('visibilitychange'); fx.window.emit('focus'); assert.equal(fx.calls.length, 2)
  fx.document.visibilityState = 'visible'; fx.document.emit('visibilitychange'); assert.equal(fx.calls.length, 3)
  fx.calls[2].resolve(hidden); await fx.flush()
  const interval = [...fx.intervals.values()][0]; assert.equal(interval.delay, 60_000)
  interval.callback(); assert.equal(fx.calls.length, 4)
  fx.unmount()
  assert.equal(fx.window.listenerCount(), 0); assert.equal(fx.document.listenerCount(), 0); assert.equal(fx.intervals.size, 0)
})

test('errors clear possibly stale visible marks and a later focus can recover', async () => {
  const fx = hookFixture(); fx.calls[0].resolve(visible); await fx.flush()
  fx.window.emit('focus'); fx.calls[1].reject(new Error('offline')); await fx.flush()
  assert.equal(fx.value, null)
  fx.window.emit('focus'); fx.calls[2].resolve(hidden); await fx.flush()
  assert.deepEqual(plain(fx.value), hidden)
  fx.unmount()
})

test('finite deadlines abort reads and unmount suppresses late state updates', async () => {
  const fx = hookFixture(), deadline = [...fx.timers.values()][0]
  assert.equal(deadline.delay, 12_000); deadline.callback(); assert.equal(fx.calls[0].signal.aborted, true)
  fx.calls[0].reject(new Error('aborted')); await fx.flush(); assert.equal(fx.value, null)
  fx.window.emit('focus'); fx.unmount()
  assert.equal(fx.calls[1].signal.aborted, true)
  const writes = fx.writes; fx.calls[1].resolve(visible)
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  assert.equal(fx.writes, writes)
})

test('StrictMode effect replay starts a fresh read and obsolete reply cannot reveal a mark', async () => {
  const fx = hookFixture(); fx.strictReplay()
  assert.equal(fx.calls.length, 2); assert.equal(fx.calls[0].signal.aborted, true)
  fx.calls[1].resolve(hidden); await fx.flush()
  fx.calls[0].resolve(visible); await fx.flush()
  assert.deepEqual(plain(fx.value), hidden)
  fx.unmount()
})

test('hiding the Participant mark preserves custom emoji and text status and does not grant access', async () => {
  const icons = { Sparkles: () => React.createElement('svg') }
  const ui = load(await read('src/components/PremiumBadge.tsx'), { react: React, 'react/jsx-runtime': jsx, 'lucide-react': icons,
    '../lib/supabase': { supabase: { rpc() { throw new Error('SSR must not perform a network request') } } },
    './ParticipantStatusEmoji': { ParticipantStatusEmojis: ({ status }) => React.createElement('span', { 'data-emoji-status': status }, status) },
    './BadgeInfo': { BadgeInfo: ({ children, label }) => React.createElement('button', { 'data-badge-label': label }, children) },
  })
  const render = props => renderToStaticMarkup(React.createElement(ui.PremiumBadge, props))
  const props = { isPremium: true, emojiStatus: '🎃', textStatus: 'Навчаюся', showBadge: false }
  const hiddenMarkup = render(props)
  assert.doesNotMatch(hiddenMarkup, /data-badge-label|Учасник/)
  assert.match(hiddenMarkup, /data-emoji-status="🎃"/); assert.match(hiddenMarkup, /Статус: Навчаюся/)
  const shown = render({ ...props, showBadge: true }); assert.match(shown, /data-badge-label="Учасник"/)
  assert.match(render({ isPremium: true }), /data-badge-label="Учасник"/, 'Other existing surfaces retain their default display')
  assert.equal(render({ ...props, isPremium: false, showBadge: true }), '', 'A display switch cannot grant Participant access')
})

test('own and public profiles use display switches without changing the entitlement or verification source', async () => {
  const [own, publicProfile, settings, dialog, api] = await Promise.all(['src/pages/ProfilePage.tsx', 'src/pages/PublicProfilePage.tsx', 'src/components/ProfileSettingsModal.tsx', 'src/components/ProfileBadgesDialog.tsx', 'src/lib/profileBadgePreferences.ts'].map(read))
  assert.match(own, /useProfileBadgeVisibility\(authUser\?\.id\)/)
  assert.match(publicProfile, /useProfileBadgeVisibility\(id\)/)
  for (const page of [own, publicProfile]) {
    assert.match(page, /showBadge=\{badgeVisibility\?\.showParticipant === true\}/)
    assert.match(page, /<TeacherBadge verified=\{[^}]+&& badgeVisibility\?\.showTeacher === true\}/)
    assert.match(page, /<SupporterBadge userId=/); assert.match(page, /<HalloweenBadge userId=/)
  }
  assert.match(own, /<PremiumBadge isPremium=\{isPremium\} emojiStatus=\{emojiStatus\} textStatus=\{textStatus\}/)
  assert.match(publicProfile, /<PremiumBadge userId=\{id\}/)
  for (const host of [settings, dialog]) for (const component of ['ProfileBadgeSettings', 'SupporterBadgeSettings', 'HalloweenBadgeSettings']) assert.match(host, new RegExp('<' + component + '\\b'))
  assert.match(own, /<ProfileBadgesDialog key=\{authUser\.id\}/)
  assert.doesNotMatch(api + hookSource, /participant_entitlements|billing_orders|user_roles|teacher_verification_requests|xelay_has_participant_access|xelay_teaching_is_verified|\.from\(/)
})
