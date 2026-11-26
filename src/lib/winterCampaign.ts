/** Fixed, cosmetic-only collection. Entitlements and payment prices are not rewards. */
export const WINTER_CAMPAIGN_ID = 'winter-2026' as const
export const WINTER_STARTS_AT = '2026-11-30T22:00:00.000Z'
export const WINTER_ADVENT_ENDS_AT = '2026-12-31T22:00:00.000Z'
export const WINTER_DECORATIONS_ENDS_AT = '2027-01-14T22:00:00.000Z'
export const WINTER_EFFECTS_KEY = 'xelay_winter_2026_effects'
export type WinterRewardKind = 'ornament' | 'scene' | 'mini' | 'keepsake'
export type WinterSymbol = 'star' | 'tree' | 'snowflake' | 'bell' | 'mug' | 'mitten' | 'gift' | 'snowman' | 'moon' | 'heart'
export interface WinterReward { day: number; id: string; name: string; description: string; kind: WinterRewardKind; symbol: WinterSymbol }
const gifts: readonly [string, string, WinterRewardKind, WinterSymbol][] = [
  ['Перша зірочка', 'Маленький початок вашої грудневої колекції.', 'ornament', 'star'],
  ['Тепле вікно', 'Ще одне світло у вашому зимовому містечку.', 'scene', 'moon'],
  ['Какао для Mini', 'Гаряча чашка для довгого зимового вечора.', 'mini', 'mug'],
  ['Сніжинка з паперу', 'У кожної зими свій візерунок.', 'ornament', 'snowflake'],
  ['Маленька ялинка', 'Зелена гостя вашої зимової колекції.', 'scene', 'tree'],
  ['Червоні рукавички', 'Щоб ловити сніжинки було тепліше.', 'mini', 'mitten'],
  ['Дзвінкий грудень', 'Перший тиждень і маленький дзвіночок на згадку.', 'ornament', 'bell'],
  ['Крижана зірка', 'Світла прикраса для вечора, який хочеться запам’ятати.', 'ornament', 'star'],
  ['Сусід сніговик', 'Новий мешканець вашої грудневої колекції.', 'scene', 'snowman'],
  ['Святковий пакунок', 'Найприємніші дрібниці часто ховаються під стрічкою.', 'keepsake', 'gift'],
  ['Мідний дзвіночок', 'Теплий відблиск серед зимових кольорів.', 'ornament', 'bell'],
  ['Шапочка Mini', 'Святкова обновка для маленького помічника.', 'mini', 'mitten'],
  ['Місячна ніч', 'Трохи тиші для вашого зимового містечка.', 'scene', 'moon'],
  ['Друга ялинка', 'Удвох на засніженому подвір’ї затишніше.', 'scene', 'tree'],
  ['Листівка з теплом', 'Невелике нагадування залишити вечір для себе.', 'keepsake', 'heart'],
  ['Золота сніжинка', 'Прикраса, що ловить світло гірлянди.', 'ornament', 'snowflake'],
  ['Зимовий шарф', 'Mini готовий до прогулянки снігом.', 'mini', 'mitten'],
  ['Вогник гірлянди', 'Маленьке світло робить вечір теплішим.', 'ornament', 'star'],
  ['Какао з маршмелоу', 'Ще одна тепла дрібничка у вашій колекції.', 'mini', 'mug'],
  ['Засніжена гілка', 'Тиха зимова прикраса без зайвого блиску.', 'ornament', 'tree'],
  ['Сніговик у шарфі', 'Три тижні грудня і ще один зимовий друг.', 'scene', 'snowman'],
  ['Оксамитова стрічка', 'Бордовий акцент для святкового пакунка.', 'ornament', 'gift'],
  ['Листівка з ялинкою', 'Збережіть маленьку частинку цієї зими.', 'keepsake', 'tree'],
  ['Вечірня зірка', 'Світло для найдовшого зимового вечора.', 'ornament', 'star'],
  ['Різдвяний пакунок', 'Зі святом! Нехай сьогодні буде трохи більше тепла.', 'keepsake', 'gift'],
  ['Срібний дзвіночок', 'Ще одна прикраса до вашої колекції.', 'ornament', 'bell'],
  ['Сніжний ліхтарик', 'Доріжка до теплого дому вже освітлена.', 'scene', 'moon'],
  ['Подарунок для Mini', 'Помічнику теж дістався маленький сюрприз.', 'mini', 'gift'],
  ['Сердечко грудня', 'За всі маленькі хороші моменти цього місяця.', 'keepsake', 'heart'],
  ['Зірка на верхівку', 'Остання прикраса перед святковою ніччю.', 'ornament', 'star'],
  ['Ваша зимова історія', 'Увесь грудень у маленькій колекції Xelay.', 'keepsake', 'gift'],
]
export const WINTER_REWARDS: readonly WinterReward[] = Object.freeze(gifts.map(([name, description, kind, symbol], index) => Object.freeze({ day: index + 1, id: `winter-2026-day-${String(index + 1).padStart(2, '0')}`, name, description, kind, symbol })))
export const WINTER_MILESTONES = Object.freeze([
  { count: 7, id: 'winter-2026-badge-07', name: 'Перші вогники', symbol: 'star' as WinterSymbol },
  { count: 14, id: 'winter-2026-badge-14', name: 'Зимовий затишок', symbol: 'mug' as WinterSymbol },
  { count: 21, id: 'winter-2026-badge-21', name: 'Груднева компанія', symbol: 'snowman' as WinterSymbol },
  { count: 31, id: 'winter-2026-badge-31', name: 'Вся зима з Xelay', symbol: 'tree' as WinterSymbol },
])
export interface WinterAdventState {
  campaignId: typeof WINTER_CAMPAIGN_ID
  userId: string | null
  serverNow: string
  startsAt: string
  endsAt: string
  phase: 'upcoming' | 'active' | 'ended'
  currentDay: number
  eligible: boolean
  ineligibleReason: null | 'guest' | 'email_unconfirmed' | 'account_unavailable'
  claimedDays: number[]
}
export interface WinterAdventClaim extends WinterAdventState { newlyClaimed: boolean }
export function winterPhase(now: number): WinterAdventState['phase'] {
  return now < Date.parse(WINTER_STARTS_AT) ? 'upcoming' : now < Date.parse(WINTER_ADVENT_ENDS_AT) ? 'active' : 'ended'
}
export function winterDay(now: number): number {
  return Number.isFinite(now) ? Math.max(0, Math.min(31, Math.floor((now - Date.parse(WINTER_STARTS_AT)) / 86_400_000) + 1)) : 0
}
export function winterDecorationsAvailable(now: number): boolean {
  return Number.isFinite(now) && now >= Date.parse(WINTER_STARTS_AT) && now < Date.parse(WINTER_DECORATIONS_ENDS_AT)
}
export function winterRouteAllowed(pathname: string): boolean {
  return !/^\/(?:admin|dean|business|auth|reset-password)(?:\/|$)/.test(pathname)
}
export function nextWinterBoundary(now: number): number | null {
  return [WINTER_STARTS_AT, WINTER_ADVENT_ENDS_AT, WINTER_DECORATIONS_ENDS_AT].map(Date.parse).find(value => value > now) ?? null
}
export function parseWinterAdventState(value: unknown): WinterAdventState {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const now = typeof v?.serverNow === 'string' ? Date.parse(v.serverNow) : NaN
  const bad = () => { throw new Error('Не вдалося перевірити зимову колекцію. Спробуйте ще раз.') }
  if (!v || v.campaignId !== WINTER_CAMPAIGN_ID || !Number.isFinite(now)
    || v.startsAt !== WINTER_STARTS_AT || v.endsAt !== WINTER_ADVENT_ENDS_AT
    || v.phase !== winterPhase(now) || v.currentDay !== winterDay(now)
    || !(v.userId === null || typeof v.userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.userId))
    || typeof v.eligible !== 'boolean' || ![null, 'guest', 'email_unconfirmed', 'account_unavailable'].includes(v.ineligibleReason as string | null)
    || v.eligible !== (v.ineligibleReason === null) || v.eligible && v.userId === null
    || (v.userId === null) !== (v.ineligibleReason === 'guest')
    || !Array.isArray(v.claimedDays) || !v.claimedDays.every(day => Number.isInteger(day) && day >= 1 && day <= Number(v.currentDay))
    || new Set(v.claimedDays).size !== v.claimedDays.length || !v.eligible && v.claimedDays.length !== 0) return bad()
  return { campaignId: WINTER_CAMPAIGN_ID, userId: v.userId as string | null, serverNow: v.serverNow as string,
    startsAt: WINTER_STARTS_AT, endsAt: WINTER_ADVENT_ENDS_AT, phase: v.phase as WinterAdventState['phase'], currentDay: v.currentDay as number,
    eligible: v.eligible, ineligibleReason: v.ineligibleReason as WinterAdventState['ineligibleReason'], claimedDays: [...v.claimedDays].sort((a, b) => a - b) }
}
export function parseWinterAdventClaim(value: unknown, day: number): WinterAdventClaim {
  const state = parseWinterAdventState(value)
  if (!state.eligible || state.phase !== 'active' || !Number.isInteger(day) || day < 1 || day > state.currentDay
    || typeof (value as Record<string, unknown>).newlyClaimed !== 'boolean' || !state.claimedDays.includes(day)) throw new Error('Не вдалося підтвердити подарунок. Оновіть колекцію.')
  return { ...state, newlyClaimed: (value as Record<string, unknown>).newlyClaimed as boolean }
}
