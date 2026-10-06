import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowUpRight, Check, Heart, Loader2, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { CheckoutLegalConsent } from '../components/LegalLinks'
import { SupporterMark } from '../components/SupporterBadge'
import { SupportThankYou } from '../components/SupportThankYou'
import { useAuth } from '../context/AuthContext'
import { createSupportCheckout, getSupportConfiguration, openHostedCheckout, reconcilePayment, returnedPaymentReference, type SupportConfiguration } from '../lib/billing'
import { legalMerchant } from '../lib/legal'
import { formatSupportAmount, parseSupportAmount, SUPPORT_MAX_KOPIYKAS, SUPPORT_ORDER_REFERENCE } from '../lib/teamSupport'

const statuses = { pending: 'Очікує підтвердження', approved: 'Підтверджено', declined: 'Відхилено', expired: 'Строк оплати минув', refunded: 'Повернено', voided: 'Скасовано' }
const formatDate = (date: string) => new Date(date).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', year: 'numeric' })
const celebratedPayments = new Set<string>()

export function TeamSupportPage() {
  const { authUser } = useAuth()
  // Keep the selected amount through sign-in, while clearing private order state.
  const [amount, setAmount] = useState('100')
  return <SupportWorkspace key={authUser?.id || 'guest'} amount={amount} setAmount={setAmount} />
}

