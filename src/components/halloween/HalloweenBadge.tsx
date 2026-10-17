import { useEffect, useRef, useState } from 'react'
import { HALLOWEEN_BADGES_CHANGED, loadHalloweenBadge, loadMyHalloweenHunt, saveMyHalloweenBadge, type HalloweenHuntState } from '../../lib/halloweenHunt'
import { BadgeInfo } from '../BadgeInfo'
import { PumpkinArt } from './HalloweenPumpkin'

export function HalloweenBadgeMark() {
  return <BadgeInfo label="Гарбузова магія" description="Відзнака за всі 10 гарбузиків, зібраних під час осіннього полювання Xelay 2026. Бейдж залишиться після акції. Призовий місяць «Учасника» отримують лише перші 10 завершень; сам бейдж додаткових прав не надає." className="halloween-earned-badge"><PumpkinArt size={25} /><span>Гарбузова магія</span></BadgeInfo>
}

export function HalloweenBadge({ userId }: { userId?: string }) {
  const [visible, setVisible] = useState<{ userId: string; value: boolean } | null>(null)
  useEffect(() => {
    if (!userId) return
    let alive = true, version = 0, busy = false, queued = false
    setVisible(null)
    const refresh = async () => {
      if (!alive || document.visibilityState !== 'visible') return
      if (busy) { queued = true; return }
      busy = true; const request = ++version
      try { const value = await loadHalloweenBadge(userId); if (alive && request === version) setVisible({ userId, value }) }
      catch { if (alive && request === version) setVisible(null) }
      finally { busy = false; if (queued) { queued = false; void refresh() } }
    }
    const changed = () => { ++version; setVisible(null); void refresh() }
    void refresh()
    window.addEventListener('focus', refresh); window.addEventListener(HALLOWEEN_BADGES_CHANGED, changed)
    const interval = window.setInterval(refresh, 60_000)
    return () => { alive = false; ++version; window.clearInterval(interval); window.removeEventListener('focus', refresh); window.removeEventListener(HALLOWEEN_BADGES_CHANGED, changed) }
  }, [userId])
  return visible?.userId === userId && visible?.value ? <HalloweenBadgeMark /> : null
}

export function HalloweenBadgeSettings({ userId }: { userId: string }) {
  const [snapshot, setSnapshot] = useState<{ userId: string; value: HalloweenHuntState } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const current = useRef(userId); current.current = userId
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true; let active = true
    setSnapshot(null); setError('')
    void loadMyHalloweenHunt().then(value => { if (active) setSnapshot({ userId, value }) }, () => { /* An unavailable seasonal badge never blocks profile settings. */ })
    return () => { active = false; alive.current = false }
  }, [userId])
  const state = snapshot?.userId === userId ? snapshot.value : null
  const save = async (visible: boolean) => {
    if (!state?.badgeEarned || lock.current) return
    const owner = userId; lock.current = true; setBusy(true); setError('')
    try { const value = await saveMyHalloweenBadge(visible); if (alive.current && current.current === owner) setSnapshot({ userId, value }) }
    catch (error) { if (alive.current && current.current === owner) setError(error instanceof Error ? error.message : 'Не вдалося зберегти вибір.') }
    finally { lock.current = false; if (alive.current && current.current === owner) setBusy(false) }
  }
  if (!state?.badgeEarned) return null
  return <section aria-label="Осінній бейдж" className="mb-6 rounded-2xl border border-border bg-muted/20 p-4"><h3 className="text-sm font-semibold">Ваш осінній трофей</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Отриманий бейдж залишиться з вами. Його показ можна змінити будь-коли.</p><label className="mt-3 flex min-h-12 items-center justify-between gap-3"><HalloweenBadgeMark /><input type="checkbox" role="switch" aria-label="Показувати гарбузовий бейдж" checked={state.showBadge} disabled={busy} onChange={event => { void save(event.target.checked) }} className="h-5 w-5 shrink-0 accent-primary" /></label>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}{busy && <p role="status" className="mt-2 text-xs text-muted-foreground">Зберігаємо вибір…</p>}</section>
}
