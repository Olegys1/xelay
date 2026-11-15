import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { requestVerifiedDeployment, validateDeployHook, validateWorkflowRunEvent, runVerifiedDeploymentCli, VerifiedDeploymentError, PUBLISHER_POLICY, PUBLISHER_REQUEST_TIMEOUT_MS, PUBLISHER_HOOK_TIMEOUT_MS } from '../security-ci/request-verified-deployment.mjs'
import { GithubVerificationError, CI_FRESHNESS_MS, CI_POLICY } from '../security-ci/verified-ci.mjs'

const NOW = Date.parse('2026-11-15T15:00:00Z')
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const PROJECT = 'prj_Yl9R5uI2IdwyeNaIhbfIlObMO5bq'
const HOOK = 'https://api.vercel.com/v1/integrations/deploy/' + PROJECT + '/synthetic_hook_only'
const READ_TOKEN = 'synthetic_readonly_workflow_token'
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const repository = () => ({ id: 1258728015, full_name: 'Olegys1/xelay', owner: { id: 290528340 }, fork: false })
const productionReceipt = () => ({ mode: 'production', sha: SHA, runId: 3001, runAttempt: 2,
  repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId, ownerId: CI_POLICY.ownerId,
  workflowId: CI_POLICY.workflowId, workflowPath: CI_POLICY.workflowPath, workflowBlob: CI_POLICY.workflowBlob })

function fixture(options = {}) {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'Olegys1/xelay',
    GITHUB_REPOSITORY_ID: '1258728015', GITHUB_REPOSITORY_OWNER_ID: '290528340', GITHUB_REF: 'refs/heads/main',
    GITHUB_TOKEN: READ_TOKEN, XELAY_VERIFIED_DEPLOY_HOOK: HOOK, ...options.env }
  const event = { action: 'completed', repository: repository(), workflow_run: {
    id: 3001, run_attempt: 2, workflow_id: 399954171, name: 'Security checks', event: 'push', head_branch: 'main',
    head_repository: repository(), head_sha: SHA, head_commit: { id: SHA }, status: 'completed', conclusion: 'success',
    updated_at: new Date(NOW - 60000).toISOString(),
  } }
  options.changeEvent?.(event)
  const fetches = [], verifications = []
  let checkoutReads = 0
  const verifyCommit = async input => {
    verifications.push(input)
    if (options.verifyFailure) throw options.verifyFailure
    return options.receipt === undefined ? productionReceipt() : options.receipt
  }
  const fetchImpl = async (url, init) => {
    fetches.push({ url: String(url), init })
    if (String(url) === 'https://api.github.com/repos/Olegys1/xelay/git/ref/heads/main') {
      if (options.mainFailure) throw options.mainFailure
      return options.mainResponse?.() ?? json({ ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } })
    }
    assert.equal(String(url), HOOK, 'Only the exact pinned synthetic hook can be requested')
    if (options.hookFailure) throw options.hookFailure
    return options.hookResponse?.() ?? json({ job: { id: 'synthetic_job', state: 'PENDING' } }, 201)
  }
  const execute = () => requestVerifiedDeployment({ env, event, now: options.now ?? NOW, fetchImpl, verifyCommit,
    checkoutSha: () => { checkoutReads++; if (options.checkoutFailure) throw options.checkoutFailure; return options.checkoutSha ?? SHA } })
  return { env, event, fetches, verifications, execute, checkoutReads: () => checkoutReads }
}

async function rejectedWithoutPost(fx, code) {
  await assert.rejects(fx.execute(), error => error.code === code && !String(error).includes(HOOK) && !String(error).includes(READ_TOKEN))
  assert.equal(fx.fetches.filter(call => call.init.method === 'POST').length, 0)
}

test('only verified completed main run can issue one scoped POST, with no credentials or payload forwarded to hook', async () => {
  assert.equal(PUBLISHER_POLICY.vercelProjectId, PROJECT)
  const fx = fixture()
  const result = await fx.execute()
  assert.deepEqual(result, { state: 'requested', deploymentRequested: true, sha: SHA, runId: 3001, runAttempt: 2 })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(fx.verifications.length, 1)
  assert.equal(fx.verifications[0].sha, SHA)
  assert.equal(fx.verifications[0].token, READ_TOKEN)
  assert.equal(fx.verifications[0].now, NOW)
  assert.equal(fx.checkoutReads(), 1)
  assert.deepEqual(fx.fetches.map(call => call.init.method), ['GET', 'POST'])
  for (const call of fx.fetches) { assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal instanceof AbortSignal) }
  assert.equal(fx.fetches[0].init.headers.Authorization, 'Bearer ' + READ_TOKEN)
  assert.equal(fx.fetches[1].init.headers, undefined)
  assert.equal(fx.fetches[1].init.body, undefined)
  assert.doesNotMatch(JSON.stringify(result), /synthetic_hook|synthetic_readonly|synthetic_job|https:/)
})

