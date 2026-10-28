// Execute the real client and component with synthetic accounts, deterministic
// hooks and simulated browser visibility. No network, database or form writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const source = await read('src/lib/rectorateFeedbackAnnouncement.ts')
const componentSource = await read('src/components/RectorateFeedbackAnnouncement.tsx')
const campaign = 'rectorate-feedback-2026-10-18'
const form = 'https://docs.google.com/forms/d/e/1FAIpQLScrp2tt5nwJ4YHFmuw5AxeY93s7NnjFizm6ZEUdTKMnnHZOdA/viewform'
const alice = '18000000-0000-4000-8000-000000000001'
const bob = '18000000-0000-4000-8000-000000000002'
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(text, imports, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, ...globals, require(name) { assert.ok(name in imports, 'Known import: ' + name); return imports[name] } })
  return module.exports
}
function clientFixture(respond = call => ({ data: null, error: null }), storageThrows = false) {
  const calls = [], storage = new Map(), timers = new Map()
  let sequence = 0
  const api = load(source, { './supabase': { supabase: { from(table) {
    const call = { table, filters: [] }; calls.push(call)
    return {
      select(columns) { call.columns = columns; return this },
      eq(column, value) { call.filters.push([column, value]); return this },
      upsert(payload, options) { call.payload = payload; call.options = options; return this },
      abortSignal(signal) { call.signal = signal; return this },
      maybeSingle() { call.single = true; return this },
      then(resolve, reject) { return Promise.resolve().then(() => respond(call)).then(resolve, reject) },
    }
  } } } }, { AbortController,
    localStorage: { getItem(key) { if (storageThrows) throw Error('Storage blocked'); return storage.get(key) ?? null }, setItem(key, value) { if (storageThrows) throw Error('Storage blocked'); storage.set(key, value) } },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
  })
  return { api, calls, storage, timers }
}

test('feedback form URL and seen keys are exact, campaign scoped and owner isolated', () => {
  const { api } = clientFixture()
  assert.equal(api.XELAY_FEEDBACK_FORM_URL, form)
  assert.equal(api.RECTORATE_FEEDBACK_ANNOUNCEMENT_ID, campaign)
  assert.equal(api.feedbackReceiptKey(alice), `xelay:announcement:${campaign}:${alice}`)
  assert.notEqual(api.feedbackReceiptKey(alice), api.feedbackReceiptKey(bob))
  api.rememberFeedbackAnnouncement(alice)
  assert.equal(api.hasSeenFeedbackAnnouncement(alice), true)
  assert.equal(api.hasSeenFeedbackAnnouncement(bob), false)
  assert.equal(api.hasSeenFeedbackAnnouncement(), false)
})

test('blocked local storage retains only the matching in-memory receipt', () => {
  const { api } = clientFixture(undefined, true)
  assert.equal(api.hasSeenFeedbackAnnouncement(alice), false)
  api.rememberFeedbackAnnouncement(alice)
  assert.equal(api.hasSeenFeedbackAnnouncement(alice), true)
  assert.equal(api.hasSeenFeedbackAnnouncement(bob), false)
})

test('guest receipt is local only and does not issue account requests', async () => {
  const fx = clientFixture(), signal = new AbortController().signal
  assert.equal(await fx.api.loadFeedbackAnnouncementSeen(undefined, signal), false)
  fx.api.rememberFeedbackAnnouncement()
  assert.equal(await fx.api.loadFeedbackAnnouncementSeen(undefined, signal), true)
  await fx.api.persistFeedbackAnnouncement()
  assert.equal(fx.calls.length, 0)
})

test('account read selects only the matching private campaign receipt with cancellation', async () => {
  const fx = clientFixture(() => ({ data: { announcement_id: campaign }, error: null }))
  const signal = new AbortController().signal
  assert.equal(await fx.api.loadFeedbackAnnouncementSeen(alice, signal), true)
  assert.equal(fx.api.hasSeenFeedbackAnnouncement(alice), true)
  const call = fx.calls[0]
  assert.equal(call.table, 'account_announcement_receipts')
  assert.equal(call.columns, 'announcement_id')
  assert.deepEqual(plain(call.filters), [['user_id', alice], ['announcement_id', campaign]])
  assert.equal(call.signal, signal)
  await fx.api.persistFeedbackAnnouncement(alice)
  assert.equal(fx.calls.length, 1, 'An existing receipt does not write again')
})

