import { supabase } from './supabase'

export async function deleteOwnQuestion(questionId: string): Promise<void> {
  const { error } = await supabase.rpc('xelay_delete_own_question', {
    p_question_id: String(questionId),
  })
  if (error) throw error
}

export async function deleteOwnAnswer(answerId: string): Promise<number | undefined> {
  const { data, error } = await supabase.rpc('xelay_delete_own_answer', {
    p_answer_id: String(answerId),
  })
  if (error) throw error
  return typeof data === 'number' && Number.isSafeInteger(data) && data >= 0 ? data : undefined
}

export function getCommunityDeletionError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'PGRST202' || code === '42883') {
    return 'Видалення ще не налаштовано. Зверніться до адміністратора платформи.'
  }
  if (code === '42501') return 'Видаляти можна лише власні запитання та відповіді. Перевірте, чи ви увійшли у свій акаунт.'
  if (code === 'P0002') return 'Цю публікацію вже видалено. Оновіть сторінку.'
  return 'Не вдалося видалити публікацію. Перевірте з’єднання та спробуйте ще раз.'
}
