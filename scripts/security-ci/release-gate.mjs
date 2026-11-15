import { spawnSync } from 'node:child_process'
import { repository } from './snapshot.mjs'
import { safeEnvironment } from './policy.mjs'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifiedVercelReceipt, VercelGateError } from './vercel-gate.mjs'
import { assertSourceTree, SourceIntegrityError } from './source-proof.mjs'
import { CI_POLICY, GithubVerificationError } from './verified-ci.mjs'

// Only fixed codes from our own error classes are safe diagnostics. Do not
// forward arbitrary provider/OS codes, messages, paths, stacks or environment.
const DIAGNOSTIC_CODES = new Set([
  'checkout_changed_during_verification', 'ci_receipt_mismatch', 'production_source_context_mismatch',
  'repository_missing', 'source_proof_mismatch', 'unsupported_gate_configuration',
  'SOURCE_CHANGED', 'SOURCE_COMMIT_MISMATCH', 'SOURCE_CONTENT_MISMATCH', 'SOURCE_EXTRA_INPUT',
  'SOURCE_GENERATED_DIRECTORY_INVALID', 'SOURCE_GIT_DIRECTORY_INVALID', 'SOURCE_GIT_UNAVAILABLE',
  'SOURCE_HEAD_MISMATCH', 'SOURCE_INVALID_INPUT', 'SOURCE_INVALID_PATH', 'SOURCE_LIMIT_EXCEEDED',
  'SOURCE_MISSING_INPUT', 'SOURCE_MODE_MISMATCH', 'SOURCE_NOT_REGULAR_FILE', 'SOURCE_RESERVED_TRACKED_PATH',
  'SOURCE_ROOT_INVALID', 'SOURCE_SYMLINK', 'SOURCE_TREE_INVALID', 'SOURCE_TREE_MISMATCH', 'SOURCE_UNAVAILABLE',
  'CI_ABORTED', 'CI_API_INVALID_RESPONSE', 'CI_API_ORIGIN', 'CI_API_OVERSIZE', 'CI_API_PAGINATION',
  'CI_API_RATE_LIMIT', 'CI_API_REDIRECT', 'CI_API_REQUEST_LIMIT', 'CI_API_TIMEOUT', 'CI_API_UNAVAILABLE',
  'CI_EVIDENCE_CHANGED', 'CI_INVALID_INPUT', 'CI_INVALID_TIMESTAMP', 'CI_JOB_IDENTITY', 'CI_JOB_MISSING',
  'CI_JOB_NOT_SUCCESSFUL', 'CI_MAIN_CHANGED', 'CI_PENDING', 'CI_REPOSITORY_MISMATCH', 'CI_RUN_FUTURE',
  'CI_RUN_IDENTITY', 'CI_RUN_MISSING', 'CI_RUN_NOT_SUCCESSFUL', 'CI_RUN_STALE', 'CI_STEP_IDENTITY',
  'CI_STEP_MISSING', 'CI_STEP_NOT_SUCCESSFUL', 'CI_WORKFLOW_MISMATCH',
])

function diagnosticContext(environment) {
  const [owner, slug] = CI_POLICY.repository.split('/')
  return {
    projectMatches: environment.VERCEL_PROJECT_ID === CI_POLICY.projectId,
    providerMatches: environment.VERCEL_GIT_PROVIDER === 'github',
    ownerMatches: typeof environment.VERCEL_GIT_REPO_OWNER === 'string' && environment.VERCEL_GIT_REPO_OWNER.toLowerCase() === owner.toLowerCase(),
    slugMatches: environment.VERCEL_GIT_REPO_SLUG === slug,
    branchMatches: environment.VERCEL_GIT_COMMIT_REF === CI_POLICY.branch,
    shaValid: typeof environment.VERCEL_GIT_COMMIT_SHA === 'string' && /^[a-f0-9]{40}$/.test(environment.VERCEL_GIT_COMMIT_SHA),
  }
}

