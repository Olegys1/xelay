import { useEffect, useState } from 'react'
import { Crown, Gem, Heart, Medal, Sparkles, Star } from 'lucide-react'
import { loadSupporterBadges } from '../lib/supporterBadge'
import { SUPPORTER_BADGES_CHANGED } from '../lib/supporterBadgePreferences'
import { supporterTierDetails, type ActiveSupporterTier, type SupporterBadges } from '../lib/supporterTiers'
import './supporterBadge.css'
import { BadgeInfo } from './BadgeInfo'

const icons = { 1: Heart, 2: Medal, 3: Star, 4: Crown, 5: Gem }

export function SupporterMark({ tier = 1 }: { tier?: ActiveSupporterTier }) {
  const details = supporterTierDetails(tier)
  const Icon = icons[tier]
  return <BadgeInfo label={details.label} description={`Знак подяки за загальну підтверджену підтримку Xelay від ${details.minimumKopiykas / 100} грн. Внески додаються, повернені й тестові платежі не враховуються. Бейдж не відкриває підписку й не надає додаткових прав.`}
    data-supporter-tier={details.key}
    className={`xelay-supporter-mark xelay-supporter-${details.key} inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
    <Icon size={12} fill={tier === 1 ? 'currentColor' : 'none'} strokeWidth={1.7} aria-hidden="true" />{details.label}
  </BadgeInfo>
}

export function SixSevenMark({ compact = true }: { compact?: boolean }) {
  return <BadgeInfo label="67 · Six Seven" description="Секретний бейдж за один підтверджений неповернений внесок рівно 67 грн. Це відсилання до мему Six Seven. Він доповнює звичайний рівень підтримки; кілька менших платежів на загальну суму 67 грн його не відкривають. Додаткових прав не надає."
    aria-label="67 · Six Seven — секретний бейдж підтримки Xelay" data-supporter-secret="six-seven"
    className="xelay-supporter-mark xelay-supporter-six-seven inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
    <Sparkles size={11} strokeWidth={1.7} aria-hidden="true" /><span className="font-bold tracking-tight">67</span>
    {!compact && <span className="font-medium">· Six Seven</span>}
  </BadgeInfo>
}

export function SupporterBadge({ userId }: { userId?: string }) {
  const [snapshot, setSnapshot] = useState<({ userId: string } & SupporterBadges) | null>(null)
  useEffect(() => {
    let active = true
    let busy = false
    let queued = false
    let generation = 0
    setSnapshot(null)
    if (!userId) return
    const refresh = async () => {
      if (!active || document.visibilityState !== 'visible') return
      if (busy) { queued = true; return }
      busy = true
      const current = ++generation
      try {
        const badges = await loadSupporterBadges(userId)
        if (active && current === generation) setSnapshot({ userId, ...badges })
      } catch { if (active && current === generation) setSnapshot(null) }
      finally { busy = false; if (queued) { queued = false; void refresh() } }
    }
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ userId: string }>).detail?.userId !== userId) return
      generation += 1; setSnapshot(null); void refresh()
    }
    void refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener(SUPPORTER_BADGES_CHANGED, changed)
    const interval = window.setInterval(refresh, 60_000)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener(SUPPORTER_BADGES_CHANGED, changed)
      window.clearInterval(interval)
    }
  }, [userId])
  return snapshot && snapshot.userId === userId
    ? <>{snapshot.tier > 0 && <SupporterMark tier={snapshot.tier as ActiveSupporterTier} />}{snapshot.sixSeven && <SixSevenMark />}</> : null
}
