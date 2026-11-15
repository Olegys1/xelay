// Fictional provider responses only: no GitHub, deployment or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { verifyGithubBranchPreview, BRANCH_PREVIEW_CI_POLICY, BRANCH_PREVIEW_CI_MAX_REQUESTS } from '../security-ci/verified-branch-preview-ci.mjs'
import { CI_POLICY, CI_FRESHNESS_MS, CI_MAX_RESPONSE_BYTES, REQUIRED_CI_JOBS, EXACT_CHECKOUT_STEP, GithubVerificationError } from '../security-ci/verified-ci.mjs'

const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40), BRANCH = 'feature/no-pr-preview'
const ROOT = '/repos/Olegys1/xelay', NOW = Date.parse('2026-11-15T18:00:00Z')
const iso = delta => new Date(NOW + delta).toISOString(), copy = value => structuredClone(value)
const REPO = { id: CI_POLICY.repositoryId, full_name: CI_POLICY.repository, owner: { id: CI_POLICY.ownerId }, private: false, default_branch: 'main' }
const RUN = { id: 9100, run_number: 12, run_attempt: 1, check_suite_id: 8100,
  workflow_id: CI_POLICY.workflowId, path: CI_POLICY.workflowPath, name: CI_POLICY.workflowName,
  event: 'push', head_branch: BRANCH, head_sha: SHA, repository: REPO, head_repository: REPO, pull_requests: [],
  status: 'completed', conclusion: 'success', created_at: iso(-300_000), run_started_at: iso(-240_000), updated_at: iso(-30_000),
}
function jobsFor(run = RUN) {
  return Object.entries(REQUIRED_CI_JOBS).map(([name, required], index) => ({
    id: 1000 + index, name, run_id: run.id, run_attempt: run.run_attempt, head_sha: SHA, head_branch: BRANCH, workflow_name: CI_POLICY.workflowName,
    status: 'completed', conclusion: 'success', started_at: iso(-180_000), completed_at: iso(-60_000),
    steps: required.map((name, index) => ({ name, number: index + 1, status: 'completed', conclusion: 'success' })),
  })).concat({ id: 2000, name: 'security-full', run_id: run.id, run_attempt: run.run_attempt, head_sha: SHA, head_branch: BRANCH,
    workflow_name: CI_POLICY.workflowName, status: 'completed', conclusion: 'skipped', steps: null })
}
const response = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
function provider(options = {}) {
  const calls = [], counts = new Map(), run = options.run ?? RUN
  async function fetchImpl(address, init) {
    const url = new URL(address), path = url.pathname, key = path + (path.endsWith('/runs') ? ':' + url.searchParams.get('event') : '')
    const occurrence = (counts.get(key) || 0) + 1; counts.set(key, occurrence)
    const context = { url, path, occurrence, calls, init }; calls.push(context)
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    const direct = await options.respond?.(context); if (direct !== undefined) return direct
    let data
    if (path === ROOT) data = copy(REPO)
    else if (path === ROOT + '/git/ref/heads/main') data = { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE } }
    else if (path === ROOT + '/git/ref/heads/' + BRANCH) data = { ref: 'refs/heads/' + BRANCH, object: { type: 'commit', sha: SHA } }
    else if (path === ROOT + '/contents/' + CI_POLICY.workflowPath) {
      assert.equal(url.searchParams.get('ref'), SHA); data = { type: 'file', path: CI_POLICY.workflowPath, sha: CI_POLICY.workflowBlob }
    } else if (path === ROOT + '/actions/workflows/' + CI_POLICY.workflowId) data = { id: CI_POLICY.workflowId, path: CI_POLICY.workflowPath, name: CI_POLICY.workflowName, state: 'active' }
    else if (path.includes('/compare/')) {
      assert.equal(path, ROOT + '/compare/' + BASE + '...' + SHA)
      data = { base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, status: 'ahead', ahead_by: 2, behind_by: 0 }
    } else if (path.endsWith('/runs')) {
      const event = url.searchParams.get('event'); assert.equal(event, 'push')
      assert.equal(url.searchParams.get('branch'), BRANCH); assert.equal(url.searchParams.get('head_sha'), SHA)
      assert.equal(url.searchParams.has('exclude_pull_requests'), false); assert.equal(url.searchParams.has('status'), false)
      const runs = options.runs ?? [run], entries = runs.filter(r => r.event === event)
      data = { total_count: entries.length, workflow_runs: copy(entries) }
    } else if (/\/attempts\/\d+\/jobs$/.test(path)) {
      const jobs = options.jobs ?? jobsFor(run); data = { total_count: jobs.length, jobs: copy(jobs) }
    } else if (/\/attempts\/\d+$/.test(path)) data = copy(options.attempt ?? run)
    else if (/\/actions\/runs\/\d+$/.test(path)) data = copy(run)
    else assert.fail('Unexpected provider read')
    options.mutate?.(data, context)
    return response(data)
  }
  return { calls, fetchImpl }
}
const verify = (p, extra = {}) => verifyGithubBranchPreview({ sha: SHA, branch: BRANCH, now: NOW, fetchImpl: p.fetchImpl, ...extra })
async function rejects(p, code, extra = {}) {
  await assert.rejects(verify(p, extra), e => e instanceof GithubVerificationError && e.code === code && e.message === `GitHub release proof rejected (${code}).`)
}

