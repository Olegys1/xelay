import { supabase } from './supabase'

export type TeacherVerificationState = 'none' | 'pending' | 'approved' | 'rejected' | 'revoked'

export interface TeacherVerificationRequest {
  id: string
  user_id: string
  full_name?: string
  university_id: string
  academic_unit_id: string
  department: string
  position: string
  note: string
  status: Exclude<TeacherVerificationState, 'none'>
  review_reason: string | null
  reviewed_by?: string | null
  reviewed_at?: string | null
  created_at: string
  updated_at: string
}

export interface TeacherVerificationStatus {
  status: TeacherVerificationState
  verified: boolean
  scope_changed: boolean
  request: TeacherVerificationRequest | null
  requests: TeacherVerificationRequest[]
}

export async function loadTeacherVerification(): Promise<TeacherVerificationStatus> {
  const { data, error } = await supabase.rpc('xelay_teacher_status')
  if (error) throw error
  return {
    status: data?.status || 'none',
    verified: data?.verified === true,
    scope_changed: data?.scope_changed === true,
    request: data?.request || null,
    requests: Array.isArray(data?.requests) ? data.requests : [],
  }
}

export async function requestTeacherVerification(department: string, position: string, note: string) {
  const { data, error } = await supabase.rpc('xelay_teacher_request', {
    p_department: department.trim(), p_position: position.trim(), p_note: note.trim(),
  })
  if (error) throw error
  return data
}

export async function loadPublicTeacherVerification(userId: string): Promise<{ verified: boolean; department: string; position: string }> {
  const { data, error } = await supabase.rpc('xelay_verified_teacher_public', { p_user_id: userId })
  if (error) throw error
  return { verified: data?.verified === true, department: data?.verified === true ? data.department || '' : '', position: data?.verified === true ? data.position || '' : '' }
}

export async function reviewTeacherVerification(requestId: string, status: 'approved' | 'rejected' | 'revoked', reason: string) {
  const { data, error } = await supabase.rpc('xelay_teaching_mutate', {
    p_action: 'review_teacher', p_payload: { request_id: requestId, status, reason: reason.trim() },
  })
  if (error) throw error
  return data
}

export function teacherVerificationError(error: unknown) {
  const message = String((error as { message?: string })?.message || '')
  if (/department|TEACHER_REQUEST_INVALID/i.test(message)) return 'Вкажіть кафедру та перевірте дані заявки.'
  if (/profile|scope|university|academic_unit/i.test(message)) return 'Спочатку оберіть університет і факультет у налаштуваннях профілю.'
  if (/approved|pending|exists/i.test(message)) return 'Статус заявки вже змінився. Оновіть сторінку, щоб побачити результат.'
  if (/auth|permission|forbidden|access/i.test(message)) return 'Доступ змінився. Увійдіть знову та повторіть дію.'
  if (/reason/i.test(message)) return 'Додайте причину рішення.'
  if (/COOLDOWN/i.test(message)) return 'Повторну заявку можна подати через добу після попереднього рішення.'
  if (/TEACHING_INVALID_INPUT/i.test(message)) return 'Вкажіть кафедру щонайменше з двох символів і перевірте університет та факультет у профілі.'
  return 'Не вдалося зберегти заявку. Перевірте з’єднання та спробуйте ще раз.'
}
