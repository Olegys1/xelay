import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { ProfileBadgeSettings } from './ProfileBadgeSettings'
import { SupporterBadgeSettings } from './SupporterBadgeSettings'
import { HalloweenBadgeSettings } from './halloween/HalloweenBadge'
import { AppreciationBadgeSettings } from './community/AppreciationBadge'

export function ProfileBadgesDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus({ preventScroll: true })
    return () => { previous?.focus({ preventScroll: true }) }
  }, [])
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div className="xelay-dialog-backdrop absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="profile-badges-title" className="xelay-dialog-panel relative z-10 max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-5 sm:p-6" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') || []).filter(element => element.offsetParent !== null)
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <div className="mb-2 flex items-center justify-between gap-4"><h2 id="profile-badges-title" className="text-xl font-bold">Бейджі профілю</h2><button ref={close} type="button" aria-label="Закрити бейджі профілю" onClick={onClose} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-muted"><X size={20} /></button></div>
      <p className="mb-5 text-sm leading-6 text-muted-foreground">Приховуйте бейджі та повертайте їх у профіль у будь-який момент.</p>
      <ProfileBadgeSettings key={`profile:${userId}`} userId={userId} />
      <SupporterBadgeSettings key={`support:${userId}`} userId={userId} />
      <AppreciationBadgeSettings key={`appreciation:${userId}`} userId={userId} />
      <HalloweenBadgeSettings key={`halloween:${userId}`} userId={userId} />
    </div>
  </div>
}
