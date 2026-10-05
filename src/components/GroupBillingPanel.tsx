import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { createGroupCheckout, getBillingConfiguration, openHostedCheckout, reconcilePayment, returnedPaymentReference, type BillingConfiguration } from '../lib/billing'
import { legalMerchant } from '../lib/legal'
import { GroupBillingPanelView } from './GroupBillingPanelView'
import { groupContentAccess, parseGroupBillingStatus, type GroupBillingStatus } from '../lib/billingState'

interface GroupBillingPanelProps {
  groupId: string; isRepresentative: boolean; onCanEditChange: (canEdit: boolean) => void
}

export function GroupBillingPanel(props: GroupBillingPanelProps) {
  const { authUser } = useAuth()
  return <GroupBillingWorkspace key={`${authUser?.id || 'guest'}:${props.groupId}`} {...props} />
}

function GroupBillingWorkspace({ groupId, isRepresentative, onCanEditChange }: GroupBillingPanelProps) {
  const { authUser } = useAuth()
  const [access, setAccess] = useState<GroupBillingStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [configuration, setConfiguration] = useState<BillingConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [buying, setBuying] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef(true)
  const clock = useRef({ serverTime: Date.now(), receivedTime: performance.now() })
  const refreshLock = useRef(false)
  const buyLock = useRef(false)
  const returnedOrder = useRef(returnedPaymentReference())
  const currentAccessTime = useCallback(() => clock.current.serverTime + Math.max(0, performance.now() - clock.current.receivedTime), [])

  const refresh = useCallback(async (checkPayment = false) => {
    if (!authUser || refreshLock.current) return
    refreshLock.current = true
    setLoading(true)
    setError('')
    let paymentError = ''
    try {
      if (checkPayment && returnedOrder.current) {
        try { await reconcilePayment(returnedOrder.current) }
        catch (failure) { paymentError = failure instanceof Error ? failure.message : 'Не вдалося перевірити оплату.' }
      }
      const { data, error: accessError } = await supabase.rpc('xelay_group_billing_status', { p_group_id: groupId })
      if (!active.current) return
      if (accessError) {
        if (isMissingDatabaseFunction(accessError)) {
          setAccess(null)
          onCanEditChange(false)
          setNotice('Не вдалося підтвердити доступ. Розклад, домашні завдання та семінари поки доступні для перегляду.')
          return
        }
        throw accessError
      }
      const nextAccess = parseGroupBillingStatus(data)
      const currentTime = nextAccess.server_now ? Date.parse(nextAccess.server_now) : Date.now()
      clock.current = { serverTime: currentTime, receivedTime: performance.now() }
      setAccess(nextAccess)
      setNow(currentTime)
      // The workspace applies the user's role separately from this group access gate.
      onCanEditChange(groupContentAccess(nextAccess, currentTime))
      setNotice(nextAccess.is_active ? '' : nextAccess.enforcement_enabled
        ? 'Дані групи збережені й доступні для перегляду. Староста може оплатити рік, щоб продовжити роботу.'
        : 'Розклад доступний під час підготовки оплат.')
      try {
        const nextConfiguration = await getBillingConfiguration()
        if (active.current) setConfiguration(nextConfiguration)
      } catch { if (active.current) setConfiguration(null) }
      if (active.current && paymentError) setError(paymentError)
    } catch {
      if (active.current) { setAccess(null); setError('Не вдалося перевірити доступ групи. Спробуйте ще раз.'); onCanEditChange(false) }
    } finally {
      refreshLock.current = false
      if (active.current) setLoading(false)
    }
  }, [authUser?.id, groupId, onCanEditChange])

  useEffect(() => {
    active.current = true
    void refresh(Boolean(returnedOrder.current))
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(onFocus, 60_000)
    return () => { active.current = false; window.removeEventListener('focus', onFocus); window.clearInterval(interval) }
  }, [refresh])

  useEffect(() => { setAcceptedTerms(false) }, [authUser?.id, groupId])

  useEffect(() => {
    if (!access?.is_active || access.is_lifetime || !access.enforcement_enabled || !access.expires_at) return
    let timer: number
    const schedule = () => {
      const remaining = Date.parse(access.expires_at!) - currentAccessTime()
      if (remaining <= 0) { setNow(currentAccessTime()); onCanEditChange(false); return }
      timer = window.setTimeout(() => {
        if (Date.parse(access.expires_at!) > currentAccessTime()) { schedule(); return }
        setNow(currentAccessTime())
        onCanEditChange(false)
        void refresh()
      }, Math.min(remaining + 50, 2_147_483_600))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [access, currentAccessTime, onCanEditChange, refresh])

  useEffect(() => {
    if (!access?.trial_active) return
    const interval = window.setInterval(() => setNow(currentAccessTime()), 30_000)
    return () => window.clearInterval(interval)
  }, [access?.trial_active, currentAccessTime])

  const canPurchase = isRepresentative && Boolean(access) && !access?.is_lifetime && (!access?.is_active || access?.can_renew === true)
  const paymentAvailable = legalMerchant.ready && Boolean(configuration?.checkoutAvailable) && configuration?.groupLicenseAvailable !== false

  const buy = async () => {
    if (!authUser || !canPurchase || !acceptedTerms || buyLock.current || loading || !paymentAvailable) return
    if (configuration?.mode === 'test' && !window.confirm('Це тестова оплата. Вона не активує доступ до робочої групи. Продовжити?')) return
    buyLock.current = true
    setBuying(true)
    setError('')
    try {
      const result = await createGroupCheckout(groupId)
      if (active.current) openHostedCheckout(result.checkout)
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : 'Не вдалося відкрити оплату.')
    } finally {
      buyLock.current = false
      if (active.current) setBuying(false)
    }
  }

  return <GroupBillingPanelView access={access} now={now} loading={loading} buying={buying}
    canPurchase={canPurchase} paymentAvailable={paymentAvailable} isTest={configuration?.mode === 'test'}
    acceptedTerms={acceptedTerms} notice={notice} error={error} returnedOrder={Boolean(returnedOrder.current)}
    onRefresh={() => void refresh(true)} onBuy={() => void buy()} onAcceptTerms={setAcceptedTerms} />
}
