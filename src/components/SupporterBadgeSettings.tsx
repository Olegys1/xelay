import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { loadMySupporterBadgePreferences, saveMySupporterBadgePreferences, SUPPORTER_BADGES_CHANGED, type SupporterBadgePreferences } from '../lib/supporterBadgePreferences'
import { SixSevenMark, SupporterMark } from './SupporterBadge'
import type { ActiveSupporterTier } from '../lib/supporterTiers'

export function SupporterBadgeSettings({ userId }: { userId: string }) {
  const [snapshot, setSnapshot] = useState<SupporterBadgePreferences | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [retry, setRetry] = useState(0)
  const alive = useRef(false)
  const lock = useRef(false)
  useEffect(() => {
    alive.current = true
    let current = true
    setLoading(true); setSnapshot(null); setError('')
    void loadMySupporterBadgePreferences().then((state) => { if (current) setSnapshot(state) }, (problem) => {
      if (current) setError(problem instanceof Error ? problem.message : 'Не вдалося завантажити бейджі.')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; alive.current = false }
  }, [userId, retry])

  const save = async (showTier: boolean, showSixSeven: boolean) => {
    if (lock.current || !snapshot) return
    lock.current = true; setBusy(true); setSaved(false); setError('')
    try {
      const state = await saveMySupporterBadgePreferences(showTier, showSixSeven)
      window.dispatchEvent(new CustomEvent(SUPPORTER_BADGES_CHANGED, { detail: { userId } }))
      if (alive.current) { setSnapshot(state); setSaved(true) }
    } catch (problem) {
      if (alive.current) setError(problem instanceof Error ? problem.message : 'Не вдалося зберегти бейджі.')
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <section aria-label="Бейджі поруч з ім’ям" className="mb-6 min-w-0 rounded-2xl border border-border bg-muted/20 p-4">
    <h3 className="text-sm font-semibold">Бейджі поруч з ім’ям</h3>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">Додавайте або прибирайте отримані бейджі підтримки. Вибір зберігається автоматично для вашого профілю на всіх пристроях.</p>
    {loading && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />Завантажуємо бейджі…</p>}
    {snapshot && <div className="mt-3 divide-y divide-border">
      <label className="flex min-h-14 items-center justify-between gap-3 py-2">
        <span className="min-w-0">{snapshot.tier > 0 ? <SupporterMark tier={snapshot.tier as ActiveSupporterTier} /> : <span className="text-xs text-muted-foreground">Рівень підтримки · ще не отримано</span>}</span>
        <input type="checkbox" role="switch" aria-label="Показувати рівень підтримки" checked={snapshot.showTier && snapshot.tier > 0} disabled={busy || snapshot.tier === 0}
          onChange={(event) => { void save(event.target.checked, snapshot.showSixSeven) }} className="h-5 w-5 shrink-0 accent-primary" />
      </label>
      <label className="flex min-h-14 items-center justify-between gap-3 py-2">
        <span className="min-w-0"><SixSevenMark compact={false} />{!snapshot.sixSeven && <span className="ml-2 text-xs text-muted-foreground">Ще не отримано</span>}</span>
        <input type="checkbox" role="switch" aria-label="Показувати секретний бейдж 67" checked={snapshot.showSixSeven && snapshot.sixSeven} disabled={busy || !snapshot.sixSeven}
          onChange={(event) => { void save(snapshot.showTier, event.target.checked) }} className="h-5 w-5 shrink-0 accent-primary" />
      </label>
    </div>}
    {error && <div className="mt-3 text-xs text-destructive"><p role="alert">{error}</p>{!snapshot && <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 min-h-9 rounded-lg border border-border px-3 font-medium text-foreground">Повторити</button>}</div>}
    <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">{busy ? 'Зберігаємо…' : saved ? 'Вибір бейджів збережено.' : ''}</p>
    {snapshot && (!snapshot.sixSeven || snapshot.tier === 0) && <a href="/support" className="mt-2 inline-block text-xs font-medium text-primary underline underline-offset-4">Як отримати бейджі</a>}
  </section>
}
