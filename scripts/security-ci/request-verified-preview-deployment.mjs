import { appendFile, lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_FRESHNESS_MS, CI_POLICY } from './verified-ci.mjs'
import { verifyGithubPreview } from './verified-preview-ci.mjs'
import { readCheckoutSha, validateDeployHook } from './request-verified-deployment.mjs'

const SHA = /^[a-f0-9]{40}$/
const API_ROOT = 'https://api.github.com/repos/Olegys1/xelay'
const REGISTRY_URL = new URL('./preview-hook-registry.json', import.meta.url)
export const PREVIEW_REQUEST_TIMEOUT_MS = 5000
export const PREVIEW_HOOK_TIMEOUT_MS = 15000
const MAX_EVENT_BYTES = 262144, MAX_REGISTRY_BYTES = 32768
const CODES = new Set(['UNTRUSTED_WORKFLOW_CONTEXT', 'PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW', 'UNTRUSTED_WORKFLOW_EVENT',
  'STALE_WORKFLOW_EVENT', 'REGISTRY_INVALID', 'TRUSTED_CHECKOUT_MISMATCH', 'PREVIEW_CI_PROOF_UNAVAILABLE', 'EVENT_PROOF_MISMATCH',
  'PREVIEW_SECRET_SELECTION_MISMATCH', 'PRODUCTION_SECRET_CONTEXT', 'RESOLVER_SECRET_CONTEXT', 'INVALID_PREVIEW_DEPLOY_HOOK', 'PREVIEW_RECHECK_UNAVAILABLE',
  'PREVIEW_HEAD_OR_BASE_MOVED', 'DEPLOYMENT_HISTORY_UNAVAILABLE', 'DEPLOY_HOOK_REQUEST_UNAVAILABLE', 'INVALID_PROVIDER_RESPONSE',
  'DEPLOY_HOOK_RECEIPT_UNAVAILABLE', 'WORKFLOW_EVENT_UNAVAILABLE', 'OUTPUT_UNAVAILABLE', 'INVALID_PHASE'])

export class VerifiedPreviewDeploymentError extends Error {
  constructor(code) { super('Verified preview deployment request refused.'); this.name = 'VerifiedPreviewDeploymentError'; this.code = code }
}
const refuse = code => { throw new VerifiedPreviewDeploymentError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const data = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value
const repositoryMatches = value => object(value) && value.id === CI_POLICY.repositoryId && value.owner?.id === CI_POLICY.ownerId
  && value.full_name === CI_POLICY.repository && value.fork === false
const validBranch = value => typeof value === 'string' && value.toLowerCase() !== 'main'
  && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,159}$/.test(value) && !value.includes('..') && !value.includes('//')
  && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.endsWith('.lock'))

export function validatePreviewWorkflowRunEvent(env, event, now = Date.now()) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REPOSITORY !== CI_POLICY.repository
    || env.GITHUB_REPOSITORY_ID !== String(CI_POLICY.repositoryId) || env.GITHUB_REPOSITORY_OWNER_ID !== String(CI_POLICY.ownerId)
    || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '')) refuse('UNTRUSTED_WORKFLOW_CONTEXT')
  if (env.GITHUB_RUN_ATTEMPT !== '1') refuse('PUBLISHER_RERUN_REQUIRES_MANUAL_REVIEW')
  if (env.XELAY_VERIFIED_DEPLOY_HOOK) refuse('PRODUCTION_SECRET_CONTEXT')
  const run = event?.workflow_run
  if (!object(event) || event.action !== 'completed' || !repositoryMatches(event.repository) || !object(run)
    || run.workflow_id !== CI_POLICY.workflowId || run.name !== CI_POLICY.workflowName || run.event !== 'pull_request'
    || !validBranch(run.head_branch) || !repositoryMatches(run.head_repository) || run.status !== 'completed' || run.conclusion !== 'success'
    || !positive(run.id) || !positive(run.run_attempt) || typeof run.head_sha !== 'string' || !SHA.test(run.head_sha)
    || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 1 || !positive(run.pull_requests[0]?.number)) refuse('UNTRUSTED_WORKFLOW_EVENT')
  const updated = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : NaN
  if (!Number.isFinite(now) || !Number.isFinite(updated) || updated > now + 60000 || now - updated > CI_FRESHNESS_MS) refuse('STALE_WORKFLOW_EVENT')
  return Object.freeze({ sha: run.head_sha, branch: run.head_branch, pullRequestNumber: run.pull_requests[0].number,
    runId: run.id, runAttempt: run.run_attempt, trustedMainSha: env.GITHUB_SHA })
}

