import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { CI_POLICY, CI_FRESHNESS_MS } from '../security-ci/verified-ci.mjs'
import { resolveVerifiedBranchDeployment, requestVerifiedBranchDeployment, runVerifiedBranchDeploymentCli,
  BRANCH_POST_TIMEOUT_MS, BRANCH_REQUEST_TIMEOUT_MS, BRANCH_DEPLOYMENT_MAX_PAGES } from '../security-ci/request-verified-branch-deployment.mjs'

const NOW = Date.parse('2026-11-15T12:00:00Z'), SHA = 'a'.repeat(40), MAIN = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const BRANCH = 'feature/new-unregistered-branch', GH = 'https://api.github.com/repos/Olegys1/xelay', VC = 'https://api.vercel.com'
const TOKEN = 'vcp_synthetic_project_only_credential_123456', GH_TOKEN = 'synthetic_readonly_github_credential'
const repository = () => ({ id: CI_POLICY.repositoryId, owner: { id: CI_POLICY.ownerId }, full_name: CI_POLICY.repository, fork: false })
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
const source = (branch = BRANCH) => ({ type: 'github', repoId: CI_POLICY.repositoryId, ref: branch, sha: SHA })
const deployment = (state = 'READY', branch = BRANCH) => ({ uid: 'dpl_Synthetic1', projectId: CI_POLICY.projectId, target: null, state,
  createdAt: NOW - 60000, meta: { githubCommitSha: SHA, githubCommitRef: branch, githubCommitRepoId: String(CI_POLICY.repositoryId) } })
const created = (branch = BRANCH) => ({ id: 'dpl_Synthetic2', projectId: CI_POLICY.projectId, target: null, readyState: 'QUEUED', gitSource: source(branch) })
const history = values => ({ deployments: values, pagination: { count: values.length, next: null, prev: null } })
function receipt(event = 'push', branch = BRANCH) {
  return { mode: 'preview', authority: 'branch-head-ci', event, sha: SHA, branch, baseSha: MAIN, runId: 123, runAttempt: 2,
    repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId, ownerId: CI_POLICY.ownerId,
    workflowId: CI_POLICY.workflowId, workflowPath: CI_POLICY.workflowPath, workflowBlob: CI_POLICY.workflowBlob,
    completedAt: new Date(NOW - 30000).toISOString(), verifiedAt: new Date(NOW).toISOString() }
}
function fixture(options = {}) {
  const branch = options.branch ?? BRANCH, ciEvent = options.ciEvent ?? 'push'
  const event = { action: 'completed', repository: repository(), workflow_run: { id: 123, run_attempt: 2,
    workflow_id: CI_POLICY.workflowId, name: CI_POLICY.workflowName, event: ciEvent, head_branch: branch, head_sha: SHA,
    head_repository: repository(), status: 'completed', conclusion: 'success', updated_at: new Date(NOW - 30000).toISOString(), pull_requests: [] } }
  options.changeEvent?.(event)
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: CI_POLICY.repository,
    GITHUB_REPOSITORY_ID: String(CI_POLICY.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(CI_POLICY.ownerId),
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: MAIN, GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: GH_TOKEN,
    XELAY_PREVIEW_PROJECT_TOKEN: TOKEN, ...options.env }
  const fetches = [], proofs = []
  const input = { env, event, now: NOW, checkoutSha: () => options.checkout ?? MAIN,
    verifyPreview: async values => { proofs.push(values); if (options.proofFailure) throw options.proofFailure
      return options.receipt ?? receipt(ciEvent, branch) },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init })
      if (options.fetch) { const result = await options.fetch(url, init, fetches); if (result !== undefined) return result }
      if (url.startsWith(VC + '/v7/deployments?')) return json(history(options.history ?? []))
      if (url === GH + '/git/ref/heads/' + encodeURIComponent(branch)) return json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha: SHA } })
      if (url === GH + '/git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: MAIN } })
      if (url === VC + '/v13/deployments' && init.method === 'POST') return json(created(branch))
      if (url === VC + '/v13/deployments/dpl_Synthetic2?withGitRepoInfo=true') return json(created(branch))
      throw Error('Unexpected fixture request')
    } }
  return { env, event, input, fetches, proofs, post: () => requestVerifiedBranchDeployment(input),
    resolve: () => resolveVerifiedBranchDeployment({ ...input, env: { ...env, XELAY_PREVIEW_PROJECT_TOKEN: undefined } }) }
}
async function refused(fx, code) {
  await assert.rejects(fx.post(), error => error.code === code && !String(error).includes(TOKEN) && !String(error).includes(GH_TOKEN))
  assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 0)
}

