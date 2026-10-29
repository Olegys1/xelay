import { supabase } from './supabase'

export interface StudyGroupRepresentativeStatus {
  isRepresentative: boolean
  ownedGroupIds: string[]
  availableRequestIds: string[]
  canCreateGroup: boolean
}
export interface StudyGroupRepresentativeTransfer {
  groupId: string
  previousRepresentativeId: string
  representativeId: string
  requestId: string
  transferredAt: string
  replayed: boolean
}
export const representativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const unavailable = () => new Error('Не вдалося перевірити права старости. Оновіть групу та спробуйте ще раз.')
const uncertain = () => new Error('Не вдалося перевірити результат передачі. Оновіть групу або повторіть цю саму дію.')
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !representativeUuid.test(id)) || new Set(value).size !== value.length) throw unavailable()
  return [...value]
}
export function parseRepresentativeStatus(value: unknown): StudyGroupRepresentativeStatus {
  if (!object(value) || typeof value.is_representative !== 'boolean' || typeof value.can_create_group !== 'boolean') throw unavailable()
  const ownedGroupIds = ids(value.owned_group_ids), availableRequestIds = ids(value.available_request_ids)
  if (!value.is_representative && (ownedGroupIds.length || availableRequestIds.length || value.can_create_group)) throw unavailable()
  return { isRepresentative: value.is_representative, ownedGroupIds, availableRequestIds, canCreateGroup: value.can_create_group }
}
export function isRepresentativeStatusMissing(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code || '')
  const message = String((error as { message?: unknown } | null)?.message || '')
  return (code === 'PGRST202' || code === '42883') && message.includes('xelay_my_study_group_representative_status')
}
function transferError(error: unknown): Error {
  const code = String((error as { code?: unknown } | null)?.code || '')
  if (code === 'PGRST202' || code === '42883') return new Error('Передача прав поки недоступна. Спробуйте після оновлення платформи.')
  const message = String((error as { message?: unknown } | null)?.message || '')
  if (/REQUEST_(?:CONFLICT|MISMATCH|REUSED)|IDEMPOTENCY|REPLAY_MISMATCH/.test(message)) return new Error('Цю спробу вже використано для іншої передачі. Оновіть групу перед новою дією.')
  if (/STALE|GROUP_CHANGED|REPRESENTATIVE_CHANGED/.test(message) || code === '40001') return new Error('Староста цієї групи вже змінився. Оновіть сторінку.')
  if (/MEMBER_REQUIRED|TARGET_MEMBER|TARGET_UNAVAILABLE|TARGET_INVALID|TARGET_NOT_ACCEPTED|ACCOUNT_UNAVAILABLE/.test(message)) return new Error('Оберіть чинного учасника цієї групи, який прийняв запрошення.')
  if (/AUTH_REQUIRED/.test(message)) return new Error('Увійдіть у свій акаунт, щоб продовжити.')
  if (/SAME_USER|SELF_TRANSFER/.test(message) || code === '22023') return new Error('Перевірте вибраного учасника та підтвердження передачі.')
  if (code === '42501' || /OWNER_REQUIRED|REPRESENTATIVE_REQUIRED|NOT_OWNER/.test(message)) return new Error('Передавати права може лише поточний староста цієї групи. Оновіть сторінку.')
  return unavailable()
}

/** Account identity is fenced on both sides of the request. A retry must reuse
 * the same request ID; the server owns scope, concurrency and authorization. */
async function rpc(actor: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!representativeUuid.test(actor)) throw unavailable()
  const controller = new AbortController()
  const abort = () => controller.abort(uncertain())
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  const timer = window.setTimeout(abort, 20000)
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_OUT' || session && session.user.id !== actor) abort() })
  const check = () => { if (controller.signal.aborted) throw uncertain() }
  let rejectAbort: (() => void) | undefined
  try {
    check()
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(uncertain())
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([interrupted, (async () => {
      const before = await supabase.auth.getSession().catch(() => { throw uncertain() }); check()
      if (before.error || before.data.session?.user.id !== actor) throw new Error('Увійдіть у свій акаунт, щоб продовжити.')
      let response
      try { response = await supabase.rpc(name, args).abortSignal(controller.signal) } catch { throw uncertain() }
      check()
      const after = await supabase.auth.getSession().catch(() => { throw uncertain() }); check()
      if (after.error || after.data.session?.user.id !== actor) throw new Error('Акаунт змінився. Відкрийте групу ще раз.')
      if (response.error) throw transferError(response.error)
      return response.data
    })()])
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); subscription.unsubscribe() }
}
export async function loadRepresentativeStatus(actor: string, signal?: AbortSignal): Promise<StudyGroupRepresentativeStatus> {
  return parseRepresentativeStatus(await rpc(actor, 'xelay_my_study_group_representative_status', {}, signal))
}
export async function transferStudyGroupRepresentative(actor: string, groupId: string, newRepresentativeId: string, expectedRepresentativeId: string, requestId: string, signal?: AbortSignal): Promise<StudyGroupRepresentativeTransfer> {
  if ([groupId, newRepresentativeId, expectedRepresentativeId, requestId].some(id => !representativeUuid.test(id)) || actor !== expectedRepresentativeId || newRepresentativeId === actor) throw unavailable()
  const value = await rpc(actor, 'xelay_transfer_study_group_representative', { p_group_id: groupId, p_new_representative_id: newRepresentativeId, p_expected_representative_id: expectedRepresentativeId, p_request_id: requestId }, signal)
  if (!object(value) || value.group_id !== groupId || value.previous_representative_id !== expectedRepresentativeId || value.representative_id !== newRepresentativeId || value.request_id !== requestId || typeof value.replayed !== 'boolean'
    || typeof value.transferred_at !== 'string' || value.transferred_at.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value.transferred_at) || !Number.isFinite(Date.parse(value.transferred_at))) throw uncertain()
  return { groupId, previousRepresentativeId: expectedRepresentativeId, representativeId: newRepresentativeId, requestId, transferredAt: value.transferred_at, replayed: value.replayed }
}