async function diagnosticSourceInputs() {
  try {
    // Inspect existence only at these exact root locations, without following
    // symlinks, listing directories or reading any file contents. The proof's
    // rejection remains authoritative regardless of these diagnostics.
    const present = await Promise.all(['.vercel', '.env.local', '.env.production', '.env.production.local', '.npmrc'].map(async name => {
      try {
        await lstat(join(repository, name))
        return true
      } catch (error) {
        if (error !== null && (typeof error === 'object' || typeof error === 'function')
          && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT') return false
        throw error
      }
    }))
    return { vercelDirectoryPresent: present[0], dotenvFilePresent: present[1] || present[2] || present[3], npmrcPresent: present[4] }
  } catch {
    // A failed diagnostic must neither disclose an OS error nor misreport an
    // unreadable location as absent. No exception is granted to source proof.
    return null
  }
}

function diagnosticCode(error) {
  const trusted = error instanceof VercelGateError || error instanceof SourceIntegrityError || error instanceof GithubVerificationError
  const candidate = trusted ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  return typeof candidate === 'string' && DIAGNOSTIC_CODES.has(candidate) ? candidate : 'unknown_gate_failure'
}

async function diagnosticDetails(code, environment) {
  const context = code === 'production_source_context_mismatch' ? ` context=${JSON.stringify(diagnosticContext(environment))}` : ''
  const sourceInputs = code === 'SOURCE_EXTRA_INPUT' ? await diagnosticSourceInputs() : undefined
  const sourceContext = sourceInputs === undefined ? '' : sourceInputs === null ? ' sourceInputDiagnosticsUnavailable=true' : ` sourceInputs=${JSON.stringify(sourceInputs)}`
  return context + sourceContext
}

async function previewSourceDiagnostic(environment) {
  if (environment.XELAY_SOURCE_PROOF_DIAGNOSTIC !== '1' || environment.VERCEL !== '1' || environment.VERCEL_ENV !== 'preview') return
  try {
    const sha = environment.VERCEL_GIT_COMMIT_SHA
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new SourceIntegrityError('SOURCE_INVALID_INPUT')
    await assertSourceTree({ directory: repository, expectedSha: sha, environment })
    console.log('Preview source diagnostic: source proof matched. The complete mandatory release gate still follows.')
  } catch (error) {
    const code = diagnosticCode(error)
    console.error(`Preview source diagnostic rejected (code=${code})${await diagnosticDetails(code, environment)}. The complete mandatory release gate still follows.`)
  }
}

let directory
try {
  await previewSourceDiagnostic(process.env ?? {})
  const receipt = await verifiedVercelReceipt({ environment: process.env ?? {}, repositoryDirectory: repository })
  if (receipt) {
    console.log(`Release gate: mandatory GitHub checks verified for ${receipt.sha} (run ${receipt.runId}, attempt ${receipt.runAttempt}); duplicate suites not executed.`)
  } else {
    // The existing complete gate remains the default and protects previews and
    // local builds. Git metadata and the protected baseline are still required.
    directory = await mkdtemp(join(tmpdir(), 'xelay-release-gate-'))
    for (const script of ['scripts/security-ci/scan-secrets.mjs', 'scripts/security-ci/audit.mjs', 'scripts/security-ci/run.mjs']) {
      const timeout = script === 'scripts/security-ci/run.mjs' ? 15 * 60_000 : 8 * 60_000
      const result = spawnSync(process.execPath, [script], { cwd: repository, env: safeEnvironment(directory), shell: false,
        windowsHide: true, stdio: 'inherit', timeout })
      if (result.status !== 0 || result.error) {
        const errorCode = result.error?.code ?? (result.error ? 'UNKNOWN' : 'none')
        console.error(`Release gate failed in ${script} (exit=${result.status ?? 'none'}, error=${errorCode}, signal=${result.signal ?? 'none'}, timeoutLimitMs=${timeout})`)
        process.exitCode = 1
        break
      }
    }
  }
} catch (error) {
  // Provider bodies, access tokens and hook URLs must never reach build logs.
  const code = diagnosticCode(error)
  console.error(`Release gate rejected (code=${code})${await diagnosticDetails(code, process.env ?? {})}: required CI proof or source identity is unavailable or invalid. No duplicate-check fallback was allowed for the verified production path.`)
  process.exitCode = 1
} finally {
  if (directory) await rm(directory, { recursive: true, force: true })
}
