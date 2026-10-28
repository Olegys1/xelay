// Offline mocks only: no environment credentials, live database, or Telegram requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const sources = await Promise.all(['server/securityMonitorPolicy.ts', 'server/securityMonitor.ts'].map(path => readFile(new URL(path, root), 'utf8')))
const compiled = sources.map(source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
const token = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const end = Math.floor(Date.now() / 300000) * 300000
const due = { lease_token: token, window_start: new Date(end - 300000).toISOString(), window_end: new Date(end).toISOString() }
const alert = { ...due, alert_id: id, kind: 'auth_failures', severity: 'warning', source: 'auth', event_count: 100, total_count: 300, threshold: { min_count: 40, min_ratio: .2, baseline_multiplier: 2 }, created_at: due.window_end, occurrences: 1 }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const env = () => ({ SECURITY_MONITOR_ENABLED: 'true', ADMIN_ALERT_TELEGRAM_ENABLED: 'true', ADMIN_ALERT_TELEGRAM_BOT_TOKEN: '123456:' + 'S'.repeat(35), ADMIN_ALERT_TELEGRAM_CHAT_ID: '-123456', SUPABASE_URL: 'https://' + 'a'.repeat(20) + '.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' })

function fixture(options = {}) {
  const calls = [], requests = [], printed = []
  let clients = 0, clock = Date.now()
  class FakeDate extends Date { static now() { return clock } }
  const service = { rpc: async (name, args) => {
    calls.push({ name, args })
    if (options.rpc) { const response = await options.rpc(name, args, { advance: ms => { clock += ms } }); if (response !== undefined) return response }
    const data = { xelay_security_monitor_due: due, xelay_security_monitor_observe: true, xelay_claim_admin_security_alert: alert, xelay_admin_security_alert_delivery_context: alert, xelay_finish_admin_security_alert: true }[name]
    assert.notEqual(data, undefined, 'unrecognized RPC')
    return { data, error: null }
  } }
  const context = vm.createContext({ exports: {}, process: { env: { ...env(), ...options.env } }, Date: FakeDate, URL, URLSearchParams, TextDecoder, Uint8Array, AbortSignal, Response,
    console: { log: (...x) => printed.push(x), error: (...x) => printed.push(x), warn: (...x) => printed.push(x) },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null })
      if (options.fetch) return options.fetch(String(url), init)
      assert.match(String(url), /^https:\/\/api\.telegram\.org\/bot123456:S{35}\/(getChat|sendMessage)$/)
      return String(url).endsWith('/getChat') ? json({ ok: true, result: { id: -123456, type: 'supergroup' } }) : json({ ok: true, result: { message_id: 15, chat: { id: -123456 } } })
    }, require: name => {
      if (name === '@supabase/supabase-js') return { createClient: () => { clients++; return service } }
      if (name === './securityMonitorPolicy.js') return policy
      throw Error('Unmocked import')
    } })
  vm.runInContext(`(function(exports) { ${compiled[0]} })(exports)`, context)
  const policy = context.exports
  context.exports = {}
  vm.runInContext(`(function(exports) { ${compiled[1]} })(exports)`, context)
  return { module: context.exports, policy, calls, requests, printed, clients: () => clients, deadline: () => clock + 53000 }
}
const lastReceipt = fx => fx.calls.filter(x => x.name === 'xelay_finish_admin_security_alert').at(-1)?.args

test('both flags default off; missing required configuration causes no network or database work', async () => {
  for (const override of [{ SECURITY_MONITOR_ENABLED: undefined }, { ADMIN_ALERT_TELEGRAM_ENABLED: 'false' }, { ADMIN_ALERT_TELEGRAM_BOT_TOKEN: '' }, { ADMIN_ALERT_TELEGRAM_CHAT_ID: '@public' }, { SUPABASE_SERVICE_ROLE_KEY: '' }]) {
    const fx = fixture({ env: override })
    const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
    assert.equal(output.enabled, false)
    assert.equal(fx.clients(), 0)
    assert.equal(fx.calls.length + fx.requests.length, 0)
    assert.notEqual(output.logs_coverage, 'healthy')
  }
})

