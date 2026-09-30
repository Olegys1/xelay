import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { currentParticipantStatus, EMPTY_PARTICIPANT_STATUS, parseParticipantStatus, type ParticipantStatus } from '../lib/billingState'

interface BillingState extends ParticipantStatus {
  isLoading: boolean
  error: string
  refreshBilling: () => Promise<boolean>
}

const BillingContext = createContext<BillingState>({
  ...EMPTY_PARTICIPANT_STATUS, isLoading: true, error: '', refreshBilling: async () => false,
})

export function BillingProvider({ children }: { children: ReactNode }) {
  const { authUser } = useAuth()
  const [snapshot, setSnapshot] = useState<{ userId: string | null; status: ParticipantStatus }>({ userId: null, status: EMPTY_PARTICIPANT_STATUS })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const currentUser = useRef(authUser?.id)
  currentUser.current = authUser?.id
  const requestSequence = useRef(0)

  const refreshBilling = useCallback(async () => {
    const userId = authUser?.id
    const sequence = ++requestSequence.current
    if (!userId) {
      setSnapshot({ userId: null, status: EMPTY_PARTICIPANT_STATUS })
      setIsLoading(false)
      setError('')
      return true
    }
    try {
      const { data, error: statusError } = await supabase.rpc('xelay_billing_status')
      if (currentUser.current !== userId || sequence !== requestSequence.current) return false
      if (statusError) throw statusError
      setSnapshot({ userId, status: parseParticipantStatus(data) })
      setError('')
      return true
    } catch (statusError) {
      if (currentUser.current !== userId || sequence !== requestSequence.current) return false
      setSnapshot({ userId, status: EMPTY_PARTICIPANT_STATUS })
      setError(isMissingDatabaseFunction(statusError as { code?: string })
        ? 'Підписка ще готується до запуску. Платні можливості поки недоступні.'
        : 'Не вдалося перевірити підписку. Оновіть сторінку або спробуйте пізніше.')
      return false
    } finally {
      if (currentUser.current === userId && sequence === requestSequence.current) setIsLoading(false)
    }
  }, [authUser?.id])

  useEffect(() => {
    setSnapshot({ userId: authUser?.id ?? null, status: EMPTY_PARTICIPANT_STATUS })
    setIsLoading(true)
    setError('')
    void refreshBilling()
    if (!authUser?.id) return () => { ++requestSequence.current }
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshBilling()
    }, 60_000)
    const onFocus = () => void refreshBilling()
    window.addEventListener('focus', onFocus)
    return () => {
      ++requestSequence.current
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshBilling])

  const ownsSnapshot = snapshot.userId === (authUser?.id ?? null)
  const status = ownsSnapshot ? currentParticipantStatus(snapshot.status) : EMPTY_PARTICIPANT_STATUS

  useEffect(() => {
    if (!ownsSnapshot || !snapshot.status.isPremium || !snapshot.status.expiresAt) return
    const userId = snapshot.userId
    const expiresAt = snapshot.status.expiresAt
    let timer: number
    const schedule = () => {
      const remaining = Date.parse(expiresAt) - Date.now()
      timer = window.setTimeout(() => {
        if (Date.parse(expiresAt) > Date.now()) { schedule(); return }
        setSnapshot((current) => current.userId === userId
          ? { ...current, status: currentParticipantStatus(current.status) } : current)
        void refreshBilling()
      }, Math.max(0, Math.min(remaining + 50, 2_147_483_600)))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [ownsSnapshot, snapshot.userId, snapshot.status.isPremium, snapshot.status.expiresAt, refreshBilling])

  return <BillingContext.Provider value={{ ...status, isLoading: isLoading || !ownsSnapshot, error: ownsSnapshot ? error : '', refreshBilling }}>{children}</BillingContext.Provider>
}

export const useBilling = () => useContext(BillingContext)
