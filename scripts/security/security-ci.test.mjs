import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CORE_TESTS, BASELINE_ONLY_FILES, TASK_FILES, safeEnvironment, selectTests } from '../security-ci/policy.mjs'
import { inventoryPaths, safePath } from '../security-ci/snapshot.mjs'
import { auditSummary } from '../security-ci/audit.mjs'
import { secretFindings } from '../security-ci/scan-secrets.mjs'
import '../security-ci/offline-guard.mjs'
import { request } from 'node:https'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

test('snapshot accepts only tracked files and explicit security task additions', () => {
  const paths = inventoryPaths([...CORE_TESTS.filter(path => path !== 'scripts/security/security-ci.test.mjs'), 'src/safe.ts'], ['scripts/security/security-ci.test.mjs'])
  assert.deepEqual(selectTests(paths), CORE_TESTS)
  assert.throws(() => inventoryPaths([], ['scripts/security/assistant-production.test.mjs']), /allowlist/)
  assert.throws(() => inventoryPaths(['../outside']), /Unsafe/)
  assert.throws(() => inventoryPaths(['.env.production']), /dotenv/)
  assert.deepEqual(inventoryPaths(['.env.server.example']), ['.env.server.example'])
})

test('full mode selects direct security tests from inventory, never arbitrary untracked discovery', () => {
  assert.deepEqual(selectTests(['scripts/security/z.test.mjs', 'scripts/security/helper.mjs', 'scripts/other.test.mjs', 'scripts/security-preview/monitor-preview.test.mjs'], 'full'), ['scripts/security/z.test.mjs'])
  assert.throws(() => selectTests([], 'core'), /Required security test missing/)
  assert.throws(() => selectTests([], 'arbitrary'), /Mode/)
})

test('snapshot path validation rejects Windows, traversal and control-character paths', () => {
  for (const path of ['C:/outside', '/outside', '../outside', 'src/../bad', 'src\\bad', 'src//bad', 'src/\u0000bad']) assert.equal(safePath(path), false)
  assert.equal(safePath('src/ordinary-file.ts'), true)
})

test('all eight unrelated pre-existing dirty paths are protected by baseline selection', () => {
  assert.equal(BASELINE_ONLY_FILES.length, 8)
  for (const path of ['package.json', 'package-lock.json', 'vercel.json', 'src/App.tsx', 'tsconfig.json']) assert.ok(BASELINE_ONLY_FILES.includes(path))
})

test('children do not inherit provider credentials, proxy configuration or Node injection', () => {
  const source = { PATH: '/synthetic/bin', SystemRoot: 'C:/synthetic', OPENAI_API_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic',
    ADMIN_ALERT_TELEGRAM_BOT_TOKEN: 'synthetic', GITHUB_TOKEN: 'synthetic', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'synthetic',
    npm_config_registry: 'synthetic', HOME: '/developer', XELAY_SECURITY_CI_BUILD: 'true' }
  const env = safeEnvironment('/isolated', source)
  assert.equal(env.PATH, source.PATH)
  assert.equal(env.HOME, '/isolated')
  for (const key of Object.keys(source).filter(key => !['PATH', 'SystemRoot', 'HOME'].includes(key))) assert.equal(env[key], undefined)
})

test('dependency audit rejects high/critical issues and malformed/incomplete registry responses', () => {
  const report = (values) => ({ metadata: { vulnerabilities: { high: 0, critical: 0, moderate: 2, low: 1, ...values } } })
  assert.equal(auditSummary(report({})).blocked, false)
  assert.equal(auditSummary(report({ high: 1 })).blocked, true)
  assert.equal(auditSummary(report({ critical: 1 })).blocked, true)
  for (const invalid of [{}, report({ high: -1 }), report({ critical: '0' })]) assert.throws(() => auditSummary(invalid), /invalid audit/)
})

test('offline secret preflight identifies credential types and returns locations without values', () => {
  const specimens = [
    ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['github-token', 'gh' + 'p_' + 'a'.repeat(36)],
    ['aws-access-key', 'AK' + 'IA' + 'A'.repeat(16)],
    ['openai-key', 'sk-' + 'proj-' + 'a'.repeat(40)],
    ['supabase-server-key', 'sb_' + 'secret_' + 'a'.repeat(24)],
    ['telegram-bot-token', '123456789:' + 'AA' + 'a'.repeat(33)],
  ]
  for (const [rule, value] of specimens) {
    const findings = secretFindings(`safe\n${value}`)
    assert.deepEqual(findings, [{ rule, line: 2 }])
    assert.equal(JSON.stringify(findings).includes(value), false)
  }
  const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"role":"service_role"}').toString('base64url'), 's'.repeat(32)].join('.')
  assert.equal(secretFindings(jwt)[0].rule, 'supabase-service-role-jwt')
  assert.deepEqual(secretFindings('SUPABASE_SERVICE_ROLE_KEY: "synthetic-fixture-value-only"'), [])
})

test('real network and subprocess calls fail before any provider contact', async () => {
  await assert.rejects(fetch('https://example.invalid'), { code: 'SECURITY_TEST_OFFLINE' })
  assert.throws(() => request('https://example.invalid'), { code: 'SECURITY_TEST_OFFLINE' })
  assert.throws(() => connect(443, 'example.invalid'), { code: 'SECURITY_TEST_OFFLINE' })
  assert.throws(() => spawnSync('unused'), { code: 'SECURITY_TEST_OFFLINE' })
})

test('workflow has read-only permissions, pinned actions and no secret interpolation or privileged PR event', async () => {
  const source = await readFile(new URL('../../.github/workflows/security-checks.yml', import.meta.url), 'utf8')
  assert.match(source, /contents: read/)
  for (const match of source.matchAll(/uses:\s*(\S+)/g)) assert.match(match[1], /@[0-9a-f]{40}$/)
  assert.doesNotMatch(source, /pull_request_target|\$\{\{\s*secrets\.|write-all|id-token: write|issues: write|pull-requests: write/)
  assert.match(source, /persist-credentials: false/)
  assert.match(source, /sha256sum --check --strict/)
})
