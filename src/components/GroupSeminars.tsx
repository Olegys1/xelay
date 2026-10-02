import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Loader2, Pencil, Plus, RefreshCw, Trash2, UsersRound, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { SeminarResourceFields, SeminarResourceList } from './SeminarResources'
import { SeminarComments } from './SeminarComments'
import { ShareStudyAssignment } from './ShareStudyAssignment'
import {
  cleanupPendingSeminarFiles, removeSeminarFiles, seminarResourceError, updateSeminarResources, uploadSeminarFiles,
  validateSeminarResources, type SeminarAttachment,
} from '../lib/seminarResources'
import {
  EMPTY_SEMINAR_DATA, SEMINAR_FORMATS, SEMINAR_WEEKDAYS, Seminar, SeminarData, SeminarFormat, SeminarProfile, SeminarQuestion, SeminarReservation, SeminarSchedule, SeminarSubject,
  addSeminarDays, formatSeminarDate, kyivToday, loadSeminars, scheduleOnDate, seminarError, seminarHasStarted, seminarRpc, seminarStartMilliseconds, seminarWeek,
} from '../lib/seminars'

type Props = {
  groupId: string; groupName?: string; currentUserId: string; canEdit: boolean; selectedDate: string; onDateChange: (date: string) => void
  canManageResources?: boolean; canModerateComments?: boolean
  highlightedAssignmentId?: string; focusHighlightedAssignment?: boolean; onHighlightedAssignmentFocus?: () => void
}
type SubjectEditor = { id: string | null; name: string }
type ScheduleEditor = {
  id: string | null; subject_id: string; weekday: number; starts_at: string; ends_at: string; valid_from: string; valid_until: string
}
type QuestionDraft = { id?: string; body: string; primary_capacity: number }
type TeamDraft = { id?: string; name: string; capacity: number }
type AssignmentEditor = {
  id: string | null; schedule_id: string; lesson_date: string; title: string; instructions: string
  format: SeminarFormat; questions: QuestionDraft[]; teams: TeamDraft[]
  links: string[]; files: File[]; attachments: SeminarAttachment[]
}
type ResourcesEditor = { id: string; title: string; links: string[]; files: File[]; attachments: SeminarAttachment[] }
type DeleteTarget = { kind: 'subject' | 'schedule' | 'seminar'; id: string; name: string }
type SupplementChoice = { seminarId: string; questionId: string; question: string }

const inputClass = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none sm:text-sm transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50 motion-reduce:transition-none'
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const iconButton = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40 motion-reduce:transition-none'

function assignmentError(error: unknown) {
  const message = (error as { message?: string })?.message || ''
  return error instanceof Error || message.includes('SEMINAR_RESOURCE_')
    ? seminarResourceError(error) : seminarError(error)
}

function Participant({ id, profile, currentUserId }: { id: string; profile?: SeminarProfile; currentUserId: string }) {
  const name = profile?.full_name || profile?.username || 'Учасник групи'
  const initials = name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()
  return (
    <Link to="/user/$id" params={{ id }} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background px-2.5 py-2 transition-colors hover:border-primary/30 hover:bg-primary/5 motion-reduce:transition-none" aria-label={`Переглянути профіль: ${name}`}>
      {profile?.avatar_url ? <img src={profile.avatar_url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold" aria-hidden="true">{initials}</span>}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{name}{id === currentUserId && <span className="ml-1 text-xs text-primary">· Ви</span>}</span>{profile?.username && <span className="block truncate text-xs text-muted-foreground">@{profile.username.replace(/^@/, '')}</span>}</span>
    </Link>
  )
}

function Dialog({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    container.current?.focus()
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-3 py-5 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close.current() }}>
      <div ref={container} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl outline-none" onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) close.current()
        if (event.key !== 'Tab') return
        const elements = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []).filter((element) => element.offsetParent !== null)
        const first = elements[0]; const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last.focus() }
        if (!event.shiftKey && (document.activeElement === last || document.activeElement === container.current)) { event.preventDefault(); first.focus() }
      }}>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4"><h2 className="text-lg font-semibold">{title}</h2><button type="button" disabled={busy} onClick={onClose} className={iconButton} aria-label="Закрити"><X size={19} /></button></header>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-1.5"><span className="block text-sm font-medium">{label}</span>{children}</label>
}

export function GroupSeminars(props: Props) {
  return <GroupSeminarsWorkspace key={`${props.groupId}:${props.currentUserId}`} {...props} />
}

