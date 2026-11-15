// Branch preview proof accepts exact-HEAD automatic push or same-repository PR
// runs. It never treats a legacy PR receipt as generic branch authorization.
import {
  CI_POLICY, CI_FRESHNESS_MS, REQUIRED_CI_JOBS, GithubVerificationError, createGithubReader,
} from './verified-ci.mjs'
import { isValidPreviewBranch } from './verified-preview-ci.mjs'

export const BRANCH_PREVIEW_CI_MAX_REQUESTS = 32
export const BRANCH_PREVIEW_CI_POLICY = Object.freeze({ ...CI_POLICY, authority: 'branch-head-ci', events: Object.freeze(['push', 'pull_request']), maxRequests: BRANCH_PREVIEW_CI_MAX_REQUESTS })
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
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('CI_INVALID_TIMESTAMP')
  const number = Date.parse(value)
  if (!Number.isFinite(number)) fail('CI_INVALID_TIMESTAMP')
  const canonical = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_, digits) => '.' + digits.padEnd(3, '0') + 'Z') : value.replace('Z', '.000Z')
  if (new Date(number).toISOString() !== canonical) fail('CI_INVALID_TIMESTAMP')
  return number
}
function runIdentity(run, context, now, requireFresh = true) {
  if (!object(run) || !positive(run.id) || !positive(run.run_number) || !positive(run.run_attempt)
    || !positive(run.check_suite_id) || run.workflow_id !== CI_POLICY.workflowId || run.path !== CI_POLICY.workflowPath
    || run.name !== CI_POLICY.workflowName || !BRANCH_PREVIEW_CI_POLICY.events.includes(run.event) || run.head_branch !== context.branch
    || run.head_sha !== context.sha || !repositoryIdentity(run.repository) || !repositoryIdentity(run.head_repository)) fail('CI_RUN_IDENTITY')
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
    || current.check_suite_id !== previous.check_suite_id || current.event !== previous.event) fail('CI_EVIDENCE_CHANGED')
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

/** Read-only proof for the latest automatic CI of a current repository branch. */
export async function verifyGithubBranchPreview({ sha, branch, fetchImpl = globalThis.fetch, now = Date.now(), token, signal } = {}) {
  if (typeof sha !== 'string' || !shaPattern.test(sha) || !isValidPreviewBranch(branch)
    || typeof fetchImpl !== 'function' || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000
    || (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,4096}$/.test(token)))) fail('CI_INVALID_INPUT')
  if (signal?.aborted) fail('CI_ABORTED')
  const { get, pages } = createGithubReader({ fetchImpl, token, signal, maxRequests: BRANCH_PREVIEW_CI_MAX_REQUESTS })
  const branchPath = `${rootPath}/git/ref/heads/${branch}`
  async function snapshot(expectedBaseSha) {
    const main = (await get(`${rootPath}/git/ref/heads/main`)).data
    if (main.ref !== 'refs/heads/main' || !object(main.object) || main.object.type !== 'commit' || !shaPattern.test(main.object.sha)) fail('CI_PREVIEW_BASE_IDENTITY')
    const baseSha = main.object.sha
    if (expectedBaseSha !== undefined && expectedBaseSha !== baseSha) fail('CI_PREVIEW_BASE_CHANGED')
    const ref = (await get(branchPath)).data
    if (ref.ref !== `refs/heads/${branch}` || !object(ref.object) || ref.object.type !== 'commit' || ref.object.sha !== sha) fail('CI_PREVIEW_HEAD_CHANGED')
    return baseSha
  }
  // Query both automatic event types without a conclusion filter. A newer
  // pending, failed or cancelled run must block an older successful sibling.
  // The optional exclude_pull_requests parameter is deliberately omitted.
  async function automaticRuns(context) {
    const combined = [], ids = new Set()
    for (const event of BRANCH_PREVIEW_CI_POLICY.events) {
      const entries = await pages(`${workflowPath}/runs`, 'workflow_runs', { branch, event, head_sha: sha })
      for (const run of entries) {
        if (run.event !== event || ids.has(run.id)) fail('CI_RUN_IDENTITY')
        ids.add(run.id); combined.push(run)
      }
    }
    return latestRun(combined, context, now)
  }
  try {
    const repo = (await get(rootPath)).data
    if (!repositoryIdentity(repo) || repo.private !== false || repo.default_branch !== CI_POLICY.branch) fail('CI_REPOSITORY_MISMATCH')
    const workflow = (await get(workflowPath)).data
    if (workflow.id !== CI_POLICY.workflowId || workflow.path !== CI_POLICY.workflowPath || workflow.state !== 'active' || workflow.name !== CI_POLICY.workflowName) fail('CI_WORKFLOW_MISMATCH')
    const file = (await get(`${rootPath}/contents/${CI_POLICY.workflowPath}`, { ref: sha })).data
    if (file.type !== 'file' || file.path !== CI_POLICY.workflowPath || file.sha !== CI_POLICY.workflowBlob) fail('CI_WORKFLOW_MISMATCH')
    const context = Object.freeze({ sha, branch, baseSha: await snapshot() })
    const selected = await automaticRuns(context)
    const comparison = (await get(`${rootPath}/compare/${context.baseSha}...${sha}`, { per_page: 1, page: 1 })).data
    if (!object(comparison.base_commit) || comparison.base_commit.sha !== context.baseSha
      || !object(comparison.merge_base_commit) || comparison.merge_base_commit.sha !== context.baseSha
      || comparison.behind_by !== 0
      || !(comparison.status === 'ahead' && positive(comparison.ahead_by)
        || comparison.status === 'identical' && comparison.ahead_by === 0 && context.baseSha === sha)) fail('CI_PREVIEW_ANCESTRY')
    const run = (await get(`${rootPath}/actions/runs/${selected.id}`)).data
    runIdentity(run, context, now); assertSameRun(selected, run); successfulRun(run)
    const attempt = (await get(`${rootPath}/actions/runs/${run.id}/attempts/${run.run_attempt}`)).data
    runIdentity(attempt, context, now); assertSameRun(run, attempt); successfulRun(attempt)
    const jobIds = jobProof(await pages(`${rootPath}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', {}), attempt, context, now)
    const latest = await automaticRuns(context)
    runIdentity(latest, context, now); assertSameRun(run, latest); successfulRun(latest)
    const rechecked = (await get(`${rootPath}/actions/runs/${run.id}`)).data
    runIdentity(rechecked, context, now); assertSameRun(run, rechecked); successfulRun(rechecked)
    if (rechecked.updated_at !== attempt.updated_at || rechecked.run_started_at !== attempt.run_started_at) fail('CI_EVIDENCE_CHANGED')
    await snapshot(context.baseSha)
    if (signal?.aborted) fail('CI_ABORTED')
    return Object.freeze({
      mode: 'preview', authority: 'branch-head-ci', event: run.event, ...context, runId: run.id, runAttempt: run.run_attempt,
      repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId, ownerId: CI_POLICY.ownerId,
      workflowId: CI_POLICY.workflowId, workflowPath: CI_POLICY.workflowPath, workflowBlob: CI_POLICY.workflowBlob,
      verifiedAt: new Date(now).toISOString(), completedAt: rechecked.updated_at, jobIds,
    })
  } catch (error) {
    if (error instanceof GithubVerificationError) throw error
    fail('CI_API_INVALID_RESPONSE')
  }
}