test('one authoritative push workflow creates required contexts; fork PR checks have distinct names and no release authority', () => {
  const bytes = readFileSync(new URL('../../.github/workflows/security-checks.yml', import.meta.url)), text = bytes.toString('utf8')
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), CI_POLICY.workflowBlob)
  assert.match(text, /push:\n    branches: \['\*\*'\]/)
  assert.doesNotMatch(text, /pull_request|github\.head_ref/)
  assert.match(text, /github\.repository_id.*github\.event_name.*github\.ref/)
  assert.match(text, /cancel-in-progress: true/)
  for (const job of text.split(/^  security-/m).slice(1, 4)) {
    assert.match(job, /ref: \$\{\{ github\.sha \}\}/)
    assert.match(job, /fetch-depth: 0/)
    assert.match(job, /MAIN_SHA="\$\(git rev-parse refs\/remotes\/origin\/main\)"/)
    assert.match(job, /git merge-base --is-ancestor "\$MAIN_SHA" "\$EXPECTED_SHA"/)
    assert.ok(job.indexOf(EXACT_CHECKOUT_STEP) < job.indexOf('actions/setup-node@'))
    assert.doesNotMatch(job, /if:.*(?:pull_request|push)/)
  }
  const fork = readFileSync(new URL('../../.github/workflows/security-forks.yml', import.meta.url), 'utf8')
  assert.match(fork, /^name: Fork security checks$/m)
  assert.match(fork, /pull_request:\n    branches: \[main\]/)
  assert.doesNotMatch(fork, /pull_request_target|\$\{\{\s*secrets\.|environment:|workflow_run|^  security-/m)
  const jobs = fork.split(/^  fork-security-/m).slice(1)
  assert.equal(jobs.length, 3)
  for (const job of jobs) {
    assert.match(job, /if: github\.event\.pull_request\.head\.repo\.id != github\.event\.pull_request\.base\.repo\.id/)
    assert.match(job, /persist-credentials: false/)
    assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
    assert.match(job, /git merge-base --is-ancestor "\$PR_BASE_SHA" "\$EXPECTED_SHA"/)
    for (const step of REQUIRED_CI_JOBS['security-' + job.split(':')[0]].filter(step => !step.startsWith('Run actions/'))) assert.ok(job.includes(step))
  }
})

