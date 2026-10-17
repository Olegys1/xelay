import { supabase } from './supabase'

export const HALLOWEEN_STARTS_AT = '2026-10-18T09:00:00.000Z'
// Kyiv returns to UTC+2 before the end of the hunt. End is exclusive.
export const HALLOWEEN_ENDS_AT = '2026-11-01T22:00:00.000Z'
export const HALLOWEEN_BADGES_CHANGED = 'xelay:halloween-badges-changed'
export const PUMPKIN_IDS = ['home', 'questions', 'news', 'groups', 'people', 'messages', 'support', 'opportunities', 'subscription', 'profile'] as const
export type HalloweenPumpkinId = typeof PUMPKIN_IDS[number]
export interface HalloweenHuntState {
  campaignId: 'halloween-2026'
  startsAt: string
  endsAt: string
  serverNow: string
  phase: 'upcoming' | 'active' | 'ended'
  eligible: boolean
  ineligibleReason: 'email_unconfirmed' | 'account_unavailable' | null
  collected: HalloweenPumpkinId[]
  completed: boolean
  completedAt: string | null
  badgeEarned: boolean
  showBadge: boolean
  subscriptionWon: boolean
  subscriptionStartsAt: string | null
  subscriptionEndsAt: string | null
  winnersRemaining: number
}
export interface HalloweenCollectionResult extends HalloweenHuntState {
  newlyCollected: boolean
  newlyCompleted: boolean
}

const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isNullableDate = (value: unknown): value is string | null => value === null || isDate(value)
const isPumpkinId = (value: unknown): value is HalloweenPumpkinId => typeof value === 'string' && (PUMPKIN_IDS as readonly string[]).includes(value)
const dataError = () => new Error('Не вдалося перевірити прогрес полювання. Спробуйте ще раз.')

export function parseHalloweenHuntState(value: unknown): HalloweenHuntState {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!row || row.campaignId !== 'halloween-2026' || row.startsAt !== HALLOWEEN_STARTS_AT || row.endsAt !== HALLOWEEN_ENDS_AT
    || !isDate(row.serverNow) || !['upcoming', 'active', 'ended'].includes(row.phase as string)
    || typeof row.eligible !== 'boolean' || ![null, 'email_unconfirmed', 'account_unavailable'].includes(row.ineligibleReason as string | null)
    || (row.eligible !== (row.ineligibleReason === null))
    || !Array.isArray(row.collected) || !row.collected.every(isPumpkinId) || new Set(row.collected).size !== row.collected.length
    || typeof row.completed !== 'boolean' || row.completed !== (row.collected.length === PUMPKIN_IDS.length)
    || !isNullableDate(row.completedAt) || row.completed !== (row.completedAt !== null)
    || typeof row.badgeEarned !== 'boolean' || row.badgeEarned !== row.completed || typeof row.showBadge !== 'boolean'
    || typeof row.subscriptionWon !== 'boolean' || (row.subscriptionWon && !row.completed)
    || !isNullableDate(row.subscriptionStartsAt) || !isNullableDate(row.subscriptionEndsAt)
    || (row.subscriptionStartsAt === null) !== (row.subscriptionEndsAt === null)
    || (!row.subscriptionWon && row.subscriptionStartsAt !== null)
    || (row.subscriptionStartsAt !== null && row.subscriptionEndsAt !== null && Date.parse(row.subscriptionEndsAt) <= Date.parse(row.subscriptionStartsAt))
    || !Number.isInteger(row.winnersRemaining) || (row.winnersRemaining as number) < 0 || (row.winnersRemaining as number) > 10) throw dataError()
  return {
    campaignId: 'halloween-2026', startsAt: row.startsAt, endsAt: row.endsAt, serverNow: row.serverNow,
    phase: row.phase as HalloweenHuntState['phase'], eligible: row.eligible,
    ineligibleReason: row.ineligibleReason as HalloweenHuntState['ineligibleReason'],
    collected: [...row.collected] as HalloweenPumpkinId[], completed: row.completed, completedAt: row.completedAt,
    badgeEarned: row.badgeEarned, showBadge: row.showBadge, subscriptionWon: row.subscriptionWon,
    subscriptionStartsAt: row.subscriptionStartsAt, subscriptionEndsAt: row.subscriptionEndsAt, winnersRemaining: row.winnersRemaining as number,
  }
}

