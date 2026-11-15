// Entirely fictional GET responses. No network, hooks, Vercel or UI calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { verifyGithubPreview, PREVIEW_CI_MAX_REQUESTS, isValidPreviewBranch } from '../security-ci/verified-preview-ci.mjs'
import { CI_POLICY, CI_FRESHNESS_MS, CI_MAX_RESPONSE_BYTES, REQUIRED_CI_JOBS, EXACT_CHECKOUT_STEP, GithubVerificationError } from '../security-ci/verified-ci.mjs'

const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const BRANCH = 'feature/test-preview', PR_NUMBER = 77, PR_ID = 7100
const NOW = Date.parse('2026-11-15T18:00:00Z'), iso = delta => new Date(NOW + delta).toISOString()
const copy = value => structuredClone(value), ROOT = '/repos/Olegys1/xelay'
const REPO = { id: CI_POLICY.repositoryId, full_name: CI_POLICY.repository, owner: { id: CI_POLICY.ownerId }, private: false, default_branch: 'main' }
const LINK = { id: PR_ID, number: PR_NUMBER,
  head: { sha: SHA, ref: BRANCH, repo: { id: CI_POLICY.repositoryId } },
  base: { sha: BASE, ref: 'main', repo: { id: CI_POLICY.repositoryId } },
}
const PULL = { id: PR_ID, number: PR_NUMBER, state: 'open', merged: false,
  head: { sha: SHA, ref: BRANCH, repo: REPO }, base: { sha: BASE, ref: 'main', repo: REPO },
}
const RUN = { id: 9100, run_number: 12, run_attempt: 1, check_suite_id: 8100,
  workflow_id: CI_POLICY.workflowId, path: CI_POLICY.workflowPath, name: CI_POLICY.workflowName,
  event: 'pull_request', head_branch: BRANCH, head_sha: SHA, repository: REPO, head_repository: REPO, pull_requests: [LINK],
  status: 'completed', conclusion: 'success', created_at: iso(-300_000), run_started_at: iso(-240_000), updated_at: iso(-30_000),
}
function jobsFor(run = RUN) {
  return Object.entries(REQUIRED_CI_JOBS).map(([name, essential], index) => ({
    id: 1000 + index, name, run_id: run.id, run_attempt: run.run_attempt, head_sha: SHA, head_branch: BRANCH, workflow_name: CI_POLICY.workflowName,
    status: 'completed', conclusion: 'success', started_at: iso(-180_000), completed_at: iso(-60_000),
    steps: essential.map((name, number) => ({ name, number: number + 1, status: 'completed', conclusion: 'success' })),
  })).concat({ id: 2000, name: 'security-full', run_id: run.id, run_attempt: run.run_attempt, head_sha: SHA, head_branch: BRANCH,
    workflow_name: CI_POLICY.workflowName, status: 'completed', conclusion: 'skipped', steps: null })
}
const response = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
function provider(options = {}) {
  const calls = [], counters = new Map()
  async function fetchImpl(address, init) {
    const url = new URL(address), path = url.pathname, occurrence = (counters.get(path) || 0) + 1
    counters.set(path, occurrence); calls.push({ url, init, occurrence })
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.ok(init.signal instanceof AbortSignal)
    const context = { url, init, path, occurrence, calls }, direct = await options.respond?.(context)
    if (direct !== undefined) return direct
    let data
    if (path === ROOT) data = copy(REPO)
    else if (path === ROOT + '/git/ref/heads/main') data = { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE } }
    else if (path === ROOT + '/git/ref/heads/' + BRANCH) data = { ref: 'refs/heads/' + BRANCH, object: { type: 'commit', sha: SHA } }
    else if (path === ROOT + '/pulls/' + PR_NUMBER) data = copy(PULL)
    else if (path === ROOT + '/contents/' + CI_POLICY.workflowPath) { assert.equal(url.searchParams.get('ref'), SHA); data = { type: 'file', path: CI_POLICY.workflowPath, sha: CI_POLICY.workflowBlob } }
    else if (path === ROOT + '/actions/workflows/' + CI_POLICY.workflowId) data = { id: CI_POLICY.workflowId, path: CI_POLICY.workflowPath, name: CI_POLICY.workflowName, state: 'active' }
    else if (path.startsWith(ROOT + '/compare/')) {
      assert.equal(path, ROOT + '/compare/' + BASE + '...' + SHA); assert.equal(url.searchParams.get('per_page'), '1')
      data = { base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, status: 'ahead', ahead_by: 2, behind_by: 0 }
    } else if (path.endsWith('/runs')) {
      assert.equal(url.searchParams.get('event'), 'pull_request'); assert.equal(url.searchParams.get('head_sha'), SHA)
      assert.equal(url.searchParams.get('branch'), BRANCH); assert.equal(url.searchParams.get('exclude_pull_requests'), 'false')
      data = { total_count: options.runs?.length ?? 1, workflow_runs: copy(options.runs ?? [RUN]) }
    } else if (/\/attempts\/\d+\/jobs$/.test(path)) data = { total_count: (options.jobs ?? jobsFor()).length, jobs: copy(options.jobs ?? jobsFor()) }
    else if (/\/attempts\/\d+$/.test(path)) data = copy(options.attempt ?? options.run ?? RUN)
    else if (/\/actions\/runs\/\d+$/.test(path)) data = copy(options.run ?? RUN)
    else assert.fail('Unexpected provider path')
    options.mutate?.(data, context)
    return response(data)
  }
  return { calls, fetchImpl }
}
const verify = (p, extra = {}) => verifyGithubPreview({ sha: SHA, branch: BRANCH, pullRequestNumber: PR_NUMBER, now: NOW, fetchImpl: p.fetchImpl, ...extra })
async function rejects(p, code, extra = {}) {
  await assert.rejects(verify(p, extra), error => error instanceof GithubVerificationError && error.code === code
    && error.message === `GitHub release proof rejected (${code}).`)
}

