// Fictional provider responses only. No GitHub, Vercel, hooks or UI calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyGithubCommit, GithubVerificationError, CI_POLICY, REQUIRED_CI_JOBS,
  CI_FRESHNESS_MS, CI_MAX_REQUESTS, CI_MAX_RESPONSE_BYTES, CI_REQUEST_TIMEOUT_MS,
} from '../security-ci/verified-ci.mjs'

const SHA = 'a'.repeat(40), NOW = Date.parse('2026-11-15T12:00:00Z')
const iso = difference => new Date(NOW + difference).toISOString()
const copy = value => structuredClone(value)
const REPO = { id: CI_POLICY.repositoryId, full_name: CI_POLICY.repository, owner: { id: CI_POLICY.ownerId }, private: false, default_branch: 'main' }
const RUN = { id: 9100, run_number: 12, run_attempt: 1, check_suite_id: 8100,
  workflow_id: CI_POLICY.workflowId, path: CI_POLICY.workflowPath, name: CI_POLICY.workflowName,
  event: 'push', head_branch: 'main', head_sha: SHA, repository: REPO, head_repository: REPO,
  status: 'completed', conclusion: 'success', created_at: iso(-5 * 60_000), run_started_at: iso(-4 * 60_000), updated_at: iso(-30_000),
}
function jobsFor(run = RUN) {
  return Object.entries(REQUIRED_CI_JOBS).map(([name, essential], index) => ({
    id: 1000 + index, name, run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha, head_branch: 'main', workflow_name: 'Security checks',
    status: 'completed', conclusion: 'success', started_at: iso(-3 * 60_000), completed_at: iso(-60_000),
    steps: essential.map((name, number) => ({ name, number: number + 1, status: 'completed', conclusion: 'success' })),
  })).concat({ id: 2000, name: 'security-full', run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha, head_branch: 'main', workflow_name: 'Security checks', status: 'completed', conclusion: 'skipped', steps: null })
}
const response = (data, init = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...init.headers }, ...init })

function provider(options = {}) {
  const calls = [], counters = new Map()
  async function fetchImpl(address, init) {
    const url = new URL(address), path = url.pathname
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.ok(init.signal instanceof AbortSignal)
    const occurrence = (counters.get(path) || 0) + 1
    counters.set(path, occurrence); calls.push({ url, init, occurrence })
    const context = { url, init, path, occurrence, calls }
    const direct = await options.respond?.(context)
    if (direct !== undefined) return direct
    let data
    const base = '/repos/Olegys1/xelay'
    if (path === base) data = copy(REPO)
    else if (path === base + '/git/ref/heads/main') data = { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } }
    else if (path === base + '/contents/' + CI_POLICY.workflowPath) data = { type: 'file', path: CI_POLICY.workflowPath, sha: CI_POLICY.workflowBlob }
    else if (path === base + '/actions/workflows/' + CI_POLICY.workflowId) data = { id: CI_POLICY.workflowId, path: CI_POLICY.workflowPath, name: CI_POLICY.workflowName, state: 'active' }
    else if (path.endsWith('/runs')) data = { total_count: options.runs?.length ?? 1, workflow_runs: copy(options.runs ?? [RUN]) }
    else if (/\/attempts\/\d+\/jobs$/.test(path)) data = { total_count: (options.jobs ?? jobsFor()).length, jobs: copy(options.jobs ?? jobsFor()) }
    else if (/\/attempts\/\d+$/.test(path)) data = copy(options.attempt ?? options.run ?? RUN)
    else if (/\/actions\/runs\/\d+$/.test(path)) data = copy(options.run ?? RUN)
    else assert.fail('Unexpected provider path ' + path)
    options.mutate?.(data, context)
    return response(data)
  }
  return { calls, fetchImpl }
}
const verify = (p, extra = {}) => verifyGithubCommit({ sha: SHA, now: NOW, fetchImpl: p.fetchImpl, ...extra })
async function rejects(p, code, extra = {}) {
  await assert.rejects(verify(p, extra), error => {
    assert.ok(error instanceof GithubVerificationError)
    assert.equal(error.code, code)
    assert.equal(error.message, `GitHub release proof rejected (${code}).`)
    return true
  })
}