test('missing hook is explicit configuration-pending and performs no API or deployment call', async () => {
  const fx = fixture({ env: { XELAY_VERIFIED_DEPLOY_HOOK: '' } })
  assert.deepEqual(await fx.execute(), { state: 'configuration_pending', deploymentRequested: false, reason: 'deployment_hook_not_configured' })
  assert.equal(fx.fetches.length, 0); assert.equal(fx.verifications.length, 0)
})

test('automatic token is optional and never creates an Authorization header when absent', async () => {
  const fx = fixture({ env: { GITHUB_TOKEN: undefined } })
  assert.equal((await fx.execute()).deploymentRequested, true)
  assert.equal(fx.verifications[0].token, undefined)
  assert.equal(fx.fetches[0].init.headers.Authorization, undefined)
})

test('direct invocation, different owner/repository/ref, and other GitHub event types fail before checkout or verification', async t => {
  for (const env of [
    { GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REPOSITORY: 'attacker/xelay' }, { GITHUB_REPOSITORY_ID: '999' },
    { GITHUB_REPOSITORY_OWNER_ID: '999' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REF: 'refs/heads/feature' },
  ]) await t.test(Object.keys(env)[0] + '=' + String(Object.values(env)[0]), async () => {
    const fx = fixture({ env }); await rejectedWithoutPost(fx, 'UNTRUSTED_WORKFLOW_CONTEXT')
    assert.equal(fx.checkoutReads(), 0); assert.equal(fx.verifications.length, 0); assert.equal(fx.fetches.length, 0)
  })
})

test('forged workflow-run metadata, PR/fork events, and wrong checks never reach privileged verification', async t => {
  const changes = [
    ['wrong action', e => { e.action = 'requested' }],
    ['wrong repository', e => { e.repository.id = 999 }],
    ['wrong top owner', e => { e.repository.owner.id = 999 }],
    ['wrong top name', e => { e.repository.full_name = 'attacker/xelay' }],
    ['forked top repository', e => { e.repository.fork = true }],
    ['missing head repository', e => { e.workflow_run.head_repository = null }],
    ['forked head', e => { e.workflow_run.head_repository.fork = true }],
    ['same-name fork', e => { e.workflow_run.head_repository.id = 999 }],
    ['wrong head owner', e => { e.workflow_run.head_repository.owner.id = 999 }],
    ['wrong head name', e => { e.workflow_run.head_repository.full_name = 'attacker/xelay' }],
    ['pull request source', e => { e.workflow_run.event = 'pull_request' }],
    ['pull request target source', e => { e.workflow_run.event = 'pull_request_target' }],
    ['manual source', e => { e.workflow_run.event = 'workflow_dispatch' }],
    ['scheduled source', e => { e.workflow_run.event = 'schedule' }],
    ['wrong branch', e => { e.workflow_run.head_branch = 'feature' }],
    ['wrong workflow ID', e => { e.workflow_run.workflow_id = 999 }],
    ['wrong workflow name', e => { e.workflow_run.name = 'Other workflow' }],
    ['pending run', e => { e.workflow_run.status = 'in_progress' }],
    ['failed run', e => { e.workflow_run.conclusion = 'failure' }],
    ['skipped run', e => { e.workflow_run.conclusion = 'skipped' }],
    ['neutral run', e => { e.workflow_run.conclusion = 'neutral' }],
    ['missing attempt', e => { delete e.workflow_run.run_attempt }],
    ['unsafe run ID', e => { e.workflow_run.id = Number.MAX_SAFE_INTEGER + 1 }],
    ['non-SHA input', e => { e.workflow_run.head_sha = 'main; echo unsafe' }],
    ['head commit mismatch', e => { e.workflow_run.head_commit.id = OTHER_SHA }],
  ]
  for (const [name, changeEvent] of changes) await t.test(name, async () => {
    const fx = fixture({ changeEvent }); await rejectedWithoutPost(fx, 'UNTRUSTED_WORKFLOW_EVENT')
    assert.equal(fx.checkoutReads(), 0); assert.equal(fx.verifications.length, 0)
  })
})

