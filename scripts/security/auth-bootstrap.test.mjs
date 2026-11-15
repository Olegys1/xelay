import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthProfileFlight, createAuthReadScope } from '../../src/lib/authBootstrap.ts'
import { createAccountBootstrapReader } from '../../src/lib/authAccountBootstrap.ts'

const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const ok = data => ({ data, error: null, status: 200 })
const bundle = id => ({ profile: ok({ id, full_name: 'Synthetic student' }), roles: ok([]), representative_requests: ok([]),
  memberships: ok([{ group_id: 'synthetic-group', status: 'accepted' }]), teacher: ok({ verified: false, status: 'none' }),
  representative_status: ok({ is_representative: false, owned_group_ids: [], available_request_ids: [], can_create_group: false }) })
const fixture = (...results) => {
  let calls = 0, lastSignal
  const read = createAccountBootstrapReader({ rpc(name) { assert.equal(name, 'xelay_my_account_bootstrap'); calls++
    return { abortSignal(signal) { lastSignal = signal; return Promise.resolve(results.shift()) } }
  } })
  return { read, calls: () => calls, signal: () => lastSignal }
}
async function readOnce(fx, id = 'a') { const scope = createAuthReadScope(); try { return await fx.read(id, scope) } finally { scope.dispose() } }

test('one successful own-account aggregate is one HTTP operation and forwards cancellation', async () => {
  const fx = fixture(ok(bundle('a'))), result = await readOnce(fx)
  assert.equal(fx.calls(), 1); assert.equal(result.profile.data.id, 'a')
  assert.equal(result.teacher.data.verified, false); assert.ok(fx.signal() instanceof AbortSignal)
})

test('only an initially absent exact RPC allows legacy fallback; detected absence is memoized', async () => {
  const fx = fixture({ data: null, error: { code: 'PGRST202', message: 'Missing public.xelay_my_account_bootstrap in schema cache' }, status: 404 })
  assert.equal(await readOnce(fx), null); assert.equal(await readOnce(fx), null); assert.equal(fx.calls(), 1)
  for (const failure of [
    { data: null, error: { code: 'PGRST202', message: 'Missing different_rpc' }, status: 404 },
    { data: null, error: { code: '42501' }, status: 403 },
    { data: null, error: { code: 'PGRST301' }, status: 401 },
    { data: null, error: { code: '57014' }, status: 500 },
    { data: null, error: { code: 'PGRST202', message: 'Missing xelay_my_account_bootstrap' }, status: 503 },
  ]) { const denied = fixture(failure); await assert.rejects(readOnce(denied)); assert.equal(denied.calls(), 1) }
})

test('a known deployment cannot downgrade to legacy requests after later schema failure or absent profile', async () => {
  for (const first of [ok(bundle('a')), ok({ profile: ok(null) })]) {
    const fx = fixture(first, { data: null, error: { code: 'PGRST202', message: 'Missing xelay_my_account_bootstrap' }, status: 404 })
    await readOnce(fx); await assert.rejects(readOnce(fx)); assert.equal(fx.calls(), 2)
  }
})

test('foreign actor, malformed sections and accidental data together with denial are rejected', async () => {
  const foreign = bundle('b'), malformed = bundle('a'), mixed = bundle('a')
  malformed.roles = ok({ role: 'ADMIN' })
  mixed.roles = { data: [{ role: 'ADMIN' }], error: { code: '42501' }, status: 403 }
  for (const data of [foreign, malformed, mixed]) await assert.rejects(readOnce(fixture(ok(data))), /Account response unavailable/)
})

test('160 independent cold identities perform 160 aggregate calls, including duplicate local triggers', async () => {
  let calls = 0
  const actions = Array.from({ length: 160 }, (_, index) => {
    const id = `synthetic-${index}`, flight = createAuthProfileFlight(), wait = deferred()
    const fx = fixture(ok(bundle(id)))
    const work = scope => wait.promise.then(() => fx.read(id, scope)).then(result => {
      assert.equal(result.profile.data.id, id); calls += fx.calls()
    })
    const first = flight.run(id, work), second = flight.run(id, work)
    assert.equal(first, second); wait.resolve(); return Promise.all([first, second])
  })
  await Promise.all(actions); assert.equal(calls, 160)
})

test('same-actor single-flight has no completed role cache and canceled identity never starts stale HTTP', async () => {
  const flight = createAuthProfileFlight(), gate = deferred(); let loads = 0, aborts = 0
  const work = async scope => { loads++; scope.signal.addEventListener('abort', () => { aborts++ }); await scope.read(() => gate.promise) }
  const first = flight.run('a', work), same = flight.run('a', work)
  assert.equal(first, same); await flush()
  const next = flight.run('b', async () => { loads++ })
  await assert.rejects(first, { name: 'AbortError' }); await next
  assert.equal(loads, 2); assert.equal(aborts, 1)
  await flight.run('b', async () => { loads++ }); assert.equal(loads, 3)
  const stale = flight.run('a', async () => { loads++ })
  flight.cancel(); await stale; assert.equal(loads, 3)
  gate.resolve()
})

test('deadline settles a broken transport even when AbortSignal is ignored; late result cannot win', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scope = createAuthReadScope(100), gate = deferred(); let signal
  const read = scope.read(value => { signal = value; return gate.promise })
  await flush(); t.mock.timers.tick(101)
  await assert.rejects(read, { name: 'TimeoutError', code: 'request_timeout' }); assert.equal(signal.aborted, true)
  gate.resolve({ dangerousLateGrant: true }); await flush()
  await assert.rejects(scope.read(() => assert.fail('A timed-out scope started another HTTP call')), { name: 'TimeoutError' })
  scope.dispose()
})