function GroupSeminarsWorkspace({ groupId, groupName = 'Навчальна група', currentUserId, canEdit, canManageResources = canEdit, canModerateComments = canEdit, selectedDate, onDateChange, highlightedAssignmentId, focusHighlightedAssignment = true, onHighlightedAssignmentFocus }: Props) {
  const [data, setData] = useState<SeminarData>(EMPTY_SEMINAR_DATA)
  const [loading, setLoading] = useState(true)
  const [loadedDate, setLoadedDate] = useState('')
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState('')
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null)
  const [subjectId, setSubjectId] = useState('')
  const [subjectEditor, setSubjectEditor] = useState<SubjectEditor | null>(null)
  const [scheduleEditor, setScheduleEditor] = useState<ScheduleEditor | null>(null)
  const [assignmentEditor, setAssignmentEditor] = useState<AssignmentEditor | null>(null)
  const [resourcesEditor, setResourcesEditor] = useState<ResourcesEditor | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [supplementChoice, setSupplementChoice] = useState<SupplementChoice | null>(null)
  const [cancelSeminar, setCancelSeminar] = useState<Seminar | null>(null)
  const [clockVersion, setClockVersion] = useState(0)
  const request = useRef(0)
  const alive = useRef(true)
  const mutation = useRef(false)
  const refreshPending = useRef(false)
  const latestData = useRef(data)
  latestData.current = data
  const latestPermissions = useRef({ canEdit, canManageResources, canModerateComments })
  latestPermissions.current = { canEdit, canManageResources, canModerateComments }

  const reload = useCallback(async () => {
    const sequence = ++request.current
    setLoading(true)
    setError('')
    try {
      const next = await loadSeminars(groupId, selectedDate)
      if (!alive.current || sequence !== request.current) return
      setData(next)
      setLoadedDate(selectedDate)
      setSubjectId((previous) => previous && !next.subjects.some((subject) => subject.id === previous) ? '' : previous)
    } catch (loadError) {
      if (alive.current && sequence === request.current) setError(seminarError(loadError))
    } finally {
      if (alive.current && sequence === request.current) setLoading(false)
    }
  }, [groupId, currentUserId, selectedDate])
  const latestReload = useRef(reload)
  latestReload.current = reload

  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current += 1 } }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (highlightedAssignmentId) setSubjectId('') }, [highlightedAssignmentId])
  useEffect(() => {
    if (!highlightedAssignmentId || !focusHighlightedAssignment || loadedDate !== selectedDate
      || !data.seminars.some((item) => item.id === highlightedAssignmentId)) return
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`study-seminar-${highlightedAssignmentId}`)
      if (!card) return
      card.focus({ preventScroll: true })
      card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
      onHighlightedAssignmentFocus?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [highlightedAssignmentId, focusHighlightedAssignment, loadedDate, selectedDate, data.seminars, subjectId, onHighlightedAssignmentFocus])
  useEffect(() => { void cleanupPendingSeminarFiles().catch(() => undefined) }, [groupId, currentUserId])
  useEffect(() => {
    const refresh = () => {
      if (!mutation.current) {
        void reload()
        void cleanupPendingSeminarFiles().catch(() => undefined)
      }
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [reload])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!alive.current) return
        if (mutation.current) { refreshPending.current = true; return }
        void latestReload.current()
      }, 300)
    }
    // DELETE payloads contain only IDs under RLS, so their group cannot be
    // filtered by Realtime. Only IDs already known in this group are handled.
    const removed = (kind: 'subjects' | 'schedule' | 'seminars') => (payload: { old: Record<string, unknown> }) => {
      const id = typeof payload.old?.id === 'string' ? payload.old.id : ''
      if (id && latestData.current[kind].some((item) => item.id === id)) changed()
    }
    const channel = supabase.channel(`group-seminars:${groupId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_seminar_subjects', filter: `group_id=eq.${groupId}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_seminar_schedule', filter: `group_id=eq.${groupId}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_seminars', filter: `group_id=eq.${groupId}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_seminar_reservations', filter: `group_id=eq.${groupId}` }, changed)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_seminar_subjects' }, removed('subjects'))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_seminar_schedule' }, removed('schedule'))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_seminars' }, removed('seminars'))
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      refreshPending.current = false
      void supabase.removeChannel(channel).catch(() => undefined)
    }
  }, [groupId])

  const runMutation = async (name: string, action: () => Promise<unknown>, onSuccess?: () => void, inDialog = false, describeError = seminarError) => {
    if (mutation.current) return
    if (['subject', 'schedule', 'assignment', 'delete'].includes(name) && !latestPermissions.current.canEdit) return
    if (name === 'resources' && !latestPermissions.current.canManageResources) return
    mutation.current = true
    setBusy(name)
    setError(''); setFormError('')
    try {
      await action()
      if (name === 'delete') await cleanupPendingSeminarFiles().catch(() => undefined)
      if (!alive.current) return
      onSuccess?.()
      await latestReload.current()
    } catch (mutationError) {
      if (alive.current) {
        if (inDialog) setFormError(describeError(mutationError))
        else setError(describeError(mutationError))
      }
    } finally {
      mutation.current = false
      if (alive.current) setBusy('')
      if (refreshPending.current && alive.current) {
        refreshPending.current = false
        void latestReload.current()
      }
    }
  }

  const selectedSubject = data.subjects.find((subject) => subject.id === subjectId)
  const week = seminarWeek(selectedDate)
  const visibleSchedule = data.schedule.filter((slot) => !subjectId || slot.subject_id === subjectId)
  const daySlots = useMemo(() => visibleSchedule.filter((slot) => scheduleOnDate(slot, selectedDate) || data.seminars.some((seminar) => seminar.schedule_id === slot.id)).sort((a, b) => {
    const aTime = data.seminars.find((seminar) => seminar.schedule_id === a.id)?.starts_at || a.starts_at
    const bTime = data.seminars.find((seminar) => seminar.schedule_id === b.id)?.starts_at || b.starts_at
    return aTime.localeCompare(bTime)
  }), [visibleSchedule, selectedDate, data.seminars])
  useEffect(() => {
    if (loadedDate !== selectedDate) return
    const now = Date.now()
    const starts = daySlots.map((slot) => {
      const seminar = data.seminars.find((item) => item.schedule_id === slot.id)
      return seminarStartMilliseconds(seminar || { lesson_date: selectedDate, starts_at: slot.starts_at })
    }).filter((instant) => Number.isFinite(instant) && instant > now)
    if (!starts.length) return
    const next = Math.min(...starts)
    const timer = setTimeout(() => setClockVersion((version) => version + 1), Math.min(next - now + 100, 2147483647))
    return () => clearTimeout(timer)
  }, [data.seminars, daySlots, loadedDate, selectedDate, clockVersion])
  const profileFor = (id: string) => data.profiles[id]
  const reservationsFor = (seminarId: string) => data.reservations.filter((item) => item.seminar_id === seminarId)
  const anyDialog = Boolean(subjectEditor || scheduleEditor || assignmentEditor || resourcesEditor || deleteTarget || supplementChoice || cancelSeminar)
  const closeDialog = () => {
    setSubjectEditor(null); setScheduleEditor(null); setAssignmentEditor(null); setResourcesEditor(null); setDeleteTarget(null); setSupplementChoice(null); setCancelSeminar(null); setFormError('')
  }
  useEffect(() => {
    if (!canEdit) { setSubjectEditor(null); setScheduleEditor(null); setAssignmentEditor(null); setDeleteTarget(null) }
    if (!canManageResources) {
      setResourcesEditor(null)
      setAssignmentEditor((draft) => {
        if (!draft) return null
        const saved = draft.id ? data.seminars.find((item) => item.id === draft.id) : null
        return { ...draft, files: [], links: saved?.resource_links || [], attachments: saved?.resource_attachments || [] }
      })
    }
  }, [canEdit, canManageResources, data.seminars])
  useEffect(() => {
    if (loading || loadedDate !== selectedDate) return
    setResourcesEditor((draft) => draft && !data.seminars.some((seminar) => seminar.id === draft.id) ? null : draft)
  }, [data.seminars, loading, loadedDate, selectedDate])
  const openSubject = (subject?: SeminarSubject) => {
    if (!latestPermissions.current.canEdit || mutation.current) return
    setFormError(''); setSubjectEditor({ id: subject?.id || null, name: subject?.name || '' })
  }
  const openSchedule = (slot?: SeminarSchedule) => {
    if (!latestPermissions.current.canEdit || mutation.current) return
    setFormError('')
    setScheduleEditor(slot ? { id: slot.id, subject_id: slot.subject_id, weekday: slot.weekday, starts_at: slot.starts_at.slice(0, 5), ends_at: slot.ends_at.slice(0, 5), valid_from: slot.valid_from, valid_until: slot.valid_until } : {
      id: null, subject_id: subjectId || data.subjects[0]?.id || '', weekday: new Date(`${selectedDate}T12:00:00`).getDay() || 7,
      starts_at: '09:00', ends_at: '10:20', valid_from: selectedDate, valid_until: addSeminarDays(selectedDate, 90),
    })
  }
  const openAssignment = (slot: SeminarSchedule, seminar?: Seminar) => {
    if (!latestPermissions.current.canEdit || mutation.current) return
    setFormError('')
    setAssignmentEditor({
      id: seminar?.id || null, schedule_id: slot.id, lesson_date: seminar?.lesson_date || selectedDate,
      title: seminar?.title || '', instructions: seminar?.instructions || '', format: seminar?.format || 'questions',
      questions: seminar ? data.questions.filter((item) => item.seminar_id === seminar.id).map((item) => ({ id: item.id, body: item.body, primary_capacity: item.primary_capacity })) : [{ body: '', primary_capacity: 1 }],
      teams: seminar ? data.teams.filter((item) => item.seminar_id === seminar.id).map((item) => ({ id: item.id, name: item.name, capacity: item.capacity })) : [{ name: 'Команда 1', capacity: 5 }, { name: 'Команда 2', capacity: 5 }],
      links: seminar?.resource_links || [], files: [], attachments: seminar?.resource_attachments || [],
    })
  }
  const saveAssignment = (event: FormEvent) => {
    event.preventDefault()
    if (!assignmentEditor || mutation.current || !latestPermissions.current.canEdit) return
    const draft = assignmentEditor
    const questions = draft.questions.map((question) => ({ ...question, body: question.body.trim() }))
    const teams = draft.teams.map((team) => ({ ...team, name: team.name.trim() }))
    if (!draft.title.trim() || (draft.format !== 'teams'
      ? !questions.length || questions.some((question) => !question.body)
      : !teams.length || teams.some((team) => !team.name))) {
      setFormError('Заповніть назву завдання та всі питання або назви команд.')
      return
    }
    const managesResources = latestPermissions.current.canManageResources
    const saved = draft.id ? latestData.current.seminars.find((item) => item.id === draft.id) : null
    const files = managesResources ? draft.files : []
    let resources: ReturnType<typeof validateSeminarResources>
    try { resources = validateSeminarResources(managesResources ? draft.links : saved?.resource_links || [], files, managesResources ? draft.attachments : saved?.resource_attachments || []) }
    catch (validationError) { setFormError(seminarResourceError(validationError)); return }
    void runMutation('assignment', async () => {
      setUploadProgress(files.length ? { completed: 0, total: files.length } : null)
      try {
        const uploaded = await uploadSeminarFiles(groupId, currentUserId, files, (completed, total) => {
          if (!alive.current || !latestPermissions.current.canEdit || !latestPermissions.current.canManageResources) throw new Error('Доступ до редагування змінився. Оновіть список семінарів.')
          if (alive.current) setUploadProgress({ completed, total })
        })
        try {
          if (!alive.current) throw new Error('Збереження скасовано. Відкрийте завдання та спробуйте ще раз.')
          if (!latestPermissions.current.canEdit || (managesResources && !latestPermissions.current.canManageResources)) throw new Error('Доступ до редагування змінився. Оновіть список семінарів.')
          await seminarRpc('xelay_save_seminar_with_resources', {
            p_group_id: groupId, p_seminar_id: draft.id, p_schedule_id: draft.schedule_id,
            p_lesson_date: draft.lesson_date, p_title: draft.title.trim(), p_instructions: draft.instructions.trim(),
            p_format: draft.format, p_questions: draft.format !== 'teams' ? questions : [],
            p_teams: draft.format === 'teams' ? teams : [],
            p_resource_links: resources.links, p_resource_attachments: [...resources.attachments, ...uploaded],
          })
        } catch (saveError) {
          // Storage refuses to remove a file linked by a committed save whose
          // response was lost; only unlinked uploads can be cleaned up here.
          await removeSeminarFiles(uploaded.map((file) => file.storage_path)).catch(() => undefined)
          throw saveError
        }
        await cleanupPendingSeminarFiles().catch(() => undefined)
      } finally { if (alive.current) setUploadProgress(null) }
    }, closeDialog, true, assignmentError)
  }
  const openResources = (seminar: Seminar) => {
    if (!latestPermissions.current.canManageResources || mutation.current) return
    setFormError('')
    setResourcesEditor({ id: seminar.id, title: seminar.title, links: seminar.resource_links, files: [], attachments: seminar.resource_attachments })
  }
  const saveResources = (event: FormEvent) => {
    event.preventDefault()
    if (!resourcesEditor || mutation.current || !latestPermissions.current.canManageResources) return
    const draft = resourcesEditor
    let resources: ReturnType<typeof validateSeminarResources>
    try { resources = validateSeminarResources(draft.links, draft.files, draft.attachments) }
    catch (validationError) { setFormError(seminarResourceError(validationError)); return }
    void runMutation('resources', async () => {
      setUploadProgress(draft.files.length ? { completed: 0, total: draft.files.length } : null)
      try {
        const uploaded = await uploadSeminarFiles(groupId, currentUserId, draft.files, (completed, total) => {
          if (!alive.current || !latestPermissions.current.canManageResources) throw new Error('Доступ до матеріалів змінився. Оновіть список семінарів.')
          setUploadProgress({ completed, total })
        })
        try {
          if (!alive.current || !latestPermissions.current.canManageResources) throw new Error('Доступ до матеріалів змінився. Оновіть список семінарів.')
          await updateSeminarResources(draft.id, resources.links, [...resources.attachments, ...uploaded])
        } catch (saveError) {
          await removeSeminarFiles(uploaded.map((file) => file.storage_path)).catch(() => undefined)
          throw saveError
        }
        await cleanupPendingSeminarFiles().catch(() => undefined)
      } finally { if (alive.current) setUploadProgress(null) }
    }, closeDialog, true, seminarResourceError)
  }
  const choose = (seminar: Seminar, role: SeminarReservation['role'], targetId: string, question?: SeminarQuestion) => {
    if (role === 'primary' && (data.streaks[seminar.id] || 0) >= 3 && question) {
      setFormError(''); setSupplementChoice({ seminarId: seminar.id, questionId: question.id, question: question.body }); return
    }
    void runMutation(`reserve:${seminar.id}`, () => seminarRpc('xelay_reserve_seminar', { p_seminar_id: seminar.id, p_role: role, p_target_id: targetId }))
  }

  const renderPeople = (userIds: string[], empty: string) => userIds.length ? <div className="grid min-w-0 gap-2 sm:grid-cols-2">{userIds.map((id) => <Participant key={id} id={id} profile={profileFor(id)} currentUserId={currentUserId} />)}</div> : <p className="text-xs text-muted-foreground">{empty}</p>

  const renderAssignment = (seminar: Seminar, slot: SeminarSchedule) => {
    const reservations = reservationsFor(seminar.id)
    const mine = reservations.find((item) => item.user_id === currentUserId)
    const locked = seminarHasStarted(seminar)
    const streak = data.streaks[seminar.id] || 0
    const myQuestion = data.questions.find((item) => item.id === mine?.question_id)
    const myTeam = data.teams.find((item) => item.id === mine?.team_id)
    return (
      <article key={seminar.id} id={`study-seminar-${seminar.id}`} tabIndex={-1} className={`xelay-card min-w-0 overflow-hidden outline-none ${highlightedAssignmentId === seminar.id ? 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background' : ''}`}>
        <header className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
          <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-primary">{data.subjects.find((subject) => subject.id === seminar.subject_id)?.name || 'Семінар'}</p><h3 className="mt-1 break-words text-lg font-semibold">{seminar.title}</h3><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><Clock3 size={13} />{seminar.starts_at.slice(0, 5)}–{seminar.ends_at.slice(0, 5)}</span><span>{SEMINAR_FORMATS.find((format) => format.id === seminar.format)?.label || 'Семінар'}</span>{locked && <span>Вибір завершено</span>}</div></div>
          <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
            <ShareStudyAssignment assignment={{ kind: 'seminar', id: seminar.id, groupId, groupName, title: seminar.title, subject: data.subjects.find((subject) => subject.id === seminar.subject_id)?.name || 'Семінар', date: seminar.lesson_date }} currentUserId={currentUserId} />
            {canEdit && !locked && <div className="flex"><button disabled={Boolean(busy)} onClick={() => openAssignment(slot, seminar)} className={iconButton} aria-label="Редагувати завдання"><Pencil size={16} /></button><button disabled={Boolean(busy) || (!canManageResources && Boolean(seminar.resource_links.length || seminar.resource_attachments.length))} title={!canManageResources && Boolean(seminar.resource_links.length || seminar.resource_attachments.length) ? 'Для видалення завдання з матеріалами потрібне також право керувати матеріалами' : 'Видалити завдання'} onClick={() => { if (!latestPermissions.current.canEdit) return; setFormError(''); setDeleteTarget({ kind: 'seminar', id: seminar.id, name: seminar.title }) }} className={iconButton} aria-label="Видалити завдання"><Trash2 size={16} /></button></div>}
          </div>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          {seminar.instructions && <details open={seminar.instructions.length < 700} className="rounded-xl bg-muted/50 p-3"><summary className="cursor-pointer text-sm font-medium">Умови завдання</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{seminar.instructions}</p></details>}
          <SeminarResourceList links={seminar.resource_links} attachments={seminar.resource_attachments} />
          {canManageResources && <button type="button" disabled={Boolean(busy)} onClick={() => openResources(seminar)} className={secondaryButton}><Pencil size={15} />{seminar.resource_links.length || seminar.resource_attachments.length ? 'Редагувати матеріали' : 'Додати матеріали'}</button>}
          {seminar.format === 'questions' && <div className="rounded-xl border border-primary/10 bg-primary/5 p-3 text-sm"><p className="font-medium">Ваша серія до цього заняття: {streak} із 3</p><p className="mt-1 text-xs text-muted-foreground">{streak >= 3 ? 'Цього разу оберіть доповнення до питання. Після цього серія почнеться знову.' : 'Після трьох основних відповідей поспіль наступне заняття — у ролі доповнювача.'}</p></div>}
          {mine && <div className="flex flex-col gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between"><p className="min-w-0 break-words text-sm"><Check size={15} className="mr-1 inline text-primary" />Ваш вибір: <strong>{mine.role === 'team' ? myTeam?.name || 'Команда' : mine.role === 'booking' ? 'Заброньоване питання' : mine.role === 'primary' ? 'Основна відповідь' : 'Доповнення'}</strong>{myQuestion && <span className="mt-1 block text-xs text-muted-foreground">{myQuestion.body}</span>}</p>{!locked && <button disabled={Boolean(busy)} onClick={() => { setFormError(''); setCancelSeminar(seminar) }} className="shrink-0 self-start text-sm font-medium text-primary hover:underline disabled:opacity-50">Скасувати вибір</button>}</div>}
          {!locked && <p className="text-xs text-muted-foreground">Один вибір на заняття. Оберіть інше питання або команду, щоб перейти; попереднє місце звільниться після успішного переходу.</p>}
          {seminar.format === 'questions' ? <div className="space-y-3">{data.questions.filter((question) => question.seminar_id === seminar.id).map((question, index) => {
            const primary = reservations.filter((item) => item.question_id === question.id && item.role === 'primary')
            const supplements = reservations.filter((item) => item.question_id === question.id && item.role === 'supplement')
            const myPrimary = mine?.question_id === question.id && mine.role === 'primary'
            const mySupplement = mine?.question_id === question.id && mine.role === 'supplement'
            const primaryFull = primary.length >= question.primary_capacity
            const supplementsFull = supplements.length >= 3
            return <section key={question.id} className="rounded-2xl border border-border p-3 sm:p-4"><div className="flex gap-2.5"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{index + 1}</span><p className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">{question.body}</p></div><div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2"><div className="min-w-0"><h4 className="mb-2 text-xs font-semibold text-muted-foreground">Основні відповідачі · {primary.length} із {question.primary_capacity}</h4>{renderPeople(primary.map((item) => item.user_id), 'Ще ніхто не зайняв питання.')}<button disabled={Boolean(busy) || locked || myPrimary || (streak >= 3 ? supplementsFull && !mySupplement : primaryFull)} onClick={() => choose(seminar, 'primary', question.id, question)} className={`${myPrimary ? secondaryButton : primaryButton} mt-3 w-full`}>
              {busy === `reserve:${seminar.id}` ? <Loader2 size={14} className="animate-spin" /> : myPrimary ? <Check size={14} /> : null}{myPrimary ? 'Ваша основна відповідь' : locked ? 'Вибір завершено' : streak >= 3 ? 'Стати доповнювачем' : primaryFull ? 'Усі місця зайняті' : 'Відповісти на питання'}
            </button></div><div className="min-w-0 rounded-xl bg-muted/40 p-3"><h4 className="mb-2 text-xs font-semibold text-muted-foreground">Доповнювачі · {supplements.length} із 3</h4>{renderPeople(supplements.map((item) => item.user_id), 'Можна доповнити відповідь одногрупника.')}<button disabled={Boolean(busy) || locked || mySupplement || supplementsFull} onClick={() => choose(seminar, 'supplement', question.id)} className={`${secondaryButton} mt-3 w-full`}>{mySupplement ? <Check size={14} /> : <Plus size={14} />}{mySupplement ? 'Ваше доповнення' : supplementsFull ? 'Три місця зайняті' : 'Доповнити відповідь'}</button></div></div></section>
          })}</div> : seminar.format === 'booking' ? <div className="space-y-3">
            <p className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">Оберіть питання для підготовки. Викладач визначить доповідачів на занятті. Бронювання не впливає на серію основних відповідей.</p>
            {data.questions.filter((question) => question.seminar_id === seminar.id).map((question, index) => {
              const members = reservations.filter((item) => item.question_id === question.id && item.role === 'booking')
              const mineHere = mine?.question_id === question.id && mine.role === 'booking'
              const full = members.length >= question.primary_capacity
              return <section key={question.id} className={`min-w-0 rounded-2xl border p-3 sm:p-4 ${mineHere ? 'border-primary/30 bg-primary/5' : 'border-border'}`}>
                <div className="flex items-start gap-2.5"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{index + 1}</span><p className="min-w-0 whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">{question.body}</p></div>
                <h4 className="mb-2 mt-4 text-xs font-semibold text-muted-foreground">Учасники · {members.length} із {question.primary_capacity}</h4>
                {renderPeople(members.map((item) => item.user_id), 'Питання ще можна забронювати.')}
                <button disabled={Boolean(busy) || locked || mineHere || full} onClick={() => choose(seminar, 'booking', question.id)} className={`${mineHere ? secondaryButton : primaryButton} mt-3 w-full`}>
                  {busy === `reserve:${seminar.id}` ? <Loader2 size={15} className="animate-spin" /> : mineHere ? <Check size={15} /> : <BookOpen size={15} />}
                  {mineHere ? 'Ваше бронювання' : locked ? 'Вибір завершено' : full ? 'Усі місця зайняті' : mine ? 'Перейти до цього питання' : 'Забронювати питання'}
                </button>
              </section>
            })}
          </div> : <div className="grid min-w-0 gap-3 md:grid-cols-2">{data.teams.filter((team) => team.seminar_id === seminar.id).map((team) => {
            const members = reservations.filter((item) => item.team_id === team.id && item.role === 'team')
            const mineHere = mine?.team_id === team.id
            const full = members.length >= team.capacity
            return <section key={team.id} className={`flex min-w-0 flex-col rounded-2xl border p-4 ${mineHere ? 'border-primary/30 bg-primary/5' : 'border-border'}`}><div className="mb-3 flex items-start justify-between gap-2"><h4 className="break-words font-semibold">{team.name}</h4><span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs">{members.length} із {team.capacity}</span></div><div className="flex-1 space-y-2">{members.length ? members.map((item) => <Participant key={item.user_id} id={item.user_id} profile={profileFor(item.user_id)} currentUserId={currentUserId} />) : <p className="py-3 text-sm text-muted-foreground">Перший учасник може приєднатися.</p>}</div><button disabled={Boolean(busy) || locked || mineHere || full} onClick={() => choose(seminar, 'team', team.id)} className={`${mineHere ? secondaryButton : primaryButton} mt-4 w-full`}>{busy === `reserve:${seminar.id}` ? <Loader2 size={15} className="animate-spin" /> : mineHere ? <Check size={15} /> : <UsersRound size={15} />}{mineHere ? 'Ваша команда' : locked ? 'Вибір завершено' : full ? 'Команда заповнена' : mine ? 'Перейти до команди' : 'Приєднатися'}</button></section>
          })}</div>}
          {seminar.format === 'teams' && <p className="text-xs text-muted-foreground">Командна робота не впливає на вашу серію індивідуальних відповідей.</p>}
          <SeminarComments key={seminar.id} seminarId={seminar.id} groupId={groupId} currentUserId={currentUserId} canModerate={canModerateComments} />
        </div>
      </article>
    )
  }

  const dialogError = formError && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{formError}</p>
  const formFooter = (label = 'Зберегти') => <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><button type="button" disabled={Boolean(busy)} onClick={closeDialog} className={secondaryButton}>Скасувати</button><button type="submit" disabled={Boolean(busy)} className={primaryButton}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{label}</button></div>

  return (
    <section className="min-w-0 space-y-5" aria-label="Семінари навчальної групи">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 text-xl font-bold"><BookOpen size={21} className="text-primary" />Семінари</h2><p className="mt-1 text-sm text-muted-foreground">Бронюйте питання, доповнюйте відповіді та збирайте команди.</p></div><button disabled={Boolean(busy) || loading} onClick={() => void reload()} className={`${secondaryButton} self-start`}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Оновити</button></header>
      {error && <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2"><button disabled={Boolean(busy)} onClick={() => setSubjectId('')} className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors motion-reduce:transition-none ${!subjectId ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>Усі предмети</button>{data.subjects.map((subject) => <button key={subject.id} disabled={Boolean(busy)} onClick={() => setSubjectId(subject.id)} className={`max-w-full rounded-full border px-4 py-2 text-sm font-medium transition-colors motion-reduce:transition-none ${subjectId === subject.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}><span className="break-words">{subject.name}</span></button>)}{canEdit && <button disabled={Boolean(busy) || loading} onClick={() => openSubject()} className={secondaryButton}><Plus size={15} />Предмет</button>}</div>
      {selectedSubject && <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h3 className="break-words font-semibold">{selectedSubject.name}</h3><p className="mt-1 text-sm text-muted-foreground">Серія основних відповідей: <strong className="text-foreground">{data.subjectStreaks[selectedSubject.id] || 0} із 3</strong></p><p className="mt-1 text-xs text-muted-foreground">Враховуються лише семінари з доповідачами та доповнювачами.</p></div>{canEdit && <div className="flex shrink-0 gap-1"><button disabled={Boolean(busy)} onClick={() => openSubject(selectedSubject)} className={iconButton} aria-label="Редагувати назву предмета"><Pencil size={16} /></button><button disabled={Boolean(busy)} onClick={() => { setFormError(''); setDeleteTarget({ kind: 'subject', id: selectedSubject.id, name: selectedSubject.name }) }} className={iconButton} aria-label="Видалити предмет"><Trash2 size={16} /></button></div>}</div>}
      <details className="rounded-xl border border-border bg-muted/20 p-3 text-sm"><summary className="flex cursor-pointer items-center gap-2 font-medium"><CircleHelp size={16} className="text-primary" />Як працює вибір</summary><div className="mt-2 space-y-2 leading-relaxed text-muted-foreground"><p>На одну пару можна зробити один вибір: забронювати питання, обрати основну відповідь, доповнення або команду. До початку заняття за київським часом можна змінити чи скасувати вибір.</p><p>У форматі «Доповідачі та доповнювачі» на питання є до трьох доповнювачів. Після трьох основних відповідей поспіль наступний семінар можна доповнити. Доповнення або пропуск такого семінару перериває серію.</p><p>Звичайне бронювання та командна робота не змінюють серію. У коментарях можна уточнити завдання, повідомити про обрану тему й домовитися про підготовку в парі.</p></div></details>
      <section className="xelay-card overflow-hidden" aria-label="Календар семінарів"><div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-semibold">Розклад семінарів</h3><p className="mt-1 text-sm text-muted-foreground">{formatSeminarDate(week[0].date)} — {formatSeminarDate(week[6].date)}</p></div><div className="flex flex-wrap items-center gap-2"><button disabled={Boolean(busy)} onClick={() => onDateChange(addSeminarDays(selectedDate, -7))} className={iconButton} aria-label="Попередній тиждень"><ChevronLeft size={19} /></button><button disabled={Boolean(busy)} onClick={() => onDateChange(kyivToday())} className="px-2 py-2 text-sm font-medium text-primary disabled:opacity-50">Сьогодні</button><button disabled={Boolean(busy)} onClick={() => onDateChange(addSeminarDays(selectedDate, 7))} className={iconButton} aria-label="Наступний тиждень"><ChevronRight size={19} /></button><label className="flex min-w-0 items-center gap-1 rounded-full border border-border px-3 py-2"><CalendarDays size={15} className="shrink-0 text-primary" /><span className="sr-only">Дата семінару</span><input type="date" value={selectedDate} disabled={Boolean(busy)} onChange={(event) => { if (event.target.value) onDateChange(event.target.value) }} className="min-w-0 max-w-[9rem] bg-transparent text-sm text-foreground outline-none" /></label></div></div><div className="grid grid-cols-7 gap-1 p-2 sm:gap-2 sm:p-3">{week.map((day) => {
        const count = visibleSchedule.filter((slot) => scheduleOnDate(slot, day.date)).length
        return <button key={day.date} disabled={Boolean(busy)} aria-pressed={day.date === selectedDate} onClick={() => onDateChange(day.date)} className={`min-w-0 rounded-2xl px-1 py-3 text-center text-xs transition-colors sm:text-sm motion-reduce:transition-none ${day.date === selectedDate ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><span className="block">{day.short}</span><span className="mt-1 block font-semibold">{Number(day.date.slice(8))}</span><span aria-label={`${count} занять`} className={`mx-auto mt-1.5 block h-1 w-1 rounded-full ${count ? day.date === selectedDate ? 'bg-primary-foreground' : 'bg-primary' : 'bg-transparent'}`} /></button>
      })}</div></section>
      {canEdit && <details className="xelay-card p-4"><summary className="cursor-pointer text-sm font-semibold">Повторення занять · {visibleSchedule.length}</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">Налаштуйте заняття один раз до обраної дати. Питання, команди та бронювання створюються окремо на кожну пару.</p>{visibleSchedule.map((slot) => <div key={slot.id} className="flex items-start justify-between gap-2 rounded-xl border border-border p-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{data.subjects.find((subject) => subject.id === slot.subject_id)?.name}</p><p className="mt-1 text-xs text-muted-foreground">{SEMINAR_WEEKDAYS.find((day) => day.id === slot.weekday)?.full}, {slot.starts_at.slice(0, 5)}–{slot.ends_at.slice(0, 5)}</p><p className="mt-1 text-xs text-muted-foreground">{formatSeminarDate(slot.valid_from)} — {formatSeminarDate(slot.valid_until, { day: 'numeric', month: 'long', year: 'numeric' })}</p></div><div className="flex shrink-0"><button disabled={Boolean(busy)} onClick={() => openSchedule(slot)} className={iconButton} aria-label="Редагувати повторення заняття"><Pencil size={15} /></button><button disabled={Boolean(busy)} onClick={() => { setFormError(''); setDeleteTarget({ kind: 'schedule', id: slot.id, name: 'Повторення заняття' }) }} className={iconButton} aria-label="Видалити повторення заняття"><Trash2 size={15} /></button></div></div>)}<button disabled={Boolean(busy) || loading || !data.subjects.length} onClick={() => openSchedule()} className={secondaryButton}><Plus size={15} />Додати заняття</button></div></details>}
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold capitalize">{formatSeminarDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>{canEdit && <button disabled={Boolean(busy) || loading || !data.subjects.length} onClick={() => openSchedule()} className={iconButton} aria-label="Додати заняття"><Plus size={19} /></button>}</div>
      {loading && loadedDate !== selectedDate ? <div className="xelay-card flex min-h-36 items-center justify-center" role="status"><Loader2 className="animate-spin text-primary" /><span className="sr-only">Завантажуємо семінари</span></div> : loadedDate === selectedDate && daySlots.length ? <div className="space-y-4">{daySlots.map((slot) => {
        const seminar = data.seminars.find((item) => item.schedule_id === slot.id)
        if (seminar) return renderAssignment(seminar, slot)
        const started = seminarHasStarted({ lesson_date: selectedDate, starts_at: slot.starts_at })
        return <article key={slot.id} className="xelay-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"><div className="min-w-0"><p className="text-xs text-muted-foreground">{slot.starts_at.slice(0, 5)}–{slot.ends_at.slice(0, 5)}</p><h3 className="mt-1 break-words font-semibold">{data.subjects.find((subject) => subject.id === slot.subject_id)?.name || 'Семінар'}</h3><p className="mt-1 text-sm text-muted-foreground">{started ? 'Завдання на цю пару не було додано.' : 'Завдання на цю дату ще не додано.'}</p></div>{canEdit && !started && <button disabled={Boolean(busy)} onClick={() => openAssignment(slot)} className={`${primaryButton} shrink-0 self-start`}><Plus size={15} />Додати завдання</button>}</article>
      })}</div> : !loading && !error && <div className="xelay-card border-dashed p-7 text-center"><CalendarDays size={28} className="mx-auto text-primary/60" /><h3 className="mt-3 font-semibold">{data.subjects.length ? 'На цей день семінарів немає' : 'Перші семінари ще попереду'}</h3><p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{data.subjects.length ? 'Оберіть іншу дату або предмет у календарі.' : canEdit ? 'Додайте предмет, налаштуйте повторення занять і створіть питання чи командне завдання.' : 'Предмети, заняття та завдання з’являться після додавання учасником із відповідним дозволом.'}</p>{canEdit && <button disabled={Boolean(busy)} onClick={() => data.subjects.length ? openSchedule() : openSubject()} className={`${primaryButton} mt-4`}><Plus size={15} />{data.subjects.length ? 'Додати заняття' : 'Додати предмет'}</button>}</div>}
      {anyDialog && subjectEditor && <Dialog title={subjectEditor.id ? 'Редагувати предмет' : 'Новий предмет'} busy={Boolean(busy)} onClose={closeDialog}><form className="space-y-4" onSubmit={(event: FormEvent) => { event.preventDefault(); void runMutation('subject', () => seminarRpc('xelay_save_seminar_subject', { p_group_id: groupId, p_subject_id: subjectEditor.id, p_name: subjectEditor.name.trim() }), closeDialog, true) }}><Field label="Назва предмета"><input required maxLength={120} value={subjectEditor.name} disabled={Boolean(busy)} onChange={(event) => setSubjectEditor({ ...subjectEditor, name: event.target.value })} placeholder="Наприклад, економічна теорія" className={inputClass} /></Field>{dialogError}{formFooter()}</form></Dialog>}
      {scheduleEditor && <Dialog title={scheduleEditor.id ? 'Повторення заняття' : 'Нове заняття'} busy={Boolean(busy)} onClose={closeDialog}><form className="space-y-4" onSubmit={(event: FormEvent) => { event.preventDefault(); if (scheduleEditor.ends_at <= scheduleEditor.starts_at || scheduleEditor.valid_until < scheduleEditor.valid_from) { setFormError('Кінець заняття має бути пізніше початку, а кінцева дата — не раніше першої.'); return } void runMutation('schedule', () => seminarRpc('xelay_save_seminar_schedule', { p_group_id: groupId, p_schedule_id: scheduleEditor.id, p_subject_id: scheduleEditor.subject_id, p_weekday: scheduleEditor.weekday, p_starts_at: scheduleEditor.starts_at, p_ends_at: scheduleEditor.ends_at, p_valid_from: scheduleEditor.valid_from, p_valid_until: scheduleEditor.valid_until }), closeDialog, true) }}><Field label="Предмет"><select required disabled={Boolean(busy) || Boolean(scheduleEditor.id)} value={scheduleEditor.subject_id} onChange={(event) => setScheduleEditor({ ...scheduleEditor, subject_id: event.target.value })} className={inputClass}>{data.subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></Field><Field label="День тижня"><select disabled={Boolean(busy)} value={scheduleEditor.weekday} onChange={(event) => setScheduleEditor({ ...scheduleEditor, weekday: Number(event.target.value) })} className={inputClass}>{SEMINAR_WEEKDAYS.map((day) => <option key={day.id} value={day.id}>{day.full}</option>)}</select></Field><div className="grid grid-cols-2 gap-3"><Field label="Початок"><input type="time" required disabled={Boolean(busy)} value={scheduleEditor.starts_at} onChange={(event) => setScheduleEditor({ ...scheduleEditor, starts_at: event.target.value })} className={inputClass} /></Field><Field label="Кінець"><input type="time" required disabled={Boolean(busy)} value={scheduleEditor.ends_at} onChange={(event) => setScheduleEditor({ ...scheduleEditor, ends_at: event.target.value })} className={inputClass} /></Field><Field label="Повторювати з"><input type="date" required disabled={Boolean(busy)} value={scheduleEditor.valid_from} onChange={(event) => setScheduleEditor({ ...scheduleEditor, valid_from: event.target.value })} className={inputClass} /></Field><Field label="Повторювати до"><input type="date" required min={scheduleEditor.valid_from} disabled={Boolean(busy)} value={scheduleEditor.valid_until} onChange={(event) => setScheduleEditor({ ...scheduleEditor, valid_until: event.target.value })} className={inputClass} /></Field></div><p className="text-xs text-muted-foreground">Час занять — київський. Зміни повторення не переносять уже створені завдання на інші дати.</p>{dialogError}{formFooter()}</form></Dialog>}
      {resourcesEditor && canManageResources && <Dialog title="Матеріали до семінару" busy={Boolean(busy)} onClose={closeDialog}><form className="space-y-4" onSubmit={saveResources}>
        <p className="break-words text-sm font-medium">{resourcesEditor.title}</p>
        <SeminarResourceFields links={resourcesEditor.links} onLinksChange={(links) => setResourcesEditor((draft) => draft ? { ...draft, links } : null)} files={resourcesEditor.files} onFilesChange={(files) => setResourcesEditor((draft) => draft ? { ...draft, files } : null)} attachments={resourcesEditor.attachments} onAttachmentsChange={(attachments) => setResourcesEditor((draft) => draft ? { ...draft, attachments } : null)} disabled={Boolean(busy) || !canManageResources} />
        {uploadProgress && <p role="status" className="text-sm text-primary">{uploadProgress.completed < uploadProgress.total ? `Завантажено файлів: ${uploadProgress.completed} із ${uploadProgress.total}` : 'Файли завантажено. Зберігаємо матеріали…'}</p>}
        {dialogError}{formFooter('Зберегти матеріали')}
      </form></Dialog>}
      {assignmentEditor && canEdit && <Dialog title={assignmentEditor.id ? 'Редагувати завдання' : 'Завдання на семінар'} busy={Boolean(busy)} onClose={closeDialog}><form className="space-y-4" onSubmit={saveAssignment}>
        <p className="text-sm text-muted-foreground">{formatSeminarDate(assignmentEditor.lesson_date, { day: 'numeric', month: 'long', year: 'numeric' })} · {data.subjects.find((subject) => subject.id === data.schedule.find((slot) => slot.id === assignmentEditor.schedule_id)?.subject_id)?.name}</p>
        <Field label="Назва завдання"><input required maxLength={160} disabled={Boolean(busy)} value={assignmentEditor.title} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, title: event.target.value })} placeholder="Наприклад, попит і пропозиція" className={inputClass} /></Field>
        <Field label="Умови завдання"><textarea rows={4} maxLength={10000} disabled={Boolean(busy)} value={assignmentEditor.instructions} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, instructions: event.target.value })} placeholder="Що підготувати до заняття та які критерії виконання" className={inputClass} /></Field>
        {canManageResources ? <SeminarResourceFields links={assignmentEditor.links} onLinksChange={(links) => setAssignmentEditor((draft) => draft ? { ...draft, links } : null)} files={assignmentEditor.files} onFilesChange={(files) => setAssignmentEditor((draft) => draft ? { ...draft, files } : null)} attachments={assignmentEditor.attachments} onAttachmentsChange={(attachments) => setAssignmentEditor((draft) => draft ? { ...draft, attachments } : null)} disabled={Boolean(busy)} /> : <div><SeminarResourceList links={assignmentEditor.links} attachments={assignmentEditor.attachments} /><p className="mt-2 text-xs text-muted-foreground">Матеріали зберігаються без змін. Для їх редагування потрібен окремий дозвіл.</p></div>}
        {uploadProgress && <p role="status" className="text-sm text-primary">{uploadProgress.completed < uploadProgress.total ? `Завантажено файлів: ${uploadProgress.completed} із ${uploadProgress.total}` : 'Файли завантажено. Зберігаємо завдання…'}</p>}
        <fieldset disabled={Boolean(busy)}><legend className="mb-2 text-sm font-medium">Формат</legend><div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{SEMINAR_FORMATS.map((format) => <button key={format.id} type="button" aria-pressed={assignmentEditor.format === format.id} disabled={Boolean(assignmentEditor.id && reservationsFor(assignmentEditor.id).length)} onClick={() => setAssignmentEditor({ ...assignmentEditor, format: format.id, questions: assignmentEditor.questions.length ? assignmentEditor.questions : [{ body: '', primary_capacity: format.id === 'booking' ? 10 : 1 }], teams: assignmentEditor.teams.length ? assignmentEditor.teams : [{ name: 'Команда 1', capacity: 5 }, { name: 'Команда 2', capacity: 5 }] })} className={`${secondaryButton} min-w-0 rounded-xl px-3 ${assignmentEditor.format === format.id ? 'border-primary/30 bg-primary/5 text-primary' : ''}`}><span className="text-center">{format.label}</span></button>)}</div><p className="mt-2 text-xs text-muted-foreground">{SEMINAR_FORMATS.find((format) => format.id === assignmentEditor.format)?.description}</p>{Boolean(assignmentEditor.id && reservationsFor(assignmentEditor.id).length) && <p className="mt-2 text-xs text-muted-foreground">Формат зафіксовано, оскільки учасники вже зробили вибір.</p>}</fieldset>
        {assignmentEditor.format !== 'teams' ? <div className="space-y-3">{assignmentEditor.questions.map((question, index) => {
          const booked = Boolean(question.id && data.reservations.some((item) => item.question_id === question.id))
          const primaryCount = data.reservations.filter((item) => item.question_id === question.id && item.role === (assignmentEditor.format === 'booking' ? 'booking' : 'primary')).length
          return <div key={question.id || `draft-${index}`} className="space-y-3 rounded-xl border border-border p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Питання {index + 1}</h3><button type="button" disabled={Boolean(busy) || assignmentEditor.questions.length <= 1 || booked} onClick={() => setAssignmentEditor({ ...assignmentEditor, questions: assignmentEditor.questions.filter((_, itemIndex) => itemIndex !== index) })} className={iconButton} aria-label={`Прибрати питання ${index + 1}`} title={booked ? 'У цьому питанні вже є учасники' : 'Прибрати питання'}><Trash2 size={15} /></button></div><Field label="Текст питання"><textarea required rows={3} maxLength={2000} disabled={Boolean(busy)} value={question.body} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, questions: assignmentEditor.questions.map((item, itemIndex) => itemIndex === index ? { ...item, body: event.target.value } : item) })} className={inputClass} /></Field><Field label={assignmentEditor.format === 'booking' ? 'Кількість місць на питання' : 'Максимум основних відповідачів'}><input type="number" required min={Math.max(1, primaryCount)} max={30} disabled={Boolean(busy)} value={question.primary_capacity} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, questions: assignmentEditor.questions.map((item, itemIndex) => itemIndex === index ? { ...item, primary_capacity: Number(event.target.value) } : item) })} className={inputClass} /></Field><p className="text-xs text-muted-foreground">{assignmentEditor.format === 'booking' ? 'Усі записані учасники мають однакову роль. Хто виступить, визначає викладач.' : 'До цього питання також можуть долучитися 3 доповнювачі.'}{booked && ' Видалення питання недоступне, поки є бронювання.'}</p></div>
        })}<button type="button" disabled={Boolean(busy) || assignmentEditor.questions.length >= 30} onClick={() => setAssignmentEditor({ ...assignmentEditor, questions: [...assignmentEditor.questions, { body: '', primary_capacity: assignmentEditor.format === 'booking' ? 10 : 1 }] })} className={secondaryButton}><Plus size={15} />Додати питання · {assignmentEditor.questions.length}/30</button></div> : <div className="space-y-3"><Field label="Кількість команд"><input type="number" required min={1} max={30} disabled={Boolean(busy)} value={assignmentEditor.teams.length} onChange={(event) => {
          const count = Number(event.target.value)
          if (!Number.isInteger(count) || count < 1 || count > 30) return
          if (count < assignmentEditor.teams.length && assignmentEditor.teams.slice(count).some((team) => team.id && data.reservations.some((item) => item.team_id === team.id))) { setFormError('Не можна прибрати команду, до якої вже приєдналися учасники.'); return }
          setFormError('')
          setAssignmentEditor({ ...assignmentEditor, teams: count <= assignmentEditor.teams.length ? assignmentEditor.teams.slice(0, count) : [...assignmentEditor.teams, ...Array.from({ length: count - assignmentEditor.teams.length }, (_, index) => ({ name: `Команда ${assignmentEditor.teams.length + index + 1}`, capacity: 5 }))] })
        }} className={inputClass} /></Field>{assignmentEditor.teams.map((team, index) => {
          const memberCount = data.reservations.filter((item) => item.team_id === team.id).length
          return <div key={team.id || `team-${index}`} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-2"><Field label={`Назва команди ${index + 1}`}><input required maxLength={80} disabled={Boolean(busy)} value={team.name} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, teams: assignmentEditor.teams.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} className={inputClass} /></Field><Field label="Кількість людей"><input type="number" required min={Math.max(1, memberCount)} max={50} disabled={Boolean(busy)} value={team.capacity} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, teams: assignmentEditor.teams.map((item, itemIndex) => itemIndex === index ? { ...item, capacity: Number(event.target.value) } : item) })} className={inputClass} /></Field></div>
        })}<p className="text-xs text-muted-foreground">Кожен учасник бачить імена, аватари та профілі своїх товаришів по команді.</p></div>}{dialogError}{formFooter()}</form></Dialog>}
      {deleteTarget && canEdit && <Dialog title="Видалити зі семінарів?" busy={Boolean(busy)} onClose={closeDialog}><div className="space-y-4"><p className="break-words text-sm">Ви видаляєте <strong>{deleteTarget.name}</strong>.</p><p className="text-sm text-muted-foreground">{deleteTarget.kind === 'subject' ? 'Будуть видалені повторення, завдання та бронювання цього предмета. Дію неможливо скасувати.' : deleteTarget.kind === 'seminar' ? 'Питання, команди та бронювання цього завдання також буде видалено. Дію неможливо скасувати.' : 'Буде видалено це повторення, усі його майбутні завдання, питання, команди та бронювання. Якщо заняття вже почалося, видалення недоступне. Дію неможливо скасувати.'}</p>{!canManageResources && <p className="text-xs text-muted-foreground">Якщо в завданнях є матеріали, для їх видалення потрібне також право керувати матеріалами семінарів.</p>}{dialogError}<div className="flex flex-wrap justify-end gap-2"><button disabled={Boolean(busy)} onClick={closeDialog} className={secondaryButton}>Залишити</button><button disabled={Boolean(busy)} onClick={() => void runMutation('delete', () => seminarRpc(deleteTarget.kind === 'subject' ? 'xelay_delete_seminar_subject' : deleteTarget.kind === 'schedule' ? 'xelay_delete_seminar_schedule' : 'xelay_delete_seminar', { [deleteTarget.kind === 'subject' ? 'p_subject_id' : deleteTarget.kind === 'schedule' ? 'p_schedule_id' : 'p_seminar_id']: deleteTarget.id }), closeDialog, true)} className={`${secondaryButton} border-destructive/20 text-destructive hover:bg-destructive/5`}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}Видалити</button></div></div></Dialog>}
      {supplementChoice && <Dialog title="Долучитися як доповнювач?" busy={Boolean(busy)} onClose={closeDialog}><div className="space-y-4"><p className="text-sm">Ви вже обрали основну відповідь на три семінари поспіль із цього предмета. Цього разу можна доповнити відповідь одногрупника.</p><p className="whitespace-pre-wrap break-words rounded-xl bg-muted p-3 text-sm">{supplementChoice.question}</p><p className="text-xs text-muted-foreground">Це замінить ваш попередній вибір на цій парі. Після участі як доповнювач серія почнеться знову.</p>{dialogError}<div className="flex flex-wrap justify-end gap-2"><button disabled={Boolean(busy)} onClick={closeDialog} className={secondaryButton}>Повернутися</button><button disabled={Boolean(busy)} onClick={() => void runMutation('supplement', () => seminarRpc('xelay_reserve_seminar', { p_seminar_id: supplementChoice.seminarId, p_role: 'supplement', p_target_id: supplementChoice.questionId }), closeDialog, true)} className={primaryButton}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}Підтвердити доповнення</button></div></div></Dialog>}
      {cancelSeminar && <Dialog title="Скасувати свій вибір?" busy={Boolean(busy)} onClose={closeDialog}><div className="space-y-4"><p className="text-sm">Ваше місце на занятті <strong>{cancelSeminar.title}</strong> стане доступним іншим учасникам. До початку заняття можна буде обрати знову.</p>{dialogError}<div className="flex flex-wrap justify-end gap-2"><button disabled={Boolean(busy)} onClick={closeDialog} className={secondaryButton}>Залишити вибір</button><button disabled={Boolean(busy)} onClick={() => void runMutation('cancel', () => seminarRpc('xelay_cancel_seminar_reservation', { p_seminar_id: cancelSeminar.id }), closeDialog, true)} className={primaryButton}>{busy ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}Скасувати вибір</button></div></div></Dialog>}
    </section>
  )
}
