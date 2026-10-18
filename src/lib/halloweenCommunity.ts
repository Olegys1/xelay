import { supabase } from './supabase'

export async function loadHalloweenCommunityTotal(signal: AbortSignal): Promise<number> {
  const { data, error } = await supabase.rpc('xelay_halloween_community_total').abortSignal(signal)
  if (signal.aborted) throw new Error('Запит скасовано.')
  if (error) throw error
  const total = typeof data === 'number' ? data : typeof data === 'string' && /^\d+$/.test(data) ? Number(data) : NaN
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Загальна колекція тимчасово недоступна.')
  return total
}

const plurals = new Intl.PluralRules('uk-UA')
export function communityPumpkinLabel(total: number): string {
  const form = plurals.select(total)
  return form === 'one' ? 'гарбузик' : form === 'few' ? 'гарбузики' : 'гарбузиків'
}
