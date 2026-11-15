// Independent end-to-end authorization fixtures. The actual provider, source
// proof, gate and publisher run together. Only HTTP and read-only Git transport
// are synthetic; there are no green receipt stubs, sockets or real credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { CI_POLICY } from '../security-ci/verified-ci.mjs'
import { verifyGithubBranchPreview } from '../security-ci/verified-branch-preview-ci.mjs'
import { verifiedVercelReceipt } from '../security-ci/vercel-gate.mjs'
import { requestVerifiedBranchDeployment } from '../security-ci/request-verified-branch-deployment.mjs'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40)
// Deliberately absent from every old deploy-hook registry and without a PR.
const BRANCH = 'feature/new-unregistered-branch-20261115'
const ROOT = '/repos/Olegys1/xelay'
const PROJECT = 'prj_Yl9R5uI2IdwyeNaIhbfIlObMO5bq'
const READ_TOKEN = 'fictional_readonly_github_token'
const PREVIEW_TOKEN = 'vcp_fictional_preview_project_token'
const DEPLOYMENT = 'dpl_independentBranchFixture'
const iso = delta => new Date(NOW + delta).toISOString()
const copy = value => structuredClone(value)
const objectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
// Independent expectations: weakening the production job policy must not make
// a missing security job or its exact-checkout step silently pass this suite.
const CHECKOUT = 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const EXACT = 'Verify exact checkout and integration with current main'
const NODE = 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
const MANDATORY = {
  'security-core': [CHECKOUT, EXACT, NODE, 'Install the locked dependencies without lifecycle scripts', 'Run the curated offline suite sequentially'],
  'security-dependencies': [CHECKOUT, EXACT, NODE, 'Reject high or critical known dependency advisories'],
  'security-secrets': [CHECKOUT, EXACT, NODE, 'Fetch the official pinned Gitleaks CLI and verify before extraction', 'Scan selected working files and all fetched history, with values withheld'],
}

async function sourceFixture(t) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'xelay-all-branch-boundary-'))
  t.after(async () => {
    assert.equal(dirname(directory), parent)
    assert.match(basename(directory), /^xelay-all-branch-boundary-/)
    await rm(directory, { recursive: true, force: true })
  })
  const files = new Map([
    ['app.js', Buffer.from('export const source = "independent exact branch HEAD"\n')],
    ['package.json', Buffer.from('{"private":true,"type":"module"}\n')],
  ])
  await mkdir(join(directory, '.git'))
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes)
  const entries = [...files].map(([name, bytes]) => ({ name, hash: objectHash('blob', bytes) }))
  const tree = Buffer.concat(entries.flatMap(({ name, hash }) => [Buffer.from(`100644 ${name}\0`), Buffer.from(hash, 'hex')]))
  const treeId = objectHash('tree', tree)
  const commit = Buffer.from(`tree ${treeId}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nindependent all-branch authorization\n`)
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

