import { createHash, timingSafeEqual } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 8192
const REQUEST_TIMEOUT_MS = 8000
const MAX_JOB_AGE_MS = 23 * 60 * 60 * 1000

export class NotificationEmailError extends Error {
  constructor(public status: number, message: string, public configurationFields?: string[]) { super(message) }
}

type EmailConfiguration = { apiKey: string; from: string; origin: string; service: SupabaseClient }
type EmailJob = { id: string; notification_id: string; attempts: number; created_at: string; lock_token: string }
type JobStatus = 'sent' | 'skipped' | 'failed' | 'pending'
type JobResult = { processed: boolean; status?: JobStatus; retryable?: boolean }
type NotificationRecord = {
  id: string; recipient_id: string; type: string; is_read: boolean
  question_id?: string | null; news_post_id?: string | null; study_group_id?: string | null
}

export function notificationPrivateResponse(res: any) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

// This credential is independent of user sessions and is never exposed in Vite.
export function authorizeNotificationWorker(req: any) {
  const expected = process.env.NOTIFICATION_WEBHOOK_SECRET || ''
  if (expected.length < 32 || /\s/.test(expected)) {
    // Only the setting name is logged. Keep the unauthenticated response generic.
    console.error('Notification email configuration: NOTIFICATION_WEBHOOK_SECRET')
    throw new NotificationEmailError(503, 'Надсилання сповіщень ще не налаштовано.')
  }
  const authorization = req.headers?.authorization
  const supplied = typeof authorization === 'string' ? authorization.match(/^Bearer ([^\s]+)$/)?.[1] : undefined
  const actualHash = createHash('sha256').update(supplied || '').digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  if (!supplied || !timingSafeEqual(actualHash, expectedHash)) {
    throw new NotificationEmailError(401, 'Недозволений запит.')
  }
}

export function notificationWebhookJobId(req: any): string {
  let body: unknown = req.body
  try {
    if (typeof body === 'string') {
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new NotificationEmailError(413, 'Запит завеликий.')
      body = JSON.parse(body)
    } else if (Buffer.isBuffer(body)) {
      if (body.byteLength > MAX_BODY_BYTES) throw new NotificationEmailError(413, 'Запит завеликий.')
      body = JSON.parse(body.toString('utf8'))
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_body')
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) throw new NotificationEmailError(413, 'Запит завеликий.')
  } catch (error) {
    if (error instanceof NotificationEmailError) throw error
    throw new NotificationEmailError(400, 'Некоректний запит.')
  }
  const payload = body as Record<string, any>
  // Only the identifier is accepted. Recipient, template and links are read
  // from the database, even when a trusted webhook supplies other fields.
  if (payload.schema !== 'public' || payload.table !== 'notification_email_outbox' || payload.type !== 'INSERT'
    || !payload.record || typeof payload.record.id !== 'string' || !UUID.test(payload.record.id)) {
    throw new NotificationEmailError(400, 'Некоректне завдання сповіщення.')
  }
  return payload.record.id
}

export function notificationEmailConfiguration(): EmailConfiguration {
  const url = process.env.SUPABASE_URL || ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  const apiKey = process.env.RESEND_API_KEY || ''
  const from = process.env.XELAY_EMAIL_FROM || ''
  let origin = ''
  try {
    const parsed = new URL(process.env.XELAY_PUBLIC_URL || '')
    if (parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash
      && !parsed.username && !parsed.password) origin = parsed.origin
  } catch { /* Missing configuration must not send email. */ }
  const configurationFields: string[] = []
  if (process.env.NOTIFICATION_EMAIL_ENABLED !== 'true') configurationFields.push('NOTIFICATION_EMAIL_ENABLED')
  if (!url) configurationFields.push('SUPABASE_URL')
  if (!serviceKey) configurationFields.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!apiKey) configurationFields.push('RESEND_API_KEY')
  if (!origin) configurationFields.push('XELAY_PUBLIC_URL')
  if (!/^Xelay <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(from)) configurationFields.push('XELAY_EMAIL_FROM')
  if (configurationFields.length) {
    // Both handlers authorize the worker before reaching this configuration check.
    // Return setting names only; credentials and their values remain private.
    console.error('Notification email configuration:', configurationFields.join(', '))
    throw new NotificationEmailError(503, 'Надсилання сповіщень ще не налаштовано.', configurationFields)
  }
  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
  })
  return { apiKey, from, origin, service }
}

function safeRecordId(value: unknown): string | null {
  // Questions in the existing project may have text IDs. No supplied value
  // can introduce a path segment, query, scheme or external destination.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
}

