import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, CreditCard, Gift, Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { createGroupCheckout, getBillingConfiguration, openHostedCheckout, reconcilePayment, returnedPaymentReference, type BillingConfiguration } from '../lib/billing'
import { legalMerchant } from '../lib/legal'
import { CheckoutLegalConsent } from './LegalLinks'
import { groupContentAccess, parseGroupBillingStatus, type GroupBillingStatus } from '../lib/billingState'

interface GroupBillingPanelProps {
  groupId: string; isRepresentative: boolean; onCanEditChange: (canEdit: boolean) => void
}

const formatGroupExpiry = (value?: string | null, includeTime = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(new Date(value))
}

const trialTimeRemaining = (expiresAt: string | null, now: number) => {
  const remaining = expiresAt ? Date.parse(expiresAt) - now : 0
  if (remaining <= 0) return 'Пробний період завершився'
  const day = 86_400_000
  if (remaining < day) {
    const totalMinutes = Math.ceil(remaining / 60_000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return hours ? `Останній день · залишилося ${hours} год${minutes ? ` ${minutes} хв` : ''}` : `Залишилося ${totalMinutes} хв`
  }
  const days = Math.ceil(remaining / day)
  const noun = new Intl.PluralRules('uk-UA').select(days)
  return `Залишилося ${days} ${noun === 'one' ? 'день' : noun === 'few' ? 'дні' : 'днів'}`
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
  const expiry = formatGroupExpiry(access?.expires_at)
  const trialExpiry = formatGroupExpiry(access?.trial_expires_at, true)
  const trialActive = Boolean(access?.trial_active && access.trial_expires_at && Date.parse(access.trial_expires_at) > now)
  const accessActive = Boolean(access?.is_active && (access.is_lifetime || (access.expires_at && Date.parse(access.expires_at) > now)))
  const trialFinished = !accessActive && Boolean(access?.trial_expired || (access?.trial_expires_at
    && Date.parse(access.trial_expires_at) <= now
    && (!access.expires_at || Date.parse(access.expires_at) === Date.parse(access.trial_expires_at))))

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

  return <section aria-label="Доступ до навчальної групи" className="mb-6 rounded-2xl border border-primary/15 bg-primary/5 p-4 sm:p-5">
    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:flex-wrap">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 text-primary">{trialActive ? <Clock3 size={23} /> : access?.source === 'free' ? <Gift size={23} /> : accessActive ? <CheckCircle2 size={23} /> : <CreditCard size={23} />}</span>
        <div className="min-w-0"><h2 className="font-semibold">{loading ? 'Перевіряємо доступ…' : trialActive ? '7 днів для вашої групи — безкоштовно' : trialFinished ? 'Пробний період завершився' : access?.source === 'free' ? 'Безкоштовний доступ групи' : accessActive ? 'Розклад групи активовано' : 'Доступ для всієї групи'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{trialActive
            ? 'Спробуйте розклад, домашні завдання та семінари разом з усіма учасниками групи.'
            : accessActive
            ? 'Розклад, домашні завдання та семінари доступні всім учасникам цієї групи.'
            : '750 грн / рік за цю групу. Без автоматичних списань. Особиста підписка «Учасник» купується окремо.'}</p>
          {trialActive && <><p className="mt-2 text-sm font-medium text-primary">{trialTimeRemaining(access?.trial_expires_at || null, now)}</p><p className="mt-1 text-xs text-muted-foreground">Пробний доступ до {trialExpiry} за київським часом. Потім — 750 грн / рік, оплата вручну, без автоматичних списань.</p><p className="mt-1 text-xs text-muted-foreground">Якщо оплатити зараз, рік почнеться після пробного періоду. Без оплати дані збережуться для перегляду, а редагування відновиться після оплати.</p></>}
          {!trialActive && expiry && access?.source !== 'trial' && !trialFinished && <p className="mt-2 text-sm font-medium text-primary">{accessActive ? 'Доступ оплачено до' : 'Оплачений період завершився'} {expiry}.</p>}
          {!trialActive && accessActive && access?.can_renew && <p className="mt-1 text-xs text-muted-foreground">Продовження за 750 грн додасть один календарний рік до оплаченого періоду. Автоматичних списань немає.</p>}
          {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void refresh(true)} disabled={loading || buying} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/20 bg-background px-3.5 py-2.5 text-xs font-semibold text-primary disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{returnedOrder.current ? 'Перевірити оплату' : 'Оновити доступ'}</button>
      </div>
    </div>
    {canPurchase && <div className="mt-4 space-y-4 border-t border-primary/15 pt-4">
      <CheckoutLegalConsent checked={acceptedTerms} onChange={setAcceptedTerms} disabled={loading || buying} />
      <button type="button" onClick={() => void buy()} disabled={loading || buying || !paymentAvailable || !acceptedTerms} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
        {buying ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
        {buying ? 'Готуємо оплату…' : paymentAvailable
          ? configuration?.mode === 'test' ? 'Тестова оплата · 750 грн / рік' : trialActive ? 'Оплатити рік · 750 грн' : accessActive ? 'Продовжити · 750 грн / рік' : 'Активувати · 750 грн / рік'
          : 'Оплата ще не підключена'}
      </button>
      {!paymentAvailable && !loading && <p className="text-xs text-muted-foreground">Оплата ще не підключена.</p>}
    </div>}
    {configuration?.mode === 'test' && <p className="mt-3 text-xs text-muted-foreground">Тестові транзакції не надають доступу й не є реальними покупками.</p>}
    {returnedOrder.current && !loading && !error && <p role="status" className="mt-3 text-xs text-muted-foreground">Активація чи продовження доступу відбуваються лише після підтвердження WayForPay. Саме повернення на сторінку не означає успішної оплати.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </section>
}