test('valid exact public main commit yields a bounded immutable nonsecret receipt', async () => {
  const p = provider(), receipt = await verify(p)
  assert.equal(receipt.sha, SHA); assert.equal(receipt.runId, RUN.id); assert.equal(receipt.runAttempt, 1)
  assert.equal(receipt.workflowBlob, CI_POLICY.workflowBlob); assert.equal(receipt.repositoryId, CI_POLICY.repositoryId)
  assert.equal(receipt.verifiedAt, iso(0)); assert.equal(receipt.completedAt, RUN.updated_at)
  assert.deepEqual(receipt.jobIds, { 'security-core': 1000, 'security-dependencies': 1001, 'security-secrets': 1002 })
  assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.jobIds)); assert.ok(Object.isFrozen(CI_POLICY))
  assert.equal(CI_POLICY.projectId, 'prj_Yl9R5uI2IdwyeNaIhbfIlObMO5bq')
  assert.ok(p.calls.length <= CI_MAX_REQUESTS); assert.equal(p.calls.length, 12)
  assert.equal(p.calls.filter(call => call.url.pathname.endsWith('/attempts/1/jobs')).length, 1)
  assert.equal(p.calls.filter(call => call.url.pathname.endsWith('/git/ref/heads/main')).length, 2)
  assert.ok(p.calls.every(call => !call.init.headers.Authorization))
})

test('optional read token goes only in fixed-origin headers and never into receipt/errors', async () => {
  const token = 'ghp_fictional_test_value', p = provider()
  const receipt = await verify(p, { token })
  assert.ok(p.calls.every(call => call.init.headers.Authorization === 'Bearer ' + token))
  assert.doesNotMatch(JSON.stringify(receipt), /fictional_test_value|Authorization/)
  await rejects(provider({ respond() { throw Error(token) } }), 'CI_API_UNAVAILABLE', { token })
})

test('untrusted inputs and pre-aborted callers make no provider request', async t => {
  for (const sha of ['', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41), '../main', 'main']) await t.test('sha ' + sha.length, async () => {
    const p = provider(); await rejects(p, 'CI_INVALID_INPUT', { sha }); assert.equal(p.calls.length, 0)
  })
  for (const value of [NaN, Infinity, -1, null, 'today']) await t.test('clock ' + String(value), async () => {
    const p = provider(); await rejects(p, 'CI_INVALID_INPUT', { now: value }); assert.equal(p.calls.length, 0)
  })
  const p = provider(), controller = new AbortController(); controller.abort()
  await rejects(p, 'CI_ABORTED', { signal: controller.signal }); assert.equal(p.calls.length, 0)
  await rejects(provider(), 'CI_INVALID_INPUT', { token: 'value\r\nInjected: true' })
})

test('repository and workflow pins cannot be redirected through names or environment flags', async t => {
  for (const patch of [{ id: 7 }, { owner: { id: 8 } }, { full_name: 'attacker/xelay' }, { private: true }, { default_branch: 'other' }]) await t.test(JSON.stringify(patch), async () => {
    await rejects(provider({ mutate(data, { path }) { if (path === '/repos/Olegys1/xelay') Object.assign(data, patch) } }), 'CI_REPOSITORY_MISMATCH')
  })
  for (const patch of [{ id: 1 }, { path: 'fake.yml' }, { state: 'disabled_manually' }, { name: 'Fake checks' }]) await t.test(JSON.stringify(patch), async () => {
    await rejects(provider({ mutate(data, { path }) { if (path.endsWith('/workflows/' + CI_POLICY.workflowId)) Object.assign(data, patch) } }), 'CI_WORKFLOW_MISMATCH')
  })
  for (const patch of [{ sha: 'b'.repeat(40) }, { path: 'other.yml' }, { type: 'symlink' }]) await t.test(JSON.stringify(patch), async () => {
    await rejects(provider({ mutate(data, { path }) { if (path.includes('/contents/')) Object.assign(data, patch) } }), 'CI_WORKFLOW_MISMATCH')
  })
})

test('main must match both before and after verification', async () => {
  for (const at of [1, 2]) await rejects(provider({ mutate(data, { path, occurrence }) {
    if (path.endsWith('/git/ref/heads/main') && occurrence === at) data.object.sha = 'b'.repeat(40)
  } }), 'CI_MAIN_CHANGED')
})

test('only the latest trusted push/main run can authorize the source', async t => {
  const wrong = [{ workflow_id: 4 }, { path: '.github/workflows/forged.yml' }, { event: 'pull_request' }, { event: 'schedule' }, { head_branch: 'preview' }, { head_sha: 'b'.repeat(40) }, { check_suite_id: null }, { run_attempt: 0 }, { repository: { ...REPO, id: 1 } }, { head_repository: { ...REPO, owner: { id: 1 } } }]
  for (const patch of wrong) await t.test(JSON.stringify(patch), () => rejects(provider({ runs: [{ ...RUN, ...patch }] }), 'CI_RUN_IDENTITY'))
  await rejects(provider({ runs: [] }), 'CI_RUN_MISSING')
  const newer = { ...RUN, id: 9200, run_number: 13, status: 'in_progress', conclusion: null }
  await rejects(provider({ runs: [RUN, newer], run: newer }), 'CI_PENDING')
  const failed = { ...newer, status: 'completed', conclusion: 'failure' }
  await rejects(provider({ runs: [RUN, failed], run: failed }), 'CI_RUN_NOT_SUCCESSFUL')
})

