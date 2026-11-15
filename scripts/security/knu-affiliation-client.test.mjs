// Production client in a VM with synthetic Auth and transport. Never contacts a provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireDependency = createRequire(process.env.XELAY_TEST_DEPENDENCY_ROOT ? resolve(process.env.XELAY_TEST_DEPENDENCY_ROOT, 'package.json') : import.meta.url)
const ts = requireDependency('typescript')
const root = new URL('../../', import.meta.url)
const source = name => readFileSync(new URL(name, root), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const actor = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002'
const challengeId = '20000000-0000-4000-8000-000000000001'
const empty = { verifiedEmail: null, verifiedAt: null, authEmailVerified: false }
const challenge = { id: challengeId, email: 'synthetic@knu.ua', expiresAt: '2026-11-03T12:10:00Z', resendAt: '2026-11-03T12:01:00Z' }
const confirmed = { verifiedEmail: 'synthetic@knu.ua', verifiedAt: '2026-11-03T12:02:00Z', authEmailVerified: false }
const session = id => ({ data: { session: id ? { user: { id }, access_token: 'synthetic-token' } : null }, error: null })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function timers() {
  let next = 0; const pending = new Map()
  return { pending, setTimeout(callback, ms) { const id = ++next; pending.set(id, { callback, ms }); return id }, clearTimeout(id) { pending.delete(id) }, fire() { const rows = [...pending.values()]; pending.clear(); rows.forEach(row => row.callback()) } }
}
function evaluate(path, imports, globals = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, AbortController, AbortSignal, Date, ...globals,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Unexpected import: ' + name); return imports[name] },
  })
  return module.exports
}
const policy = evaluate('src/lib/knuEmailPolicy.ts', {})
function fixture(options = {}) {
  const clock = timers(), calls = [], printed = []; let listener, unsubscribed = 0, sessions = 0, userReads = 0
  const api = evaluate('src/lib/knuAffiliation.ts', { './knuEmailPolicy': policy, './supabase': { supabase: {} } }, {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch() { assert.fail('Live fetch is forbidden') },
    localStorage: new Proxy({}, { get() { assert.fail('No credentials or OTP in storage') } }),
    sessionStorage: new Proxy({}, { get() { assert.fail('No credentials or OTP in storage') } }),
    console: { log(...values) { printed.push(values) }, warn(...values) { printed.push(values) }, error(...values) { printed.push(values) } },
  })
  const client = api.createKnuAffiliationClient({
    async getSession() { const index = sessions++; return options.session ? options.session(index) : session(actor) },
    async getUser(token) { userReads++; assert.equal(token, 'synthetic-token'); return options.user ? options.user() : { data: { user: { id: actor } }, error: null } },
    subscribe(callback) { listener = callback; return () => { unsubscribed++ } },
    async fetch(url, init) {
      calls.push({ url, init })
      return options.fetch ? options.fetch(url, init) : { ok: true, status: 200, headers: new Headers(), json: async () => options.payload || empty }
    },
  })
  return { api, client, calls, clock, printed, emit: id => listener?.(id), sessions: () => sessions, userReads: () => userReads, unsubscribed: () => unsubscribed }
}

test('status parser accepts canonical or secondary verification and strips unrelated fields', () => {
  const f = fixture()
  assert.deepEqual(plain(f.api.parseKnuAffiliationStatus(empty)), empty)
  assert.deepEqual(plain(f.api.parseKnuAffiliationStatus({ ...confirmed, authEmailVerified: true, role: 'ADMIN', phone: 'not-public' })), { ...confirmed, authEmailVerified: true })
  assert.deepEqual(plain(f.api.parseKnuAffiliationStatus({ ...empty, challenge })), { ...empty, challenge })
  assert.equal(f.calls.length, 0)
})

test('status parser rejects malformed verification, non-KNU addresses and malformed challenges', () => {
  const f = fixture()
  for (const bad of [null, [], {}, { ...empty, authEmailVerified: 'true' }, { ...confirmed, verifiedAt: null }, { ...empty, verifiedAt: confirmed.verifiedAt },
    { ...confirmed, verifiedEmail: 'synthetic@gmail.com' }, { ...confirmed, verifiedEmail: 'synthetic@univ.knu.ua' },
    ...[{ ...challenge, id: 'not-a-uuid' }, { ...challenge, email: 'person@example.test' }, { ...challenge, expiresAt: 'invalid' }, { ...challenge, resendAt: '2026-11-03T13:00:00Z' }].map(value => ({ ...empty, challenge: value })),
  ]) assert.throws(() => f.api.parseKnuAffiliationStatus(bad), /KNU_EMAIL_RESPONSE_INVALID/)
})

test('invalid domain and invalid OTP never create Auth or transport work', async () => {
  const f = fixture()
  for (const email of ['person@gmail.com', 'person@univ.knu.ua', 'person@knu.ua.evil.test', 'person＠knu.ua', 'a..b@knu.ua']) await assert.rejects(f.client.request(actor, email), /KNU_EMAIL_INVALID/)
  for (const code of ['12345', '1234567', '12 456', '１２３４５６', 123456]) await assert.rejects(f.client.verify(actor, challengeId, code), /KNU_EMAIL_CODE_INVALID/)
  assert.equal(f.calls.length, 0); assert.equal(f.sessions(), 0)
})

