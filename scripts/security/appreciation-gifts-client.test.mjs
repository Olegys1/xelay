// Execute the actual client with inert sessions/RPCs/clocks. No live imports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(await readFile(new URL('../../src/lib/appreciationGifts.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
const giftId = '33333333-3333-4333-8333-333333333333', notificationId = '44444444-4444-4444-8444-444444444444'
const pending = patch => ({ id: giftId, notification_id: notificationId, recipient_name: 'Synthetic first name', offered_at: '2026-10-26T10:00:00Z',
  claimed_at: null, valid_from: null, valid_until: null, newly_claimed: false, badge_key: 'community_spark', badge_name: 'Іскра Xelay', badge_earned: false, badge_visible: true, ...patch })
const claimed = patch => pending({ claimed_at: '2026-10-26T10:01:00Z', valid_from: '2026-10-26T10:01:00Z', valid_until: '2026-11-26T10:01:00Z', newly_claimed: true, badge_earned: true, ...patch })
const badge = patch => ({ badge_key: 'community_spark', badge_name: 'Іскра Xelay', earned: true, visible: true, ...patch })
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
class CustomEventMock { constructor(type, options) { this.type = type; this.detail = options?.detail } }

function fixture(options = {}) {
  const exports = {}, calls = [], timers = new Map(), listeners = new Set(), events = []
  let session = { user: { id: owner } }, timerId = 0, checks = 0
  const supabase = { auth: {
    onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe() { listeners.delete(callback) } } } } },
    async getSession() { checks++; return options.session ? options.session(checks, session) : { data: { session }, error: null } },
  }, rpc(name, args) { const call = { name, args }; calls.push(call); return { abortSignal(signal) { call.signal = signal; return options.rpc ? options.rpc(call) : Promise.resolve({ data: [], error: null }) } } } }
  vm.runInNewContext(code, { exports, AbortController, DOMException, Error, Date, CustomEvent: CustomEventMock,
    setTimeout(callback, ms) { assert.equal(ms, 18000); const id = ++timerId; timers.set(id, callback); return id }, clearTimeout(id) { timers.delete(id) },
    window: { dispatchEvent(event) { events.push(event); return true } },
    require(name) { assert.equal(name, './supabase'); return { supabase } },
  })
  return { api: exports, calls, timers, listeners, events, get checks() { return checks },
    auth(event, value) { session = value; for (const callback of [...listeners]) callback(event, value) },
    expire() { for (const [id, callback] of timers) { timers.delete(id); callback() } },
  }
}

test('parser binds the fixed badge and rejects inconsistent claims, grants and impossible dates', () => {
  const { api } = fixture()
  assert.deepEqual(plain(api.parseAppreciationGift(pending())), pending())
  assert.deepEqual(plain(api.parseAppreciationGift(claimed())), claimed())
  for (const value of [null, [], {}, pending({ id: 'wrong' }), pending({ notification_id: 'wrong' }), pending({ recipient_name: 'x'.repeat(81) }),
    pending({ badge_name: 'Other badge' }), pending({ badge_key: 'other' }), pending({ badge_earned: true }), pending({ badge_visible: 'true' }),
    pending({ offered_at: '2026-02-30T10:00:00Z' }), pending({ offered_at: '2026-10-26T10:00:00' }), pending({ newly_claimed: true }),
    pending({ valid_until: '2026-11-26T10:01:00Z' }), claimed({ badge_earned: false }), claimed({ valid_from: null }), claimed({ valid_until: '2026-10-26T10:01:00Z' })]) {
    assert.throws(() => api.parseAppreciationGift(value), /Не вдалося перевірити/)
  }
})

test('own list is bounded and rejects duplicate gift or notification receipts', async () => {
  const fx = fixture({ rpc: async () => ({ data: [pending()], error: null }) })
  assert.deepEqual(plain(await fx.api.loadAppreciationGifts(owner)), [pending()])
  assert.equal(fx.calls[0].name, 'xelay_my_appreciation_gifts'); assert.deepEqual(plain(fx.calls[0].args), {})
  assert.equal(fx.checks, 2); assert.equal(fx.listeners.size, 0); assert.equal(fx.timers.size, 0)
  for (const data of [{}, [pending(), pending()], [pending(), pending({ id: other })], Array.from({ length: 21 }, () => pending())]) {
    const bad = fixture({ rpc: async () => ({ data, error: null }) })
    await assert.rejects(bad.api.loadAppreciationGifts(owner), /Не вдалося перевірити/)
  }
})

test('offer carries only exact recipient and explicit greeting; claim binds gift receipt and replay state', async () => {
  const fx = fixture({ rpc: async call => ({ data: call.name.includes('claim') ? claimed({ newly_claimed: false }) : pending(), error: null }) })
  await fx.api.offerAppreciationGift(owner, other, undefined, '  Synthetic first name  ')
  assert.deepEqual(plain(fx.calls[0].args), { p_user_id: other, p_greeting_name: 'Synthetic first name' })
  assert.equal(fx.calls[0].name, 'xelay_admin_offer_appreciation_gift')
  assert.equal((await fx.api.claimAppreciationGift(owner, giftId)).newly_claimed, false)
  assert.deepEqual(plain(fx.calls[1].args), { p_gift_id: giftId }); assert.equal(fx.events[0].type, 'xelay:appreciation-badges-changed')
  for (const data of [pending(), claimed({ id: other })]) {
    const bad = fixture({ rpc: async () => ({ data, error: null }) })
    await assert.rejects(bad.api.claimAppreciationGift(owner, giftId), /Не вдалося перевірити/)
    assert.equal(bad.events.length, 0)
  }
  const invalid = fixture()
  await assert.rejects(invalid.api.offerAppreciationGift(owner, 'wrong'))
  await assert.rejects(invalid.api.offerAppreciationGift(owner, other, undefined, 'x'.repeat(81)))
  await assert.rejects(invalid.api.claimAppreciationGift(owner, 'wrong'))
  assert.equal(invalid.calls.length, 0)
})

