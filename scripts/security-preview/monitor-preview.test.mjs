// Explicit loopback-only smoke test, deliberately outside the offline security glob.
// Synthetic data only. No production/provider calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { once } from 'node:events'
import { createSecurityMonitorPreviewServer } from '../preview-security-monitor.mjs'

test('local preview serves bounded read-only routes, protected headers and synthetic formatter scenarios', async t => {
  const server = await createSecurityMonitorPreviewServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const read = (path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
  const page = await read('/')
  assert.equal(page.status, 200)
  assert.match(page.body, /Безпека Xelay/)
  assert.match(page.body, /Локальний приклад\. Вигадані дані\. Повідомлення не надсилаються\./)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  const data = JSON.parse((await read('/demo.json')).body)
  assert.equal(data.demonstration, true)
  assert.equal(data.monitoring_enabled, false)
  assert.equal(data.scenarios.find(x => x.id === 'quiet').message, null)
  assert.match(data.scenarios.find(x => x.id === 'api').message, /сигнал про стан сервісу/)
  assert.match(data.scenarios.find(x => x.id === 'auth').message, /не підтвердження атаки/)
  assert.equal(data.scenarios.find(x => x.id === 'partial').coverage, 'partial')
  assert.equal(data.scenarios.find(x => x.id === 'partial').tone, 'warning')
  assert.doesNotMatch(JSON.stringify(data), /https?:|@|11111111|22222222|SUPABASE|TELEGRAM_BOT_TOKEN/)
  for (const path of ['/preview.css', '/preview.js']) assert.equal((await read(path)).status, 200)
  const head = await read('/', 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  for (const path of ['/server/securityMonitor.ts', '/.env', '/../package.json', '/%2e%2e/package.json', '/demo.json?token=x', '/unknown']) assert.equal((await read(path)).status, 404)
  assert.equal((await read('/', 'POST')).status, 405)
  assert.equal((await read('/', 'GET', { Host: 'untrusted.test' })).status, 403)
})
