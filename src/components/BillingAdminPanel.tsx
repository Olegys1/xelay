import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, CreditCard, Download, Gift, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import {
  ADMIN_BILLING_PAGE_SIZE, ADMIN_BILLING_PRODUCT, ADMIN_BILLING_STATUS, assertAdminBillingIdentity,
  exportAdminBillingTransactions, isSixSevenTransaction, loadAdminBillingTransactions,
  type AdminBillingFilters, type AdminBillingPage,
} from '../lib/adminBillingTransactions'

type Overview = {
  active_participants: number; active_groups: number; paid_groups: number; live_revenue: number
  support_revenue?: number; subscription_revenue?: number; refunds: number; fees: number; fees_known: boolean
  fees_pending: number; enforcement_enabled: boolean
  audit: Array<{ id: string; action: string; created_at: string; detail: { reason?: string; order_reference?: string } }>
}
const AUDIT_ACTION: Record<string, string> = {
  grant_participant: 'Надання доступу Учасник',
  set_group_enforcement: 'Налаштування оплати груп',
  duplicate_group_payment: 'Повторна оплата групи — перевірте повернення',
}
const initialFilters: AdminBillingFilters = { product: '', status: '', mode: '', query: '' }
const fieldClass = 'mt-1 min-h-10 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15'
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40'
const finiteAmount = (value: unknown) => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
const money = (value: unknown) => value != null && value !== '' && Number.isFinite(Number(value)) ? new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH' }).format(Number(value)) : '—'
const count = (value: unknown) => finiteAmount(value) ? Number(value).toLocaleString('uk-UA') : '—'
const date = (value: string, time = false) => {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? time
    ? parsed.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    : parsed.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }) : '—'
}
function message(problem: unknown, fallback: string) {
  return problem instanceof Error && /^[А-ЯІЇЄҐ]/u.test(problem.message) && problem.message.length < 500 ? problem.message : fallback
}

