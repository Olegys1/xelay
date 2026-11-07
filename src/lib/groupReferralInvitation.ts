const CODE = /^[A-Z0-9_-]{6,64}$/i
const KEY = 'xelay_group_referral_invitation_v1'
export function normalizeGroupReferralCode(value: unknown): string | undefined {
  return typeof value === 'string' && CODE.test(value.trim()) ? value.trim().toUpperCase() : undefined
}
export function rememberGroupReferralInvitation(actorId: string, value: unknown, storage: Storage = sessionStorage): void {
  const code = normalizeGroupReferralCode(value)
  if (!actorId || !code) return
  try { storage.setItem(KEY, JSON.stringify({ actorId, code, at: Date.now() })) } catch { /* A blocked browser store never prevents group creation. */ }
}
export function groupReferralCreationDestination(actorId: string, storage: Storage = sessionStorage, consume = false): string | null {
  try {
    const value = JSON.parse(storage.getItem(KEY) || 'null')
    if (value?.actorId !== actorId || !normalizeGroupReferralCode(value.code) || typeof value.at !== 'number' || Date.now() < value.at || Date.now() - value.at > 24 * 3600_000) return null
    if (consume) storage.removeItem(KEY)
    return `/referrals?ref=${encodeURIComponent(normalizeGroupReferralCode(value.code)!)}`
  } catch { return null }
}