test('resolver accepts every valid same-repository branch and push without an open PR; exposes no credential output', async () => {
  for (const branch of ['feature/new-never-registered', 'fix/deep/path_1', 'release-2026.11', 'student/test']) {
    const fx = fixture({ branch }), result = await fx.resolve()
    assert.equal(result.state, 'ready'); assert.equal(result.branch, branch); assert.equal(result.baseSha, MAIN)
    assert.equal(fx.fetches.length, 0); assert.equal(fx.proofs.length, 1)
    assert.deepEqual(Object.keys(fx.proofs[0]).sort(), ['branch', 'fetchImpl', 'now', 'sha', 'signal', 'token'])
    assert.equal(fx.proofs[0].token, GH_TOKEN)
    assert.doesNotMatch(JSON.stringify(result), /synthetic_project|synthetic_readonly|secretName|registry/)
  }
  const fx = fixture(); await assert.rejects(resolveVerifiedBranchDeployment(fx.input), { code: 'RESOLVER_SECRET_CONTEXT' })
})

test('PR and separate fork checks can never authorize Preview, even with successful-looking receipts', async () => {
  for (const ciEvent of ['pull_request', 'pull_request_target']) {
    const fx = fixture({ ciEvent })
    await refused(fx, 'UNTRUSTED_WORKFLOW_EVENT')
    await assert.rejects(fx.resolve(), { code: 'UNTRUSTED_WORKFLOW_EVENT' })
    assert.equal(fx.proofs.length, 0); assert.equal(fx.fetches.length, 0)
  }
  const fork = fixture({ changeEvent: event => { event.workflow_run.name = 'Fork security checks'; event.workflow_run.workflow_id = 1 } })
  await refused(fork, 'UNTRUSTED_WORKFLOW_EVENT'); assert.equal(fork.proofs.length, 0)
})

test('poster revalidates CI twice then reads branch and main immediately before one exact Preview-only REST request', async () => {
  const fx = fixture(), result = await fx.post()
  assert.equal(result.state, 'requested'); assert.equal(result.deploymentRequested, true); assert.equal(fx.proofs.length, 2)
  assert.deepEqual(fx.fetches.map(value => value.init.method), ['GET', 'GET', 'GET', 'POST'])
  const first = new URL(fx.fetches[0].url)
  assert.equal(first.origin, VC); assert.equal(first.pathname, '/v7/deployments')
  assert.deepEqual(Object.fromEntries(first.searchParams), { projectId: CI_POLICY.projectId, branch: BRANCH, sha: SHA, limit: '100' })
  assert.equal(fx.fetches[1].url, GH + '/git/ref/heads/' + encodeURIComponent(BRANCH))
  assert.equal(fx.fetches[2].url, GH + '/git/ref/heads/main')
  const post = fx.fetches.at(-1)
  assert.equal(post.url, VC + '/v13/deployments')
  assert.deepEqual(JSON.parse(post.init.body), { name: 'xelay', project: CI_POLICY.projectId, gitSource: source() })
  assert.doesNotMatch(post.init.body, /target|files|settings|env|hook|token|buildMachine/)
  for (const call of fx.fetches) {
    assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store'); assert.ok(call.init.signal instanceof AbortSignal)
    assert.equal(call.init.headers.Authorization, 'Bearer ' + (call.url.startsWith(GH) ? GH_TOKEN : TOKEN))
  }
  assert.doesNotMatch(JSON.stringify(result), /synthetic_project|synthetic_readonly|https:/)
})

test('missing project token is configuration pending with no proof, HTTP or POST; invalid or legacy credentials refuse', async () => {
  const fx = fixture({ env: { XELAY_PREVIEW_PROJECT_TOKEN: '' } })
  assert.deepEqual(await fx.post(), { state: 'configuration_pending', deploymentRequested: false, reason: 'preview_project_token_not_configured' })
  assert.equal(fx.fetches.length, 0); assert.equal(fx.proofs.length, 0)
  for (const token of ['full-account-not-a-token', 'vcp_short', TOKEN + '\n', TOKEN + ' ', 'Bearer ' + TOKEN]) await refused(fixture({ env: { XELAY_PREVIEW_PROJECT_TOKEN: token } }), 'INVALID_PROJECT_TOKEN')
  await refused(fixture({ env: { XELAY_VERIFIED_DEPLOY_HOOK: 'production-secret' } }), 'PRODUCTION_SECRET_CONTEXT')
  await refused(fixture({ env: { XELAY_PREVIEW_DEPLOY_HOOK: 'legacy-hook' } }), 'LEGACY_SECRET_CONTEXT')
})

