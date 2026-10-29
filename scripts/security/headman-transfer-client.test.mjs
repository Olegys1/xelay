// Run the production transport with isolated Auth/RPC and clocks. No network,
// account, working database, environment key or real transfer is used here.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const source = ts.transpileModule(await readFile(new URL('src/lib/studyGroupRepresentativeTransfer.ts', root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const actor = '11111111-1111-4111-8111-111111111111', target = '22222222-2222-4222-8222-222222222222'
const group = '33333333-3333-4333-8333-333333333333', request = '44444444-4444-4444-8444-444444444444'
const other = '55555555-5555-4555-8555-555555555555'
const receipt = { group_id: group, previous_representative_id: actor, representative_id: target, request_id: request, transferred_at: '2026-10-29T12:00:00Z', replayed: false }
const status = { is_representative: true, owned_group_ids: [group], available_request_ids: [], can_create_group: false }
const native = value => JSON.parse(JSON.stringify(value))
const session = id => ({ data: { session: id ? { user: { id } } : null }, error: null })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
function fixture(options = {}) {
  let listener, sessions = 0, unsubscribed = 0, nextTimer = 0
  const calls = [], signals = [], timers = new Map(), printed = []
  const supabase = { auth: {
    onAuthStateChange: fn => { listener = fn; return { data: { subscription: { unsubscribe() { unsubscribed++ } } } } },
    getSession: async () => { const index = sessions++; return options.session ? options.session(index) : session(actor) },
  }, rpc: (name, args) => ({ abortSignal(signal) {
    calls.push({ name, args }); signals.push(signal)
    return options.rpc ? options.rpc(name, args, signal) : Promise.resolve({ data: name.endsWith('_status') ? status : receipt, error: null })
  } }) }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require(name) { assert.equal(name, './supabase'); return { supabase } },
    window: { setTimeout(fn, delay) { const key = ++nextTimer; timers.set(key, { fn, delay }); return key }, clearTimeout(key) { timers.delete(key) } },
    AbortController, AbortSignal, Date, console: { log: (...x) => printed.push(x), warn: (...x) => printed.push(x), error: (...x) => printed.push(x) },
    fetch() { throw new Error('Network forbidden') },
  })
  return { api: module.exports, calls, signals, timers, printed, sessions: () => sessions, unsubscribed: () => unsubscribed,
    emit: (event, id) => listener?.(event, id ? { user: { id } } : null),
    fire: () => { const entries = [...timers.values()]; timers.clear(); for (const { fn } of entries) fn() },
  }
}
const transfer = (fx, signal) => fx.api.transferStudyGroupRepresentative(actor, group, target, actor, request, signal)
function clean(fx, count = 1) {
  assert.equal(fx.timers.size, 0); assert.equal(fx.unsubscribed(), count); assert.equal(fx.printed.length, 0)
}

test('current role parser projects only bounded UUID capabilities and rejects impossible or malformed data', () => {
  const { api } = fixture()
  assert.deepEqual(native(api.parseRepresentativeStatus({ ...status, email: 'private@example.test' })), {
    isRepresentative: true, ownedGroupIds: [group], availableRequestIds: [], canCreateGroup: false,
  })
  assert.deepEqual(native(api.parseRepresentativeStatus({ is_representative: false, owned_group_ids: [], available_request_ids: [], can_create_group: false })), {
    isRepresentative: false, ownedGroupIds: [], availableRequestIds: [], canCreateGroup: false,
  })
  for (const value of [null, [], {}, { ...status, is_representative: 1 }, { ...status, can_create_group: null },
    { ...status, owned_group_ids: [group, group] }, { ...status, available_request_ids: ['../foreign'] },
    { ...status, owned_group_ids: Array(201).fill(group) }, { ...status, is_representative: false },
    { ...status, is_representative: false, owned_group_ids: [], can_create_group: true }]) assert.throws(() => api.parseRepresentativeStatus(value))
})