test('new branch with no PR receives a distinct immutable branch-head receipt after authoritative push queries', async () => {
  const p = provider(), r = await verify(p)
  assert.equal(r.mode, 'preview'); assert.equal(r.authority, 'branch-head-ci'); assert.equal(r.event, 'push')
  assert.equal(r.sha, SHA); assert.equal(r.branch, BRANCH); assert.equal(r.baseSha, BASE)
  assert.equal(r.runId, RUN.id); assert.equal(r.runAttempt, 1); assert.equal(r.repositoryId, CI_POLICY.repositoryId)
  assert.equal(r.workflowBlob, CI_POLICY.workflowBlob); assert.equal(r.verifiedAt, iso(0)); assert.equal(r.completedAt, RUN.updated_at)
  assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.jobIds)); assert.equal(r.pullRequestNumber, undefined)
  assert.equal(p.calls.length, 15); assert.ok(p.calls.length <= BRANCH_PREVIEW_CI_MAX_REQUESTS)
  assert.deepEqual(p.calls.filter(c => c.path.endsWith('/runs')).map(c => c.url.searchParams.get('event')), ['push', 'push'])
  assert.equal(p.calls.filter(c => c.path.includes('/pulls')).length, 0)
  assert.ok(Object.isFrozen(BRANCH_PREVIEW_CI_POLICY.events))
})

test('PR-only success cannot replace a cancelled push or authorize a branch preview', async () => {
  const pull = { ...RUN, id: 9200, run_number: 13, event: 'pull_request', pull_requests: [] }
  await rejects(provider({ run: pull, runs: [pull] }), 'CI_RUN_MISSING')
  const cancelled = { ...RUN, conclusion: 'cancelled' }
  await rejects(provider({ run: cancelled, runs: [cancelled, pull] }), 'CI_RUN_NOT_SUCCESSFUL')
})

test('latest authoritative push wins, including pending, cancelled and failure', async t => {
  for (const event of ['push']) for (const conclusion of ['failure', 'cancelled', 'neutral', 'skipped']) {
    const newer = { ...RUN, id: 9200, run_number: 13, event, conclusion }
    await t.test(event + ':' + conclusion, () => rejects(provider({ run: newer, runs: [RUN, newer] }), 'CI_RUN_NOT_SUCCESSFUL'))
  }
  for (const event of ['push']) {
    const newer = { ...RUN, id: 9200, run_number: 13, event, status: 'queued', conclusion: null }
    await rejects(provider({ run: newer, runs: [RUN, newer] }), 'CI_PENDING')
  }
  await rejects(provider({ runs: [] }), 'CI_RUN_MISSING')
  await rejects(provider({ runs: [RUN, { ...RUN, id: 9200 }] }), 'CI_RUN_IDENTITY')
})

test('manual, fork, wrong repo/workflow/head and cross-event injection never authorize', async t => {
  for (const patch of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { event: 'schedule' }, { workflow_id: 3 }, { name: 'Forged' }, { path: 'fake.yml' },
    { head_sha: OTHER }, { head_branch: 'other' }, { repository: { ...REPO, id: 3 } }, { head_repository: { ...REPO, id: 3 } },
    { head_repository: { ...REPO, owner: { id: 3 } } }, { run_attempt: 0 }, { check_suite_id: 0 }]) {
    await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) {
      if (path.endsWith('/runs') && d.workflow_runs.length) Object.assign(d.workflow_runs[0], patch)
    } }), 'CI_RUN_IDENTITY'))
  }
  await rejects(provider({ mutate(d, { path, url }) {
    if (path.endsWith('/runs') && url.searchParams.get('event') === 'push') { d.workflow_runs = [{ ...RUN, event: 'pull_request' }]; d.total_count = 1 }
  } }), 'CI_RUN_IDENTITY')
})

