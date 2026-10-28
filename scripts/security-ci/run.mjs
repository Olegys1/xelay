import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createSnapshot, repository } from './snapshot.mjs'
import { safeEnvironment, selectTests } from './policy.mjs'

const args = process.argv.slice(2)
if (args.some(arg => !['--core', '--full', '--build', '--list'].includes(arg)) || (args.includes('--core') && args.includes('--full'))) {
  throw new Error('Usage: node scripts/security-ci/run.mjs [--core|--full] [--build] [--list]')
}
const mode = args.includes('--full') ? 'full' : 'core'
if (mode === 'full' && !args.includes('--build') && !args.includes('--list')) throw new Error('Full mode includes built HTML checks; pass --build explicitly')
let snapshot
try {
  snapshot = await createSnapshot({ dependencies: !args.includes('--list') })
  const tests = selectTests(snapshot.paths, mode)
  if (args.includes('--list')) {
    console.log(`${mode}: ${tests.length} selected files; current tracked contents plus explicit security task additions`)
    for (const path of tests) console.log(path)
  } else {
    const env = safeEnvironment(snapshot.directory)
    const guard = pathToFileURL(join(snapshot.directory, 'scripts/security-ci/offline-guard.mjs')).href
    const run = (args, build = false) => spawnSync(process.execPath, args, {
      cwd: snapshot.directory, env: build ? { ...env, XELAY_SECURITY_CI_BUILD: 'true' } : env,
      shell: false, encoding: 'utf8', timeout: build ? 180_000 : 150_000,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    })
    if (args.includes('--build')) {
      const result = run(['--max-old-space-size=1536', '--import', guard, join(repository, 'node_modules/vite/bin/vite.js'), 'build'], true)
      if (result.status !== 0 || result.error) {
        console.error(((result.stdout ?? '') + (result.stderr ?? '')).slice(-12000))
        throw new Error('Isolated production build failed')
      }
      console.log('Isolated production build passed (synthetic environment; no dotenv files).')
    }
    let failed = 0
    const results = []
    const started = Date.now()
    for (const path of tests) {
      const before = Date.now()
      const result = run(['--max-old-space-size=768', '--import', guard, '--test', '--test-isolation=none', '--test-concurrency=1', '--test-timeout=120000', path])
      const passed = result.status === 0 && !result.error
      const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(key => {
        const match = (result.stdout ?? '').match(new RegExp(`^(?:#|ℹ)\\s*${key}\\s+(\\d+)`, 'm'))
        return [key, match ? Number(match[1]) : null]
      }))
      results.push({ path, passed, durationMs: Date.now() - before, counts })
      console.log(`${passed ? 'PASS' : 'FAIL'} ${path} (${((Date.now() - before) / 1000).toFixed(1)}s)`)
      if (!passed) { failed++; console.error(((result.stdout ?? '') + (result.stderr ?? '')).slice(-12000)); if (result.error) console.error(`Child failed: ${result.error.code || 'unknown'}`) }
    }
    console.log(`${mode}: ${tests.length - failed}/${tests.length} files passed sequentially in ${((Date.now() - started) / 1000).toFixed(1)}s.`)
    const reportDirectory = join(repository, '.security-ci.local')
    await mkdir(reportDirectory, { recursive: true })
    const totals = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(key => [key,
      results.every(item => item.counts[key] !== null) ? results.reduce((sum, item) => sum + item.counts[key], 0) : null]))
    await writeFile(join(reportDirectory, `last-${mode}.json`), JSON.stringify({ timestamp: new Date().toISOString(), mode,
      passedFiles: tests.length - failed, totalFiles: tests.length, durationMs: Date.now() - started,
      nodeReportedCounts: totals, results }, null, 2) + '\n')
    if (failed) process.exitCode = 1
  }
} finally { if (snapshot) await snapshot.dispose() }