test('public badge access returns only a boolean with no account/session dependency', async () => {
  for (const data of [true, false]) {
    const fx = fixture({ session: () => { throw new Error('Public badge cannot read a session') }, rpc: async () => ({ data, error: null }) })
    assert.equal(await fx.api.loadAppreciationBadge(other), data)
    assert.equal(fx.calls[0].name, 'xelay_appreciation_badge'); assert.deepEqual(plain(fx.calls[0].args), { p_user_id: other })
    assert.equal(fx.checks, 0); assert.equal(fx.listeners.size, 0); assert.equal(fx.timers.size, 0)
  }
  const leaked = fixture({ rpc: async () => ({ data: { visible: true, valid_until: 'PRIVATE' }, error: null }) })
  await assert.rejects(leaked.api.loadAppreciationBadge(other), /Не вдалося перевірити/)
})

test('owner badge save checks exact visibility echo and never changes the target identity', async () => {
  const fx = fixture({ rpc: async call => ({ data: badge({ visible: call.args.p_visible ?? true }), error: null }) })
  assert.equal((await fx.api.loadMyAppreciationBadge(owner)).earned, true)
  assert.equal((await fx.api.saveMyAppreciationBadge(owner, false)).visible, false)
  assert.deepEqual(plain(fx.calls[1].args), { p_visible: false }); assert.equal(fx.events[0].type, 'xelay:appreciation-badges-changed')
  const mismatch = fixture({ rpc: async () => ({ data: badge(), error: null }) })
  await assert.rejects(mismatch.api.saveMyAppreciationBadge(owner, false), /Не вдалося перевірити/)
  assert.equal(mismatch.events.length, 0)
})

test('wrong initial/final identity and sign-out reject private results and release listeners', async () => {
  for (const changedAt of [1, 2]) {
    const fx = fixture({ session: count => ({ data: { session: { user: { id: count === changedAt ? other : owner } } }, error: null }), rpc: async () => ({ data: claimed(), error: null }) })
    await assert.rejects(fx.api.claimAppreciationGift(owner, giftId), /акаунт|Акаунт/)
    assert.equal(fx.calls.length, changedAt === 1 ? 0 : 1); assert.equal(fx.events.length, 0); assert.equal(fx.listeners.size, 0)
  }
  const wait = deferred(), fx = fixture({ rpc: () => wait.promise })
  const work = fx.api.claimAppreciationGift(owner, giftId); await tick()
  fx.auth('SIGNED_OUT', null)
  await assert.rejects(work, /Акаунт змінився/)
  assert.equal(fx.calls[0].signal.aborted, true); assert.equal(fx.listeners.size, 0); assert.equal(fx.timers.size, 0)
  wait.resolve({ data: claimed(), error: null }); await tick(); assert.equal(fx.events.length, 0)
})

test('timeouts and external cancellation settle noncooperative private and public calls without late actions', async () => {
  for (const method of ['claim', 'public']) {
    const wait = deferred(), fx = fixture({ rpc: () => wait.promise })
    const work = method === 'claim' ? fx.api.claimAppreciationGift(owner, giftId) : fx.api.loadAppreciationBadge(other)
    await tick(); fx.expire(); await assert.rejects(work, /Відповідь затримується/)
    assert.equal(fx.listeners.size, 0); assert.equal(fx.timers.size, 0)
    wait.resolve({ data: method === 'claim' ? claimed() : true, error: null }); await tick(); assert.equal(fx.events.length, 0)
  }
  const controller = new AbortController(); controller.abort()
  const fx = fixture()
  await assert.rejects(fx.api.loadAppreciationGifts(owner, controller.signal))
  assert.equal(fx.calls.length, 0); assert.equal(fx.listeners.size, 0); assert.equal(fx.timers.size, 0)
})

test('provider errors and thrown transport details are sanitized; invalid badge data never becomes a mark', async () => {
  for (const response of [async () => ({ data: null, error: { message: 'PRIVATE_SERVER_DETAIL' } }), async () => { throw new Error('PRIVATE_SERVER_DETAIL') }]) {
    const fx = fixture({ rpc: response })
    await assert.rejects(fx.api.loadAppreciationGifts(owner), error => /Не вдалося перевірити/.test(error.message) && !error.message.includes('PRIVATE_SERVER_DETAIL'))
    assert.equal(fx.listeners.size, 0); assert.equal(fx.timers.size, 0)
  }
  const fx = fixture({ rpc: async () => ({ data: { ...badge(), earned: 'true' }, error: null }) })
  await assert.rejects(fx.api.loadMyAppreciationBadge(owner), /Не вдалося перевірити/)
})
