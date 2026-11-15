// Privileged orchestration is loaded from immutable current main, never a branch.
// The Vercel credential is project-scoped and is used only by the final poster.
import { appendFile, lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_FRESHNESS_MS, CI_POLICY } from './verified-ci.mjs'
import { isValidPreviewBranch } from './verified-preview-ci.mjs'
import { verifyGithubBranchPreview } from './verified-branch-preview-ci.mjs'
import { readCheckoutSha } from './request-verified-deployment.mjs'

const SHA = /^[a-f0-9]{40}$/
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{1,100}$/
const GH_ROOT = 'https://api.github.com/repos/Olegys1/xelay'
const VERCEL_ROOT = 'https://api.vercel.com'
export const BRANCH_REQUEST_TIMEOUT_MS = 5000
export const BRANCH_POST_TIMEOUT_MS = 15000
export const BRANCH_PUBLISHER_TIMEOUT_MS = 90000
export const BRANCH_DEPLOYMENT_MAX_PAGES = 3
const PAGE_SIZE = 100, MAX_EVENT_BYTES = 262144
const ACTIVE = new Set(['QUEUED', 'INITIALIZING', 'BUILDING', 'READY'])
const FAILED = new Set(['ERROR', 'CANCELED', 'BLOCKED'])
const CODES = new Set(['UNTRUSTED_WORKFLOW_CONTEXT', 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW', 'UNTRUSTED_WORKFLOW_EVENT',
  'STALE_WORKFLOW_EVENT', 'TRUSTED_CHECKOUT_MISMATCH', 'PREVIEW_CI_PROOF_UNAVAILABLE', 'EVENT_PROOF_MISMATCH',
  'PRODUCTION_SECRET_CONTEXT', 'RESOLVER_SECRET_CONTEXT', 'LEGACY_SECRET_CONTEXT', 'INVALID_PROJECT_TOKEN',
  'PREVIEW_RECHECK_UNAVAILABLE', 'PREVIEW_HEAD_OR_BASE_MOVED', 'DEPLOYMENT_HISTORY_UNAVAILABLE',
  'DEPLOYMENT_RETRY_REQUIRES_FRESH_CI', 'DEPLOYMENT_REQUEST_UNAVAILABLE', 'INVALID_PROVIDER_RESPONSE',
  'DEPLOYMENT_RECEIPT_UNAVAILABLE', 'WORKFLOW_EVENT_UNAVAILABLE', 'OUTPUT_UNAVAILABLE', 'INVALID_PHASE', 'PUBLISHER_DEADLINE'])

export class VerifiedBranchDeploymentError extends Error {
  constructor(code) { super('Verified branch deployment request refused.'); this.name = 'VerifiedBranchDeploymentError'; this.code = code }
}
const refuse = code => { throw new VerifiedBranchDeploymentError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value
const repositoryMatches = value => object(value) && value.id === CI_POLICY.repositoryId && value.owner?.id === CI_POLICY.ownerId
  && value.full_name === CI_POLICY.repository && value.fork === false
const validToken = value => typeof value === 'string' && /^vcp_[A-Za-z0-9_-]{20,500}$/.test(value)
const pending = () => Object.freeze({ state: 'configuration_pending', deploymentRequested: false, reason: 'preview_project_token_not_configured' })

export function validateBranchWorkflowRunEvent(env, event, now = Date.now()) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REPOSITORY !== CI_POLICY.repository
    || env.GITHUB_REPOSITORY_ID !== String(CI_POLICY.repositoryId) || env.GITHUB_REPOSITORY_OWNER_ID !== String(CI_POLICY.ownerId)
    || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '')) refuse('UNTRUSTED_WORKFLOW_CONTEXT')
  if (env.GITHUB_RUN_ATTEMPT !== '1') refuse('PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW')
  if (env.XELAY_VERIFIED_DEPLOY_HOOK) refuse('PRODUCTION_SECRET_CONTEXT')
  if (env.XELAY_PREVIEW_DEPLOY_HOOK || env.XELAY_PREVIEW_HOOK_SECRET_NAME) refuse('LEGACY_SECRET_CONTEXT')
  const run = event?.workflow_run
  if (!object(event) || event.action !== 'completed' || !repositoryMatches(event.repository) || !object(run)
    || run.workflow_id !== CI_POLICY.workflowId || run.name !== CI_POLICY.workflowName || !['push', 'pull_request'].includes(run.event)
    || !isValidPreviewBranch(run.head_branch) || !repositoryMatches(run.head_repository) || run.status !== 'completed' || run.conclusion !== 'success'
    || !positive(run.id) || !positive(run.run_attempt) || !SHA.test(run.head_sha ?? '')) refuse('UNTRUSTED_WORKFLOW_EVENT')
  const updated = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : NaN
  if (!Number.isFinite(now) || !Number.isFinite(updated) || updated > now + 60000 || now - updated > CI_FRESHNESS_MS) refuse('STALE_WORKFLOW_EVENT')
  return Object.freeze({ sha: run.head_sha, branch: run.head_branch, event: run.event, runId: run.id,
    runAttempt: run.run_attempt, trustedMainSha: env.GITHUB_SHA })
}