function emailContent(notification: NotificationRecord) {
  const question = safeRecordId(notification.question_id)
  const news = safeRecordId(notification.news_post_id)
  const group = safeRecordId(notification.study_group_id)
  const templates: Record<string, { subject: string; message: string; path: string }> = {
    connection_request: { subject: 'Новий запит на спілкування', message: 'Ви отримали новий запит на спілкування. Перегляньте профіль людини та дайте відповідь на платформі.', path: '/profile' },
    connection_accepted: { subject: 'Ваш запит на спілкування прийнято', message: 'Ваш запит прийнято. Особистий чат уже доступний у розділі «Повідомлення».', path: '/messages' },
    message: { subject: 'Нове повідомлення', message: 'Вам надійшло нове особисте повідомлення. Відкрийте Xelay, щоб прочитати його та відповісти.', path: '/messages' },
    answer: { subject: 'Нова відповідь на ваше запитання', message: 'На ваше запитання з’явилася нова відповідь. Перегляньте її та долучайтеся до обговорення.', path: question ? `/question/${question}` : '/categories' },
    comment: { subject: 'Новий коментар', message: 'У вашому обговоренні з’явився новий коментар.', path: question ? `/question/${question}` : '/categories' },
    answer_comment: { subject: 'Новий коментар до відповіді', message: 'До вашої відповіді додали коментар. Перегляньте обговорення на Xelay.', path: question ? `/question/${question}` : '/categories' },
    discussion: { subject: 'Новий коментар до відповіді', message: 'До вашої відповіді додали коментар. Перегляньте обговорення на Xelay.', path: question ? `/question/${question}` : '/categories' },
    news_comment: { subject: 'Новий коментар до новини', message: 'До вашої новини додали новий коментар.', path: news ? `/news/${news}` : '/news' },
    news_submission_published: { subject: 'Вашу новину опубліковано', message: 'Запропоновану вами новину перевірено й опубліковано. Дякуємо, що ділитеся можливостями зі спільнотою.', path: news ? `/news/${news}` : '/news' },
    news_submission_rejected: { subject: 'Результат розгляду вашої новини', message: 'Ваша пропозиція новини не була схвалена. Перегляньте розділ «Новини» на платформі.', path: '/news' },
    editor_request_approved: { subject: 'Редакторський доступ підтверджено', message: 'Вашу заявку схвалено. Тепер ви можете публікувати офіційні новини свого підрозділу.', path: '/news' },
    editor_request_rejected: { subject: 'Результат заявки на редакторський доступ', message: 'Вашу заявку на редакторський доступ не було схвалено.', path: '/news' },
    class_rep_approved: { subject: 'Статус старости підтверджено', message: 'Вашу заявку схвалено. Тепер ви можете створити навчальну групу та керувати її розкладом.', path: '/groups' },
    class_rep_rejected: { subject: 'Результат заявки старости', message: 'Вашу заявку на підтвердження статусу старости не було схвалено.', path: '/profile' },
    group_invite: { subject: 'Запрошення до навчальної групи', message: 'Вас запросили до навчальної групи. Перегляньте запрошення та підтвердьте участь на Xelay.', path: '/groups' },
    group_invite_accepted: { subject: 'Запрошення до групи прийнято', message: 'Учасник прийняв ваше запрошення до навчальної групи.', path: group ? `/groups/${group}` : '/groups' },
    group_homework: { subject: 'Оновлення у навчальній групі', message: 'У вашій навчальній групі оновили тему заняття, домашнє завдання або навчальні матеріали. Перегляньте зміни в розкладі.', path: group ? `/groups/${group}` : '/groups' },
  }
  return Object.prototype.hasOwnProperty.call(templates, notification.type) ? templates[notification.type] : null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
}

function renderEmail(content: NonNullable<ReturnType<typeof emailContent>>, origin: string) {
  const actionUrl = new URL(content.path, origin).href
  const settingsUrl = new URL('/?notifications=settings', origin).href
  const footer = 'Ви отримали цей лист, тому що сповіщення на пошту ввімкнено у вашому обліковому записі Xelay.'
  const subject = `${content.subject} — Xelay`
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#f4f4f6;color:#25252b;font-family:Arial,sans-serif"><div style="max-width:540px;margin:0 auto;padding:32px 24px;background:#ffffff;border:1px solid #e6e6eb;border-radius:20px"><div style="color:#800020;font-family:Georgia,serif;font-size:30px;margin-bottom:28px">Xelay</div><h1 style="font-size:23px;line-height:1.3;margin:0 0 18px">${escapeHtml(content.subject)}</h1><p style="font-size:16px;line-height:1.6;margin:0 0 24px">${escapeHtml(content.message)}</p><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:13px 20px;color:#ffffff;background:#800020;border-radius:24px;text-decoration:none;font-size:15px;font-weight:600">Відкрити Xelay</a><hr style="border:0;border-top:1px solid #e6e6eb;margin:28px 0 18px"><p style="font-size:12px;line-height:1.6;color:#676773;margin:0 0 12px">${escapeHtml(footer)}</p><a href="${escapeHtml(settingsUrl)}" style="font-size:12px;color:#800020">Керувати сповіщеннями</a></div></body></html>`
  const text = `${content.subject}\n\n${content.message}\n\nВідкрити Xelay: ${actionUrl}\n\n${footer}\nКерувати сповіщеннями: ${settingsUrl}`
  return { subject, html, text }
}

