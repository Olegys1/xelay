import { lstat, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { safeEnvironment } from './policy.mjs'
import { verifyGithubCommit, GithubVerificationError, CI_FRESHNESS_MS, CI_POLICY } from './verified-ci.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SHA = /^[0-9a-f]{40}$/
const MAX_EVENT_BYTES = 262144
const MAX_RESPONSE_BYTES = 16384
const MAX_CLOCK_SKEW_MS = 60000
export const PUBLISHER_REQUEST_TIMEOUT_MS = 5000
export const PUBLISHER_HOOK_TIMEOUT_MS = 15000
export const PUBLISHER_POLICY = Object.freeze({
  repository: 'Olegys1/xelay', repositoryId: 1258728015, ownerId: 290528340,
  workflowId: 399954171, workflowName: 'Security checks', branch: 'main',
  vercelProjectId: CI_POLICY.projectId,
})

export class VerifiedDeploymentError extends Error {
  constructor(code) { super('Verified deployment request refused: ' + code); this.name = 'VerifiedDeploymentError'; this.code = code }
}
const refuse = code => { throw new VerifiedDeploymentError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = value => Number.isSafeInteger(value) && value > 0
const repositoryMatches = value => object(value) && value.id === PUBLISHER_POLICY.repositoryId
  && value.full_name === PUBLISHER_POLICY.repository && value.owner?.id === PUBLISHER_POLICY.ownerId
  && value.fork === false

export function validateWorkflowRunEvent(env, event, now = Date.now()) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run'
    || env.GITHUB_REPOSITORY !== PUBLISHER_POLICY.repository || env.GITHUB_REPOSITORY_ID !== String(PUBLISHER_POLICY.repositoryId)
    || env.GITHUB_REPOSITORY_OWNER_ID !== String(PUBLISHER_POLICY.ownerId) || env.GITHUB_REF !== 'refs/heads/main') refuse('UNTRUSTED_WORKFLOW_CONTEXT')
  const run = event?.workflow_run
  if (!object(event) || event.action !== 'completed' || !repositoryMatches(event.repository) || !object(run)
    || run.workflow_id !== PUBLISHER_POLICY.workflowId || run.name !== PUBLISHER_POLICY.workflowName
    || run.event !== 'push' || run.head_branch !== PUBLISHER_POLICY.branch || !repositoryMatches(run.head_repository)
    || run.status !== 'completed' || run.conclusion !== 'success' || !positiveId(run.id) || !positiveId(run.run_attempt)
    || typeof run.head_sha !== 'string' || !SHA.test(run.head_sha) || run.head_commit?.id !== run.head_sha) refuse('UNTRUSTED_WORKFLOW_EVENT')
  const updated = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : NaN
  if (!Number.isFinite(now) || !Number.isFinite(updated) || updated > now + MAX_CLOCK_SKEW_MS || now - updated > CI_FRESHNESS_MS) refuse('STALE_WORKFLOW_EVENT')
  return Object.freeze({ sha: run.head_sha, runId: run.id, runAttempt: run.run_attempt })
}

export function validateDeployHook(value, projectId = PUBLISHER_POLICY.vercelProjectId) {
  if (typeof projectId !== 'string' || !/^prj_[A-Za-z0-9]{8,80}$/.test(projectId)) refuse('PROJECT_PIN_NOT_CONFIGURED')
  if (typeof value !== 'string' || !value || value.length > 1024 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) refuse('INVALID_DEPLOY_HOOK')
  let url
  try { url = new URL(value) } catch { refuse('INVALID_DEPLOY_HOOK') }
  if (url.origin !== 'https://api.vercel.com' || url.username || url.password || url.port || url.search || url.hash
    || !new RegExp('^/v1/integrations/deploy/' + projectId + '/[A-Za-z0-9_-]{10,160}$').test(url.pathname)) refuse('INVALID_DEPLOY_HOOK')
  return url
}

export function readCheckoutSha() {
  const options = { cwd: ROOT, env: safeEnvironment(tmpdir()), shell: false, encoding: 'utf8',
    windowsHide: true, timeout: 5000, maxBuffer: 16384 }
  const prefix = ['-c', 'safe.directory=' + resolve(ROOT).replaceAll('\\', '/')]
  const head = spawnSync('git', [...prefix, 'rev-parse', 'HEAD'], options)
  if (head.status !== 0 || head.error || !SHA.test(head.stdout?.trim() || '')) refuse('CHECKOUT_IDENTITY_UNAVAILABLE')
  const clean = spawnSync('git', [...prefix, 'status', '--porcelain', '--untracked-files=normal'], options)
  if (clean.status !== 0 || clean.error || clean.stdout.trim()) refuse('CHECKOUT_NOT_CLEAN')
  return head.stdout.trim()
}