function prepare(env, event, now, checkoutSha) {
  const expected = validateBranchWorkflowRunEvent(env, event, now)
  if (checkoutSha() !== expected.trustedMainSha) refuse('TRUSTED_CHECKOUT_MISMATCH')
  return expected
}
function githubHeaders(token) {
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
}
function vercelHeaders(token) { return { Accept: 'application/json', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }

async function providerJson(url, init, fetchImpl, failureCode, signal, timeoutMs = BRANCH_REQUEST_TIMEOUT_MS, maximumBytes = 524288) {
  const controller = new AbortController(), aborted = () => controller.abort()
  signal?.addEventListener('abort', aborted, { once: true })
  let timer, response, reader
  try {
    if (signal?.aborted) refuse(failureCode)
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new VerifiedBranchDeploymentError(failureCode)) }, timeoutMs) })
    const operation = (async () => {
      response = await fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || !response || response.redirected || response.url && response.url !== url
        || ![200, ...(init.method === 'POST' ? [201, 202] : [])].includes(response.status)) refuse(failureCode)
      const type = response.headers?.get('content-type') ?? '', length = response.headers?.get('content-length')
      if (!/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(type)
        || length && (!/^\d+$/.test(length) || Number(length) > maximumBytes) || !response.body?.getReader) refuse('INVALID_PROVIDER_RESPONSE')
      reader = response.body.getReader()
      const chunks = []; let bytes = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (controller.signal.aborted) refuse(failureCode)
        if (done) break
        if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > maximumBytes) refuse('INVALID_PROVIDER_RESPONSE')
        chunks.push(Buffer.from(value))
      }
      let body
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { refuse('INVALID_PROVIDER_RESPONSE') }
      if (!object(body)) refuse('INVALID_PROVIDER_RESPONSE')
      return body
    })()
    return await Promise.race([operation, timeout])
  } catch (error) {
    if (error instanceof VerifiedBranchDeploymentError) throw error
    refuse(failureCode)
  } finally {
    clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', aborted)
    try { if (reader?.cancel) void Promise.resolve(reader.cancel()).catch(() => {}); else if (response?.body?.cancel) void Promise.resolve(response.body.cancel()).catch(() => {}) } catch {}
  }
}

async function bounded(operation) {
  const controller = new AbortController(); let timer
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new VerifiedBranchDeploymentError('PUBLISHER_DEADLINE')) }, BRANCH_PUBLISHER_TIMEOUT_MS) })
    return await Promise.race([operation(controller.signal), timeout])
  } finally { clearTimeout(timer); controller.abort() }
}