async function finishJob(config: EmailConfiguration, job: EmailJob, status: JobStatus, errorCode: string | null = null, providerId: string | null = null) {
  const { data, error } = await config.service.rpc('xelay_finish_notification_email', {
    p_job_id: job.id, p_lock_token: job.lock_token, p_status: status,
    p_error_code: errorCode, p_provider_message_id: providerId,
  })
  if (error || data === false) throw new NotificationEmailError(503, 'Не вдалося зберегти стан сповіщення.')
  return { processed: true, status, retryable: status === 'pending' } as JobResult
}

async function retryJob(config: EmailConfiguration, job: EmailJob, code: string): Promise<JobResult> {
  return finishJob(config, job, job.attempts >= 5 ? 'failed' : 'pending', code)
}

export async function deliverNotificationEmail(config: EmailConfiguration, jobId: string | null = null): Promise<JobResult> {
  const { data, error } = await config.service.rpc('xelay_claim_notification_email', { p_job_id: jobId })
  if (error) throw new NotificationEmailError(503, 'Чергу сповіщень ще не підключено.')
  const job: EmailJob | undefined = Array.isArray(data) ? data[0] : data
  if (!job) return { processed: false }
  if (!UUID.test(job.id) || !UUID.test(job.lock_token)) throw new NotificationEmailError(503, 'Некоректний стан черги сповіщень.')
  const created = new Date(job.created_at).getTime()
  // Resend keeps idempotency keys for 24h. Never retry an uncertain delivery
  // after that window and accidentally send a second copy.
  if (!Number.isFinite(created) || Date.now() - created >= MAX_JOB_AGE_MS) {
    return finishJob(config, job, 'skipped', 'expired')
  }

  try {
    const notificationResult = await config.service.from('notifications').select('*').eq('id', job.notification_id).maybeSingle()
    if (notificationResult.error) return retryJob(config, job, 'notification_lookup_failed')
    const notification = notificationResult.data as NotificationRecord | null
    if (!notification || notification.is_read) return finishJob(config, job, 'skipped', notification ? 'already_read' : 'notification_removed')
    const content = emailContent(notification)
    if (!content) return finishJob(config, job, 'skipped', 'unsupported_type')
    const preferenceResult = await config.service.from('notification_preferences')
      .select('notifications_enabled,email_notifications_enabled').eq('user_id', notification.recipient_id).maybeSingle()
    if (preferenceResult.error) return retryJob(config, job, 'preferences_lookup_failed')
    if (preferenceResult.data?.notifications_enabled === false || preferenceResult.data?.email_notifications_enabled === false) {
      return finishJob(config, job, 'skipped', 'notifications_disabled')
    }

    const userResult = await config.service.auth.admin.getUserById(notification.recipient_id)
    if (userResult.error) {
      if (userResult.error.status === 404) return finishJob(config, job, 'skipped', 'recipient_removed')
      return retryJob(config, job, 'recipient_lookup_failed')
    }
    const user = userResult.data.user
    // Profile email is user editable; only Supabase Auth's verified canonical
    // address is eligible. A pending email change cannot redirect mail.
    if (!user?.email || !user.email_confirmed_at || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(user.email)) {
      return finishJob(config, job, 'skipped', 'email_unverified')
    }
    const rendered = renderEmail(content, config.origin)
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `xelay-notification/${job.id}` },
      body: JSON.stringify({ from: config.from, to: [user.email], ...rendered }),
    })
    let provider: { id?: string; name?: string } = {}
    try { provider = await response.json() } catch { /* Do not log provider payload or recipient PII. */ }
    if (response.ok && typeof provider.id === 'string' && provider.id.length <= 256) {
      return finishJob(config, job, 'sent', null, provider.id)
    }
    const concurrent = response.status === 409 && provider.name === 'concurrent_idempotent_requests'
    if (response.status === 429 || response.status >= 500 || concurrent || response.ok) {
      return retryJob(config, job, concurrent ? 'provider_in_progress' : `provider_${response.status}`)
    }
    // Do not generate a new idempotency key on 409 payload mismatch (e.g.
    // verified address/config changed between retries): that could duplicate.
    return finishJob(config, job, 'failed', `provider_${response.status}`)
  } catch (error) {
    if (error instanceof NotificationEmailError) throw error
    return retryJob(config, job, 'delivery_temporarily_unavailable')
  }
}

export function sendNotificationEmailError(res: any, error: unknown) {
  if (error instanceof NotificationEmailError) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.configurationFields ? { configuration_errors: error.configurationFields } : {}),
    })
  }
  return res.status(503).json({ error: 'Надсилання сповіщень тимчасово недоступне.' })
}
