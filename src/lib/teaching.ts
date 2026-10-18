import { supabase } from './supabase'
import { validateSeminarFile } from './seminarResources'
import { HOMEWORK_FILE_ACCEPT } from './homeworkResources'
import { getResourceLinkTitles, normalizeResourceLinkLabels, type ResourceLinkLabels } from './resourceLinkLabels'
import { kyivToday, seminarStartMilliseconds, type Seminar, type SeminarQuestion, type SeminarReservation, type SeminarTeam, type SeminarSchedule } from './seminars'

export type TeachingPermission = 'materials' | 'assignments' | 'grades' | 'manage'
export type TeachingCategory = { id: string; name: string; max_points: number }
export type TeachingCourse = { id: string; owner_id: string; university_id: string; academic_unit_id: string; title: string; semester: string; starts_on: string; ends_on: string; grading_rules: { categories: TeachingCategory[]; total_max?: number }; archived_at: string | null; created_at: string; updated_at: string; version: number; permissions: TeachingPermission[] }
export type TeachingGroup = Omit<TeachingDirectoryGroup, 'id' | 'subjects'> & { id: string; course_id: string; group_id: string; representative_id: string; subject_id?: string | null; status: 'pending_teacher' | 'pending_group' | 'accepted' | 'rejected' | 'removed' }
export type TeachingDirectoryGroup = { id: string; group_name: string; specialty?: string; representative_id?: string; representative_name?: string | null; study_year?: number | null; study_level?: string | null; cohort_start_year?: number | null; academic_unit_name?: string | null; subjects?: { id: string; name: string }[] }
export type TeachingTeacher = { id: string; course_id: string; user_id: string; full_name: string; permissions: TeachingPermission[]; status: 'pending' | 'accepted' | 'rejected' | 'removed' }
export type TeachingDirectoryTeacher = { id: string; user_id?: string; full_name: string; department: string; position?: string }
export type TeachingEntry = { id: string; course_id: string; group_id: string; user_id: string | null; full_name: string; active: boolean; version: number }
export type TeachingActivity = { id: string; course_id: string; group_id: string; title: string; category: string; activity_date: string; max_points: number; seminar_id?: string | null; item_id?: string | null; version: number }
export type TeachingGrade = { id: string; activity_id: string; entry_id: string; draft_score?: number | null; draft_comment?: string; published_score: number | null; published_comment: string; published_at: string | null; version: number }
export type TeachingFile = { storage_path: string; name: string; mime_type: string; size: number }
export type TeachingTarget = { group_id: string; due_at?: string | null }
export type TeachingPublication = { id: string; course_id: string; title: string; body: string; links: string[]; link_labels?: ResourceLinkLabels; attachments: TeachingFile[]; targets: TeachingTarget[]; status: 'draft' | 'published'; published_at: string | null; created_by: string; author_name: string; version: number; material_date?: string; max_points?: number | null; category?: string }
export type TeachingAudit = { id: string; activity_id: string; entry_id: string; old_score: number | null; new_score: number | null; reason: string; actor_name: string; created_at: string }
export type TeachingRosterClaim = { id: string; entry_id: string; user_id: string; group_id?: string; status: 'pending' | 'accepted' | 'rejected'; full_name: string }
export type TeachingClassroom = Omit<TeachingDirectoryGroup, 'id' | 'subjects'> & { group_id: string; courses: { course_id: string; subject_id?: string | null; status: 'accepted' }[] }
export type TeachingSubmissionStatus = 'draft' | 'submitted' | 'returned' | 'reviewed'
export type TeachingSubmission = { id: string; item_id: string; course_id: string; group_id: string; user_id: string; status: TeachingSubmissionStatus; body: string; links: string[]; attachments: TeachingFile[]; version: number; attempt: number; submitted_at: string | null; feedback: string; reviewed_at: string | null; reviewed_by: string | null; reviewer_name: string | null; student_name: string; grade_id?: string | null; grade_version: number; grade_published_at?: string | null; published_score: number | null; published_comment: string; updated_at?: string; late?: boolean }
export type TeachingSubmissionHistory = { id: string; submission_id: string; attempt: number; status?: TeachingSubmissionStatus; event?: 'submitted' | 'withdrawn' | 'returned' | 'reviewed'; body: string; links: string[]; attachments: TeachingFile[]; feedback: string; created_at: string; actor_name: string; score?: number | null; published_score?: number | null; version?: number; action?: string }
export type TeachingSubmissionData = { item: TeachingPublication; group: TeachingDirectoryGroup; permissions: TeachingPermission[]; my_submission: TeachingSubmission | null; submissions: TeachingSubmission[]; history: TeachingSubmissionHistory[]; students: { user_id: string; full_name: string; username?: string | null }[]; can_submit: boolean; can_review?: boolean; course_archived_at: string | null; is_assessed: boolean; activity_id?: string | null; max_points?: number | null }
export type TeachingGroupContext = { group: TeachingDirectoryGroup; courses: TeachingCourse[] }
export type TeachingClassroomSeminars = { subject_id: string | null; schedule: SeminarSchedule[]; seminars: (Seminar & { version: number; author_name?: string })[]; questions: SeminarQuestion[]; teams: SeminarTeam[]; reservations: SeminarReservation[]; profiles: Record<string, { full_name: string }>; can_edit: boolean }
export type TeachingSnapshot = { course: TeachingCourse; teachers: TeachingTeacher[]; groups: TeachingGroup[]; entries: TeachingEntry[]; activities: TeachingActivity[]; assignments: TeachingPublication[]; materials: TeachingPublication[]; grades: TeachingGrade[]; audit: TeachingAudit[]; roster_claims: TeachingRosterClaim[]; members: { group_id: string; user_id: string; full_name: string; username?: string | null }[]; seminars: { seminars: Seminar[]; questions: SeminarQuestion[]; teams: SeminarTeam[]; reservations: SeminarReservation[]; profiles: Record<string, { full_name: string }> } }
export type TeachingWorkspaceData = { teacher_status: { status: string; verified?: boolean }; courses: TeachingCourse[]; groups: TeachingDirectoryGroup[]; teacher_directory: TeachingDirectoryTeacher[]; invitations?: TeachingTeacher[]; teacher_invites?: TeachingTeacher[]; pending_invites?: TeachingGroup[]; roster_claims?: (TeachingRosterClaim & { course_title?: string })[]; classrooms?: TeachingClassroom[] }
export type TeachingGroupData = { courses: TeachingCourse[]; pending_invites: (TeachingGroup & { title?: string; teacher_name?: string; semester?: string })[]; assignments: TeachingPublication[]; materials: TeachingPublication[]; grades: TeachingGrade[] }
export interface TeachingRepository {
  readonly mode: 'supabase' | 'local'
  workspace(): Promise<TeachingWorkspaceData>
  course(id: string): Promise<TeachingSnapshot>
  group(id: string): Promise<TeachingGroupData>
  groupContext(id: string): Promise<TeachingGroupContext>
  classroom(itemId: string, groupId: string): Promise<TeachingSubmissionData>
  classroomSeminars(courseId: string, groupId: string): Promise<TeachingClassroomSeminars>
  classroomMutate(action: string, payload: Record<string, unknown>): Promise<{ id?: string; version?: number }>
  mutate(action: string, payload: Record<string, unknown>): Promise<{ id?: string; version?: number }>
  upload(courseId: string, userId: string, file: File): Promise<TeachingFile>
  fileUrl(file: TeachingFile): Promise<string>
  uploadSubmission(submissionId: string, userId: string, file: File): Promise<TeachingFile>
  submissionFileUrl(file: TeachingFile): Promise<string>
}
export const TEACHING_FILE_ACCEPT = HOMEWORK_FILE_ACCEPT.replace(',application/zip', '').replace(',.zip', '')
export const TEACHING_PERMISSIONS: { id: TeachingPermission; label: string }[] = [{ id: 'materials', label: 'Матеріали' }, { id: 'assignments', label: 'Завдання' }, { id: 'grades', label: 'Журнал і бали' }]
export const EMPTY_TEACHING_SEMINARS: TeachingSnapshot['seminars'] = { seminars: [], questions: [], teams: [], reservations: [], profiles: {} }
export const TEACHING_BUCKET = 'xelay-teaching-files'
export const TEACHING_SUBMISSION_BUCKET = 'xelay-submission-files'

