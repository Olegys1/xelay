import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CreditCard, Download, Gift, Loader2, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useBilling } from '../context/BillingContext'

type BillingOrder = { id: string; user_id: string; product: string; amount: number; mode: string; status: string; created_at: string; order_reference: string }
type Overview = { active_participants: number; active_groups: number; paid_groups: number; live_revenue: number; refunds: number; fees: number; fees_known: boolean; fees_pending: number; enforcement_enabled: boolean; orders: BillingOrder[]; audit: Array<{ id: string; action: string; created_at: string; detail: any }> }
const STATUS: Record<string, string> = { pending: 'Очікує', approved: 'Сплачено', declined: 'Відхилено', expired: 'Час вичерпано', refunded: 'Повернено', voided: 'Скасовано' }
const AUDIT_ACTION: Record<string, string> = {
  grant_participant: 'Надання доступу Учасник',
  set_group_enforcement: 'Налаштування оплати груп',
  duplicate_group_payment: 'Повторна оплата групи — перевірте повернення',
}
const money = (value: number) => new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH' }).format(Number(value) || 0)

export function BillingAdminPanel() {
  const navigate = useNavigate()
  const { refreshBilling } = useBilling()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [grantTarget, setGrantTarget] = useState('')
  const [reason, setReason] = useState('')
  const [granting, setGranting] = useState(false)
  const [success, setSuccess] = useState('')
  const active = useRef(true)
  const loadSequence = useRef(0)
  const grantLock = useRef(false)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    const valid = () => active.current && sequence === loadSequence.current
    setLoading(true)
    try {
      const { data, error: loadError } = await supabase.rpc('xelay_admin_billing_overview')
      if (loadError) throw loadError
      if (valid()) { setOverview(data); setError('') }
    } catch {
      if (valid()) { setOverview(null); setError('Розділ оплат недоступний. Перевірте міграцію підписки й права адміністратора.') }
    } finally { if (valid()) setLoading(false) }
  }, [])
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; ++loadSequence.current } }, [load])

  const grant = async (event: FormEvent) => {
    event.preventDefault()
    if (grantLock.current) return
    const userId = grantTarget.trim().match(/(?:^|\/user\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:$|[?#])/i)?.[1]
    if (!userId) { setError('Вставте ID користувача або посилання на його профіль.'); return }
    if (reason.trim().length < 5) { setError('Вкажіть причину надання доступу — щонайменше 5 символів.'); return }
    grantLock.current = true
    setGranting(true)
    setError('')
    setSuccess('')
    try {
      const { error: grantError } = await supabase.rpc('xelay_admin_grant_participant', { p_user_id: userId, p_months: 1, p_reason: reason.trim() })
      if (!active.current) return
      if (grantError) throw grantError
      setSuccess('Один місяць доступу надано. Дію записано в журнал; вона не враховується як оплачена покупка.')
      setGrantTarget('')
      setReason('')
      await Promise.all([load(), refreshBilling()])
    } catch {
      if (active.current) setError('Не вдалося надати доступ. Перевірте профіль і права адміністратора.')
    } finally { grantLock.current = false; if (active.current) setGranting(false) }
  }

  const exportOrders = () => {
    const cell = (value: unknown) => `"${String(value ?? '').replace(/^[=+\-@]/, "'").replace(/"/g, '""')}"`
    const rows = [['Замовлення', 'Продукт', 'Сума, грн', 'Режим', 'Статус', 'Створено'], ...(overview?.orders || []).map((order) => [order.order_reference, order.product === 'group' ? 'Група' : 'Учасник', order.amount, order.mode, STATUS[order.status] || order.status, order.created_at])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((row) => row.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'xelay-payments.csv'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="xelay-card mb-6 min-w-0 overflow-hidden" aria-label="Оплати та підписки">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
      <div><h2 className="flex items-center gap-2 font-semibold"><CreditCard size={18} className="text-primary" /> Оплати та підписки</h2><p className="mt-1 text-xs text-muted-foreground">Тестові транзакції й подарований доступ не збільшують виручку.</p></div>
      <button onClick={() => void load()} disabled={loading} aria-label="Оновити статистику оплат" className="rounded-full p-2 text-primary hover:bg-accent"><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button>
    </header>
    {error && <p role="alert" className="m-5 text-sm text-destructive">{error}</p>}
    {success && <p role="status" className="m-5 rounded-xl bg-accent p-3 text-sm text-primary">{success}</p>}
    {loading && !overview ? <div className="flex justify-center p-8"><Loader2 className="animate-spin text-primary" /></div> : overview && <>
      <div className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-5">
        {[
          ['Активні учасники', String(overview.active_participants)], ['Активовані групи', String(overview.active_groups)],
          ['Успішні оплати без повернень', money(overview.live_revenue)], ['Повернення', money(overview.refunds)], ['Комісії успішних оплат', overview.fees_known ? money(overview.fees) : 'Очікують звірки'],
        ].map(([label, value]) => <div key={label} className="min-w-0 rounded-2xl bg-muted/60 p-3"><p className="text-lg font-bold text-primary break-words">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{label}</p></div>)}
      </div>
      <div className="mx-5 mb-5 rounded-2xl border border-border p-4 text-sm">
        {overview.fees_known ? <p>Після комісій за успішні оплати: <strong>{money(Number(overview.live_revenue) - Number(overview.fees))}</strong></p> : <p>Підсумок після комісій ще не підтверджено. Оплат для звірки: <strong>{overview.fees_pending ?? '—'}</strong>.</p>}
        <p className="mt-1 text-xs text-muted-foreground">Податки та витрати платформи не враховані. Дані потрібно звіряти з випискою провайдера.</p>
        <p className="mt-2 text-xs text-muted-foreground">Обов’язкова оплата груп: {overview.enforcement_enabled ? 'увімкнена' : 'ще не ввімкнена — триває підготовка платежів'}.</p>
      </div>
      <details className="mx-5 mb-5 rounded-2xl border border-border p-4">
        <summary className="cursor-pointer text-sm font-semibold text-primary"><Gift size={15} className="mr-2 inline" /> Надати місяць доступу від адміністратора</summary>
        <p className="mt-3 text-xs text-muted-foreground">Для перевірки функцій або погодженого подарунка. Це реальний доступ до «Учасника», без списання коштів. Кожна дія зберігається з причиною.</p>
        <form onSubmit={(event) => void grant(event)} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted-foreground">ID або посилання на профіль<input value={grantTarget} onChange={(event) => setGrantTarget(event.target.value)} required maxLength={250} className="mt-1 w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label>
          <label className="text-xs text-muted-foreground">Причина<input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} maxLength={500} className="mt-1 w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label>
          <button disabled={granting} className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground sm:col-span-2">{granting && <Loader2 size={15} className="animate-spin" />} Надати 1 місяць</button>
        </form>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-4"><h3 className="text-sm font-semibold">Останні 50 замовлень</h3><button onClick={exportOrders} disabled={!overview.orders?.length} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary disabled:opacity-40"><Download size={14} /> Експорт CSV</button></div>
      {overview.orders?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[580px] text-left text-xs"><thead className="bg-muted/60 text-muted-foreground"><tr>{['Продукт', 'Сума', 'Статус', 'Режим', 'Дата', 'Покупець'].map((label) => <th key={label} className="px-5 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{overview.orders.map((order) => <tr key={order.id} className="border-t border-border"><td className="px-5 py-3">{order.product === 'group' ? 'Група' : 'Учасник'}</td><td className="whitespace-nowrap px-5 py-3">{money(order.amount)}</td><td className="px-5 py-3">{STATUS[order.status] || order.status}</td><td className="px-5 py-3">{order.mode === 'test' ? 'Тест' : 'Реальна оплата'}</td><td className="whitespace-nowrap px-5 py-3">{new Date(order.created_at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}</td><td className="px-5 py-3"><button onClick={() => navigate({ to: '/user/$id', params: { id: order.user_id } })} className="text-primary hover:underline">Профіль</button></td></tr>)}</tbody></table></div> : <p className="px-5 pb-5 text-sm text-muted-foreground">Замовлень поки немає.</p>}
      {overview.audit?.length > 0 && <details className="border-t border-border p-5"><summary className="cursor-pointer text-sm font-semibold">Журнал адміністративних дій</summary><ul className="mt-3 space-y-2">{overview.audit.map((item) => <li key={item.id} className="rounded-xl bg-muted/50 p-3 text-xs"><p className="font-semibold">{AUDIT_ACTION[item.action] || 'Інша дія з оплатою'} · {new Date(item.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}</p><p className="mt-1 break-words text-muted-foreground">{item.detail?.reason}</p>{item.detail?.order_reference && <p className="mt-1 break-all text-muted-foreground">Замовлення: {item.detail.order_reference}</p>}</li>)}</ul></details>}
    </>}
  </section>
}