test('pinned workflow explicitly checks exact HEAD plus base ancestry before all three mandatory jobs', () => {
  const bytes = readFileSync(new URL('../../.github/workflows/security-checks.yml', import.meta.url))
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.equal(hash, CI_POLICY.workflowBlob)
  const text = bytes.toString('utf8'), jobs = text.split(/^  security-/m).slice(1, 4)
  assert.equal(jobs.length, 3)
  for (const job of jobs) {
    assert.match(job, /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
    assert.match(job, /fetch-depth: 0/); assert.match(job, /set -euo pipefail/)
    assert.match(job, /git merge-base --is-ancestor "\$PR_BASE_SHA" "\$EXPECTED_SHA"/)
    assert.ok(job.indexOf(EXACT_CHECKOUT_STEP) < job.indexOf('actions/setup-node@'))
    assert.match(job, /EXPECTED_SHA: \$\{\{/); assert.match(job, /PR_BASE_SHA: \$\{\{/)
    assert.ok(REQUIRED_CI_JOBS['security-' + job.split(':')[0]].includes(EXACT_CHECKOUT_STEP))
  }
})

test('exact open same-repo HEAD yields a bounded immutable preview-specific receipt', async () => {
  const p = provider(), r = await verify(p)
  assert.equal(r.mode, 'preview'); assert.equal(r.sha, SHA); assert.equal(r.branch, BRANCH)
  assert.equal(r.pullRequestNumber, PR_NUMBER); assert.equal(r.pullRequestId, PR_ID); assert.equal(r.baseSha, BASE)
  assert.equal(r.runId, RUN.id); assert.equal(r.runAttempt, 1); assert.equal(r.repositoryId, CI_POLICY.repositoryId)
  assert.equal(r.workflowBlob, CI_POLICY.workflowBlob); assert.equal(r.verifiedAt, iso(0))
  assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.jobIds)); assert.equal(p.calls.length, 16)
  assert.ok(p.calls.length <= PREVIEW_CI_MAX_REQUESTS)
  assert.equal(p.calls.filter(c => c.url.pathname.endsWith('/pulls/' + PR_NUMBER)).length, 2)
  assert.equal(p.calls.filter(c => c.url.pathname.endsWith('/git/ref/heads/main')).length, 2)
})

test('hook with no PR hint derives only the unique exact latest run association then verifies the actual PR', async () => {
  const p = provider(), r = await verify(p, { pullRequestNumber: undefined })
  assert.equal(r.pullRequestNumber, PR_NUMBER); assert.equal(r.baseSha, BASE)
  assert.equal(p.calls.filter(c => c.url.pathname.includes('/pulls/')).length, 2)
  assert.ok(p.calls.every(c => c.url.pathname !== ROOT + '/pulls'))
})

test('invalid inputs and unsafe branch refs make zero requests', async t => {
  for (const branch of ['', 'main', '../main', 'foo/../bar', 'foo//bar', '.hidden', 'foo/.hidden', 'foo.lock', 'foo/bar.lock', 'foo.', 'foo/', '-foo', 'a'.repeat(40), 'foo@{bar', 'foo\nbar', 'я', 'a'.repeat(201)]) {
    await t.test('invalid branch ' + JSON.stringify(branch), async () => { const p = provider(); assert.equal(isValidPreviewBranch(branch), false); await rejects(p, 'CI_INVALID_INPUT', { branch }); assert.equal(p.calls.length, 0) })
  }
  for (const value of [0, -1, null, '', '77', 1.5, Infinity]) await t.test('PR ' + String(value), async () => {
    const p = provider(); await rejects(p, 'CI_INVALID_INPUT', { pullRequestNumber: value }); assert.equal(p.calls.length, 0)
  })
  for (const extra of [{ sha: 'A'.repeat(40) }, { now: NaN }, { now: -1 }, { token: 'header\r\ninjection' }]) {
    const p = provider(); await rejects(p, 'CI_INVALID_INPUT', extra); assert.equal(p.calls.length, 0)
  }
  const controller = new AbortController(); controller.abort(); const p = provider()
  await rejects(p, 'CI_ABORTED', { signal: controller.signal }); assert.equal(p.calls.length, 0)
})

test('repo, workflow and exact new checkout workflow blob remain authoritative', async t => {
  for (const patch of [{ id: 1 }, { owner: { id: 2 } }, { full_name: 'fork/xelay' }, { private: true }, { default_branch: 'dev' }]) await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path === ROOT) Object.assign(d, patch) } }), 'CI_REPOSITORY_MISMATCH'))
  for (const patch of [{ id: 2 }, { name: 'Forged' }, { state: 'disabled_manually' }, { path: 'other.yml' }]) await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path.endsWith('/workflows/' + CI_POLICY.workflowId)) Object.assign(d, patch) } }), 'CI_WORKFLOW_MISMATCH'))
  for (const patch of [{ sha: '7b73f719e9ccb50be18f884fd98c7d93cdb4bad6' }, { type: 'symlink' }, { path: 'other.yml' }]) await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path.includes('/contents/')) Object.assign(d, patch) } }), 'CI_WORKFLOW_MISMATCH'))
})

