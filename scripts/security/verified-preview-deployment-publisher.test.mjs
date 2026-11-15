import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { CI_POLICY } from '../security-ci/verified-ci.mjs'
import { validatePreviewWorkflowRunEvent, selectPreviewHook, resolveVerifiedPreviewDeployment, requestVerifiedPreviewDeployment,
  readPreviewHookRegistry, runVerifiedPreviewDeploymentCli, PREVIEW_HOOK_TIMEOUT_MS, PREVIEW_REQUEST_TIMEOUT_MS } from '../security-ci/request-verified-preview-deployment.mjs'

const NOW = Date.parse('2026-11-15T20:00:00Z'), SHA = 'a'.repeat(40), MAIN = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const BRANCH = 'feature/synthetic-preview', SECRET = 'XELAY_PREVIEW_SYNTHETIC', TOKEN = 'synthetic_readonly_token'
const HOOK = 'https://api.vercel.com/v1/integrations/deploy/' + CI_POLICY.projectId + '/synthetic_preview_hook'
const API = 'https://api.github.com/repos/Olegys1/xelay'
const repository = () => ({ id: CI_POLICY.repositoryId, full_name: CI_POLICY.repository, owner: { id: CI_POLICY.ownerId }, fork: false })
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
const registry = () => ({ schemaVersion: 1, branches: { [BRANCH]: { hookSecretName: SECRET } } })
const receipt = () => ({ mode: 'preview', sha: SHA, branch: BRANCH, pullRequestNumber: 91, baseSha: MAIN, runId: 123, runAttempt: 2,
  repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId, ownerId: CI_POLICY.ownerId,
  workflowId: CI_POLICY.workflowId, workflowPath: CI_POLICY.workflowPath, workflowBlob: CI_POLICY.workflowBlob })

function fixture(options = {}) {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: CI_POLICY.repository,
    GITHUB_REPOSITORY_ID: String(CI_POLICY.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(CI_POLICY.ownerId),
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: MAIN, GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: TOKEN,
    XELAY_PREVIEW_HOOK_SECRET_NAME: SECRET, XELAY_PREVIEW_DEPLOY_HOOK: HOOK, ...options.env }
  const event = { action: 'completed', repository: repository(), workflow_run: { id: 123, run_attempt: 2, workflow_id: CI_POLICY.workflowId,
    name: CI_POLICY.workflowName, event: 'pull_request', head_branch: BRANCH, head_repository: repository(), head_sha: SHA,
    status: 'completed', conclusion: 'success', pull_requests: [{ number: 91 }], updated_at: new Date(NOW - 60000).toISOString() } }
  options.changeEvent?.(event)
  const selected = options.registry ?? registry()
  const fetches = [], proofs = []
  const responses = {
    [API + '/pulls/91']: () => json({ number: 91, state: 'open', merged: false, head: { ref: BRANCH, sha: SHA, repo: repository() }, base: { ref: 'main', sha: MAIN, repo: repository() } }),
    [API + '/git/ref/heads/' + encodeURIComponent(BRANCH)]: () => json({ ref: 'refs/heads/' + BRANCH, object: { type: 'commit', sha: SHA } }),
    [API + '/git/ref/heads/main']: () => json({ ref: 'refs/heads/main', object: { type: 'commit', sha: MAIN } }),
    [API + '/commits/' + SHA + '/status?per_page=100']: () => json({ sha: SHA, total_count: 0, statuses: [] }),
    [HOOK]: () => json({ job: { id: 'synthetic_job', state: 'PENDING' } }, 201),
    ...options.responses,
  }
  const fetchImpl = async (url, init) => {
    fetches.push({ url: String(url), init })
    assert.ok(Object.hasOwn(responses, String(url)), 'Only fixed API paths and the selected synthetic project hook may be requested')
    return responses[String(url)](init)
  }
  const verifyPreview = async input => { proofs.push(input); if (options.proofFailure) throw options.proofFailure; return options.receipt === undefined ? receipt() : options.receipt }
  const input = { env, event, registry: selected, now: options.now ?? NOW, fetchImpl, verifyPreview, checkoutSha: () => options.checkout ?? MAIN }
  return { env, event, input, fetches, proofs, resolve: () => resolveVerifiedPreviewDeployment({ ...input, env: { ...env, XELAY_PREVIEW_DEPLOY_HOOK: undefined } }), post: () => requestVerifiedPreviewDeployment(input) }
}
async function refused(fx, code) {
  await assert.rejects(fx.post(), error => error.code === code && !String(error).includes(HOOK) && !String(error).includes(TOKEN))
  assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 0)
}