test('foreign workflow context, forks, main and publisher reruns cannot use the project token', async t => {
  for (const [name, env, code] of [
    ['local', { GITHUB_ACTIONS: undefined }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['PR', { GITHUB_EVENT_NAME: 'pull_request' }, 'UNTRUSTED_WORKFLOW_CONTEXT'],
    ['other repo', { GITHUB_REPOSITORY: 'evil/xelay' }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['ID', { GITHUB_REPOSITORY_ID: '1' }, 'UNTRUSTED_WORKFLOW_CONTEXT'],
    ['owner', { GITHUB_REPOSITORY_OWNER_ID: '1' }, 'UNTRUSTED_WORKFLOW_CONTEXT'], ['branch checkout', { GITHUB_REF: 'refs/heads/feature' }, 'UNTRUSTED_WORKFLOW_CONTEXT'],
    ['rerun', { GITHUB_RUN_ATTEMPT: '2' }, 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW'], ['attempt absent', { GITHUB_RUN_ATTEMPT: undefined }, 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW'],
  ]) await t.test(name, async () => { const fx = fixture({ env }); await refused(fx, code); assert.equal(fx.proofs.length, 0) })
  for (const branch of ['main', '../evil', 'bad\nready=true', 'bad;echo', 'bad//path', 'bad.lock', SHA]) await refused(fixture({ branch }), 'UNTRUSTED_WORKFLOW_EVENT')
  for (const mutate of [event => { event.workflow_run.head_repository.fork = true }, event => { event.repository.owner.id = 1 },
    event => { event.workflow_run.workflow_id = 1 }, event => { event.workflow_run.event = 'workflow_dispatch' },
    event => { event.workflow_run.status = 'in_progress' }, event => { event.workflow_run.conclusion = 'failure' },
    event => { event.workflow_run.head_sha = OTHER + '\n' }]) await refused(fixture({ changeEvent: mutate }), 'UNTRUSTED_WORKFLOW_EVENT')
  await refused(fixture({ checkout: SHA }), 'TRUSTED_CHECKOUT_MISMATCH')
  await refused(fixture({ changeEvent: event => { event.workflow_run.updated_at = new Date(NOW - CI_FRESHNESS_MS - 1).toISOString() } }), 'STALE_WORKFLOW_EVENT')
})

test('every exact proof authority dimension is mandatory and provider errors never expose credentials', async () => {
  for (const change of [{ mode: 'production' }, { authority: 'pr-merge' }, { event: 'pull_request' }, { sha: OTHER }, { branch: 'other' },
    { baseSha: OTHER }, { runId: 124 }, { runAttempt: 3 }, { repository: 'evil/xelay' }, { repositoryId: 1 }, { ownerId: 1 },
    { workflowId: 1 }, { workflowPath: 'other.yml' }, { workflowBlob: OTHER }, { completedAt: 'invalid' }]) {
    await refused(fixture({ receipt: { ...receipt(), ...change } }), 'EVENT_PROOF_MISMATCH')
  }
  await refused(fixture({ proofFailure: Error(TOKEN + GH_TOKEN) }), 'PREVIEW_CI_PROOF_UNAVAILABLE')
  let count = 0
  const fx = fixture(); fx.input.verifyPreview = async () => { if (++count === 2) throw Error(TOKEN); return receipt() }
  await refused(fx, 'PREVIEW_CI_PROOF_UNAVAILABLE')
})

test('exact project/branch/SHA active Preview states dedupe; failed build requires a newer security event', async () => {
  for (const state of ['QUEUED', 'INITIALIZING', 'BUILDING', 'READY']) {
    const fx = fixture({ history: [{ ...deployment(state), createdAt: NOW - 10000 }] }), result = await fx.post()
    assert.equal(result.state, 'already_requested'); assert.equal(fx.fetches.length, 1)
  }
  for (const state of ['QUEUED', 'INITIALIZING', 'BUILDING']) {
    const fx = fixture({ history: [deployment(state)] }), result = await fx.post()
    assert.equal(result.state, 'requested', 'a pre-CI active build cannot consume the successful-CI event')
    assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 1)
  }
  assert.equal((await fixture({ history: [deployment('READY')] }).post()).state, 'already_requested')
  for (const state of ['ERROR', 'CANCELED', 'BLOCKED']) {
    assert.equal((await fixture({ history: [deployment(state)] }).post()).state, 'requested')
    await refused(fixture({ history: [{ ...deployment(state), createdAt: NOW - 10000 }] }), 'DEPLOYMENT_RETRY_REQUIRES_FRESH_CI')
  }
  for (const change of [{ projectId: 'prj_wrongProject' }, { meta: { ...deployment().meta, githubCommitRef: 'other' } },
    { meta: { ...deployment().meta, githubCommitSha: OTHER } }, { meta: { ...deployment().meta, githubCommitRepoId: '1' } }, { target: undefined }, { state: 'NEW_UNKNOWN' }]) {
    await refused(fixture({ history: [{ ...deployment(), ...change }] }), 'DEPLOYMENT_HISTORY_UNAVAILABLE')
  }
  const production = fixture({ history: [{ ...deployment(), target: 'production' }] })
  assert.equal((await production.post()).state, 'requested')
})

test('bounded deployment pagination is traversed, and malformed, repeated or excessive cursors fail closed', async () => {
  const emptyWithNext = fixture({ fetch: url => url.startsWith(VC + '/v7/') ? json({ deployments: [], pagination: { count: 0, next: 123 } }) : undefined })
  await refused(emptyWithNext, 'DEPLOYMENT_HISTORY_UNAVAILABLE')
  const repeated = fixture({ fetch: url => url.startsWith(VC + '/v7/') ? json({ deployments: [{ ...deployment('ERROR'), uid: 'dpl_' + ('until' in Object.fromEntries(new URL(url).searchParams) ? 'Second' : 'First') }], pagination: { count: 1, next: NOW - 60000 } }) : undefined })
  await refused(repeated, 'DEPLOYMENT_HISTORY_UNAVAILABLE')
  let pages = 0
  const bounded = fixture({ fetch: url => url.startsWith(VC + '/v7/') ? json({ deployments: [{ ...deployment('ERROR'), uid: 'dpl_Page' + ++pages }], pagination: { count: 1, next: NOW - pages * 1000 } }) : undefined })
  await refused(bounded, 'DEPLOYMENT_HISTORY_UNAVAILABLE'); assert.equal(pages, BRANCH_DEPLOYMENT_MAX_PAGES)
  let seen = 0
  const succeeds = fixture({ fetch: url => url.startsWith(VC + '/v7/') ? json(++seen === 1
    ? { deployments: [{ ...deployment('ERROR'), uid: 'dpl_OldError' }], pagination: { count: 1, next: NOW - 60000 } }
    : history([{ ...deployment('BUILDING'), createdAt: NOW - 10000 }])) : undefined })
  assert.equal((await succeeds.post()).state, 'already_requested'); assert.equal(seen, 2)
})

test('branch or main movement and wrong-scope API responses fail before mutation', async () => {
  for (const branch of [BRANCH, 'main']) {
    const fx = fixture({ fetch: url => url === GH + '/git/ref/heads/' + encodeURIComponent(branch)
      ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha: OTHER } }) : undefined })
    await refused(fx, 'PREVIEW_HEAD_OR_BASE_MOVED')
  }
  await refused(fixture({ fetch: url => url.startsWith(VC + '/v7/') ? json({ message: TOKEN }, 403) : undefined }), 'DEPLOYMENT_HISTORY_UNAVAILABLE')
  await refused(fixture({ fetch: url => url.startsWith(GH) ? json({ message: GH_TOKEN }, 503) : undefined }), 'PREVIEW_RECHECK_UNAVAILABLE')
})

