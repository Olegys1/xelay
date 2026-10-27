import { supabase } from './supabase'
import { uploadTeachingStorageFile } from './teachingFileUpload'
import { getResourceLinkTitles, normalizeResourceLinkLabels, type ResourceLinkLabels } from './resourceLinkLabels'
import { kyivToday, seminarStartMilliseconds, type Seminar, type SeminarQuestion, type SeminarReservation, type SeminarTeam, type SeminarSchedule } from './seminars'
import type { TimetableLesson } from './studyGroupTimetable'
import { calculateTeachingTotal, teachingRulesForGroup, type TeachingGradingRules } from './teachingGrading'
import { getTeachingMaterialFileInfo, getTeachingMaterialFileChunk, type TeachingMaterialFileInfo } from './teachingMaterialPreview'
import type { TeachingColleague } from './teachingColleagues'
import type { TeachingMaterialLibraryData } from './teachingMaterialLibrary'

export type TeachingPermission = 'materials' | 'assignments' | 'grades' | 'manage'
export type TeachingCategory = { id: string; name: string; max_points: number; coefficient?: number }
export type TeachingCourse = { id: string; owner_id: string; university_id: string; academic_unit_id: string; title: string; semester: string; starts_on: string; ends_on: string; grading_rules: TeachingGradingRules; grading_scope?: 'course' | 'group'; archived_at: string | null; created_at: string; updated_at: string; version: number; permissions: TeachingPermission[] }
export type TeachingGroup = Omit<TeachingDirectoryGroup, 'id' | 'subjects'> & { id: string; course_id: string; group_id: string; representative_id: string; subject_id?: string | null; grading_rules_override?: TeachingGradingRules | null; grading_version?: number; permissions?: TeachingPermission[]; status: 'pending_teacher' | 'pending_group' | 'accepted' | 'rejected' | 'removed' }
export type TeachingDirectoryGroup = { id: string; group_name: string; specialty?: string; representative_id?: string; representative_name?: string | null; study_year?: number | null; study_level?: string | null; cohort_start_year?: number | null; academic_unit_name?: string | null; supplement_capacity?: number; subjects?: { id: string; name: string }[] }
export type TeachingTeacher = { id: string; course_id: string; user_id: string; full_name: string; permissions: TeachingPermission[]; group_scope?: 'selected' | 'all'; group_ids?: string[]; status: 'pending' | 'accepted' | 'rejected' | 'removed' }
export type TeachingDirectoryTeacher = { id: string; user_id?: string; full_name: string; department: string; position?: string }
export type TeachingEntry = { id: string; course_id: string; group_id: string; user_id: string | null; full_name: string; active: boolean; version: number }
export type TeachingActivity = { id: string; course_id: string; group_id: string; title: string; category: string; work_type?: string; activity_date: string; max_points: number; seminar_id?: string | null; item_id?: string | null; version: number }
export type TeachingGrade = { id: string; activity_id: string; entry_id: string; draft_score?: number | null; draft_comment?: string; published_score: number | null; published_comment: string; published_at: string | null; version: number }
export type TeachingOwnGrade = Pick<TeachingGrade, 'id' | 'activity_id' | 'entry_id' | 'published_score' | 'published_comment' | 'published_at'> & {
  course_id: string; group_id: string; activity_title: string; activity_date: string;
  max_points: number; category: string; course_title: string; grading_rules: TeachingCourse['grading_rules'];
}
export type TeachingFile = { storage_path: string; name: string; mime_type: string; size: number }
export type TeachingTarget = { group_id: string; due_at?: string | null; closes_at?: string | null; lesson_date?: string | null; schedule_item_id?: string | null; placement_mode?: 'lesson' | 'unplaced' }
export type TeachingPublication = { id: string; course_id: string; title: string; body: string; links: string[]; link_labels?: ResourceLinkLabels; attachments: TeachingFile[]; targets: TeachingTarget[]; status: 'draft' | 'scheduled' | 'published'; publish_at?: string | null; submission_format?: 'written' | 'oral' | 'defense'; work_type?: string; published_at: string | null; created_by: string; author_name: string; version: number; material_date?: string; max_points?: number | null; category?: string; allow_download?: boolean }
export type TeachingScheduledPublication = TeachingPublication & { course_title: string; kind: 'assignment' | 'material' }
export type TeachingGradeRequest = { id: string; course_id: string; course_title: string; group_id: string; group_name?: string; activity_id: string; activity_title: string; entry_id?: string; user_id: string; student_name: string; message: string; status: 'open' | 'resolved'; response: string; created_at: string; resolved_at: string | null; resolved_by?: string | null; can_manage?: boolean; can_resolve?: boolean; version: number }
export type TeachingGradeRequestActivity = { activity_id: string; activity_title: string; activity_date: string; course_id: string; course_title: string; group_id: string; group_name: string; max_points: number }
export type TeachingSubmissionExtension = { item_id: string; group_id: string; user_id: string; closes_at: string | null; version: number }
export type TeachingCalendarLesson = { id: string; course_id: string; course_title: string; group_id: string; group_name: string; subject_name: string; lesson_date: string; starts_at: string; ends_at: string; lesson_type: string; location: string | null; teacher_name?: string | null; can_grade?: boolean; assigned_to_me: boolean; source: 'timetable' | 'seminar' }
export type TeachingMaterialSubject = { id: string; group_id: string; name: string; source?: 'teacher'; read_only?: boolean }
export type TeachingGroupMaterial = TeachingPublication & { source: 'teacher'; source_item_id: string; group_id: string; subject_id: string; subject_name: string; course_title: string; course_archived_at: string | null; read_only: true; can_withdraw: boolean; can_edit?: boolean }
export type TeachingOwnedMaterial = TeachingPublication & { course_title: string; course_archived_at: string | null; can_withdraw: boolean; can_edit?: boolean; withdrawn_at?: string | null }
export type TeachingLessonAssignment = TeachingPublication & { group_id: string; subject_id: string; subject_name: string; course_title: string; lesson_date: string | null; schedule_item_id: string | null; source: 'teacher'; read_only: true }
export type TeachingAudit = { id: string; activity_id: string; entry_id: string; old_score: number | null; new_score: number | null; reason: string; actor_name: string; created_at: string }
export type TeachingRosterClaim = { id: string; entry_id: string; user_id: string; group_id?: string; status: 'pending' | 'accepted' | 'rejected'; full_name: string }
export type TeachingClassroom = Omit<TeachingDirectoryGroup, 'id' | 'subjects'> & { group_id: string; courses: { course_id: string; subject_id?: string | null; status: 'accepted' }[] }
export type TeachingSubmissionStatus = 'draft' | 'submitted' | 'returned' | 'reviewed'
export type TeachingSubmission = { id: string; item_id: string; course_id: string; group_id: string; user_id: string; status: TeachingSubmissionStatus; body: string; links: string[]; attachments: TeachingFile[]; version: number; attempt: number; submitted_at: string | null; feedback: string; reviewed_at: string | null; reviewed_by: string | null; reviewer_name: string | null; student_name: string; grade_id?: string | null; grade_version: number; grade_published_at?: string | null; published_score: number | null; published_comment: string; updated_at?: string; late?: boolean; effective_closes_at?: string | null; extension_version?: number; extension_closes_at?: string | null }
export type TeachingSubmissionHistory = { id: string; submission_id: string; attempt: number; status?: TeachingSubmissionStatus; event?: 'submitted' | 'withdrawn' | 'returned' | 'reviewed'; body: string; links: string[]; attachments: TeachingFile[]; feedback: string; created_at: string; actor_name: string; score?: number | null; published_score?: number | null; version?: number; action?: string }
export type TeachingSubmissionData = { item: TeachingPublication; group: TeachingDirectoryGroup; permissions: TeachingPermission[]; my_submission: TeachingSubmission | null; submissions: TeachingSubmission[]; history: TeachingSubmissionHistory[]; students: { user_id: string; full_name: string; username?: string | null }[]; can_submit: boolean; can_save_draft?: boolean; can_review?: boolean; effective_closes_at?: string | null; is_closed?: boolean; submission_extensions?: TeachingSubmissionExtension[]; course_archived_at: string | null; is_assessed: boolean; activity_id?: string | null; max_points?: number | null }
export type TeachingGroupContext = { group: TeachingDirectoryGroup; courses: TeachingCourse[] }
export type TeachingClassroomSeminars = { subject_id: string | null; supplement_capacity?: number; schedule: SeminarSchedule[]; seminars: (Seminar & { version: number; author_name?: string })[]; questions: SeminarQuestion[]; teams: SeminarTeam[]; reservations: SeminarReservation[]; profiles: Record<string, { full_name: string }>; can_edit: boolean }
export type TeachingSnapshot = { course: TeachingCourse; teachers: TeachingTeacher[]; groups: TeachingGroup[]; entries: TeachingEntry[]; activities: TeachingActivity[]; assignments: TeachingPublication[]; materials: TeachingPublication[]; grades: TeachingGrade[]; audit: TeachingAudit[]; roster_claims: TeachingRosterClaim[]; members: { group_id: string; user_id: string; full_name: string; username?: string | null }[]; seminars: { seminars: Seminar[]; questions: SeminarQuestion[]; teams: SeminarTeam[]; reservations: SeminarReservation[]; profiles: Record<string, { full_name: string }> } }
export type TeachingWorkspaceData = { teacher_status: { status: string; verified?: boolean; has_current_access?: boolean }; courses: TeachingCourse[]; groups: TeachingDirectoryGroup[]; teacher_directory: TeachingDirectoryTeacher[]; invitations?: TeachingTeacher[]; teacher_invites?: TeachingTeacher[]; pending_invites?: TeachingGroup[]; roster_claims?: (TeachingRosterClaim & { course_title?: string })[]; classrooms?: TeachingClassroom[] }
export type TeachingGroupData = { courses: TeachingCourse[]; pending_invites: (TeachingGroup & { title?: string; teacher_name?: string; semester?: string })[]; assignments: TeachingPublication[]; materials: TeachingPublication[]; grades: TeachingOwnGrade[] }
export interface TeachingRepository {
  readonly mode: 'supabase' | 'local'
  workspace(): Promise<TeachingWorkspaceData>
  course(id: string): Promise<TeachingSnapshot>
  findColleague(courseId: string, nickname: string, signal?: AbortSignal): Promise<TeachingColleague | null>
  group(id: string): Promise<TeachingGroupData>
  groupMaterials(id: string): Promise<{ subjects: TeachingMaterialSubject[]; materials: TeachingGroupMaterial[] }>
  groupAssignments(id: string, date: string): Promise<{ assignments: TeachingLessonAssignment[] }>
  assignmentLessons(courseId: string, groupId: string, date: string): Promise<{ lessons: TimetableLesson[]; subject_name: string }>
  scheduledItems(groupId?: string): Promise<{ items: TeachingScheduledPublication[] }>
  teacherCalendar(from: string, to: string): Promise<{ lessons: TeachingCalendarLesson[] }>
  setCalendarLesson(courseId: string, groupId: string, scheduleId: string, source: 'timetable' | 'seminar', assigned: boolean): Promise<{ assigned: boolean }>
  gradeRequests(courseId?: string): Promise<{ requests: TeachingGradeRequest[]; available_activities?: TeachingGradeRequestActivity[] }>
  requestGrade(activityId: string, message: string, requestId: string): Promise<{ id?: string; version?: number; existing?: boolean }>
  resolveGradeRequest(id: string, version: number, response: string): Promise<{ id?: string; version?: number }>
  myMaterials(): Promise<{ materials: TeachingOwnedMaterial[] }>
  materialLibrary(): Promise<TeachingMaterialLibraryData>
  withdrawMaterial(id: string, version: number): Promise<{ id?: string; version?: number }>
  groupContext(id: string): Promise<TeachingGroupContext>
  classroom(itemId: string, groupId: string): Promise<TeachingSubmissionData>
  classroomSeminars(courseId: string, groupId: string): Promise<TeachingClassroomSeminars>
  classroomMutate(action: string, payload: Record<string, unknown>): Promise<{ id?: string; version?: number }>
  mutate(action: string, payload: Record<string, unknown>): Promise<{ id?: string; version?: number }>
  upload(courseId: string, userId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<TeachingFile>
  fileUrl(file: TeachingFile): Promise<string>
  materialFileInfo(publication: TeachingPublication, file: TeachingFile, signal?: AbortSignal): Promise<TeachingMaterialFileInfo>
  materialFileChunk(publication: TeachingPublication, file: TeachingFile, offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer>
  uploadSubmission(submissionId: string, userId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<TeachingFile>
  submissionFileUrl(file: TeachingFile): Promise<string>
}
const TEACHING_FILE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
}
const TEACHING_CSV_MIME_TYPES = new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'text/x-csv'])
const TEACHING_SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,240}$/
export const TEACHING_FILE_ACCEPT = Object.keys(TEACHING_FILE_MIME_TYPES).map(extension => `.${extension}`).join(',')
export const TEACHING_MAX_FILE_BYTES = 50 * 1024 * 1024
export const TEACHING_PERMISSIONS: { id: TeachingPermission; label: string }[] = [{ id: 'materials', label: 'Матеріали' }, { id: 'assignments', label: 'Завдання' }, { id: 'grades', label: 'Журнал і бали' }]
export const EMPTY_TEACHING_SEMINARS: TeachingSnapshot['seminars'] = { seminars: [], questions: [], teams: [], reservations: [], profiles: {} }
export const TEACHING_BUCKET = 'xelay-teaching-files'
export const TEACHING_SUBMISSION_BUCKET = 'xelay-submission-files'