export function teachingError(error: unknown) {
  const item = error as { message?: string; code?: string }
  const message = item?.message || ''
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(item?.code || '')) return 'Розділ ще підключається. Спробуйте пізніше або повідомте команді Xelay.'
  const errors: Record<string, string> = {
    TEACHING_FORBIDDEN: 'Немає дозволу на цю дію. Перевірте підключення до предмета.',
    TEACHING_INVALID_INPUT: 'Перевірте поля, дати, групи та максимальний бал.',
    TEACHING_CONFLICT: 'Ці дані вже змінили. Оновіть журнал і повторіть редагування.',
    TEACHING_ARCHIVED: 'Предмет в архіві. Спочатку відновіть його, щоб редагувати.',
    TEACHING_NOT_FOUND: 'Запис більше недоступний. Оновіть сторінку.',
    TEACHER_VERIFICATION_REQUIRED: 'Для цієї дії потрібно підтвердити статус викладача.',
    TEACHING_ROSTER_LINK_REQUIRED: 'Прив’язку до акаунта ще не підтверджено.',
    TEACHING_MAX_BELOW_SCORE: 'Максимум роботи не може бути нижчим за вже виставлені бали.',
    TEACHING_REVISION_REASON_REQUIRED: 'Додайте причину зміни опублікованого результату — щонайменше два символи.',
    TEACHING_ACCOUNT_ALREADY_LINKED: 'До цього акаунта вже прив’язано запис із результатами. Зв’яжіться з викладачем, щоб уточнити записи.',
    TEACHING_ALREADY_INVITED: 'Це запрошення вже надіслано. Оновіть список, щоб побачити його стан.',
    TEACHING_FILE_FORBIDDEN: 'Немає доступу до цього файлу. Оновіть публікацію та перевірте підключення групи.',
    TEACHING_FILE_METADATA_IMMUTABLE: 'Збережений файл не можна підмінити. Приберіть його з публікації та завантажте новий.',
    TEACHING_ASSESSMENT_HAS_GRADES: 'За це завдання вже збережено бали. Оцінювання та відповідна колонка журналу мають залишитися.',
    TEACHING_ASSIGNMENT_ACTIVITY_IMMUTABLE: 'Параметри цієї роботи змінюються в редакторі завдання.',
    TEACHING_ACTIVITY_OUTSIDE_SEMESTER: 'У журналі вже є роботи поза цими датами. Збережіть межі семестру, що охоплюють усі роботи.',
    CLASSROOM_SUBMISSION_EMPTY: 'Додайте текст, файл або посилання, перш ніж здавати роботу.',
    CLASSROOM_SUBMISSION_LOCKED: 'Роботу вже здано. Відкличте її або дочекайтеся повернення на доопрацювання.',
    CLASSROOM_REVIEW_REASON_REQUIRED: 'Поясніть зміну вже опублікованого результату.',
    CLASSROOM_SOURCE_CHANGED: 'Вихідне завдання змінилося. Оновіть його перед копіюванням.',
    CLASSROOM_SUBJECT_REQUIRED: 'Спочатку прив’яжіть предмет до семінарів цієї групи.',
    SEMINAR_HAS_RESERVATIONS: 'До цього семінару вже записалися студенти. Збережіть їхні питання, команди та час заняття.',
    SEMINAR_CAPACITY_BELOW_MEMBERS: 'Кількість місць не може бути меншою за число записаних студентів.',
    SEMINAR_ALREADY_EXISTS: 'Для цієї пари вже є семінар. Відкрийте його для редагування.',
    SEMINAR_DATE_MISMATCH: 'Оберіть дату, яка відповідає дню тижня та періоду цієї пари.',
    SEMINAR_LOCKED: 'Заняття вже почалося. Записи студентів зберігаються; оберіть майбутню пару для нового завдання.',
    SEMINAR_INVALID_INPUT: 'Перевірте тему, дату, час, питання та кількість місць.',
    CLASSROOM_EMPTY_SUBMISSION: 'Додайте текст, файл або посилання, перш ніж здавати роботу.',
    CLASSROOM_WORK_LOCKED: 'Роботу вже здано. Відкличте її або дочекайтеся повернення на доопрацювання.',
    CLASSROOM_ASSIGNMENT_NOT_ASSESSED: 'Це завдання поки без оцінювання. Опублікуйте коментар або спочатку додайте максимальний бал до завдання.',
    CLASSROOM_ROSTER_LINK_REQUIRED: 'Спочатку підтвердьте прив’язку студента до журналу. Коментар можна опублікувати без балів.',
    CLASSROOM_ASSIGNMENT_HAS_SUBMISSIONS: 'Для цього завдання вже збережено студентські роботи. Їх потрібно зберегти; завдання можна відредагувати.',
    CLASSROOM_EXPLICIT_FORK_REQUIRED: 'Оберіть конкретну групу для зміни цього спільного завдання.',
    CLASSROOM_SINGLE_GROUP_REQUIRED: 'Завдання має належати одній групі. Для іншої групи створіть окрему копію.',
  }
  const code = Object.keys(errors).find(key => message.includes(key))
  if (code) return errors[code]
  if (error instanceof Error && !item.code && !/fetch|network|timeout/i.test(message)) return message
  return 'Не вдалося підтвердити збереження. Оновіть дані перед повторною спробою та перевірте з’єднання.'
}
async function rpc<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, params)
  if (error) throw error
  return data as T
}
export function validateTeachingLinks(value: string[]) {
  const links = [...new Set(value.map(link => link.trim()).filter(Boolean))]
  if (links.length > 10) throw new Error('До публікації можна додати до 10 посилань.')
  for (const link of links) {
    let parsed: URL
    try { parsed = new URL(link) } catch { throw new Error('Посилання має починатися з https:// або http://.') }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || link.length > 2000) throw new Error('Додайте звичайне посилання https:// або http:// без пароля, до 2000 символів.')
  }
  return links
}
export function validateTeachingPublicationLinks(value: string[], titles: string[]) {
  const links = validateTeachingLinks(value)
  const normalizedLabels = normalizeResourceLinkLabels(value, titles)
  const names = getResourceLinkTitles(links, normalizedLabels)
  // Keep the original URL strings for legacy clients and attach each name to its
  // URL, so reordering/removing links never transfers a name to another resource.
  const link_labels = Object.fromEntries(links.flatMap((url, index) => names[index] ? [[url, names[index]]] : []))
  return { links, link_labels }
}
export function validateTeachingFile(file: File) {
  validateSeminarFile(file)
  if (file.size > 20 * 1024 * 1024 || /\.zip$/i.test(file.name) || file.name.length > 240) throw new Error('Додайте PDF, документ, таблицю, презентацію або зображення до 20 МБ. Назва — до 240 символів.')
}
export const supabaseTeachingRepository: TeachingRepository = {
  mode: 'supabase',
  async workspace() {
    const [workspace, classroom] = await Promise.all([rpc<TeachingWorkspaceData>('xelay_teaching_workspace'), rpc<{ classrooms: TeachingClassroom[] }>('xelay_classroom_workspace').catch(error => {
      if (['PGRST202', '42883'].includes((error as { code?: string }).code || '')) return { classrooms: [] }
      throw error
    })])
    return { ...workspace, classrooms: classroom.classrooms }
  },
  async course(id) { const data = await rpc<TeachingSnapshot>('xelay_teaching_course', { p_course_id: id }); return { ...data, seminars: { ...EMPTY_TEACHING_SEMINARS, ...data.seminars } } },
  group: id => rpc('xelay_teaching_group', { p_group_id: id }),
  groupContext: id => rpc('xelay_teaching_group_context', { p_group_id: id }),
  classroom: (itemId, groupId) => rpc('xelay_classroom_assignment', { p_item_id: itemId, p_group_id: groupId }),
  classroomSeminars: (courseId, groupId) => rpc('xelay_classroom_seminars', { p_course_id: courseId, p_group_id: groupId }),
  classroomMutate: (action, payload) => rpc('xelay_classroom_mutate', { p_action: action, p_payload: payload }),
  mutate: (action, payload) => rpc('xelay_teaching_mutate', { p_action: action, p_payload: payload }),
  async upload(courseId, userId, file) {
    validateTeachingFile(file)
    const session = await supabase.auth.getSession()
    if (session.error || session.data.session?.user.id !== userId) throw new Error('Акаунт змінився. Оновіть сторінку.')
    const extension = file.name.split('.').pop()!.toLowerCase()
    const storage_path = `${courseId}/${userId}/${crypto.randomUUID()}.${extension}`
    const types: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv' }
    const mime_type = types[extension]
    if (!mime_type) throw new Error('Формат файлу не підтримується.')
    const result = await supabase.storage.from(TEACHING_BUCKET).upload(storage_path, file, { contentType: mime_type, upsert: false })
    if (result.error) throw result.error
    return { storage_path, name: file.name, mime_type, size: file.size }
  },
  async fileUrl(file) {
    const { data, error } = await supabase.storage.from(TEACHING_BUCKET).createSignedUrl(file.storage_path, 120, { download: file.name })
    if (error || !data?.signedUrl) throw error || new Error('Файл тимчасово недоступний.')
    return data.signedUrl
  },
  uploadSubmission: (submissionId, userId, file) => uploadPrivateTeachingFile(TEACHING_SUBMISSION_BUCKET, submissionId, userId, file),
  async submissionFileUrl(file) {
    const { data, error } = await supabase.storage.from(TEACHING_SUBMISSION_BUCKET).createSignedUrl(file.storage_path, 120, { download: file.name })
    if (error || !data?.signedUrl) throw error || new Error('Файл тимчасово недоступний.')
    return data.signedUrl
  },
}