test('missing optional logs credentials still checks DB signals, then sends only sanitized private-group text', async () => {
  const fx = fixture()
  const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
  assert.equal(output.state, 'sent')
  assert.equal(output.logs_coverage, 'not_configured')
  assert.equal(output.logs_sources.auth, 'not_configured')
  const observation = fx.calls.find(x => x.name === 'xelay_security_monitor_observe').args
  assert.equal(observation.p_coverage, 'not_configured')
  assert.equal(observation.p_error_code, 'logs_not_configured')
  assert.deepEqual(Array.from(observation.p_observations), [])
  assert.deepEqual(fx.requests.map(x => x.url.split('/').at(-1)), ['getChat', 'sendMessage'])
  const sent = fx.requests[1].body
  assert.equal(sent.protect_content, true)
  assert.equal(sent.parse_mode, undefined)
  assert.equal(sent.link_preview_options.is_disabled, true)
  assert.match(sent.text, /не підтвердження атаки/)
  assert.doesNotMatch(sent.text, /synthetic|11111111|22222222|123456/)
  assert.equal(lastReceipt(fx).p_status, 'sent')
  assert.equal(fx.printed.length, 0)
})

test('getChat rejects public, redirected, direct-message and malformed group destinations', async () => {
  for (const info of [{ id: -123456, type: 'private' }, { id: -123456, type: 'channel' }, { id: -999, type: 'supergroup' }, { id: -123456, type: 'supergroup', username: 'public' }, { id: -123456, type: 'supergroup', active_usernames: ['public'] }, { id: -123456, type: 'supergroup', active_usernames: 'public' }, { id: -123456, type: 'supergroup', is_direct_messages: true }]) {
    const fx = fixture({ fetch: () => json({ ok: true, result: info }) })
    assert.equal((await fx.module.deliverAdminSecurityAlerts(fx.deadline())).state, 'retry')
    assert.equal(fx.requests.length, 1)
    assert.equal(lastReceipt(fx).p_error_code, 'telegram_rejected')
  }
})

test('log project must match canonical database URL; a mismatch cannot select another project or link', async () => {
  for (const override of [{ SECURITY_MONITOR_PROJECT_REF: 'b'.repeat(20) }, { SECURITY_MONITOR_PROJECT_REF: '../other' }, { SUPABASE_URL: 'https://custom.example.test', SECURITY_MONITOR_PROJECT_REF: 'a'.repeat(20) }]) {
    const fx = fixture({ env: { SECURITY_MONITOR_SUPABASE_LOGS_TOKEN: 'synthetic-token', ...override } })
    const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
    assert.equal(output.state, 'sent')
    assert.equal(output.logs_coverage, 'not_configured')
    assert.equal(fx.requests.some(x => x.url.startsWith('https://api.supabase.com/')), false)
    assert.equal(fx.calls.find(x => x.name === 'xelay_security_monitor_observe').args.p_error_code, 'logs_not_configured')
    assert.equal(fx.requests.at(-1).body.reply_markup.inline_keyboard[0][0].url, 'https://www.xelay.ink/admin')
  }
})

test('canonical log project ref is derived when no explicit ref is provided', async () => {
  const fx = fixture({ env: { SECURITY_MONITOR_SUPABASE_LOGS_TOKEN: 'synthetic-token' }, fetch: url => {
    if (url.startsWith('https://api.supabase.com/')) { assert.match(url, new RegExp('/projects/' + 'a'.repeat(20) + '/analytics/endpoints/logs')); return json({ error: null, result: [] }) }
    return url.endsWith('/getChat') ? json({ ok: true, result: { id: -123456, type: 'group' } }) : json({ ok: true, result: { message_id: 15, chat: { id: -123456 } } })
  } })
  const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
  assert.equal(output.logs_coverage, 'healthy')
  assert.equal(output.state, 'sent')
  assert.equal(fx.requests.filter(x => x.url.startsWith('https://api.supabase.com/')).length, 1)
})

test('429 on getChat is persisted with bounded retry and no send', async () => {
  const fx = fixture({ fetch: () => json({ ok: false, error_code: 429, description: 'raw provider secret email ip', parameters: { retry_after: 999999999 } }, 429) })
  const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
  assert.equal(output.state, 'retry')
  assert.equal(lastReceipt(fx).p_error_code, 'telegram_rate_limited')
  assert.equal(lastReceipt(fx).p_retry_after_seconds, 86400)
  assert.equal(fx.requests.length, 1)
  assert.doesNotMatch(JSON.stringify([output, fx.calls, fx.printed]), /raw provider|email ip/)
})

