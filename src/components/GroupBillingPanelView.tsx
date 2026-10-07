import { ChevronDown, GraduationCap, RefreshCw } from 'lucide-react'

interface GroupBillingPanelViewProps {
  freeAccess: boolean
  loading: boolean
  error: string
  returnedOrder: boolean
  onRefresh: () => void
}

export function GroupBillingPanelView({ freeAccess, loading, error, returnedOrder, onRefresh }: GroupBillingPanelViewProps) {
  return <section aria-label="Доступ до навчальної групи" className="mb-6 rounded-2xl border border-primary/15 bg-primary/5 p-4 sm:p-5">
    <details className="group/billing">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-lg [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <GraduationCap size={24} className="shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{loading ? 'Перевіряємо доступ…' : freeAccess ? 'Навчальна група — безкоштовно' : 'Доступ до навчальної групи'}</h2>
            <p className="mt-1 text-sm text-primary">{freeAccess ? 'Для всіх учасників · без обмеження строку' : 'Перевірка доступу на сервері'}</p>
          </div>
        </div>
        <span className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-primary/20 bg-background px-4 py-2.5 text-sm font-semibold text-primary">
          <span className="group-open/billing:hidden">Докладніше</span>
          <span className="hidden group-open/billing:inline">Згорнути</span>
          <ChevronDown size={18} className="transition-transform motion-reduce:transition-none group-open/billing:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="mt-4 space-y-3 border-t border-primary/15 pt-4 text-sm leading-relaxed">
        <p>Розклад, домашні завдання, семінари й матеріали за предметами доступні без оплати та особистої підписки «Учасник».</p>
        <p className="text-xs text-muted-foreground">Староста керує групою та призначає права заступникам. Учасники можуть переглядати навчальну інформацію й брати участь у семінарах; змінювати спільні матеріали можуть лише люди з відповідними дозволами.</p>
        {!loading && !freeAccess && !error && <p role="status" className="text-xs text-muted-foreground">Безкоштовний доступ ще налаштовується на сервері. Дані групи збережені.</p>}
        {returnedOrder && <p className="text-xs text-muted-foreground">Попередні оплати залишаються в історії на сторінці підписки. Нові оплати за групу не потрібні.</p>}
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/20 bg-background px-3.5 py-2.5 text-xs font-semibold text-primary disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} aria-hidden="true" />Оновити статус</button>
      </div>
    </details>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </section>
}