export class HalloweenHuntError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HalloweenHuntError' }
}
function rpcError(error: { message?: string } | null, fallback: string) {
  const messages: Record<string, string> = {
    HALLOWEEN_NOT_STARTED: 'Полювання почнеться 18 жовтня о 12:00 за Києвом.',
    HALLOWEEN_ENDED: 'Полювання вже завершилося. Зібрані бейджі залишаються з вами.',
    HALLOWEEN_TOO_FAST: 'Гарбузик уже близько! Зачекайте пару секунд і натисніть ще раз.',
    HALLOWEEN_EMAIL_UNCONFIRMED: 'Спочатку підтвердьте свою електронну пошту, щоб брати участь у полюванні.',
    HALLOWEEN_BADGE_NOT_EARNED: 'Спочатку зберіть усі 10 гарбузиків, щоб отримати бейдж.',
    HALLOWEEN_UNKNOWN_PUMPKIN: 'Не вдалося впізнати цей гарбузик. Оновіть сторінку.',
  }
  const code = Object.keys(messages).find(candidate => error?.message?.includes(candidate))
  return code ? new HalloweenHuntError(code, messages[code]) : new HalloweenHuntError('HALLOWEEN_REQUEST_FAILED', fallback)
}
const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(HALLOWEEN_BADGES_CHANGED)) }
function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new HalloweenHuntError('HALLOWEEN_REQUEST_ABORTED', 'Запит скасовано. Спробуйте ще раз — збережений прогрес не загубиться.')
}

export async function loadMyHalloweenHunt(signal?: AbortSignal): Promise<HalloweenHuntState> {
  assertNotAborted(signal)
  let request = supabase.rpc('xelay_my_halloween_hunt')
  if (signal) request = request.abortSignal(signal)
  const { data, error } = await request
  assertNotAborted(signal)
  if (error) throw rpcError(error, 'Не вдалося завантажити полювання. Спробуйте ще раз.')
  return parseHalloweenHuntState(data)
}

export async function collectHalloweenPumpkin(id: string, signal?: AbortSignal): Promise<HalloweenCollectionResult> {
  if (!isPumpkinId(id)) throw new HalloweenHuntError('HALLOWEEN_UNKNOWN_PUMPKIN', 'Не вдалося впізнати цей гарбузик.')
  assertNotAborted(signal)
  let request = supabase.rpc('xelay_collect_halloween_pumpkin', { p_pumpkin_id: id })
  if (signal) request = request.abortSignal(signal)
  const { data, error } = await request
  assertNotAborted(signal)
  if (error) throw rpcError(error, 'Не вдалося зберегти гарбузик. Спробуйте ще раз — прогрес не загубиться.')
  const state = parseHalloweenHuntState(data)
  if (!data || typeof data.newlyCollected !== 'boolean' || typeof data.newlyCompleted !== 'boolean'
    || (data.newlyCompleted && (!data.newlyCollected || !state.completed)) || !state.collected.includes(id as HalloweenPumpkinId)) throw dataError()
  if (data.newlyCompleted) changed()
  return { ...state, newlyCollected: data.newlyCollected, newlyCompleted: data.newlyCompleted }
}

export async function saveMyHalloweenBadge(visible: boolean, signal?: AbortSignal): Promise<HalloweenHuntState> {
  if (typeof visible !== 'boolean') throw new Error('Перевірте вибір бейджа.')
  assertNotAborted(signal)
  let request = supabase.rpc('xelay_set_my_halloween_badge', { p_visible: visible })
  if (signal) request = request.abortSignal(signal)
  const { data, error } = await request
  assertNotAborted(signal)
  if (error) throw rpcError(error, 'Не вдалося зберегти бейдж. Попередній вибір збережено.')
  const state = parseHalloweenHuntState(data)
  if (!state.badgeEarned || state.showBadge !== visible) throw dataError()
  changed()
  return state
}

export async function loadHalloweenBadge(userId: string, signal?: AbortSignal): Promise<boolean> {
  assertNotAborted(signal)
  if (!userId) return false
  let request = supabase.rpc('xelay_halloween_badge', { p_user_id: userId })
  if (signal) request = request.abortSignal(signal)
  const { data, error } = await request
  assertNotAborted(signal)
  if (error) throw new Error('Не вдалося завантажити бейдж.')
  if (typeof data !== 'boolean') throw dataError()
  return data
}