test('legacy fallback recognizes only the missing role RPC, not unrelated or transient failures', () => {
  const { api } = fixture()
  for (const code of ['PGRST202', '42883']) assert.equal(api.isRepresentativeStatusMissing({ code, message: 'Missing public.xelay_my_study_group_representative_status()' }), true)
  for (const error of [null, {}, { code: 'PGRST202', message: 'different_function' }, { code: '42501', message: 'xelay_my_study_group_representative_status' }, { code: '503', message: 'temporary unavailable' }]) assert.equal(api.isRepresentativeStatusMissing(error), false)
})

test('transfer sends exact target/group/retry identity, derives actor on server and projects the bound receipt', async () => {
  const fx = fixture()
  assert.deepEqual(native(await transfer(fx)), { groupId: group, previousRepresentativeId: actor, representativeId: target, requestId: request, transferredAt: receipt.transferred_at, replayed: false })
  assert.deepEqual(native(fx.calls), [{ name: 'xelay_transfer_study_group_representative', args: {
    p_group_id: group, p_new_representative_id: target, p_expected_representative_id: actor, p_request_id: request,
  } }])
  assert.equal(fx.sessions(), 2); clean(fx)
  const retry = fixture({ rpc: () => Promise.resolve({ data: { ...receipt, replayed: true, email: 'private@example.test' }, error: null }) })
  assert.equal((await transfer(retry)).replayed, true); assert.equal(retry.calls[0].args.p_request_id, request); clean(retry)
})

test('status request sends no actor-controlled scope or private profile fields', async () => {
  const fx = fixture()
  assert.equal((await fx.api.loadRepresentativeStatus(actor)).isRepresentative, true)
  assert.deepEqual(native(fx.calls), [{ name: 'xelay_my_study_group_representative_status', args: {} }]); clean(fx)
})

test('self transfer, forged expected owner and invalid IDs are rejected before Auth or transport work', async () => {
  const fx = fixture()
  for (const args of [[actor, group, actor, actor, request], [actor, group, target, other, request], ['bad', group, target, actor, request], [actor, '../group', target, actor, request], [actor, group, 'bad', actor, request], [actor, group, target, actor, 'bad']]) {
    await assert.rejects(fx.api.transferStudyGroupRepresentative(...args))
  }
  assert.equal(fx.sessions(), 0); assert.equal(fx.calls.length, 0); clean(fx, 0)
})

test('both preflight and post-response session identities fence all receipt disclosure', async () => {
  for (const id of [other, null]) {
    const before = fixture({ session: () => session(id) })
    await assert.rejects(transfer(before), /Увійдіть/); assert.equal(before.calls.length, 0); clean(before)
    const after = fixture({ session: index => session(index ? id : actor) })
    await assert.rejects(transfer(after), /Акаунт змінився/); assert.equal(after.calls.length, 1); clean(after)
  }
})

test('foreign, partial and malformed receipts never report success', async () => {
  for (const data of [null, [], {}, { ...receipt, group_id: other }, { ...receipt, previous_representative_id: other },
    { ...receipt, representative_id: other }, { ...receipt, request_id: other }, { ...receipt, replayed: 'true' },
    { ...receipt, transferred_at: 'yesterday' }, { ...receipt, transferred_at: '2026-10-29Tinvalid' },
    { ...receipt, transferred_at: '2026-10-29T' + 'x'.repeat(100) }]) {
    const fx = fixture({ rpc: () => Promise.resolve({ data, error: null }) })
    await assert.rejects(transfer(fx), /перевірити результат/); clean(fx)
  }
})

