// Synthetic aggregate responses and fake fetch only. Never reads real credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const source = await readFile(new URL('../../server/securityMonitor.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const token = '11111111-1111-4111-8111-111111111111'
const end = Math.floor(Date.now() / 300000) * 300000
const due = { lease_token: token, window_start: new Date(end - 300000).toISOString(), window_end: new Date(end).toISOString() }
const settings = () => ({ projectRef: 'a'.repeat(20), logsToken: 'synthetic-project-scoped-token', deadline: Date.now() + 34000 })
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const row = (source, total, failures = 0, server_errors = 0, access_denials = 0, unknown_status = 0) => ({ source, total, failures, server_errors, access_denials, unknown_status })
function fixture(response) {
  const requests = []
  const context = vm.createContext({ exports: {}, process: { env: {} }, Date, URL, URLSearchParams, TextDecoder, Uint8Array, AbortSignal,
    fetch: async (url, init) => { requests.push({ url: String(url), init }); return typeof response === 'function' ? response(url, init) : response },
    require: name => { if (name === '@supabase/supabase-js') return { createClient: () => { throw Error('no database in collector tests') } }; if (name === './securityMonitorPolicy.js') return {}; throw Error('unmocked import') } })
  vm.runInContext(compiled, context)
  return { module: context.exports, requests, collect: (config = settings(), window = due) => context.exports.collectSecurityMonitorLogs(config, window) }
}

test('one fixed ClickHouse aggregate query reads a complete UTC window and preserves separate sources', async () => {
  const fx = fixture(json({ error: null, result: [row('edge_logs', '1000', '40', '30', '10'), row('auth_logs', 200, 100, 0, 40), row('storage_logs', 50, 15, 0, 15)] }))
  const output = await fx.collect()
  assert.equal(output.coverage, 'healthy')
  assert.equal(fx.requests.length, 1)
  const request = fx.requests[0], url = new URL(request.url)
  assert.equal(url.origin, 'https://api.supabase.com')
  assert.equal(url.pathname, '/v1/projects/' + 'a'.repeat(20) + '/analytics/endpoints/logs')
  assert.equal(url.searchParams.get('sql'), fx.module.SECURITY_MONITOR_LOG_SQL)
  assert.equal(url.searchParams.get('iso_timestamp_start'), due.window_start)
  assert.equal(url.searchParams.get('iso_timestamp_end'), due.window_end)
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.method, 'GET')
  assert.match(request.init.headers.Authorization, /^Bearer synthetic-/)
  assert.match(fx.module.SECURITY_MONITOR_LOG_SQL, /FROM logs WHERE source IN/)
  assert.match(fx.module.SECURITY_MONITOR_LOG_SQL, /log_attributes\['response.status_code'\]/)
  assert.match(fx.module.SECURITY_MONITOR_LOG_SQL, /log_attributes\['res.statusCode'\]/)
  assert.doesNotMatch(fx.module.SECURITY_MONITOR_LOG_SQL, /unnest|event_message|request\.path|ip|email|SELECT \*/i)
  const metrics = Object.fromEntries(output.observations.map(x => [x.kind, x]))
  assert.equal(metrics.request_volume.count, 1000)
  assert.equal(metrics.auth_failures.count, 100)
  assert.equal(metrics.auth_failures.total, 200)
  assert.equal(metrics.api_errors.total, 1000)
  assert.equal(metrics.storage_denials.total, 50)
  assert.equal(output.sources.auth, 'observed')
  assert.doesNotMatch(JSON.stringify(output), /synthetic-project-scoped-token|Authorization/)
})

test('empty capture returns zero aggregates with no_events coverage, never proof of safety', async () => {
  const output = await fixture(json({ result: [], error: null })).collect()
  assert.equal(output.coverage, 'healthy')
  assert.equal(output.observations.length, 5)
  assert.ok(output.observations.every(x => x.count === 0 && x.total === 0 && x.unknown_status === 0))
  assert.deepEqual(Object.values(output.sources), ['no_events', 'no_events', 'no_events'])
})

test('missing status is preserved, never a successful response or added to unique requests', async () => {
  const output = await fixture(json({ result: [row('edge_logs', 100, 20, 15, 5, 30), row('auth_logs', 70, 20, 0, 10, 50)], error: null })).collect()
  assert.equal(output.coverage, 'partial')
  assert.equal(output.error_code, 'logs_partial')
  assert.equal(output.sources.auth, 'unknown_status')
  assert.equal(output.observations.find(x => x.kind === 'auth_failures').unknown_status, 50)
  assert.equal(output.observations.find(x => x.kind === 'api_errors').unknown_status, 30)
  assert.equal(output.observations.find(x => x.kind === 'request_volume').count, 100)
  assert.equal(output.observations.find(x => x.kind === 'request_volume').unknown_status, 0)
})

