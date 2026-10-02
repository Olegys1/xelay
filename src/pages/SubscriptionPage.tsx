import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight, BadgeCheck, BarChart3, CalendarDays, Check, ChevronDown, Crown,
  FileText, Heart, Loader2, LockKeyhole, RefreshCw, Search, ShieldCheck, Smile, Sparkles, UsersRound,
} from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { CheckoutLegalConsent } from '../components/LegalLinks'
import { ParticipantWelcome } from '../components/ParticipantWelcome'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import {
  createParticipantCheckout, getBillingConfiguration, openHostedCheckout,
  reconcilePayment, returnedPaymentReference,
  type BillingConfiguration,
} from '../lib/billing'
import { legalMerchant } from '../lib/legal'
import './premium.css'

const PREMIUM_FEATURES = [
  { icon: BadgeCheck, title: 'Бейдж учасника', text: 'Позначка підписки поруч з вашим ім’ям.' },
  { icon: Smile, title: 'Текст і емодзі поруч із ніком', text: 'Короткий статус до 48 символів і до трьох емодзі з розширеної добірки.' },
  { icon: Search, title: 'Пошук без денного ліміту', text: 'Знаходьте людей за ніком без обмеження у 5 запитів на день.' },
  { icon: CalendarDays, title: 'Особистий органайзер', text: 'Завдання, нотатки й дедлайни — разом, у вашому просторі.' },
  { icon: BarChart3, title: 'Опитування у чатах', text: 'Один або кілька варіантів відповіді, анонімне чи відкрите голосування та завершення опитування.' },
  { icon: FileText, title: 'Статті у чатах', text: 'Публікації із заголовком, обкладинкою й форматованим текстом у ваших переписках.' },
]

const formatExpiry = (value: string) => new Intl.DateTimeFormat('uk-UA', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv',
}).format(new Date(value))

const ORDER_STATUS = {
  pending: 'Очікує оплати', approved: 'Оплачено', declined: 'Відхилено',
  expired: 'Час оплати минув', refunded: 'Кошти повернено', voided: 'Скасовано',
}

export function SubscriptionPage() {
  const { authUser } = useAuth()
  return <SubscriptionWorkspace key={authUser?.id || 'guest'} />
}