test('read failures, mismatched campaigns and aborted replies never mark an account seen', async () => {
  for (const response of [{ data: null, error: Error('offline') }, { data: { announcement_id: 'other' }, error: null }]) {
    const fx = clientFixture(() => response)
    await assert.rejects(fx.api.loadFeedbackAnnouncementSeen(alice, new AbortController().signal))
    assert.equal(fx.api.hasSeenFeedbackAnnouncement(alice), false)
  }
  const abort = new AbortController(); abort.abort()
  const fx = clientFixture()
  await assert.rejects(fx.api.loadFeedbackAnnouncementSeen(alice, abort.signal), /ABORTED/)
  assert.equal(fx.calls.length, 0)
  const lateAbort = new AbortController()
  const late = clientFixture(() => { lateAbort.abort(); return { data: { announcement_id: campaign }, error: null } })
  await assert.rejects(late.api.loadFeedbackAnnouncementSeen(alice, lateAbort.signal), /ABORTED/)
  assert.equal(late.api.hasSeenFeedbackAnnouncement(alice), false)
})

test('receipt writes deduplicate by owner, send no client timestamp and clear their deadline', async () => {
  const reply = deferred(), fx = clientFixture(() => reply.promise)
  const first = fx.api.persistFeedbackAnnouncement(alice), duplicate = fx.api.persistFeedbackAnnouncement(alice)
  assert.equal(fx.calls.length, 1)
  assert.deepEqual(plain(fx.calls[0].payload), { user_id: alice, announcement_id: campaign })
  assert.deepEqual(plain(fx.calls[0].options), { onConflict: 'user_id,announcement_id', ignoreDuplicates: true })
  assert.ok(fx.calls[0].signal instanceof AbortSignal)
  assert.equal(fx.timers.size, 1)
  reply.resolve({ data: null, error: null }); await Promise.all([first, duplicate])
  assert.equal(fx.timers.size, 0)
  await fx.api.persistFeedbackAnnouncement(alice)
  assert.equal(fx.calls.length, 1)
})

test('failed and timed out writes can be retried, while separate owners are independent', async () => {
  let failure = true
  const fx = clientFixture(() => ({ data: null, error: failure ? Error('offline') : null }))
  await assert.rejects(fx.api.persistFeedbackAnnouncement(alice), /offline/)
  failure = false
  await fx.api.persistFeedbackAnnouncement(alice); await fx.api.persistFeedbackAnnouncement(bob)
  assert.equal(fx.calls.length, 3)
  const pending = deferred(), timed = clientFixture(() => pending.promise)
  const writing = timed.api.persistFeedbackAnnouncement(alice)
  ;[...timed.timers.values()][0].callback()
  assert.equal(timed.calls[0].signal.aborted, true)
  pending.resolve({ data: null, error: null })
  await assert.rejects(writing, /ABORTED/)
  assert.equal(timed.timers.size, 0)
})

