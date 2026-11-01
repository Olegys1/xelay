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
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  assert.equal(BASELINE_ONLY_FILES.length, 6)
  for (const path of ['package.json', 'package-lock.json', 'vercel.json']) assert.ok(BASELINE_ONLY_FILES.includes(path))
  assert.equal(BASELINE_ONLY_FILES.includes('tsconfig.json'), false, 'server emission must validate the proposed compiler configuration')
  assert.equal(BASELINE_ONLY_FILES.includes('src/App.tsx'), false, 'assistant mount and source navigation must validate the proposed App')
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

test('the actual sequential runner enables TypeScript transforms while retaining the offline guard', async () => {
  const source = await readFile(new URL('../security-ci/run.mjs', import.meta.url), 'utf8')
  const calls = [], reports = []
  let disposed = false
  const fixture = '/synthetic/snapshot'
  // Execute the real dispatcher with synthetic inventory and captured process
  // calls. No child, model, network, snapshot directory or report is created.
  await vm.runInNewContext(`(async () => {${source.replace(/^import [^\r\n]+\r?$/gm, '')}\n})()`, {
    process: { argv: ['node', 'run.mjs', '--core'], execPath: '/synthetic/node' },
    repository: '/synthetic/repository', join, pathToFileURL, Date,
    createSnapshot: async () => ({ directory: fixture, paths: ['scripts/security/synthetic.test.mjs'], dispose: async () => { disposed = true } }),
    selectTests: () => ['scripts/security/synthetic.test.mjs'],
    safeEnvironment: directory => safeEnvironment(directory, { PATH: '/synthetic/bin' }),
    spawnSync: (executable, args, options) => { calls.push({ executable, args, options }); return { status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n' } },
    mkdir: async () => {}, writeFile: async (...args) => { reports.push(args) },
    console: { log() {}, error() {} },
  })
  assert.equal(disposed, true)
  assert.equal(calls.length, 1)
  const { args, options } = calls[0]
  assert.equal(args[0], '--experimental-transform-types')
  assert.ok(args.includes('--test'))
  assert.ok(args.includes('--test-isolation=none'))
  assert.ok(args.includes('--test-concurrency=1'))
  assert.equal(args[args.indexOf('--import') + 1], pathToFileURL(join(fixture, 'scripts/security-ci/offline-guard.mjs')).href)
  assert.equal(options.cwd, fixture)
  assert.equal(options.shell, false)
  assert.equal(options.env.XELAY_SECURITY_CI_BUILD, undefined)
  assert.equal(options.env.OPENAI_API_KEY, undefined)
  assert.equal(reports.length, 1)
  assert.equal(JSON.parse(reports[0][1]).nodeReportedCounts.pass, 1)
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

test('Gitleaks keeps maintained rules and permits only reviewed inert values at their exact paths', async () => {
  const source = await readFile(new URL('../security-ci/gitleaks.toml', import.meta.url), 'utf8')
  assert.equal(/useDefault\s*=\s*true/.test(source), true)
  assert.equal(/disabledRules|targetRules|commits\s*=|stopwords\s*=/.test(source), false)
  assert.equal((source.match(/\[\[rules\]\]/g) ?? []).length, 1)
  assert.equal(/id\s*=\s*"generic-api-key"/.test(source), true)
  const blocks = source.split('[[rules.allowlists]]').slice(1)
  const expected = [
    {
      path: '(^|/)scripts/security/test1-mfa-probe\\.test\\.mjs$',
      files: ['scripts/security/test1-mfa-probe.test.mjs'],
      valueHash: '549c9390539efcfa01d2744e82e7da34409a63dd0feaf310f7a6e12551fe7668',
    },
    {
      path: '(^|/)scripts/security/assistant-v2-cloud-chat\\.test\\.mjs$',
      files: ['scripts/security/assistant-v2-cloud-chat.test.mjs'],
      value: ['synthetic-private', 'continuation-secret', '123456789'].join('-'),
    },
    {
      path: '(^|/)scripts/security/assistant-v2-cloud-handler\\.test\\.mjs$',
      files: ['scripts/security/assistant-v2-cloud-handler.test.mjs'],
      value: ['synthetic', 'private', 'fixture', '987654321'].join('_'),
    },
    {
      path: '(^|/)supabase/migrations/(202610310004_assistant_model_budget|202610310007_assistant_model_usage_bounds)\\.sql$',
      files: ['supabase/migrations/202610310004_assistant_model_budget.sql', 'supabase/migrations/202610310007_assistant_model_usage_bounds.sql'],
      value: ['finished_at', 'v_now'].join('='),
    },
  ]
  assert.equal(blocks.length, expected.length)
  for (const [index, block] of blocks.entries()) {
    assert.match(block, /condition\s*=\s*"AND"/)
    assert.match(block, /regexTarget\s*=\s*"secret"/)
    const path = block.match(/paths\s*=\s*\['''([^']+)'''\]/)?.[1]
    const value = block.match(/regexes\s*=\s*\['''\^([^']+)\$'''\]/)?.[1]
    assert.equal(path, expected[index].path)
    assert.equal(typeof value, 'string')
    if (expected[index].valueHash) assert.equal(createHash('sha256').update(value).digest('hex'), expected[index].valueHash)
    else assert.equal(value, expected[index].value)
    const pathRule = new RegExp(path)
    const valueRule = new RegExp(`^${value}$`)
    const permits = (file, secret) => pathRule.test(file) && valueRule.test(secret)
    for (const file of expected[index].files) {
      assert.equal(permits(file, value), true)
      assert.equal(permits(`C:/local-scan/${file}`, value), true)
      assert.equal(permits(`${file}.bak`, value), false)
      assert.equal(permits(file, `${value}X`), false)
      assert.equal(permits(file, `X${value}`), false)
      assert.equal(permits(file, ['not', 'a', 'reviewed', 'credential', '987654321'].join('_')), false)
    }
    assert.equal(permits('src/other-file.ts', value), false)
    for (const file of expected.flatMap(item => item.files).filter(file => !expected[index].files.includes(file))) assert.equal(permits(file, value), false)
    assert.equal(permits('supabase/migrations/202610310004_assistant_model_usage_bounds.sql', value), false)
    assert.equal(permits('supabase/migrations/202610310007_assistant_model_budget.sql', value), false)
  }
})