async function providerJson(url, init, fetchImpl, failureCode, statuses, timeoutMs = PUBLISHER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  let timer, response, reader
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new VerifiedDeploymentError(failureCode)) }, timeoutMs)
    })
    const operation = (async () => {
      response = await fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || !response || response.redirected || (response.url && response.url !== url)
        || !statuses.includes(response.status)) refuse(failureCode)
      const contentType = response.headers?.get('content-type') || ''
      const length = response.headers?.get('content-length')
      if (!/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
        || length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
        || !response.body?.getReader) refuse('INVALID_PROVIDER_RESPONSE')
      reader = response.body.getReader()
      let bytes = 0
      const chunks = []
      for (;;) {
        const { value, done } = await reader.read()
        if (controller.signal.aborted) refuse(failureCode)
        if (done) break
        if (!(value instanceof Uint8Array)) refuse('INVALID_PROVIDER_RESPONSE')
        bytes += value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) refuse('INVALID_PROVIDER_RESPONSE')
        chunks.push(Buffer.from(value))
      }
      let data
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
      catch { refuse('INVALID_PROVIDER_RESPONSE') }
      if (!object(data)) refuse('INVALID_PROVIDER_RESPONSE')
      return data
    })()
    return await Promise.race([operation, timeout])
  } catch (error) {
    if (error instanceof VerifiedDeploymentError) throw error
    refuse(failureCode)
  } finally {
    clearTimeout(timer)
    controller.abort()
    try {
      if (typeof reader?.cancel === 'function') void Promise.resolve(reader.cancel()).catch(() => {})
      else if (typeof response?.body?.cancel === 'function') void Promise.resolve(response.body.cancel()).catch(() => {})
    } catch { /* cleanup cannot expose or replace a sanitized provider failure */ }
  }
}

async function checkCurrentMain(sha, fetchImpl, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) headers.Authorization = 'Bearer ' + token
  const ref = await providerJson('https://api.github.com/repos/Olegys1/xelay/git/ref/heads/main',
    { method: 'GET', headers }, fetchImpl, 'MAIN_RECHECK_UNAVAILABLE', [200])
  if (ref.ref !== 'refs/heads/main' || ref.object?.type !== 'commit' || ref.object?.sha !== sha) refuse('MAIN_MOVED')
}

export async function requestVerifiedDeployment({ env = process.env, event, now = Date.now(), fetchImpl = globalThis.fetch,
  verifyCommit = verifyGithubCommit, checkoutSha = readCheckoutSha, projectId = PUBLISHER_POLICY.vercelProjectId } = {}) {
  const expected = validateWorkflowRunEvent(env, event, now)
  if (checkoutSha() !== expected.sha) refuse('CHECKOUT_SHA_MISMATCH')
  if (!env.XELAY_VERIFIED_DEPLOY_HOOK) return Object.freeze({ state: 'configuration_pending', deploymentRequested: false, reason: 'deployment_hook_not_configured' })
  if (!projectId) return Object.freeze({ state: 'configuration_pending', deploymentRequested: false, reason: 'project_pin_not_configured' })
  const hook = validateDeployHook(env.XELAY_VERIFIED_DEPLOY_HOOK, projectId)
  let receipt
  try { receipt = await verifyCommit({ sha: expected.sha, fetchImpl, now, token: env.GITHUB_TOKEN || undefined }) }
  catch (error) { if (error instanceof GithubVerificationError) throw error; refuse('CI_PROOF_UNAVAILABLE') }
  if (!object(receipt) || receipt.sha !== expected.sha || receipt.runId !== expected.runId || receipt.runAttempt !== expected.runAttempt) refuse('EVENT_PROOF_MISMATCH')
  // A hook tracks a branch, not a supplied SHA. Reject a stale completed event
  // immediately before POST; the build gate independently rechecks its real SHA.
  await checkCurrentMain(expected.sha, fetchImpl, env.GITHUB_TOKEN)
  const unknownOutcome = code => Object.freeze({ state: 'request_outcome_unknown', deploymentRequested: null, requestAttempted: true,
    code, sha: expected.sha, runId: expected.runId, runAttempt: expected.runAttempt })
  let accepted
  try { accepted = await providerJson(hook.href, { method: 'POST' }, fetchImpl, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE', [200, 201, 202], PUBLISHER_HOOK_TIMEOUT_MS) }
  catch (error) {
    // Once POST was attempted, a missing receipt cannot establish that Vercel
    // did not queue it. An operator must inspect deployments before any retry.
    return unknownOutcome(error instanceof VerifiedDeploymentError ? error.code : 'DEPLOY_HOOK_REQUEST_UNAVAILABLE')
  }
  if (!object(accepted.job) || typeof accepted.job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accepted.job.id)
    || !['PENDING', 'QUEUED', 'RUNNING'].includes(accepted.job.state)) return unknownOutcome('DEPLOY_HOOK_RECEIPT_UNAVAILABLE')
  // This is only a build request. Never claim the new version is already live.
  return Object.freeze({ state: 'requested', deploymentRequested: true, sha: expected.sha, runId: expected.runId, runAttempt: expected.runAttempt })
}

export async function runVerifiedDeploymentCli({ env = process.env, statEvent = lstat, readEvent = readFile,
  requestDeployment = requestVerifiedDeployment, stdout = line => console.log(line), stderr = line => console.error(line) } = {}) {
  try {
    // Refuse a direct/local invocation before reading an arbitrary event path.
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run') refuse('UNTRUSTED_WORKFLOW_CONTEXT')
    const path = env.GITHUB_EVENT_PATH
    if (typeof path !== 'string' || !path || path.length > 4096) refuse('WORKFLOW_EVENT_UNAVAILABLE')
    let event
    try {
      const info = await statEvent(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVENT_BYTES) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      event = JSON.parse(await readEvent(path, 'utf8'))
    } catch { refuse('WORKFLOW_EVENT_UNAVAILABLE') }
    const outcome = await requestDeployment({ env, event })
    stdout(JSON.stringify(outcome))
    return outcome.state === 'request_outcome_unknown' ? 1 : 0
  } catch (error) {
    const code = error instanceof VerifiedDeploymentError || error instanceof GithubVerificationError ? error.code : 'DEPLOYMENT_REQUEST_UNAVAILABLE'
    stderr(JSON.stringify({ state: 'refused', deploymentRequested: false, code }))
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runVerifiedDeploymentCli()
}
