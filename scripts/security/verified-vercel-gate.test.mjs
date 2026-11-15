import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { releaseGatePlan, verifiedVercelReceipt, VercelGateError } from '../security-ci/vercel-gate.mjs'
import { CI_POLICY, GithubVerificationError } from '../security-ci/verified-ci.mjs'
import { SourceIntegrityError } from '../security-ci/source-proof.mjs'

const sha = 'a'.repeat(40)
const sourceEnv = () => ({
  XELAY_VERIFIED_CI_GATE: 'github', VERCEL: '1', VERCEL_ENV: 'production',
  VERCEL_PROJECT_ID: CI_POLICY.projectId, VERCEL_GIT_PROVIDER: 'github',
  VERCEL_GIT_REPO_OWNER: 'Olegys1', VERCEL_GIT_REPO_SLUG: 'xelay',
  VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: sha,
})
const receipt = () => ({
  sha, repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId,
  workflowId: CI_POLICY.workflowId, runId: 11, runAttempt: 1,
})
const sourceProof = () => ({ sha, digest: 'c'.repeat(64), fileCount: 3, totalBytes: 100 })

function fixture({ environment = sourceEnv(), proof = sourceProof(), verifier, sourceError } = {}) {
  const sourceCalls = [], verifierCalls = []
  return {
    sourceCalls, verifierCalls,
    run: () => verifiedVercelReceipt({
      environment, repositoryDirectory: '/fictional/checkout', now: 10,
      proveSource: async options => {
        sourceCalls.push(options)
        if (sourceError) throw sourceError
        return proof
      },
      verifyGithub: async options => {
        verifierCalls.push(options)
        return verifier ? verifier(options) : receipt()
      },
    }),
  }
}

test('default, preview and local paths retain the complete existing gate without provider reads', async () => {
  for (const environment of [{}, { XELAY_SKIP_SECURITY: 'true' }, { XELAY_SECURITY_CI_BUILD: 'true' },
    { ...sourceEnv(), XELAY_VERIFIED_CI_GATE: '' }, { ...sourceEnv(), XELAY_VERIFIED_CI_GATE: 'full' },
    { ...sourceEnv(), VERCEL: '0' }, { ...sourceEnv(), VERCEL_ENV: 'preview' }]) {
    const f = fixture({ environment })
    assert.equal(releaseGatePlan(environment).mode, 'full')
    assert.equal(await f.run(), null)
    assert.equal(f.sourceCalls.length, 0)
    assert.equal(f.verifierCalls.length, 0)
  }
})

test('a mode flag never accepts unsupported values or incomplete production source identity', async () => {
  for (const value of ['true', 'skip', '1', 'GitHub']) {
    assert.throws(() => releaseGatePlan({ ...sourceEnv(), XELAY_VERIFIED_CI_GATE: value }), { code: 'unsupported_gate_configuration' })
  }
  for (const [field, values] of Object.entries({
    VERCEL_PROJECT_ID: ['', 'prj_other'], VERCEL_GIT_PROVIDER: ['', 'gitlab'],
    VERCEL_GIT_REPO_OWNER: ['', 'somebody'], VERCEL_GIT_REPO_SLUG: ['', 'xelay-copy'],
    VERCEL_GIT_COMMIT_REF: ['', 'feature', 'refs/heads/main'], VERCEL_GIT_COMMIT_SHA: ['', 'main', 'a'.repeat(39), 'A'.repeat(40)],
  })) {
    for (const value of values) {
      const f = fixture({ environment: { ...sourceEnv(), [field]: value } })
      await assert.rejects(f.run(), { code: 'production_source_context_mismatch' }, `${field}=${value}`)
      assert.equal(f.verifierCalls.length, 0)
    }
  }
})