export function teachingError(error: unknown) {
  const item = error as { message?: string; code?: string }
  const message = item?.message || ''
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(item?.code || '')) return 'Розділ ще підключається. Спробуйте пізніше або повідомте команді Xelay.'
  const errors: Record<string, string> = {
    TEACHING_ACCESS_EXPIRED_OR_UNVERIFIED: 'Термін викладацького доступу завершився або статус ще не підтверджено. Матеріали, роботи та історія збережені; для нових змін зверніться до адміністрації.',
    TEACHING_ACTOR_CHANGED: 'Акаунт змінився. Закрийте редактор і відкрийте його знову зі свого профілю.',
    TEACHING_FORBIDDEN: 'Немає дозволу на цю дію. Перевірте підключення до предмета.',
    TEACHING_INVALID_INPUT: 'Перевірте поля, дати, групи та максимальний бал.',
    TEACHING_CALENDAR_RANGE_INVALID: 'Оберіть період до 31 дня включно.',
    TEACHING_CALENDAR_TOO_LARGE: 'У цьому періоді забагато занять. Оберіть менший проміжок дат.',
    TEACHING_CALENDAR_LESSON_INVALID: 'Ця пара змінилася. Оновіть розклад і повторіть дію.',
    TEACHING_SCHEDULER_UNAVAILABLE: 'Автоматична публікація ще не підключена. Збережіть чернетку або опублікуйте зараз.',
    TEACHING_SCHEDULE_TIME_INVALID: 'Оберіть майбутню дату й час публікації за Києвом.',
    TEACHING_PUBLISHED_CANNOT_SCHEDULE: 'Уже опубліковану роботу можна редагувати. Для нової запланованої публікації створіть окрему чернетку.',
    TEACHING_NOT_SCHEDULED: 'Ця публікація вже змінила стан. Оновіть список запланованих.',
    TEACHING_EXTENSION_INVALID: 'Індивідуальний термін має бути в майбутньому й продовжувати загальний строк прийому робіт.',
    CLASSROOM_SUBMISSIONS_CLOSED: 'Прийом робіт закрито. Зверніться до викладача щодо індивідуального продовження.',
    TEACHING_GRADE_REQUEST_INVALID: 'Перевірте текст запиту або відповіді та обрану роботу.',
    TEACHING_GRADE_REQUEST_RATE_LIMIT: 'Ви вже надсилали запит. Дочекайтеся відповіді або спробуйте пізніше.',
    TEACHING_GRADE_REQUEST_ENTRY_REQUIRED: 'Спочатку підтвердьте свій запис у журналі цієї групи.',
    TEACHING_CONFLICT: 'Ці дані вже змінили. Оновіть список і відкрийте редагування знову. Ваші незбережені зміни залишаються у формі.',
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
    TEACHING_MATERIAL_AUTHOR_REQUIRED: 'Для цієї дії потрібен дозвіл автора матеріалу та доступ до всіх груп, яких вона стосується.',
    TEACHING_MATERIAL_RIGHTS_REQUIRED: 'Підтвердьте право на розміщення матеріалу та умови публікації.',
    TEACHING_MATERIAL_AUTHOR_ACCEPTANCE_REQUIRED: 'Спочатку автор має підтвердити права й опублікувати цей матеріал. Після цього колега з дозволом на оновлення зможе керувати його публікацією.',
    TEACHING_MATERIAL_WITHDRAWN: 'Викладач відкликав цей матеріал. Його більше не видно в групах.',
    TEACHING_MATERIAL_PREVIEW_FORMAT_REQUIRED: 'Для перегляду лише у Xelay використовуйте PDF, JPG, PNG, WebP, TXT або CSV. Документ, таблицю чи презентацію збережіть як PDF.',
    TEACHING_MATERIAL_PREVIEW_LINKS_UNSUPPORTED: 'Для перегляду лише у Xelay приберіть зовнішні посилання та додайте файли. Доступом на інших сайтах платформа не керує.',
    TEACHING_MATERIAL_PREVIEW_OWN_FILES_REQUIRED: 'Щоб обмежити скачування, завантажте файл від свого імені заново. Раніше скопійований файл може використовуватися в інших матеріалах.',
    TEACHING_MATERIAL_DOWNLOAD_FORBIDDEN: 'Викладач дозволив перегляд цього матеріалу лише у Xelay. Скористайтеся кнопкою «Переглянути».',
    TEACHING_ASSIGNMENT_SUBJECT_REQUIRED: 'Спочатку підключіть предмет до відповідного предмета групи.',
    TEACHING_ASSIGNMENT_PLACEMENT_REQUIRED: 'Оберіть, де показати завдання: під парою або без прив’язки до пари.',
    TEACHING_ASSIGNMENT_LESSON_REQUIRED: 'Оберіть дату та пару або «Без прив’язки до пари» з датою чи терміном здачі.',
    TEACHING_ASSIGNMENT_LESSON_INVALID: 'Пара змінилася або не відповідає предмету чи даті. Оновіть розклад і виберіть пару знову.',
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
    SEMINAR_SUPPLEMENT_CAPACITY_INVALID: 'Вкажіть ціле число місць для доповнювачів від 0 до 30.',
    SEMINAR_SUPPLEMENT_CAPACITY_BELOW_MEMBERS: 'Місць для доповнювачів не може бути менше, ніж уже записаних студентів. Їхні записи збережено.',
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
  const dot = file.name.lastIndexOf('.')
  const extension = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase()
  if (!TEACHING_SAFE_FILE_NAME.test(file.name) || !Object.prototype.hasOwnProperty.call(TEACHING_FILE_MIME_TYPES, extension)) {
    throw new Error('Оберіть PDF, Word, Excel, PowerPoint, TXT, CSV, JPG, PNG або WebP. Назва має містити не більше 240 символів.')
  }
  const mime = file.type.trim().toLowerCase()
  if (mime && mime !== 'application/octet-stream' && mime !== TEACHING_FILE_MIME_TYPES[extension]
    && !(extension === 'csv' && TEACHING_CSV_MIME_TYPES.has(mime))) {
    throw new Error(`Тип файлу «${file.name}» не відповідає його розширенню. Оберіть інший файл.`)
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`Файл «${file.name}» порожній. Оберіть інший файл.`)
  if (file.size > TEACHING_MAX_FILE_BYTES) {
    throw new Error(`Файл «${file.name}» завеликий. Максимальний розмір — ${TEACHING_MAX_FILE_BYTES / (1024 * 1024)} МБ. Для більших файлів завантажте їх у Google Drive та додайте посилання з доступом для викладача або вибраної групи.`)
  }
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
  async course(id) { const data = await rpc<TeachingSnapshot>('xelay_teaching_course', { p_course_id: id }); return { ...data, seminars: EMPTY_TEACHING_SEMINARS } },
  findColleague: async (courseId, nickname, signal) => (await import('./teachingColleagues')).lookupTeachingColleague(courseId, nickname, signal),
  group: id => rpc('xelay_teaching_group', { p_group_id: id }),
  groupMaterials: id => rpc('xelay_group_teacher_materials', { p_group_id: id }),
  groupAssignments: (id, date) => rpc('xelay_group_teacher_assignments', { p_group_id: id, p_lesson_date: date }),
  assignmentLessons: (courseId, groupId, date) => rpc('xelay_teaching_assignment_lessons', { p_course_id: courseId, p_group_id: groupId, p_lesson_date: date }),
  scheduledItems: groupId => rpc('xelay_teaching_scheduled_items', { p_group_id: groupId || null }),
  teacherCalendar: (from, to) => rpc('xelay_teaching_calendar', { p_from: from, p_to: to }),
  setCalendarLesson: (courseId, groupId, scheduleId, source, assigned) => rpc('xelay_teaching_calendar_assign', { p_course_id: courseId, p_group_id: groupId, p_schedule_id: scheduleId, p_source: source, p_assigned: assigned }),
  gradeRequests: courseId => rpc('xelay_teaching_grade_requests', { p_course_id: courseId || null }),
  requestGrade: (activityId, message, requestId) => rpc('xelay_teaching_request_grade', { p_activity_id: activityId, p_message: message, p_request_id: requestId }),
  resolveGradeRequest: (id, version, response) => rpc('xelay_teaching_resolve_grade_request', { p_request_id: id, p_version: version, p_response: response }),
  myMaterials: () => rpc('xelay_my_teaching_materials'),
  // Prepared for the material-library rollout; not applied to the live database yet.
  materialLibrary: () => rpc('xelay_teaching_material_library'),
  withdrawMaterial: (id, version) => rpc('xelay_teaching_mutate', { p_action: 'withdraw_material', p_payload: { id, version } }),
  groupContext: id => rpc('xelay_teaching_group_context', { p_group_id: id }),
  classroom: (itemId, groupId) => rpc('xelay_classroom_assignment', { p_item_id: itemId, p_group_id: groupId }),
  async classroomSeminars() { throw new Error('Розподіл питань і команд веде навчальна група.') },
  async classroomMutate(action, payload) {
    if (['save_seminar_schedule', 'save_seminar', 'delete_seminar'].includes(action)) throw new Error('Розподіл питань і команд веде навчальна група.')
    if (action === 'save_multi_group_assignment') return rpc('xelay_teaching_save_multi_assignment', { p_payload: payload })
    return rpc(['save_group_assignment', 'copy_assignment'].includes(action) ? 'xelay_teaching_classified_assignment' : 'xelay_classroom_mutate', { p_action: action, p_payload: payload })
  },
  mutate: (action, payload) => action === 'save_group_grading'
    ? rpc('xelay_teaching_save_group_grading', { p_course_id: payload.course_id, p_group_id: payload.group_id, p_version: payload.version, p_course_version: payload.course_version, p_rules: payload.grading_rules, p_expected_user_id: payload.expected_user_id })
    : action === 'save_activity'
    ? rpc('xelay_teaching_classified_activity', { p_payload: payload })
    : action === 'save_grades_batch'
    ? rpc('xelay_save_teaching_grades_batch', { p_request_id: payload.id, p_course_id: payload.course_id, p_group_id: payload.group_id, p_activity_id: payload.activity_id, p_expected_user_id: payload.expected_user_id, p_rows: payload.rows })
    : rpc('xelay_teaching_mutate', { p_action: action, p_payload: payload }),
  upload: (courseId, userId, file, onProgress, signal) => uploadPrivateTeachingFile(TEACHING_BUCKET, courseId, userId, file, onProgress, signal),
  async fileUrl(file) {
    const { data, error } = await supabase.storage.from(TEACHING_BUCKET).createSignedUrl(file.storage_path, 120, { download: file.name })
    if (error || !data?.signedUrl) throw error || new Error('Файл тимчасово недоступний.')
    return data.signedUrl
  },
  materialFileInfo: getTeachingMaterialFileInfo,
  materialFileChunk: getTeachingMaterialFileChunk,
  uploadSubmission: (submissionId, userId, file, onProgress, signal) => uploadPrivateTeachingFile(TEACHING_SUBMISSION_BUCKET, submissionId, userId, file, onProgress, signal),
  async submissionFileUrl(file) {
    const { data, error } = await supabase.storage.from(TEACHING_SUBMISSION_BUCKET).createSignedUrl(file.storage_path, 120, { download: file.name })
    if (error || !data?.signedUrl) throw error || new Error('Файл тимчасово недоступний.')
    return data.signedUrl
  },
}

async function uploadPrivateTeachingFile(bucket: string, parentId: string, userId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<TeachingFile> {
  validateTeachingFile(file)
  const session = await supabase.auth.getSession()
  const currentSession = session.data.session
  if (session.error || !currentSession || currentSession.user.id !== userId) throw new Error('Акаунт змінився. Оновіть сторінку.')
  const extension = file.name.split('.').pop()!.toLowerCase()
  const mime_type = TEACHING_FILE_MIME_TYPES[extension]
  if (!mime_type) throw new Error('Формат файлу не підтримується.')
  const storage_path = `${parentId}/${userId}/${crypto.randomUUID()}.${extension}`
  await uploadTeachingStorageFile({ bucket, storagePath: storage_path, file, mimeType: mime_type, accessToken: currentSession.access_token, onProgress, signal })
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
  const values = activities.map(activity => {
    const grade = snapshot.grades.find(g => g.entry_id === entry.id && g.activity_id === activity.id)
    const score = draft && grade && 'draft_score' in grade ? grade.draft_score : grade?.published_score
    return { category: activity.category, score }
  })
  return calculateTeachingTotal(teachingRulesForGroup(snapshot, entry.group_id), values)
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
