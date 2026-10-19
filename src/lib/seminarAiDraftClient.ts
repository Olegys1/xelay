import { supabase } from './supabase'
import {
  normalizeSeminarAiDraft, normalizeSeminarAiInput,
  type SeminarAiDraftResult, type SeminarAiInput,
} from './seminarAiDraft'

const ENDPOINT = '/api/seminars/draft'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMED_OUT = 'Підготовка чернетки триває задовго. Спробуйте ще раз або скоротіть текст.'
const ACCOUNT_CHANGED = 'Акаунт змінився. Відкрийте завдання знову.'
const NOT_CONNECTED = 'Помічник поки недоступний. Можна заповнити завдання вручну.'

export type SeminarAiAvailability = { available: boolean; reason?: string }

export class SeminarAiRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'SeminarAiRequestError' }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Скасовано', 'AbortError')
}

async function authorized<T>(groupId: string, currentUserId: string, signal: AbortSignal | undefined, timeout: number,
  operation: (token: string, activeSignal: AbortSignal) => Promise<T>): Promise<T> {
  if (!UUID.test(groupId) || !UUID.test(currentUserId)) throw new Error('Не вдалося визначити групу або акаунт. Оновіть сторінку.')
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted) forward()
  const timer = setTimeout(() => controller.abort(new Error(TIMED_OUT)), timeout)
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (session && session.user.id !== currentUserId)) controller.abort(new Error(ACCOUNT_CHANGED))
  })
  let onAbort: (() => void) | undefined
  try {
    checkAbort(controller.signal)
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => { try { checkAbort(controller.signal) } catch (error) { reject(error) } }
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([interrupted, (async () => {
      const session = await supabase.auth.getSession()
      checkAbort(controller.signal)
      if (session.error || !session.data.session?.access_token || session.data.session.user.id !== currentUserId) throw new Error('Увійдіть у свій акаунт знову, щоб підготувати чернетку.')
      const result = await operation(session.data.session.access_token, controller.signal)
      checkAbort(controller.signal)
      const latest = await supabase.auth.getSession()
      checkAbort(controller.signal)
      if (latest.error || latest.data.session?.user.id !== currentUserId) throw new Error(ACCOUNT_CHANGED)
      return result
    })()])
  } catch (failure) {
    checkAbort(controller.signal)
    if (failure instanceof TypeError) throw new Error('Не вдалося з’єднатися із сервісом. Перевірте інтернет і спробуйте ще раз.')
    throw failure
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    subscription.unsubscribe()
  }
}

async function body(response: Response, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (!(response.headers.get('content-type') || '').includes('application/json')) return null
  const raw = await response.text()
  checkAbort(signal)
  if (raw.length > 150000) throw new Error('Відповідь завелика. Спробуйте підготувати менше питань за раз.')
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function requestError(status: number): SeminarAiRequestError {
  const message = status === 401 ? 'Увійдіть знову, щоб підготувати чернетку.'
    : status === 403 ? 'Підготувати чернетку може староста або заступник із правом редагувати семінари.'
    : status === 429 ? 'Досягнуто ліміт ШІ-чернеток. Спробуйте пізніше або заповніть завдання вручну.'
    : status === 400 ? 'Перевірте текст, формат і кількість учасників або команд.'
    : status === 422 ? 'Не вдалося надійно підготувати чернетку. Уточніть текст або заповніть форму вручну.'
    : NOT_CONNECTED
  return new SeminarAiRequestError(message, status)
}

export async function seminarAiDraftAvailability(groupId: string, currentUserId: string, signal?: AbortSignal): Promise<SeminarAiAvailability> {
  return authorized(groupId, currentUserId, signal, 20000, async (token, activeSignal) => {
    const response = await fetch(`${ENDPOINT}?group_id=${encodeURIComponent(groupId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: activeSignal,
    })
    const value = await body(response, activeSignal)
    if (response.status === 401 || response.status === 403) throw requestError(response.status)
    if (!response.ok || !value || typeof value.available !== 'boolean') return { available: false, reason: NOT_CONNECTED }
    return { available: value.available, reason: typeof value.reason === 'string' && value.reason.length <= 400
      ? value.reason : value.available ? undefined : NOT_CONNECTED }
  })
}

export async function requestSeminarAiDraft(groupId: string, currentUserId: string, input: SeminarAiInput, signal?: AbortSignal): Promise<SeminarAiDraftResult> {
  const normalized = normalizeSeminarAiInput(input)
  return authorized(groupId, currentUserId, signal, 118000, async (token, activeSignal) => {
    const response = await fetch(ENDPOINT, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, ...normalized }), cache: 'no-store', signal: activeSignal,
    })
    const value = await body(response, activeSignal)
    if (!response.ok) throw requestError(response.status)
    if (!value || !('draft' in value)) throw new Error('Не вдалося прочитати чернетку. Спробуйте ще раз або заповніть форму вручну.')
    return normalizeSeminarAiDraft(value.draft, normalized)
  })
}