test('pending, skipped, neutral, cancellation and failures are not successful releases', async t => {
  for (const conclusion of ['skipped', 'neutral', 'failure', 'cancelled', 'timed_out', 'action_required', null]) await t.test(String(conclusion), () => rejects(provider({ run: { ...RUN, conclusion } }), 'CI_RUN_NOT_SUCCESSFUL'))
  for (const status of ['queued', 'waiting', 'in_progress', undefined]) await t.test(String(status), () => rejects(provider({ run: { ...RUN, status } }), 'CI_PENDING'))
})

test('freshness and timestamps are strict, including future and malformed calendar dates', async () => {
  await rejects(provider({ run: { ...RUN, created_at: iso(-CI_FRESHNESS_MS - 1000), run_started_at: iso(-CI_FRESHNESS_MS - 1) } }), 'CI_RUN_STALE')
  await rejects(provider({ run: { ...RUN, updated_at: iso(1) } }), 'CI_RUN_FUTURE')
  await rejects(provider({ run: { ...RUN, created_at: '2026-02-31T00:00:00Z' } }), 'CI_INVALID_TIMESTAMP')
  await rejects(provider({ run: { ...RUN, run_started_at: iso(-1000), updated_at: iso(-2000) } }), 'CI_INVALID_TIMESTAMP')
  const fresh = { ...RUN, created_at: iso(-CI_FRESHNESS_MS - 1000), run_started_at: iso(-CI_FRESHNESS_MS) }
  await verify(provider({ runs: [fresh], run: fresh }))
})

test('a newer attempt or run cannot revive an older successful proof', async () => {
  await rejects(provider({ run: { ...RUN, run_attempt: 2 } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(data, { path, occurrence }) {
    if (path.endsWith('/runs') && occurrence === 2) { data.workflow_runs.push({ ...RUN, id: 9500, run_number: 15, status: 'queued', conclusion: null }); data.total_count++ }
  } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(data, { path, occurrence }) {
    if (path.endsWith('/actions/runs/' + RUN.id) && occurrence === 2) { data.run_attempt++; data.status = 'in_progress'; data.conclusion = null }
  } }), 'CI_EVIDENCE_CHANGED')
  await rejects(provider({ mutate(data, { path, occurrence }) {
    if (path.endsWith('/actions/runs/' + RUN.id) && occurrence === 2) data.updated_at = iso(-20_000)
  } }), 'CI_EVIDENCE_CHANGED')
})

