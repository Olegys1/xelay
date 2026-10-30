import { supabase } from './supabase'
import { homeKyivClock, homeShiftDate, type HomeDashboardData, type HomeDashboardGroup, type HomeDashboardLesson, type HomeDashboardPermission, type HomeDashboardTask, type HomeDashboardUpdate } from './homeDashboardModel'
import { loadStudyGroupScheduleHistory } from './studyGroupScheduleRead'
import { LESSON_TYPES, scheduleOccursOnDate, type TimetableLesson } from './studyGroupTimetable'
import { homeLessonConference } from './homeLessonConference'
import { isStudyGroupListed } from './studyGroupVisibility'
import type { TeachingGroupData, TeachingPublication } from './teaching'

export type HomeDashboardRepositorySlice = Pick<HomeDashboardData, 'groups' | 'lessons' | 'tasks' | 'updates' | 'publications'>
export type HomeLearningGroupRow = { id: string; group_name: string; representative_id: string; specialty: string | null; cohort_start_year: number | null; study_level: string | null }
export type HomeLearningMembershipRow = { group_id: string; user_id: string; status: string }
export type HomeLearningDeputyRow = { group_id: string; user_id: string; status: string; permissions: string[] }
export type HomeLearningHomeworkRow = { id: string; group_id: string; schedule_item_id: string; lesson_date: string; lesson_topic?: string | null; body?: string | null }
export type HomeLearningLongTermRow = { id: string; group_id: string; subject: string; title: string; description: string; due_date: string; closed_at: string | null }
export type HomeLearningMaterialRow = { id: string; group_id: string; subject_id: string; title: string; updated_at: string }
export type HomeLearningTeachingGroup = TeachingGroupData & { courses: Array<TeachingGroupData['courses'][number] & { subject_id?: string | null; teacher_name?: string | null }> }
export type HomeLearningSubmissionState = { item_id: string; course_id: string; group_id: string; user_id: string; status: null | 'draft' | 'submitted' | 'returned' | 'reviewed'; effective_closes_at?: string | null }
export type HomeTeacherReviewSummary = { item_id: string; course_id: string; group_id: string; title: string; submitted_count: number; pending_count: number; ungraded_count: number | null; last_submitted_at: string | null }
export type HomeTeachingSummary = { assignments: HomeLearningSubmissionState[]; teacher_reviews: HomeTeacherReviewSummary[] }

/** All methods read through the signed-in client and existing RLS/RPC gates.
 * Injection is for deterministic tests, not for trusting caller-supplied grants. */
export interface HomeLearningDataSource {
  assertActor(userId: string, signal?: AbortSignal): Promise<void>
  access(userId: string, signal?: AbortSignal): Promise<{ groups: HomeLearningGroupRow[]; memberships: HomeLearningMembershipRow[]; deputies: HomeLearningDeputyRow[] }>
  schedule(groupId: string, isCurrent: () => boolean): Promise<TimetableLesson[]>
  homework(groupIds: string[], from: string, until: string, signal?: AbortSignal): Promise<HomeLearningHomeworkRow[]>
  longTerm?(groupIds: string[], from: string, until: string, signal?: AbortSignal): Promise<HomeLearningLongTermRow[]>
  materials(groupIds: string[], since: string, signal?: AbortSignal): Promise<HomeLearningMaterialRow[]>
  teachingGroup(groupId: string, signal?: AbortSignal): Promise<HomeLearningTeachingGroup>
  summary?(groupIds: string[], signal?: AbortSignal): Promise<HomeTeachingSummary>
}

export type HomeDashboardLearningSlice = HomeDashboardRepositorySlice & {
  isHeadman: boolean
  pendingInvitations: number
  warnings: string[]
  /** Null explicitly means no reliable submission-state aggregate was read. */
  summary: HomeTeachingSummary | null
}

