// Keep additions explicit: a busy local checkout can contain unrelated untracked tests.
export const TASK_FILES = Object.freeze([
  '.github/workflows/security-checks.yml',
  '.github/dependabot.yml',
  'docs/security-ci.md',
  'docs/security-monitor.md',
  'scripts/security-ci/policy.mjs',
  'scripts/security-ci/offline-guard.mjs',
  'scripts/security-ci/snapshot.mjs',
  'scripts/security-ci/run.mjs',
  'scripts/security-ci/audit.mjs',
  'scripts/security-ci/scan-secrets.mjs',
  'scripts/security-ci/gitleaks.toml',
  'scripts/security-ci/release-gate.mjs',
  'scripts/security/security-ci.test.mjs',
  'scripts/security/auth-session-security.test.mjs',
  'scripts/security/auth-profile-network.test.mjs',
  'scripts/security/notification-email-delivery.test.mjs',
  'server/notificationRetry.ts',
  'server/securityMonitor.ts',
  'server/securityMonitorPolicy.ts',
  'supabase/setup/security_monitor_20261028.sql',
  'scripts/security/security-monitor-integration.test.mjs',
  'scripts/security/security-monitor-database.test.mjs',
  'scripts/security/security-monitor-fixture.mjs',
  'scripts/security/security-monitor-server.test.mjs',
  'scripts/security/security-monitor-logs.test.mjs',
  'scripts/preview-security-monitor.mjs',
  'scripts/security-monitor-preview/index.html',
  'scripts/security-monitor-preview/preview.css',
  'scripts/security-monitor-preview/preview.js',
  'scripts/security-preview/monitor-preview.test.mjs',
])

// This checkout had these unrelated edits before the security task. Validate
// their HEAD versions locally, without editing or staging the developer's files.
// In CI a committed checkout normally has the same contents as HEAD already.
export const BASELINE_ONLY_FILES = Object.freeze([
  'api/groups/recognize-timetable.ts', 'ios/README.md', 'package-lock.json', 'package.json',
  'src/App.tsx', 'src/components/teaching/LocalTeachingGradesPreview.tsx', 'tsconfig.json', 'vercel.json',
])

export const CORE_TESTS = Object.freeze([
  'scripts/security/security-ci.test.mjs',
  'scripts/security/auth-login-errors.test.mjs',
  'scripts/security/auth-session-security.test.mjs',
  'scripts/security/auth-profile-network.test.mjs',
  'scripts/security/supabase-transport.test.mjs',
  'scripts/security/message-chat-security.test.mjs',
  'scripts/security/admin-mfa.test.mjs',
  'scripts/security/public-content-quota.test.mjs',
  'scripts/security/public-media-managed-storage.test.mjs',
  'scripts/security/homework-ai-server.test.mjs',
  'scripts/security/supporter-tiers-api.test.mjs',
])

export function selectTests(paths, mode = 'core') {
  if (!['core', 'full'].includes(mode)) throw new Error('Mode must be core or full')
  const available = new Set(paths)
  const tests = mode === 'core' ? [...CORE_TESTS,
    ...paths.filter(path => /^scripts\/security\/security-monitor-[^/]+\.test\.mjs$/.test(path)).sort(),
  ] : paths.filter(path => /^scripts\/security\/[^/]+\.test\.mjs$/.test(path)).sort()
  for (const path of tests) if (!available.has(path)) throw new Error(`Required security test missing: ${path}`)
  return tests
}

// Construct, never copy, a child's environment. Do not inherit NODE_OPTIONS,
// npm config, provider credentials, proxy settings, or a developer's home.
export function safeEnvironment(directory, source = process.env) {
  const env = { CI: 'true', NODE_ENV: 'test', TZ: 'UTC', LANG: 'C.UTF-8',
    HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory }
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (source[name]) env[name] = source[name]
  }
  return env
}
