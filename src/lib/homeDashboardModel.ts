/** Display contracts for the personal home screen. These selectors narrow already
 * authorized data; they are not a substitute for server-side access checks. */
export type HomeDashboardRole = 'student' | 'headman' | 'teacher'
export type HomeDashboardContext = 'learning' | 'teaching'
export type HomeDashboardDateView = 'today' | 'tomorrow' | 'week'
export type HomeDashboardScenario = 'normal' | 'empty' | 'no-group' | 'pending' | 'loading' | 'error'
export type HomeDashboardStatus = 'ready' | 'pending' | 'loading' | 'error'
export type HomeDashboardPermission = 'schedule' | 'homework' | 'materials' | 'members' | 'assignments' | 'grades'

export interface HomeDashboardGroup {
  id: string
  name: string
  program: string
  studyYear: number
  academicYear: string
  status: 'accepted' | 'invited' | 'pending'
  learning: boolean
  /** Exact subject grants supplied by the authorized teaching repository. */
  teachingSubjectIds: string[]
  gradingSubjectIds: string[]
  permissions: HomeDashboardPermission[]
  learningPermissions?: HomeDashboardPermission[]
  teachingPermissions?: HomeDashboardPermission[]
}

export interface HomeDashboardLesson {
  id: string
  context?: HomeDashboardContext
  groupId: string
  subjectId: string
  subject: string
  date: string
  startsAt: string
  endsAt: string
  type: string
  topic?: string
  room?: string
  teacherName?: string
  href: string
  /** A dual-role account uses a different existing destination in each context. */
  hrefByContext?: Partial<Record<HomeDashboardContext, string>>
  conference?: { href?: string; meetingId?: string; passcode?: string }
  homeworkId?: string
  materialId?: string
}

export interface HomeDashboardTask {
  id: string
  groupId: string
  subjectId?: string
  subject?: string
  title: string
  description: string
  kind: 'preparation' | 'submission' | 'review' | 'grade-request' | 'group-request'
  audience: 'learning' | 'teaching' | 'management'
  status: 'open' | 'in-progress' | 'returned' | 'submitted' | 'done'
  /** An actual stated deadline only. A lesson date is never promoted to a deadline. */
  dueAt?: string | null
  /** An actual calendar-day deadline, without inventing a closing hour. */
  dueDate?: string
  lessonDate?: string
  href: string
  actionLabel: string
  authorName?: string
  source?: 'teacher' | 'headman'
  count?: number
  requiredPermission?: HomeDashboardPermission
}

export interface HomeDashboardUpdate {
  id: string
  groupId: string
  subjectId?: string
  audience: 'learning' | 'teaching' | 'management'
  kind: 'material' | 'grade' | 'schedule' | 'message' | 'teacher-request'
  title: string
  description: string
  createdAt: string
  href: string
  isNew?: boolean
  requiredPermission?: HomeDashboardPermission
}

export interface HomeDashboardPublication {
  id: string
  groupId: string
  subjectId: string
  title: string
  kind: 'assignment' | 'material'
  publishAt: string
  href: string
}

export interface HomeDashboardCommunityItem {
  id: string
  category: string
  title: string
  author: string
  replies?: number
  href: string
}

export interface HomeDashboardNewsItem {
  id: string
  kind: 'platform' | 'faculty'
  title: string
  excerpt: string
  date: string
  href: string
}

export interface HomeDashboardQuickAction {
  id: string
  title: string
  description: string
  href: string
  kind: 'schedule' | 'homework' | 'materials' | 'members' | 'assignments' | 'grades'
  groupId?: string
}

export interface HomeDashboardData {
  role: HomeDashboardRole
  displayName: string
  initials: string
  clockIso: string
  contexts: HomeDashboardContext[]
  teachingVerified: boolean
  reviewCountsAvailable?: boolean
  status: HomeDashboardStatus
  errorMessage?: string
  partialMessage?: string
  preferredGroupId?: string
  participantCount: number
  groups: HomeDashboardGroup[]
  lessons: HomeDashboardLesson[]
  tasks: HomeDashboardTask[]
  updates: HomeDashboardUpdate[]
  publications: HomeDashboardPublication[]
  community: HomeDashboardCommunityItem[]
  news: HomeDashboardNewsItem[]
}

export interface HomeDashboardSelection {
  context?: HomeDashboardContext
  groupId?: string
  date?: HomeDashboardDateView
}

export type HomeDashboardVisibleLesson = HomeDashboardLesson & {
  groupName: string
  state: 'current' | 'upcoming' | 'finished'
  kind: HomeDashboardLesson['type']
  meetingHref?: string
  homework?: { title: string; href: string; taskId: string; kind: 'preparation' | 'submission' }
}

