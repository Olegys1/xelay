import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Archive, CalendarDays, ChevronDown, ChevronUp, Loader2, Pencil, Pin, Plus, RotateCcw, X } from 'lucide-react'
import { kyivToday } from '../lib/seminars'
import {
  longTermTaskError, normalizeLongTermSubject, saveStudyGroupLongTermTask, setStudyGroupLongTermTaskClosed,
  type StudyGroupLongTermTask,
} from '../lib/studyGroupLongTermTasks'

const inputClass = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50 sm:text-sm motion-reduce:transition-none'
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const smallButton = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'

function matchesSubject(task: StudyGroupLongTermTask, subject: string) {
  return normalizeLongTermSubject(task.subject) === normalizeLongTermSubject(subject)
}

function taskDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
    : value
}

function useKyivCalendarDate() {
  const [today, setToday] = useState(kyivToday)
  useEffect(() => {
    const refresh = () => setToday(kyivToday())
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return today
}

function TaskRow({ task, today, children }: { task: StudyGroupLongTermTask; today: string; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const descriptionId = useId()
  const overdue = !task.closed_at && task.due_date < today
  return (
    <article className="min-w-0 rounded-xl border border-border bg-background px-3 py-2.5">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={descriptionId} className="flex w-full min-w-0 items-start gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">{task.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CalendarDays size={13} aria-hidden="true" />До {taskDate(task.due_date)}</span>
            {overdue && <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">Строк минув</span>}
            {task.closed_at && <span className="rounded-full bg-muted px-2 py-0.5">Закрито</span>}
          </span>
        </span>
        {expanded ? <ChevronUp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronDown size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </button>
      <div id={descriptionId} hidden={!expanded} className="mt-2.5 whitespace-pre-wrap break-words border-t border-border pt-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]">
        {task.description || <span className="text-muted-foreground">Опис не додано.</span>}
      </div>
      {children}
    </article>
  )
}

type ListProps = {
  subject: string; tasks: StudyGroupLongTermTask[]; loading?: boolean; error?: string
  onRetry?: () => void; onManage?: () => void
}

export function LongTermTaskList({ subject, tasks, loading = false, error = '', onRetry, onManage }: ListProps) {
  const today = useKyivCalendarDate()
  const activeTasks = tasks.filter((task) => !task.closed_at && matchesSubject(task, subject))
    .sort((first, second) => first.due_date.localeCompare(second.due_date) || first.created_at.localeCompare(second.created_at))
  if (!activeTasks.length && !loading && !error && !onManage) return null
  return (
    <section className="min-w-0 space-y-2 border-t border-border pt-3" aria-label={`Довгострокові завдання: ${subject}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
        <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-muted-foreground"><Pin size={14} className="shrink-0 text-primary" aria-hidden="true" />Довгострокові завдання</h4>
        {onManage && <button type="button" onClick={onManage} className={smallButton} aria-label={`Керувати довгостроковими завданнями: ${subject}`}><Pencil size={13} aria-hidden="true" />Керувати</button>}
      </div>
      {error ? <div role="status" className="text-xs text-muted-foreground">{error}{onRetry && <button type="button" onClick={onRetry} className={`${smallButton} ml-1`}>Оновити</button>}</div>
        : loading && !activeTasks.length ? <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Завантажуємо завдання…</p>
        : !activeTasks.length ? <p className="text-xs text-muted-foreground">Активних завдань поки немає.</p>
        : activeTasks.map((task) => <TaskRow key={task.id} task={task} today={today} />)}
    </section>
  )
}

type ManagerProps = {
  groupId: string; currentUserId: string; subjects: string[]; tasks: StudyGroupLongTermTask[]
  loading: boolean; error: string; onReload: () => Promise<unknown> | void; canEdit: boolean
  initialSubject?: string; onClose: () => void
}
type Editor = { id: string | null; subject: string; title: string; description: string; dueDate: string }

function subjectChoices(subjects: string[], tasks: StudyGroupLongTermTask[], initialSubject?: string) {
  const choices = new Map<string, string>()
  for (const subject of [...subjects, ...tasks.map((task) => task.subject), initialSubject || '']) {
    const value = subject.trim()
    const key = normalizeLongTermSubject(value)
    if (key && !choices.has(key)) choices.set(key, value)
  }
  return [...choices.values()].sort((first, second) => first.localeCompare(second, 'uk'))
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-1.5"><span className="block text-sm font-medium">{label}</span>{children}</label>
}

export function StudyGroupLongTermTaskManager(props: ManagerProps) {
  return <LongTermTaskManagerWorkspace key={`${props.groupId}:${props.currentUserId}`} {...props} />
}

function LongTermTaskManagerWorkspace({ groupId, subjects, tasks, loading, error, onReload, canEdit, initialSubject, onClose }: ManagerProps) {
  const today = useKyivCalendarDate()
  const groupTasks = useMemo(() => tasks.filter((task) => task.group_id === groupId), [tasks, groupId])
  const choices = useMemo(() => subjectChoices(subjects, groupTasks, initialSubject), [subjects, groupTasks, initialSubject])
  const [subject, setSubject] = useState(() => choices.find((value) => normalizeLongTermSubject(value) === normalizeLongTermSubject(initialSubject || '')) || choices[0] || '')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showArchive, setShowArchive] = useState(false)
  const [busy, setBusy] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const editorTitle = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const mutation = useRef(false)
  const permissions = useRef(canEdit)
  permissions.current = canEdit
  const latestClose = useRef(onClose)
  latestClose.current = onClose
  const archiveId = useId()
  const titleId = useId()
  const explanationId = useId()

  useEffect(() => {
    alive.current = true
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    return () => {
      alive.current = false
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (editor) editorTitle.current?.focus()
    else if (dialog.current && !dialog.current.contains(document.activeElement)) dialog.current.focus()
  }, [editor?.id, Boolean(editor)])
  useEffect(() => {
    if (subject && choices.some((value) => normalizeLongTermSubject(value) === normalizeLongTermSubject(subject))) return
    setSubject(choices[0] || '')
    setEditor(null)
  }, [choices, subject])
  useEffect(() => {
    if (!canEdit) setEditor(null)
  }, [canEdit])

  const subjectTasks = groupTasks.filter((task) => matchesSubject(task, subject))
    .sort((first, second) => first.due_date.localeCompare(second.due_date) || first.created_at.localeCompare(second.created_at))
  const activeTasks = subjectTasks.filter((task) => !task.closed_at)
  const archivedTasks = subjectTasks.filter((task) => task.closed_at)

  const runMutation = async (name: string, action: () => Promise<unknown>, success: string, after?: () => void) => {
    if (mutation.current || !permissions.current) return
    mutation.current = true
    setBusy(name)
    setFormError('')
    setNotice('')
    try {
      await action()
      if (!alive.current) return
      after?.()
      setNotice(success)
      try { await onReload() } catch {
        if (alive.current) setFormError('Дію збережено, але список не вдалося оновити. Натисніть «Оновити».')
      }
    } catch (actionError) {
      if (alive.current) setFormError(longTermTaskError(actionError))
    } finally {
      mutation.current = false
      if (alive.current) setBusy('')
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!editor || mutation.current || !permissions.current) return
    const title = editor.title.trim()
    const chosenSubject = editor.subject.trim()
    const description = editor.description.trim()
    if (!chosenSubject || chosenSubject.length > 120) { setFormError('Оберіть предмет із назвою до 120 символів.'); return }
    if (!title || title.length > 240) { setFormError('Додайте назву завдання до 240 символів.'); editorTitle.current?.focus(); return }
    if (description.length > 10000) { setFormError('Скоротіть опис до 10 000 символів.'); return }
    if (!validDate(editor.dueDate)) { setFormError('Оберіть кінцеву дату від 1900 до 2200 року.'); return }
    void runMutation('save', () => saveStudyGroupLongTermTask({ groupId, id: editor.id, subject: chosenSubject, title, description, dueDate: editor.dueDate }), editor.id ? 'Зміни збережено для всіх семінарів предмета.' : 'Завдання додано до всіх семінарів предмета.', () => { setSubject(chosenSubject); setEditor(null) })
  }

  const changeSubject = (value: string) => {
    setSubject(value)
    setEditor(null)
    setFormError('')
    setNotice('')
    setShowArchive(false)
  }
  const edit = (task: StudyGroupLongTermTask) => {
    if (mutation.current || !permissions.current) return
    setEditor({ id: task.id, subject: task.subject, title: task.title, description: task.description, dueDate: task.due_date })
    setFormError('')
    setNotice('')
  }

  return (
    <div className="xelay-dialog-backdrop fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-3 py-5 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !mutation.current) latestClose.current() }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={explanationId} tabIndex={-1} className="xelay-dialog-panel flex max-h-[90dvh] w-full min-w-0 max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl outline-none" onKeyDown={(event) => {
        if (event.key === 'Escape' && !mutation.current) { event.preventDefault(); event.stopPropagation(); latestClose.current() }
        if (event.key !== 'Tab') return
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []).filter((element) => element.offsetParent !== null)
        const first = elements[0]; const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); return }
        if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
        if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
      }}>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-lg font-semibold"><Pin size={18} className="shrink-0 text-primary" aria-hidden="true" />Довгострокові завдання</h2>
          <button type="button" disabled={Boolean(busy)} onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40 motion-reduce:transition-none" aria-label="Закрити вікно"><X size={19} aria-hidden="true" /></button>
        </header>
        <div className="min-w-0 space-y-4 overflow-y-auto p-5">
          <p id={explanationId} className="text-sm leading-relaxed text-muted-foreground">Додайте завдання один раз: воно з’явиться під домашнім завданням на кожному семінарі цього предмета. Після кінцевої дати завдання залишиться видимим із позначкою «Строк минув». Закриті завдання зберігаються в архіві.</p>
          {!canEdit && <p role="status" className="rounded-xl bg-muted px-3 py-2.5 text-sm text-muted-foreground">Керувати завданнями може староста або погоджений заступник із дозволом на домашні завдання.</p>}
          <Field label="Предмет">
            <select value={choices.find((value) => normalizeLongTermSubject(value) === normalizeLongTermSubject(subject)) || ''} disabled={Boolean(busy) || !choices.length} onChange={(event) => changeSubject(event.target.value)} className={inputClass}>
              {!choices.length && <option value="">Спочатку додайте предмет до розкладу або семінарів</option>}
              {choices.map((value) => <option key={normalizeLongTermSubject(value)} value={value}>{value}</option>)}
            </select>
          </Field>
          {error && <div role="alert" className="rounded-xl border border-border px-3 py-2.5 text-sm text-muted-foreground">{error}<button type="button" disabled={Boolean(busy) || loading} onClick={() => { void onReload() }} className={`${smallButton} ml-1`}>Оновити</button></div>}
          {formError && <p role="alert" className="whitespace-pre-wrap break-words rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{formError}</p>}
          {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
          {editor && canEdit ? (
            <form onSubmit={save} className="space-y-3 rounded-xl border border-primary/20 bg-primary/[0.03] p-4">
              <h3 className="text-sm font-semibold">{editor.id ? 'Редагувати завдання' : 'Нове завдання'}</h3>
              <Field label="Предмет завдання"><select required value={choices.find((value) => normalizeLongTermSubject(value) === normalizeLongTermSubject(editor.subject)) || ''} disabled={Boolean(busy)} onChange={(event) => setEditor((previous) => previous && ({ ...previous, subject: event.target.value }))} className={inputClass}>{choices.map((value) => <option key={normalizeLongTermSubject(value)} value={value}>{value}</option>)}</select></Field>
              <Field label="Назва завдання"><input ref={editorTitle} required maxLength={240} value={editor.title} disabled={Boolean(busy)} onChange={(event) => setEditor((previous) => previous && ({ ...previous, title: event.target.value }))} className={inputClass} placeholder="Наприклад, підготувати курсову роботу" /></Field>
              <Field label="Опис"><textarea rows={4} maxLength={10000} value={editor.description} disabled={Boolean(busy)} onChange={(event) => setEditor((previous) => previous && ({ ...previous, description: event.target.value }))} className={`${inputClass} resize-y`} placeholder="Що потрібно підготувати та які вимоги врахувати" /></Field>
              <Field label="Кінцева дата"><input type="date" required min="1900-01-01" max="2200-12-31" value={editor.dueDate} disabled={Boolean(busy)} onChange={(event) => setEditor((previous) => previous && ({ ...previous, dueDate: event.target.value }))} className={inputClass} /></Field>
              <p className="text-xs text-muted-foreground">Кінцева дата включно, за часом Києва.</p>
              <div className="flex flex-wrap items-center gap-2"><button type="submit" disabled={Boolean(busy)} className={primaryButton}>{busy === 'save' && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}Зберегти</button><button type="button" disabled={Boolean(busy)} onClick={() => { setEditor(null); setFormError('') }} className={secondaryButton}>Скасувати</button></div>
            </form>
          ) : canEdit && <button type="button" disabled={Boolean(busy) || loading || Boolean(error) || !subject} onClick={() => { setEditor({ id: null, subject, title: '', description: '', dueDate: '' }); setFormError(''); setNotice('') }} className={secondaryButton}><Plus size={16} aria-hidden="true" />Додати завдання</button>}
          <section className="min-w-0 space-y-2" aria-label="Активні довгострокові завдання">
            <h3 className="text-sm font-semibold">Активні завдання{activeTasks.length > 0 && <span className="ml-1 text-muted-foreground">· {activeTasks.length}</span>}</h3>
            {loading && !activeTasks.length ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Завантажуємо завдання…</p>
              : !activeTasks.length ? <p className="text-sm text-muted-foreground">Для цього предмета активних завдань поки немає.</p>
              : activeTasks.map((task) => <TaskRow key={task.id} task={task} today={today}>{canEdit && <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border pt-1.5"><button type="button" disabled={Boolean(busy)} onClick={() => edit(task)} className={smallButton} aria-label={`Редагувати завдання: ${task.title}`}><Pencil size={13} aria-hidden="true" />Редагувати</button><button type="button" disabled={Boolean(busy)} onClick={() => { void runMutation(`close:${task.id}`, () => setStudyGroupLongTermTaskClosed(groupId, task.id, true), 'Завдання закрито й перенесено в архів.', () => { if (editor?.id === task.id) setEditor(null) }) }} className={smallButton} aria-label={`Закрити для всіх завдання: ${task.title}`}>{busy === `close:${task.id}` ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}Закрити для всіх</button></div>}</TaskRow>)}
          </section>
          <section className="min-w-0 border-t border-border pt-3">
            <button type="button" onClick={() => setShowArchive((value) => !value)} aria-expanded={showArchive} aria-controls={archiveId} className="inline-flex min-h-9 items-center gap-2 rounded-lg text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"><Archive size={15} aria-hidden="true" />Архів · {archivedTasks.length}{showArchive ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</button>
            <div id={archiveId} hidden={!showArchive} className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">Закриті завдання приховані на семінарах. Їх можна знову відкрити для всієї групи.</p>
              {!archivedTasks.length ? <p className="text-sm text-muted-foreground">Архів цього предмета порожній.</p> : archivedTasks.map((task) => <TaskRow key={task.id} task={task} today={today}>{canEdit && <div className="mt-2 border-t border-border pt-1.5"><button type="button" disabled={Boolean(busy)} onClick={() => { void runMutation(`reopen:${task.id}`, () => setStudyGroupLongTermTaskClosed(groupId, task.id, false), 'Завдання знову відкрите на всіх семінарах предмета.') }} className={smallButton} aria-label={`Знову відкрити для всіх завдання: ${task.title}`}>{busy === `reopen:${task.id}` ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}Відкрити знову</button></div>}</TaskRow>)}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
