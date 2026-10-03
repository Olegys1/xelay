import { FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight,
  BookOpen, GraduationCap, Loader2, MapPin, Pencil, Plus, Trash2, UsersRound, X,
} from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import { getPublicProfiles } from '../lib/profiles'
import { GroupBillingPanel } from '../components/GroupBillingPanel'
import { HomeworkResourceFields, HomeworkResourceList } from '../components/HomeworkResources'
import { StudyGroupMembers } from '../components/StudyGroupMembers'
import { StudyGroupDeputies } from '../components/StudyGroupDeputies'
import { canManageStudyGroupContent, loadStudyGroupPermissions, STUDY_GROUP_CONTENT_PERMISSIONS, STUDY_GROUP_PERMISSIONS, type StudyGroupContentPermission, type StudyGroupPermission } from '../lib/studyGroupDeputies'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { ShareStudyAssignment } from '../components/ShareStudyAssignment'
import type { StudyGroupMember } from '../lib/studyGroupMembers'
import { mondayForDate, scheduleOccursOnDate, timetableImportError, type TimetableLesson, type WeekPattern } from '../lib/studyGroupTimetable'
import {
  HomeworkAttachment, MAX_HOMEWORK_FILES, getHomeworkAttachments, getHomeworkLinks,
  normalizeHomeworkLinks, removeHomeworkFiles, uploadHomeworkFiles, validateHomeworkFile,
} from '../lib/homeworkResources'

const GroupSeminars = lazy(() => import('../components/GroupSeminars').then((module) => ({ default: module.GroupSeminars })))
const GroupTimetable = lazy(() => import('../components/GroupTimetable').then((module) => ({ default: module.GroupTimetable })))

type GroupSummary = {
  id: string
  representative_request_id: string
  representative_id: string
  university_id: string
  academic_unit_id: string
  specialty: string
  group_name: string
  created_at: string
}

type MembershipRow = {
  id: string
  group_id: string
  user_id: string
  invited_by: string | null
  status: 'pending' | 'accepted' | 'rejected' | 'removed'
  created_at: string
}

type ScheduleItem = TimetableLesson

type HomeworkItem = {
  id: string
  group_id: string
  schedule_item_id: string
  lesson_date: string
  lesson_topic?: string | null
  resource_links?: string[]
  attachments?: HomeworkAttachment[]
  body: string
  url: string | null
  created_by: string
}

type MemberProfile = {
  id: string
  full_name: string | null
  username: string | null
  avatar_url: string | null
}

const WEEKDAYS = [
  { id: 1, short: 'Пн', full: 'Понеділок' },
  { id: 2, short: 'Вт', full: 'Вівторок' },
  { id: 3, short: 'Ср', full: 'Середа' },
  { id: 4, short: 'Чт', full: 'Четвер' },
  { id: 5, short: 'Пт', full: 'П’ятниця' },
  { id: 6, short: 'Сб', full: 'Субота' },
  { id: 7, short: 'Нд', full: 'Неділя' },
]

const LESSON_TYPES: Record<ScheduleItem['lesson_type'], string> = {
  lecture: 'Лекція',
  seminar: 'Семінар',
  practical: 'Практичне',
  lab: 'Лабораторна',
  other: 'Заняття',
}

const localDateString = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const parseLocalDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const isoWeekday = (date: Date) => date.getDay() || 7

const dateForWeekday = (selectedDate: Date, weekday: number) => {
  const monday = new Date(selectedDate)
  monday.setDate(monday.getDate() - (isoWeekday(monday) - 1))
  monday.setDate(monday.getDate() + weekday - 1)
  return monday
}

const formatDate = (value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }) =>
  new Intl.DateTimeFormat('uk-UA', options).format(parseLocalDate(value))

const safeLessonUrl = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
      ? url.href
      : null
  } catch {
    return null
  }
}

const isMissingSecondaryUrlColumn = (error: { code: string; message: string } | null) =>
  Boolean(error && (error.code === 'PGRST204' || error.code === '42703') && /\bonline_url_secondary\b/i.test(error.message))

const isMissingTimetableColumn = (error: { code: string; message: string } | null) =>
  Boolean(error && (error.code === 'PGRST204' || error.code === '42703') && /\b(week_pattern|week_anchor_date|lesson_number)\b/i.test(error.message))

const isMissingLessonTopicColumn = (error: { code: string; message: string } | null) =>
  Boolean(error && (error.code === 'PGRST204' || error.code === '42703') && /\blesson_topic\b/i.test(error.message))

const isMissingHomeworkResourceColumns = (error: { code: string; message: string } | null) =>
  Boolean(error && (error.code === 'PGRST204' || error.code === '42703') && /\b(attachments|resource_links)\b/i.test(error.message))

