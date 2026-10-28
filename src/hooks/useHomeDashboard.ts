import { useCallback, useEffect, useRef, useState } from 'react'
import type { XelayUser } from '../types'
import { supabase } from '../lib/supabase'
import { createHomeFeedRefresh } from '../lib/homeFeedRefresh'
import { emptyLiveHome, loadLiveHome } from '../lib/homeDashboardLive'
import { homeKyivClock, type HomeDashboardData } from '../lib/homeDashboardModel'

type DashboardRefresh = ReturnType<typeof createHomeFeedRefresh<HomeDashboardData>>
type DashboardSnapshot = { scope: string; data: HomeDashboardData; refreshing: boolean }
const sortedIds = (ids?: string[]) => [...new Set((ids || []).filter(id => typeof id === 'string'))].sort()

/** Changes to the rights-bearing identity must invalidate private results, even
 * when AuthContext reuses an account ID or reorders equivalent arrays. */
export function homeDashboardProfileScope(profile: XelayUser, userId: string): string {
  return JSON.stringify([
    userId, profile.id, profile.userId, profile.name, profile.username,
    Boolean(profile.isTeacher), profile.accountType, profile.teacherVerificationStatus,
    Boolean(profile.isClassRepresentative), profile.classRepresentativeRequestId,
    Boolean(profile.isPlatformAdmin), Boolean(profile.isPlatformNewsEditor),
    profile.universityId, profile.academicUnitId,
    sortedIds(profile.studyGroupIds), sortedIds(profile.editorUnitIds), sortedIds(profile.editorUniversityIds),
    profile.specialtyId, profile.studyYear, profile.studyYearAcademicYear,
  ])
}

/** No private data is persisted. Membership changes drop the in-memory snapshot
 * before any replacement read can finish, and old account reads cannot publish. */
