import { supabase } from './supabase'

export type CourseResourceType = 'material' | 'assignment' | 'test'
export type CourseCompletionRule = 'acknowledged' | 'submitted' | 'graded' | 'passed'
export type CourseModuleItem = {
  id: string; resource_type: CourseResourceType; resource_id: string; title: string
  required: boolean; completion: CourseCompletionRule; pass_percent: number | null
  prerequisite_item_ids: string[]; position: number
}
export type CourseModule = {
  id: string; course_id: string; title: string; description: string
  status: 'draft' | 'published' | 'archived'; group_ids: string[]; position: number; version: number
  prerequisite_item_ids: string[]; items: CourseModuleItem[]
}
export type CourseResource = {
  id: string; resource_type: CourseResourceType; title: string; status: string
  group_ids: string[]; max_points: number | null
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
}
export const courseResourceLabels: Record<CourseResourceType, string> = { material: 'Матеріал', assignment: 'Завдання', test: 'Тест' }
export const courseCompletionLabels: Record<CourseCompletionRule, string> = {
  acknowledged: 'Позначено прочитаним', submitted: 'Роботу здано', graded: 'Є опублікований бал', passed: 'Досягнуто потрібний результат',
}
export function courseModuleError(error: unknown): string {
  const message = String((error as { message?: string })?.message || error || '')
  const labels: Record<string, string> = {
    COURSE_MODULE_LOCKED: 'Спочатку виконайте умови відкриття цього кроку.',
    COURSE_MODULE_CONFLICT: 'Структуру вже змінили. Оновіть її та перевірте свої правки.',
    COURSE_MODULE_FORBIDDEN: 'Немає доступу до цього курсу або дії.',
    COURSE_MODULE_CYCLE: 'Умови утворюють замкнене коло. Залиште послідовність, яку можна пройти.',
    COURSE_MODULE_TARGET_MISMATCH: 'Умова має бути доступною всім отримувачам наступного кроку.',
    COURSE_MODULE_RESOURCE_USED: 'Цей матеріал, тест або завдання вже додано до іншого модуля.',
    COURSE_MODULE_INVALID: 'Перевірте назву, групи, ресурси та умови відкриття.',
    TEACHING_ACTOR_CHANGED: 'Акаунт змінився. Відкрийте курс знову зі свого профілю.',
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
  }
}
