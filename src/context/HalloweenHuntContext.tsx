import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { useBilling } from './BillingContext'
import { useToast } from './ToastContext'
import { collectHalloweenPumpkin, HALLOWEEN_ENDS_AT, HALLOWEEN_STARTS_AT, loadMyHalloweenHunt, type HalloweenCollectionResult, type HalloweenHuntState } from '../lib/halloweenHunt'

export type HalloweenCelebration = { key: number; count: number; completed: boolean; subscriptionWon: boolean }
export interface HalloweenHuntContextValue {
  userId?: string; available: boolean; state: HalloweenHuntState | null; loading: boolean; error: string
  collecting: string | null; celebration: HalloweenCelebration | null
  refresh: () => Promise<void>; collect: (id: string) => Promise<void>; clearCelebration: () => void
}
const empty: HalloweenHuntContextValue = { available: false, state: null, loading: false, error: '', collecting: null, celebration: null, refresh: async () => {}, collect: async () => {}, clearCelebration() {} }
const HalloweenHuntContext = createContext<HalloweenHuntContextValue>(empty)
const activeByClock = () => Date.now() >= Date.parse(HALLOWEEN_STARTS_AT) && Date.now() < Date.parse(HALLOWEEN_ENDS_AT)

export function HalloweenHuntProvider({ children }: { children: ReactNode }) {
  const { authUser, isPasswordRecovery, isLoading: authLoading } = useAuth()
  const { refreshBilling } = useBilling()
  const { notify } = useToast()
  const [available, setAvailable] = useState(activeByClock)
  const [snapshot, setSnapshot] = useState<{ userId: string; state: HalloweenHuntState } | null>(null)
  const [problem, setProblem] = useState<{ userId: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [collecting, setCollecting] = useState<string | null>(null)
  const [celebration, setCelebration] = useState<(HalloweenCelebration & { userId: string }) | null>(null)
  const owner = useRef(authUser?.id); owner.current = authUser?.id
  const alive = useRef(true)
  const sequence = useRef(0)
  const collectingLock = useRef<{ userId: string; version: number } | null>(null)
  const loadingLock = useRef<{ userId: string; version: number } | null>(null)
  const requests = useRef(new Map<AbortController, string>())
  const collectedRef = useRef(snapshot); collectedRef.current = snapshot
  useEffect(() => () => {
    alive.current = false; ++sequence.current
    requests.current.forEach((_, request) => request.abort()); requests.current.clear()
    loadingLock.current = null; collectingLock.current = null
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const reconcile = () => {
      clearTimeout(timer)
      setAvailable(activeByClock())
      const next = [Date.parse(HALLOWEEN_STARTS_AT), Date.parse(HALLOWEEN_ENDS_AT)].find(time => time > Date.now())
      if (next) timer = setTimeout(reconcile, Math.min(next - Date.now() + 20, 2_147_483_600))
    }
    reconcile()
    window.addEventListener('focus', reconcile)
    document.addEventListener('visibilitychange', reconcile)
    return () => { clearTimeout(timer); window.removeEventListener('focus', reconcile); document.removeEventListener('visibilitychange', reconcile) }
  }, [])
  const refresh = useCallback(async () => {
    const userId = authUser?.id
    if (!userId || isPasswordRecovery || authLoading || loadingLock.current?.userId === userId || collectingLock.current?.userId === userId) return
    const version = ++sequence.current
    loadingLock.current = { userId, version }
    const controller = new AbortController(); requests.current.set(controller, userId)
    const deadline = setTimeout(() => controller.abort(), 12000)
    if (collectedRef.current?.userId !== userId) setLoading(true)
    try {
      const state = await loadMyHalloweenHunt(controller.signal)
      if (alive.current && owner.current === userId && version === sequence.current) { setSnapshot({ userId, state }); setProblem(null) }
    } catch (error) {
      if (alive.current && owner.current === userId && version === sequence.current) setProblem({ userId, message: error instanceof Error ? error.message : 'Не вдалося завантажити полювання.' })
    } finally {
      clearTimeout(deadline); requests.current.delete(controller)
      if (loadingLock.current?.version === version) loadingLock.current = null
      if (alive.current && owner.current === userId && version === sequence.current) setLoading(false)
    }
  }, [authUser?.id, authLoading, isPasswordRecovery])
  useEffect(() => {
    ++sequence.current; setProblem(null); setCelebration(null); setCollecting(null); setLoading(false)
    requests.current.forEach((userId, controller) => { if (userId !== authUser?.id || isPasswordRecovery) controller.abort() })
    if (!authUser?.id || snapshot?.userId !== authUser.id) setSnapshot(null)
    alive.current = true
    if (available) void refresh()
    if (!available || !authUser?.id || isPasswordRecovery) return
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', visible); window.addEventListener('online', visible); document.addEventListener('visibilitychange', visible)
    const interval = window.setInterval(visible, 60_000)
    return () => { ++sequence.current; window.clearInterval(interval); window.removeEventListener('focus', visible); window.removeEventListener('online', visible); document.removeEventListener('visibilitychange', visible) }
  }, [available, authUser?.id, isPasswordRecovery, refresh])
  const collect = useCallback(async (id: string) => {
    const userId = authUser?.id
    const currentSnapshot = collectedRef.current
    const state = currentSnapshot && currentSnapshot.userId === userId ? currentSnapshot.state : null
    if (!userId || !available || collectingLock.current?.userId === userId || !state || state.phase !== 'active' || !state.eligible || state.collected.includes(id as never)) return
    const version = ++sequence.current
    collectingLock.current = { userId, version }
    const controller = new AbortController(); requests.current.set(controller, userId)
    const deadline = setTimeout(() => controller.abort(), 12000)
    setCollecting(id)
    try {
      const result: HalloweenCollectionResult = await collectHalloweenPumpkin(id, controller.signal)
      if (!alive.current || owner.current !== userId || version !== sequence.current) return
      setSnapshot({ userId, state: result }); setProblem(null)
      if (result.newlyCollected) setCelebration({ userId, key: Date.now(), count: result.collected.length, completed: result.newlyCompleted, subscriptionWon: result.subscriptionWon })
      if (result.newlyCompleted) {
        if (result.subscriptionWon) void refreshBilling()
        notify({ id: 'halloween-complete', title: result.subscriptionWon ? 'Вітаємо! Місяць «Учасника» — ваш 🎃' : 'Усі гарбузики зібрано! 🎃', description: result.subscriptionWon ? 'Ви серед перших 10! Підписку нараховано, а бейдж із гарбузом уже у профілі.' : 'Бейдж із гарбузом уже у профілі. Дякуємо за участь!', tone: 'success', duration: 10000 })
      }
    } catch (error) {
      if (alive.current && owner.current === userId && version === sequence.current) notify({ id: 'halloween-pickup', title: 'Гарбузик поки не збережено', description: error instanceof Error ? error.message : 'Перевірте з’єднання та спробуйте ще раз.', tone: 'warning' })
    } finally {
      clearTimeout(deadline); requests.current.delete(controller)
      if (collectingLock.current?.version === version) collectingLock.current = null
      if (alive.current && owner.current === userId && version === sequence.current) setCollecting(null)
    }
  }, [authUser?.id, available, notify, refreshBilling])
  const clearCelebration = useCallback(() => setCelebration(null), [])
  const value = useMemo<HalloweenHuntContextValue>(() => ({ userId: authUser?.id, available: available && !isPasswordRecovery,
    state: snapshot && snapshot.userId === authUser?.id ? snapshot.state : null, loading,
    error: problem && problem.userId === authUser?.id ? problem.message : '', collecting,
    celebration: celebration?.userId === authUser?.id ? celebration : null,
    refresh, collect, clearCelebration }), [authUser?.id, available, isPasswordRecovery, snapshot, problem, loading, collecting, celebration, refresh, collect, clearCelebration])
  return <HalloweenHuntContext.Provider value={value}>{children}</HalloweenHuntContext.Provider>
}

/** Only imported by the isolated visual fixture. It cannot change server progress or prizes. */
export function HalloweenHuntPreviewProvider({ children, value }: { children: ReactNode; value: HalloweenHuntContextValue }) {
  return <HalloweenHuntContext.Provider value={value}>{children}</HalloweenHuntContext.Provider>
}
export const useHalloweenHunt = () => useContext(HalloweenHuntContext)