test('trusted-main resolver exposes only a registry-approved secret name after exact PR proof', async () => {
  const fx = fixture(), result = await fx.resolve()
  assert.deepEqual(result, { state: 'ready', deploymentRequested: false, secretName: SECRET, sha: SHA, branch: BRANCH, pullRequestNumber: 91, runId: 123, runAttempt: 2, baseSha: MAIN })
  assert.equal(fx.fetches.length, 0); assert.equal(fx.proofs.length, 1)
  assert.deepEqual(Object.keys(fx.proofs[0]).sort(), ['branch', 'fetchImpl', 'now', 'pullRequestNumber', 'sha', 'token'])
  assert.equal(Object.isFrozen(result), true)
  assert.equal(JSON.stringify(result).includes(HOOK), false)
  await assert.rejects(resolveVerifiedPreviewDeployment(fx.input), { code: 'RESOLVER_SECRET_CONTEXT' })
})

test('poster rechecks PR, exact branch and trusted current main before one project-scoped POST with no payload or token', async () => {
  const fx = fixture(), result = await fx.post()
  assert.equal(result.state, 'requested'); assert.equal(result.deploymentRequested, true)
  assert.equal(result.sha, SHA); assert.equal(result.pullRequestNumber, 91); assert.equal(fx.proofs.length, 1)
  assert.deepEqual(fx.fetches.map(value => value.init.method), ['GET', 'GET', 'GET', 'POST'])
  for (const call of fx.fetches) { assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal instanceof AbortSignal) }
  assert.equal(fx.fetches[0].init.headers.Authorization, 'Bearer ' + TOKEN)
  assert.equal(fx.fetches.at(-1).init.headers, undefined); assert.equal(fx.fetches.at(-1).init.body, undefined)
  assert.doesNotMatch(JSON.stringify(result), /synthetic_preview_hook|synthetic_readonly|synthetic_job|https:/)
})

test('checked-in registry approves only the canary; unregistered or missing-hook configurations never request a deployment', async () => {
  const actual = JSON.parse(await readFile(new URL('../security-ci/preview-hook-registry.json', import.meta.url), 'utf8'))
  assert.deepEqual(actual, { schemaVersion: 1, branches: {
    'verify/preview-ci-20261115': { hookSecretName: 'XELAY_PREVIEW_CI_CANARY' },
  } })
  assert.equal(selectPreviewHook(actual, 'verify/preview-ci-20261115').secretName, 'XELAY_PREVIEW_CI_CANARY')
  for (const options of [{ registry: actual }, { registry: { schemaVersion: 1, branches: {} } },
    { registry: { schemaVersion: 1, branches: { other: { hookSecretName: 'XELAY_PREVIEW_OTHER' } } } }, { env: { XELAY_PREVIEW_DEPLOY_HOOK: '' } }]) {
    const fx = fixture(options)
    assert.equal((await fx.post()).state, 'configuration_pending'); assert.equal(fx.fetches.length, 0); assert.equal(fx.proofs.length, 0)
  }
})

