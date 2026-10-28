// Local, read-only demonstration. No credentials, providers, database, or production modules.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = new URL('./security-monitor-preview/', import.meta.url)
const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

async function demoScenarios() {
  // Compile ONLY the pure formatter. The VM has no process, require, fetch or filesystem.
  const source = await readFile(new URL('../server/securityMonitorPolicy.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true })
  if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw Error('PREVIEW_POLICY_INVALID')
  const context = vm.createContext({ exports: {} }, { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(`(function(exports) { ${compiled.outputText} })(exports)`, context, { timeout: 1000 })
  const policy = context.exports
  if (typeof policy.formatAdminSecurityAlert !== 'function') throw Error('PREVIEW_POLICY_MISSING')
  const period = { window_start: '2026-10-28T10:00:00Z', window_end: '2026-10-28T10:05:00Z', created_at: '2026-10-28T10:06:00Z' }
  const alert = (kind, event_count, total_count, threshold) => {
    const meta = policy.SECURITY_ALERT_POLICY[kind]
    const message = policy.formatAdminSecurityAlert({ ...period, lease_token: '11111111-1111-4111-8111-111111111111', alert_id: '22222222-2222-4222-8222-222222222222', kind, severity: meta.severity, source: meta.source, event_count, total_count, threshold, occurrences: 1 })
    if (typeof message !== 'string') throw Error('PREVIEW_FIXTURE_INVALID')
    return message
  }
  return {
    demonstration: true, monitoring_enabled: false, period: '28 жовтня · 10:00–10:05 UTC',
    note: 'Локальний приклад. Вигадані дані. Повідомлення не надсилаються.',
    scenarios: [
      { id: 'quiet', label: 'Звичайна активність', primary: true, coverage: 'healthy', tone: 'calm', title: 'Порогів не перевищено', explanation: 'У цьому прикладі дані отримано, а задані пороги не перетнуто. Це не гарантує відсутність загроз.', count: '4 із 240', countLabel: 'Невдалі відповіді Auth', threshold: 'Поріг: щонайменше 30 подій і 50%', message: null },
      { id: 'auth', label: 'Помилки Auth', primary: true, coverage: 'healthy', tone: 'warning', title: 'Потрібна перевірка автентифікації', explanation: 'Невдалі відповіді Auth можуть стосуватися входу та оновлення сесій. Сигнал сам по собі не підтверджує атаку.', count: '45 із 60', countLabel: 'Невдалі відповіді Auth', threshold: 'Поріг: щонайменше 30 подій і 50%', message: alert('auth_failures', 45, 60, { min_count: 30, min_ratio: .5 }) },
      { id: 'api', label: 'Збій API', primary: true, coverage: 'healthy', tone: 'warning', title: 'Потрібна перевірка стану сервісу', explanation: 'Серверні помилки API — це сигнал про доступність і роботу сервісу. Вони не є доказом атаки.', count: '24 із 160', countLabel: 'Серверні помилки API', threshold: 'Поріг: щонайменше 15 подій і 10%', message: alert('api_errors', 24, 160, { min_count: 15, min_ratio: .1 }) },
      { id: 'rls', label: 'Захист таблиць', primary: true, coverage: 'healthy', tone: 'critical', title: 'Потрібна перевірка захисту даних', explanation: 'Приклад: одна з контрольованих таблиць відсутня або має вимкнений захист рядків. У повідомленні немає назв таблиць.', count: '1 із 12', countLabel: 'Проблемні таблиці', threshold: 'Поріг: щонайменше 1 проблема', message: alert('rls_disabled', 1, 12, { min_count: 1, min_ratio: 0 }) },
      { id: 'mfa', label: 'MFA адміністраторів', primary: true, coverage: 'healthy', tone: 'critical', title: 'Потрібна перевірка MFA', explanation: 'Приклад: один адміністратор не має підтвердженого додаткового фактора. Імена та облікові дані в повідомлення не потрапляють.', count: '1 із 3', countLabel: 'Адміністратори без MFA', threshold: 'Поріг: щонайменше 1 адміністратор', message: alert('admin_mfa_missing', 1, 3, { min_count: 1, min_ratio: 0 }) },
      { id: 'partial', label: 'Неповні журнали', primary: true, coverage: 'partial', tone: 'warning', title: 'Частину подій неможливо оцінити', explanation: 'У деяких записах немає впізнаваного статусу відповіді. Вони не зараховуються до успішних. Після трьох неповних перевірок з’являється попередження.', count: '18 із 80', countLabel: 'Записи без відомого статусу', threshold: 'У прикладі: 3 неповні перевірки поспіль', message: alert('logs_unavailable', 3, 3, { min_count: 3, min_ratio: 0 }) },
      { id: 'not-configured', label: 'Журнали не налаштовано', primary: true, coverage: 'not_configured', tone: 'warning', title: 'Для журналів ще немає даних', explanation: 'Відсутність налаштування не відображається як успішна перевірка. Незалежні перевірки захисту таблиць і MFA можуть продовжуватися.', count: 'Немає даних', countLabel: 'Покриття журналів', threshold: 'У цьому прикладі перша перевірка; повідомлення ще немає', message: null },
      { id: 'access', label: 'Відмови API', coverage: 'healthy', tone: 'warning', title: 'Потрібна перевірка доступу', explanation: 'Відмови 401/403 можуть виникати через звичайні помилки клієнта або налаштування прав. Причину потрібно перевірити.', count: '60 із 150', countLabel: 'Відмови в доступі API', threshold: 'Поріг: щонайменше 50 подій і 30%', message: alert('access_denials', 60, 150, { min_count: 50, min_ratio: .3 }) },
      { id: 'storage', label: 'Доступ до файлів', coverage: 'healthy', tone: 'warning', title: 'Потрібна перевірка доступу до файлів', explanation: 'Окремий приклад відмов сховища. Події різних джерел не додаються до кількості унікальних запитів.', count: '24 із 50', countLabel: 'Відмови в доступі до сховища', threshold: 'Поріг: щонайменше 20 подій і 40%', message: alert('storage_denials', 24, 50, { min_count: 20, min_ratio: .4 }) },
      { id: 'volume', label: 'Зростання трафіку', coverage: 'healthy', tone: 'warning', title: 'Потрібне порівняння навантаження', explanation: 'У прикладі є шість попередніх повних вікон для порівняння. Зростання трафіку саме по собі не доводить DDoS.', count: '3 600', countLabel: 'Запити API за 5 хвилин', threshold: 'Поріг: від 3 000 запитів і понад 5× базового рівня', message: alert('request_volume', 3600, 3600, { min_count: 3000, min_ratio: 0, min_baseline_windows: 6, baseline_multiplier: 5 }) },
      { id: 'role', label: 'Зміна ролей', coverage: 'healthy', tone: 'warning', title: 'Потрібна перевірка адміністративних змін', explanation: 'Приклад фіксує факт зміни ролей у вікні. Він не містить даних адміністратора чи автора зміни.', count: 'Є зміна', countLabel: 'Адміністративні ролі', threshold: 'Один факт зміни за період', message: alert('admin_role_changed', 1, 1, { min_count: 1, min_ratio: 0 }) },
    ],
  }
}

export async function createSecurityMonitorPreviewServer() {
  const [html, css, js, demos] = await Promise.all([
    readFile(new URL('index.html', directory)), readFile(new URL('preview.css', directory)),
    readFile(new URL('preview.js', directory)), demoScenarios(),
  ])
  const routes = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: html }],
    ['/preview.css', { type: 'text/css; charset=utf-8', body: css }],
    ['/preview.js', { type: 'text/javascript; charset=utf-8', body: js }],
    ['/demo.json', { type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(demos)) }],
  ])
  return createServer((req, res) => {
    const respond = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
      res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': buffer.byteLength, ...extra })
      res.end(req.method === 'HEAD' ? undefined : buffer)
    }
    if (!/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(req.headers.host || '')) return respond(403, 'Лише локальний перегляд.')
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(405, 'Доступний лише перегляд.', undefined, { Allow: 'GET, HEAD' })
    const route = routes.get(req.url)
    if (!route) return respond(404, 'Сторінку не знайдено.')
    respond(200, route.body, route.type)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await createSecurityMonitorPreviewServer()
  server.on('error', () => { console.error('Не вдалося відкрити локальний порт 3067.'); process.exitCode = 1 })
  server.listen(3067, '127.0.0.1', () => console.log('Локальний приклад безпеки: http://127.0.0.1:3067/'))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close())
}
