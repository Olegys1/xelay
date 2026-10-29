import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuth } from './AuthContext'
import { guideKey, hasSeenGuide, onboardingProgress, OPEN_PLATFORM_GUIDE } from '../lib/onboarding'
import { EMPTY_HOME_GUIDE, homeGuideKey, homeGuideView, readHomeGuideProgress, saveHomeGuideProgress, validHomeGuideStep, type HomeGuideController, type HomeGuideProgress } from '../lib/homeGuide'

const OnboardingContext = createContext<{ suspended: boolean; homeGuide: HomeGuideController }>({
  suspended: false, homeGuide: EMPTY_HOME_GUIDE,
})
export const useOnboarding = () => useContext(OnboardingContext)

export function ApplicationOnboarding({ children }: { children: ReactNode }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  return <AccountOnboarding key={authUser?.id || 'guest'} userId={authUser?.id}
    eligible={Boolean(xelayUser && xelayUser.id === authUser?.id && !xelayUser.has_seen_onboarding)}
    pending={isLoading || isPasswordRecovery || Boolean(authUser && (!xelayUser || xelayUser.id !== authUser.id))}>{children}</AccountOnboarding>
}

function AccountOnboarding({ userId, eligible, pending, children }: { userId?: string; eligible: boolean; pending: boolean; children: ReactNode }) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const key = homeGuideKey(userId || 'guest')
  const legacyKey = guideKey(userId || 'guest', 'platform')
  const [legacy] = useState(() => ({ seen: hasSeenGuide(legacyKey), paused: onboardingProgress(legacyKey)?.paused === true }))
  const [progress, setProgress] = useState<HomeGuideProgress | null>(() => readHomeGuideProgress(key))
  const previousPath = useRef(pathname)
  const view = homeGuideView({ userId, pending, pathname, eligible, legacySeen: legacy.seen, legacyPaused: legacy.paused, progress })

  const updateProgress = useCallback((value: HomeGuideProgress) => {
    if (saveHomeGuideProgress(key, value)) setProgress(value)
  }, [key])

  const start = useCallback(() => {
    if (!userId) return
    updateProgress({ status: 'active', step: 0 })
    if (pathname !== '/') void navigate({ to: '/' })
  }, [userId, pathname, navigate, updateProgress])

  const setStep = useCallback((step: number) => {
    if (!userId || !view.available || !validHomeGuideStep(step)) return
    updateProgress({ status: 'active', step })
  }, [userId, view.available, updateProgress])

  const pause = useCallback(() => {
    if (userId) updateProgress({ status: 'paused', step: progress?.step ?? 0 })
  }, [userId, progress?.step, updateProgress])

  const finish = useCallback(() => {
    if (!userId || !view.available) return
    updateProgress({ status: 'complete', step: progress?.step ?? 0 })
  }, [userId, view.available, progress?.step, updateProgress])

  useEffect(() => {
    const leftHome = previousPath.current === '/' && pathname !== '/'
    previousPath.current = pathname
    // Navigation remains usable during the tour. Returning never reopens it.
    if (leftHome && (progress?.status === 'active' || (!progress && eligible && !legacy.seen && !legacy.paused))) pause()
  }, [pathname, progress, eligible, legacy.seen, legacy.paused, pause])

  useEffect(() => {
    window.addEventListener(OPEN_PLATFORM_GUIDE, start)
    return () => window.removeEventListener(OPEN_PLATFORM_GUIDE, start)
  }, [start])

  const homeGuide: HomeGuideController = { ...view, start, setStep, pause, finish }
  // The homepage renders its own anchored coach marks. No global modal, body
  // scroll lock, profile mutation or registration step is mounted here.
  return <OnboardingContext.Provider value={{ suspended: pending || view.open, homeGuide }}>{children}</OnboardingContext.Provider>
}