test('foreign contexts, production secrets, unsafe branches and publisher reruns refuse before proof or POST', async t => {
  for (const [name, env, code] of [
    ['local', { GITHUB_ACTIONS: undefined }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['direct PR', { GITHUB_EVENT_NAME: 'pull_request' }, 'UNTRUSTED_WORKFLOW_CONTEXT'],
    ['other repo', { GITHUB_REPOSITORY: 'attacker/xelay' }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['other ID', { GITHUB_REPOSITORY_ID: '1' }, 'UNTRUSTED_WORKFLOW_CONTEXT'],
    ['other owner', { GITHUB_REPOSITORY_OWNER_ID: '1' }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['PR checkout', { GITHUB_REF: 'refs/pull/91/merge' }, 'UNTRUSTED_WORKFLOW_CONTEXT'],
    ['invalid trusted SHA', { GITHUB_SHA: 'main' }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['rerun', { GITHUB_RUN_ATTEMPT: '2' }, 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW'],
    ['missing attempt', { GITHUB_RUN_ATTEMPT: undefined }, 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW'], ['production secret', { XELAY_VERIFIED_DEPLOY_HOOK: 'private-production' }, 'PRODUCTION_SECRET_CONTEXT'],
  ]) await t.test(name, async () => { const fx = fixture({ env }); await refused(fx, code); assert.equal(fx.proofs.length, 0); assert.equal(fx.fetches.length, 0) })
  for (const value of ['main', 'Main', '../branch', 'feature//branch', 'branch.lock', 'bad branch', 'bad\nready=true', 'bad;echo', '-bad']) {
    const fx = fixture({ changeEvent: event => { event.workflow_run.head_branch = value } }); await refused(fx, 'UNTRUSTED_WORKFLOW_EVENT')
  }
})

test('workflow identity, fork, failure, stale timestamp and ambiguous PR event cannot reach privileged proof', async t => {
  for (const [name, mutate] of [
    ['fork', event => { event.workflow_run.head_repository.fork = true }], ['head repository', event => { event.workflow_run.head_repository.id = 1 }],
    ['owner', event => { event.repository.owner.id = 1 }], ['workflow', event => { event.workflow_run.workflow_id = 1 }],
    ['push', event => { event.workflow_run.event = 'push' }], ['schedule', event => { event.workflow_run.event = 'schedule' }],
    ['pending', event => { event.workflow_run.status = 'in_progress' }], ['skipped', event => { event.workflow_run.conclusion = 'skipped' }],
    ['unknown PR', event => { event.workflow_run.pull_requests = [] }], ['ambiguous PR', event => { event.workflow_run.pull_requests.push({ number: 92 }) }],
    ['missing attempt', event => { delete event.workflow_run.run_attempt }], ['SHA injection', event => { event.workflow_run.head_sha = 'private;sha' }],
  ]) await t.test(name, async () => { const fx = fixture({ changeEvent: mutate }); await refused(fx, 'UNTRUSTED_WORKFLOW_EVENT'); assert.equal(fx.proofs.length, 0) })
  for (const delta of [-7 * 3600000, 61000]) {
    const fx = fixture({ changeEvent: event => { event.workflow_run.updated_at = new Date(NOW + delta).toISOString() } })
    await refused(fx, 'STALE_WORKFLOW_EVENT')
  }
  await refused(fixture({ checkout: SHA }), 'TRUSTED_CHECKOUT_MISMATCH')
})

test('registry cannot select main, a production secret, a duplicate hook, arbitrary fields or getters', () => {
  let read = false
  const getter = { schemaVersion: 1, branches: { [BRANCH]: Object.defineProperty({}, 'hookSecretName', { enumerable: true, get() { read = true; throw Error('private') } }) } }
  for (const value of [null, {}, { schemaVersion: 2, branches: {} }, { schemaVersion: 1, branches: {}, hook: HOOK },
    { schemaVersion: 1, branches: { main: { hookSecretName: SECRET } } },
    { schemaVersion: 1, branches: { [BRANCH]: { hookSecretName: 'XELAY_VERIFIED_DEPLOY_HOOK' } } },
    { schemaVersion: 1, branches: { [BRANCH]: { hookSecretName: SECRET, url: HOOK } } },
    { schemaVersion: 1, branches: { [BRANCH]: { hookSecretName: SECRET }, other: { hookSecretName: SECRET } } }, getter]) {
    assert.throws(() => selectPreviewHook(value, BRANCH), { code: 'REGISTRY_INVALID' })
  }
  assert.equal(read, false)
})

test('selected secret name, hook project and every receipt identity dimension must match exactly', async () => {
  await refused(fixture({ env: { XELAY_PREVIEW_HOOK_SECRET_NAME: 'XELAY_PREVIEW_OTHER' } }), 'PREVIEW_SECRET_SELECTION_MISMATCH')
  for (const value of [HOOK.replace(CI_POLICY.projectId, 'prj_otherProject123'), HOOK + '?secret=x', HOOK.replace('api.vercel.com', 'evil.test'), HOOK.replace('https:', 'http:')]) {
    await refused(fixture({ env: { XELAY_PREVIEW_DEPLOY_HOOK: value } }), 'INVALID_PREVIEW_DEPLOY_HOOK')
  }
  for (const change of [{ mode: 'production' }, { sha: OTHER }, { branch: 'other' }, { baseSha: OTHER }, { pullRequestNumber: 92 }, { runId: 122 }, { runAttempt: 1 },
    { repository: 'other/xelay' }, { repositoryId: 1 }, { ownerId: 1 }, { workflowId: 1 }, { workflowPath: 'other.yml' }, { workflowBlob: '0'.repeat(40) }]) {
    await refused(fixture({ receipt: { ...receipt(), ...change } }), 'EVENT_PROOF_MISMATCH')
  }
  await refused(fixture({ proofFailure: Error(HOOK + TOKEN) }), 'PREVIEW_CI_PROOF_UNAVAILABLE')
})

test('late PR close, head/base/main movement and read failures prevent every hook request', async t => {
  const goodPr = { number: 91, state: 'open', merged: false, head: { ref: BRANCH, sha: SHA, repo: repository() }, base: { ref: 'main', sha: MAIN, repo: repository() } }
  for (const [name, path, body] of [
    ['closed', '/pulls/91', { ...goodPr, state: 'closed' }], ['head moved', '/pulls/91', { ...goodPr, head: { ...goodPr.head, sha: OTHER } }],
    ['unknown merged status', '/pulls/91', { ...goodPr, merged: undefined }],
    ['base moved', '/pulls/91', { ...goodPr, base: { ...goodPr.base, sha: OTHER } }],
    ['branch moved', '/git/ref/heads/' + encodeURIComponent(BRANCH), { ref: 'refs/heads/' + BRANCH, object: { type: 'commit', sha: OTHER } }],
    ['main moved', '/git/ref/heads/main', { ref: 'refs/heads/main', object: { type: 'commit', sha: OTHER } }],
  ]) await t.test(name, async () => { await refused(fixture({ responses: { [API + path]: () => json(body) } }), 'PREVIEW_HEAD_OR_BASE_MOVED') })
  await refused(fixture({ responses: { [API + '/pulls/91']: () => json({ secret: HOOK }, 503) } }), 'PREVIEW_RECHECK_UNAVAILABLE')
})

test('optional exact-project Vercel status dedupe is best effort and does not trust a name, actor or other project alone', async () => {
  const configured = registry(); configured.branches[BRANCH].status = { context: 'Vercel', creatorId: 77, projectPath: '/synthetic-team/synthetic-project' }
  const base = { id: 51, context: 'Vercel', state: 'pending', creator: { id: 77, login: 'vercel[bot]', type: 'Bot' }, target_url: 'https://vercel.com/synthetic-team/synthetic-project/synthetic-deployment' }
  for (const state of ['pending', 'success']) {
    const fx = fixture({ registry: configured, responses: { [API + '/commits/' + SHA + '/status?per_page=100']: () => json({ sha: SHA, total_count: 1, statuses: [{ ...base, state }] }) } })
    assert.equal((await fx.post()).state, 'already_requested'); assert.equal(fx.fetches.length, 1)
  }
  for (const change of [{ creator: { ...base.creator, id: 78 } }, { context: 'fake' }, { target_url: 'https://vercel.com/synthetic-team/other-project/deployment' },
    { target_url: 'https://evil.test/synthetic-team/synthetic-project/deployment' }, { state: 'failure' }]) {
    const fx = fixture({ registry: configured, responses: { [API + '/commits/' + SHA + '/status?per_page=100']: () => json({ sha: SHA, total_count: 1, statuses: [{ ...base, ...change }] }) } })
    assert.equal((await fx.post()).state, 'requested'); assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 1)
  }
  const fx = fixture({ registry: configured, responses: { [API + '/commits/' + SHA + '/status?per_page=100']: () => json({ sha: OTHER, total_count: 0, statuses: [] }) } })
  await refused(fx, 'DEPLOYMENT_HISTORY_UNAVAILABLE')
})

test('once POST is attempted every transport/receipt failure is uncertain and never retried or logged as not requested', async () => {
  for (const response of [() => { throw Error(HOOK + TOKEN) }, () => json({ private: HOOK }, 503), () => new Response(null, { status: 302, headers: { location: HOOK } }),
    () => json({ private: TOKEN }), () => new Response('private ' + HOOK, { headers: { 'content-type': 'application/json' } }),
    () => json({}, 200, { 'content-length': '-1' }), () => json({}, 200, { 'content-length': '16385' })]) {
    const fx = fixture({ responses: { [HOOK]: response } }), result = await fx.post()
    assert.equal(result.state, 'request_outcome_unknown'); assert.equal(result.deploymentRequested, null); assert.equal(result.requestAttempted, true)
    assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic_preview_hook|synthetic_readonly|https:/)
  }
})

test('independent deadlines bound stalled GitHub and hook bodies even if transport ignores cancellation', async t => {
  for (const target of ['read', 'hook']) await t.test(target, async sub => {
    sub.mock.timers.enable({ apis: ['setTimeout'] })
    let cancelled = false
    const stall = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
    const fx = fixture({ responses: { [target === 'hook' ? HOOK : API + '/pulls/91']: stall } })
    const promise = fx.post()
    const checked = target === 'hook' ? promise.then(result => { assert.equal(result.state, 'request_outcome_unknown'); assert.equal(result.deploymentRequested, null) }) : assert.rejects(promise, { code: 'PREVIEW_RECHECK_UNAVAILABLE' })
    const count = target === 'hook' ? 4 : 1
    for (let n = 0; n < 30 && fx.fetches.length < count; n++) await nextTurn()
    assert.equal(fx.fetches.length, count)
    const limit = target === 'hook' ? PREVIEW_HOOK_TIMEOUT_MS : PREVIEW_REQUEST_TIMEOUT_MS
    sub.mock.timers.tick(limit - 1); assert.equal(fx.fetches.at(-1).init.signal.aborted, false)
    sub.mock.timers.tick(2); await checked
    assert.equal(cancelled, true); assert.equal(fx.fetches.at(-1).init.signal.aborted, true)
  })
})

test('workflow separates secret-free resolution and a project-scoped credential; both checkouts are immutable main', async () => {
  const source = await readFile(new URL('../../.github/workflows/deploy-preview-verified.yml', import.meta.url), 'utf8')
  assert.match(source, /workflow_run:\s*\n\s*workflows: \[Security checks\]\s*\n\s*types: \[completed\]/)
  assert.match(source, /permissions: \{\}/); assert.match(source, /environment: preview-release/)
  assert.equal((source.match(/ref: \$\{\{ github.sha \}\}/g) ?? []).length, 2)
  assert.doesNotMatch(source, /ref:.*head_sha|production-release|XELAY_VERIFIED_DEPLOY_HOOK|VERCEL_TOKEN|pull_request_target|download-artifact|npm ci|npm install|npx|:\s*write/)
  assert.equal((source.match(/secrets\./g) ?? []).length, 1)
  assert.match(source, /secrets\.XELAY_PREVIEW_PROJECT_TOKEN/)
  assert.ok(source.indexOf('secrets.') > source.indexOf('request-preview:'))
  assert.match(source, /github.event.workflow_run.head_repository.fork == false/)
  assert.match(source, /github.run_attempt == 1/)
})

test('registry/event file reads are bounded and CLI real entrypoint refuses direct invocation before any read', async () => {
  let read = false
  await assert.rejects(readPreviewHookRegistry({ stat: async () => ({ isFile: () => true, isSymbolicLink: () => true }), read: async () => { read = true } }), { code: 'REGISTRY_INVALID' })
  assert.equal(read, false)
  const url = new URL('../security-ci/request-verified-preview-deployment.mjs', import.meta.url), script = fileURLToPath(url)
  const source = await readFile(url, 'utf8'), entry = source.slice(source.lastIndexOf('\nif (process.argv[1]')).replaceAll('import.meta.url', 'moduleUrl')
  const errors = [], effects = []
  const context = { process: { argv: ['node', script, 'post'] }, resolve, fileURLToPath, moduleUrl: url.href,
    runVerifiedPreviewDeploymentCli: options => runVerifiedPreviewDeploymentCli({ ...options, env: {}, statEvent: async () => { effects.push('read') }, stderr: line => errors.push(JSON.parse(line)) }) }
  await vm.runInNewContext('(async () => {' + entry + '\n})()', context)
  assert.equal(context.process.exitCode, 1); assert.deepEqual(effects, [])
  assert.deepEqual(errors, [{ state: 'refused', deploymentRequested: false, code: 'UNTRUSTED_WORKFLOW_CONTEXT' }])
  const imported = { ...context, process: { argv: ['node', 'different-script.mjs'] }, runVerifiedPreviewDeploymentCli: () => { throw Error('Import must not execute the publisher') } }
  await vm.runInNewContext('(async () => {' + entry + '\n})()', imported)
  assert.equal(imported.process.exitCode, undefined)
  for (const size of [-1, NaN, 32769]) {
    await assert.rejects(readPreviewHookRegistry({ stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size }), read: async () => { throw Error('Must not read oversized registry') } }), { code: 'REGISTRY_INVALID' })
  }
  assert.deepEqual(await readPreviewHookRegistry({ stat: async path => {
    assert.equal(path.pathname.endsWith('/scripts/security-ci/preview-hook-registry.json'), true)
    return { isFile: () => true, isSymbolicLink: () => false, size: 100 }
  }, read: async () => '{"schemaVersion":1,"branches":{}}' }), { schemaVersion: 1, branches: {} })
})

test('CLI rejects malformed/oversized event files before registry resolution, output or provider actions', async () => {
  const fx = fixture(), errors = []
  let resolved = false
  const input = { phase: 'resolve', env: { ...fx.env, GITHUB_EVENT_PATH: 'synthetic-event.json' },
    statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readEvent: async () => JSON.stringify(fx.event),
    readRegistry: async () => { resolved = true; throw Error('Unexpected registry read') }, writeOutput: async () => { throw Error('Unexpected output') },
    stdout: () => { throw Error('Unexpected public output') }, stderr: line => errors.push(JSON.parse(line)) }
  for (const change of [{ env: fx.env }, { statEvent: async () => ({ isFile: () => false }) },
    { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => true }) },
    { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: -1 }) },
    { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 262145 }) },
    { readEvent: async () => 'PRIVATE_INVALID_EVENT' }, { readEvent: async () => ' '.repeat(262145) }]) {
    assert.equal(await runVerifiedPreviewDeploymentCli({ ...input, ...change }), 1)
    assert.equal(resolved, false)
    assert.deepEqual(errors.at(-1), { state: 'refused', deploymentRequested: false, code: 'WORKFLOW_EVENT_UNAVAILABLE' })
  }
})

