import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 65536
const ADMIN_REQUESTS_URL = 'https://www.xelay.ink/admin#class-representative-requests'

type Configuration = { botToken: string; chatId: string; service: SupabaseClient; deadline: number }
type Summary = { lease_token: string; pending_count: number; oldest_pending_at: string }
type TelegramResponse = { status: number; body: Record<string, any> | null }
export type AdminRepresentativeAlertResult = {
  enabled: boolean
  processed: boolean
  state: 'disabled' | 'not_configured' | 'idle' | 'sent' | 'skipped' | 'retry' | 'unavailable' | 'receipt_unavailable' | 'deadline'
}

function configuration(deadline: number): Configuration | null {
  const botToken = process.env.ADMIN_ALERT_TELEGRAM_BOT_TOKEN || ''
  const chatId = process.env.ADMIN_ALERT_TELEGRAM_CHAT_ID || ''
  const url = process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  // Only a numeric group ID is accepted. A username could redirect the alerts
  // to a public chat; getChat below additionally checks the current chat type.
  if (!/^[1-9][0-9]{5,14}:[A-Za-z0-9_-]{30,64}$/.test(botToken)
    || !/^-[1-9][0-9]{0,15}$/.test(chatId)
    || !Number.isSafeInteger(Number(chatId)) || Math.abs(Number(chatId)) >= 2 ** 52
    || !/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(url) || !key) return null
  try {
    const service = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(requestTimeout(deadline)) }) },
    })
    return { botToken, chatId, service, deadline }
  } catch { return null }
}

function requestTimeout(deadline: number) {
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
}

function validSummary(value: unknown): value is Summary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Summary
  return UUID.test(summary.lease_token) && Number.isSafeInteger(summary.pending_count) && summary.pending_count > 0
    && typeof summary.oldest_pending_at === 'string' && Number.isFinite(Date.parse(summary.oldest_pending_at))
}

async function telegramRequest(settings: Configuration, method: 'getChat' | 'sendMessage', body: Record<string, unknown>): Promise<TelegramResponse> {
  // The token is necessarily part of Telegram's API URL. Never log or return
  // the URL, thrown fetch error, provider description, or response body.
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestTimeout(settings.deadline)),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const reader = response.body?.getReader()
  if (!reader) return { status: response.status, body: null }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return { status: response.status, body: null } }
      chunks.push(value)
    }
    const buffer = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer))
    return { status: response.status, body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null }
  } catch {
    return { status: response.status, body: null }
  } finally { reader.releaseLock() }
}

function retryAfter(response: TelegramResponse): number | null {
  const value = response.body?.parameters?.retry_after
  return Number.isInteger(value) && value > 0 ? Math.min(value, 86400) : null
}

function telegramFailure(response: TelegramResponse) {
  const status = Number.isInteger(response.body?.error_code) ? response.body!.error_code : response.status
  if (status === 429) return { code: 'telegram_rate_limited', retryAfter: retryAfter(response) }
  if ([400, 401, 403, 404].includes(status)) return { code: 'telegram_configuration', retryAfter: null }
  return { code: 'telegram_unavailable', retryAfter: null }
}

async function finish(settings: Configuration, token: string, status: 'sent' | 'failed' | 'skipped', errorCode: string | null = null, retryAfterSeconds: number | null = null): Promise<AdminRepresentativeAlertResult> {
  try {
    const { data, error } = await settings.service.rpc('xelay_finish_admin_representative_alert', {
      p_token: token, p_status: status, p_error_code: errorCode, p_retry_after_seconds: retryAfterSeconds,
    })
    if (error || data !== true) return { enabled: true, processed: true, state: 'receipt_unavailable' }
    return { enabled: true, processed: true, state: status === 'failed' ? 'retry' : status }
  } catch { return { enabled: true, processed: true, state: 'receipt_unavailable' } }
}