test('repository, workflow and immutable checkout workflow blob are authoritative', async t => {
  for (const patch of [{ id: 1 }, { owner: { id: 2 } }, { full_name: 'fork/xelay' }, { private: true }, { default_branch: 'dev' }]) {
    await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path === ROOT) Object.assign(d, patch) } }), 'CI_REPOSITORY_MISMATCH'))
  }
  for (const patch of [{ id: 2 }, { name: 'Forged' }, { state: 'disabled_manually' }, { path: 'other.yml' }]) {
    await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path.endsWith('/workflows/' + CI_POLICY.workflowId)) Object.assign(d, patch) } }), 'CI_WORKFLOW_MISMATCH'))
  }
  for (const patch of [{ sha: OTHER }, { type: 'symlink' }, { path: 'other.yml' }]) await rejects(provider({ mutate(d, { path }) { if (path.includes('/contents/')) Object.assign(d, patch) } }), 'CI_WORKFLOW_MISMATCH')
})

test('current main ancestor and stable source snapshot are required before and after proof', async t => {
  for (const patch of [{ status: 'diverged' }, { status: 'behind' }, { behind_by: 1 }, { ahead_by: 0 },
    { merge_base_commit: { sha: OTHER } }, { base_commit: { sha: OTHER } }]) {
    await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path.includes('/compare/')) Object.assign(d, patch) } }), 'CI_PREVIEW_ANCESTRY'))
  }
  await rejects(provider({ mutate(d, { path, occurrence }) { if (path.endsWith('/heads/main') && occurrence === 2) d.object.sha = OTHER } }), 'CI_PREVIEW_BASE_CHANGED')
  for (const occurrence of [1, 2]) await rejects(provider({ mutate(d, c) { if (c.path.endsWith('/heads/' + BRANCH) && c.occurrence === occurrence) d.object.sha = OTHER } }), 'CI_PREVIEW_HEAD_CHANGED')
  await rejects(provider({ mutate(d, { path }) { if (path.endsWith('/heads/main')) d.object.type = 'tag' } }), 'CI_PREVIEW_BASE_IDENTITY')
  await rejects(provider({ mutate(d, { path }) { if (path.endsWith('/heads/' + BRANCH)) d.ref = 'refs/tags/' + BRANCH } }), 'CI_PREVIEW_HEAD_CHANGED')
})

test('late push run, retry, event or timestamp changes invalidate earlier success', async () => {
  await rejects(provider({ mutate(d, { path, url, occurrence }) {
    if (path.endsWith('/runs') && url.searchParams.get('event') === 'push' && occurrence === 2) {
      d.workflow_runs = [{ ...RUN, id: 9200, run_number: 13, event: 'push', status: 'queued', conclusion: null }]; d.total_count = 1
    }
  } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ attempt: { ...RUN, event: 'pull_request' } }), 'CI_RUN_IDENTITY')
  for (const patch of [{ run_attempt: 2 }, { check_suite_id: 9000 }]) await rejects(provider({ attempt: { ...RUN, ...patch } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(d, { path, occurrence }) { if (path.endsWith('/actions/runs/' + RUN.id) && occurrence === 2) d.run_attempt++ } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(d, { path, occurrence }) { if (path.endsWith('/actions/runs/' + RUN.id) && occurrence === 2) d.updated_at = iso(-20_000) } }), 'CI_EVIDENCE_CHANGED')
})

test('every required job and every exact-checkout/security step must succeed in this attempt', async t => {
  for (let index = 0; index < 3; index++) await t.test('mandatory job ' + index, async () => {
    const missing = jobsFor(); missing.splice(index, 1); await rejects(provider({ jobs: missing }), 'CI_JOB_MISSING')
    for (const conclusion of ['skipped', 'failure', 'neutral', 'cancelled']) {
      const jobs = jobsFor(); jobs[index].conclusion = conclusion; await rejects(provider({ jobs }), 'CI_JOB_NOT_SUCCESSFUL')
    }
    for (const required of REQUIRED_CI_JOBS[jobsFor()[index].name]) {
      const missingStep = jobsFor(); missingStep[index].steps = missingStep[index].steps.filter(s => s.name !== required)
      await rejects(provider({ jobs: missingStep }), 'CI_STEP_MISSING')
      const skipped = jobsFor(); skipped[index].steps.find(s => s.name === required).conclusion = 'skipped'
      await rejects(provider({ jobs: skipped }), 'CI_STEP_NOT_SUCCESSFUL')
    }
  })
  for (const patch of [{ run_id: 1 }, { run_attempt: 2 }, { head_sha: OTHER }, { head_branch: 'other' }, { workflow_name: 'Forged' }]) {
    const jobs = jobsFor(); Object.assign(jobs[0], patch); await rejects(provider({ jobs }), 'CI_JOB_IDENTITY')
  }
  const jobs = jobsFor(); jobs.push({ ...jobs[0], id: 3000 }); await rejects(provider({ jobs }), 'CI_JOB_IDENTITY')
  const steps = jobsFor(); steps[0].steps.push({ ...steps[0].steps[0], number: 30 }); await rejects(provider({ jobs: steps }), 'CI_STEP_IDENTITY')
})

