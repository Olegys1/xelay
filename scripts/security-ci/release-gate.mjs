import { spawnSync } from 'node:child_process'
import { repository } from './snapshot.mjs'
import { safeEnvironment } from './policy.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifiedVercelReceipt } from './vercel-gate.mjs'

let directory
try {
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
} catch {
  // Provider bodies, access tokens and hook URLs must never reach build logs.
  console.error('Release gate rejected: required CI proof or source identity is unavailable or invalid. No duplicate-check fallback was allowed for the verified production path.')
  process.exitCode = 1
} finally {
  if (directory) await rm(directory, { recursive: true, force: true })
}
