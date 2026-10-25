import { supabase } from './supabase'
import { normalizeHomeworkAiDraft, normalizeHomeworkAiInput, type HomeworkAiInput, type HomeworkAiDraftResult } from './homeworkAiDraft'

const ENDPOINT = '/api/groups/homework-draft'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNAVAILABLE = 'ШІ для ДЗ поки недоступний. Можна заповнити завдання вручну.'
const TIMED_OUT = 'Підготовка триває задовго. Скоротіть повідомлення або спробуйте пізніше.'
export type HomeworkAiAvailability = { available: boolean; reason?: string }

export class HomeworkAiRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'HomeworkAiRequestError' }
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Скасовано', 'AbortError')
}

async function authorized<T>(groupId: string, currentUserId: string, signal: AbortSignal | undefined, timeout: number,
  operation: (token: string, activeSignal: AbortSignal) => Promise<T>): Promise<T> {
  if (!UUID.test(groupId) || !UUID.test(currentUserId)) throw new Error('Не вдалося визначити групу або акаунт. Оновіть сторінку.')
  const controller = new AbortController(), forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted) forward()
  const timer = setTimeout(() => controller.abort(new Error(TIMED_OUT)), timeout)
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (session && session.user.id !== currentUserId)) controller.abort(new Error('Акаунт змінився. Відкрийте ДЗ знову.'))
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
      if (session.error || !session.data.session?.access_token || session.data.session.user.id !== currentUserId) throw new Error('Увійдіть знову, щоб підготувати чернетку ДЗ.')
      const result = await operation(session.data.session.access_token, controller.signal)
      checkAbort(controller.signal)
      const latest = await supabase.auth.getSession()
      checkAbort(controller.signal)
      if (latest.error || latest.data.session?.user.id !== currentUserId) throw new Error('Акаунт змінився. Чернетку не застосовано.')
      return result
    })()])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    subscription.unsubscribe()
  }
}

async function jsonBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > 150000) { await response.body?.cancel(); throw new Error('Чернетка завелика. Поділіть повідомлення.') }
  if (!response.body) return null
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      checkAbort(signal)
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 150000) throw new Error('Чернетка завелика. Поділіть повідомлення.')
      chunks.push(value)
    }
    checkAbort(signal)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch { return null }
  } finally { await reader.cancel().catch(() => {}) }
}

function requestError(status: number): HomeworkAiRequestError {
  const message = status === 401 ? 'Увійдіть знову, щоб підготувати чернетку ДЗ.'
    : status === 403 ? 'Потрібні права старости або затвердженого заступника на редагування ДЗ цієї групи.'
    : status === 429 ? 'Використано ліміт ШІ-чернеток для ДЗ та семінарів. Спробуйте завтра або заповніть вручну.'
    : status === 400 || status === 413 ? 'Перевірте текст до 12 000 символів і дату вихідного повідомлення.'
    : status === 422 ? 'Не вдалося повністю розібрати повідомлення. Уточніть текст або поділіть його. Чернетку не застосовано.'
    : status === 504 ? TIMED_OUT : UNAVAILABLE
  return new HomeworkAiRequestError(message, status)
}

export async function homeworkAiDraftAvailability(groupId: string, currentUserId: string, signal?: AbortSignal): Promise<HomeworkAiAvailability> {
  return authorized(groupId, currentUserId, signal, 20000, async (token, activeSignal) => {
    const response = await fetch(`${ENDPOINT}?group_id=${encodeURIComponent(groupId)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: activeSignal,
    })
    const value = await jsonBody(response, activeSignal)
    if (response.status === 401 || response.status === 403) throw requestError(response.status)
    if (!response.ok || !value || typeof value.available !== 'boolean') return { available: false, reason: UNAVAILABLE }
    return { available: value.available, reason: typeof value.reason === 'string' && value.reason.length <= 400 ? value.reason : value.available ? undefined : UNAVAILABLE }
  })
}

export async function requestHomeworkAiDraft(groupId: string, currentUserId: string, input: HomeworkAiInput, signal?: AbortSignal): Promise<HomeworkAiDraftResult> {
  const normalized = normalizeHomeworkAiInput(input)
  return authorized(groupId, currentUserId, signal, 118000, async (token, activeSignal) => {
    const response = await fetch(ENDPOINT, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, ...normalized }), cache: 'no-store', signal: activeSignal,
    })
    const value = await jsonBody(response, activeSignal)
    if (!response.ok) throw requestError(response.status)
    if (!value || !('draft' in value)) throw new Error('Не вдалося прочитати чернетку ДЗ. Спробуйте ще раз або заповніть вручну.')
    return normalizeHomeworkAiDraft(value.draft, normalized)
  })
}
