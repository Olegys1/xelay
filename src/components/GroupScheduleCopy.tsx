import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Copy, Loader2, RefreshCw, X } from 'lucide-react'
import { useToast } from '../context/ToastContext'
import { LESSON_TYPES, addTimetableDays, copyStudyGroupScheduleDay, isTimetableDate, mondayForDate, timetableImportError, type ScheduleCopyPreview } from '../lib/studyGroupTimetable'

type Props = {
  groupId: string; targetDate: string; canEdit: boolean
  onCopied: () => Promise<boolean | null>; onLicenseRequired?: () => void
}
const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя']
const inputClass = 'mt-1.5 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base disabled:opacity-50 sm:text-sm'
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50 motion-reduce:transition-none'
function weekday(date: string): number { return isTimetableDate(date) ? new Date(`${date}T12:00:00Z`).getUTCDay() || 7 : 1 }
function dateLabel(date: string): string {
  return isTimetableDate(date) ? new Intl.DateTimeFormat('uk-UA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)) : ''
}

export function GroupScheduleCopy(props: Props) {
  return <CopyWorkspace key={`${props.groupId}:${props.targetDate}`} {...props} />
}

function CopyWorkspace({ groupId, targetDate, canEdit, onCopied, onLicenseRequired }: Props) {
  const { notify } = useToast()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [sourceDate, setSourceDate] = useState(() => mondayForDate(targetDate))
  const [preview, setPreview] = useState<ScheduleCopyPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const request = useRef(0)
  const saveLock = useRef(false)
  const current = useRef({ sourceDate, canEdit, open })
  current.current = { sourceDate, canEdit, open }

  useEffect(() => { alive.current = true; return () => { alive.current = false; ++request.current } }, [])
  useEffect(() => { if (!canEdit) { setOpen(false); setPreview(null); ++request.current } }, [canEdit])
  const explain = (failure: unknown) => {
    if (!alive.current) return
    setError(timetableImportError(failure))
    const message = failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : ''
    if (message.includes('GROUP_LICENSE_REQUIRED')) onLicenseRequired?.()
  }
  const refresh = async (source = sourceDate) => {
    if (!canEdit || saveLock.current) return
    const sequence = ++request.current
    setPreview(null); setError('')
    if (!isTimetableDate(source) || source === targetDate) { setLoading(false); setError('Оберіть правильну дату джерела, відмінну від дати призначення.'); return }
    setLoading(true)
    try {
      const result = await copyStudyGroupScheduleDay(groupId, source, targetDate, true)
      if (alive.current && sequence === request.current && current.current.sourceDate === source && current.current.canEdit && current.current.open) setPreview(result)
    } catch (failure) { if (alive.current && sequence === request.current) explain(failure) }
    finally { if (alive.current && sequence === request.current) setLoading(false) }
  }
  useEffect(() => { if (open && canEdit) void refresh(); else { ++request.current; setLoading(false) } }, [open, sourceDate, canEdit])

  const copy = async () => {
    if (!preview || !canEdit || saveLock.current || loading) return
    saveLock.current = true; setSaving(true); setError('')
    let committed = false
    try {
      const result = await copyStudyGroupScheduleDay(groupId, sourceDate, targetDate, false, preview.source_signature)
      committed = true
      if (!alive.current) return
      setOpen(false); setPreview(null)
      const refreshed = await onCopied()
      if (!alive.current || refreshed === null) return
      notify({ id: `group-copy:${groupId}`, title: result.copied ? 'Розклад скопійовано' : 'Ці пари вже є в розкладі',
        description: `${dateLabel(targetDate)}. Додано: ${result.copied}; уже наявні: ${result.skipped}.${refreshed ? '' : ' Не вдалося оновити список — оновіть сторінку.'}`,
        tone: refreshed ? 'success' : 'warning' })
    } catch (failure) {
      if (!alive.current) return
      if (committed) notify({ id: `group-copy:${groupId}`, title: 'Розклад скопійовано', description: 'Не вдалося оновити список. Оновіть сторінку.', tone: 'warning' })
      else {
        explain(failure)
        setPreview(null)
        notify({ id: `group-copy:${groupId}`, title: 'Перевірте копіювання розкладу', description: `${timetableImportError(failure)} Якщо відповідь загубилася, оновіть список. Повторне копіювання не дублює вже наявні пари.`, tone: 'error' })
      }
    } finally { saveLock.current = false; if (alive.current) setSaving(false) }
  }
  if (!canEdit || weekday(targetDate) < 6) return null
  return <>
    <button type="button" disabled={saving} onClick={() => { setError(''); setOpen(true) }} className={buttonClass}><Copy size={14} aria-hidden="true" />Скопіювати розклад</button>
    {open && <CopyDialog titleId={`${id}-title`} busy={saving} onClose={() => setOpen(false)}>
      <header className="mb-4 flex items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="text-lg font-semibold">Скопіювати розклад</h2><p className="mt-1 text-sm text-muted-foreground">На {dateLabel(targetDate)}</p></div><button type="button" disabled={saving} onClick={() => setOpen(false)} aria-label="Закрити копіювання" className="rounded-full p-2 hover:bg-muted disabled:opacity-50"><X size={18} /></button></header>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">День-джерело<select disabled={saving} value={weekday(sourceDate)} onChange={(event) => setSourceDate(addTimetableDays(mondayForDate(sourceDate || targetDate), Number(event.target.value) - 1))} className={inputClass}>{DAYS.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label>
        <label className="text-sm font-medium">Дата розкладу<input disabled={saving} required type="date" min="1900-01-01" max="2200-12-31" value={sourceDate} onChange={(event) => setSourceDate(event.target.value)} className={inputClass} /></label>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Буде додано пари лише на обрану суботу чи неділю. Джерело збережеться. Копіюються предмет, тип, час, номер, місце й посилання; верхній/нижній тиждень визначається за датою джерела. Домашні завдання не копіюються.</p>
      {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Перевіряємо розклад…</p>}
      {error && <div className="mt-4 rounded-xl bg-destructive/10 p-3"><p role="alert" className="text-sm text-destructive">{error}</p><button type="button" disabled={saving || loading} onClick={() => void refresh()} className={`${buttonClass} mt-3`}><RefreshCw size={14} />Оновити перегляд</button></div>}
      {preview && !loading && <div className="mt-4"><p className="mb-2 text-sm font-medium">Додамо пар: {preview.copied}{preview.skipped > 0 ? ` · Уже є: ${preview.skipped}` : ''}</p><ul className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-border p-3">{preview.lessons.map((lesson) => <li key={lesson.id} className="flex min-w-0 gap-3 text-sm"><span className="shrink-0 tabular-nums text-muted-foreground">{lesson.starts_at.slice(0, 5)}–{lesson.ends_at.slice(0, 5)}</span><span className="min-w-0 break-words">{lesson.subject}<span className="ml-1 text-xs text-muted-foreground">· {LESSON_TYPES[lesson.lesson_type]}</span></span></li>)}</ul></div>}
      <footer className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" disabled={saving} onClick={() => setOpen(false)} className={buttonClass}>Скасувати</button><button type="button" disabled={!preview || loading || saving} onClick={() => void copy()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{saving ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Copy size={16} />}{saving ? 'Копіюємо…' : 'Скопіювати'}</button></footer>
    </CopyDialog>}
  </>
}

function CopyDialog({ titleId, busy, onClose, children }: { titleId: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; dialog.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="xelay-dialog-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-foreground/40 p-3 backdrop-blur-sm sm:p-4" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="xelay-dialog-panel max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-3xl border border-border bg-background p-5 shadow-2xl outline-none sm:p-6" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) onClose()
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || []).filter((item) => item.offsetParent !== null)
    const first = controls[0]; const last = controls[controls.length - 1]
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
  }}>{children}</div></div>
}
