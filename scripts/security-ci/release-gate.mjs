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
    const result = spawnSync(process.execPath, [script], { cwd: repository, env: safeEnvironment(directory), shell: false,
      windowsHide: true, stdio: 'inherit', timeout: 8 * 60_000 })
    if (result.status !== 0 || result.error) { process.exitCode = 1; break }
  }
} finally { await rm(directory, { recursive: true, force: true }) }