test('the exact clean checkout and authenticated repository evidence permit no repeated suite processes', async () => {
  const f = fixture({ environment: { ...sourceEnv(), OPENAI_API_KEY: 'fictional-never-forward', NODE_OPTIONS: 'fictional-injection',
    GIT_SSH_COMMAND: 'fictional-command', GITHUB_TOKEN: 'fictional-unused', XELAY_CI_READ_TOKEN: 'fictional-read-only-token' } })
  assert.deepEqual(await f.run(), receipt())
  assert.equal(f.sourceCalls.length, 2)
  assert.equal(f.verifierCalls.length, 1)
  assert.equal(f.verifierCalls[0].sha, sha)
  assert.equal(f.verifierCalls[0].token, 'fictional-read-only-token')
  assert.ok(f.sourceCalls.every(call => call.directory === '/fictional/checkout' && call.expectedSha === sha))
  assert.deepEqual(Object.keys(f.verifierCalls[0]).sort(), ['now', 'sha', 'token'])
})

test('invalid canonical source proofs cannot reuse green CI', async () => {
  for (const proof of [null, { ...sourceProof(), sha: 'b'.repeat(40) }, { ...sourceProof(), digest: '' },
    { ...sourceProof(), fileCount: 0 }, { ...sourceProof(), totalBytes: -1 }]) {
    const f = fixture({ proof })
    await assert.rejects(f.run(), { code: 'source_proof_mismatch' })
    assert.equal(f.verifierCalls.length, 0)
  }
  for (const code of ['SOURCE_CHANGED', 'UNEXPECTED_BUILD_INPUT', 'GIT_UNAVAILABLE']) {
    const f = fixture({ sourceError: Object.assign(new Error('fictional source rejection'), { code }) })
    await assert.rejects(f.run(), { code })
    assert.equal(f.verifierCalls.length, 0)
  }
})

test('pending, stale or rejected CI never falls back to local scan or a paid polling loop', async () => {
  for (const code of ['pending', 'failed', 'skipped', 'wrong_workflow', 'stale', 'api_unauthorized', 'rate_limited']) {
    const f = fixture({ verifier: async () => { throw Object.assign(new Error('fictional provider rejection'), { code }) } })
    await assert.rejects(f.run(), { code })
    assert.equal(f.verifierCalls.length, 1)
    assert.equal(f.sourceCalls.length, 1)
  }
})

test('receipts for another SHA, repository or workflow are rejected', async () => {
  for (const invalid of [null, { ...receipt(), sha: 'b'.repeat(40) }, { ...receipt(), repository: 'other/xelay' },
    { ...receipt(), repositoryId: 1 }, { ...receipt(), workflowId: 2 }]) {
    const f = fixture({ verifier: async () => invalid })
    await assert.rejects(f.run(), { code: 'ci_receipt_mismatch' })
  }
})

test('source changes while CI evidence is fetched cannot reach the actual build', async () => {
  let calls = 0
  await assert.rejects(verifiedVercelReceipt({
    environment: sourceEnv(), repositoryDirectory: '/fictional', verifyGithub: async () => receipt(),
    proveSource: async () => ({ ...sourceProof(), digest: (++calls === 1 ? 'c' : 'd').repeat(64) }),
  }), { code: 'checkout_changed_during_verification' })
  assert.equal(calls, 2)
})

async function executeWrapper(verification, { environment = sourceEnv(), sourceProver = async () => { throw Error('Unexpected preview diagnostic') } } = {}) {
  const source = await readFile(new URL('../security-ci/release-gate.mjs', import.meta.url), 'utf8')
  const calls = [], errors = [], logs = [], scratch = []
  const process = { env: environment, execPath: '/fictional/node' }
  await vm.runInNewContext(`(async () => {${source.replace(/^import [^\r\n]+\r?$/gm, '')}\n})()`, {
    process, repository: '/fictional/repository',
    verifiedVercelReceipt: verification, assertSourceTree: sourceProver,
    VercelGateError, SourceIntegrityError, GithubVerificationError, CI_POLICY,
    lstat: async () => { throw Object.assign(Error('fictional absent'), { code: 'ENOENT' }) },
    readdir: async () => { throw Error('Unexpected directory diagnostic') },
    mkdtemp: async () => { scratch.push('create'); return '/fictional/scratch' },
    tmpdir: () => '/fictional', join: (...parts) => parts.join('/'),
    rm: async () => { scratch.push('remove') }, safeEnvironment: () => ({}),
    spawnSync: (...args) => { calls.push(args); return { status: 0 } },
    console: { log: text => logs.push(text), error: text => errors.push(text) },
  })
  return { calls, errors, logs, scratch, exitCode: process.exitCode }
}