export function selectPreviewHook(registry, branch) {
  if (!validBranch(branch) || !object(registry) || Object.keys(registry).some(key => !['schemaVersion', 'branches'].includes(key))
    || data(registry, 'schemaVersion') !== 1 || !object(data(registry, 'branches'))) refuse('REGISTRY_INVALID')
  const branches = data(registry, 'branches'), names = Object.keys(branches), secrets = new Set()
  if (names.length > 64) refuse('REGISTRY_INVALID')
  let selected
  for (const name of names) {
    const entry = data(branches, name)
    if (!validBranch(name) || !object(entry) || Object.keys(entry).some(key => !['hookSecretName', 'status'].includes(key))) refuse('REGISTRY_INVALID')
    const secretName = data(entry, 'hookSecretName'), status = data(entry, 'status')
    if (typeof secretName !== 'string' || !/^XELAY_PREVIEW_[A-Z0-9_]{1,80}$/.test(secretName) || secrets.has(secretName)) refuse('REGISTRY_INVALID')
    secrets.add(secretName)
    if (Object.hasOwn(entry, 'status') && (!object(status) || Object.keys(status).some(key => !['context', 'creatorId', 'projectPath'].includes(key))
      || data(status, 'context') !== 'Vercel' || !positive(data(status, 'creatorId'))
      || typeof data(status, 'projectPath') !== 'string' || !/^\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_-]{1,100}$/.test(data(status, 'projectPath')))) refuse('REGISTRY_INVALID')
    if (name === branch) selected = Object.freeze({ branch, secretName,
      status: status === undefined ? undefined : Object.freeze({ context: data(status, 'context'), creatorId: data(status, 'creatorId'), projectPath: data(status, 'projectPath') }) })
  }
  return selected ?? null
}

export async function readPreviewHookRegistry({ stat = lstat, read = readFile } = {}) {
  try {
    const info = await stat(REGISTRY_URL)
    if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_REGISTRY_BYTES) refuse('REGISTRY_INVALID')
    const text = await read(REGISTRY_URL, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) refuse('REGISTRY_INVALID')
    return JSON.parse(text)
  } catch { refuse('REGISTRY_INVALID') }
}

async function providerJson(url, init, fetchImpl, failureCode, timeoutMs = PREVIEW_REQUEST_TIMEOUT_MS, maximumBytes = 262144) {
  const controller = new AbortController()
  let timer, response, reader
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new VerifiedPreviewDeploymentError(failureCode)) }, timeoutMs) })
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
    if (error instanceof VerifiedPreviewDeploymentError) throw error
    refuse(failureCode)
  } finally {
    clearTimeout(timer); controller.abort()
    try { if (reader?.cancel) void Promise.resolve(reader.cancel()).catch(() => {}); else if (response?.body?.cancel) void Promise.resolve(response.body.cancel()).catch(() => {}) } catch {}
  }
}

function headers(token) {
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
}
function prepare({ env, event, registry, now, checkoutSha }) {
  const expected = validatePreviewWorkflowRunEvent(env, event, now)
  if (checkoutSha() !== expected.trustedMainSha) refuse('TRUSTED_CHECKOUT_MISMATCH')
  const selection = selectPreviewHook(registry, expected.branch)
  return { expected, selection }
}
const pending = reason => Object.freeze({ state: 'configuration_pending', deploymentRequested: false, reason })
async function proof({ expected, env, now, fetchImpl, verifyPreview }) {
  let receipt
  try { receipt = await verifyPreview({ sha: expected.sha, branch: expected.branch, pullRequestNumber: expected.pullRequestNumber,
    now, fetchImpl, token: env.GITHUB_TOKEN || undefined }) } catch { refuse('PREVIEW_CI_PROOF_UNAVAILABLE') }
  if (!object(receipt) || receipt.mode !== 'preview' || receipt.sha !== expected.sha || receipt.branch !== expected.branch
    || receipt.pullRequestNumber !== expected.pullRequestNumber || receipt.baseSha !== expected.trustedMainSha
    || !positive(receipt.runId) || !positive(receipt.runAttempt) || receipt.runId !== expected.runId || receipt.runAttempt !== expected.runAttempt
    || receipt.repository !== CI_POLICY.repository || receipt.repositoryId !== CI_POLICY.repositoryId || receipt.ownerId !== CI_POLICY.ownerId
    || receipt.workflowId !== CI_POLICY.workflowId || receipt.workflowPath !== CI_POLICY.workflowPath || receipt.workflowBlob !== CI_POLICY.workflowBlob) refuse('EVENT_PROOF_MISMATCH')
  return receipt
}