test('CLI resolver writes only safe selected name outputs; missing configuration and unknown POST are represented accurately', async () => {
  const fx = fixture(), output = [], stdout = [], stderr = []
  const input = { phase: 'resolve', env: { ...fx.env, GITHUB_EVENT_PATH: 'synthetic-event.json' },
    statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readEvent: async () => JSON.stringify(fx.event), readRegistry: async () => registry(),
    resolver: async () => ({ state: 'ready', deploymentRequested: false, secretName: SECRET }), writeOutput: async value => output.push(value),
    stdout: line => stdout.push(JSON.parse(line)), stderr: line => stderr.push(JSON.parse(line)) }
  assert.equal(await runVerifiedPreviewDeploymentCli(input), 0); assert.deepEqual(output, ['ready=true\nsecretName=' + SECRET + '\n'])
  assert.deepEqual(stderr, [])
  const invalid = []
  assert.equal(await runVerifiedPreviewDeploymentCli({ ...input, resolver: async () => ({ state: 'ready', secretName: 'XELAY_VERIFIED_DEPLOY_HOOK\nready=true' }), writeOutput: async value => invalid.push(value) }), 1)
  assert.deepEqual(invalid, [])
  const unknown = { state: 'request_outcome_unknown', deploymentRequested: null, requestAttempted: true }
  assert.equal(await runVerifiedPreviewDeploymentCli({ ...input, phase: 'post', requester: async () => unknown }), 1)
  assert.deepEqual(stdout.at(-1), unknown)
})
