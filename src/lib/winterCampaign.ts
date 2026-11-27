/** Winter 2026: display catalog and validated server calendar state. */
export const WINTER_CAMPAIGN_ID = 'winter-2026' as const
export const WINTER_STARTS_AT = '2026-11-30T22:00:00.000Z'
export const WINTER_ADVENT_ENDS_AT = '2026-12-31T22:00:00.000Z'
export const WINTER_DECORATIONS_ENDS_AT = '2027-01-14T22:00:00.000Z'
export const WINTER_EFFECTS_KEY = 'xelay_winter_2026_effects'
export type WinterRewardKind = 'credits' | 'extension' | 'upgrade' | 'pause' | 'subscription_coupon' | 'friend_coupon' | 'credit_bonus'
export type WinterSymbol = 'star' | 'tree' | 'snowflake' | 'bell' | 'mug' | 'mitten' | 'gift' | 'snowman' | 'moon' | 'heart'
export interface WinterReward { day: number; id: string; name: string; description: string; kind: WinterRewardKind; amount: number; plan?: 'start' | 'plus' | 'max' | 'annual'; maximum?: number }
/** Display catalog only. Server time, entitlement checks and ledger decide every grant. */
export const WINTER_REWARDS: readonly WinterReward[] = Object.freeze([
  {
    "day": 1,
    "id": "winter-2026-day-01",
    "name": "50 бонусних кредитів",
    "description": "Зберіть бонус і активуйте до 31 січня 2027 року за наявності оплаченої підписки з ШІ. Після активації залишок не згорає; використання доступне лише з активною оплаченою підпискою з ШІ.",
    "kind": "credits",
    "amount": 50
  },
  {
    "day": 2,
    "id": "winter-2026-day-02",
    "name": "День до підписки",
    "description": "Додайте один день до чинної оплаченої студентської або викладацької підписки. Ліміт ШІ заново не нараховується.",
    "kind": "extension",
    "amount": 1
  },
  {
    "day": 3,
    "id": "winter-2026-day-03",
    "name": "Старт зі знижкою",
    "description": "Знижка 10% на один оплачений місяць Старту. За весь календар можна використати одну знижку на власну підписку. Окремо можна подарувати один купон другу. Інші знижки не додаються.",
    "kind": "subscription_coupon",
    "amount": 10,
    "plan": "start"
  },
  {
    "day": 4,
    "id": "winter-2026-day-04",
    "name": "День Макса",
    "description": "Один день можливостей Макса поверх оплаченої підписки з ШІ. Якщо вже оплачений Макс, отримаєте додатковий день. Новий місячний ліміт ШІ не нараховується.",
    "kind": "upgrade",
    "amount": 1
  },
  {
    "day": 5,
    "id": "winter-2026-day-05",
    "name": "Подарунок другу",
    "description": "Особистий купон на знижку 10% для друга. Створіть код і передайте його самостійно. Один подарований купон за календар; він не забирає твою власну знижку.",
    "kind": "friend_coupon",
    "amount": 10
  },
  {
    "day": 6,
    "id": "winter-2026-day-06",
    "name": "Плюс зі знижкою",
    "description": "Знижка 10% на один оплачений місяць Плюса. Одна знижка на власну підписку за календар, без поєднання з іншими акціями.",
    "kind": "subscription_coupon",
    "amount": 10,
    "plan": "plus"
  },
  {
    "day": 7,
    "id": "winter-2026-day-07",
    "name": "Пауза на два дні",
    "description": "Призупиніть чинну оплачену підписку на два дні. Платні можливості на цей час недоступні, а строк підписки буде збережено. Можна відновити раніше.",
    "kind": "pause",
    "amount": 2
  },
  {
    "day": 8,
    "id": "winter-2026-day-08",
    "name": "Макс зі знижкою",
    "description": "Знижка 5% на один оплачений місяць Макса. Одна знижка на власну підписку за календар, без поєднання з іншими акціями.",
    "kind": "subscription_coupon",
    "amount": 5,
    "plan": "max"
  },
  {
    "day": 9,
    "id": "winter-2026-day-09",
    "name": "Ще один день",
    "description": "Додайте один день до чинної оплаченої студентської або викладацької підписки. Без повторного нарахування місячного ліміту ШІ.",
    "kind": "extension",
    "amount": 1
  },
  {
    "day": 10,
    "id": "winter-2026-day-10",
    "name": "Рік зі знижкою",
    "description": "Знижка 10% на одну річну оплату. Тариф, остаточну суму та умови можна перевірити перед переходом до оплати. Це одна знижка на підписку за календар.",
    "kind": "subscription_coupon",
    "amount": 10,
    "plan": "annual"
  },
  {
    "day": 11,
    "id": "winter-2026-day-11",
    "name": "Більше кредитів у пакеті",
    "description": "До однієї покупки пакета кредитів студентського Макса додається 5%, але не більше 100 бонусних кредитів. Один бонус до покупки за календар, без поєднання з іншими акціями на пакети.",
    "kind": "credit_bonus",
    "amount": 5,
    "maximum": 100
  },
  {
    "day": 12,
    "id": "winter-2026-day-12",
    "name": "Старт вигідніше",
    "description": "Знижка 20% на один оплачений місяць Старту. Можна використати, якщо власну або отриману від друга знижку на свою підписку за календар ще не використано.",
    "kind": "subscription_coupon",
    "amount": 20,
    "plan": "start"
  },
  {
    "day": 13,
    "id": "winter-2026-day-13",
    "name": "Ще день Макса",
    "description": "Один день можливостей Макса поверх оплаченої підписки з ШІ. Для вже оплаченого Макса це додатковий день. Без нової місячної квоти ШІ.",
    "kind": "upgrade",
    "amount": 1
  },
  {
    "day": 14,
    "id": "winter-2026-day-14",
    "name": "Плюс вигідніше",
    "description": "Знижка 15% на один оплачений місяць Плюса. Одна знижка на власну підписку за календар, без складання з іншими акціями.",
    "kind": "subscription_coupon",
    "amount": 15,
    "plan": "plus"
  },
  {
    "day": 15,
    "id": "winter-2026-day-15",
    "name": "Ще 50 бонусних кредитів",
    "description": "Зберіть бонус і активуйте до 31 січня 2027 року з оплаченою підпискою з ШІ. Нову оплату робити не потрібно, якщо відповідна оплачена підписка вже чинна.",
    "kind": "credits",
    "amount": 50
  },
  {
    "day": 16,
    "id": "winter-2026-day-16",
    "name": "Ще два дні паузи",
    "description": "Призупиніть чинну оплачену підписку на два дні. На час паузи платні можливості не працюють, невикористаний час зберігається.",
    "kind": "pause",
    "amount": 2
  },
  {
    "day": 17,
    "id": "winter-2026-day-17",
    "name": "Макс вигідніше",
    "description": "Знижка 10% на один оплачений місяць Макса. Якщо власну або отриману від друга знижку на свою підписку за календар уже використано, повторно застосувати її не можна.",
    "kind": "subscription_coupon",
    "amount": 10,
    "plan": "max"
  },
  {
    "day": 18,
    "id": "winter-2026-day-18",
    "name": "Другу зі знижкою 15%",
    "description": "Краща пропозиція для друга: 15% на одну оплату підписки. Спершу перевірте умови, потім створіть один особистий код. Код не надсилається автоматично.",
    "kind": "friend_coupon",
    "amount": 15
  },
  {
    "day": 19,
    "id": "winter-2026-day-19",
    "name": "Два дні до підписки",
    "description": "Додайте два дні до чинної оплаченої студентської або викладацької підписки. Місячний ліміт ШІ не скидається.",
    "kind": "extension",
    "amount": 2
  },
  {
    "day": 20,
    "id": "winter-2026-day-20",
    "name": "Рік вигідніше",
    "description": "Знижка 15% на одну річну оплату. Одна спільна знижка на підписку за календар на власну підписку. Ціну й умови буде показано перед оплатою.",
    "kind": "subscription_coupon",
    "amount": 15,
    "plan": "annual"
  },
  {
    "day": 21,
    "id": "winter-2026-day-21",
    "name": "Більше кредитів для роботи",
    "description": "До однієї покупки пакета кредитів студентського Макса додається 10%, але не більше 300 бонусних кредитів. Якщо бонус до покупки за календар уже витрачено, повторно отримати його не можна.",
    "kind": "credit_bonus",
    "amount": 10,
    "maximum": 300
  },
  {
    "day": 22,
    "id": "winter-2026-day-22",
    "name": "Старт зі знижкою 25%",
    "description": "Знижка 25% на один оплачений місяць Старту. Використовується замість інших підписних купонів календаря, а не разом із ними.",
    "kind": "subscription_coupon",
    "amount": 25,
    "plan": "start"
  },
  {
    "day": 23,
    "id": "winter-2026-day-23",
    "name": "Ще один день Макса",
    "description": "Один день можливостей Макса для чинної оплаченої підписки з ШІ. Якщо вже оплачено Макс, строк збільшиться на день. Без повторного нарахування ліміту ШІ.",
    "kind": "upgrade",
    "amount": 1
  },
  {
    "day": 24,
    "id": "winter-2026-day-24",
    "name": "Плюс зі знижкою 20%",
    "description": "Знижка 20% на один оплачений місяць Плюса. Одна підписна знижка за календар на власну підписку, без поєднання з іншими акціями.",
    "kind": "subscription_coupon",
    "amount": 20,
    "plan": "plus"
  },
  {
    "day": 25,
    "id": "winter-2026-day-25",
    "name": "Ще два дні разом",
    "description": "Додайте два дні до чинної оплаченої студентської або викладацької підписки. Збережені дані й поточний ліміт ШІ залишаються.",
    "kind": "extension",
    "amount": 2
  },
  {
    "day": 26,
    "id": "winter-2026-day-26",
    "name": "Пауза на три дні",
    "description": "Три дні паузи для чинної оплаченої підписки. Під час паузи платні функції недоступні; відновити роботу можна раніше.",
    "kind": "pause",
    "amount": 3
  },
  {
    "day": 27,
    "id": "winter-2026-day-27",
    "name": "Макс зі знижкою 15%",
    "description": "Знижка 15% на один оплачений місяць Макса. Можна вибрати її, якщо спільну підписну знижку календаря ще не витрачено.",
    "kind": "subscription_coupon",
    "amount": 15,
    "plan": "max"
  },
  {
    "day": 28,
    "id": "winter-2026-day-28",
    "name": "Другу зі знижкою 20%",
    "description": "Найбільша пропозиція для друга: 20% на одну оплату підписки. Один код за календар. Він не забирає твою власну знижку; одержувач може використати один купон на свою підписку.",
    "kind": "friend_coupon",
    "amount": 20
  },
  {
    "day": 29,
    "id": "winter-2026-day-29",
    "name": "Рік зі знижкою 20%",
    "description": "Знижка 20% на одну річну оплату. Перед оплатою виберіть тариф і перевірте повну суму та умови. Одна підписна знижка за календар.",
    "kind": "subscription_coupon",
    "amount": 20,
    "plan": "annual"
  },
  {
    "day": 30,
    "id": "winter-2026-day-30",
    "name": "Ще день у Xelay",
    "description": "Один додатковий день до чинної оплаченої студентської або викладацької підписки, без повторного нарахування ліміту ШІ.",
    "kind": "extension",
    "amount": 1
  },
  {
    "day": 31,
    "id": "winter-2026-day-31",
    "name": "Фінальні 50 бонусних кредитів",
    "description": "Разом у календарі 150 бонусних кредитів. Активуйте їх до 31 січня 2027 року з оплаченою підпискою з ШІ; після активації залишок не згорає і використовується лише з чинною оплаченою підпискою з ШІ.",
    "kind": "credits",
    "amount": 50
  }
] as WinterReward[])

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
