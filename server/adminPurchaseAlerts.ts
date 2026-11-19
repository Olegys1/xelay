import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLANS = {
  participant: 'Учасник (попередній тариф)', group: 'Підписка навчальної групи',
  start: 'Студентський Старт', plus: 'Студентський Плюс', max: 'Студентський Макс',
  teacher_start: 'Викладацький Старт', teacher_plus: 'Викладацький Плюс', teacher_max: 'Викладацький Макс',
} as const
type Purchase = { lease_token: string; order_id: string; plan_id: keyof typeof PLANS; amount: number; currency: 'UAH'; approved_at: string; username: string | null }
type Settings = { service: SupabaseClient; botToken: string; chatId: string; deadline: number }
type State = 'disabled' | 'not_configured' | 'deadline' | 'idle' | 'sent' | 'skipped' | 'retry' | 'unavailable' | 'receipt_unavailable'
const result = (state: State, processed = false) => ({ state, processed, enabled: !['disabled', 'not_configured'].includes(state) })
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const timeout = (s: Settings) => Math.max(1, Math.min(5000, s.deadline - Date.now()))

export function validPurchase(value: unknown): value is Purchase {
  if (!object(value)) return false
  return typeof value.lease_token === 'string' && UUID.test(value.lease_token) && typeof value.order_id === 'string' && UUID.test(value.order_id)
    && typeof value.plan_id === 'string' && Object.prototype.hasOwnProperty.call(PLANS, value.plan_id)
    && typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount > 0 && value.amount <= 1_000_000
    && Math.abs(value.amount * 100 - Math.round(value.amount * 100)) < 0.00001 && value.currency === 'UAH'
    && typeof value.approved_at === 'string' && value.approved_at.length <= 40 && Number.isFinite(Date.parse(value.approved_at))
    && (value.username === null || typeof value.username === 'string' && /^[A-Za-z0-9_]{3,40}$/.test(value.username))
}
export function formatAdminPurchaseAlert(value: unknown): string | null {
  if (!validPurchase(value)) return null
  const date = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value.approved_at))
  return `💳 Xelay · оплачено підписку\n\nТариф: ${PLANS[value.plan_id]}.\nСума: ${value.amount.toFixed(2)} грн.\nПокупець: ${value.username ? '@' + value.username : 'профіль без публічного ніка'}.\nЧас за Києвом: ${date}.\n\nОплату підтверджено. Період доступу визначається з урахуванням попередніх підписок і подарунків.\nЦя оплата не поповнює баланс OpenAI автоматично.\nПокупка: ${value.order_id}.`
}
function configuration(deadline: number): Settings | null {
  const botToken = process.env.ADMIN_ALERT_TELEGRAM_BOT_TOKEN || '', chatId = process.env.ADMIN_ALERT_TELEGRAM_CHAT_ID || ''
  const url = process.env.SUPABASE_URL || '', key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  if (!/^[1-9][0-9]{5,14}:[A-Za-z0-9_-]{30,64}$/.test(botToken) || !/^-[1-9][0-9]{0,15}$/.test(chatId)
    || !Number.isSafeInteger(Number(chatId)) || Math.abs(Number(chatId)) >= 2 ** 52 || !/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(url) || !key) return null
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) }),
  } })
  return { botToken, chatId, service, deadline }
}
async function telegram(s: Settings, method: 'getChat' | 'sendMessage', body: Record<string, unknown>) {
  // Provider URLs contain credentials. Never log URLs, thrown errors or response bodies.
  const response = await fetch(`https://api.telegram.org/bot${s.botToken}/${method}`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(timeout(s)), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const reader = response.body?.getReader()
  if (!reader) return { status: response.status, body: null }
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > 65536) { await reader.cancel(); return { status: response.status, body: null } }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return { status: response.status, body: object(parsed) ? parsed : null }
  } catch { return { status: response.status, body: null } } finally { reader.releaseLock() }
}
async function finish(s: Settings, token: string, status: 'sent' | 'failed' | 'skipped', error: string | null = null, retry: number | null = null) {
  try {
    const receipt = await s.service.rpc('xelay_finish_admin_purchase_alert', { p_token: token, p_status: status, p_error_code: error, p_retry_after_seconds: retry })
    return result(receipt.error || receipt.data !== true ? 'receipt_unavailable' : status === 'failed' ? 'retry' : status, true)
  } catch { return result('receipt_unavailable', true) }
}
function providerFailure(response: Awaited<ReturnType<typeof telegram>>) {
  const code = Number.isInteger(response.body?.error_code) ? response.body!.error_code : response.status
  const retry = response.body?.parameters?.retry_after
  return { code: code === 429 ? 'telegram_rate_limited' : [400, 401, 403, 404].includes(code) ? 'telegram_rejected' : 'telegram_unavailable',
    retry: code === 429 && Number.isInteger(retry) && retry > 0 ? Math.min(86400, retry) : null }
}
/** Existing private admin destination; no new provider, credentials or frontend entry point. */
export async function deliverAdminPurchaseAlert(deadline: number) {
  if (process.env.ADMIN_ALERT_TELEGRAM_ENABLED !== 'true') return result('disabled')
  if (!Number.isFinite(deadline) || Date.now() + 26000 > deadline) return result('deadline')
  let s: Settings | null = null, token: string | undefined
  try {
    s = configuration(Math.min(deadline, Date.now() + 30000))
    if (!s) return result('not_configured')
    const claim = await s.service.rpc('xelay_claim_admin_purchase_alert')
    if (claim.error) return result('unavailable')
    if (!claim.data) return result('idle')
    if (!validPurchase(claim.data)) {
      const lease = typeof claim.data?.lease_token === 'string' && UUID.test(claim.data.lease_token) ? claim.data.lease_token : null
      return lease ? finish(s, lease, 'failed', 'invalid_context') : result('unavailable')
    }
    token = claim.data.lease_token
    const chat = await telegram(s, 'getChat', { chat_id: s.chatId })
    if (chat.status < 200 || chat.status >= 300 || chat.body?.ok !== true) {
      const fail = providerFailure(chat); return finish(s, token, 'failed', fail.code, fail.retry)
    }
    const info = chat.body.result
    if (!object(info) || String(info.id) !== s.chatId || !['group', 'supergroup'].includes(info.type) || info.username
      || (info.active_usernames !== undefined && (!Array.isArray(info.active_usernames) || info.active_usernames.length)) || info.is_direct_messages === true) return finish(s, token, 'failed', 'telegram_rejected')
    const context = await s.service.rpc('xelay_admin_purchase_alert_delivery_context', { p_token: token })
    if (context.error) return finish(s, token, 'failed', 'delivery_unavailable')
    if (!context.data) return finish(s, token, 'skipped')
    if (!validPurchase(context.data) || context.data.lease_token !== token || context.data.order_id !== claim.data.order_id) return finish(s, token, 'failed', 'invalid_context')
    if (Date.now() + 11000 > s.deadline) return finish(s, token, 'failed', 'delivery_unavailable')
    const sent = await telegram(s, 'sendMessage', { chat_id: s.chatId, text: formatAdminPurchaseAlert(context.data), protect_content: true,
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Адміністрування Xelay', url: 'https://www.xelay.ink/admin' }]] } })
    if (sent.status >= 200 && sent.status < 300 && sent.body?.ok === true && Number.isSafeInteger(sent.body.result?.message_id)
      && sent.body.result.message_id > 0 && String(sent.body.result?.chat?.id) === s.chatId) return finish(s, token, 'sent')
    // Callback duplicates are deduplicated by order. Telegram has no idempotency key;
    // a lost send receipt may repeat delivery, with the same visible purchase ID.
    const fail = providerFailure(sent); return finish(s, token, 'failed', fail.code, fail.retry)
  } catch { return s && token ? finish(s, token, 'failed', 'delivery_unavailable') : result('unavailable') }
}
