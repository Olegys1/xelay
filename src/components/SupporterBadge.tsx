import { useEffect, useState } from 'react'
import { Crown, Gem, Heart, Medal, Sparkles, Star } from 'lucide-react'
import { loadSupporterBadges } from '../lib/supporterBadge'
import { supporterTierDetails, type ActiveSupporterTier, type SupporterBadges } from '../lib/supporterTiers'
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

export function SixSevenMark({ compact = true }: { compact?: boolean }) {
  return <span title="67 · Six Seven — секретний бейдж підтримки Xelay. Без додаткових прав."
    aria-label="67 · Six Seven — секретний бейдж підтримки Xelay" data-supporter-secret="six-seven"
    className="xelay-supporter-mark xelay-supporter-six-seven inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold">
    <Sparkles size={11} strokeWidth={1.7} aria-hidden="true" /><span className="font-bold tracking-tight">67</span>
    {!compact && <span className="font-medium">· Six Seven</span>}
  </span>
}

export function SupporterBadge({ userId }: { userId?: string }) {
  const [snapshot, setSnapshot] = useState<({ userId: string } & SupporterBadges) | null>(null)
  useEffect(() => {
    let active = true
    let busy = false
    setSnapshot(null)
    if (!userId) return
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const badges = await loadSupporterBadges(userId)
        if (active) setSnapshot({ userId, ...badges })
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
  return snapshot && snapshot.userId === userId && snapshot.tier > 0
    ? <><SupporterMark tier={snapshot.tier as ActiveSupporterTier} />{snapshot.sixSeven && <SixSevenMark />}</> : null
}