function transport(sha, { mutate, vercelMutate } = {}) {
  const repository = { id: 1258728015, full_name: 'Olegys1/xelay', owner: { id: 290528340 }, private: false, default_branch: 'main', fork: false }
  const run = { id: 9100, run_number: 12, run_attempt: 1, check_suite_id: 8100,
    workflow_id: 399954171, path: '.github/workflows/security-checks.yml', name: 'Security checks',
    event: 'push', head_branch: BRANCH, head_sha: sha, repository, head_repository: repository,
    status: 'completed', conclusion: 'success', created_at: iso(-300_000), run_started_at: iso(-240_000), updated_at: iso(-30_000),
    pull_requests: [],
  }
  const jobs = Object.entries(MANDATORY).map(([name, required], index) => ({
    id: 1000 + index, name, run_id: run.id, run_attempt: 1, head_sha: sha, head_branch: BRANCH, workflow_name: 'Security checks',
    status: 'completed', conclusion: 'success', started_at: iso(-180_000), completed_at: iso(-60_000),
    steps: required.map((name, index) => ({ name, number: index + 1, status: 'completed', conclusion: 'success' })),
  }))
  const state = { repository, run, runs: [run], jobs, main: BASE, head: sha, deployments: [],
    comparison: { base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, behind_by: 0, ahead_by: 1, status: 'ahead' },
    deployment: { id: DEPLOYMENT, projectId: PROJECT, target: null, readyState: 'QUEUED',
      gitSource: { type: 'github', repoId: 1258728015, ref: BRANCH, sha } },
  }
  const calls = [], posts = [], occurrences = new Map()
  async function fetchImpl(address, init = {}) {
    const url = new URL(address), path = decodeURIComponent(url.pathname), method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    calls.push({ url, method, headers, body: init.body })
    assert.equal(init.redirect, 'error', 'credentials must never follow a redirect')
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '')
    const occurrence = (occurrences.get(path) ?? 0) + 1; occurrences.set(path, occurrence)
    if (url.origin === 'https://api.vercel.com') {
      assert.equal(headers.get('authorization'), `Bearer ${PREVIEW_TOKEN}`)
      assert.ok(!String(init.body).includes(READ_TOKEN))
      let data
      if (method === 'POST') {
        assert.equal(url.href, 'https://api.vercel.com/v13/deployments')
        const body = JSON.parse(init.body)
        assert.deepEqual(body, { name: 'xelay', project: PROJECT,
          gitSource: { type: 'github', repoId: 1258728015, ref: BRANCH, sha } })
        for (const forbidden of ['target', 'customEnvironmentSlugOrId', 'files', 'env', 'projectSettings', 'withLatestCommit', 'buildMachine']) {
          assert.equal(Object.hasOwn(body, forbidden), false, forbidden)
        }
        posts.push({ url, init, body }); data = copy(state.deployment)
      } else {
        assert.equal(method, 'GET')
        if (path === '/v7/deployments') {
          assert.equal(url.searchParams.get('projectId'), PROJECT)
          assert.equal(url.searchParams.get('branch'), BRANCH); assert.equal(url.searchParams.get('sha'), sha)
          assert.equal(url.searchParams.get('limit'), '100')
          data = { deployments: copy(state.deployments), pagination: { count: state.deployments.length, next: null, prev: null } }
        } else {
          assert.equal(path, `/v13/deployments/${DEPLOYMENT}`)
          assert.equal(url.searchParams.get('withGitRepoInfo'), 'true')
          data = copy(state.deployment)
        }
      }
      const response = { status: 200, headers: { 'content-type': 'application/json' } }
      await vercelMutate?.(data, { url, path, method, occurrence, state, calls, posts, response })
      return new Response(JSON.stringify(data), response)
    }
    assert.equal(url.origin, 'https://api.github.com', 'untrusted API origin must never receive either credential')
    assert.equal(method, 'GET'); assert.equal(init.cache, 'no-store')
    assert.equal(headers.get('authorization'), `Bearer ${READ_TOKEN}`)
    assert.equal(JSON.stringify([...headers]).includes(PREVIEW_TOKEN), false)
    let value
    if (path === ROOT) value = state.repository
    else if (path === `${ROOT}/git/ref/heads/main`) value = { ref: 'refs/heads/main', object: { type: 'commit', sha: state.main } }
    else if (path === `${ROOT}/git/ref/heads/${BRANCH}`) value = { ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha: state.head } }
    else if (path === `${ROOT}/actions/workflows/399954171`) value = { id: 399954171, path: '.github/workflows/security-checks.yml', name: 'Security checks', state: 'active' }
    else if (path === `${ROOT}/contents/.github/workflows/security-checks.yml`) value = { type: 'file', path: '.github/workflows/security-checks.yml', sha: CI_POLICY.workflowBlob }
    else if (path === `${ROOT}/compare/${BASE}...${sha}`) value = state.comparison
    else if (path === `${ROOT}/actions/workflows/399954171/runs`) {
      assert.equal(url.searchParams.get('branch'), BRANCH); assert.equal(url.searchParams.get('head_sha'), sha)
      assert.equal(url.searchParams.has('status'), false); assert.equal(url.searchParams.has('exclude_pull_requests'), false)
      const event = url.searchParams.get('event'); assert.ok(['push', 'pull_request'].includes(event))
      const runs = state.runs.filter(run => run.event === event)
      value = { total_count: runs.length, workflow_runs: runs }
    } else if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) value = { total_count: state.jobs.length, jobs: state.jobs }
    else if (/\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(path)) {
      const id = Number(path.match(/\/actions\/runs\/(\d+)/)[1])
      value = state.runs.find(run => run.id === id)
      assert.ok(value, `Unknown synthetic run: ${id}`)
    } else assert.fail(`Unplanned synthetic GitHub request: ${path}`)
    const data = copy(value), response = { status: 200, headers: { 'content-type': 'application/json' } }
    await mutate?.(data, { url, path, occurrence, state, calls, posts, response })
    return new Response(JSON.stringify(data), response)
  }
  return { state, calls, posts, fetchImpl }
}

