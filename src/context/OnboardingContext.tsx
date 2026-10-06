import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAuth } from './AuthContext'
import { supabase } from '../lib/supabase'
import { guideKey, hasSeenGuide, OPEN_PLATFORM_GUIDE, rememberGuide } from '../lib/onboarding'
import { OnboardingModal, type IntroRoute } from '../components/OnboardingModal'

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
  const key = guideKey(userId || 'guest', 'platform')
  const [finished, setFinished] = useState(() => hasSeenGuide(key))
  const [replay, setReplay] = useState(false)
  const open = Boolean(userId && !pending && (replay || (eligible && !finished)))

  useEffect(() => {
    const show = () => { if (userId) setReplay(true) }
    window.addEventListener(OPEN_PLATFORM_GUIDE, show)
    return () => window.removeEventListener(OPEN_PLATFORM_GUIDE, show)
  }, [userId])

  const finish = useCallback((route?: IntroRoute) => {
    if (!userId) return
    rememberGuide(key)
    setFinished(true)
    setReplay(false)
    // Reuse the existing preference; no permissions, subscription or profile data change.
    void supabase.from('profiles').update({ has_seen_onboarding: true }).eq('id', userId)
      .then(() => {}, () => {})
    if (route) void navigate({ to: route })
  }, [userId, key, navigate])

  return <OnboardingContext.Provider value={{ suspended: pending || open }}>
    {children}
    {open && <OnboardingModal onFinish={finish} />}
  </OnboardingContext.Provider>
}
