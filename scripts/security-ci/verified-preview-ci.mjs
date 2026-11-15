// PR preview proof accepts only exact HEAD checkouts from the pinned workflow.
// The default pull_request merge checkout is deliberately not reusable evidence.
import {
  CI_POLICY, CI_FRESHNESS_MS, REQUIRED_CI_JOBS, GithubVerificationError, createGithubReader,
} from './verified-ci.mjs'

export const PREVIEW_CI_MAX_REQUESTS = 32
export const PREVIEW_CI_POLICY = Object.freeze({ ...CI_POLICY, event: 'pull_request', maxRequests: PREVIEW_CI_MAX_REQUESTS })
const rootPath = `/repos/${CI_POLICY.repository}`
const workflowPath = `${rootPath}/actions/workflows/${CI_POLICY.workflowId}`
const shaPattern = /^[a-f0-9]{40}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const fail = code => { throw new GithubVerificationError(code) }
function repositoryIdentity(value) {
  return object(value) && value.id === CI_POLICY.repositoryId && value.full_name === CI_POLICY.repository
    && object(value.owner) && value.owner.id === CI_POLICY.ownerId
}
export function isValidPreviewBranch(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    && value !== CI_POLICY.branch && !value.includes('..') && !value.includes('//')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
    && !shaPattern.test(value)
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('CI_INVALID_TIMESTAMP')
  const number = Date.parse(value)
  if (!Number.isFinite(number)) fail('CI_INVALID_TIMESTAMP')
  const canonical = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_, digits) => '.' + digits.padEnd(3, '0') + 'Z') : value.replace('Z', '.000Z')
  if (new Date(number).toISOString() !== canonical) fail('CI_INVALID_TIMESTAMP')
  return number
}
function association(run, context) {
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) fail('CI_PREVIEW_RUN_PR_IDENTITY')
  const pull = run.pull_requests[0]
  if (!object(pull) || pull.id !== context.pullRequestId || pull.number !== context.pullRequestNumber
    || !object(pull.head) || pull.head.sha !== context.sha || pull.head.ref !== context.branch
    || !object(pull.head.repo) || pull.head.repo.id !== CI_POLICY.repositoryId
    || !object(pull.base) || pull.base.sha !== context.baseSha || pull.base.ref !== CI_POLICY.branch
    || !object(pull.base.repo) || pull.base.repo.id !== CI_POLICY.repositoryId) fail('CI_PREVIEW_RUN_PR_IDENTITY')
}
function runIdentity(run, context, now, requireFresh = true) {
  if (!object(run) || !positive(run.id) || !positive(run.run_number) || !positive(run.run_attempt)
    || !positive(run.check_suite_id) || run.workflow_id !== CI_POLICY.workflowId || run.path !== CI_POLICY.workflowPath
    || run.name !== CI_POLICY.workflowName || run.event !== 'pull_request' || run.head_branch !== context.branch
    || run.head_sha !== context.sha || !repositoryIdentity(run.repository) || !repositoryIdentity(run.head_repository)) fail('CI_RUN_IDENTITY')
  if (context.pullRequestId !== undefined) association(run, context)
  const created = timestamp(run.created_at), started = timestamp(run.run_started_at), updated = timestamp(run.updated_at)
  if ([created, started, updated].some(value => value > now)) fail('CI_RUN_FUTURE')
  if (created > started || started > updated) fail('CI_INVALID_TIMESTAMP')
  if (requireFresh && now - started > CI_FRESHNESS_MS) fail('CI_RUN_STALE')
  return { started, updated }
}
function successfulRun(run) {
  if (run.status !== 'completed') fail('CI_PENDING')
  if (run.conclusion !== 'success') fail('CI_RUN_NOT_SUCCESSFUL')
}
function latestRun(runs, context, now) {
  if (!runs.length) fail('CI_RUN_MISSING')
  for (const run of runs) runIdentity(run, { sha: context.sha, branch: context.branch }, now, false)
  const latest = [...runs].sort((a, b) => b.run_number - a.run_number || b.id - a.id)[0]
  if (runs.some(run => run.id !== latest.id && run.run_number === latest.run_number)) fail('CI_RUN_IDENTITY')
  runIdentity(latest, context, now)
  return latest
}
function assertSameRun(previous, current) {
  if (current.id !== previous.id || current.run_number !== previous.run_number || current.run_attempt !== previous.run_attempt
    || current.check_suite_id !== previous.check_suite_id) fail('CI_EVIDENCE_CHANGED')
}
function jobProof(jobs, run, context, now) {
  const found = new Map(), ids = new Set(), times = runIdentity(run, context, now)
  for (const job of jobs) {
    if (!object(job) || !positive(job.id) || ids.has(job.id) || typeof job.name !== 'string' || found.has(job.name)
      || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== context.sha || job.head_branch !== context.branch
      || job.workflow_name !== CI_POLICY.workflowName) fail('CI_JOB_IDENTITY')
    ids.add(job.id); found.set(job.name, job)
    if (!Object.hasOwn(REQUIRED_CI_JOBS, job.name) && job.name !== 'security-full') fail('CI_JOB_IDENTITY')
  }
  const jobIds = {}
  for (const [name, essential] of Object.entries(REQUIRED_CI_JOBS)) {
    const job = found.get(name)
    if (!job) fail('CI_JOB_MISSING')
    if (job.status !== 'completed' || job.conclusion !== 'success') fail('CI_JOB_NOT_SUCCESSFUL')
    const started = timestamp(job.started_at), completed = timestamp(job.completed_at)
    if (started > now || completed > now) fail('CI_RUN_FUTURE')
    if (started < times.started || completed < started || completed > times.updated) fail('CI_INVALID_TIMESTAMP')
    if (!Array.isArray(job.steps) || !job.steps.length || job.steps.length > 50) fail('CI_STEP_MISSING')
    const steps = new Map(), numbers = new Set()
    for (const step of job.steps) {
      if (!object(step) || typeof step.name !== 'string' || steps.has(step.name) || !positive(step.number) || numbers.has(step.number)) fail('CI_STEP_IDENTITY')
      steps.set(step.name, step); numbers.add(step.number)
      if (step.status !== 'completed' || !['success', 'skipped'].includes(step.conclusion)) fail('CI_STEP_NOT_SUCCESSFUL')
    }
    for (const required of essential) {
      const step = steps.get(required)
      if (!step) fail('CI_STEP_MISSING')
      if (step.status !== 'completed' || step.conclusion !== 'success') fail('CI_STEP_NOT_SUCCESSFUL')
    }
    jobIds[name] = job.id
  }
  const full = found.get('security-full')
  if (full && (full.status !== 'completed' || full.conclusion !== 'skipped')) fail('CI_JOB_IDENTITY')
  return Object.freeze(jobIds)
}

