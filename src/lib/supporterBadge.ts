import { supabase } from './supabase'
import { isSupporterTier, type SupporterTier } from './supporterTiers'

/** This public RPC returns a level, never a total, payment or private profile field. */
export async function loadSupporterTier(userId: string): Promise<SupporterTier> {
  const result = await supabase.rpc('xelay_supporter_tier', { p_user_id: userId })
  if (result.error) {
    if (!['PGRST202', '42883'].includes(result.error.code || '')) throw result.error
    // Compatibility while a deployment is being connected: an existing donor
    // can keep the old basic badge, but the browser never invents a higher tier.
    const legacy = await supabase.rpc('xelay_supporter_badge', { p_user_id: userId })
    if (legacy.error) throw legacy.error
    if (typeof legacy.data !== 'boolean') throw new Error('SUPPORTER_BADGE_INVALID')
    return legacy.data ? 1 : 0
  }
  if (!isSupporterTier(result.data)) throw new Error('SUPPORTER_TIER_INVALID')
  return result.data
}