export function StudyGroupsPage() {
  const { authUser, refreshUser } = useAuth()
  const { notify } = useToast()
  const navigate = useNavigate()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [request, setRequest] = useState<any>(null)
  const [memberships, setMemberships] = useState<MembershipRow[]>([])
  const [groupsById, setGroupsById] = useState<Record<string, GroupSummary>>({})
  const [busyMemberId, setBusyMemberId] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)

  const loadGroups = useCallback(async () => {
    if (!authUser?.id) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const [requestResult, membershipResult] = await Promise.all([
      supabase.from('class_representative_requests')
        .select('id, status, group_name, created_at')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('study_group_members')
        .select('id, group_id, user_id, invited_by, status, created_at')
        .eq('user_id', authUser.id)
        .in('status', ['pending', 'accepted'])
        .order('created_at', { ascending: false }),
    ])
    if (requestResult.error || membershipResult.error) {
      console.error('Could not load study groups:', requestResult.error || membershipResult.error)
      setError('Не вдалося завантажити групи. Перевірте, чи застосована міграція навчальних груп.')
      setLoading(false)
      return
    }
    const membershipRows = (membershipResult.data || []) as MembershipRow[]
    const groupIds = [...new Set(membershipRows.map((membership) => membership.group_id))]
    const groupResult = groupIds.length
      ? await supabase.from('study_groups').select('*').in('id', groupIds)
      : { data: [], error: null }
    if (groupResult.error) {
      setError('Не вдалося завантажити дані навчальних груп.')
      setLoading(false)
      return
    }
    setRequest(requestResult.data)
    setMemberships(membershipRows)
    setGroupsById(Object.fromEntries(((groupResult.data || []) as GroupSummary[]).map((group) => [group.id, group])))
    setLoading(false)
  }, [authUser?.id])

  useEffect(() => { void loadGroups() }, [loadGroups])

  const respondToInvitation = async (membershipId: string, accept: boolean) => {
    setBusyMemberId(membershipId)
    setError('')
    const { data: groupId, error: responseError } = await supabase.rpc('xelay_respond_study_group_invitation', {
      p_member_id: membershipId,
      p_accept: accept,
    })
    if (responseError) {
      console.error('Could not respond to group invitation:', responseError)
      const description = 'Не вдалося обробити запрошення. Оновіть сторінку та спробуйте ще раз.'
      setError(description)
      notify({ id: 'group-invitation', title: 'Запрошення не оброблено', description, tone: 'error' })
    } else {
      notify({ id: 'group-invitation', title: accept ? 'Запрошення прийнято' : 'Запрошення відхилено', tone: 'success' })
      await loadGroups()
      await refreshUser()
      if (accept && groupId) navigate({ to: '/groups/$id', params: { id: String(groupId) } })
    }
    setBusyMemberId('')
  }

  const createGroup = async () => {
    if (!request?.id) return
    setCreatingGroup(true)
    setError('')
    const { data: groupId, error: createError } = await supabase.rpc('xelay_create_study_group', {
      p_request_id: request.id,
    })
    if (createError) {
      console.error('Could not create study group:', createError)
      const description = createError.message.includes('unique')
        ? 'Група з такими даними вже існує. Зверніться до адміністратора.'
        : 'Не вдалося створити групу. Оновіть сторінку та спробуйте ще раз.'
      setError(description)
      notify({ id: 'group-create', title: 'Групу не створено', description, tone: 'error' })
    } else if (groupId) {
      notify({ id: 'group-create', title: 'Навчальну групу створено', tone: 'success' })
      await refreshUser()
      navigate({ to: '/groups/$id', params: { id: String(groupId) } })
    }
    setCreatingGroup(false)
  }

  if (!authUser) return (
    <main className="min-h-[65vh] px-4 py-12">
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <section className="xelay-card mx-auto max-w-lg p-7 text-center">
        <UsersRound size={30} className="mx-auto mb-3 text-primary" />
        <h1 className="text-xl font-bold">Навчальні групи</h1>
        <p className="mt-2 text-sm text-muted-foreground">Увійдіть, щоб переглядати запрошення та розклад своєї групи.</p>
        <button onClick={() => setShowAuthModal(true)} className="mt-5 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">Увійти</button>
      </section>
    </main>
  )

  const pendingInvitations = memberships.filter((membership) => membership.status === 'pending')
  const activeMemberships = memberships.filter((membership) => membership.status === 'accepted')
  const hasCreatedRequestedGroup = Object.values(groupsById).some((group) => group.representative_request_id === request?.id)

  return (
    <main className="min-h-screen min-w-0 bg-background px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto w-full min-w-0 max-w-4xl">
        <header className="mb-7">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Навчання разом</p>
          <h1 className="mt-2 text-2xl font-bold sm:text-3xl">Мої групи</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Розклад занять і домашні завдання вашої академічної групи.</p>
        </header>

        {error && <p role="alert" className="mb-5 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

        {loading ? (
          <div className="xelay-card flex min-h-40 items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>
        ) : (
          <div className="space-y-5">
            {pendingInvitations.map((membership) => {
              const group = groupsById[membership.group_id]
              if (!group) return null
              return (
                <section key={membership.id} className="xelay-card flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary">Запрошення до групи</p>
                    <h2 className="mt-1 break-words text-lg font-semibold">{group.group_name}</h2>
                    <p className="text-sm text-muted-foreground">{group.specialty || 'Навчальна група'}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button disabled={busyMemberId === membership.id} onClick={() => void respondToInvitation(membership.id, true)} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                      {busyMemberId === membership.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Прийняти
                    </button>
                    <button disabled={Boolean(busyMemberId)} onClick={() => void respondToInvitation(membership.id, false)} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><X size={15} /> Відхилити</button>
                  </div>
                </section>
              )
            })}

            {request?.status === 'pending' && (
              <section className="xelay-card flex items-start gap-4 p-5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-primary"><Loader2 size={20} className="animate-spin" /></div>
                <div><h2 className="font-semibold">Заявка старости на перевірці</h2><p className="mt-1 text-sm text-muted-foreground">Після підтвердження адміністратора тут з’явиться можливість створити групу «{request.group_name}».</p></div>
              </section>
            )}

            {request?.status === 'rejected' && (
              <section className="xelay-card flex items-start gap-4 p-5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><X size={20} /></div>
                <div><h2 className="font-semibold">Заявку старости відхилено</h2><p className="mt-1 text-sm text-muted-foreground">Перевірте дані профілю або зверніться до адміністратора. Повторно подати заявку можна зі свого профілю.</p><button onClick={() => navigate({ to: '/profile' })} className="mt-3 text-sm font-medium text-primary hover:underline">До профілю</button></div>
              </section>
            )}

            {request?.status === 'approved' && !hasCreatedRequestedGroup && (
              <section className="xelay-card flex min-w-0 flex-col gap-4 border-primary/20 bg-accent/40 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-primary"><GraduationCap size={21} /></div>
                  <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-primary">Статус підтверджено</p><h2 className="mt-1 break-words text-lg font-semibold">Створіть групу «{request.group_name}»</h2><p className="mt-1 text-sm text-muted-foreground">Дані університету та факультету вже прив’язані до вашої заявки.</p></div>
                </div>
                <button onClick={() => void createGroup()} disabled={creatingGroup} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                  {creatingGroup ? <Loader2 size={16} className="animate-spin" /> : <Plus size={17} />} Створити групу
                </button>
              </section>
            )}

            {activeMemberships.length > 0 ? (
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ваші групи</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {activeMemberships.map((membership) => {
                    const group = groupsById[membership.group_id]
                    if (!group) return null
                    return (
                      <button key={membership.id} onClick={() => navigate({ to: '/groups/$id', params: { id: group.id } })} className="xelay-card group flex min-w-0 items-center gap-4 p-5 text-left hover:border-primary/30">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent text-primary"><CalendarDays size={21} /></span>
                        <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{group.group_name}</span><span className="mt-1 block truncate text-sm text-muted-foreground">{group.specialty || 'Навчальна група'}</span></span>
                        <ChevronRight size={18} className="shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
                      </button>
                    )
                  })}
                </div>
              </section>
            ) : !request && pendingInvitations.length === 0 ? (
              <section className="xelay-card p-7 text-center sm:p-10">
                <UsersRound size={30} className="mx-auto mb-3 text-primary" />
                <h2 className="text-lg font-semibold">Поки що немає навчальних груп</h2>
                <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">Щоб створити групу, подайте заявку старости у своєму профілі. До інших груп можна приєднатися лише за запрошенням.</p>
                <button onClick={() => navigate({ to: '/profile' })} className="mt-5 rounded-full border border-primary/30 px-4 py-2 text-sm font-medium text-primary hover:bg-accent">До профілю</button>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </main>
  )
}

export function StudyGroupDetailPage() {
  const { id } = useParams({ from: '/groups/$id' })
  const { authUser } = useAuth()
  return <StudyGroupWorkspace key={`${authUser?.id || 'guest'}:${id}`} />
}

function StudyGroupWorkspace() {
  const { id } = useParams({ from: '/groups/$id' })
  const search = useSearch({ from: '/groups/$id' })
  const { authUser } = useAuth()
  const { notify } = useToast()
  const navigate = useNavigate()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [group, setGroup] = useState<GroupSummary | null>(null)
  const [unitName, setUnitName] = useState('')
  const [universityName, setUniversityName] = useState('')
  const [members, setMembers] = useState<Array<MembershipRow & { profile?: MemberProfile }>>([])
  const [schedule, setSchedule] = useState<ScheduleItem[]>([])
  const [homework, setHomework] = useState<HomeworkItem[]>([])
  const [activeTab, setActiveTab] = useState<'schedule' | 'seminars' | 'timetable'>(() => search.tab || 'schedule')
  const [selectedDate, setSelectedDate] = useState(() => search.date || localDateString(new Date()))
  const [sharedTarget, setSharedTarget] = useState<{ id: string; kind: 'homework' | 'seminar'; date: string; status: 'loading' | 'ready' | 'error'; message?: string } | null>(null)
  const [sharedFocus, setSharedFocus] = useState('')
  const [homeworkLoad, setHomeworkLoad] = useState<{ date: string; status: 'loading' | 'ready' | 'error' }>({ date: '', status: 'loading' })
  const [homeworkReload, setHomeworkReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviteUsername, setInviteUsername] = useState('')
  const [inviting, setInviting] = useState(false)
  const [showScheduleForm, setShowScheduleForm] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<ScheduleItem | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [editingHomework, setEditingHomework] = useState<ScheduleItem | null>(null)
  const [editingHomeworkRecordId, setEditingHomeworkRecordId] = useState<string | null>(null)
  const [editingHomeworkCreatedBy, setEditingHomeworkCreatedBy] = useState<string | null>(null)
  const [homeworkDate, setHomeworkDate] = useState(selectedDate)
  const [homeworkTopic, setHomeworkTopic] = useState('')
  const [homeworkBody, setHomeworkBody] = useState('')
  const [homeworkLinks, setHomeworkLinks] = useState<string[]>([''])
  const [homeworkFiles, setHomeworkFiles] = useState<File[]>([])
  const [homeworkAttachments, setHomeworkAttachments] = useState<HomeworkAttachment[]>([])
  const [originalHomeworkAttachments, setOriginalHomeworkAttachments] = useState<HomeworkAttachment[]>([])
  const [homeworkUploadProgress, setHomeworkUploadProgress] = useState({ completed: 0, total: 0 })
  const [homeworkError, setHomeworkError] = useState('')
  const [savingHomework, setSavingHomework] = useState(false)
  const [groupCanEdit, setGroupCanEdit] = useState(false)
  const [permissions, setPermissions] = useState<StudyGroupPermission[]>([])
  const [contentGrant, setContentGrant] = useState<{ groupId: string; userId: string; permissions: StudyGroupContentPermission[] } | null>(null)
  const [approvedDeputyIds, setApprovedDeputyIds] = useState<string[]>([])
  const active = useRef(true)
  const groupLoadSequence = useRef(0)
  const homeworkContext = useRef({ groupId: id, date: selectedDate, userId: authUser?.id })
  homeworkContext.current = { groupId: id, date: selectedDate, userId: authUser?.id }
  const [expandedHomeworkIds, setExpandedHomeworkIds] = useState<Set<string>>(new Set())
  const [scheduleForm, setScheduleForm] = useState({
    weekday: String(isoWeekday(new Date())), starts_at: '09:00', ends_at: '10:20', subject: '',
    lesson_type: 'lecture' as ScheduleItem['lesson_type'], location: '', online_url: '', online_url_secondary: '',
    valid_from: localDateString(new Date()), valid_until: localDateString(new Date(new Date().setMonth(new Date().getMonth() + 4))),
    week_pattern: 'every' as WeekPattern, week_anchor_date: '', lesson_number: '',
  })

  const isRepresentative = Boolean(group && authUser?.id === group.representative_id)
  const hasPermission = (permission: StudyGroupPermission) => Boolean(group) && permissions.includes(permission)
  const hasContentPermission = (permission: StudyGroupContentPermission) => hasPermission(permission) && group?.id === id
    && contentGrant?.groupId === id && contentGrant?.userId === authUser?.id && contentGrant?.permissions.includes(permission) === true
  const canEditSchedule = groupCanEdit && hasContentPermission('schedule')
  const canEditHomework = groupCanEdit && hasContentPermission('homework')
  const canEditSeminars = groupCanEdit && hasContentPermission('seminars')
  const canManageSeminarResources = groupCanEdit && hasContentPermission('seminar_resources')
  const canModerateSeminarComments = groupCanEdit && hasPermission('seminar_comments')
  const canInviteMembers = groupCanEdit && hasPermission('invite_members')
  const canRemoveMembers = hasPermission('remove_members')
  const canViewInvitations = hasPermission('invite_members') || hasPermission('remove_members')

  const showScheduleError = (description: string, tone: 'warning' | 'error' = 'warning') => {
    setScheduleError(description)
    if (active.current) notify({ id: `group-schedule:${id}`, title: tone === 'warning' ? 'Перевірте дані заняття' : 'Пару не збережено', description, tone })
  }
  const showHomeworkError = (description: string, tone: 'warning' | 'error' = 'warning') => {
    setHomeworkError(description)
    if (active.current) notify({ id: `group-homework:${id}`, title: tone === 'warning' ? 'Перевірте домашнє завдання' : 'Не вдалося зберегти ДЗ', description, tone })
  }
  const showGroupActionError = (description: string, title = 'Не вдалося виконати дію', tone: 'warning' | 'error' = 'error', toastId = `group-action:${id}`) => {
    setError(description)
    if (active.current) notify({ id: toastId, title, description, tone })
  }

  useEffect(() => {
    active.current = true
    return () => { active.current = false; ++groupLoadSequence.current }
  }, [])

  useEffect(() => {
    if (!canEditSchedule) setShowScheduleForm(false)
    if (!canEditHomework) setEditingHomework(null)
  }, [canEditSchedule, canEditHomework])

  useEffect(() => {
    if (search.tab) setActiveTab(search.tab)
    if (search.date) setSelectedDate(search.date)
    setSharedFocus('')
    if (!search.assignment || !authUser?.id) { setSharedTarget(null); return }
    let current = true
    const kind = search.kind || (search.tab === 'seminars' ? 'seminar' : 'homework')
    const assignmentId = search.assignment
    const date = search.date || ''
    setActiveTab(kind === 'seminar' ? 'seminars' : 'schedule')
    setSharedTarget({ id: assignmentId, kind, date, status: 'loading' })
    const resolve = async () => {
      try {
        const result = await supabase.from(kind === 'seminar' ? 'study_group_seminars' : 'study_group_homework')
          .select(kind === 'seminar' ? 'id,lesson_date' : 'id,lesson_date,schedule_item_id')
          .eq('id', assignmentId).eq('group_id', id).maybeSingle()
        if (!current || !active.current) return
        if (result.error) throw result.error
        const target = result.data as unknown as { id: string; lesson_date: string; schedule_item_id?: string } | null
        if (!target) {
          setSharedTarget({ id: assignmentId, kind, date, status: 'error', message: 'Завдання з посилання видалено або більше недоступне.' })
          return
        }
        // IDs stay stable if the representative changes the assignment date.
        setSelectedDate(target.lesson_date)
        setSharedTarget({ id: target.id, kind, date: target.lesson_date, status: 'ready' })
        if (target.schedule_item_id) setExpandedHomeworkIds((previous) => new Set([...previous, target.schedule_item_id!]))
      } catch {
        if (current && active.current) setSharedTarget({ id: assignmentId, kind, date, status: 'error', message: 'Не вдалося відкрити завдання з посилання. Оновіть сторінку та спробуйте ще раз.' })
      }
    }
    void resolve()
    return () => { current = false }
  }, [id, authUser?.id, search.assignment, search.kind, search.tab, search.date])

  const loadGroup = useCallback(async (silent = false): Promise<boolean> => {
    const sequence = ++groupLoadSequence.current
    if (!authUser?.id) {
      setGroup(null)
      setMembers([])
      setSchedule([])
      setHomework([])
      setPermissions([])
      setContentGrant(null)
      setApprovedDeputyIds([])
      setLoading(false)
      return false
    }
    if (!silent) { setLoading(true); setContentGrant(null) }
    setError('')
    const valid = () => active.current && sequence === groupLoadSequence.current
    const [groupResult, ownMembershipResult] = await Promise.all([
      supabase.from('study_groups').select('*').eq('id', id).maybeSingle(),
      supabase.from('study_group_members').select('id, status').eq('group_id', id).eq('user_id', authUser.id).maybeSingle(),
    ])
    if (!valid()) return false
    if (groupResult.error || !groupResult.data) {
      setGroup(null)
      setMembers([])
      setSchedule([])
      setHomework([])
      setPermissions([])
      setContentGrant(null)
      setApprovedDeputyIds([])
      setError('Групу не знайдено або у вас немає доступу.')
      setLoading(false)
      return false
    }
    const groupData = groupResult.data as GroupSummary
    const isLeader = groupData.representative_id === authUser.id
    if (ownMembershipResult.error || (!isLeader && ownMembershipResult.data?.status !== 'accepted')) {
      setGroup(null)
      setMembers([])
      setSchedule([])
      setHomework([])
      setPermissions([])
      setContentGrant(null)
      setApprovedDeputyIds([])
      setError('Перегляд розкладу доступний лише учасникам, які прийняли запрошення.')
      setLoading(false)
      return false
    }
    const [memberResult, scheduleResult, unitResult, universityResult, permissionResult, deputiesResult] = await Promise.all([
      supabase.from('study_group_members').select('id, group_id, user_id, invited_by, status, created_at').eq('group_id', id).in('status', ['pending', 'accepted']).order('created_at'),
      supabase.from('study_group_schedule').select('*').eq('group_id', id).order('weekday').order('starts_at'),
      supabase.from('academic_units').select('name').eq('id', groupData.academic_unit_id).maybeSingle(),
      supabase.from('universities').select('name').eq('id', groupData.university_id).maybeSingle(),
      loadStudyGroupPermissions(id).then((data) => ({ data, error: null }))
        .catch((error: unknown) => ({ data: [] as StudyGroupPermission[], error })),
      supabase.rpc('xelay_list_study_group_deputies', { p_group_id: id }),
    ])
    if (!valid()) return false
    // Preserve the original representative workflow while the additive migration is pending.
    // Deputies always fail closed if their server permissions cannot be loaded.
    setPermissions(permissionResult.error && isLeader && isMissingDatabaseFunction(permissionResult.error as { code?: string })
      ? STUDY_GROUP_PERMISSIONS.map((permission) => permission.key) : permissionResult.data)
    setContentGrant({ groupId: groupData.id, userId: authUser.id, permissions: STUDY_GROUP_CONTENT_PERMISSIONS.filter((permission) => canManageStudyGroupContent({
      groupId: groupData.id, userId: authUser.id, representativeId: groupData.representative_id,
      memberStatus: ownMembershipResult.data?.status, deputies: deputiesResult.error ? null : deputiesResult.data,
      permission,
    })) })
    setApprovedDeputyIds(Array.isArray(deputiesResult.data)
      ? deputiesResult.data.filter((deputy: { status: string }) => deputy.status === 'approved')
        .map((deputy: { user_id: string }) => deputy.user_id) : [])
    if (memberResult.error || scheduleResult.error) {
      console.error('Could not load group content:', memberResult.error || scheduleResult.error)
      setError('Не вдалося завантажити склад групи або розклад.')
      setLoading(false)
      return false
    }
    const memberRows = (memberResult.data || []) as MembershipRow[]
    const profileIds = [...new Set([...memberRows.map((member) => member.user_id), groupData.representative_id])]
    const profilesResult = profileIds.length
      ? await getPublicProfiles(profileIds)
      : { data: [], error: null }
    if (!valid()) return false
    if (profilesResult.error) {
      setMembers([])
      setError('Не вдалося завантажити профілі учасників. Оновіть сторінку та спробуйте ще раз.')
      setLoading(false)
      return false
    }
    const profilesById = new Map(((profilesResult.data || []) as MemberProfile[]).map((profile) => [profile.id, profile]))
    // The representative is also shown for older groups without her own membership row.
    if (!memberRows.some((member) => member.user_id === groupData.representative_id)) memberRows.unshift({
      id: `representative:${groupData.id}`, group_id: groupData.id, user_id: groupData.representative_id,
      invited_by: null, status: 'accepted', created_at: groupData.created_at,
    })
    setGroup(groupData)
    setMembers(memberRows.map((member) => ({ ...member, profile: profilesById.get(member.user_id) })))
    setSchedule((scheduleResult.data || []) as ScheduleItem[])
    setUnitName(unitResult.data?.name || '')
    setUniversityName(universityResult.data?.name || '')
    setLoading(false)
    return true
  }, [authUser?.id, id])

  const refreshGroupAfterAction = async (): Promise<boolean | null> => {
    const pendingReload = loadGroup()
    const sequence = groupLoadSequence.current
    const refreshed = await pendingReload
    return active.current && sequence === groupLoadSequence.current ? refreshed : null
  }

  useEffect(() => { void loadGroup() }, [loadGroup])

  useEffect(() => {
    if (!authUser?.id) return
    const refresh = () => { void loadGroup(true) }
    const channel = supabase.channel(`study-group-roster:${id}:${authUser.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_members', filter: `group_id=eq.${id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_groups', filter: `id=eq.${id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_deputy_requests', filter: `group_id=eq.${id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_schedule', filter: `group_id=eq.${id}` }, refresh)
      .subscribe()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 60000)
    return () => { void supabase.removeChannel(channel); window.removeEventListener('focus', refresh); window.clearInterval(timer) }
  }, [authUser?.id, id, loadGroup])

  useEffect(() => {
    if (!group?.id || activeTab !== 'schedule') return
    let active = true
    setHomeworkLoad({ date: selectedDate, status: 'loading' })
    const loadHomework = async () => {
      try {
        const { data, error: homeworkError } = await supabase.from('study_group_homework')
          .select('*').eq('group_id', group.id).eq('lesson_date', selectedDate)
        if (!active) return
        if (homeworkError) {
          setHomeworkLoad({ date: selectedDate, status: 'error' })
          return
        }
        setHomework((data || []) as HomeworkItem[])
        setHomeworkLoad({ date: selectedDate, status: 'ready' })
        setError((current) => current === 'Зміни збережено, але їх не вдалося завантажити. Повторіть завантаження домашніх завдань.'
          || current === 'Зміни збережено, але сторінку не вдалося оновити. Повторіть завантаження домашніх завдань.' ? '' : current)
      } catch {
        if (active) setHomeworkLoad({ date: selectedDate, status: 'error' })
      }
    }
    void loadHomework()
    return () => { active = false }
  }, [group?.id, selectedDate, homeworkReload, activeTab])

  const selectedDateObject = useMemo(() => parseLocalDate(selectedDate), [selectedDate])
  const currentWeekday = isoWeekday(selectedDateObject)
  const currentWeekDates = WEEKDAYS.map((day) => ({ ...day, date: localDateString(dateForWeekday(selectedDateObject, day.id)) }))
  const homeworkReady = homeworkLoad.date === selectedDate && homeworkLoad.status === 'ready'
  const homeworkLoadFailed = homeworkLoad.date === selectedDate && homeworkLoad.status === 'error'
  const homeworkBySchedule = new Map((homeworkReady ? homework : []).filter((item) => item.lesson_date === selectedDate).map((item) => [item.schedule_item_id, item]))
  const highlightedAssignmentId = sharedTarget?.status === 'ready' && sharedTarget.date === selectedDate ? sharedTarget.id : undefined
  const visibleSchedule = schedule.filter((item) => scheduleOccursOnDate(item, selectedDate)
    || (Boolean(highlightedAssignmentId) && sharedTarget?.kind === 'homework' && homeworkBySchedule.get(item.id)?.id === highlightedAssignmentId))
  useEffect(() => {
    if (!highlightedAssignmentId || sharedTarget?.kind !== 'homework' || sharedFocus === highlightedAssignmentId || activeTab !== 'schedule' || !homeworkReady || loading) return
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`study-homework-${highlightedAssignmentId}`)
      if (!card) return
      card.focus({ preventScroll: true })
      card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
      setSharedFocus(highlightedAssignmentId)
    })
    return () => cancelAnimationFrame(frame)
  }, [highlightedAssignmentId, sharedTarget?.kind, sharedFocus, activeTab, homeworkReady, loading, homework])

  const changeWeek = (amount: number) => {
    const nextDate = parseLocalDate(selectedDate)
    nextDate.setDate(nextDate.getDate() + amount * 7)
    setSelectedDate(localDateString(nextDate))
  }

  const inviteMember = async (event: FormEvent) => {
    event.preventDefault()
    if (!group || !canInviteMembers || inviting) return
    setInviting(true)
    setError('')
    const { error: inviteError } = await supabase.rpc('xelay_invite_to_study_group', {
      p_group_id: group.id,
      p_username: inviteUsername.trim(),
    })
    if (inviteError) {
      console.error('Could not invite group member:', inviteError)
      showGroupActionError(inviteError.message.includes('not found')
        ? 'Користувача з таким Xelay-ніком не знайдено.'
        : 'Не вдалося надіслати запрошення.')
    } else {
      setInviteUsername('')
      const refreshed = await refreshGroupAfterAction()
      if (refreshed === false) showGroupActionError('Запрошення надіслано, але склад групи не вдалося оновити. Оновіть сторінку.', 'Запрошення надіслано', 'warning')
      else if (refreshed) notify({ id: `group-action:${id}`, title: 'Запрошення надіслано', tone: 'success' })
    }
    setInviting(false)
  }

  const removeMember = async (member: StudyGroupMember) => {
    if (!canRemoveMembers || member.group_id !== group?.id || member.user_id === group.representative_id) return
    if (!window.confirm('Видалити учасника з групи?')) return
    setError('')
    const { error: removeError } = await supabase.rpc('xelay_remove_study_group_member', { p_member_id: member.id })
    if (removeError) {
      console.error('Could not remove group member:', removeError)
      showGroupActionError('Не вдалося видалити учасника.')
    } else {
      const refreshed = await refreshGroupAfterAction()
      if (refreshed === false) showGroupActionError('Учасника видалено, але склад групи не вдалося оновити. Оновіть сторінку.', 'Учасника видалено з групи', 'warning')
      else if (refreshed) notify({ id: `group-action:${id}`, title: 'Учасника видалено з групи', tone: 'success' })
    }
  }

  const openNewScheduleForm = (seed?: Pick<TimetableLesson, 'weekday' | 'starts_at' | 'ends_at' | 'lesson_number' | 'week_pattern' | 'week_anchor_date'>) => {
    if (!canEditSchedule) return
    setEditingSchedule(null)
    setScheduleError('')
    const endDate = new Date(parseLocalDate(selectedDate))
    endDate.setMonth(endDate.getMonth() + 4)
    setScheduleForm({
      weekday: String(currentWeekday), starts_at: '09:00', ends_at: '10:20', subject: '',
      lesson_type: 'lecture', location: '', online_url: '', online_url_secondary: '', valid_from: selectedDate,
      valid_until: localDateString(endDate),
      week_pattern: seed?.week_pattern || 'every', week_anchor_date: seed?.week_anchor_date || '',
      lesson_number: seed?.lesson_number ? String(seed.lesson_number) : '',
      ...(seed ? { weekday: String(seed.weekday), starts_at: seed.starts_at, ends_at: seed.ends_at } : {}),
    })
    setShowScheduleForm(true)
  }

  const openEditScheduleForm = (item: ScheduleItem) => {
    if (!canEditSchedule) return
    setEditingSchedule(item)
    setScheduleError('')
    setScheduleForm({
      weekday: String(item.weekday), starts_at: item.starts_at.slice(0, 5), ends_at: item.ends_at.slice(0, 5),
      subject: item.subject, lesson_type: item.lesson_type, location: item.location || '',
      online_url: item.online_url || '', online_url_secondary: item.online_url_secondary || '',
      valid_from: item.valid_from, valid_until: item.valid_until,
      week_pattern: item.week_pattern || 'every', week_anchor_date: item.week_anchor_date || '',
      lesson_number: item.lesson_number ? String(item.lesson_number) : '',
    })
    setShowScheduleForm(true)
  }

  const saveSchedule = async (event: FormEvent) => {
    event.preventDefault()
    if (!group || !authUser?.id || !canEditSchedule || savingSchedule) return
    setScheduleError('')
    if (scheduleForm.week_pattern !== 'every' && (!scheduleForm.week_anchor_date || mondayForDate(scheduleForm.week_anchor_date) !== scheduleForm.week_anchor_date)) {
      showScheduleError('Оберіть понеділок відомого верхнього тижня, щоб правильно чергувати заняття.')
      return
    }
    if (scheduleForm.lesson_number && (!Number.isInteger(Number(scheduleForm.lesson_number)) || Number(scheduleForm.lesson_number) < 1 || Number(scheduleForm.lesson_number) > 12)) {
      showScheduleError('Номер пари має бути від 1 до 12.')
      return
    }
    const primaryUrl = safeLessonUrl(scheduleForm.online_url)
    const secondaryUrl = safeLessonUrl(scheduleForm.online_url_secondary)
    if ((scheduleForm.online_url.trim() && !primaryUrl) || (scheduleForm.online_url_secondary.trim() && !secondaryUrl)) {
      showScheduleError('Введіть коректні посилання на заняття, що починаються з https:// або http://. Обидва поля можна залишити порожніми.')
      return
    }
    setSavingSchedule(true)
    setError('')
    let values: Record<string, unknown> = {
      group_id: group.id,
      weekday: Number(scheduleForm.weekday),
      starts_at: scheduleForm.starts_at,
      ends_at: scheduleForm.ends_at,
      subject: scheduleForm.subject.trim(),
      lesson_type: scheduleForm.lesson_type,
      location: scheduleForm.location.trim(),
      online_url: primaryUrl,
      online_url_secondary: secondaryUrl,
      valid_from: scheduleForm.valid_from,
      valid_until: scheduleForm.valid_until,
      created_by: editingSchedule?.created_by || authUser.id,
      week_pattern: scheduleForm.week_pattern,
      week_anchor_date: scheduleForm.week_pattern === 'every' ? null : scheduleForm.week_anchor_date,
      lesson_number: scheduleForm.lesson_number ? Number(scheduleForm.lesson_number) : null,
    }
    let committed = false
    try {
      const persist = () => editingSchedule
        ? supabase.from('study_group_schedule').update(values).eq('id', editingSchedule.id).eq('group_id', group.id).select('id').single()
        : supabase.from('study_group_schedule').insert(values).select('id').single()
      let result = await persist()
      for (let attempt = 0; attempt < 2 && result.error; attempt++) {
        if (isMissingTimetableColumn(result.error)) {
          if (scheduleForm.week_pattern !== 'every' || scheduleForm.lesson_number) {
            showScheduleError('Чергування тижнів і номери пар поки недоступні. Попросіть адміністратора оновити розклад платформи. Ваші дані залишилися у формі.')
            return
          }
          const { week_pattern: unusedPattern, week_anchor_date: unusedAnchor, lesson_number: unusedNumber, ...legacy } = values
          values = legacy
        } else if (isMissingSecondaryUrlColumn(result.error)) {
          if (secondaryUrl) {
            showScheduleError('Друге посилання ще не підтримується базою даних. Попросіть адміністратора оновити платформу. Ваші дані залишилися у формі.')
            return
          }
          const { online_url_secondary: unusedSecondaryUrl, ...legacy } = values
          values = legacy
        } else break
        result = await persist()
      }
      if (result.error) {
        console.error('Could not save schedule item:', result.error)
        showScheduleError(timetableImportError(result.error), 'error')
      } else {
        committed = true
        setShowScheduleForm(false)
        setEditingSchedule(null)
        const refreshed = await refreshGroupAfterAction()
        if (refreshed === false) showGroupActionError('Пару збережено, але розклад не вдалося оновити. Оновіть сторінку.', 'Пару збережено', 'warning', `group-schedule:${id}`)
        else if (refreshed) notify({ id: `group-schedule:${id}`, title: 'Пару збережено', description: scheduleForm.subject.trim(), tone: 'success' })
      }
    } catch (saveError) {
      console.error('Could not save schedule item:', saveError)
      if (committed) showGroupActionError('Пару збережено, але розклад не вдалося оновити. Оновіть сторінку.', 'Пару збережено', 'warning', `group-schedule:${id}`)
      else showScheduleError('Не вдалося зберегти пару. Перевірте з’єднання та спробуйте ще раз. Ваші дані залишилися у формі.', 'error')
    } finally {
      setSavingSchedule(false)
    }
  }

  const deleteSchedule = async (item: ScheduleItem) => {
    if (!group || !authUser?.id || !canEditSchedule) return
    if (!window.confirm(`Видалити «${item.subject}» з розкладу? Домашні завдання до цієї пари також буде видалено.`)) return
    let committed = false
    try {
      const { data: lessonHomework, error: lookupError } = await supabase.from('study_group_homework')
        .select('*').eq('group_id', group.id).eq('schedule_item_id', item.id)
      if (lookupError) throw lookupError
      if (lessonHomework?.length && !canEditHomework) {
        showGroupActionError('До цієї пари додано домашні завдання. Для її видалення потрібні також права на керування ДЗ.', 'Пару не видалено', 'warning', `group-schedule:${id}`)
        return
      }
      const paths = (lessonHomework || []).flatMap((row) => getHomeworkAttachments(row.attachments).map((file) => file.storage_path))
      const { error: deleteError } = await supabase.from('study_group_schedule').delete()
        .eq('id', item.id).eq('group_id', group.id).select('id').single()
      if (deleteError) throw deleteError
      committed = true
      const cleaned = await removeHomeworkFiles(paths)
      const refreshed = await refreshGroupAfterAction()
      if (refreshed === null) return
      if (!cleaned) showGroupActionError(refreshed
        ? 'Пару видалено. Частину файлів не вдалося прибрати зі сховища; повідомте адміністратора.'
        : 'Пару видалено, але розклад не вдалося оновити. Оновіть сторінку. Частину файлів не вдалося прибрати зі сховища; повідомте адміністратора.', 'Пару видалено', 'warning', `group-schedule:${id}`)
      else if (!refreshed) showGroupActionError('Пару видалено, але розклад не вдалося оновити. Оновіть сторінку.', 'Пару видалено', 'warning', `group-schedule:${id}`)
      else notify({ id: `group-schedule:${id}`, title: 'Пару видалено з розкладу', description: item.subject, tone: 'success' })
    } catch (deleteError) {
      console.error('Could not delete schedule item:', deleteError)
      if (committed) showGroupActionError('Пару видалено, але оновлення розкладу або прибирання файлів не завершилося. Оновіть сторінку.', 'Пару видалено', 'warning', `group-schedule:${id}`)
      else showGroupActionError('Не вдалося видалити пару. Перевірте доступ до групи та спробуйте ще раз.', 'Пару не видалено', 'error', `group-schedule:${id}`)
    }
  }

  const openHomeworkForm = (item: ScheduleItem) => {
    if (!canEditHomework || savingHomework || !homeworkReady) return
    const existing = homeworkBySchedule.get(item.id)
    setEditingHomework(item)
    setEditingHomeworkRecordId(existing?.id || null)
    setEditingHomeworkCreatedBy(existing?.created_by || null)
    setHomeworkDate(selectedDate)
    setHomeworkTopic(existing?.lesson_topic || '')
    setHomeworkBody(existing?.body || '')
    const links = existing ? getHomeworkLinks(existing) : []
    const files = getHomeworkAttachments(existing?.attachments)
    setHomeworkLinks(links.length ? links : [''])
    setHomeworkFiles([])
    setHomeworkAttachments(files)
    setOriginalHomeworkAttachments(files)
    setHomeworkUploadProgress({ completed: 0, total: 0 })
    setHomeworkError('')
  }

  const saveHomework = async (event: FormEvent) => {
    event.preventDefault()
    if (!group || !authUser?.id || !editingHomework || !canEditHomework || savingHomework) return
    setHomeworkError('')
    const topic = homeworkTopic.trim()
    const body = homeworkBody.trim()
    if (topic.length > 240 || body.length > 10000) {
      showHomeworkError('Тема може містити до 240 символів, а опис завдання — до 10 000.')
      return
    }
    let links: string[]
    try {
      links = normalizeHomeworkLinks(homeworkLinks)
      if (homeworkFiles.length + homeworkAttachments.length > MAX_HOMEWORK_FILES) {
        throw new Error('До домашнього завдання можна додати щонайбільше 10 файлів.')
      }
      homeworkFiles.forEach(validateHomeworkFile)
    } catch (validationError) {
      showHomeworkError(validationError instanceof Error ? validationError.message : 'Перевірте файли й посилання.')
      return
    }
    const removeEntry = !topic && !body && !links.length && !homeworkFiles.length && !homeworkAttachments.length
    if (removeEntry) {
      if (!editingHomeworkRecordId) {
        showHomeworkError('Додайте тему заняття, опис домашнього завдання, файл або посилання.')
        return
      }
      if (!window.confirm(`Прибрати тему, домашнє завдання та всі вкладення до «${editingHomework.subject}» на ${formatDate(homeworkDate)}?`)) return
    }
    const groupId = group.id
    const userId = authUser.id
    const lessonDate = homeworkDate
    const isCurrent = () => active.current && homeworkContext.current.groupId === groupId
      && homeworkContext.current.userId === userId
    const hasResourceChanges = homeworkFiles.length > 0 || homeworkAttachments.length > 0
      || originalHomeworkAttachments.length > 0 || links.length > 1
    let uploaded: HomeworkAttachment[] = []
    let committed = false
    setSavingHomework(true)
    setHomeworkUploadProgress({ completed: 0, total: homeworkFiles.length })
    setError('')
    try {
      if (homeworkFiles.length) {
        const { error: schemaError } = await supabase.from('study_group_homework')
          .select('attachments, resource_links').limit(0)
        if (isMissingHomeworkResourceColumns(schemaError)) {
          throw new Error('Файли та кілька посилань ще не підтримуються базою даних. Попросіть адміністратора застосувати міграцію вкладень до домашніх завдань. Ваші дані залишилися у формі.')
        }
        if (schemaError) throw schemaError
        if (!isCurrent()) return
        uploaded = await uploadHomeworkFiles(groupId, userId, homeworkFiles, (completed, total) => {
          if (isCurrent()) setHomeworkUploadProgress({ completed, total })
        })
      }
      if (!isCurrent()) return
      const attachments = [...homeworkAttachments, ...uploaded]
      let values: Record<string, unknown> = {
        group_id: groupId, schedule_item_id: editingHomework.id, lesson_date: lessonDate,
        lesson_topic: topic || null, body, url: links[0] || null,
        resource_links: links, attachments, created_by: editingHomeworkCreatedBy || userId,
      }
      const persist = () => removeEntry
        ? supabase.from('study_group_homework').delete().eq('id', editingHomeworkRecordId!)
          .eq('group_id', groupId).eq('lesson_date', lessonDate).select('id').single()
        : editingHomeworkRecordId
          ? supabase.from('study_group_homework').update(values).eq('id', editingHomeworkRecordId)
            .eq('group_id', groupId).eq('lesson_date', lessonDate).select('*').single()
          : supabase.from('study_group_homework').insert(values).select('*').single()
      let result = await persist()
      for (let attempt = 0; attempt < 2 && result.error; attempt++) {
        if (isMissingHomeworkResourceColumns(result.error)) {
          if (hasResourceChanges) {
            throw new Error('Файли та кілька посилань ще не підтримуються базою даних. Попросіть адміністратора застосувати міграцію вкладень до домашніх завдань. Ваші дані залишилися у формі.')
          }
          const { attachments: unusedAttachments, resource_links: unusedLinks, ...legacyValues } = values
          values = legacyValues
        } else if (isMissingLessonTopicColumn(result.error)) {
          if (topic || !body) {
            throw new Error('Теми занять ще не підтримуються базою даних. Попросіть адміністратора застосувати міграцію тем занять. Ваші дані залишилися у формі.')
          }
          const { lesson_topic: unusedTopic, ...legacyValues } = values
          values = legacyValues
        } else break
        if (!isCurrent()) return
        result = await persist()
      }
      if (!isCurrent()) return
      if (result.error) {
        console.error('Could not save lesson details:', result.error)
        throw new Error('Не вдалося зберегти домашнє завдання. Перевірте доступ до групи та дату заняття або спробуйте ще раз. Введені дані залишилися у формі.')
      }
      committed = true
      const retainedPaths = new Set(attachments.map((file) => file.storage_path))
      const removedPaths = originalHomeworkAttachments.filter((file) => removeEntry || !retainedPaths.has(file.storage_path))
        .map((file) => file.storage_path)
      const cleaned = await removeHomeworkFiles(removedPaths)
      if (!isCurrent()) return
      setEditingHomework(null)
      setHomeworkFiles([])
      const { data, error: refreshError } = await supabase.from('study_group_homework')
        .select('*').eq('group_id', groupId).eq('lesson_date', lessonDate)
      if (!isCurrent() || homeworkContext.current.date !== lessonDate) return
      if (refreshError) {
        setHomeworkLoad({ date: lessonDate, status: 'error' })
        showGroupActionError('Зміни збережено, але їх не вдалося завантажити. Повторіть завантаження домашніх завдань.', 'Зміни ДЗ збережено', 'warning', `group-homework:${id}`)
      } else {
        setHomework((data || []) as HomeworkItem[])
        setHomeworkLoad({ date: lessonDate, status: 'ready' })
      }
      if (!cleaned) showGroupActionError('Зміни збережено. Частину прибраних файлів не вдалося видалити зі сховища; повідомте адміністратора.', 'Зміни ДЗ збережено', 'warning', `group-homework:${id}`)
      else if (!refreshError) notify({ id: `group-homework:${id}`, title: removeEntry ? 'Домашнє завдання прибрано' : 'Домашнє завдання збережено', tone: 'success' })
    } catch (saveError) {
      if (!isCurrent()) return
      console.error('Could not save lesson details:', saveError)
      if (committed) {
        if (homeworkContext.current.date === lessonDate) setHomeworkLoad({ date: lessonDate, status: 'error' })
        showGroupActionError('Зміни збережено, але сторінку не вдалося оновити. Повторіть завантаження домашніх завдань.', 'Зміни ДЗ збережено', 'warning', `group-homework:${id}`)
      }
      else showHomeworkError(saveError instanceof Error ? saveError.message
        : 'Не вдалося зберегти зміни. Перевірте з’єднання та спробуйте ще раз. Ваші дані залишилися у формі.', 'error')
    } finally {
      if (!committed && uploaded.length) {
        const cleaned = await removeHomeworkFiles(uploaded.map((file) => file.storage_path))
        if (!cleaned && isCurrent()) {
          setHomeworkError((message) => `${message} Частину завантажених файлів не вдалося прибрати; оновіть сторінку перед повторною спробою та повідомте адміністратора.`)
          notify({ id: `group-homework:${id}`, title: 'Збереження ДЗ не завершилося', description: 'Частину завантажених файлів не вдалося прибрати. Оновіть сторінку перед повторною спробою та повідомте адміністратора.', tone: 'warning' })
        }
      }
      setSavingHomework(false)
      setHomeworkUploadProgress({ completed: 0, total: 0 })
    }
  }

  if (!authUser) return (
    <main className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <section className="xelay-card max-w-md p-7 text-center">
        <UsersRound size={28} className="mx-auto mb-3 text-primary" />
        <h1 className="text-lg font-semibold">Увійдіть, щоб переглянути групу</h1>
        <button onClick={() => setShowAuthModal(true)} className="mt-4 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">Увійти</button>
      </section>
    </main>
  )

  return (
    <main className="min-h-screen min-w-0 bg-background px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full min-w-0 max-w-6xl">
        <button onClick={() => navigate({ to: '/groups' })} className="mb-5 inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowLeft size={16} /> Мої групи</button>
        {loading ? (
          <div className="xelay-card flex min-h-48 items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>
        ) : error && !group ? (
          <section className="xelay-card p-7 text-center"><p className="text-sm text-muted-foreground">{error}</p><button onClick={() => navigate({ to: '/groups' })} className="mt-4 text-sm font-medium text-primary hover:underline">До моїх груп</button></section>
        ) : group ? (
          <>
            <header className="mb-6 flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary"><GraduationCap size={15} /> Навчальна група</p>
                <h1 className="mt-2 break-words text-2xl font-bold sm:text-3xl">{group.group_name}</h1>
                <p className="mt-1 break-words text-sm text-muted-foreground">{[universityName, unitName, group.specialty].filter(Boolean).join(' · ')}</p>
              </div>
              <label className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm">
                <CalendarDays size={17} className="text-primary" />
                <span className="sr-only">Обрати дату</span>
                <input type="date" value={selectedDate} onChange={(event) => { if (event.target.value) setSelectedDate(event.target.value) }} className="min-w-0 bg-transparent text-sm" />
              </label>
            </header>

            <GroupBillingPanel groupId={group.id} isRepresentative={isRepresentative} onCanEditChange={setGroupCanEdit} />
            {sharedTarget?.status === 'loading' && <p role="status" className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Відкриваємо завдання з повідомлення…</p>}
            {sharedTarget?.status === 'error' && <p role="alert" className="mb-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">{sharedTarget.message}</p>}
            {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

            <div role="tablist" aria-label="Розділи навчальної групи" className="mb-5 flex flex-wrap gap-1 rounded-2xl border border-border bg-muted/50 p-1.5 sm:inline-flex">
              <button id="group-schedule-tab" type="button" role="tab" aria-selected={activeTab === 'schedule'} aria-controls="group-schedule-panel" onClick={() => setActiveTab('schedule')} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors motion-reduce:transition-none ${activeTab === 'schedule' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}`}><CalendarDays size={17} /> Розклад і ДЗ</button>
              <button id="group-seminars-tab" type="button" role="tab" aria-selected={activeTab === 'seminars'} aria-controls="group-seminars-panel" onClick={() => setActiveTab('seminars')} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors motion-reduce:transition-none ${activeTab === 'seminars' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}`}><BookOpen size={17} /> Семінари</button>
              <button id="group-timetable-tab" type="button" role="tab" aria-selected={activeTab === 'timetable'} aria-controls="group-timetable-panel" onClick={() => setActiveTab('timetable')} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors motion-reduce:transition-none ${activeTab === 'timetable' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}`}><CalendarDays size={17} /> Наш розклад</button>
            </div>

            {activeTab === 'timetable' ? (
              <section id="group-timetable-panel" role="tabpanel" aria-labelledby="group-timetable-tab">
                <Suspense fallback={<div className="xelay-card flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" />Завантажуємо розклад…</div>}>
                  <GroupTimetable key={`${group.id}:${authUser.id}`} groupId={group.id} currentUserId={authUser.id} schedule={schedule} canEdit={canEditSchedule} selectedDate={selectedDate} onDateChange={setSelectedDate} onEditLesson={openEditScheduleForm} onAddLesson={openNewScheduleForm} onImported={async () => { await loadGroup(true) }} />
                </Suspense>
              </section>
            ) : activeTab === 'seminars' ? (
              <section id="group-seminars-panel" role="tabpanel" aria-labelledby="group-seminars-tab">
                <Suspense fallback={<div className="xelay-card flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" /> Завантаження семінарів…</div>}>
                  <GroupSeminars key={`${group.id}:${authUser.id}`} groupId={group.id} groupName={group.group_name} currentUserId={authUser.id} canEdit={canEditSeminars} canManageResources={canManageSeminarResources} canModerateComments={canModerateSeminarComments} selectedDate={selectedDate} onDateChange={setSelectedDate} highlightedAssignmentId={sharedTarget?.kind === 'seminar' ? highlightedAssignmentId : undefined} focusHighlightedAssignment={sharedFocus !== highlightedAssignmentId} onHighlightedAssignmentFocus={() => { if (highlightedAssignmentId) setSharedFocus(highlightedAssignmentId) }} />
                </Suspense>
              </section>
            ) : (
            <div id="group-schedule-panel" role="tabpanel" aria-labelledby="group-schedule-tab">
            <section className="xelay-card min-w-0 overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
                <div><h2 className="font-semibold">Розклад на тиждень</h2><p className="mt-0.5 text-xs text-muted-foreground">{formatDate(currentWeekDates[0].date)} — {formatDate(currentWeekDates[6].date)}</p></div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => changeWeek(-1)} aria-label="Попередній тиждень" className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-primary"><ChevronLeft size={18} /></button>
                  <button type="button" onClick={() => setSelectedDate(localDateString(new Date()))} className="rounded-full px-3 py-2 text-xs font-medium text-primary hover:bg-accent">Сьогодні</button>
                  <button type="button" onClick={() => changeWeek(1)} aria-label="Наступний тиждень" className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-primary"><ChevronRight size={18} /></button>
                </div>
              </header>

              <div className="grid grid-cols-7 gap-1 overflow-x-auto border-b border-border p-2 sm:gap-2 sm:p-3">
                {currentWeekDates.map((day) => {
                  const isSelected = day.date === selectedDate
                  return (
                    <button key={day.id} type="button" onClick={() => setSelectedDate(day.date)} className={`min-w-10 rounded-xl px-1 py-2 text-center transition-colors sm:min-w-0 sm:px-2 ${isSelected ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-primary'}`}>
                      <span className="block text-[10px] font-medium sm:text-xs">{day.short}</span>
                      <span className="mt-0.5 block text-sm font-semibold">{parseLocalDate(day.date).getDate()}</span>
                    </button>
                  )
                })}
              </div>

              <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-4 sm:px-5">
                <h3 className="text-sm font-semibold">{WEEKDAYS[currentWeekday - 1].full}, {formatDate(selectedDate, { day: 'numeric', month: 'long', year: 'numeric' })}</h3>
                {canEditSchedule && <button onClick={() => openNewScheduleForm()} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90"><Plus size={14} /> Додати пару</button>}
              </div>

              <div className="space-y-3 px-4 pb-5 pt-2 sm:px-5">
                {!homeworkReady && (homeworkLoadFailed ? (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <span>Не вдалося завантажити домашні завдання.</span>
                    <button type="button" onClick={() => { setHomeworkLoad({ date: selectedDate, status: 'loading' }); setHomeworkReload((value) => value + 1) }} className="min-h-11 rounded-full px-3 font-semibold hover:bg-destructive/10">Спробувати ще раз</button>
                  </div>
                ) : <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Завантаження домашніх завдань…</p>)}
                {visibleSchedule.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center">
                    <CalendarDays size={24} className="mx-auto mb-2 text-primary/70" />
                    <p className="text-sm text-muted-foreground">На цей день занять не заплановано.</p>
                  </div>
                ) : visibleSchedule.map((item) => {
                  const homeworkItem = homeworkBySchedule.get(item.id)
                  const isExpanded = expandedHomeworkIds.has(item.id)
                  const shouldCollapse = Boolean(homeworkItem && homeworkItem.body.length > 220)
                  const resourceLinks = homeworkItem ? getHomeworkLinks(homeworkItem) : []
                  const attachedFiles = getHomeworkAttachments(homeworkItem?.attachments)
                  const primaryLessonUrl = safeLessonUrl(item.online_url)
                  const secondaryLessonUrl = safeLessonUrl(item.online_url_secondary)
                  return (
                    <article key={item.id} id={homeworkItem ? `study-homework-${homeworkItem.id}` : undefined} tabIndex={-1} className={`grid min-w-0 grid-cols-[62px_minmax(0,1fr)] gap-3 rounded-2xl outline-none sm:grid-cols-[84px_minmax(0,1fr)] sm:gap-4 ${highlightedAssignmentId && homeworkItem?.id === highlightedAssignmentId ? 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background' : ''}`}>
                      <div className="pt-3 text-right text-xs font-semibold tabular-nums text-muted-foreground sm:text-sm"><span className="block text-primary">{item.starts_at.slice(0, 5)}</span><span className="mt-0.5 block font-normal">{item.ends_at.slice(0, 5)}</span></div>
                      <div className="min-w-0 rounded-2xl border border-primary/15 bg-accent/35 p-3.5 sm:p-4">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <span className="inline-flex rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-primary">{LESSON_TYPES[item.lesson_type]}</span>
                            {item.week_pattern && item.week_pattern !== 'every' && <span className="ml-1.5 text-[11px] text-muted-foreground">{item.week_pattern === 'upper' ? 'Верхній тиждень' : 'Нижній тиждень'}</span>}
                            <h4 className="mt-1.5 break-words font-semibold text-foreground">{item.subject}</h4>
                            {homeworkItem?.lesson_topic?.trim() && <p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-primary">{homeworkItem.lesson_topic}</p>}
                          </div>
                          {canEditSchedule && <div className="flex shrink-0 items-center gap-0.5"><button onClick={() => openEditScheduleForm(item)} aria-label="Редагувати пару" title="Редагувати пару" className="rounded-full p-2 text-primary hover:bg-accent"><Pencil size={15} /></button><button onClick={() => void deleteSchedule(item)} aria-label="Видалити пару" title="Видалити пару" className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={15} /></button></div>}
                        </div>
                        {(item.location || primaryLessonUrl || secondaryLessonUrl) && (
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {item.location && <span className="inline-flex items-center gap-1"><MapPin size={13} />{item.location}</span>}
                            {primaryLessonUrl && <a href={primaryLessonUrl} target="_blank" rel="noopener noreferrer" aria-label={`Посилання 1 на заняття «${item.subject}» (відкриється в новій вкладці)`} className="inline-flex min-h-11 items-center rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Посилання 1</a>}
                            {secondaryLessonUrl && <a href={secondaryLessonUrl} target="_blank" rel="noopener noreferrer" aria-label={`Посилання 2 на заняття «${item.subject}» (відкриється в новій вкладці)`} className="inline-flex min-h-11 items-center rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Посилання 2</a>}
                          </div>
                        )}
                        <p className="mt-2 text-[11px] text-muted-foreground">Повторюється до {formatDate(item.valid_until, { day: 'numeric', month: 'long', year: 'numeric' })}</p>

                        {homeworkItem && (homeworkItem.lesson_topic?.trim() || homeworkItem.body.trim() || resourceLinks.length || attachedFiles.length) ? (
                          <div className="mt-3 border-t border-primary/10 pt-3">
                            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-foreground">Домашнє завдання</p><div className="flex flex-wrap items-center gap-2"><ShareStudyAssignment assignment={{ kind: 'homework', id: homeworkItem.id, groupId: group.id, groupName: group.group_name, title: homeworkItem.lesson_topic?.trim() || item.subject, subject: item.subject, date: homeworkItem.lesson_date }} currentUserId={authUser.id} />{canEditHomework && <button disabled={savingHomework || !homeworkReady} onClick={() => openHomeworkForm(item)} className="text-xs font-medium text-primary hover:underline disabled:opacity-50">Редагувати</button>}</div></div>
                            {homeworkItem.body.trim() && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{shouldCollapse && !isExpanded ? `${homeworkItem.body.slice(0, 220).trimEnd()}…` : homeworkItem.body}</p>}
                            {shouldCollapse && <button onClick={() => setExpandedHomeworkIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} className="mt-1 text-xs font-medium text-primary hover:underline">{isExpanded ? 'Згорнути' : 'Показати повністю'}</button>}
                            <HomeworkResourceList key={`${homeworkItem.id}:${homeworkItem.lesson_date}`} links={resourceLinks} attachments={attachedFiles} />
                          </div>
                        ) : canEditHomework ? (
                          <button disabled={savingHomework || !homeworkReady} onClick={() => openHomeworkForm(item)} className="mt-3 inline-flex min-h-11 items-center gap-1.5 border-t border-primary/10 pt-3 text-xs font-semibold text-primary hover:underline disabled:opacity-50">{homeworkItem ? <Pencil size={14} /> : <Plus size={14} />}{homeworkItem ? 'Редагувати тему / ДЗ' : 'Додати тему / ДЗ'}</button>
                        ) : !homeworkReady || homeworkItem?.lesson_topic?.trim() ? null : <p className="mt-3 border-t border-primary/10 pt-3 text-xs text-muted-foreground">Домашнє завдання ще не додане.</p>}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
            </div>
            )}

              <section className="xelay-card mt-6 min-w-0 p-4 sm:p-5">
                <div className="flex items-center gap-2"><UsersRound size={18} className="text-primary" /><h2 className="font-semibold">Учасники групи</h2><span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">{members.filter((member) => member.status === 'accepted').length}</span></div>
                {(isRepresentative || hasPermission('invite_members')) && <form onSubmit={(event) => void inviteMember(event)} className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <input disabled={inviting || !canInviteMembers} value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value)} required maxLength={32} placeholder="Нік у Xelay" className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm" />
                  <button disabled={inviting || !canInviteMembers} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{inviting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Запросити</button>
                </form>}
                <StudyGroupMembers key={`${group.id}:${authUser.id}`} groupId={group.id} currentUserId={authUser.id} representativeId={group.representative_id} members={members} canManage={canInviteMembers || canRemoveMembers} canViewInvitations={canViewInvitations} canRemoveMembers={canRemoveMembers} deputyIds={approvedDeputyIds} onRemove={removeMember} />
              </section>
              <StudyGroupDeputies key={`deputies:${group.id}:${authUser.id}`} groupId={group.id} currentUserId={authUser.id} isRepresentative={isRepresentative} representativeId={group.representative_id} members={members} onPermissionsChange={() => { void loadGroup(true) }} />
          </>
        ) : null}
      </div>

      {showScheduleForm && group && canEditSchedule && (
        <div className="xelay-dialog-backdrop fixed inset-0 z-[70] flex items-end justify-center bg-foreground/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowScheduleForm(false) }}>
          <form onSubmit={(event) => void saveSchedule(event)} className="xelay-dialog-panel max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-border bg-background p-5 shadow-2xl sm:rounded-3xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">{editingSchedule ? 'Редагувати пару' : 'Додати пару'}</h2><p className="mt-1 text-xs text-muted-foreground">Оберіть період і тижні, у які відбувається пара.</p></div><button type="button" onClick={() => setShowScheduleForm(false)} aria-label="Закрити" className="rounded-full p-2 text-muted-foreground hover:bg-muted"><X size={18} /></button></div>
            {scheduleError && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{scheduleError}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">День тижня<select value={scheduleForm.weekday} onChange={(event) => setScheduleForm((current) => ({ ...current, weekday: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">{WEEKDAYS.map((day) => <option key={day.id} value={day.id}>{day.full}</option>)}</select></label>
              <label className="text-sm font-medium">Тип заняття<select value={scheduleForm.lesson_type} onChange={(event) => setScheduleForm((current) => ({ ...current, lesson_type: event.target.value as ScheduleItem['lesson_type'] }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">{Object.entries(LESSON_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="text-sm font-medium">Номер пари<input type="number" min={1} max={12} value={scheduleForm.lesson_number} onChange={(event) => setScheduleForm((current) => ({ ...current, lesson_number: event.target.value }))} placeholder="Необов’язково" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium">Повторення<select value={scheduleForm.week_pattern} onChange={(event) => setScheduleForm((current) => ({ ...current, week_pattern: event.target.value as WeekPattern }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5"><option value="every">Кожного тижня</option><option value="upper">Верхній тиждень</option><option value="lower">Нижній тиждень</option></select></label>
              {scheduleForm.week_pattern !== 'every' && <label className="text-sm font-medium sm:col-span-2">Понеділок відомого верхнього тижня<input type="date" required value={scheduleForm.week_anchor_date} onChange={(event) => setScheduleForm((current) => ({ ...current, week_anchor_date: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /><span className="mt-1.5 block text-xs font-normal text-muted-foreground">Наприклад, оберіть понеділок тижня, про який точно відомо, що він верхній. Наступний тиждень буде нижнім.</span></label>}
              <label className="text-sm font-medium sm:col-span-2">Предмет<input value={scheduleForm.subject} onChange={(event) => setScheduleForm((current) => ({ ...current, subject: event.target.value }))} required maxLength={120} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" placeholder="Назва предмета" /></label>
              <label className="text-sm font-medium">Початок<input type="time" value={scheduleForm.starts_at} onChange={(event) => setScheduleForm((current) => ({ ...current, starts_at: event.target.value }))} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium">Завершення<input type="time" value={scheduleForm.ends_at} onChange={(event) => setScheduleForm((current) => ({ ...current, ends_at: event.target.value }))} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium sm:col-span-2">Аудиторія або місце<input value={scheduleForm.location} onChange={(event) => setScheduleForm((current) => ({ ...current, location: event.target.value }))} maxLength={160} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" placeholder="Наприклад, ауд. 305 або Online" /></label>
              <label className="text-sm font-medium sm:col-span-2">Посилання на заняття 1<input type="url" inputMode="url" autoCapitalize="none" spellCheck={false} aria-describedby="schedule-links-help" value={scheduleForm.online_url} onChange={(event) => setScheduleForm((current) => ({ ...current, online_url: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base" placeholder="https://…" /></label>
              <label className="text-sm font-medium sm:col-span-2">Посилання на заняття 2<input type="url" inputMode="url" autoCapitalize="none" spellCheck={false} aria-describedby="schedule-links-help" value={scheduleForm.online_url_secondary} onChange={(event) => setScheduleForm((current) => ({ ...current, online_url_secondary: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base" placeholder="https://…" /></label>
              <p id="schedule-links-help" className="-mt-2 text-xs text-muted-foreground sm:col-span-2">Можна додати до двох посилань на заняття. Обидва поля необов’язкові; використовуйте адреси з https:// або http://.</p>
              <label className="text-sm font-medium">Повторювати з<input type="date" value={scheduleForm.valid_from} onChange={(event) => setScheduleForm((current) => ({ ...current, valid_from: event.target.value }))} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium">До<input type="date" value={scheduleForm.valid_until} onChange={(event) => setScheduleForm((current) => ({ ...current, valid_until: event.target.value }))} min={scheduleForm.valid_from} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
            </div>
            <div className="mt-5 flex gap-2"><button disabled={savingSchedule} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{savingSchedule && <Loader2 size={15} className="animate-spin" />} Зберегти</button><button type="button" onClick={() => setShowScheduleForm(false)} className="min-h-11 rounded-full border border-border px-4 py-2.5 text-sm">Скасувати</button></div>
          </form>
        </div>
      )}

      {editingHomework && group && canEditHomework && (
        <div className="xelay-dialog-backdrop fixed inset-0 z-[70] flex items-end justify-center bg-foreground/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(event) => { if (!savingHomework && event.target === event.currentTarget) setEditingHomework(null) }}>
          <form onSubmit={(event) => void saveHomework(event)} className="xelay-dialog-panel max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-border bg-background p-5 shadow-2xl sm:rounded-3xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Тема заняття та домашнє завдання</h2><p className="mt-1 text-sm text-muted-foreground">{editingHomework.subject} · {formatDate(homeworkDate, { day: 'numeric', month: 'long' })}</p></div><button type="button" disabled={savingHomework} onClick={() => setEditingHomework(null)} aria-label="Закрити" className="rounded-full p-2 text-muted-foreground hover:bg-muted disabled:opacity-50"><X size={18} /></button></div>
            {homeworkError && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{homeworkError}</p>}
            <label className="block text-sm font-medium">Тема заняття / примітка<input value={homeworkTopic} disabled={savingHomework} onChange={(event) => setHomeworkTopic(event.target.value)} maxLength={240} aria-describedby="lesson-topic-help" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base" placeholder="Наприклад, контрольна робота або інтеграли" /></label>
            <p id="lesson-topic-help" className="mt-1.5 text-xs text-muted-foreground">Відображається під назвою предмета лише на цю дату. Можна додати без домашнього завдання.</p>
            <label className="mt-4 block text-sm font-medium">Домашнє завдання<textarea value={homeworkBody} disabled={savingHomework} onChange={(event) => setHomeworkBody(event.target.value)} maxLength={10000} rows={6} className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-base" placeholder="Опишіть, що потрібно підготувати…" /></label>
            <HomeworkResourceFields links={homeworkLinks} onLinksChange={setHomeworkLinks}
              files={homeworkFiles} onFilesChange={setHomeworkFiles}
              attachments={homeworkAttachments} onAttachmentsChange={setHomeworkAttachments} disabled={savingHomework} />
            {homeworkUploadProgress.total > 0 && <p role="status" className="mt-3 text-sm text-primary">Завантаження файлів: {homeworkUploadProgress.completed} / {homeworkUploadProgress.total}</p>}
            {editingHomeworkRecordId && <p className="mt-2 text-xs text-muted-foreground">Щоб прибрати запис лише на цю дату, очистіть усі поля, приберіть вкладення та збережіть зміни.</p>}
            <div className="mt-5 flex gap-2"><button disabled={savingHomework} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{savingHomework && <Loader2 size={15} className="animate-spin" />} Зберегти</button><button type="button" disabled={savingHomework} onClick={() => setEditingHomework(null)} className="min-h-11 rounded-full border border-border px-4 py-2.5 text-sm disabled:opacity-50">Скасувати</button></div>
          </form>
        </div>
      )}
    </main>
  )
}
