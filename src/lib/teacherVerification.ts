import { supabase } from './supabase'
import { loadTeacherContacts } from './teacherAcademicProfile'
import { teacherAcademicProfilePayload, type TeacherAcademicProfile } from './teacherAcademicProfile'
import { normalizeTeacherVerificationContact, type TeacherVerificationContact } from './teacherVerificationContact'
export { normalizeTeacherVerificationContact, savedTeacherVerificationContact } from './teacherVerificationContact'
export type { TeacherVerificationContact, TeacherVerificationContactKind } from './teacherVerificationContact'

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
  academic_profile?: Partial<TeacherAcademicProfile>
  /** Private application snapshot; independent of public/group profile contacts. */
  contact_telegram?: string | null
  contact_phone?: string | null
}

export interface TeacherVerificationStatus {
  status: TeacherVerificationState
  verified: boolean
  scope_changed: boolean
  request: TeacherVerificationRequest | null
  requests: TeacherVerificationRequest[]
  has_current_access?: boolean
  academic_profile?: TeacherAcademicProfile | null
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
    has_current_access: typeof data?.has_current_access === 'boolean' ? data.has_current_access : undefined,
    academic_profile: data?.academic_profile || null,
  }
}

export async function requestTeacherVerification(department: string, position: string, note: string, academicProfile?: TeacherAcademicProfile, contact?: TeacherVerificationContact) {
  const normalized = normalizeTeacherVerificationContact(contact)
  if (!normalized) throw new Error(contact?.value?.trim() ? 'TEACHER_REQUEST_CONTACT_INVALID' : 'TEACHER_REQUEST_CONTACT_REQUIRED')
  const privateContact = { p_contact_telegram: normalized.kind === 'telegram' ? normalized.value : '', p_contact_phone: normalized.kind === 'phone' ? normalized.value : '' }
  if (academicProfile) {
    const { data, error } = await supabase.rpc('xelay_teacher_request_with_academic_profile', {
      p_department: department.trim(), p_position: position.trim(), p_note: note.trim(), p_profile: teacherAcademicProfilePayload(academicProfile),
      ...privateContact,
    })
    if (error) throw error
    return data
  }
  const { data, error } = await supabase.rpc('xelay_teacher_request', {
    p_department: department.trim(), p_position: position.trim(), p_note: note.trim(),
    ...privateContact,
  })
  if (error) throw error
  return data
}

export async function loadPublicTeacherVerification(userId: string): Promise<{ verified: boolean; department: string; position: string }> {
  const { data, error } = await supabase.rpc('xelay_verified_teacher_public', { p_user_id: userId })
  if (error) throw error
  const academic = data?.verified === true ? await loadTeacherContacts(userId).catch(() => null) : null
  return { verified: data?.verified === true, department: data?.verified === true ? academic?.verified && academic.department ? academic.department : data.department || '' : '', position: data?.verified === true ? academic?.verified && academic.position ? academic.position : data.position || '' : '' }
}

export async function reviewTeacherVerification(requestId: string, status: 'approved' | 'rejected' | 'revoked', reason: string, approvedUntil?: string | null, expectedUpdatedAt?: string, expectedAdminId?: string) {
  if (status === 'approved') {
    const { data, error } = await supabase.rpc('xelay_teacher_review_with_period', {
      p_request_id: requestId, p_status: status, p_reason: reason.trim(),
      p_approved_valid_until: approvedUntil || null, p_expected_updated_at: expectedUpdatedAt || null,
      p_expected_admin_id: expectedAdminId || null,
    })
    if (error) throw error
    return data
  }
  const { data, error } = await supabase.rpc('xelay_teaching_mutate', {
    p_action: 'review_teacher', p_payload: { request_id: requestId, status, reason: reason.trim() },
  })
  if (error) throw error
  return data
}

export function teacherVerificationError(error: unknown) {
  const message = String((error as { message?: string })?.message || '')
  if (/TEACHER_DEPARTMENT_INVALID/i.test(message)) return 'Оберіть кафедру зі списку свого факультету.'
  if (/TEACHER_REQUEST_CONTACT_REQUIRED/i.test(message)) return 'Додайте Telegram або номер телефону для зв’язку під час перевірки.'
  if (/TEACHER_REQUEST_CONTACT_INVALID/i.test(message)) return 'Перевірте контакт для адміністрації: Telegram-нік або номер телефону.'
  if (/TEACHER_ACADEMIC_CONFLICT/i.test(message)) return 'Дані викладача вже змінилися. Оновіть список перед рішенням.'
  if (/TEACHER_ACADEMIC_INVALID_DATE/i.test(message)) return 'Оберіть дату сьогодні або пізніше чи залиште строк необмеженим.'
  if (/department|TEACHER_REQUEST_INVALID/i.test(message)) return 'Вкажіть кафедру та перевірте дані заявки.'
  if (/profile|scope|university|academic_unit/i.test(message)) return 'Спочатку оберіть університет і факультет у налаштуваннях профілю.'
  if (/approved|pending|exists/i.test(message)) return 'Статус заявки вже змінився. Оновіть сторінку, щоб побачити результат.'
  if (/auth|permission|forbidden|access/i.test(message)) return 'Доступ змінився. Увійдіть знову та повторіть дію.'
  if (/reason/i.test(message)) return 'Додайте причину рішення.'
  if (/COOLDOWN/i.test(message)) return 'Повторну заявку можна подати через добу після попереднього рішення.'
  if (/TEACHING_INVALID_INPUT/i.test(message)) return 'Вкажіть кафедру щонайменше з двох символів і перевірте університет та факультет у профілі.'
  return 'Не вдалося зберегти заявку. Перевірте з’єднання та спробуйте ще раз.'
}
