// Independent boundary fixtures: real source hashing and real provider/gate code.
// Only the read-only Git transport and HTTP transport are synthetic. No sockets,
// subprocesses, deployed resources, credentials or green receipt stubs are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { CI_POLICY } from '../security-ci/verified-ci.mjs'
import { verifyGithubPreview } from '../security-ci/verified-preview-ci.mjs'
import { verifiedVercelReceipt } from '../security-ci/vercel-gate.mjs'
import { requestVerifiedPreviewDeployment } from '../security-ci/request-verified-preview-deployment.mjs'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const BRANCH = 'test/verified-preview-boundary', PR = 76, PR_ID = 7600
const ROOT = '/repos/Olegys1/xelay'
const HOOK = 'https://api.vercel.com/v1/integrations/deploy/prj_Yl9R5uI2IdwyeNaIhbfIlObMO5bq/fictional_preview_hook_only'
const iso = delta => new Date(NOW + delta).toISOString()
const copy = value => structuredClone(value)
const objectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
// These expectations intentionally do not come from REQUIRED_CI_JOBS. Removing
// a mandatory job/step in production code must not silently weaken this fixture.
const CHECKOUT = 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const EXACT = 'Verify exact checkout and integration with current main'
const NODE = 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
const MANDATORY = {
  'security-core': [CHECKOUT, EXACT, NODE, 'Install the locked dependencies without lifecycle scripts', 'Run the curated offline suite sequentially'],
  'security-dependencies': [CHECKOUT, EXACT, NODE, 'Reject high or critical known dependency advisories'],
  'security-secrets': [CHECKOUT, EXACT, NODE, 'Fetch the official pinned Gitleaks CLI and verify before extraction', 'Scan selected working files and all fetched history, with values withheld'],
}

async function sourceFixture(t) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'xelay-preview-boundary-'))
  t.after(async () => {
    assert.equal(dirname(directory), parent)
    assert.match(basename(directory), /^xelay-preview-boundary-/)
    await rm(directory, { recursive: true, force: true })
  })
  const files = new Map([
    ['app.js', Buffer.from('export const source = "exact checked HEAD"\n')],
    ['package.json', Buffer.from('{"private":true,"type":"module"}\n')],
  ])
  await mkdir(join(directory, '.git'))
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes)
  const entries = [...files].map(([name, bytes]) => ({ name, hash: objectHash('blob', bytes) }))
  const tree = Buffer.concat(entries.flatMap(({ name, hash }) => [Buffer.from(`100644 ${name}\0`), Buffer.from(hash, 'hex')]))
  const treeId = objectHash('tree', tree)
  const commit = Buffer.from(`tree ${treeId}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nindependent preview boundary\n`)
  const sha = objectHash('commit', commit), gitReads = []
  const spawn = (command, args, options) => {
    assert.equal(command, 'git'); assert.equal(options.shell, false); assert.equal(options.cwd, directory)
    assert.ok(args.includes(`--git-dir=${join(directory, '.git')}`))
    assert.ok(args.includes(`--work-tree=${directory}`)); assert.ok(args.includes('--no-replace-objects'))
    gitReads.push(args)
    if (args.includes('rev-parse')) return { status: 0, stdout: Buffer.from(sha + '\n') }
    if (args.includes('ls-tree')) return { status: 0, stdout: Buffer.from(entries.map(({ name, hash }) => `100644 blob ${hash}\t${name}\0`).join('')) }
    if (args.includes('--batch')) {
      assert.equal(options.input.toString(), treeId + '\n')
      return { status: 0, stdout: Buffer.concat([Buffer.from(`${treeId} tree ${tree.length}\n`), tree, Buffer.from('\n')]) }
    }
    assert.ok(args.includes('commit')); assert.equal(args.at(-1), sha)
    return { status: 0, stdout: commit }
  }
  return { directory, sha, spawn, gitReads }
}

