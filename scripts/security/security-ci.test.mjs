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
import { VercelGateError } from '../security-ci/vercel-gate.mjs'
import { SourceIntegrityError } from '../security-ci/source-proof.mjs'
import { CI_POLICY, GithubVerificationError } from '../security-ci/verified-ci.mjs'
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

test('verified release regressions are mandatory in normal core CI, not only manual full runs', () => {
  for (const path of ['scripts/security/verified-ci-provider.test.mjs', 'scripts/security/verified-vercel-gate.test.mjs',
    'scripts/security/verified-deployment-publisher.test.mjs', 'scripts/security/verified-source-proof.test.mjs']) {
    assert.equal(CORE_TESTS.filter(candidate => candidate === path).length, 1)
    assert.ok(TASK_FILES.includes(path))
  }
})

test('snapshot path validation rejects Windows, traversal and control-character paths', () => {
  for (const path of ['C:/outside', '/outside', '../outside', 'src/../bad', 'src\\bad', 'src//bad', 'src/\u0000bad']) assert.equal(safePath(path), false)
  assert.equal(safePath('src/ordinary-file.ts'), true)
})

test('the snapshot protects unrelated local files and uses the proposed CSP', () => {
  assert.equal(BASELINE_ONLY_FILES.length, 5)
  for (const path of ['package.json', 'package-lock.json']) assert.ok(BASELINE_ONLY_FILES.includes(path))
  assert.equal(BASELINE_ONLY_FILES.includes('vercel.json'), false, 'the CSP test must read the proposed deployment headers')
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

async function runReleaseGate(childResult, proof = async () => null, environment = {}, stat = async () => { throw Object.assign(Error('synthetic absent'), { code: 'ENOENT' }) }, sourceProof = async () => { throw Error('Unexpected source diagnostic') }, readDirectory = async () => { throw Error('Unexpected directory diagnostic') }) {
  const source = await readFile(new URL('../security-ci/release-gate.mjs', import.meta.url), 'utf8')
  const calls = [], errors = [], logs = [], removals = []
  const fixture = '/synthetic/release-gate', process = { execPath: '/synthetic/node', env: environment }
  await vm.runInNewContext(`(async () => {${source.replace(/^import [^\r\n]+\r?$/gm, '')}\n})()`, {
    process, repository: '/synthetic/repository', join, tmpdir: () => '/synthetic/tmp',
    verifiedVercelReceipt: proof, assertSourceTree: sourceProof, VercelGateError, SourceIntegrityError, GithubVerificationError, CI_POLICY,
    lstat: stat, readdir: readDirectory,
    mkdtemp: async () => fixture,
    rm: async (path, options) => { removals.push([path, options.recursive, options.force]) },
    safeEnvironment: directory => safeEnvironment(directory, { PATH: '/synthetic/bin', OPENAI_API_KEY: 'synthetic' }),
    spawnSync: (executable, args, options) => {
      calls.push({ executable, args: [...args], options })
      return childResult(args[0])
    },
    console: { error: message => errors.push(message), log: message => logs.push(message) },
  })
  return { calls, errors, logs, removals, exitCode: process.exitCode }
}

test('the release gate allows fifteen minutes for the complete default core run and retains the other stages', async () => {
  const { calls, errors, removals, exitCode } = await runReleaseGate(() => ({ status: 0 }))
  assert.deepEqual(calls.map(call => call.args), [
    ['scripts/security-ci/scan-secrets.mjs'],
    ['scripts/security-ci/audit.mjs'],
    ['scripts/security-ci/run.mjs'],
  ])
  assert.deepEqual(calls.map(call => call.options.timeout), [480_000, 480_000, 900_000])
  for (const { executable, options } of calls) {
    assert.equal(executable, '/synthetic/node')
    assert.equal(options.cwd, '/synthetic/repository')
    assert.equal(options.shell, false)
    assert.equal(options.stdio, 'inherit')
    assert.equal(options.env.OPENAI_API_KEY, undefined)
  }
  assert.equal(exitCode, undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(removals, [['/synthetic/release-gate', true, true]])
})

test('the release gate rejects a timed-out or failed stage and reports its process outcome', async () => {
  const cases = [
    ['run.mjs', { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }, 3,
      /run\.mjs \(exit=none, error=ETIMEDOUT, signal=SIGTERM, timeoutLimitMs=900000\)/],
    ['audit.mjs', { status: 1 }, 2,
      /audit\.mjs \(exit=1, error=none, signal=none, timeoutLimitMs=480000\)/],
    ['scan-secrets.mjs', { status: null, error: { code: 'ENOENT' } }, 1,
      /scan-secrets\.mjs \(exit=none, error=ENOENT, signal=none, timeoutLimitMs=480000\)/],
  ]
  for (const [stage, failure, callsExpected, diagnostic] of cases) {
    const { calls, errors, removals, exitCode } = await runReleaseGate(script => script.endsWith('/' + stage) ? failure : { status: 0 })
    assert.equal(exitCode, 1)
    assert.equal(calls.length, callsExpected)
    assert.equal(errors.length, 1)
    assert.match(errors[0], diagnostic)
    assert.deepEqual(removals, [['/synthetic/release-gate', true, true]])
  }
})

test('verified gate reports only fixed codes from trusted classes and never their message, stack, provider body or environment', async () => {
  const secret = 'PRIVATE_PROVIDER_BODY_TOKEN_AND_PATH'
  for (const error of [new VercelGateError('production_source_context_mismatch'), new SourceIntegrityError('SOURCE_GIT_UNAVAILABLE'),
    new SourceIntegrityError('SOURCE_EXTRA_INPUT'), new GithubVerificationError('CI_PENDING'), new GithubVerificationError('CI_API_RATE_LIMIT')]) {
    const expectedCode = error.code
    error.message = secret; error.stack = secret
    const result = await runReleaseGate(() => { throw Error('Must not fall back') }, async () => { throw error })
    assert.equal(result.exitCode, 1); assert.deepEqual(result.calls, []); assert.deepEqual(result.removals, [])
    assert.equal(result.errors.length, 1)
    assert.ok(result.errors[0].includes('(code=' + expectedCode + ')'))
    assert.equal(result.errors[0].includes(secret), false)
  }
})

test('arbitrary codes, lookalike classes and getters cannot inject secret data into gate diagnostics', async () => {
  const secret = 'PRIVATE_UNTRUSTED_DIAGNOSTIC_SECRET'
  let getterRead = false
  const getter = new SourceIntegrityError('SOURCE_EXTRA_INPUT')
  Object.defineProperty(getter, 'code', { get() { getterRead = true; throw Error(secret) } })
  for (const error of [Object.assign(Error(secret), { code: 'SOURCE_GIT_UNAVAILABLE' }),
    { name: 'GithubVerificationError', code: 'CI_PENDING', message: secret, stack: secret },
    new SourceIntegrityError(secret), new GithubVerificationError(secret), new VercelGateError(secret), getter]) {
    const result = await runReleaseGate(() => { throw Error('Must not fall back') }, async () => { throw error })
    assert.equal(result.exitCode, 1); assert.deepEqual(result.calls, [])
    assert.equal(result.errors.length, 1)
    assert.ok(result.errors[0].includes('(code=unknown_gate_failure)'))
    assert.equal(result.errors[0].includes(secret), false)
  }
  assert.equal(getterRead, false, 'Do not evaluate an arbitrary error getter')
})

test('context mismatch diagnostics expose only the six fixed comparison booleans, never environment values', async () => {
  const secret = 'PRIVATE_CONTEXT_VALUE_TOKEN_AND_PATH'
  const [owner, slug] = CI_POLICY.repository.split('/')
  const valid = { VERCEL_PROJECT_ID: CI_POLICY.projectId, VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: owner.toUpperCase(),
    VERCEL_GIT_REPO_SLUG: slug, VERCEL_GIT_COMMIT_REF: CI_POLICY.branch, VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) }
  const keys = ['projectMatches', 'providerMatches', 'ownerMatches', 'slugMatches', 'branchMatches', 'shaValid']
  for (const inputKey of [null, ...Object.keys(valid)]) {
    const environment = inputKey ? { ...valid, [inputKey]: secret } : valid
    const result = await runReleaseGate(() => { throw Error('Must not fall back') }, async () => {
      throw new VercelGateError('production_source_context_mismatch')
    }, environment)
    const booleans = Object.fromEntries(keys.map((key, index) => [key, inputKey !== Object.keys(valid)[index]]))
    assert.equal(result.exitCode, 1); assert.deepEqual(result.calls, [])
    assert.ok(result.errors[0].includes('context=' + JSON.stringify(booleans)))
    for (const value of [secret, CI_POLICY.projectId, owner, 'a'.repeat(40)]) assert.equal(result.errors[0].includes(value), false)
  }
  const ordinary = await runReleaseGate(() => {}, async () => { throw new GithubVerificationError('CI_PENDING') }, valid)
  assert.equal(ordinary.errors[0].includes('context='), false, 'Only context mismatches print these fixed comparisons')
})

test('extra-input diagnostics use only five fixed root lstat calls and print three existence booleans', async () => {
  const names = ['.vercel', '.env.local', '.env.production', '.env.production.local', '.npmrc']
  const paths = names.map(name => join('/synthetic/repository', name))
  const secret = 'PRIVATE_FILE_CONTENT_AND_PATH'
  for (let mask = 0; mask < 32; mask++) {
    const statCalls = []
    const result = await runReleaseGate(() => { throw Error('Must not fall back') }, async () => {
      throw new SourceIntegrityError('SOURCE_EXTRA_INPUT')
    }, {}, async path => {
      statCalls.push(path)
      const index = paths.indexOf(path)
      assert.notEqual(index, -1, 'No traversal or additional path is inspected')
      if (!(mask & (1 << index))) throw Object.assign(Error(secret), { code: 'ENOENT' })
      // Contents and even type getters are never touched; an existing symlink
      // is reported as present without dereferencing it.
      return { get isFile() { throw Error(secret) }, get isDirectory() { throw Error(secret) }, get isSymbolicLink() { throw Error(secret) } }
    })
    const expected = { vercelDirectoryPresent: Boolean(mask & 1), dotenvFilePresent: Boolean(mask & 14), npmrcPresent: Boolean(mask & 16) }
    assert.deepEqual(statCalls, paths)
    assert.equal(result.exitCode, 1); assert.deepEqual(result.calls, []); assert.deepEqual(result.removals, [])
    assert.ok(result.errors[0].includes('sourceInputs=' + JSON.stringify(expected)))
    for (const value of [secret, '/synthetic/repository', ...names]) assert.equal(result.errors[0].includes(value), false)
  }
  let inspected = false
  for (const error of [new SourceIntegrityError('SOURCE_UNAVAILABLE'), Object.assign(Error(secret), { code: 'SOURCE_EXTRA_INPUT' })]) {
    const result = await runReleaseGate(() => {}, async () => { throw error }, {}, async () => { inspected = true })
    assert.equal(result.errors[0].includes('sourceInputs='), false)
  }
  assert.equal(inspected, false, 'Only trusted SOURCE_EXTRA_INPUT failures inspect these five fixed locations')
})

test('unavailable extra-input diagnostics retain rejection and never expose errors, paths or arbitrary code getters', async () => {
  const secret = 'PRIVATE_FILESYSTEM_ERROR_AND_PATH'
  let getterRead = false
  const getter = Object.defineProperty(Error(secret), 'code', { get() { getterRead = true; throw Error(secret) } })
  for (const error of [Object.assign(Error(secret), { code: 'EACCES' }), Error(secret), null, secret, getter]) {
    const result = await runReleaseGate(() => { throw Error('Must not fall back') }, async () => {
      throw new SourceIntegrityError('SOURCE_EXTRA_INPUT')
    }, {}, async () => { throw error })
    assert.equal(result.exitCode, 1); assert.deepEqual(result.calls, []); assert.deepEqual(result.removals, [])
    assert.ok(result.errors[0].includes('(code=SOURCE_EXTRA_INPUT) sourceInputDiagnosticsUnavailable=true'))
    assert.equal(result.errors[0].includes('sourceInputs='), false, 'An unreadable location must not be misreported as absent')
    assert.equal(result.errors[0].includes(secret), false)
  }
  assert.equal(getterRead, false)
})

test('preview Vercel metadata uses one root listing, fixed filename/type flags and bounded counts without exposing names', async () => {
  const secret = 'PRIVATE_UNKNOWN_ENTRY_NAME'
  const environment = { VERCEL: '1', VERCEL_ENV: 'preview', XELAY_SOURCE_PROOF_DIAGNOSTIC: '1', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) }
  const entry = (name, kind) => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })
  const stat = async path => {
    if (path === join('/synthetic/repository', '.vercel')) return { isDirectory: () => true, isSymbolicLink: () => false }
    throw Object.assign(Error(secret), { code: 'ENOENT' })
  }
  const entries = [entry('project.json', 'file'), entry('README.txt', 'file'), entry('output', 'directory'), entry('cache', 'directory'), entry(secret, 'symlink'), entry(secret + '_OTHER', 'other')]
  const directoryCalls = []
  const result = await runReleaseGate(() => ({ status: 0 }), async () => null, environment, stat,
    async () => { throw new SourceIntegrityError('SOURCE_EXTRA_INPUT') }, async (path, options) => {
      directoryCalls.push([path, options.withFileTypes]); return entries
    })
  assert.deepEqual(directoryCalls, [[join('/synthetic/repository', '.vercel'), true]])
  const expected = { entryCount: 6, unknownEntryCount: 2, projectJsonPresent: true, projectJsonRegularFile: true,
    readmeTxtPresent: true, readmeTxtRegularFile: true, outputPresent: true, outputDirectory: true, cachePresent: true, cacheDirectory: true,
    hasRegularFiles: true, hasDirectories: true, hasSymbolicLinks: true, hasOtherTypes: true }
  assert.ok(result.errors[0].includes('vercelRoot=' + JSON.stringify(expected)))
  assert.equal(result.errors[0].includes(secret), false)
  assert.equal(result.errors[0].includes('/synthetic/repository'), false)
  assert.equal(result.calls.length, 3); assert.equal(result.exitCode, undefined)
  const oversized = await runReleaseGate(() => ({ status: 0 }), async () => null, environment, stat,
    async () => { throw new SourceIntegrityError('SOURCE_EXTRA_INPUT') }, async () => Array.from({ length: 65 }, () => ({ get name() { throw Error(secret) } })))
  assert.ok(oversized.errors[0].includes('vercelRoot={"entryLimitExceeded":true}'))
  assert.equal(oversized.calls.length, 3)
})

