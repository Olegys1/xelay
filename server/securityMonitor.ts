import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { adminSecurityAlertButtons, formatAdminSecurityAlert, validSecurityAlert } from './securityMonitorPolicy.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BYTES = 65536
const RPC_TIMEOUT_MS = 3000
const LOG_TIMEOUT_MS = 6000
const TELEGRAM_TIMEOUT_MS = 5000
const MAX_RUN_MS = 34000
const WINDOW_MS = 300000
type Coverage = 'healthy' | 'partial' | 'unavailable' | 'not_configured'
type SourceCoverage = 'observed' | 'no_events' | 'unknown_status' | 'unavailable' | 'not_configured' | 'not_checked'
type Sources = { api: SourceCoverage; auth: SourceCoverage; storage: SourceCoverage }
type Observation = { kind: 'auth_failures' | 'api_errors' | 'access_denials' | 'storage_denials' | 'request_volume'; count: number; total: number; unknown_status: number }
type Due = { lease_token: string; window_start: string; window_end: string; logs_retry_at?: string | null }
type LogsResult = { coverage: Coverage; observations: Observation[]; error_code: string | null; retry_after_seconds: number | null; sources: Sources }
type Settings = { service: SupabaseClient; botToken: string; chatId: string; deadline: number; projectRef: string; logsToken: string }
export type AdminSecurityAlertResult = {
  enabled: boolean; processed: boolean
  state: 'disabled' | 'not_configured' | 'idle' | 'sent' | 'skipped' | 'retry' | 'unavailable' | 'receipt_unavailable' | 'deadline'
  logs_coverage: Coverage | 'not_checked'; logs_sources: Sources
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const sourceFlags = (value: SourceCoverage): Sources => ({ api: value, auth: value, storage: value })
const result = (state: AdminSecurityAlertResult['state'], enabled = true, processed = false, logs?: LogsResult): AdminSecurityAlertResult => ({ enabled, processed, state, logs_coverage: logs?.coverage ?? 'not_checked', logs_sources: logs?.sources ?? sourceFlags('not_checked') })
const timeout = (deadline: number, limit: number) => Math.max(1, Math.min(limit, deadline - Date.now()))

function configuration(deadline: number): Settings | null {
  const botToken = process.env.ADMIN_ALERT_TELEGRAM_BOT_TOKEN || ''
  const chatId = process.env.ADMIN_ALERT_TELEGRAM_CHAT_ID || ''
  const url = process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  if (!/^[1-9][0-9]{5,14}:[A-Za-z0-9_-]{30,64}$/.test(botToken)
    || !/^-[1-9][0-9]{0,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || Math.abs(Number(chatId)) >= 2 ** 52
    || !/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(url) || !key) return null
  try {
    const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout(deadline, RPC_TIMEOUT_MS)) }),
    } })
    // Bind log collection and investigation links to this database's canonical
    // project URL. A typo, another project's ref or a custom domain cannot
    // silently select a different project's logs. Independent DB checks remain available.
    const canonicalRef = /^https:\/\/([a-z0-9]{20})\.supabase\.co(?::443)?\/?$/.exec(url)?.[1] || ''
    const explicitRef = process.env.SECURITY_MONITOR_PROJECT_REF || ''
    const projectRef = canonicalRef && (!explicitRef || explicitRef === canonicalRef) ? canonicalRef : ''
    const logsToken = process.env.SECURITY_MONITOR_SUPABASE_LOGS_TOKEN || ''
    return { service, botToken, chatId, deadline, projectRef, logsToken }
  } catch { return null }
}

async function boundedJson(response: Response): Promise<Record<string, any> | null> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); return null }
  const reader = response.body?.getReader()
  if (!reader) return null
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const buffer = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer))
    return object(parsed) ? parsed : null
  } catch { return null } finally { reader.releaseLock() }
}