export async function resolveVerifiedPreviewDeployment({ env = process.env, event, registry, now = Date.now(), fetchImpl = globalThis.fetch,
  verifyPreview = verifyGithubPreview, checkoutSha = readCheckoutSha } = {}) {
  const { expected, selection } = prepare({ env, event, registry, now, checkoutSha })
  if (env.XELAY_PREVIEW_DEPLOY_HOOK) refuse('RESOLVER_SECRET_CONTEXT')
  if (!selection) return pending('preview_branch_not_registered')
  const receipt = await proof({ expected, env, now, fetchImpl, verifyPreview })
  return Object.freeze({ state: 'ready', deploymentRequested: false, secretName: selection.secretName, sha: receipt.sha, branch: receipt.branch,
    pullRequestNumber: expected.pullRequestNumber, runId: expected.runId, runAttempt: expected.runAttempt, baseSha: receipt.baseSha })
}

async function existingVercelStatus({ expected, selection, env, fetchImpl }) {
  if (!selection.status) return null
  const response = await providerJson(API_ROOT + '/commits/' + expected.sha + '/status?per_page=100', { method: 'GET', headers: headers(env.GITHUB_TOKEN) }, fetchImpl, 'DEPLOYMENT_HISTORY_UNAVAILABLE')
  if (response.sha !== expected.sha || !Array.isArray(response.statuses) || response.statuses.length > 100
    || !Number.isSafeInteger(response.total_count) || response.total_count < response.statuses.length || response.total_count > 100) refuse('DEPLOYMENT_HISTORY_UNAVAILABLE')
  const status = response.statuses.filter(value => value?.context === selection.status.context && positive(value.id)
    && value.creator?.id === selection.status.creatorId && value.creator?.login === 'vercel[bot]' && value.creator?.type === 'Bot').sort((a, b) => b.id - a.id)[0]
  if (!status || !['pending', 'success'].includes(status.state) || typeof status.target_url !== 'string' || status.target_url.length > 1024) return null
  let target
  try { target = new URL(status.target_url) } catch { return null }
  return target.origin === 'https://vercel.com' && !target.username && !target.password
    && target.pathname.startsWith(selection.status.projectPath + '/') ? status.state : null
}

async function recheckPreview(expected, env, fetchImpl) {
  const get = path => providerJson(API_ROOT + path, { method: 'GET', headers: headers(env.GITHUB_TOKEN) }, fetchImpl, 'PREVIEW_RECHECK_UNAVAILABLE')
  const pr = await get('/pulls/' + expected.pullRequestNumber)
  if (pr.number !== expected.pullRequestNumber || pr.state !== 'open' || pr.merged !== false
    || !repositoryMatches(pr.head?.repo) || pr.head.ref !== expected.branch || pr.head.sha !== expected.sha
    || !repositoryMatches(pr.base?.repo) || pr.base.ref !== 'main' || pr.base.sha !== expected.trustedMainSha) refuse('PREVIEW_HEAD_OR_BASE_MOVED')
  const ref = await get('/git/ref/heads/' + encodeURIComponent(expected.branch))
  if (ref.ref !== 'refs/heads/' + expected.branch || ref.object?.type !== 'commit' || ref.object?.sha !== expected.sha) refuse('PREVIEW_HEAD_OR_BASE_MOVED')
  const main = await get('/git/ref/heads/main')
  if (main.ref !== 'refs/heads/main' || main.object?.type !== 'commit' || main.object?.sha !== expected.trustedMainSha) refuse('PREVIEW_HEAD_OR_BASE_MOVED')
}