test('Vercel metadata diagnostics cannot follow a root symlink, leak listing failures, or run outside opt-in preview', async () => {
  const secret = 'PRIVATE_DIRECTORY_ERROR'
  const valid = { VERCEL: '1', VERCEL_ENV: 'preview', XELAY_SOURCE_PROOF_DIAGNOSTIC: '1', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) }
  const proof = async () => { throw new SourceIntegrityError('SOURCE_EXTRA_INPUT') }
  for (const kind of ['symlink', 'file', 'unreadable']) {
    let listings = 0
    const result = await runReleaseGate(() => ({ status: 0 }), async () => null, valid, async path => {
      if (path !== join('/synthetic/repository', '.vercel')) throw Object.assign(Error(secret), { code: 'ENOENT' })
      return { isDirectory: () => kind !== 'file', isSymbolicLink: () => kind === 'symlink' }
    }, proof, async () => { listings++; throw Error(secret) })
    assert.equal(listings, kind === 'unreadable' ? 1 : 0)
    assert.ok(result.errors[0].includes('vercelRootDiagnosticsUnavailable=true'))
    assert.equal(result.errors[0].includes(secret), false); assert.equal(result.calls.length, 3)
  }
  for (const environment of [{ ...valid, VERCEL_ENV: 'production' }, { ...valid, XELAY_SOURCE_PROOF_DIAGNOSTIC: undefined }]) {
    let listings = 0
    const result = await runReleaseGate(() => {}, proof, environment, async () => ({}), undefined, async () => { listings++; throw Error(secret) })
    assert.equal(listings, 0); assert.equal(result.errors[0].includes('vercelRoot='), false)
    assert.equal(result.exitCode, 1)
  }
})