test('all three jobs must be unique, same run/source and terminal success', async t => {
  await rejects(provider({ jobs: jobsFor().filter(job => job.name !== 'security-core') }), 'CI_JOB_MISSING')
  for (const patch of [{ run_id: 1 }, { run_attempt: 2 }, { run_attempt: undefined }, { head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { workflow_name: 'Forged' }, { name: 'display-name-lookalike' }]) await t.test(JSON.stringify(patch), async () => {
    const jobs = jobsFor(); Object.assign(jobs[0], patch); await rejects(provider({ jobs }), 'CI_JOB_IDENTITY')
  })
  const duplicate = jobsFor(); duplicate.push({ ...duplicate[0], id: 9999 }); await rejects(provider({ jobs: duplicate }), 'CI_JOB_IDENTITY')
  const prototypeName = jobsFor(); prototypeName.push({ ...prototypeName[0], id: 9999, name: 'constructor' }); await rejects(provider({ jobs: prototypeName }), 'CI_JOB_IDENTITY')
  const duplicateId = jobsFor(); duplicateId[1].id = duplicateId[0].id; await rejects(provider({ jobs: duplicateId }), 'CI_API_PAGINATION')
  for (const conclusion of ['skipped', 'neutral', 'failure', 'cancelled', null]) await t.test('job ' + conclusion, async () => {
    const jobs = jobsFor(); jobs[0].conclusion = conclusion; await rejects(provider({ jobs }), 'CI_JOB_NOT_SUCCESSFUL')
  })
})

test('a successful-looking job cannot hide a skipped, missing or duplicated essential step', async t => {
  for (const jobIndex of [0, 1, 2]) await t.test('job ' + jobIndex, async () => {
    const missing = jobsFor(); missing[jobIndex].steps.pop(); await rejects(provider({ jobs: missing }), 'CI_STEP_MISSING')
    const skipped = jobsFor(); skipped[jobIndex].steps.at(-1).conclusion = 'skipped'; await rejects(provider({ jobs: skipped }), 'CI_STEP_NOT_SUCCESSFUL')
    const duplicate = jobsFor(); duplicate[jobIndex].steps.push({ ...duplicate[jobIndex].steps[0], number: 30 }); await rejects(provider({ jobs: duplicate }), 'CI_STEP_IDENTITY')
    const failed = jobsFor(); failed[jobIndex].steps.at(-1).conclusion = 'failure'; await rejects(provider({ jobs: failed }), 'CI_STEP_NOT_SUCCESSFUL')
  })
})

test('all provider pages must be present, coherent, unique and remain on the fixed API origin', async () => {
  const jobs = jobsFor()
  const good = provider({ respond({ url, path }) {
    if (!path.endsWith('/jobs')) return
    const second = url.searchParams.get('page') === '2', next = new URL(url); next.searchParams.set('page', '2')
    return response({ total_count: 4, jobs: second ? jobs.slice(2) : jobs.slice(0, 2) }, { headers: { 'content-type': 'application/json', ...(!second ? { link: `<${next}>; rel="next"` } : {}) } })
  } })
  await verify(good)
  await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 5, jobs }) } }), 'CI_API_PAGINATION')
  for (const link of ['<https://attacker.invalid/steal>; rel="next"', 'garbage', '<https://api.github.com/repos/Olegys1/xelay/actions/runs/9100/attempts/1/jobs?per_page=100&page=3>; rel="next"']) {
    await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 5, jobs }, { headers: { 'content-type': 'application/json', link } }) } }), 'CI_API_PAGINATION')
  }
  await rejects(provider({ respond({ path }) { if (path.endsWith('/jobs')) return response({ total_count: 301, jobs }) } }), 'CI_API_PAGINATION')
})

test('HTTP, redirect and malformed/oversized bodies fail without exposing provider content', async () => {
  for (const status of [401, 403, 404, 500]) await rejects(provider({ respond() { return response({ error: 'sensitive should never escape' }, { status }) } }), 'CI_API_UNAVAILABLE')
  await rejects(provider({ respond() { return response({}, { status: 429 }) } }), 'CI_API_RATE_LIMIT')
  await rejects(provider({ respond() { return response({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) } }), 'CI_API_RATE_LIMIT')
  await rejects(provider({ respond() { return response({}, { status: 302, headers: { location: 'https://attacker.invalid' } }) } }), 'CI_API_REDIRECT')
  await rejects(provider({ respond() { const r = response({}); Object.defineProperty(r, 'redirected', { value: true }); return r } }), 'CI_API_REDIRECT')
  await rejects(provider({ respond() { const r = response({}); Object.defineProperty(r, 'url', { value: 'https://attacker.invalid' }); return r } }), 'CI_API_REDIRECT')
  await rejects(provider({ respond() { return new Response('{broken', { headers: { 'content-type': 'application/json' } }) } }), 'CI_API_INVALID_RESPONSE')
  await rejects(provider({ respond() { return new Response('{}', { headers: { 'content-type': 'text/html' } }) } }), 'CI_API_INVALID_RESPONSE')
  await rejects(provider({ respond() { return response({}, { headers: { 'content-type': 'application/json', 'content-length': String(CI_MAX_RESPONSE_BYTES + 1) } }) } }), 'CI_API_OVERSIZE')
  await rejects(provider({ respond() { return response({ data: 'x'.repeat(CI_MAX_RESPONSE_BYTES) }) } }), 'CI_API_OVERSIZE')
  await rejects(provider({ respond() { return new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }) } }), 'CI_API_INVALID_RESPONSE')
})

test('external cancellation is immediate even if a supplied transport ignores its AbortSignal', async () => {
  const controller = new AbortController(), p = provider({ respond() { return new Promise(() => {}) } })
  const pending = verify(p, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.code === 'CI_ABORTED')
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].init.signal.aborted, true)
})

test('a nonresponsive provider is bounded by the request timeout, without retrying or polling CI', async () => {
  const p = provider({ respond() { return new Promise(() => {}) } }), started = Date.now()
  await rejects(p, 'CI_API_TIMEOUT')
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].init.signal.aborted, true)
  assert.ok(Date.now() - started >= CI_REQUEST_TIMEOUT_MS - 50)
  assert.ok(Date.now() - started < CI_REQUEST_TIMEOUT_MS + 3_000)
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