function publicProvider(sha, { mutate } = {}) {
  const repository = { id: 1258728015, full_name: 'Olegys1/xelay', owner: { id: 290528340 }, private: false, default_branch: 'main', fork: false }
  const pull = { id: PR_ID, number: PR, state: 'open', merged: false,
    head: { sha, ref: BRANCH, repo: repository }, base: { sha: BASE, ref: 'main', repo: repository } }
  const run = { id: 9100, run_number: 12, run_attempt: 1, check_suite_id: 8100,
    workflow_id: 399954171, path: '.github/workflows/security-checks.yml', name: 'Security checks',
    event: 'pull_request', head_branch: BRANCH, head_sha: sha, repository, head_repository: repository,
    status: 'completed', conclusion: 'success', created_at: iso(-300_000), run_started_at: iso(-240_000), updated_at: iso(-30_000),
    pull_requests: [pull],
  }
  const jobs = Object.entries(MANDATORY).map(([name, required], index) => ({
    id: 1000 + index, name, run_id: run.id, run_attempt: 1, head_sha: sha, head_branch: BRANCH, workflow_name: 'Security checks',
    status: 'completed', conclusion: 'success', started_at: iso(-180_000), completed_at: iso(-60_000),
    steps: required.map((name, index) => ({ name, number: index + 1, status: 'completed', conclusion: 'success' })),
  }))
  const state = { repository, pull, run, runs: [run], jobs, main: BASE, head: sha,
    comparison: { base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, behind_by: 0, ahead_by: 1, status: 'ahead' } }
  const calls = [], posts = [], occurrences = new Map()
  async function fetchImpl(address, init = {}) {
    const url = new URL(address), path = decodeURIComponent(url.pathname), method = init.method ?? 'GET'
    calls.push({ url, method })
    if (method === 'POST') {
      assert.equal(url.href, HOOK); assert.equal(init.redirect, 'error')
      assert.equal(init.headers, undefined); assert.equal(init.body, undefined)
      posts.push({ url, init })
      return new Response('{"job":{"id":"fictional_job","state":"PENDING"}}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    const occurrence = (occurrences.get(path) ?? 0) + 1; occurrences.set(path, occurrence)
    let value
    if (path === ROOT) value = state.repository
    else if (path === `${ROOT}/git/ref/heads/main`) value = { ref: 'refs/heads/main', object: { type: 'commit', sha: state.main } }
    else if (path === `${ROOT}/git/ref/heads/${BRANCH}`) value = { ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha: state.head } }
    else if (path === `${ROOT}/pulls/${PR}`) value = state.pull
    else if (path === `${ROOT}/actions/workflows/399954171`) value = { id: 399954171, path: '.github/workflows/security-checks.yml', name: 'Security checks', state: 'active' }
    else if (path === `${ROOT}/contents/.github/workflows/security-checks.yml`) value = { type: 'file', path: '.github/workflows/security-checks.yml', sha: CI_POLICY.workflowBlob }
    else if (path === `${ROOT}/compare/${BASE}...${sha}`) value = state.comparison
    else if (path === `${ROOT}/actions/workflows/399954171/runs`) value = { total_count: state.runs.length, workflow_runs: state.runs }
    else if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) value = { total_count: state.jobs.length, jobs: state.jobs }
    else if (/\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(path)) value = state.run
    else assert.fail(`Unplanned synthetic provider request: ${path}`)
    const data = copy(value)
    await mutate?.(data, { url, path, occurrence, state, calls, posts })
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { state, calls, posts, fetchImpl }
}

const previewEnvironment = sha => ({
  XELAY_VERIFIED_PREVIEW_CI_GATE: 'github', VERCEL: '1', VERCEL_ENV: 'preview',
  VERCEL_PROJECT_ID: CI_POLICY.projectId, VERCEL_GIT_PROVIDER: 'github',
  VERCEL_GIT_REPO_OWNER: 'Olegys1', VERCEL_GIT_REPO_SLUG: 'xelay',
  VERCEL_GIT_COMMIT_REF: BRANCH, VERCEL_GIT_COMMIT_SHA: sha, VERCEL_GIT_PULL_REQUEST_ID: String(PR),
})
function gate(fx, provider, { environment = previewEnvironment(fx.sha) } = {}) {
  return verifiedVercelReceipt({
    environment, repositoryDirectory: fx.directory, spawn: fx.spawn, now: NOW,
    verifyPreview: options => verifyGithubPreview({ ...options, fetchImpl: provider.fetchImpl }),
  })
}
function publisher(provider, { env: overrides, event: eventOverride, registry } = {}) {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'Olegys1/xelay',
    GITHUB_REPOSITORY_ID: '1258728015', GITHUB_REPOSITORY_OWNER_ID: '290528340', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: BASE, GITHUB_RUN_ATTEMPT: '1', XELAY_PREVIEW_HOOK_SECRET_NAME: 'XELAY_PREVIEW_FIXTURE',
    XELAY_PREVIEW_DEPLOY_HOOK: HOOK, ...overrides }
  const event = eventOverride ?? { action: 'completed', repository: copy(provider.state.repository), workflow_run: copy(provider.state.run) }
  return requestVerifiedPreviewDeployment({ env, event, now: NOW, fetchImpl: provider.fetchImpl,
    registry: registry ?? { schemaVersion: 1, branches: { [BRANCH]: { hookSecretName: 'XELAY_PREVIEW_FIXTURE' } } },
    checkoutSha: () => BASE,
  })
}

