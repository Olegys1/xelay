// A read-only provider proof. Local files, environment flags and check names
// alone are never evidence that the mandatory workflow actually succeeded.
export const CI_FRESHNESS_MS = 6 * 60 * 60_000
export const CI_REQUEST_TIMEOUT_MS = 4_000
export const CI_TOTAL_TIMEOUT_MS = 25_000
export const CI_MAX_RESPONSE_BYTES = 512 * 1024
export const CI_MAX_REQUESTS = 18
export const CI_MAX_PAGES = 3
const PAGE_SIZE = 100
const API_ORIGIN = 'https://api.github.com'
const CHECKOUT = 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const NODE = 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
export const EXACT_CHECKOUT_STEP = 'Verify exact checkout and integration with current main'

export const REQUIRED_CI_JOBS = Object.freeze({
  'security-core': Object.freeze([CHECKOUT, EXACT_CHECKOUT_STEP, NODE, 'Install the locked dependencies without lifecycle scripts', 'Run the curated offline suite sequentially']),
  'security-dependencies': Object.freeze([CHECKOUT, EXACT_CHECKOUT_STEP, NODE, 'Reject high or critical known dependency advisories']),
  'security-secrets': Object.freeze([CHECKOUT, EXACT_CHECKOUT_STEP, NODE, 'Fetch the official pinned Gitleaks CLI and verify before extraction', 'Scan selected working files and all fetched history, with values withheld']),
})
export const CI_POLICY = Object.freeze({
  repository: 'Olegys1/xelay', repositoryId: 1258728015, ownerId: 290528340,
  projectId: 'prj_Yl9R5uI2IdwyeNaIhbfIlObMO5bq',
  branch: 'main', workflowId: 399954171, workflowName: 'Security checks',
  workflowPath: '.github/workflows/security-checks.yml',
  workflowBlob: '82f4536c4d5415a84f2d2c75843ea55d9bc124b6',
  freshnessMs: CI_FRESHNESS_MS,
  requiredJobs: REQUIRED_CI_JOBS,
})

export class GithubVerificationError extends Error {
  constructor(code) {
    super(`GitHub release proof rejected (${code}).`)
    this.name = 'GithubVerificationError'
    this.code = code
  }
}
const fail = code => { throw new GithubVerificationError(code) }
const positive = value => Number.isSafeInteger(value) && value > 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const rootPath = `/repos/${CI_POLICY.repository}`
const workflowPath = `${rootPath}/actions/workflows/${CI_POLICY.workflowId}`
const shaPattern = /^[a-f0-9]{40}$/

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('CI_INVALID_TIMESTAMP')
  const number = Date.parse(value)
  if (!Number.isFinite(number)) fail('CI_INVALID_TIMESTAMP')
  const canonical = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_, digits) => '.' + digits.padEnd(3, '0') + 'Z') : value.replace('Z', '.000Z')
  if (new Date(number).toISOString() !== canonical) fail('CI_INVALID_TIMESTAMP')
  return number
}

function repositoryIdentity(value) {
  return object(value) && value.id === CI_POLICY.repositoryId && value.full_name === CI_POLICY.repository
    && object(value.owner) && value.owner.id === CI_POLICY.ownerId
}

function runIdentity(run, sha, now, requireFresh = true) {
  if (!object(run) || !positive(run.id) || !positive(run.run_number) || !positive(run.run_attempt)
    || !positive(run.check_suite_id)
    || run.workflow_id !== CI_POLICY.workflowId || run.path !== CI_POLICY.workflowPath
    || run.name !== CI_POLICY.workflowName || run.event !== 'push' || run.head_branch !== CI_POLICY.branch
    || run.head_sha !== sha || !repositoryIdentity(run.repository) || !repositoryIdentity(run.head_repository)) fail('CI_RUN_IDENTITY')
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

function latestRun(runs, sha, now) {
  if (!runs.length) fail('CI_RUN_MISSING')
  // Do not select an older successful run by filtering on its conclusion.
  for (const run of runs) runIdentity(run, sha, now, false)
  const latest = [...runs].sort((a, b) => b.run_number - a.run_number || b.id - a.id)[0]
  if (runs.some(run => run.id !== latest.id && run.run_number === latest.run_number)) fail('CI_RUN_IDENTITY')
  runIdentity(latest, sha, now)
  return latest
}

function assertSameRun(previous, current) {
  if (current.id !== previous.id || current.run_number !== previous.run_number || current.run_attempt !== previous.run_attempt
    || current.check_suite_id !== previous.check_suite_id) fail('CI_EVIDENCE_CHANGED')
}

function jobProof(jobs, run, sha, now) {
  const found = new Map(), ids = new Set()
  const times = runIdentity(run, sha, now)
  for (const job of jobs) {
    if (!object(job) || !positive(job.id) || ids.has(job.id) || typeof job.name !== 'string' || found.has(job.name)
      || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== sha || job.head_branch !== CI_POLICY.branch
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
  // This optional manual-only job must not run in an accepted push workflow.
  const full = found.get('security-full')
  if (full && (full.status !== 'completed' || full.conclusion !== 'skipped')) fail('CI_JOB_IDENTITY')
  return Object.freeze(jobIds)
}

function nextPageLink(header, requested, expectedPage) {
  if (!header) return false
  if (typeof header !== 'string' || header.length > 8_192) fail('CI_API_PAGINATION')
  let next = false
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part)
    if (!match) fail('CI_API_PAGINATION')
    let url
    try { url = new URL(match[1]) } catch { fail('CI_API_PAGINATION') }
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash || url.pathname !== requested.pathname) fail('CI_API_PAGINATION')
    const original = new URLSearchParams(requested.searchParams); original.delete('page')
    const linked = new URLSearchParams(url.searchParams); linked.delete('page')
    if ([...original].some(([key, value]) => linked.getAll(key).length !== 1 || linked.get(key) !== value)
      || [...linked.keys()].some(key => !original.has(key))) fail('CI_API_PAGINATION')
    const page = url.searchParams.getAll('page')
    if (page.length !== 1 || !/^[1-9]\d*$/.test(page[0])) fail('CI_API_PAGINATION')
    if (match[2] === 'next') {
      if (next || Number(page[0]) !== expectedPage) fail('CI_API_PAGINATION')
      next = true
    }
  }
  return next
}

