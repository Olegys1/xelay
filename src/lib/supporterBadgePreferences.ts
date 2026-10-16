import { supabase } from './supabase'
import { isSupporterTier, type SupporterBadges } from './supporterTiers'

export const SUPPORTER_BADGES_CHANGED = 'xelay:supporter-badges-changed'
export interface SupporterBadgePreferences extends SupporterBadges { showTier: boolean; showSixSeven: boolean }

export function parseSupporterBadgePreferences(value: unknown): SupporterBadgePreferences {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!row || !isSupporterTier(row.tier) || typeof row.sixSeven !== 'boolean'
    || (row.sixSeven && row.tier === 0) || typeof row.showTier !== 'boolean' || typeof row.showSixSeven !== 'boolean') {
    throw new Error('Не вдалося перевірити бейджі. Спробуйте ще раз.')
  }
  return { tier: row.tier, sixSeven: row.sixSeven, showTier: row.showTier, showSixSeven: row.showSixSeven }
}

export async function loadMySupporterBadgePreferences() {
  const { data, error } = await supabase.rpc('xelay_my_supporter_badges')
  if (error) throw new Error('Не вдалося завантажити бейджі. Спробуйте ще раз.')
  return parseSupporterBadgePreferences(data)
}

export async function saveMySupporterBadgePreferences(showTier: boolean, showSixSeven: boolean) {
  if (typeof showTier !== 'boolean' || typeof showSixSeven !== 'boolean') throw new Error('Перевірте вибір бейджів.')
  const { data, error } = await supabase.rpc('xelay_set_my_supporter_badges', { p_show_tier: showTier, p_show_six_seven: showSixSeven })
  if (error) throw new Error('Не вдалося зберегти бейджі. Попередній вибір збережено.')
  return parseSupporterBadgePreferences(data)
}
