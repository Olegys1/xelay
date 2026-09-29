import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight,
  GraduationCap, Loader2, MapPin, Pencil, Plus, Trash2, UsersRound, X,
} from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

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

type ScheduleItem = {
  id: string
  group_id: string
  weekday: number
  starts_at: string
  ends_at: string
  subject: string
  lesson_type: 'lecture' | 'seminar' | 'practical' | 'lab' | 'other'
  location: string
  online_url: string | null
  valid_from: string
  valid_until: string
  created_by: string
}

type HomeworkItem = {
  id: string
  group_id: string
  schedule_item_id: string
  lesson_date: string
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

export function StudyGroupsPage() {
  const { authUser, refreshUser } = useAuth()
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
      setError('Не вдалося обробити запрошення. Оновіть сторінку та спробуйте ще раз.')
    } else {
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
      setError(createError.message.includes('unique')
        ? 'Група з такими даними вже існує. Зверніться до адміністратора.'
        : 'Не вдалося створити групу. Оновіть сторінку та спробуйте ще раз.')
    } else if (groupId) {
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
  const navigate = useNavigate()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [group, setGroup] = useState<GroupSummary | null>(null)
  const [unitName, setUnitName] = useState('')
  const [universityName, setUniversityName] = useState('')
  const [members, setMembers] = useState<Array<MembershipRow & { profile?: MemberProfile }>>([])
  const [schedule, setSchedule] = useState<ScheduleItem[]>([])
  const [homework, setHomework] = useState<HomeworkItem[]>([])
  const [selectedDate, setSelectedDate] = useState(() => localDateString(new Date()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviteUsername, setInviteUsername] = useState('')
  const [inviting, setInviting] = useState(false)
  const [showScheduleForm, setShowScheduleForm] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<ScheduleItem | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [editingHomework, setEditingHomework] = useState<ScheduleItem | null>(null)
  const [homeworkBody, setHomeworkBody] = useState('')
  const [homeworkUrl, setHomeworkUrl] = useState('')
  const [savingHomework, setSavingHomework] = useState(false)
  const [expandedHomeworkIds, setExpandedHomeworkIds] = useState<Set<string>>(new Set())
  const [scheduleForm, setScheduleForm] = useState({
    weekday: String(isoWeekday(new Date())), starts_at: '09:00', ends_at: '10:20', subject: '',
    lesson_type: 'lecture' as ScheduleItem['lesson_type'], location: '', online_url: '',
    valid_from: localDateString(new Date()), valid_until: localDateString(new Date(new Date().setMonth(new Date().getMonth() + 4))),
  })

  const isRepresentative = Boolean(group && authUser?.id === group.representative_id)

  const loadGroup = useCallback(async () => {
    if (!authUser?.id) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const [groupResult, ownMembershipResult] = await Promise.all([
      supabase.from('study_groups').select('*').eq('id', id).maybeSingle(),
      supabase.from('study_group_members').select('id, status').eq('group_id', id).eq('user_id', authUser.id).maybeSingle(),
    ])
    if (groupResult.error || !groupResult.data) {
      setError('Групу не знайдено або у вас немає доступу.')
      setLoading(false)
      return
    }
    const groupData = groupResult.data as GroupSummary
    const isLeader = groupData.representative_id === authUser.id
    if (!isLeader && ownMembershipResult.data?.status !== 'accepted') {
      setError('Перегляд розкладу доступний лише учасникам, які прийняли запрошення.')
      setLoading(false)
      return
    }
    const [memberResult, scheduleResult, unitResult, universityResult] = await Promise.all([
      supabase.from('study_group_members').select('id, group_id, user_id, invited_by, status, created_at').eq('group_id', id).in('status', ['pending', 'accepted']).order('created_at'),
      supabase.from('study_group_schedule').select('*').eq('group_id', id).order('weekday').order('starts_at'),
      supabase.from('academic_units').select('name').eq('id', groupData.academic_unit_id).maybeSingle(),
      supabase.from('universities').select('name').eq('id', groupData.university_id).maybeSingle(),
    ])
    if (memberResult.error || scheduleResult.error) {
      console.error('Could not load group content:', memberResult.error || scheduleResult.error)
      setError('Не вдалося завантажити склад групи або розклад.')
      setLoading(false)
      return
    }
    const memberRows = (memberResult.data || []) as MembershipRow[]
    const profileIds = [...new Set(memberRows.map((member) => member.user_id))]
    const profilesResult = profileIds.length
      ? await supabase.from('profiles').select('id, full_name, username, avatar_url').in('id', profileIds)
      : { data: [], error: null }
    const profilesById = new Map(((profilesResult.data || []) as MemberProfile[]).map((profile) => [profile.id, profile]))
    setGroup(groupData)
    setMembers(memberRows.map((member) => ({ ...member, profile: profilesById.get(member.user_id) })))
    setSchedule((scheduleResult.data || []) as ScheduleItem[])
    setUnitName(unitResult.data?.name || '')
    setUniversityName(universityResult.data?.name || '')
    setLoading(false)
  }, [authUser?.id, id])

  useEffect(() => { void loadGroup() }, [loadGroup])

  useEffect(() => {
    if (!group?.id) return
    let active = true
    const loadHomework = async () => {
      const { data, error: homeworkError } = await supabase.from('study_group_homework')
        .select('*').eq('group_id', group.id).eq('lesson_date', selectedDate)
      if (!active) return
      if (homeworkError) setError('Не вдалося завантажити домашні завдання.')
      else setHomework((data || []) as HomeworkItem[])
    }
    void loadHomework()
    return () => { active = false }
  }, [group?.id, selectedDate])

  const selectedDateObject = useMemo(() => parseLocalDate(selectedDate), [selectedDate])
  const currentWeekday = isoWeekday(selectedDateObject)
  const currentWeekDates = WEEKDAYS.map((day) => ({ ...day, date: localDateString(dateForWeekday(selectedDateObject, day.id)) }))
  const visibleSchedule = schedule.filter((item) => item.weekday === currentWeekday && selectedDate >= item.valid_from && selectedDate <= item.valid_until)
  const homeworkBySchedule = new Map(homework.map((item) => [item.schedule_item_id, item]))

  const changeWeek = (amount: number) => {
    const nextDate = parseLocalDate(selectedDate)
    nextDate.setDate(nextDate.getDate() + amount * 7)
    setSelectedDate(localDateString(nextDate))
  }

  const inviteMember = async (event: FormEvent) => {
    event.preventDefault()
    if (!group) return
    setInviting(true)
    setError('')
    const { error: inviteError } = await supabase.rpc('xelay_invite_to_study_group', {
      p_group_id: group.id,
      p_username: inviteUsername.trim(),
    })
    if (inviteError) {
      console.error('Could not invite group member:', inviteError)
      setError(inviteError.message.includes('not found')
        ? 'Користувача з таким Xelay-ніком не знайдено.'
        : 'Не вдалося надіслати запрошення.')
    } else {
      setInviteUsername('')
      await loadGroup()
    }
    setInviting(false)
  }

  const removeMember = async (member: MembershipRow) => {
    if (!window.confirm('Видалити учасника з групи?')) return
    setError('')
    const { error: removeError } = await supabase.rpc('xelay_remove_study_group_member', { p_member_id: member.id })
    if (removeError) {
      console.error('Could not remove group member:', removeError)
      setError('Не вдалося видалити учасника.')
    } else await loadGroup()
  }

  const openNewScheduleForm = () => {
    setEditingSchedule(null)
    const endDate = new Date(parseLocalDate(selectedDate))
    endDate.setMonth(endDate.getMonth() + 4)
    setScheduleForm({
      weekday: String(currentWeekday), starts_at: '09:00', ends_at: '10:20', subject: '',
      lesson_type: 'lecture', location: '', online_url: '', valid_from: selectedDate,
      valid_until: localDateString(endDate),
    })
    setShowScheduleForm(true)
  }

  const openEditScheduleForm = (item: ScheduleItem) => {
    setEditingSchedule(item)
    setScheduleForm({
      weekday: String(item.weekday), starts_at: item.starts_at.slice(0, 5), ends_at: item.ends_at.slice(0, 5),
      subject: item.subject, lesson_type: item.lesson_type, location: item.location || '',
      online_url: item.online_url || '', valid_from: item.valid_from, valid_until: item.valid_until,
    })
    setShowScheduleForm(true)
  }

  const saveSchedule = async (event: FormEvent) => {
    event.preventDefault()
    if (!group || !authUser?.id) return
    setSavingSchedule(true)
    setError('')
    const values = {
      group_id: group.id,
      weekday: Number(scheduleForm.weekday),
      starts_at: scheduleForm.starts_at,
      ends_at: scheduleForm.ends_at,
      subject: scheduleForm.subject.trim(),
      lesson_type: scheduleForm.lesson_type,
      location: scheduleForm.location.trim(),
      online_url: scheduleForm.online_url.trim() || null,
      valid_from: scheduleForm.valid_from,
      valid_until: scheduleForm.valid_until,
      created_by: authUser.id,
    }
    const result = editingSchedule
      ? await supabase.from('study_group_schedule').update(values).eq('id', editingSchedule.id)
      : await supabase.from('study_group_schedule').insert(values)
    if (result.error) {
      console.error('Could not save schedule item:', result.error)
      setError('Не вдалося зберегти пару. Перевірте час і період повторення.')
    } else {
      setShowScheduleForm(false)
      setEditingSchedule(null)
      await loadGroup()
    }
    setSavingSchedule(false)
  }

  const deleteSchedule = async (item: ScheduleItem) => {
    if (!window.confirm(`Видалити «${item.subject}» з розкладу? Домашні завдання до цієї пари також буде видалено.`)) return
    const { error: deleteError } = await supabase.from('study_group_schedule').delete().eq('id', item.id)
    if (deleteError) setError('Не вдалося видалити пару.')
    else await loadGroup()
  }

  const openHomeworkForm = (item: ScheduleItem) => {
    const existing = homeworkBySchedule.get(item.id)
    setEditingHomework(item)
    setHomeworkBody(existing?.body || '')
    setHomeworkUrl(existing?.url || '')
  }

  const saveHomework = async (event: FormEvent) => {
    event.preventDefault()
    if (!group || !authUser?.id || !editingHomework) return
    setSavingHomework(true)
    setError('')
    const existing = homeworkBySchedule.get(editingHomework.id)
    const values = {
      group_id: group.id,
      schedule_item_id: editingHomework.id,
      lesson_date: selectedDate,
      body: homeworkBody.trim(),
      url: homeworkUrl.trim() || null,
      created_by: authUser.id,
    }
    const result = existing
      ? await supabase.from('study_group_homework').update(values).eq('id', existing.id)
      : await supabase.from('study_group_homework').insert(values)
    if (result.error) {
      console.error('Could not save homework:', result.error)
      setError('Не вдалося зберегти домашнє завдання. Перевірте, що дата відповідає повторюваній парі.')
    } else {
      setEditingHomework(null)
      const { data } = await supabase.from('study_group_homework').select('*').eq('group_id', group.id).eq('lesson_date', selectedDate)
      setHomework((data || []) as HomeworkItem[])
    }
    setSavingHomework(false)
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
                <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="min-w-0 bg-transparent text-sm" />
              </label>
            </header>

            {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

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
                {isRepresentative && <button onClick={openNewScheduleForm} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90"><Plus size={14} /> Додати пару</button>}
              </div>

              <div className="space-y-3 px-4 pb-5 pt-2 sm:px-5">
                {visibleSchedule.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center">
                    <CalendarDays size={24} className="mx-auto mb-2 text-primary/70" />
                    <p className="text-sm text-muted-foreground">На цей день занять не заплановано.</p>
                  </div>
                ) : visibleSchedule.map((item) => {
                  const homeworkItem = homeworkBySchedule.get(item.id)
                  const isExpanded = expandedHomeworkIds.has(item.id)
                  const shouldCollapse = Boolean(homeworkItem && homeworkItem.body.length > 220)
                  return (
                    <article key={item.id} className="grid min-w-0 grid-cols-[62px_minmax(0,1fr)] gap-3 sm:grid-cols-[84px_minmax(0,1fr)] sm:gap-4">
                      <div className="pt-3 text-right text-xs font-semibold tabular-nums text-muted-foreground sm:text-sm"><span className="block text-primary">{item.starts_at.slice(0, 5)}</span><span className="mt-0.5 block font-normal">{item.ends_at.slice(0, 5)}</span></div>
                      <div className="min-w-0 rounded-2xl border border-primary/15 bg-accent/35 p-3.5 sm:p-4">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0"><span className="inline-flex rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-primary">{LESSON_TYPES[item.lesson_type]}</span><h4 className="mt-1.5 break-words font-semibold text-foreground">{item.subject}</h4></div>
                          {isRepresentative && <div className="flex shrink-0 items-center gap-0.5"><button onClick={() => openEditScheduleForm(item)} aria-label="Редагувати пару" title="Редагувати пару" className="rounded-full p-2 text-primary hover:bg-accent"><Pencil size={15} /></button><button onClick={() => void deleteSchedule(item)} aria-label="Видалити пару" title="Видалити пару" className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={15} /></button></div>}
                        </div>
                        {(item.location || item.online_url) && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{item.location && <span className="inline-flex items-center gap-1"><MapPin size={13} />{item.location}</span>}{item.online_url && <a href={item.online_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Посилання на заняття</a>}</div>}
                        <p className="mt-2 text-[11px] text-muted-foreground">Повторюється до {formatDate(item.valid_until, { day: 'numeric', month: 'long', year: 'numeric' })}</p>

                        {homeworkItem ? (
                          <div className="mt-3 border-t border-primary/10 pt-3">
                            <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-foreground">Домашнє завдання</p>{isRepresentative && <button onClick={() => openHomeworkForm(item)} className="text-xs font-medium text-primary hover:underline">Редагувати</button>}</div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{shouldCollapse && !isExpanded ? `${homeworkItem.body.slice(0, 220).trimEnd()}…` : homeworkItem.body}</p>
                            {shouldCollapse && <button onClick={() => setExpandedHomeworkIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} className="mt-1 text-xs font-medium text-primary hover:underline">{isExpanded ? 'Згорнути' : 'Показати повністю'}</button>}
                            {homeworkItem.url && <a href={homeworkItem.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full break-all text-xs font-medium text-primary hover:underline">Відкрити матеріал</a>}
                          </div>
                        ) : isRepresentative ? (
                          <button onClick={() => openHomeworkForm(item)} className="mt-3 inline-flex items-center gap-1.5 border-t border-primary/10 pt-3 text-xs font-semibold text-primary hover:underline"><Plus size={14} /> Додати домашнє завдання</button>
                        ) : <p className="mt-3 border-t border-primary/10 pt-3 text-xs text-muted-foreground">Домашнє завдання ще не додане.</p>}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>

            {isRepresentative && (
              <section className="xelay-card mt-6 min-w-0 p-4 sm:p-5">
                <div className="flex items-center gap-2"><UsersRound size={18} className="text-primary" /><h2 className="font-semibold">Учасники групи</h2><span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">{members.filter((member) => member.status === 'accepted').length}</span></div>
                <form onSubmit={(event) => void inviteMember(event)} className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <input value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value)} required maxLength={32} placeholder="Нік у Xelay" className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm" />
                  <button disabled={inviting} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{inviting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Запросити</button>
                </form>
                <div className="mt-4 divide-y divide-border">
                  {members.map((member) => (
                    <div key={member.id} className="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0">
                      {member.profile?.avatar_url ? <img src={member.profile.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-primary">{member.profile?.full_name?.[0] || '?'}</span>}
                      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.profile?.full_name || 'Учасник Xelay'}{member.user_id === group.representative_id && <span className="ml-1.5 text-xs font-normal text-primary">староста</span>}</p><p className="truncate text-xs text-muted-foreground">{member.profile?.username ? `@${member.profile.username}` : member.status === 'pending' ? 'Запрошення надіслано' : ''}</p></div>
                      <span className={`shrink-0 text-xs ${member.status === 'pending' ? 'text-muted-foreground' : 'text-emerald-700'}`}>{member.status === 'pending' ? 'Очікує' : 'У групі'}</span>
                      {member.user_id !== authUser.id && <button onClick={() => void removeMember(member)} aria-label="Видалити учасника" title="Видалити учасника" className="shrink-0 rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><X size={15} /></button>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : null}
      </div>

      {showScheduleForm && group && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-foreground/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowScheduleForm(false) }}>
          <form onSubmit={(event) => void saveSchedule(event)} className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-border bg-background p-5 shadow-2xl sm:rounded-3xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">{editingSchedule ? 'Редагувати пару' : 'Додати пару'}</h2><p className="mt-1 text-xs text-muted-foreground">Пара повторюватиметься щотижня до вказаної дати.</p></div><button type="button" onClick={() => setShowScheduleForm(false)} aria-label="Закрити" className="rounded-full p-2 text-muted-foreground hover:bg-muted"><X size={18} /></button></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">День тижня<select value={scheduleForm.weekday} onChange={(event) => setScheduleForm((current) => ({ ...current, weekday: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">{WEEKDAYS.map((day) => <option key={day.id} value={day.id}>{day.full}</option>)}</select></label>
              <label className="text-sm font-medium">Тип заняття<select value={scheduleForm.lesson_type} onChange={(event) => setScheduleForm((current) => ({ ...current, lesson_type: event.target.value as ScheduleItem['lesson_type'] }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">{Object.entries(LESSON_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="text-sm font-medium sm:col-span-2">Предмет<input value={scheduleForm.subject} onChange={(event) => setScheduleForm((current) => ({ ...current, subject: event.target.value }))} required maxLength={120} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" placeholder="Назва предмета" /></label>
              <label className="text-sm font-medium">Початок<input type="time" value={scheduleForm.starts_at} onChange={(event) => setScheduleForm((current) => ({ ...current, starts_at: event.target.value }))} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium">Завершення<input type="time" value={scheduleForm.ends_at} onChange={(event) => setScheduleForm((current) => ({ ...current, ends_at: event.target.value }))} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium sm:col-span-2">Аудиторія або місце<input value={scheduleForm.location} onChange={(event) => setScheduleForm((current) => ({ ...current, location: event.target.value }))} maxLength={160} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" placeholder="Наприклад, ауд. 305 або Online" /></label>
              <label className="text-sm font-medium sm:col-span-2">Посилання на онлайн-заняття<input type="url" value={scheduleForm.online_url} onChange={(event) => setScheduleForm((current) => ({ ...current, online_url: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" placeholder="https://…" /></label>
              <label className="text-sm font-medium">Повторювати з<input type="date" value={scheduleForm.valid_from} onChange={(event) => setScheduleForm((current) => ({ ...current, valid_from: event.target.value }))} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
              <label className="text-sm font-medium">До<input type="date" value={scheduleForm.valid_until} onChange={(event) => setScheduleForm((current) => ({ ...current, valid_until: event.target.value }))} min={scheduleForm.valid_from} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" /></label>
            </div>
            <div className="mt-5 flex gap-2"><button disabled={savingSchedule} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{savingSchedule && <Loader2 size={15} className="animate-spin" />} Зберегти</button><button type="button" onClick={() => setShowScheduleForm(false)} className="min-h-11 rounded-full border border-border px-4 py-2.5 text-sm">Скасувати</button></div>
          </form>
        </div>
      )}

      {editingHomework && group && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-foreground/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingHomework(null) }}>
          <form onSubmit={(event) => void saveHomework(event)} className="w-full max-w-xl rounded-t-3xl border border-border bg-background p-5 shadow-2xl sm:rounded-3xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Домашнє завдання</h2><p className="mt-1 text-sm text-muted-foreground">{editingHomework.subject} · {formatDate(selectedDate, { day: 'numeric', month: 'long' })}</p></div><button type="button" onClick={() => setEditingHomework(null)} aria-label="Закрити" className="rounded-full p-2 text-muted-foreground hover:bg-muted"><X size={18} /></button></div>
            <label className="block text-sm font-medium">Опис<textarea value={homeworkBody} onChange={(event) => setHomeworkBody(event.target.value)} required minLength={1} maxLength={10000} rows={6} className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5" placeholder="Опишіть, що потрібно підготувати…" /></label>
            <label className="mt-4 block text-sm font-medium">Посилання на матеріал<input type="url" value={homeworkUrl} onChange={(event) => setHomeworkUrl(event.target.value)} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5" placeholder="https://…" /></label>
            <div className="mt-5 flex gap-2"><button disabled={savingHomework} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{savingHomework && <Loader2 size={15} className="animate-spin" />} Зберегти завдання</button><button type="button" onClick={() => setEditingHomework(null)} className="min-h-11 rounded-full border border-border px-4 py-2.5 text-sm">Скасувати</button></div>
          </form>
        </div>
      )}
    </main>
  )
}
