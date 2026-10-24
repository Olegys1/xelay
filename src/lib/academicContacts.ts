import { supabase } from './supabase'

export type AcademicTeacherContact = {
  user_id: string
  full_name: string
  position?: string | null
  position_code?: string
  is_postgraduate: boolean
  contact_email: string | null
  contact_phone: string | null
  contact_telegram: string | null
  courses: { id: string; title: string; semester: string }[]
}

export type AcademicConversationContext = {
  conversation_id: string
  active: boolean
  is_academic?: boolean
  can_send: boolean
  contexts: {
    teacher_id: string; student_id: string; student_name: string; teacher_name: string
    course_id: string; course_title: string; group_id: string; group_name: string
    specialty: string; academic_unit_name: string | null; study_year: number | null
    study_level: string | null
  }[]
}

export interface AcademicContactRepository {
  readonly mode: 'supabase' | 'local'
  loadGroup(groupId: string): Promise<{ teachers: AcademicTeacherContact[] }>
  openConversation(teacherId: string, groupId: string, courseId: string, studentId: string): Promise<{ conversation_id: string }>
  conversationContext(conversationId: string): Promise<AcademicConversationContext>
}

export const supabaseAcademicContactRepository: AcademicContactRepository = {
  mode: 'supabase',
  async loadGroup(groupId) {
    const result = await supabase.rpc('xelay_academic_group_teachers', { p_group_id: groupId })
    if (result.error) throw result.error
    return result.data as { teachers: AcademicTeacherContact[] }
  },
  async openConversation(teacherId, groupId, courseId, studentId) {
    const result = await supabase.rpc('xelay_academic_open_conversation', { p_teacher_id: teacherId, p_group_id: groupId, p_course_id: courseId, p_student_id: studentId })
    if (result.error) throw result.error
    return result.data as { conversation_id: string }
  },
  async conversationContext(conversationId) {
    const result = await supabase.rpc('xelay_academic_conversation_context', { p_conversation_id: conversationId })
    if (result.error) throw result.error
    return result.data as AcademicConversationContext
  },
}

export function academicContactError(error: unknown): string {
  const code = error instanceof Error ? error.message : String((error as { message?: string })?.message || '')
  if (/TEACHING_AUTH_REQUIRED|CHAT_AUTH_REQUIRED/.test(code)) return 'Увійдіть у свій акаунт, щоб побачити викладачів групи.'
  if (/ACADEMIC_RELATION_REQUIRED|TEACHING_FORBIDDEN/.test(code)) return 'Зв’язок із цим викладачем уже недоступний. Оновіть список викладачів групи.'
  if (/RATE_LIMIT/.test(code)) return 'Зачекайте хвилину перед відкриттям нової переписки.'
  return 'Не вдалося завантажити зв’язок із викладачами. Спробуйте ще раз.'
}

/** Fixtures never query Supabase or create a real conversation. */
export function createLocalAcademicContactRepository(teachers?: AcademicTeacherContact[]): AcademicContactRepository {
  const rows = teachers ?? [
    { user_id: 'local-teacher-economics-main', full_name: 'Олена Прикладенко', position: 'Доцент', is_postgraduate: false, contact_email: 'teacher@example.org', contact_phone: null, contact_telegram: null, courses: [{ id: 'local-course-economics-main', title: 'Економічна теорія', semester: 'Осінь 2026' }] },
    { user_id: 'local-teacher-economics', full_name: 'Андрій Мельник', position: 'Асистент', is_postgraduate: true, contact_email: null, contact_phone: null, contact_telegram: null, courses: [{ id: 'local-course-economics', title: 'Економічна теорія', semester: 'Осінь 2026' }] },
  ]
  let current: AcademicConversationContext['contexts'][number] | null = null
  return {
    mode: 'local',
    async loadGroup() { return { teachers: structuredClone(rows) } },
    async openConversation(teacherId, groupId, courseId, studentId) {
      const teacher = rows.find(row => row.user_id === teacherId)
      const course = teacher?.courses.find(row => row.id === courseId)
      if (!teacher || !course) throw new Error('ACADEMIC_RELATION_REQUIRED')
      current = { teacher_id: teacherId, student_id: studentId, student_name: 'Марія Прикладенко', teacher_name: teacher.full_name, course_id: courseId, course_title: course.title, group_id: groupId, group_name: 'Економіка · група 1', specialty: 'Економіка та управління бізнесом', academic_unit_name: 'Економічний факультет', study_year: 1, study_level: 'bachelor' }
      return { conversation_id: `local-academic-${teacherId}` }
    },
    async conversationContext(conversationId) { return { conversation_id: conversationId, active: Boolean(current), can_send: Boolean(current), contexts: current ? [structuredClone(current)] : [] } },
  }
}

export function academicContactHref(kind: 'email' | 'phone' | 'telegram', value: string): string | null {
  if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${encodeURIComponent(value)}` : null
  if (kind === 'phone') return /^\+?[\d\s().-]{6,40}$/.test(value.trim()) && value.replace(/\D/g, '').length >= 6 ? `tel:${value.replace(/[^+0-9]/g, '')}` : null
  const username = value.replace(/^@/, '')
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username) ? `https://t.me/${encodeURIComponent(username)}` : null
}