test('request and verification send only narrow bodies and preserve a leading-zero code', async () => {
  const f = fixture()
  await f.client.request(actor, ' Synthetic@KNU.UA ')
  await f.client.verify(actor, challengeId, '001234')
  assert.deepEqual(f.calls.map(call => JSON.parse(call.init.body)), [{ action: 'request', email: 'synthetic@knu.ua' }, { action: 'verify', challengeId, code: '001234' }])
  for (const call of f.calls) {
    assert.equal(call.url, '/api/auth/knu-email'); assert.equal(call.init.method, 'POST')
    assert.equal(call.init.headers.Authorization, 'Bearer synthetic-token'); assert.equal(call.init.credentials, 'omit')
    assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.redirect, 'error')
    assert.doesNotMatch(call.init.body, /userId|user_id|uid|role|password|refresh_token/)
  }
  assert.equal(f.userReads(), 2); assert.equal(f.unsubscribed(), 2); assert.equal(f.clock.pending.size, 0); assert.equal(f.printed.length, 0)
})

test('a status read is GET without a mutation body or a letter request', async () => {
  const f = fixture(); await f.client.status(actor)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.body, undefined)
})

test('wrong or switched Auth identities before dispatch cannot send a request', async () => {
  for (const options of [
    { session: () => session(other) },
    { user: () => ({ data: { user: { id: other } }, error: null }) },
    { session: index => session(index === 0 ? actor : other) },
  ]) {
    const f = fixture(options); await assert.rejects(f.client.request(actor, 'synthetic@knu.ua'), error => /AUTH_REQUIRED|SESSION_CHANGED/.test(error.code))
    assert.equal(f.calls.length, 0); assert.equal(f.unsubscribed(), 1); assert.equal(f.clock.pending.size, 0)
  }
})

test('an account change after the server reply rejects the result instead of displaying another account status', async () => {
  const f = fixture({ session: index => session(index < 2 ? actor : other), payload: confirmed })
  await assert.rejects(f.client.status(actor), error => error.code === 'KNU_EMAIL_SESSION_CHANGED')
  assert.equal(f.calls.length, 1); assert.equal(f.clock.pending.size, 0); assert.equal(f.unsubscribed(), 1)
})

test('account changes and caller abort settle a stuck request and ignore its late success', async () => {
  for (const reason of ['other', 'logout', 'caller']) {
    const stuck = deferred(), f = fixture({ fetch: () => stuck.promise }), controller = new AbortController()
    const pending = f.client.verify(actor, challengeId, '001234', controller.signal)
    let outcome = 'pending'; pending.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
    await flush(); assert.equal(f.calls.length, 1)
    if (reason === 'caller') controller.abort(); else f.emit(reason === 'other' ? other : null)
    await flush(); assert.equal(outcome, 'rejected'); assert.equal(f.calls[0].init.signal.aborted, true)
    stuck.resolve({ ok: true, status: 200, json: async () => confirmed }); await flush()
    assert.equal(outcome, 'rejected'); assert.equal(f.clock.pending.size, 0); assert.equal(f.unsubscribed(), 1)
  }
})

test('timeout also settles an uncooperative Auth promise and already aborted calls do no Auth work', async () => {
  const stuck = deferred(), f = fixture({ session: () => stuck.promise })
  const pending = f.client.status(actor); await flush(); f.clock.fire()
  await assert.rejects(pending, error => error.code === 'KNU_EMAIL_TIMEOUT')
  assert.equal(f.calls.length, 0); assert.equal(f.clock.pending.size, 0); assert.equal(f.unsubscribed(), 1)
  const before = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(before.client.status(actor, controller.signal), error => error.code === 'KNU_EMAIL_ABORTED')
  assert.equal(before.sessions(), 0); assert.equal(before.calls.length, 0); assert.equal(before.clock.pending.size, 0)
})

test('server failures preserve retry delays and expose only local safe messages', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [409, 'KNU_EMAIL_IN_USE'], [429, 'KNU_EMAIL_RATE_LIMIT'], [503, 'KNU_EMAIL_UNAVAILABLE']]) {
    const f = fixture({ fetch: async () => ({ ok: false, status, headers: new Headers(), json: async () => ({ code, error: 'private@example.test provider-secret', retryAfterSeconds: 60 }) }) })
    await assert.rejects(f.client.request(actor, 'synthetic@knu.ua'), failure => {
      assert.equal(failure.retryAfterSeconds, 60); assert.equal(failure.statusCode, status)
      assert.doesNotMatch(f.api.knuAffiliationErrorMessage(failure), /private@example|provider-secret/); return true
    })
    assert.equal(f.printed.length, 0); assert.equal(f.clock.pending.size, 0)
  }
})
