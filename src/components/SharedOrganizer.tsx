import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, Archive, CalendarDays, Check, CheckCircle2, ChevronDown, Circle, ListTodo, Loader2, LogOut, Pencil, Plus, RefreshCw, Search, Trash2, UserPlus, Users, X } from 'lucide-react'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { dateOnlyLabel, dueLabel, fromDateTimeInput, toDateTimeInput, validDayKey } from '../lib/organizerDates'
import {
  archiveSharedOrganizer, cancelSharedOrganizerInvitation, createSharedOrganizer, deleteSharedOrganizerTask,
  inviteSharedOrganizer, isSharedOrganizerAccessError, loadSharedOrganizerOverview, loadSharedOrganizerWorkspace, removeSharedOrganizerMember,
  renameSharedOrganizer, respondSharedOrganizerInvitation, saveSharedOrganizerTask, sharedOrganizerError,
  SHARED_ORGANIZER_UPDATED_EVENT,
  type SharedOrganizerInvitation, type SharedOrganizerMember, type SharedOrganizerSnapshot,
  type SharedOrganizerTask, type SharedOrganizerWorkspace,
} from '../lib/sharedOrganizer'

const PAGE_SIZE = 100
const inputClass = 'block min-h-11 min-w-0 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10 disabled:opacity-50'
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryClass = buttonClass + ' border-primary bg-primary text-white hover:bg-primary/90'
const dangerClass = buttonClass + ' border-destructive/30 text-destructive hover:bg-destructive/5'
type TaskFilter = 'all' | 'pending' | 'done' | 'mine'
type Draft = { title: string; notes: string; subject: string; date: string; time: string; timed: boolean; assignee: string; completed: boolean }
type Editor = { userId: string; workspaceId: string; taskId: string | null; version: string | null; draft: Draft; initial: Draft; conflict: boolean; latest: SharedOrganizerTask | null; deleted: boolean }
type Confirmation = { kind: 'task' | 'member' | 'invitation'; id: string; version?: string } | { kind: 'archive' | 'leave' | 'discard' | 'reload' | 'switch'; id?: string; version?: string }
const emptyDraft = (): Draft => ({ title: '', notes: '', subject: '', date: '', time: '18:00', timed: false, assignee: '', completed: false })
const fromTask = (task: SharedOrganizerTask): Draft => {
  const timed = toDateTimeInput(task.due_at)
  return { title: task.title, notes: task.notes || '', subject: task.subject || '', date: task.due_date || timed.slice(0, 10), time: timed.slice(11) || '18:00', timed: Boolean(task.due_at), assignee: task.assignee_id || '', completed: task.completed }
}
const isDirty = (editor: Editor | null) => Boolean(editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.initial))
const failureText = (failure: unknown) => typeof failure === 'object' && failure !== null
  ? ['code', 'message', 'details', 'hint'].map((key) => String((failure as Record<string, unknown>)[key] || '')).join(' ') : String(failure)
const accessFailure = isSharedOrganizerAccessError
const conflictFailure = (failure: unknown) => /CONFLICT|VERSION|STALE/i.test(failureText(failure))
const personName = (member?: SharedOrganizerMember) => member?.full_name || (member?.username ? '@' + member.username : member ? 'Учасник' : 'Колишній учасник')