test('actual create receipt validates source, project and null Preview target; reduced receipt uses fixed authenticated detail lookup', async () => {
  const reduced = fixture({ fetch: (url, init) => init.method === 'POST' ? json({ id: 'dpl_Synthetic2', readyState: 'QUEUED', target: null }) : undefined })
  assert.equal((await reduced.post()).state, 'requested')
  assert.equal(reduced.fetches.at(-1).url, VC + '/v13/deployments/dpl_Synthetic2?withGitRepoInfo=true')
  for (const change of [{ projectId: 'prj_otherProject' }, { target: 'production' }, { target: undefined }, { id: 'https://evil.test/' },
    { gitSource: { ...source(), sha: OTHER } }, { gitSource: { ...source(), ref: 'other' } }, { gitSource: { ...source(), repoId: 1 } },
    { meta: { githubCommitSha: OTHER } }, { readyState: 'ERROR' }]) {
    const fx = fixture({ fetch: (url, init) => init.method === 'POST' ? json({ ...created(), ...change }) : undefined }), result = await fx.post()
    assert.equal(result.state, 'request_outcome_unknown'); assert.equal(result.deploymentRequested, null)
    assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 1)
  }
})

test('ambiguous POST outcomes never retry and never log response bodies, credentials or URLs', async () => {
  for (const response of [() => { throw Error(TOKEN + GH_TOKEN) }, () => json({ private: TOKEN }, 503),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }), () => json({ private: TOKEN }),
    () => new Response('private ' + TOKEN, { headers: { 'content-type': 'application/json' } }),
    () => json({}, 200, { 'content-length': '-1' }), () => json({}, 200, { 'content-length': '524289' })]) {
    const fx = fixture({ fetch: (url, init) => init.method === 'POST' ? response() : undefined }), result = await fx.post()
    assert.equal(result.state, 'request_outcome_unknown'); assert.equal(result.requestAttempted, true)
    assert.equal(fx.fetches.filter(value => value.init.method === 'POST').length, 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic_project|synthetic_readonly|https:/)
  }
})

