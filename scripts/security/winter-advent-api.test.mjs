import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const userId = randomUUID(), sessionId = randomUUID()
const time = Date.parse('2026-12-20T12:00:00Z')
const env = { NODE_ENV: 'production', VERCEL_ENV: 'production',
  SUPABASE_URL: 'https://baohfpadxvhqhhjjqtil.supabase.co',
  SUPABASE_ANON_KEY: 'synthetic-public-key', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-key' }
const exports = {}
for (const [path, key] of [['src/lib/winterCampaign.ts', 'campaign'], ['server/winter-advent.ts', 'server']]) {
  const module = { exports: {} }
  const code = ts.transpileModule(await readFile(new URL('../../' + path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  runInNewContext(code, { module, exports: module.exports, Buffer, URL, AbortSignal,
    process: { env: {} }, fetch() { throw Error('Network forbidden in isolated tests') },
    require(name) {
      if (name === '../src/lib/winterCampaign.js') return exports.campaign
      if (name === '@supabase/supabase-js') return { createClient() { throw Error('No live credentials in tests') } }
      throw Error('Unexpected import ' + name)
    },
  })
  exports[key] = module.exports
}
const { createWinterAdventHandler, winterAdventClock, winterAdventConfiguration } = exports.server
const token = (overrides = {}) => ['synthetic', Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated',
  session_id: sessionId, exp: Math.floor(time / 1000) + 3600, ...overrides })).toString('base64url'), 'verified-by-test-port'].join('.')
const request = (extra = {}) => ({ method: 'GET', url: '/api/winter/advent',
  headers: { authorization: 'Bearer ' + token(), origin: 'https://www.xelay.ink',
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, ...extra })
const response = () => ({ headers: {}, statusCode: 0, body: undefined, setHeader(name, value) { this.headers[name.toLowerCase()] = value },
  end(value) { this.body = JSON.parse(value); this.writableEnded = true } })
const progress = (overrides = {}) => ({ serverNow: '2026-12-20T12:00:00Z', currentDay: 20, phase: 'active',
  eligible: true, ineligibleReason: null, claimedDays: [1], ...overrides })
function harness(options = {}) {
  const calls = [], clients = []
  const handle = createWinterAdventHandler({ environment: options.environment || env, now: options.now || (() => time),
    clientFactory(url, key, config) {
      clients.push({ url, key, config })
      return { auth: { async getUser(value) {
        calls.push({ kind: 'auth', token: value })
        return options.auth || { data: { user: { id: userId, email_confirmed_at: '2026-10-01' } }, error: null }
      } }, async rpc(name, args) {
        calls.push({ kind: 'rpc', name, args, key })
        if (options.rpc) return options.rpc(name, args)
        return { data: progress(args.p_claim_day ? { claimedDays: [...new Set([1, args.p_claim_day])].sort((a, b) => a - b), newlyClaimed: true } : {}), error: null }
      } }
    },
  })
  const run = async req => { const res = response(); await handle(req, res); return res }
  return { handle, run, calls, clients }
}

test('public metadata is private-cache safe and never creates a database client or invents rewards', async () => {
  const h = harness({ environment: {} })
  const result = await h.run(request({ headers: {} }))
  assert.equal(result.statusCode, 200); assert.equal(result.body.eligible, false)
  assert.equal(result.body.ineligibleReason, 'guest'); assert.equal(result.body.userId, null)
  assert.deepEqual(result.body.claimedDays, []); assert.equal(result.body.campaignId, 'winter-2026')
  assert.equal(result.headers['cache-control'], 'no-store, private')
  assert.equal(result.headers.vary, 'Authorization, Origin')
  assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin')
  assert.equal(h.clients.length, 0)
  assert.equal((await h.run(request({ method: 'POST', body: { day: 1 }, headers: {
    origin: 'https://www.xelay.ink', 'content-type': 'application/json' } }))).statusCode, 401)
})

test('verified account and session IDs are the only identity passed to SQL; successful claims and reads share the same contract', async () => {
  const h = harness()
  const read = await h.run(request())
  assert.equal(read.statusCode, 200); assert.equal(read.body.userId, userId)
  assert.deepEqual(read.body.claimedDays, [1]); assert.equal('newlyClaimed' in read.body, false)
  const claim = await h.run(request({ method: 'POST', body: Buffer.from('{"day":7}') }))
  assert.equal(claim.statusCode, 200); assert.equal(claim.body.newlyClaimed, true)
  assert.deepEqual(claim.body.claimedDays, [1, 7])
  const rpcCalls = h.calls.filter(call => call.kind === 'rpc')
  assert.equal(rpcCalls.length, 2)
  assert.equal(rpcCalls[0].name, 'xelay_winter_advent')
  assert.equal(rpcCalls[0].key, env.SUPABASE_SERVICE_ROLE_KEY)
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[1].args)), { p_user_id: userId, p_session_id: sessionId, p_claim_day: 7 })
  assert.equal(h.clients[0].config.auth.persistSession, false)
  assert.equal(h.clients[1].config.global.headers, undefined, 'service calls must not inherit the caller bearer')
  assert.equal(JSON.stringify(claim.body).includes('key'), false)
})

