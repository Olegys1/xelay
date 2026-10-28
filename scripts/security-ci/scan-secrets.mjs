import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSnapshot, repository } from './snapshot.mjs'
import { safeEnvironment } from './policy.mjs'

// High-confidence local preflight, deliberately narrower than Gitleaks. Values
// are never returned/logged. Keep test specimens assembled from separate parts.
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}\b/g],
  ['supabase-server-key', /\bsb_secret_[A-Za-z0-9_-]{20,255}\b/g],
  ['telegram-bot-token', /\b[0-9]{6,16}:AA[A-Za-z0-9_-]{30,40}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/g],
  ['credential-in-url', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s@/]{8,}@/g],
  ['literal-provider-secret', /\b(?:SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|RESEND_API_KEY|ADMIN_ALERT_TELEGRAM_BOT_TOKEN)\s*[:=]\s*["'](?!synthetic|fixture|test|example|placeholder|your[-_]|["'])([A-Za-z0-9_-]{28,})["']/g],
]

// Exact, deliberately invalid literals already used by rejection-path tests.
// No file/directory/rule wildcard suppression. Gitleaks still scans these files.
const syntheticLiterals = new Set([
  'sb_secret_never_use_service_credentials',
  'sb_secret_never_pass_into_media',
  'server-only-signing-key-for-test',
])

export function secretFindings(source) {
  const findings = []
  for (const [rule, regex] of rules) {
    regex.lastIndex = 0
    for (const match of source.matchAll(regex)) {
      if (!syntheticLiterals.has(match[1] ?? match[0])) findings.push({ rule, line: source.slice(0, match.index).split('\n').length })
    }
  }
  // Legacy Supabase service-role JWTs are sensitive even without a familiar prefix.
  for (const match of source.matchAll(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}\b/g)) {
    try { if (JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url')).role === 'service_role') findings.push({ rule: 'supabase-service-role-jwt', line: source.slice(0, match.index).split('\n').length }) } catch {}
  }
  return findings
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--offline', '--gitleaks'].includes(arg))) throw new Error('Usage: node scripts/security-ci/scan-secrets.mjs [--offline|--gitleaks]')
  const snapshot = await createSnapshot({ dependencies: false })
  try {
    let count = 0
    for (const path of snapshot.paths) {
      const bytes = await readFile(join(snapshot.directory, path))
      if (bytes.includes(0)) continue // Binary assets: handled by Gitleaks in CI.
      for (const finding of secretFindings(bytes.toString('utf8'))) {
        count++
        console.error(`${path}:${finding.line}: ${finding.rule} [value redacted]`)
      }
    }
    console.log(`Offline secret preflight: ${snapshot.paths.length} selected files, ${count} high-confidence findings. This is not a complete secret detector.`)
    if (count) process.exitCode = 1
    if (args.includes('--gitleaks')) {
      const env = { ...safeEnvironment(snapshot.directory), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: repository.replaceAll('\\', '/') }
      const options = { shell: false, windowsHide: true, encoding: 'utf8', timeout: 150_000, maxBuffer: 2 * 1024 * 1024, env }
      const version = spawnSync('gitleaks', ['version'], options)
      if (version.status !== 0 || version.error || version.stdout.trim() !== '8.30.1') throw new Error('The verified Gitleaks v8.30.1 CLI is required; scan did not pass')
      const config = join(snapshot.directory, 'security-scanner.toml'), ignore = join(snapshot.directory, 'empty.gitleaksignore')
      await writeFile(config, '[extend]\nuseDefault = true\n')
      await writeFile(ignore, '')
      const scannerPolicy = ['--config', config, '--gitleaks-ignore-path', ignore]
      for (const [cwd, scannerArgs] of [
        [snapshot.directory, ['dir', '.', '--redact=100', '--no-banner', '--ignore-gitleaks-allow', '--timeout=120', ...scannerPolicy]],
        [repository, ['git', '.', '--log-opts=--all', '--redact=100', '--no-banner', '--ignore-gitleaks-allow', '--timeout=120', ...scannerPolicy]],
      ]) {
        const result = spawnSync('gitleaks', scannerArgs, { ...options, cwd })
        if (result.status !== 0 || result.error) {
          // Do not echo scanner output; report values and snippets may be sensitive.
          console.error(`Gitleaks ${scannerArgs[0]} scan failed or found secrets (details deliberately withheld).`)
          process.exitCode = 1
        } else console.log(`Gitleaks ${scannerArgs[0]} scan passed (redacted).`)
      }
    }
  } finally { await snapshot.dispose() }
}