function SubscriptionWorkspace() {
  const navigate = useNavigate()
  const { authUser, xelayUser } = useAuth()
  const { isPremium, expiresAt, emojiStatus, textStatus, refreshBilling, error: billingError } = useBilling()
  const [showAuth, setShowAuth] = useState(false)
  const [configuration, setConfiguration] = useState<BillingConfiguration | null>(null)
  const [configurationUserId, setConfigurationUserId] = useState<string | undefined>(undefined)
  const configurationOwner = useRef(authUser?.id)
  configurationOwner.current = authUser?.id
  const [configurationLoading, setConfigurationLoading] = useState(true)
  const [purchasing, setPurchasing] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [paymentNotice, setPaymentNotice] = useState('')
  const active = useRef(true)
  const configurationSequence = useRef(0)
  const purchaseLock = useRef(false)
  const checkLock = useRef(false)
  const returnReference = useRef(returnedPaymentReference())
  const [welcomeCandidateReference, setWelcomeCandidateReference] = useState(returnReference.current)
  const [welcome, setWelcome] = useState<'purchase' | 'tour' | null>(null)
  const welcomedOrders = useRef(new Set<string>())
  const closeWelcome = useCallback(() => setWelcome(null), [])
  const [paymentReturned] = useState(() => {
    const query = new URLSearchParams(window.location.search)
    return query.has('payment') || query.has('orderReference')
  })

  const loadConfiguration = useCallback(async () => {
    const userId = authUser?.id
    const sequence = ++configurationSequence.current
    const valid = () => active.current && configurationOwner.current === userId && sequence === configurationSequence.current
    setConfigurationLoading(true)
    try {
      const result = await getBillingConfiguration()
      if (!valid()) return
      setConfiguration(result)
      setConfigurationUserId(userId)
      return result
    } catch {
      // A Vite-only preview has no server API. Keep payments explicitly unavailable.
      if (!valid()) return
      setConfiguration({ checkoutAvailable: false, mode: 'disabled' })
      setConfigurationUserId(userId)
      return null
    } finally {
      if (valid()) setConfigurationLoading(false)
    }
  }, [authUser?.id])

  useEffect(() => {
    active.current = true
    void loadConfiguration()
    return () => { active.current = false; ++configurationSequence.current }
  }, [loadConfiguration])

  useEffect(() => { setAcceptedTerms(false) }, [authUser?.id])

  const purchase = async () => {
    if (!authUser) { setShowAuth(true); return }
    if (!legalMerchant.ready || !acceptedTerms || !configuration?.checkoutAvailable || configurationLoading || purchaseLock.current) return
    if (configuration.mode === 'test' && !window.confirm('Це тестова оплата. Вона не активує робочу підписку. Продовжити?')) return
    purchaseLock.current = true
    setPurchasing(true)
    setError('')
    try {
      const result = await createParticipantCheckout()
      if (active.current) openHostedCheckout(result.checkout)
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Не вдалося підготувати оплату. Спробуйте ще раз.')
    } finally {
      purchaseLock.current = false
      if (active.current) setPurchasing(false)
    }
  }

  const checkPayment = useCallback(async (reference = returnReference.current) => {
    if (!authUser || checkLock.current) return
    checkLock.current = true
    setRefreshing(true)
    setError('')
    setPaymentNotice('')
    if (reference) setWelcomeCandidateReference(reference)
    let retryAfter = 60
    let updatedConfiguration: BillingConfiguration | null | undefined
    try {
      if (reference) {
        const result = await reconcilePayment(reference)
        retryAfter = Number.isFinite(result.retryAfter) ? Math.max(5, Math.min(120, result.retryAfter)) : 60
        if (active.current && !result.checked) setPaymentNotice('Підтвердження ще очікується. Зачекайте на оновлення статусу або перевірте його за хвилину.')
      }
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Не вдалося перевірити оплату. Спробуйте пізніше.')
    } finally {
      if (active.current) {
        await refreshBilling()
        updatedConfiguration = await loadConfiguration()
        if (active.current) setRefreshing(false)
      }
      checkLock.current = false
    }
    const checkedOrder = updatedConfiguration?.orders?.find((order) => order.order_reference === reference)
    if (active.current && checkedOrder?.status === 'approved') setPaymentNotice('')
    return { retryAfter, complete: Boolean(checkedOrder && checkedOrder.status !== 'pending') }
  }, [authUser?.id, refreshBilling, loadConfiguration])

  useEffect(() => {
    if (!authUser || !returnReference.current) return
    let stopped = false
    let timer: number | undefined
    let attempts = 0
    const checkReturnedPayment = async () => {
      if (stopped) return
      attempts += 1
      const result = await checkPayment()
      if (!stopped && attempts < 4 && !result?.complete) {
        timer = window.setTimeout(() => void checkReturnedPayment(), (result?.retryAfter || 60) * 1000)
      } else if (!stopped && attempts >= 4 && !result?.complete) {
        setPaymentNotice('Оплата ще очікує підтвердження. Трохи згодом натисніть «Оновити статус» — повторно оплачувати не потрібно.')
      }
    }
    void checkReturnedPayment()
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer) }
  }, [checkPayment, authUser?.id])

  useEffect(() => {
    if (!authUser || configurationUserId !== authUser.id || !welcomeCandidateReference || welcome
      || !isPremium || !expiresAt || billingError) return
    const expiryTime = Date.parse(expiresAt)
    if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) return
    const order = configuration?.orders?.find((item) => item.order_reference === welcomeCandidateReference)
    if (!order || order.product !== 'participant' || order.mode !== 'live' || order.status !== 'approved' || !order.approved_at) return
    const approvalTime = Date.parse(order.approved_at)
    if (!Number.isFinite(approvalTime) || approvalTime >= expiryTime) return
    const key = `xelay:participant-welcome:v1:${authUser.id}:${order.id}`
    if (welcomedOrders.current.has(key)) return
    try {
      if (window.localStorage.getItem(key) === 'seen') { welcomedOrders.current.add(key); return }
      window.localStorage.setItem(key, 'seen')
    } catch { /* The tour remains usable when browser storage is unavailable. */ }
    welcomedOrders.current.add(key)
    setWelcome('purchase')
  }, [authUser?.id, configurationUserId, configuration, welcomeCandidateReference, welcome, isPremium, expiresAt, billingError])

  useEffect(() => { if (!isPremium) setWelcome(null) }, [isPremium])

  const paymentUnavailable = !legalMerchant.ready || !configuration?.checkoutAvailable

  return (
    <main className="min-h-[80vh] bg-background">
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {welcome && isPremium && <ParticipantWelcome key={welcome} celebrate={welcome === 'purchase'} onClose={closeWelcome} />}
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="xelay-premium-reveal mx-auto mb-9 max-w-2xl text-center">
          <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-4 py-2 text-xs font-semibold text-primary">
            <Crown size={15} /> Xelay · Учасник
          </span>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Більше можливостей щодня</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Власний стиль, зручніший директ і порядок у навчальних справах. Одна підписка — усе поруч.
          </p>
        </header>

        {isPremium && (
          <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white"><Crown size={21} /></span>
              <div className="min-w-0"><p className="font-semibold">Ви вже з нами ✨</p><p className="mt-1 text-sm text-muted-foreground">{expiresAt ? `Підписка активна до ${formatExpiry(expiresAt)}.` : 'Ваша підписка активна.'}</p></div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="button" onClick={() => setWelcome('tour')} className="inline-flex items-center justify-center gap-2 rounded-full border border-primary/20 bg-card px-4 py-3 text-sm font-semibold text-primary hover:bg-primary/5"><Sparkles size={16} /> Показати можливості</button>
              <button type="button" onClick={() => navigate({ to: '/organizer' })} className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-white">До органайзера <ArrowRight size={16} /></button>
            </div>
          </div>
        )}

        {paymentReturned && (
          <div className="mb-6 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
            <p className="font-semibold">Перевіримо результат оплати</p>
            <p className="mt-1 text-muted-foreground">Доступ з’являється після підтвердження платіжного сервісу. Повернення на цю сторінку саме по собі не підтверджує оплату.</p>
            {authUser && <button type="button" disabled={refreshing} onClick={() => void checkPayment()} className="mt-3 inline-flex items-center gap-2 font-semibold text-primary disabled:opacity-60"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />{refreshing ? 'Перевіряємо…' : 'Оновити статус'}</button>}
          </div>
        )}

        <section aria-label="Особисті тарифи" className="grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
          <article className="xelay-premium-reveal rounded-3xl border border-border bg-card p-6 sm:p-8">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-muted"><Heart size={22} className="text-muted-foreground" /></span>
            <h2 className="mt-5 text-xl font-bold">Спільнота</h2>
            <p className="mt-1 text-sm text-muted-foreground">Усе головне для знайомств і спілкування.</p>
            <p className="mt-6 flex items-baseline gap-2"><span className="text-4xl font-bold">0</span><span className="text-sm text-muted-foreground">грн · завжди</span></p>
            <ul className="mt-6 space-y-3 text-sm">
              {['Профіль і університетські новини', 'Обговорення та коментарі', 'Особисті чати, групи, канали й чат факультету', 'Фото, відео та відповіді в директі', 'Усі реакції та особисті закріплення', 'Читання статей і голосування у відкритих опитуваннях', '5 пошуків людей на день', 'Пошук груп і каналів без обмежень'].map((item) => <li key={item} className="flex items-start gap-3"><Check size={16} className="mt-0.5 shrink-0 text-primary" /><span>{item}</span></li>)}
            </ul>
            <div className="mt-7 rounded-2xl bg-muted/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground">Розклад і домашки активованої групи доступні її учасникам без особистої підписки.</div>
          </article>

          <article className="xelay-premium-surface xelay-premium-reveal relative overflow-hidden rounded-3xl border border-primary/25 p-6 sm:p-8">
            <div className="relative">
              <div className="flex items-center justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-white"><Crown size={22} /></span><span className="rounded-full border border-primary/15 bg-card/75 px-3 py-1.5 text-xs font-semibold text-primary">Для себе</span></div>
              <h2 className="mt-5 text-xl font-bold">Учасник</h2>
              <p className="mt-1 text-sm text-muted-foreground">Ваш простір. Ваш стиль. Ваш ритм.</p>
              <p className="mt-6 flex flex-wrap items-baseline gap-2"><span className="text-4xl font-bold text-primary">100</span><span className="text-sm text-muted-foreground">грн / місяць</span></p>
              <p className="mt-2 text-xs text-muted-foreground">Доступ на один календарний місяць. Без автоматичних списань. Продовження вручну.</p>
              <ul className="mt-6 space-y-4">
                {PREMIUM_FEATURES.map(({ icon: Icon, title, text }) => <li key={title} className="flex gap-3"><span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-card/80 text-primary"><Icon size={17} /></span><div><p className="text-sm font-semibold">{title}</p><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{text}</p></div></li>)}
              </ul>
              <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Створення опитувань і створення та редагування статей потребує активної підписки й права писати в чаті. Питання й варіанти опитування після публікації не змінюються. У каналі публікують лише власник та адміністратори. Читання й голосування залишаються безкоштовними після завершення підписки.</p>
              <div className="mt-6 rounded-2xl border border-border bg-card/70 p-4">
                <CheckoutLegalConsent checked={acceptedTerms} onChange={setAcceptedTerms} disabled={configurationLoading || purchasing || !authUser} />
              </div>
              <button type="button" onClick={() => void purchase()} disabled={configurationLoading || purchasing || (Boolean(authUser) && (paymentUnavailable || !acceptedTerms))} className="mt-7 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-primary/20 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55">
                {configurationLoading || purchasing ? <Loader2 size={18} className="animate-spin" /> : <Crown size={18} />}
                {configurationLoading ? 'Перевіряємо оплату…' : purchasing ? 'Готуємо оплату…' : !authUser ? 'Увійти, щоб оформити' : paymentUnavailable ? 'Оплата ще не підключена' : configuration?.mode === 'test' ? 'Перейти до тестової оплати' : isPremium ? 'Продовжити за 100 грн' : 'Оформити за 100 грн'}
              </button>
              {configuration?.mode === 'test' && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Тестовий режим: реальна підписка не активується тестовим платежем.</p>}
              {paymentUnavailable && !configurationLoading && <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">Оплата ще не підключена.</p>}
              {!paymentUnavailable && <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole size={13} /> Захищена сторінка оплати WayForPay</p>}
            </div>
          </article>
        </section>

        {paymentNotice && <p role="status" className="mt-5 rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3 text-sm text-primary">{paymentNotice}</p>}
        {(error || billingError) && <p role="alert" className="mt-5 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error || billingError}</p>}

        <section aria-label="Попередній вигляд підписки" className="mt-7 grid gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Маленькі деталі, які відчуваються</p>
            <div className="flex items-center gap-3"><span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 font-bold text-primary">{xelayUser?.avatarUrl ? <img src={xelayUser.avatarUrl} alt="" className="h-full w-full object-cover" /> : xelayUser?.name?.charAt(0) || 'В'}</span><div className="min-w-0"><p className="flex flex-wrap items-center gap-1.5 font-semibold"><span className="max-w-full truncate">{xelayUser?.username ? `@${xelayUser.username}` : xelayUser?.name || 'Ваш нік'}</span><BadgeCheck size={17} className="shrink-0 text-primary" /><span aria-label="Приклад емодзі-статусу">{emojiStatus || '🌿 📚 ☕'}</span></p><p className="mt-1 max-w-full break-words text-xs font-medium text-primary">{textStatus || 'На своєму вайбі'}</p><p className="mt-1 text-xs text-muted-foreground">Приклад вигляду профілю з підпискою</p></div></div>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">За непристойні статуси, образи та мову ненависті акаунт буде заблоковано.</p>
            <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Відповіді, реакції та особисті закріплення в чатах доступні всім безкоштовно.</p>
          </div>

          <article className="flex flex-col rounded-2xl border border-border bg-card p-5 sm:p-6">
            <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/5 text-primary"><UsersRound size={21} /></span><div><h2 className="font-bold">Розклад для всієї групи</h2><p className="mt-0.5 text-xs text-muted-foreground">Окрема покупка від старости</p></div></div>
            <p className="mt-5 flex items-baseline gap-2"><span className="text-3xl font-bold">750</span><span className="text-sm text-muted-foreground">грн / рік</span></p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Спільні пари, домашки, семінари та запрошення одногрупників. Доступ на один календарний рік закріплюється за конкретною групою й зберігається при зміні старости. Без автоматичних списань; продовження вручну.</p>
            <p className="mt-3 rounded-xl bg-primary/5 px-3 py-2 text-xs text-primary">Перша створена група на всій платформі отримує доступ безкоштовно. Пропозиція діє один раз для Xelay.</p>
            <button type="button" onClick={() => navigate({ to: '/groups' })} className="mt-5 inline-flex items-center justify-center gap-2 rounded-full border border-primary/20 px-4 py-3 text-sm font-semibold text-primary hover:bg-primary/5">До моїх груп <ArrowRight size={16} /></button>
          </article>
        </section>

        {authUser && configurationUserId === authUser.id && configuration?.orders && (
          <details className="group mt-7 rounded-2xl border border-border bg-card p-5 sm:p-6">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold"><span>Історія оплат</span><ChevronDown size={17} className="text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" /></summary>
            {configuration.orders.length ? <div className="mt-5 space-y-3">{configuration.orders.map((order) => <article key={order.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/40 p-3 text-sm"><div className="min-w-0"><p className="font-semibold">{order.product === 'group' ? 'Доступ для групи' : 'Учасник · один місяць'}</p><p className="mt-1 text-xs text-muted-foreground">{formatExpiry(order.created_at)}{order.mode === 'test' ? ' · тестова оплата' : ''}</p></div><div className="text-right"><p className="font-semibold">{new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH', maximumFractionDigits: 0 }).format(order.amount)}</p><p className={`mt-1 text-xs ${order.status === 'approved' ? 'text-primary' : 'text-muted-foreground'}`}>{ORDER_STATUS[order.status] || 'Обробляється'}</p>{(order.status === 'pending' || order.status === 'approved') && configuration.mode === order.mode && <button type="button" disabled={refreshing} onClick={() => void checkPayment(order.order_reference)} className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/5 disabled:opacity-50"><RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />Перевірити</button>}</div></article>)}</div> : <p className="mt-4 text-sm text-muted-foreground">Оплат поки немає. Вони з’являться тут після створення замовлення.</p>}
          </details>
        )}

        <section className="mx-auto mt-9 max-w-3xl" aria-label="Поширені запитання">
          <h2 className="mb-3 text-lg font-bold">Перед оформленням</h2>
          {[
            ['Чи будуть автоматичні списання?', 'Ні. Підписка «Учасник» надається на один календарний місяць, доступ для групи — на один календарний рік. Ви самі вирішуєте, коли продовжити. Повторна покупка додає відповідний період до поточного оплаченого доступу.'],
            ['Що буде із завданнями після завершення підписки?', 'Ваші завдання зберігаються. Ви можете переглядати, експортувати у CSV та видаляти їх; створення й редагування відновлюються після продовження підписки.'],
            ['Що буде з опитуваннями й статтями після завершення підписки?', 'Публікації залишаються в переписці. Люди з доступом до чату можуть безкоштовно читати статті й голосувати у відкритих опитуваннях. Автор або адміністратор із відповідним правом може завершити опитування; видалення власних повідомлень і модерація залишаються безкоштовними. Для нових публікацій та редагування своїх статей потрібна активна підписка.'],
            ['Чи дає підписка право публікувати в будь-якому каналі?', 'Ні. Підписка відкриває формати опитувань і статей, але зберігає права конкретної переписки. У каналі публікують його власник та адміністратори. У звичайній групі й чаті свого факультету — учасники з доступом до надсилання повідомлень.'],
            ['Чи потрібна особиста підписка для розкладу групи?', 'Ні. Після активації групи розклад і домашки доступні всім учасникам, які прийняли запрошення старости. Особиста підписка дає додаткові можливості саме вашому акаунту.'],
          ].map(([question, answer]) => <details key={question} className="group border-b border-border py-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold"><span>{question}</span><ChevronDown size={17} className="shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" /></summary><p className="mt-3 pr-6 text-sm leading-relaxed text-muted-foreground">{answer}</p></details>)}
          <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-primary" />Платіжні реквізити вводяться лише на сторінці WayForPay. Xelay не зберігає дані вашої картки.</p>
        </section>
      </div>
    </main>
  )
}
