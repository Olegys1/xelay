import { supabase } from './supabase'
import type { TeachingFile } from './teaching'

export type CourseResourceType = 'material' | 'assignment' | 'test'
export type CourseCompletionRule = 'acknowledged' | 'submitted' | 'graded' | 'passed'
export type CourseModuleItem = {
  id: string; resource_type: CourseResourceType; resource_id: string; title: string
  required: boolean; completion: CourseCompletionRule; pass_percent: number | null
  prerequisite_item_ids: string[]; position: number
}
export type CourseLecture = {
  file?: TeachingFile | null; duration_seconds: number; test_item_id: string
  locked?: boolean; watched_seconds?: number; required_seconds?: number; completed?: boolean
}
export type CourseLectureStatistics = {
  module_id: string; group_id: string; lecture_duration_seconds: number
  students: { user_id: string; full_name: string; watched_seconds: number; watched: boolean; test_status: 'not_started' | 'in_progress' | 'submitted'; score: number | null; published_score: number | null; max_points: number | null }[]
  questions: { question_id: string; text: string; attempted: number; incorrect: number }[]
}
export type CourseModule = {
  id: string; course_id: string; title: string; description: string
  status: 'draft' | 'published' | 'archived'; group_ids: string[]; position: number; version: number
  prerequisite_item_ids: string[]; items: CourseModuleItem[]
  release_delay_days?: number
  lecture?: CourseLecture | null
}
export type CourseResource = {
  id: string; resource_type: CourseResourceType; title: string; status: string
  group_ids: string[]; max_points: number | null
  whole_group_ids?: string[]
}
export type CourseStudentProgress = {
  user_id: string; full_name: string; group_id: string; group_name: string
  completed: number; total: number; percent: number
  items: { item_id: string; completed: boolean; locked: boolean; reason: string; score: number | null; max_points: number | null }[]
}
export type CourseModulesData = {
  course_id: string; can_manage: boolean; modules: CourseModule[]; resources: CourseResource[]
  groups: { id: string; name: string }[]; progress: CourseStudentProgress[]
}
export type CourseLearningItem = CourseModuleItem & {
  locked: boolean; reason: string; completed: boolean; available: boolean
  score: number | null; max_points: number | null
}
export type CourseLearningModule = Omit<CourseModule, 'items'> & {
  items: CourseLearningItem[]; locked: boolean; reason: string
  available_at?: string | null
  completed: number; total: number; percent: number
}
export type CourseLearningData = {
  course_id: string; group_id: string; course_title: string; modules: CourseLearningModule[]
  completed: number; total: number; percent: number
}
export type CourseModuleSave = Omit<CourseModule, 'version' | 'items'> & {
  version: number; expected_user_id: string; items: Omit<CourseModuleItem, 'title'>[]
}
export interface TeachingCourseModuleRepository {
  teacher(courseId: string): Promise<CourseModulesData>
  save(payload: CourseModuleSave): Promise<CourseModulesData>
  reorder(courseId: string, moduleIds: string[], versions: Record<string, number>, expectedUserId: string): Promise<CourseModulesData>
  student(courseId: string, groupId: string): Promise<CourseLearningData>
  acknowledge(itemId: string, groupId: string, expectedUserId: string): Promise<CourseLearningData>
  uploadLecture?(courseId: string, expectedUserId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<{ file: TeachingFile; duration_seconds: number }>
  lectureUrl?(file: TeachingFile): Promise<string>
  recordLectureProgress?(moduleId: string, groupId: string, expectedUserId: string, positionSeconds: number, expectedStoragePath: string): Promise<CourseLearningData>
  lectureStatistics?(moduleId: string, groupId: string): Promise<CourseLectureStatistics>
}
export const courseResourceLabels: Record<CourseResourceType, string> = { material: 'Матеріал', assignment: 'Завдання', test: 'Тест' }
export const courseCompletionLabels: Record<CourseCompletionRule, string> = {
  acknowledged: 'Позначено прочитаним', submitted: 'Роботу здано', graded: 'Є опублікований бал', passed: 'Досягнуто потрібний результат',
}
export function lectureTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
type CourseModulePrerequisiteIssue = {
  reason: 'missing' | 'groups' | 'draft' | 'audience'
  module_title?: string; prerequisite_module_title?: string; prerequisite_title?: string; group_name?: string
}
export function courseModulePrerequisiteMessage(issue: CourseModulePrerequisiteIssue): string {
  const prefix = issue.module_title ? `Перевірте умови модуля «${issue.module_title}». ` : ''
  const prerequisite = issue.prerequisite_title ? `Крок «${issue.prerequisite_title}»` : 'Обраний крок'
  const parent = issue.prerequisite_module_title ? `модуль «${issue.prerequisite_module_title}»` : 'попередній модуль'
  const group = issue.group_name ? `групи «${issue.group_name}»` : 'вибраних груп'
  switch (issue.reason) {
    case 'missing': return `${prefix}Одна з умов відкриття більше недоступна. Зніміть її у списку умов та оберіть інший крок.`
    case 'groups': return `${prefix}${prerequisite} з попереднього модуля недоступний для ${group}. Змініть групи або оберіть іншу умову відкриття.`
    case 'draft': return `${prefix}${prerequisite} міститься в чернетці. Спочатку опублікуйте ${parent} або зніміть цю умову відкриття.`
    case 'audience': return `${prefix}${prerequisite} доступний лише частині студентів ${group}. Перевірте, кому призначено цей ресурс, або оберіть іншу умову відкриття.`
  }
}
export function courseModuleError(error: unknown): string {
  const response = error as { message?: string; details?: string }
  const message = String(response?.message || error || '')
  if (message.includes('COURSE_MODULE_TARGET_MISMATCH') && typeof response?.details === 'string') {
    try {
      const issue = JSON.parse(response.details) as CourseModulePrerequisiteIssue | null
      if (issue && ['missing', 'groups', 'draft', 'audience'].includes(issue.reason)) return courseModulePrerequisiteMessage(issue)
    } catch { /* Legacy responses omit structured details. */ }
  }
  const labels: Record<string, string> = {
    COURSE_MODULE_LOCKED: 'Спочатку виконайте умови відкриття цього кроку.',
    COURSE_MODULE_CONFLICT: 'Структуру вже змінили. Оновіть її та перевірте свої правки.',
    COURSE_MODULE_FORBIDDEN: 'Немає доступу до цього курсу або дії.',
    COURSE_MODULE_CYCLE: 'Умови утворюють замкнене коло. Залиште послідовність, яку можна пройти.',
    COURSE_MODULE_DELAY_INVALID: 'Укажіть затримку від 0 до 365 повних днів.',
    COURSE_MODULE_DELAY_REQUIRES_STEPS: 'Для затримки оберіть хоча б один попередній крок.',
    COURSE_MODULE_TARGET_MISMATCH: 'Перевірте групи та умови відкриття. Кожен студент, якому доступний наступний крок, має мати доступ до обраної умови.',
    COURSE_MODULE_RESOURCE_USED: 'Цей матеріал, тест або завдання вже додано до іншого модуля.',
    COURSE_MODULE_INVALID: 'Перевірте назву, групи, ресурси та умови відкриття.',
    TEACHING_ACTOR_CHANGED: 'Акаунт змінився. Відкрийте курс знову зі свого профілю.',
    COURSE_LECTURE_LOCKED: 'Спочатку виконайте умови відкриття цієї лекції.',
    COURSE_LECTURE_INVALID: 'Перевірте відео, пов’язаний тест і його доступність для обраних груп.',
    COURSE_LECTURE_CONFLICT: 'Ця відеолекція вже має прогрес студентів. Створіть окремий модуль для нового відео або тесту.',
    COURSE_MODULE_LECTURE_FILE_UNVERIFIED: 'Перевірку вмісту відео не підтверджено. Завантажте відео знову.',
    COURSE_MODULE_LECTURE_TEST_REQUIRED: 'Додайте обов’язковий тест під лекцією.',
    COURSE_MODULE_LECTURE_FILE_USED: 'Цей файл уже додано до іншої лекції. Завантажте окремий файл.',
  }
  return Object.entries(labels).find(([code]) => message.includes(code))?.[1] || 'Не вдалося оновити модулі. Оновіть дані та спробуйте ще раз.'
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data as T
}
export function createSupabaseTeachingCourseModuleRepository(): TeachingCourseModuleRepository {
  return {
    teacher: courseId => rpc('xelay_teaching_course_modules', { p_course_id: courseId }),
    save: payload => rpc('xelay_teaching_course_module_save', { p_payload: payload }),
    reorder: (courseId, moduleIds, versions, expectedUserId) => rpc('xelay_teaching_course_modules_reorder', { p_course_id: courseId, p_module_ids: moduleIds, p_versions: versions, p_expected_user_id: expectedUserId }),
    student: (courseId, groupId) => rpc('xelay_student_course_modules', { p_course_id: courseId, p_group_id: groupId }),
    acknowledge: (itemId, groupId, expectedUserId) => rpc('xelay_student_module_acknowledge', { p_item_id: itemId, p_group_id: groupId, p_expected_user_id: expectedUserId }),
    async uploadLecture(courseId, expectedUserId, file, onProgress, signal) {
      const extension = file.name.split('.').pop()?.toLowerCase()
      if (extension !== 'mp4' && extension !== 'webm') throw new Error('Оберіть відео у форматі MP4 або WebM.')
      if (!file.size || file.size > 50 * 1024 * 1024) throw new Error('Розмір відео має бути до 50 МБ.')
      if (file.name.trim().length > 240) throw new Error('Скоротіть назву відеофайлу до 240 символів.')
      const duration_seconds = await lectureVideoDuration(file, signal)
      const [{ uploadTeachingStorageFile }, { verifyUploadedContent }] = await Promise.all([import('./teachingFileUpload'), import('./uploadContentVerification')])
      const { data, error } = await supabase.auth.getSession()
      if (error || !data.session || data.session.user.id !== expectedUserId) throw new Error('TEACHING_ACTOR_CHANGED')
      const bucket = 'xelay-teaching-files'
      const storage_path = `${courseId}/${expectedUserId}/${crypto.randomUUID()}.${extension}`
      const mime_type = extension === 'mp4' ? 'video/mp4' : 'video/webm'
      await uploadTeachingStorageFile({ bucket, storagePath: storage_path, file, mimeType: mime_type, accessToken: data.session.access_token, onProgress: percent => onProgress?.(Math.min(98, percent)), signal })
      await verifyUploadedContent({ bucket, path: storage_path, userId: expectedUserId, onProgress, signal })
      return { file: { storage_path, name: file.name, mime_type, size: file.size }, duration_seconds }
    },
    async lectureUrl(file) {
      const { data, error } = await supabase.storage.from('xelay-teaching-files').createSignedUrl(file.storage_path, 3 * 60 * 60)
      if (error || !data?.signedUrl) throw error || new Error('COURSE_LECTURE_LOCKED')
      return data.signedUrl
    },
    recordLectureProgress: (moduleId, groupId, expectedUserId, positionSeconds, expectedStoragePath) => rpc('xelay_student_module_lecture_progress', { p_item_id: moduleId, p_group_id: groupId, p_expected_user_id: expectedUserId, p_position_seconds: positionSeconds, p_expected_storage_path: expectedStoragePath }),
    lectureStatistics: (moduleId, groupId) => rpc('xelay_teaching_module_lecture_statistics', { p_module_id: moduleId, p_group_id: groupId }),
  }
}

export class TeachingLectureDurationError extends Error {
  constructor() {
    super('Не вдалося прочитати тривалість. Спробуйте інше MP4 або WebM відео.')
  }
}

export function lectureVideoDuration(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Завантаження скасовано.', 'AbortError')); return }
    const media = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    function cleanup() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      media.onloadedmetadata = media.onerror = null
      media.removeAttribute('src')
      URL.revokeObjectURL(objectUrl)
    }
    function fail() { cleanup(); reject(new TeachingLectureDurationError()) }
    function abort() { cleanup(); reject(new DOMException('Завантаження скасовано.', 'AbortError')) }
    const timeout = setTimeout(fail, 15000)
    signal?.addEventListener('abort', abort, { once: true })
    media.preload = 'metadata'
    media.onerror = fail
    media.onloadedmetadata = () => {
      const duration = Math.floor(media.duration)
      if (!Number.isFinite(duration) || duration < 1 || duration > 14400) { fail(); return }
      cleanup()
      resolve(duration)
    }
    media.src = objectUrl
  })
}
