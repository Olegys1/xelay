// Runs the real recurring worker with synthetic providers only. No live config.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../server/notificationRetry.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText

function fixture(options = {}) {
  const calls = [], deadlines = [], exports = {}
  const response = { code: null, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
  const email = {
    notificationPrivateResponse() { calls.push('private-response') },
    authorizeNotificationWorker() { calls.push('authorize'); if (options.unauthorized) throw Error('DENIED') },
    notificationEmailConfiguration({ deadline }) {
      calls.push('email-config'); deadlines.push(deadline)
      if (options.emailUnavailable) throw Error('SYNTHETIC_MAIL_CONFIGURATION')
      return { service: {}, deadline }
    },
    notificationEmailWorkerSchemaReady: async () => { calls.push('schema'); return !options.waitingForSchema },
    deliverNotificationEmail: async () => { calls.push('mail-job'); return { processed: false } },
    notificationEmailWorkerHeartbeat: async () => { calls.push('heartbeat') },
    notificationEmailWorkerDisable: async () => { calls.push('disable') },
    sendNotificationEmailError(res) { calls.push('error-response'); return res.status(options.unauthorized ? 401 : 503).json({ error: 'unavailable' }) },
  }
  const modules = {
    './notificationEmail.js': email,
    './adminRepresentativeAlerts.js': { deliverAdminRepresentativeAlert: async deadline => {
      calls.push('admin-alerts'); deadlines.push(deadline); return { state: 'idle' }
    } },
    './opportunitiesDigest.js': { deliverOpportunitiesDigest: async () => {
      calls.push('digest'); return { state: 'disabled' }
    } },
    './birthdayEvents.js': { processBirthdayEvents: async () => ({ enabled: false, status: 'disabled',
      processed: 0, giftsOffered: 0, groupNotifications: 0, hasMore: false }) },
    './securityMonitor.js': { deliverAdminSecurityAlerts: async deadline => {
      calls.push('security-start'); deadlines.push(deadline)
      await Promise.resolve()
      calls.push('security-settled')
      if (options.securityFailure) throw Error('PRIVATE_PROVIDER_TOKEN_MUST_NOT_LEAK')
      return { enabled: true, processed: false, state: 'idle', logs_coverage: 'not_configured' }
    } },
  }
  vm.runInNewContext(compiled, {
    exports, Date, setTimeout,
    require(name) { assert.ok(Object.hasOwn(modules, name)); return modules[name] },
    fetch() { throw Error('Live network forbidden in integration fixture') },
  })
  return { response, calls, deadlines, run(method = 'POST') { return exports.default({ method }, response) } }
}

test('unauthorized and non-POST requests never start any monitoring or delivery', async () => {
  const denied = fixture({ unauthorized: true })
  await denied.run()
  assert.equal(denied.response.code, 401)
  assert.deepEqual(denied.calls, ['private-response', 'authorize', 'error-response'])
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const fx = fixture()
    await fx.run(method)
    assert.equal(fx.response.code, 405)
    assert.deepEqual(fx.calls, ['private-response'])
  }
})

test('security delivery remains independent of a mail configuration outage', async () => {
  const fx = fixture({ emailUnavailable: true })
  await fx.run()
  assert.equal(fx.response.code, 503)
  assert.ok(fx.calls.indexOf('authorize') < fx.calls.indexOf('security-start'))
  assert.ok(fx.calls.indexOf('security-start') < fx.calls.indexOf('email-config'))
  assert.ok(fx.calls.indexOf('security-settled') < fx.calls.indexOf('error-response'))
  assert.equal(fx.calls.filter(value => value === 'admin-alerts').length, 1)
  assert.equal(fx.calls.filter(value => value === 'security-start').length, 1)
  assert.ok(!fx.calls.includes('mail-job'))
})

test('a monitoring failure cannot stop existing mail delivery or leak its provider error', async () => {
  const fx = fixture({ securityFailure: true })
  await fx.run()
  assert.equal(fx.response.code, 200)
  assert.equal(fx.response.body.healthy, true)
  assert.equal(fx.response.body.security_monitor, null)
  assert.ok(fx.calls.includes('mail-job'))
  assert.ok(fx.calls.includes('heartbeat'))
  assert.ok(!fx.calls.includes('disable'))
  assert.doesNotMatch(JSON.stringify(fx.response.body), /PRIVATE_|TOKEN|PROVIDER/)
})

test('mail schema waiting still returns the independently completed monitoring status', async () => {
  const fx = fixture({ waitingForSchema: true })
  await fx.run()
  assert.equal(fx.response.code, 200)
  assert.equal(fx.response.body.waiting_for_migration, true)
  assert.equal(fx.response.body.security_monitor.logs_coverage, 'not_configured')
  assert.ok(fx.calls.includes('security-settled'))
  assert.ok(!fx.calls.includes('mail-job'))
})

test('every optional delivery shares the bounded authorized worker deadline', async () => {
  const fx = fixture()
  const before = Date.now()
  await fx.run()
  assert.equal(fx.response.code, 200)
  // Later individual mail jobs deliberately receive a shorter 12-second cap.
  assert.equal(new Set(fx.deadlines.slice(0, 3)).size, 1)
  assert.ok(fx.deadlines.every(deadline => deadline <= fx.deadlines[0]))
  assert.ok(fx.deadlines[0] >= before + 52000 && fx.deadlines[0] <= Date.now() + 53000)
  assert.equal(fx.calls.filter(value => value === 'security-start').length, 1)
  assert.equal(fx.response.body.security_monitor.logs_coverage, 'not_configured')
})
