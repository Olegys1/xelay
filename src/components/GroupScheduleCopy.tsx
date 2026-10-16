import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Copy, Loader2, RefreshCw, X } from 'lucide-react'
import { useToast } from '../context/ToastContext'
import { DEFAULT_TIMETABLE_SLOTS, LESSON_TYPES, addTimetableDays, copyStudyGroupScheduleDay, isTimetableDate, mondayForDate, scheduleCopyTimeKey, timetableImportError, type ScheduleCopyLesson, type ScheduleCopyPreview, type ScheduleCopySlotAssignment, type ScheduleCopyTimeMode } from '../lib/studyGroupTimetable'
import { buildScheduleCopySequence, copyStudyGroupScheduleSequence, scheduleCopyCycle, scheduleCopySequenceError, MAX_SCHEDULE_COPY_DATES, type ScheduleCopySequencePreview } from '../lib/studyGroupScheduleSequence'

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
  const [mode, setMode] = useState<'day' | 'sequence'>('day')
  const [firstTarget, setFirstTarget] = useState(targetDate)
  const [until, setUntil] = useState(() => addTimetableDays(targetDate, 35))
  const [sourceWeekdays, setSourceWeekdays] = useState([1, 2, 3, 4, 5])
  const [firstWeekday, setFirstWeekday] = useState(1)
  const [timeMode, setTimeMode] = useState<ScheduleCopyTimeMode>('original')
  const [overrideState, setOverrideState] = useState<{ base: string; assignments: Record<string, ScheduleCopySlotAssignment[]> }>({ base: '', assignments: {} })
  const [mappingWorkspace, setMappingWorkspace] = useState<{ base: string; days: { source_date: string; target_date: string; lessons: ScheduleCopyLesson[]; slot_assignments: ScheduleCopySlotAssignment[] }[] } | null>(null)
  const [preview, setPreview] = useState<ScheduleCopyPreview | null>(null)
  const [sequencePreview, setSequencePreview] = useState<ScheduleCopySequencePreview | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const request = useRef(0)
  const saveLock = useRef(false)
  const baseConfiguration = JSON.stringify([mode, sourceDate, firstTarget, until, sourceWeekdays, firstWeekday, timeMode])
  const slotAssignments = overrideState.base === baseConfiguration ? overrideState.assignments : {}
  const configuration = JSON.stringify([baseConfiguration, slotAssignments])
  const current = useRef({ configuration, canEdit, open })
  current.current = { configuration, canEdit, open }
  const activePreview = mode === 'day' ? preview : sequencePreview
  const errorMessage = (failure: unknown) => scheduleCopySequenceError(failure) || timetableImportError(failure)
  let cycle: number[] = []
  try { cycle = scheduleCopyCycle(sourceWeekdays, firstWeekday) } catch { /* An empty selection has an inline validation message. */ }

  useEffect(() => { alive.current = true; return () => { alive.current = false; ++request.current } }, [])
  useEffect(() => { setOverrideState({ base: baseConfiguration, assignments: {} }) }, [baseConfiguration])
  useEffect(() => { if (!canEdit) { setOpen(false); setPreview(null); setSequencePreview(null); setPreviewKey(''); ++request.current } }, [canEdit])
  const explain = (failure: unknown) => {
    if (!alive.current) return
    setError(errorMessage(failure))
    const message = failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : ''
    if (message.includes('GROUP_LICENSE_REQUIRED')) onLicenseRequired?.()
  }
  const refresh = async () => {
    if (!canEdit || !current.current.canEdit || !current.current.open || saveLock.current) return
    const sequence = ++request.current
    const requestedConfiguration = configuration
    setPreview(null); setSequencePreview(null); setPreviewKey(''); setError('')
    setLoading(true)
    try {
      if (mode === 'day' && (!isTimetableDate(sourceDate) || sourceDate === targetDate)) throw new Error('Оберіть правильну дату джерела, відмінну від дати призначення.')
      const result = mode === 'day'
        ? await copyStudyGroupScheduleDay(groupId, sourceDate, targetDate, true, null, timeMode, slotAssignments[sourceDate] || [])
        : await copyStudyGroupScheduleSequence(groupId, buildScheduleCopySequence(firstTarget, until, sourceWeekdays, firstWeekday), true, null, timeMode, slotAssignments)
      if (alive.current && sequence === request.current && current.current.configuration === requestedConfiguration && current.current.canEdit && current.current.open) {
        if (mode === 'day') setPreview(result as ScheduleCopyPreview)
        else setSequencePreview(result as ScheduleCopySequencePreview)
        if (timeMode === 'first_shift') {
          const days = mode === 'day' ? [{ source_date: sourceDate, target_date: targetDate, ...(result as ScheduleCopyPreview) }] : (result as ScheduleCopySequencePreview).days
          setMappingWorkspace({ base: baseConfiguration, days: days.map((day) => ({ source_date: day.source_date, target_date: day.target_date, lessons: day.lessons, slot_assignments: day.slot_assignments || [] })) })
        }
        setPreviewKey(requestedConfiguration)
      }
    } catch (failure) { if (alive.current && sequence === request.current && current.current.configuration === requestedConfiguration && current.current.canEdit && current.current.open) explain(failure) }
    finally { if (alive.current && sequence === request.current) setLoading(false) }
  }
  useEffect(() => { if (open && canEdit) void refresh(); else { ++request.current; setLoading(false) } }, [open, configuration, canEdit])

  const copy = async () => {
    if (!activePreview || activePreview.copied + activePreview.skipped === 0 || previewKey !== configuration || !canEdit || !current.current.canEdit || !current.current.open || current.current.configuration !== configuration || saveLock.current || loading) return
    saveLock.current = true; setSaving(true); setError('')
    const requestedConfiguration = configuration
    let committed = false
    try {
      const result = mode === 'day'
        ? await copyStudyGroupScheduleDay(groupId, sourceDate, targetDate, false, activePreview.source_signature, timeMode, slotAssignments[sourceDate] || [])
        : await copyStudyGroupScheduleSequence(groupId, buildScheduleCopySequence(firstTarget, until, sourceWeekdays, firstWeekday), false, activePreview.source_signature, timeMode, slotAssignments)
      committed = true
      if (!alive.current || !current.current.canEdit || current.current.configuration !== requestedConfiguration) return
      setOpen(false); setPreview(null); setSequencePreview(null); setPreviewKey('')
      const refreshed = await onCopied()
      if (!alive.current || refreshed === null) return
      notify({ id: `group-copy:${groupId}`, title: result.copied ? 'Розклад скопійовано' : 'Ці пари вже є в розкладі',
        description: `${mode === 'day' ? dateLabel(targetDate) : `Копіювання на ${sequencePreview?.days.length || 0} дат`}. Додано: ${result.copied}; уже наявні: ${result.skipped}.${refreshed ? '' : ' Не вдалося оновити список — оновіть сторінку.'}`,
        tone: refreshed ? 'success' : 'warning' })
    } catch (failure) {
      if (!alive.current || !current.current.canEdit || current.current.configuration !== requestedConfiguration) return
      if (committed) notify({ id: `group-copy:${groupId}`, title: 'Розклад скопійовано', description: 'Не вдалося оновити список. Оновіть сторінку.', tone: 'warning' })
      else {
        explain(failure)
        setPreview(null); setSequencePreview(null); setPreviewKey('')
        notify({ id: `group-copy:${groupId}`, title: 'Перевірте копіювання розкладу', description: `${errorMessage(failure)} Якщо відповідь загубилася, оновіть список. Повторне копіювання не дублює вже наявні пари.`, tone: 'error' })
      }
    } finally { saveLock.current = false; if (alive.current) setSaving(false) }
  }
  if (!canEdit || weekday(targetDate) < 6) return null
  return <>
    <button type="button" disabled={saving} onClick={() => { setError(''); setOpen(true) }} className={buttonClass}><Copy size={14} aria-hidden="true" />Скопіювати розклад</button>
    {open && <CopyDialog titleId={`${id}-title`} busy={saving} onClose={() => setOpen(false)}>
      <header className="mb-4 flex items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="text-lg font-semibold">Скопіювати розклад</h2><p className="mt-1 text-sm text-muted-foreground">{mode === 'day' ? `Дата копії: ${dateLabel(targetDate)}` : 'Щотижневі разові копії з чергуванням будніх днів'}</p></div><button type="button" disabled={saving} onClick={() => setOpen(false)} aria-label="Закрити копіювання" className="rounded-full p-2 hover:bg-muted disabled:opacity-50"><X size={18} /></button></header>
      <fieldset disabled={saving} className="mb-4 min-w-0"><legend className="mb-2 text-sm font-medium">Як скопіювати розклад?</legend><div className="grid grid-cols-2 gap-2">{([['day', 'Один день'], ['sequence', 'Чергувати дні']] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2 text-center text-sm font-medium focus-within:ring-2 focus-within:ring-primary/30 ${mode === value ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border text-muted-foreground'}`}><input type="radio" name={`${id}-copy-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} className="h-4 w-4 accent-primary" />{label}</label>)}</div></fieldset>
      {mode === 'day' ? <><div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">День-джерело<select disabled={saving} value={weekday(sourceDate)} onChange={(event) => setSourceDate(addTimetableDays(mondayForDate(sourceDate || targetDate), Number(event.target.value) - 1))} className={inputClass}>{DAYS.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label>
        <label className="text-sm font-medium">Дата розкладу<input disabled={saving} required type="date" min="1900-01-01" max="2200-12-31" value={sourceDate} onChange={(event) => setSourceDate(event.target.value)} className={inputClass} /></label>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Буде додано пари лише на обрану суботу чи неділю. Джерело збережеться. Копіюються предмет, тип, місце й посилання; час і номер залежать від вибору нижче. Верхній/нижній тиждень визначається за датою джерела. Домашні завдання не копіюються.</p></> : <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">Щотижня копіюватимемо наступний обраний будній день на суботу чи неділю. Після останнього дня цикл почнеться знову.</p>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">Перша дата копіювання<input type="date" required min="1900-01-01" max="2200-12-31" disabled={saving} value={firstTarget} onChange={(event) => setFirstTarget(event.target.value)} className={inputClass} /><span className="mt-1 block text-xs font-normal text-muted-foreground">Оберіть суботу або неділю. Далі — той самий день щотижня.</span></label><label className="text-sm font-medium">Копіювати до дати включно<input type="date" required min={firstTarget || '1900-01-01'} max="2200-12-31" disabled={saving} value={until} onChange={(event) => setUntil(event.target.value)} className={inputClass} /><span className="mt-1 block text-xs font-normal text-muted-foreground">Щонайбільше {MAX_SCHEDULE_COPY_DATES} дат за один раз.</span></label></div>
        <fieldset disabled={saving}><legend className="text-sm font-medium">Які дні чергувати?</legend><div className="mt-2 flex flex-wrap gap-2">{DAYS.slice(0, 5).map((day, index) => { const value = index + 1; return <label key={day} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium focus-within:ring-2 focus-within:ring-primary/30 ${sourceWeekdays.includes(value) ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border text-muted-foreground'}`}><input type="checkbox" checked={sourceWeekdays.includes(value)} onChange={(event) => {
          const next = event.target.checked ? [...sourceWeekdays, value].sort((a, b) => a - b) : sourceWeekdays.filter((item) => item !== value)
          setSourceWeekdays(next)
          if (!next.includes(firstWeekday)) setFirstWeekday(next[0] || 1)
        }} className="h-4 w-4 accent-primary" />{day}</label> })}</div></fieldset>
        <label className="block text-sm font-medium">Перший день циклу<select disabled={saving || !sourceWeekdays.length} value={firstWeekday} onChange={(event) => setFirstWeekday(Number(event.target.value))} className={inputClass}>{sourceWeekdays.map((day) => <option key={day} value={day}>{DAYS[day - 1]}</option>)}</select></label>
        {cycle.length > 0 && <p className="rounded-xl bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground"><span className="font-medium text-foreground">Порядок: </span>{cycle.map((day) => DAYS[day - 1]).join(' → ')} → знову {DAYS[cycle[0] - 1].toLocaleLowerCase('uk-UA')}.</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">Для кожної дати беремо розклад буднього дня з її ж тижня. Так враховуються верхній і нижній тижні, зміни та скасування. Кожна копія буде разовою; початковий розклад збережеться. Домашні завдання не копіюються.</p>
      </div>}
      <fieldset disabled={saving} className="mt-4 min-w-0"><legend className="mb-2 text-sm font-medium">Час занять</legend><div className="space-y-2">{([['original', 'Залишити як у вихідному розкладі'], ['first_shift', 'Перенести на першу зміну']] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-primary/30 ${timeMode === value ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border text-muted-foreground'}`}><input type="radio" name={`${id}-time-mode`} value={value} checked={timeMode === value} onChange={() => setTimeMode(value)} className="h-4 w-4 shrink-0 accent-primary" />{label}</label>)}</div>{timeMode === 'first_shift' && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Перша пара — о 08:00. Для кожної дати джерела окремо переносимо пари в першу зміну. Коли всі номери відомі й узгоджені, зберігаємо пропуски між ними; без повної нумерації беремо порядок за часом. До збереження перевірте час нижче. Номер пари можна змінити — після цього знову перевіримо перетини. Початковий розклад не зміниться.</p>}</fieldset>
      {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Перевіряємо розклад…</p>}
      {error && <div className="mt-4 rounded-xl bg-destructive/10 p-3"><p role="alert" className="text-sm text-destructive">{error}</p><button type="button" disabled={saving || loading} onClick={() => void refresh()} className={`${buttonClass} mt-3`}><RefreshCw size={14} />Оновити перегляд</button></div>}
      {timeMode === 'first_shift' && mappingWorkspace?.base === baseConfiguration && mappingWorkspace.days.some((day) => day.slot_assignments.length > 0) && <section className="mt-4" aria-label="Номери пар першої зміни"><h3 className="text-sm font-semibold">Було → стане</h3><div className="mt-2 max-h-72 space-y-4 overflow-y-auto rounded-xl border border-border p-3">{mappingWorkspace.days.filter((day) => day.slot_assignments.length > 0).map((day) => <FirstShiftMapping key={day.source_date} sourceDate={day.source_date} targetDate={day.target_date} lessons={day.lessons} assignments={slotAssignments[day.source_date] || day.slot_assignments} disabled={saving} onChange={(assignments) => setOverrideState({ base: baseConfiguration, assignments: { ...slotAssignments, [day.source_date]: assignments } })} />)}</div>{(loading || previewKey !== configuration) && <p className="mt-2 text-xs text-muted-foreground">Це вибрані номери пар. Копіювання стане доступним після успішної перевірки нового часу.</p>}</section>}
      {mode === 'day' && preview && previewKey === configuration && !loading && <div className="mt-4"><p className="mb-2 text-sm font-medium">Додамо пар: {preview.copied}{preview.skipped > 0 ? ` · Уже є: ${preview.skipped}` : ''}</p><ul className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-border p-3">{preview.lessons.map((lesson) => <li key={lesson.id} className="min-w-0 text-sm"><LessonCopyTime lesson={lesson} shifted={timeMode === 'first_shift'} /><span className="ml-2 break-words">{lesson.subject}<span className="ml-1 text-xs text-muted-foreground">· {LESSON_TYPES[lesson.lesson_type]}</span></span></li>)}</ul></div>}
      {mode === 'sequence' && sequencePreview && previewKey === configuration && !loading && <section className="mt-4" aria-label="Перегляд чергування розкладу"><p className="mb-2 text-sm font-medium">Дат: {sequencePreview.days.length} · Додамо пар: {sequencePreview.copied}{sequencePreview.skipped > 0 ? ` · Уже є: ${sequencePreview.skipped}` : ''}</p><ol className="max-h-72 space-y-3 overflow-y-auto rounded-xl border border-border p-3">{sequencePreview.days.map((day) => <li key={day.target_date} className="min-w-0 border-b border-border pb-3 last:border-0 last:pb-0"><p className="break-words text-sm font-semibold">Дата копії: {dateLabel(day.target_date)}</p><p className="mt-1 break-words text-xs text-muted-foreground">Джерело: {dateLabel(day.source_date)}</p><p className="mt-1 text-xs text-muted-foreground">Додамо: {day.copied} · Уже є: {day.skipped}</p>{day.lessons.length ? <ul className="mt-2 space-y-1.5">{day.lessons.map((lesson) => <li key={lesson.id} className="min-w-0 text-xs"><LessonCopyTime lesson={lesson} shifted={timeMode === 'first_shift'} /><span className="ml-2 break-words">{lesson.subject}<span className="ml-1 text-muted-foreground">· {LESSON_TYPES[lesson.lesson_type]}</span></span></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">У цей день-джерело занять немає — нічого не додаємо.</p>}</li>)}</ol></section>}
      {mode === 'sequence' && activePreview && previewKey === configuration && !loading && activePreview.copied + activePreview.skipped === 0 && <p role="status" className="mt-3 text-sm text-muted-foreground">На обрані дати немає пар для копіювання. Змініть дні або період.</p>}
      <footer className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" disabled={saving} onClick={() => setOpen(false)} className={buttonClass}>Скасувати</button><button type="button" disabled={!activePreview || activePreview.copied + activePreview.skipped === 0 || previewKey !== configuration || loading || saving} onClick={() => void copy()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{saving ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Copy size={16} />}{saving ? 'Копіюємо…' : mode === 'day' ? 'Скопіювати' : 'Скопіювати всі дати'}</button></footer>
    </CopyDialog>}
  </>
}

function LessonCopyTime({ lesson, shifted }: { lesson: ScheduleCopyLesson; shifted: boolean }) {
  const target = `${lesson.starts_at.slice(0, 5)}–${lesson.ends_at.slice(0, 5)}`
  return <span className="inline-block tabular-nums text-muted-foreground">{shifted && lesson.source_starts_at && lesson.source_ends_at ? <><span>{lesson.source_starts_at.slice(0, 5)}–{lesson.source_ends_at.slice(0, 5)}</span><span aria-label="перенесено на" className="mx-1">→</span><strong className="font-semibold text-foreground">{target}</strong></> : target}</span>
}

function FirstShiftMapping({ sourceDate, targetDate, lessons, assignments, disabled, onChange }: {
  sourceDate: string; targetDate: string; lessons: ScheduleCopyLesson[]; assignments: ScheduleCopySlotAssignment[]
  disabled: boolean; onChange: (assignments: ScheduleCopySlotAssignment[]) => void
}) {
  const id = useId()
  return <div className="min-w-0 border-b border-border pb-3 last:border-0 last:pb-0"><p className="break-words text-xs font-semibold">{dateLabel(sourceDate)} → {dateLabel(targetDate)}</p><p className="mt-1 text-xs text-muted-foreground">Змінюємо лише час копії на цю дату.</p><div className="mt-2 space-y-3">{assignments.map((assignment, index) => {
    const key = scheduleCopyTimeKey(assignment.source_starts_at, assignment.source_ends_at)
    const matching = lessons.filter((lesson) => lesson.source_starts_at && lesson.source_ends_at && scheduleCopyTimeKey(lesson.source_starts_at, lesson.source_ends_at) === key)
    const sourceNumber = matching[0]?.source_lesson_number
    const slot = DEFAULT_TIMETABLE_SLOTS.find((item) => item.number === assignment.target_lesson_number)
    return <div key={key} className="min-w-0"><p className="mb-1 break-words text-xs">{matching.map((lesson) => lesson.subject).join(' / ')}</p><div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"><span className="text-xs tabular-nums text-muted-foreground">{sourceNumber ? `${sourceNumber} пара · ` : ''}{assignment.source_starts_at.slice(0, 5)}–{assignment.source_ends_at.slice(0, 5)}</span><span aria-hidden="true" className="text-muted-foreground">→</span><label htmlFor={`${id}-${index}`} className="min-w-0"><span className="sr-only">Номер пари для {sourceDate}, {assignment.source_starts_at.slice(0, 5)}–{assignment.source_ends_at.slice(0, 5)}</span><select id={`${id}-${index}`} disabled={disabled} value={assignment.target_lesson_number} onChange={(event) => onChange(assignments.map((item, itemIndex) => itemIndex === index ? { ...item, target_lesson_number: Number(event.target.value) } : item))} className="w-full min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-base disabled:opacity-50 sm:text-xs">{DEFAULT_TIMETABLE_SLOTS.map((item) => <option key={item.number} value={item.number}>{item.number} пара · {item.starts_at}–{item.ends_at}</option>)}</select>{slot && <span className="sr-only">Час копії: {slot.starts_at}–{slot.ends_at}</span>}</label></div></div>
  })}</div></div>
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
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); return }
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || []).filter((item) => item.offsetParent !== null)
    const first = controls[0]; const last = controls[controls.length - 1]
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
  }}>{children}</div></div>
}