export function useHomeDashboard(profile: XelayUser, userId: string): { data: HomeDashboardData; refresh: () => Promise<void>; refreshing: boolean } {
  const identity = homeDashboardProfileScope(profile, userId)
  const [reset, setReset] = useState(0)
  const scope = `${identity}:${reset}`
  const currentScope = useRef(scope)
  const profileRef = useRef(profile)
  const generation = useRef(0)
  const refreshers = useRef<{ scope: string; refresh: DashboardRefresh } | null>(null)
  currentScope.current = scope
  profileRef.current = profile
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => ({ scope, data: emptyLiveHome(profile), refreshing: false }))

  useEffect(() => {
    let active = true
    const currentGeneration = ++generation.current
    const currentProfile = profileRef.current
    const inScope = () => active && generation.current === currentGeneration && currentScope.current === scope
    const blank = (status: HomeDashboardData['status'] = 'loading'): DashboardSnapshot => ({ scope, data: emptyLiveHome(currentProfile, status), refreshing: false })
    setSnapshot(blank())

    if (!userId || currentProfile.id !== userId) {
      const data = { ...emptyLiveHome(currentProfile, 'error'), errorMessage: 'Акаунт змінився. Увійдіть до Xelay ще раз.' }
      setSnapshot({ scope, data, refreshing: false })
      return () => { active = false }
    }

    let lastDay = homeKyivClock(new Date().toISOString()).date
    const refresher: DashboardRefresh = createHomeFeedRefresh<HomeDashboardData>({
      initialVisible: document.visibilityState === 'visible',
      fallbackMs: 120_000,
      debounceMs: 600,
      reconcileMs: 15_000,
      minBackgroundIntervalMs: 5_000,
      readTimeoutMs: 35_000,
      load: signal => loadLiveHome(currentProfile, userId, signal),
      onStart: () => {
        if (inScope()) setSnapshot(previous => previous.scope === scope ? { ...previous, refreshing: true } : { ...blank(), refreshing: true })
      },
      onData: data => {
        if (!inScope()) return
        const clockIso = new Date().toISOString()
        const actualDay = homeKyivClock(clockIso).date
        // A read crossing Kyiv midnight must be repeated with the new date range.
        if (homeKyivClock(data.clockIso).date !== actualDay) refresher.invalidate()
        lastDay = actualDay
        setSnapshot({ scope, data: { ...data, clockIso }, refreshing: true })
      },
      onError: () => {
        if (!inScope()) return
        // Never keep protected content after an authoritative or failed recheck.
        setSnapshot({ scope, data: { ...emptyLiveHome(currentProfile, 'error'), errorMessage: 'Не вдалося оновити навчальний день. Перевірте інтернет і спробуйте ще раз.' }, refreshing: false })
      },
      onSettled: () => {
        if (inScope()) setSnapshot(previous => previous.scope === scope ? { ...previous, refreshing: false } : previous)
      },
    })
    refreshers.current = { scope, refresh: refresher }
    void refresher.request()

    const clearProtectedAndReload = () => {
      if (!inScope()) return
      // Increment immediately; waiting for React cleanup would leave a window
      // in which an old RPC ignoring AbortSignal could publish revoked data.
      generation.current += 1
      refresher.dispose()
      if (refreshers.current?.scope === scope) refreshers.current = null
      setSnapshot(blank())
      setReset(value => value + 1)
    }
    const ownAccessChanged = (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
      const changedUser = payload.new?.user_id || payload.old?.user_id
      if (changedUser && changedUser !== userId) return
      clearProtectedAndReload()
    }
    const channel = supabase.channel(`home-dashboard:${userId}:${currentGeneration}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_members', filter: `user_id=eq.${userId}` }, ownAccessChanged)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_deputy_requests', filter: `user_id=eq.${userId}` }, ownAccessChanged)
      .subscribe(status => { if (inScope() && status === 'SUBSCRIBED') refresher.reconcile() })

    const tick = () => {
      if (!inScope() || document.visibilityState !== 'visible') return
      const clockIso = new Date().toISOString()
      const day = homeKyivClock(clockIso).date
      if (day !== lastDay) { lastDay = day; refresher.invalidate() }
      setSnapshot(previous => previous.scope === scope ? { ...previous, data: { ...previous.data, clockIso } } : previous)
    }
    let clockTimer: ReturnType<typeof setTimeout> | undefined
    const armClock = () => {
      clockTimer = setTimeout(() => { tick(); if (inScope()) armClock() }, 60_000 - Date.now() % 60_000 + 20)
    }
    armClock()
    const visibilityChanged = () => {
      if (!inScope()) return
      const visible = document.visibilityState === 'visible'
      refresher.setVisible(visible)
      if (visible) tick()
    }
    const reconcile = () => { if (inScope()) { tick(); refresher.reconcile() } }
    const notificationUpdated = (event: Event) => {
      if (!inScope()) return
      const detail = (event as CustomEvent<{ userId?: string }>).detail
      if (detail?.userId === userId) refresher.invalidate()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('focus', reconcile)
    window.addEventListener('online', reconcile)
    window.addEventListener('xelay-notifications-updated', notificationUpdated)
    return () => {
      active = false
      refresher.dispose()
      if (clockTimer !== undefined) clearTimeout(clockTimer)
      if (refreshers.current?.scope === scope) refreshers.current = null
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('focus', reconcile)
      window.removeEventListener('online', reconcile)
      window.removeEventListener('xelay-notifications-updated', notificationUpdated)
      void supabase.removeChannel(channel).catch(() => undefined)
    }
  }, [scope, userId])

  const refresh = useCallback(async () => {
    const current = refreshers.current
    if (!current || current.scope !== scope || currentScope.current !== scope) return
    await current.refresh.request()
  }, [scope])

  // Render-time isolation protects the frame before the previous effect cleans up.
  const visible = snapshot.scope === scope ? snapshot : { scope, data: emptyLiveHome(profile), refreshing: false }
  return { data: visible.data, refreshing: visible.refreshing, refresh }
}
