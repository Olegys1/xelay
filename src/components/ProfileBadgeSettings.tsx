import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, Loader2, Sparkles } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { loadProfileBadgePreferences, saveMyProfileBadgePreferences, PROFILE_BADGES_CHANGED, type ProfileBadgePreferences } from '../lib/profileBadgePreferences'

export function ProfileBadgeSettings({ userId }: { userId: string }) {
  const { xelayUser } = useAuth()
  const { isPremium } = useBilling()
  const [snapshot, setSnapshot] = useState<{ userId: string; value: ProfileBadgePreferences } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [retry, setRetry] = useState(0)
  const owner = useRef(userId); owner.current = userId
  const alive = useRef(false)
  const pending = useRef<AbortController | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    let active = true; alive.current = true
    setSnapshot(null); setLoading(true); setError(''); setSaved(false)
    const controller = new AbortController(); pending.current = controller
    const deadline = window.setTimeout(() => controller.abort(), 12_000)
    void loadProfileBadgePreferences(userId, controller.signal).then(value => {
      if (active) setSnapshot({ userId, value })
    }).catch(() => { if (active) setError('Не вдалося завантажити бейджі. Перевірте з’єднання та повторіть спробу.') })
      .finally(() => { window.clearTimeout(deadline); if (active) setLoading(false) })
    return () => { active = false; alive.current = false; controller.abort(); pending.current?.abort(); window.clearTimeout(deadline) }
  }, [userId, retry])
  const state = snapshot?.userId === userId ? snapshot.value : null
  const save = async (showParticipant: boolean, showTeacher: boolean) => {
    if (!state || lock.current) return
    const account = userId
    lock.current = true; setBusy(true); setSaved(false); setError('')
    const controller = new AbortController(); pending.current = controller
    const deadline = window.setTimeout(() => controller.abort(), 12_000)
    try {
      const value = await saveMyProfileBadgePreferences(showParticipant, showTeacher, controller.signal)
      if (alive.current && owner.current === account) {
        setSnapshot({ userId: account, value }); setSaved(true)
        window.dispatchEvent(new CustomEvent(PROFILE_BADGES_CHANGED, { detail: { userId: account } }))
      }
    } catch {
      if (alive.current && owner.current === account) {
        setError('Не вдалося підтвердити збереження. Повторіть перевірку налаштувань.')
        setSnapshot(null)
        window.dispatchEvent(new CustomEvent(PROFILE_BADGES_CHANGED, { detail: { userId: account } }))
      }
    } finally {
      window.clearTimeout(deadline); lock.current = false
      if (alive.current && owner.current === account) setBusy(false)
    }
  }
  return <section aria-label="Бейджі підписки та викладача" className="mb-6 min-w-0 rounded-2xl border border-border bg-muted/20 p-4">
    <h3 className="text-sm font-semibold">Підписка та статус викладача</h3>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">Оберіть, які бейджі бачите ви та відвідувачі вашого профілю. Вибір зберігається автоматично на всіх пристроях.</p>
    {loading && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />Завантажуємо бейджі…</p>}
    {state && <div className="mt-3 divide-y divide-border">
      <label className="flex min-h-14 items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="inline-flex items-center gap-1.5 text-sm font-medium"><Sparkles size={15} className="text-primary" />Учасник</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{isPremium ? 'Підписка залишиться активною, навіть якщо приховати бейдж.' : 'Доступний з активною підпискою «Учасник».'}</span></span><input type="checkbox" role="switch" aria-label="Показувати бейдж Учасник у профілі" checked={state.showParticipant} disabled={busy} onChange={event => { void save(event.target.checked, state.showTeacher) }} className="h-5 w-5 shrink-0 accent-primary" /></label>
      <label className="flex min-h-14 items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="inline-flex items-center gap-1.5 text-sm font-medium"><BadgeCheck size={15} className="text-sky-600" />Викладач</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{xelayUser?.isTeacher ? 'Показ підтвердженого статусу поруч з ім’ям.' : 'З’явиться після підтвердження статусу викладача.'}</span></span><input type="checkbox" role="switch" aria-label="Показувати бейдж Викладач у профілі" checked={state.showTeacher} disabled={busy} onChange={event => { void save(state.showParticipant, event.target.checked) }} className="h-5 w-5 shrink-0 accent-primary" /></label>
    </div>}
    {error && <div className="mt-3 text-xs text-destructive"><p role="alert">{error}</p>{!state && !loading && <button type="button" onClick={() => setRetry(value => value + 1)} className="mt-2 min-h-9 rounded-lg border border-border px-3 font-medium text-foreground">Повторити перевірку</button>}</div>}
    <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">{busy ? 'Зберігаємо…' : saved ? 'Вибір бейджів збережено.' : ''}</p>
  </section>
}