function alertText(summary: Summary) {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(summary.oldest_pending_at)) / 60000))
  const age = ageMinutes < 60 ? `${ageMinutes} хв` : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)} год` : `${Math.floor(ageMinutes / 1440)} дн`
  return `🔔 Xelay: заявки старост очікують на розгляд\n\nУ черзі: ${summary.pending_count}.\nНайдавніша заявка очікує: ${age}.\n\nПерегляньте заявки й ухваліть рішення на платформі. Нагадування повторюватиметься, доки черга не буде опрацьована.`
}

/** Independent of email settings and user preferences; called only by the authorized worker. */
export async function deliverAdminRepresentativeAlert(deadline: number): Promise<AdminRepresentativeAlertResult> {
  if (process.env.ADMIN_ALERT_TELEGRAM_ENABLED !== 'true') return { enabled: false, processed: false, state: 'disabled' }
  const settings = configuration(Math.min(deadline, Date.now() + 30000))
  if (!settings) return { enabled: false, processed: false, state: 'not_configured' }
  // Claim, private-chat check, live summary, Telegram and receipt each have a
  // five-second cap. No lease is taken when that budget cannot fit.
  if (Date.now() + 26000 > settings.deadline) return { enabled: true, processed: false, state: 'deadline' }
  let token: string | undefined
  try {
    const { data, error } = await settings.service.rpc('xelay_claim_admin_representative_alert')
    if (error) return { enabled: true, processed: false, state: 'unavailable' }
    if (!data) return { enabled: true, processed: false, state: 'idle' }
    if (!validSummary(data)) {
      const lease = typeof data?.lease_token === 'string' && UUID.test(data.lease_token) ? data.lease_token : null
      return lease ? finish(settings, lease, 'failed', 'malformed_queue') : { enabled: true, processed: false, state: 'unavailable' }
    }
    token = data.lease_token
    // Claim before getChat so Telegram's Retry-After can be persisted even if
    // the privacy check is rate limited. No message is sent before this check.
    const chat = await telegramRequest(settings, 'getChat', { chat_id: settings.chatId })
    if (chat.status < 200 || chat.status >= 300 || chat.body?.ok !== true) {
      const failure = telegramFailure(chat)
      return finish(settings, token, 'failed', failure.code, failure.retryAfter)
    }
    const info = chat.body.result
    if (!info || String(info.id) !== settings.chatId || !['group', 'supergroup'].includes(info.type)
      || info.username || (Array.isArray(info.active_usernames) && info.active_usernames.length > 0) || info.is_direct_messages === true) {
      return finish(settings, token, 'failed', 'telegram_chat_not_private')
    }
    const { data: live, error: liveError } = await settings.service.rpc('xelay_admin_representative_alert_delivery_context', { p_token: token })
    if (liveError) return finish(settings, token, 'failed', 'delivery_temporarily_unavailable')
    if (!live) return finish(settings, token, 'skipped')
    if (!validSummary(live) || live.lease_token !== token) return finish(settings, token, 'failed', 'malformed_queue')
    if (Date.now() + 11000 > settings.deadline) return finish(settings, token, 'failed', 'delivery_deadline')
    const response = await telegramRequest(settings, 'sendMessage', {
      chat_id: settings.chatId, text: alertText(live), disable_notification: false,
      protect_content: true, link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Переглянути заявки', url: ADMIN_REQUESTS_URL }]] },
    })
    if (response.status >= 200 && response.status < 300 && response.body?.ok === true
      && Number.isSafeInteger(response.body.result?.message_id) && response.body.result.message_id > 0
      && String(response.body.result?.chat?.id) === settings.chatId) {
      // Telegram has no sendMessage idempotency key. If this receipt is lost,
      // a lease-expiry retry can repeat the summary; never claim exactly once.
      return finish(settings, token, 'sent')
    }
    const failure = telegramFailure(response)
    return finish(settings, token, 'failed', failure.code, failure.retryAfter)
  } catch {
    return token ? finish(settings, token, 'failed', 'delivery_temporarily_unavailable') : { enabled: true, processed: false, state: 'unavailable' }
  }
}
