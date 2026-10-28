import { spawnSync } from 'node:child_process'
import { access, copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeEnvironment } from './policy.mjs'
import { createSnapshot, repository } from './snapshot.mjs'

// Run npm's own advisory checker against only the proposed manifest/lockfile.
// No installs or lifecycle scripts, no project/user npmrc, one fixed registry.
export async function findNpmCli() {
  const nodeDirectory = dirname(await realpath(process.execPath))
  const candidates = [join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'), join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')]
  for (const candidate of candidates) { try { await access(candidate, constants.R_OK); return resolve(candidate) } catch {} }
  throw new Error('npm CLI not found beside Node; use an official Node installation with npm')
}

export function auditSummary(report) {
  const counts = report?.metadata?.vulnerabilities
  if (!counts || ['high', 'critical', 'moderate', 'low'].some(level => !Number.isInteger(counts[level]) || counts[level] < 0)) throw new Error('Registry returned an invalid audit report')
  return { high: counts.high, critical: counts.critical, moderate: counts.moderate, low: counts.low,
    blocked: counts.high + counts.critical > 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = await createSnapshot({ dependencies: false })
  const directory = join(snapshot.directory, 'audit-isolated')
  try {
    await mkdir(directory)
    for (const path of ['package.json', 'package-lock.json']) await copyFile(join(snapshot.directory, path), join(directory, path))
    // No project npmrc in this package root; user/global config is also empty.
    const config = join(directory, 'empty.npmrc')
    await writeFile(config, '')
    const result = spawnSync(process.execPath, [await findNpmCli(), 'audit', '--package-lock-only', '--ignore-scripts', '--audit-level=high',
      '--registry=https://registry.npmjs.org/', '--json', '--no-progress', '--no-fund', '--fetch-retries=0', '--fetch-timeout=45000'], {
      cwd: directory, shell: false, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...safeEnvironment(directory), NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_GLOBALCONFIG: join(directory, 'absent-global.npmrc'), NPM_CONFIG_CACHE: join(directory, 'cache') },
    })
    if (result.error || ![0, 1].includes(result.status)) throw new Error('Dependency audit could not complete; this is a failed check')
    let report
    try { report = JSON.parse(result.stdout) } catch { throw new Error('Dependency audit did not return JSON; this is a failed check') }
    if (report.error) {
      const code = typeof report.error.code === 'string' && /^[A-Z0-9_]+$/.test(report.error.code) ? report.error.code : 'UNKNOWN'
      throw new Error(`Registry audit failed (${code}); this is a failed check`)
    }
    const summary = auditSummary(report)
    if (result.status !== 0 && !summary.blocked) throw new Error('Dependency audit returned an unexpected failure; this is a failed check')
    const findings = Object.entries(report.vulnerabilities ?? {}).filter(([, advisory]) => ['high', 'critical'].includes(advisory.severity))
      .map(([name, advisory]) => ({ name, severity: advisory.severity, range: advisory.range, fixAvailable: advisory.fixAvailable,
        advisories: (advisory.via ?? []).filter(value => typeof value === 'object').map(value => ({ title: value.title, url: value.url, range: value.range })) }))
    const reportDirectory = join(repository, '.security-ci.local')
    await mkdir(reportDirectory, { recursive: true })
    await writeFile(join(reportDirectory, 'last-audit.json'), JSON.stringify({ timestamp: new Date().toISOString(), source: 'https://registry.npmjs.org/',
      summary, findings }, null, 2) + '\n')
    console.log(`Dependency audit: critical=${summary.critical}, high=${summary.high}, moderate=${summary.moderate}, low=${summary.low} (runtime and development dependencies).`)
    for (const finding of findings) {
      console.log(`${finding.severity}: ${finding.name}`)
    }
    if (summary.blocked) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally { await snapshot.dispose() }
}