test('freshness and canonical provider timestamps are required', async () => {
  await rejects(provider({ run: { ...RUN, created_at: iso(-CI_FRESHNESS_MS - 1000), run_started_at: iso(-CI_FRESHNESS_MS - 1) } }), 'CI_RUN_STALE')
  await rejects(provider({ run: { ...RUN, updated_at: iso(1) } }), 'CI_RUN_FUTURE')
  await rejects(provider({ run: { ...RUN, created_at: '2026-02-31T00:00:00Z' } }), 'CI_INVALID_TIMESTAMP')
})

test('unsafe inputs and aborted requests perform no reads', async () => {
  for (const branch of ['', 'main', '../main', 'foo/../bar', 'foo//bar', '.hidden', 'foo.lock', 'foo/', 'a'.repeat(40), 'foo\nbar', 'a'.repeat(201)]) {
    const p = provider(); await rejects(p, 'CI_INVALID_INPUT', { branch }); assert.equal(p.calls.length, 0)
  }
  for (const extra of [{ sha: 'A'.repeat(40) }, { now: NaN }, { now: -1 }, { token: 'header\r\ninjection' }]) {
    const p = provider(); await rejects(p, 'CI_INVALID_INPUT', extra); assert.equal(p.calls.length, 0)
  }
  const controller = new AbortController(); controller.abort(); const p = provider()
  await rejects(p, 'CI_ABORTED', { signal: controller.signal }); assert.equal(p.calls.length, 0)
})

test('bounded fixed-origin transport rejects malformed pages, redirects, errors and oversize bodies', async () => {
  await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 5, jobs: jobsFor() }) } }), 'CI_API_PAGINATION')
  await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 5, jobs: jobsFor() }, { headers: { link: '<https://attacker.invalid/steal>; rel="next"' } }) } }), 'CI_API_PAGINATION')
  for (const status of [401, 403, 404, 500]) await rejects(provider({ respond() { return response({ message: 'untrusted private content' }, { status }) } }), 'CI_API_UNAVAILABLE')
  await rejects(provider({ respond() { return response({}, { status: 429 }) } }), 'CI_API_RATE_LIMIT')
  await rejects(provider({ respond() { return response({}, { status: 302, headers: { location: 'https://attacker.invalid' } }) } }), 'CI_API_REDIRECT')
  await rejects(provider({ respond() { return response({ huge: 'x'.repeat(CI_MAX_RESPONSE_BYTES) }) } }), 'CI_API_OVERSIZE')
  await rejects(provider({ respond() { return new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }) } }), 'CI_API_INVALID_RESPONSE')
})

test('optional token never leaves fixed GET headers or appears in receipts/errors; cancellation is immediate', async () => {
  const token = 'ghp_fictional_branch', p = provider(), r = await verify(p, { token })
  assert.ok(p.calls.every(c => c.init.headers.Authorization === 'Bearer ' + token)); assert.doesNotMatch(JSON.stringify(r), /fictional_branch/)
  await rejects(provider({ respond() { throw Error(token) } }), 'CI_API_UNAVAILABLE', { token })
  const controller = new AbortController(), stuck = provider({ respond() { return new Promise(() => {}) } })
  const pending = verify(stuck, { signal: controller.signal }); controller.abort()
  await assert.rejects(pending, e => e.code === 'CI_ABORTED'); assert.equal(stuck.calls.length, 1); assert.equal(stuck.calls[0].init.signal.aborted, true)
})