export type LoadLearningHomeDashboardInput = { userId: string; clockIso: string; signal?: AbortSignal; source?: HomeLearningDataSource; summary?: HomeTeachingSummary | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GROUP_COLUMNS = 'id,group_name,representative_id,specialty,cohort_start_year,study_level'
const PAGE_SIZE = 250
const MAX_READ_ROWS = 10_000
const invalid = () => new Error('HOME_DASHBOARD_RESPONSE_INVALID')
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const normalizedId = (value: unknown): string => { if (!isId(value)) throw invalid(); return value.toLowerCase() }
const plain = (value: unknown, maximum = 400): string => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, maximum) : ''
const timestamp = (value: unknown): value is string => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))
const groupHref = (groupId: string, tab = 'schedule', date?: string) => `/groups/${encodeURIComponent(groupId)}?tab=${tab}${date ? `&date=${date}` : ''}`
const abortCheck = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') }
const records = <T>(value: unknown): T[] => { if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw invalid(); return value as T[] }
const readResult = <T>(result: { data: unknown; error: unknown }): T => { if (result.error) throw result.error; return result.data as T }
const withSignal = <T extends { abortSignal(signal: AbortSignal): T }>(query: T, signal?: AbortSignal): T => signal ? query.abortSignal(signal) : query

/** Existing aggregate returns explicit null for an assignment with no submission.
 * A missing row is never interpreted as unsubmitted. */
export function normalizeHomeTeachingSummary(value: unknown): HomeTeachingSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const row = value as HomeTeachingSummary
  const assignments = records<HomeLearningSubmissionState>(row.assignments)
  const teacher_reviews = records<HomeTeacherReviewSummary>(row.teacher_reviews)
  if (assignments.some(item => !isId(item.item_id) || !isId(item.course_id) || !isId(item.group_id) || !isId(item.user_id)
    || ![null, 'draft', 'submitted', 'returned', 'reviewed'].includes(item.status)
    || item.effective_closes_at != null && !timestamp(item.effective_closes_at))) throw invalid()
  if (teacher_reviews.some(item => !isId(item.item_id) || !isId(item.course_id) || !isId(item.group_id)
    || typeof item.title !== 'string' || !Number.isSafeInteger(item.submitted_count) || item.submitted_count < 0
    || !Number.isSafeInteger(item.pending_count) || item.pending_count < 0
    || item.ungraded_count !== null && (!Number.isSafeInteger(item.ungraded_count) || item.ungraded_count < 0)
    || item.last_submitted_at !== null && !timestamp(item.last_submitted_at))) throw invalid()
  return { assignments, teacher_reviews }
}

export async function loadHomeTeachingSummary(groupIds: string[] | null = null, signal?: AbortSignal): Promise<HomeTeachingSummary> {
  abortCheck(signal)
  const ids = groupIds === null ? null : [...new Set(groupIds.map(normalizedId))]
  const result = await withSignal(supabase.rpc('xelay_home_teaching_summary', { p_group_ids: ids }), signal)
  abortCheck(signal)
  return normalizeHomeTeachingSummary(readResult(result))
}

async function readPages<T extends { id?: string }>(table: string, columns: string, narrow: (query: any) => any, signal?: AbortSignal): Promise<T[]> {
  const output: T[] = []
  let after = ''
  while (true) {
    abortCheck(signal)
    let query = narrow(supabase.from(table).select(columns)).order('id', { ascending: true }).limit(PAGE_SIZE)
    if (after) query = query.gt('id', after)
    const result = await withSignal(query, signal)
    abortCheck(signal)
    const page = records<T>(readResult(result))
    if (!page.length) return output
    const next = page[page.length - 1].id
    if (!isId(next) || after && next <= after || page.some(row => !isId(row.id))) throw invalid()
    output.push(...page)
    if (output.length > MAX_READ_ROWS) throw new Error('HOME_DASHBOARD_READ_TOO_LARGE')
    after = next
  }
}