test('real source + provider + preview gate accept one current exact PR HEAD without subprocesses or a hook', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha), receipt = await gate(fx, p)
  assert.equal(receipt.mode, 'preview'); assert.equal(receipt.sha, fx.sha)
  assert.equal(receipt.baseSha, BASE); assert.equal(receipt.pullRequestNumber, PR)
  assert.deepEqual(Object.keys(receipt.jobIds).sort(), Object.keys(MANDATORY).sort())
  assert.equal(fx.gitReads.length, 10); assert.equal(p.posts.length, 0)
})

test('local/default/full paths preserve the mandatory full gate and perform no provider or source reads', async t => {
  const fx = await sourceFixture(t)
  for (const environment of [{}, { ...previewEnvironment(fx.sha), XELAY_VERIFIED_PREVIEW_CI_GATE: '' },
    { ...previewEnvironment(fx.sha), XELAY_VERIFIED_PREVIEW_CI_GATE: 'full' },
    { ...previewEnvironment(fx.sha), VERCEL: '0' }]) {
    const p = publicProvider(fx.sha)
    assert.equal(await gate(fx, p, { environment }), null)
    assert.equal(p.calls.length, 0); assert.equal(p.posts.length, 0)
  }
  assert.equal(fx.gitReads.length, 0)
})

test('successful synthetic PR merge jobs cannot authorize deployment of the separate PR HEAD', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha)
  p.state.run.head_sha = OTHER
  for (const job of p.state.jobs) job.head_sha = OTHER
  await assert.rejects(gate(fx, p), { code: 'CI_RUN_IDENTITY' })
  assert.equal(p.posts.length, 0)
})

test('each of the three mandatory jobs and its exact checkout proof must actually succeed', async t => {
  const fx = await sourceFixture(t)
  for (const name of Object.keys(MANDATORY)) {
    const missing = publicProvider(fx.sha)
    missing.state.jobs = missing.state.jobs.filter(job => job.name !== name)
    await assert.rejects(gate(fx, missing), { code: 'CI_JOB_MISSING' }); assert.equal(missing.posts.length, 0)
    const skipped = publicProvider(fx.sha)
    skipped.state.jobs.find(job => job.name === name).steps.find(step => step.name === EXACT).conclusion = 'skipped'
    await assert.rejects(gate(fx, skipped), { code: 'CI_STEP_NOT_SUCCESSFUL' }); assert.equal(skipped.posts.length, 0)
  }
})

test('a partial rerun cannot combine new core with older dependency and secret evidence', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha)
  p.state.run.run_attempt = 2; p.state.jobs[0].run_attempt = 2
  await assert.rejects(gate(fx, p), { code: 'CI_JOB_IDENTITY' })
  assert.equal(p.posts.length, 0)
})

test('newer pending or failed evidence blocks an older successful run', async t => {
  const fx = await sourceFixture(t)
  for (const [status, conclusion, code] of [['in_progress', null, 'CI_PENDING'], ['completed', 'failure', 'CI_RUN_NOT_SUCCESSFUL']]) {
    const p = publicProvider(fx.sha)
    p.state.run = { ...p.state.run, id: 9200, run_number: 13, status, conclusion }
    p.state.runs.push(p.state.run)
    await assert.rejects(gate(fx, p), { code }); assert.equal(p.posts.length, 0)
  }
})

test('non-ancestor base and main movement during evidence reads both stop reuse', async t => {
  const fx = await sourceFixture(t), unrelated = publicProvider(fx.sha)
  unrelated.state.comparison.merge_base_commit.sha = OTHER
  await assert.rejects(gate(fx, unrelated), { code: 'CI_PREVIEW_ANCESTRY' }); assert.equal(unrelated.posts.length, 0)
  const moved = publicProvider(fx.sha, { mutate(data, { path, occurrence }) {
    if (path === `${ROOT}/git/ref/heads/main` && occurrence === 2) data.object.sha = OTHER
  } })
  await assert.rejects(gate(fx, moved), { code: 'CI_PREVIEW_BASE_CHANGED' }); assert.equal(moved.posts.length, 0)
})

test('head movement, closed PR, and fork identity with identical repository text all stop reuse', async t => {
  const fx = await sourceFixture(t)
  for (const mutation of [
    p => { p.state.head = OTHER },
    p => { p.state.pull.state = 'closed' },
    p => { p.state.pull.head.repo = { ...p.state.repository, id: 7, owner: { id: 8 }, fork: true } },
  ]) {
    const p = publicProvider(fx.sha); mutation(p)
    await assert.rejects(gate(fx, p), error => /^CI_PREVIEW_(HEAD_CHANGED|PR_IDENTITY|RUN_PR_IDENTITY)$/.test(error.code))
    assert.equal(p.posts.length, 0)
  }
})

