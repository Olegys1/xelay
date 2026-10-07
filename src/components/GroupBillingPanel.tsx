import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { reconcilePayment, returnedPaymentReference } from '../lib/billing'
import { GroupBillingPanelView } from './GroupBillingPanelView'
import { groupContentAccess, parseGroupBillingStatus, type GroupBillingStatus } from '../lib/billingState'

interface GroupBillingPanelProps {
  groupId: string; onCanEditChange: (canEdit: boolean) => void
}

export function GroupBillingPanel(props: GroupBillingPanelProps) {
  const { authUser } = useAuth()
  return <GroupAccessWorkspace key={`${authUser?.id || 'guest'}:${props.groupId}`} {...props} />
}

function GroupAccessWorkspace({ groupId, onCanEditChange }: GroupBillingPanelProps) {
  const { authUser } = useAuth()
  const [access, setAccess] = useState<GroupBillingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const active = useRef(true)
  const refreshLock = useRef(false)
  const returnedOrder = useRef(returnedPaymentReference())

  const refresh = useCallback(async (checkPayment = false) => {
    if (!authUser || refreshLock.current) return
    refreshLock.current = true
    setLoading(true)
    setError('')
    let paymentError = ''
    try {
      // Historical payments can still be reconciled; no new group checkout exists.
      if (checkPayment && returnedOrder.current) {
        try { await reconcilePayment(returnedOrder.current) }
        catch (failure) { paymentError = failure instanceof Error ? failure.message : 'Не вдалося перевірити попередню оплату.' }
      }
      const { data, error: accessError } = await supabase.rpc('xelay_group_billing_status', { p_group_id: groupId })
      if (!active.current) return
      if (accessError) throw accessError
      const nextAccess = parseGroupBillingStatus(data)
      setAccess(nextAccess)
      // This confirms group membership/access. The workspace checks each role separately.
      onCanEditChange(groupContentAccess(nextAccess, nextAccess.server_now ? Date.parse(nextAccess.server_now) : Date.now()))
      if (paymentError) setError(paymentError)
    } catch {
      if (active.current) {
        setAccess(null)
        setError('Не вдалося перевірити доступ групи. Спробуйте ще раз.')
        onCanEditChange(false)
      }
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

  return <GroupBillingPanelView freeAccess={access?.is_free === true} loading={loading} error={error}
    returnedOrder={Boolean(returnedOrder.current)} onRefresh={() => void refresh(true)} />
}