test('live delivery context can cancel a leased alert and must match the claimed alert', async () => {
  for (const live of [null, { ...alert, alert_id: '33333333-3333-4333-8333-333333333333' }, { ...alert, kind: '<b>injected</b>' }]) {
    const fx = fixture({ rpc: name => name === 'xelay_admin_security_alert_delivery_context' ? { data: live, error: null } : undefined })
    const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
    assert.equal(output.state, live === null ? 'skipped' : 'retry')
    assert.equal(fx.requests.length, 1)
  }
})

test('lost send receipt is reported without claiming exactly-once delivery', async () => {
  const fx = fixture({ rpc: name => name === 'xelay_finish_admin_security_alert' ? { data: false, error: { message: 'private database message' } } : undefined })
  const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
  assert.equal(output.state, 'receipt_unavailable')
  assert.equal(output.processed, true)
  assert.equal(fx.requests.filter(x => x.url.endsWith('/sendMessage')).length, 1)
  assert.doesNotMatch(JSON.stringify(output), /private database|exactly/)
})

test('provider body, queue metadata and thrown exceptions cannot reach alert text or output', async () => {
  const dirty = { ...alert, full_name: 'Secret Person', email: 'secret@example.test', ip: '203.0.113.1', message: '<b>raw provider message</b>', threshold: { ...alert.threshold, min_count: '<b>untrusted threshold</b>', note: 'SECRET_TOKEN' } }
  const fx = fixture({ rpc: name => ['xelay_claim_admin_security_alert', 'xelay_admin_security_alert_delivery_context'].includes(name) ? { data: dirty, error: null } : undefined })
  assert.equal((await fx.module.deliverAdminSecurityAlerts(fx.deadline())).state, 'sent')
  const text = fx.requests.at(-1).body.text
  assert.doesNotMatch(text, /Secret Person|secret@example|203\.0|raw provider|SECRET_TOKEN|untrusted|<b>/)
  const broken = fixture({ fetch: () => { throw Error('bot_token SECRET_TOKEN secret@example.test') } })
  const output = await broken.module.deliverAdminSecurityAlerts(broken.deadline())
  assert.equal(output.state, 'retry')
  assert.equal(lastReceipt(broken).p_error_code, 'telegram_transport_error')
  assert.doesNotMatch(JSON.stringify([output, broken.printed, lastReceipt(broken)]), /SECRET_TOKEN|secret@example/)
})

test('budget prevents a new delivery lease when collection exhausted delivery time', async () => {
  const fx = fixture({ rpc: (name, args, control) => { if (name === 'xelay_security_monitor_observe') control.advance(15000) } })
  const output = await fx.module.deliverAdminSecurityAlerts(fx.deadline())
  assert.equal(output.state, 'deadline')
  assert.equal(fx.calls.some(x => x.name === 'xelay_claim_admin_security_alert'), false)
  assert.equal(fx.requests.length, 0)
})

test('policy explains volume as a review signal, validates enum metadata, and uses only fixed links', () => {
  const fx = fixture()
  assert.match(fx.policy.formatAdminSecurityAlert({ ...alert, kind: 'request_volume', source: 'api' }), /не доводить DDoS/)
  assert.match(fx.policy.formatAdminSecurityAlert({ ...alert, kind: 'api_errors', source: 'api' }), /стан сервісу/)
  assert.equal(fx.policy.formatAdminSecurityAlert({ ...alert, source: '<b>raw</b>' }), null)
  assert.equal(fx.policy.formatAdminSecurityAlert({ ...alert, kind: '__proto__' }), null)
  assert.equal(fx.policy.formatAdminSecurityAlert({ ...alert, event_count: 'evil' }), null)
  assert.equal(fx.policy.adminSecurityAlertButtons('https://evil.test').inline_keyboard[0][0].url, 'https://www.xelay.ink/admin')
  assert.equal(fx.policy.adminSecurityAlertButtons('a'.repeat(20)).inline_keyboard[0][0].url, 'https://supabase.com/dashboard/project/' + 'a'.repeat(20) + '/logs/explorer')
})
