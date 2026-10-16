export type SupporterTier = 0 | 1 | 2 | 3 | 4 | 5
export type ActiveSupporterTier = Exclude<SupporterTier, 0>
export interface SupporterBadges { tier: SupporterTier; sixSeven: boolean }
export interface SupporterSummary { tier: SupporterTier; totalKopiykas: number; sixSeven?: boolean }
export const SIX_SEVEN_KOPIYKAS = 6_700

export function parseSupporterBadges(value: unknown): SupporterBadges {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
  if (!row || !isSupporterTier(row.tier) || typeof row.sixSeven !== 'boolean'
    || (row.sixSeven && row.tier === 0)) throw new Error('SUPPORTER_BADGES_INVALID')
  return { tier: row.tier, sixSeven: row.sixSeven }
}

/** Thresholds are integer kopiykas and match the server's approved-live total. */
export const SUPPORTER_TIERS = [
  { tier: 1, key: 'supporter', name: 'Базовий', label: 'Підтримую Xelay', minimumKopiykas: 100 },
  { tier: 2, key: 'bronze', name: 'Бронзовий', label: 'Бронза Xelay', minimumKopiykas: 10_000 },
  { tier: 3, key: 'silver', name: 'Срібний', label: 'Срібло Xelay', minimumKopiykas: 25_000 },
  { tier: 4, key: 'gold', name: 'Золотий', label: 'Золото Xelay', minimumKopiykas: 50_000 },
  { tier: 5, key: 'diamond', name: 'Діамантовий', label: 'Діамант Xelay', minimumKopiykas: 100_000 },
] as const

export function isSupporterTier(value: unknown): value is SupporterTier {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
}

export function supporterTierForTotal(totalKopiykas: number): SupporterTier {
  if (!Number.isSafeInteger(totalKopiykas) || totalKopiykas < 0) return 0
  for (let index = SUPPORTER_TIERS.length - 1; index >= 0; index -= 1) {
    if (totalKopiykas >= SUPPORTER_TIERS[index].minimumKopiykas) return SUPPORTER_TIERS[index].tier
  }
  return 0
}

export function supporterTierDetails(tier: ActiveSupporterTier) {
  return SUPPORTER_TIERS.find((item) => item.tier === tier)!
}

export function parseSupporterSummary(value: unknown): SupporterSummary {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
  if (!row || !isSupporterTier(row.tier) || typeof row.totalKopiykas !== 'number'
    || !Number.isSafeInteger(row.totalKopiykas) || row.totalKopiykas < 0
    || supporterTierForTotal(row.totalKopiykas) !== row.tier
    || (row.sixSeven !== undefined && (typeof row.sixSeven !== 'boolean'
      || (row.sixSeven && row.totalKopiykas < SIX_SEVEN_KOPIYKAS)))) throw new Error('SUPPORTER_SUMMARY_INVALID')
  return { tier: row.tier, totalKopiykas: row.totalKopiykas,
    ...(row.sixSeven === undefined ? {} : { sixSeven: row.sixSeven }) }
}

export function previewSupporterTier(totalKopiykas: number, contributionKopiykas: number): SupporterTier {
  if (!Number.isSafeInteger(totalKopiykas) || totalKopiykas < 0
    || !Number.isSafeInteger(contributionKopiykas) || contributionKopiykas < 100) return 0
  // The public result has only five levels, including for a very large lifetime total.
  if (totalKopiykas >= 100_000 || contributionKopiykas >= 100_000) return 5
  return supporterTierForTotal(totalKopiykas + contributionKopiykas)
}

export function nextSupporterTier(totalKopiykas: number) {
  if (!Number.isSafeInteger(totalKopiykas) || totalKopiykas < 0) return null
  const next = SUPPORTER_TIERS.find((item) => item.minimumKopiykas > totalKopiykas)
  return next ? { ...next, remainingKopiykas: next.minimumKopiykas - totalKopiykas } : null
}
