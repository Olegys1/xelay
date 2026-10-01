import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CreditCard, Gift, Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { createGroupCheckout, getBillingConfiguration, openHostedCheckout, reconcilePayment, returnedPaymentReference, type BillingConfiguration } from '../lib/billing'

interface GroupAccess {
  is_active: boolean
  source: 'free' | 'payment' | 'admin_grant' | null
  can_edit: boolean
  payment_required: boolean
  enforcement_enabled: boolean
}

export function GroupBillingPanel({ groupId, isRepresentative, onCanEditChange }: {
  groupId: string; isRepresentative: boolean; onCanEditChange: (canEdit: boolean) => void
}) {
  const { authUser } = useAuth()
  const [access, setAccess] = useState<GroupAccess | null>(null)
  const [configuration, setConfiguration] = useState<BillingConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [buying, setBuying] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef(true)
  const refreshLock = useRef(false)
  const buyLock = useRef(false)
  const returnedOrder = useRef(returnedPaymentReference())

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
          onCanEditChange(true)
          setNotice('Оплата груп ще готується до запуску.')
          return
        }
        throw accessError
      }
      if (!data || typeof data.is_active !== 'boolean' || typeof data.can_edit !== 'boolean') throw new Error('Invalid group access')
      setAccess(data as GroupAccess)
      onCanEditChange(data.can_edit)
      setNotice(data.is_active ? '' : data.enforcement_enabled
        ? 'Староста може активувати розклад, домашні завдання та семінари для всієї групи.'
        : 'Розклад доступний під час підготовки оплат.')
      try {
        const nextConfiguration = await getBillingConfiguration()
        if (active.current) setConfiguration(nextConfiguration)
      } catch { if (active.current) setConfiguration(null) }
      if (active.current && paymentError && !data.is_active) setError(paymentError)
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

  const buy = async () => {
    if (!isRepresentative || buyLock.current || loading || access?.is_active || !configuration?.checkoutAvailable) return
    if (configuration.mode === 'test' && !window.confirm('Це тестова оплата. Вона не активує доступ до робочої групи. Продовжити?')) return
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

  return <section aria-label="Доступ до навчальної групи" className="mb-6 rounded-2xl border border-primary/15 bg-primary/5 p-4 sm:p-5">
    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:flex-wrap">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 text-primary">{access?.source === 'free' ? <Gift size={23} /> : access?.is_active ? <CheckCircle2 size={23} /> : <CreditCard size={23} />}</span>
        <div className="min-w-0"><h2 className="font-semibold">{loading ? 'Перевіряємо доступ…' : access?.source === 'free' ? 'Перша група Xelay — безкоштовно' : access?.is_active ? 'Розклад групи активовано' : 'Доступ для всієї групи'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{access?.is_active ? 'Розклад, домашні завдання та семінари доступні без щомісячних платежів.' : '750 грн одноразово за цю групу. Особиста підписка «Учасник» купується окремо.'}</p>
          {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {isRepresentative && !access?.is_active && <button type="button" onClick={() => void buy()} disabled={loading || buying || !access || !configuration?.checkoutAvailable} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {buying ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}{configuration?.checkoutAvailable ? configuration.mode === 'test' ? 'Тестова оплата · 750 грн' : 'Активувати · 750 грн' : 'Оплата скоро'}
        </button>}
        <button type="button" onClick={() => void refresh(true)} disabled={loading || buying} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/20 bg-background px-3.5 py-2.5 text-xs font-semibold text-primary disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{returnedOrder.current ? 'Перевірити оплату' : 'Оновити доступ'}</button>
      </div>
    </div>
    {configuration?.mode === 'test' && <p className="mt-3 text-xs text-muted-foreground">Тестові транзакції не надають доступу й не є реальними покупками.</p>}
    {returnedOrder.current && !access?.is_active && !loading && !error && <p role="status" className="mt-3 text-xs text-muted-foreground">Доступ з’явиться після підтвердження WayForPay. Саме повернення на сторінку не означає успішної оплати.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </section>
}
