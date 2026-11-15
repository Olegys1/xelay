import { normalizeKnuEmail } from './knuEmailPolicy'
import { supabase } from './supabase'

export interface KnuEmailChallenge {
  id: string
  email: string
  expiresAt: string
  resendAt: string
}

export interface KnuAffiliationStatus {
  verifiedEmail: string | null
  verifiedAt: string | null
  authEmailVerified: boolean
  challenge?: KnuEmailChallenge
}

export interface KnuAffiliationClient {
  status(userId: string, signal?: AbortSignal): Promise<KnuAffiliationStatus>
  request(userId: string, email: string, signal?: AbortSignal): Promise<KnuAffiliationStatus>
  verify(userId: string, challengeId: string, code: string, signal?: AbortSignal): Promise<KnuAffiliationStatus>
}

export class KnuAffiliationError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 0, public readonly retryAfterSeconds = 0) {
    super(code)
    this.name = 'KnuAffiliationError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

/** Fail closed when a response is incomplete, malformed or not a KNU address. */
export function parseKnuAffiliationStatus(value: unknown): KnuAffiliationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnuAffiliationError('KNU_EMAIL_RESPONSE_INVALID')
  const row = value as Record<string, unknown>
  const verifiedEmail = row.verifiedEmail === null ? null : typeof row.verifiedEmail === 'string' ? normalizeKnuEmail(row.verifiedEmail) : undefined
  if (verifiedEmail === undefined || row.verifiedEmail !== null && !verifiedEmail
    || typeof row.authEmailVerified !== 'boolean'
    || (verifiedEmail ? !validDate(row.verifiedAt) : row.verifiedAt !== null)) throw new KnuAffiliationError('KNU_EMAIL_RESPONSE_INVALID')
  let challenge: KnuEmailChallenge | undefined
  if (row.challenge !== undefined && row.challenge !== null) {
    if (typeof row.challenge !== 'object' || Array.isArray(row.challenge)) throw new KnuAffiliationError('KNU_EMAIL_RESPONSE_INVALID')
    const pending = row.challenge as Record<string, unknown>
    const email = typeof pending.email === 'string' ? normalizeKnuEmail(pending.email) : null
    if (typeof pending.id !== 'string' || !UUID.test(pending.id) || !email
      || !validDate(pending.expiresAt) || !validDate(pending.resendAt)
      || Date.parse(pending.resendAt) > Date.parse(pending.expiresAt)) throw new KnuAffiliationError('KNU_EMAIL_RESPONSE_INVALID')
    challenge = { id: pending.id, email, expiresAt: pending.expiresAt, resendAt: pending.resendAt }
  }
  return { verifiedEmail: verifiedEmail || null, verifiedAt: verifiedEmail ? row.verifiedAt as string : null, authEmailVerified: row.authEmailVerified, ...(challenge ? { challenge } : {}) }
}

interface AffiliationSession {
  access_token: string
  user: { id: string }
}
export interface KnuAffiliationClientDependencies {
  getSession(): Promise<{ data: { session: AffiliationSession | null }; error: unknown }>
  getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  subscribe?(onIdentity: (userId: string | null) => void): () => void
  fetch: typeof fetch
}