export function BillingAdminPanel() {
  const navigate = useNavigate()
  const { authUser, xelayUser } = useAuth()
  const adminId = authUser?.id && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin ? authUser.id : null
  const currentAdmin = useRef(adminId); currentAdmin.current = adminId
  const { refreshBilling } = useBilling()
  const [overview, setOverview] = useState<Overview | null>(null)
  const overviewOwner = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [overviewError, setOverviewError] = useState('')
  const [error, setError] = useState('')
  const [grantTarget, setGrantTarget] = useState('')
  const [reason, setReason] = useState('')
  const [granting, setGranting] = useState(false)
  const [success, setSuccess] = useState('')
  const [filters, setFilters] = useState<AdminBillingFilters>(initialFilters)
  const [searchText, setSearchText] = useState('')
  const [pagination, setPagination] = useState<{ offset: number; before: string | null }>({ offset: 0, before: null })
  const [listRefresh, setListRefresh] = useState(0)
  const [loadedPage, setLoadedPage] = useState<{ owner: string; key: string; value: AdminBillingPage } | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<{ loaded: number; total: number } | null>(null)
  const [exportError, setExportError] = useState('')
  const [exportSuccess, setExportSuccess] = useState('')
  const active = useRef(true)
  const loadSequence = useRef(0)
  const listSequence = useRef(0)
  const exportSequence = useRef(0)
  const grantSequence = useRef(0)
  const grantLock = useRef(false)
  const overviewRequest = useRef<AbortController | null>(null)
  const listRequest = useRef<AbortController | null>(null)
  const exportRequest = useRef<AbortController | null>(null)
  const grantRequest = useRef<AbortController | null>(null)
  const listKey = JSON.stringify([filters, pagination.offset, pagination.before, listRefresh])
  const currentListKey = useRef(listKey); currentListKey.current = listKey
  const exportKey = JSON.stringify([filters, searchText])
  const currentExportKey = useRef(exportKey); currentExportKey.current = exportKey
  const searchPending = searchText.trim() !== filters.query
  const page = loadedPage?.owner === adminId && loadedPage.key === listKey && !searchPending ? loadedPage.value : null
  const visibleOverview = overviewOwner.current === adminId ? overview : null

  const cancelExport = useCallback(() => {
    ++exportSequence.current; exportRequest.current?.abort(); exportRequest.current = null
    setExporting(false); setExportProgress(null)
  }, [])
  const invalidateList = useCallback(() => {
    ++listSequence.current; listRequest.current?.abort(); listRequest.current = null
    cancelExport(); setExportError(''); setExportSuccess(''); setListError('')
  }, [cancelExport])

  const load = useCallback(async () => {
    overviewRequest.current?.abort()
    const controller = new AbortController(); overviewRequest.current = controller
    const sequence = ++loadSequence.current, owner = adminId
    const valid = () => active.current && Boolean(owner) && currentAdmin.current === owner && sequence === loadSequence.current
    if (!owner) { setLoading(false); setOverview(null); overviewOwner.current = null; return }
    setLoading(true)
    const timer = window.setTimeout(() => controller.abort(), 30000)
    try {
      await assertAdminBillingIdentity(owner, controller.signal)
      const { data, error: loadError } = await supabase.rpc('xelay_admin_billing_overview').abortSignal(controller.signal)
      if (loadError || !data || typeof data !== 'object') throw new Error('Overview unavailable')
      await assertAdminBillingIdentity(owner, controller.signal)
      if (valid()) { overviewOwner.current = owner; setOverview(data as Overview); setOverviewError('') }
    } catch {
      if (valid()) { overviewOwner.current = null; setOverview(null); setOverviewError('Статистика оплат недоступна. Перевірте права адміністратора або оновіть сторінку.') }
    } finally { window.clearTimeout(timer); if (valid()) { setLoading(false); overviewRequest.current = null } }
  }, [adminId])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      ++loadSequence.current; ++listSequence.current; ++exportSequence.current; ++grantSequence.current
      overviewRequest.current?.abort(); listRequest.current?.abort(); exportRequest.current?.abort(); grantRequest.current?.abort()
    }
  }, [])
  useEffect(() => {
    setOverview(null); overviewOwner.current = null; setLoadedPage(null)
    setError(''); setSuccess(''); setGrantTarget(''); setReason(''); setGranting(false); grantLock.current = false
    setExportError(''); setExportSuccess(''); cancelExport()
    void load()
    return () => { ++loadSequence.current; overviewRequest.current?.abort(); ++grantSequence.current; grantRequest.current?.abort() }
  }, [adminId, load, cancelExport])
  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== 'SIGNED_OUT' && session?.user.id === currentAdmin.current) return
      ++loadSequence.current; ++listSequence.current; ++exportSequence.current; ++grantSequence.current
      overviewRequest.current?.abort(); listRequest.current?.abort(); exportRequest.current?.abort(); grantRequest.current?.abort()
      overviewOwner.current = null; setOverview(null); setLoadedPage(null); setExporting(false); setExportProgress(null)
      setLoading(false); setListLoading(false); setGranting(false); grantLock.current = false; setGrantTarget(''); setReason('')
      setError('Сесія адміністратора змінилася. Оновіть сторінку для продовження.'); setSuccess(''); setExportSuccess('')
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (searchText.trim() === filters.query) return
    const timer = window.setTimeout(() => {
      setFilters((current) => ({ ...current, query: searchText.trim() }))
      setPagination({ offset: 0, before: null })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [searchText, filters.query])

  useEffect(() => {
    listRequest.current?.abort()
    const controller = new AbortController(); listRequest.current = controller
    const sequence = ++listSequence.current, owner = adminId, key = listKey
    const valid = () => active.current && currentAdmin.current === owner && Boolean(owner)
      && sequence === listSequence.current && currentListKey.current === key && !controller.signal.aborted
    if (!owner || searchPending) { setListLoading(false); return () => controller.abort() }
    setListLoading(true); setListError('')
    void loadAdminBillingTransactions({ userId: owner, filters, offset: pagination.offset, before: pagination.before, signal: controller.signal })
      .then((value) => { if (valid()) setLoadedPage({ owner, key, value }) })
      .catch((problem) => { if (valid()) { setLoadedPage(null); setListError(message(problem, 'Не вдалося завантажити оплати. Спробуйте ще раз.')) } })
      .finally(() => { if (valid()) { setListLoading(false); listRequest.current = null } })
    return () => controller.abort()
  }, [adminId, listKey, searchPending])

  const changeFilters = (changes: Partial<AdminBillingFilters>) => {
    invalidateList(); setFilters((current) => ({ ...current, ...changes })); setPagination({ offset: 0, before: null })
  }
  const changeSearch = (value: string) => {
    if (value.trim() !== filters.query) invalidateList()
    else { cancelExport(); setExportError(''); setExportSuccess('') }
    setSearchText(value)
  }
  const resetFilters = () => { invalidateList(); setSearchText(''); setFilters(initialFilters); setPagination({ offset: 0, before: null }); setListRefresh((current) => current + 1) }
  const refresh = () => {
    invalidateList(); setPagination({ offset: 0, before: null }); setListRefresh((current) => current + 1); void load()
  }
  const changePage = (offset: number) => {
    if (!page || listLoading || exporting) return
    ++listSequence.current; listRequest.current?.abort()
    setPagination({ offset: Math.max(0, offset), before: page.snapshot_at })
  }

  const grant = async (event: FormEvent) => {
    event.preventDefault()
    if (grantLock.current || !adminId) return
    const userId = grantTarget.trim().match(/(?:^|\/user\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:$|[?#])/i)?.[1]
    if (!userId) { setError('Вставте ID користувача або посилання на його профіль.'); return }
    if (reason.trim().length < 5) { setError('Вкажіть причину надання доступу — щонайменше 5 символів.'); return }
    const owner = adminId, sequence = ++grantSequence.current, controller = new AbortController()
    const valid = () => active.current && currentAdmin.current === owner && sequence === grantSequence.current && !controller.signal.aborted
    grantRequest.current = controller; grantLock.current = true
    setGranting(true); setError(''); setSuccess('')
    try {
      await assertAdminBillingIdentity(owner, controller.signal)
      const { error: grantError } = await supabase.rpc('xelay_admin_grant_participant', { p_user_id: userId, p_months: 1, p_reason: reason.trim() }).abortSignal(controller.signal)
      if (grantError) throw grantError
      await assertAdminBillingIdentity(owner, controller.signal)
      if (!valid()) return
      setSuccess('Один місяць доступу надано. Дію записано в журнал; вона не враховується як оплачена покупка.')
      setGrantTarget(''); setReason('')
      await Promise.all([load(), refreshBilling()])
    } catch { if (valid()) setError('Не вдалося підтвердити надання доступу. Перевірте журнал дій, профіль і права адміністратора перед повторною спробою.') }
    finally { if (sequence === grantSequence.current) { grantLock.current = false; grantRequest.current = null; if (active.current) setGranting(false) } }
  }

  const exportOrders = async () => {
    if (!adminId || !page || !page.total || exporting || searchPending) return
    cancelExport()
    const controller = new AbortController(); exportRequest.current = controller
    const owner = adminId, sequence = ++exportSequence.current, key = exportKey, selectedFilters = { ...filters }, before = page.snapshot_at
    const valid = () => active.current && currentAdmin.current === owner && sequence === exportSequence.current
      && currentExportKey.current === key && !controller.signal.aborted
    setExporting(true); setExportError(''); setExportSuccess(''); setExportProgress({ loaded: 0, total: page.total })
    try {
      const exported = await exportAdminBillingTransactions({ userId: owner, filters: selectedFilters, before, signal: controller.signal,
        onProgress: (loaded, total) => { if (valid()) setExportProgress({ loaded, total }) } })
      if (!valid()) return
      const url = URL.createObjectURL(exported.blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'xelay-payments-' + before.slice(0, 10) + '.csv'
      document.body.appendChild(anchor)
      try { anchor.click() } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
      setExportSuccess('Експортовано всі транзакції за вибраними фільтрами: ' + count(exported.count) + '.')
    } catch (problem) { if (valid()) setExportError(message(problem, 'Не вдалося експортувати всі оплати. Частковий файл не створено. Спробуйте ще раз.')) }
    finally { if (valid()) { exportRequest.current = null; setExporting(false) } }
  }

  if (!adminId) return null
  const combined = visibleOverview && finiteAmount(visibleOverview.support_revenue) && finiteAmount(visibleOverview.subscription_revenue)
  const hasFilters = Boolean(filters.product || filters.status || filters.mode || searchText)
  return <section className="xelay-card mb-6 min-w-0 overflow-hidden" aria-label="Оплати та підписки">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
      <div><h2 className="flex items-center gap-2 font-semibold"><CreditCard size={18} className="text-primary" aria-hidden="true" />Оплати та підтримка</h2><p className="mt-1 text-xs text-muted-foreground">Підписки, попередні оплати груп і підтримка Xelay. Тестові транзакції й подарований доступ не збільшують виручку.</p></div>
      <button type="button" onClick={refresh} disabled={loading || listLoading} aria-label="Оновити статистику й список оплат" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary hover:bg-accent disabled:opacity-40"><RefreshCw size={17} className={loading || listLoading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" /></button>
    </header>
    {error && <p role="alert" className="m-5 text-sm text-destructive">{error}</p>}
    {success && <p role="status" className="m-5 rounded-xl bg-accent p-3 text-sm text-primary">{success}</p>}
    {overviewError && <p role="alert" className="m-5 text-sm text-destructive">{overviewError}</p>}
    {loading && !visibleOverview ? <div role="status" className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 size={18} className="animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />Завантажуємо статистику…</div> : visibleOverview && <>
      <p className="px-5 pt-4 text-xs text-muted-foreground">Загальні підсумки за весь час · фільтри списку нижче на них не впливають.</p>
      <div className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-5">{[
        ['Активні учасники', count(visibleOverview.active_participants)], ['Активовані групи', count(visibleOverview.active_groups)],
        [combined ? 'Успішні оплати без повернень' : 'Оплати підписок без повернень', money(visibleOverview.live_revenue)],
        ['Повернення', money(visibleOverview.refunds)], ['Комісії успішних оплат', visibleOverview.fees_known ? money(visibleOverview.fees) : 'Очікують звірки'],
      ].map(([label, value]) => <div key={label} className="min-w-0 rounded-2xl bg-muted/60 p-3"><p className="break-words text-lg font-bold text-primary">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{label}</p></div>)}</div>
      {combined ? <div className="mx-5 mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm"><p>Підписки: <strong>{money(visibleOverview.subscription_revenue)}</strong></p><p>Підтримка Xelay: <strong>{money(visibleOverview.support_revenue)}</strong></p></div> : <p className="mx-5 mb-4 text-xs text-muted-foreground">Підсумок підтримки ще не підключено до статистики. Суми видимої сторінки не використовуються для загального підсумку.</p>}
      <div className="mx-5 mb-5 rounded-2xl border border-border p-4 text-sm">
        {visibleOverview.fees_known && finiteAmount(visibleOverview.fees) && finiteAmount(visibleOverview.live_revenue) ? <p>Після комісій за успішні оплати: <strong>{money(Number(visibleOverview.live_revenue) - Number(visibleOverview.fees))}</strong></p> : <p>Підсумок після комісій ще не підтверджено. Оплат для звірки: <strong>{count(visibleOverview.fees_pending)}</strong>.</p>}
        <p className="mt-1 text-xs text-muted-foreground">Невідомі комісії не вважаються нульовими. Податки й витрати платформи не враховані; дані потрібно звіряти з випискою провайдера.</p>
        <p className="mt-2 text-xs text-muted-foreground">Навчальні групи безкоштовні. {visibleOverview.enforcement_enabled ? 'У базі залишився старий прапорець оплати — застосуйте оновлення безкоштовного доступу.' : 'Оплата та продовження для груп не потрібні.'}</p>
      </div>
    </>}
    <details className="mx-5 mb-5 rounded-2xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold text-primary"><Gift size={15} className="mr-2 inline" aria-hidden="true" />Надати місяць доступу від адміністратора</summary>
      <p className="mt-3 text-xs text-muted-foreground">Для перевірки функцій або погодженого подарунка. Це реальний доступ до «Учасника», без списання коштів. Кожна дія зберігається з причиною.</p>
      <form onSubmit={(event) => void grant(event)} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">ID або посилання на профіль<input value={grantTarget} onChange={(event) => setGrantTarget(event.target.value)} required maxLength={250} disabled={granting} className={fieldClass} /></label>
        <label className="text-xs text-muted-foreground">Причина<input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} maxLength={500} disabled={granting} className={fieldClass} /></label>
        <button type="submit" disabled={granting} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50 sm:col-span-2">{granting && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}Надати 1 місяць</button>
      </form>
    </details>
    <div className="border-t border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Усі транзакції</h3><p className="mt-1 text-xs text-muted-foreground">Включно з підтримкою на 67 грн, очікуваннями та поверненнями. По 50 записів на сторінці.</p></div>
        <button type="button" onClick={() => void exportOrders()} disabled={!page?.total || exporting || listLoading || searchPending} className={secondaryButton}>{exporting ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}Експорт усіх за фільтрами</button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="min-w-0 text-xs text-muted-foreground">Пошук<span className="relative block"><Search size={15} className="pointer-events-none absolute left-3 top-4" aria-hidden="true" /><input type="search" value={searchText} maxLength={120} onChange={(event) => changeSearch(event.target.value)} placeholder="Ім’я, нік, ID або замовлення" className={fieldClass + ' pl-9'} /></span></label>
        <label className="text-xs text-muted-foreground">Продукт<select className={fieldClass} value={filters.product} onChange={(event) => changeFilters({ product: event.target.value as AdminBillingFilters['product'] })}><option value="">Усі продукти</option>{Object.entries(ADMIN_BILLING_PRODUCT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-xs text-muted-foreground">Статус<select className={fieldClass} value={filters.status} onChange={(event) => changeFilters({ status: event.target.value as AdminBillingFilters['status'] })}><option value="">Усі статуси</option>{Object.entries(ADMIN_BILLING_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-xs text-muted-foreground">Режим<select className={fieldClass} value={filters.mode} onChange={(event) => changeFilters({ mode: event.target.value as AdminBillingFilters['mode'] })}><option value="">Тестові й реальні</option><option value="live">Реальні оплати</option><option value="test">Тестові оплати</option></select></label>
      </div>
      {hasFilters && <button type="button" className="mt-3 inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline" onClick={resetFilters}><X size={13} aria-hidden="true" />Скинути фільтри</button>}
      {exporting && <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 p-3 text-xs"><span>Готуємо повний CSV: {count(exportProgress?.loaded ?? 0)} / {count(exportProgress?.total ?? page?.total)}. Не закривайте сторінку.</span><button type="button" className="min-h-8 font-medium text-primary hover:underline" onClick={() => { cancelExport(); setExportSuccess('Експорт скасовано. Файл не створено.') }}>Скасувати експорт</button></div>}
      {exportError && <p role="alert" className="mt-3 text-sm text-destructive">{exportError}</p>}
      {exportSuccess && <p role="status" className="mt-3 text-xs text-primary">{exportSuccess}</p>}
      {listError && <div role="alert" className="mt-4 text-sm text-destructive"><p>{listError}</p><button type="button" className={secondaryButton + ' mt-2 text-foreground'} onClick={refresh}>Спробувати ще раз</button></div>}
      {(listLoading || searchPending) && <p role="status" className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{searchPending ? 'Готуємо пошук…' : 'Завантажуємо транзакції…'}</p>}
      {page && <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{page.transactions.length ? (page.offset + 1).toLocaleString('uk-UA') + '–' + Math.min(page.offset + page.transactions.length, page.total).toLocaleString('uk-UA') + ' з ' + count(page.total) : 'На сторінці: 0 · Загалом: ' + count(page.total)}</span><span>Нові замовлення після {date(page.snapshot_at, true)} з’являться після оновлення.</span></div>}
    </div>
    {page?.transactions.length ? <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs"><caption className="sr-only">Транзакції підписок і підтримки за вибраними фільтрами</caption><thead className="bg-muted/60 text-muted-foreground"><tr>{['Продукт / замовлення', 'Сума', 'Статус', 'Режим', 'Створено / сплачено', 'Покупець'].map((label) => <th scope="col" key={label} className="px-5 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{page.transactions.map((transaction) => <tr key={transaction.source + ':' + transaction.id} className="border-t border-border align-top">
      <td className="px-5 py-3"><span className="font-medium">{ADMIN_BILLING_PRODUCT[transaction.product]}</span>{isSixSevenTransaction(transaction) && <span title="Окремий підтверджений внесок 67 грн" className="mt-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">67 · Six Seven</span>}<span className="mt-1 block max-w-64 break-all font-mono text-[10px] text-muted-foreground">{transaction.order_reference}</span></td>
      <td className="whitespace-nowrap px-5 py-3"><span className="font-medium">{money(transaction.amount)}</span><span className="mt-1 block text-[10px] text-muted-foreground">{transaction.fee_amount === null ? 'Комісія невідома' : 'Комісія: ' + money(transaction.fee_amount)}</span></td>
      <td className="px-5 py-3"><span className={'inline-flex rounded-full px-2 py-1 ' + (transaction.status === 'approved' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : transaction.status === 'refunded' || transaction.status === 'voided' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>{ADMIN_BILLING_STATUS[transaction.status]}</span></td>
      <td className="whitespace-nowrap px-5 py-3">{transaction.mode === 'test' ? 'Тест' : 'Реальна оплата'}</td>
      <td className="whitespace-nowrap px-5 py-3"><time dateTime={transaction.created_at} title={date(transaction.created_at, true)}>{date(transaction.created_at)}</time>{transaction.approved_at && <span className="mt-1 block text-[10px] text-muted-foreground">Підтверджено: {date(transaction.approved_at, true)}</span>}</td>
      <td className="max-w-56 px-5 py-3"><button type="button" onClick={() => navigate({ to: '/user/$id', params: { id: transaction.user_id } })} className="break-words text-left font-medium text-primary hover:underline">{transaction.full_name || (transaction.username ? '@' + transaction.username.replace(/^@/, '') : 'Профіль')}</button>{transaction.username && transaction.full_name && <span className="mt-1 block break-words text-muted-foreground">@{transaction.username.replace(/^@/, '')}</span>}<span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{transaction.user_id}</span></td>
    </tr>)}</tbody></table></div> : page && !listLoading && <p className="px-5 pb-5 text-sm text-muted-foreground">{page.total ? 'На цій сторінці записів уже немає. Оновіть список або поверніться на попередню сторінку.' : hasFilters ? 'За вибраними фільтрами транзакцій немає.' : 'Транзакцій поки немає.'}</p>}
    {page && <nav aria-label="Сторінки транзакцій" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4"><span className="text-xs text-muted-foreground">Сторінка {Math.floor(page.offset / ADMIN_BILLING_PAGE_SIZE) + 1}{page.total > 0 ? ' з ' + Math.ceil(page.total / ADMIN_BILLING_PAGE_SIZE) : ''}</span><div className="flex gap-2"><button type="button" className={secondaryButton} disabled={page.offset === 0 || listLoading || exporting} onClick={() => changePage(page.offset - ADMIN_BILLING_PAGE_SIZE)}><ChevronLeft size={15} aria-hidden="true" />Назад</button><button type="button" className={secondaryButton} disabled={page.offset + page.limit >= page.total || listLoading || exporting} onClick={() => changePage(page.offset + ADMIN_BILLING_PAGE_SIZE)}>Далі<ChevronRight size={15} aria-hidden="true" /></button></div></nav>}
    {visibleOverview?.audit?.length ? <details className="border-t border-border p-5"><summary className="cursor-pointer text-sm font-semibold">Журнал адміністративних дій</summary><ul className="mt-3 space-y-2">{visibleOverview.audit.map((item) => <li key={item.id} className="rounded-xl bg-muted/50 p-3 text-xs"><p className="font-semibold">{AUDIT_ACTION[item.action] || 'Інша дія з оплатою'} · {date(item.created_at, true)}</p><p className="mt-1 break-words text-muted-foreground">{item.detail?.reason}</p>{item.detail?.order_reference && <p className="mt-1 break-all text-muted-foreground">Замовлення: {item.detail.order_reference}</p>}</li>)}</ul></details> : null}
  </section>
}