async function proof({ expected, env, now, fetchImpl, verifyPreview, signal }) {
  let receipt
  try { receipt = await verifyPreview({ sha: expected.sha, branch: expected.branch, now, fetchImpl, token: env.GITHUB_TOKEN || undefined, signal }) }
  catch { refuse('PREVIEW_CI_PROOF_UNAVAILABLE') }
  if (!object(receipt) || receipt.mode !== 'preview' || receipt.authority !== 'branch-head-ci' || receipt.event !== expected.event
    || receipt.sha !== expected.sha || receipt.branch !== expected.branch || receipt.baseSha !== expected.trustedMainSha
    || receipt.runId !== expected.runId || receipt.runAttempt !== expected.runAttempt
    || receipt.repository !== CI_POLICY.repository || receipt.repositoryId !== CI_POLICY.repositoryId || receipt.ownerId !== CI_POLICY.ownerId
    || receipt.workflowId !== CI_POLICY.workflowId || receipt.workflowPath !== CI_POLICY.workflowPath || receipt.workflowBlob !== CI_POLICY.workflowBlob
    || typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt))
    || Date.parse(receipt.completedAt) > now || now - Date.parse(receipt.completedAt) > CI_FRESHNESS_MS) refuse('EVENT_PROOF_MISMATCH')
  return receipt
}
const identity = expected => ({ sha: expected.sha, branch: expected.branch, runId: expected.runId, runAttempt: expected.runAttempt })

export async function resolveVerifiedBranchDeployment({ env = process.env, event, now = Date.now(), fetchImpl = globalThis.fetch,
  verifyPreview = verifyGithubBranchPreview, checkoutSha = readCheckoutSha } = {}) {
  const expected = prepare(env, event, now, checkoutSha)
  if (env.XELAY_PREVIEW_PROJECT_TOKEN) refuse('RESOLVER_SECRET_CONTEXT')
  return bounded(async signal => {
    const receipt = await proof({ expected, env, now, fetchImpl, verifyPreview, signal })
    return Object.freeze({ state: 'ready', deploymentRequested: false, ...identity(expected), baseSha: receipt.baseSha })
  })
}

function sourceMatches(value, expected) {
  return object(value) && value.type === 'github' && String(value.repoId) === String(CI_POLICY.repositoryId)
    && value.ref === expected.branch && value.sha === expected.sha
}
function metadataMatches(value, expected) {
  return object(value) && value.githubCommitSha === expected.sha && value.githubCommitRef === expected.branch
    && String(value.githubCommitRepoId ?? value.githubRepoId) === String(CI_POLICY.repositoryId)
}
function deploymentMatches(value, expected) {
  if (!object(value) || value.projectId !== CI_POLICY.projectId || own(value, 'target') !== null) return false
  if (value.gitSource === undefined) return metadataMatches(value.meta, expected)
  if (!sourceMatches(value.gitSource, expected)) return false
  if (value.meta === undefined) return true
  if (!object(value.meta)) return false
  return (value.meta.githubCommitSha === undefined || value.meta.githubCommitSha === expected.sha)
    && (value.meta.githubCommitRef === undefined || value.meta.githubCommitRef === expected.branch)
    && (value.meta.githubCommitRepoId === undefined || String(value.meta.githubCommitRepoId) === String(CI_POLICY.repositoryId))
    && (value.meta.githubRepoId === undefined || String(value.meta.githubRepoId) === String(CI_POLICY.repositoryId))
}