export type HomeDashboardVisibleTask = HomeDashboardTask & {
  groupName: string
  overdue: boolean
  dueLabel: string
}

export interface HomeDashboardView {
  role: HomeDashboardRole
  canManage: boolean
  context: HomeDashboardContext
  dateView: HomeDashboardDateView
  today: string
  selectedDate: string
  rangeStart: string
  rangeEnd: string
  dateLabel: string
  dayLabel: string
  fallbackNote?: string
  groups: HomeDashboardGroup[]
  selectedGroupId: string
  selectedGroup?: HomeDashboardGroup
  lessons: HomeDashboardVisibleLesson[]
  currentLesson?: HomeDashboardVisibleLesson
  nextLesson?: HomeDashboardVisibleLesson
  focusLesson?: HomeDashboardVisibleLesson
  tasks: HomeDashboardVisibleTask[]
  updates: Array<HomeDashboardUpdate & { groupName: string }>
  publications: Array<HomeDashboardPublication & { groupName: string }>
  quickActions: HomeDashboardQuickAction[]
  status: HomeDashboardStatus
  emptyState?: 'no-group' | 'no-lessons' | 'pending' | 'group-unavailable' | 'context-unavailable'
  errorMessage?: string
  summary: { lessons: number; tasks: number; updates: number; reviewCount: number }
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const finiteDate = (value?: string | null): number | null => {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

export function homeKyivClock(iso: string): { date: string; time: string } {
  const milliseconds = finiteDate(iso)
  if (milliseconds === null) throw new Error('HOME_CLOCK_INVALID')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(milliseconds)
  const part = (name: string) => parts.find(value => value.type === name)?.value || ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

export function homeShiftDate(date: string, amount: number): string {
  if (!dayPattern.test(date) || !Number.isInteger(amount)) throw new Error('HOME_DATE_INVALID')
  const milliseconds = Date.parse(`${date}T12:00:00Z`)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date) throw new Error('HOME_DATE_INVALID')
  return new Date(milliseconds + amount * 86_400_000).toISOString().slice(0, 10)
}

export function homeDateLabel(date: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }): string {
  homeShiftDate(date, 0)
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`))
}

function validLesson(lesson: HomeDashboardLesson): boolean {
  try { homeShiftDate(lesson.date, 0) } catch { return false }
  return timePattern.test(lesson.startsAt) && timePattern.test(lesson.endsAt) && lesson.startsAt < lesson.endsAt
}

function contextPermissions(group: HomeDashboardGroup, context: HomeDashboardContext): HomeDashboardPermission[] {
  return (context === 'learning' ? group.learningPermissions : group.teachingPermissions) ?? group.permissions
}

function subjectAllowed(group: HomeDashboardGroup, subjectId: string | undefined, context: HomeDashboardContext, permission?: HomeDashboardPermission): boolean {
  if (context === 'learning') return group.learning && (!permission || contextPermissions(group, context).includes(permission))
  if (!subjectId || !group.teachingSubjectIds.includes(subjectId)) return false
  if (permission && !contextPermissions(group, context).includes(permission)) return false
  return permission !== 'grades' || group.gradingSubjectIds.includes(subjectId)
}

function resourceAllowed(resource: { groupId: string; subjectId?: string; audience: 'learning' | 'teaching' | 'management'; requiredPermission?: HomeDashboardPermission }, group: HomeDashboardGroup, context: HomeDashboardContext): boolean {
  if (context === 'teaching') return resource.audience === 'teaching' && subjectAllowed(group, resource.subjectId, context, resource.requiredPermission)
  if (resource.audience === 'teaching') return false
  if (resource.audience === 'management') return Boolean(resource.requiredPermission && contextPermissions(group, 'learning').includes(resource.requiredPermission) && group.learning)
  return subjectAllowed(group, resource.subjectId, context, resource.requiredPermission)
}

function taskDueLabel(task: HomeDashboardTask, today: string): string {
  const deadline = finiteDate(task.dueAt)
  if (deadline !== null && task.dueAt) {
    const local = homeKyivClock(task.dueAt)
    const day = local.date === today ? 'Сьогодні' : local.date === homeShiftDate(today, 1) ? 'Завтра' : homeDateLabel(local.date)
    return `${day}, до ${local.time}`
  }
  if (validCalendarDay(task.dueDate)) return `До ${homeDateLabel(task.dueDate!)}`
  if (task.lessonDate && dayPattern.test(task.lessonDate)) {
    try { return `До заняття ${homeDateLabel(task.lessonDate)}` } catch { /* keep explicit no-deadline state */ }
  }
  return 'Термін не вказано'
}

function validCalendarDay(date: string | undefined): boolean {
  if (!date) return false
  try { homeShiftDate(date, 0); return true } catch { return false }
}

function taskSortDate(task: HomeDashboardTask): string {
  if (finiteDate(task.dueAt) !== null) return homeKyivClock(task.dueAt!).date
  if (validCalendarDay(task.dueDate)) return task.dueDate!
  return validCalendarDay(task.lessonDate) ? task.lessonDate! : '9999-12-31'
}

function quickActions(context: HomeDashboardContext, groups: HomeDashboardGroup[], selectedGroupId: string): HomeDashboardQuickAction[] {
  if (context === 'teaching') {
    if (!groups.length) return []
    const definitions: HomeDashboardQuickAction[] = [
      { id: 'new-assignment', title: 'Задати ДЗ', description: 'Для своїх предметів і груп', href: '/teaching?home=assignments', kind: 'assignments' },
      { id: 'teacher-materials', title: 'Мої матеріали', description: 'Файли, посилання та доступ', href: '/teaching?home=materials', kind: 'materials' },
      { id: 'teacher-journal', title: 'Відкрити журнал', description: 'Роботи й результати', href: '/teaching?home=journal', kind: 'grades' },
    ]
    return definitions.filter(action => groups.some(group => contextPermissions(group, context).includes(action.kind) && (action.kind !== 'grades' || group.gradingSubjectIds.length > 0)))
  }
  const group = selectedGroupId === 'all' ? groups.find(item => contextPermissions(item, context).length) : groups.find(item => item.id === selectedGroupId)
  if (!group) return []
  const definitions = [
    ['schedule', 'Розклад групи', 'Перевірити або змінити заняття', 'schedule'],
    ['homework', 'Додати ДЗ', 'До потрібної пари', 'schedule'],
    ['materials', 'Додати матеріал', 'До відповідного предмета', 'materials'],
    ['members', 'Учасники групи', 'Запрошення та склад групи', 'schedule'],
  ] as const
  return definitions.filter(([permission]) => contextPermissions(group, context).includes(permission)).map(([kind, title, description, tab]) => ({ id: `manage-${kind}`, title, description, href: `/groups/${group.id}?tab=${tab}`, groupId: group.id, kind }))
}

/** The selector fails closed for an unavailable context/group. It never imports
 * seminar allocations, classmates' grades, or foreign group data into a view. */
export function selectHomeDashboard(data: HomeDashboardData, selection: HomeDashboardSelection = {}): HomeDashboardView {
  const clock = homeKyivClock(data.clockIso)
  const context = selection.context || (data.role === 'teacher' ? 'teaching' : 'learning')
  const dateView = selection.date || 'today'
  const requestedDate = dateView === 'tomorrow' ? homeShiftDate(clock.date, 1) : clock.date
  const contextAvailable = data.contexts.includes(context) && (context !== 'teaching' || data.teachingVerified)
  const groups = contextAvailable ? data.groups.filter(group => group.status === 'accepted' && (context === 'learning' ? group.learning : group.teachingSubjectIds.length > 0)) : []
  const selectedGroupId = selection.groupId || data.preferredGroupId || 'all'
  const groupAvailable = selectedGroupId === 'all' || groups.some(group => group.id === selectedGroupId)
  const selectedGroup = groups.find(group => group.id === selectedGroupId)
  const visibleGroups = groupAvailable ? groups.filter(group => selectedGroupId === 'all' || group.id === selectedGroupId) : []
  const groupById = new Map(visibleGroups.map(group => [group.id, group]))
  const allLessons: HomeDashboardVisibleLesson[] = []
  for (const lesson of data.lessons) {
    const group = groupById.get(lesson.groupId)
    if (lesson.context && lesson.context !== context || !group || !subjectAllowed(group, lesson.subjectId, context) || !validLesson(lesson)) continue
    const state = lesson.date < clock.date || lesson.date === clock.date && lesson.endsAt <= clock.time ? 'finished' : lesson.date === clock.date && lesson.startsAt <= clock.time && lesson.endsAt > clock.time ? 'current' : 'upcoming'
    allLessons.push({ ...lesson, href: lesson.hrefByContext?.[context] || lesson.href, groupName: group.name, state, kind: lesson.type, meetingHref: lesson.conference?.href })
  }
  allLessons.sort((a, b) => `${a.date} ${a.startsAt} ${a.groupName}`.localeCompare(`${b.date} ${b.startsAt} ${b.groupName}`))
  let selectedDate = requestedDate
  let rangeStart = requestedDate
  let rangeEnd = requestedDate
  let fallbackNote: string | undefined
  if (dateView === 'week') {
    const weekday = new Date(`${clock.date}T12:00:00Z`).getUTCDay()
    rangeStart = homeShiftDate(clock.date, -((weekday + 6) % 7))
    rangeEnd = homeShiftDate(rangeStart, 6)
  } else if (!allLessons.some(lesson => lesson.date === requestedDate)) {
    const nearest = allLessons.find(lesson => lesson.date > requestedDate && lesson.date <= homeShiftDate(requestedDate, 14))
    if (nearest) {
      selectedDate = rangeStart = rangeEnd = nearest.date
      fallbackNote = `${dateView === 'today' ? 'Сьогодні' : 'Завтра'} занять немає. Показуємо найближчий навчальний день.`
    }
  }
  const lessons = allLessons.filter(lesson => lesson.date >= rangeStart && lesson.date <= rangeEnd)
  const currentLesson = lessons.find(lesson => lesson.state === 'current')
  const nextLesson = lessons.find(lesson => lesson.state === 'upcoming')
  const tasks: HomeDashboardVisibleTask[] = []
  for (const task of data.tasks) {
    const group = groupById.get(task.groupId)
    if (!group || !resourceAllowed(task, group, context) || task.status === 'done' || task.status === 'submitted') continue
    const due = finiteDate(task.dueAt)
    const overdue = due !== null ? due < Date.parse(data.clockIso) : validCalendarDay(task.dueDate) && task.dueDate! < clock.date
    tasks.push({ ...task, groupName: group.name, overdue, dueLabel: taskDueLabel(task, clock.date) })
  }
  tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || taskSortDate(a).localeCompare(taskSortDate(b)) || (finiteDate(a.dueAt) ?? Infinity) - (finiteDate(b.dueAt) ?? Infinity))
  for (const lesson of lessons) {
    const task = tasks.find(item => item.id === lesson.homeworkId && (item.kind === 'preparation' || item.kind === 'submission'))
    if (task && (task.kind === 'preparation' || task.kind === 'submission')) lesson.homework = { title: task.title, href: task.href, taskId: task.id, kind: task.kind }
  }
  const updates = data.updates.flatMap(update => {
    const group = groupById.get(update.groupId)
    return group && resourceAllowed(update, group, context) ? [{ ...update, groupName: group.name }] : []
  }).sort((a, b) => (finiteDate(b.createdAt) ?? 0) - (finiteDate(a.createdAt) ?? 0))
  const publications = context !== 'teaching' ? [] : data.publications.flatMap(publication => {
    const group = groupById.get(publication.groupId)
    return group && subjectAllowed(group, publication.subjectId, context, publication.kind === 'assignment' ? 'assignments' : 'materials') && (finiteDate(publication.publishAt) ?? 0) > Date.parse(data.clockIso) ? [{ ...publication, groupName: group.name }] : []
  }).sort((a, b) => (finiteDate(a.publishAt) ?? 0) - (finiteDate(b.publishAt) ?? 0))
  const pending = data.status === 'pending' || context === 'teaching' && data.contexts.includes('teaching') && !data.teachingVerified
  const emptyState = pending ? 'pending' : !contextAvailable ? 'context-unavailable' : !groupAvailable ? 'group-unavailable' : !groups.length ? 'no-group' : !lessons.length ? 'no-lessons' : undefined
  return {
    role: data.role, canManage: context === 'learning' && visibleGroups.some(group => contextPermissions(group, 'learning').some(permission => ['schedule','homework','materials','members'].includes(permission))),
    context, dateView, today: clock.date, selectedDate, rangeStart, rangeEnd,
    dateLabel: dateView === 'week' ? `З ${homeDateLabel(rangeStart)} до ${homeDateLabel(rangeEnd)}` : homeDateLabel(selectedDate),
    dayLabel: dateView === 'week' ? 'Цього тижня' : selectedDate === clock.date ? 'Сьогодні' : selectedDate === homeShiftDate(clock.date, 1) ? 'Завтра' : homeDateLabel(selectedDate, { weekday: 'long' }),
    fallbackNote, groups, selectedGroupId, selectedGroup, lessons, currentLesson, nextLesson, focusLesson: currentLesson || nextLesson || lessons[lessons.length - 1],
    tasks, updates, publications, quickActions: contextAvailable && groupAvailable ? quickActions(context, visibleGroups, selectedGroupId) : [],
    status: data.status, emptyState, errorMessage: data.errorMessage,
    summary: { lessons: lessons.length, tasks: tasks.length, updates: updates.filter(update => update.isNew).length, reviewCount: tasks.filter(task => task.kind === 'review').reduce((sum, task) => sum + (task.count || 1), 0) },
  }
}