test('closed, foreign, forked, mismatched or replaced PR never authorizes preview', async t => {
  const patches = [{ state: 'closed' }, { merged: true }, { id: 0 }, { number: 78 },
    { head: { ...PULL.head, sha: OTHER } }, { head: { ...PULL.head, ref: 'other' } },
    { head: { ...PULL.head, repo: { ...REPO, id: 2 } } }, { head: { ...PULL.head, repo: { ...REPO, owner: { id: 2 } } } },
    { base: { ...PULL.base, ref: 'other' } }, { base: { ...PULL.base, repo: { ...REPO, id: 2 } } }]
  for (const patch of patches) await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path.includes('/pulls/')) Object.assign(d, patch) } }), 'CI_PREVIEW_PR_IDENTITY'))
  await rejects(provider({ mutate(d, { path, occurrence }) { if (path.includes('/pulls/') && occurrence === 2) d.id++ } }), 'CI_PREVIEW_PR_IDENTITY')
  await rejects(provider({ mutate(d, { path }) { if (path.includes('/pulls/')) d.base.sha = OTHER } }), 'CI_PREVIEW_BASE_CHANGED')
})

test('base, branch and PR changes before or during verification fail closed', async t => {
  for (const occurrence of [1, 2]) {
    await t.test('main change at ' + occurrence, () => rejects(provider({ mutate(d, c) { if (c.path.endsWith('/heads/main') && c.occurrence === occurrence) d.object.sha = OTHER } }), 'CI_PREVIEW_BASE_CHANGED'))
    await t.test('head change at ' + occurrence, () => rejects(provider({ mutate(d, c) { if (c.path.endsWith('/heads/' + BRANCH) && c.occurrence === occurrence) d.object.sha = OTHER } }), 'CI_PREVIEW_HEAD_CHANGED'))
  }
  await rejects(provider({ mutate(d, { path }) { if (path.endsWith('/heads/main')) d.ref = 'refs/tags/main' } }), 'CI_PREVIEW_BASE_IDENTITY')
  await rejects(provider({ mutate(d, { path }) { if (path.endsWith('/heads/' + BRANCH)) d.object.type = 'tag' } }), 'CI_PREVIEW_HEAD_CHANGED')
})

test('both initial and final authoritative PR reads require explicit merged false', async t => {
  for (const occurrence of [1, 2]) {
    for (const merged of [true, undefined, null]) await t.test('PR read ' + occurrence + ', merged ' + String(merged), () => rejects(provider({
      mutate(d, c) { if (c.path === ROOT + '/pulls/' + PR_NUMBER && c.occurrence === occurrence) d.merged = merged },
    }), 'CI_PREVIEW_PR_IDENTITY'))
  }
  await rejects(provider({ mutate(d, { path, occurrence }) {
    if (path === ROOT + '/pulls/' + PR_NUMBER && occurrence === 2) d.state = 'closed'
  } }), 'CI_PREVIEW_PR_IDENTITY')
})