async function existingDeployment({ expected, receipt, env, fetchImpl, signal, now }) {
  let until, newestFailure = 0
  const seen = new Set()
  for (let page = 0; page < BRANCH_DEPLOYMENT_MAX_PAGES; page++) {
    const query = new URLSearchParams({ projectId: CI_POLICY.projectId, branch: expected.branch, sha: expected.sha, limit: String(PAGE_SIZE) })
    if (until !== undefined) query.set('until', String(until))
    const body = await providerJson(VERCEL_ROOT + '/v7/deployments?' + query, { method: 'GET', headers: vercelHeaders(env.XELAY_PREVIEW_PROJECT_TOKEN) }, fetchImpl, 'DEPLOYMENT_HISTORY_UNAVAILABLE', signal)
    if (!Array.isArray(body.deployments) || body.deployments.length > PAGE_SIZE || !object(body.pagination)
      || body.pagination.count !== body.deployments.length) refuse('DEPLOYMENT_HISTORY_UNAVAILABLE')
    for (const value of body.deployments) {
      const created = value?.createdAt ?? value?.created
      if (!object(value) || !DEPLOYMENT_ID.test(value.uid ?? '') || seen.has(value.uid) || value.projectId !== CI_POLICY.projectId
        || !positive(created) || created > now + 60000 || ![...ACTIVE, ...FAILED].includes(value.state)
        || own(value, 'target') !== null && typeof value.target !== 'string') refuse('DEPLOYMENT_HISTORY_UNAVAILABLE')
      seen.add(value.uid)
      // The fixed API filters are not a substitute for checking returned identity.
      if (!deploymentMatches(value, expected)) {
        if (own(value, 'target') === null) refuse('DEPLOYMENT_HISTORY_UNAVAILABLE')
        continue
      }
      // An early Git build may already have observed pending CI and still be
      // winding down. Only post-CI active builds can suppress this follow-up.
      if (value.state === 'READY' || ACTIVE.has(value.state) && created >= Date.parse(receipt.completedAt)) return value.state
      if (ACTIVE.has(value.state)) continue
      newestFailure = Math.max(newestFailure, created)
    }
    const next = body.pagination.next
    if (next === null) {
      if (newestFailure >= Date.parse(receipt.completedAt)) refuse('DEPLOYMENT_RETRY_REQUIRES_FRESH_CI')
      return null
    }
    if (!positive(next) || until !== undefined && next >= until || !body.deployments.length) refuse('DEPLOYMENT_HISTORY_UNAVAILABLE')
    until = next
  }
  refuse('DEPLOYMENT_HISTORY_UNAVAILABLE')
}

async function recheckHeads(expected, env, fetchImpl, signal) {
  for (const [branch, sha] of [[expected.branch, expected.sha], ['main', expected.trustedMainSha]]) {
    const ref = await providerJson(GH_ROOT + '/git/ref/heads/' + encodeURIComponent(branch), { method: 'GET', headers: githubHeaders(env.GITHUB_TOKEN) }, fetchImpl, 'PREVIEW_RECHECK_UNAVAILABLE', signal)
    if (ref.ref !== 'refs/heads/' + branch || ref.object?.type !== 'commit' || ref.object.sha !== sha) refuse('PREVIEW_HEAD_OR_BASE_MOVED')
  }
}

