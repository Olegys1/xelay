/** Server-backed winter benefits. This catalogue describes rewards; it never grants access. */
export const WINTER_BENEFITS_ENDS_AT = '2027-02-28T22:00:00.000Z'
export const WINTER_CREDITS_ACTIVATE_BY = '2027-01-31T22:00:00.000Z'
export type WinterAudience = 'student' | 'teacher'
export type WinterBenefitKind = 'extension' | 'upgrade' | 'pause'
export const WINTER_BENEFIT_CATALOG: Readonly<Record<number, { kind: WinterBenefitKind; amountDays: number }>> = Object.freeze({
  2: { kind: 'extension', amountDays: 1 }, 4: { kind: 'upgrade', amountDays: 1 },
  7: { kind: 'pause', amountDays: 2 }, 9: { kind: 'extension', amountDays: 1 },
  13: { kind: 'upgrade', amountDays: 1 }, 16: { kind: 'pause', amountDays: 2 },
  19: { kind: 'extension', amountDays: 2 }, 23: { kind: 'upgrade', amountDays: 1 },
  25: { kind: 'extension', amountDays: 2 }, 26: { kind: 'pause', amountDays: 3 },
  30: { kind: 'extension', amountDays: 1 },
})
export interface WinterSubscription {
  planId: string | null
  effectivePlanId: string | null
  expiresAt: string | null
  pausedUntil: string | null
  upgradeUntil: string | null
}
export interface WinterBenefit {
  day: number
  kind: WinterBenefitKind
  amountDays: number
  status: 'available' | 'active' | 'used' | 'expired'
  audience: WinterAudience | null
  activeUntil: string | null
  convertedToExtension: boolean
}
export interface WinterBenefitsState {
  campaignId: 'winter-2026'
  serverNow: string
  eligible: boolean
  activationEndsAt: typeof WINTER_BENEFITS_ENDS_AT
  promo: {
    collectedCredits: number
    purchaseBonusCredits: number
    availableCredits: number
    reservedCredits: number
    spentCredits: number
    activatedAt: string | null
    activationEndsAt: typeof WINTER_CREDITS_ACTIVATE_BY
    usable: boolean
  }
  subscriptions: Record<WinterAudience, WinterSubscription>
  benefits: WinterBenefit[]
}
export type WinterBenefitAction = { action: 'activate_credits' }
  | { action: 'redeem'; day: number; audience: WinterAudience }
  | { action: 'resume'; audience: WinterAudience }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const date = (v: unknown) => v === null || typeof v === 'string' && Number.isFinite(Date.parse(v))
const numeric = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
export function parseWinterBenefitAction(value: unknown): WinterBenefitAction {
  const bad = () => { throw new Error('Невідома дія з подарунком.') }
  if (!object(value)) return bad()
  const fields = Object.keys(value)
  if (value.action === 'activate_credits' && fields.length === 1) return { action: value.action }
  if (value.audience !== 'student' && value.audience !== 'teacher') return bad()
  if (value.action === 'resume' && fields.length === 2) return { action: value.action, audience: value.audience }
  if (value.action === 'redeem' && fields.length === 3 && Number.isInteger(value.day)
    && Object.prototype.hasOwnProperty.call(WINTER_BENEFIT_CATALOG, value.day)) return { action: value.action, day: value.day, audience: value.audience }
  return bad()
}
export function parseWinterBenefitsState(value: unknown): WinterBenefitsState {
  const bad = (): never => { throw new Error('Не вдалося перевірити подарунки. Оновіть сторінку.') }
  if (!object(value) || value.campaignId !== 'winter-2026' || !date(value.serverNow) || value.serverNow === null
    || typeof value.eligible !== 'boolean' || value.activationEndsAt !== WINTER_BENEFITS_ENDS_AT
    || !object(value.promo) || !object(value.subscriptions) || !Array.isArray(value.benefits) || value.benefits.length > 11) return bad()
  const p = value.promo
  if (!numeric(p.collectedCredits, 150) || !numeric(p.purchaseBonusCredits, 300)
    || !numeric(p.availableCredits, 450) || !numeric(p.reservedCredits, 450) || !numeric(p.spentCredits, 450)
    || !date(p.activatedAt) || p.activationEndsAt !== WINTER_CREDITS_ACTIVATE_BY || typeof p.usable !== 'boolean') return bad()
  for (const audience of ['student', 'teacher'] as const) {
    const s = value.subscriptions[audience]
    const plans = audience === 'student' ? [null, 'start', 'plus', 'max'] : [null, 'teacher_start', 'teacher_plus', 'teacher_max']
    if (!object(s) || !plans.includes(s.planId) || !plans.includes(s.effectivePlanId)
      || !date(s.expiresAt) || !date(s.pausedUntil) || !date(s.upgradeUntil)) return bad()
  }
  const seen = new Set<number>()
  for (const row of value.benefits) {
    if (!object(row) || !Number.isInteger(row.day) || seen.has(row.day)) return bad()
    const catalogue = WINTER_BENEFIT_CATALOG[row.day]
    if (!catalogue || catalogue.kind !== row.kind || catalogue.amountDays !== row.amountDays
      || !['available', 'active', 'used', 'expired'].includes(row.status)
      || ![null, 'student', 'teacher'].includes(row.audience) || !date(row.activeUntil)
      || typeof row.convertedToExtension !== 'boolean') return bad()
    seen.add(row.day)
  }
  return value as unknown as WinterBenefitsState
}
