import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, BellRing, Clock3, RefreshCw, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

const SNOOZE_MS = 10 * 60 * 1000
const REQUESTS_CHANGED = 'xelay:representative-requests-changed'
type AlertSummary = {
  pending_count: number
  alert_generation: number
  oldest_pending_at: string | null
  latest_pending_at: string | null
  latest_request_id: string | null
}

function readSummary(value: unknown): AlertSummary {
  if (!value || typeof value !== 'object') throw new Error('Invalid alert summary')
  const summary = value as AlertSummary
  if (!Number.isSafeInteger(summary.pending_count) || summary.pending_count < 0
    || !Number.isSafeInteger(summary.alert_generation) || summary.alert_generation < 0
    || !['oldest_pending_at', 'latest_pending_at'].every((field) => {
      const date = summary[field as keyof AlertSummary]
      return date === null || (typeof date === 'string' && Number.isFinite(Date.parse(date)))
    }) || !(summary.latest_request_id === null || (typeof summary.latest_request_id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(summary.latest_request_id)))) {
    throw new Error('Invalid alert summary')
  }
  if (summary.pending_count > 0 && (!summary.latest_request_id || !summary.latest_pending_at || !summary.oldest_pending_at)) {
    throw new Error('Incomplete alert summary')
  }
  return summary
}

function requestCount(count: number) {
  const last = count % 10
  const lastTwo = count % 100
  return `${count} ${last === 1 && lastTwo !== 11 ? 'заявка' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'заявки' : 'заявок'}`
}

function snoozeKey(userId: string) { return `xelay:representative-alert-snooze:${userId}` }
function savedSnooze(userId: string) {
  try {
    const until = Number(sessionStorage.getItem(snoozeKey(userId)))
    return until > Date.now() && until <= Date.now() + SNOOZE_MS ? until : 0
  } catch { return 0 }
}