function validDue(value: unknown): value is Due {
  if (!object(value) || typeof value.lease_token !== 'string' || !UUID.test(value.lease_token)) return false
  const start = typeof value.window_start === 'string' && value.window_start.length <= 40 ? Date.parse(value.window_start) : NaN
  const end = typeof value.window_end === 'string' && value.window_end.length <= 40 ? Date.parse(value.window_end) : NaN
  return Number.isFinite(start) && Number.isFinite(end) && start % WINDOW_MS === 0 && end - start === WINDOW_MS
    && end <= Date.now() && end >= Date.now() - 86400000
    && (value.logs_retry_at == null || (typeof value.logs_retry_at === 'string' && value.logs_retry_at.length <= 40 && Number.isFinite(Date.parse(value.logs_retry_at))))
}

// One fixed aggregate query, never supplied by a request or environment variable.
// ClickHouse logs API, verified against Supabase's October 2026 API / observability docs:
// https://supabase.com/docs/reference/api/v1-get-project-logs
// https://supabase.com/docs/guides/observability/advanced-log-filtering
// https://supabase.com/docs/guides/storage/debugging/logs
// Sources are separate observations: API Gateway and Auth counts are NEVER added.
export const SECURITY_MONITOR_LOG_SQL = `SELECT source, count() AS total,
  countIf(status BETWEEN 400 AND 599) AS failures,
  countIf(status BETWEEN 500 AND 599) AS server_errors,
  countIf(status IN (401, 403)) AS access_denials,
  countIf(status IS NULL OR status < 100 OR status > 599) AS unknown_status
FROM (
  SELECT source, toInt32OrNull(multiIf(source = 'edge_logs', log_attributes['response.status_code'],
    source = 'storage_logs', log_attributes['res.statusCode'], log_attributes['status'])) AS status
  FROM logs WHERE source IN ('edge_logs', 'auth_logs', 'storage_logs')
) GROUP BY source ORDER BY source LIMIT 3`

function parseLogRows(value: unknown): Pick<LogsResult, 'observations' | 'sources'> | null {
  if (!Array.isArray(value) || value.length > 3) return null
  const rows = new Map<string, Record<string, number>>()
  const safeCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
    ? value : typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value) && Number(value) <= 1_000_000_000 ? Number(value) : null
  for (const raw of value) {
    if (!object(raw) || !['edge_logs', 'auth_logs', 'storage_logs'].includes(raw.source) || rows.has(raw.source)) return null
    const row: Record<string, number> = {}
    for (const key of ['total', 'failures', 'server_errors', 'access_denials', 'unknown_status']) {
      const number = safeCount(raw[key]); if (number === null) return null
      row[key] = number
    }
    if (row.failures + row.unknown_status > row.total || row.server_errors > row.failures || row.access_denials > row.failures) return null
    rows.set(raw.source, row)
  }
  const zero = { total: 0, failures: 0, server_errors: 0, access_denials: 0, unknown_status: 0 }
  const api = rows.get('edge_logs') || zero, auth = rows.get('auth_logs') || zero, storage = rows.get('storage_logs') || zero
  const metric = (kind: Observation['kind'], row: typeof zero, count: number, statusMatters = true): Observation => ({ kind, count, total: row.total, unknown_status: statusMatters ? row.unknown_status : 0 })
  const flag = (row: typeof zero): SourceCoverage => !row.total ? 'no_events' : row.unknown_status ? 'unknown_status' : 'observed'
  return { observations: [metric('auth_failures', auth, auth.failures), metric('api_errors', api, api.server_errors), metric('access_denials', api, api.access_denials), metric('storage_denials', storage, storage.access_denials), metric('request_volume', api, api.total, false)], sources: { api: flag(api), auth: flag(auth), storage: flag(storage) } }
}