export const supabaseHomeLearningSource: HomeLearningDataSource = {
  async assertActor(userId, signal) {
    abortCheck(signal)
    const session = await supabase.auth.getSession()
    abortCheck(signal)
    if (session.error || session.data.session?.user.id !== userId) throw new Error('HOME_DASHBOARD_ACCOUNT_CHANGED')
  },
  async access(userId, signal) {
    const [membershipRows, ownedRows, deputyRows] = await Promise.all([
      readPages<HomeLearningMembershipRow & { id: string }>('study_group_members', 'id,group_id,user_id,status', query => query.eq('user_id', userId).in('status', ['accepted', 'pending']), signal),
      readPages<HomeLearningGroupRow>('study_groups', GROUP_COLUMNS, query => query.eq('representative_id', userId), signal),
      readPages<HomeLearningDeputyRow & { id: string }>('study_group_deputy_requests', 'id,group_id,user_id,status,permissions', query => query.eq('user_id', userId).eq('status', 'approved'), signal),
    ])
    if (membershipRows.some(row => row.user_id !== userId || !isId(row.group_id) || !['accepted', 'pending'].includes(row.status))
      || ownedRows.some(row => row.representative_id !== userId)) throw invalid()
    const listedOwnedRows = ownedRows.filter(row => isStudyGroupListed(row.id))
    const listedMembershipRows = membershipRows.filter(row => isStudyGroupListed(row.group_id))
    const ownedIds = new Set(listedOwnedRows.map(row => normalizedId(row.id)))
    const ids = [...new Set(listedMembershipRows.map(row => normalizedId(row.group_id)))].filter(id => !ownedIds.has(id))
    const joined = ids.length ? await readPages<HomeLearningGroupRow>('study_groups', GROUP_COLUMNS, query => query.in('id', ids), signal) : []
    if (joined.some(row => !ids.includes(normalizedId(row.id)))) throw invalid()
    return { groups: [...listedOwnedRows, ...joined.filter(row => isStudyGroupListed(row.id))], memberships: listedMembershipRows, deputies: deputyRows.filter(row => isStudyGroupListed(row.group_id)) }
  },
  async schedule(groupId, isCurrent) {
    const result = await loadStudyGroupScheduleHistory(groupId, isCurrent)
    if (result.error) throw result.error
    return result.data || []
  },
  homework: (groupIds, from, until, signal) => readPages<HomeLearningHomeworkRow>('study_group_homework', 'id,group_id,schedule_item_id,lesson_date,lesson_topic,body', query => query.in('group_id', groupIds).gte('lesson_date', from).lte('lesson_date', until), signal),
  longTerm: (groupIds, from, until, signal) => readPages<HomeLearningLongTermRow>('study_group_long_term_tasks', 'id,group_id,subject,title,description,due_date,closed_at', query => query.in('group_id', groupIds).is('closed_at', null).gte('due_date', from).lte('due_date', until), signal),
  async materials(groupIds, since, signal) {
    const query = supabase.from('study_group_materials').select('id,group_id,subject_id,title,updated_at').in('group_id', groupIds).gte('updated_at', since).order('updated_at', { ascending: false }).limit(24)
    return records<HomeLearningMaterialRow>(readResult(await withSignal(query, signal)))
  },
  async teachingGroup(groupId, signal) {
    const result = await withSignal(supabase.rpc('xelay_teaching_group', { p_group_id: groupId }), signal)
    abortCheck(signal)
    return readResult<HomeLearningTeachingGroup>(result)
  },
  summary: loadHomeTeachingSummary,
}

function learningPermissions(group: HomeLearningGroupRow, userId: string, deputies: HomeLearningDeputyRow[], accepted: boolean): HomeDashboardPermission[] {
  if (group.representative_id === userId) return ['schedule', 'homework', 'materials', 'members']
  if (!accepted) return []
  const granted = deputies.filter(row => row.group_id === group.id && row.user_id === userId && row.status === 'approved').flatMap(row => Array.isArray(row.permissions) ? row.permissions : [])
  const output: HomeDashboardPermission[] = []
  if (granted.includes('schedule')) output.push('schedule')
  if (granted.includes('homework')) output.push('homework')
  if (granted.includes('materials')) output.push('materials')
  if (granted.includes('invite_members') || granted.includes('remove_members')) output.push('members')
  return output
}

/** Fresh accepted membership is read every time, including after invite acceptance.
 * There is deliberately no profile-group or cross-account persistent cache here. */
