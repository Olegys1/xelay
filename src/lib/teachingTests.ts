import { supabase } from './supabase'
import { teachingError } from './teaching'

export type TeachingTestQuestionKind = 'choice' | 'boolean' | 'sorting' | 'sequence'
export type TeachingTestOption = { id: string; text: string }
export type TeachingTestQuestion = {
  id: string; kind: TeachingTestQuestionKind; text: string; points: number; time_limit_seconds: number | null
  partial_credit: boolean; options: TeachingTestOption[]; buckets: TeachingTestOption[]
  answer?: string | string[] | Record<string, string>
}
export type TeachingTestTarget = { group_id: string; audience_mode: 'all' | 'subgroups'; subgroup_ids: string[] }
export type TeachingTest = {
  id: string; course_id: string; course_title?: string; title: string; description: string; status: 'draft' | 'published' | 'closed'
  opens_at: string; closes_at: string; duration_seconds: number; max_points: number; category: string; journal_date: string; work_type: string
  allow_skip: boolean; allow_return: boolean; question_timer_policy: 'continue' | 'lock_on_leave'; restrict_copy: boolean
  bonus_percent: 0 | 10 | 20; bonus_points: number; targets: TeachingTestTarget[]; questions: TeachingTestQuestion[]
  question_count: number; version: number; has_attempts: boolean; results_finalized_at: string | null; review_revision: number; approved_revision: number | null
  can_edit?: boolean; can_review?: boolean; created_at?: string
  my_attempt?: { id: string; status: 'in_progress' | 'submitted'; submitted_at: string | null; published_score?: number | null; published_absent?: boolean; grade_published_at?: string | null } | null
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
}
export type TeachingTestReviewMode = 'auto' | 'full' | 'zero' | 'custom'
export type TeachingTestGradeSnapshot = { id: string | null; version: number; draft_score?: number | null; draft_comment?: string; draft_absent?: boolean; published_score?: number | null; published_absent?: boolean }
export type TeachingTestQuestionResult = { question_id: string; automatic_points: number; points: number; max_points: number; manual: boolean; mode: TeachingTestReviewMode; reason: string; reviewed_at?: string | null; reviewed_by?: string | null }
export type TeachingTestReviewEvent = { id: string; question_id: string; old_points: number; new_points: number; mode: TeachingTestReviewMode; reason: string; actor_name: string; created_at: string }
export type TeachingTestDetail = { test: TeachingTest; attempt: TeachingTestAttempt | null; attempts: TeachingTestAttempt[]; server_now: string }
export type TeachingTestList = { tests: TeachingTest[]; server_now: string }
export interface TeachingTestRepository {
  list(courseId?: string, groupId?: string): Promise<TeachingTestList>
  detail(testId: string): Promise<TeachingTestDetail>
  mutate(action: 'save_test' | 'start' | 'save_answer' | 'navigate' | 'finish' | 'save_review' | 'finalize_results' | 'review_results', payload: Record<string, unknown>): Promise<TeachingTestDetail>
}
export function teachingTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message || '')
  const known: Record<string, string> = {
    TEST_CONFLICT: 'Дані вже змінилися. Оновіть тест і повторіть дію.',
    TEST_FORBIDDEN: 'Цей тест або дія недоступні вашому акаунту.',
    TEST_INVALID_INPUT: 'Перевірте запитання, відповіді, бали, час і отримувачів.',
    TEST_IMMUTABLE: 'Студенти вже почали проходження. Створіть окремий тест для інших умов.',
    TEST_NOT_OPEN: 'Тест ще не відкрито або час доступу вже завершився.',
    TEST_ANSWER_LOCKED: 'Час цього запитання завершився або відповідь уже зафіксована.',
    TEST_NAVIGATION_BLOCKED: 'Перехід заборонений правилами цього тесту.',
    TEST_RESULTS_NOT_READY: 'Результати можна підготувати після закриття тесту.',
    TEST_REVIEW_REQUIRED: 'Спочатку підготуйте результати та перевірте відповіді.',
    TEST_GRADE_CONFLICT: 'Бали в журналі змінилися після підтвердження перевірки. Оновіть результати, перевірте зміни й підтвердьте їх ще раз.',
    TEST_TARGET_HAS_GRADES: 'У колонці цієї групи вже є оцінки або історія. Залиште групу серед отримувачів, щоб зберегти ці дані.',
    TEST_REVIEW_REASON_REQUIRED: 'Поясніть зміну оцінювання — щонайменше два символи.',
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
    mutate: (action, payload) => rpc('xelay_teaching_test_mutate', { p_action: action, p_payload: payload }),
  }
}
