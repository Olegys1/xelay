import { spawnSync } from 'node:child_process'
import { CI_POLICY, verifyGithubCommit } from './verified-ci.mjs'
import { isValidPreviewBranch } from './verified-preview-ci.mjs'
import { verifyGithubBranchPreview } from './verified-branch-preview-ci.mjs'
import { assertSourceTree } from './source-proof.mjs'

export class VercelGateError extends Error {
  constructor(code) {
    super(`Vercel release proof rejected: ${code}`)
    this.name = 'VercelGateError'
    this.code = code
  }
}

// This setting selects a verifier; it is never evidence that checks succeeded.
// Until the separate post-CI publisher is activated, retain the existing gate.
export function releaseGatePlan(environment = {}) {
  const requested = environment.XELAY_VERIFIED_CI_GATE
  const previewRequested = environment.XELAY_VERIFIED_PREVIEW_CI_GATE
  for (const value of [requested, previewRequested]) {
    if (value != null && value !== '' && value !== 'full' && value !== 'github') throw new VercelGateError('unsupported_gate_configuration')
  }
  const scope = environment.VERCEL_ENV
  if (environment.VERCEL !== '1' || !['production', 'preview'].includes(scope)) {
    return { mode: 'full', reason: 'local_or_preview_full_gate' }
  }
  const selected = scope === 'production' ? requested : previewRequested
  if (selected !== 'github') return { mode: 'full', reason: 'default_full_gate' }
  const [owner, repository] = CI_POLICY.repository.split('/')
  if (environment.VERCEL_PROJECT_ID !== CI_POLICY.projectId
    || environment.VERCEL_GIT_PROVIDER !== 'github'
    || typeof environment.VERCEL_GIT_REPO_OWNER !== 'string'
    || environment.VERCEL_GIT_REPO_OWNER.toLowerCase() !== owner.toLowerCase()
    || environment.VERCEL_GIT_REPO_SLUG !== repository
    || !/^[a-f0-9]{40}$/.test(environment.VERCEL_GIT_COMMIT_SHA ?? '')) {
    throw new VercelGateError(scope + '_source_context_mismatch')
  }
  const sha = environment.VERCEL_GIT_COMMIT_SHA
  if (scope === 'production') {
    if (environment.VERCEL_GIT_COMMIT_REF !== CI_POLICY.branch) throw new VercelGateError('production_source_context_mismatch')
    return { mode: 'github', scope, sha }
  }
  const branch = environment.VERCEL_GIT_COMMIT_REF
  if (!isValidPreviewBranch(branch)) throw new VercelGateError('preview_source_context_mismatch')
  const hint = environment.VERCEL_GIT_PULL_REQUEST_ID
  if (hint != null && hint !== '' && (typeof hint !== 'string' || !/^[1-9]\d{0,9}$/.test(hint))) throw new VercelGateError('preview_pull_request_context_mismatch')
  // A PR hint is optional metadata, never authority to publish a branch. Exact
  // same-repository branch HEAD and mandatory CI also protect branches without PRs.
  return { mode: 'github', scope, sha, branch }
}

function validSourceProof(proof, sha) {
  return proof?.sha === sha && /^[a-f0-9]{64}$/.test(proof.digest ?? '')
    && Number.isSafeInteger(proof.fileCount) && proof.fileCount > 0
    && Number.isSafeInteger(proof.totalBytes) && proof.totalBytes >= 0
}

/** No tests, installs or builds run here. Network reads only verify CI evidence. */
export async function verifiedVercelReceipt({
  environment = process.env, repositoryDirectory,
  spawn = spawnSync, verifyGithub = verifyGithubCommit, verifyPreview = verifyGithubBranchPreview,
  proveSource = assertSourceTree, now = Date.now(),
} = {}) {
  const plan = releaseGatePlan(environment)
  if (plan.mode === 'full') return null
  if (typeof repositoryDirectory !== 'string' || !repositoryDirectory) throw new VercelGateError('repository_missing')
  const options = { directory: repositoryDirectory, expectedSha: plan.sha, spawn, environment }
  const before = await proveSource(options)
  if (!validSourceProof(before, plan.sha)) throw new VercelGateError('source_proof_mismatch')
  // A rejected, missing, pending or stale proof MUST NOT fall back to a cheaper
  // local scan. In this mode all three authoritative CI jobs are mandatory.
  const token = environment.XELAY_CI_READ_TOKEN === '' ? undefined : environment.XELAY_CI_READ_TOKEN
  const receipt = plan.scope === 'preview'
    ? await verifyPreview({ sha: plan.sha, branch: plan.branch, token, now })
    : await verifyGithub({ sha: plan.sha, token, now })
  if (!receipt || receipt.sha !== plan.sha || receipt.repository !== CI_POLICY.repository
    || receipt.repositoryId !== CI_POLICY.repositoryId || receipt.workflowId !== CI_POLICY.workflowId
    || receipt.ownerId !== CI_POLICY.ownerId || receipt.workflowPath !== CI_POLICY.workflowPath
    || receipt.workflowBlob !== CI_POLICY.workflowBlob || receipt.mode !== plan.scope
    || !Number.isSafeInteger(receipt.runId) || receipt.runId <= 0
    || !Number.isSafeInteger(receipt.runAttempt) || receipt.runAttempt <= 0) {
    throw new VercelGateError('ci_receipt_mismatch')
  }
  if (plan.scope === 'preview' && (receipt.branch !== plan.branch
    || receipt.authority !== 'branch-head-ci' || receipt.event !== 'push'
    || !/^[a-f0-9]{40}$/.test(receipt.baseSha ?? ''))) {
    throw new VercelGateError('ci_receipt_mismatch')
  }
  // Defend against source changes while provider reads were in flight.
  const after = await proveSource(options)
  if (!validSourceProof(after, plan.sha) || after.digest !== before.digest
    || after.fileCount !== before.fileCount || after.totalBytes !== before.totalBytes) {
    throw new VercelGateError('checkout_changed_during_verification')
  }
  return receipt
}