const previewEnvironment = sha => ({
  XELAY_VERIFIED_PREVIEW_CI_GATE: 'github', VERCEL: '1', VERCEL_ENV: 'preview',
  VERCEL_PROJECT_ID: PROJECT, VERCEL_GIT_PROVIDER: 'github',
  VERCEL_GIT_REPO_OWNER: 'Olegys1', VERCEL_GIT_REPO_SLUG: 'xelay',
  VERCEL_GIT_COMMIT_REF: BRANCH, VERCEL_GIT_COMMIT_SHA: sha, XELAY_CI_READ_TOKEN: READ_TOKEN,
})
function gate(fx, p, environment = previewEnvironment(fx.sha)) {
  return verifiedVercelReceipt({ environment, repositoryDirectory: fx.directory, spawn: fx.spawn, now: NOW,
    verifyPreview: options => verifyGithubBranchPreview({ ...options, fetchImpl: p.fetchImpl }),
  })
}
function publisher(p, { env: overrides, event: eventOverride } = {}) {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'Olegys1/xelay',
    GITHUB_REPOSITORY_ID: '1258728015', GITHUB_REPOSITORY_OWNER_ID: '290528340', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: BASE, GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: READ_TOKEN, XELAY_PREVIEW_PROJECT_TOKEN: PREVIEW_TOKEN, ...overrides }
  const event = eventOverride ?? { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run) }
  return requestVerifiedBranchDeployment({ env, event, now: NOW, fetchImpl: p.fetchImpl, checkoutSha: () => BASE })
}
function newer(p, { event = 'pull_request', status = 'completed', conclusion = 'success' } = {}) {
  const run = { ...copy(p.state.run), id: 9200, run_number: 13, check_suite_id: 8200, event, status, conclusion }
  p.state.runs.push(run); p.state.run = run
  for (const job of p.state.jobs) job.run_id = run.id
  return run
}

test('new branch with no PR or registry automatically deploys after real exact-HEAD CI proof', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha)
  assert.deepEqual(p.state.run.pull_requests, [])
  const outcome = await publisher(p)
  assert.equal(outcome.state, 'requested'); assert.equal(outcome.deploymentRequested, true)
  assert.equal(outcome.sha, fx.sha); assert.equal(outcome.branch, BRANCH)
  assert.equal(p.posts.length, 1)
  const receipt = await gate(fx, p)
  assert.equal(receipt.mode, 'preview'); assert.equal(receipt.authority, 'branch-head-ci'); assert.equal(receipt.event, 'push')
  assert.equal(receipt.sha, fx.sha); assert.equal(receipt.branch, BRANCH); assert.equal(receipt.baseSha, BASE)
  assert.deepEqual(Object.keys(receipt.jobIds).sort(), Object.keys(MANDATORY).sort())
  assert.equal(fx.gitReads.length, 10)
  assert.equal(p.calls.some(({ url }) => /\/pulls\//.test(url.pathname)), false)
})

test('same-repository PR wins over an older cancelled push; reverse automatic order also works', async t => {
  const fx = await sourceFixture(t)
  for (const event of ['pull_request', 'push']) {
    const p = transport(fx.sha)
    p.state.run.event = event === 'push' ? 'pull_request' : 'push'
    p.state.run.conclusion = 'cancelled'
    newer(p, { event })
    const receipt = await gate(fx, p)
    assert.equal(receipt.event, event); assert.equal(receipt.runId, 9200)
    const outcome = await publisher(p)
    assert.equal(outcome.state, 'requested'); assert.equal(p.posts.length, 1)
  }
})