// Shared fixed-origin bounded read transport; this never authorizes a deployment.
export function createGithubReader({ fetchImpl = globalThis.fetch, token, signal, maxRequests = CI_MAX_REQUESTS } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 32
    || (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,4096}$/.test(token)))) fail('CI_INVALID_INPUT')
  if (signal?.aborted) fail('CI_ABORTED')
  const startedWall = Date.now()
  let requestCount = 0
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'xelay-verified-release' }
  if (token) headers.Authorization = `Bearer ${token}`

  async function get(path, parameters = {}) {
    if (++requestCount > maxRequests) fail('CI_API_REQUEST_LIMIT')
    const remaining = CI_TOTAL_TIMEOUT_MS - (Date.now() - startedWall)
    if (remaining <= 0) fail('CI_API_TIMEOUT')
    if (signal?.aborted) fail('CI_ABORTED')
    const url = new URL(path, API_ORIGIN)
    if (url.origin !== API_ORIGIN || !(path === rootPath || path.startsWith(rootPath + '/'))) fail('CI_API_ORIGIN')
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    const controller = new AbortController()
    let timer, reader, rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = reject })
    const externalAbort = () => { controller.abort(); rejectAbort(new GithubVerificationError('CI_ABORTED')) }
    signal?.addEventListener('abort', externalAbort, { once: true })
    if (signal?.aborted) externalAbort()
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new GithubVerificationError('CI_API_TIMEOUT')) }, Math.min(remaining, CI_REQUEST_TIMEOUT_MS))
      })
      const transport = (async () => {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', cache: 'no-store', headers: { ...headers }, signal: controller.signal })
        if (signal?.aborted) fail('CI_ABORTED')
        if (controller.signal.aborted) fail('CI_API_TIMEOUT')
        if (!response || response.redirected || (response.url && response.url !== url.href) || response.status >= 300 && response.status < 400) fail('CI_API_REDIRECT')
        if (response.status !== 200) fail(response.status === 429 || response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0' ? 'CI_API_RATE_LIMIT' : 'CI_API_UNAVAILABLE')
        const contentType = response.headers?.get('content-type') || ''
        if (!/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) fail('CI_API_INVALID_RESPONSE')
        const length = response.headers?.get('content-length')
        if (length && (!/^\d+$/.test(length) || Number(length) > CI_MAX_RESPONSE_BYTES)) fail('CI_API_OVERSIZE')
        if (!response.body?.getReader) fail('CI_API_INVALID_RESPONSE')
        reader = response.body.getReader()
        let bytes = 0
        const chunks = []
        for (;;) {
          const chunk = await reader.read()
          if (signal?.aborted) fail('CI_ABORTED')
          if (controller.signal.aborted) fail('CI_API_TIMEOUT')
          if (chunk.done) break
          if (!(chunk.value instanceof Uint8Array)) fail('CI_API_INVALID_RESPONSE')
          bytes += chunk.value.byteLength
          if (bytes > CI_MAX_RESPONSE_BYTES) fail('CI_API_OVERSIZE')
          chunks.push(chunk.value)
        }
        const data = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
        let parsed
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) } catch { fail('CI_API_INVALID_RESPONSE') }
        if (!object(parsed)) fail('CI_API_INVALID_RESPONSE')
        return { data: parsed, link: response.headers.get('link'), url }
      })()
      return await Promise.race([transport, timeout, aborted])
    } catch (error) {
      if (signal?.aborted) fail('CI_ABORTED')
      if (error instanceof GithubVerificationError) throw error
      fail('CI_API_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', externalAbort)
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
    }
  }

  async function pages(path, field, parameters) {
    const result = [], seen = new Set()
    let total
    for (let page = 1; page <= CI_MAX_PAGES; page++) {
      const response = await get(path, { ...parameters, per_page: PAGE_SIZE, page })
      const body = response.data, entries = body[field]
      if (!Number.isSafeInteger(body.total_count) || body.total_count < 0 || body.total_count > PAGE_SIZE * CI_MAX_PAGES
        || !Array.isArray(entries) || entries.length > PAGE_SIZE || (total !== undefined && body.total_count !== total)) fail('CI_API_PAGINATION')
      total = body.total_count
      for (const entry of entries) {
        if (!object(entry) || !positive(entry.id) || seen.has(entry.id)) fail('CI_API_PAGINATION')
        seen.add(entry.id); result.push(entry)
      }
      const next = nextPageLink(response.link, response.url, page + 1)
      if (result.length > total) fail('CI_API_PAGINATION')
      if (result.length === total) { if (next) fail('CI_API_PAGINATION'); return result }
      if (!entries.length || !next) fail('CI_API_PAGINATION')
    }
    fail('CI_API_PAGINATION')
  }

  return Object.freeze({ get, pages })
}

