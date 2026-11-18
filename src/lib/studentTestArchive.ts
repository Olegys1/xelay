import type { TeachingTest } from './teachingTests'

export function studentTestCanArchive(test: TeachingTest): boolean {
  return test.my_attempt?.status === 'submitted' && Boolean(test.my_attempt.submitted_at)
    && !test.can_edit && !test.can_review && !test.qa_own_attempt && !test.questions.length
}
export function studentTestIsArchived(test: TeachingTest): boolean {
  return test.my_archived === true && studentTestCanArchive(test)
}
export function studentTestArchiveError(reason: unknown): string {
  const value = reason as { message?: string; code?: string } | null
  if (value?.code === 'PGRST202' || value?.code === '42883') return 'Архів ще підключається. Усі роботи залишаються у списку; спробуйте після оновлення Xelay.'
  if (value?.message?.includes('ACTOR_CHANGED')) return 'Акаунт змінився. Оновіть сторінку перед архівуванням.'
  if (value?.message?.includes('NOT_COMPLETED')) return 'До архіву можна перенести лише вже здану роботу.'
  if (value?.message?.includes('FORBIDDEN')) return 'Ця робота недоступна у вашому поточному списку. Оновіть тести.'
  return 'Не вдалося оновити архів. Список робіт, відповіді й оцінки збережені. Спробуйте ще раз.'
}