/** Read-only proof for one current same-repository PR HEAD; never polls or deploys. */
export async function verifyGithubPreview({ sha, branch, pullRequestNumber, fetchImpl = globalThis.fetch, now = Date.now(), token, signal } = {}) {
  if (typeof sha !== 'string' || !shaPattern.test(sha) || !isValidPreviewBranch(branch) || pullRequestNumber !== undefined && !positive(pullRequestNumber)
    || typeof fetchImpl !== 'function' || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000
    || (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,4096}$/.test(token)))) fail('CI_INVALID_INPUT')
  if (signal?.aborted) fail('CI_ABORTED')
  const { get, pages } = createGithubReader({ fetchImpl, token, signal, maxRequests: PREVIEW_CI_MAX_REQUESTS })
  const branchPath = `${rootPath}/git/ref/heads/${branch}`
  async function snapshot(expected) {
    const main = (await get(`${rootPath}/git/ref/heads/main`)).data
    if (main.ref !== 'refs/heads/main' || !object(main.object) || main.object.type !== 'commit' || !shaPattern.test(main.object.sha)) fail('CI_PREVIEW_BASE_IDENTITY')
    const baseSha = main.object.sha
    if (expected.baseSha !== baseSha) fail('CI_PREVIEW_BASE_CHANGED')
    const ref = (await get(branchPath)).data
    if (ref.ref !== `refs/heads/${branch}` || !object(ref.object) || ref.object.type !== 'commit' || ref.object.sha !== sha) fail('CI_PREVIEW_HEAD_CHANGED')
    const pull = (await get(`${rootPath}/pulls/${expected.pullRequestNumber}`)).data
    if (!positive(pull.id) || pull.number !== expected.pullRequestNumber || pull.state !== 'open' || pull.merged !== false
      || !object(pull.head) || pull.head.sha !== sha || pull.head.ref !== branch || !repositoryIdentity(pull.head.repo)
      || !object(pull.base) || pull.base.ref !== CI_POLICY.branch || !repositoryIdentity(pull.base.repo)) fail('CI_PREVIEW_PR_IDENTITY')
    if (pull.base.sha !== baseSha) fail('CI_PREVIEW_BASE_CHANGED')
    if (pull.id !== expected.pullRequestId) fail('CI_PREVIEW_PR_IDENTITY')
    return expected
  }
  try {
    const repo = (await get(rootPath)).data
    if (!repositoryIdentity(repo) || repo.private !== false || repo.default_branch !== CI_POLICY.branch) fail('CI_REPOSITORY_MISMATCH')
    const workflow = (await get(workflowPath)).data
    if (workflow.id !== CI_POLICY.workflowId || workflow.path !== CI_POLICY.workflowPath || workflow.state !== 'active' || workflow.name !== CI_POLICY.workflowName) fail('CI_WORKFLOW_MISMATCH')
    const file = (await get(`${rootPath}/contents/${CI_POLICY.workflowPath}`, { ref: sha })).data
    if (file.type !== 'file' || file.path !== CI_POLICY.workflowPath || file.sha !== CI_POLICY.workflowBlob) fail('CI_WORKFLOW_MISMATCH')
    const parameters = { branch, event: 'pull_request', head_sha: sha, exclude_pull_requests: 'false' }
    const initialRuns = await pages(`${workflowPath}/runs`, 'workflow_runs', parameters)
    const selected = latestRun(initialRuns, { sha, branch }, now)
    // A deploy hook may omit PR metadata. Derive the number only from this
    // exact latest run, never from an arbitrary PR search or an older success.
    if (!Array.isArray(selected.pull_requests) || selected.pull_requests.length !== 1) fail('CI_PREVIEW_RUN_PR_IDENTITY')
    const linked = selected.pull_requests[0]
    if (!object(linked) || !positive(linked.id) || !positive(linked.number)
      || pullRequestNumber !== undefined && linked.number !== pullRequestNumber
      || !object(linked.base) || !shaPattern.test(linked.base.sha)) fail('CI_PREVIEW_RUN_PR_IDENTITY')
    const context = Object.freeze({ sha, branch, pullRequestNumber: linked.number, pullRequestId: linked.id, baseSha: linked.base.sha })
    runIdentity(selected, context, now)
    await snapshot(context)
    const comparison = (await get(`${rootPath}/compare/${context.baseSha}...${sha}`, { per_page: 1, page: 1 })).data
    if (!object(comparison.base_commit) || comparison.base_commit.sha !== context.baseSha
      || !object(comparison.merge_base_commit) || comparison.merge_base_commit.sha !== context.baseSha
      || comparison.behind_by !== 0
      || !(comparison.status === 'ahead' && positive(comparison.ahead_by)
        || comparison.status === 'identical' && comparison.ahead_by === 0 && context.baseSha === sha)) fail('CI_PREVIEW_ANCESTRY')
    const selectedRun = async () => latestRun(await pages(`${workflowPath}/runs`, 'workflow_runs', parameters), context, now)
    const run = (await get(`${rootPath}/actions/runs/${selected.id}`)).data
    runIdentity(run, context, now); assertSameRun(selected, run); successfulRun(run)
    const attempt = (await get(`${rootPath}/actions/runs/${run.id}/attempts/${run.run_attempt}`)).data
    runIdentity(attempt, context, now); assertSameRun(run, attempt); successfulRun(attempt)
    const jobIds = jobProof(await pages(`${rootPath}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', {}), attempt, context, now)
    const latest = await selectedRun()
    runIdentity(latest, context, now); assertSameRun(run, latest); successfulRun(latest)
    const rechecked = (await get(`${rootPath}/actions/runs/${run.id}`)).data
    runIdentity(rechecked, context, now); assertSameRun(run, rechecked); successfulRun(rechecked)
    if (rechecked.updated_at !== attempt.updated_at || rechecked.run_started_at !== attempt.run_started_at) fail('CI_EVIDENCE_CHANGED')
    await snapshot(context)
    if (signal?.aborted) fail('CI_ABORTED')
    return Object.freeze({
      mode: 'preview', ...context, runId: run.id, runAttempt: run.run_attempt,
      repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId, ownerId: CI_POLICY.ownerId,
      workflowId: CI_POLICY.workflowId, workflowPath: CI_POLICY.workflowPath, workflowBlob: CI_POLICY.workflowBlob,
      verifiedAt: new Date(now).toISOString(), completedAt: rechecked.updated_at, jobIds,
    })
  } catch (error) {
    if (error instanceof GithubVerificationError) throw error
    fail('CI_API_INVALID_RESPONSE')
  }
}