function uiFixture(initialUser = alice) {
  let user = initialUser, authLoading = false, recovery = false, suspended = false, profileUser = initialUser, blocked = false
  let index = 0, dirty = false, sequence = 0, mountedKey, cells = [], effects = [], result
  let modal = false, rect = { top: 0, bottom: 160, height: 160, width: 400 }, style = { display: 'block', visibility: 'visible' }
  const reads = [], writes = [], remembered = new Set(), timers = new Map(), observers = new Set()
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; if (!cells[i]) cells[i] = { value: initial }; const cell = cells[i]; return [cell.value, update => { const next = typeof update === 'function' ? update(cell.value) : update; if (!Object.is(cell.value, next)) { cell.value = next; dirty = true } }] },
    useRef(initial) { const i = index++; if (!cells[i]) cells[i] = { current: initial }; return cells[i] },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: callback, deps }; return cells[i].value },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps, callback, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const eventTarget = () => { const listeners = new Map(); return {
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    emit(name, event = {}) { for (const callback of [...(listeners.get(name) || [])]) callback(event) },
    listenerCount() { return [...listeners.values()].reduce((sum, value) => sum + value.size, 0) },
  } }
  const window = { ...eventTarget(), innerHeight: 800 }
  const document = { ...eventTarget(), visibilityState: 'visible', body: {}, querySelectorAll: () => modal ? [{ getClientRects: () => [rect] }] : [] }
  const element = { isConnected: true, getBoundingClientRect: () => rect }
  class Observer { constructor(callback) { this.callback = callback; observers.add(this) } observe() {} disconnect() { observers.delete(this) } }
  const api = load(componentSource, {
    react: hooks, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    'lucide-react': {}, '../context/AuthContext': { useAuth: () => ({ authUser: user ? { id: user } : null, xelayUser: profileUser ? { id: profileUser } : null, isLoading: authLoading, isPasswordRecovery: recovery }) },
    '../context/OnboardingContext': { useOnboarding: () => ({ suspended }) },
    '../lib/rectorateFeedbackAnnouncement': { feedbackReceiptKey: id => 'receipt:' + (id || 'guest'), XELAY_FEEDBACK_FORM_URL: form,
      hasSeenFeedbackAnnouncement: id => remembered.has(id || 'guest'),
      rememberFeedbackAnnouncement: id => remembered.add(id || 'guest'),
      persistFeedbackAnnouncement: async id => { writes.push(id || 'guest') },
      loadFeedbackAnnouncementSeen: (id, signal) => { const request = { userId: id, signal, ...deferred() }; reads.push(request); return request.promise },
    },
  }, { window, document, AbortController, IntersectionObserver: Observer, MutationObserver: Observer,
    getComputedStyle: target => target === element ? style : { visibility: 'visible' },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
  })
  const cleanup = () => { cells.forEach(cell => cell?.cleanup?.()); cells = []; effects = []; mountedKey = undefined; element.isConnected = false }
  function render() {
    for (let turn = 0; turn < 20; turn++) {
      dirty = false
      const root = api.RectorateFeedbackAnnouncement({ blocked })
      if (!root) { cleanup(); result = null; return result }
      if (root.key !== mountedKey) { cleanup(); mountedKey = root.key; element.isConnected = true }
      index = 0; result = root.type(root.props)
      if (result?.props.cardRef) result.props.cardRef.current = element
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return result
    }
    throw Error('Too many renders')
  }
  const flush = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); return render() }
  render()
  return { reads, writes, remembered, timers, window, document, render, flush,
    get shown() { return Boolean(result) }, get props() { return result?.props },
    fire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() } return render() },
    mutate() { for (const observer of [...observers]) observer.callback() },
    setHidden(hidden) { document.visibilityState = hidden ? 'hidden' : 'visible'; document.emit('visibilitychange'); return render() },
    setModal(value) { modal = value; this.mutate(); return render() },
    setRect(next) { rect = { ...rect, ...next }; window.emit('scroll'); return render() },
    setStyle(next) { style = { ...style, ...next }; this.mutate(); return render() },
    switchUser(next, profile = next) { user = next; profileUser = profile; return render() },
    setGates(next) { if ('loading' in next) authLoading = next.loading; if ('recovery' in next) recovery = next.recovery; if ('suspended' in next) suspended = next.suspended; if ('blocked' in next) blocked = next.blocked; return render() },
    strictReplay() { cells.forEach(cell => cell?.cleanup?.()); cells.forEach(cell => { if (cell?.callback) cell.cleanup = cell.callback() }); return render() },
    unmount: cleanup,
  }
}

test('notice waits for its account read and records only after visible dwell without collapsing itself', async () => {
  const fx = uiFixture()
  assert.equal(fx.shown, false); assert.equal(fx.reads.length, 1); assert.equal(fx.writes.length, 0)
  fx.reads[0].resolve(false); await fx.flush()
  assert.equal(fx.shown, true); assert.equal(fx.writes.length, 0)
  fx.fire(1200)
  assert.deepEqual(fx.writes, [alice]); assert.equal(fx.shown, true)
  fx.window.emit('focus'); await fx.flush()
  assert.equal(fx.shown, true, 'Reading the card must not collapse on focus or local receipt')
  fx.unmount(); assert.equal(fx.window.listenerCount(), 0); assert.equal(fx.document.listenerCount(), 0)
})

test('background tabs, obstructing dialogs and offscreen or hidden cards never consume a display', async () => {
  for (const obstruct of [fx => fx.setHidden(true), fx => fx.setModal(true), fx => fx.setRect({ top: 790, bottom: 950 }), fx => fx.setStyle({ visibility: 'hidden' }), fx => fx.setRect({ height: 0, width: 0 })]) {
    const fx = uiFixture(); fx.reads[0].resolve(false); await fx.flush()
    obstruct(fx); fx.fire(1200)
    assert.equal(fx.writes.length, 0); assert.equal(fx.remembered.size, 0)
    fx.unmount()
  }
  const fx = uiFixture(); fx.reads[0].resolve(false); await fx.flush()
  fx.setModal(true); fx.fire(1200); fx.setModal(false); fx.fire(1200)
  assert.deepEqual(fx.writes, [alice]); fx.unmount()
})