test('base must be an ancestor of the exact HEAD, not merely a mergeable branch', async t => {
  for (const patch of [{ status: 'diverged' }, { status: 'behind' }, { status: 'identical' }, { behind_by: 1 }, { ahead_by: 0 },
    { merge_base_commit: { sha: OTHER } }, { base_commit: { sha: OTHER } }]) await t.test(JSON.stringify(patch), () => rejects(provider({ mutate(d, { path }) { if (path.includes('/compare/')) Object.assign(d, patch) } }), 'CI_PREVIEW_ANCESTRY'))
})

test('PR number and immutable association cannot be guessed, omitted, forked or swapped', async t => {
  for (const links of [[], null, [LINK, LINK], [{ ...LINK, number: 78 }], [{ ...LINK, id: 0 }],
    [{ ...LINK, head: { ...LINK.head, sha: OTHER } }], [{ ...LINK, head: { ...LINK.head, ref: 'other' } }],
    [{ ...LINK, head: { ...LINK.head, repo: { id: 7 } } }], [{ ...LINK, base: { ...LINK.base, ref: 'other' } }],
    [{ ...LINK, base: { ...LINK.base, repo: { id: 7 } } }]]) await t.test(JSON.stringify(links), () => rejects(provider({ runs: [{ ...RUN, pull_requests: links }] }), 'CI_PREVIEW_RUN_PR_IDENTITY'))
  await rejects(provider(), 'CI_PREVIEW_RUN_PR_IDENTITY', { pullRequestNumber: 99 })
  for (const links of [[], [LINK, LINK], [{ ...LINK, number: null }]]) await rejects(provider({ runs: [{ ...RUN, pull_requests: links }] }), 'CI_PREVIEW_RUN_PR_IDENTITY', { pullRequestNumber: undefined })
  await rejects(provider({ run: { ...RUN, pull_requests: [{ ...LINK, id: 42 }] } }), 'CI_PREVIEW_RUN_PR_IDENTITY')
})

test('only latest fixed-identity run can authorize and old-base historical runs do not cause permanent denial', async t => {
  for (const patch of [{ event: 'push' }, { event: 'workflow_dispatch' }, { workflow_id: 9 }, { head_branch: 'other' }, { head_sha: OTHER },
    { path: 'fake.yml' }, { repository: { ...REPO, id: 9 } }, { head_repository: { ...REPO, id: 9 } }]) await t.test(JSON.stringify(patch), () => rejects(provider({ runs: [{ ...RUN, ...patch }] }), 'CI_RUN_IDENTITY'))
  await rejects(provider({ runs: [] }), 'CI_RUN_MISSING')
  const newer = { ...RUN, id: 9200, run_number: 13, status: 'in_progress', conclusion: null }
  await rejects(provider({ runs: [RUN, newer], run: newer }), 'CI_PENDING')
  await rejects(provider({ runs: [RUN, { ...newer, status: 'completed', conclusion: 'failure' }], run: { ...newer, status: 'completed', conclusion: 'failure' } }), 'CI_RUN_NOT_SUCCESSFUL')
  const old = { ...RUN, id: 9000, run_number: 11, pull_requests: [{ ...LINK, base: { ...LINK.base, sha: OTHER } }] }
  await verify(provider({ runs: [old, RUN] }))
})

test('retries, partial retries and newer run/attempt races cannot reuse an older success', async () => {
  await rejects(provider({ run: { ...RUN, run_attempt: 2 } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ attempt: { ...RUN, run_attempt: 2 } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(d, { path, occurrence }) {
    if (path.endsWith('/runs') && occurrence === 2) { d.workflow_runs.push({ ...RUN, id: 9200, run_number: 13, status: 'queued', conclusion: null }); d.total_count++ }
  } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(d, { path, occurrence }) { if (path.endsWith('/actions/runs/' + RUN.id) && occurrence === 2) d.run_attempt++ } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(d, { path, occurrence }) { if (path.endsWith('/actions/runs/' + RUN.id) && occurrence === 2) d.updated_at = iso(-20_000) } }), 'CI_EVIDENCE_CHANGED')
  const jobs = jobsFor(); jobs[0].run_attempt = 2; await rejects(provider({ jobs }), 'CI_JOB_IDENTITY')
})