/** The expected account is checked locally; identity is never accepted from a request body. */
export function createKnuAffiliationClient(dependencies: KnuAffiliationClientDependencies): KnuAffiliationClient {
  async function call(userId: string, body?: { action: 'request'; email: string } | { action: 'verify'; challengeId: string; code: string }, signal?: AbortSignal) {
    if (!userId) throw new KnuAffiliationError('AUTH_REQUIRED', 401)
    const controller = new AbortController()
    const abort = () => controller.abort(new KnuAffiliationError('KNU_EMAIL_ABORTED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timeout = setTimeout(() => controller.abort(new KnuAffiliationError('KNU_EMAIL_TIMEOUT')), 20_000)
    const unsubscribe = dependencies.subscribe?.(id => { if (id !== userId) controller.abort(new KnuAffiliationError('KNU_EMAIL_SESSION_CHANGED', 401)) })
    const check = () => { if (controller.signal.aborted) throw controller.signal.reason || new KnuAffiliationError('KNU_EMAIL_ABORTED') }
    async function wait<T>(pending: Promise<T>): Promise<T> {
      check()
      let onAbort: (() => void) | undefined
      try {
        return await Promise.race([pending, new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason || new KnuAffiliationError('KNU_EMAIL_ABORTED'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })])
      } finally { if (onAbort) controller.signal.removeEventListener('abort', onAbort) }
    }
    try {
      check()
      const before = await wait(dependencies.getSession()); check()
      const session = before.data.session
      if (before.error || !session?.access_token || session.user.id !== userId) throw new KnuAffiliationError('AUTH_REQUIRED', 401)
      const verified = await wait(dependencies.getUser(session.access_token)); check()
      if (verified.error || verified.data.user?.id !== userId) throw new KnuAffiliationError('AUTH_REQUIRED', 401)
      const latest = await wait(dependencies.getSession()); check()
      if (latest.error || latest.data.session?.user.id !== userId) throw new KnuAffiliationError('KNU_EMAIL_SESSION_CHANGED', 401)
      const response = await wait(dependencies.fetch('/api/auth/knu-email', {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      })); check()
      const payload: unknown = await wait(response.json().catch(() => null)); check()
      const after = await wait(dependencies.getSession()); check()
      if (after.error || after.data.session?.user.id !== userId) throw new KnuAffiliationError('KNU_EMAIL_SESSION_CHANGED', 401)
      if (!response.ok) {
        const error = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
        const seconds = Number(error.retryAfterSeconds ?? response.headers.get('Retry-After') ?? 0)
        throw new KnuAffiliationError(typeof error.code === 'string' ? error.code : response.status === 401 ? 'AUTH_REQUIRED' : response.status === 429 ? 'KNU_EMAIL_RATE_LIMIT' : 'KNU_EMAIL_UNAVAILABLE', response.status,
          Number.isFinite(seconds) ? Math.max(0, Math.min(86_400, Math.ceil(seconds))) : 0)
      }
      return parseKnuAffiliationStatus(payload)
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason || new KnuAffiliationError('KNU_EMAIL_ABORTED')
      if (error instanceof KnuAffiliationError) throw error
      throw new KnuAffiliationError('KNU_EMAIL_NETWORK')
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); unsubscribe?.()
    }
  }
  return {
    status: (userId, signal) => call(userId, undefined, signal),
    request(userId, value, signal) {
      const email = normalizeKnuEmail(value)
      if (!email) return Promise.reject(new KnuAffiliationError('KNU_EMAIL_INVALID', 400))
      return call(userId, { action: 'request', email }, signal)
    },
    verify(userId, challengeId, code, signal) {
      if (typeof challengeId !== 'string' || !UUID.test(challengeId) || typeof code !== 'string' || !/^\d{6}$/.test(code)) return Promise.reject(new KnuAffiliationError('KNU_EMAIL_CODE_INVALID', 400))
      return call(userId, { action: 'verify', challengeId, code }, signal)
    },
  }
}

export const knuAffiliationClient = createKnuAffiliationClient({
  getSession: () => supabase.auth.getSession(),
  getUser: token => supabase.auth.getUser(token),
  subscribe: onIdentity => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => onIdentity(session?.user.id || null))
    return () => subscription.unsubscribe()
  },
  fetch: (input, init) => globalThis.fetch(input, init),
})

export function knuAffiliationErrorMessage(error: unknown): string {
  const code = error instanceof KnuAffiliationError ? error.code : ''
  switch (code) {
    case 'KNU_EMAIL_INVALID': return 'Вкажіть університетську пошту з адресою @knu.ua, наприклад name@knu.ua.'
    case 'AUTH_REQUIRED': case 'KNU_EMAIL_SESSION_CHANGED': return 'Сесію акаунта змінено або завершено. Увійдіть у свій профіль і повторіть дію.'
    case 'EMAIL_CONFIRMATION_REQUIRED': return 'Спочатку підтвердьте поточну пошту для входу. Потім зможете додати університетську адресу до цього профілю.'
    case 'KNU_EMAIL_IN_USE': return 'Цю університетську адресу вже підключено до іншого акаунта. Зверніться до підтримки, якщо це ваша пошта.'
    case 'KNU_EMAIL_RATE_LIMIT': return 'Листи запитуються надто часто. Зачекайте перед повторною спробою.'
    case 'KNU_EMAIL_CODE_INVALID': return 'Код неправильний. Перевірте шість цифр в останньому листі.'
    case 'KNU_EMAIL_CODE_EXPIRED': return 'Термін дії коду завершився. Запросіть новий лист.'
    case 'KNU_EMAIL_NETWORK': case 'KNU_EMAIL_TIMEOUT': return 'Не вдалося отримати відповідь. Перевірте з’єднання та оновіть статус, перш ніж повторювати дію.'
    case 'KNU_EMAIL_ABORTED': return 'Запит перервано. Оновіть статус і повторіть дію.'
    default: return 'Підтвердження пошти КНУ тимчасово недоступне. Спробуйте пізніше.'
  }
}
