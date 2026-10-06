import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuth } from './AuthContext'
import { supabase } from '../lib/supabase'
import { guideKey, hasSeenGuide, onboardingProgress, OPEN_PLATFORM_GUIDE, rememberGuide, saveOnboardingProgress } from '../lib/onboarding'
import { OnboardingModal, ONBOARDING_STEP_COUNT, type IntroRoute } from '../components/OnboardingModal'

const OnboardingContext = createContext({ suspended: false })
export const useOnboarding = () => useContext(OnboardingContext)

export function ApplicationOnboarding({ children }: { children: ReactNode }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  return <AccountOnboarding key={authUser?.id || 'guest'} userId={authUser?.id}
    eligible={Boolean(xelayUser && xelayUser.id === authUser?.id && !xelayUser.has_seen_onboarding)}
    pending={isLoading || isPasswordRecovery || Boolean(authUser && !xelayUser)}>{children}</AccountOnboarding>
}

function AccountOnboarding({ userId, eligible, pending, children }: { userId?: string; eligible: boolean; pending: boolean; children: ReactNode }) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const key = guideKey(userId || 'guest', 'platform')
  const [finished, setFinished] = useState(() => hasSeenGuide(key))
  const [replay, setReplay] = useState(false)
  const [progress, setProgress] = useState(() => {
    const saved = onboardingProgress(key)
    return saved ? { ...saved, step: Math.min(saved.step, ONBOARDING_STEP_COUNT - 1) } : null
  })
  const previousPath = useRef<string | null>(null)
  const open = Boolean(userId && !pending && !progress?.paused && (progress || replay || (eligible && !finished)))

  const updateProgress = useCallback((value: { step: number; paused: boolean } | null) => {
    saveOnboardingProgress(key, value)
    setProgress(value)
  }, [key])

  useEffect(() => {
    if (pending) return
    const returnedHome = pathname === '/' && previousPath.current !== '/'
    previousPath.current = pathname
    if (userId && returnedHome && progress?.paused) updateProgress({ ...progress, paused: false })
  }, [userId, pathname, pending, progress, updateProgress])

  useEffect(() => {
    const show = () => {
      if (!userId) return
      // Continue an unfinished overview; a completed overview restarts at step one.
      updateProgress({ step: progress?.step ?? 0, paused: false })
      setReplay(true)
    }
    window.addEventListener(OPEN_PLATFORM_GUIDE, show)
    return () => window.removeEventListener(OPEN_PLATFORM_GUIDE, show)
  }, [userId, progress, updateProgress])

  const pause = useCallback(() => {
    if (userId) updateProgress({ step: progress?.step ?? 0, paused: true })
  }, [userId, progress?.step, updateProgress])

  const visit = useCallback((route: IntroRoute) => {
    pause()
    void navigate({ to: route })
  }, [pause, navigate])

  const finish = useCallback(() => {
    if (!userId || progress?.step !== ONBOARDING_STEP_COUNT - 1) return
    rememberGuide(key)
    updateProgress(null)
    setFinished(true)
    setReplay(false)
    // Reuse the existing preference; no permissions, subscription or profile data change.
    void supabase.from('profiles').update({ has_seen_onboarding: true }).eq('id', userId)
      .then(() => {}, () => {})
  }, [userId, key, progress?.step, updateProgress])

  return <OnboardingContext.Provider value={{ suspended: pending || open }}>
    {children}
    {open && <OnboardingModal step={progress?.step ?? 0}
      onStepChange={(step) => updateProgress({ step, paused: false })}
      onPause={pause} onVisit={visit} onFinish={finish} />}
  </OnboardingContext.Provider>
}
