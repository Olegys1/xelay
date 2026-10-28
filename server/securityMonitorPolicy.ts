/** Presentation allowlist: provider text and database object/user names never enter alerts. */
export const SECURITY_ALERT_POLICY = {
  auth_failures: { severity: 'warning', source: 'auth', title: 'Зросла кількість невдалих відповідей Auth', action: 'Перевірте потоки входу та оновлення сесій. Це сигнал для перевірки, а не підтвердження атаки.' },
  api_errors: { severity: 'warning', source: 'api', title: 'Зросла кількість серверних помилок API', action: 'Перевірте доступність сервісу та останні зміни. Це сигнал про стан сервісу.' },
  access_denials: { severity: 'warning', source: 'api', title: 'Зросла кількість відмов у доступі API', action: 'Перевірте очікувані права доступу та клієнтські запити. Причину ще не встановлено.' },
  storage_denials: { severity: 'warning', source: 'storage', title: 'Зросла кількість відмов у доступі до файлів', action: 'Перевірте правила доступу до сховища та клієнтські запити.' },
  request_volume: { severity: 'warning', source: 'api', title: 'Зросла кількість запитів API', action: 'Порівняйте навантаження зі звичайним. Зростання трафіку саме по собі не доводить DDoS.' },
  rls_disabled: { severity: 'critical', source: 'database', title: 'Порушено перевірку захисту таблиць', action: 'Перевірте наявність захищених таблиць, налаштування RLS і фактичний доступ.' },
  admin_mfa_missing: { severity: 'critical', source: 'database', title: 'Адміністратори без налаштованої MFA', action: 'Перевірте налаштування багатофакторної автентифікації адміністраторів.' },
  admin_role_changed: { severity: 'warning', source: 'database', title: 'Змінився склад адміністраторів', action: 'Перевірте, чи всі зміни адміністративних ролей були заплановані.' },
  logs_unavailable: { severity: 'warning', source: 'monitor', title: 'Моніторинг журналів потребує перевірки', action: 'Частина журналів або потрібних полів недоступна. Перевірте доступ і стан провайдера. Відсутність даних не означає відсутність загроз.' },
} as const

export type SecurityAlertKind = keyof typeof SECURITY_ALERT_POLICY
export type SecurityAlert = {
  lease_token: string; alert_id: string; kind: SecurityAlertKind
  severity: 'warning' | 'critical'; source: 'auth' | 'api' | 'storage' | 'database' | 'monitor'
  event_count: number; total_count: number; threshold: Record<string, unknown>
  window_start: string; window_end: string; created_at: string; occurrences: number
}
export const SECURITY_MONITOR_ADMIN_URL = 'https://www.xelay.ink/admin'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000
const date = (value: unknown) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))

export function validSecurityAlert(value: unknown): value is SecurityAlert {
  if (!object(value) || typeof value.kind !== 'string' || !Object.prototype.hasOwnProperty.call(SECURITY_ALERT_POLICY, value.kind)) return false
  const policy = SECURITY_ALERT_POLICY[value.kind as SecurityAlertKind]
  return typeof value.lease_token === 'string' && UUID.test(value.lease_token) && typeof value.alert_id === 'string' && UUID.test(value.alert_id)
    && value.source === policy.source && value.severity === policy.severity
    && count(value.event_count) && count(value.total_count) && count(value.occurrences) && value.occurrences > 0
    && date(value.window_start) && date(value.window_end) && date(value.created_at)
    && Date.parse(value.window_start) <= Date.parse(value.window_end) && object(value.threshold)
}

function timestamp(value: string) { return new Date(value).toISOString().slice(0, 16).replace('T', ' ') }

/** Plain text only. Every interpolated value is a validated number or normalized timestamp. */
export function formatAdminSecurityAlert(value: unknown): string | null {
  if (!validSecurityAlert(value)) return null
  const policy = SECURITY_ALERT_POLICY[value.kind]
  const numeric = (key: string, max: number) => typeof value.threshold[key] === 'number'
    && Number.isFinite(value.threshold[key]) && Number(value.threshold[key]) >= 0 && Number(value.threshold[key]) <= max
      ? Number(value.threshold[key]) : null
  const minimum = numeric('min_count', 1_000_000_000)
  const ratio = numeric('min_ratio', 1)
  const multiplier = numeric('baseline_multiplier', 1000)
  const threshold = [minimum === null ? '' : `від ${minimum} подій`, ratio ? `від ${Math.round(ratio * 10000) / 100}%` : '', multiplier ? `від ${multiplier}× базового рівня` : ''].filter(Boolean).join(', ')
  const measurement = value.kind === 'logs_unavailable' ? `Неповних або недоступних перевірок поспіль: ${value.event_count}.`
    : value.kind === 'rls_disabled' ? `Проблемних таблиць: ${value.event_count} із ${value.total_count}.`
      : value.kind === 'admin_mfa_missing' ? `Адміністраторів без MFA: ${value.event_count} із ${value.total_count}.`
        : value.kind === 'admin_role_changed' ? 'Зафіксовано зміну адміністративних ролей у цьому періоді.'
          : `Подій: ${value.event_count}. Спостережень джерела: ${value.total_count}.`
  return `${policy.severity === 'critical' ? '🚨 Критично' : '⚠️ Увага'} · Xelay\n${policy.title}\n\n${measurement}\nПеріод UTC: ${timestamp(value.window_start)} — ${timestamp(value.window_end)}.${threshold ? `\nПоріг: ${threshold}.` : ''}\nСпрацювань: ${value.occurrences}.\n\n${policy.action}`
}

export function adminSecurityAlertButtons(projectRef?: string) {
  const url = projectRef && /^[a-z0-9]{20}$/.test(projectRef)
    ? `https://supabase.com/dashboard/project/${projectRef}/logs/explorer` : SECURITY_MONITOR_ADMIN_URL
  return { inline_keyboard: [[{ text: projectRef && /^[a-z0-9]{20}$/.test(projectRef) ? 'Перевірити журнали' : 'Відкрити адміністрування', url }]] }
}