test('origin, method, content type, size and exact payload prevent alternate user, date or reward injection', async () => {
  const h = harness()
  const headers = request().headers
  const malicious = [
    request({ method: 'DELETE' }),
    request({ headers: { ...headers, origin: 'https://evil.example' } }),
    request({ headers: { ...headers, 'sec-fetch-site': 'cross-site' } }),
    request({ method: 'POST', body: { day: 1 }, headers: { ...headers, origin: undefined } }),
    request({ url: '/api/winter/advent?userId=' + randomUUID() }),
    request({ query: { day: '1' } }),
    request({ method: 'POST', body: { day: 1, userId: randomUUID() } }),
    request({ method: 'POST', body: { day: 1, reward: 'max' } }),
    request({ method: 'POST', body: { day: 1, serverNow: '2026-12-31' } }),
    request({ method: 'POST', body: { day: 1, campaignId: 'other' } }),
    request({ method: 'POST', body: '{"day":1,"__proto__":{"admin":true}}' }),
    request({ method: 'POST', body: { day: '1' } }),
    request({ method: 'POST', body: { day: 1.5 } }),
    request({ method: 'POST', body: { day: 0 } }),
    request({ method: 'POST', body: { day: 32 } }),
    request({ method: 'POST', body: [1] }),
    request({ method: 'POST', body: '{broken' }),
    request({ method: 'POST', body: ' '.repeat(257) }),
    request({ method: 'POST', body: { day: 1 }, headers: { ...headers, 'content-type': 'text/plain' } }),
  ]
  for (const req of malicious) assert.ok((await h.run(req)).statusCode >= 400)
  assert.equal(h.calls.length, 0)
})

test('expired, mismatched, malformed, anonymous and unverified sessions never reach the service RPC', async () => {
  for (const claims of [{ sub: randomUUID() }, { role: 'service_role' }, { exp: Math.floor(time / 1000) }, { exp: '99999999999' }, { session_id: null }, { session_id: 'invalid' }]) {
    const h = harness()
    assert.equal((await h.run(request({ headers: { ...request().headers, authorization: 'Bearer ' + token(claims) } }))).statusCode, 401)
    assert.equal(h.calls.filter(call => call.kind === 'rpc').length, 0)
  }
  for (const auth of [
    { data: { user: null }, error: { message: 'private auth detail' } },
    { data: { user: { id: userId, is_anonymous: true, email_confirmed_at: '2026-10-01' } }, error: null },
    { data: { user: { id: 'invalid', email_confirmed_at: '2026-10-01' } }, error: null },
  ]) {
    const h = harness({ auth }); assert.equal((await h.run(request())).statusCode, 401)
    assert.equal(h.calls.filter(call => call.kind === 'rpc').length, 0)
  }
  const h = harness({ auth: { data: { user: { id: userId } }, error: null } })
  const read = await h.run(request()); assert.equal(read.statusCode, 200); assert.equal(read.body.ineligibleReason, 'email_unconfirmed')
  assert.equal((await h.run(request({ method: 'POST', body: { day: 1 } }))).statusCode, 403)
  assert.equal(h.calls.filter(call => call.kind === 'rpc').length, 0)
})