test('open and close record once; close hides immediately and remount stays hidden', async () => {
  const fx = uiFixture(); fx.reads[0].resolve(false); await fx.flush()
  fx.props.onOpen(); fx.props.onClose(); fx.render()
  assert.deepEqual(fx.writes, [alice]); assert.equal(fx.shown, false)
  fx.setGates({ blocked: true }); fx.setGates({ blocked: false })
  assert.equal(fx.shown, false); assert.equal(fx.reads.length, 1)
  fx.unmount()
})

test('account switches cancel stale reads and a late previous response cannot show another account notice', async () => {
  const fx = uiFixture(); fx.switchUser(bob)
  assert.equal(fx.reads[0].signal.aborted, true); assert.equal(fx.reads[1].userId, bob)
  fx.reads[0].resolve(false); await fx.flush()
  assert.equal(fx.shown, false)
  fx.reads[1].resolve(false); await fx.flush(); fx.fire(1200)
  assert.deepEqual(fx.writes, [bob]); fx.unmount()
})

test('loading, recovery, onboarding, auth modal and mismatched profile suppress the notice', async () => {
  for (const gate of ['loading', 'recovery', 'suspended', 'blocked']) {
    const fx = uiFixture(); fx.reads[0].resolve(false); await fx.flush()
    fx.setGates({ [gate]: true }); fx.fire(1200)
    assert.equal(fx.shown, false); assert.equal(fx.writes.length, 0); fx.unmount()
  }
  const fx = uiFixture(); fx.switchUser(bob, alice)
  assert.equal(fx.shown, false); assert.equal(fx.reads.length, 1)
  fx.reads[0].resolve(false); await fx.flush()
  assert.equal(fx.shown, false); fx.unmount()
})

test('failed reads retry a bounded number, resume on focus and StrictMode restarts an aborted initial read', async () => {
  const fx = uiFixture()
  fx.reads[0].reject(Error('offline')); await fx.flush(); fx.fire(2000)
  fx.reads[1].reject(Error('offline')); await fx.flush(); fx.fire(4000)
  fx.reads[2].reject(Error('offline')); await fx.flush()
  assert.equal(fx.reads.length, 3); assert.equal(fx.timers.size, 0); assert.equal(fx.shown, false)
  fx.window.emit('focus'); assert.equal(fx.reads.length, 4)
  fx.reads[3].resolve(false); await fx.flush(); assert.equal(fx.shown, true); fx.unmount()
  const strict = uiFixture(); strict.strictReplay()
  assert.equal(strict.reads[0].signal.aborted, true); assert.equal(strict.reads.length, 2)
  strict.reads[0].reject(Error('aborted')); strict.reads[1].resolve(false); await strict.flush()
  assert.equal(strict.shown, true); strict.unmount()
})

test('receipt from a second tab hides the matching card, while other accounts and unrelated keys do not', async () => {
  const fx = uiFixture(); fx.reads[0].resolve(false); await fx.flush()
  fx.remembered.add(bob); fx.window.emit('storage', { key: 'receipt:' + bob }); fx.render()
  assert.equal(fx.shown, true)
  fx.remembered.add(alice); fx.window.emit('storage', { key: 'unrelated' }); fx.render()
  assert.equal(fx.shown, true)
  fx.window.emit('storage', { key: 'receipt:' + alice }); fx.render()
  assert.equal(fx.shown, false); fx.unmount()
})

test('actual notice stays compact in page flow and opens exactly the public form safely without submitting it', async () => {
  const icon = () => React.createElement('svg', { 'aria-hidden': true })
  const api = load(componentSource, { react: React, 'react/jsx-runtime': jsx,
    'lucide-react': { ArrowUpRight: icon, MessageSquareHeart: icon, X: icon },
    '../context/AuthContext': {}, '../context/OnboardingContext': {}, '../lib/rectorateFeedbackAnnouncement': { XELAY_FEEDBACK_FORM_URL: form },
  })
  const html = renderToStaticMarkup(React.createElement(api.RectorateFeedbackNotice, { onOpen() {}, onClose() {} }))
  assert.match(html, /<aside/); assert.match(html, /Готуємо презентацію ректорату КНУ/)
  assert.match(html, /Студенти, старости та викладачі/); assert.ok(html.includes(`href="${form}"`))
  assert.match(html, /target="_blank"/); assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /aria-label="Закрити запрошення залишити відгук"/)
  assert.doesNotMatch(html, /aria-modal|role="(?:alert)?dialog"|inset-0|fixed|<form|<iframe|type="submit"|100vh/)
  assert.doesNotMatch(source + componentSource, /formResponse|entry\.\d+|fetch\(/)
  const home = await read('src/pages/CommunityPage.tsx')
  assert.match(home, /<RectorateFeedbackAnnouncement blocked=\{showAuthModal\}/)
})