test('the opt-in preview source probe runs first but success or rejection always retains every complete release stage', async () => {
  const environment = { VERCEL: '1', VERCEL_ENV: 'preview', XELAY_SOURCE_PROOF_DIAGNOSTIC: '1', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) }
  const secret = 'PRIVATE_PREVIEW_PROBE_ERROR_AND_PATH'
  for (const outcome of ['success', 'extra-input', 'unknown']) {
    const order = [], proofCalls = []
    const result = await runReleaseGate(script => { order.push(script); return { status: 0 } }, async () => null,
      environment, async () => { throw Object.assign(Error(secret), { code: 'ENOENT' }) }, async options => {
        order.push('probe'); proofCalls.push(options)
        if (outcome === 'extra-input') throw new SourceIntegrityError('SOURCE_EXTRA_INPUT')
        if (outcome === 'unknown') throw Error(secret)
        return { diagnosticOnly: true }
      })
    assert.deepEqual(order, ['probe', 'scripts/security-ci/scan-secrets.mjs', 'scripts/security-ci/audit.mjs', 'scripts/security-ci/run.mjs'])
    assert.equal(proofCalls.length, 1)
    assert.equal(proofCalls[0].directory, '/synthetic/repository')
    assert.equal(proofCalls[0].expectedSha, environment.VERCEL_GIT_COMMIT_SHA)
    assert.equal(proofCalls[0].environment, environment)
    assert.equal(result.exitCode, undefined)
    assert.deepEqual(result.removals, [['/synthetic/release-gate', true, true]])
    const message = [...result.logs, ...result.errors].join('\n')
    assert.equal(message.includes(secret), false)
    assert.ok(message.includes('complete mandatory release gate still follows'))
    if (outcome === 'extra-input') assert.ok(message.includes('(code=SOURCE_EXTRA_INPUT) sourceInputs={"vercelDirectoryPresent":false,"dotenvFilePresent":false,"npmrcPresent":false}'))
    if (outcome === 'unknown') assert.ok(message.includes('(code=unknown_gate_failure)'))
  }
})