test('database denial, day closure, rate limiting and failures are safely mapped without leaking internals', async () => {
  for (const [code, status, publicCode] of [
    ['42501', 403, 'account_unavailable'], ['PT409', 409, 'day_unavailable'],
    ['PT429', 429, 'rate_limited'], ['22023', 400, 'invalid_request'], ['XX000', 503, 'unavailable'],
  ]) {
    const h = harness({ rpc: async () => ({ data: null, error: { code, message: 'private-database-secret' } }) })
    const result = await h.run(request({ method: 'POST', body: { day: 1 } }))
    assert.equal(result.statusCode, status); assert.equal(result.body.code, publicCode)
    assert.equal(JSON.stringify(result.body).includes('secret'), false)
    if (status === 429) assert.equal(result.headers['retry-after'], '60')
  }
  const unavailable = harness({ rpc: async () => { throw Error('private-exception') } })
  assert.equal((await unavailable.run(request())).statusCode, 503)
  const rejected = harness({ rpc: async () => ({ data: progress({ eligible: false, ineligibleReason: 'account_unavailable', claimedDays: [] }), error: null }) })
  const result = await rejected.run(request()); assert.equal(result.body.eligible, false); assert.deepEqual(result.body.claimedDays, [])
})

test('invalid backend replies fail closed instead of showing fabricated or another account collection', async () => {
  for (const data of [null, {}, progress({ currentDay: 31 }), progress({ phase: 'ended' }),
    progress({ claimedDays: [21] }), progress({ claimedDays: [1, 1] }), progress({ claimedDays: [2, 1] }),
    progress({ claimedDays: ['1'] }), progress({ eligible: false, ineligibleReason: 'account_unavailable' }),
    progress({ serverNow: 'not a date' })]) {
    const h = harness({ rpc: async () => ({ data, error: null }) })
    assert.equal((await h.run(request())).statusCode, 503)
  }
  const h = harness({ rpc: async () => ({ data: progress({ newlyClaimed: true }), error: null }) })
  assert.equal((await h.run(request({ method: 'POST', body: { day: 7 } }))).statusCode, 503)
})

test('server window follows Kyiv midnight and configuration never targets an arbitrary Supabase host', async () => {
  assert.equal(winterAdventClock(Date.parse('2026-11-30T21:59:59Z')).currentDay, 0)
  assert.equal(winterAdventClock(Date.parse('2026-11-30T22:00:00Z')).currentDay, 1)
  assert.equal(winterAdventClock(Date.parse('2026-12-31T21:59:59Z')).phase, 'active')
  assert.equal(winterAdventClock(Date.parse('2026-12-31T22:00:00Z')).phase, 'ended')
  assert.equal(winterAdventConfiguration({ ...env, SUPABASE_URL: 'https://evil.example' }).enabled, false)
  assert.equal(winterAdventConfiguration({ ...env, WINTER_ADVENT_ENABLED: 'false' }).enabled, false)
  const h = harness({ environment: { ...env, VERCEL_ENV: 'preview', VERCEL_URL: 'branch.vercel.app' } })
  assert.equal((await h.run(request({ headers: { ...request().headers, origin: 'https://branch.vercel.app' } }))).statusCode, 200)
  assert.equal((await h.run(request({ headers: { ...request().headers, origin: 'https://other.vercel.app' } }))).statusCode, 403)
})

test('bounded preflight caps a simultaneous burst and releases slots after completion', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const h = harness({ rpc: async () => { await waiting; return { data: progress(), error: null } } })
  const runs = Array.from({ length: 6 }, () => h.run(request()))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.filter(call => call.kind === 'rpc').length, 4)
  release()
  const results = await Promise.all(runs)
  assert.equal(results.filter(result => result.statusCode === 200).length, 4)
  assert.equal(results.filter(result => result.statusCode === 429).length, 2)
  assert.equal((await h.run(request())).statusCode, 200)
})