/** Verify fresh mandatory CI for one exact public main commit; never polls CI. */
export async function verifyGithubCommit({ sha, fetchImpl = globalThis.fetch, now = Date.now(), token, signal } = {}) {
  if (typeof sha !== 'string' || !shaPattern.test(sha) || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000
    || (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,4096}$/.test(token)))) fail('CI_INVALID_INPUT')
  if (signal?.aborted) fail('CI_ABORTED')
  const { get, pages } = createGithubReader({ fetchImpl, token, signal })

  async function main() {
    const result = (await get(`${rootPath}/git/ref/heads/main`)).data
    if (result.ref !== 'refs/heads/main' || !object(result.object) || result.object.type !== 'commit' || result.object.sha !== sha) fail('CI_MAIN_CHANGED')
  }
  const runParameters = { branch: CI_POLICY.branch, event: 'push', head_sha: sha, exclude_pull_requests: 'true' }
  async function selectedRun() { return latestRun(await pages(`${workflowPath}/runs`, 'workflow_runs', runParameters), sha, now) }

  try {
    const repo = (await get(rootPath)).data
    if (!repositoryIdentity(repo) || repo.private !== false || repo.default_branch !== CI_POLICY.branch) fail('CI_REPOSITORY_MISMATCH')
    await main()
    const workflow = (await get(workflowPath)).data
    if (workflow.id !== CI_POLICY.workflowId || workflow.path !== CI_POLICY.workflowPath || workflow.state !== 'active' || workflow.name !== CI_POLICY.workflowName) fail('CI_WORKFLOW_MISMATCH')
    const file = (await get(`${rootPath}/contents/${CI_POLICY.workflowPath}`, { ref: sha })).data
    if (file.type !== 'file' || file.path !== CI_POLICY.workflowPath || file.sha !== CI_POLICY.workflowBlob) fail('CI_WORKFLOW_MISMATCH')
    const selected = await selectedRun()
    const run = (await get(`${rootPath}/actions/runs/${selected.id}`)).data
    runIdentity(run, sha, now); assertSameRun(selected, run); successfulRun(run)
    const attempt = (await get(`${rootPath}/actions/runs/${run.id}/attempts/${run.run_attempt}`)).data
    runIdentity(attempt, sha, now); assertSameRun(run, attempt); successfulRun(attempt)
    const jobs = await pages(`${rootPath}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', {})
    const jobIds = jobProof(jobs, attempt, sha, now)
    const latest = await selectedRun()
    runIdentity(latest, sha, now); assertSameRun(run, latest); successfulRun(latest)
    const rechecked = (await get(`${rootPath}/actions/runs/${run.id}`)).data
    runIdentity(rechecked, sha, now); assertSameRun(run, rechecked); successfulRun(rechecked)
    if (rechecked.updated_at !== attempt.updated_at || rechecked.run_started_at !== attempt.run_started_at) fail('CI_EVIDENCE_CHANGED')
    await main()
    if (signal?.aborted) fail('CI_ABORTED')
    return Object.freeze({
      mode: 'production', sha, runId: run.id, runAttempt: run.run_attempt,
      repository: CI_POLICY.repository, repositoryId: CI_POLICY.repositoryId, ownerId: CI_POLICY.ownerId,
      workflowId: CI_POLICY.workflowId, workflowPath: CI_POLICY.workflowPath, workflowBlob: CI_POLICY.workflowBlob,
      verifiedAt: new Date(now).toISOString(), completedAt: rechecked.updated_at, jobIds,
    })
  } catch (error) {
    if (error instanceof GithubVerificationError) throw error
    fail('CI_API_INVALID_RESPONSE')
  }
}