test('newer pending, failed or cancelled push/PR never falls back to an older green run or sends a deployment', async t => {
  const fx = await sourceFixture(t)
  for (const event of ['push', 'pull_request']) for (const [status, conclusion, code] of [
    ['in_progress', null, 'CI_PENDING'], ['completed', 'failure', 'CI_RUN_NOT_SUCCESSFUL'], ['completed', 'cancelled', 'CI_RUN_NOT_SUCCESSFUL'],
  ]) {
    const p = transport(fx.sha)
    const eventBeforeNewer = { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run) }
    newer(p, { event, status, conclusion })
    await assert.rejects(gate(fx, p), { code })
    await assert.rejects(publisher(p, { event: eventBeforeNewer }), { code: 'PREVIEW_CI_PROOF_UNAVAILABLE' })
    assert.equal(p.posts.length, 0, `${event}:${status}:${conclusion}`)
  }
})

test('a completed event cannot publish a different newer successful run or rerun of the same SHA', async t => {
  const fx = await sourceFixture(t)
  for (const change of [
    p => { newer(p) },
    p => { p.state.run.run_attempt = 2; for (const job of p.state.jobs) job.run_attempt = 2 },
  ]) {
    const p = transport(fx.sha)
    const event = { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run) }
    change(p)
    // The current evidence itself is genuine; only the privileged trigger's
    // run identity is obsolete. The event must not borrow that newer proof.
    const receipt = await gate(fx, p)
    assert.equal(receipt.sha, fx.sha)
    await assert.rejects(publisher(p, { event }), { code: 'EVENT_PROOF_MISMATCH' })
    assert.equal(p.posts.length, 0)
  }
})

test('all three mandatory jobs and every exact-checkout step are required by actual gate and publisher', async t => {
  const fx = await sourceFixture(t)
  for (const name of Object.keys(MANDATORY)) for (const mode of ['missing-job', 'skipped-job', 'missing-checkout', 'skipped-checkout']) {
    const p = transport(fx.sha), job = p.state.jobs.find(job => job.name === name)
    let code
    if (mode === 'missing-job') { p.state.jobs = p.state.jobs.filter(job => job.name !== name); code = 'CI_JOB_MISSING' }
    if (mode === 'skipped-job') { job.conclusion = 'skipped'; code = 'CI_JOB_NOT_SUCCESSFUL' }
    if (mode === 'missing-checkout') { job.steps = job.steps.filter(step => step.name !== EXACT); code = 'CI_STEP_MISSING' }
    if (mode === 'skipped-checkout') { job.steps.find(step => step.name === EXACT).conclusion = 'skipped'; code = 'CI_STEP_NOT_SUCCESSFUL' }
    await assert.rejects(gate(fx, p), { code }); await assert.rejects(publisher(p), { code: 'PREVIEW_CI_PROOF_UNAVAILABLE' })
    assert.equal(p.posts.length, 0, `${name}:${mode}`)
  }
})

test('foreign repository, fork, wrong workflow and wrong attempt cannot authorize either boundary', async t => {
  const fx = await sourceFixture(t)
  for (const [change, code] of [
    [p => { p.state.run.repository = { ...p.state.repository, id: 7 } }, 'CI_RUN_IDENTITY'],
    [p => { p.state.run.head_repository = { ...p.state.repository, id: 8, fork: true } }, 'CI_RUN_IDENTITY'],
    [p => { p.state.run.workflow_id = 9 }, 'CI_RUN_IDENTITY'],
    [p => { p.state.jobs[1].run_attempt = 2 }, 'CI_JOB_IDENTITY'],
    [p => { p.state.run.head_sha = OTHER }, 'CI_RUN_IDENTITY'],
  ]) {
    const p = transport(fx.sha)
    const event = { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run) }
    change(p)
    await assert.rejects(gate(fx, p), { code }); await assert.rejects(publisher(p, { event }), { code: 'PREVIEW_CI_PROOF_UNAVAILABLE' })
    assert.equal(p.posts.length, 0)
  }
})

