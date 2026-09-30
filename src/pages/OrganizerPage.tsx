import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight, CalendarDays, Check, CheckCircle2, Circle, Crown, Download,
  ListTodo, Loader2, Pencil, Plus, RefreshCw, Trash2, X,
} from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseTable } from '../lib/databaseCompatibility'
import { dayKey, dueLabel, fromDateTimeInput, toDateTimeInput } from '../lib/organizerDates'
import './premium.css'

interface OrganizerTask {
  id: string
  user_id: string
  title: string
  notes: string
  due_at: string | null
  completed: boolean
  created_at: string
  updated_at: string
}

type TaskFilter = 'today' | 'upcoming' | 'all' | 'done'
type TaskDraft = { title: string; notes: string; dueLocal: string }

const EMPTY_DRAFT: TaskDraft = { title: '', notes: '', dueLocal: '' }
const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'Усі завдання' }, { key: 'today', label: 'Сьогодні' },
  { key: 'upcoming', label: 'Майбутні' }, { key: 'done', label: 'Виконані' },
]

// Quoting alone does not prevent formulas from running when a CSV is opened.
const csvCell = (value: string) => {
  const safe = /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function OrganizerPage() {
  const navigate = useNavigate()
  const { authUser, isLoading: authLoading } = useAuth()
  const { isPremium, isLoading: billingLoading, error: billingError } = useBilling()
  const ownerRef = useRef(authUser?.id)
  ownerRef.current = authUser?.id
  const [showAuth, setShowAuth] = useState(false)
  const [taskData, setTasks] = useState<OrganizerTask[]>([])
  const [taskOwnerId, setTaskOwnerId] = useState(authUser?.id)
  const ownsTasks = taskOwnerId === authUser?.id
  const tasks = ownsTasks ? taskData : []
  const canEdit = ownsTasks && isPremium && !billingLoading && !billingError
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const ownerEpoch = useRef(0)
  const loadSequence = useRef(0)
  const mutationLock = useRef(false)
  const mutating = saving || busyTask !== null

  const isCurrentOwner = (ownerId: string, epoch: number) => ownerRef.current === ownerId && ownerEpoch.current === epoch

  const loadTasks = useCallback(async () => {
    const ownerId = authUser?.id
    if (!ownerId) { setTasks([]); setLoading(false); return }
    if (mutationLock.current) return
    const epoch = ownerEpoch.current
    const sequence = ++loadSequence.current
    const isCurrent = () => ownerRef.current === ownerId && ownerEpoch.current === epoch && sequence === loadSequence.current
    setLoading(true)
    setError('')
    try {
      const { data, error: loadError } = await supabase.from('organizer_tasks')
        .select('id, user_id, title, notes, due_at, completed, created_at, updated_at')
        .eq('user_id', ownerId).order('created_at', { ascending: false }).limit(1000)
      if (!isCurrent()) return
      if (loadError) throw loadError
      setTasks((data || []) as OrganizerTask[])
    } catch (loadError) {
      if (isCurrent()) setError(isMissingDatabaseTable(loadError as { code?: string })
        ? 'Органайзер ще готується до запуску. Спробуйте пізніше.'
        : 'Не вдалося завантажити органайзер. Спробуйте ще раз трохи пізніше.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [authUser?.id])

  useEffect(() => {
    ++ownerEpoch.current
    ++loadSequence.current
    mutationLock.current = false
    setTaskOwnerId(authUser?.id)
    setTasks([])
    setError('')
    setSaving(false)
    setBusyTask(null)
    setExporting(false)
    setEditorOpen(false)
    setEditingId(null)
    setConfirmDelete(null)
    setDraft(EMPTY_DRAFT)
    void loadTasks()
    return () => { ++ownerEpoch.current; ++loadSequence.current }
  }, [loadTasks])

  useEffect(() => {
    if (!canEdit) { setEditorOpen(false); setEditingId(null); setDraft(EMPTY_DRAFT) }
  }, [canEdit])

  const today = dayKey(new Date())
  const counts = useMemo(() => ({
    unfinished: tasks.filter((task) => !task.completed).length,
    today: tasks.filter((task) => !task.completed && task.due_at && dayKey(new Date(task.due_at)) === today).length,
    done: tasks.filter((task) => task.completed).length,
  }), [tasks, today])

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    if (filter === 'done') return task.completed
    if (filter === 'today') return !task.completed && Boolean(task.due_at) && dayKey(new Date(task.due_at!)) === today
    if (filter === 'upcoming') return !task.completed && Boolean(task.due_at) && dayKey(new Date(task.due_at!)) > today
    return true
  }).sort((left, right) => {
    if (left.completed !== right.completed) return Number(left.completed) - Number(right.completed)
    if (left.due_at && right.due_at) return new Date(left.due_at).getTime() - new Date(right.due_at).getTime()
    if (left.due_at || right.due_at) return left.due_at ? -1 : 1
    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  }), [tasks, filter, today])

  const openEditor = (task?: OrganizerTask) => {
    if (!canEdit || mutationLock.current || exporting || loading) return
    setError('')
    setEditingId(task?.id || null)
    setDraft(task ? { title: task.title, notes: task.notes || '', dueLocal: toDateTimeInput(task.due_at) } : EMPTY_DRAFT)
    setEditorOpen(true)
  }

  const closeEditor = () => {
    if (saving) return
    setEditorOpen(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
  }

  const saveTask = async (event: FormEvent) => {
    event.preventDefault()
    const ownerId = authUser?.id
    if (!ownerId || !canEdit || mutationLock.current || exporting) return
    const title = draft.title.trim()
    if (!title || title.length > 200) { setError('Назва має містити від 1 до 200 символів.'); return }
    if (draft.notes.trim().length > 10000) { setError('Нотатки мають містити не більше 10 000 символів.'); return }
    const due = draft.dueLocal ? fromDateTimeInput(draft.dueLocal) : null
    if (due && Number.isNaN(due.getTime())) { setError('Оберіть коректну дату дедлайну.'); return }
    const epoch = ownerEpoch.current
    mutationLock.current = true
    ++loadSequence.current
    setLoading(false)
    setSaving(true)
    setError('')
    const payload = { title, notes: draft.notes.trim(), due_at: due?.toISOString() || null, updated_at: new Date().toISOString() }
    try {
      const result = editingId
        ? await supabase.from('organizer_tasks').update(payload).eq('id', editingId).eq('user_id', ownerId).select().single()
        : await supabase.from('organizer_tasks').insert({ ...payload, user_id: ownerId, completed: false }).select().single()
      if (!isCurrentOwner(ownerId, epoch)) return
      if (result.error) throw result.error
      const updated = result.data as OrganizerTask
      setTasks((current) => editingId ? current.map((task) => task.id === updated.id ? updated : task) : [updated, ...current])
      setEditorOpen(false)
      setEditingId(null)
      setDraft(EMPTY_DRAFT)
    } catch {
      if (isCurrentOwner(ownerId, epoch)) setError('Не вдалося зберегти завдання. Перевірте доступ до підписки та спробуйте ще раз.')
    } finally {
      if (isCurrentOwner(ownerId, epoch)) { mutationLock.current = false; setSaving(false) }
    }
  }

  const toggleComplete = async (task: OrganizerTask) => {
    const ownerId = authUser?.id
    if (!ownerId || !canEdit || mutationLock.current || exporting) return
    const epoch = ownerEpoch.current
    mutationLock.current = true
    ++loadSequence.current
    setLoading(false)
    setBusyTask(task.id)
    setError('')
    try {
      const { data, error: updateError } = await supabase.from('organizer_tasks')
        .update({ completed: !task.completed, updated_at: new Date().toISOString() }).eq('id', task.id).eq('user_id', ownerId).select().single()
      if (!isCurrentOwner(ownerId, epoch)) return
      if (updateError) throw updateError
      setTasks((current) => current.map((item) => item.id === task.id ? data as OrganizerTask : item))
    } catch {
      if (isCurrentOwner(ownerId, epoch)) setError('Не вдалося змінити статус завдання. Спробуйте ще раз.')
    } finally {
      if (isCurrentOwner(ownerId, epoch)) { mutationLock.current = false; setBusyTask(null) }
    }
  }

  const deleteTask = async (taskId: string) => {
    const ownerId = authUser?.id
    if (!ownerId || !ownsTasks || mutationLock.current || exporting) return
    const epoch = ownerEpoch.current
    mutationLock.current = true
    ++loadSequence.current
    setLoading(false)
    setBusyTask(taskId)
    setError('')
    try {
      const { error: deleteError } = await supabase.from('organizer_tasks').delete().eq('id', taskId).eq('user_id', ownerId).select('id').single()
      if (!isCurrentOwner(ownerId, epoch)) return
      if (deleteError) throw deleteError
      setTasks((current) => current.filter((task) => task.id !== taskId))
      setConfirmDelete(null)
      if (editingId === taskId) closeEditor()
    } catch {
      if (isCurrentOwner(ownerId, epoch)) setError('Не вдалося видалити завдання. Спробуйте ще раз.')
    } finally {
      if (isCurrentOwner(ownerId, epoch)) { mutationLock.current = false; setBusyTask(null) }
    }
  }

  const exportTasks = async () => {
    const ownerId = authUser?.id
    if (!ownerId || !ownsTasks || exporting || mutationLock.current) return
    const epoch = ownerEpoch.current
    setExporting(true)
    setError('')
    try {
      const allTasks: OrganizerTask[] = []
      let offset = 0
      // Export every task, including ones outside the current screen's limit.
      while (true) {
        const { data, error: exportError } = await supabase.from('organizer_tasks')
          .select('id, user_id, title, notes, due_at, completed, created_at, updated_at')
          .eq('user_id', ownerId).order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(offset, offset + 499)
        if (!isCurrentOwner(ownerId, epoch)) return
        if (exportError) throw exportError
        allTasks.push(...(data || []) as OrganizerTask[])
        if (!data || data.length < 500) break
        offset += 500
      }
      const rows = [
        ['Завдання', 'Нотатки', 'Дедлайн', 'Статус', 'Створено'],
        ...allTasks.map((task) => [task.title, task.notes || '', task.due_at ? dueLabel(task.due_at) : '', task.completed ? 'Виконано' : 'У планах', dueLabel(task.created_at)]),
      ]
      const content = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n')
      const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `xelay-zavdannia-${today}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      if (isCurrentOwner(ownerId, epoch)) setError('Не вдалося експортувати завдання. Спробуйте ще раз.')
    } finally {
      if (isCurrentOwner(ownerId, epoch)) setExporting(false)
    }
  }

  return (
    <main className="min-h-[80vh] bg-background">
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="xelay-premium-reveal mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div><span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary"><Crown size={13} />Ваш особистий простір</span><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Органайзер</h1><p className="mt-2 text-sm text-muted-foreground">Менше тримати в голові. Більше встигати у своєму ритмі.</p></div>
          {canEdit && <button type="button" disabled={loading || mutating || exporting} onClick={() => openEditor()} className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white"><Plus size={18} />Додати завдання</button>}
        </header>

        {!authLoading && !authUser && <div className="xelay-premium-surface rounded-3xl border border-primary/15 p-7 text-center sm:p-10"><CalendarDays size={35} className="mx-auto mb-4 text-primary" /><h2 className="text-xl font-bold">Місце для ваших планів</h2><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">Увійдіть до Xelay, щоб відкрити особистий органайзер. Створення завдань доступне з підпискою «Учасник».</p><button type="button" onClick={() => setShowAuth(true)} className="mt-6 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-white">Увійти до акаунта</button></div>}

        {authUser && !billingLoading && !isPremium && <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-primary/15 bg-primary/5 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><Crown size={21} className="mt-0.5 shrink-0 text-primary" /><div><p className="text-sm font-semibold">Органайзер у підписці «Учасник»</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">100 грн на місяць. Збережені завдання можна переглядати й видаляти після завершення підписки.</p></div></div><button type="button" onClick={() => navigate({ to: '/subscription' })} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-white">Переглянути підписку <ArrowRight size={15} /></button></div>}

        {authUser && <>
          <section aria-label="Огляд завдань" className="mb-6 grid grid-cols-3 gap-2 sm:gap-3">
            {[{ label: 'У планах', value: counts.unfinished, icon: ListTodo }, { label: 'На сьогодні', value: counts.today, icon: CalendarDays }, { label: 'Виконано', value: counts.done, icon: CheckCircle2 }].map(({ label, value, icon: Icon }) => <div key={label} className="rounded-2xl border border-border bg-card p-3 sm:p-4"><Icon size={18} className="mb-2 text-primary" /><p className="text-xl font-bold sm:text-2xl">{loading ? '—' : value}</p><p className="mt-1 text-[11px] text-muted-foreground sm:text-xs">{label}</p></div>)}
          </section>

          {editorOpen && canEdit && <section className="xelay-premium-reveal mb-6 rounded-2xl border border-primary/20 bg-card p-5 sm:p-6" aria-labelledby="task-editor-title"><div className="mb-5 flex items-center justify-between gap-3"><h2 id="task-editor-title" className="font-bold">{editingId ? 'Редагувати завдання' : 'Нове завдання'}</h2><button type="button" disabled={saving} onClick={closeEditor} aria-label="Закрити форму" className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={18} /></button></div><form onSubmit={(event) => void saveTask(event)} className="space-y-4"><label className="block"><span className="mb-1.5 block text-sm font-medium">Що потрібно зробити?</span><input autoFocus disabled={mutating || exporting} required maxLength={200} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Наприклад, підготуватися до семінару" className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium">Дедлайн <span className="font-normal text-muted-foreground">· необов’язково, час Києва</span></span><input type="datetime-local" disabled={mutating || exporting} value={draft.dueLocal} onChange={(event) => setDraft((current) => ({ ...current, dueLocal: event.target.value }))} className="block min-w-0 w-full rounded-xl border border-border bg-background px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium">Нотатки <span className="font-normal text-muted-foreground">· необов’язково</span></span><textarea rows={4} disabled={mutating || exporting} maxLength={10000} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Деталі, матеріали або посилання" className="w-full resize-y rounded-xl border border-border bg-background px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10" /></label><div className="flex flex-wrap items-center gap-3"><button type="submit" disabled={mutating || exporting || !draft.title.trim()} className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}{saving ? 'Зберігаємо…' : 'Зберегти завдання'}</button><button type="button" disabled={saving} onClick={closeEditor} className="rounded-full px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted">Скасувати</button></div></form></section>}

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-1.5" role="group" aria-label="Фільтр завдань">{FILTERS.map(({ key, label }) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={`rounded-full px-3 py-2 text-xs font-semibold transition sm:px-4 sm:text-sm ${filter === key ? 'bg-primary text-white' : 'bg-muted/70 text-muted-foreground hover:bg-muted'}`}>{label}</button>)}</div><div className="flex items-center gap-1"><button type="button" disabled={exporting || loading || mutating || !tasks.length} onClick={() => void exportTasks()} className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-40" title="Завантажити всі завдання у CSV">{exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}{exporting ? 'Експортуємо…' : 'Експорт CSV'}</button><button type="button" disabled={loading || mutating || exporting} onClick={() => void loadTasks()} aria-label="Оновити завдання" className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button></div></div>

          {(error || billingError) && <p role="alert" className="mb-5 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error || billingError}</p>}

          {loading || authLoading ? <div className="py-12 text-center text-sm text-muted-foreground"><Loader2 size={24} className="mx-auto mb-3 animate-spin" />Завантажуємо ваші плани…</div> : filteredTasks.length ? <section aria-label="Ваші завдання" className="space-y-3">{filteredTasks.map((task) => <TaskCard key={task.id} task={task} canEdit={Boolean(canEdit)} disabled={mutating || exporting} busy={busyTask === task.id} confirmDelete={confirmDelete === task.id} onToggle={() => void toggleComplete(task)} onEdit={() => openEditor(task)} onAskDelete={() => setConfirmDelete(task.id)} onCancelDelete={() => setConfirmDelete(null)} onDelete={() => void deleteTask(task.id)} />)}</section> : !error && !billingError && <div className="rounded-3xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center"><span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/5 text-primary"><CalendarDays size={27} /></span><h2 className="font-semibold">{filter === 'done' ? 'Виконані завдання з’являться тут' : filter === 'today' ? 'На сьогодні все спокійно' : filter === 'upcoming' ? 'Майбутніх дедлайнів поки немає' : 'Залиште тут перший план'}</h2><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{filter === 'all' ? 'Додайте завдання, вкажіть дедлайн і збережіть потрібні деталі. Це ваш органайзер — його бачите лише ви.' : 'Оберіть «Усі завдання», щоб переглянути решту планів.'}</p>{canEdit && filter === 'all' && <button type="button" disabled={mutating || exporting} onClick={() => openEditor()} className="mt-5 inline-flex items-center gap-2 rounded-full border border-primary/20 px-4 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5"><Plus size={16} />Додати завдання</button>}</div>}
          <p className="mt-6 text-center text-xs text-muted-foreground">Особисті завдання доступні лише вам і не змінюють розклад вашої групи.</p>
          {tasks.length === 1000 && <p className="mt-2 text-center text-xs text-muted-foreground">Показано останні 1000 завдань. Експорт CSV містить усі ваші завдання.</p>}
        </>}
      </div>
    </main>
  )
}

function TaskCard({ task, canEdit, disabled, busy, confirmDelete, onToggle, onEdit, onAskDelete, onCancelDelete, onDelete }: {
  task: OrganizerTask; canEdit: boolean; disabled: boolean; busy: boolean; confirmDelete: boolean;
  onToggle: () => void; onEdit: () => void; onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void;
}) {
  const overdue = !task.completed && task.due_at && new Date(task.due_at).getTime() < Date.now()
  return <article className={`xelay-premium-reveal rounded-2xl border bg-card p-4 transition-colors sm:p-5 ${task.completed ? 'border-border bg-muted/20' : 'border-border hover:border-primary/20'}`}><div className="flex items-start gap-3"><button type="button" disabled={!canEdit || disabled} onClick={onToggle} aria-label={task.completed ? `Повернути завдання «${task.title}» у плани` : `Позначити завдання «${task.title}» виконаним`} className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full disabled:cursor-default ${task.completed ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}>{busy ? <Loader2 size={19} className="animate-spin" /> : task.completed ? <CheckCircle2 size={23} /> : <Circle size={23} />}</button><div className="min-w-0 flex-1"><h3 className={`break-words text-sm font-semibold sm:text-base ${task.completed ? 'text-muted-foreground line-through' : ''}`}>{task.title}</h3>{task.due_at && <p className={`mt-2 flex flex-wrap items-center gap-1.5 text-xs ${overdue ? 'text-primary' : 'text-muted-foreground'}`}><CalendarDays size={13} />{dueLabel(task.due_at)}{overdue && <span className="rounded-full bg-primary/5 px-2 py-0.5">Дедлайн минув</span>}</p>}{task.notes && <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-primary">Нотатки</summary><p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{task.notes}</p></details>}</div><div className="flex shrink-0 gap-1">{canEdit && <button type="button" disabled={disabled} onClick={onEdit} aria-label={`Редагувати завдання «${task.title}»`} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/5 hover:text-primary"><Pencil size={15} /></button>}<button type="button" disabled={disabled} onClick={onAskDelete} aria-label={`Видалити завдання «${task.title}»`} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/5 hover:text-destructive"><Trash2 size={15} /></button></div></div>{confirmDelete && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/5 p-3"><p className="text-xs text-destructive">Видалити це завдання назавжди?</p><div className="flex gap-2"><button type="button" disabled={disabled} onClick={onCancelDelete} className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium">Залишити</button><button type="button" disabled={disabled} onClick={onDelete} className="rounded-full bg-destructive px-3 py-1.5 text-xs font-semibold text-white">{busy ? 'Видаляємо…' : 'Видалити'}</button></div></div>}</article>
}