test('actual wrapper skips all three duplicate stages only after verified evidence', async () => {
  const result = await executeWrapper(async () => receipt())
  assert.equal(result.calls.length, 0)
  assert.deepEqual(result.scratch, [])
  assert.equal(result.exitCode, undefined)
  assert.equal(result.errors.length, 0)
  assert.match(result.logs[0], /mandatory GitHub checks verified/)
})

test('actual wrapper stops on rejected proof without leaking provider data, tokens or hook URLs', async () => {
  const privateValue = 'fictional-provider-detail-never-log'
  const result = await executeWrapper(async () => { throw new Error(privateValue) })
  assert.equal(result.calls.length, 0)
  assert.deepEqual(result.scratch, [])
  assert.equal(result.exitCode, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(JSON.stringify(result).includes(privateValue), false)
})

test('actual wrapper recognizes its real error classes while preserving mandatory proof rejection', async () => {
  for (const error of [new VercelGateError('production_source_context_mismatch'), new SourceIntegrityError('SOURCE_EXTRA_INPUT'), new GithubVerificationError('CI_PENDING')]) {
    const result = await executeWrapper(async () => { throw error })
    assert.equal(result.exitCode, 1); assert.equal(result.calls.length, 0); assert.deepEqual(result.scratch, [])
    assert.ok(result.errors[0].includes('(code=' + error.code + ')'))
  }
})

test('actual wrapper preview diagnostic rejection cannot authorize skipping the complete existing gate', async () => {
  let probed = 0, verified = 0
  const environment = { ...sourceEnv(), VERCEL_ENV: 'preview', XELAY_SOURCE_PROOF_DIAGNOSTIC: '1' }
  const result = await executeWrapper(async options => {
    verified++
    assert.equal(options.environment, environment)
    return verifiedVercelReceipt({ ...options,
      proveSource: async () => { throw Error('Preview must not enter authoritative source verifier') },
      verifyGithub: async () => { throw Error('Preview must not request production CI evidence') } })
  }, { environment, sourceProver: async options => {
    probed++
    assert.equal(options.directory, '/fictional/repository'); assert.equal(options.expectedSha, sha)
    throw new SourceIntegrityError('SOURCE_EXTRA_INPUT')
  } })
  assert.equal(probed, 1); assert.equal(verified, 1); assert.equal(result.exitCode, undefined)
  assert.deepEqual(result.calls.map(call => call[1][0]), [
    'scripts/security-ci/scan-secrets.mjs', 'scripts/security-ci/audit.mjs', 'scripts/security-ci/run.mjs',
  ])
  assert.deepEqual(result.scratch, ['create', 'remove'])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /^Preview source diagnostic rejected \(code=SOURCE_EXTRA_INPUT\)/)
})

test('deployment and runtime configuration stay unchanged: no slower machine, cache or function adjustments', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'))
  assert.equal(config.buildCommand, 'node scripts/security-ci/release-gate.mjs && npm run build')
  assert.equal(config.installCommand, 'npm ci --ignore-scripts --no-audit --no-fund')
  assert.equal(config.functions['api/security/media-cleanup.ts'].maxDuration, 60)
  assert.match(config.headers.find(row => row.source === '/assets/(.*)').headers[0].value, /immutable/)
})
