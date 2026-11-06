import { supabase } from './supabase'
import { teachingError } from './teaching'
import type { TeachingRubric } from './teachingRubrics'

export type TeachingTestQuestionKind = 'choice' | 'boolean' | 'sorting' | 'sequence' | 'multiple' | 'short_text' | 'numerical' | 'calculated' | 'cloze' | 'essay'
export type TeachingTestOption = { id: string; text: string; images?: TeachingTestQuestionImage[] }
export type TeachingTestQuestionImage = {
  id: string; mime_type: 'image/jpeg'; alt: string
}
export type TeachingTestQuestion = {
  id: string; kind: TeachingTestQuestionKind; text: string; points: number; time_limit_seconds: number | null
  partial_credit: boolean; options: TeachingTestOption[]; buckets: TeachingTestOption[]
  answer?: string | string[] | Record<string, string>
  tolerance?: number; case_sensitive?: boolean
  gaps?: { id: string; answers: string[] }[]
  calculation?: { formula: string; variables: { name: string; min: number; max: number; step: number }[] }
  rubric?: TeachingRubric | null
  source_bank_id?: string; source_bank_version?: number
  images?: TeachingTestQuestionImage[]
}
export type TeachingTestVariant = { id: string; title: string; questions: TeachingTestQuestion[] }
export type TeachingTestOverride = {
  user_id: string; group_id: string; opens_at: string | null; closes_at: string | null; duration_seconds: number | null
  excluded?: boolean; exclusion_reason?: string
}
export type TeachingTestAdmission = { allowed: boolean; reason: string }
export type TeachingTestTarget = { group_id: string; audience_mode: 'all' | 'subgroups'; subgroup_ids: string[] }
export type TeachingTest = {
  id: string; course_id: string; course_title?: string; title: string; description: string; status: 'draft' | 'published' | 'closed'
  opens_at: string; closes_at: string; duration_seconds: number; max_points: number; category: string; journal_date: string; work_type: string
  allow_skip: boolean; allow_return: boolean; question_timer_policy: 'continue' | 'lock_on_leave'; restrict_copy: boolean
  bonus_percent: 0 | 10 | 20; bonus_points: number; targets: TeachingTestTarget[]; questions: TeachingTestQuestion[]
  question_count: number; version: number; has_attempts: boolean; results_finalized_at: string | null; review_revision: number; approved_revision: number | null
  can_edit?: boolean; can_review?: boolean; can_close?: boolean; closed_early_at?: string | null; created_at?: string
  my_admission?: TeachingTestAdmission
  my_attempt?: { id: string; status: 'in_progress' | 'submitted'; submitted_at: string | null; published_score?: number | null; published_absent?: boolean; grade_published_at?: string | null } | null
  shuffle_questions?: boolean; shuffle_answers?: boolean; draw_count?: number | null; overrides?: TeachingTestOverride[]
  results_ready_at?: string
  require_access_code?: boolean; restrict_tab_switch?: boolean; discourage_capture?: boolean; allow_external_links?: boolean
  variants?: TeachingTestVariant[]
}
export type TeachingTestAttempt = {
  id: string; test_id: string; group_id: string; user_id: string; student_name?: string
  status: 'in_progress' | 'submitted'; started_at: string; expires_at: string; submitted_at: string | null
  current_index: number; answers: Record<string, string | string[] | Record<string, string>>
  opened_at: Record<string, string>; locked: string[]; version: number; elapsed_seconds?: number
  auto_score?: number; score?: number; bonus_score?: number; final_score?: number; reviewed_at?: string | null; review_note?: string; grade_version?: number | null
  question_results?: TeachingTestQuestionResult[]; review_history?: TeachingTestReviewEvent[]; rank?: number | null; bonus_winner?: boolean
  grade_snapshot?: TeachingTestGradeSnapshot | null; current_grade?: TeachingTestGradeSnapshot | null
  question_expires_at?: string | null; current_question?: TeachingTestQuestion | null
  published_score?: number | null; published_absent?: boolean; published_comment?: string; grade_published_at?: string | null
  questions?: TeachingTestQuestion[]; question_count?: number; requires_manual_review?: boolean; practice_score?: number
  published_rubrics?: { question_id: string; text: string; rubric: TeachingRubric; levels: Record<string, string>; points: number; maximum: number }[]
  tab_exit_count?: number; completion_reason?: 'tab_switch' | null
  watermark_surname?: string | null; attempt_number?: number
}
export function formatTeachingTestWatermark(attempt: Pick<TeachingTestAttempt, 'id' | 'watermark_surname' | 'attempt_number'>) {
  const surname = attempt.watermark_surname?.trim()
  return [surname || 'Xelay', `Спроба №${attempt.attempt_number ?? 1}`, attempt.id.slice(-8).toUpperCase()].join(' · ')
}
export type TeachingTestReviewMode = 'auto' | 'full' | 'zero' | 'custom'
export type TeachingTestGradeSnapshot = { id: string | null; version: number; draft_score?: number | null; draft_comment?: string; draft_absent?: boolean; published_score?: number | null; published_absent?: boolean }
export type TeachingTestQuestionResult = { question_id: string; automatic_points: number; points: number; max_points: number; manual: boolean; mode: TeachingTestReviewMode; reason: string; reviewed_at?: string | null; reviewed_by?: string | null; rubric_levels?: Record<string, string> }
export type TeachingTestReviewEvent = { id: string; question_id: string; old_points: number; new_points: number; mode: TeachingTestReviewMode; reason: string; actor_name: string; created_at: string }
export type TeachingTestAccessCode = { current: string | null; previous: string | null; rotated_at: string | null }
export type TeachingTestDetail = {
  test: TeachingTest; attempt: TeachingTestAttempt | null; attempts: TeachingTestAttempt[]; server_now: string; practice?: boolean
  access_code?: TeachingTestAccessCode; access_error?: string
}
export type TeachingTestList = { tests: TeachingTest[]; server_now: string }
export interface TeachingTestRepository {
  list(courseId?: string, groupId?: string): Promise<TeachingTestList>
  detail(testId: string): Promise<TeachingTestDetail>
  mutate(action: 'save_test' | 'save_override' | 'close_test' | 'start' | 'save_answer' | 'navigate' | 'finish' | 'save_review' | 'finalize_results' | 'review_results' | 'read_access_code' | 'rotate_access_code' | 'record_tab_exit', payload: Record<string, unknown>): Promise<TeachingTestDetail>
}
export function teachingTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message || '')
  const known: Record<string, string> = {
    COURSE_MODULE_LOCKED: 'Спочатку виконайте умови відкриття тесту у модулях курсу.',
    COURSE_MODULE_LECTURE_TEST_REQUIRED: 'Цей тест прив’язаний до опублікованої лекції. Спочатку від’єднайте тест або зніміть лекцію з публікації.',
    TEST_CONFLICT: 'Дані вже змінилися. Оновіть тест і повторіть дію.',
    TEST_FORBIDDEN: 'Цей тест або дія недоступні вашому акаунту.',
    TEST_NOT_ADMITTED: 'Викладач поки не допустив вас до цього тесту. Зверніться до викладача.',
    TEST_INVALID_INPUT: 'Перевірте запитання, відповіді, бали, час і отримувачів.',
    TEST_IMMUTABLE: 'Студенти вже почали проходження. Створіть окремий тест для інших умов.',
    TEST_NOT_OPEN: 'Тест ще не відкрито або час доступу вже завершився.',
    TEST_CODE_INVALID: 'Цей код не підходить. Попросіть викладача надати чинний код.',
    TEST_CODE_RATE_LIMITED: 'Забагато спроб введення коду. Зачекайте кілька хвилин і спробуйте ще раз.',
    TEST_CODE_UNAVAILABLE: 'Викладач ще не створив код доступу.',
    TEST_ANSWER_LOCKED: 'Час цього запитання завершився або відповідь уже зафіксована.',
    TEST_NAVIGATION_BLOCKED: 'Перехід заборонений правилами цього тесту.',
    TEST_RESULTS_NOT_READY: 'Результати можна підготувати після закриття тесту.',
    TEST_REVIEW_REQUIRED: 'Спочатку підготуйте результати та перевірте відповіді.',
    TEST_GRADE_CONFLICT: 'Бали в журналі змінилися після підтвердження перевірки. Оновіть результати, перевірте зміни й підтвердьте їх ще раз.',
    TEST_TARGET_HAS_GRADES: 'У колонці цієї групи вже є оцінки або історія. Залиште групу серед отримувачів, щоб зберегти ці дані.',
    TEST_REVIEW_REASON_REQUIRED: 'Поясніть зміну оцінювання — щонайменше два символи.',
    TEST_MANUAL_REVIEW_REQUIRED: 'Перевірте відкриті відповіді та оцініть їх за критеріями перед затвердженням результатів.',
    TEST_OVERRIDE_STARTED: 'Студент уже почав роботу. Умови цієї спроби зафіксовані.',
    TEST_CLOSE_CONFIRM_REQUIRED: 'Підтвердьте дострокове закриття тесту.',
    TEST_ACTIVE_ATTEMPTS: 'Студенти ще виконують тест. Дочекайтеся завершення їхніх спроб.',
    TEST_NO_SUBMITTED_ATTEMPTS: 'Поки немає зданих робіт для перевірки.',
  }
  return Object.entries(known).find(([code]) => message.includes(code))?.[1]
    || (message.includes('TEACHING_') ? teachingError(error) : 'Не вдалося підтвердити дію. Оновіть дані та перевірте з’єднання.')
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data as T
}
export function createSupabaseTeachingTestRepository(): TeachingTestRepository {
  return {
    list: (courseId, groupId) => rpc('xelay_teaching_tests', { p_course_id: courseId || null, p_group_id: groupId || null }),
    detail: testId => rpc('xelay_teaching_test', { p_test_id: testId }),
    mutate: async (action, payload) => {
      const detail = await rpc<TeachingTestDetail>('xelay_teaching_test_mutate', { p_action: action, p_payload: payload })
      if (detail.access_error) throw new Error(detail.access_error)
      return detail
    },
  }
}
