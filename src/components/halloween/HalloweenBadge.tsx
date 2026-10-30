import { useEffect, useRef, useState } from 'react'
import { HALLOWEEN_BADGES_CHANGED, loadHalloweenBadge, loadMyHalloweenHunt, saveMyHalloweenBadge, type HalloweenHuntState } from '../../lib/halloweenHunt'
import { BadgeInfo } from '../BadgeInfo'
import { PumpkinArt } from './HalloweenPumpkin'

export function HalloweenBadgeMark() {
  return <BadgeInfo label="Бейдж із гарбузом" description="Відзнака за всі 10 гарбузиків, зібраних під час осіннього полювання Xelay 2026. Бейдж залишиться після акції. Перші 10 призових місяців уже видано. Ще 5 отримають наступні учасники, які вперше завершать збір після старту додаткової акції. За вже завершений збір повторної нагороди немає. Сам бейдж додаткових прав не надає." className="halloween-earned-badge"><PumpkinArt size={25} /><span>Бейдж із гарбузом</span></BadgeInfo>
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

async function badgeRequestWithDeadline<T>(controller: AbortController, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Запит скасовано. Спробуйте ще раз.'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      reject(new Error('Запит триває надто довго. Перевірте з’єднання та спробуйте ще раз.'))
      controller.abort()
    }, 12_000)
  })
  try { return await Promise.race([request(controller.signal), interrupted]) }
  finally { clearTimeout(timeout); if (onAbort) controller.signal.removeEventListener('abort', onAbort) }
}

type BadgeSettingsView = { userId: string; value: HalloweenHuntState | null; operation: 'loading' | 'saving' | null; error: string; retryVisible?: boolean }

export function HalloweenBadgeSettings({ userId }: { userId: string }) {
  const [view, setView] = useState<BadgeSettingsView>({ userId, value: null, operation: 'loading', error: '' })
  const [reload, setReload] = useState(0)
  const current = useRef(userId); current.current = userId
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const version = ++generation.current
    const controller = new AbortController()
    request.current = controller
    const isCurrent = () => current.current === userId && generation.current === version && request.current === controller
    setView({ userId, value: null, operation: 'loading', error: '' })
    void badgeRequestWithDeadline(controller, loadMyHalloweenHunt).then(
      value => { if (isCurrent()) setView({ userId, value, operation: null, error: '' }) },
      error => { if (isCurrent()) setView({ userId, value: null, operation: null, error: error instanceof Error ? error.message : 'Не вдалося завантажити бейдж. Спробуйте ще раз.' }) },
    ).finally(() => { if (request.current === controller) request.current = null })
    return () => { ++generation.current; request.current?.abort(); request.current = null }
  }, [userId, reload])
  const ownView = view.userId === userId ? view : null
  const state = ownView?.value
  const loading = !ownView || ownView.operation === 'loading'
  const saving = ownView?.operation === 'saving'
  const save = async (visible: boolean) => {
    if (!state?.badgeEarned || request.current) return
    const owner = userId, version = generation.current
    const controller = new AbortController()
    request.current = controller
    const isCurrent = () => current.current === owner && generation.current === version && request.current === controller
    setView({ userId: owner, value: state, operation: 'saving', error: '' })
    try {
      const value = await badgeRequestWithDeadline(controller, signal => saveMyHalloweenBadge(visible, signal))
      if (isCurrent()) setView({ userId: owner, value, operation: null, error: '' })
    } catch (error) {
      if (isCurrent()) setView({ userId: owner, value: state, operation: null, error: error instanceof Error ? error.message : 'Не вдалося зберегти вибір. Попередній вибір збережено.', retryVisible: visible })
    } finally { if (request.current === controller) request.current = null }
  }
  const retry = () => { if (ownView?.retryVisible !== undefined) void save(ownView.retryVisible); else setReload(value => value + 1) }
  return <section aria-label="Бейдж із гарбузом" className="mb-6 rounded-2xl border border-border bg-muted/20 p-4">
    <h3 className="text-sm font-semibold">Гелловінська нагорода</h3>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">Ви можете приховати бейдж із профілю та знову показати його будь-коли. Отримана нагорода залишиться з вами.</p>
    {loading && <p role="status" className="mt-3 text-xs text-muted-foreground">Завантажуємо бейдж…</p>}
    {state && <label className="mt-3 flex min-h-12 items-center justify-between gap-3">{state.badgeEarned ? <HalloweenBadgeMark /> : <span className="text-xs text-muted-foreground">Бейдж із гарбузом · ще не отримано</span>}<input type="checkbox" role="switch" aria-label="Показувати бейдж із гарбузом" checked={state.badgeEarned && state.showBadge} disabled={saving || !state.badgeEarned} onChange={event => { void save(event.target.checked) }} className="h-5 w-5 shrink-0 accent-primary" /></label>}
    {state && !state.badgeEarned && <p className="mt-1 text-xs leading-5 text-muted-foreground">Зберіть усі 10 гарбузиків на платформі до кінця 1 листопада, щоб отримати цей бейдж.</p>}
    {ownView?.error && <div role="alert" className="mt-2 text-xs text-destructive"><p>{ownView.error}</p><button type="button" onClick={retry} disabled={loading || saving} className="mt-2 min-h-10 underline">{ownView.retryVisible === undefined ? 'Повторити завантаження' : 'Повторити збереження'}</button></div>}
    {saving && <p role="status" className="mt-2 text-xs text-muted-foreground">Зберігаємо вибір…</p>}
  </section>
}
