import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { APPRECIATION_BADGES_CHANGED, loadMyAppreciationBadge, saveMyAppreciationBadge, type AppreciationBadgeState } from '../../lib/appreciationGifts'
import { loadCachedAppreciationBadge } from '../../lib/appreciationBadgeCache'
import { BadgeInfo } from '../BadgeInfo'
import { CommunitySparkMark } from './AppreciationGiftCard'

export function AppreciationMark() {
  return <BadgeInfo label="Іскра Xelay" description="Особиста відзнака від команди за те, що допомагаєш спільноті Xelay рости й знаходити своїх людей. Відзнака залишається у профілі та не надає додаткових прав. Її можна приховати в налаштуваннях бейджів."
    data-appreciation-badge="community_spark" className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-primary/20 bg-primary/5 py-0.5 pl-0.5 pr-2 text-[10px] font-semibold text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
    <CommunitySparkMark compact />Іскра Xelay
  </BadgeInfo>
}

export function AppreciationBadge({ userId }: { userId?: string }) {
  const [snapshot, setSnapshot] = useState<{ owner: string; visible: boolean } | null>(null)
  useEffect(() => {
    let alive = true, version = 0
    let pending: AbortController | null = null
    setSnapshot(null)
    if (!userId) return
    const refresh = async () => {
      if (!alive || document.visibilityState !== 'visible') return
      pending?.abort()
      const controller = new AbortController(); pending = controller
      const request = ++version
      try {
        const visible = await loadCachedAppreciationBadge(userId)
        if (alive && request === version && !controller.signal.aborted) setSnapshot({ owner: userId, visible })
      } catch { if (alive && request === version) setSnapshot(null) }
    }
    const changed = () => { setSnapshot(null); void refresh() }
    void refresh()
    window.addEventListener(APPRECIATION_BADGES_CHANGED, changed)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, 60_000)
    return () => {
      alive = false; ++version; pending?.abort(); window.clearInterval(interval)
      window.removeEventListener(APPRECIATION_BADGES_CHANGED, changed)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [userId])
  return snapshot?.owner === userId && snapshot?.visible ? <AppreciationMark /> : null
}

export function AppreciationBadgeSettings({ userId }: { userId: string }) {
  const [snapshot, setSnapshot] = useState<{ owner: string; badge: AppreciationBadgeState } | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [retry, setRetry] = useState(0)
  const owner = useRef(userId); owner.current = userId
  const alive = useRef(false), locked = useRef(false), pending = useRef<AbortController | null>(null)
  useEffect(() => {
    let active = true; alive.current = true
    setSnapshot(null); setLoading(true); setError(''); setSaved(false); setBusy(false); locked.current = false
    const controller = new AbortController(); pending.current = controller
    void loadMyAppreciationBadge(userId, controller.signal).then(badge => {
      if (active && !controller.signal.aborted) setSnapshot({ owner: userId, badge })
    }).catch(() => { if (active && !controller.signal.aborted) setError('Не вдалося перевірити відзнаку. Спробуйте ще раз.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; alive.current = false; controller.abort(); pending.current?.abort() }
  }, [userId, retry])
  const badge = snapshot?.owner === userId ? snapshot.badge : null
  const save = async (visible: boolean) => {
    if (!badge?.earned || locked.current) return
    const actor = userId, controller = new AbortController(); pending.current = controller
    locked.current = true; setBusy(true); setSaved(false); setError('')
    try {
      const value = await saveMyAppreciationBadge(actor, visible, controller.signal)
      if (alive.current && owner.current === actor && !controller.signal.aborted) { setSnapshot({ owner: actor, badge: value }); setSaved(true) }
    } catch {
      if (alive.current && owner.current === actor && !controller.signal.aborted) {
        setSnapshot(null); setError('Не вдалося підтвердити збереження. Повторіть перевірку відзнаки.')
        window.dispatchEvent(new CustomEvent(APPRECIATION_BADGES_CHANGED))
      }
    } finally {
      if (pending.current === controller && alive.current && owner.current === actor) { locked.current = false; setBusy(false) }
    }
  }
  if (loading || badge && !badge.earned) return null
  return <section aria-label="Відзнака спільноти" className="mb-6 min-w-0 rounded-2xl border border-border bg-muted/20 p-4">
    <h3 className="text-sm font-semibold">Відзнака спільноти</h3>
    {badge?.earned && <label className="mt-3 flex min-h-14 items-center justify-between gap-3 py-2"><span className="min-w-0"><AppreciationMark /><span className="mt-1 block text-xs leading-5 text-muted-foreground">Відзнака залишається вашою, навіть коли прихована. Вибір діє на всіх пристроях.</span></span><input type="checkbox" role="switch" aria-label="Показувати бейдж Іскра Xelay у профілі" checked={badge.visible} disabled={busy} onChange={event => { void save(event.target.checked) }} className="h-5 w-5 shrink-0 accent-primary" /></label>}
    {error && <div className="mt-3 text-xs text-destructive"><p role="alert">{error}</p>{!badge && <button type="button" onClick={() => setRetry(value => value + 1)} className="mt-2 min-h-9 rounded-lg border border-border px-3 font-medium text-foreground">Повторити перевірку</button>}</div>}
    <p role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">{busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{busy ? 'Зберігаємо…' : saved ? 'Вибір бейджа збережено.' : ''}</p>
  </section>
}
