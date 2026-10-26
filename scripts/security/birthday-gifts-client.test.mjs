// Actual client code with inert provider/session/timer dependencies. The React
// hook session below uses mocked gift calls; nothing can contact a real service.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as runtime from 'react/jsx-runtime'

const compile = (source, jsx = false) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
} }).outputText
const clientCode = compile(await readFile(new URL('../../src/lib/birthdayGifts.ts', import.meta.url), 'utf8'))
const experienceCode = compile(await readFile(new URL('../../src/components/birthday/BirthdayGiftExperience.tsx', import.meta.url), 'utf8'), true)
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const giftId = '33333333-3333-4333-8333-333333333333'
const notificationId = '44444444-4444-4444-8444-444444444444'
const foreignId = '55555555-5555-4555-8555-555555555555'
const pendingGift = (changes = {}) => ({ id: giftId, notification_id: notificationId, recipient_name: 'Synthetic recipient', gift_year: 2026,
  offered_at: '2026-10-26T10:00:00+00:00', claimed_at: null, valid_from: null, valid_until: null, newly_claimed: false, ...changes })
const claimedGift = (changes = {}) => pendingGift({ claimed_at: '2026-10-26T10:01:00Z', valid_from: '2026-10-26T10:01:00Z',
  valid_until: '2026-11-26T10:01:00Z', newly_claimed: true, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(setImmediate)
const json = value => JSON.parse(JSON.stringify(value))
class CustomEventMock extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail } }

function clientFixture(options = {}) {
  const exports = {}, calls = [], timers = new Map(), listeners = new Set(), events = []
  let session = { user: { id: owner } }, timerId = 0, unsubscribed = 0, sessionChecks = 0
  const supabase = {
    auth: {
      onAuthStateChange(callback) {
        listeners.add(callback)
        return { data: { subscription: { unsubscribe() { listeners.delete(callback); unsubscribed++ } } } }
      },
      async getSession() {
        sessionChecks++
        return options.session ? options.session(sessionChecks, session) : { data: { session }, error: null }
      },
    },
    rpc(name, args) {
      const call = { name, args, signal: null }; calls.push(call)
      return { abortSignal(signal) {
        call.signal = signal
        return options.rpc ? options.rpc(call) : Promise.resolve({ data: [], error: null })
      } }
    },
  }
  vm.runInNewContext(clientCode, {
    exports, AbortController, DOMException, Error, Date,
    setTimeout(callback, ms) { assert.equal(ms, 18000); const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    window: { dispatchEvent(event) { events.push(event); return true } }, CustomEvent: CustomEventMock,
    require(name) { if (name === './supabase') return { supabase }; throw new Error('Unexpected live dependency: ' + name) },
  })
  return { api: exports, calls, timers, events,
    get unsubscribed() { return unsubscribed }, get sessionChecks() { return sessionChecks }, get listeners() { return listeners.size },
    setSession(value) { session = value },
    auth(event, value) { session = value; for (const callback of [...listeners]) callback(event, value) },
    expire() { for (const [id, callback] of timers) { timers.delete(id); callback() } },
  }
}

test('gift parser accepts pending and claimed contracts and rejects inconsistent dates and state', () => {
  const { api } = clientFixture()
  assert.deepEqual(json(api.parseBirthdayGift(pendingGift())), pendingGift())
  assert.deepEqual(json(api.parseBirthdayGift(claimedGift())), claimedGift())
  for (const malformed of [null, [], {}, pendingGift({ id: 'wrong' }), pendingGift({ notification_id: 'wrong' }),
    pendingGift({ recipient_name: 'x'.repeat(301) }), pendingGift({ gift_year: 2026.5 }), pendingGift({ gift_year: 1999 }),
    pendingGift({ offered_at: 'not-a-date' }), pendingGift({ offered_at: '2026-10-26T10:00:00' }),
    pendingGift({ offered_at: '2026-13-26T10:00:00Z' }), pendingGift({ claimed_at: undefined }),
    pendingGift({ valid_until: '2026-11-26T10:00:00Z' }), pendingGift({ newly_claimed: true }),
    claimedGift({ valid_from: null }), claimedGift({ valid_until: null }),
    claimedGift({ valid_until: '2026-10-26T10:01:00Z' }), claimedGift({ valid_until: '2026-09-26T10:01:00Z' }),
  ]) assert.throws(() => api.parseBirthdayGift(malformed), /Не вдалося перевірити подарунок/)
})

test('parser rejects impossible calendar dates instead of accepting Date.parse normalization', () => {
  const { api } = clientFixture()
  for (const stamp of ['2026-02-30T10:00:00Z', '2026-04-31T10:00:00+00:00', '2026-02-29T10:00:00Z']) {
    assert.throws(() => api.parseBirthdayGift(pendingGift({ offered_at: stamp })), /Не вдалося перевірити подарунок/)
  }
})

test('list validates its bound, duplicate gift/notification IDs and only calls the own-list RPC', async () => {
  const fx = clientFixture({ rpc: async () => ({ data: [pendingGift()], error: null }) })
  assert.deepEqual(json(await fx.api.loadBirthdayGifts(owner)), [pendingGift()])
  assert.equal(fx.calls[0].name, 'xelay_my_birthday_gifts')
  assert.deepEqual(json(fx.calls[0].args), {})
  assert.equal(fx.calls[0].signal.aborted, false)
  assert.equal(fx.sessionChecks, 2)
  assert.equal(fx.timers.size, 0); assert.equal(fx.listeners, 0); assert.equal(fx.unsubscribed, 1)
  for (const result of [{}, [pendingGift(), pendingGift()],
    [pendingGift(), pendingGift({ id: foreignId })],
    Array.from({ length: 21 }, (_, index) => pendingGift({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })),
  ]) {
    const bad = clientFixture({ rpc: async () => ({ data: result, error: null }) })
    await assert.rejects(bad.api.loadBirthdayGifts(owner), /Не вдалося перевірити подарунок/)
    assert.equal(bad.timers.size, 0); assert.equal(bad.listeners, 0)
  }
})

test('claim binds response gift ID, requires claimed state and accepts replay without another celebration', async () => {
  for (const newly_claimed of [true, false]) {
    const gift = claimedGift({ newly_claimed }), fx = clientFixture({ rpc: async () => ({ data: gift, error: null }) })
    const result = await fx.api.claimBirthdayGift(owner, giftId)
    assert.equal(result.newly_claimed, newly_claimed)
    assert.equal(fx.calls[0].name, 'xelay_claim_birthday_gift')
    assert.deepEqual(json(fx.calls[0].args), { p_gift_id: giftId })
  }
  for (const data of [pendingGift(), claimedGift({ id: foreignId })]) {
    const fx = clientFixture({ rpc: async () => ({ data, error: null }) })
    await assert.rejects(fx.api.claimBirthdayGift(owner, giftId), /Не вдалося перевірити подарунок/)
  }
  const invalid = clientFixture()
  await assert.rejects(invalid.api.claimBirthdayGift(owner, 'bad-id'))
  await assert.rejects(invalid.api.offerBirthdayGift(owner, 'bad-id'))
  await assert.rejects(invalid.api.loadBirthdayGifts('bad-id'))
  assert.equal(invalid.calls.length, 0)
})

test('offer passes only the selected recipient and sanitizes provider error details', async () => {
  const fx = clientFixture({ rpc: async () => ({ data: pendingGift(), error: null }) })
  await fx.api.offerBirthdayGift(owner, other)
  assert.equal(fx.calls[0].name, 'xelay_admin_offer_birthday_gift')
  assert.deepEqual(json(fx.calls[0].args), { p_user_id: other, p_greeting_name: '' })
  await fx.api.offerBirthdayGift(owner, other, undefined, '  Аліна  ')
  assert.deepEqual(json(fx.calls[1].args), { p_user_id: other, p_greeting_name: 'Аліна' })
  for (const name of ['x'.repeat(81), 'Аліна\n', '\tАліна', 'Аліна\u007f']) {
    await assert.rejects(fx.api.offerBirthdayGift(owner, other, undefined, name))
  }
  assert.equal(fx.calls.length, 2, 'invalid greeting never reaches provider')
  for (const message of ['RAW_PROVIDER_SECRET', 'BIRTHDAY_GIFT_UNAVAILABLE', 'MFA_REQUIRED']) {
    const broken = clientFixture({ rpc: async () => ({ data: null, error: { message } }) })
    await assert.rejects(broken.api.loadBirthdayGifts(owner), error => !error.message.includes(message))
  }
})

test('wrong initial or final session prevents a result from reaching the former account', async () => {
  const wrong = clientFixture(); wrong.setSession({ user: { id: other } })
  await assert.rejects(wrong.api.loadBirthdayGifts(owner), /Увійдіть у свій акаунт/)
  assert.equal(wrong.calls.length, 0)
  const changed = clientFixture({ session: async check => ({ data: { session: { user: { id: check === 1 ? owner : other } } }, error: null }), rpc: async () => ({ data: [pendingGift()], error: null }) })
  await assert.rejects(changed.api.loadBirthdayGifts(owner), /Акаунт змінився/)
  assert.equal(changed.calls.length, 1)
  assert.equal(changed.timers.size, 0); assert.equal(changed.listeners, 0)
})

test('sign-out and account change abort a noncooperative provider immediately and ignore its late success', async () => {
  for (const [event, session] of [['SIGNED_OUT', null], ['SIGNED_IN', { user: { id: other } }]]) {
    const waiting = deferred(), fx = clientFixture({ rpc: () => waiting.promise })
    const work = fx.api.claimBirthdayGift(owner, giftId)
    const rejected = assert.rejects(work, /Акаунт змінився/)
    await tick(); assert.equal(fx.calls.length, 1)
    fx.auth(event, session)
    await rejected
    assert.equal(fx.calls[0].signal.aborted, true)
    assert.equal(fx.timers.size, 0); assert.equal(fx.listeners, 0)
    waiting.resolve({ data: claimedGift(), error: null }); await tick()
    assert.equal(fx.sessionChecks, 1)
  }
})

test('external abort and an already aborted signal release subscriptions and suppress provider calls/results', async () => {
  const stopped = new AbortController(); stopped.abort()
  const before = clientFixture()
  await assert.rejects(before.api.loadBirthdayGifts(owner, stopped.signal), error => error.name === 'AbortError')
  assert.equal(before.calls.length, 0); assert.equal(before.sessionChecks, 0)
  assert.equal(before.timers.size, 0); assert.equal(before.listeners, 0)
  const waiting = deferred(), controller = new AbortController(), during = clientFixture({ rpc: () => waiting.promise })
  const work = during.api.loadBirthdayGifts(owner, controller.signal)
  const rejected = assert.rejects(work, error => error.name === 'AbortError')
  await tick(); controller.abort(); await rejected
  assert.equal(during.calls[0].signal.aborted, true)
  assert.equal(during.timers.size, 0); assert.equal(during.listeners, 0)
  waiting.resolve({ data: [pendingGift()], error: null }); await tick()
})

test('timeout settles a hung session check or provider and cleans up, without issuing late calls', async () => {
  for (const phase of ['session', 'provider']) {
    const waiting = deferred(), fx = clientFixture(phase === 'session'
      ? { session: () => waiting.promise } : { rpc: () => waiting.promise })
    const work = fx.api.loadBirthdayGifts(owner)
    const rejected = assert.rejects(work, /Відповідь затримується/)
    await tick(); fx.expire(); await rejected
    assert.equal(fx.timers.size, 0); assert.equal(fx.listeners, 0)
    if (phase === 'provider') assert.equal(fx.calls[0].signal.aborted, true)
    waiting.resolve(phase === 'session' ? { data: { session: { user: { id: owner } } }, error: null } : { data: [pendingGift()], error: null })
    await tick()
    assert.equal(fx.calls.length, phase === 'session' ? 0 : 1)
  }
})

function experienceFixture(options = {}) {
  const exports = {}, slots = [], effects = [], calls = [], timers = new Map(), events = []
  const window = new EventTarget(), document = { visibilityState: 'visible' }, storage = new Map()
  let cursor = 0, dirty = false, tree, timerId = 0, authUser = { id: owner }, blocked = false
  let preferences = { loading: false, enabled: true, ...options.preferences }
  const hooks = {
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: initial }; return [slots[index].value, next => {
      const value = typeof next === 'function' ? next(slots[index].value) : next
      if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true }
    }] },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useEffect(callback, deps) { const index = cursor++, old = slots[index]
      if (!old || deps.length !== old.deps.length || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects.push(() => {
        old?.cleanup?.(); slots[index] = { deps, cleanup: callback() }
      })
    },
  }
  window.setTimeout = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id }
  window.clearTimeout = id => timers.delete(id)
  const dispatch = window.dispatchEvent.bind(window)
  window.dispatchEvent = event => { events.push(event); return dispatch(event) }
  const BirthdayGiftCard = () => null
  vm.runInNewContext(experienceCode, {
    exports, AbortController, CustomEvent: CustomEventMock, window, document,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return runtime
      if (name === '../../context/AuthContext') return { useAuth: () => ({ authUser }) }
      if (name === '../../context/BillingContext') return { useBilling: () => ({ refreshBilling: async () => { calls.push(['billing']); return true } }) }
      if (name === '../../context/NotificationPreferencesContext') return { useNotificationPreferences: () => ({ preferences: { notificationsEnabled: preferences.enabled }, loading: preferences.loading }) }
      if (name === '../../context/ToastContext') return { useToast: () => ({ notify: value => calls.push(['toast', value]) }) }
      if (name === '../../lib/birthdayGifts') return {
        BIRTHDAY_GIFT_EVENT: 'xelay-birthday-gift-open', BIRTHDAY_REFRESH_EVENT: 'xelay-birthday-gift-refresh',
        loadBirthdayGifts: async (...args) => { calls.push(['load', ...args]); return options.load ? options.load(...args) : [pendingGift()] },
        claimBirthdayGift: async (...args) => { calls.push(['claim', ...args]); return options.claim ? options.claim(...args) : claimedGift() },
      }
      if (name === './BirthdayGiftCard') return { BirthdayGiftCard }
      throw new Error('Unexpected live dependency: ' + name)
    },
  })
  function render() {
    for (let attempts = 0; attempts < 12; attempts++) {
      dirty = false; cursor = 0; tree = exports.BirthdayGiftExperience({ blocked })
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('Hook session did not settle')
  }
  const flush = async () => { await tick(); render() }
  const card = () => tree?.props.children?.props
  render()
  return { calls, events, timers, card, flush, render,
    setUser(id) { authUser = id ? { id } : null; render() },
    setBlocked(value) { blocked = value; render() },
    setPreferences(value) { preferences = { ...preferences, ...value }; render() },
    claim() { return card()?.onClaim() },
    close() { card()?.onClose(); render() },
    open(requestedNotification = notificationId) { window.dispatchEvent(new CustomEventMock('xelay-birthday-gift-open', { detail: { userId: authUser.id, notificationId: requestedNotification } })) },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

test('experience waits for preferences then opens a pending gift without another provider load', async () => {
  const fx = experienceFixture({ preferences: { loading: true } })
  await fx.flush(); assert.equal(fx.card(), undefined)
  fx.setPreferences({ loading: false })
  assert.equal(fx.card().claimedAt, null)
  assert.equal(fx.calls.filter(([name]) => name === 'load').length, 1)
  fx.unmount()
})

test('disabled notifications suppress automatic card but an explicit notification opens it, and dismissal persists', async () => {
  const fx = experienceFixture({ preferences: { enabled: false } })
  await fx.flush(); assert.equal(fx.card(), undefined)
  fx.open(); await fx.flush(); assert.ok(fx.card())
  fx.close(); assert.equal(fx.card(), undefined)
  fx.setPreferences({ enabled: true }); assert.equal(fx.card(), undefined)
  fx.open(); await fx.flush(); assert.ok(fx.card())
  fx.unmount()
})

test('manual failed or unavailable notification lookups report a visible toast without exposing provider details', async () => {
  for (const unavailable of [true, false]) {
    let reads = 0
    const fx = experienceFixture({ preferences: { enabled: false }, load: async () => {
      if (++reads === 1) return [pendingGift()]
      if (unavailable) return []
      throw new Error('RAW_PROVIDER_SECRET')
    } })
    await fx.flush(); fx.open(); await fx.flush()
    const toast = fx.calls.find(([name]) => name === 'toast')?.[1]
    assert.ok(toast)
    assert.equal(toast.tone, 'error')
    assert.match(toast.title, unavailable ? /недоступний/ : /Не вдалося відкрити/)
    assert.doesNotMatch(JSON.stringify(toast), /RAW_PROVIDER_SECRET/)
    fx.unmount()
  }
})

test('experience claim refreshes access/read markers and celebrates only a new claim, never a replay', async () => {
  for (const newly_claimed of [true, false]) {
    const fx = experienceFixture({ claim: async () => claimedGift({ newly_claimed }) })
    await fx.flush(); assert.ok(fx.card())
    await fx.claim(); await fx.flush()
    assert.equal(fx.card().claimedAt, claimedGift().claimed_at)
    assert.equal(fx.card().celebrating, newly_claimed)
    assert.equal(fx.calls.filter(([name]) => name === 'billing').length, 1)
    assert.equal(fx.events.filter(event => event.type === 'xelay-notifications-updated').length, 1)
    await fx.claim(); assert.equal(fx.calls.filter(([name]) => name === 'claim').length, 1)
    fx.unmount()
  }
})

test('experience aborts claims on account change, block and unmount without rendering stale success', async () => {
  for (const change of ['account', 'block', 'unmount']) {
    const waiting = deferred(), fx = experienceFixture({ claim: () => waiting.promise })
    await fx.flush(); const work = fx.claim(); fx.render()
    const signal = fx.calls.find(([name]) => name === 'claim')[3]
    if (change === 'account') fx.setUser(other)
    else if (change === 'block') fx.setBlocked(true)
    else fx.unmount()
    assert.equal(signal.aborted, true)
    waiting.resolve(claimedGift()); await work
    if (change !== 'unmount') { await fx.flush(); assert.equal(fx.card()?.claimedAt ?? null, null) }
    assert.equal(fx.calls.filter(([name]) => name === 'billing').length, 0)
    assert.equal(fx.events.filter(event => event.type === 'xelay-notifications-updated').length, 0)
    fx.unmount()
  }
})

test('stale same-account claim finalizer cannot unlock a newer claim after an account round trip', async () => {
  const first = deferred(), second = deferred(); let attempts = 0
  const fx = experienceFixture({ claim: () => (++attempts === 1 ? first : second).promise })
  await fx.flush(); const oldWork = fx.claim(); fx.render()
  fx.setUser(other); await fx.flush(); fx.setUser(owner); await fx.flush()
  const newWork = fx.claim(); fx.render(); assert.equal(fx.card().busy, true)
  first.resolve(claimedGift()); await oldWork; await fx.flush()
  assert.equal(fx.card().busy, true, 'old request must not clear the current request busy state')
  void fx.claim()
  assert.equal(fx.calls.filter(([name]) => name === 'claim').length, 2, 'newer claim lock remains held')
  second.resolve(claimedGift()); await newWork; await fx.flush()
  assert.equal(fx.card().busy, false)
  fx.unmount()
})