test('workflow contents, ancestor and freshness are independently checked before any deployment', async t => {
  const fx = await sourceFixture(t)
  for (const [boundary, code] of [['workflow', 'CI_WORKFLOW_MISMATCH'], ['ancestry', 'CI_PREVIEW_ANCESTRY'], ['stale', 'CI_RUN_STALE']]) {
    const p = transport(fx.sha, { mutate(data, { path }) {
      if (boundary === 'workflow' && path === `${ROOT}/contents/.github/workflows/security-checks.yml`) data.sha = OTHER
    } })
    if (boundary === 'ancestry') p.state.comparison.merge_base_commit.sha = OTHER
    if (boundary === 'stale') { p.state.run.created_at = iso(-25_600_000); p.state.run.run_started_at = iso(-25_500_000) }
    await assert.rejects(gate(fx, p), { code }); await assert.rejects(publisher(p), { code: 'PREVIEW_CI_PROOF_UNAVAILABLE' })
    assert.equal(p.posts.length, 0)
  }
})

test('a second run appearing during proof collection blocks the previous green proof', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha, { mutate(data, { path, occurrence, state }) {
    if (path === `${ROOT}/actions/workflows/399954171/runs` && occurrence === 3) {
      const next = { ...copy(state.run), id: 9200, run_number: 13, status: 'in_progress', conclusion: null }
      state.runs.push(next); data.workflow_runs.push(copy(next)); data.total_count++
    }
  } })
  await assert.rejects(gate(fx, p), error => ['CI_EVIDENCE_CHANGED', 'CI_PENDING'].includes(error.code))
  assert.equal(p.posts.length, 0)
})

test('moving main or branch HEAD during actual provider reads blocks source reuse', async t => {
  const fx = await sourceFixture(t)
  for (const [ref, code] of [['main', 'CI_PREVIEW_BASE_CHANGED'], [BRANCH, 'CI_PREVIEW_HEAD_CHANGED']]) {
    const p = transport(fx.sha, { mutate(data, { path, occurrence }) {
      if (path === `${ROOT}/git/ref/heads/${ref}` && occurrence === 2) data.object.sha = OTHER
    } })
    await assert.rejects(gate(fx, p), { code }); assert.equal(p.posts.length, 0)
  }
})

test('publisher rechecks current main and HEAD after real proof and before secret-bearing POST', async t => {
  const fx = await sourceFixture(t)
  for (const ref of ['main', BRANCH]) {
    const p = transport(fx.sha, { mutate(data, { path, occurrence }) {
      if (path === `${ROOT}/git/ref/heads/${ref}` && occurrence === 5) data.object.sha = OTHER
    } })
    await assert.rejects(publisher(p), { code: 'PREVIEW_HEAD_OR_BASE_MOVED' })
    assert.equal(p.posts.length, 0, ref)
  }
})

test('real checked-out source mutation during HTTP reads invalidates otherwise genuine green CI', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha, { async mutate(data, { path, occurrence }) {
    if (path === `${ROOT}/git/ref/heads/main` && occurrence === 2) await writeFile(join(fx.directory, 'app.js'), 'changed while evidence was read\n')
  } })
  await assert.rejects(gate(fx, p), { code: 'SOURCE_CONTENT_MISMATCH' })
  assert.equal(p.posts.length, 0)
})

test('an authentic branch preview receipt cannot be replayed at the production gate', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha)
  const receipt = await verifyGithubBranchPreview({ sha: fx.sha, branch: BRANCH, fetchImpl: p.fetchImpl, token: READ_TOKEN, now: NOW })
  const environment = { ...previewEnvironment(fx.sha), XELAY_VERIFIED_CI_GATE: 'github', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' }
  await assert.rejects(verifiedVercelReceipt({ environment, repositoryDirectory: fx.directory, spawn: fx.spawn, now: NOW,
    verifyGithub: async () => receipt }), { code: 'ci_receipt_mismatch' })
  assert.equal(p.posts.length, 0)
})

test('untrusted branch event strings cannot select an endpoint, project, production target or secret', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha)
  const event = { action: 'completed', repository: copy(p.state.repository), workflow_run: copy(p.state.run),
    project: 'attacker-project', target: 'production', endpoint: 'https://attacker.invalid/collect',
    secretName: 'XELAY_VERIFIED_DEPLOY_HOOK', env: { STEAL: PREVIEW_TOKEN } }
  event.workflow_run.head_commit = { message: '$(PRIVATE_COMMIT_SENTINEL)\n::set-output name=target::production' }
  event.workflow_run.html_url = 'https://attacker.invalid/do-not-follow'
  const outcome = await publisher(p, { event })
  assert.equal(outcome.state, 'requested'); assert.equal(p.posts.length, 1)
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_COMMIT_SENTINEL|attacker\.invalid|fictional_preview_project_token|secretName/)
  assert.equal(p.calls.some(({ url }) => !['https://api.github.com', 'https://api.vercel.com'].includes(url.origin)), false)
})

