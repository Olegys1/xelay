import { supabase } from './supabase'

export const APPRECIATION_BADGE_KEY = 'community_spark' as const
export const APPRECIATION_BADGE_NAME = 'Іскра Xelay' as const
export const APPRECIATION_BADGES_CHANGED = 'xelay:appreciation-badges-changed'
export const APPRECIATION_GIFT_EVENT = 'xelay-appreciation-gift-open'
export const APPRECIATION_REFRESH_EVENT = 'xelay-appreciation-gift-refresh'
export type AppreciationGift = {
  id: string; notification_id: string; recipient_name: string; offered_at: string
  claimed_at: string | null; valid_from: string | null; valid_until: string | null; newly_claimed: boolean
  badge_key: typeof APPRECIATION_BADGE_KEY; badge_name: typeof APPRECIATION_BADGE_NAME; badge_earned: boolean; badge_visible: boolean
}
export type AppreciationBadgeState = {
  badge_key: typeof APPRECIATION_BADGE_KEY; badge_name: typeof APPRECIATION_BADGE_NAME; earned: boolean; visible: boolean
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
class AppreciationRequestError extends Error {}
const invalid = () => new Error('Не вдалося перевірити подарунок подяки. Оновіть сторінку.')
function date(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 50) return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  return new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))).toISOString().slice(0, 10) === value.slice(0, 10)
}
export function parseAppreciationGift(value: unknown): AppreciationGift {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.notification_id !== 'string' || !UUID.test(item.notification_id)
    || typeof item.recipient_name !== 'string' || item.recipient_name.length > 80 || /[\u0000-\u001f\u007f]/.test(item.recipient_name)
    || item.badge_key !== APPRECIATION_BADGE_KEY || item.badge_name !== APPRECIATION_BADGE_NAME
    || typeof item.badge_earned !== 'boolean' || typeof item.badge_visible !== 'boolean'
    || !date(item.offered_at) || typeof item.newly_claimed !== 'boolean'
    || ![item.claimed_at, item.valid_from, item.valid_until].every(value => value === null || date(value))
    || item.badge_earned !== (item.claimed_at !== null)) throw invalid()
  if (item.claimed_at === null ? item.valid_from !== null || item.valid_until !== null || item.newly_claimed
    : !date(item.valid_from) || !date(item.valid_until) || Date.parse(item.valid_until) <= Date.parse(item.valid_from)) throw invalid()
  return { id: item.id, notification_id: item.notification_id, recipient_name: item.recipient_name, offered_at: item.offered_at,
    claimed_at: item.claimed_at as string | null, valid_from: item.valid_from as string | null, valid_until: item.valid_until as string | null,
    newly_claimed: item.newly_claimed, badge_key: APPRECIATION_BADGE_KEY, badge_name: APPRECIATION_BADGE_NAME,
    badge_earned: item.badge_earned, badge_visible: item.badge_visible }
}
export function parseAppreciationBadgeState(value: unknown): AppreciationBadgeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const row = value as Record<string, unknown>
  if (row.badge_key !== APPRECIATION_BADGE_KEY || row.badge_name !== APPRECIATION_BADGE_NAME
    || typeof row.earned !== 'boolean' || typeof row.visible !== 'boolean') throw invalid()
  return { badge_key: APPRECIATION_BADGE_KEY, badge_name: APPRECIATION_BADGE_NAME, earned: row.earned, visible: row.visible }
}
function check(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Скасовано', 'AbortError')
}
async function rpc(userId: string | null, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (userId !== null && !UUID.test(userId)) throw invalid()
  const controller = new AbortController(), forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true }); if (signal?.aborted) forward()
  const timer = setTimeout(() => controller.abort(new AppreciationRequestError('Відповідь затримується. Перевірте подарунок ще раз: повторна спроба не видасть його двічі.')), 18000)
  const listener = userId ? supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || session && session.user.id !== userId) controller.abort(new AppreciationRequestError('Акаунт змінився. Відкрийте подарунок знову.'))
  }).data.subscription : null
  let rejectAbort: (() => void) | undefined
  try {
    check(controller.signal)
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => { try { check(controller.signal) } catch (error) { reject(error) } }
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([interrupted, (async () => {
      if (userId) {
        const before = await supabase.auth.getSession(); check(controller.signal)
        if (before.error || before.data.session?.user.id !== userId) throw new AppreciationRequestError('Увійдіть у свій акаунт, щоб відкрити подарунок.')
      }
      const result = await supabase.rpc(name, args).abortSignal(controller.signal); check(controller.signal)
      if (userId) {
        const after = await supabase.auth.getSession(); check(controller.signal)
        if (after.error || after.data.session?.user.id !== userId) throw new AppreciationRequestError('Акаунт змінився. Відкрийте подарунок знову.')
      }
      if (result.error) {
        const message = typeof result.error.message === 'string' ? result.error.message : ''
        if (/ADMIN|MFA/.test(message)) throw new AppreciationRequestError('Потрібен підтверджений вхід адміністратора з двоетапним захистом.')
        if (/UNAVAILABLE|AUTH_REQUIRED|FORBIDDEN|NOT_EARNED/.test(message)) throw new AppreciationRequestError('Подарунок або відзнака недоступні для цього акаунта.')
        throw new AppreciationRequestError('Не вдалося перевірити подарунок подяки. Спробуйте ще раз пізніше.')
      }
      return result.data
    })()])
  } catch (problem) {
    check(controller.signal)
    if (problem instanceof AppreciationRequestError) throw problem
    throw new AppreciationRequestError('Не вдалося перевірити подарунок подяки. Спробуйте ще раз пізніше.')
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', forward)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    listener?.unsubscribe()
  }
}
const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(APPRECIATION_BADGES_CHANGED)) }
export async function loadAppreciationGifts(userId: string, signal?: AbortSignal): Promise<AppreciationGift[]> {
  const result = await rpc(userId, 'xelay_my_appreciation_gifts', {}, signal)
  if (!Array.isArray(result) || result.length > 20) throw invalid()
  const gifts = result.map(parseAppreciationGift)
  if (new Set(gifts.map(gift => gift.id)).size !== gifts.length || new Set(gifts.map(gift => gift.notification_id)).size !== gifts.length) throw invalid()
  return gifts
}
export async function claimAppreciationGift(userId: string, giftId: string, signal?: AbortSignal): Promise<AppreciationGift> {
  if (!UUID.test(giftId)) throw invalid()
  const result = parseAppreciationGift(await rpc(userId, 'xelay_claim_appreciation_gift', { p_gift_id: giftId }, signal))
  if (result.id !== giftId || !result.claimed_at) throw invalid()
  changed(); return result
}
export async function offerAppreciationGift(adminId: string, targetUserId: string, signal?: AbortSignal, greetingName = ''): Promise<AppreciationGift> {
  if (!UUID.test(targetUserId) || typeof greetingName !== 'string' || greetingName.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(greetingName)) throw invalid()
  return parseAppreciationGift(await rpc(adminId, 'xelay_admin_offer_appreciation_gift', { p_user_id: targetUserId, p_greeting_name: greetingName.trim() }, signal))
}
export async function loadMyAppreciationBadge(userId: string, signal?: AbortSignal): Promise<AppreciationBadgeState> {
  return parseAppreciationBadgeState(await rpc(userId, 'xelay_my_appreciation_badge', {}, signal))
}
export async function saveMyAppreciationBadge(userId: string, visible: boolean, signal?: AbortSignal): Promise<AppreciationBadgeState> {
  if (typeof visible !== 'boolean') throw invalid()
  const result = parseAppreciationBadgeState(await rpc(userId, 'xelay_set_my_appreciation_badge', { p_visible: visible }, signal))
  if (!result.earned || result.visible !== visible) throw invalid()
  changed(); return result
}
export async function loadAppreciationBadge(targetUserId: string, signal?: AbortSignal): Promise<boolean> {
  if (!UUID.test(targetUserId)) throw invalid()
  const result = await rpc(null, 'xelay_appreciation_badge', { p_user_id: targetUserId }, signal)
  if (typeof result !== 'boolean') throw invalid()
  return result
}
export function openAppreciationGift(userId: string, notificationId: string) {
  if (UUID.test(userId) && UUID.test(notificationId) && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(APPRECIATION_GIFT_EVENT, { detail: { userId, notificationId } }))
}