// Observed GitHub behavior: run and attempt are separate resources and their
// updated_at can differ even when their source and lifecycle are identical.
test('stable run/attempt resource timestamps may differ; receipt uses the latest verified completion', async () => {
  for (const delta of [-31_000, -29_000]) {
    const p = provider({ attempt: { ...RUN, updated_at: iso(delta) } }), receipt = await verify(p)
    assert.equal(receipt.completedAt, iso(Math.max(-30_000, delta)))
    assert.equal(receipt.runId, RUN.id); assert.equal(receipt.runAttempt, RUN.run_attempt)
    assert.equal(p.calls.filter(c => c.url.pathname.endsWith('/actions/runs/' + RUN.id)).length, 2)
    assert.equal(p.calls.filter(c => c.url.pathname.endsWith('/attempts/1')).length, 2)
  }
})

test('each resource snapshot remains immutable and run/attempt execution start must agree', async t => {
  const mutations = { created_at: iso(-310_000), run_started_at: iso(-250_000), updated_at: iso(-20_000) }
  for (const resource of ['run', 'attempt']) for (const [field, value] of Object.entries(mutations)) {
    await t.test(resource + ':' + field, () => rejects(provider({ mutate(d, { path, occurrence }) {
      const endpoint = resource === 'run' ? /\/actions\/runs\/\d+$/ : /\/attempts\/\d+$/
      if (endpoint.test(path) && occurrence === 2) d[field] = value
    } }), 'CI_EVIDENCE_CHANGED'))
  }
  for (const field of ['run_started_at']) await t.test('cross-resource ' + field, () => rejects(
    provider({ attempt: { ...RUN, [field]: mutations[field] } }), 'CI_EVIDENCE_CHANGED'))
  for (const [field, value] of Object.entries({ id: RUN.id + 1, run_number: RUN.run_number + 1, run_attempt: 2, check_suite_id: RUN.check_suite_id + 1 })) {
    await t.test('final attempt identity:' + field, () => rejects(provider({ mutate(d, { path, occurrence }) {
      if (/\/attempts\/\d+$/.test(path) && occurrence === 2) d[field] = value
    } }), 'CI_EVIDENCE_CHANGED'))
  }
  await rejects(provider({ mutate(d, { path, occurrence }) {
    if (/\/attempts\/\d+$/.test(path) && occurrence === 2) d.conclusion = 'failure'
  } }), 'CI_RUN_NOT_SUCCESSFUL')
})

// GitHub can create the attempt record after execution has already started.
// This metadata is not a shared causal start time or a freshness override.
test('independent resource creation metadata can follow the shared execution start', async () => {
  const run = { ...RUN, created_at: iso(-239_000) }
  for (const attemptCreated of [iso(-310_000), iso(-241_000), iso(-239_000), iso(-238_000)]) {
    const receipt = await verify(provider({ run, attempt: { ...RUN, created_at: attemptCreated } }))
    assert.equal(receipt.runId, RUN.id); assert.equal(receipt.runAttempt, RUN.run_attempt)
    assert.equal(receipt.completedAt, RUN.updated_at)
  }
})

test('creation metadata remains canonical, nonfuture and no later than its own update', async t => {
  for (const resource of ['run', 'attempt']) {
    for (const [created, code] of [[null, 'CI_INVALID_TIMESTAMP'], ['not-a-date', 'CI_INVALID_TIMESTAMP'],
      ['2026-02-31T00:00:00Z', 'CI_INVALID_TIMESTAMP'], [iso(1), 'CI_RUN_FUTURE'], [iso(-20_000), 'CI_INVALID_TIMESTAMP']]) {
      await t.test(resource + ':' + String(created), () => rejects(provider({ [resource]: { ...RUN, created_at: created } }), code))
    }
  }
})