test('stale, invalid, and future event times fail closed before checkout or provider calls', async t => {
  for (const [name, value] of [['stale', new Date(NOW - CI_FRESHNESS_MS - 1).toISOString()],
    ['future', new Date(NOW + 60001).toISOString()], ['invalid', 'not-a-date'], ['missing', undefined]]) {
    await t.test(name, async () => {
      const fx = fixture({ changeEvent: e => { e.workflow_run.updated_at = value } })
      await rejectedWithoutPost(fx, 'STALE_WORKFLOW_EVENT')
      assert.equal(fx.checkoutReads(), 0); assert.equal(fx.verifications.length, 0)
    })
  }
})

test('checkout must be the exact tested SHA and cannot be dirty or unavailable', async () => {
  for (const fx of [fixture({ checkoutSha: OTHER_SHA }), fixture({ checkoutFailure: new VerifiedDeploymentError('CHECKOUT_NOT_CLEAN') }),
    fixture({ checkoutFailure: new VerifiedDeploymentError('CHECKOUT_IDENTITY_UNAVAILABLE') })]) {
    await assert.rejects(fx.execute()); assert.equal(fx.verifications.length, 0); assert.equal(fx.fetches.length, 0)
  }
})

test('hook must use the fixed HTTPS API origin and exact reviewed project, with no query/fragment/redirect target', () => {
  assert.equal(validateDeployHook(HOOK).href, HOOK)
  const invalid = [
    HOOK.replace('https:', 'http:'), HOOK.replace('api.vercel.com', 'api.vercel.com.evil.test'),
    HOOK.replace('api.vercel.com', 'evil.test'), HOOK.replace(PROJECT, 'prj_AnotherProject1234'),
    HOOK + '?buildCache=false', HOOK + '#fragment', HOOK.replace('api.vercel.com', 'user:pass@api.vercel.com'),
    HOOK.replace('/v1/', '/v2/'), HOOK.replace('synthetic_hook_only', 'short'), HOOK + '/extra', ' ' + HOOK,
    HOOK + '\n', HOOK.replace('/deploy/', '/deploy%2F'),
  ]
  for (const value of invalid) assert.throws(() => validateDeployHook(value), error => error.code === 'INVALID_DEPLOY_HOOK' && !String(error).includes(value))
  assert.throws(() => validateDeployHook(HOOK, ''), error => error.code === 'PROJECT_PIN_NOT_CONFIGURED')
})

test('invalid hook is refused before trusted CI proof is queried', async () => {
  const fx = fixture({ env: { XELAY_VERIFIED_DEPLOY_HOOK: 'https://evil.test/token' } })
  await rejectedWithoutPost(fx, 'INVALID_DEPLOY_HOOK')
  assert.equal(fx.verifications.length, 0); assert.equal(fx.fetches.length, 0)
})

test('exact latest proof must bind the triggering run ID, rerun attempt, and commit together', async t => {
  for (const [name, receipt] of [
    ['other run', { ...productionReceipt(), runId: 3000 }],
    ['old attempt', { ...productionReceipt(), runAttempt: 1 }],
    ['other SHA', { ...productionReceipt(), sha: OTHER_SHA }],
    ['preview mode with otherwise matching identity', { ...productionReceipt(), mode: 'preview', branch: 'feature/preview', pullRequestNumber: 91, baseSha: OTHER_SHA }],
    ...Object.entries({ mode: undefined, repository: 'other/xelay', repositoryId: 1, ownerId: 1, workflowId: 1,
      workflowPath: 'other.yml', workflowBlob: '0'.repeat(40) }).map(([field, value]) => ['wrong ' + field, { ...productionReceipt(), [field]: value }]),
    ['missing proof', null],
  ]) await t.test(name, async () => {
    const fx = fixture({ receipt }); await rejectedWithoutPost(fx, 'EVENT_PROOF_MISMATCH')
    assert.equal(fx.fetches.length, 0)
  })
})

