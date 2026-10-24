import {
  EMPTY_TEACHING_SEMINARS, localDeadline, validateTeachingFile, validateTeachingLinks, validateTeachingPublicationLinks,
  type TeachingActivity, type TeachingAudit, type TeachingCourse, type TeachingDirectoryGroup,
  type TeachingDirectoryTeacher, type TeachingEntry, type TeachingFile, type TeachingGrade,
  type TeachingGroup, type TeachingGroupData, type TeachingOwnGrade, type TeachingPermission, type TeachingPublication,
  type TeachingRepository, type TeachingRosterClaim, type TeachingSnapshot, type TeachingTeacher,
  type TeachingWorkspaceData, type TeachingSubmission, type TeachingSubmissionHistory, type TeachingSubmissionData, type TeachingClassroomSeminars,
  type TeachingGradeRequest,
} from './teaching'
import type { SeminarSchedule } from './seminars'
import { getResourceLinkTitles } from './resourceLinkLabels'
import { TEACHING_MATERIAL_TERMS_VERSION } from './legal'
import { addTimetableDays, isTimetableDate, scheduleOccursOnDate, type TimetableLesson } from './studyGroupTimetable'
import { normalizedScheduleSubjectName } from './scheduleSubjects'
import { isTeachingMaterialPreviewFile } from './teachingMaterialPreview'
import { teachingRulesForGroup, validateTeachingGradingRules } from './teachingGrading'

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
type LocalPublication = TeachingPublication & { course_id: string; kind: 'assignment' | 'material'; max_points?: number | null; category?: string | null; withdrawn_at?: string | null; rights_terms_version?: string; rights_accepted_at?: string; schedule_actor_id?: string | null; schedule_error?: string | null }
type LocalActivity = TeachingActivity & { item_id?: string | null }
type LocalEntry = TeachingEntry & { created_at?: string }
type LocalClaim = TeachingRosterClaim & { course_title?: string }
type LocalExtension = { item_id: string; group_id: string; user_id: string; closes_at: string | null; version: number }
type State = {
  schema: number; courses: TeachingCourse[]; groups: TeachingDirectoryGroup[];
  teachers: TeachingDirectoryTeacher[]; links: TeachingGroup[]; coTeachers: TeachingTeacher[];
  entries: LocalEntry[]; activities: LocalActivity[]; grades: TeachingGrade[];
  publications: LocalPublication[]; audit: TeachingAudit[]; claims: LocalClaim[];
  members: { group_id: string; user_id: string; full_name: string }[];
  seminars: TeachingSnapshot['seminars']; receipts: Record<string, { signature: string; result: { id?: string; version?: number; existing?: boolean } }>;
  submissions: TeachingSubmission[]; submissionHistory: TeachingSubmissionHistory[];
  handedIn: Record<string, Pick<TeachingSubmission, 'body' | 'links' | 'attachments'>>;
  seminarSchedule: SeminarSchedule[]; seminarVersions: Record<string, number>;
  submissionExtensions?: LocalExtension[]; gradeRequests?: TeachingGradeRequest[];
  teachingFeaturesVersion?: number;
}
const STORAGE_KEY = 'xelay-local-teaching-preview-v3'
let cache: State | null = null
const localFiles = new Map<string, string>()
const copy = <T,>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()
function fail(code: string): never { throw new Error(code) }
const checkVersion = (actual: number, expected: unknown) => { if (actual !== Number(expected)) fail('TEACHING_CONFLICT') }