test('independent deadlines bound stalled reads and POST bodies even when transport ignores cancellation', async t => {
  for (const target of ['history', 'post']) await t.test(target, async sub => {
    sub.mock.timers.enable({ apis: ['setTimeout'] })
    let cancelled = false
    const stall = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
    const fx = fixture({ fetch: (url, init) => (target === 'post' ? init.method === 'POST' : url.startsWith(VC + '/v7/')) ? stall() : undefined })
    const promise = fx.post(), checked = target === 'post' ? promise.then(result => assert.equal(result.state, 'request_outcome_unknown'))
      : assert.rejects(promise, { code: 'DEPLOYMENT_HISTORY_UNAVAILABLE' })
    const count = target === 'post' ? 4 : 1
    for (let i = 0; i < 50 && fx.fetches.length < count; i++) await nextTurn()
    assert.equal(fx.fetches.length, count)
    sub.mock.timers.tick((target === 'post' ? BRANCH_POST_TIMEOUT_MS : BRANCH_REQUEST_TIMEOUT_MS) + 1)
    await checked; assert.equal(cancelled, true); assert.equal(fx.fetches.at(-1).init.signal.aborted, true)
  })
})

test('workflow has two immutable-main jobs, read-only GitHub permissions, and one project credential only in final step', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy-preview-verified.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflows: \[Security checks\]/); assert.match(workflow, /permissions: \{\}/)
  assert.match(workflow, /github.event.workflow_run.event == 'push' &&/)
  assert.doesNotMatch(workflow, /workflow_run.event == 'pull_request'/)
  assert.equal((workflow.match(/ref: \$\{\{ github.sha \}\}/g) ?? []).length, 2)
  assert.match(workflow, /environment: preview-release/); assert.match(workflow, /github.run_attempt == 1/)
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 1)
  assert.match(workflow, /XELAY_PREVIEW_PROJECT_TOKEN: \$\{\{ secrets.XELAY_PREVIEW_PROJECT_TOKEN \}\}/)
  assert.ok(workflow.indexOf('secrets.') > workflow.indexOf('request-preview:'))
  assert.doesNotMatch(workflow, /secretName|secrets\[|registry|XELAY_PREVIEW_DEPLOY_HOOK|production-release|pull_request_target|head_sha.*checkout|npm ci|npm install|npx|download-artifact|:\s*write/)
})

test('CLI refuses untrusted/oversized event files and emits fixed codes without secret content', async () => {
  const fx = fixture(), stdout = [], stderr = [], outputs = []
  const input = { phase: 'resolve', env: { ...fx.env, GITHUB_EVENT_PATH: 'synthetic-event.json', XELAY_PREVIEW_PROJECT_TOKEN: undefined },
    statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readEvent: async () => JSON.stringify(fx.event),
    resolver: async () => ({ state: 'ready', deploymentRequested: false }), writeOutput: async line => outputs.push(line),
    stdout: line => stdout.push(JSON.parse(line)), stderr: line => stderr.push(JSON.parse(line)) }
  assert.equal(await runVerifiedBranchDeploymentCli(input), 0); assert.deepEqual(outputs, ['ready=true\n'])
  for (const change of [{ env: {} }, { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => true }) },
    { statEvent: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 262145 }) },
    { readEvent: async () => TOKEN }, { resolver: async () => { throw Error(TOKEN) } }]) {
    assert.equal(await runVerifiedBranchDeploymentCli({ ...input, ...change }), 1)
    assert.doesNotMatch(JSON.stringify(stderr.at(-1)), /synthetic_project|synthetic_readonly/)
  }
  const unknown = { state: 'request_outcome_unknown', deploymentRequested: null, requestAttempted: true }
  assert.equal(await runVerifiedBranchDeploymentCli({ ...input, phase: 'post', requester: async () => unknown }), 1)
  assert.deepEqual(stdout.at(-1), unknown)
})