function SupportWorkspace({ amount, setAmount }: { amount: string; setAmount: (amount: string) => void }) {
  const { authUser, isLoading } = useAuth()
  const navigate = useNavigate()
  const [consent, setConsent] = useState(false)
  const [config, setConfig] = useState<SupportConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [authOpen, setAuthOpen] = useState(false)
  const [thankYouReference, setThankYouReference] = useState<string | null>(null)
  const alive = useRef(true)
  const request = useRef(0)
  const paymentLock = useRef(false)
  const checkingLock = useRef(false)
  const [returned] = useState(() => {
    const reference = returnedPaymentReference()
    return reference && SUPPORT_ORDER_REFERENCE.test(reference) ? reference : null
  })
  const kopiykas = parseSupportAmount(amount)
  const max = config?.maxKopiykas ?? SUPPORT_MAX_KOPIYKAS
  const validAmount = kopiykas !== null && kopiykas <= max
  const returnedOrder = config?.orders.find((order) => order.order_reference === returned)

  useEffect(() => {
    // A browser return URL is only a hint: celebrate the owner's order only
    // after the server reports an approved LIVE payment.
    if (!authUser || !returnedOrder || returnedOrder.status !== 'approved' || returnedOrder.mode !== 'live') return
    const key = `xelay_support_thanked:${authUser.id}:${returnedOrder.order_reference}`
    if (celebratedPayments.has(key)) return
    try {
      if (localStorage.getItem(key) === '1') return
      localStorage.setItem(key, '1')
    } catch { /* The in-memory marker still prevents repeats if storage is blocked. */ }
    celebratedPayments.add(key)
    if (celebratedPayments.size > 100) celebratedPayments.delete(celebratedPayments.values().next().value!)
    setThankYouReference(returnedOrder.order_reference)
  }, [authUser?.id, returnedOrder?.order_reference, returnedOrder?.status, returnedOrder?.mode])

  useEffect(() => { alive.current = true; return () => { alive.current = false; ++request.current } }, [])

  const refresh = useCallback(async () => {
    const generation = ++request.current
    try {
      const next = await getSupportConfiguration()
      if (alive.current && generation === request.current) { setConfig(next); setLoading(false) }
      return next
    } catch (problem) {
      if (alive.current && generation === request.current) {
        setLoading(false)
        const message = problem instanceof Error ? problem.message : 'Не вдалося завантажити підтримку.'
        // Plain Vite previews have no Vercel payment API. Show the unavailable
        // button without suggesting that an attempted payment has failed.
        setError(message === 'Оплата ще не підключена. Спробуйте пізніше.' ? '' : message)
      }
      return null
    }
  }, [])

  useEffect(() => {
    if (isLoading) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const checkReturn = async () => {
      const state = await refresh()
      if (cancelled || !authUser || !returned || !state) return
      const order = state.orders.find((item) => item.order_reference === returned)
      if (!order || order.status !== 'pending' || attempts >= 4) return
      if (checkingLock.current) return
      ++attempts
      checkingLock.current = true
      if (alive.current) setChecking(true)
      let retryAfter = 60
      try {
        const result = await reconcilePayment(returned)
        retryAfter = Math.max(60, result.retryAfter)
        await refresh()
      } catch (problem) {
        if (!cancelled && alive.current) setError(problem instanceof Error ? problem.message : 'Не вдалося підтвердити платіж.')
      } finally {
        checkingLock.current = false
        if (alive.current) setChecking(false)
      }
      if (!cancelled && attempts < 4) timer = setTimeout(checkReturn, retryAfter * 1000)
    }
    void checkReturn()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [isLoading, authUser?.id, returned, refresh])

  const pay = async () => {
    if (paymentLock.current) return
    setError('')
    if (!validAmount || kopiykas === null) { setError(`Вкажіть суму від 1 до ${formatSupportAmount(max)} грн, максимум дві цифри після коми.`); return }
    if (!consent) { setError('Підтвердьте згоду з умовами підтримки та повернення.'); return }
    if (!authUser) { setAuthOpen(true); return }
    if (!config?.checkoutAvailable) { setError('Підтримку через оплату ще не підключено.'); return }
    if (config.mode === 'test' && !window.confirm('Це тестова оплата. Вона не надасть бейдж у робочому профілі. Продовжити?')) return
    paymentLock.current = true
    setBusy(true)
    try {
      const result = await createSupportCheckout(kopiykas)
      if (alive.current) openHostedCheckout(result.checkout)
    } catch (problem) {
      if (alive.current) setError(problem instanceof Error ? problem.message : 'Не вдалося підготувати оплату.')
    } finally {
      paymentLock.current = false
      if (alive.current) setBusy(false)
    }
  }

  const check = async (reference: string) => {
    if (checkingLock.current || !authUser) return
    checkingLock.current = true
    setChecking(true)
    setError('')
    try { await reconcilePayment(reference); await refresh() }
    catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : 'Не вдалося перевірити оплату.') }
    finally { checkingLock.current = false; if (alive.current) setChecking(false) }
  }

  return <main className="w-full min-w-0 flex-1 bg-background px-4 py-6 sm:px-6 sm:py-12">
    {thankYouReference && returnedOrder?.order_reference === thankYouReference && returnedOrder.status === 'approved' && returnedOrder.mode === 'live' && <SupportThankYou
      amountKopiykas={returnedOrder.amount_kopiykas} onClose={() => setThankYouReference(null)}
      onViewProfile={() => { setThankYouReference(null); void navigate({ to: '/profile' }) }}
    />}
    {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
    <div className="mx-auto w-full min-w-0 max-w-4xl">
      <button onClick={() => navigate({ to: '/subscription' })} className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:mb-8"><ArrowLeft size={16} />До підписок</button>
      <div className="grid min-w-0 grid-cols-1 gap-6 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
        <section className="min-w-0 self-center">
          <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Heart size={27} strokeWidth={1.6} /></span>
          <p className="mb-3 text-xs font-semibold uppercase tracking-[.16em] text-primary">Створюємо Xelay разом</p>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Підтримати<br />команду Xelay</h1>
          <p className="mt-5 max-w-md text-sm leading-7 text-muted-foreground">Ми розвиваємо простір, де студентам простіше спілкуватися й організовувати навчання. Якщо Xelay допомагає вам щодня — можете підтримати нашу роботу будь-якою зручною сумою.</p>
          <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
            {['Розвиток можливостей для навчання', 'Робота платформи та її інфраструктури', 'Покращення зручності й стабільності'].map((item) => <li key={item} className="flex items-start gap-2.5"><Check size={16} className="mt-0.5 shrink-0 text-primary" />{item}</li>)}
          </ul>
          <div className="mt-7 rounded-2xl border border-border bg-muted/30 p-4">
            <SupporterMark />
            <p className="mt-3 text-xs leading-6 text-muted-foreground">Маленький знак нашої подяки з’явиться у вашому профілі після підтвердженої оплати. Сума підтримки публічно не відображається. Бейдж не відкриває підписку й не надає додаткових прав.</p>
          </div>
        </section>
        <form onSubmit={(event) => { event.preventDefault(); void pay() }} className="w-full min-w-0 max-w-full self-start rounded-3xl border border-primary/15 bg-gradient-to-b from-primary/5 to-card p-4 shadow-sm sm:p-7" aria-labelledby="support-payment-heading">
          <h2 id="support-payment-heading" className="text-lg font-semibold">Сума на ваш вибір</h2>
          <p className="mt-1 text-xs text-muted-foreground">Один платіж. Без автоматичних списань.</p>
          <div className="my-5 grid min-w-0 grid-cols-4 gap-1.5 sm:gap-2" aria-label="Популярні суми">
            {[25, 50, 100, 250].map((value) => <button key={value} type="button" disabled={busy} aria-pressed={kopiykas === value * 100}
              onClick={() => { setAmount(String(value)); setError('') }}
              className={`min-w-0 rounded-xl border py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${kopiykas === value * 100 ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:border-primary/40'}`}>{value} ₴</button>)}
          </div>
          <label htmlFor="support-amount" className="text-xs font-medium">Або інша сума</label>
          <div className={`mt-2 flex w-full min-w-0 items-center gap-2 rounded-2xl border bg-background px-4 focus-within:ring-2 focus-within:ring-primary/30 ${amount && !validAmount ? 'border-destructive' : 'border-border'}`}>
            <input id="support-amount" type="text" inputMode="decimal" autoComplete="off" maxLength={10} value={amount} disabled={busy}
              onChange={(event) => { setAmount(event.target.value); setError('') }} aria-invalid={Boolean(amount) && !validAmount} aria-describedby="support-amount-help"
              className="w-0 min-w-0 flex-1 bg-transparent py-4 text-2xl font-medium outline-none" />
            <span className="shrink-0 text-sm text-muted-foreground">грн</span>
          </div>
          <p id="support-amount-help" className={`mt-2 text-xs ${amount && !validAmount ? 'text-destructive' : 'text-muted-foreground'}`}>Від 1 до {formatSupportAmount(max)} грн · до двох знаків після коми</p>
          <div className="my-5 min-w-0 break-words rounded-2xl border border-border bg-background/70 p-3 sm:p-4"><CheckoutLegalConsent purpose="support" checked={consent} onChange={setConsent} disabled={busy} /></div>
          {error && <p role="alert" className="mb-4 break-words rounded-xl bg-destructive/10 p-3 text-sm leading-6 text-destructive">{error}</p>}
          <button type="submit" disabled={busy || loading || isLoading || !config?.checkoutAvailable}
            className="flex min-h-14 w-full min-w-0 items-center justify-center gap-2 rounded-2xl bg-primary px-3 py-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 sm:px-4">
            {busy || loading ? <Loader2 size={17} className="shrink-0 animate-spin motion-reduce:animate-none" /> : <Heart size={17} className="shrink-0" />}
            <span className="min-w-0 break-words text-center">{busy ? 'Готуємо оплату…' : loading ? 'Завантаження…' : !config?.checkoutAvailable ? 'Підтримку ще не підключено' : !authUser ? 'Увійти й підтримати' : `Підтримати${validAmount ? ` — ${formatSupportAmount(kopiykas!)} грн` : ''}`}</span>
          </button>
          {config?.mode === 'test' && <p className="mt-3 text-center text-xs text-muted-foreground">Тестовий режим · робочий бейдж не надається</p>}
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck size={16} className="mt-0.5 shrink-0" />Захищена оплата через WayForPay. Дані картки вводяться на його сторінці.</p>
          <p className="mt-3 break-words text-[11px] leading-5 text-muted-foreground">Отримувач: {legalMerchant.name}. Добровільна підтримка розвитку продукту, без благодійного чи інвестиційного призначення. Повне повернення за зверненням протягом 14 днів.</p>
        </form>
      </div>
      {returned && <section aria-live="polite" className="mt-8 rounded-2xl border border-border p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{returnedOrder?.status === 'approved' ? <Heart size={17} className="text-primary" /> : <RefreshCw size={17} className={checking ? 'animate-spin motion-reduce:animate-none' : ''} />}
          {returnedOrder?.status === 'approved' ? returnedOrder.mode === 'live' ? 'Дякуємо за підтримку!' : 'Тестову оплату підтверджено' : 'Статус вашого платежу'}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{!authUser ? 'Увійдіть в акаунт, з якого оформлено підтримку, щоб переглянути результат.' : !returnedOrder ? 'Платіж поки не знайдено у вашій історії. Оновіть статус або зверніться до підтримки.' : returnedOrder.status === 'approved' ? returnedOrder.mode === 'live' ? 'Ваш внесок допомагає розвивати Xelay. Бейдж уже доступний у профілі.' : 'Реального бейджа за тестовий платіж немає.' : returnedOrder.status === 'pending' ? 'Очікуємо підтвердження від WayForPay. Якщо кошти вже списано, перевірте статус перед новою оплатою.' : statuses[returnedOrder.status]}</p>
        <button disabled={checking || loading} onClick={() => returnedOrder ? void check(returnedOrder.order_reference) : authUser ? void refresh() : setAuthOpen(true)} className="mt-3 text-sm font-medium text-primary disabled:opacity-50">{checking ? 'Перевіряємо…' : authUser ? 'Оновити статус' : 'Увійти'}</button>
      </section>}
      {authUser && Boolean(config?.orders.length) && <section className="mt-10" aria-labelledby="support-history-heading">
        <h2 id="support-history-heading" className="mb-4 text-base font-semibold">Ваша підтримка</h2>
        <div className="divide-y divide-border rounded-2xl border border-border bg-card px-4 sm:px-5">
          {config!.orders.map((order) => <div key={order.id} className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{formatSupportAmount(order.amount_kopiykas)} грн{order.mode === 'test' && ' · тест'}</span><span className={order.status === 'approved' ? 'text-primary' : 'text-muted-foreground'}>{statuses[order.status]}</span></div>
            <p className="mt-1 text-xs text-muted-foreground">{formatDate(order.created_at)}</p>
            <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Номер платежу</summary><p className="mt-2 break-all select-all">{order.order_reference}</p></details>
            {order.status === 'pending' && <button disabled={checking} onClick={() => void check(order.order_reference)} className="mt-2 text-xs font-medium text-primary disabled:opacity-50">Перевірити оплату</button>}
          </div>)}
        </div>
      </section>}
      <div className="mt-8 flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-border p-4 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:p-5">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground"><Sparkles size={17} className="shrink-0" /><span className="min-w-0">Потрібні додаткові можливості?</span></span>
        <button onClick={() => navigate({ to: '/subscription' })} className="inline-flex max-w-full items-center gap-2 font-medium text-primary">Підписка «Учасник»<ArrowUpRight size={16} className="shrink-0" /></button>
      </div>
    </div>
  </main>
}