function publishScheduled(data: State) {
  const timestamp = now()
  for (const item of data.publications) {
    const course = data.courses.find(course => course.id === item.course_id)
    if (item.status !== 'scheduled' || !item.publish_at || Date.parse(item.publish_at) > Date.parse(timestamp) || !course || course.archived_at || item.withdrawn_at) continue
    const actor = item.schedule_actor_id || item.created_by
    const right = item.kind === 'assignment' ? 'assignments' : 'materials'
    if (!(course.owner_id === actor || data.coTeachers.some(link => link.course_id === course.id && link.user_id === actor && link.status === 'accepted' && link.permissions.includes(right))) || item.kind === 'material' && (actor !== item.created_by || item.rights_terms_version !== TEACHING_MATERIAL_TERMS_VERSION && !(item.allow_download !== false && item.rights_terms_version === '2026-10-21.1')) || item.targets.some(target => !data.links.some(link => link.course_id === course.id && link.group_id === target.group_id && link.status === 'accepted'))) { item.schedule_error = 'TEACHING_SCHEDULE_REVIEW_REQUIRED'; continue }
    item.status = 'published'; item.published_at = item.publish_at; item.version++
    item.schedule_error = null
    if (item.kind === 'assignment' && item.max_points != null) for (const target of item.targets) {
      if (!data.links.some(link => link.course_id === item.course_id && link.group_id === target.group_id && link.status === 'accepted') || data.activities.some(activity => activity.item_id === item.id && activity.group_id === target.group_id)) continue
      const date = target.lesson_date || (target.due_at ? localDeadline(target.due_at).slice(0, 10) : course.starts_on)
      data.activities.push({ id: crypto.randomUUID(), course_id: item.course_id, group_id: target.group_id, title: item.title, category: item.category || '', work_type: item.work_type || '', activity_date: date, max_points: item.max_points, item_id: item.id, version: 1 })
    }
  }
}
function addTeachingFeatureFixtures(data: State) {
  const previous = data.teachingFeaturesVersion || 0
  if (previous >= 3) return
  data.teachingFeaturesVersion = 3
  const course = data.courses.find(course => course.id === COURSE)
  if (!course || !data.links.some(link => link.course_id === COURSE && link.group_id === GROUP_1 && link.status === 'accepted')) return
  if (!course.grading_rules.presets) course.grading_rules.presets = [
    { id: 'seminar-5', name: 'Семінар · 5 балів', work_type: 'Семінар', max_points: 5, category: 'seminars', submission_format: 'oral' },
    { id: 'notes-1', name: 'Конспект · 1 бал', work_type: 'Конспект', max_points: 1, category: 'tasks', submission_format: 'written' },
    { id: 'mkr-20', name: 'МКР · 20 балів', work_type: 'МКР', max_points: 20, category: 'exam', submission_format: 'written' },
  ]
  const secondGroup = data.links.find(link => link.course_id === COURSE && link.group_id === GROUP_2)
  if (previous < 3 && secondGroup) { secondGroup.grading_rules_override = { ...copy(course.grading_rules), categories: course.grading_rules.categories.map(category => category.id === 'seminars' ? { ...category, coefficient: 1.5 } : category) }; secondGroup.grading_version = 1 }
  for (const activity of data.activities) if (!activity.work_type) activity.work_type = activity.item_id ? 'Домашнє завдання' : 'Семінар'
  for (const publication of data.publications) if (publication.kind === 'assignment' && !publication.work_type) publication.work_type = publication.submission_format === 'oral' ? 'Семінар' : 'Домашнє завдання'
  const later = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString()
  const common = { course_id: COURSE, body: 'Локальний приклад для перегляду нового сценарію.', links: [] as string[], attachments: [] as TeachingFile[], created_by: TEACHER, author_name: 'Олена Прикладенко', version: 1 }
  if (previous < 1) {
    if (!data.publications.some(item => item.id === uuid(181))) data.publications.push({ ...common, id: uuid(181), kind: 'assignment', title: 'Заплановано · усне обговорення', status: 'scheduled', publish_at: later(2), published_at: null, submission_format: 'oral', max_points: null, targets: [{ group_id: GROUP_1, placement_mode: 'unplaced', due_at: later(48), closes_at: later(168) }] })
    if (!data.publications.some(item => item.id === uuid(182))) data.publications.push({ ...common, id: uuid(182), kind: 'material', title: 'Заплановано · матеріали наступної лекції', status: 'scheduled', publish_at: later(3), published_at: null, targets: [{ group_id: GROUP_1 }], rights_terms_version: TEACHING_MATERIAL_TERMS_VERSION, rights_accepted_at: now() })
    if (!data.publications.some(item => item.id === uuid(183))) data.publications.push({ ...common, id: uuid(183), kind: 'assignment', title: 'Усна відповідь · без обов’язкового файлу', status: 'published', published_at: now(), submission_format: 'oral', max_points: null, targets: [{ group_id: GROUP_1, placement_mode: 'unplaced', due_at: later(24), closes_at: later(144) }] })
  }
  const activity = data.activities.find(activity => activity.course_id === COURSE && activity.group_id === GROUP_1 && !activity.item_id)
  const student = data.entries.find(entry => entry.course_id === COURSE && entry.group_id === GROUP_1 && entry.user_id === STUDENT && entry.active)
  if (activity && student && !data.gradeRequests?.some(request => request.id === uuid(184))) (data.gradeRequests ||= []).push({ id: uuid(184), course_id: COURSE, course_title: course.title, group_id: GROUP_1, group_name: data.groups.find(group => group.id === GROUP_1)?.group_name || 'Група 1', activity_id: activity.id, activity_title: activity.title, entry_id: student.id, user_id: STUDENT, student_name: student.full_name, message: 'Підкажіть, будь ласка, чи враховано моє доповнення на семінарі?', status: 'open', response: '', created_at: now(), resolved_at: null, version: 1 })
  if (!data.publications.some(item => item.id === uuid(185))) {
    data.publications.push({ ...common, id: uuid(185), kind: 'assignment', title: 'Приймання завершено · приклад доздачі', status: 'published', published_at: later(-168), submission_format: 'written', max_points: null, targets: [{ group_id: GROUP_1, placement_mode: 'unplaced', due_at: later(-144), closes_at: later(-1) }] })
    ;(data.submissionExtensions ||= []).push({ item_id: uuid(185), group_id: GROUP_1, user_id: HEAD, closes_at: later(48), version: 1 })
  }
}

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
  if (cache) { addTeachingFeatureFixtures(cache); publishScheduled(cache); return cache }
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (saved?.schema === 3 && Array.isArray(saved.courses) && Array.isArray(saved.grades) && Array.isArray(saved.submissions)) {
    saved.submissionHistory ||= []; saved.handedIn ||= {}; saved.seminarSchedule ||= []; saved.seminarVersions ||= {}
    cache = saved
  } } catch { /* A blocked local store falls back to memory. */ }
  cache ||= fixture()
  addTeachingFeatureFixtures(cache)
  publishScheduled(cache)
  return cache
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
    return copy({ course: { ...course, permissions: rights }, teachers: data.coTeachers.filter(link => link.course_id === id && (staff || link.status === 'accepted')), groups: links, entries, activities, grades, assignments: publications(course, 'assignment', data), materials: publications(course, 'material', data), audit: grader ? data.audit.filter(audit => activities.some(activity => activity.id === audit.activity_id)) : [], roster_claims: data.claims.filter(claim => entries.some(entry => entry.id === claim.entry_id) && (grader || claim.user_id === userId)), members: grader ? data.members.filter(row => links.some(link => link.group_id === row.group_id && link.status === 'accepted')) : [], seminars: EMPTY_TEACHING_SEMINARS })
  }
  function closing(item: TeachingPublication, groupId: string, studentId: string, data: State) {
    const target = item.targets.find(target => target.group_id === groupId)
    const extension = data.submissionExtensions?.find(row => row.item_id === item.id && row.group_id === groupId && row.user_id === studentId)
    const groupClose = target?.closes_at || null
    const effective = groupClose && extension?.closes_at && Date.parse(extension.closes_at) > Date.parse(groupClose) ? extension.closes_at : groupClose
    return { effective_closes_at: effective, extension_version: extension?.version || 0, extension_closes_at: extension?.closes_at || null, is_closed: Boolean(effective && Date.now() >= Date.parse(effective)) }
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
      return { ...copy(submission), ...closing(item, groupId, submission.user_id, data), ...(!own ? copy(data.handedIn[submission.id] || { body: '', links: [], attachments: [] }) : {}), grade_id: canSeeGrade ? grade?.id || null : null, grade_version: canSeeGrade ? grade?.version || 0 : 0, grade_published_at: canSeeGrade ? grade?.published_at || null : null, published_score: canSeeGrade ? grade?.published_score ?? null : null, published_comment: canSeeGrade ? grade?.published_comment || '' : '' }
    }
    const own = data.submissions.find(submission => submission.item_id === itemId && submission.group_id === groupId && submission.user_id === userId)
    const submissions = staff ? data.submissions.filter(submission => submission.item_id === itemId && submission.group_id === groupId && submission.status !== 'draft').map(submission => visibleSubmission(submission)) : []
    const visibleIds = new Set(staff ? submissions.map(submission => submission.id) : own ? [own.id] : [])
    const deadline = closing(item, groupId, userId, data)
    const canSave = !course.archived_at && member(groupId) && item.status === 'published'
    return copy({ item, group, permissions: rights, my_submission: own ? visibleSubmission(own, true) : null, submissions, history: data.submissionHistory.filter(row => visibleIds.has(row.submission_id)).map(row => rights.includes('grades') || data.submissions.some(s => s.id === row.submission_id && s.user_id === userId) ? row : { ...row, score: null, published_score: null }), students: staff ? data.members.filter(person => person.group_id === groupId).map(person => ({ ...person, ...closing(item, groupId, person.user_id, data) })) : [], ...deadline, submission_extensions: rights.includes('assignments') ? data.submissionExtensions?.filter(row => row.item_id === itemId && row.group_id === groupId) || [] : [], can_save_draft: canSave, can_submit: canSave && !deadline.is_closed, can_review: !course.archived_at && rights.some(right => ['assignments', 'grades'].includes(right)), course_archived_at: course.archived_at, is_assessed: Boolean(activity), activity_id: activity?.id || null, max_points: activity?.max_points || null })
  }
  const repository: TeachingRepository = {
    mode: 'local',
    async teacherCalendar(from, to) {
      if (!isTimetableDate(from) || !isTimetableDate(to) || to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 30) fail('TEACHING_CALENDAR_RANGE_INVALID')
      const data = state(), lessons: import('./teaching').TeachingCalendarLesson[] = []
      const marks = (data as State & { calendarAssignments?: string[] }).calendarAssignments || []
      for (const link of data.links.filter(link => link.status === 'accepted')) {
        const course = data.courses.find(course => course.id === link.course_id && !course.archived_at)
        if (!course || !permissions(course, data).length) continue
        const group = data.groups.find(group => group.id === link.group_id)
        if (!group) continue
        const subjectName = group.subjects?.find(subject => subject.id === link.subject_id)?.name || course.title
        for (let date = from; date <= to; date = addTimetableDays(date, 1)) {
          if (date < course.starts_on || date > course.ends_on) continue
          const timetable = localTeachingTimetable(group.id).filter(slot => normalizedScheduleSubjectName(slot.subject) === normalizedScheduleSubjectName(subjectName) && scheduleOccursOnDate(slot, date))
          for (const slot of timetable) lessons.push({ id: slot.id, course_id: course.id, course_title: course.title, group_id: group.id, group_name: group.group_name, subject_name: slot.subject, lesson_date: date, starts_at: slot.starts_at, ends_at: slot.ends_at, lesson_type: slot.lesson_type, location: slot.location, assigned_to_me: marks.includes(`${userId}:${course.id}:${group.id}:timetable:${slot.id}`), source: 'timetable' })
        }
      }
      return copy({ lessons: lessons.sort((a, b) => a.lesson_date.localeCompare(b.lesson_date) || a.starts_at.localeCompare(b.starts_at)).map(lesson => ({ ...lesson, can_grade: permissions(data.courses.find(course => course.id === lesson.course_id)!, data).includes('grades') })) })
    },
    async setCalendarLesson(courseId, groupId, scheduleId, source, assigned) {
      const data = copy(state()) as State & { calendarAssignments?: string[] }
      const course = data.courses.find(course => course.id === courseId)
      if (!course || course.archived_at || !permissions(course, data).length) fail('TEACHING_FORBIDDEN')
      const link = data.links.find(link => link.course_id === courseId && link.group_id === groupId && link.status === 'accepted')
      if (!link) fail('TEACHING_FORBIDDEN')
      if (source !== 'timetable' && source !== 'seminar') fail('TEACHING_INVALID_INPUT')
      const subjectName = data.groups.find(group => group.id === groupId)?.subjects?.find(subject => subject.id === link.subject_id)?.name || course.title
      const valid = source === 'timetable' && localTeachingTimetable(groupId).some(slot => slot.id === scheduleId && normalizedScheduleSubjectName(slot.subject) === normalizedScheduleSubjectName(subjectName))
      if (assigned && !valid) fail('TEACHING_CALENDAR_LESSON_INVALID')
      const key = `${userId}:${courseId}:${groupId}:${source}:${scheduleId}`
      data.calendarAssignments = (data.calendarAssignments || []).filter(value => value !== key)
      if (assigned) data.calendarAssignments.push(key)
      persist(data)
      return { assigned }
    },
    async scheduledItems(groupId) {
      const data = state()
      return copy({ items: data.publications.filter(item => item.status === 'scheduled' && !item.withdrawn_at && (!groupId || item.targets.some(target => target.group_id === groupId)) && data.courses.some(course => course.id === item.course_id && !course.archived_at && permitted(course, item.kind === 'assignment' ? 'assignments' : 'materials', data) && (item.kind === 'assignment' || item.created_by === userId))).map(item => ({ ...item, course_title: data.courses.find(course => course.id === item.course_id)!.title })) })
    },
    async gradeRequests(courseId) {
      const data = state()
      const allowed = (course: TeachingCourse, groupId: string) => !course.archived_at && data.links.some(link => link.course_id === course.id && link.group_id === groupId && link.status === 'accepted')
      const requests = (data.gradeRequests || []).filter(request => (!courseId || request.course_id === courseId) && data.courses.some(course => course.id === request.course_id && allowed(course, request.group_id) && (permitted(course, 'grades', data) || request.user_id === userId && member(request.group_id)))).map(request => { const canManage = data.courses.some(course => course.id === request.course_id && permitted(course, 'grades', data)); return { ...request, can_manage: canManage, can_resolve: request.status === 'open' && canManage } })
      const available_activities = data.activities.filter(activity => (!courseId || activity.course_id === courseId) && data.entries.some(entry => entry.course_id === activity.course_id && entry.group_id === activity.group_id && entry.user_id === userId && entry.active) && data.courses.some(course => course.id === activity.course_id && allowed(course, activity.group_id)) && (!activity.item_id || data.publications.some(item => item.id === activity.item_id && item.status === 'published' && item.targets.some(target => target.group_id === activity.group_id)))).map(activity => ({ activity_id: activity.id, activity_title: activity.title, activity_date: activity.activity_date, course_id: activity.course_id, course_title: data.courses.find(course => course.id === activity.course_id)!.title, group_id: activity.group_id, group_name: data.groups.find(group => group.id === activity.group_id)?.group_name || 'Навчальна група', max_points: activity.max_points }))
      return copy({ requests, available_activities })
    },
    async requestGrade(activityId, message, requestId) {
      const data = copy(state()), signature = JSON.stringify([activityId, message]), receiptKey = `${userId}:grade-request:${requestId}`
      if (data.receipts[receiptKey]) { if (data.receipts[receiptKey].signature !== signature) fail('TEACHING_CONFLICT'); return copy(data.receipts[receiptKey].result) }
      const allowed = await repository.gradeRequests()
      const activity = allowed.available_activities?.find(activity => activity.activity_id === activityId)
      if (!activity || !requestId || message.trim().length < 2 || message.trim().length > 1000) fail('TEACHING_INVALID_INPUT')
      const existing = data.gradeRequests?.find(request => request.activity_id === activityId && request.user_id === userId && request.status === 'open')
      if (existing) { const result = { id: existing.id, version: existing.version, existing: true }; data.receipts[receiptKey] = { signature, result }; persist(data); return result }
      const entry = data.entries.find(entry => entry.course_id === activity.course_id && entry.group_id === activity.group_id && entry.user_id === userId && entry.active)!
      const request: TeachingGradeRequest = { id: requestId, course_id: activity.course_id, course_title: activity.course_title, group_id: activity.group_id, group_name: activity.group_name, activity_id: activityId, activity_title: activity.activity_title, entry_id: entry.id, user_id: userId, student_name: entry.full_name, message: message.trim(), status: 'open', response: '', created_at: now(), resolved_at: null, version: 1 }
      ;(data.gradeRequests ||= []).push(request)
      const result = { id: request.id, version: request.version, existing: false }; data.receipts[receiptKey] = { signature, result }; persist(data); return result
    },
    async resolveGradeRequest(id, version, response) {
      const data = copy(state()), request = data.gradeRequests?.find(request => request.id === id)
      const course = data.courses.find(course => course.id === request?.course_id)
      if (!request || !course || course.archived_at || !permitted(course, 'grades', data) || !data.links.some(link => link.course_id === course.id && link.group_id === request.group_id && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
      checkVersion(request.version, version)
      if (request.status !== 'open' || response.trim().length < 2 || response.length > 2000) fail('TEACHING_INVALID_INPUT')
      request.status = 'resolved'; request.response = response.trim(); request.resolved_at = now(); request.resolved_by = userId; request.version++; persist(data); return { id, version: request.version }
    },
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
        return publications(course, 'material', data, groupId).map(item => ({ ...item, source: 'teacher' as const, source_item_id: item.id, group_id: groupId, subject_id, subject_name, course_title: course.title, course_archived_at: course.archived_at, read_only: true as const, can_withdraw: item.created_by === userId, can_edit: item.created_by === userId && !course.archived_at && permitted(course, 'materials', data) }))
      })
      const subjects = [...new Map(materials.map(item => [item.subject_id, { id: item.subject_id, group_id: groupId, name: item.subject_name, source: 'teacher' as const, read_only: true }])).values()]
      return copy({ subjects, materials })
    },
    async myMaterials() {
      const data = state()
      return copy({ materials: data.publications.filter(item => item.kind === 'material' && item.created_by === userId).map(item => { const course = data.courses.find(course => course.id === item.course_id); return { ...item, course_title: course?.title || 'Предмет', course_archived_at: course?.archived_at || null, can_withdraw: !item.withdrawn_at, can_edit: !item.withdrawn_at && Boolean(course && !course.archived_at && permitted(course, 'materials', data)) } }) })
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
      return fail('TEACHING_SEMINARS_MANAGED_BY_GROUP')
    },
    async group(id): Promise<TeachingGroupData> {
      const data = state()
      if (!member(id, userId, data)) fail('TEACHING_FORBIDDEN')
      const courses = data.courses.filter(course => data.links.some(link => link.course_id === course.id && link.group_id === id && link.status === 'accepted')).map(course => { const override = data.links.find(link => link.course_id === course.id && link.group_id === id)?.grading_rules_override; return { ...course, grading_rules: override || course.grading_rules, grading_scope: override ? 'group' as const : 'course' as const } })
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
      if (matching.some(item => item.kind === 'material' && item.allow_download === false && item.created_by !== userId)) fail('TEACHING_MATERIAL_DOWNLOAD_FORBIDDEN')
      if (!matching.some(item => !item.withdrawn_at && (item.created_by === userId || (() => { const course = data.courses.find(course => course.id === item.course_id); return course && publications(course, item.kind, data).some(visible => visible.id === item.id) })()))) fail('TEACHING_FORBIDDEN')
      const url = localFiles.get(file.storage_path)
      if (!url) throw new Error('Локальний файл доступний до перезавантаження сторінки. Завантажте його ще раз у прикладі.')
      return url
    },
    async materialFileInfo(publication, file, signal) {
      signal?.throwIfAborted()
      const data = state(), item = data.publications.find(item => item.id === publication.id && item.kind === 'material')
      const course = item && data.courses.find(course => course.id === item.course_id)
      if (!item || !course || item.withdrawn_at || !publications(course, 'material', data).some(visible => visible.id === item.id)) fail('TEACHING_FILE_FORBIDDEN')
      if (publication.version !== item.version) fail('TEACHING_CONFLICT')
      const canonical = item.attachments.find(attachment => attachment.storage_path === file.storage_path)
      if (!canonical || !localFiles.has(canonical.storage_path)) throw new Error('Локальний файл доступний після завантаження в цьому прикладі.')
      if (!isTeachingMaterialPreviewFile(canonical)) fail('TEACHING_MATERIAL_PREVIEW_FORMAT_REQUIRED')
      const preview_kind = canonical.mime_type === 'application/pdf' ? 'pdf' as const : canonical.mime_type.startsWith('image/') ? 'image' as const : 'text' as const
      const restrictedElsewhere = data.publications.some(candidate => candidate.kind === 'material' && candidate.allow_download === false && candidate.created_by !== userId && candidate.attachments.some(attachment => attachment.storage_path === canonical.storage_path))
      return { item_id: item.id, storage_path: canonical.storage_path, name: canonical.name, mime_type: canonical.mime_type, size: canonical.size, allow_download: item.allow_download !== false, download_allowed: !restrictedElsewhere && (item.allow_download !== false || item.created_by === userId), author_name: item.author_name, viewer_name: identity.fullName, version: item.version, preview_kind }
    },
    async materialFileChunk(publication, file, offset, length, signal) {
      const info = await repository.materialFileInfo(publication, file, signal)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || offset >= info.size) fail('TEACHING_INVALID_INPUT')
      const url = localFiles.get(info.storage_path)!
      const bytes = await (await fetch(url, { signal })).arrayBuffer()
      signal?.throwIfAborted()
      return bytes.slice(offset, Math.min(offset + length, bytes.byteLength))
    },
    async uploadSubmission(submissionId, actor, file) {
      const data = state(), submission = data.submissions.find(item => item.id === submissionId && item.user_id === userId)
      if (!submission || actor !== userId || !classroomData(submission.item_id, submission.group_id).can_save_draft || !['draft', 'returned'].includes(submission.status)) fail('TEACHING_FORBIDDEN')
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
      if (['save_seminar_schedule', 'save_seminar', 'delete_seminar'].includes(action)) fail('TEACHING_SEMINARS_MANAGED_BY_GROUP')
      if (['save_group_assignment', 'copy_assignment'].includes(action)) {
        if (payload.expected_user_id !== userId) fail('TEACHING_ACTOR_CHANGED')
        const current = state(), source = current.publications.find(item => item.id === payload.source_item_id)
        const selectedCourse = current.courses.find(course => course.id === (action === 'copy_assignment' ? source?.course_id : payload.course_id))
        const selectedGroup = action === 'copy_assignment' ? String(payload.destination_group_id) : (payload.targets as TeachingPublication['targets'])?.[0]?.group_id
        if (!selectedCourse || !permitted(selectedCourse, 'assignments', current) || !current.links.some(link => link.course_id === selectedCourse.id && link.group_id === selectedGroup && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
        if (selectedCourse.archived_at) fail('TEACHING_ARCHIVED')
      }
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
        } else if (action === 'set_submission_extension') {
          const item = data.publications.find(item => item.id === payload.item_id && item.kind === 'assignment'), groupId = String(payload.group_id), studentId = String(payload.user_id)
          const course = data.courses.find(course => course.id === item?.course_id)
          if (!id || !item || !course || course.archived_at || item.status !== 'published' || !permitted(course, 'assignments', data) || !member(groupId, studentId, data) || !item.targets.some(target => target.group_id === groupId) || !data.links.some(link => link.course_id === course.id && link.group_id === groupId && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
          const groupClose = item.targets.find(target => target.group_id === groupId)?.closes_at
          const closes = payload.closes_at === null ? null : String(payload.closes_at || '')
          if (closes && (!groupClose || !Number.isFinite(Date.parse(closes)) || Date.parse(closes) <= Date.parse(groupClose) || Date.parse(closes) <= Date.now())) fail('TEACHING_INVALID_INPUT')
          let extension = data.submissionExtensions?.find(row => row.item_id === item.id && row.group_id === groupId && row.user_id === studentId)
          checkVersion(extension?.version || 0, payload.version)
          if (!extension) { extension = { item_id: item.id, group_id: groupId, user_id: studentId, closes_at: null, version: 0 }; (data.submissionExtensions ||= []).push(extension) }
          extension.closes_at = closes; extension.version++; result = { id, version: extension.version }; persist(data)
        } else if (['reserve_submission', 'save_submission', 'submit_submission', 'withdraw_submission', 'review_submission'].includes(action)) {
          let submission = data.submissions.find(item => item.id === id)
          if (action === 'reserve_submission' || action === 'save_submission' && !submission) {
            const itemId = String(payload.item_id), groupId = String(payload.group_id), visible = classroomData(itemId, groupId)
            if (!visible.can_save_draft) fail('TEACHING_FORBIDDEN')
            submission = data.submissions.find(s => s.item_id === itemId && s.group_id === groupId && s.user_id === userId)
            if (!submission) { submission = { id, item_id: itemId, course_id: visible.item.course_id, group_id: groupId, user_id: userId, status: 'draft', body: '', links: [], attachments: [], version: 1, attempt: 0, submitted_at: null, feedback: '', reviewed_at: null, reviewed_by: null, reviewer_name: null, student_name: identity.fullName, grade_version: 0, published_score: null, published_comment: '' }; data.submissions.push(submission) }
            if (action === 'reserve_submission') result = { id: submission.id, version: submission.version }
          }
          if (!submission) fail('TEACHING_NOT_FOUND')
          const visible = classroomData(submission.item_id, submission.group_id)
          if (action !== 'reserve_submission') {
            checkVersion(submission.version, payload.version)
            if (action !== 'review_submission' && (submission.user_id !== userId || !(action === 'submit_submission' ? visible.can_submit : visible.can_save_draft))) fail(action === 'submit_submission' && visible.is_closed ? 'CLASSROOM_SUBMISSION_CLOSED' : 'TEACHING_FORBIDDEN')
            if (action === 'save_submission') {
              if (!['draft', 'returned'].includes(submission.status)) fail('CLASSROOM_SUBMISSION_LOCKED')
              const links = validateTeachingLinks(payload.links as string[] || []), attachments = copy(payload.attachments as TeachingFile[] || [])
              if (attachments.length > 10 || attachments.some(file => !file.storage_path.startsWith(`${submission!.id}/${userId}/`) || !localFiles.has(file.storage_path) && !submission!.attachments.some(previous => JSON.stringify(previous) === JSON.stringify(file)))) fail('TEACHING_FILE_FORBIDDEN')
              if (String(payload.body || '').length > 10000) fail('TEACHING_INVALID_INPUT')
              Object.assign(submission, { body: String(payload.body || ''), links, attachments, version: submission.version + 1 })
            } else if (action === 'submit_submission') {
              if (!['draft', 'returned'].includes(submission.status)) fail('CLASSROOM_SUBMISSION_LOCKED')
              if (!['oral', 'defense'].includes(visible.item.submission_format || 'written') && !submission.body.trim() && !submission.links.length && !submission.attachments.length) fail('CLASSROOM_SUBMISSION_EMPTY')
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
        } else fail('TEACHING_INVALID_ACTION')
        const latest = copy(state()); latest.receipts[receiptKey] = { signature, result }; persist(latest)
        return copy(result)
      } catch (failure) { persist(prior); throw failure }
    },
    async mutate(action, payload) {
      if (['save_group_grading', 'save_activity'].includes(action)) {
        if (payload.expected_user_id !== userId) fail('TEACHING_ACTOR_CHANGED')
        const current = state(), selectedCourse = current.courses.find(course => course.id === payload.course_id)
        if (!selectedCourse || !permitted(selectedCourse, action === 'save_group_grading' ? 'manage' : 'grades', current) || !current.links.some(link => link.course_id === selectedCourse.id && link.group_id === payload.group_id && link.status === 'accepted')) fail('TEACHING_FORBIDDEN')
        if (selectedCourse.archived_at) fail('TEACHING_ARCHIVED')
        if (action === 'save_activity' && payload.seminar_id) {
          const previous = current.activities.find(activity => activity.id === payload.id && activity.course_id === selectedCourse.id && activity.group_id === payload.group_id)
          if (String(payload.seminar_id) !== previous?.seminar_id) fail('TEACHING_SEMINARS_MANAGED_BY_GROUP')
        }
      }
      // Work on a copy so validation or a stale version leaves all local data intact.
      const data = copy(state()), timestamp = now(), id = String(payload.id || ''), signature = JSON.stringify(payload), receiptKey = `${userId}:${action}:${action === 'cancel_scheduled_publication' ? String(payload.request_id || id) : id}`
      const createsWithId = id && (Number(payload.version || 0) === 0 || ['copy_course', 'cancel_scheduled_publication', 'save_grades_batch'].includes(action))
      if (createsWithId && data.receipts[receiptKey]) {
        if (action === 'save_grades_batch' || action === 'cancel_scheduled_publication') {
          const currentCourse = data.courses.find(course => course.id === payload.course_id)
          const item = action === 'cancel_scheduled_publication' ? data.publications.find(item => item.id === id && item.course_id === payload.course_id) : null
          const permission = action === 'save_grades_batch' ? 'grades' : item?.kind === 'material' ? 'materials' : 'assignments'
          if (!currentCourse || currentCourse.archived_at || !permitted(currentCourse, permission, data) || action === 'save_grades_batch' && (payload.expected_user_id !== userId || !data.links.some(link => link.course_id === currentCourse.id && link.group_id === payload.group_id && link.status === 'accepted')) || action === 'cancel_scheduled_publication' && (!item || item.kind === 'material' && item.created_by !== userId)) fail('TEACHING_FORBIDDEN')
        }
        if (data.receipts[receiptKey].signature !== signature) fail('TEACHING_CONFLICT')
        return copy(data.receipts[receiptKey].result)
      }
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
        validateTeachingGradingRules((payload.grading_rules as TeachingCourse['grading_rules']) || { categories: [] })
        const created: TeachingCourse = { id: id || crypto.randomUUID(), owner_id: ownerId, university_id: UNIVERSITY, academic_unit_id: FACULTY, title: String(payload.title).trim(), semester: String(payload.semester), starts_on: String(payload.starts_on), ends_on: String(payload.ends_on), grading_rules: copy(payload.grading_rules as TeachingCourse['grading_rules'] || { categories: [] }), archived_at: null, version: 1, created_at: timestamp, updated_at: timestamp, permissions: [] }
        if (data.courses.some(item => item.id === created.id)) fail('TEACHING_CONFLICT')
        data.courses.push(created)
        if (group) data.links.push({ id: crypto.randomUUID(), course_id: created.id, group_id: group.id, group_name: group.group_name, representative_id: group.representative_id!, status: 'pending_teacher', subject_id: String(payload.subject_id || '') || null })
        result = { id: created.id, version: 1 }
      } else if (action === 'save_group_grading') {
        const selectedCourse = requireCourse('manage'), link = data.links.find(link => link.course_id === selectedCourse.id && link.group_id === payload.group_id && link.status === 'accepted')
        if (!link) fail('TEACHING_FORBIDDEN')
        checkVersion(selectedCourse.version, payload.course_version); checkVersion(link.grading_version || 0, payload.version)
        const rules = payload.grading_rules === null ? null : copy(payload.grading_rules as TeachingCourse['grading_rules'])
        validateTeachingGradingRules(rules || selectedCourse.grading_rules)
        if (data.activities.some(activity => activity.course_id === selectedCourse.id && activity.group_id === link.group_id && activity.category && !(rules || selectedCourse.grading_rules).categories.some(rule => rule.id === activity.category)) || data.publications.some(item => item.course_id === selectedCourse.id && item.category && item.targets.some(target => target.group_id === link.group_id) && !(rules || selectedCourse.grading_rules).categories.some(rule => rule.id === item.category))) fail('TEACHING_INVALID_INPUT')
        link.grading_rules_override = rules; link.grading_version = (link.grading_version || 0) + 1; result = { id: link.id, version: link.grading_version }
      } else if (action === 'update_course' || action === 'archive_course' || action === 'copy_course') {
        const source = requireCourse('manage', action !== 'update_course'); checkVersion(source.version, payload.version)
        if (action === 'archive_course') { source.archived_at = payload.archived ? timestamp : null; source.version++; source.updated_at = timestamp; result = { id: source.id, version: source.version } }
        else if (action === 'copy_course') { const next = { ...copy(source), id: id || crypto.randomUUID(), semester: String(payload.semester), starts_on: String(payload.starts_on), ends_on: String(payload.ends_on), archived_at: null, version: 1, created_at: timestamp, updated_at: timestamp }; if (data.courses.some(item => item.id === next.id) || !next.semester.trim() || next.starts_on > next.ends_on) fail('TEACHING_INVALID_INPUT'); data.courses.push(next); for (const item of data.publications.filter(item => item.course_id === source.id && item.kind === 'assignment')) data.publications.push({ ...copy(item), id: crypto.randomUUID(), course_id: next.id, targets: [], status: 'draft', published_at: null, created_by: userId, author_name: identity.fullName, version: 1 }); result = { id: next.id, version: 1 } }
        else { validateTeachingGradingRules(payload.grading_rules as TeachingCourse['grading_rules']); if (data.activities.some(activity => activity.course_id === source.id && activity.category && !data.links.find(link => link.course_id === source.id && link.group_id === activity.group_id)?.grading_rules_override && !(payload.grading_rules as TeachingCourse['grading_rules']).categories.some(rule => rule.id === activity.category))) fail('TEACHING_INVALID_INPUT'); if (!String(payload.title).trim() || String(payload.starts_on) > String(payload.ends_on)) fail('TEACHING_INVALID_INPUT'); source.title = String(payload.title).trim(); source.semester = String(payload.semester); source.starts_on = String(payload.starts_on); source.ends_on = String(payload.ends_on); source.grading_rules = copy(payload.grading_rules as TeachingCourse['grading_rules']); source.version++; source.updated_at = timestamp; result = { id: source.id, version: source.version } }
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
      } else if (action === 'cancel_scheduled_publication') {
        const item = data.publications.find(item => item.id === id)
        if (!item || item.course_id !== payload.course_id) fail('TEACHING_NOT_FOUND')
        course = data.courses.find(course => course.id === item.course_id)
        requireCourse(item.kind === 'assignment' ? 'assignments' : 'materials')
        if (item.kind === 'material' && item.created_by !== userId) fail('TEACHING_MATERIAL_AUTHOR_REQUIRED')
        checkVersion(item.version, payload.version)
        if (item.status !== 'scheduled') fail('TEACHING_CONFLICT')
        item.status = 'draft'; item.publish_at = null; item.version++; result = { id: item.id, version: item.version }
      } else if (action === 'save_assignment' || action === 'save_material') {
        const kind = action === 'save_assignment' ? 'assignment' : 'material', selectedCourse = requireCourse(kind === 'assignment' ? 'assignments' : 'materials')
        const nextStatus = payload.status === 'scheduled' ? 'scheduled' : payload.status === 'published' ? 'published' : payload.status === 'draft' ? 'draft' : null
        if (!nextStatus) fail('TEACHING_INVALID_INPUT')
        const willPublish = nextStatus !== 'draft'
        const publishAt = nextStatus === 'scheduled' ? String(payload.publish_at || '') : null
        if (publishAt && (!Number.isFinite(Date.parse(publishAt)) || Date.parse(publishAt) <= Date.now()) || nextStatus === 'scheduled' && !publishAt) fail('TEACHING_INVALID_INPUT')
        const workType = String(payload.work_type || '')
        if (workType.length > 100) fail('TEACHING_INVALID_INPUT')
        const format = payload.submission_format || 'written'
        if (!['written', 'oral', 'defense'].includes(String(format))) fail('TEACHING_INVALID_INPUT')
        const targets = copy(payload.targets as TeachingPublication['targets'])
        if (targets.some(target => target.due_at && !Number.isFinite(Date.parse(target.due_at)) || target.closes_at && (!Number.isFinite(Date.parse(target.closes_at)) || target.due_at && Date.parse(target.closes_at) < Date.parse(target.due_at)) || publishAt && (target.due_at && Date.parse(target.due_at) < Date.parse(publishAt) || target.closes_at && Date.parse(target.closes_at) < Date.parse(publishAt)))) fail('TEACHING_INVALID_INPUT')
        if (!String(payload.title || '').trim() || !targets.length || targets.some(target => !accepted(target.group_id))) fail('TEACHING_INVALID_INPUT')
        if (kind === 'assignment') for (const target of targets) {
          if (willPublish && !['lesson', 'unplaced'].includes(target.placement_mode || '')) fail('TEACHING_ASSIGNMENT_PLACEMENT_REQUIRED')
          if (target.lesson_date && (!isTimetableDate(target.lesson_date) || target.lesson_date < selectedCourse.starts_on || target.lesson_date > selectedCourse.ends_on)) fail('TEACHING_ASSIGNMENT_LESSON_INVALID')
          if (target.placement_mode === 'unplaced') {
            if (target.schedule_item_id) fail('TEACHING_ASSIGNMENT_LESSON_INVALID')
            if (willPublish && !target.lesson_date && !target.due_at) fail('TEACHING_ASSIGNMENT_LESSON_REQUIRED')
          } else if (target.schedule_item_id || willPublish) {
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
        if (payload.allow_download !== undefined && typeof payload.allow_download !== 'boolean' || kind === 'assignment' && payload.allow_download === false) fail('TEACHING_INVALID_INPUT')
        const allowDownload = kind === 'material' ? typeof payload.allow_download === 'boolean' ? payload.allow_download : publication?.allow_download !== false : true
        if (!allowDownload) {
          if (links.length) fail('TEACHING_MATERIAL_PREVIEW_LINKS_UNSUPPORTED')
          if (attachments.some(file => !isTeachingMaterialPreviewFile(file))) fail('TEACHING_MATERIAL_PREVIEW_FORMAT_REQUIRED')
        }
        if (kind === 'material' && publication?.created_by !== undefined && publication.created_by !== userId) fail('TEACHING_MATERIAL_AUTHOR_REQUIRED')
        if (kind === 'material' && publication?.withdrawn_at) fail('TEACHING_MATERIAL_WITHDRAWN')
        if (kind === 'material' && willPublish && (payload.rights_accepted !== true || payload.rights_terms_version !== TEACHING_MATERIAL_TERMS_VERSION)) fail('TEACHING_MATERIAL_RIGHTS_REQUIRED')
        const link_labels = validateTeachingPublicationLinks(links, getResourceLinkTitles(links,
          Object.prototype.hasOwnProperty.call(payload, 'link_labels') ? payload.link_labels : publication?.link_labels)).link_labels
        const maximum = kind === 'assignment' && payload.max_points !== null && payload.max_points !== undefined && payload.max_points !== '' ? Number(payload.max_points) : null
        const category = maximum === null ? null : String(payload.category || '')
        if (maximum !== null && (!Number.isFinite(maximum) || maximum <= 0 || maximum > 10000 || Math.round(maximum * 100) / 100 !== maximum || category && !targets.every(target => teachingRulesForGroup({ course: selectedCourse, groups: data.links.filter(link => link.course_id === selectedCourse.id) }, target.group_id).categories.some(rule => rule.id === category)))) fail('TEACHING_INVALID_INPUT')
        if (kind === 'assignment' && !permitted(selectedCourse, 'grades', data) && (maximum !== (publication?.max_points ?? null) || category !== (publication?.category ?? null))) fail('TEACHING_FORBIDDEN')
        if (publication) { if (publication.course_id !== selectedCourse.id || publication.kind !== kind) fail('TEACHING_FORBIDDEN'); checkVersion(publication.version, payload.version) }
        else { if (Number(payload.version) !== 0) fail('TEACHING_CONFLICT'); publication = { id: id || crypto.randomUUID(), course_id: selectedCourse.id, kind, title: '', body: '', links: [], attachments: [], targets: [], status: 'draft', published_at: null, created_by: userId, author_name: identity.fullName, version: 0 }; data.publications.push(publication) }
        if (kind === 'assignment' && payload.status !== 'published' && data.submissions.some(submission => submission.item_id === publication!.id)) fail('CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS')
        const linkedActivities = data.activities.filter(activity => activity.item_id === publication!.id)
        if (kind === 'assignment' && maximum === null && linkedActivities.some(activity => data.grades.some(grade => grade.activity_id === activity.id))) fail('TEACHING_ASSESSMENT_HAS_GRADES')
        if (kind === 'assignment' && maximum !== null && linkedActivities.some(activity => data.grades.some(grade => grade.activity_id === activity.id && Math.max(grade.draft_score || 0, grade.published_score || 0) > maximum))) fail('TEACHING_MAX_BELOW_SCORE')
        if (kind === 'assignment' && maximum === null && willPublish) data.activities = data.activities.filter(activity => activity.item_id !== publication!.id)
        Object.assign(publication, { title: String(payload.title).trim(), body: String(payload.body || ''), links, link_labels, attachments, targets, max_points: maximum, category, allow_download: allowDownload, material_date: String(payload.material_date || '') || undefined, status: nextStatus, publish_at: publishAt, schedule_actor_id: nextStatus === 'scheduled' ? userId : null, schedule_error: null, submission_format: format, work_type: kind === 'assignment' ? workType.trim() : '', published_at: nextStatus === 'published' ? publication.published_at || timestamp : null, version: publication.version + 1 })
        if (kind === 'material' && willPublish) Object.assign(publication, { rights_terms_version: TEACHING_MATERIAL_TERMS_VERSION, rights_accepted_at: timestamp })
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
            Object.assign(activity, { title: publication.title, category, work_type: publication.work_type || '', activity_date: date, max_points: maximum, version: activity.version + 1 })
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
        const rules = teachingRulesForGroup({ course: selectedCourse, groups: data.links.filter(link => link.course_id === selectedCourse.id) }, String(payload.group_id))
        if (String(payload.work_type || '').length > 100 || payload.category && !rules.categories.some(rule => rule.id === payload.category)) fail('TEACHING_INVALID_INPUT')
        let activity = data.activities.find(item => item.id === id)
        if (activity) { if (activity.course_id !== selectedCourse.id || activity.group_id !== payload.group_id || activity.item_id) fail('TEACHING_FORBIDDEN'); checkVersion(activity.version, payload.version); if (data.grades.some(grade => grade.activity_id === activity!.id && Math.max(grade.draft_score || 0, grade.published_score || 0) > maximum)) fail('TEACHING_MAX_BELOW_SCORE') }
        else { if (Number(payload.version) !== 0) fail('TEACHING_CONFLICT'); activity = { id: id || crypto.randomUUID(), course_id: selectedCourse.id, group_id: String(payload.group_id), title: '', category: '', activity_date: date, max_points: maximum, version: 0 }; data.activities.push(activity) }
        Object.assign(activity, { title: String(payload.title).trim(), category: String(payload.category || ''), work_type: String(payload.work_type || '').trim(), activity_date: date, max_points: maximum, seminar_id: activity.seminar_id || null, version: activity.version + 1 }); result = { id: activity.id, version: activity.version }
      } else if (action === 'save_grades_batch') {
        const selectedCourse = requireCourse('grades'), activity = data.activities.find(activity => activity.id === payload.activity_id && activity.course_id === selectedCourse.id && activity.group_id === payload.group_id)
        const rows = payload.rows as { entry_id: string; score: number | null; comment: string; reason: string; version: number }[]
        if (!id || payload.expected_user_id !== userId || !activity || !accepted(activity.group_id) || !Array.isArray(rows) || !rows.length || rows.length > 200 || new Set(rows.map(row => row.entry_id)).size !== rows.length) fail('TEACHING_INVALID_INPUT')
        for (const row of rows) {
          const entry = data.entries.find(entry => entry.id === row.entry_id && entry.active && entry.course_id === selectedCourse.id && entry.group_id === activity.group_id)
          if (!entry) fail('TEACHING_FORBIDDEN')
          const score = row.score === null ? null : Number(row.score), comment = String(row.comment || ''), reason = String(row.reason || '')
          if (score !== null && (!Number.isFinite(score) || score < 0 || score > activity.max_points || Math.round(score * 100) / 100 !== score) || comment.length > 2000 || reason.length > 500) fail('TEACHING_INVALID_INPUT')
          let grade = data.grades.find(grade => grade.activity_id === activity.id && grade.entry_id === entry.id)
          checkVersion(grade?.version || 0, row.version)
          if (grade?.published_at && (score !== grade.published_score || comment !== grade.published_comment) && reason.trim().length < 2) fail('TEACHING_REVISION_REASON_REQUIRED')
          if (!grade) { grade = { id: crypto.randomUUID(), activity_id: activity.id, entry_id: entry.id, published_score: null, published_comment: '', published_at: null, version: 0 }; data.grades.push(grade) }
          data.audit.push({ id: crypto.randomUUID(), activity_id: activity.id, entry_id: entry.id, old_score: grade.draft_score ?? null, new_score: score, reason, actor_name: identity.fullName, created_at: timestamp }); grade.draft_score = score; grade.draft_comment = comment; grade.version++
        }
        result = { id: activity.id }
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
