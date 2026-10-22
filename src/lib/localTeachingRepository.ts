import {
  EMPTY_TEACHING_SEMINARS, localDeadline, validateTeachingFile, validateTeachingLinks, validateTeachingPublicationLinks,
  type TeachingActivity, type TeachingAudit, type TeachingCourse, type TeachingDirectoryGroup,
  type TeachingDirectoryTeacher, type TeachingEntry, type TeachingFile, type TeachingGrade,
  type TeachingGroup, type TeachingGroupData, type TeachingOwnGrade, type TeachingPermission, type TeachingPublication,
  type TeachingRepository, type TeachingRosterClaim, type TeachingSnapshot, type TeachingTeacher,
  type TeachingWorkspaceData, type TeachingSubmission, type TeachingSubmissionHistory, type TeachingSubmissionData, type TeachingClassroomSeminars,
} from './teaching'
import { scheduleOnDate, seminarHasStarted, seminarSupplementCapacity, SEMINAR_MAX_SUPPLEMENT_CAPACITY, type SeminarSchedule, type Seminar } from './seminars'
import { getResourceLinkTitles } from './resourceLinkLabels'
import { TEACHING_MATERIAL_TERMS_VERSION } from './legal'
import { isTimetableDate, scheduleOccursOnDate, type TimetableLesson } from './studyGroupTimetable'
import { normalizedScheduleSubjectName } from './scheduleSubjects'

export type LocalTeachingRole = 'teacher' | 'colleague' | 'student' | 'head'
const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const GROUP_1 = uuid(11), GROUP_2 = uuid(12), TEACHER = uuid(1), STUDENT = uuid(2), HEAD = uuid(3), COLLEAGUE = uuid(4), OTHER_STUDENT = uuid(5)
const COURSE = uuid(21), INVITED_COURSE = uuid(22), UNIVERSITY = uuid(30), FACULTY = uuid(31)
export const LOCAL_TEACHING_IDENTITIES: Record<LocalTeachingRole, { userId: string; fullName: string; groupId?: string; groupName?: string }> = {
  teacher: { userId: TEACHER, fullName: 'Олена Прикладенко' },
  colleague: { userId: COLLEAGUE, fullName: 'Тарас Прикладенко' },
  student: { userId: STUDENT, fullName: 'Марія Прикладенко', groupId: GROUP_1, groupName: 'Економіка · група 1' },
  head: { userId: HEAD, fullName: 'Андрій Прикладенко', groupId: GROUP_1, groupName: 'Економіка · група 1' },
}
type LocalPublication = TeachingPublication & { course_id: string; kind: 'assignment' | 'material'; max_points?: number | null; category?: string | null; withdrawn_at?: string | null; rights_terms_version?: string; rights_accepted_at?: string }
type LocalActivity = TeachingActivity & { item_id?: string | null }
type LocalEntry = TeachingEntry & { created_at?: string }
type LocalClaim = TeachingRosterClaim & { course_title?: string }
type State = {
  schema: number; courses: TeachingCourse[]; groups: TeachingDirectoryGroup[];
  teachers: TeachingDirectoryTeacher[]; links: TeachingGroup[]; coTeachers: TeachingTeacher[];
  entries: LocalEntry[]; activities: LocalActivity[]; grades: TeachingGrade[];
  publications: LocalPublication[]; audit: TeachingAudit[]; claims: LocalClaim[];
  members: { group_id: string; user_id: string; full_name: string }[];
  seminars: TeachingSnapshot['seminars']; receipts: Record<string, { signature: string; result: { id?: string; version?: number } }>;
  submissions: TeachingSubmission[]; submissionHistory: TeachingSubmissionHistory[];
  handedIn: Record<string, Pick<TeachingSubmission, 'body' | 'links' | 'attachments'>>;
  seminarSchedule: SeminarSchedule[]; seminarVersions: Record<string, number>;
}
const STORAGE_KEY = 'xelay-local-teaching-preview-v3'
let cache: State | null = null
const localFiles = new Map<string, string>()
const copy = <T,>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()
function fail(code: string): never { throw new Error(code) }
const checkVersion = (actual: number, expected: unknown) => { if (actual !== Number(expected)) fail('TEACHING_CONFLICT') }

export function localTeachingTimetable(groupId: string): TimetableLesson[] {
  const firstGroup = groupId === GROUP_1
  if (!firstGroup && groupId !== GROUP_2) return []
  return [0, 1].map(index => ({ id: uuid((firstGroup ? 171 : 173) + index), group_id: groupId, weekday: firstGroup ? 4 : 5,
    starts_at: index ? '09:40:00' : '08:00:00', ends_at: index ? '11:00:00' : '09:20:00', subject: 'Економічна теорія', lesson_type: index ? 'seminar' : 'lecture',
    location: index ? 'Аудиторія 204' : 'Аудиторія 101', online_url: null, valid_from: '2026-09-01', valid_until: '2026-12-31', created_by: HEAD, week_pattern: 'every' }))
}

