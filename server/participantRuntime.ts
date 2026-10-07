import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import webpush from 'web-push'

export class ParticipantRuntimeError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function privateParticipantResponse(res: any) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}
export function participantError(res: any, error: unknown) {
  if (error instanceof ParticipantRuntimeError) return res.status(error.status).json({ error: error.message })
  // Endpoint capabilities, VAPID keys, tokens, and private task text never enter logs.
  return res.status(503).json({ error: 'Ця можливість ще недоступна. Спробуйте пізніше.' })
}
export function participantService(deadline?: number): SupabaseClient {
  const url = process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || ''
  if (!/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(url) || !key) throw new ParticipantRuntimeError(503, 'Сервіс ще не налаштований.')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline ? deadline - Date.now() : 8000))) }) },
  })
}
export function authorizeParticipantWorker(req: any) {
  const expected = process.env.PARTICIPANT_WORKER_SECRET || ''
  if (expected.length < 32 || /\s/.test(expected)) throw new ParticipantRuntimeError(503, 'Фоновий сервіс ще не налаштований.')
  const supplied = typeof req.headers?.authorization === 'string' ? req.headers.authorization.match(/^Bearer ([^\s]+)$/)?.[1] : ''
  if (!supplied || !timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest())) {
    throw new ParticipantRuntimeError(401, 'Недозволений запит.')
  }
}
export async function participantActor(req: any, service: SupabaseClient) {
  const token = typeof req.headers?.authorization === 'string' ? req.headers.authorization.match(/^Bearer ([^\s]+)$/)?.[1] : undefined
  if (!token || token.length > 8192) throw new ParticipantRuntimeError(401, 'Увійдіть до свого акаунта.')
  const { data, error } = await service.auth.getUser(token)
  if (error || !data.user?.id) throw new ParticipantRuntimeError(401, 'Увійдіть до свого акаунта.')
  return data.user.id
}
export function requestObject(req: any): Record<string, any> {
  let body: unknown = req.body
  try {
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > 4096) throw new Error('size')
      body = JSON.parse(body)
    }
    if (Buffer.isBuffer(body)) {
      if (body.byteLength > 4096) throw new Error('size')
      body = JSON.parse(body.toString('utf8'))
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 4096) throw new Error('body')
    return body as Record<string, any>
  } catch { throw new ParticipantRuntimeError(400, 'Некоректний запит.') }
}
export function validPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (!url.port || url.port === '443') && url.pathname.length > 1
      && (['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname)
        || /^[a-z0-9.-]+\.push\.apple\.com$/i.test(url.hostname)
        || /^[a-z0-9.-]+\.notify\.windows\.com$/i.test(url.hostname))
  } catch { return false }
}
function pushSettings() {
  const publicKey = process.env.PUSH_VAPID_PUBLIC_KEY || ''
  const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY || ''
  const subject = process.env.PUSH_VAPID_SUBJECT || ''
  if (process.env.PARTICIPANT_PUSH_ENABLED !== 'true' || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)
    || !/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return null
  return { publicKey, privateKey, subject }
}
export async function participantPushConfiguration(service: SupabaseClient) {
  const settings = pushSettings()
  if (process.env.PARTICIPANT_BACKGROUND_ENABLED !== 'true') return { available: false, scheduledAvailable: false, publicKey: null }
  const { data, error } = await service.rpc('xelay_participant_runtime_status')
  const scheduledAvailable = !error && data?.scheduled_enabled === true
  return { available: scheduledAvailable && Boolean(settings), scheduledAvailable, publicKey: scheduledAvailable && settings ? settings.publicKey : null }
}

/** Absolute wall-clock deadline, including DNS, TLS and response draining. */
async function sendParticipantPush(details: { endpoint: string; method: string; headers: Record<string, string | number>; body?: Buffer }) {
  if (!validPushEndpoint(details.endpoint)) throw new Error('PUSH_ENDPOINT_INVALID')
  const endpoint = new URL(details.endpoint)
  await new Promise<void>((resolve, reject) => {
    let request: ClientRequest | undefined
    let settled = false
    const finish = (failure?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure) reject(failure)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(new Error('PUSH_DELIVERY_TIMEOUT'))
      request?.destroy()
    }, 5000)
    try {
      // Native HTTPS does not follow redirects. Capabilities and response
      // bodies are never returned, accumulated or attached to error objects.
      request = httpsRequest(endpoint, { method: details.method, headers: details.headers, agent: false }, (response) => {
        const statusCode = response.statusCode ?? 0
        response.on('error', () => finish(new Error('PUSH_DELIVERY_FAILED')))
        response.on('aborted', () => finish(new Error('PUSH_DELIVERY_FAILED')))
        if (statusCode < 200 || statusCode > 299) {
          const failure = Object.assign(new Error('PUSH_PROVIDER_REJECTED'), { statusCode })
          finish(failure)
          response.destroy()
          request?.destroy()
          return
        }
        response.on('end', () => finish())
        response.resume()
      })
      request.on('error', () => finish(new Error('PUSH_DELIVERY_FAILED')))
      request.end(details.body)
    } catch {
      finish(new Error('PUSH_DELIVERY_FAILED'))
      request?.destroy()
    }
  })
}

export async function dispatchParticipantPush(service: SupabaseClient, deadline: number) {
  const settings = pushSettings()
  if (!settings) return { sent: 0, skipped: 0, retry: 0, enabled: false }
  let sent = 0, skipped = 0, retry = 0
  // Claim one job only when claim/check/provider/final receipt all fit the deadline.
  for (let index = 0; index < 10 && Date.now() + 30000 < deadline; ++index) {
    const { data: jobs, error } = await service.rpc('xelay_claim_participant_push', { p_limit: 1 })
    if (error || !Array.isArray(jobs)) throw new ParticipantRuntimeError(503, 'Push-сервіс ще не підключено.')
    const job = jobs[0]
    if (!job) break
    let status: 'sent' | 'skipped' | 'retry' = 'retry'
    let remove = false
    if (!validPushEndpoint(job.endpoint)) { status = 'skipped'; remove = true }
    else if (Date.now() + 22000 < deadline) {
      // Recheck live user preference, entitlement, device and unread event at the delivery boundary.
      const { data: eligible, error: eligibilityError } = await service.rpc('xelay_participant_push_delivery_allowed', { p_job_id: job.job_id, p_token: job.lock_token })
      if (eligibilityError) status = 'retry'
      else if (eligible !== true) status = 'skipped'
      else if (Date.now() + 14000 < deadline) {
        try {
          const details = webpush.generateRequestDetails({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth_key } }, JSON.stringify({
            userId: job.user_id, title: 'Нагадування Xelay', body: 'У вас є нагадування в особистому органайзері.',
            path: '/organizer', tag: `organizer-${job.notification_id}`,
          }), { vapidDetails: settings, TTL: 3600, contentEncoding: 'aes128gcm', topic: job.notification_id.replace(/-/g, '') })
          await sendParticipantPush(details)
          status = 'sent'
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) { status = 'skipped'; remove = true }
        }
      }
    }
    const { error: finishError } = await service.rpc('xelay_finish_participant_push', {
      p_job_id: job.job_id, p_token: job.lock_token, p_status: status, p_remove_device: remove,
    })
    if (finishError) throw new ParticipantRuntimeError(503, 'Не вдалося підтвердити обробку сповіщень.')
    if (status === 'sent') ++sent
    else if (status === 'skipped') ++skipped
    else ++retry
  }
  return { sent, skipped, retry, enabled: true }
}