test('real checked-out bytes changed while GitHub responds cannot reuse the valid receipt', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha, { async mutate(data, { path, occurrence }) {
    if (path === `${ROOT}/git/ref/heads/main` && occurrence === 2) await writeFile(join(fx.directory, 'app.js'), 'changed during provider reads\n')
  } })
  await assert.rejects(gate(fx, p), { code: 'SOURCE_CONTENT_MISMATCH' })
  assert.equal(p.posts.length, 0)
})

test('an actual preview receipt for the same SHA cannot authorize production mode', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha)
  const actualPreview = await verifyGithubPreview({ sha: fx.sha, branch: BRANCH, pullRequestNumber: PR, fetchImpl: p.fetchImpl, now: NOW })
  const environment = { ...previewEnvironment(fx.sha), XELAY_VERIFIED_CI_GATE: 'github', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' }
  await assert.rejects(verifiedVercelReceipt({ environment, repositoryDirectory: fx.directory, spawn: fx.spawn, now: NOW,
    verifyGithub: async () => actualPreview }), { code: 'ci_receipt_mismatch' })
  assert.equal(p.posts.length, 0)
})

test('real provider permits one scoped preview hook request and the separate source gate accepts its exact source', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha)
  const event = { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run),
    untrusted_comment: '$(PRIVATE_COMMIT_SENTINEL)\n::set-output name=secretName::XELAY_VERIFIED_DEPLOY_HOOK' }
  event.workflow_run.head_commit = { message: event.untrusted_comment }
  const outcome = await publisher(p, { event })
  assert.equal(outcome.state, 'requested'); assert.equal(outcome.deploymentRequested, true)
  assert.equal(outcome.sha, fx.sha); assert.equal(outcome.pullRequestNumber, PR)
  assert.equal(p.posts.length, 1)
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_COMMIT_SENTINEL|fictional_preview_hook|secretName/)
  const receipt = await gate(fx, p)
  assert.equal(receipt.sha, outcome.sha); assert.equal(receipt.mode, 'preview')
  assert.equal(p.posts.length, 1)
})

test('publisher makes no hook POST when PR, branch HEAD or main changes after the real CI proof', async t => {
  const fx = await sourceFixture(t)
  for (const boundary of ['pull', 'head', 'main']) {
    const p = publicProvider(fx.sha, { mutate(data, { path, occurrence }) {
      if (boundary === 'pull' && path === `${ROOT}/pulls/${PR}` && occurrence === 3) data.state = 'closed'
      if (boundary === 'head' && path === `${ROOT}/git/ref/heads/${BRANCH}` && occurrence === 3) data.object.sha = OTHER
      if (boundary === 'main' && path === `${ROOT}/git/ref/heads/main` && occurrence === 3) data.object.sha = OTHER
    } })
    await assert.rejects(publisher(p), { code: 'PREVIEW_HEAD_OR_BASE_MOVED' })
    assert.equal(p.posts.length, 0, boundary)
  }
})

test('publisher cannot replay an older completed event after a newer full CI attempt succeeds', async t => {
  const fx = await sourceFixture(t), p = publicProvider(fx.sha)
  const event = { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run) }
  p.state.run.run_attempt = 2
  for (const job of p.state.jobs) job.run_attempt = 2
  await assert.rejects(publisher(p, { event }), { code: 'EVENT_PROOF_MISMATCH' })
  assert.equal(p.posts.length, 0)
})

test('unregistered branches, wrong selected secrets and production secrets cannot request a preview hook', async t => {
  const fx = await sourceFixture(t), unregistered = publicProvider(fx.sha)
  const outcome = await publisher(unregistered, { registry: { schemaVersion: 1, branches: {} } })
  assert.equal(outcome.state, 'configuration_pending'); assert.equal(unregistered.calls.length, 0)
  for (const [env, code] of [
    [{ XELAY_PREVIEW_HOOK_SECRET_NAME: 'XELAY_PREVIEW_OTHER' }, 'PREVIEW_SECRET_SELECTION_MISMATCH'],
    [{ XELAY_VERIFIED_DEPLOY_HOOK: 'production_secret_sentinel' }, 'PRODUCTION_SECRET_CONTEXT'],
    [{ GITHUB_RUN_ATTEMPT: '2' }, 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW'],
  ]) {
    const p = publicProvider(fx.sha)
    await assert.rejects(publisher(p, { env }), error => error.code === code && !String(error).includes('production_secret_sentinel'))
    assert.equal(p.calls.length, 0); assert.equal(p.posts.length, 0)
  }
})
