import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, Archive, BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Columns2, FileText, Hash, LayoutList, ListTodo, Loader2, LogOut, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, UserPlus, Users } from 'lucide-react'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { dateOnlyLabel, dueLabel, fromDateTimeInput, toDateTimeInput, validDayKey } from '../lib/organizerDates'
import {
  archiveSharedOrganizer, cancelSharedOrganizerInvitation, createSharedOrganizer, deleteSharedOrganizerTask,
  inviteSharedOrganizer, isSharedOrganizerAccessError, loadSharedOrganizerOverview, loadSharedOrganizerWorkspace, removeSharedOrganizerMember,
  renameSharedOrganizer, respondSharedOrganizerInvitation, saveSharedOrganizerTask, sharedOrganizerError,
  SHARED_ORGANIZER_MEMBER_LIMIT, SHARED_ORGANIZER_UPDATED_EVENT,
  type SharedOrganizerInvitation, type SharedOrganizerMember, type SharedOrganizerSnapshot,
  type SharedOrganizerTask, type SharedOrganizerWorkspace,
} from '../lib/sharedOrganizer'
import { ChatDialog } from './CommunityChatPrimitives'
import './SharedOrganizer.css'

const PAGE_SIZE = 100
const inputClass = 'block min-h-11 min-w-0 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10 disabled:opacity-50'
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryClass = buttonClass + ' border-primary bg-primary text-primary-foreground hover:bg-primary/90'
const dangerClass = buttonClass + ' border-destructive/30 text-destructive hover:bg-destructive/5'
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function initialWorkspaceSelection(workspaces: SharedOrganizerWorkspace[], requestedId?: string): string | null {
  // The overview contains only this account's accessible workspaces. A URL
  // never authorizes loading an arbitrary workspace or a pending invitation.
  const requested = typeof requestedId === 'string' && WORKSPACE_ID.test(requestedId)
    ? workspaces.find(workspace => workspace.id.toLowerCase() === requestedId.toLowerCase()) : undefined
  return requested?.id || workspaces[0]?.id || null
}
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
export function SharedOrganizer({ userId, initialWorkspaceId, onStateChange }: {
  userId: string; initialWorkspaceId?: string; onStateChange?: (state: { busy: boolean; dirty: boolean }) => void
}) {
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
  const requestedWorkspaceRef = useRef(initialWorkspaceId)
  requestedWorkspaceRef.current = initialWorkspaceId
  const initialSelection = useRef({ userId, consumed: false })
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
  const [membersOpen, setMembersOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [display, setDisplay] = useState<'list' | 'board'>('list')
  const [quickTitle, setQuickTitle] = useState('')
  const [completedExpanded, setCompletedExpanded] = useState(false)
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
    setMembersOpen(false); setSettingsOpen(false); setQuickTitle(''); setCompletedExpanded(false)
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
      setMembersOpen(false); setSettingsOpen(false); setCreateOpen(false); setQuickTitle('')
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
      if (!initialSelection.current.consumed && initialSelection.current.userId === account) {
        initialSelection.current.consumed = true
        if (!selectedRef.current) selectWorkspace(initialWorkspaceSelection(result.workspaces, requestedWorkspaceRef.current))
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
    initialSelection.current = { userId, consumed: false }
    selectedRef.current = null; snapshotRef.current = null; pagesRef.current = PAGE_SIZE
    setOverview({ userId, workspaces: [], invitations: [] }); setSnapshot(null); setSelected(null); updateEditor(null)
    setError(''); setAccessLost(false); setBusy(''); setCreateName(''); setInviteName(''); setRenameName(''); setConfirmation(null)
    setMembersOpen(false); setSettingsOpen(false); setCreateOpen(false); setQuickTitle(''); setCompletedExpanded(false)
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
    if (!isDirty(currentEditor) && !quickTitle.trim()) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [currentEditor, quickTitle])
  useEffect(() => {
    if (!confirmation || !confirmationRef.current) return
    confirmationRef.current.focus({ preventScroll: true })
    confirmationRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [confirmation])
  useEffect(() => { onStateChange?.({ busy: Boolean(busy), dirty: isDirty(currentEditor) || Boolean(quickTitle.trim()) }) }, [busy, currentEditor, quickTitle, onStateChange])
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
    if (editorRef.current || quickTitle.trim()) return validate('Збережіть або закрийте чернетку завдання перед створенням іншого органайзера.')
    const name = createName.trim()
    if (!name || name.length > 100) return validate('Вкажіть назву від 1 до 100 символів.')
    void runAction('create', (account) => createSharedOrganizer(name, account), (result) => {
      setCreateName(''); setCreateOpen(false); selectWorkspace(result as string)
    }, 'Спільний органайзер створено')
  }
  const chooseWorkspace = (workspaceId: string) => {
    if (mutationLock.current !== null || selectedRef.current === workspaceId) return
    if (isDirty(editorRef.current) || quickTitle.trim()) setConfirmation({ kind: 'switch', id: workspaceId })
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
  const quickAdd = (event: FormEvent) => {
    event.preventDefault()
    const workspaceId = selectedRef.current, title = quickTitle.trim()
    if (!workspaceId || !title || title.length > 200 || editorRef.current || disabled) return
    void runAction('quick-add', (account) => saveSharedOrganizerTask(workspaceId, {
      title, notes: '', subject: '', due_date: null, due_at: null, assignee_id: filter === 'mine' ? account : null, completed: false,
    }, account), () => { setQuickTitle(''); setQuery('') }, 'Завдання додано', workspaceId)
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
    if (!workspaceId || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,29}$/u.test(username)) return validate('Вкажіть точний нік Xelay: від 3 до 30 літер, цифр, крапок, дефісів або підкреслень.')
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

  const closeEditor = () => { if (isDirty(editorRef.current)) setConfirmation({ kind: 'discard' }); else updateEditor(null) }
  const reserved = data ? data.workspace.member_count + data.invitations.length : 0
  const full = reserved >= SHARED_ORGANIZER_MEMBER_LIMIT
  const openTasks = visibleTasks.filter(task => !task.completed)
  const doneTasks = visibleTasks.filter(task => task.completed)
  const todayKyiv = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date())
  const taskOverdue = (task: SharedOrganizerTask) => !task.completed && (task.due_date ? task.due_date < todayKyiv : task.due_at ? Date.parse(task.due_at) < Date.now() : false)
  const taskLine = (task: SharedOrganizerTask, board = false) => <article key={task.id} className={`xso-task ${board ? 'xso-task-card' : ''} ${task.completed ? 'is-completed' : ''}`}>
    <button type="button" className="xso-check" disabled={disabled || currentEditor?.taskId === task.id} onClick={() => toggle(task)} aria-label={(task.completed ? 'Повернути у плани: ' : 'Позначити виконаним: ') + task.title}>{busy === 'task:' + task.id ? <Loader2 size={17} className="animate-spin" /> : task.completed ? <CheckCircle2 size={19} /> : <Circle size={19} />}</button>
    <button type="button" className="xso-task-title" disabled={disabled || Boolean(currentEditor && currentEditor.taskId !== task.id)} onClick={() => openEditor(task)} aria-label={'Відкрити завдання: ' + task.title}><span>{task.title}</span>{task.notes && <FileText size={13} aria-label="Є нотатки" />}</button>
    <span className="xso-task-subject" title={task.subject || 'Без предмета'}>{task.subject || <span className="xso-placeholder">Без предмета</span>}</span>
    <span className={'xso-task-due ' + (taskOverdue(task) ? 'is-overdue' : '')}>{task.due_date || task.due_at ? <><CalendarDays size={13} />{task.due_date ? dateOnlyLabel(task.due_date) : dueLabel(task.due_at!)}</> : <span className="xso-placeholder">Без дедлайну</span>}</span>
    <span className="xso-task-person" title={task.assignee_id ? personName(members.get(task.assignee_id)) : 'Усі учасники'}><span className={'xso-avatar xso-avatar-small ' + (!task.assignee_id ? 'xso-avatar-everyone' : '')} aria-hidden="true">{task.assignee_id ? personName(members.get(task.assignee_id)).slice(0, 1) : <Users size={13} />}</span><span>{task.assignee_id ? personName(members.get(task.assignee_id)) : 'Усі учасники'}</span></span>
    <button type="button" className="xso-row-action" disabled={disabled || Boolean(currentEditor && currentEditor.taskId !== task.id)} onClick={() => openEditor(task)} aria-label={'Редагувати: ' + task.title}><Pencil size={14} /></button>
  </article>

  if (!accountCurrent) return null
  return <section aria-label="Спільний органайзер" className="xso">
    <aside className="xso-sidebar" aria-label="Спільні простори">
      <div className="xso-sidebar-brand"><span className="xso-brand-icon"><BookOpen size={20} /></span><div><strong>Разом</strong><span>Спільні простори Xelay</span></div></div>
      <div className="xso-sidebar-caption"><span>ВАШІ ПРОСТОРИ</span><button type="button" className="xso-icon" onClick={() => setCreateOpen(true)} disabled={disabled || Boolean(currentEditor)} aria-label="Створити спільний органайзер"><Plus size={16} /></button></div>
      {overviewLoading && !workspaces.length ? <p role="status" className="xso-sidebar-loading"><Loader2 size={15} className="animate-spin" />Завантажуємо…</p> : <nav className="xso-workspace-nav" aria-label="Вибір спільного органайзера">{workspaces.map((workspace) => <button type="button" key={workspace.id} className={'xso-workspace-link ' + (workspace.id === selected ? 'is-selected' : '')} disabled={disabled} onClick={() => chooseWorkspace(workspace.id)} aria-current={workspace.id === selected ? 'page' : undefined}><Hash size={16} /><span>{workspace.name}</span><small>{workspace.member_count}</small></button>)}</nav>}
      <button type="button" className="xso-sidebar-add" onClick={() => setCreateOpen(true)} disabled={disabled || Boolean(currentEditor)}><Plus size={15} />Новий простір</button>
      {invitations.length > 0 && <details className="xso-inbox"><summary><UserPlus size={15} />Вас запрошують<span>{invitations.length}</span></summary><div className="xso-inbox-list">{invitations.map(invitation => <div className="xso-inbox-item" key={invitation.id}><strong>{invitation.workspace_name}</strong><span>Від {invitation.inviter_name}</span><small>До {dueLabel(invitation.expires_at)}</small><div><button type="button" className={primaryClass} disabled={disabled || Boolean(currentEditor) || Boolean(quickTitle.trim())} onClick={() => void runAction('accept:' + invitation.id, account => respondSharedOrganizerInvitation(invitation.id, true, account), result => { if (result) selectWorkspace(result as string) }, 'Запрошення прийнято')}><Check size={14} />Прийняти</button><button type="button" className="xso-icon" disabled={disabled} aria-label={'Відхилити запрошення до ' + invitation.workspace_name} onClick={() => void runAction('decline:' + invitation.id, account => respondSharedOrganizerInvitation(invitation.id, false, account), () => {}, 'Запрошення відхилено')}>×</button></div></div>)}{(currentEditor || quickTitle.trim()) && <p className="xso-hint">Збережіть чернетку, щоб прийняти запрошення.</p>}</div></details>}
      <div className="xso-sidebar-foot"><Users size={16} /><p>Один простір.<br /><strong>До {SHARED_ORGANIZER_MEMBER_LIMIT} своїх людей.</strong></p></div>
    </aside>
    <div className="xso-main">
      <header className="xso-topbar"><div className="xso-breadcrumb"><span>Спільний органайзер</span>{data && <><ChevronRight size={13} /><strong>{data.workspace.name}</strong></>}</div><div className="xso-topbar-actions"><button type="button" className="xso-icon" disabled={disabled || refreshing || overviewLoading || loadingMore} onClick={() => void refresh(false)} aria-label="Оновити спільні органайзери"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /></button>{data && <><button type="button" className="xso-people-button" onClick={() => setMembersOpen(true)} disabled={disabled} aria-label={'Учасники та запрошення: ' + data.workspace.member_count + ' з ' + SHARED_ORGANIZER_MEMBER_LIMIT}><span className="xso-avatar-stack" aria-hidden="true">{data.members.slice(0, 3).map(member => <span key={member.user_id} className="xso-avatar">{personName(member).slice(0, 1)}</span>)}</span><span>{data.workspace.member_count}<span className="xso-capacity">/{SHARED_ORGANIZER_MEMBER_LIMIT}</span></span>{owner && <UserPlus size={15} />}</button><button type="button" className="xso-icon" onClick={() => setSettingsOpen(true)} disabled={disabled} aria-label="Налаштування спільного органайзера"><MoreHorizontal size={20} /></button></>}</div></header>
      <div className="xso-content">
        {error && <div role="alert" className="xso-alert"><AlertCircle size={17} /><p>{error}</p></div>}
        {accessLost ? <div className="xso-empty"><Users size={32} /><h3>Доступ до простору змінився</h3><p>Перевіримо підписку та доступні вам спільні органайзери.</p><button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => {
          if (mutationLock.current !== null) return
          setBusy('access'); const account = userId, generation = epoch.current
          void refreshBilling().then(ok => { if (!own(account, generation)) return; if (ok) { accessRef.current = true; setAccessLost(false); setError(''); void loaders.current.overview() } }).finally(() => { if (own(account, generation)) setBusy('') })
        }}><RefreshCw size={15} />Перевірити доступ</button></div> : <>
          {detailLoading && !data && <div className="xso-empty" role="status"><Loader2 size={25} className="animate-spin" /><p>Завантажуємо завдання й команду…</p></div>}
          {!overviewLoading && !workspaces.length && <div className="xso-welcome"><span className="xso-welcome-icon"><BookOpen size={35} /></span><p className="xso-eyebrow">МІСЦЕ ДЛЯ СПІЛЬНИХ СПРАВ</p><h2>Зібрати своїх.<br />Зробити разом.</h2><p>Навчання, проєкт чи підготовка до сесії.<br />Створіть простір і запросіть друзів за ніком.</p><button type="button" className={primaryClass} disabled={disabled} onClick={() => setCreateOpen(true)}><Plus size={17} />Створити перший простір</button><small>До {SHARED_ORGANIZER_MEMBER_LIMIT} учасників разом із вами</small></div>}
          {data && <>
            <div className="xso-page-heading"><span className="xso-page-icon"><BookOpen size={29} /></span><h2>{data.workspace.name}</h2><p>Спільні справи, зрозумілі дедлайни й ваші люди поруч.</p><div className="xso-page-meta"><span><Users size={13} />{data.workspace.member_count} учасників</span><span className="xso-sync"><i />Оновлюється автоматично</span></div></div>
            <div className="xso-viewbar"><div role="group" aria-label="Вигляд спільних завдань" className="xso-view-tabs"><button type="button" aria-pressed={display === 'list'} onClick={() => setDisplay('list')}><LayoutList size={16} />Список</button><button type="button" aria-pressed={display === 'board'} onClick={() => setDisplay('board')}><Columns2 size={16} />Дошка</button></div><button type="button" className="xso-add-task" disabled={disabled || Boolean(currentEditor)} onClick={() => openEditor()}><Plus size={16} />Нове завдання</button></div>
            <div className="xso-toolbar"><div className="xso-filters" role="group" aria-label="Фільтр спільних завдань">{([{ key: 'all', label: 'Усі' }, { key: 'mine', label: 'Мої' }, { key: 'pending', label: 'У планах' }, { key: 'done', label: 'Виконані' }] as const).map(item => <button type="button" key={item.key} aria-pressed={filter === item.key} disabled={disabled} onClick={() => setFilter(item.key)}>{item.label}{item.key === 'pending' && <small>{pending}</small>}</button>)}</div><label className="xso-search"><Search size={15} /><span className="sr-only">Пошук у завантажених завданнях</span><input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} disabled={disabled} placeholder="Знайти завдання…" /></label></div>
            {data.tasks.length < data.total && <p className="xso-loaded-note">Пошук, лічильники й фільтри застосовані до {data.tasks.length} завантажених завдань із {data.total}.</p>}
            {display === 'list' ? <div className="xso-task-list">
              <div className="xso-table-head" aria-hidden="true"><span /><span><FileText size={13} />Завдання</span><span><Hash size={13} />Предмет</span><span><CalendarDays size={13} />Дедлайн</span><span><Users size={13} />Відповідальний</span><span /></div>
              {(filter === 'done' ? doneTasks : openTasks).map(task => taskLine(task))}
              {filter !== 'done' && <form className="xso-quick-add" onSubmit={quickAdd}><Plus size={17} /><label className="sr-only" htmlFor={id + '-quick-task'}>Назва нового спільного завдання</label><input id={id + '-quick-task'} maxLength={200} value={quickTitle} onChange={event => setQuickTitle(event.target.value)} disabled={disabled || Boolean(currentEditor)} placeholder={filter === 'mine' ? 'Додати моє завдання…' : 'Додати завдання…'} /><button type="submit" disabled={disabled || !quickTitle.trim() || Boolean(currentEditor)}>{busy === 'quick-add' ? <Loader2 size={14} className="animate-spin" /> : 'Додати'}<span aria-hidden="true">↵</span></button></form>}
              {filter !== 'done' && doneTasks.length > 0 && <div className="xso-completed"><button type="button" className="xso-completed-toggle" aria-expanded={completedExpanded} onClick={() => setCompletedExpanded(!completedExpanded)}><ChevronRight size={15} className={completedExpanded ? 'is-expanded' : ''} />Виконані<span>{doneTasks.length}</span></button>{completedExpanded && doneTasks.map(task => taskLine(task))}</div>}
            </div> : <div className="xso-board">{([{ complete: false, label: 'У планах', rows: openTasks }, { complete: true, label: 'Виконані', rows: doneTasks }] as const).map(column => <section className="xso-board-column" key={column.label} aria-label={column.label}><h3><span className={column.complete ? 'xso-status-dot is-done' : 'xso-status-dot'} />{column.label}<small>{column.rows.length}</small></h3>{column.rows.map(task => taskLine(task, true))}{!column.rows.length && <p className="xso-board-empty">{column.complete ? 'Тут з’являться виконані справи' : 'Усе зроблено. Можна видихнути.'}</p>}{!column.complete && <button type="button" className="xso-board-add" disabled={disabled || Boolean(currentEditor)} onClick={() => openEditor()}><Plus size={15} />Додати завдання</button>}</section>)}</div>}
            {!visibleTasks.length && <div className="xso-empty xso-empty-small"><ListTodo size={25} /><h3>{data.total ? 'За цими умовами нічого не знайшли' : 'Чистий аркуш для вашої команди'}</h3><p>{data.total ? 'Спробуйте інший фільтр або пошуковий запит.' : 'Додайте першу справу в рядку вище або відкрийте нове завдання.'}</p></div>}
            {data.tasks.length < data.total && <button type="button" className={buttonClass + ' mt-4 w-full'} disabled={disabled || loadingMore || refreshing || detailLoading} onClick={() => void loaders.current.detail(false, true)}>{loadingMore && <Loader2 size={15} className="animate-spin" />}Показати ще · {data.tasks.length} із {data.total}</button>}
            <p className="xso-bottom-note">Цей простір бачать лише його учасники. Дедлайни — за київським часом.</p>
          </>}
        </>}
      </div>
    </div>
    {createOpen && !accessLost && <ChatDialog title="Новий спільний простір" busy={disabled} onClose={() => setCreateOpen(false)}><form onSubmit={create} className="space-y-4"><p className="text-sm leading-relaxed text-muted-foreground">Один простір для завдань вашої команди. Назву можна змінити пізніше.</p><label className="block"><span className="mb-1.5 block text-sm font-medium">Назва</span><input className={inputClass} maxLength={100} required value={createName} autoFocus onChange={event => setCreateName(event.target.value)} disabled={disabled} placeholder="Наприклад, Наш курсовий проєкт" /></label>{(currentEditor || quickTitle.trim()) && <p className="text-xs text-muted-foreground">Спочатку збережіть чернетку поточного завдання.</p>}<button className={primaryClass} disabled={disabled || Boolean(currentEditor) || Boolean(quickTitle.trim())}>{busy === 'create' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}Створити простір</button></form></ChatDialog>}
    {membersOpen && data && <ChatDialog title="Учасники простору" busy={disabled} onClose={() => setMembersOpen(false)}><div className="space-y-5"><div className="xso-members-heading"><div><strong>{data.workspace.member_count} із {SHARED_ORGANIZER_MEMBER_LIMIT} учасників</strong><p>{data.invitations.length ? `Зарезервовано місць: ${data.invitations.length}` : full ? 'Усі місця зайняті' : 'Додайте своїх людей за ніком Xelay'}</p></div><span className="xso-member-capacity">{reserved}/{SHARED_ORGANIZER_MEMBER_LIMIT}</span></div>
      {owner && <form onSubmit={invite} className="xso-invite-form"><label htmlFor={id + '-invite'}>Запросити за ніком</label><div><span aria-hidden="true">@</span><input id={id + '-invite'} value={inviteName.replace(/^@/, '')} maxLength={31} required autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setInviteName(event.target.value)} disabled={disabled || full} placeholder="нік_друга" /><button type="submit" disabled={disabled || full || !inviteName.trim()}>{busy === 'invite' ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}Запросити</button></div><p>{full ? `Усі ${SHARED_ORGANIZER_MEMBER_LIMIT} місць зайняті або зарезервовані. Скасуйте зайве запрошення, щоб звільнити місце.` : 'Людина отримає запрошення й сама його прийме. Нік можна скопіювати з її профілю.'}</p></form>}
      <ul className="xso-members-list">{data.members.map(member => <li key={member.user_id}><span className="xso-avatar" aria-hidden="true">{personName(member).slice(0, 1)}</span><div><strong>{personName(member)}{member.user_id === userId && <small> · ви</small>}</strong><span>{member.username ? '@' + member.username : 'Учасник Xelay'}{!member.is_premium && ' · неактивна підписка'}</span></div>{member.role === 'owner' ? <small className="xso-role">Власник</small> : owner && <button type="button" className="xso-icon xso-danger" disabled={disabled} onClick={() => setConfirmation({ kind: 'member', id: member.user_id })} aria-label={'Вилучити учасника ' + personName(member)}><LogOut size={15} /></button>}</li>)}</ul>
      {owner && data.invitations.length > 0 && <div><h3 className="xso-dialog-caption">ОЧІКУЮТЬ ВІДПОВІДІ · {data.invitations.length}</h3><ul className="xso-members-list">{data.invitations.map(invitation => <li key={invitation.id}><span className="xso-avatar xso-avatar-pending"><UserPlus size={15} /></span><div><strong>{invitation.invitee_name}</strong><span>@{invitation.invitee_username} · до {dueLabel(invitation.expires_at)}</span></div><button type="button" className="xso-icon" disabled={disabled} onClick={() => setConfirmation({ kind: 'invitation', id: invitation.id })} aria-label={'Скасувати запрошення для ' + invitation.invitee_name}><Trash2 size={15} /></button></li>)}</ul></div>}
      <p className="xso-hint">Для користування спільним органайзером кожному потрібна активна підписка «Учасник». Неактивні учасники зберігають своє місце й авторство.</p>
    </div></ChatDialog>}
    {settingsOpen && data && <ChatDialog title="Налаштування простору" busy={disabled} onClose={() => setSettingsOpen(false)}><div className="space-y-5"><p className="text-sm text-muted-foreground">{owner ? 'Ви — власник цього спільного простору.' : 'Ви — учасник цього спільного простору.'}</p>{owner ? <><button type="button" className={buttonClass} disabled={disabled} onClick={() => { setRenameName(data.workspace.name); renameVersion.current = data.workspace.updated_at; setRenameOpen(!renameOpen) }} aria-expanded={renameOpen}><Pencil size={15} />Змінити назву</button>{renameOpen && <form onSubmit={rename} className="space-y-3"><label className="block"><span className="mb-1.5 block text-sm">Нова назва</span><input className={inputClass} required maxLength={100} value={renameName} onChange={event => setRenameName(event.target.value)} disabled={disabled} /></label><button className={primaryClass} disabled={disabled}>Зберегти назву</button></form>}<div className="border-t border-border pt-4"><p className="mb-3 text-sm text-muted-foreground">Архівування закриє доступ для команди. Завдання та історія збережуться.</p><button type="button" className={dangerClass} disabled={disabled} onClick={() => setConfirmation({ kind: 'archive', version: data.workspace.updated_at })}><Archive size={15} />Архівувати простір</button></div></> : <button type="button" className={dangerClass} disabled={disabled} onClick={() => setConfirmation({ kind: 'leave' })}><LogOut size={15} />Вийти з простору</button>}</div></ChatDialog>}
    {currentEditor && data && <ChatDialog title={currentEditor.taskId ? 'Завдання' : 'Нове завдання'} onClose={closeEditor} busy={disabled} wide><form onSubmit={save} className="xso-editor">
      {currentEditor.conflict && <div role="status" className="xso-conflict"><strong>{currentEditor.deleted ? 'Це завдання вже видалив інший учасник.' : 'Завдання змінилося, поки ви його редагували.'}</strong><p>Ваш текст залишається тут. {currentEditor.deleted ? 'Скопіюйте потрібне й створіть нове завдання.' : 'Відкрийте актуальну версію перед збереженням.'}</p>{currentEditor.latest && !currentEditor.deleted && <button type="button" className={buttonClass} disabled={disabled} onClick={() => setConfirmation({ kind: 'reload' })}>Відкрити актуальну версію</button>}</div>}
      <label className="xso-editor-title"><span className="sr-only">Назва завдання</span><input required maxLength={200} value={currentEditor.draft.title} disabled={disabled} onChange={event => patchDraft({ title: event.target.value })} placeholder="Назва завдання" autoFocus /></label>
      <div className="xso-properties"><label><span><Hash size={15} />Предмет</span><input maxLength={120} value={currentEditor.draft.subject} disabled={disabled} onChange={event => patchDraft({ subject: event.target.value })} placeholder="Необов’язково" /></label><label><span><Users size={15} />Відповідальний</span><select value={currentEditor.draft.assignee} disabled={disabled} onChange={event => patchDraft({ assignee: event.target.value })}><option value="">Усі учасники</option>{data.members.map(member => <option key={member.user_id} value={member.user_id} disabled={!member.is_premium}>{personName(member)}{member.is_premium ? '' : ' · неактивний'}</option>)}{currentEditor.draft.assignee && !members.has(currentEditor.draft.assignee) && <option value={currentEditor.draft.assignee} disabled>Колишній учасник · оберіть іншого</option>}</select></label><label><span><CalendarDays size={15} />Дедлайн</span><input type="date" value={currentEditor.draft.date} disabled={disabled} onChange={event => patchDraft({ date: event.target.value, timed: event.target.value ? currentEditor.draft.timed : false })} /></label><div className="xso-time-property"><label><input type="checkbox" checked={currentEditor.draft.timed} disabled={disabled || !currentEditor.draft.date} onChange={event => patchDraft({ timed: event.target.checked })} />Уточнити час</label>{currentEditor.draft.timed && <label><span className="sr-only">Час дедлайну за Києвом</span><input type="time" required value={currentEditor.draft.time} disabled={disabled} onChange={event => patchDraft({ time: event.target.value })} /></label>}<small>За Києвом</small></div><label className="xso-completion-property"><span><CheckCircle2 size={15} />Виконання</span><span><input type="checkbox" checked={currentEditor.draft.completed} disabled={disabled} onChange={event => patchDraft({ completed: event.target.checked })} />Завдання виконано</span></label></div>
      <label className="xso-editor-notes"><span>Нотатки та посилання</span><textarea maxLength={10000} value={currentEditor.draft.notes} disabled={disabled} onChange={event => patchDraft({ notes: event.target.value })} placeholder="Опишіть завдання, додайте план або корисне посилання…" /></label>
      {currentEditor.draft.notes && <details className="xso-note-preview"><summary>Відкрити посилання з нотаток<ChevronDown size={14} /></summary><p><SharedNoteLinks text={currentEditor.draft.notes} /></p></details>}
      {currentEditor.latest && <p className="xso-hint">Створив: {personName(members.get(currentEditor.latest.created_by))} · Оновив: {personName(members.get(currentEditor.latest.updated_by))} · {dueLabel(currentEditor.latest.updated_at)}</p>}
      <div className="xso-editor-footer"><div><button type="submit" className={primaryClass} disabled={disabled || currentEditor.conflict}>{busy === 'save' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}{busy === 'save' ? 'Зберігаємо…' : 'Зберегти'}</button><button type="button" className={buttonClass} disabled={disabled} onClick={closeEditor}>Скасувати</button></div>{currentEditor.taskId && <button type="button" className="xso-icon xso-danger" disabled={disabled} onClick={() => setConfirmation({ kind: 'task', id: currentEditor.taskId!, version: currentEditor.version! })} aria-label="Видалити це завдання"><Trash2 size={16} /></button>}</div><p className="xso-hint">{isDirty(currentEditor) ? 'Є незбережені зміни. Після збереження їх побачить команда.' : 'Зміни побачать усі учасники простору.'}</p>
    </form></ChatDialog>}
    {confirmation && <ChatDialog title="Підтвердження дії" busy={disabled} onClose={() => setConfirmation(null)}><div ref={confirmationRef} tabIndex={-1} role="alert" className="space-y-4 outline-none"><p className="text-sm leading-relaxed">{confirmationText}</p>{(isDirty(currentEditor) || quickTitle.trim()) && (confirmation.kind === 'archive' || confirmation.kind === 'leave' || confirmation.kind === 'switch' || (confirmation.kind === 'task' && confirmation.id === currentEditor?.taskId)) && <p className="text-xs text-destructive">Незбережені зміни у поточній чернетці буде втрачено.</p>}<div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled} onClick={() => setConfirmation(null)}>Залишити як є</button><button type="button" className={dangerClass} disabled={disabled} onClick={confirmAction}>{busy && <Loader2 size={16} className="animate-spin" />}Підтвердити</button></div></div></ChatDialog>}
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
