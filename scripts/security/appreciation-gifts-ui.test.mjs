// Actual client code with inert provider/session/timer dependencies. The React
// hook session below uses mocked gift calls; nothing can contact a real service.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as runtime from 'react/jsx-runtime'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const compile = (source, jsx = false) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
} }).outputText
const experienceCode = compile(await readFile(new URL('../../src/components/community/AppreciationGiftExperience.tsx', import.meta.url), 'utf8'), true)
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const giftId = '33333333-3333-4333-8333-333333333333'
const notificationId = '44444444-4444-4444-8444-444444444444'
const foreignId = '55555555-5555-4555-8555-555555555555'
const pendingGift = (changes = {}) => ({ id: giftId, notification_id: notificationId, recipient_name: 'Synthetic recipient', badge_key: 'community_spark', badge_name: 'Іскра Xelay', badge_earned: false, badge_visible: true,
  offered_at: '2026-10-26T10:00:00+00:00', claimed_at: null, valid_from: null, valid_until: null, newly_claimed: false, ...changes })
const claimedGift = (changes = {}) => pendingGift({ badge_earned: true, claimed_at: '2026-10-26T10:01:00Z', valid_from: '2026-10-26T10:01:00Z',
  valid_until: '2026-11-26T10:01:00Z', newly_claimed: true, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(setImmediate)
const json = value => JSON.parse(JSON.stringify(value))
class CustomEventMock extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail } }

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
  const AppreciationGiftCard = () => null
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
      if (name === '../../lib/appreciationGifts') return {
        APPRECIATION_GIFT_EVENT: 'xelay-appreciation-gift-open', APPRECIATION_REFRESH_EVENT: 'xelay-appreciation-gift-refresh',
        loadAppreciationGifts: async (...args) => { calls.push(['load', ...args]); return options.load ? options.load(...args) : [pendingGift()] },
        claimAppreciationGift: async (...args) => { calls.push(['claim', ...args]); return options.claim ? options.claim(...args) : claimedGift() },
      }
      if (name === './AppreciationGiftCard') return { AppreciationGiftCard }
            throw new Error('Unexpected live dependency: ' + name)
    },
  })
  function render() {
    for (let attempts = 0; attempts < 12; attempts++) {
      dirty = false; cursor = 0; tree = exports.AppreciationGiftExperience({ blocked })
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
    open(requestedNotification = notificationId) { window.dispatchEvent(new CustomEventMock('xelay-appreciation-gift-open', { detail: { userId: authUser.id, notificationId: requestedNotification } })) },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

test('experience waits for preferences then opens a pending gift without another provider load', async () => {
  const fx = experienceFixture({ preferences: { loading: true } })
  await fx.flush(); assert.equal(fx.card(), undefined)
  fx.setPreferences({ loading: false })
  assert.equal(fx.card().claimed, false)
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

test('an explicit notification opened behind a birthday or blocking screen is queued for the same recipient', async () => {
  const fx = experienceFixture({ preferences: { enabled: false } })
  fx.setBlocked(true); fx.open(); await fx.flush()
  assert.equal(fx.card(), undefined)
  fx.setBlocked(false); await fx.flush()
  assert.ok(fx.card(), 'the notification remains explicitly open after the preceding card closes')
  fx.unmount()
  const changed = experienceFixture({ preferences: { enabled: false } })
  changed.setBlocked(true); changed.open(); changed.setUser(other); changed.setBlocked(false); await changed.flush()
  assert.equal(changed.card(), undefined, 'a previous account notification is never replayed into another account')
  changed.unmount()
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
    assert.equal(fx.card().claimed, true)
    assert.equal(fx.card().burst, newly_claimed ? 1 : 0)
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
    if (change !== 'unmount') { await fx.flush(); assert.equal(fx.card()?.claimed ?? false, false) }
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

test('the production card uses the saved greeting and entitlement date, reports errors, and respects a hidden badge', async () => {
  const exports = {}, source = await readFile(new URL('../../src/components/community/AppreciationGiftCard.tsx', import.meta.url), 'utf8')
  vm.runInNewContext(compile(source, true), { exports, require(name) {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return runtime
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => React.createElement('svg') })
    if (name.endsWith('.css')) return {}
    throw new Error('Unexpected card dependency: ' + name)
  } })
  const props = { claimed: false, busy: false, burst: 0, recipientName: 'Тестове ім’я', onClaim() {}, onClose() {} }
  const pending = renderToStaticMarkup(React.createElement(exports.AppreciationGiftCard, { ...props, error: 'Повторіть спробу' }))
  assert.match(pending, /Тестове ім’я,/); assert.match(pending, /role="alert"/); assert.match(pending, /Повторіть спробу/)
  assert.doesNotMatch(pending, /kn\.vanov|Настю|26 листопада/)
  assert.match(pending, /community-thanks-hero/); assert.match(pending, /community-spark-mark/)
  assert.match(pending, />ти неймовірна!<\/h2>/); assert.doesNotMatch(pending, /pumpkin|halloween-scene/)
  assert.match(pending, /Бейдж «Іскра Xelay»/)
  const claimed = renderToStaticMarkup(React.createElement(exports.AppreciationGiftCard, { ...props, claimed: true, validUntil: '2027-03-09T12:00:00Z', badgeVisible: false, burst: 1 }))
  assert.match(claimed, /9 березня 2027/); assert.match(claimed, /можна показати в налаштуваннях/)
  assert.match(claimed, /Тестове ім’я,/); assert.match(claimed, />ти неймовірна!<\/h2>/)
  assert.doesNotMatch(claimed, /Бейдж уже прикрашає/)
  assert.equal((claimed.match(/--birthday-x:/g) || []).length, 32)
})

test('public badge cache deduplicates, expires, remains bounded and invalidates after claim or visibility changes', async () => {
  const source = await readFile(new URL('../../src/lib/appreciationBadgeCache.ts', import.meta.url), 'utf8')
  const exports = {}, window = new EventTarget(), calls = []
  let now = 0, visible = true
  vm.runInNewContext(compile(source), { exports, window, Date: { now: () => now }, require(name) {
    assert.equal(name, './appreciationGifts')
    return { APPRECIATION_BADGES_CHANGED: 'badges', loadAppreciationBadge: async id => { calls.push(id); return visible } }
  } })
  const load = exports.loadCachedAppreciationBadge
  const one = load(owner), two = load(owner)
  assert.equal(one, two); assert.equal(await one, true); assert.equal(calls.length, 1)
  visible = false; window.dispatchEvent(new Event('badges'))
  assert.equal(await load(owner), false); assert.equal(calls.length, 2)
  now = 60_001; await load(owner); assert.equal(calls.length, 3)
  for (let i = 0; i < 64; i++) await load(String(i))
  await load(owner); assert.equal(calls.length, 68, 'old entries are evicted after 64 public profiles')
})

function badgeFixture(options = {}) {
  const slots = [], effects = [], calls = [], exports = {}, window = new EventTarget()
  let cursor = 0, dirty = false, tree, userId = owner
  const hooks = {
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: initial }; return [slots[index].value, next => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true } }] },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() } }) },
  }
  const badge = { badge_key: 'community_spark', badge_name: 'Іскра Xelay', earned: true, visible: true }
  vm.runInNewContext(options.code, { exports, AbortController, window, CustomEvent: CustomEventMock, require(name) {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return runtime
    if (name === 'lucide-react') return { Loader2: () => null }
    if (name === '../BadgeInfo') return { BadgeInfo: () => null }
    if (name === './AppreciationGiftCard') return { CommunitySparkMark: () => null }
    if (name === '../../lib/appreciationBadgeCache') return { loadCachedAppreciationBadge: async () => true }
    if (name === '../../lib/appreciationGifts') return {
      APPRECIATION_BADGES_CHANGED: 'badges',
      loadMyAppreciationBadge: async (...args) => { calls.push(['load', ...args]); return options.load ? options.load(...args) : badge },
      saveMyAppreciationBadge: async (...args) => { calls.push(['save', ...args]); return options.save ? options.save(...args) : { ...badge, visible: args[1] } },
    }
    throw new Error('Unexpected badge dependency: ' + name)
  } })
  function render() {
    for (let i = 0; i < 12; i++) {
      cursor = 0; dirty = false; tree = exports.AppreciationBadgeSettings({ userId })
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('Badge hooks did not settle')
  }
  function* nodes(node = tree) { if (!React.isValidElement(node)) return; yield node; for (const child of React.Children.toArray(node.props.children)) yield* nodes(child) }
  const toggle = () => [...nodes()].find(node => node.type === 'input')
  render()
  return { calls, render, toggle, flush: async () => { await tick(); render() },
    change: value => toggle()?.props.onChange({ target: { checked: value } }),
    setUser(id) { userId = id; render() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

test('earned badge can be hidden and restored without changing the entitlement; failed saves require reconfirmation', async () => {
  const code = compile(await readFile(new URL('../../src/components/community/AppreciationBadge.tsx', import.meta.url), 'utf8'), true)
  const fx = badgeFixture({ code }); await fx.flush()
  assert.equal(fx.toggle().props.checked, true)
  await fx.change(false); await fx.flush(); assert.equal(fx.toggle().props.checked, false)
  await fx.change(true); await fx.flush(); assert.equal(fx.toggle().props.checked, true)
  assert.deepEqual(fx.calls.filter(([name]) => name === 'save').map(call => call.slice(1, 3)), [[owner, false], [owner, true]])
  fx.unmount()
  const failed = badgeFixture({ code, save: async () => { throw new Error('SYNTHETIC_PROVIDER_DETAIL') } }); await failed.flush()
  await failed.change(false); await failed.flush(); assert.equal(failed.toggle(), undefined)
  failed.unmount()
  const unearned = badgeFixture({ code, load: async () => ({ earned: false, visible: false }) }); await unearned.flush()
  assert.equal(unearned.toggle(), undefined); assert.equal(unearned.calls.some(([name]) => name === 'save'), false); unearned.unmount()
})

test('an old badge save cannot render into another account or unlock a newer save after an account round trip', async () => {
  const code = compile(await readFile(new URL('../../src/components/community/AppreciationBadge.tsx', import.meta.url), 'utf8'), true)
  const first = deferred(), second = deferred(); let requests = 0
  const fx = badgeFixture({ code, save: () => (++requests === 1 ? first : second).promise }); await fx.flush()
  const old = fx.change(false); fx.render()
  const oldSignal = fx.calls.find(([name]) => name === 'save')[3]
  fx.setUser(other); await fx.flush(); fx.setUser(owner); await fx.flush()
  assert.equal(oldSignal.aborted, true)
  const current = fx.change(false); fx.render(); assert.equal(fx.toggle().props.disabled, true)
  first.resolve({ earned: true, visible: false }); await old; await fx.flush()
  assert.equal(fx.toggle().props.disabled, true); assert.equal(fx.toggle().props.checked, true)
  second.resolve({ earned: true, visible: false }); await current; await fx.flush()
  assert.equal(fx.toggle().props.disabled, false); assert.equal(fx.toggle().props.checked, false)
  fx.unmount()
})
