import { supabase } from './supabase'

export type BirthdayGift = {
  id: string; notification_id: string; recipient_name: string; gift_year: number; offered_at: string
  claimed_at: string | null; valid_from: string | null; valid_until: string | null; newly_claimed: boolean
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalid = () => new Error('Не вдалося перевірити подарунок. Оновіть сторінку.')
const date = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 50) return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const day = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
  return day.toISOString().slice(0, 10) === value.slice(0, 10)
}
export function parseBirthdayGift(value: unknown): BirthdayGift {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.notification_id !== 'string' || !UUID.test(item.notification_id)
    || typeof item.recipient_name !== 'string' || item.recipient_name.length > 80 || /[\u0000-\u001f\u007f]/.test(item.recipient_name) || typeof item.gift_year !== 'number' || !Number.isInteger(item.gift_year) || item.gift_year < 2000 || item.gift_year > 2200
    || !date(item.offered_at) || typeof item.newly_claimed !== 'boolean'
    || ![item.claimed_at, item.valid_from, item.valid_until].every(value => value === null || date(value))) throw invalid()
  if (item.claimed_at === null ? item.valid_from !== null || item.valid_until !== null || item.newly_claimed
    : !date(item.valid_from) || !date(item.valid_until) || Date.parse(item.valid_until) <= Date.parse(item.valid_from)) throw invalid()
  return { id: item.id, notification_id: item.notification_id, recipient_name: item.recipient_name, gift_year: item.gift_year, offered_at: item.offered_at,
    claimed_at: item.claimed_at as string | null, valid_from: item.valid_from as string | null, valid_until: item.valid_until as string | null, newly_claimed: item.newly_claimed }
}
function check(signal: AbortSignal) { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Скасовано', 'AbortError') }
async function rpc(userId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!UUID.test(userId)) throw invalid()
  const controller = new AbortController(), forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true }); if (signal?.aborted) forward()
  const timer = setTimeout(() => controller.abort(new Error('Відповідь затримується. Перевірте подарунок ще раз: повторне натискання не видасть його двічі.')), 18000)
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || session && session.user.id !== userId) controller.abort(new Error('Акаунт змінився. Відкрийте подарунок знову.'))
  })
  let rejectAbort: (() => void) | undefined
  try {
    check(controller.signal)
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => { try { check(controller.signal) } catch (error) { reject(error) } }
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([interrupted, (async () => {
      const before = await supabase.auth.getSession(); check(controller.signal)
      if (before.error || before.data.session?.user.id !== userId) throw new Error('Увійдіть у свій акаунт, щоб відкрити подарунок.')
      const result = await supabase.rpc(name, args).abortSignal(controller.signal); check(controller.signal)
      const after = await supabase.auth.getSession(); check(controller.signal)
      if (after.error || after.data.session?.user.id !== userId) throw new Error('Акаунт змінився. Відкрийте подарунок знову.')
      if (result.error) {
        const message = typeof result.error.message === 'string' ? result.error.message : ''
        if (/NOT_FOUND|FORBIDDEN|AUTH_REQUIRED|ACCOUNT_UNAVAILABLE/.test(message)) throw new Error('Подарунок недоступний для цього акаунта.')
        if (/MFA|ADMIN/.test(message)) throw new Error('Потрібен підтверджений вхід адміністратора з двоетапним захистом.')
        throw new Error('Не вдалося перевірити подарунок. Спробуйте ще раз пізніше.')
      }
      return result.data
    })()])
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', forward)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    subscription.unsubscribe()
  }
}
export async function loadBirthdayGifts(userId: string, signal?: AbortSignal): Promise<BirthdayGift[]> {
  const result = await rpc(userId, 'xelay_my_birthday_gifts', {}, signal)
  if (!Array.isArray(result) || result.length > 20) throw invalid()
  const gifts = result.map(parseBirthdayGift)
  if (new Set(gifts.map(gift => gift.id)).size !== gifts.length || new Set(gifts.map(gift => gift.notification_id)).size !== gifts.length) throw invalid()
  return gifts
}
export async function claimBirthdayGift(userId: string, giftId: string, signal?: AbortSignal): Promise<BirthdayGift> {
  if (!UUID.test(giftId)) throw invalid()
  const result = parseBirthdayGift(await rpc(userId, 'xelay_claim_birthday_gift', { p_gift_id: giftId }, signal))
  if (result.id !== giftId || !result.claimed_at) throw invalid()
  return result
}
export async function offerBirthdayGift(adminId: string, targetUserId: string, signal?: AbortSignal, greetingName = ''): Promise<BirthdayGift> {
  if (!UUID.test(targetUserId) || typeof greetingName !== 'string' || greetingName.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(greetingName)) throw invalid()
  return parseBirthdayGift(await rpc(adminId, 'xelay_admin_offer_birthday_gift', { p_user_id: targetUserId, p_greeting_name: greetingName.trim() }, signal))
}
export const BIRTHDAY_GIFT_EVENT = 'xelay-birthday-gift-open'
export const BIRTHDAY_REFRESH_EVENT = 'xelay-birthday-gift-refresh'
export function openBirthdayGift(userId: string, notificationId: string) {
  if (UUID.test(userId) && UUID.test(notificationId)) window.dispatchEvent(new CustomEvent(BIRTHDAY_GIFT_EVENT, { detail: { userId, notificationId } }))
}
