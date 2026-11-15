import { spawnSync } from 'node:child_process'
import { CI_POLICY, verifyGithubCommit } from './verified-ci.mjs'
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
  if (requested == null || requested === '' || requested === 'full') return { mode: 'full', reason: 'default_full_gate' }
  if (requested !== 'github') throw new VercelGateError('unsupported_gate_configuration')
  if (environment.VERCEL !== '1' || environment.VERCEL_ENV !== 'production') {
    return { mode: 'full', reason: 'local_or_preview_full_gate' }
  }
  const [owner, repository] = CI_POLICY.repository.split('/')
  if (environment.VERCEL_PROJECT_ID !== CI_POLICY.projectId
    || environment.VERCEL_GIT_PROVIDER !== 'github'
    || environment.VERCEL_GIT_REPO_OWNER?.toLowerCase() !== owner.toLowerCase()
    || environment.VERCEL_GIT_REPO_SLUG !== repository
    || environment.VERCEL_GIT_COMMIT_REF !== 'main'
    || !/^[a-f0-9]{40}$/.test(environment.VERCEL_GIT_COMMIT_SHA ?? '')) {
    throw new VercelGateError('production_source_context_mismatch')
  }
  return { mode: 'github', sha: environment.VERCEL_GIT_COMMIT_SHA }
}

function validSourceProof(proof, sha) {
  return proof?.sha === sha && /^[a-f0-9]{64}$/.test(proof.digest ?? '')
    && Number.isSafeInteger(proof.fileCount) && proof.fileCount > 0
    && Number.isSafeInteger(proof.totalBytes) && proof.totalBytes >= 0
}

/** No tests, installs or builds run here. Network reads only verify CI evidence. */
export async function verifiedVercelReceipt({
  environment = process.env, repositoryDirectory,
  spawn = spawnSync, verifyGithub = verifyGithubCommit, proveSource = assertSourceTree, now = Date.now(),
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
  const receipt = await verifyGithub({ sha: plan.sha, token, now })
  if (!receipt || receipt.sha !== plan.sha || receipt.repository !== CI_POLICY.repository
    || receipt.repositoryId !== CI_POLICY.repositoryId || receipt.workflowId !== CI_POLICY.workflowId) {
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