export async function requestVerifiedBranchDeployment({ env = process.env, event, now = Date.now(), fetchImpl = globalThis.fetch,
  verifyPreview = verifyGithubBranchPreview, checkoutSha = readCheckoutSha } = {}) {
  const expected = prepare(env, event, now, checkoutSha)
  if (!env.XELAY_PREVIEW_PROJECT_TOKEN) return pending()
  if (!validToken(env.XELAY_PREVIEW_PROJECT_TOKEN)) refuse('INVALID_PROJECT_TOKEN')
  let attempted = false
  const unknown = code => Object.freeze({ state: 'request_outcome_unknown', deploymentRequested: null, requestAttempted: true, code, ...identity(expected) })
  try {
    return await bounded(async signal => {
      const receipt = await proof({ expected, env, now, fetchImpl, verifyPreview, signal })
      const state = await existingDeployment({ expected, receipt, env, fetchImpl, signal, now })
      if (state) return Object.freeze({ state: 'already_requested', deploymentRequested: false, reason: 'verified_preview_' + state.toLowerCase(), ...identity(expected) })
      // A second independent provider proof closes the history-read interval.
      await proof({ expected, env, now, fetchImpl, verifyPreview, signal })
      await recheckHeads(expected, env, fetchImpl, signal)
      if (signal.aborted) refuse('PUBLISHER_DEADLINE')
      // No target means Preview. Do not add projectSettings, env, files or hooks.
      const body = { name: 'xelay', project: CI_POLICY.projectId,
        gitSource: { type: 'github', repoId: CI_POLICY.repositoryId, ref: expected.branch, sha: expected.sha } }
      attempted = true
      const accepted = await providerJson(VERCEL_ROOT + '/v13/deployments', { method: 'POST', headers: vercelHeaders(env.XELAY_PREVIEW_PROJECT_TOKEN), body: JSON.stringify(body) }, fetchImpl, 'DEPLOYMENT_REQUEST_UNAVAILABLE', signal, BRANCH_POST_TIMEOUT_MS)
      if (!DEPLOYMENT_ID.test(accepted.id ?? '') || own(accepted, 'target') !== null || ![...ACTIVE, ...FAILED].includes(accepted.readyState)) refuse('DEPLOYMENT_RECEIPT_UNAVAILABLE')
      let confirmed = accepted
      // The REST API can return a reduced receipt; resolve only its validated ID.
      if (!Object.hasOwn(accepted, 'projectId') || !accepted.gitSource && !accepted.meta) {
        confirmed = await providerJson(VERCEL_ROOT + '/v13/deployments/' + accepted.id + '?withGitRepoInfo=true', { method: 'GET', headers: vercelHeaders(env.XELAY_PREVIEW_PROJECT_TOKEN) }, fetchImpl, 'DEPLOYMENT_RECEIPT_UNAVAILABLE', signal)
      }
      if (confirmed.id !== accepted.id || !deploymentMatches(confirmed, expected) || !ACTIVE.has(confirmed.readyState)) refuse('DEPLOYMENT_RECEIPT_UNAVAILABLE')
      return Object.freeze({ state: 'requested', deploymentRequested: true, ...identity(expected) })
    })
  } catch (error) {
    if (attempted) return unknown(error instanceof VerifiedBranchDeploymentError && CODES.has(error.code) ? error.code : 'DEPLOYMENT_RECEIPT_UNAVAILABLE')
    throw error
  }
}

export async function runVerifiedBranchDeploymentCli({ phase, env = process.env, statEvent = lstat, readEvent = readFile,
  resolver = resolveVerifiedBranchDeployment, requester = requestVerifiedBranchDeployment,
  writeOutput = async text => {
    if (typeof env.GITHUB_OUTPUT !== 'string' || !env.GITHUB_OUTPUT || env.GITHUB_OUTPUT.length > 4096) refuse('OUTPUT_UNAVAILABLE')
    await appendFile(env.GITHUB_OUTPUT, text, 'utf8')
  }, stdout = line => console.log(line), stderr = line => console.error(line) } = {}) {
  try {
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run') refuse('UNTRUSTED_WORKFLOW_CONTEXT')
    if (!['resolve', 'post'].includes(phase)) refuse('INVALID_PHASE')
    let event
    try {
      const path = env.GITHUB_EVENT_PATH
      if (typeof path !== 'string' || !path || path.length > 4096) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      const stat = await statEvent(path)
      if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_EVENT_BYTES) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      const text = await readEvent(path, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_EVENT_BYTES) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      event = JSON.parse(text)
    } catch { refuse('WORKFLOW_EVENT_UNAVAILABLE') }
    const outcome = await (phase === 'resolve' ? resolver : requester)({ env, event })
    if (phase === 'resolve') await writeOutput('ready=' + (outcome.state === 'ready') + '\n')
    stdout(JSON.stringify(outcome))
    return outcome.state === 'request_outcome_unknown' ? 1 : 0
  } catch (error) {
    const code = error instanceof VerifiedBranchDeploymentError && CODES.has(own(error, 'code')) ? own(error, 'code') : 'PREVIEW_DEPLOYMENT_REFUSED'
    stderr(JSON.stringify({ state: 'refused', deploymentRequested: false, code }))
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runVerifiedBranchDeploymentCli({ phase: process.argv[2] })
}
