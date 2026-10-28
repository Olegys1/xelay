import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Archive, BookOpen, CalendarDays, Check, ChevronDown, ChevronRight, ClipboardList, Clock3, ExternalLink, FolderOpen, GraduationCap, MessageSquareText, Plus, RefreshCw, Search, Settings2, UsersRound, X } from 'lucide-react'
import { EMPTY_TEACHING_SEMINARS, TEACHING_PERMISSIONS, teachingDate, teachingError, type TeachingRepository, type TeachingSnapshot, type TeachingWorkspaceData } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingCourseForms, type CourseDialog } from './TeachingCourseForms'
import { TeachingPublications } from './TeachingPublications'
import { TeachingMyMaterials } from './TeachingMyMaterials'
import { TeachingGradebook } from './TeachingGradebook'
import { TeacherPermissionControl } from './TeacherPermissionControl'
import { TeachingClassroomGuide } from './TeachingClassroomGuide'
import { TeachingCalendar } from './TeachingCalendar'
import { TeachingScheduledPublications } from './TeachingScheduledPublications'
import { TeachingGradeRequests } from './TeachingGradeRequests'
import './teaching-workflow.css'
import { teachingGroupDirectoryLabel } from '../../lib/teachingGroupDirectory'
import type { TeachingJournalFocus } from '../../lib/teachingGradeFollowup'
import { createTeachingReadRepository } from '../../lib/teachingReadRepository'
import { useTeachingVisibilityRefresh } from '../../lib/useTeachingVisibilityRefresh'
import { teachingSemesterKey, teachingSemesterPeriod, teachingSemesters, type TeachingSemesterPeriod } from '../../lib/teachingSemesterJournal'
import { kyivToday } from '../../lib/seminars'
import { TeachingSentGroupRequests } from './TeachingSentGroupRequests'

const TABS = [
  { id: 'assignments', label: 'Завдання', icon: ClipboardList, permission: 'assignments' },
  { id: 'materials', label: 'Матеріали', icon: FolderOpen, permission: 'materials' },
  { id: 'grades', label: 'Журнал', icon: BookOpen, permission: 'grades' },
] as const
type Tab = typeof TABS[number]['id']
type WorkspaceView = 'groups' | 'calendar' | 'scheduled' | 'requests' | 'materials' | 'connections'
type Selection = { repository: TeachingRepository; courseId: string | null; groupId: string; view: WorkspaceView }
type Props = { repository: TeachingRepository; userId: string; fullName: string; initialCourseId?: string; initialGroupId?: string; initialView?: 'groups' | 'materials'; embedded?: boolean; onOpenGroup?: (groupId: string, courseId: string) => void }
const TeachingPublicationsView = memo(TeachingPublications)
const TeachingGradebookView = memo(TeachingGradebook)

function classroomSnapshot(snapshot: TeachingSnapshot, groupId: string): TeachingSnapshot {
  const entries = snapshot.entries.filter(entry => entry.group_id === groupId)
  const activities = snapshot.activities.filter(activity => activity.group_id === groupId)
  const entryIds = new Set(entries.map(entry => entry.id)), activityIds = new Set(activities.map(activity => activity.id))
  return { ...snapshot, course: { ...snapshot.course, permissions: snapshot.groups.find(group => group.group_id === groupId)?.permissions ?? snapshot.course.permissions }, groups: snapshot.groups.filter(group => group.group_id === groupId), entries, activities,
    grades: snapshot.grades.filter(grade => entryIds.has(grade.entry_id) && activityIds.has(grade.activity_id)),
    assignments: snapshot.assignments.filter(item => item.targets.some(target => target.group_id === groupId)), materials: snapshot.materials.filter(item => item.targets.some(target => target.group_id === groupId)),
    audit: snapshot.audit.filter(item => entryIds.has(item.entry_id) && activityIds.has(item.activity_id)),
    roster_claims: snapshot.roster_claims.filter(claim => entryIds.has(claim.entry_id)), members: snapshot.members.filter(member => member.group_id === groupId),
    seminars: EMPTY_TEACHING_SEMINARS,
  }
}