export async function requestVerifiedPreviewDeployment({ env = process.env, event, registry, now = Date.now(), fetchImpl = globalThis.fetch,
  verifyPreview = verifyGithubPreview, checkoutSha = readCheckoutSha } = {}) {
  const { expected, selection } = prepare({ env, event, registry, now, checkoutSha })
  if (!selection) return pending('preview_branch_not_registered')
  if (env.XELAY_PREVIEW_HOOK_SECRET_NAME !== selection.secretName) refuse('PREVIEW_SECRET_SELECTION_MISMATCH')
  if (!env.XELAY_PREVIEW_DEPLOY_HOOK) return pending('preview_hook_not_configured')
  let hook
  try { hook = validateDeployHook(env.XELAY_PREVIEW_DEPLOY_HOOK, CI_POLICY.projectId) } catch { refuse('INVALID_PREVIEW_DEPLOY_HOOK') }
  await proof({ expected, env, now, fetchImpl, verifyPreview })
  const status = await existingVercelStatus({ expected, selection, env, fetchImpl })
  const identity = { sha: expected.sha, branch: expected.branch, pullRequestNumber: expected.pullRequestNumber, runId: expected.runId, runAttempt: expected.runAttempt }
  if (status) return Object.freeze({ state: 'already_requested', deploymentRequested: false, reason: 'verified_vercel_status_' + status, ...identity })
  await recheckPreview(expected, env, fetchImpl)
  const unknown = code => Object.freeze({ state: 'request_outcome_unknown', deploymentRequested: null, requestAttempted: true, code, ...identity })
  let accepted
  try { accepted = await providerJson(hook.href, { method: 'POST' }, fetchImpl, 'DEPLOY_HOOK_REQUEST_UNAVAILABLE', PREVIEW_HOOK_TIMEOUT_MS, 16384) }
  catch (error) { return unknown(error instanceof VerifiedPreviewDeploymentError && CODES.has(error.code) ? error.code : 'DEPLOY_HOOK_REQUEST_UNAVAILABLE') }
  if (!object(accepted.job) || typeof accepted.job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accepted.job.id)
    || !['PENDING', 'QUEUED', 'RUNNING'].includes(accepted.job.state)) return unknown('DEPLOY_HOOK_RECEIPT_UNAVAILABLE')
  return Object.freeze({ state: 'requested', deploymentRequested: true, ...identity })
}

export async function runVerifiedPreviewDeploymentCli({ phase, env = process.env, statEvent = lstat, readEvent = readFile,
  readRegistry = readPreviewHookRegistry, resolver = resolveVerifiedPreviewDeployment, requester = requestVerifiedPreviewDeployment,
  writeOutput = async text => {
    const path = env.GITHUB_OUTPUT
    if (typeof path !== 'string' || !path || path.length > 4096) refuse('OUTPUT_UNAVAILABLE')
    await appendFile(path, text, 'utf8')
  }, stdout = line => console.log(line), stderr = line => console.error(line) } = {}) {
  try {
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_run') refuse('UNTRUSTED_WORKFLOW_CONTEXT')
    if (!['resolve', 'post'].includes(phase)) refuse('INVALID_PHASE')
    const path = env.GITHUB_EVENT_PATH
    let event
    try {
      if (typeof path !== 'string' || !path || path.length > 4096) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      const stat = await statEvent(path)
      if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_EVENT_BYTES) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      const text = await readEvent(path, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_EVENT_BYTES) refuse('WORKFLOW_EVENT_UNAVAILABLE')
      event = JSON.parse(text)
    } catch { refuse('WORKFLOW_EVENT_UNAVAILABLE') }
    const registry = await readRegistry()
    const outcome = await (phase === 'resolve' ? resolver : requester)({ env, event, registry })
    if (phase === 'resolve') {
      const ready = outcome.state === 'ready'
      if (ready && !/^XELAY_PREVIEW_[A-Z0-9_]{1,80}$/.test(outcome.secretName ?? '')) refuse('OUTPUT_UNAVAILABLE')
      await writeOutput('ready=' + ready + '\n' + (ready ? 'secretName=' + outcome.secretName + '\n' : ''))
    }
    stdout(JSON.stringify(outcome))
    return outcome.state === 'request_outcome_unknown' ? 1 : 0
  } catch (error) {
    const code = error instanceof VerifiedPreviewDeploymentError && CODES.has(data(error, 'code')) ? data(error, 'code') : 'PREVIEW_DEPLOYMENT_REFUSED'
    stderr(JSON.stringify({ state: 'refused', deploymentRequested: false, code }))
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runVerifiedPreviewDeploymentCli({ phase: process.argv[2] })
}
