import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { AuthModal } from '../components/AuthModal'
import { supabase } from '../lib/supabase'
import { parseWinterAdventClaim, parseWinterAdventState, type WinterAdventState } from '../lib/winterCampaign'
import { WinterCalendarView } from '../components/winter/WinterCalendarView'

export function WinterPage() {
  const { authUser, isLoading: authLoading, isPasswordRecovery } = useAuth()
  const owner = useRef(authUser?.id || null); owner.current = authUser?.id || null
  const [snapshot, setSnapshot] = useState<WinterAdventState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const version = useRef(0)
  const active = useRef<AbortController | null>(null)
  const pendingRefresh = useRef(false)
  const mounted = useRef(true)
  const received = useRef(0)
  const request = useCallback(async function runRequest(day?: number): Promise<WinterAdventState> {
    const userId = owner.current, sequence = ++version.current
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    const timer = setTimeout(() => controller.abort(), 12_000)
    setLoading(true); setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (owner.current !== userId || (session?.user.id || null) !== userId) throw new Error('Акаунт змінився. Оновіть календар.')
      const response = await fetch('/api/winter/advent', { method: day === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { Accept: 'application/json', ...(day === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        ...(day === undefined ? {} : { body: JSON.stringify({ day }) }) })
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Календар тимчасово недоступний. Спробуйте ще раз.')
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Не вдалося відкрити календар. Спробуйте ще раз.')
      const next = day === undefined ? parseWinterAdventState(data) : parseWinterAdventClaim(data, day)
      if (next.userId !== userId) throw new Error('Не вдалося перевірити власника колекції. Оновіть сторінку.')
      if (mounted.current && owner.current === userId && sequence === version.current) { received.current = performance.now(); setSnapshot(next) }
      return next
    } catch (cause) {
      const message = cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'Не вдалося з’єднатися. Подарунки, які вже відкриті, збережено. Спробуйте ще раз.'
      if (mounted.current && owner.current === userId && sequence === version.current) setError(message)
      throw new Error(message)
    } finally {
      clearTimeout(timer)
      if (active.current === controller) active.current = null
      if (mounted.current && owner.current === userId && sequence === version.current) {
        setLoading(false)
        // A clock/online refresh must survive an in-flight claim, including a
        // failed claim. Consume it once; failures never schedule their own retry.
        if (pendingRefresh.current) {
          pendingRefresh.current = false
          void runRequest().catch(() => {})
        }
      }
    }
  }, [])
  const refresh = useCallback(() => {
    if (active.current) { pendingRefresh.current = true; return }
    void request().catch(() => {})
  }, [request])
  useEffect(() => {
    mounted.current = true; ++version.current; active.current?.abort(); active.current = null; pendingRefresh.current = false
    setSnapshot(null); setError(''); setLoading(false)
    if (!authLoading && !isPasswordRecovery) refresh()
    return () => { mounted.current = false; ++version.current; active.current?.abort(); active.current = null; pendingRefresh.current = false }
  }, [authUser?.id, authLoading, isPasswordRecovery, refresh])
  useEffect(() => {
    if (authLoading || isPasswordRecovery) return
    const online = () => refresh()
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [authLoading, isPasswordRecovery, refresh])
  const state = snapshot?.userId === (authUser?.id || null) ? snapshot : null
  useEffect(() => {
    if (!state || state.phase === 'ended' || authLoading || isPasswordRecovery) return
    const boundary = Date.parse(state.startsAt) + state.currentDay * 86_400_000
    const delay = Math.max(20, boundary - Date.parse(state.serverNow) + 100)
    const due = received.current + delay
    const timer = setTimeout(refresh, Math.min(delay, 2_147_483_600))
    const visible = () => { if (!document.hidden && performance.now() >= due) refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [state, authLoading, isPasswordRecovery, refresh])
  return <>{authOpen && <AuthModal onClose={() => setAuthOpen(false)}/>}<WinterCalendarView key={authUser?.id || 'guest'} state={state} loading={loading || authLoading} error={error} onRefresh={refresh} onSignIn={() => setAuthOpen(true)} onClaim={async day => { await request(day) }}/></>
}