export function TeachingWorkspace({ repository: sourceRepository, userId, fullName, initialCourseId, initialGroupId, initialView = 'groups', embedded = false, onOpenGroup }: Props) {
  const repository = useMemo(() => createTeachingReadRepository(sourceRepository, userId), [sourceRepository, userId])
  // Scope tags hide the previous account's state before its cleanup effect runs.
  const [selection, setSelection] = useState<Selection>(() => ({ repository, courseId: initialCourseId || null, groupId: initialGroupId || '', view: initialView }))
  const currentSelection = selection.repository === repository ? selection : { repository, courseId: initialCourseId || null, groupId: initialGroupId || '', view: initialView }
  const { courseId, groupId, view: workspaceView } = currentSelection
  const context = useRef(currentSelection)
  context.current = currentSelection
  const select = useCallback((patch: Partial<Omit<Selection, 'repository'>>) => {
    if (context.current.repository !== repository) return
    const next = { ...context.current, ...patch }
    context.current = next
    setSelection(next)
  }, [repository])
  const setWorkspaceView = (view: WorkspaceView) => select({ view })
  const [workspaceResult, setWorkspaceResult] = useState<{ repository: TeachingRepository; data: TeachingWorkspaceData | null; loading: boolean }>({ repository, data: null, loading: true })
  const [courseResult, setCourseResult] = useState<{ repository: TeachingRepository; courseId: string; data: TeachingSnapshot | null; loading: boolean } | null>(null)
  const workspace = workspaceResult.repository === repository ? workspaceResult.data : null
  const snapshot = courseResult?.repository === repository && courseResult.courseId === courseId ? courseResult.data : null
  const [tab, setTab] = useState<Tab>('assignments')
  const [dialog, setDialog] = useState<CourseDialog | null>(null)
  const [failure, setFailure] = useState({ repository, message: '' })
  const error = failure.repository === repository ? failure.message : ''
  const setError = useCallback((message: string) => setFailure({ repository, message }), [repository])
  const [actionState, setActionState] = useState({ repository, action: '' })
  const busy = actionState.repository === repository ? actionState.action : ''
  const [semesterPeriod, setSemesterPeriod] = useState<TeachingSemesterPeriod>('current'), [semester, setSemester] = useState(''), [query, setQuery] = useState('')
  const today = kyivToday()
  const archived = semesterPeriod === 'previous'
  const [confirm, setConfirm] = useState<{ action: string; payload: Record<string, unknown>; title: string; body: string } | null>(null)
  const [journalDate, setJournalDate] = useState('')
  const [journalFocus, setJournalFocus] = useState<TeachingJournalFocus | undefined>()
  const [refreshKeys, setRefreshKeys] = useState({ calendar: 0, scheduled: 0, requests: 0, materials: 0 })
  const workspaceGeneration = useRef(0), courseGeneration = useRef(0), mounted = useRef(true)
  const actionLock = useRef<TeachingRepository | null>(null)
  const explicitCourseLoad = useRef<{ repository: TeachingRepository; id: string } | null>(null)
  const explicitGroupRefresh = useRef<TeachingRepository | null>(null)
  const previousView = useRef({ repository, view: workspaceView })
  const loading = workspaceResult.repository !== repository || workspaceResult.loading || workspaceView === 'groups' && Boolean(courseId && (courseResult?.repository !== repository || courseResult.courseId !== courseId || courseResult.loading))
  // A background read must not unmount an open editor or discard its local draft.
  const showLoading = loading && (!workspace || Boolean(courseId && !snapshot))
  const loadWorkspace = useCallback(async () => {
    if (!mounted.current || context.current.repository !== repository) return
    const version = ++workspaceGeneration.current
    setError('')
    setWorkspaceResult(previous => ({ repository, data: previous.repository === repository ? previous.data : null, loading: true }))
    try {
      const next = await repository.workspace()
      if (!mounted.current || context.current.repository !== repository || workspaceGeneration.current !== version) return
      setWorkspaceResult({ repository, data: next, loading: false })
      const selected = context.current
      if (selected.groupId && !selected.courseId) {
        const groupCourses = next.classrooms?.find(classroom => classroom.group_id === selected.groupId)?.courses
        const first = groupCourses?.find(link => next.courses.some(item => item.id === link.course_id && !item.archived_at)) || groupCourses?.[0]
        if (first) select({ courseId: first.course_id })
      } else if (!selected.groupId && selected.courseId && !embedded) {
        const first = next.classrooms?.find(classroom => classroom.courses.some(link => link.course_id === selected.courseId))
        if (first) select({ groupId: first.group_id })
      }
    } catch (failure) {
      if (mounted.current && context.current.repository === repository && workspaceGeneration.current === version) {
        setWorkspaceResult(previous => ({ repository, data: previous.repository === repository ? previous.data : null, loading: false }))
        setError(teachingError(failure)); throw failure
      }
    }
  }, [repository, embedded, select, setError])
  const loadCourse = useCallback(async (id: string) => {
    if (!mounted.current || context.current.repository !== repository || context.current.courseId !== id || context.current.view !== 'groups') return
    const version = ++courseGeneration.current
    const current = () => mounted.current && context.current.repository === repository && context.current.courseId === id && context.current.view === 'groups' && courseGeneration.current === version
    setError('')
    setCourseResult(previous => ({ repository, courseId: id, data: previous?.repository === repository && previous.courseId === id ? previous.data : null, loading: true }))
    try {
      const detail = await repository.course(id)
      if (!current()) return
      setCourseResult({ repository, courseId: id, data: detail, loading: false }); setSemesterPeriod(teachingSemesterPeriod(detail.course, kyivToday())); setSemester(selected => !selected || selected === teachingSemesterKey(detail.course) ? selected : '')
    } catch (failure) {
      if (current()) {
        const item = failure as { code?: string; message?: string; status?: number }
        const denied = /FORBIDDEN|ACTOR_CHANGED|JWT|ACCESS_EXPIRED/.test(`${item.code || ''} ${item.message || ''}`) || item.status === 401 || item.status === 403
        setCourseResult(previous => ({ repository, courseId: id, data: !denied && previous?.repository === repository && previous.courseId === id ? previous.data : null, loading: false }))
        setError(teachingError(failure)); throw failure
      }
    }
  }, [repository, setError])
  const load = useCallback(async () => {
    if (context.current.repository !== repository) return
    const selected = context.current
    await Promise.all([loadWorkspace(), selected.view === 'groups' && selected.courseId ? loadCourse(selected.courseId) : Promise.resolve()])
  }, [repository, loadWorkspace, loadCourse])
  useEffect(() => {
    mounted.current = true
    setDialog(null); setConfirm(null); setTab('assignments'); setJournalDate(''); setJournalFocus(undefined); setQuery(''); setSemesterPeriod('current'); setSemester('')
    void loadWorkspace().catch(() => {})
    return () => { mounted.current = false; workspaceGeneration.current++; courseGeneration.current++ }
  }, [repository, loadWorkspace])
  useEffect(() => {
    const previous = previousView.current
    previousView.current = { repository, view: workspaceView }
    if (previous.repository !== repository || previous.view === 'groups' || workspaceView !== 'groups') return
    if (explicitGroupRefresh.current === repository) explicitGroupRefresh.current = null
    else void loadWorkspace().catch(() => {})
  }, [repository, workspaceView, loadWorkspace])
  useEffect(() => { if (workspaceView === 'connections') void loadWorkspace().catch(() => {}) }, [workspaceView, loadWorkspace])
  // Changing only the classroom does not change this effect's dependencies.
  useEffect(() => {
    if (workspaceView !== 'groups' || !courseId) return
    const explicit = explicitCourseLoad.current
    explicitCourseLoad.current = null
    if (!(explicit?.repository === repository && explicit.id === courseId)) void loadCourse(courseId).catch(() => {})
  }, [repository, courseId, workspaceView, loadCourse])
  useTeachingVisibilityRefresh(() => workspaceView === 'connections' ? loadWorkspace() : load(), { enabled: workspaceView === 'groups' || workspaceView === 'connections', blocked: Boolean(dialog || confirm || busy) })
  useEffect(() => {
    const currentTab = TABS.find(item => item.id === tab)
    const permissions = snapshot?.groups.find(group => group.group_id === groupId)?.permissions ?? snapshot?.course.permissions ?? []
    if (snapshot && (!currentTab || !(permissions.includes(currentTab.permission) || tab === 'assignments' && permissions.includes('grades')))) setTab(TABS.find(item => permissions.includes(item.permission))?.id || 'assignments')
  }, [snapshot, tab, groupId])
  async function act(action: string, payload: Record<string, unknown>) {
    if (context.current.repository !== repository || actionLock.current === repository) return
    actionLock.current = repository; setActionState({ repository, action }); setError('')
    let changed = false
    try { await repository.mutate(action, payload); changed = true; if (context.current.repository === repository) { setConfirm(null); await load() } }
    catch (failure) { if (context.current.repository === repository) setError(`${changed ? 'Зміну збережено. Оновіть дані перед наступною дією. ' : ''}${teachingError(failure)}`) }
    finally { if (actionLock.current === repository) actionLock.current = null; if (context.current.repository === repository) setActionState({ repository, action: '' }) }
  }
  async function saved(id?: string) {
    if (!mounted.current || context.current.repository !== repository) throw new Error('TEACHING_ACTOR_CHANGED')
    if (id) {
      setSemester('')
      if (context.current.courseId !== id || context.current.view !== 'groups') explicitCourseLoad.current = { repository, id }
      if (context.current.view !== 'groups') explicitGroupRefresh.current = repository
      select({ groupId: '', courseId: id, view: 'groups' }); setTab('assignments')
      await Promise.all([loadWorkspace(), loadCourse(id)])
    } else await load()
  }
  function refreshActiveView() {
    if (workspaceView === 'groups') void load().catch(() => {})
    else if (workspaceView === 'connections') void loadWorkspace().catch(() => {})
    else setRefreshKeys(previous => ({ ...previous, [workspaceView]: previous[workspaceView] + 1 }))
  }
  const course = snapshot?.course
  const accessExpired = workspace?.teacher_status.verified === true && workspace.teacher_status.has_current_access === false
  const owner = !accessExpired && course?.owner_id === userId && Boolean(course.permissions.includes('manage'))
  const verified = workspace?.teacher_status.verified === true && !accessExpired
  const semesters = useMemo(() => teachingSemesters(workspace?.courses || [], semesterPeriod, today), [workspace, semesterPeriod, today])
  const courseList = useMemo(() => workspace?.courses.filter(item => item.permissions.length && (semesterPeriod === 'all' || teachingSemesterPeriod(item, today) === semesterPeriod) && (!semester || teachingSemesterKey(item) === semester) && !(workspace.invitations || workspace.teacher_invites || []).some(invite => invite.course_id === item.id && invite.status === 'pending' && !item.permissions.length)) || [], [workspace, semesterPeriod, semester, today])
  const classrooms = useMemo(() => (workspace?.classrooms || []).map(classroom => ({ ...classroom, courses: classroom.courses.filter(link => courseList.some(item => item.id === link.course_id)) })).filter(classroom => classroom.courses.length && (!embedded || classroom.group_id === initialGroupId)), [workspace, courseList, embedded, initialGroupId])
  const calendarCourses = useMemo(() => (workspace?.courses || []).filter(item => item.permissions.length > 0), [workspace])
  const coursesWithoutGroup = courseList.filter(item => !classrooms.some(classroom => classroom.courses.some(link => link.course_id === item.id)))
  const selectedClassroom = classrooms.find(classroom => classroom.group_id === groupId)
  const selectedGroup = snapshot?.groups.find(group => group.group_id === groupId && group.status === 'accepted')
  const groupName = selectedClassroom?.group_name || selectedGroup?.group_name || workspace?.groups.find(group => group.id === groupId)?.group_name || 'Навчальна група'
  const availableCourses = selectedClassroom ? courseList.filter(item => selectedClassroom.courses.some(link => link.course_id === item.id)) : []
  const classroomLabel = (classroom: typeof classrooms[number], includeName = true) => teachingGroupDirectoryLabel({ ...classroom, id: classroom.group_id }, includeName)
  const linkedGroupLabel = (link: NonNullable<typeof snapshot>['groups'][number]) => teachingGroupDirectoryLabel({ ...workspace?.groups.find(group => group.id === link.group_id), ...link })
  const colleagueGroupsLabel = (teacher: NonNullable<typeof snapshot>['teachers'][number]) => teacher.group_scope === 'selected'
    ? `Групи: ${(teacher.group_ids || []).map(id => snapshot?.groups.find(group => group.group_id === id)?.group_name || workspace?.groups.find(group => group.id === id)?.group_name || 'Вибрана група').join(', ') || 'не вибрано'}`
    : 'Доступ до всіх груп предмета'
  const filteredClassrooms = classrooms.filter(classroom => !query.trim() || `${classroomLabel(classroom)} ${classroom.courses.map(link => courseList.find(item => item.id === link.course_id)?.title || '').join(' ')}`.toLocaleLowerCase('uk-UA').includes(query.trim().toLocaleLowerCase('uk-UA')))
  const groupSnapshot = useMemo(() => snapshot && selectedGroup ? classroomSnapshot(snapshot, groupId) : null, [snapshot, selectedGroup, groupId])
  const groupPermissions = selectedGroup?.permissions ?? course?.permissions ?? []
  const visibleTabs = TABS.filter(item => groupPermissions.includes(item.permission) || item.id === 'assignments' && groupPermissions.includes('grades'))
  const back = () => { if (embedded) return; select({ groupId: '', courseId: null, view: 'groups' }); setTab('assignments'); setJournalDate(''); setJournalFocus(undefined) }
  const openCourse = (id: string) => {
    const next = workspace?.courses.find(item => item.id === id)
    if (next) { setSemesterPeriod(teachingSemesterPeriod(next, today)); setSemester('') }
    const first = !embedded ? workspace?.classrooms?.find(classroom => classroom.courses.some(link => link.course_id === id)) : undefined
    select({ groupId: first?.group_id || (embedded ? initialGroupId || '' : ''), courseId: id }); setTab('assignments')
  }
  function changeSemester(period: TeachingSemesterPeriod, key = '') {
    setSemesterPeriod(period); setSemester(key); setQuery(''); select({ groupId: '', courseId: null, view: 'groups' }); setTab('assignments')
  }
  function chooseGroup(id: string, selectedCourseId?: string) {
    if (embedded && id !== initialGroupId) return
    const classroom = classrooms.find(item => item.group_id === id)
    const nextCourse = selectedCourseId || (classroom?.courses.some(link => link.course_id === courseId) ? courseId : classroom?.courses[0]?.course_id) || null
    select({ groupId: id, courseId: nextCourse }); setTab('assignments')
    setJournalDate(''); setJournalFocus(undefined)
  }
  function openJournal(id: string, selectedCourseId: string, date = '') {
    const target = workspace?.courses.find(item => item.id === selectedCourseId)
    setSemester(''); if (target) setSemesterPeriod(teachingSemesterPeriod(target, today))
    chooseGroup(id, selectedCourseId); setTab('grades'); setJournalDate(date); setWorkspaceView('groups')
  }
  const openReviewJournal = useCallback((focus: TeachingJournalFocus) => {
    if (focus.courseId !== courseId || focus.groupId !== groupId || !groupPermissions.includes('grades')) return
    setJournalFocus(focus); setJournalDate(''); setTab('grades'); select({ view: 'groups' })
  }, [courseId, groupId, groupPermissions, select])
  const invitationList = workspace?.invitations || workspace?.teacher_invites || []
  const acceptedGroups = snapshot?.groups.filter(link => link.status === 'accepted' && (!embedded || link.group_id === initialGroupId)) || []
  const waitingForHead = snapshot?.groups.filter(link => link.status === 'pending_group') || []
  const waitingForTeacher = snapshot?.groups.filter(link => link.status === 'pending_teacher') || []
  const courseNextTitle = acceptedGroups.length ? 'Оберіть підключену групу' : waitingForTeacher.length ? 'Підтвердьте запрошення старости' : waitingForHead.length ? 'Очікуємо підтвердження старости' : 'Підключіть першу групу до предмета'
  const courseNextDescription = acceptedGroups.length ? 'Завдання, матеріали та журнал відкриваються окремо для кожної групи.'
    : waitingForTeacher.length ? 'Запрошення вже є. У блоці «Підключення груп» нижче натисніть «Прийняти», щоб почати роботу.'
    : waitingForHead.length ? 'Запрошення надіслано. Попросіть старосту підтвердити його в навчальній групі. Повторно створювати предмет не потрібно.'
    : owner ? 'Предмет уже збережено. Оберіть навчальну групу й надішліть запрошення. Після підтвердження старостою зможете дати завдання та відкрити журнал.'
    : 'Групу підключає власник предмета. Після прийняття запрошення ви зможете працювати в межах наданих дозволів.'

  return <main className={embedded ? 'teaching-classroom-embedded' : 'teaching-page'}>
    <header className="teaching-heading"><div>
      {!embedded && (groupId || courseId) ? <button type="button" className="mb-3 inline-flex min-h-10 items-center gap-2 text-xs font-medium text-muted-foreground hover:text-primary" onClick={back}><ArrowLeft size={15} />Мої групи</button> : <span className="teaching-eyebrow"><GraduationCap size={15} />Викладання</span>}
      <h1>{workspaceView === 'materials' ? 'Мої матеріали' : workspaceView === 'calendar' ? 'Мій розклад' : workspaceView === 'scheduled' ? 'Заплановані публікації' : workspaceView === 'requests' ? 'Запити щодо балів' : workspaceView === 'connections' ? 'Надіслані запити' : groupId ? groupName : course ? course.title : archived ? 'Минулі семестри' : 'Мої групи'}</h1>
      <p>{workspaceView !== 'groups' ? 'Ваші предмети та підключені навчальні групи.' : groupId ? 'Завдання, здані роботи, матеріали та журнал цієї групи.' : course ? 'Підключіть групу до предмета, щоб працювати з її завданнями та результатами.' : `${fullName.split(' ')[0]}, оберіть групу та предмет, з якими працюватимете.`}</p>
    </div><div className="flex flex-wrap gap-2">
      <a className="teaching-button" href="/guides/#teacher/__first-setup" target="_blank" rel="noopener noreferrer" aria-label="Як користуватися кабінетом викладача — відкриється в новій вкладці"><BookOpen size={15} aria-hidden="true" />Як користуватися</a>
      {embedded && <TeachingButton onClick={() => setWorkspaceView(workspaceView === 'materials' ? 'groups' : 'materials')}><FolderOpen size={15} />{workspaceView === 'materials' ? 'До групи' : 'Мої матеріали'}</TeachingButton>}
      {groupId && courseId && !embedded && (onOpenGroup ? <TeachingButton onClick={() => onOpenGroup(groupId, courseId)}><ExternalLink size={15} />Відкрити групу</TeachingButton> : repository.mode !== 'local' ? <a className="teaching-button" href={`/groups/${encodeURIComponent(groupId)}?teaching=${encodeURIComponent(courseId)}`}><ExternalLink size={15} />Відкрити групу</a> : null)}
      {workspace && <TeachingButton disabled={loading || Boolean(busy)} onClick={refreshActiveView}><RefreshCw size={15} />Оновити викладання</TeachingButton>}
      {!groupId && !courseId && verified && <TeachingButton onClick={() => setDialog('course')}><Plus size={15} />Новий предмет</TeachingButton>}
    </div></header>
    {accessExpired && <div role="status" className="teaching-note mb-5">Погоджений строк викладання завершився. Ви можете переглядати історію та відкликати власні матеріали. Для нових завдань і оцінок запросіть продовження строку в налаштуваннях профілю.</div>}
    {!embedded && <div className="teaching-workflow-buttons" role="group" aria-label="Робочий простір викладача">
      <button type="button" className="teaching-button" aria-pressed={workspaceView === 'groups'} onClick={() => setWorkspaceView('groups')}><UsersRound size={15} />Групи</button>
      <button type="button" className="teaching-button" aria-pressed={workspaceView === 'materials'} onClick={() => setWorkspaceView('materials')}><FolderOpen size={15} />Мої матеріали</button>
      <button type="button" className="teaching-button" aria-pressed={workspaceView === 'calendar'} onClick={() => setWorkspaceView('calendar')}><CalendarDays size={15} />Мій розклад</button>
      <button type="button" className="teaching-button" aria-pressed={workspaceView === 'scheduled'} onClick={() => setWorkspaceView('scheduled')}><Clock3 size={15} />Заплановані</button>
      <button type="button" className="teaching-button" aria-pressed={workspaceView === 'requests'} onClick={() => setWorkspaceView('requests')}><MessageSquareText size={15} />Запити щодо балів</button>
      <button type="button" className="teaching-button" aria-pressed={workspaceView === 'connections'} onClick={() => setWorkspaceView('connections')}><UsersRound size={15} />Надіслані запити</button>
    </div>}
    {workspaceView === 'calendar' && <TeachingCalendar repository={repository} userId={userId} refreshKey={refreshKeys.calendar} courses={calendarCourses} initialCourseId={courseId} initialGroupId={groupId} onOpenJournal={lesson => openJournal(lesson.group_id, lesson.course_id, lesson.lesson_date)} />}
    {workspaceView === 'scheduled' && <TeachingScheduledPublications repository={repository} userId={userId} groups={workspace?.groups || []} refreshKey={refreshKeys.scheduled} onRefresh={load} />}
    {workspaceView === 'requests' && <TeachingGradeRequests repository={repository} userId={userId} refreshKey={refreshKeys.requests} mode="teacher" onOpenJournal={(selectedCourseId, selectedGroupId) => openJournal(selectedGroupId, selectedCourseId)} />}
    {workspaceView === 'connections' && workspace && <>{error && <p role="alert" className="teaching-error mb-4">{error}</p>}<TeachingSentGroupRequests workspace={workspace} busy={Boolean(busy) || loading} onOpen={id => { openCourse(id); setWorkspaceView('groups') }} onCancel={request => setConfirm({ action: 'cancel_group_invite', payload: { link_id: request.id, expected_updated_at: request.updated_at }, title: 'Скасувати запрошення групи?', body: `Запрошення до предмета «${request.course_title}» для групи «${request.group_name}» більше не можна буде прийняти. Попередні роботи та результати збережуться.` })} /></>}
    <div hidden={workspaceView !== 'groups'}>
    {!embedded && workspace && <div className="teaching-card mb-5"><div className="grid items-end gap-3 sm:grid-cols-2"><TeachingField label="Семестри"><select name="teaching-semester-period" className={teachingInput} value={semesterPeriod} onChange={event => changeSemester(event.target.value as TeachingSemesterPeriod)}><option value="current">Поточний семестр</option><option value="previous">Минулі семестри</option><option value="upcoming">Майбутні семестри</option><option value="all">Усі семестри</option></select></TeachingField><TeachingField label="Навчальний період"><select name="teaching-semester" className={teachingInput} value={semester} onChange={event => changeSemester(semesterPeriod, event.target.value)}><option value="">Усі періоди цього розділу</option>{semesters.map(item => <option value={item.key} key={item.key}>{item.label} · {teachingDate(item.starts_on)} — {teachingDate(item.ends_on)}</option>)}</select></TeachingField></div><p className="mt-3 text-xs leading-relaxed text-muted-foreground">Завдання, матеріали, здані роботи та журнал минулих семестрів зберігаються. Новий семестр не очищає попередній.</p></div>}
    {!embedded && <TeachingClassroomGuide key={userId} userId={userId} local={repository.mode === 'local'} />}
    {error && <div role="alert" className="teaching-error mb-5 flex flex-wrap items-center justify-between gap-3"><p>{error}</p><TeachingButton onClick={() => void load().catch(() => {})} disabled={loading}>Оновити</TeachingButton></div>}
    {showLoading ? <div aria-busy="true" aria-label="Завантаження груп" className="grid gap-4 sm:grid-cols-2"><div className="h-48 animate-pulse rounded-2xl bg-muted/60 motion-reduce:animate-none" /><div className="h-48 animate-pulse rounded-2xl bg-muted/60 motion-reduce:animate-none" /></div> : workspace && !groupId && !courseId ? <>
      {invitationList.filter(invite => invite.status === 'pending').map(invite => <div key={invite.id} className="teaching-list-row mb-4"><div><span className="teaching-badge">Спільне викладання</span><h3 className="mt-2">{(invite as typeof invite & { course_title?: string }).course_title || 'Запрошення до предмета'}</h3><p>{invite.permissions.map(permission => TEACHING_PERMISSIONS.find(item => item.id === permission)?.label).filter(Boolean).join(' · ')}</p><p>{colleagueGroupsLabel(invite)}</p></div><div className="flex flex-wrap gap-2"><TeachingButton disabled={Boolean(busy)} busy={busy === 'respond_teacher'} onClick={() => void act('respond_teacher', { teacher_link_id: invite.id, accept: true })}><Check size={15} />Прийняти</TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_teacher', { teacher_link_id: invite.id, accept: false })}>Відхилити</TeachingButton></div></div>)}
      {(workspace.pending_invites || []).filter(link => link.status === 'pending_teacher').map(link => <div key={link.id} className="teaching-list-row mb-4"><div><span className="teaching-badge">Староста запрошує вас</span><h3 className="mt-2">{linkedGroupLabel(link)}</h3><p>{workspace.courses.find(item => item.id === link.course_id)?.title || 'Навчальний предмет'}</p></div><div className="flex flex-wrap gap-2"><TeachingButton disabled={Boolean(busy)} busy={busy === 'respond_group'} onClick={() => void act('respond_group', { link_id: link.id, accept: true })}><Check size={15} />Підключитися</TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_group', { link_id: link.id, accept: false })}>Відхилити</TeachingButton></div></div>)}
      {coursesWithoutGroup.length > 0 && <section className="mb-5 space-y-3" aria-label="Предмети без підключеної групи">
        <div><h2 className="text-base font-semibold">Завершіть підключення групи</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Ці предмети вже створені. Відкрийте предмет, щоб підключити групу або перевірити запрошення.</p></div>
        {coursesWithoutGroup.map(item => {
          const pending = (workspace.pending_invites || []).filter(link => link.course_id === item.id)
          const toHead = pending.filter(link => link.status === 'pending_group'), toTeacher = pending.filter(link => link.status === 'pending_teacher')
          return <article key={item.id} className="teaching-card flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1"><span className="teaching-badge">{toTeacher.length ? 'Потрібна ваша відповідь' : toHead.length ? 'Очікуємо старосту' : 'Групу ще не підключено'}</span><h3 className="mt-2 break-words font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted-foreground">{item.semester}{pending.length ? ` · ${pending.map(link => linkedGroupLabel(link)).join('; ')}` : ''}</p>{toHead.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Попросіть старосту прийняти запрошення. Предмет збережено.</p>}</div>
            <TeachingButton onClick={() => openCourse(item.id)}><ChevronRight size={16} />{toTeacher.length || toHead.length ? 'Переглянути підключення' : item.owner_id === userId ? 'Підключити групу' : 'Відкрити предмет'}</TeachingButton>
          </article>
        })}
      </section>}
      {classrooms.length > 4 && <div className="mb-5"><TeachingField label="Знайти свою групу"><div className="relative"><Search size={17} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" /><input name="teacher-group-search" value={query} onChange={event => setQuery(event.target.value)} className={`${teachingInput} !pl-10`} placeholder="Група, курс, староста або назва предмета" /></div></TeachingField></div>}
      {filteredClassrooms.length ? <div className="teaching-classroom-grid">{filteredClassrooms.map(classroom => <button type="button" key={classroom.group_id} className="teaching-card teaching-classroom-card" onClick={() => chooseGroup(classroom.group_id)}><div className="flex items-start justify-between gap-3"><span className="teaching-badge teaching-badge-blue"><UsersRound size={14} />{archived ? 'Завершений семестр' : 'Група підключена'}</span><ChevronRight size={18} className="shrink-0 text-muted-foreground" /></div><div><h3>{classroom.group_name}</h3><p>{classroomLabel(classroom, false)}</p></div><div className="teaching-classroom-subjects">{classroom.courses.slice(0, 3).map(link => <span key={link.course_id} className="teaching-badge">{courseList.find(item => item.id === link.course_id)?.title}</span>)}{classroom.courses.length > 3 && <span className="teaching-badge">Ще {classroom.courses.length - 3}</span>}</div><footer><span>Завдання · Матеріали · Журнал</span><ChevronRight size={15} /></footer></button>)}</div> : <div className="teaching-card"><TeachingEmpty icon={<UsersRound size={25} />} title={query ? 'Такої групи не знайдено' : archived ? 'Завершених груп поки немає' : coursesWithoutGroup.length ? 'Підключені групи з’являться тут' : 'Почнімо з першого предмета'} description={query ? 'Спробуйте іншу назву групи або предмета.' : coursesWithoutGroup.length ? 'Оберіть створений предмет вище та завершіть підключення. Створювати його повторно не потрібно.' : verified ? 'Створіть предмет, запросіть групу та дочекайтеся підтвердження старостою. Після цього група з’явиться тут.' : 'Завершіть підтвердження статусу викладача в картці вище. Потім створіть предмет або прийміть запрошення старости.'}>{verified && !archived && !query && !coursesWithoutGroup.length && <TeachingButton primary onClick={() => setDialog('course')}><Plus size={16} />Створити предмет</TeachingButton>}</TeachingEmpty></div>}
      <details className="teaching-extra"><summary><span>Предмети, підключення та архів</span><ChevronDown size={16} /></summary><div className="teaching-extra-content"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold">{archived ? 'Завершені предмети' : 'Усі мої предмети'}</p><TeachingButton onClick={() => changeSemester(archived ? 'current' : 'previous')}><Archive size={15} />{archived ? 'Поточні предмети' : 'Архів'}</TeachingButton></div><div className="teaching-list">{courseList.map(item => <button type="button" key={item.id} className="teaching-list-row text-left" onClick={() => openCourse(item.id)}><div className="min-w-0"><h3>{item.title}</h3><p>{item.semester} · {item.owner_id === userId ? 'Ваш предмет' : 'Спільне викладання'}</p></div><ChevronRight size={17} className="shrink-0" /></button>)}{!courseList.length && <p className="text-sm text-muted-foreground">{archived ? 'Архів предметів порожній.' : 'Предметів поки немає.'}</p>}</div></div></details>
    </> : snapshot && course && workspace ? <>
      {course.archived_at && <div className="teaching-note mb-4 flex flex-wrap items-center justify-between gap-3"><span>Семестр завершено. Матеріали та результати збережені.</span>{owner && <TeachingButton onClick={() => setDialog('archive')}>Відновити предмет</TeachingButton>}</div>}
      {groupId && selectedGroup ? <>
        <div className="teaching-classroom-context">{!embedded && <TeachingField label="Навчальна група"><select name="classroom-group" value={groupId} className={teachingInput} onChange={event => chooseGroup(event.target.value)}>{classrooms.map(classroom => <option key={classroom.group_id} value={classroom.group_id}>{classroomLabel(classroom)}</option>)}</select></TeachingField>}<TeachingField label="Ваш предмет"><select name="classroom-course" value={course.id} className={teachingInput} onChange={event => { select({ courseId: event.target.value }); setTab('assignments') }}>{availableCourses.map(item => <option key={item.id} value={item.id}>{item.title} · {item.semester}</option>)}</select></TeachingField>{embedded && <p className="self-end text-xs leading-relaxed text-muted-foreground">{teachingDate(course.starts_on)} — {teachingDate(course.ends_on)}</p>}</div>
        <div role="tablist" aria-label="Викладання в цій групі" className="teaching-tabs" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const current = visibleTabs.findIndex(item => item.id === tab)
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
          const next = visibleTabs[index]
          if (next) { setTab(next.id); document.getElementById(`teaching-classroom-tab-${next.id}`)?.focus() }
        }}>{visibleTabs.map(item => <button key={item.id} type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} id={`teaching-classroom-tab-${item.id}`} aria-controls="teaching-classroom-panel" onClick={() => setTab(item.id)}><item.icon size={16} />{item.label}</button>)}</div>
        <section role="tabpanel" id="teaching-classroom-panel" className="teaching-classroom-pane" aria-labelledby={`teaching-classroom-tab-${tab}`} key={`${course.id}:${groupId}:${tab}`}>
          {tab === 'assignments' && <TeachingPublicationsView kind="assignment" snapshot={snapshot} groupId={groupId} repository={repository} userId={userId} readonly={accessExpired} onRefresh={load} onOpenJournal={openReviewJournal} />}
          {tab === 'materials' && <TeachingPublicationsView kind="material" snapshot={snapshot} groupId={groupId} repository={repository} userId={userId} readonly={accessExpired} onRefresh={load} />}
          {tab === 'grades' && groupSnapshot && <TeachingGradebookView snapshot={groupSnapshot} repository={repository} userId={userId} initialDate={journalDate} initialFocus={journalFocus} readonly={accessExpired} onRefresh={load} />}
        </section>
      </> : <div className="teaching-card mb-5"><TeachingEmpty icon={<UsersRound size={24} />} title={courseNextTitle} description={courseNextDescription}>{acceptedGroups.map(link => <TeachingButton key={link.id} onClick={() => chooseGroup(link.group_id, course.id)}><UsersRound size={15} />{linkedGroupLabel(link)}</TeachingButton>)}{owner && !course.archived_at && !acceptedGroups.length && !waitingForTeacher.length && <TeachingButton primary onClick={() => setDialog('group')}><Plus size={15} />{waitingForHead.length ? 'Підключити іншу групу' : 'Підключити групу'}</TeachingButton>}</TeachingEmpty></div>}
      <details className="teaching-extra" open={!groupId}><summary><span>Налаштування предмета та доступ</span><ChevronDown size={16} /></summary><div className="teaching-extra-content">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{course.title}</h2><p className="mt-1 text-xs text-muted-foreground">{course.semester} · {teachingDate(course.starts_on)} — {teachingDate(course.ends_on)}</p><p className="mt-1 text-xs text-muted-foreground">Правила предмета застосовуються за замовчуванням; окрема група може мати власну систему оцінювання.</p></div>{owner && <div className="flex flex-wrap gap-2"><TeachingButton disabled={Boolean(busy) || Boolean(course.archived_at)} onClick={() => setDialog('settings')}><Settings2 size={15} />Правила й налаштування</TeachingButton><TeachingButton onClick={() => setDialog('copy')}><Plus size={15} />Новий семестр</TeachingButton><TeachingButton onClick={() => setDialog('archive')}><Archive size={15} />{course.archived_at ? 'Відновити' : 'Завершити семестр'}</TeachingButton></div>}</div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Підключення груп</h3>{owner && !course.archived_at && <TeachingButton onClick={() => setDialog('group')}><Plus size={15} />Підключити групу</TeachingButton>}</div>
        <div className="teaching-list">{snapshot.groups.filter(link => link.status !== 'removed').map(link => <div key={link.id} className="teaching-list-row"><div className="min-w-0"><h3>{linkedGroupLabel(link)}</h3><p>{link.status === 'accepted' ? 'Підключено' : link.status === 'pending_teacher' ? 'Староста запросив вас' : link.status === 'pending_group' ? 'Очікуємо підтвердження старости' : 'Запрошення відхилено'}</p></div><div className="flex flex-wrap gap-2">{link.status === 'accepted' && !embedded && <TeachingButton disabled={Boolean(busy)} onClick={() => chooseGroup(link.group_id, course.id)}>До завдань</TeachingButton>}{owner && link.status === 'pending_teacher' && !course.archived_at && <><TeachingButton disabled={Boolean(busy)} busy={busy === 'respond_group'} onClick={() => void act('respond_group', { link_id: link.id, accept: true })}><Check size={15} />Прийняти</TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_group', { link_id: link.id, accept: false })}>Відхилити</TeachingButton></>}{owner && link.status === 'accepted' && !course.archived_at && <TeachingButton disabled={Boolean(busy)} onClick={() => setConfirm({ action: 'remove_group', payload: { link_id: link.id }, title: 'Відключити групу?', body: 'Група втратить доступ до цього предмета. Її записи й попередні результати журналу збережуться.' })}><X size={14} />Відключити</TeachingButton>}{owner && link.status === 'pending_group' && !course.archived_at && <TeachingButton disabled={Boolean(busy) || !link.updated_at} onClick={() => setConfirm({ action: 'cancel_group_invite', payload: { link_id: link.id, expected_updated_at: link.updated_at }, title: 'Скасувати запрошення?', body: 'Староста більше не зможе прийняти це запрошення. Роботи й бали залишаться збереженими.' })}><X size={14} />Скасувати запит</TeachingButton>}</div></div>)}</div>
        <div className="mb-4 mt-7 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Викладачі предмета</h3>{owner && !course.archived_at && <TeachingButton onClick={() => setDialog('teacher')}><Plus size={15} />Запросити колегу</TeachingButton>}</div>
        <div className="teaching-list"><div className="teaching-list-row"><div><h3>{workspace.teacher_directory.find(teacher => (teacher.user_id || teacher.id) === course.owner_id)?.full_name || (owner ? fullName : 'Викладач предмета')}</h3><p>Власник предмета · усі навчальні дозволи</p></div><GraduationCap size={20} className="shrink-0 text-primary" /></div>{snapshot.teachers.filter(teacher => teacher.user_id !== course.owner_id && teacher.status !== 'removed').map(teacher => <div key={teacher.id} className="teaching-list-row"><div className="min-w-0"><h3>{teacher.full_name}</h3><p>{teacher.status === 'pending' ? 'Очікуємо підтвердження · ' : ''}{teacher.permissions.map(permission => TEACHING_PERMISSIONS.find(item => item.id === permission)?.label).filter(Boolean).join(' · ')}</p><p>{colleagueGroupsLabel(teacher)}</p></div>{owner && !course.archived_at && <div className="flex flex-wrap gap-2"><TeacherPermissionControl teacher={teacher} groups={snapshot.groups} repository={repository} onRefresh={() => load()} /><TeachingButton disabled={Boolean(busy)} onClick={() => setConfirm({ action: 'update_teacher', payload: { teacher_link_id: teacher.id, permissions: teacher.permissions, status: 'removed' }, title: 'Прибрати викладача?', body: 'Доступ колеги до предмета закриється. Його попередні зміни залишаться в історії.' })}>Прибрати</TeachingButton></div>}</div>)}</div>
      </div></details>
    </> : !loading && groupId ? <div className="teaching-card"><TeachingEmpty icon={<UsersRound size={25} />} title="Підключення групи ще немає" description="Група з’явиться після підтвердження старостою або викладачем." /></div> : null}
    </div>
    {workspaceView === 'materials' && <TeachingMyMaterials repository={repository} userId={userId} refreshKey={refreshKeys.materials} />}
    {dialog && workspace && <TeachingCourseForms key={`${dialog}:${courseId}`} dialog={dialog} snapshot={snapshot} workspace={workspace} repository={repository} onSaved={saved} onClose={() => setDialog(null)} />}
    {confirm && <TeachingModal title={confirm.title} description={confirm.body} onClose={() => setConfirm(null)} busy={Boolean(busy)}><div className="teaching-form-actions"><TeachingButton disabled={Boolean(busy)} onClick={() => setConfirm(null)}>Скасувати</TeachingButton><TeachingButton primary busy={Boolean(busy)} onClick={() => void act(confirm.action, confirm.payload)}>Підтвердити</TeachingButton></div></TeachingModal>}
  </main>
}