test('server conflicts and permission errors have useful bounded messages without SQL or personal data', async () => {
  const cases = [
    ['PT409', 'REPRESENTATIVE_TRANSFER_STALE', /вже змінився/],
    ['22023', 'REPRESENTATIVE_TRANSFER_REQUEST_REUSED', /вже використано/],
    ['42501', 'REPRESENTATIVE_TRANSFER_NOT_OWNER', /лише поточний староста/],
    ['42501', 'REPRESENTATIVE_TRANSFER_TARGET_NOT_ACCEPTED', /прийняв запрошення/],
    ['42501', 'REPRESENTATIVE_TRANSFER_ACCOUNT_UNAVAILABLE', /прийняв запрошення/],
    ['42501', 'REPRESENTATIVE_TRANSFER_AUTH_REQUIRED', /Увійдіть/],
    ['22023', 'REPRESENTATIVE_TRANSFER_INVALID_ARGUMENT', /Перевірте вибраного/],
    ['PGRST202', 'missing RPC', /поки недоступна/],
    ['XX000', 'unexpected SQL failure', /перевірити права/],
  ]
  for (const [code, message, expected] of cases) {
    const fx = fixture({ rpc: () => Promise.resolve({ data: receipt, error: { code, message: message + ' private@example.test SELECT secret FROM sensitive' } }) })
    await assert.rejects(transfer(fx), error => expected.test(error.message) && !/private@|SELECT|secret|sensitive/.test(error.message)); clean(fx)
  }
})

async function promptly(promise, cancel) {
  let outcome = 'pending'
  promise.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await flush(); cancel(); await flush()
  assert.equal(outcome, 'rejected', 'cancellation must settle even an uncooperative transport')
}
test('20-second timeout settles hung Auth and hung RPC without retries or leaked subscriptions', async () => {
  for (const stage of ['auth', 'rpc']) {
    const stuck = deferred(), fx = fixture(stage === 'auth' ? { session: () => stuck.promise } : { rpc: () => stuck.promise })
    const pending = transfer(fx)
    await flush(); assert.equal([...fx.timers.values()][0].delay, 20000)
    await promptly(pending, fx.fire); clean(fx)
    assert.equal(fx.calls.length, stage === 'auth' ? 0 : 1)
    stuck.resolve(stage === 'auth' ? session(actor) : { data: receipt, error: null }); await flush()
    assert.equal(fx.calls.length, stage === 'auth' ? 0 : 1)
  }
})

test('caller cancellation, signout and account switch fence late responses with no automatic reattempt', async () => {
  for (const reason of ['caller', 'signout', 'account']) {
    const stuck = deferred(), fx = fixture({ rpc: () => stuck.promise }), controller = new AbortController()
    const pending = transfer(fx, controller.signal)
    await promptly(pending, () => reason === 'caller' ? controller.abort() : fx.emit(reason === 'signout' ? 'SIGNED_OUT' : 'SIGNED_IN', reason === 'account' ? other : null))
    assert.equal(fx.signals[0].aborted, true); assert.equal(fx.calls.length, 1); clean(fx)
    stuck.resolve({ data: receipt, error: null }); await flush(); assert.equal(fx.sessions(), 1)
  }
})

test('already-aborted requests create no sessions, calls or outstanding timers', async () => {
  const fx = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(transfer(fx, controller.signal)); assert.equal(fx.sessions(), 0); assert.equal(fx.calls.length, 0); clean(fx)
})

test('network exceptions yield uncertainty and never imply either failure-to-commit or success', async () => {
  const fx = fixture({ rpc: () => Promise.reject(new Error('private@example.test sensitive SQL')) })
  await assert.rejects(transfer(fx), error => /перевірити результат/.test(error.message) && !/private|sensitive/.test(error.message))
  assert.equal(fx.calls.length, 1); clean(fx)
})

test('rejected Auth promises do not expose SDK messages before or after a transfer', async () => {
  for (const stage of [0, 1]) {
    const fx = fixture({ session: index => index === stage ? Promise.reject(new Error('private@example.test sensitive provider payload')) : session(actor) })
    await assert.rejects(transfer(fx), error => /перевірити результат/.test(error.message) && !/private|sensitive|provider/.test(error.message))
    assert.equal(fx.calls.length, stage); clean(fx)
  }
})
