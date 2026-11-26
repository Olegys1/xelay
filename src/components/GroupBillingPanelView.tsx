import { RefreshCw } from 'lucide-react'

interface GroupBillingPanelViewProps {
  freeAccess: boolean
  loading: boolean
  error: string
  returnedOrder: boolean
  onRefresh: () => void
}

export function GroupBillingPanelView({ freeAccess, loading, error, returnedOrder, onRefresh }: GroupBillingPanelViewProps) {
  if (freeAccess && !error && !returnedOrder) return null
  if (loading && !error) return null
  return <section aria-label="Доступ до навчальної групи" className="mb-4 rounded-xl border border-border p-4 text-sm">
    {error ? <p role="alert" className="text-destructive">{error}</p> : !freeAccess ? <p role="status">Не вдалося підтвердити доступ до групи.</p> : null}
    {returnedOrder && <p className="text-muted-foreground">Попередні оплати можна переглянути в історії підписки.</p>}
    {(!freeAccess || error) && <button type="button" onClick={onRefresh} disabled={loading} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 disabled:opacity-50"><RefreshCw size={15} aria-hidden="true" />Перевірити доступ</button>}
  </section>
}