test('GitHub pagination cannot redirect a credential to an untrusted URL or continue to deployment', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha, { mutate(data, { path, response }) {
    if (path.endsWith('/runs')) response.headers.link = '<https://attacker.invalid/collect?page=2>; rel="next"'
  } })
  await assert.rejects(publisher(p), { code: 'PREVIEW_CI_PROOF_UNAVAILABLE' })
  assert.equal(p.posts.length, 0)
  assert.equal(p.calls.some(({ url }) => url.origin === 'https://attacker.invalid'), false)
})

test('existing exact-source Preview deployment deduplicates without another POST', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha)
  p.state.deployments.push({ uid: DEPLOYMENT, projectId: PROJECT, target: null, state: 'READY', createdAt: NOW - 10_000,
    meta: { githubCommitSha: fx.sha, githubCommitRef: BRANCH, githubCommitRepoId: '1258728015' } })
  const result = await publisher(p)
  assert.equal(result.deploymentRequested, false); assert.equal(p.posts.length, 0)
})

test('Preview API success is rejected unless project, target and exact source match', async t => {
  const fx = await sourceFixture(t)
  for (const mutate of [
    value => { value.projectId = 'prj_foreign' },
    value => { value.target = 'production' },
    value => { value.gitSource.sha = OTHER },
    value => { value.gitSource.ref = 'other-branch' },
    value => { value.gitSource.repoId = 7 },
  ]) {
    const p = transport(fx.sha); mutate(p.state.deployment)
    const outcome = await publisher(p)
    assert.equal(outcome.state, 'request_outcome_unknown'); assert.equal(outcome.code, 'DEPLOYMENT_RECEIPT_UNAVAILABLE')
    assert.equal(outcome.deploymentRequested, null)
    assert.equal(p.posts.length, 1, 'a mismatched response must fail without retrying the request')
  }
})

test('a reduced Preview API receipt is resolved only by its safe ID and checked against the exact source', async t => {
  const fx = await sourceFixture(t)
  for (const wrongSource of [false, true]) {
    const p = transport(fx.sha, { vercelMutate(data, { method, path }) {
      if (method === 'POST') { delete data.projectId; delete data.gitSource }
      if (wrongSource && path === `/v13/deployments/${DEPLOYMENT}`) data.gitSource.sha = OTHER
    } })
    const outcome = await publisher(p)
    assert.equal(outcome.state, wrongSource ? 'request_outcome_unknown' : 'requested')
    assert.equal(p.posts.length, 1)
    assert.equal(p.calls.filter(({ url }) => url.pathname === `/v13/deployments/${DEPLOYMENT}`).length, 1)
  }
})

test('a secret-bearing POST receiving a redirect has an unknown outcome and is never retried or followed', async t => {
  const fx = await sourceFixture(t), p = transport(fx.sha, { vercelMutate(data, { method, response }) {
    if (method === 'POST') { response.status = 302; response.headers.location = 'https://attacker.invalid/collect' }
  } })
  const outcome = await publisher(p)
  assert.equal(outcome.state, 'request_outcome_unknown'); assert.equal(outcome.deploymentRequested, null)
  assert.equal(p.posts.length, 1)
  assert.equal(p.calls.some(({ url }) => url.origin === 'https://attacker.invalid'), false)
})

test('missing project token is configuration pending and publisher reruns cannot duplicate requests', async t => {
  const fx = await sourceFixture(t), missing = transport(fx.sha)
  const result = await publisher(missing, { env: { XELAY_PREVIEW_PROJECT_TOKEN: '' } })
  assert.equal(result.state, 'configuration_pending'); assert.equal(result.deploymentRequested, false)
  assert.equal(missing.posts.length, 0); assert.equal(missing.calls.length, 0)
  const rerun = transport(fx.sha)
  await assert.rejects(publisher(rerun, { env: { GITHUB_RUN_ATTEMPT: '2' } }))
  assert.equal(rerun.posts.length, 0)
})
