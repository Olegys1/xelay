import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertCircle, Bell, CalendarDays, Check, CheckCircle2, Circle, Download, ExternalLink,
  ListTodo, Loader2, Pencil, Plus, RefreshCw, Repeat2, Search, Trash2, Users, X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { MiniGuide } from '../components/MiniGuide'
import { PushReminderSettings } from '../components/PushReminderSettings'
import { SharedOrganizer } from '../components/SharedOrganizer'
import { ORGANIZER_GUIDE } from '../lib/pageGuides'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import {
  ORGANIZER_SELECT, ORGANIZER_UPDATED_EVENT, announceOrganizerUpdate, loadOrganizerSubjects,
  organizerError, type OrganizerTask,
} from '../lib/organizer'
import {
  EMPTY_ORGANIZER_DRAFT, clearOrganizerDraft, readOrganizerDraft, saveOrganizerDraft, type OrganizerDraft,
} from '../lib/organizerDraft'
import { dateOnlyLabel, dayKey, dueLabel, fromDateTimeInput, nextDayKey, toDateTimeInput, validDayKey } from '../lib/organizerDates'
import './premium.css'

type TaskFilter = 'all' | 'pending' | 'today' | 'upcoming' | 'overdue' | 'undated' | 'done'
const PAGE_SIZE = 50
const REMINDER_OFFSETS = [{ value: 15, label: 'За 15 хв' }, { value: 60, label: 'За годину' }, { value: 180, label: 'За 3 години' }, { value: 1440, label: 'За день' }, { value: 10080, label: 'За тиждень' }]
const RECURRENCE_LABELS = { none: 'Без повторення', daily: 'Щодня', weekly: 'Щотижня', monthly: 'Щомісяця' }
const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'Усі' }, { key: 'pending', label: 'У планах' }, { key: 'overdue', label: 'Прострочені' },
  { key: 'today', label: 'Сьогодні' }, { key: 'upcoming', label: 'Майбутні' },
  { key: 'undated', label: 'Без дати' }, { key: 'done', label: 'Виконані' },
]
const inputClass = 'block min-w-0 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10'
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50'
const primaryClass = buttonClass + ' border-primary bg-primary font-semibold text-white hover:bg-primary/90'
const hasDraft = (draft: OrganizerDraft) => Boolean(draft.title.trim() || draft.notes.trim() || draft.subject.trim() || draft.dueDate)
const csvCell = (value: string) => '"' + (/^[\s]*[=+\-@]/u.test(value) ? "'" + value : value).replace(/"/g, '""') + '"'
const ilikeValue = (value: string) => '"' + ('%' + value.replace(/[\\%_]/g, '\\$&') + '%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function taskDraft(task: OrganizerTask): OrganizerDraft {
  const timed = toDateTimeInput(task.due_at)
  const reminderCustom = toDateTimeInput(task.reminder_at)
  return {
    title: task.title, notes: task.notes || '', subject: task.subject || '',
    dueDate: task.due_date || timed.slice(0, 10), dueTime: timed.slice(11) || '18:00',
    timed: Boolean(task.due_at), reminder: task.reminder_at ? 'custom' : 'none', reminderCustom,
    reminderOffsets: task.reminder_offsets_minutes || [], recurrence: task.recurrence_rule || 'none',
    recurrenceUntil: task.recurrence_until || '',
  }
}
function taskSection(task: OrganizerTask, today: string, now: number) {
  if (task.completed) return 'Виконані'
  const date = task.due_date || (task.due_at ? dayKey(new Date(task.due_at)) : '')
  if (!date) return 'Без дати'
  if (task.due_date ? date < today : new Date(task.due_at!).getTime() < now) return 'Прострочені'
  return date === today ? 'Сьогодні' : 'Далі'
}
function sourceHref(task: OrganizerTask) {
  if (!task.source_kind || !task.source_id || !task.source_group_id || !task.source_date) return null
  const query = new URLSearchParams({
    tab: task.source_kind === 'seminar' ? 'seminars' : 'schedule',
    date: task.source_date, assignment: task.source_id, kind: task.source_kind,
  })
  return '/groups/' + encodeURIComponent(task.source_group_id) + '?' + query.toString()
}

export function OrganizerPage() {
  const navigate = useNavigate()
  const { notify } = useToast()
  const { authUser, isLoading: authLoading } = useAuth()
  const { isPremium, isLoading: billingLoading, error: billingError, refreshBilling } = useBilling()
  const ownerId = authUser?.id || null
  const ownerRef = useRef(ownerId)
  ownerRef.current = ownerId
  const ownerEpoch = useRef(0)
  const sequence = useRef(0)
  const mutationLock = useRef(false)
  const loadBusy = useRef(false)
  const loadPending = useRef(false)
  const accessRef = useRef(false)
  const authorized = Boolean(ownerId && !authLoading && !billingLoading && !billingError && isPremium)
  accessRef.current = authorized
  const [tasks, setTasks] = useState<OrganizerTask[]>([])
  const [taskOwner, setTaskOwner] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [query, setQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [subject, setSubject] = useState('')
  const [subjects, setSubjects] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ pending: 0, today: 0, overdue: 0, done: 0 })
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingVersion, setEditingVersion] = useState<string | null>(null)
  const [editConflict, setEditConflict] = useState(false)
  const [draft, setDraft] = useState<OrganizerDraft>(EMPTY_ORGANIZER_DRAFT)
  const [draftOwner, setDraftOwner] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const [view, setView] = useState<'personal' | 'shared'>('personal')
  const [sharedState, setSharedState] = useState({ busy: false, dirty: false })
  const visibleTasks = taskOwner === ownerId ? tasks : []
  const mutating = saving || busyTask !== null
  const today = dayKey(new Date(clock))
  const tomorrow = nextDayKey(today)
  const current = (owner: string, epoch: number) => ownerRef.current === owner && ownerEpoch.current === epoch

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(query.trim().slice(0, 100)), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!authLoading && (!ownerId || (!billingLoading && !billingError && !isPremium))) {
      void navigate({ to: '/subscription', replace: true })
    }
  }, [authLoading, ownerId, billingLoading, billingError, isPremium, navigate])
  useEffect(() => {
    ++ownerEpoch.current
    ++sequence.current
    mutationLock.current = false
    loadBusy.current = false; loadPending.current = false
    setTaskOwner(ownerId); setTasks([]); setCounts({ pending: 0, today: 0, overdue: 0, done: 0 })
    setTotal(0); setSubjects([]); setSubject(''); setQuery(''); setSearchTerm(''); setFilter('all')
    setError(''); setSaving(false); setBusyTask(null); setExporting(false); setConfirmDelete(null)
    const stored = ownerId ? readOrganizerDraft(ownerId) : null
    setDraft(stored?.draft || EMPTY_ORGANIZER_DRAFT); setEditingId(stored?.editingId || null)
    setEditingVersion(stored?.editingVersion || null); setEditConflict(false); setDraftOwner(ownerId); setEditorOpen(Boolean(stored))
    return () => { ++ownerEpoch.current; ++sequence.current }
  }, [ownerId])
  useEffect(() => {
    if (ownerId && draftOwner === ownerId) saveOrganizerDraft(ownerId, draft, editingId, editingVersion)
  }, [ownerId, draftOwner, draft, editingId, editingVersion])
  useEffect(() => {
    if (!ownerId || !editorOpen || !hasDraft(draft)) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [ownerId, editorOpen, draft])

  const loadTasks = useCallback(async (append = false, quiet = false) => {
    const owner = ownerId
    if (!owner || !accessRef.current || view !== 'personal') return
    if (mutationLock.current) { loadPending.current = true; return }
    if (quiet && loadBusy.current) return
    const epoch = ownerEpoch.current
    const token = ++sequence.current
    loadBusy.current = true
    loadPending.current = false
    const isCurrent = () => current(owner, epoch) && token === sequence.current && accessRef.current
    if (quiet || append) setRefreshing(true)
    else setLoading(true)
    setError('')
    const now = new Date().toISOString()
    const start = fromDateTimeInput(today + 'T00:00').toISOString()
    const end = fromDateTimeInput(nextDayKey(today) + 'T00:00').toISOString()
    const todayFilter = 'due_date.eq.' + today + ',and(due_at.gte.' + start + ',due_at.lt.' + end + ')'
    const overdueFilter = 'due_date.lt.' + today + ',due_at.lt.' + now
    try {
      let request = supabase.from('organizer_tasks').select(ORGANIZER_SELECT, { count: 'exact' }).eq('user_id', owner)
      if (filter === 'done') request = request.eq('completed', true)
      else if (filter !== 'all') {
        request = request.eq('completed', false)
        if (filter === 'today') request = request.or(todayFilter)
        if (filter === 'overdue') request = request.or(overdueFilter)
        if (filter === 'upcoming') request = request.or('due_date.gt.' + today + ',due_at.gte.' + end)
        if (filter === 'undated') request = request.is('due_at', null).is('due_date', null)
      }
      if (subject) request = request.eq('subject', subject)
      if (searchTerm) {
        const pattern = ilikeValue(searchTerm)
        request = request.or('title.ilike.' + pattern + ',notes.ilike.' + pattern + ',subject.ilike.' + pattern)
      }
      const offset = append ? visibleTasks.length : 0
      const targetLength = !append && quiet ? Math.max(PAGE_SIZE, visibleTasks.length) : PAGE_SIZE
      request = request.order('completed').order('due_sort_at', { nullsFirst: false })
        .order('created_at', { ascending: false }).order('id').range(offset, offset + Math.min(targetLength, 500) - 1)
      const results = await Promise.all([
        request,
        supabase.from('organizer_tasks').select('id', { count: 'exact', head: true }).eq('user_id', owner).eq('completed', false),
        supabase.from('organizer_tasks').select('id', { count: 'exact', head: true }).eq('user_id', owner).eq('completed', false).or(todayFilter),
        supabase.from('organizer_tasks').select('id', { count: 'exact', head: true }).eq('user_id', owner).eq('completed', false).or(overdueFilter),
        supabase.from('organizer_tasks').select('id', { count: 'exact', head: true }).eq('user_id', owner).eq('completed', true),
        loadOrganizerSubjects(owner),
      ])
      if (!isCurrent()) return
      for (const result of results.slice(0, 5)) {
        if ('error' in result && result.error) throw result.error
      }
      const list = results[0]
      const rows = (list.data || []) as unknown as OrganizerTask[]
      // Preserve expanded pages during a quiet refresh, paging through the
      // database response cap instead of truncating the open list.
      if (!append) for (let next = 500; next < targetLength && next < (list.count || 0); next += 500) {
        const page = await request.range(next, Math.min(next + 499, targetLength - 1))
        if (!isCurrent()) return
        if (page.error) throw page.error
        rows.push(...((page.data || []) as unknown as OrganizerTask[]))
      }
      setTaskOwner(owner)
      setTasks((previous) => append ? [...previous, ...rows.filter((row) => !previous.some((old) => old.id === row.id))] : rows)
      setTotal(list.count || 0)
      setCounts({ pending: results[1].count || 0, today: results[2].count || 0, overdue: results[3].count || 0, done: results[4].count || 0 })
      setSubjects(results[5])
    } catch (failure) {
      if (isCurrent()) setError(organizerError(failure))
    } finally {
      if (current(owner, epoch) && token === sequence.current) { loadBusy.current = false; setLoading(false); setRefreshing(false) }
    }
  }, [ownerId, filter, subject, searchTerm, today, visibleTasks.length, view])
  const loadRef = useRef(loadTasks)
  loadRef.current = loadTasks
  // Changes in page length do not trigger another fetch; only actual filters do.
  useEffect(() => {
    ++sequence.current
    loadBusy.current = false
    if (authorized && view === 'personal') { setLoading(true); void loadRef.current() }
    else { ++sequence.current; loadBusy.current = false; setLoading(false); setRefreshing(false) }
  }, [authorized, ownerId, filter, subject, searchTerm, today, view])
  useEffect(() => {
    if (!authorized || view !== 'personal') return
    const refresh = () => {
      if (document.visibilityState === 'visible' && !mutationLock.current) void loadRef.current(false, true)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener(ORGANIZER_UPDATED_EVENT, refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => {
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener(ORGANIZER_UPDATED_EVENT, refresh); window.clearInterval(timer)
    }
  }, [authorized, view])

  const clearDraft = () => {
    if (saving) return
    if (ownerId) clearOrganizerDraft(ownerId)
    setDraft(EMPTY_ORGANIZER_DRAFT); setEditingId(null); setEditingVersion(null); setEditConflict(false); setEditorOpen(false)
  }
  const openEditor = (task?: OrganizerTask) => {
    if (!authorized || mutationLock.current || exporting) return
    if (task && hasDraft(draft) && editingId === task.id) { setEditorOpen(true); return }
    if (task && hasDraft(draft) && editingId !== task.id) {
      setEditorOpen(true)
      notify({ tone: 'warning', title: 'У вас є незбережена чернетка', description: 'Збережіть її або натисніть «Очистити чернетку», щоб редагувати інше завдання.' })
      return
    }
    if (task) { setDraft(taskDraft(task)); setEditingId(task.id); setEditingVersion(task.updated_at); setEditConflict(false) }
    setEditorOpen(true); setError('')
  }
  const validationError = (message: string) => {
    setError(message)
    notify({ id: 'organizer-save', tone: 'warning', title: 'Перевірте завдання', description: message })
  }
  const saveTask = async (event: FormEvent) => {
    event.preventDefault()
    const owner = ownerId
    if (!owner || !authorized || mutationLock.current || exporting) return
    const title = draft.title.trim()
    if (!title || title.length > 200) return validationError('Вкажіть назву від 1 до 200 символів.')
    if (draft.subject.trim().length > 120) return validationError('Назва предмета має містити не більше 120 символів.')
    if (draft.notes.length > 10000) return validationError('Нотатки мають містити не більше 10 000 символів.')
    if (draft.dueDate && !validDayKey(draft.dueDate)) return validationError('Оберіть коректний день дедлайну.')
    const due = draft.dueDate && draft.timed ? fromDateTimeInput(draft.dueDate + 'T' + draft.dueTime) : null
    if (due && !Number.isFinite(due.getTime())) return validationError('Оберіть коректний час дедлайну за Києвом.')
    const previousTask = visibleTasks.find((task) => task.id === editingId)
    if (draft.recurrence !== 'none' && (!draft.dueDate || previousTask?.source_kind)) {
      return validationError('Повторювати можна особисте завдання з дедлайном. Домашка й семінари з групи мають власну дату.')
    }
    if (draft.recurrence !== 'none' && draft.recurrenceUntil && (!validDayKey(draft.recurrenceUntil) || draft.recurrenceUntil < draft.dueDate)) {
      return validationError('Завершення повторень має бути не раніше за перший дедлайн.')
    }
    if (draft.reminderOffsets.length) {
      if (!draft.dueDate) return validationError('Для нагадувань спочатку вкажіть дедлайн.')
      const base = due || fromDateTimeInput(draft.dueDate + 'T18:00')
      const unchanged = previousTask && (previousTask.due_at || null) === (due?.toISOString() || null)
        && (previousTask.due_date || '') === (draft.timed ? '' : draft.dueDate)
        && JSON.stringify([...(previousTask.reminder_offsets_minutes || [])].sort((a, b) => a - b)) === JSON.stringify([...draft.reminderOffsets].sort((a, b) => a - b))
      if (!unchanged && draft.reminderOffsets.some((offset) => base.getTime() - offset * 60_000 <= Date.now())) {
        return validationError('Одне з обраних нагадувань уже минуло. Приберіть його або перенесіть дедлайн.')
      }
    }
    let reminder: Date | null = null
    if (draft.reminder !== 'none') {
      if (!draft.dueDate) return validationError('Спочатку вкажіть дату дедлайну.')
      if (draft.reminder === 'custom') reminder = fromDateTimeInput(draft.reminderCustom)
      else {
        const base = due || fromDateTimeInput(draft.dueDate + 'T18:00')
        reminder = new Date(base.getTime() - (draft.reminder === 'day' ? 86_400_000 : 3_600_000))
      }
      if (!Number.isFinite(reminder.getTime())) return validationError('Оберіть коректну дату й час нагадування.')
      const previous = visibleTasks.find((task) => task.id === editingId)
      if (reminder.getTime() <= Date.now() && (!editingId || (previous && previous.reminder_at !== reminder.toISOString()))) {
        return validationError('Новий час нагадування має бути в майбутньому.')
      }
    }
    const epoch = ownerEpoch.current
    const savedId = editingId
    if (savedId && (!editingVersion || editConflict)) {
      setEditConflict(true)
      return validationError('Не можна перезаписати новіші зміни. Збережіть чернетку як окреме завдання або очистіть її та відкрийте актуальну версію.')
    }
    mutationLock.current = true; ++sequence.current; loadBusy.current = false
    setSaving(true); setLoading(false); setRefreshing(false); setError('')
    try {
      const payload = {
        title, notes: draft.notes.trim(), subject: draft.subject.trim(),
        due_at: due?.toISOString() || null, due_date: draft.dueDate && !draft.timed ? draft.dueDate : null,
        reminder_at: reminder?.toISOString() || null,
        reminder_offsets_minutes: draft.reminderOffsets,
        recurrence_rule: draft.recurrence, recurrence_until: draft.recurrence === 'none' ? null : draft.recurrenceUntil || null,
      }
      let result
      if (savedId) {
        let update = supabase.from('organizer_tasks').update(payload).eq('user_id', owner).eq('id', savedId)
        if (editingVersion) update = update.eq('updated_at', editingVersion)
        result = await update.select(ORGANIZER_SELECT).maybeSingle()
      } else result = await supabase.from('organizer_tasks').insert({ ...payload, user_id: owner, completed: false }).select(ORGANIZER_SELECT).single()
      if (!current(owner, epoch)) return
      if (result.error) throw result.error
      if (!result.data) {
        setEditConflict(true)
        validationError('Завдання вже змінилося на іншому пристрої або видалене. Чернетку збережено; оновіть список перед повторним редагуванням.')
        return
      }
      clearOrganizerDraft(owner)
      setDraft(EMPTY_ORGANIZER_DRAFT); setEditingId(null); setEditingVersion(null); setEditConflict(false); setEditorOpen(false)
      notify({ id: 'organizer-save', tone: 'success', title: savedId ? 'Завдання оновлено' : 'Завдання додано' })
      mutationLock.current = false; loadBusy.current = false
      announceOrganizerUpdate()
    } catch (failure) {
      if (current(owner, epoch)) {
        setError(organizerError(failure))
        notify({ id: 'organizer-save', tone: 'error', title: 'Завдання не збережено', description: 'Чернетка залишилася. Перевірте з’єднання та спробуйте ще раз.' })
      }
    } finally {
      if (current(owner, epoch)) {
        mutationLock.current = false; setSaving(false)
        if (loadPending.current) { loadBusy.current = false; void loadRef.current() }
      }
    }
  }
  const mutateTask = async (task: OrganizerTask, remove = false) => {
    const owner = ownerId
    if (!owner || !authorized || mutationLock.current || exporting) return
    const epoch = ownerEpoch.current
    mutationLock.current = true; ++sequence.current; loadBusy.current = false
    setBusyTask(task.id); setError(''); setLoading(false); setRefreshing(false)
    try {
      const result = remove
        ? await supabase.from('organizer_tasks').delete().eq('id', task.id).eq('user_id', owner).select('id').single()
        : await supabase.from('organizer_tasks').update({ completed: !task.completed }).eq('id', task.id).eq('user_id', owner)
          .eq('updated_at', task.updated_at).select('id').maybeSingle()
      if (!current(owner, epoch)) return
      if (result.error) throw result.error
      if (!result.data) throw new Error('ORGANIZER_CONFLICT')
      setConfirmDelete(null)
      if (remove && editingId === task.id) clearDraft()
      if (remove) notify({ id: 'organizer-delete', tone: 'success', title: 'Завдання видалено' })
      else if (!task.completed && task.recurrence_rule !== 'none') notify({ tone: 'success', title: 'Завдання виконано', description: 'Наступне повторення з’явиться у планах, якщо серія ще триває.' })
      mutationLock.current = false; loadBusy.current = false; announceOrganizerUpdate()
    } catch (failure) {
      if (current(owner, epoch)) {
        setError(organizerError(failure))
        notify({ tone: 'error', title: remove ? 'Не вдалося видалити завдання' : 'Статус не змінено', description: organizerError(failure) })
      }
    } finally {
      if (current(owner, epoch)) {
        mutationLock.current = false; setBusyTask(null)
        if (loadPending.current) { loadBusy.current = false; void loadRef.current() }
      }
    }
  }
  const exportTasks = async () => {
    const owner = ownerId
    if (!owner || !authorized || exporting || mutationLock.current) return
    const epoch = ownerEpoch.current
    setExporting(true)
    try {
      const all: OrganizerTask[] = []
      for (let offset = 0; ; offset += 500) {
        const result = await supabase.from('organizer_tasks').select(ORGANIZER_SELECT).eq('user_id', owner)
          .order('created_at').order('id').range(offset, offset + 499)
        if (!current(owner, epoch) || !accessRef.current) return
        if (result.error) throw result.error
        all.push(...((result.data || []) as unknown as OrganizerTask[]))
        if (!result.data || result.data.length < 500) break
      }
      const rows = [
        ['Завдання', 'Предмет', 'Нотатки', 'Дедлайн', 'Нагадування', 'Повторення', 'Повторювати до', 'Статус', 'Джерело'],
        ...all.map((task) => [task.title, task.subject || '', task.notes || '',
          task.due_date ? dateOnlyLabel(task.due_date) : task.due_at ? dueLabel(task.due_at) : '',
          [task.reminder_at ? dueLabel(task.reminder_at) : '', ...(task.reminder_offsets_minutes || []).map((offset) => REMINDER_OFFSETS.find((item) => item.value === offset)?.label || '')].filter(Boolean).join(', '),
          RECURRENCE_LABELS[task.recurrence_rule || 'none'], task.recurrence_until ? dateOnlyLabel(task.recurrence_until) : '',
          task.completed ? 'Виконано' : 'У планах', sourceHref(task) || '']),
      ]
      const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = 'xelay-zavdannia-' + today + '.csv'
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      notify({ tone: 'success', title: 'Усі завдання експортовано у CSV' })
    } catch (failure) {
      if (current(owner, epoch)) notify({ tone: 'error', title: 'Експорт не завершено', description: organizerError(failure) })
    } finally { if (current(owner, epoch)) setExporting(false) }
  }

  const groups = useMemo(() => {
    const result = new Map<string, OrganizerTask[]>()
    for (const task of visibleTasks) {
      const section = taskSection(task, today, clock)
      result.set(section, [...(result.get(section) || []), task])
    }
    return ['Прострочені', 'Сьогодні', 'Далі', 'Без дати', 'Виконані']
      .filter((section) => result.has(section)).map((section) => ({ section, tasks: result.get(section)! }))
  }, [visibleTasks, today, clock])

  if (!authorized) return <main className="flex min-h-[65vh] items-center justify-center px-4">
    {billingError && ownerId ? <div className="max-w-md space-y-4 rounded-2xl border border-border p-6 text-center">
      <AlertCircle className="mx-auto text-primary" size={28} />
      <h1 className="font-semibold">Не вдалося перевірити підписку</h1>
      <p className="text-sm text-muted-foreground">Перевірте з’єднання. Ваша чернетка збережена в цьому браузері.</p>
      <button type="button" className={primaryClass} onClick={() => void refreshBilling()}>Повторити перевірку</button>
    </div> : <div className="text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-3 animate-spin" size={24} />Перевіряємо доступ до органайзера…</div>}
  </main>

  return <main className="min-h-[80vh] bg-background">
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Органайзер</h1><p className="mt-1 text-sm text-muted-foreground">Ваші навчальні й особисті плани в одному місці.</p></div>
        {view === 'personal' && <button type="button" className={primaryClass} disabled={mutating || exporting} onClick={() => openEditor()}><Plus size={18} />Додати завдання</button>}
      </header>
      <MiniGuide userId={ownerId!} topic="organizer" label="Підказки для органайзера" steps={ORGANIZER_GUIDE} />
      <div role="tablist" aria-label="Тип органайзера" className="mb-5 flex gap-1 rounded-2xl border border-border bg-muted/40 p-1">
        {([{ key: 'personal', label: 'Особистий', Icon: ListTodo }, { key: 'shared', label: 'Спільний', Icon: Users }] as const).map(({ key, label, Icon }) => <button
          key={key} id={'organizer-tab-' + key} type="button" role="tab" aria-selected={view === key} aria-controls={'organizer-panel-' + key}
          disabled={mutating || exporting || sharedState.busy} onClick={() => {
            if (view === 'shared' && key !== view && sharedState.dirty) {
              notify({ tone: 'warning', title: 'Є незбережене спільне завдання', description: 'Збережіть його або закрийте форму перед переходом до особистих планів.' })
              return
            }
            setView(key)
          }}
          className={'inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ' + (view === key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:bg-card/60')}>
          <Icon size={17} />{label}
        </button>)}
      </div>
      {view === 'shared' ? <section id="organizer-panel-shared" role="tabpanel" aria-labelledby="organizer-tab-shared"><SharedOrganizer key={ownerId!} userId={ownerId!} onStateChange={setSharedState} /></section> : <section id="organizer-panel-personal" role="tabpanel" aria-labelledby="organizer-tab-personal">
      <details className="mb-5 rounded-2xl border border-border bg-card px-4 py-2.5"><summary className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm font-medium text-primary"><Bell size={16} />Налаштувати push-нагадування</summary><PushReminderSettings /></details>
      <section aria-label="Огляд завдань" className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([
          { key: 'pending', label: 'У планах', value: counts.pending, Icon: ListTodo },
          { key: 'today', label: 'Сьогодні', value: counts.today, Icon: CalendarDays },
          { key: 'overdue', label: 'Прострочені', value: counts.overdue, Icon: AlertCircle },
          { key: 'done', label: 'Виконані', value: counts.done, Icon: CheckCircle2 },
        ] as const).map(({ key, label, value, Icon }) => <button key={key} type="button" onClick={() => setFilter(key)}
          className="flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/30 sm:p-4">
          <Icon size={20} className="shrink-0 text-primary" /><span><span className="block text-lg font-bold">{loading ? '—' : value}</span><span className="text-xs text-muted-foreground">{label}</span></span>
        </button>)}
      </section>

      {hasDraft(draft) && !editorOpen && <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-primary/15 bg-primary/5 p-3">
        <p className="mr-auto text-sm">Є незбережена чернетка</p><button type="button" className={buttonClass} onClick={() => setEditorOpen(true)}>Продовжити</button><button type="button" className={buttonClass} onClick={clearDraft}>Очистити чернетку</button>
      </div>}
      {editorOpen && <section className="xelay-premium-reveal mb-6 rounded-2xl border border-primary/20 bg-card p-4 sm:p-6" aria-labelledby="task-editor-title">
        <div className="mb-4 flex items-center justify-between gap-3"><h2 id="task-editor-title" className="font-semibold">{editingId ? 'Редагувати завдання' : 'Нове завдання'}</h2>
          <button type="button" disabled={saving} onClick={() => setEditorOpen(false)} aria-label="Закрити форму та зберегти чернетку" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted"><X size={18} /></button>
        </div>
        <form noValidate onSubmit={(event) => void saveTask(event)} className="space-y-4">
          {editConflict && <div role="alert" className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
            <p>Завдання змінилося на іншому пристрої. Ваш текст збережено в чернетці.</p>
            <button type="button" disabled={mutating} className={buttonClass + ' mt-2'} onClick={() => { setEditingId(null); setEditingVersion(null); setEditConflict(false); setError('') }}>Зберегти як нове завдання</button>
          </div>}
          <label className="block"><span className="mb-1.5 block text-sm font-medium">Що потрібно зробити?</span><input autoFocus disabled={mutating || exporting} maxLength={200} value={draft.title} onChange={(event) => setDraft((old) => ({ ...old, title: event.target.value }))} placeholder="Підготуватися до семінару" className={inputClass} /></label>
          <label className="block"><span className="mb-1.5 block text-sm font-medium">Предмет або категорія</span><input list="organizer-subjects" disabled={mutating || exporting} maxLength={120} value={draft.subject} onChange={(event) => setDraft((old) => ({ ...old, subject: event.target.value }))} placeholder="Наприклад, Вища математика або Особисте" className={inputClass} /><datalist id="organizer-subjects">{subjects.map((item) => <option key={item} value={item} />)}</datalist></label>
          <div className="space-y-2"><p className="text-sm font-medium">Дедлайн <span className="font-normal text-muted-foreground">· необов’язково</span></p>
            <div className="flex flex-wrap gap-2">{[{ label: 'Сьогодні', date: today }, { label: 'Завтра', date: tomorrow }, { label: 'Без дати', date: '' }].map(({ label, date }) => <button key={label} type="button" className={buttonClass + ' text-xs'} disabled={mutating || exporting} onClick={() => setDraft((old) => ({ ...old, dueDate: date, reminder: date ? old.reminder : 'none', reminderOffsets: date ? old.reminderOffsets : [], recurrence: date ? old.recurrence : 'none', recurrenceUntil: date ? old.recurrenceUntil : '' }))}>{label}</button>)}</div>
            <div className="grid gap-3 sm:grid-cols-2"><label><span className="sr-only">Дата дедлайну</span><input type="date" className={inputClass} value={draft.dueDate} disabled={mutating || exporting} onChange={(event) => setDraft((old) => ({ ...old, dueDate: event.target.value, reminder: event.target.value ? old.reminder : 'none', reminderOffsets: event.target.value ? old.reminderOffsets : [], recurrence: event.target.value ? old.recurrence : 'none', recurrenceUntil: event.target.value ? old.recurrenceUntil : '' }))} /></label>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.timed} disabled={mutating || exporting || !draft.dueDate} onChange={(event) => setDraft((old) => ({ ...old, timed: event.target.checked }))} className="h-4 w-4 accent-primary" />Указати точний час за Києвом</label>
            </div>
            {draft.timed && draft.dueDate && <label className="block"><span className="sr-only">Час дедлайну за Києвом</span><input type="time" className={inputClass} value={draft.dueTime} disabled={mutating || exporting} onChange={(event) => setDraft((old) => ({ ...old, dueTime: event.target.value }))} /></label>}
          </div>
          <fieldset className="space-y-2"><legend className="mb-1.5 text-sm font-medium">Нагадування</legend>
            <div className="flex flex-wrap gap-2">{REMINDER_OFFSETS.map(({ value, label }) => <button key={value} type="button" aria-pressed={draft.reminderOffsets.includes(value)} disabled={mutating || exporting || !draft.dueDate} className={buttonClass + ' text-xs ' + (draft.reminderOffsets.includes(value) ? 'border-primary/30 bg-primary/5 text-primary' : '')} onClick={() => setDraft((old) => ({ ...old, reminderOffsets: old.reminderOffsets.includes(value) ? old.reminderOffsets.filter((offset) => offset !== value) : [...old.reminderOffsets, value] }))}><Bell size={13} />{label}{draft.reminderOffsets.includes(value) && <Check size={13} />}</button>)}</div>
            <p className="text-xs text-muted-foreground">Можна обрати кілька. Для дедлайну без часу нагадування відраховуються від 18:00 за Києвом.</p>
          </fieldset>
          <label className="block"><span className="mb-1.5 block text-sm font-medium">Додаткове нагадування</span><select className={inputClass} value={draft.reminder} disabled={mutating || exporting || !draft.dueDate} onChange={(event) => setDraft((old) => ({ ...old, reminder: event.target.value as OrganizerDraft['reminder'] }))}><option value="none">Без додаткового нагадування</option><option value="day">За день</option><option value="hour">За годину</option><option value="custom">Обрати час</option></select></label>
          {draft.reminder === 'custom' && <label className="block"><span className="mb-1.5 block text-sm font-medium">Коли нагадати · час Києва</span><input type="datetime-local" className={inputClass} value={draft.reminderCustom} disabled={mutating || exporting} onChange={(event) => setDraft((old) => ({ ...old, reminderCustom: event.target.value }))} /></label>}
          {(draft.reminder !== 'none' || draft.reminderOffsets.length > 0) && <p className="text-xs leading-relaxed text-muted-foreground">Нагадування з’являються у «Сповіщеннях». Якщо ввімкнені push-сповіщення на цьому пристрої, вони можуть надходити й коли сайт закрито. Потрібна активна підписка та увімкнені загальні сповіщення; дозвіл і доставку контролює браузер.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span className="mb-1.5 block text-sm font-medium">Повторення</span><select className={inputClass} value={draft.recurrence} disabled={mutating || exporting || !draft.dueDate || Boolean(visibleTasks.find((task) => task.id === editingId)?.source_kind)} onChange={(event) => setDraft((old) => ({ ...old, recurrence: event.target.value as OrganizerDraft['recurrence'] }))}>{Object.entries(RECURRENCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {draft.recurrence !== 'none' && <label><span className="mb-1.5 block text-sm font-medium">Повторювати до <span className="font-normal text-muted-foreground">· необов’язково</span></span><input type="date" min={draft.dueDate || undefined} className={inputClass} value={draft.recurrenceUntil} disabled={mutating || exporting} onChange={(event) => setDraft((old) => ({ ...old, recurrenceUntil: event.target.value }))} /></label>}
          </div>
          {draft.recurrence !== 'none' && <p className="text-xs leading-relaxed text-muted-foreground">Після позначки «Виконано» створиться наступне завдання за Київським календарем. Пропущені дати пропускаються. Щомісячні завдання зберігають початковий день місяця, а в короткому місяці використовують останній день.</p>}
          {Boolean(visibleTasks.find((task) => task.id === editingId)?.source_kind) && <p className="text-xs text-muted-foreground">Домашка й семінари з групи зберігають посилання на оригінал і не повторюються автоматично.</p>}
          <label className="block"><span className="mb-1.5 block text-sm font-medium">Нотатки</span><textarea rows={3} className={inputClass + ' resize-y'} maxLength={10000} value={draft.notes} disabled={mutating || exporting} onChange={(event) => setDraft((old) => ({ ...old, notes: event.target.value }))} placeholder="Деталі, матеріали або посилання" /></label>
          <div className="flex flex-wrap gap-2"><button type="submit" className={primaryClass} disabled={mutating || exporting}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}{saving ? 'Зберігаємо…' : 'Зберегти'}</button><button type="button" className={buttonClass} disabled={saving} onClick={() => setEditorOpen(false)}>Закрити</button>{hasDraft(draft) && <button type="button" className={buttonClass + ' ml-auto text-muted-foreground'} disabled={saving} onClick={clearDraft}>Очистити чернетку</button>}</div>
          <p className="text-xs text-muted-foreground">Чернетка зберігається в цій вкладці браузера до збереження або виходу з акаунта.</p>
        </form>
      </section>}
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_220px]">
        <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} /><input type="search" aria-label="Пошук завдань і нотаток" className={inputClass + ' pl-10'} placeholder="Знайти завдання або нотатку" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span className="sr-only">Фільтр за предметом</span><select className={inputClass} value={subject} onChange={(event) => setSubject(event.target.value)}><option value="">Усі предмети</option>{subjects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Фільтр завдань">{FILTERS.map(({ key, label }) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={'min-h-11 rounded-full px-3 text-xs font-semibold transition-colors ' + (filter === key ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}>{label}</button>)}</div>
        <div className="flex gap-1"><button type="button" className={buttonClass + ' border-transparent px-3 text-xs'} disabled={exporting || mutating || (!counts.pending && !counts.done)} onClick={() => void exportTasks()}>{exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}CSV</button><button type="button" className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50" aria-label="Оновити завдання" disabled={refreshing || loading || mutating || exporting} onClick={() => void loadRef.current(false, true)}><RefreshCw size={17} className={refreshing ? 'animate-spin' : ''} /></button></div>
      </div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {loading ? <div className="py-12 text-center text-sm text-muted-foreground"><Loader2 size={24} className="mx-auto mb-3 animate-spin" />Завантажуємо плани…</div> : groups.length ? <div className="space-y-5">
        {groups.map(({ section, tasks: items }) => <section key={section} aria-label={section}><h2 className="mb-2 text-sm font-semibold">{section}</h2><div className="space-y-2">{items.map((task) => <TaskCard key={task.id} task={task} now={clock} today={today} disabled={mutating || exporting} busy={busyTask === task.id} confirmDelete={confirmDelete === task.id} onToggle={() => void mutateTask(task)} onEdit={() => openEditor(task)} onAskDelete={() => setConfirmDelete(task.id)} onCancelDelete={() => setConfirmDelete(null)} onDelete={() => void mutateTask(task, true)} />)}</div></section>)}
      </div> : !error && <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center">
        <CalendarDays className="mx-auto mb-3 text-primary" size={28} /><h2 className="font-semibold">{searchTerm || subject ? 'За цими умовами завдань немає' : filter === 'overdue' ? 'Прострочених завдань немає' : filter === 'today' ? 'На сьогодні завдань немає' : filter === 'done' ? 'Виконані завдання з’являться тут' : filter === 'undated' ? 'Завдань без дати немає' : filter === 'upcoming' ? 'Майбутніх дедлайнів поки немає' : 'Додайте перший план'}</h2>
        {filter === 'today' && counts.overdue > 0 && <button type="button" className={buttonClass + ' mt-3'} onClick={() => setFilter('overdue')}>Є прострочені: {counts.overdue}</button>}
        {!searchTerm && !subject && filter === 'all' && <p className="mt-2 text-sm text-muted-foreground">Створіть завдання тут або додайте домашку чи семінар із навчальної групи.</p>}
      </div>}
      {visibleTasks.length < total && !loading && <button type="button" className={buttonClass + ' mt-5 w-full'} disabled={refreshing || mutating || exporting} onClick={() => void loadRef.current(true)}>{refreshing && <Loader2 className="animate-spin" size={16} />}Показати ще · {visibleTasks.length} із {total}</button>}
      <p className="mt-6 text-center text-xs text-muted-foreground">Ваші завдання приватні. Позначка «Виконано» не змінює домашку, семінари або розклад групи.</p>
      </section>}
    </div>
  </main>
}

function NoteLinks({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return <span key={index}>{part}</span>
    const match = part.match(/^(.*?)([),.!;]+)?$/)
    const href = match?.[1] || part
    try {
      const url = new URL(href)
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return <span key={index}>{part}</span>
      return <span key={index}><a href={url.toString()} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{href}</a>{match?.[2] || ''}</span>
    } catch { return <span key={index}>{part}</span> }
  })}</>
}
function TaskCard({ task, today, now, disabled, busy, confirmDelete, onToggle, onEdit, onAskDelete, onCancelDelete, onDelete }: {
  task: OrganizerTask; today: string; now: number; disabled: boolean; busy: boolean; confirmDelete: boolean;
  onToggle: () => void; onEdit: () => void; onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void;
}) {
  const overdue = taskSection(task, today, now) === 'Прострочені'
  const source = sourceHref(task)
  return <article className={'rounded-2xl border bg-card p-2.5 transition-colors sm:p-3 ' + (overdue ? 'border-primary/25' : 'border-border')}>
    <div className="flex items-start gap-1.5">
      <button type="button" disabled={disabled || Boolean(task.completed && task.recurrence_next_id)} title={task.completed && task.recurrence_next_id ? 'Наступне повторення вже створене' : undefined} onClick={onToggle} aria-label={task.completed ? 'Повернути у плани: ' + task.title : 'Позначити виконаним: ' + task.title} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/5 disabled:opacity-50">{busy ? <Loader2 size={20} className="animate-spin" /> : task.completed ? <CheckCircle2 size={22} /> : <Circle size={22} />}</button>
      <div className="min-w-0 flex-1 py-2">
        <h3 className={'break-words text-sm font-semibold [overflow-wrap:anywhere] ' + (task.completed ? 'text-muted-foreground line-through' : '')}>{task.title}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {task.subject && <span className="rounded-full bg-muted px-2 py-0.5">{task.subject}</span>}
          {(task.due_date || task.due_at) && <span className={'inline-flex items-center gap-1 ' + (overdue ? 'font-medium text-primary' : '')}><CalendarDays size={13} />{task.due_date ? dateOnlyLabel(task.due_date) : dueLabel(task.due_at!)}</span>}
          {task.reminder_at && !task.completed && <span className="inline-flex items-center gap-1" title={'Нагадати ' + dueLabel(task.reminder_at)}><Bell size={12} />{task.reminder_sent_at ? 'Нагадано' : dueLabel(task.reminder_at)}</span>}
          {task.reminder_offsets_minutes?.length > 0 && !task.completed && <span className="inline-flex items-center gap-1" title={task.reminder_offsets_minutes.map((offset) => REMINDER_OFFSETS.find((item) => item.value === offset)?.label || '').join(', ')}><Bell size={12} />Нагадувань: {task.reminder_offsets_minutes.length}</span>}
          {task.recurrence_rule && task.recurrence_rule !== 'none' && <span className="inline-flex items-center gap-1"><Repeat2 size={12} />{RECURRENCE_LABELS[task.recurrence_rule]}{task.recurrence_until && ' · до ' + dateOnlyLabel(task.recurrence_until)}</span>}
        </div>
        {source && <a href={source} className="mt-2 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary hover:underline"><ExternalLink size={12} />{task.source_kind === 'homework' ? 'Відкрити домашнє завдання' : 'Відкрити семінар'}</a>}
        {task.notes && <details className="mt-1"><summary className="inline-flex min-h-9 cursor-pointer items-center text-xs font-medium text-muted-foreground hover:text-primary">Нотатки</summary><p className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]"><NoteLinks text={task.notes} /></p></details>}
      </div>
      <div className="flex shrink-0 flex-col sm:flex-row">
        <button type="button" disabled={disabled} onClick={onEdit} aria-label={'Редагувати: ' + task.title} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"><Pencil size={15} /></button>
        <button type="button" disabled={disabled} onClick={onAskDelete} aria-label={'Видалити: ' + task.title} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"><Trash2 size={15} /></button>
      </div>
    </div>
    {confirmDelete && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/5 p-3"><p className="text-xs text-destructive">Видалити це завдання назавжди?</p><div className="flex gap-2"><button type="button" className={buttonClass + ' text-xs'} disabled={disabled} onClick={onCancelDelete}>Залишити</button><button type="button" className={buttonClass + ' border-destructive bg-destructive text-xs text-white hover:bg-destructive/90'} disabled={disabled} onClick={onDelete}>Видалити</button></div></div>}
  </article>
}