test('Auth excludes only the two proven non-response signatures; unknown HTTP responses still degrade coverage', async () => {
  const fx = fixture(null)
  const rules = fx.module.SECURITY_MONITOR_AUTH_NON_RESPONSE_RULES
  const excluded = attributes => rules.some(rule => Object.entries(rule).every(([key, allowed]) => allowed.includes(attributes[key] ?? '')))
  const login = { msg: 'Login', action: 'login', metering: 'true', path: '/' }
  const warning = { msg: 'Request received external host in X-Forwarded-Host or Host headers, but the values have not been added to GOTRUE_MAILER_EXTERNAL_HOSTS and will not be used. To suppress this message add the host, or sanitize the headers before the request reaches Auth.', level: 'info', path: '/' }
  for (const attributes of [login, { ...login, path: '' }, warning, { ...warning, path: '' }]) assert.equal(excluded(attributes), true)
  const retained = [
    { msg: 'request completed' }, { msg: 'request panicked', component: 'api', method: 'POST', path: '/token' },
    { msg: 'request completed', status: 'unrecognized', method: 'POST', path: '/token' },
    {}, { msg: null }, { msg: 'unrecognized event' }, { ...login, msg: 'Other login event' }, { ...login, action: 'logout' }, { ...login, metering: 'false' },
    { ...warning, msg: warning.msg + ' unexpected suffix' }, { ...warning, level: 'warn' },
  ]
  for (const attributes of [login, warning]) for (const override of [{ status: '200' }, { status: '403' }, { status: 'unrecognized' }, { method: 'POST' }, { component: 'api' }, { component: 'other' }, { path: '/token' }]) retained.push({ ...attributes, ...override })
  for (const attributes of retained) assert.equal(excluded(attributes), false)
  const sql = fx.module.SECURITY_MONITOR_LOG_SQL
  assert.match(sql, /AND NOT \(source = 'auth_logs' AND/)
  // Ensure every constraint tested above is emitted into the fixed SQL, not
  // merely retained as unused policy data. Only quoted literals are generated.
  for (const rule of rules) for (const [key, allowed] of Object.entries(rule)) {
    assert.ok(sql.includes(`coalesce(log_attributes['${key}'], '') IN (${allowed.map(value => "'" + value.replace(/'/g, "''") + "'").join(', ')})`))
  }
  // Model the verified three-record shape: two operational records and one
  // completed response. Unknown request records remain in that denominator.
  const completed = { msg: 'request completed', component: 'api', method: 'POST', path: '/token', status: '200' }
  const responseRows = [login, warning, completed].filter(attributes => !excluded(attributes))
  assert.deepEqual(responseRows, [completed])
  const healthy = await fixture(json({ error: null, result: [row('auth_logs', responseRows.length)] })).collect()
  assert.equal(healthy.coverage, 'healthy')
  const partial = await fixture(json({ error: null, result: [row('auth_logs', responseRows.length + 1, 0, 0, 0, 1)] })).collect()
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.error_code, 'logs_partial')
})

test('missing/invalid config and invalid/incomplete windows perform no HTTP request', async () => {
  for (const config of [{ ...settings(), logsToken: '' }, { ...settings(), projectRef: '../other' }, { ...settings(), logsToken: 'bad\nheader' }]) {
    const fx = fixture(() => { throw Error('must not fetch') })
    const output = await fx.collect(config)
    assert.equal(output.coverage, 'not_configured')
    assert.equal(fx.requests.length, 0)
    assert.ok(Object.values(output.sources).every(x => x === 'not_configured'))
  }
  for (const window of [{ ...due, window_start: 'raw secret' }, { ...due, window_end: new Date(end + 300000).toISOString() }, { ...due, window_start: new Date(end - 600000).toISOString() }, { ...due, window_start: new Date(end - 299999).toISOString() }]) {
    const fx = fixture(() => { throw Error('must not fetch') })
    assert.equal((await fx.collect(settings(), window)).error_code, 'logs_window_mismatch')
    assert.equal(fx.requests.length, 0)
  }
})

test('402/401/403/429 persist safe coverage and bounded backoff without a paid fallback', async () => {
  for (const [status, code, retry] of [[402, 'logs_payment_required', 21600], [401, 'logs_unauthorized', 3600], [403, 'logs_forbidden', 3600], [429, 'logs_rate_limited', 86400], [503, 'logs_unavailable', 900]]) {
    const fx = fixture(json({ error: 'PRIVATE provider error secret@example.test 203.0.113.1' }, status, { 'retry-after': '99999999' }))
    const output = await fx.collect()
    assert.equal(output.coverage, 'unavailable')
    assert.equal(output.error_code, code)
    assert.equal(output.retry_after_seconds, retry)
    assert.equal(output.observations.length, 0)
    assert.equal(fx.requests.length, 1)
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE|secret@|203\.0/)
  }
})

test('HTTP 200 query errors, malformed aggregates, unknown sources and oversized bodies are unavailable', async () => {
  for (const body of [{ result: [], error: 'SECRET SQL error' }, { result: [], error: {} }, { result: {} }, { result: [null] }, { result: [row('untrusted_source', 1)] }, { result: [row('auth_logs', 10), row('auth_logs', 10)] }, { result: [row('auth_logs', 10, 9, 0, 0, 2)] }, { result: [row('auth_logs', 10, '10 SECRET')] }, { result: [row('auth_logs', -1)] }, { result: [row('auth_logs', 10, 0, 1)] }, { result: [], extra: 'P'.repeat(65536) }]) {
    const output = await fixture(json(body)).collect()
    assert.equal(output.coverage, 'unavailable')
    assert.equal(output.error_code, 'logs_invalid_response')
    assert.equal(output.observations.length, 0)
    assert.doesNotMatch(JSON.stringify(output), /SECRET|SQL error/)
  }
})

test('backoff and deadline stop HTTP; thrown transport errors are sanitized', async () => {
  const fx = fixture(() => { throw Error('PRIVATE TOKEN secret@example.test') })
  const wait = await fx.collect(settings(), { ...due, logs_retry_at: new Date(Date.now() + 600000).toISOString() })
  assert.equal(wait.error_code, 'logs_unavailable')
  assert.ok(wait.retry_after_seconds <= 600)
  assert.equal(fx.requests.length, 0)
  assert.equal((await fx.collect({ ...settings(), deadline: Date.now() + 500 })).error_code, 'logs_timeout')
  assert.equal(fx.requests.length, 0)
  const output = await fx.collect()
  assert.equal(output.error_code, 'logs_unavailable')
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|TOKEN|secret@/)
})