test('freshness, future times and non-success conclusions are rejected', async t => {
  for (const conclusion of ['skipped', 'neutral', 'failure', 'cancelled', 'timed_out', null]) await t.test(String(conclusion), () => rejects(provider({ run: { ...RUN, conclusion } }), 'CI_RUN_NOT_SUCCESSFUL'))
  await rejects(provider({ runs: [{ ...RUN, created_at: iso(-CI_FRESHNESS_MS - 1000), run_started_at: iso(-CI_FRESHNESS_MS - 1) }] }), 'CI_RUN_STALE')
  await rejects(provider({ run: { ...RUN, updated_at: iso(1) } }), 'CI_RUN_FUTURE')
  await rejects(provider({ run: { ...RUN, created_at: '2026-02-31T00:00:00Z' } }), 'CI_INVALID_TIMESTAMP')
})

test('all required jobs and the exact-checkout/ancestry step are mandatory in this attempt', async t => {
  for (let index = 0; index < 3; index++) await t.test('mandatory job ' + index, async () => {
    const missing = jobsFor(); missing.splice(index, 1); await rejects(provider({ jobs: missing }), 'CI_JOB_MISSING')
    const skipped = jobsFor(); skipped[index].conclusion = 'skipped'; await rejects(provider({ jobs: skipped }), 'CI_JOB_NOT_SUCCESSFUL')
    const noExact = jobsFor(); noExact[index].steps = noExact[index].steps.filter(s => s.name !== EXACT_CHECKOUT_STEP); await rejects(provider({ jobs: noExact }), 'CI_STEP_MISSING')
    const fakeExact = jobsFor(); fakeExact[index].steps.find(s => s.name === EXACT_CHECKOUT_STEP).conclusion = 'skipped'; await rejects(provider({ jobs: fakeExact }), 'CI_STEP_NOT_SUCCESSFUL')
  })
  for (const patch of [{ run_id: 2 }, { head_sha: OTHER }, { head_branch: 'other' }, { workflow_name: 'Forged' }, { run_attempt: undefined }]) await t.test(JSON.stringify(patch), async () => {
    const jobs = jobsFor(); Object.assign(jobs[0], patch); await rejects(provider({ jobs }), 'CI_JOB_IDENTITY')
  })
  const dup = jobsFor(); dup.push({ ...dup[0], id: 1009 }); await rejects(provider({ jobs: dup }), 'CI_JOB_IDENTITY')
  const stepDup = jobsFor(); stepDup[0].steps.push({ ...stepDup[0].steps[0], number: 30 }); await rejects(provider({ jobs: stepDup }), 'CI_STEP_IDENTITY')
})

test('missing/incoherent pages, redirects and provider body failures never become proof', async () => {
  await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 5, jobs: jobsFor() }) } }), 'CI_API_PAGINATION')
  await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 5, jobs: jobsFor() }, { headers: { link: '<https://attacker.invalid/steal>; rel="next"' } }) } }), 'CI_API_PAGINATION')
  for (const status of [401, 403, 404, 500]) await rejects(provider({ respond() { return response({ message: 'never expose provider content' }, { status }) } }), 'CI_API_UNAVAILABLE')
  await rejects(provider({ respond() { return response({}, { status: 429 }) } }), 'CI_API_RATE_LIMIT')
  await rejects(provider({ respond() { return response({}, { status: 302, headers: { location: 'https://attacker.invalid' } }) } }), 'CI_API_REDIRECT')
  await rejects(provider({ respond() { return response({ huge: 'x'.repeat(CI_MAX_RESPONSE_BYTES) }) } }), 'CI_API_OVERSIZE')
  await rejects(provider({ respond() { return new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }) } }), 'CI_API_INVALID_RESPONSE')
})

test('optional token is scoped to fixed GET headers, not receipt or errors; cancellation is immediate', async () => {
  const token = 'ghp_fictional_preview', p = provider(), r = await verify(p, { token })
  assert.ok(p.calls.every(c => c.init.headers.Authorization === 'Bearer ' + token)); assert.doesNotMatch(JSON.stringify(r), /fictional_preview/)
  await rejects(provider({ respond() { throw Error(token) } }), 'CI_API_UNAVAILABLE', { token })
  const controller = new AbortController(), stuck = provider({ respond() { return new Promise(() => {}) } })
  const pending = verify(stuck, { signal: controller.signal }); controller.abort()
  await assert.rejects(pending, e => e.code === 'CI_ABORTED'); assert.equal(stuck.calls.length, 1); assert.equal(stuck.calls[0].init.signal.aborted, true)
})