test('failed, skipped, stale or unavailable provider proof cannot issue a hook request', async () => {
  const rejected = fixture({ verifyFailure: new GithubVerificationError('REQUIRED_JOB_FAILED') })
  await rejectedWithoutPost(rejected, 'REQUIRED_JOB_FAILED')
  assert.equal(rejected.fetches.length, 0)
  const unexpected = fixture({ verifyFailure: Error('Provider includes secret ' + HOOK) })
  await rejectedWithoutPost(unexpected, 'CI_PROOF_UNAVAILABLE')
  assert.equal(unexpected.fetches.length, 0)
})

test('main is checked again after proof immediately before POST; moved branch or API errors never deploy', async t => {
  for (const [name, options, code] of [
    ['moved', { mainResponse: () => json({ ref: 'refs/heads/main', object: { type: 'commit', sha: OTHER_SHA } }) }, 'MAIN_MOVED'],
    ['noncommit', { mainResponse: () => json({ ref: 'refs/heads/main', object: { type: 'tree', sha: SHA } }) }, 'MAIN_MOVED'],
    ['wrongref', { mainResponse: () => json({ ref: 'refs/heads/other', object: { type: 'commit', sha: SHA } }) }, 'MAIN_MOVED'],
    ['API503', { mainResponse: () => json({ message: HOOK }, 503) }, 'MAIN_RECHECK_UNAVAILABLE'],
    ['APIredirect', { mainResponse: () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }) }, 'MAIN_RECHECK_UNAVAILABLE'],
    ['network', { mainFailure: Error(HOOK) }, 'MAIN_RECHECK_UNAVAILABLE'],
  ]) await t.test(name, async () => {
    const fx = fixture(options); await rejectedWithoutPost(fx, code)
    assert.equal(fx.fetches.length, 1)
  })
})

test('hook rejection, redirect and transport failure are not retried and cannot disclose provider payload', async t => {
  for (const [name, options, code] of [
    ['HTTP503', { hookResponse: () => json({ secret: HOOK }, 503) }, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE'],
    ['redirect', { hookResponse: () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }) }, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE'],
    ['network', { hookFailure: Error('Private hook URL ' + HOOK) }, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE'],
    ['invalidJSON', { hookResponse: () => new Response('private ' + HOOK, { status: 200, headers: { 'content-type': 'application/json' } }) }, 'INVALID_PROVIDER_RESPONSE'],
    ['no receipt', { hookResponse: () => json({ secret: HOOK }) }, 'DEPLOY_HOOK_RECEIPT_UNAVAILABLE'],
    ['oversized', { hookResponse: () => new Response('x'.repeat(16385), { status: 200, headers: { 'content-type': 'application/json' } }) }, 'INVALID_PROVIDER_RESPONSE'],
    ['declared oversized', { hookResponse: () => json({}, 200, { 'content-length': '16385' }) }, 'INVALID_PROVIDER_RESPONSE'],
    ['invalid length', { hookResponse: () => json({}, 200, { 'content-length': 'not-a-number' }) }, 'INVALID_PROVIDER_RESPONSE'],
    ['negative length', { hookResponse: () => json({}, 200, { 'content-length': '-1' }) }, 'INVALID_PROVIDER_RESPONSE'],
    ['wrong MIME', { hookResponse: () => json({}, 200, { 'content-type': 'text/html' }) }, 'INVALID_PROVIDER_RESPONSE'],
    ['invalid UTF8', { hookResponse: () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }) }, 'INVALID_PROVIDER_RESPONSE'],
  ]) await t.test(name, async () => {
    const fx = fixture(options)
    const result = await fx.execute()
    assert.equal(result.state, 'request_outcome_unknown')
    assert.equal(result.deploymentRequested, null)
    assert.equal(result.requestAttempted, true)
    assert.equal(result.code, code)
    assert.doesNotMatch(JSON.stringify(result), /synthetic_hook|synthetic_readonly|private|https:/)
    assert.equal(fx.fetches.length, 2); assert.equal(fx.fetches.filter(call => call.init.method === 'POST').length, 1)
  })
})

test('an injected transport cannot silently follow a redirect or return a different final URL', async t => {
  for (const target of ['main', 'hook']) for (const property of ['redirected', 'url']) await t.test(target + ':' + property, async () => {
    const response = json(target === 'main' ? { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } } : { job: { id: 'job', state: 'PENDING' } })
    Object.defineProperty(response, property, { value: property === 'redirected' ? true : 'https://evil.test/private-token' })
    const fx = fixture({ [target + 'Response']: () => response })
    if (target === 'main') await assert.rejects(fx.execute(), error => error.code === 'MAIN_RECHECK_UNAVAILABLE')
    else {
      const result = await fx.execute()
      assert.equal(result.state, 'request_outcome_unknown'); assert.equal(result.deploymentRequested, null)
      assert.equal(result.requestAttempted, true); assert.equal(result.code, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE')
    }
    assert.equal(fx.fetches.length, target === 'main' ? 1 : 2)
  })
})