export async function loadLearningHomeDashboard(input: LoadLearningHomeDashboardInput): Promise<HomeDashboardLearningSlice> {
  const { userId, clockIso, signal, source = supabaseHomeLearningSource } = input
  if (!isId(userId)) throw invalid()
  const clock = homeKyivClock(clockIso)
  const academicStart = Number(clock.date.slice(0, 4)) - (Number(clock.date.slice(5, 7)) < 9 ? 1 : 0)
  const weekday = new Date(`${clock.date}T12:00:00Z`).getUTCDay() || 7
  const from = homeShiftDate(clock.date, 1 - weekday)
  const until = homeShiftDate(clock.date, 15)
  const since = new Date(Date.parse(clockIso) - 14 * 86_400_000).toISOString()
  const current = () => !signal?.aborted
  await source.assertActor(userId, signal)
  const access = await source.access(userId, signal)
  abortCheck(signal)
  const groups: HomeDashboardGroup[] = []
  const seenGroups = new Set<string>()
  for (const row of access.groups) {
    const id = normalizedId(row.id)
    if (!isStudyGroupListed(id)) continue
    if (seenGroups.has(id)) continue
    seenGroups.add(id)
    const owner = row.representative_id === userId
    const ownMembership = access.memberships.find(item => item.group_id === id && item.user_id === userId && ['accepted', 'pending'].includes(item.status))
    if (!owner && !ownMembership) continue
    const accepted = owner || ownMembership?.status === 'accepted'
    const course = Number.isInteger(row.cohort_start_year) ? academicStart - Number(row.cohort_start_year) + 1 : 0
    groups.push({ id, name: plain(row.group_name, 180), program: plain(row.specialty, 240), studyYear: course >= 1 && course <= 6 ? course : 0,
      academicYear: `${academicStart}/${academicStart + 1}`, status: accepted ? 'accepted' : 'invited', learning: accepted,
      teachingSubjectIds: [], gradingSubjectIds: [], permissions: learningPermissions({ ...row, id }, userId, access.deputies, accepted) })
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.id.localeCompare(b.id))
  const allowed = groups.filter(group => group.status === 'accepted' && group.learning)
  if (allowed.length > 100) throw new Error('HOME_DASHBOARD_TOO_MANY_GROUPS')
  const ids = allowed.map(group => group.id)
  const output: HomeDashboardLearningSlice = { groups, lessons: [], tasks: [], updates: [], publications: [], isHeadman: groups.some(group => group.permissions.length > 0), pendingInvitations: groups.filter(group => group.status === 'invited').length, warnings: [], summary: input.summary ?? null }
  if (!ids.length) { await source.assertActor(userId, signal); abortCheck(signal); return output }
  const allowedIds = new Set(ids)
  const schedules = new Map<string, TimetableLesson[]>()
  const teaching = new Map<string, HomeLearningTeachingGroup>()
  let nextGroup = 0
  const worker = async () => {
    while (nextGroup < ids.length) {
      abortCheck(signal)
      const id = ids[nextGroup++]
      const [schedule, publications] = await Promise.all([
        source.schedule(id, current),
        source.teachingGroup(id, signal).catch(() => { abortCheck(signal); output.warnings.push('Не вдалося оновити завдання й бали викладачів.'); return null }),
      ])
      abortCheck(signal)
      if (schedule.some(row => row.group_id !== id)) throw invalid()
      schedules.set(id, schedule)
      if (publications) teaching.set(id, publications)
    }
  }
  const [homework, longTerm, materials, summary] = await Promise.all([
    source.homework(ids, from, until, signal),
    source.longTerm?.(ids, `${academicStart}-09-01`, `${academicStart + 1}-08-31`, signal) ?? Promise.resolve([]),
    source.materials(ids, since, signal).catch(() => { abortCheck(signal); output.warnings.push('Не вдалося оновити список матеріалів.'); return [] }),
    input.summary !== undefined ? Promise.resolve(input.summary) : source.summary?.(ids, signal).catch(() => { abortCheck(signal); output.warnings.push('Стан здачі робіт тимчасово недоступний.'); return null }) ?? Promise.resolve(null),
    ...Array.from({ length: Math.min(3, ids.length) }, worker),
  ])
  abortCheck(signal)
  if (summary) {
    const normalized = normalizeHomeTeachingSummary(summary)
    output.summary = { assignments: normalized.assignments.filter(row => row.user_id === userId && allowedIds.has(row.group_id)), teacher_reviews: normalized.teacher_reviews.filter(row => allowedIds.has(row.group_id)) }
  } else output.summary = null
  const ownStates = new Map(output.summary?.assignments.filter(row => row.user_id === userId && allowedIds.has(row.group_id)).map(row => [`${row.group_id}:${row.course_id}:${row.item_id}`, row]) || [])
  const homeworkByOccurrence = new Map<string, HomeLearningHomeworkRow>()
  for (const row of homework) {
    if (!allowedIds.has(row.group_id) || !isId(row.id) || !isId(row.schedule_item_id)) continue
    let lessonDate: string
    try { lessonDate = homeShiftDate(row.lesson_date, 0) } catch { continue }
    if (lessonDate < from || lessonDate > until) continue
    const slot = schedules.get(row.group_id)?.find(item => item.id === row.schedule_item_id)
    if (!slot || !scheduleOccursOnDate(slot, lessonDate)) continue
    homeworkByOccurrence.set(`${row.group_id}:${row.schedule_item_id}:${lessonDate}`, row)
    if (lessonDate < clock.date || lessonDate === clock.date && slot.ends_at.slice(0, 5) <= clock.time) continue
    output.tasks.push({ id: row.id, groupId: row.group_id, subjectId: `schedule:${row.schedule_item_id}`, subject: plain(slot.subject, 240), title: plain(row.lesson_topic, 240) || `Підготовка до заняття: ${plain(slot.subject, 180)}`,
      description: plain(row.body) || 'Перегляньте умови й матеріали до заняття у групі.', kind: 'preparation', audience: 'learning', status: 'open', lessonDate, dueAt: null,
      href: groupHref(row.group_id, 'schedule', lessonDate), actionLabel: 'Відкрити ДЗ', source: 'headman' })
  }
  for (const row of longTerm) {
    if (!allowedIds.has(row.group_id) || !isId(row.id) || row.closed_at !== null) continue
    try { homeShiftDate(row.due_date, 0) } catch { continue }
    if (row.due_date < `${academicStart}-09-01` || row.due_date > `${academicStart + 1}-08-31`) continue
    output.tasks.push({ id: `long-term:${row.id}`, groupId: row.group_id, subject: plain(row.subject, 240), title: plain(row.title, 240), description: plain(row.description) || 'Перегляньте умови довгострокового завдання у групі.', kind: 'preparation', audience: 'learning', status: 'open', dueAt: null,
      dueDate: row.due_date, href: groupHref(row.group_id), actionLabel: 'Відкрити завдання', source: 'headman' })
  }
  const days = Array.from({ length: Math.round((Date.parse(`${until}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1 }, (_, index) => homeShiftDate(from, index))
  for (const [groupId, rows] of schedules) for (const slot of rows) {
    if (!isId(slot.id)) continue
    for (const date of days) {
      if (!scheduleOccursOnDate(slot, date)) continue
      const homeworkRow = homeworkByOccurrence.get(`${groupId}:${slot.id}:${date}`)
      const conference = homeLessonConference(slot)
      output.lessons.push({ id: `${slot.id}:${date}`, context: 'learning', groupId, subjectId: `schedule:${slot.id}`, subject: plain(slot.subject, 240), date,
        startsAt: slot.starts_at.slice(0, 5), endsAt: slot.ends_at.slice(0, 5), type: (LESSON_TYPES[slot.lesson_type] || LESSON_TYPES.other) as HomeDashboardLesson['type'], room: plain(slot.location, 240) || undefined,
        teacherName: plain(slot.teacher_name, 180) || undefined, topic: plain(homeworkRow?.lesson_topic, 240) || undefined, conference,
        href: groupHref(groupId, 'schedule', date), homeworkId: homeworkRow?.id })
    }
    if (timestamp(slot.updated_at) && Date.parse(slot.updated_at) >= Date.parse(since)) output.updates.push({ id: `schedule:${slot.id}`, groupId, audience: 'learning', kind: 'schedule', title: 'Оновлено розклад', description: plain(slot.subject, 240), createdAt: slot.updated_at, href: groupHref(groupId) })
  }
  for (const row of materials) if (allowedIds.has(row.group_id) && isId(row.id) && timestamp(row.updated_at)) output.updates.push({ id: `material:${row.id}`, groupId: row.group_id, subjectId: row.subject_id, audience: 'learning', kind: 'material', title: plain(row.title, 240) || 'Матеріал групи', description: 'Матеріал доступний у вашій навчальній групі.', createdAt: row.updated_at, href: groupHref(row.group_id, 'materials') })
  for (const [groupId, data] of teaching) {
    const courses = records<HomeLearningTeachingGroup['courses'][number]>(data.courses)
    const courseById = new Map(courses.filter(course => isId(course.id)).map(course => [course.id, course]))
    for (const item of records<TeachingPublication>(data.assignments)) {
      const course = courseById.get(item.course_id)
      const target = Array.isArray(item.targets) ? item.targets.find(row => row.group_id === groupId) : null
      if (!isId(item.id) || !course || course.archived_at || item.status !== 'published' || !target) continue
      const subject = plain(course.title, 240)
      const state = ownStates.get(`${groupId}:${item.course_id}:${item.id}`)
      const lessonDate = target.lesson_date && /^\d{4}-\d{2}-\d{2}$/.test(target.lesson_date) ? target.lesson_date : undefined
      const deadline = timestamp(target.due_at) ? target.due_at : null
      if (state) {
        output.tasks.push({ id: `assignment:${groupId}:${item.id}`, groupId, subjectId: course.subject_id || course.id, subject, title: plain(item.title, 240), description: plain(item.body) || 'Перегляньте завдання викладача у групі.', kind: item.submission_format === 'oral' ? 'preparation' : 'submission', audience: 'learning',
          status: state.status === null ? 'open' : state.status === 'draft' ? 'in-progress' : state.status === 'returned' ? 'returned' : 'submitted', dueAt: deadline, lessonDate,
          href: groupHref(groupId, 'schedule', lessonDate), actionLabel: 'Відкрити завдання', authorName: plain(item.author_name, 180) || undefined, source: 'teacher' })
      } else if (timestamp(item.published_at) && (Date.parse(item.published_at) >= Date.parse(since)
        || deadline !== null && Date.parse(deadline) >= Date.parse(clockIso)
        || lessonDate !== undefined && lessonDate >= clock.date)) {
        const deadlineText = deadline ? (() => { const value = homeKyivClock(deadline); return ` Термін: ${value.date}, ${value.time}.` })() : ''
        output.updates.push({ id: `assignment:${groupId}:${item.id}`, groupId, subjectId: course.subject_id || course.id, audience: 'learning', kind: 'material', title: plain(item.title, 240), description: `Завдання викладача з предмета «${subject}».${deadlineText}`, createdAt: item.published_at, href: groupHref(groupId, 'schedule', lessonDate) })
      }
    }
    for (const item of records<TeachingPublication>(data.materials)) {
      const course = courseById.get(item.course_id)
      if (!isId(item.id) || !course || item.status !== 'published' || !Array.isArray(item.targets) || !item.targets.some(target => target.group_id === groupId) || !timestamp(item.published_at) || Date.parse(item.published_at) < Date.parse(since)) continue
      output.updates.push({ id: `teacher-material:${groupId}:${item.id}`, groupId, subjectId: course.subject_id || course.id, audience: 'learning', kind: 'material', title: plain(item.title, 240), description: `Матеріал викладача з предмета «${plain(course.title, 240)}».`, createdAt: item.published_at, href: groupHref(groupId, 'materials') })
    }
    for (const grade of records<TeachingGroupData['grades'][number]>(data.grades)) {
      if (grade.group_id !== groupId || !isId(grade.id) || !courseById.has(grade.course_id) || !timestamp(grade.published_at) || Date.parse(grade.published_at) < Date.parse(since)) continue
      const hasScore = typeof grade.published_score === 'number' && Number.isFinite(grade.published_score)
      if (!hasScore && !plain(grade.published_comment)) continue
      const points = hasScore ? `${grade.published_score}${Number.isFinite(grade.max_points) ? ` з ${grade.max_points}` : ''} балів.` : ''
      output.updates.push({ id: `grade:${grade.id}`, groupId, subjectId: courseById.get(grade.course_id)?.subject_id || grade.course_id, audience: 'learning', kind: 'grade', title: plain(grade.activity_title, 240) || 'Результат роботи', description: [points, plain(grade.published_comment)].filter(Boolean).join(' '), createdAt: grade.published_at, href: groupHref(groupId) })
    }
    const group = allowed.find(row => row.id === groupId)
    const pending = records<TeachingGroupData['pending_invites'][number]>(data.pending_invites).filter(row => row.group_id === groupId && row.status === 'pending_group')
    if (group?.permissions.includes('members') && pending.length) output.tasks.push({ id: `teacher-requests:${groupId}`, groupId, title: 'Викладачі хочуть підключити предмети', description: 'Перевірте запити на підключення до навчальної групи.', kind: 'group-request', audience: 'management', status: 'open', href: groupHref(groupId), actionLabel: 'Переглянути запити', count: pending.length, requiredPermission: 'members' })
  }
  output.updates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  output.updates = [...new Map(output.updates.map(row => [row.id, row])).values()].slice(0, 60)
  output.warnings = [...new Set(output.warnings)]
  await source.assertActor(userId, signal)
  abortCheck(signal)
  return output
}