function anotherDialogIsOpen(ownDialog?: HTMLDialogElement | null) {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'))
    .some((dialog) => dialog !== ownDialog && dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
}

// Mounted only inside AdminSecurityGate. The RPC independently requires an
// administrator with AAL2 and returns counts, dates and an opaque request ID.
export function AdminRepresentativeAlerts({ blocked = false }: { blocked?: boolean }) {
  const { authUser, xelayUser, isLoading, isPasswordRecovery } = useAuth()
  const ready = authUser && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin && !isLoading && !isPasswordRecovery
  return ready ? <RepresentativeAlertWorkspace key={authUser.id} userId={authUser.id} blocked={blocked} /> : null
}

function RepresentativeAlertWorkspace({ userId, blocked }: { userId: string; blocked: boolean }) {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<AlertSummary | null>(null)
  const [error, setError] = useState(false)
  const [candidate, setCandidate] = useState(false)
  const [open, setOpen] = useState(false)
  const [snoozedUntil, setSnoozedUntil] = useState(() => savedSnooze(userId))
  const [refreshing, setRefreshing] = useState(false)
  const summaryRef = useRef<AlertSummary | null>(null)
  const lastSeenGeneration = useRef<number | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    let active = true
    let busy = false
    let queued = false
    let debounce: ReturnType<typeof setTimeout> | null = null
    const refresh = async () => {
      if (!active || document.visibilityState !== 'visible') return
      if (busy) { queued = true; return }
      busy = true
      setRefreshing(true)
      try {
        const result = await supabase.rpc('xelay_admin_representative_alert_summary')
        if (!active) return
        if (result.error) throw result.error
        const next = readSummary(result.data)
        const previous = summaryRef.current
        summaryRef.current = next
        setSummary(next)
        setError(false)
        const seenGeneration = lastSeenGeneration.current
        lastSeenGeneration.current = Math.max(seenGeneration ?? 0, next.alert_generation)
        if (!next.pending_count) { setCandidate(false); setOpen(false) }
        else {
          // Server-controlled generation catches a new arrival even when a
          // simultaneous review leaves the pending count unchanged. Submitted
          // timestamps are display information, never the alert authority.
          if (seenGeneration === null || !previous?.pending_count || next.alert_generation > seenGeneration) {
            setCandidate(true)
          }
        }
        if (previous && (previous.pending_count !== next.pending_count
          || previous.alert_generation !== next.alert_generation
          || previous.latest_request_id !== next.latest_request_id || previous.oldest_pending_at !== next.oldest_pending_at)) {
          window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED, { detail: { userId, source: 'summary' } }))
        }
      } catch {
        // Preserve a known pending count on network or authorization failure;
        // an unavailable summary must never look like an empty queue.
        if (active) setError(true)
      } finally {
        busy = false
        if (active) {
          setRefreshing(false)
          if (queued) { queued = false; schedule() }
        }
      }
    }
    const schedule = () => {
      if (!active || debounce) return
      debounce = setTimeout(() => { debounce = null; void refresh() }, 200)
    }
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; source?: string }>).detail
      if (detail?.userId === userId && detail.source !== 'summary') schedule()
    }
    refreshRef.current = schedule
    void refresh()
    const poll = setInterval(schedule, 30_000)
    window.addEventListener('focus', schedule)
    window.addEventListener('online', schedule)
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener(REQUESTS_CHANGED, onChanged)
    return () => {
      active = false
      refreshRef.current = () => {}
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      window.removeEventListener('focus', schedule)
      window.removeEventListener('online', schedule)
      document.removeEventListener('visibilitychange', schedule)
      window.removeEventListener(REQUESTS_CHANGED, onChanged)
    }
  }, [userId])

  useEffect(() => {
    if (!candidate || !summary?.pending_count) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = null
      const allowed = !blocked && document.visibilityState === 'visible' && !anotherDialogIsOpen(dialogRef.current)
      if (!allowed) { setOpen(false); return }
      if (Date.now() < snoozedUntil) {
        timer = setTimeout(schedule, Math.max(1, snoozedUntil - Date.now() + 1))
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (!blocked && document.visibilityState === 'visible' && !anotherDialogIsOpen(dialogRef.current)) setOpen(true)
      }, 400)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'hidden', 'open'] })
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [candidate, blocked, snoozedUntil, summary?.pending_count])

  const snooze = useCallback(() => {
    const until = Date.now() + SNOOZE_MS
    setOpen(false)
    setSnoozedUntil(until)
    try { sessionStorage.setItem(snoozeKey(userId), String(until)) } catch { /* In-memory snooze still works. */ }
  }, [userId])
  const openQueue = useCallback(() => {
    snooze()
    void navigate({ to: '/admin', hash: 'class-representative-requests' }).then(() => {
      requestAnimationFrame(() => {
        const section = document.getElementById('class-representative-requests')
        section?.scrollIntoView({ block: 'start' })
        section?.focus({ preventScroll: true })
      })
    })
  }, [navigate, snooze])

  if (!summary?.pending_count && !error) return null
  return <>
    <section aria-label="Заявки старост для адміністратора" className="border-b border-primary/20 bg-primary/[0.06] px-4 py-3">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <BellRing size={21} aria-hidden="true" />
            {Boolean(summary?.pending_count) && <span aria-hidden="true" className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-primary motion-safe:animate-pulse" />}
          </span>
          <div className="min-w-0">
            <p role="status" className="text-sm font-semibold text-foreground">{summary?.pending_count ? `${requestCount(summary.pending_count)} — потрібна перевірка старост` : 'Не вдалося перевірити заявки старост'}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{error ? 'Дані не оновлено. Відкрийте чергу або повторіть перевірку.' : 'Сигнал залишатиметься, доки всі заявки не буде розглянуто.'}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-[52px] sm:pl-0">
          {error && <button type="button" disabled={refreshing} onClick={() => refreshRef.current()} aria-label="Повторити перевірку заявок" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/20 text-primary hover:bg-primary/10 disabled:opacity-50"><RefreshCw size={17} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /></button>}
          <button type="button" onClick={openQueue} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 sm:w-auto">Переглянути заявки <ArrowRight size={16} aria-hidden="true" /></button>
        </div>
      </div>
    </section>
    {open && Boolean(summary?.pending_count) && <RepresentativeRequestDialog dialogRef={dialogRef} count={summary!.pending_count} oldest={summary!.oldest_pending_at} onSnooze={snooze} onOpenQueue={openQueue} />}
  </>
}

function RepresentativeRequestDialog({ dialogRef, count, oldest, onSnooze, onOpenQueue }: {
  dialogRef: React.RefObject<HTMLDialogElement | null>
  count: number
  oldest: string | null
  onSnooze: () => void
  onOpenQueue: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || anotherDialogIsOpen(dialog)) return
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [dialogRef])

  return createPortal(<dialog ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onSnooze() }}
    className="fixed inset-0 m-auto max-h-[88dvh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-[28px] border border-primary/20 bg-card p-6 text-foreground shadow-2xl outline-none backdrop:bg-black/40 backdrop:backdrop-blur-sm sm:p-8">
    <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"><BellRing size={30} aria-hidden="true" /></span>
    <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-primary"><ShieldCheck size={14} aria-hidden="true" /> Тільки для адміністраторів</p>
    <h2 id={titleId} className="mt-2 text-center text-2xl font-semibold leading-tight">Старости чекають на відповідь</h2>
    <div id={descriptionId} className="mt-3 text-center text-sm leading-6 text-muted-foreground">
      <p><strong className="font-semibold text-foreground">{requestCount(count)}</strong> на підтвердження статусу. Перевірте дані та надайте відповідь у черзі заявок.</p>
      {oldest && <p className="mt-2 text-xs">Найдавніша заявка: <time dateTime={oldest}>{new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(oldest))}</time>.</p>}
    </div>
    <div className="mt-6 space-y-2">
      <button type="button" autoFocus onClick={onOpenQueue} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Переглянути заявки <ArrowRight size={17} aria-hidden="true" /></button>
      <button type="button" onClick={onSnooze} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-4 py-2 text-sm text-muted-foreground hover:bg-muted"><Clock3 size={15} aria-hidden="true" /> Нагадати через 10 хвилин</button>
    </div>
    <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">Нагадування можна відкласти. Заявка зникне із сигналу лише після розгляду.</p>
  </dialog>, document.body)
}