test('independent deadline bounds a fetch or body that ignores AbortSignal and cancels its transport', async t => {
  for (const target of ['main', 'hook']) for (const kind of ['fetch', 'body']) await t.test(target + ':' + kind, async sub => {
    sub.mock.timers.enable({ apis: ['setTimeout'] })
    let cancelled = false
    const stalled = kind === 'fetch' ? () => new Promise(() => {}) : () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}) }, cancel() { cancelled = true },
    }), { headers: { 'content-type': 'application/json' } })
    const fx = fixture({ [target + 'Response']: stalled })
    const pending = fx.execute()
    const checked = target === 'main' ? assert.rejects(pending, error => error.code === 'MAIN_RECHECK_UNAVAILABLE') : pending.then(result => {
      assert.equal(result.state, 'request_outcome_unknown'); assert.equal(result.deploymentRequested, null)
      assert.equal(result.requestAttempted, true); assert.equal(result.code, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE')
      assert.doesNotMatch(JSON.stringify(result), /synthetic_hook|synthetic_readonly|https:/)
    })
    const expectedCalls = target === 'main' ? 1 : 2
    for (let i = 0; i < 20 && fx.fetches.length < expectedCalls; i++) await nextTurn()
    assert.equal(fx.fetches.length, expectedCalls)
    await nextTurn()
    const timeoutMs = target === 'hook' ? PUBLISHER_HOOK_TIMEOUT_MS : PUBLISHER_REQUEST_TIMEOUT_MS
    assert.equal(timeoutMs, target === 'hook' ? 15000 : 5000)
    sub.mock.timers.tick(timeoutMs - 1)
    assert.equal(fx.fetches.at(-1).init.signal.aborted, false, 'Do not abort the hook at the previous five-second limit')
    sub.mock.timers.tick(2)
    await checked
    assert.equal(fx.fetches.at(-1).init.signal.aborted, true)
    if (kind === 'body') assert.equal(cancelled, true)
    assert.equal(fx.fetches.filter(call => call.init.method === 'POST').length, target === 'main' ? 0 : 1)
  })
})

