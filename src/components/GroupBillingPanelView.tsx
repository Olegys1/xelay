import { CheckCircle2, ChevronDown, Clock3, CreditCard, Gift, Loader2, RefreshCw } from 'lucide-react'
import type { GroupBillingStatus } from '../lib/billingState'
import { CheckoutLegalConsent } from './LegalLinks'
import { GroupPricingDetails } from './GroupPricingDetails'

interface GroupBillingPanelViewProps {
  access: GroupBillingStatus | null
  now: number
  loading: boolean
  buying: boolean
  canPurchase: boolean
  paymentAvailable: boolean
  isTest: boolean
  acceptedTerms: boolean
  notice: string
  error: string
  returnedOrder: boolean
  onRefresh: () => void
  onBuy: () => void
  onAcceptTerms: (accepted: boolean) => void
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

/** Presentation only. The workspace retains all access and checkout checks. */
export function GroupBillingPanelView({ access, now, loading, buying, canPurchase, paymentAvailable, isTest, acceptedTerms, notice, error, returnedOrder, onRefresh, onBuy, onAcceptTerms }: GroupBillingPanelViewProps) {
  const expiry = formatGroupExpiry(access?.expires_at)
  const trialExpiry = formatGroupExpiry(access?.trial_expires_at, true)
  const trialActive = Boolean(access?.trial_active && access.trial_expires_at && Date.parse(access.trial_expires_at) > now)
  const accessActive = Boolean(access?.is_active && (access.is_lifetime || (access.expires_at && Date.parse(access.expires_at) > now)))
  const trialFinished = !accessActive && Boolean(access?.trial_expired || (access?.trial_expires_at
    && Date.parse(access.trial_expires_at) <= now
    && (!access.expires_at || Date.parse(access.expires_at) === Date.parse(access.trial_expires_at))))

  return <section aria-label="Доступ до навчальної групи" className="mb-6 rounded-2xl border border-primary/15 bg-primary/5 p-4 sm:p-5">
    <details className="group/billing">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-lg [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="shrink-0 text-primary">{trialActive ? <Clock3 size={23} /> : accessActive ? <CheckCircle2 size={23} /> : <CreditCard size={23} />}</span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{loading ? 'Перевіряємо доступ…' : trialActive ? 'Пробний доступ групи' : trialFinished ? 'Пробний період завершився' : accessActive ? 'Доступ групи активовано' : 'Доступ для всієї групи'}</h2>
            <p className="mt-1 text-sm text-primary">{trialActive ? trialTimeRemaining(access?.trial_expires_at || null, now)
              : accessActive && access?.is_lifetime ? 'Безстроковий доступ'
              : expiry ? `${accessActive ? 'Оплачено до' : 'Доступ завершився'} ${expiry}`
              : 'Умови та оплата доступу групи'}</p>
          </div>
        </div>
        <span className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">
          <span className="group-open/billing:hidden">Розгорнути</span>
          <span className="hidden group-open/billing:inline">Згорнути</span>
          <ChevronDown size={18} className="transition-transform motion-reduce:transition-none group-open/billing:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="mt-4 border-t border-primary/15 pt-4">
    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:flex-wrap">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 text-primary">{trialActive ? <Clock3 size={23} /> : access?.source === 'free' ? <Gift size={23} /> : accessActive ? <CheckCircle2 size={23} /> : <CreditCard size={23} />}</span>
        <div className="min-w-0"><h2 className="font-semibold">{loading ? 'Перевіряємо доступ…' : trialActive ? '7 днів для вашої групи — безкоштовно' : trialFinished ? 'Пробний період завершився' : access?.source === 'free' ? 'Безкоштовний доступ групи' : accessActive ? 'Доступ групи активовано' : 'Усе для навчання вашої групи — в одному місці'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{trialActive
            ? 'Спробуйте розклад, домашні завдання, семінари й матеріали разом з усією групою.'
            : accessActive
            ? 'Розклад, домашні завдання, семінари й матеріали доступні всім учасникам цієї групи.'
            : 'Розклад, домашні завдання, семінари й матеріали — щоб потрібне було під рукою у кожного.'}</p>
          {trialActive && <><p className="mt-2 text-sm font-medium text-primary">{trialTimeRemaining(access?.trial_expires_at || null, now)}</p><p className="mt-1 text-xs text-muted-foreground">Пробний доступ до {trialExpiry} за київським часом. Після пробного періоду ви самі вирішуєте, чи оплачувати доступ на рік.</p><p className="mt-1 text-xs text-muted-foreground">Якщо оплатити зараз, рік почнеться після пробного періоду. Без оплати дані збережуться для перегляду, а редагування відновиться після оплати.</p></>}
          {!trialActive && expiry && access?.source !== 'trial' && !trialFinished && <p className="mt-2 text-sm font-medium text-primary">{accessActive ? 'Доступ оплачено до' : 'Оплачений період завершився'} {expiry}.</p>}
          {!trialActive && accessActive && !access?.is_lifetime && expiry && (access?.source === 'payment' || access?.can_renew) && <div className="mt-3 rounded-xl border border-primary/15 bg-background/70 px-3 py-2.5">
            <p className="text-sm font-medium text-primary">Дата наступної оплати для продовження: {expiry}</p>
            <p className="mt-1 text-xs text-muted-foreground">Оплата вручну — автоматичного списання не буде.</p>
          </div>}
          {!trialActive && accessActive && access?.can_renew && <p className="mt-1 text-xs text-muted-foreground">Продовження додасть один календарний рік до оплаченого доступу.</p>}
          {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRefresh} disabled={loading || buying} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/20 bg-background px-3.5 py-2.5 text-xs font-semibold text-primary disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{returnedOrder ? 'Перевірити оплату' : 'Оновити доступ'}</button>
      </div>
    </div>
    {!loading && access && !access.is_lifetime && (!accessActive || trialActive || access.can_renew) && <div className="mt-4 border-t border-primary/15 pt-4"><GroupPricingDetails /></div>}
    {canPurchase && <div className="mt-4 space-y-4 border-t border-primary/15 pt-4">
      <CheckoutLegalConsent checked={acceptedTerms} onChange={onAcceptTerms} disabled={loading || buying} />
      <button type="button" onClick={onBuy} disabled={loading || buying || !paymentAvailable || !acceptedTerms} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
        {buying ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
        {buying ? 'Готуємо оплату…' : paymentAvailable
          ? isTest ? 'Тестова оплата · 750 грн / рік' : accessActive && !trialActive ? 'Продовжити рік для групи — 750 грн' : 'Оплатити рік для групи — 750 грн'
          : 'Оплата ще не підключена'}
      </button>
      {!paymentAvailable && !loading && <p className="text-xs text-muted-foreground">Оплата ще не підключена.</p>}
    </div>}
    {isTest && <p className="mt-3 text-xs text-muted-foreground">Тестові транзакції не надають доступу й не є реальними покупками.</p>}
    {returnedOrder && !loading && !error && <p role="status" className="mt-3 text-xs text-muted-foreground">Активація чи продовження доступу відбуваються лише після підтвердження WayForPay. Саме повернення на сторінку не означає успішної оплати.</p>}
      </div>
    </details>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </section>
}