/** The parent gates this component by account and premium access; requests also pin both scopes. */
export function SharedOrganizer({ userId, onStateChange }: { userId: string; onStateChange?: (state: { busy: boolean; dirty: boolean }) => void }) {
  const { refreshBilling } = useBilling()
  const { notify } = useToast()
  const id = useId()
  const userRef = useRef(userId)
  userRef.current = userId
  const alive = useRef(true)
  const epoch = useRef(0)
  const overviewSequence = useRef(0)
  const detailSequence = useRef(0)
  const overviewBusy = useRef(false)
  const detailBusy = useRef(false)
  const mutationLock = useRef<number | null>(null)
  const mutationSequence = useRef(0)
  const accessRef = useRef(true)
  const selectedRef = useRef<string | null>(null)
  const snapshotRef = useRef<SharedOrganizerSnapshot | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const pagesRef = useRef(PAGE_SIZE)
  const [overview, setOverview] = useState<{ userId: string; workspaces: SharedOrganizerWorkspace[]; invitations: SharedOrganizerInvitation[] }>({ userId, workspaces: [], invitations: [] })
  const [selected, setSelected] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ userId: string; data: SharedOrganizerSnapshot } | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [accessLost, setAccessLost] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const confirmationRef = useRef<HTMLDivElement | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const renameVersion = useRef<string | null>(null)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [query, setQuery] = useState('')
  const accountCurrent = overview.userId === userId
  const workspaces = accountCurrent && !accessLost ? overview.workspaces : []
  const invitations = accountCurrent && !accessLost ? overview.invitations : []
  const data = !accessLost && snapshot?.userId === userId && snapshot.data.workspace.id === selected ? snapshot.data : null
  const currentEditor = !accessLost && editor?.userId === userId && editor.workspaceId === selected ? editor : null
  const owner = data?.workspace.owner_id === userId
  const disabled = Boolean(busy) || accessLost
  const own = useCallback((account: string, generation: number) => alive.current && userRef.current === account && epoch.current === generation, [])
  const updateEditor = useCallback((value: Editor | null) => { editorRef.current = value; setEditor(value) }, [])
  const patchDraft = (patch: Partial<Draft>) => {
    const current = editorRef.current
    if (!current || current.userId !== userRef.current || current.workspaceId !== selectedRef.current || mutationLock.current !== null) return
    updateEditor({ ...current, draft: { ...current.draft, ...patch } })
  }
  const selectWorkspace = useCallback((workspaceId: string | null) => {
    // Invalidate requests synchronously, before React commits the new selection.
    selectedRef.current = workspaceId
    ++detailSequence.current
    detailBusy.current = false
    snapshotRef.current = null
    pagesRef.current = PAGE_SIZE
    updateEditor(null)
    setSelected(workspaceId); setSnapshot(null); setConfirmation(null)
    setRenameOpen(false); setRenameName(''); renameVersion.current = null; setInviteName(''); setFilter('all'); setQuery('')
    setLoadingMore(false); setDetailLoading(Boolean(workspaceId)); setError('')
  }, [updateEditor])
  const reportFailure = useCallback((failure: unknown, title?: string) => {
    const message = sharedOrganizerError(failure)
    setError(message)
    if (title) notify({ id: 'shared-organizer-action', tone: 'error', title, description: message })
    if (accessFailure(failure)) {
      accessRef.current = false
      ++overviewSequence.current; ++detailSequence.current
      overviewBusy.current = false; detailBusy.current = false
      selectedRef.current = null; snapshotRef.current = null
      setOverview({ userId: userRef.current, workspaces: [], invitations: [] })
      setSnapshot(null); setSelected(null); updateEditor(null); setConfirmation(null)
      setCreateName(''); setInviteName(''); setRenameName(''); setQuery('')
      setOverviewLoading(false); setDetailLoading(false); setLoadingMore(false); setRefreshing(false)
      setAccessLost(true)
      void refreshBilling()
    }
  }, [notify, refreshBilling, updateEditor])

  const loadOverview = useCallback(async (quiet = false, force = false) => {
    if (!accessRef.current || (mutationLock.current !== null && !force) || (overviewBusy.current && !force)) return
    const account = userRef.current
    const generation = epoch.current
    const token = ++overviewSequence.current
    overviewBusy.current = true
    if (!quiet) setOverviewLoading(true)
    const current = () => own(account, generation) && token === overviewSequence.current && accessRef.current
    try {
      const result = await loadSharedOrganizerOverview(account)
      if (!current()) return
      setOverview({ userId: account, ...result })
      if (selectedRef.current && !result.workspaces.some((workspace) => workspace.id === selectedRef.current)) {
        selectWorkspace(null)
        setError('Цей спільний органайзер більше недоступний. Оберіть інший зі списку.')
      }
      if (!selectedRef.current && result.workspaces.length) selectWorkspace(result.workspaces[0].id)
    } catch (failure) { if (current()) reportFailure(failure) }
    finally { if (own(account, generation) && token === overviewSequence.current) { overviewBusy.current = false; setOverviewLoading(false) } }
  }, [own, reportFailure, selectWorkspace])

  const loadDetail = useCallback(async (quiet = false, append = false, force = false) => {
    const workspaceId = selectedRef.current
    if (!workspaceId || !accessRef.current || (mutationLock.current !== null && !force) || (detailBusy.current && !force)) return
    const account = userRef.current
    const generation = epoch.current
    const token = ++detailSequence.current
    const previous = snapshotRef.current?.workspace.id === workspaceId ? snapshotRef.current : null
    const target = append ? pagesRef.current + PAGE_SIZE : Math.max(PAGE_SIZE, pagesRef.current)
    const offset = append ? previous?.tasks.length || 0 : 0
    detailBusy.current = true
    if (append) setLoadingMore(true)
    else if (!quiet) setDetailLoading(true)
    const current = () => own(account, generation) && selectedRef.current === workspaceId && token === detailSequence.current && accessRef.current
    try {
      const result = await loadSharedOrganizerWorkspace(workspaceId, account, offset, PAGE_SIZE)
      if (!current()) return
      const rows = [...result.tasks]
      // Refresh only the pages the user has opened; every server request stays bounded.
      if (!append) for (let next = PAGE_SIZE; next < target && next < result.total; next += PAGE_SIZE) {
        const page = await loadSharedOrganizerWorkspace(workspaceId, account, next, PAGE_SIZE)
        if (!current()) return
        rows.push(...page.tasks)
      }
      const tasks = [...new Map((append ? [...(previous?.tasks || []), ...rows] : rows).map((task) => [task.id, task])).values()]
      const next = { ...result, tasks }
      snapshotRef.current = next
      pagesRef.current = target
      setSnapshot({ userId: account, data: next })
      const open = editorRef.current
      if (open?.userId === account && open.workspaceId === workspaceId && open.taskId) {
        const latest = tasks.find((task) => task.id === open.taskId)
        const deleted = !latest && result.total <= target
        if ((latest && latest.updated_at !== open.version) || deleted) {
          updateEditor({ ...open, conflict: true, latest: latest || null, deleted })
        }
      }
    } catch (failure) { if (current()) reportFailure(failure) }
    finally {
      if (own(account, generation) && token === detailSequence.current) { detailBusy.current = false; setDetailLoading(false); setLoadingMore(false) }
    }
  }, [own, reportFailure, updateEditor])
  const loaders = useRef({ overview: loadOverview, detail: loadDetail })
  loaders.current = { overview: loadOverview, detail: loadDetail }
  const refresh = useCallback(async (quiet = true) => {
    if (mutationLock.current !== null || !accessRef.current) return
    const account = userRef.current
    const generation = epoch.current
    if (!quiet) { setRefreshing(true); setError('') }
    await loaders.current.overview(true)
    if (!own(account, generation)) return
    await loaders.current.detail(true)
    if (!quiet && own(account, generation)) setRefreshing(false)
  }, [own])

  useEffect(() => {
    alive.current = true; ++epoch.current; ++overviewSequence.current; ++detailSequence.current
    accessRef.current = true; mutationLock.current = null; overviewBusy.current = false; detailBusy.current = false
    selectedRef.current = null; snapshotRef.current = null; pagesRef.current = PAGE_SIZE
    setOverview({ userId, workspaces: [], invitations: [] }); setSnapshot(null); setSelected(null); updateEditor(null)
    setError(''); setAccessLost(false); setBusy(''); setCreateName(''); setInviteName(''); setRenameName(''); setConfirmation(null)
    setOverviewLoading(true); setDetailLoading(false); setRefreshing(false); setLoadingMore(false)
    void loaders.current.overview()
    return () => { alive.current = false; ++epoch.current; ++overviewSequence.current; ++detailSequence.current; mutationLock.current = null }
  }, [userId, updateEditor])
  useEffect(() => { if (selected) void loaders.current.detail() }, [selected])
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') void refresh(true) }
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update); window.addEventListener(SHARED_ORGANIZER_UPDATED_EVENT, update)
    const interval = window.setInterval(update, 15_000)
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); window.removeEventListener(SHARED_ORGANIZER_UPDATED_EVENT, update); window.clearInterval(interval) }
  }, [refresh])
  useEffect(() => {
    if (!isDirty(currentEditor)) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [currentEditor])
  useEffect(() => {
    if (!confirmation || !confirmationRef.current) return
    confirmationRef.current.focus({ preventScroll: true })
    confirmationRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [confirmation])
  useEffect(() => { onStateChange?.({ busy: Boolean(busy), dirty: isDirty(currentEditor) }) }, [busy, currentEditor, onStateChange])
  useEffect(() => () => { onStateChange?.({ busy: false, dirty: false }) }, [onStateChange])

  const runAction = async (key: string, action: (account: string) => Promise<unknown>, success: (result: unknown) => void, title: string, workspaceId: string | null = selectedRef.current) => {
    if (!accessRef.current || mutationLock.current !== null || userRef.current !== userId || selectedRef.current !== workspaceId) return
    const account = userId
    const generation = epoch.current
    const token = ++mutationSequence.current
    // Old reads must never overwrite the result of a mutation.
    mutationLock.current = token; ++overviewSequence.current; ++detailSequence.current
    overviewBusy.current = false; detailBusy.current = false
    onStateChange?.({ busy: true, dirty: isDirty(editorRef.current) })
    setBusy(key); setError(''); setLoadingMore(false); setDetailLoading(false)
    const current = () => own(account, generation) && mutationLock.current === token && selectedRef.current === workspaceId && accessRef.current
    try {
      const result = await action(account)
      if (!current()) return
      success(result)
      setConfirmation(null)
      notify({ id: 'shared-organizer-action', tone: 'success', title })
      await loaders.current.overview(true, true)
      if (own(account, generation) && accessRef.current) await loaders.current.detail(true, false, true)
    } catch (failure) {
      if (!current()) return
      if (conflictFailure(failure)) setConfirmation(null)
      if (key === 'save' && editorRef.current?.workspaceId === workspaceId) {
        if (/SHARED_ORGANIZER_TASK_UNAVAILABLE/.test(failureText(failure))) updateEditor({ ...editorRef.current, conflict: true, deleted: true, latest: null })
        else if (conflictFailure(failure)) updateEditor({ ...editorRef.current, conflict: true })
      }
      reportFailure(failure, 'Не вдалося виконати дію')
      if (!accessFailure(failure)) {
        await loaders.current.overview(true, true)
        if (own(account, generation) && accessRef.current) await loaders.current.detail(true, false, true)
      }
    } finally {
      if (mutationLock.current === token) mutationLock.current = null
      if (own(account, generation)) setBusy('')
    }
  }
  const validate = (message: string) => { setError(message); notify({ id: 'shared-organizer-validation', tone: 'warning', title: 'Перевірте дані', description: message }) }
  const create = (event: FormEvent) => {
    event.preventDefault()
    if (editorRef.current) return validate('Збережіть або закрийте відкрите завдання перед створенням іншого органайзера.')
    const name = createName.trim()
    if (!name || name.length > 100) return validate('Вкажіть назву від 1 до 100 символів.')
    void runAction('create', (account) => createSharedOrganizer(name, account), (result) => {
      setCreateName(''); setCreateOpen(false); selectWorkspace(result as string)
    }, 'Спільний органайзер створено')
  }
  const chooseWorkspace = (workspaceId: string) => {
    if (mutationLock.current !== null || selectedRef.current === workspaceId) return
    if (isDirty(editorRef.current)) setConfirmation({ kind: 'switch', id: workspaceId })
    else selectWorkspace(workspaceId)
  }
  const openEditor = (task?: SharedOrganizerTask) => {
    const workspaceId = selectedRef.current
    if (!workspaceId || disabled || mutationLock.current !== null || (task && task.workspace_id !== workspaceId)) return
    if (editorRef.current && (!task || editorRef.current.taskId !== task.id)) {
      notify({ tone: 'warning', title: 'У вас уже відкрите завдання', description: 'Збережіть чернетку або закрийте її перед відкриттям іншого завдання.' })
      return
    }
    if (editorRef.current) return
    const draft = task ? fromTask(task) : emptyDraft()
    updateEditor({ userId, workspaceId, taskId: task?.id || null, version: task?.updated_at || null, draft, initial: { ...draft }, conflict: false, latest: task || null, deleted: false })
    setConfirmation(null)
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    const open = editorRef.current
    if (!open || open.userId !== userId || open.workspaceId !== selectedRef.current || open.conflict) return
    const draft = open.draft
    if (!draft.title.trim() || draft.title.trim().length > 200) return validate('Вкажіть назву завдання від 1 до 200 символів.')
    if (draft.notes.length > 10000 || draft.subject.trim().length > 120) return validate('Нотатки: до 10 000 символів; предмет: до 120 символів.')
    if (draft.date && !validDayKey(draft.date)) return validate('Оберіть коректну дату дедлайну.')
    const due = draft.date && draft.timed ? fromDateTimeInput(draft.date + 'T' + draft.time) : null
    if (due && !Number.isFinite(due.getTime())) return validate('Оберіть коректний час за Києвом. Цей час може бути недоступним під час переходу на літній час.')
    const retainedAssignee = Boolean(open.taskId && draft.assignee === open.initial.assignee)
    if (draft.assignee && !retainedAssignee && !snapshotRef.current?.members.some((member) => member.user_id === draft.assignee && member.is_premium)) return validate('Оберіть активного учасника або «Усі учасники».')
    void runAction('save', (account) => saveSharedOrganizerTask(open.workspaceId, {
      id: open.taskId, updated_at: open.version, title: draft.title.trim(), notes: draft.notes.trim(), subject: draft.subject.trim(),
      due_date: draft.date && !draft.timed ? draft.date : null, due_at: due?.toISOString() || null,
      assignee_id: draft.assignee || null, completed: draft.completed,
    }, account), () => updateEditor(null), open.taskId ? 'Зміни збережено' : 'Завдання додано', open.workspaceId)
  }
  const toggle = (task: SharedOrganizerTask) => {
    if (editorRef.current?.taskId === task.id) return validate('Спочатку збережіть або закрийте відкрите завдання.')
    void runAction('task:' + task.id, (account) => saveSharedOrganizerTask(task.workspace_id, {
      id: task.id, updated_at: task.updated_at, title: task.title, notes: task.notes || '', subject: task.subject || '',
      due_date: task.due_date, due_at: task.due_at, assignee_id: task.assignee_id, completed: !task.completed,
    }, account), () => {}, task.completed ? 'Завдання повернуто у плани' : 'Завдання виконано', task.workspace_id)
  }
  const rename = (event: FormEvent) => {
    event.preventDefault()
    const current = snapshotRef.current
    const name = renameName.trim()
    if (!current || !name || name.length > 100) return validate('Вкажіть назву від 1 до 100 символів.')
    const version = renameVersion.current
    if (!version) return
    void runAction('rename', (account) => renameSharedOrganizer(current.workspace.id, name, version, account), () => setRenameOpen(false), 'Назву оновлено')
  }
  const invite = (event: FormEvent) => {
    event.preventDefault()
    const workspaceId = selectedRef.current
    const username = inviteName.trim().replace(/^@/, '')
    if (!workspaceId || !username || username.length > 50 || /\s/.test(username)) return validate('Вкажіть точний нік учасника без пробілів.')
    void runAction('invite', (account) => inviteSharedOrganizer(workspaceId, username, account), () => setInviteName(''), 'Запрошення надіслано')
  }
  const confirmAction = () => {
    if (!confirmation || disabled) return
    const current = snapshotRef.current
    if (confirmation.kind === 'switch') { selectWorkspace(confirmation.id || null); return }
    if (confirmation.kind === 'discard') { updateEditor(null); setConfirmation(null); return }
    if (confirmation.kind === 'reload') {
      const open = editorRef.current
      if (open?.latest && open.workspaceId === selectedRef.current && open.latest.workspace_id === open.workspaceId) {
        const draft = fromTask(open.latest)
        updateEditor({ ...open, draft, initial: { ...draft }, version: open.latest.updated_at, conflict: false, deleted: false })
      }
      setConfirmation(null); return
    }
    if (!current) return
    const workspaceId = current.workspace.id
    if (confirmation.kind === 'archive' && confirmation.version) void runAction('archive', (account) => archiveSharedOrganizer(workspaceId, confirmation.version!, account), () => selectWorkspace(null), 'Органайзер архівовано')
    if (confirmation.kind === 'leave') void runAction('leave', (account) => removeSharedOrganizerMember(workspaceId, account, account), () => selectWorkspace(null), 'Ви вийшли зі спільного органайзера')
    if (confirmation.kind === 'member') void runAction('member:' + confirmation.id, (account) => removeSharedOrganizerMember(workspaceId, confirmation.id, account), () => {}, 'Учасника вилучено')
    if (confirmation.kind === 'invitation') void runAction('invitation:' + confirmation.id, (account) => cancelSharedOrganizerInvitation(confirmation.id, account), () => {}, 'Запрошення скасовано')
    if (confirmation.kind === 'task') {
      const task = current.tasks.find((row) => row.id === confirmation.id)
      if (!task) { setConfirmation(null); return validate('Це завдання більше не відображається у списку. Оновіть органайзер.') }
      if (task && confirmation.version) void runAction('delete:' + task.id, (account) => deleteSharedOrganizerTask(workspaceId, task.id, confirmation.version!, account), () => {
        if (editorRef.current?.taskId === task.id) updateEditor(null)
      }, 'Завдання видалено')
    }
  }
  const members = useMemo(() => new Map(data?.members.map((member) => [member.user_id, member]) || []), [data?.members])
  const visibleTasks = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('uk-UA')
    return (data?.tasks || []).filter((task) => (filter !== 'pending' || !task.completed) && (filter !== 'done' || task.completed)
      && (filter !== 'mine' || task.assignee_id === userId)
      && (!term || [task.title, task.notes, task.subject].join(' ').toLocaleLowerCase('uk-UA').includes(term)))
  }, [data?.tasks, filter, query, userId])
  const pending = data?.tasks.filter((task) => !task.completed).length || 0
  const confirmationText = confirmation?.kind === 'archive' ? 'Архівувати цей органайзер? Учасники втратять доступ, а завдання та історія збережуться в архіві.'
    : confirmation?.kind === 'leave' ? 'Вийти з цього органайзера? Ваші спільні завдання та історія залишаться для команди.'
      : confirmation?.kind === 'member' ? 'Вилучити цього учасника? Він втратить доступ. Його завдання та авторство залишаться.'
        : confirmation?.kind === 'invitation' ? 'Скасувати це запрошення та звільнити місце?'
          : confirmation?.kind === 'task' ? 'Видалити це завдання назавжди для всіх учасників?'
            : confirmation?.kind === 'reload' ? 'Відкинути вашу чернетку та відкрити актуальну версію завдання?'
              : confirmation?.kind === 'switch' ? 'Відкинути незбережені зміни та перейти до іншого органайзера?' : 'Відкинути незбережені зміни?'

  if (!accountCurrent) return null
  return <section aria-label="Спільний органайзер" className="space-y-5">
    <div className="rounded-2xl border border-primary/15 bg-primary/5 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Users size={22} aria-hidden="true" /></span><div><h2 className="text-lg font-semibold">Плануйте разом</h2><p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">Спільні завдання, дедлайни й відповідальні — для команди до 5 учасників із підпискою.</p></div></div>
        <button type="button" className={buttonClass + ' bg-card'} onClick={() => setCreateOpen(!createOpen)} disabled={disabled} aria-expanded={createOpen} aria-controls={id + '-create'}><Plus size={16} aria-hidden="true" />Створити</button>
      </div>
      {createOpen && !accessLost && <form id={id + '-create'} onSubmit={create} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"><label className="min-w-0 flex-1"><span className="mb-1.5 block text-xs font-medium">Назва нового органайзера</span><input className={inputClass} maxLength={100} required value={createName} onChange={(event) => setCreateName(event.target.value)} disabled={disabled} placeholder="Наприклад, Підготовка до сесії" /></label><button className={primaryClass} disabled={disabled}>{busy === 'create' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}Створити органайзер</button></form>}
    </div>
    {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm"><AlertCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" /><p className="min-w-0 break-words">{error}</p></div>}
    {accessLost ? <div className="rounded-2xl border border-border bg-card p-5 text-center"><h3 className="font-semibold">Доступ до органайзера змінився</h3><p className="mt-2 text-sm text-muted-foreground">Повторна перевірка оновить підписку й перелік доступних вам спільних органайзерів.</p><button type="button" className={buttonClass + ' mt-4'} disabled={Boolean(busy)} onClick={() => {
      if (mutationLock.current !== null) return
      setBusy('access')
      const account = userId; const generation = epoch.current
      void refreshBilling().then((ok) => {
        if (!own(account, generation)) return
        if (ok) { accessRef.current = true; setAccessLost(false); setError(''); void loaders.current.overview() }
      }).finally(() => { if (own(account, generation)) setBusy('') })
    }}><RefreshCw size={16} aria-hidden="true" />Перевірити доступ</button></div> : <>
      {invitations.length > 0 && <section className="rounded-2xl border border-primary/20 bg-card p-4" aria-labelledby={id + '-invitations'}><h3 id={id + '-invitations'} className="flex items-center gap-2 text-sm font-semibold"><UserPlus size={17} className="text-primary" aria-hidden="true" />Вас запрошують · {invitations.length}</h3><div className="mt-3 space-y-3">{invitations.map((invitation) => <div key={invitation.id} className="flex flex-col justify-between gap-2 rounded-xl bg-muted/40 p-3 sm:flex-row sm:items-center"><div className="min-w-0"><p className="break-words text-sm font-semibold">{invitation.workspace_name}</p><p className="mt-1 text-xs text-muted-foreground">Від {invitation.inviter_name} · до {dueLabel(invitation.expires_at)}</p></div><div className="flex shrink-0 flex-wrap gap-2"><button type="button" className={primaryClass} disabled={disabled || Boolean(currentEditor)} onClick={() => void runAction('accept:' + invitation.id, (account) => respondSharedOrganizerInvitation(invitation.id, true, account), (workspaceId) => { if (workspaceId) selectWorkspace(workspaceId as string) }, 'Запрошення прийнято')}><Check size={16} aria-hidden="true" />Прийняти</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => void runAction('decline:' + invitation.id, (account) => respondSharedOrganizerInvitation(invitation.id, false, account), () => {}, 'Запрошення відхилено')}>Відхилити</button></div></div>)}</div>{currentEditor && <p className="mt-2 text-xs text-muted-foreground">Збережіть або закрийте відкрите завдання, щоб прийняти запрошення.</p>}</section>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="min-w-0 flex-1"><span className="mb-1.5 block text-xs font-medium text-muted-foreground">Ваші спільні органайзери</span><select className={inputClass} value={selected || ''} disabled={disabled || overviewLoading || !workspaces.length} onChange={(event) => chooseWorkspace(event.target.value)}><option value="" disabled>{overviewLoading ? 'Завантажуємо…' : 'Оберіть органайзер'}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.member_count}/5</option>)}</select></label><button type="button" className={buttonClass} disabled={disabled || refreshing || overviewLoading || loadingMore} onClick={() => void refresh(false)} aria-label="Оновити спільні органайзери">{refreshing ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}Оновити</button></div>
      {overviewLoading && !workspaces.length && <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Завантажуємо спільні органайзери…</div>}
      {!overviewLoading && !workspaces.length && <div className="rounded-2xl border border-dashed border-border p-7 text-center"><Users size={30} className="mx-auto text-muted-foreground" aria-hidden="true" /><h3 className="mt-3 font-semibold">Команда починається з органайзера</h3><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">Створіть спільний простір і запросіть друзів за їхнім точним ніком. Кожен учасник зможе додавати та редагувати завдання.</p><button type="button" className={primaryClass + ' mt-4'} onClick={() => setCreateOpen(true)} disabled={disabled}><Plus size={16} aria-hidden="true" />Створити органайзер</button></div>}
      {detailLoading && !data && <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Завантажуємо команду й завдання…</div>}
      {data && <>
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{data.workspace.name}</h3><p className="mt-1 text-xs text-muted-foreground">{data.workspace.member_count} із 5 учасників{data.invitations.length ? ' · Запрошень: ' + data.invitations.length : ''} · {owner ? 'Ви — власник' : 'Ви — учасник'}</p></div><button type="button" className={primaryClass} disabled={disabled || Boolean(currentEditor)} onClick={() => openEditor()}><Plus size={16} aria-hidden="true" />Додати завдання</button></div>
          <details className="mt-4 border-t border-border pt-2"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium"><span className="flex items-center gap-2"><Users size={16} aria-hidden="true" />Команда та налаштування</span><ChevronDown size={16} aria-hidden="true" /></summary>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Неактивний учасник зберігає місце та авторство, але доступ до органайзера повернеться після поновлення підписки.</p>
            <ul className="mt-3 space-y-2">{data.members.map((member) => <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 p-3"><div className="flex min-w-0 items-center gap-2.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden="true">{personName(member).slice(0, 1).toLocaleUpperCase('uk-UA')}</span><div className="min-w-0"><p className="break-words text-sm font-medium">{personName(member)}{member.user_id === userId && <span className="text-muted-foreground"> · ви</span>}</p><p className="mt-0.5 break-words text-xs text-muted-foreground">{member.username ? '@' + member.username + ' · ' : ''}{member.role === 'owner' ? 'Власник' : 'Учасник'} · <span className={member.is_premium ? 'text-primary' : ''}>{member.is_premium ? 'Активний' : 'Неактивна підписка'}</span></p></div></div>{owner && member.role !== 'owner' && <button type="button" className={dangerClass + ' text-xs'} disabled={disabled} onClick={() => setConfirmation({ kind: 'member', id: member.user_id })} aria-label={'Вилучити учасника ' + personName(member)}>Вилучити</button>}</li>)}</ul>
            {owner && <>
              <form onSubmit={invite} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"><label className="min-w-0 flex-1"><span className="mb-1.5 block text-xs font-medium">Запросити за точним ніком</span><input className={inputClass} value={inviteName} maxLength={50} required autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setInviteName(event.target.value)} disabled={disabled || data.workspace.member_count + data.invitations.length >= 5} placeholder="@нік" /></label><button className={buttonClass} disabled={disabled || data.workspace.member_count + data.invitations.length >= 5}><UserPlus size={16} aria-hidden="true" />Запросити</button></form><p className="mt-1.5 text-xs text-muted-foreground">{data.workspace.member_count + data.invitations.length >= 5 ? 'Усі 5 місць зайняті або зарезервовані запрошеннями.' : 'Запрошення резервує місце. Для приєднання потрібна активна підписка.'}</p>
              {data.invitations.length > 0 && <div className="mt-4"><h4 className="text-xs font-semibold text-muted-foreground">Очікують відповіді</h4><ul className="mt-2 space-y-2">{data.invitations.map((invitation) => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"><div className="min-w-0"><p className="break-words text-sm">{invitation.invitee_name}{invitation.invitee_username && <span className="text-muted-foreground"> · @{invitation.invitee_username}</span>}</p><p className="mt-1 text-xs text-muted-foreground">Діє до {dueLabel(invitation.expires_at)}</p></div><button type="button" className={buttonClass + ' text-xs'} disabled={disabled} onClick={() => setConfirmation({ kind: 'invitation', id: invitation.id })}>Скасувати запрошення</button></li>)}</ul></div>}
            </>}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">{owner ? <><button type="button" className={buttonClass} disabled={disabled} onClick={() => { setRenameName(data.workspace.name); renameVersion.current = data.workspace.updated_at; setRenameOpen(!renameOpen) }} aria-expanded={renameOpen}><Pencil size={15} aria-hidden="true" />Змінити назву</button><button type="button" className={dangerClass} disabled={disabled} onClick={() => setConfirmation({ kind: 'archive', version: data.workspace.updated_at })}><Archive size={15} aria-hidden="true" />Архівувати</button></> : <button type="button" className={dangerClass} disabled={disabled} onClick={() => setConfirmation({ kind: 'leave' })}><LogOut size={15} aria-hidden="true" />Вийти з органайзера</button>}</div>
            {owner && renameOpen && <form onSubmit={rename} className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="min-w-0 flex-1"><span className="sr-only">Нова назва органайзера</span><input className={inputClass} required maxLength={100} value={renameName} onChange={(event) => setRenameName(event.target.value)} disabled={disabled} /></label><button className={primaryClass} disabled={disabled}>Зберегти назву</button></form>}
          </details>
        </div>
        {currentEditor && <form onSubmit={save} className="rounded-2xl border border-primary/25 bg-card p-4 sm:p-5" aria-labelledby={id + '-editor'}>
          <div className="mb-4 flex items-start justify-between gap-2"><div><h3 id={id + '-editor'} className="font-semibold">{currentEditor.taskId ? 'Редагування завдання' : 'Нове спільне завдання'}</h3><p className="mt-1 text-xs text-muted-foreground">Зміни побачать усі учасники органайзера.</p></div><button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50" aria-label="Закрити редактор завдання" disabled={disabled} onClick={() => { if (isDirty(editorRef.current)) setConfirmation({ kind: 'discard' }); else updateEditor(null) }}><X size={18} aria-hidden="true" /></button></div>
          {currentEditor.conflict && <div role="status" className="mb-4 rounded-xl border border-primary/20 bg-primary/5 p-3"><p className="text-sm font-medium">{currentEditor.deleted ? 'Це завдання вже видалив інший учасник.' : 'Завдання змінилося, поки ви його редагували.'}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Ваш текст збережений у цьому редакторі. {currentEditor.deleted ? 'Скопіюйте потрібне й створіть нове завдання.' : 'Перегляньте актуальну версію перед збереженням.'}</p>{currentEditor.latest && !currentEditor.deleted && <button type="button" className={buttonClass + ' mt-2 text-xs'} disabled={disabled} onClick={() => setConfirmation({ kind: 'reload' })}>Відкрити актуальну версію</button>}</div>}
          <div className="space-y-3"><label className="block"><span className="mb-1.5 block text-xs font-medium">Назва завдання *</span><input className={inputClass} required maxLength={200} value={currentEditor.draft.title} disabled={disabled} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="Що потрібно зробити?" /></label><div className="grid gap-3 sm:grid-cols-2"><label><span className="mb-1.5 block text-xs font-medium">Предмет</span><input className={inputClass} maxLength={120} value={currentEditor.draft.subject} disabled={disabled} onChange={(event) => patchDraft({ subject: event.target.value })} placeholder="Необов’язково" /></label><label><span className="mb-1.5 block text-xs font-medium">Відповідальний</span><select className={inputClass} value={currentEditor.draft.assignee} disabled={disabled} onChange={(event) => patchDraft({ assignee: event.target.value })}><option value="">Усі учасники</option>{data.members.map((member) => <option key={member.user_id} value={member.user_id} disabled={!member.is_premium}>{personName(member)}{member.is_premium ? '' : ' · неактивний'}</option>)}{currentEditor.draft.assignee && !members.has(currentEditor.draft.assignee) && <option value={currentEditor.draft.assignee} disabled>Колишній учасник · оберіть іншого</option>}</select></label></div><label className="block"><span className="mb-1.5 block text-xs font-medium">Нотатки</span><textarea className={inputClass + ' min-h-28 resize-y'} maxLength={10000} value={currentEditor.draft.notes} disabled={disabled} onChange={(event) => patchDraft({ notes: event.target.value })} placeholder="Деталі, посилання та план роботи" /></label><div className="rounded-xl bg-muted/40 p-3"><p className="mb-2 text-xs font-medium">Дедлайн <span className="font-normal text-muted-foreground">· необов’язково, час за Києвом</span></p><div className="grid gap-3 sm:grid-cols-2"><label><span className="mb-1.5 block text-xs text-muted-foreground">Дата</span><input type="date" className={inputClass} value={currentEditor.draft.date} disabled={disabled} onChange={(event) => patchDraft({ date: event.target.value, timed: event.target.value ? currentEditor.draft.timed : false })} /></label><div><label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" className="h-4 w-4 accent-primary" checked={currentEditor.draft.timed} disabled={disabled || !currentEditor.draft.date} onChange={(event) => patchDraft({ timed: event.target.checked })} />Уточнити час</label>{currentEditor.draft.timed && <label><span className="sr-only">Час дедлайну за Києвом</span><input type="time" className={inputClass} required value={currentEditor.draft.time} disabled={disabled} onChange={(event) => patchDraft({ time: event.target.value })} /></label>}</div></div></div><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={currentEditor.draft.completed} disabled={disabled} onChange={(event) => patchDraft({ completed: event.target.checked })} />Завдання виконано</label></div><div className="mt-4 flex flex-wrap items-center gap-2"><button className={primaryClass} disabled={disabled || currentEditor.conflict}>{busy === 'save' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy === 'save' ? 'Зберігаємо…' : 'Зберегти завдання'}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => { if (isDirty(editorRef.current)) setConfirmation({ kind: 'discard' }); else updateEditor(null) }}>Скасувати</button><span className="text-xs text-muted-foreground">{isDirty(currentEditor) ? 'Є незбережені зміни' : 'Зміни ще не внесено'}</span></div>
        </form>}
        {confirmation && <div ref={confirmationRef} tabIndex={-1} role="alert" className="rounded-2xl border border-destructive/20 bg-destructive/5 p-4"><p className="text-sm leading-relaxed">{confirmationText}</p>{isDirty(currentEditor) && (confirmation.kind === 'archive' || confirmation.kind === 'leave' || (confirmation.kind === 'task' && confirmation.id === currentEditor?.taskId)) && <p className="mt-2 text-xs text-destructive">Незбережені зміни у відкритому завданні буде втрачено.</p>}<div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled} onClick={() => setConfirmation(null)}>Залишити як є</button><button type="button" className={dangerClass} disabled={disabled} onClick={confirmAction}>{busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}Підтвердити</button></div></div>}
        <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><ListTodo size={17} className="text-primary" aria-hidden="true" />Завдання <span className="text-xs font-normal text-muted-foreground">{data.total} загалом · {pending} у планах серед завантажених</span></h3><span className="text-xs text-muted-foreground">Оновлюється автоматично</span></div><div className="flex flex-wrap gap-2" role="group" aria-label="Фільтр завдань">{([{ key: 'all', label: 'Усі' }, { key: 'pending', label: 'У планах' }, { key: 'done', label: 'Виконані' }, { key: 'mine', label: 'Призначені мені' }] as const).map((item) => <button key={item.key} type="button" className={buttonClass + ' text-xs ' + (filter === item.key ? 'border-primary/30 bg-primary/10 text-primary' : '')} aria-pressed={filter === item.key} disabled={disabled} onClick={() => setFilter(item.key)}>{item.label}</button>)}</div><label className="relative block"><span className="sr-only">Пошук у завантажених завданнях</span><Search size={16} className="pointer-events-none absolute left-3.5 top-3.5 text-muted-foreground" aria-hidden="true" /><input type="search" className={inputClass + ' pl-10'} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} disabled={disabled} placeholder="Пошук за назвою, предметом або нотатками" /></label>{data.tasks.length < data.total && <p className="text-xs text-muted-foreground">Пошук і фільтри застосовані до {data.tasks.length} завантажених завдань. Завантажте ще, щоб побачити решту.</p>}</div>
        <div className="space-y-2">{visibleTasks.map((task) => <article key={task.id} className="rounded-2xl border border-border bg-card p-2.5 sm:p-3"><div className="flex items-start gap-1.5"><button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/5 disabled:opacity-50" disabled={disabled || currentEditor?.taskId === task.id} onClick={() => toggle(task)} aria-label={(task.completed ? 'Повернути у плани: ' : 'Позначити виконаним: ') + task.title}>{busy === 'task:' + task.id ? <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : task.completed ? <CheckCircle2 size={22} aria-hidden="true" /> : <Circle size={22} aria-hidden="true" />}</button><div className="min-w-0 flex-1 py-2"><h4 className={'break-words text-sm font-semibold [overflow-wrap:anywhere] ' + (task.completed ? 'text-muted-foreground line-through' : '')}>{task.title}</h4><div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{task.subject && <span className="rounded-full bg-muted px-2 py-0.5">{task.subject}</span>}{(task.due_date || task.due_at) && <span className="inline-flex items-center gap-1"><CalendarDays size={13} aria-hidden="true" />{task.due_date ? dateOnlyLabel(task.due_date) : dueLabel(task.due_at!)}</span>}<span className="inline-flex items-center gap-1"><Users size={13} aria-hidden="true" />{task.assignee_id ? personName(members.get(task.assignee_id)) : 'Усі учасники'}{task.assignee_id && members.get(task.assignee_id) && !members.get(task.assignee_id)!.is_premium && ' · неактивний'}</span></div>{task.notes && <details className="mt-1"><summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-muted-foreground">Нотатки</summary><p className="whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]"><SharedNoteLinks text={task.notes} /></p></details>}<p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Автор: {personName(members.get(task.created_by))} · Оновив: {personName(members.get(task.updated_by))} · {dueLabel(task.updated_at)}</p></div><div className="flex shrink-0 flex-col sm:flex-row"><button type="button" className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50" disabled={disabled || Boolean(currentEditor && currentEditor.taskId !== task.id)} onClick={() => openEditor(task)} aria-label={'Редагувати: ' + task.title}><Pencil size={15} aria-hidden="true" /></button><button type="button" className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/5 hover:text-destructive disabled:opacity-50" disabled={disabled} onClick={() => setConfirmation({ kind: 'task', id: task.id, version: task.updated_at })} aria-label={'Видалити: ' + task.title}><Trash2 size={15} aria-hidden="true" /></button></div></div></article>)}</div>
        {!visibleTasks.length && <div className="rounded-2xl border border-dashed border-border p-7 text-center"><ListTodo size={28} className="mx-auto text-muted-foreground" aria-hidden="true" /><h4 className="mt-3 text-sm font-semibold">{data.total ? 'За цими умовами завдань немає' : 'Поки що немає завдань'}</h4><p className="mt-2 text-sm text-muted-foreground">{data.total ? 'Спробуйте інший фільтр або пошук.' : 'Додайте перше завдання, щоб команда могла почати роботу.'}</p></div>}
        {data.tasks.length < data.total && <button type="button" className={buttonClass + ' w-full'} disabled={disabled || loadingMore || refreshing || detailLoading} onClick={() => void loaders.current.detail(false, true)}>{loadingMore && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}Показати ще · {data.tasks.length} із {data.total}</button>}
        <p className="text-center text-xs leading-relaxed text-muted-foreground">Спільні завдання бачать учасники цього органайзера. Час дедлайнів указано за Києвом.</p>
      </>}
      {!data && !detailLoading && confirmation?.kind === 'switch' && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4"><p className="text-sm">{confirmationText}</p><div className="mt-3 flex gap-2"><button type="button" className={buttonClass} disabled={disabled} onClick={() => setConfirmation(null)}>Залишитися</button><button type="button" className={dangerClass} disabled={disabled} onClick={confirmAction}>Перейти</button></div></div>}
    </>}
  </section>
}

function SharedNoteLinks({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return <span key={index}>{part}</span>
    const match = part.match(/^(.*?)([),.!;]+)?$/)
    const href = match?.[1] || part
    try {
      const url = new URL(href)
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return <span key={index}>{part}</span>
      return <span key={index}><a href={url.toString()} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{href}</a>{match?.[2] || ''}</span>
    } catch { return <span key={index}>{part}</span> }
  })}</>
}
