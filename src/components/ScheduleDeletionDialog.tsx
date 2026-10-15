import { useEffect, useId, useRef } from 'react'
import { CalendarX2, Loader2, Trash2, X } from 'lucide-react'

type Props = {
  subject: string
  date: string
  busy: boolean
  onClose: () => void
  onCancelOccurrence: () => void
  onDeleteSeries: () => void
}

function displayDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
    : value
}

export function ScheduleDeletionDialog({ subject, date, busy, onClose, onCancelOccurrence, onDeleteSeries }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const safeAction = useRef<HTMLButtonElement>(null)
  const formattedDate = displayDate(date)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    safeAction.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (busy) panel.current?.focus()
    else if (panel.current && !panel.current.contains(document.activeElement)) safeAction.current?.focus()
  }, [busy])

  return (
    <div className="xelay-dialog-backdrop fixed inset-0 z-[90] flex items-center justify-center bg-black/35 px-3 py-5 backdrop-blur-sm" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1} className="xelay-dialog-panel max-h-[90dvh] w-full min-w-0 max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl outline-none sm:p-6" onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!busy) onClose()
          return
        }
        if (event.key !== 'Tab') return
        const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])
          .filter((element) => element.offsetParent !== null)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first) { event.preventDefault(); panel.current?.focus(); return }
        if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus() }
      }}>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">Прибрати пару</h2>
            <p className="mt-1 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{subject}</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="Закрити вікно" className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40 motion-reduce:transition-none"><X size={19} aria-hidden="true" /></button>
        </header>
        <div id={descriptionId} className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p>Якщо заняття скасували або перенесли, приберіть його лише на {formattedDate}</p>
          <p>Інші повторення залишаться в розкладі. Домашні завдання та файли збережуться.</p>
        </div>
        <button ref={safeAction} type="button" disabled={busy} onClick={onCancelOccurrence} className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none">
          {busy ? <Loader2 size={18} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" /> : <CalendarX2 size={18} aria-hidden="true" className="shrink-0" />}
          Прибрати лише {formattedDate}
        </button>
        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs leading-relaxed text-muted-foreground">Усю пару видаляйте, лише якщо вона більше не потрібна в розкладі. Будуть видалені всі її повторення та пов’язані домашні завдання.</p>
          <button type="button" disabled={busy} onClick={onDeleteSeries} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-destructive/25 px-3 py-2.5 text-center text-sm font-medium text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30 disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"><Trash2 size={16} aria-hidden="true" className="shrink-0" />Видалити всі повторення та ДЗ</button>
        </div>
        <button type="button" disabled={busy} onClick={onClose} className="mt-3 min-h-11 w-full rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 motion-reduce:transition-none">Залишити без змін</button>
      </div>
    </div>
  )
}