function fixture(): State {
  const timestamp = now()
  const dates = { semester: 'Осінній семестр 2026', starts_on: '2026-09-01', ends_on: '2026-12-31' }
  const course: TeachingCourse = { id: COURSE, owner_id: TEACHER, university_id: UNIVERSITY, academic_unit_id: FACULTY, title: 'Економічна теорія', ...dates, grading_rules: { categories: [{ id: 'seminars', name: 'Семінари', max_points: 30 }, { id: 'tasks', name: 'Завдання', max_points: 30 }, { id: 'exam', name: 'Підсумкова робота', max_points: 40 }], total_max: 100 }, archived_at: null, version: 1, created_at: timestamp, updated_at: timestamp, permissions: ['materials', 'assignments', 'grades'] }
  const eStudent = uuid(41), eHead = uuid(42), eOther = uuid(43), placeholder = uuid(44), activity = uuid(51), taskActivity = uuid(52), seminar = uuid(61), question = uuid(62)
  const result: State = {
    schema: 3, courses: [course, { ...copy(course), id: INVITED_COURSE, owner_id: COLLEAGUE, title: 'Аналіз даних для економістів' }],
    groups: [{ id: GROUP_1, group_name: 'Економіка · група 1', specialty: 'Економіка та управління бізнесом', study_year: 1, study_level: 'bachelor', cohort_start_year: 2026, academic_unit_name: 'Економічний факультет', representative_name: 'Андрій Прикладенко', representative_id: HEAD, subjects: [{ id: uuid(71), name: 'Економічна теорія' }, { id: uuid(73), name: 'Аналіз даних для економістів' }] }, { id: GROUP_2, group_name: 'Економіка · група 2', specialty: 'Економіка та управління бізнесом', study_year: 2, study_level: 'bachelor', cohort_start_year: 2025, academic_unit_name: 'Економічний факультет', representative_name: 'Андрій Прикладенко', representative_id: HEAD, subjects: [{ id: uuid(72), name: 'Економічна теорія' }] }],
    teachers: [{ id: TEACHER, user_id: TEACHER, full_name: 'Олена Прикладенко', department: 'Кафедра економічної теорії', position: 'Доцентка' }, { id: COLLEAGUE, user_id: COLLEAGUE, full_name: 'Тарас Прикладенко', department: 'Кафедра економічної кібернетики', position: 'Асистент' }],
    links: [{ id: uuid(81), course_id: COURSE, group_id: GROUP_1, group_name: 'Економіка · група 1', representative_id: HEAD, subject_id: uuid(71), status: 'accepted' }, { id: uuid(82), course_id: COURSE, group_id: GROUP_2, group_name: 'Економіка · група 2', representative_id: HEAD, subject_id: uuid(72), status: 'accepted' }, { id: uuid(83), course_id: INVITED_COURSE, group_id: GROUP_1, group_name: 'Економіка · група 1', representative_id: HEAD, subject_id: uuid(73), status: 'pending_group' }],
    coTeachers: [],
    members: [{ group_id: GROUP_1, user_id: STUDENT, full_name: 'Марія Прикладенко' }, { group_id: GROUP_1, user_id: HEAD, full_name: 'Андрій Прикладенко' }, { group_id: GROUP_2, user_id: OTHER_STUDENT, full_name: 'Софія Прикладенко' }, { group_id: GROUP_2, user_id: HEAD, full_name: 'Андрій Прикладенко' }],
    entries: [{ id: eStudent, course_id: COURSE, group_id: GROUP_1, user_id: STUDENT, full_name: 'Марія Прикладенко', active: true, version: 1 }, { id: eHead, course_id: COURSE, group_id: GROUP_1, user_id: HEAD, full_name: 'Андрій Прикладенко', active: true, version: 1 }, { id: eOther, course_id: COURSE, group_id: GROUP_2, user_id: OTHER_STUDENT, full_name: 'Софія Прикладенко', active: true, version: 1 }, { id: placeholder, course_id: COURSE, group_id: GROUP_1, user_id: null, full_name: 'Андрій Прикладенко · запис без акаунта', active: true, version: 1 }],
    activities: [{ id: activity, course_id: COURSE, group_id: GROUP_1, title: 'Семінар 1 · попит і пропозиція', category: 'seminars', activity_date: '2026-10-13', max_points: 5, seminar_id: seminar, version: 1 }, { id: taskActivity, course_id: COURSE, group_id: GROUP_1, title: 'Побудуйте модель ринкової рівноваги', category: 'tasks', activity_date: '2026-10-16', max_points: 10, item_id: uuid(101), version: 1 }, { id: uuid(53), course_id: COURSE, group_id: GROUP_2, title: 'Семінар 1 · попит і пропозиція', category: 'seminars', activity_date: '2026-10-14', max_points: 5, version: 1 }, { id: uuid(54), course_id: COURSE, group_id: GROUP_2, title: 'Побудуйте модель ринкової рівноваги', category: 'tasks', activity_date: '2026-10-17', max_points: 10, item_id: uuid(101), version: 1 }],
    grades: [{ id: uuid(91), activity_id: activity, entry_id: eStudent, draft_score: 5, draft_comment: 'Уточнила висновок після обговорення.', published_score: 4, published_comment: 'Добра аргументація. Додайте приклад зміни попиту.', published_at: timestamp, version: 2 }, { id: uuid(92), activity_id: activity, entry_id: placeholder, draft_score: 3, draft_comment: 'Вдале доповнення до відповіді.', published_score: 3, published_comment: 'Вдале доповнення до відповіді.', published_at: timestamp, version: 1 }, { id: uuid(93), activity_id: taskActivity, entry_id: eStudent, draft_score: 8, draft_comment: 'Чернетка перевірки — студент ще її не бачить.', published_score: null, published_comment: '', published_at: null, version: 1 }],
    publications: [{ id: uuid(101), course_id: COURSE, kind: 'assignment', title: 'Побудуйте модель ринкової рівноваги', body: 'Оберіть знайомий товар, поясніть чинники попиту й пропозиції та побудуйте графік. На семінарі порівняємо ваші висновки.', links: [], attachments: [], targets: [{ group_id: GROUP_1, due_at: '2026-10-16T15:00:00Z' }, { group_id: GROUP_2, due_at: '2026-10-17T15:00:00Z' }], status: 'published', published_at: timestamp, created_by: TEACHER, author_name: 'Олена Прикладенко', version: 1 }, { id: uuid(102), course_id: COURSE, kind: 'material', title: 'План семінару: попит, пропозиція та рівновага', body: '1. Які чинники змінюють попит?\n2. Чим відрізняється зміна пропозиції від зміни обсягу пропозиції?\n3. Поясніть ринкову рівновагу на власному прикладі.', links: [], attachments: [], targets: [{ group_id: GROUP_1 }, { group_id: GROUP_2 }], status: 'published', published_at: timestamp, created_by: TEACHER, author_name: 'Олена Прикладенко', version: 1 }, { id: uuid(103), course_id: COURSE, kind: 'assignment', title: 'Чернетка наступного завдання', body: 'Цей запис прихований від студентів до публікації.', links: [], attachments: [], targets: [{ group_id: GROUP_1 }], status: 'draft', published_at: null, created_by: TEACHER, author_name: 'Олена Прикладенко', version: 1 }],
    audit: [{ id: uuid(111), activity_id: activity, entry_id: eStudent, old_score: 4, new_score: 5, reason: 'Доповнення відповіді після обговорення', actor_name: 'Олена Прикладенко', created_at: timestamp }],
    claims: [{ id: uuid(121), entry_id: placeholder, user_id: HEAD, full_name: 'Андрій Прикладенко · запис без акаунта', status: 'pending', course_title: course.title }],
    seminars: { seminars: [{ id: seminar, group_id: GROUP_1, subject_id: uuid(71), schedule_id: uuid(63), lesson_date: '2026-10-13', starts_at: '09:40:00', ends_at: '11:00:00', title: 'Попит і пропозиція', instructions: 'Підготуйте відповідь і приклад.', format: 'questions', created_by: HEAD, resource_links: [], resource_attachments: [] }], questions: [{ id: question, seminar_id: seminar, position: 1, body: 'Як змінюється рівноважна ціна, коли зростає попит?', primary_capacity: 1 }], teams: [], reservations: [{ id: uuid(64), seminar_id: seminar, user_id: STUDENT, role: 'primary', question_id: question, team_id: null }, { id: uuid(65), seminar_id: seminar, user_id: HEAD, role: 'supplement', question_id: question, team_id: null }], profiles: { [STUDENT]: { full_name: 'Марія Прикладенко' }, [HEAD]: { full_name: 'Андрій Прикладенко' } } },
    submissions: [{ id: uuid(151), item_id: uuid(101), course_id: COURSE, group_id: GROUP_1, user_id: STUDENT, status: 'submitted', body: 'Для прикладу обрала ринок кави. Зростання доходів зміщує криву попиту праворуч. За незмінної пропозиції рівноважна ціна та обсяг зростають.', links: [], attachments: [], version: 2, attempt: 1, submitted_at: timestamp, feedback: '', reviewed_at: null, reviewed_by: null, reviewer_name: null, student_name: 'Марія Прикладенко', grade_version: 1, published_score: null, published_comment: '' }, { id: uuid(152), item_id: uuid(101), course_id: COURSE, group_id: GROUP_1, user_id: HEAD, status: 'returned', body: 'Пояснив рівновагу на прикладі ринку оренди житла.', links: [], attachments: [], version: 3, attempt: 1, submitted_at: timestamp, feedback: 'Додайте графік і поясніть, яка саме крива зміщується.', reviewed_at: timestamp, reviewed_by: TEACHER, reviewer_name: 'Олена Прикладенко', student_name: 'Андрій Прикладенко', grade_version: 0, published_score: null, published_comment: '' }],
    submissionHistory: [{ id: uuid(161), submission_id: uuid(151), attempt: 1, event: 'submitted', body: 'Для прикладу обрала ринок кави. Зростання доходів зміщує криву попиту праворуч.', links: [], attachments: [], feedback: '', created_at: timestamp, actor_name: 'Марія Прикладенко', published_score: null, version: 2 }, { id: uuid(162), submission_id: uuid(152), attempt: 1, event: 'returned', body: 'Пояснив рівновагу на прикладі ринку оренди житла.', links: [], attachments: [], feedback: 'Додайте графік і поясніть, яка саме крива зміщується.', created_at: timestamp, actor_name: 'Олена Прикладенко', published_score: null, version: 3 }],
    seminarSchedule: [{ id: uuid(63), group_id: GROUP_1, subject_id: uuid(71), weekday: 2, starts_at: '09:40:00', ends_at: '11:00:00', valid_from: dates.starts_on, valid_until: dates.ends_on, created_by: HEAD }, { id: uuid(66), group_id: GROUP_2, subject_id: uuid(72), weekday: 3, starts_at: '09:40:00', ends_at: '11:00:00', valid_from: dates.starts_on, valid_until: dates.ends_on, created_by: HEAD }],
    handedIn: {}, seminarVersions: { [seminar]: 1 }, receipts: {},
  }
  result.publications[0].max_points = 10
  result.publications[0].category = 'tasks'
  result.publications[0].targets = [{ group_id: GROUP_1, due_at: '2026-10-16T15:00:00Z', lesson_date: '2026-10-15', schedule_item_id: uuid(172), placement_mode: 'lesson' }]
  result.publications.push({ ...copy(result.publications[0]), id: uuid(104), title: 'Поясніть чинники попиту', body: 'Ваша група ще працює над попитом. Оберіть товар і наведіть три чинники, які змінюють попит на нього.', targets: [{ group_id: GROUP_2, due_at: '2026-10-20T15:00:00Z', lesson_date: '2026-10-16', schedule_item_id: uuid(174), placement_mode: 'lesson' }] })
  const secondGroupActivity = result.activities.find(item => item.id === uuid(54))!
  secondGroupActivity.item_id = uuid(104); secondGroupActivity.title = 'Поясніть чинники попиту'; secondGroupActivity.activity_date = '2026-10-20'
  result.handedIn = Object.fromEntries(result.submissions.map(submission => [submission.id, { body: submission.body, links: copy(submission.links), attachments: copy(submission.attachments) }]))
  return result
}

function state(): State {
  if (cache) return cache
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (saved?.schema === 3 && Array.isArray(saved.courses) && Array.isArray(saved.grades) && Array.isArray(saved.submissions)) {
    saved.submissionHistory ||= []; saved.handedIn ||= {}; saved.seminarSchedule ||= []; saved.seminarVersions ||= {}
    cache = saved
  } } catch { /* A blocked local store falls back to memory. */ }
  return cache ||= fixture()
}
function persist(value: State) { cache = value; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* Local preview remains usable without browser storage. */ } }
export function resetLocalTeachingPreview() { for (const url of localFiles.values()) URL.revokeObjectURL(url); localFiles.clear(); persist(fixture()) }