test('workflow has read-only permissions, trusted metadata guards, pinned checkout of exact tested SHA and secret only in publisher step', async () => {
  const source = await readFile(new URL('../../.github/workflows/deploy-verified.yml', import.meta.url), 'utf8')
  assert.match(source, /workflow_run:\s*\n\s*workflows: \[Security checks\]\s*\n\s*types: \[completed\]\s*\n\s*branches: \[main\]/)
  for (const expression of ["github.repository == 'Olegys1/xelay'", "github.repository_id == '1258728015'", "github.repository_owner_id == '290528340'",
    'github.event.repository.id == 1258728015', 'github.event.repository.owner.id == 290528340',
    'github.event.workflow_run.workflow_id == 399954171', "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.id == 1258728015', 'github.event.workflow_run.head_repository.owner.id == 290528340',
    "github.event.workflow_run.head_repository.full_name == 'Olegys1/xelay'", 'github.event.workflow_run.head_repository.fork == false',
    "github.event.workflow_run.status == 'completed'", "github.event.workflow_run.conclusion == 'success'"]) assert.ok(source.includes(expression), expression)
  assert.match(source, /permissions: \{\}/)
  assert.match(source, /contents: read\s*\n\s*actions: read/)
  assert.doesNotMatch(source, /(?:contents|actions|checks|deployments|id-token): write|pull_request_target|workflow_dispatch|download-artifact|npm ci|npm install|npx/)
  assert.match(source, /environment: production-release/)
  assert.match(source, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/)
  assert.match(source, /ref: \$\{\{ github.event.workflow_run.head_sha \}\}/)
  assert.match(source, /persist-credentials: false/)
  assert.match(source, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/)
  assert.equal(source.match(/secrets\.XELAY_VERIFIED_DEPLOY_HOOK/g)?.length, 1)
  assert.ok(source.indexOf('secrets.XELAY_VERIFIED_DEPLOY_HOOK') > source.indexOf('- name: Verify the completed main run'))
  assert.match(source, /run: node scripts\/security-ci\/request-verified-deployment\.mjs/)
  assert.doesNotMatch(source, /run:.*\$\{\{.*head_sha/)
})

test('real CLI entrypoint refuses direct invocation before event reads or provider calls without a subprocess', async () => {
  const url = new URL('../security-ci/request-verified-deployment.mjs', import.meta.url)
  const script = fileURLToPath(url)
  const source = await readFile(url, 'utf8')
  const index = source.lastIndexOf('\nif (process.argv[1]')
  assert.ok(index > 0, 'The production direct-entry guard must exist')
  const entry = source.slice(index).replaceAll('import.meta.url', 'moduleUrl')
  const effects = [], stdout = [], stderr = []
  const runController = () => runVerifiedDeploymentCli({ env: { GITHUB_EVENT_PATH: 'must-not-be-read.json' },
    statEvent: async () => { effects.push('stat'); throw Error('Unexpected event access') },
    readEvent: async () => { effects.push('read'); throw Error('Unexpected event read') },
    requestDeployment: async () => { effects.push('request'); throw Error('Unexpected deployment request') },
    stdout: line => stdout.push(line), stderr: line => stderr.push(line) })
  const context = { process: { argv: ['node', script] }, resolve, fileURLToPath, moduleUrl: url.href, runVerifiedDeploymentCli: runController }
  await vm.runInNewContext('(async () => {' + entry + '\n})()', context)
  assert.equal(context.process.exitCode, 1)
  assert.deepEqual(effects, [])
  assert.deepEqual(stdout, [])
  assert.deepEqual(stderr.map(line => JSON.parse(line)), [{ state: 'refused', deploymentRequested: false, code: 'UNTRUSTED_WORKFLOW_CONTEXT' }])
  const imported = { ...context, process: { argv: ['node', 'another-script.mjs'] },
    runVerifiedDeploymentCli: () => { throw Error('An import must not execute the publisher') } }
  await vm.runInNewContext('(async () => {' + entry + '\n})()', imported)
  assert.equal(imported.process.exitCode, undefined)
})

test('CLI bounds event files and routes successful or uncertain outcomes through its real controller', async t => {
  const fx = fixture()
  const effects = [], stdout = [], stderr = []
  const input = { env: { ...fx.env, GITHUB_EVENT_PATH: 'synthetic-event.json' },
    statEvent: async path => { effects.push(['stat', path]); return { isFile: () => true, isSymbolicLink: () => false, size: 1000 } },
    readEvent: async (path, encoding) => { effects.push(['read', path, encoding]); return JSON.stringify(fx.event) },
    requestDeployment: async ({ env, event }) => { assert.equal(env, input.env); assert.deepEqual(event, fx.event); return { state: 'configuration_pending', deploymentRequested: false } },
    stdout: line => stdout.push(line), stderr: line => stderr.push(line) }
  assert.equal(await runVerifiedDeploymentCli(input), 0)
  assert.deepEqual(effects, [['stat', 'synthetic-event.json'], ['read', 'synthetic-event.json', 'utf8']])
  assert.deepEqual(JSON.parse(stdout[0]), { state: 'configuration_pending', deploymentRequested: false })
  assert.deepEqual(stderr, [])
  for (const [name, changes] of [
    ['missing path', { env: fx.env }],
    ['non-file', { statEvent: async () => ({ isFile: () => false }) }],
    ['symlink', { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => true }) }],
    ['oversize', { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 262145 }) }],
    ['invalid JSON', { readEvent: async () => 'private invalid event' }],
  ]) await t.test(name, async () => {
    let requested = false
    const errors = []
    assert.equal(await runVerifiedDeploymentCli({ ...input, ...changes,
      requestDeployment: async () => { requested = true }, stderr: line => errors.push(JSON.parse(line)) }), 1)
    assert.equal(requested, false)
    assert.deepEqual(errors, [{ state: 'refused', deploymentRequested: false, code: 'WORKFLOW_EVENT_UNAVAILABLE' }])
  })
  const unknown = { state: 'request_outcome_unknown', deploymentRequested: null, requestAttempted: true }
  const output = []
  assert.equal(await runVerifiedDeploymentCli({ ...input, requestDeployment: async () => unknown, stdout: line => output.push(JSON.parse(line)) }), 1)
  assert.deepEqual(output, [unknown], 'Uncertain POST must not be converted to a false not-requested claim')
})