async function uploadPrivateTeachingFile(bucket: string, parentId: string, userId: string, file: File): Promise<TeachingFile> {
  validateTeachingFile(file)
  const session = await supabase.auth.getSession()
  if (session.error || session.data.session?.user.id !== userId) throw new Error('Акаунт змінився. Оновіть сторінку.')
  const extension = file.name.split('.').pop()!.toLowerCase()
  const types: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv' }
  const mime_type = types[extension]
  if (!mime_type) throw new Error('Формат файлу не підтримується.')
  const storage_path = `${parentId}/${userId}/${crypto.randomUUID()}.${extension}`
  const result = await supabase.storage.from(bucket).upload(storage_path, file, { contentType: mime_type, upsert: false })
  if (result.error) throw result.error
  return { storage_path, name: file.name, mime_type, size: file.size }
}
export function teachingDate(value: string | null | undefined, withTime = false) {
  if (!value) return 'Без терміну'
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(date) : value
}
export function kyivDeadline(value: string) {
  if (!value) return null
  const [lesson_date, starts_at] = value.split('T')
  return new Date(seminarStartMilliseconds({ lesson_date, starts_at })).toISOString()
}
export function localDeadline(value?: string | null) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
  const part = (key: string) => parts.find(p => p.type === key)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}
export function defaultTeachingSemester() {
  const year = Number(kyivToday().slice(0, 4)), autumn = Number(kyivToday().slice(5, 7)) >= 8
  return { semester: `${autumn ? 'Осінній' : 'Весняний'} семестр ${year}`, starts_on: `${year}-${autumn ? '09-01' : '02-01'}`, ends_on: `${year}-${autumn ? '12-31' : '06-30'}` }
}
export function teachingTotal(snapshot: TeachingSnapshot, entry: TeachingEntry, draft = false) {
  const activities = snapshot.activities.filter(a => a.group_id === entry.group_id)
  const categories = snapshot.course.grading_rules?.categories || []
  const sums = new Map<string, number>()
  for (const activity of activities) {
    const grade = snapshot.grades.find(g => g.entry_id === entry.id && g.activity_id === activity.id)
    const score = draft && grade && 'draft_score' in grade ? grade.draft_score : grade?.published_score
    if (score !== null && score !== undefined) sums.set(activity.category, (sums.get(activity.category) || 0) + Number(score))
  }
  let total = 0
  for (const [category, score] of sums) {
    const rule = categories.find(c => c.id === category)
    total += rule ? Math.min(score, rule.max_points) : score
  }
  return Math.min(total, snapshot.course.grading_rules?.total_max ?? Infinity)
}
export function gradeHasDraft(grade: TeachingGrade) {
  return 'draft_score' in grade && (grade.draft_score !== grade.published_score || (grade.draft_comment || '') !== (grade.published_comment || ''))
}
export function exportTeachingJournal(snapshot: TeachingSnapshot, groupId: string) {
  const activities = snapshot.activities.filter(a => a.group_id === groupId)
  const cells = (value: unknown) => {
    let text = String(value ?? '')
    if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  const rows = [['Студент', ...activities.map(a => `${a.title} (до ${a.max_points})`), 'Опубліковано, разом'], ...snapshot.entries.filter(e => e.group_id === groupId && e.active).map(entry => [entry.full_name, ...activities.map(a => snapshot.grades.find(g => g.entry_id === entry.id && g.activity_id === a.id)?.published_score ?? ''), teachingTotal(snapshot, entry)])]
  const blob = new Blob(['\uFEFF', rows.map(row => row.map(cells).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${snapshot.course.title.replace(/[^\p{L}\p{N}_-]/gu, '_')}_журнал.csv`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