export function createLocalTeachingRepository(role: LocalTeachingRole): TeachingRepository {
  const identity = LOCAL_TEACHING_IDENTITIES[role], userId = identity.userId
  const isTeacher = role === 'teacher' || role === 'colleague'
  const member = (groupId: string, account = userId, data = state()) => data.members.some(row => row.group_id === groupId && row.user_id === account) || data.groups.some(group => group.id === groupId && group.representative_id === account)
  const permissions = (course: TeachingCourse, data = state()): TeachingPermission[] => course.owner_id === userId && isTeacher ? ['materials', 'assignments', 'grades', 'manage'] : data.coTeachers.find(link => link.course_id === course.id && link.user_id === userId && link.status === 'accepted')?.permissions || []
  const canRead = (course: TeachingCourse, data = state()) => permissions(course, data).length > 0 || data.links.some(link => link.course_id === course.id && link.status === 'accepted' && member(link.group_id, userId, data))
  const permitted = (course: TeachingCourse, permission: TeachingPermission | 'manage', data: State) => permission === 'manage' ? course.owner_id === userId && isTeacher : permissions(course, data).includes(permission)
  const publications = (course: TeachingCourse, kind: 'assignment' | 'material', data: State, groupId?: string) => {
    const visibleTarget = (target: TeachingPublication['targets'][number]) => data.links.some(link => link.course_id === course.id && link.group_id === target.group_id && link.status === 'accepted') && member(target.group_id, userId, data)
    const editor = permitted(course, kind === 'assignment' ? 'assignments' : 'materials', data)
    const grader = kind === 'assignment' && permitted(course, 'grades', data)
    return data.publications.filter(item => !item.withdrawn_at && item.course_id === course.id && item.kind === kind && (groupId ? item.status === 'published' && item.targets.some(target => target.group_id === groupId && visibleTarget(target)) : editor || item.status === 'published' && (grader || item.targets.some(visibleTarget)))).map(item => ({ ...copy(item), targets: item.targets.filter(target => groupId ? target.group_id === groupId && visibleTarget(target) : editor || grader || visibleTarget(target)) }))
  }
  const snapshot = (id: string): TeachingSnapshot => {
    const data = state(), course = data.courses.find(item => item.id === id)
    if (!course || !canRead(course, data)) fail('TEACHING_FORBIDDEN')
    const rights = permissions(course, data), grader = rights.includes('grades'), staff = rights.length > 0
    const links = data.links.filter(link => link.course_id === id && (staff || link.status === 'accepted' && member(link.group_id, userId, data))).map(link => ({ ...data.groups.find(group => group.id === link.group_id), ...link }))
    const entries = data.entries.filter(entry => entry.course_id === id && (grader || entry.user_id === userId && links.some(link => link.group_id === entry.group_id && link.status === 'accepted')))
    const activities = data.activities.filter(activity => activity.course_id === id && (grader || links.some(link => link.group_id === activity.group_id && link.status === 'accepted')))
    const grades = data.grades.filter(grade => entries.some(entry => entry.id === grade.entry_id) && (grader || grade.published_at)).map(grade => grader ? copy(grade) : { id: grade.id, activity_id: grade.activity_id, entry_id: grade.entry_id, published_score: grade.published_score, published_comment: grade.published_comment, published_at: grade.published_at, version: grade.version })
    const seminars = staff ? data.seminars.seminars.filter(seminar => links.some(link => link.group_id === seminar.group_id && link.status === 'accepted' && (!link.subject_id || link.subject_id === seminar.subject_id))) : []
    const seminarIds = new Set(seminars.map(seminar => seminar.id))
    const reservations = data.seminars.reservations.filter(reservation => seminarIds.has(reservation.seminar_id))
    const seminarProfiles = Object.fromEntries(Object.entries(data.seminars.profiles).filter(([profileId]) => reservations.some(reservation => reservation.user_id === profileId)))
    return copy({ course: { ...course, permissions: rights }, teachers: data.coTeachers.filter(link => link.course_id === id && (staff || link.status === 'accepted')), groups: links, entries, activities, grades, assignments: publications(course, 'assignment', data), materials: publications(course, 'material', data), audit: grader ? data.audit.filter(audit => activities.some(activity => activity.id === audit.activity_id)) : [], roster_claims: data.claims.filter(claim => entries.some(entry => entry.id === claim.entry_id) && (grader || claim.user_id === userId)), members: grader ? data.members.filter(row => links.some(link => link.group_id === row.group_id && link.status === 'accepted')) : [], seminars: staff ? { seminars, questions: data.seminars.questions.filter(question => seminarIds.has(question.seminar_id)), teams: data.seminars.teams.filter(team => seminarIds.has(team.seminar_id)), reservations, profiles: seminarProfiles } : EMPTY_TEACHING_SEMINARS })
  }
  function classroomData(itemId: string, groupId: string): TeachingSubmissionData {
    const data = state(), item = data.publications.find(item => item.id === itemId && item.kind === 'assignment')
    const group = data.groups.find(group => group.id === groupId), course = data.courses.find(course => course.id === item?.course_id)
    if (!item || !group || !course || !item.targets.some(target => target.group_id === groupId) || !data.links.some(link => link.course_id === course.id && link.group_id === groupId && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
    const rights = permissions(course, data), staff = rights.includes('assignments') || rights.includes('grades')
    if (!staff && (!member(groupId) || item.status !== 'published')) fail('TEACHING_FORBIDDEN')
    const activity = data.activities.find(activity => activity.item_id === itemId && activity.group_id === groupId)
    const visibleSubmission = (submission: TeachingSubmission, own = false) => {
      const entry = data.entries.find(entry => entry.course_id === course.id && entry.group_id === groupId && entry.user_id === submission.user_id)
      const grade = activity && data.grades.find(grade => grade.activity_id === activity.id && grade.entry_id === entry?.id)
      const canSeeGrade = own || rights.includes('grades')
      return { ...copy(submission), ...(!own ? copy(data.handedIn[submission.id] || { body: '', links: [], attachments: [] }) : {}), grade_id: canSeeGrade ? grade?.id || null : null, grade_version: canSeeGrade ? grade?.version || 0 : 0, grade_published_at: canSeeGrade ? grade?.published_at || null : null, published_score: canSeeGrade ? grade?.published_score ?? null : null, published_comment: canSeeGrade ? grade?.published_comment || '' : '' }
    }
    const own = data.submissions.find(submission => submission.item_id === itemId && submission.group_id === groupId && submission.user_id === userId)
    const submissions = staff ? data.submissions.filter(submission => submission.item_id === itemId && submission.group_id === groupId && submission.status !== 'draft').map(submission => visibleSubmission(submission)) : []
    const visibleIds = new Set(staff ? submissions.map(submission => submission.id) : own ? [own.id] : [])
    return copy({ item, group, permissions: rights, my_submission: own ? visibleSubmission(own, true) : null, submissions, history: data.submissionHistory.filter(row => visibleIds.has(row.submission_id)).map(row => rights.includes('grades') || data.submissions.some(s => s.id === row.submission_id && s.user_id === userId) ? row : { ...row, score: null, published_score: null }), students: staff ? data.members.filter(person => person.group_id === groupId) : [], can_submit: !course.archived_at && member(groupId) && item.status === 'published', can_review: !course.archived_at && rights.some(right => ['assignments', 'grades'].includes(right)), course_archived_at: course.archived_at, is_assessed: Boolean(activity), activity_id: activity?.id || null, max_points: activity?.max_points || null })
  }
  const repository: TeachingRepository = {
    mode: 'local',
    async workspace(): Promise<TeachingWorkspaceData> {
      const data = state()
      const invitations = data.coTeachers.filter(link => link.user_id === userId && link.status === 'pending')
      const pendingInvites = data.links.filter(link => ['pending_teacher', 'pending_group'].includes(link.status) && data.courses.some(course => course.id === link.course_id && course.owner_id === userId) || link.status === 'pending_group' && link.representative_id === userId)
      const classrooms = data.groups.map(group => ({ ...group, group_id: group.id, courses: data.links.filter(link => link.group_id === group.id && link.status === 'accepted' && data.courses.some(course => course.id === link.course_id && permissions(course, data).length > 0)).map(link => ({ course_id: link.course_id, subject_id: link.subject_id, status: 'accepted' as const })) })).filter(group => group.courses.length)
      return copy({ teacher_status: { status: isTeacher ? 'approved' : 'none', verified: isTeacher }, courses: data.courses.filter(course => canRead(course, data) || invitations.some(link => link.course_id === course.id)).map(course => ({ ...course, permissions: permissions(course, data) })), groups: data.groups.filter(group => isTeacher || member(group.id, userId, data)), teacher_directory: data.teachers, invitations, teacher_invites: invitations, pending_invites: pendingInvites, roster_claims: data.claims.filter(claim => claim.user_id === userId && claim.status === 'pending'), classrooms } as TeachingWorkspaceData)
    },
    async course(id) { return snapshot(id) },
    async assignmentLessons(courseId, groupId, date) {
      const data = state(), course = data.courses.find(item => item.id === courseId), group = data.groups.find(item => item.id === groupId)
      const link = data.links.find(item => item.course_id === courseId && item.group_id === groupId && item.status === 'accepted')
      if (!course || !group || !link || !permitted(course, 'assignments', data)) fail('TEACHING_FORBIDDEN')
      const subject = group.subjects?.find(item => item.id === link.subject_id)
      if (!subject) fail('TEACHING_ASSIGNMENT_SUBJECT_REQUIRED')
      if (!isTimetableDate(date)) fail('TEACHING_ASSIGNMENT_LESSON_INVALID')
      return copy({ subject_name: subject.name, lessons: localTeachingTimetable(groupId).filter(lesson => normalizedScheduleSubjectName(lesson.subject) === normalizedScheduleSubjectName(subject.name) && scheduleOccursOnDate(lesson, date)) })
    },
    async groupAssignments(groupId, date) {
      const data = state(), group = data.groups.find(item => item.id === groupId)
      if (!group || !member(groupId) || !isTimetableDate(date)) fail('TEACHING_FORBIDDEN')
      const assignments = data.links.filter(link => link.group_id === groupId && link.status === 'accepted').flatMap(link => {
        const course = data.courses.find(item => item.id === link.course_id)
        if (!course) return []
        const subject = group.subjects?.find(item => item.id === link.subject_id)
        return publications(course, 'assignment', data, groupId).flatMap(item => {
          const target = item.targets.find(target => target.group_id === groupId)!
          if (target.lesson_date ? target.lesson_date !== date : target.placement_mode === 'unplaced' && target.due_at && localDeadline(target.due_at).slice(0, 10) !== date) return []
          return [{ ...item, group_id: groupId, subject_id: subject?.id || '', subject_name: subject?.name || course.title, course_title: course.title, lesson_date: target.lesson_date || null, schedule_item_id: target.schedule_item_id || null, source: 'teacher' as const, read_only: true as const }]
        })
      })
      return copy({ assignments })
    },
    async groupMaterials(groupId) {
      const data = state(), group = data.groups.find(item => item.id === groupId)
      if (!group || !member(groupId)) fail('TEACHING_FORBIDDEN')
      const materials = data.links.filter(link => link.group_id === groupId && link.status === 'accepted').flatMap(link => {
        const course = data.courses.find(item => item.id === link.course_id)
        if (!course) return []
        const subject = group.subjects?.find(item => item.id === link.subject_id)
        const subject_id = `teacher-subject:${link.subject_id || course.id}`, subject_name = subject?.name || course.title
        return publications(course, 'material', data, groupId).map(item => ({ ...item, source: 'teacher' as const, source_item_id: item.id, group_id: groupId, subject_id, subject_name, course_title: course.title, course_archived_at: course.archived_at, read_only: true as const, can_withdraw: item.created_by === userId }))
      })
      const subjects = [...new Map(materials.map(item => [item.subject_id, { id: item.subject_id, group_id: groupId, name: item.subject_name, source: 'teacher' as const, read_only: true }])).values()]
      return copy({ subjects, materials })
    },
    async myMaterials() {
      const data = state()
      return copy({ materials: data.publications.filter(item => item.kind === 'material' && item.created_by === userId).map(item => ({ ...item, course_title: data.courses.find(course => course.id === item.course_id)?.title || 'Предмет', course_archived_at: data.courses.find(course => course.id === item.course_id)?.archived_at || null, can_withdraw: !item.withdrawn_at })) })
    },
    withdrawMaterial: (id, version) => repository.mutate('withdraw_material', { id, version }),
    async groupContext(id) {
      const data = state(), group = data.groups.find(group => group.id === id)
      const courses = data.courses.filter(course => permissions(course, data).length && data.links.some(link => link.course_id === course.id && link.group_id === id && link.status === 'accepted'))
      if (!group || !courses.length) fail('TEACHING_FORBIDDEN')
      return copy({ group, courses: courses.map(course => ({ ...course, permissions: permissions(course, data) })) })
    },
    async classroom(itemId, groupId) { return classroomData(itemId, groupId) },
    async classroomSeminars(courseId, groupId): Promise<TeachingClassroomSeminars> {
      const data = state(), course = data.courses.find(course => course.id === courseId), link = data.links.find(link => link.course_id === courseId && link.group_id === groupId && link.status === 'accepted')
      if (!course || !link || !permissions(course, data).length) fail('TEACHING_FORBIDDEN')
      const seminars = data.seminars.seminars.filter(seminar => seminar.group_id === groupId && seminar.subject_id === link.subject_id && seminar.lesson_date >= course.starts_on && seminar.lesson_date <= course.ends_on)
      const ids = new Set(seminars.map(seminar => seminar.id))
      return copy({ subject_id: link.subject_id || null, supplement_capacity: seminarSupplementCapacity(data.groups.find(group => group.id === groupId)?.supplement_capacity), schedule: data.seminarSchedule.filter(slot => slot.group_id === groupId && slot.subject_id === link.subject_id), seminars: seminars.map(seminar => ({ ...seminar, version: data.seminarVersions[seminar.id] || 1, author_name: data.teachers.find(teacher => teacher.id === seminar.created_by)?.full_name || 'Староста' })), questions: data.seminars.questions.filter(q => ids.has(q.seminar_id)).map(question => ({ ...question, supplement_capacity: seminarSupplementCapacity(question.supplement_capacity) })), teams: data.seminars.teams.filter(team => ids.has(team.seminar_id)), reservations: data.seminars.reservations.filter(r => ids.has(r.seminar_id)), profiles: data.seminars.profiles, can_edit: !course.archived_at && permissions(course, data).includes('assignments') })
    },
    async group(id): Promise<TeachingGroupData> {
      const data = state()
      if (!member(id, userId, data)) fail('TEACHING_FORBIDDEN')
      const courses = data.courses.filter(course => data.links.some(link => link.course_id === course.id && link.group_id === id && link.status === 'accepted'))
      // Match the own published-only production projection, even for a grader.
      // A staff snapshot may contain the full journal and private draft fields.
      const grades: TeachingOwnGrade[] = data.grades.flatMap(grade => {
        if (!grade.published_at) return []
        const entry = data.entries.find(row => row.id === grade.entry_id && row.user_id === userId && row.group_id === id)
        const course = entry && courses.find(row => row.id === entry.course_id)
        const activity = entry && data.activities.find(row => row.id === grade.activity_id && row.group_id === id && row.course_id === entry.course_id)
        if (!entry || !course || !activity) return []
        return [{
          id: grade.id, course_id: course.id, group_id: id, activity_id: activity.id, entry_id: entry.id,
          published_score: grade.published_score, published_comment: grade.published_comment, published_at: grade.published_at,
          max_points: activity.max_points, activity_title: activity.title, activity_date: activity.activity_date,
          category: activity.category, course_title: course.title, grading_rules: course.grading_rules,
        }]
      })
      return copy({ courses: courses.map(course => ({ ...course, permissions: permissions(course, data) })), pending_invites: data.links.filter(link => link.group_id === id && ['pending_group', 'pending_teacher'].includes(link.status)).map(link => ({ ...link, title: data.courses.find(course => course.id === link.course_id)?.title, semester: data.courses.find(course => course.id === link.course_id)?.semester, teacher_name: data.teachers.find(teacher => teacher.id === data.courses.find(course => course.id === link.course_id)?.owner_id)?.full_name })), assignments: courses.flatMap(course => publications(course, 'assignment', data, id)), materials: courses.flatMap(course => publications(course, 'material', data, id)), grades })
    },
    async upload(courseId, actor, file) {
      const data = state(), course = data.courses.find(item => item.id === courseId)
      if (!course || actor !== userId || course.archived_at || !permissions(course, data).some(permission => ['materials', 'assignments'].includes(permission))) fail('TEACHING_FORBIDDEN')
      validateTeachingFile(file)
      const storage_path = `${courseId}/${userId}/${crypto.randomUUID()}.${file.name.split('.').pop()!.toLowerCase()}`
      localFiles.set(storage_path, URL.createObjectURL(file))
      return { storage_path, name: file.name, mime_type: file.type || 'application/octet-stream', size: file.size }
    },
    async fileUrl(file: TeachingFile) {
      const data = state(), matching = data.publications.filter(item => item.attachments.some(attachment => attachment.storage_path === file.storage_path))
      if (!matching.some(item => !item.withdrawn_at && (item.created_by === userId || (() => { const course = data.courses.find(course => course.id === item.course_id); return course && publications(course, item.kind, data).some(visible => visible.id === item.id) })()))) fail('TEACHING_FORBIDDEN')
      const url = localFiles.get(file.storage_path)
      if (!url) throw new Error('Локальний файл доступний до перезавантаження сторінки. Завантажте його ще раз у прикладі.')
      return url
    },
    async uploadSubmission(submissionId, actor, file) {
      const data = state(), submission = data.submissions.find(item => item.id === submissionId && item.user_id === userId)
      if (!submission || actor !== userId || !classroomData(submission.item_id, submission.group_id).can_submit || !['draft', 'returned'].includes(submission.status)) fail('TEACHING_FORBIDDEN')
      validateTeachingFile(file)
      const storage_path = `${submissionId}/${userId}/${crypto.randomUUID()}.${file.name.split('.').pop()!.toLowerCase()}`
      localFiles.set(storage_path, URL.createObjectURL(file))
      return { storage_path, name: file.name, mime_type: file.type || 'application/octet-stream', size: file.size }
    },
    async submissionFileUrl(file) {
      const data = state(), submission = data.submissions.find(s => file.storage_path.startsWith(`${s.id}/`))
      if (!submission) fail('TEACHING_FORBIDDEN')
      const visible = classroomData(submission.item_id, submission.group_id)
      const isOwner = submission.user_id === userId
      const linked = visible.submissions.some(s => s.attachments.some(a => a.storage_path === file.storage_path)) || visible.history.some(h => h.attachments.some(a => a.storage_path === file.storage_path))
      if (!isOwner && !linked) fail('TEACHING_FORBIDDEN')
      const url = localFiles.get(file.storage_path)
      if (!url) throw new Error('Локальний файл доступний до перезавантаження сторінки.')
      return url
    },
    async classroomMutate(action, payload) {
      const prior = copy(state()), data = copy(prior), timestamp = now(), id = String(payload.id || '')
      const receiptKey = `${userId}:classroom:${action}:${id}:${payload.version ?? payload.source_version ?? 0}`, signature = JSON.stringify(payload)
      if (data.receipts[receiptKey]) { if (data.receipts[receiptKey].signature !== signature) fail('TEACHING_CONFLICT'); return copy(data.receipts[receiptKey].result) }
      let result: { id?: string; version?: number } = {}
      try {
        if (action === 'save_group_assignment' || action === 'copy_assignment') {
          let nextPayload = copy(payload)
          const source = data.publications.find(item => item.id === payload.source_item_id)
          if (action === 'copy_assignment' || payload.source_item_id) {
            if (!source || source.kind !== 'assignment') fail('TEACHING_NOT_FOUND')
            const course = data.courses.find(course => course.id === source.course_id)!
            if (course.archived_at || !permitted(course, 'assignments', data)) fail('TEACHING_FORBIDDEN')
            checkVersion(source.version, payload.source_version)
            const groupId = action === 'copy_assignment' ? String(payload.destination_group_id) : String((payload.targets as TeachingPublication['targets'])[0]?.group_id)
            if (!data.links.some(link => link.course_id === course.id && link.group_id === groupId && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
            if (action === 'copy_assignment') nextPayload = { ...copy(source), id, version: 0, targets: [{ group_id: groupId, due_at: payload.due_at || null }], status: 'draft' }
            else {
              if (!source.targets.some(target => target.group_id === groupId) || source.targets.length < 2) fail('TEACHING_INVALID_INPUT')
              source.targets = source.targets.filter(target => target.group_id !== groupId); source.version++
              for (const activity of data.activities.filter(a => a.item_id === source.id && a.group_id === groupId)) activity.item_id = id
              for (const submission of data.submissions.filter(s => s.item_id === source.id && s.group_id === groupId)) { submission.item_id = id; submission.version++ }
              persist(data)
            }
            data.publications.push({ ...copy(source), id, version: action === 'copy_assignment' ? 0 : 1, status: 'draft', published_at: null, created_by: userId, author_name: identity.fullName, targets: [{ group_id: groupId, due_at: (nextPayload.targets as TeachingPublication['targets'])[0]?.due_at || null }] })
            if (action !== 'copy_assignment') nextPayload.version = 1
            persist(data)
          }
          if ((nextPayload.targets as TeachingPublication['targets'])?.length !== 1) fail('TEACHING_INVALID_INPUT')
          const existing = data.publications.find(item => item.id === id)
          const targetGroup = (nextPayload.targets as TeachingPublication['targets'])[0]?.group_id
          if (!payload.source_item_id && existing && !(existing.status === 'draft' && !existing.targets.length)
            && (existing.targets.length !== 1 || existing.targets[0].group_id !== targetGroup)) fail('CLASSROOM_EXPLICIT_FORK_REQUIRED')
          result = await repository.mutate('save_assignment', nextPayload)
        } else if (action === 'delete_group_assignment') {
          const item = data.publications.find(item => item.id === id && item.kind === 'assignment'), groupId = String(payload.group_id)
          const course = data.courses.find(course => course.id === item?.course_id)
          if (!item || !course || !permitted(course, 'assignments', data) || course.archived_at || !item.targets.some(target => target.group_id === groupId) && !(item.status === 'draft' && !item.targets.length) || !data.links.some(link => link.course_id === course.id && link.group_id === groupId && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
          checkVersion(item.version, payload.version)
          if (data.submissions.some(s => s.item_id === id && s.group_id === groupId)) fail('CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS')
          if (item.targets.length > 1) { item.targets = item.targets.filter(target => target.group_id !== groupId); item.version++ }
          else data.publications = data.publications.filter(item => item.id !== id)
          for (const activity of data.activities.filter(activity => activity.item_id === id && activity.group_id === groupId)) {
            if (data.grades.some(grade => grade.activity_id === activity.id)) { if (item.targets.length === 1 && !data.publications.some(item => item.id === id)) activity.item_id = null }
            else data.activities = data.activities.filter(row => row.id !== activity.id)
          }
          result = { id, version: item.version }; persist(data)
        } else if (['reserve_submission', 'save_submission', 'submit_submission', 'withdraw_submission', 'review_submission'].includes(action)) {
          let submission = data.submissions.find(item => item.id === id)
          if (action === 'reserve_submission' || action === 'save_submission' && !submission) {
            const itemId = String(payload.item_id), groupId = String(payload.group_id), visible = classroomData(itemId, groupId)
            if (!visible.can_submit) fail('TEACHING_FORBIDDEN')
            submission = data.submissions.find(s => s.item_id === itemId && s.group_id === groupId && s.user_id === userId)
            if (!submission) { submission = { id, item_id: itemId, course_id: visible.item.course_id, group_id: groupId, user_id: userId, status: 'draft', body: '', links: [], attachments: [], version: 1, attempt: 0, submitted_at: null, feedback: '', reviewed_at: null, reviewed_by: null, reviewer_name: null, student_name: identity.fullName, grade_version: 0, published_score: null, published_comment: '' }; data.submissions.push(submission) }
            if (action === 'reserve_submission') result = { id: submission.id, version: submission.version }
          }
          if (!submission) fail('TEACHING_NOT_FOUND')
          const visible = classroomData(submission.item_id, submission.group_id)
          if (action !== 'reserve_submission') {
            checkVersion(submission.version, payload.version)
            if (action !== 'review_submission' && (submission.user_id !== userId || !visible.can_submit)) fail('TEACHING_FORBIDDEN')
            if (action === 'save_submission') {
              if (!['draft', 'returned'].includes(submission.status)) fail('CLASSROOM_SUBMISSION_LOCKED')
              const links = validateTeachingLinks(payload.links as string[] || []), attachments = copy(payload.attachments as TeachingFile[] || [])
              if (attachments.length > 10 || attachments.some(file => !file.storage_path.startsWith(`${submission!.id}/${userId}/`) || !localFiles.has(file.storage_path) && !submission!.attachments.some(previous => JSON.stringify(previous) === JSON.stringify(file)))) fail('TEACHING_FILE_FORBIDDEN')
              if (String(payload.body || '').length > 10000) fail('TEACHING_INVALID_INPUT')
              Object.assign(submission, { body: String(payload.body || ''), links, attachments, version: submission.version + 1 })
            } else if (action === 'submit_submission') {
              if (!['draft', 'returned'].includes(submission.status)) fail('CLASSROOM_SUBMISSION_LOCKED')
              if (!submission.body.trim() && !submission.links.length && !submission.attachments.length) fail('CLASSROOM_SUBMISSION_EMPTY')
              Object.assign(submission, { status: 'submitted', attempt: submission.attempt + 1, submitted_at: timestamp, feedback: '', reviewed_at: null, reviewed_by: null, reviewer_name: null, version: submission.version + 1 })
              data.handedIn[submission.id] = { body: submission.body, links: copy(submission.links), attachments: copy(submission.attachments) }
            } else if (action === 'withdraw_submission') {
              if (submission.status !== 'submitted') fail('CLASSROOM_SUBMISSION_LOCKED')
              submission.status = 'draft'; submission.version++
            } else if (action === 'review_submission') {
              if (!visible.can_review || !['submitted', 'reviewed'].includes(submission.status) || !['returned', 'reviewed'].includes(String(payload.status))) fail('TEACHING_FORBIDDEN')
              const feedback = String(payload.feedback || '').trim()
              if (feedback.length > 10000 || payload.status === 'returned' && feedback.length < 2) fail('TEACHING_INVALID_INPUT')
              if (payload.score !== undefined) {
                if (!visible.permissions.includes('grades') || !visible.activity_id) fail('TEACHING_FORBIDDEN')
                const entry = data.entries.find(e => e.course_id === submission!.course_id && e.group_id === submission!.group_id && e.user_id === submission!.user_id && e.active)
                if (!entry) fail('TEACHING_ROSTER_LINK_REQUIRED')
                persist(data)
                const gradeResult = await repository.mutate('save_grade', { activity_id: visible.activity_id, entry_id: entry.id, score: payload.score, comment: feedback, reason: payload.reason || '', version: payload.grade_version })
                await repository.mutate('publish_grades', { activity_id: visible.activity_id, expected_versions: [{ entry_id: entry.id, version: gradeResult.version }] })
                Object.assign(data, copy(state()))
                submission = data.submissions.find(item => item.id === id)!
              }
              Object.assign(submission, { status: payload.status, feedback, reviewed_at: timestamp, reviewed_by: userId, reviewer_name: identity.fullName, version: submission.version + 1 })
            }
            if (action !== 'save_submission') data.submissionHistory.push({ id: crypto.randomUUID(), submission_id: submission.id, attempt: submission.attempt, status: submission.status, action: action === 'submit_submission' ? 'submitted' : action === 'withdraw_submission' ? 'withdrawn' : String(payload.status), body: data.handedIn[submission.id]?.body || submission.body, links: copy(data.handedIn[submission.id]?.links || submission.links), attachments: copy(data.handedIn[submission.id]?.attachments || submission.attachments), feedback: submission.feedback, created_at: timestamp, actor_name: identity.fullName, score: payload.score === undefined ? null : payload.score as number | null, version: submission.version })
            result = { id: submission.id, version: submission.version }
          }
          persist(data)
        } else if (action === 'save_seminar_schedule' || action === 'save_seminar') {
          const course = data.courses.find(course => course.id === payload.course_id), groupId = String(payload.group_id), link = data.links.find(link => link.course_id === course?.id && link.group_id === groupId && link.status === 'accepted')
          if (!course || !link || course.archived_at || !permissions(course, data).includes('assignments')) fail('TEACHING_FORBIDDEN')
          if (action === 'save_seminar_schedule') {
            if (!link.subject_id) { link.subject_id = crypto.randomUUID(); data.groups.find(group => group.id === groupId)!.subjects!.push({ id: link.subject_id, name: course.title }) }
            const weekday = Number(payload.weekday), starts = String(payload.starts_at), ends = String(payload.ends_at), from = String(payload.valid_from), until = String(payload.valid_until)
            if (weekday < 1 || weekday > 7 || starts >= ends || from < course.starts_on || until > course.ends_on || from > until) fail('TEACHING_INVALID_INPUT')
            if (data.seminarSchedule.some(slot => slot.id === id)) fail('TEACHING_CONFLICT')
            data.seminarSchedule.push({ id, group_id: groupId, subject_id: link.subject_id, weekday, starts_at: starts, ends_at: ends, valid_from: from, valid_until: until, created_by: userId }); result = { id, version: 1 }
          } else {
            const slot = data.seminarSchedule.find(slot => slot.id === payload.schedule_id && slot.group_id === groupId && slot.subject_id === link.subject_id)
            const date = String(payload.lesson_date)
            if (!slot || !scheduleOnDate(slot, date) || date < course.starts_on || date > course.ends_on) fail('TEACHING_INVALID_INPUT')
            let seminar = data.seminars.seminars.find(seminar => seminar.id === id)
            if (seminar && seminarHasStarted(seminar) || seminarHasStarted({ lesson_date: date, starts_at: slot.starts_at })) fail('SEMINAR_LOCKED')
            if (seminar) { if (seminar.subject_id !== link.subject_id || seminar.group_id !== groupId) fail('TEACHING_FORBIDDEN'); checkVersion(data.seminarVersions[id] || 1, payload.version) }
            else { if (Number(payload.version) !== 0 || data.seminars.seminars.some(s => s.schedule_id === slot.id && s.lesson_date === date)) fail('TEACHING_CONFLICT'); seminar = { id, group_id: groupId, subject_id: link.subject_id!, schedule_id: slot.id, lesson_date: date, starts_at: slot.starts_at, ends_at: slot.ends_at, title: '', instructions: '', format: 'questions', created_by: userId, resource_links: [], resource_attachments: [] }; data.seminars.seminars.push(seminar) }
            const questions = copy(payload.questions as TeachingSnapshot['seminars']['questions'] || []).map(question => {
              const existing = data.seminars.questions.find(row => row.id === question.id && row.seminar_id === id)
              const capacity = question.supplement_capacity === undefined
                ? seminarSupplementCapacity(existing ? existing.supplement_capacity : data.groups.find(group => group.id === groupId)?.supplement_capacity)
                : question.supplement_capacity
              if (!Number.isInteger(capacity) || capacity < 0 || capacity > SEMINAR_MAX_SUPPLEMENT_CAPACITY) fail('SEMINAR_SUPPLEMENT_CAPACITY_INVALID')
              return { ...question, supplement_capacity: capacity }
            }), teams = copy(payload.teams as TeachingSnapshot['seminars']['teams'] || [])
            const booked = data.seminars.reservations.filter(r => r.seminar_id === id)
            if (booked.length && (seminar.lesson_date !== date || seminar.schedule_id !== slot.id || seminar.format !== payload.format)) fail('SEMINAR_HAS_RESERVATIONS')
            if (booked.some(r => r.question_id && !questions.some(q => q.id === r.question_id) || r.team_id && !teams.some(t => t.id === r.team_id))) fail('SEMINAR_HAS_RESERVATIONS')
            if (questions.some(question => booked.filter(row => row.question_id === question.id && row.role === 'supplement').length > question.supplement_capacity)) fail('SEMINAR_SUPPLEMENT_CAPACITY_BELOW_MEMBERS')
            Object.assign(seminar, { schedule_id: slot.id, lesson_date: date, starts_at: slot.starts_at, ends_at: slot.ends_at, title: String(payload.title).trim(), instructions: String(payload.instructions || ''), format: payload.format as Seminar['format'], teaching_course_id: course.id, teaching_author_id: userId })
            data.seminars.questions = [...data.seminars.questions.filter(q => q.seminar_id !== id), ...questions.map((q, index) => ({ ...q, seminar_id: id, position: index + 1 }))]
            data.seminars.teams = [...data.seminars.teams.filter(t => t.seminar_id !== id), ...teams.map((t, index) => ({ ...t, seminar_id: id, position: index + 1 }))]
            data.seminarVersions[id] = (data.seminarVersions[id] || 0) + 1; result = { id, version: data.seminarVersions[id] }
          }
          persist(data)
        } else fail('TEACHING_INVALID_ACTION')
        const latest = copy(state()); latest.receipts[receiptKey] = { signature, result }; persist(latest)
        return copy(result)
      } catch (failure) { persist(prior); throw failure }
    },
    async mutate(action, payload) {
      // Work on a copy so validation or a stale version leaves all local data intact.
      const data = copy(state()), timestamp = now(), id = String(payload.id || ''), signature = JSON.stringify(payload), receiptKey = `${userId}:${action}:${id}`
      const createsWithId = id && (Number(payload.version || 0) === 0 || action === 'copy_course')
      if (createsWithId && data.receipts[receiptKey]) { if (data.receipts[receiptKey].signature !== signature) fail('TEACHING_CONFLICT'); return copy(data.receipts[receiptKey].result) }
      let course = data.courses.find(item => item.id === payload.course_id)
      const requireCourse = (permission: TeachingPermission | 'manage', allowArchive = false) => { if (!course || !permitted(course, permission, data)) fail('TEACHING_FORBIDDEN'); if (course.archived_at && !allowArchive) fail('TEACHING_ARCHIVED'); return course }
      const accepted = (groupId: string) => data.links.some(link => link.course_id === course?.id && link.group_id === groupId && link.status === 'accepted')
      const sync = (selectedCourse: TeachingCourse, groupId: string) => { for (const person of data.members.filter(member => member.group_id === groupId)) if (!data.entries.some(entry => entry.course_id === selectedCourse.id && entry.group_id === groupId && entry.user_id === person.user_id)) data.entries.push({ id: crypto.randomUUID(), course_id: selectedCourse.id, group_id: groupId, user_id: person.user_id, full_name: person.full_name, active: true, version: 1 }) }
      let result: { id?: string; version?: number } = {}
      if (action === 'withdraw_material' || action === 'delete_material') {
        const publication = data.publications.find(item => item.id === id && item.kind === 'material')
        if (!publication) fail('TEACHING_NOT_FOUND')
        if (publication.created_by !== userId) fail('TEACHING_MATERIAL_AUTHOR_REQUIRED')
        if (!publication.withdrawn_at) { checkVersion(publication.version, payload.version); publication.withdrawn_at = timestamp; publication.version++ }
        result = { id: publication.id, version: publication.version }
      } else if (action === 'create_course' || action === 'invite_teacher_from_group') {
        const ownerId = action === 'create_course' ? userId : String(payload.teacher_id), group = data.groups.find(item => item.id === payload.group_id)
        if (action === 'create_course' ? !isTeacher : !group || group.representative_id !== userId) fail('TEACHING_FORBIDDEN')
        if (!data.teachers.some(teacher => teacher.id === ownerId)) fail('TEACHER_VERIFICATION_REQUIRED')
        if (!String(payload.title || '').trim() || !String(payload.semester || '').trim() || String(payload.starts_on) > String(payload.ends_on)) fail('TEACHING_INVALID_INPUT')
        const created: TeachingCourse = { id: id || crypto.randomUUID(), owner_id: ownerId, university_id: UNIVERSITY, academic_unit_id: FACULTY, title: String(payload.title).trim(), semester: String(payload.semester), starts_on: String(payload.starts_on), ends_on: String(payload.ends_on), grading_rules: copy(payload.grading_rules as TeachingCourse['grading_rules'] || { categories: [] }), archived_at: null, version: 1, created_at: timestamp, updated_at: timestamp, permissions: [] }
        if (data.courses.some(item => item.id === created.id)) fail('TEACHING_CONFLICT')
        data.courses.push(created)
        if (group) data.links.push({ id: crypto.randomUUID(), course_id: created.id, group_id: group.id, group_name: group.group_name, representative_id: group.representative_id!, status: 'pending_teacher', subject_id: String(payload.subject_id || '') || null })
        result = { id: created.id, version: 1 }
      } else if (action === 'update_course' || action === 'archive_course' || action === 'copy_course') {
        const source = requireCourse('manage', action !== 'update_course'); checkVersion(source.version, payload.version)
        if (action === 'archive_course') { source.archived_at = payload.archived ? timestamp : null; source.version++; source.updated_at = timestamp; result = { id: source.id, version: source.version } }
        else if (action === 'copy_course') { const next = { ...copy(source), id: id || crypto.randomUUID(), semester: String(payload.semester), starts_on: String(payload.starts_on), ends_on: String(payload.ends_on), archived_at: null, version: 1, created_at: timestamp, updated_at: timestamp }; if (data.courses.some(item => item.id === next.id) || !next.semester.trim() || next.starts_on > next.ends_on) fail('TEACHING_INVALID_INPUT'); data.courses.push(next); for (const item of data.publications.filter(item => item.course_id === source.id && item.kind === 'assignment')) data.publications.push({ ...copy(item), id: crypto.randomUUID(), course_id: next.id, targets: [], status: 'draft', published_at: null, created_by: userId, author_name: identity.fullName, version: 1 }); result = { id: next.id, version: 1 } }
        else { if (!String(payload.title).trim() || String(payload.starts_on) > String(payload.ends_on)) fail('TEACHING_INVALID_INPUT'); source.title = String(payload.title).trim(); source.semester = String(payload.semester); source.starts_on = String(payload.starts_on); source.ends_on = String(payload.ends_on); source.grading_rules = copy(payload.grading_rules as TeachingCourse['grading_rules']); source.version++; source.updated_at = timestamp; result = { id: source.id, version: source.version } }
      } else if (action === 'invite_group') {
        const selectedCourse = requireCourse('manage'), group = data.groups.find(item => item.id === payload.group_id)
        if (!group) fail('TEACHING_NOT_FOUND')
        let link = data.links.find(item => item.course_id === selectedCourse.id && item.group_id === group.id)
        if (link && ['accepted', 'pending_group', 'pending_teacher'].includes(link.status)) fail('TEACHING_ALREADY_INVITED')
        if (!link) { link = { id: crypto.randomUUID(), course_id: selectedCourse.id, group_id: group.id, group_name: group.group_name, representative_id: group.representative_id!, status: 'pending_group' }; data.links.push(link) }
        link.status = 'pending_group'; link.subject_id = String(payload.subject_id || '') || null; result = { id: link.id }
      } else if (action === 'respond_group' || action === 'remove_group') {
        const link = data.links.find(item => item.id === payload.link_id); if (!link) fail('TEACHING_NOT_FOUND'); course = data.courses.find(item => item.id === link.course_id)!
        if (course.archived_at) fail('TEACHING_ARCHIVED')
        if (action === 'respond_group') { if (link.status === 'pending_teacher' ? course.owner_id !== userId : link.status !== 'pending_group' || link.representative_id !== userId) fail('TEACHING_FORBIDDEN'); link.status = payload.accept ? 'accepted' : 'rejected'; if (payload.accept) sync(course, link.group_id) }
        else { if (course.owner_id !== userId && link.representative_id !== userId) fail('TEACHING_FORBIDDEN'); link.status = 'removed' }
        result = { id: link.id }
      } else if (action === 'invite_teacher') {
        const selectedCourse = requireCourse('manage'), teacher = data.teachers.find(item => item.id === payload.user_id)
        if (!teacher || teacher.id === selectedCourse.owner_id) fail('TEACHING_INVALID_INPUT')
        const rights = payload.permissions as TeachingPermission[]; if (!rights.length || rights.some(right => !['materials', 'assignments', 'grades'].includes(right))) fail('TEACHING_INVALID_INPUT')
        let link = data.coTeachers.find(item => item.course_id === selectedCourse.id && item.user_id === teacher.id)
        if (link && ['pending', 'accepted'].includes(link.status)) fail('TEACHING_ALREADY_INVITED')
        if (!link) { link = { id: crypto.randomUUID(), course_id: selectedCourse.id, user_id: teacher.id, full_name: teacher.full_name, permissions: rights, status: 'pending' }; data.coTeachers.push(link) }
        link.permissions = rights; link.status = 'pending'; result = { id: link.id }
      } else if (action === 'respond_teacher' || action === 'update_teacher') {
        const link = data.coTeachers.find(item => item.id === payload.teacher_link_id); if (!link) fail('TEACHING_NOT_FOUND'); course = data.courses.find(item => item.id === link.course_id)!
        if (course.archived_at) fail('TEACHING_ARCHIVED')
        if (action === 'respond_teacher') { if (link.user_id !== userId || link.status !== 'pending') fail('TEACHING_FORBIDDEN'); link.status = payload.accept ? 'accepted' : 'rejected' }
        else { requireCourse('manage'); if (payload.permissions) link.permissions = copy(payload.permissions as TeachingPermission[]); if (payload.status === 'removed') link.status = 'removed' }
        result = { id: link.id }
      } else if (action === 'save_assignment' || action === 'save_material') {
        const kind = action === 'save_assignment' ? 'assignment' : 'material', selectedCourse = requireCourse(kind === 'assignment' ? 'assignments' : 'materials')
        const targets = copy(payload.targets as TeachingPublication['targets'])
        if (!String(payload.title || '').trim() || !targets.length || targets.some(target => !accepted(target.group_id))) fail('TEACHING_INVALID_INPUT')
        if (kind === 'assignment') for (const target of targets) {
          if (payload.status === 'published' && !['lesson', 'unplaced'].includes(target.placement_mode || '')) fail('TEACHING_ASSIGNMENT_PLACEMENT_REQUIRED')
          if (target.lesson_date && (!isTimetableDate(target.lesson_date) || target.lesson_date < selectedCourse.starts_on || target.lesson_date > selectedCourse.ends_on)) fail('TEACHING_ASSIGNMENT_LESSON_INVALID')
          if (target.placement_mode === 'unplaced') {
            if (target.schedule_item_id) fail('TEACHING_ASSIGNMENT_LESSON_INVALID')
            if (payload.status === 'published' && !target.lesson_date && !target.due_at) fail('TEACHING_ASSIGNMENT_LESSON_REQUIRED')
          } else if (target.schedule_item_id || payload.status === 'published') {
            const group = data.groups.find(group => group.id === target.group_id), link = data.links.find(link => link.course_id === selectedCourse.id && link.group_id === target.group_id && link.status === 'accepted')
            const subject = group?.subjects?.find(subject => subject.id === link?.subject_id)
            if (!subject) fail('TEACHING_ASSIGNMENT_SUBJECT_REQUIRED')
            if (!target.lesson_date || !target.schedule_item_id) fail('TEACHING_ASSIGNMENT_LESSON_REQUIRED')
            const lesson = localTeachingTimetable(target.group_id).find(lesson => lesson.id === target.schedule_item_id)
            if (!lesson || normalizedScheduleSubjectName(lesson.subject) !== normalizedScheduleSubjectName(subject.name) || !scheduleOccursOnDate(lesson, target.lesson_date)) fail('TEACHING_ASSIGNMENT_LESSON_INVALID')
          }
        }
        const links = validateTeachingLinks(payload.links as string[]), attachments = copy(payload.attachments as TeachingFile[])
        if (kind === 'material' && attachments.some(file => file.storage_path.split('/')[0] !== selectedCourse.id || file.storage_path.split('/')[1] !== userId)) fail('TEACHING_FILE_FORBIDDEN')
        if (attachments.length > 10 || attachments.some(file => !localFiles.has(file.storage_path) && !data.publications.some(publication => publication.attachments.some(existing => existing.storage_path === file.storage_path)))) fail('TEACHING_INVALID_INPUT')
        let publication = data.publications.find(item => item.id === id)
        if (kind === 'material' && publication?.created_by !== undefined && publication.created_by !== userId) fail('TEACHING_MATERIAL_AUTHOR_REQUIRED')
        if (kind === 'material' && publication?.withdrawn_at) fail('TEACHING_MATERIAL_WITHDRAWN')
        if (kind === 'material' && payload.status === 'published' && (payload.rights_accepted !== true || payload.rights_terms_version !== TEACHING_MATERIAL_TERMS_VERSION)) fail('TEACHING_MATERIAL_RIGHTS_REQUIRED')
        const link_labels = validateTeachingPublicationLinks(links, getResourceLinkTitles(links,
          Object.prototype.hasOwnProperty.call(payload, 'link_labels') ? payload.link_labels : publication?.link_labels)).link_labels
        const maximum = kind === 'assignment' && payload.max_points !== null && payload.max_points !== undefined && payload.max_points !== '' ? Number(payload.max_points) : null
        const category = maximum === null ? null : String(payload.category || '')
        if (maximum !== null && (!Number.isFinite(maximum) || maximum <= 0 || maximum > 10000 || Math.round(maximum * 100) / 100 !== maximum || category && !selectedCourse.grading_rules.categories.some(rule => rule.id === category))) fail('TEACHING_INVALID_INPUT')
        if (kind === 'assignment' && !permitted(selectedCourse, 'grades', data) && (maximum !== (publication?.max_points ?? null) || category !== (publication?.category ?? null))) fail('TEACHING_FORBIDDEN')
        if (publication) { if (publication.course_id !== selectedCourse.id || publication.kind !== kind) fail('TEACHING_FORBIDDEN'); checkVersion(publication.version, payload.version) }
        else { if (Number(payload.version) !== 0) fail('TEACHING_CONFLICT'); publication = { id: id || crypto.randomUUID(), course_id: selectedCourse.id, kind, title: '', body: '', links: [], attachments: [], targets: [], status: 'draft', published_at: null, created_by: userId, author_name: identity.fullName, version: 0 }; data.publications.push(publication) }
        if (kind === 'assignment' && payload.status !== 'published' && data.submissions.some(submission => submission.item_id === publication!.id)) fail('CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS')
        const linkedActivities = data.activities.filter(activity => activity.item_id === publication!.id)
        if (kind === 'assignment' && maximum === null && linkedActivities.some(activity => data.grades.some(grade => grade.activity_id === activity.id))) fail('TEACHING_ASSESSMENT_HAS_GRADES')
        if (kind === 'assignment' && maximum !== null && linkedActivities.some(activity => data.grades.some(grade => grade.activity_id === activity.id && Math.max(grade.draft_score || 0, grade.published_score || 0) > maximum))) fail('TEACHING_MAX_BELOW_SCORE')
        if (kind === 'assignment' && maximum === null && payload.status === 'published') data.activities = data.activities.filter(activity => activity.item_id !== publication!.id)
        Object.assign(publication, { title: String(payload.title).trim(), body: String(payload.body || ''), links, link_labels, attachments, targets, max_points: maximum, category, material_date: String(payload.material_date || '') || undefined, status: payload.status === 'published' ? 'published' : 'draft', published_at: payload.status === 'published' ? timestamp : null, version: publication.version + 1 })
        if (kind === 'material' && payload.status === 'published') Object.assign(publication, { rights_terms_version: TEACHING_MATERIAL_TERMS_VERSION, rights_accepted_at: timestamp })
        if (kind === 'assignment' && publication.status === 'published') {
          for (const existing of linkedActivities) {
            const retained = maximum !== null && targets.some(target => target.group_id === existing.group_id)
            if (!retained && !data.grades.some(grade => grade.activity_id === existing.id)) data.activities = data.activities.filter(activity => activity.id !== existing.id)
          }
          if (maximum !== null) for (const target of targets) {
            const today = localDeadline(timestamp).slice(0, 10)
            const date = target.due_at ? localDeadline(target.due_at).slice(0, 10) : publication.material_date || (today < selectedCourse.starts_on ? selectedCourse.starts_on : today > selectedCourse.ends_on ? selectedCourse.ends_on : today)
            if (date < selectedCourse.starts_on || date > selectedCourse.ends_on) fail('TEACHING_INVALID_INPUT')
            let activity = linkedActivities.find(item => item.group_id === target.group_id)
            if (activity && data.grades.some(grade => grade.activity_id === activity!.id && Math.max(grade.draft_score || 0, grade.published_score || 0) > maximum)) fail('TEACHING_MAX_BELOW_SCORE')
            if (!activity) { activity = { id: crypto.randomUUID(), course_id: selectedCourse.id, group_id: target.group_id, title: publication.title, category: category!, activity_date: date, max_points: maximum, item_id: publication.id, version: 0 }; data.activities.push(activity) }
            Object.assign(activity, { title: publication.title, category, activity_date: date, max_points: maximum, version: activity.version + 1 })
          }
        }
        result = { id: publication.id, version: publication.version }
      } else if (action === 'delete_assignment' || action === 'delete_material') {
        const publication = data.publications.find(item => item.id === id)
        if (!publication) fail('TEACHING_NOT_FOUND')
        const kind = action === 'delete_assignment' ? 'assignment' : 'material'
        course = data.courses.find(item => item.id === publication.course_id)
        requireCourse(kind === 'assignment' ? 'assignments' : 'materials')
        if (publication.kind !== kind) fail('TEACHING_INVALID_INPUT')
        checkVersion(publication.version, payload.version)
        data.publications = data.publications.filter(item => item.id !== id)
        for (const activity of data.activities.filter(item => item.item_id === id)) activity.item_id = null
        result = { id }
      } else if (action === 'sync_roster') { const selectedCourse = requireCourse('grades'); if (!accepted(String(payload.group_id))) fail('TEACHING_FORBIDDEN'); sync(selectedCourse, String(payload.group_id)); result = { id: selectedCourse.id } }
      else if (action === 'save_entry') {
        const selectedCourse = requireCourse('grades'); if (!accepted(String(payload.group_id)) || !String(payload.full_name || '').trim()) fail('TEACHING_INVALID_INPUT')
        let entry = data.entries.find(item => item.id === id)
        if (entry) { if (entry.course_id !== selectedCourse.id || entry.group_id !== payload.group_id) fail('TEACHING_FORBIDDEN'); checkVersion(entry.version, payload.version); entry.full_name = String(payload.full_name).trim(); entry.active = payload.active !== false; entry.version++ }
        else { if (Number(payload.version) !== 0) fail('TEACHING_CONFLICT'); entry = { id: id || crypto.randomUUID(), course_id: selectedCourse.id, group_id: String(payload.group_id), full_name: String(payload.full_name).trim(), user_id: null, active: true, version: 1 }; data.entries.push(entry) }; result = { id: entry.id, version: entry.version }
      } else if (action === 'request_roster_link') {
        const entry = data.entries.find(item => item.id === payload.entry_id); if (!entry) fail('TEACHING_NOT_FOUND'); course = data.courses.find(item => item.id === entry.course_id)!; requireCourse('grades')
        const actor = String(payload.user_id)
        if (entry.user_id || !member(entry.group_id, actor, data) || data.claims.some(claim => claim.entry_id === entry.id && claim.status === 'pending')) fail('TEACHING_FORBIDDEN')
        const existing = data.entries.find(item => item.course_id === entry.course_id && item.group_id === entry.group_id && item.user_id === actor)
        if (existing && data.grades.some(grade => grade.entry_id === existing.id)) fail('TEACHING_ACCOUNT_ALREADY_LINKED')
        const claim: LocalClaim = { id: crypto.randomUUID(), entry_id: entry.id, user_id: actor, full_name: entry.full_name, status: 'pending', course_title: course.title }; data.claims.push(claim); result = { id: claim.id }
      } else if (action === 'respond_roster_link') {
        const claim = data.claims.find(item => item.id === payload.claim_id), entry = data.entries.find(item => item.id === claim?.entry_id)
        if (!claim || !entry || claim.user_id !== userId || claim.status !== 'pending' || entry.user_id || !member(entry.group_id, userId, data)) fail('TEACHING_FORBIDDEN')
        if (payload.accept) { const existing = data.entries.find(item => item.course_id === entry.course_id && item.group_id === entry.group_id && item.user_id === userId); if (existing && data.grades.some(grade => grade.entry_id === existing.id)) fail('TEACHING_ACCOUNT_ALREADY_LINKED'); data.entries = data.entries.filter(item => item !== existing); entry.user_id = userId; entry.version++; claim.status = 'accepted' } else claim.status = 'rejected'; result = { id: claim.id }
      } else if (action === 'save_activity') {
        const selectedCourse = requireCourse('grades'), maximum = Number(payload.max_points), date = String(payload.activity_date)
        if (!accepted(String(payload.group_id)) || !String(payload.title || '').trim() || !Number.isFinite(maximum) || maximum <= 0 || maximum > 10000 || date < selectedCourse.starts_on || date > selectedCourse.ends_on) fail('TEACHING_INVALID_INPUT')
        let activity = data.activities.find(item => item.id === id)
        if (activity) { if (activity.course_id !== selectedCourse.id || activity.group_id !== payload.group_id || activity.item_id) fail('TEACHING_FORBIDDEN'); checkVersion(activity.version, payload.version); if (data.grades.some(grade => grade.activity_id === activity!.id && Math.max(grade.draft_score || 0, grade.published_score || 0) > maximum)) fail('TEACHING_MAX_BELOW_SCORE') }
        else { if (Number(payload.version) !== 0) fail('TEACHING_CONFLICT'); activity = { id: id || crypto.randomUUID(), course_id: selectedCourse.id, group_id: String(payload.group_id), title: '', category: '', activity_date: date, max_points: maximum, version: 0 }; data.activities.push(activity) }
        Object.assign(activity, { title: String(payload.title).trim(), category: String(payload.category || ''), activity_date: date, max_points: maximum, seminar_id: payload.seminar_id ? String(payload.seminar_id) : null, version: activity.version + 1 }); result = { id: activity.id, version: activity.version }
      } else if (action === 'save_grade') {
        const activity = data.activities.find(item => item.id === payload.activity_id), entry = data.entries.find(item => item.id === payload.entry_id)
        if (!activity || !entry || entry.course_id !== activity.course_id || entry.group_id !== activity.group_id || !entry.active) fail('TEACHING_FORBIDDEN')
        course = data.courses.find(item => item.id === activity.course_id)!; requireCourse('grades'); if (!accepted(activity.group_id)) fail('TEACHING_FORBIDDEN')
        const score = payload.score === null ? null : Number(payload.score), comment = String(payload.comment || ''), reason = String(payload.reason || '')
        if (score !== null && (!Number.isFinite(score) || score < 0 || score > activity.max_points || Math.round(score * 100) / 100 !== score)) fail('TEACHING_INVALID_INPUT')
        let grade = data.grades.find(item => item.entry_id === entry.id && item.activity_id === activity.id)
        if (grade) { checkVersion(grade.version, payload.version); if (grade.published_at && (score !== grade.published_score || comment !== grade.published_comment) && reason.trim().length < 2) fail('TEACHING_REVISION_REASON_REQUIRED') }
        else { if (Number(payload.version) !== 0) fail('TEACHING_CONFLICT'); grade = { id: crypto.randomUUID(), activity_id: activity.id, entry_id: entry.id, published_score: null, published_comment: '', published_at: null, version: 0 }; data.grades.push(grade) }
        data.audit.push({ id: crypto.randomUUID(), activity_id: activity.id, entry_id: entry.id, old_score: grade.draft_score ?? null, new_score: score, reason, actor_name: identity.fullName, created_at: timestamp }); grade.draft_score = score; grade.draft_comment = comment; grade.version++; result = { id: grade.id, version: grade.version }
      } else if (action === 'publish_grades') {
        const activity = data.activities.find(item => item.id === payload.activity_id); if (!activity) fail('TEACHING_NOT_FOUND'); course = data.courses.find(item => item.id === activity.course_id)!; requireCourse('grades')
        const expected = payload.expected_versions as { entry_id: string; version: number }[]; if (!expected.length || !accepted(activity.group_id)) fail('TEACHING_INVALID_INPUT')
        for (const item of expected) { const grade = data.grades.find(grade => grade.activity_id === activity.id && grade.entry_id === item.entry_id); if (!grade) fail('TEACHING_CONFLICT'); checkVersion(grade.version, item.version); data.audit.push({ id: crypto.randomUUID(), activity_id: activity.id, entry_id: grade.entry_id, old_score: grade.published_score, new_score: grade.draft_score ?? null, reason: 'Публікація результату', actor_name: identity.fullName, created_at: timestamp }); grade.published_score = grade.draft_score ?? null; grade.published_comment = grade.draft_comment || ''; grade.published_at = timestamp; grade.version++ }; result = { id: activity.id }
      } else fail('TEACHING_INVALID_ACTION')
      if (createsWithId) data.receipts[receiptKey] = { signature, result }
      persist(data)
      return copy(result)
    },
  }
  return repository
}