/** Aggregate-only collector: no raw records, status/error text, identities, paths or IPs leave this function. */
export async function collectSecurityMonitorLogs(settings: Pick<Settings, 'projectRef' | 'logsToken' | 'deadline'>, due: Due): Promise<LogsResult> {
  const failure = (coverage: Coverage, code: string, retry: number | null = null): LogsResult => ({ coverage, error_code: code, retry_after_seconds: retry, observations: [], sources: sourceFlags(coverage === 'not_configured' ? 'not_configured' : 'unavailable') })
  if (!/^[a-z0-9]{20}$/.test(settings.projectRef) || !settings.logsToken || settings.logsToken.length > 4096 || /\s/.test(settings.logsToken)) return failure('not_configured', 'logs_not_configured', 3600)
  if (!validDue(due)) return failure('unavailable', 'logs_window_mismatch', 300)
  if (due.logs_retry_at && Date.parse(due.logs_retry_at) > Date.now()) return failure('unavailable', 'logs_unavailable', Math.min(86400, Math.max(1, Math.ceil((Date.parse(due.logs_retry_at) - Date.now()) / 1000))))
  if (Date.now() + LOG_TIMEOUT_MS + RPC_TIMEOUT_MS > settings.deadline) return failure('unavailable', 'logs_timeout', 300)
  try {
    const url = new URL(`https://api.supabase.com/v1/projects/${settings.projectRef}/analytics/endpoints/logs`)
    url.search = new URLSearchParams({ sql: SECURITY_MONITOR_LOG_SQL, iso_timestamp_start: new Date(due.window_start).toISOString(), iso_timestamp_end: new Date(due.window_end).toISOString() }).toString()
    const response = await fetch(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${settings.logsToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout(settings.deadline, LOG_TIMEOUT_MS)) })
    if (response.status !== 200) {
      const retry = response.headers.get('retry-after')
      const seconds = retry && /^[0-9]{1,8}$/.test(retry) ? Math.min(86400, Math.max(1, Number(retry))) : null
      await response.body?.cancel().catch(() => {})
      if (response.status === 429) return failure('unavailable', 'logs_rate_limited', seconds ?? 900)
      if (response.status === 402) return failure('unavailable', 'logs_payment_required', 21600)
      if ([401, 403].includes(response.status)) return failure('unavailable', response.status === 401 ? 'logs_unauthorized' : 'logs_forbidden', 3600)
      return failure('unavailable', 'logs_unavailable', 900)
    }
    const body = await boundedJson(response)
    if (!body || (body.error !== undefined && body.error !== null && body.error !== '')) return failure('unavailable', 'logs_invalid_response', 900)
    const aggregate = parseLogRows(body.result)
    if (!aggregate) return failure('unavailable', 'logs_invalid_response', 900)
    const partial = aggregate.observations.some(row => row.unknown_status > 0)
    // A successful query can still lack response statuses. Preserve degraded
    // coverage; fully known independent metrics can still be assessed by SQL.
    // healthy means the aggregate was read, not that every source captured traffic or no threats exist.
    return { coverage: partial ? 'partial' : 'healthy', ...aggregate, error_code: partial ? 'logs_partial' : null, retry_after_seconds: null }
  } catch { return failure('unavailable', 'logs_unavailable', 900) }
}

type TelegramResponse = { status: number; body: Record<string, any> | null }
async function telegram(settings: Settings, method: 'getChat' | 'sendMessage', body: Record<string, unknown>): Promise<TelegramResponse> {
  // Never log/return this URL or provider response: Telegram embeds the secret in its API URL.
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout(settings.deadline, TELEGRAM_TIMEOUT_MS)), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await boundedJson(response) }
}
function telegramFailure(response: TelegramResponse) {
  const code = Number.isInteger(response.body?.error_code) ? response.body!.error_code : response.status
  const retry = response.body?.parameters?.retry_after
  return { code: code === 429 ? 'telegram_rate_limited' : [400, 401, 403, 404].includes(code) ? 'telegram_rejected' : 'telegram_unavailable', retry: code === 429 && Number.isInteger(retry) && retry > 0 ? Math.min(86400, retry) : null }
}
async function finish(settings: Settings, token: string, status: 'sent' | 'failed' | 'skipped', logs: LogsResult | undefined, error: string | null = null, retry: number | null = null) {
  try {
    const receipt = await settings.service.rpc('xelay_finish_admin_security_alert', { p_token: token, p_status: status, p_error_code: error, p_retry_after_seconds: retry })
    return result(receipt.error || receipt.data !== true ? 'receipt_unavailable' : status === 'failed' ? 'retry' : status, true, true, logs)
  } catch { return result('receipt_unavailable', true, true, logs) }
}

