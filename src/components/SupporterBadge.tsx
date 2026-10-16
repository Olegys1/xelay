import { useEffect, useState } from 'react'
import { Crown, Gem, Heart, Medal, Star } from 'lucide-react'
import { loadSupporterTier } from '../lib/supporterBadge'
import { supporterTierDetails, type ActiveSupporterTier, type SupporterTier } from '../lib/supporterTiers'
import './supporterBadge.css'

const icons = { 1: Heart, 2: Medal, 3: Star, 4: Crown, 5: Gem }

export function SupporterMark({ tier = 1 }: { tier?: ActiveSupporterTier }) {
  const details = supporterTierDetails(tier)
  const Icon = icons[tier]
  return <span title={`${details.name} рівень підтримки Xelay. Знак подяки, без додаткових прав.`}
    data-supporter-tier={details.key}
    className={`xelay-supporter-mark xelay-supporter-${details.key} inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold`}>
    <Icon size={12} fill={tier === 1 ? 'currentColor' : 'none'} strokeWidth={1.7} aria-hidden="true" />{details.label}
  </span>
}

export function SupporterBadge({ userId }: { userId?: string }) {
  const [snapshot, setSnapshot] = useState<{ userId: string; tier: SupporterTier } | null>(null)
  useEffect(() => {
    let active = true
    let busy = false
    setSnapshot(null)
    if (!userId) return
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const tier = await loadSupporterTier(userId)
        if (active) setSnapshot({ userId, tier })
      } catch { if (active) setSnapshot(null) }
      finally { busy = false }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, 60_000)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(interval)
    }
  }, [userId])
  return snapshot && snapshot.userId === userId && snapshot.tier > 0 ? <SupporterMark tier={snapshot.tier as ActiveSupporterTier} /> : null
}
