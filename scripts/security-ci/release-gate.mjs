import { spawnSync } from 'node:child_process'
import { repository } from './snapshot.mjs'
import { safeEnvironment } from './policy.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Build providers must retain Git metadata. Without it, neither test selection
// nor the protected baseline is knowable, so the release is rejected.
const directory = await mkdtemp(join(tmpdir(), 'xelay-release-gate-'))
try {
  for (const script of ['scripts/security-ci/scan-secrets.mjs', 'scripts/security-ci/audit.mjs', 'scripts/security-ci/run.mjs']) {
    // The core runner checks every suite sequentially under its own per-suite limit.
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
} finally { await rm(directory, { recursive: true, force: true }) }