test('preview source diagnostics cannot run without all exact opt-in preview conditions or bypass a failing mandatory stage', async () => {
  const valid = { VERCEL: '1', VERCEL_ENV: 'preview', XELAY_SOURCE_PROOF_DIAGNOSTIC: '1', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) }
  for (const environment of [{}, { ...valid, XELAY_SOURCE_PROOF_DIAGNOSTIC: undefined }, { ...valid, XELAY_SOURCE_PROOF_DIAGNOSTIC: 'true' },
    { ...valid, VERCEL: undefined }, { ...valid, VERCEL: 'true' }, { ...valid, VERCEL_ENV: 'production' }, { ...valid, VERCEL_ENV: 'development' }]) {
    let probed = false
    const result = await runReleaseGate(() => ({ status: 0 }), async () => null, environment, undefined, async () => { probed = true })
    assert.equal(probed, false); assert.equal(result.calls.length, 3); assert.deepEqual(result.logs, []); assert.deepEqual(result.errors, [])
  }
  for (const sha of [undefined, 'PRIVATE_INVALID_SHA', 'A'.repeat(40)]) {
    let probed = false
    const result = await runReleaseGate(() => ({ status: 0 }), async () => null, { ...valid, VERCEL_GIT_COMMIT_SHA: sha }, undefined, async () => { probed = true })
    assert.equal(probed, false); assert.equal(result.calls.length, 3); assert.equal(result.exitCode, undefined)
    assert.ok(result.errors[0].includes('(code=SOURCE_INVALID_INPUT)'))
    assert.equal(result.errors[0].includes(String(sha)), false)
  }
  const failed = await runReleaseGate(script => ({ status: script.endsWith('/audit.mjs') ? 1 : 0 }), async () => null, valid, undefined, async () => ({}))
  assert.equal(failed.exitCode, 1)
  assert.deepEqual(failed.calls.map(call => call.args[0]), ['scripts/security-ci/scan-secrets.mjs', 'scripts/security-ci/audit.mjs'])
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