/** Called by the existing authorized notification worker; both feature flags default off. */
export async function deliverAdminSecurityAlerts(deadline: number): Promise<AdminSecurityAlertResult> {
  if (process.env.SECURITY_MONITOR_ENABLED !== 'true' || process.env.ADMIN_ALERT_TELEGRAM_ENABLED !== 'true') return result('disabled', false)
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return result('deadline')
  const settings = configuration(Math.min(deadline, Date.now() + MAX_RUN_MS))
  if (!settings) return result('not_configured', false, false, { coverage: 'not_configured', observations: [], error_code: 'logs_not_configured', retry_after_seconds: null, sources: sourceFlags('not_configured') })
  let logs: LogsResult | undefined
  let token: string | undefined
  try {
    if (Date.now() + 4000 > settings.deadline) return result('deadline')
    // This RPC also checks database invariants; it runs even without optional logs credentials.
    const due = await settings.service.rpc('xelay_security_monitor_due')
    if (due.error) return result('unavailable')
    if (due.data) {
      if (!validDue(due.data)) return result('unavailable')
      logs = await collectSecurityMonitorLogs(settings, due.data)
      const observed = await settings.service.rpc('xelay_security_monitor_observe', { p_token: due.data.lease_token, p_observations: logs.observations, p_coverage: logs.coverage, p_error_code: logs.error_code, p_retry_after_seconds: logs.retry_after_seconds })
      if (observed.error || observed.data !== true) return result('unavailable', true, false, logs)
    }
    // Claim only when private-chat validation, live context, send and receipt fit.
    if (Date.now() + 20000 > settings.deadline) return result('deadline', true, false, logs)
    const claim = await settings.service.rpc('xelay_claim_admin_security_alert')
    if (claim.error) return result('unavailable', true, false, logs)
    if (!claim.data) return result('idle', true, false, logs)
    if (!validSecurityAlert(claim.data)) {
      const lease = typeof claim.data?.lease_token === 'string' && UUID.test(claim.data.lease_token) ? claim.data.lease_token : null
      return lease ? finish(settings, lease, 'failed', logs, 'security_monitor_invalid_context') : result('unavailable', true, false, logs)
    }
    token = claim.data.lease_token
    const chat = await telegram(settings, 'getChat', { chat_id: settings.chatId })
    if (chat.status < 200 || chat.status >= 300 || chat.body?.ok !== true) {
      const failure = telegramFailure(chat); return finish(settings, token, 'failed', logs, failure.code, failure.retry)
    }
    const info = chat.body.result
    if (!object(info) || String(info.id) !== settings.chatId || !['group', 'supergroup'].includes(info.type) || info.username
      || (info.active_usernames !== undefined && (!Array.isArray(info.active_usernames) || info.active_usernames.length > 0)) || info.is_direct_messages === true) return finish(settings, token, 'failed', logs, 'telegram_rejected')
    const context = await settings.service.rpc('xelay_admin_security_alert_delivery_context', { p_token: token })
    if (context.error) return finish(settings, token, 'failed', logs, 'telegram_delivery_failed')
    if (!context.data) return finish(settings, token, 'skipped', logs)
    if (!validSecurityAlert(context.data) || context.data.lease_token !== token || context.data.alert_id !== claim.data.alert_id) return finish(settings, token, 'failed', logs, 'security_monitor_invalid_context')
    const text = formatAdminSecurityAlert(context.data)
    if (!text) return finish(settings, token, 'failed', logs, 'security_monitor_invalid_context')
    if (Date.now() + 8500 > settings.deadline) return finish(settings, token, 'failed', logs, 'telegram_delivery_failed')
    const sent = await telegram(settings, 'sendMessage', { chat_id: settings.chatId, text, protect_content: true, disable_notification: false, link_preview_options: { is_disabled: true }, reply_markup: adminSecurityAlertButtons(settings.projectRef) })
    if (sent.status >= 200 && sent.status < 300 && sent.body?.ok === true && Number.isSafeInteger(sent.body.result?.message_id) && sent.body.result.message_id > 0 && String(sent.body.result?.chat?.id) === settings.chatId) {
      // Telegram supplies no send idempotency key. Lost receipts can cause lease retries and duplicates.
      return finish(settings, token, 'sent', logs)
    }
    const failure = telegramFailure(sent)
    return finish(settings, token, 'failed', logs, failure.code, failure.retry)
  } catch { return token ? finish(settings, token, 'failed', logs, 'telegram_transport_error') : result('unavailable', true, false, logs) }
}
