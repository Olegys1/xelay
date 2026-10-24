import { supabase } from './supabase'

export const TEACHER_POSITION_OPTIONS = [
  { value: '', label: 'Не вказано' },
  { value: 'assistant', label: 'Асистент' },
  { value: 'lecturer', label: 'Викладач' },
  { value: 'senior_lecturer', label: 'Старший викладач' },
  { value: 'associate_professor', label: 'Доцент' },
  { value: 'professor', label: 'Професор' },
  { value: 'other', label: 'Інша посада' },
] as const
export type TeacherPositionCode = typeof TEACHER_POSITION_OPTIONS[number]['value']
export type TeacherContactKind = 'email' | 'phone' | 'telegram'
export interface TeacherAcademicProfile {
  user_id: string
  position_code: TeacherPositionCode
  position_other: string
  is_postgraduate: boolean
  requested_valid_until: string | null
  approved_valid_until: string | null
  access_period_pending: boolean
  access_expired: boolean
  contact_email: string
  contact_phone: string
  contact_telegram: string
  email_visible_to_groups: boolean
  email_visible_public: boolean
  phone_visible_to_groups: boolean
  phone_visible_public: boolean
  telegram_visible_to_groups: boolean
  telegram_visible_public: boolean
  updated_at?: string
}
export interface TeacherContactProjection {
  user_id: string
  verified: boolean
  position_code: TeacherPositionCode
  position: string
  is_postgraduate: boolean
  contact_email: string | null
  contact_phone: string | null
  contact_telegram: string | null
}
export interface TeacherAcademicRepository {
  load(): Promise<TeacherAcademicProfile>
  save(profile: TeacherAcademicProfile): Promise<TeacherAcademicProfile>
}

export function emptyTeacherAcademicProfile(userId = ''): TeacherAcademicProfile {
  return {
    user_id: userId, position_code: '', position_other: '', is_postgraduate: false,
    requested_valid_until: null, approved_valid_until: null, access_period_pending: false, access_expired: false,
    contact_email: '', contact_phone: '', contact_telegram: '',
    email_visible_to_groups: false, email_visible_public: false,
    phone_visible_to_groups: false, phone_visible_public: false,
    telegram_visible_to_groups: false, telegram_visible_public: false,
  }
}
export function teacherPositionLabel(profile: Pick<TeacherAcademicProfile, 'position_code' | 'position_other'>): string {
  return !profile.position_code ? '' : profile.position_code === 'other' ? profile.position_other.trim()
    : TEACHER_POSITION_OPTIONS.find((option) => option.value === profile.position_code)?.label || ''
}
export function teacherAcademicProfileError(error: unknown): string {
  const message = String((error as { message?: string })?.message || '')
  if (/CONFLICT/i.test(message)) return 'Дані вже змінилися. Оновіть профіль перед збереженням.'
  if (/ACCESS_EXPIRED/i.test(message)) return 'Погоджений строк викладання завершився. Запросіть продовження у профілі.'
  if (/INVALID|date|email|phone|telegram/i.test(message)) return 'Перевірте посаду, дату та контактні дані.'
  if (/AUTH|FORBIDDEN|permission/i.test(message)) return 'Увійдіть у свій акаунт і повторіть дію.'
  return 'Не вдалося зберегти дані викладача. Спробуйте ще раз.'
}
export function validateTeacherAcademicProfile(profile: TeacherAcademicProfile): string | null {
  if (!TEACHER_POSITION_OPTIONS.some((option) => option.value === profile.position_code)
    || profile.position_other.trim().length > 120
    || profile.position_code === 'other' && !profile.position_other.trim()) return 'Уточніть посаду викладача.'
  if (profile.requested_valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(profile.requested_valid_until)) return 'Перевірте дату завершення викладання.'
  if (profile.contact_email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contact_email.trim()) || profile.contact_email.length > 254)) return 'Перевірте контактну електронну пошту.'
  if (profile.contact_phone && (!/^\+?[\d\s().-]{6,40}$/.test(profile.contact_phone.trim()) || profile.contact_phone.replace(/\D/g, '').length < 6)) return 'Перевірте номер телефону.'
  if (profile.contact_telegram && !/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(profile.contact_telegram.trim())) return 'Вкажіть Telegram-нік, наприклад @username.'
  return null
}

export function teacherAcademicProfilePayload(profile: TeacherAcademicProfile) {
  return {
    expected_user_id: profile.user_id,
    position_code: profile.position_code, position_other: profile.position_other.trim(),
    is_postgraduate: profile.is_postgraduate, requested_valid_until: profile.requested_valid_until,
    contact_email: profile.contact_email.trim(), contact_phone: profile.contact_phone.trim(),
    contact_telegram: profile.contact_telegram.trim().replace(/^@/, ''),
    email_visible_to_groups: profile.email_visible_to_groups, email_visible_public: profile.email_visible_public,
    phone_visible_to_groups: profile.phone_visible_to_groups, phone_visible_public: profile.phone_visible_public,
    telegram_visible_to_groups: profile.telegram_visible_to_groups, telegram_visible_public: profile.telegram_visible_public,
    ...(profile.updated_at ? { expected_updated_at: profile.updated_at } : {}),
  }
}
export const supabaseTeacherAcademicRepository: TeacherAcademicRepository = {
  async load() {
    const { data, error } = await supabase.rpc('xelay_teacher_academic_profile')
    if (error) throw error
    return { ...emptyTeacherAcademicProfile(), ...data }
  },
  async save(profile) {
    const validation = validateTeacherAcademicProfile(profile)
    if (validation) throw new Error(validation)
    const { data, error } = await supabase.rpc('xelay_teacher_academic_profile_save', { p_profile: teacherAcademicProfilePayload(profile) })
    if (error) throw error
    return { ...emptyTeacherAcademicProfile(), ...data }
  },
}
export async function loadTeacherContacts(teacherId: string, groupId?: string): Promise<TeacherContactProjection> {
  const { data, error } = await supabase.rpc('xelay_teacher_contacts', { p_teacher_id: teacherId, p_group_id: groupId || null })
  if (error) throw error
  return data as TeacherContactProjection
}
export async function reviewTeacherAcademicPeriod(userId: string, approvedUntil: string | null, expectedUpdatedAt?: string, expectedAdminId?: string): Promise<TeacherAcademicProfile> {
  const { data, error } = await supabase.rpc('xelay_teacher_academic_period_review', {
    p_teacher_id: userId, p_approved_valid_until: approvedUntil,
    p_expected_updated_at: expectedUpdatedAt || null,
    p_expected_admin_id: expectedAdminId || null,
  })
  if (error) throw error
  return { ...emptyTeacherAcademicProfile(userId), ...data }
}

export function createLocalTeacherAcademicRepository(userId: string, initial: Partial<TeacherAcademicProfile> = {}, onChange?: (value: TeacherAcademicProfile) => void) {
  let current = { ...emptyTeacherAcademicProfile(userId), ...initial, user_id: userId }
  const snapshot = () => ({ ...current })
  return {
    async load() { return snapshot() },
    async save(profile: TeacherAcademicProfile) {
      const validation = validateTeacherAcademicProfile(profile)
      if (validation) throw new Error(validation)
      if (profile.user_id !== userId) throw new Error('TEACHING_FORBIDDEN')
      current = { ...current, ...teacherAcademicProfilePayload(profile),
        access_period_pending: profile.requested_valid_until !== current.requested_valid_until ? true : current.access_period_pending,
        updated_at: new Date().toISOString() }
      onChange?.(snapshot())
      return snapshot()
    },
    snapshot,
    async approve(approvedUntil: string | null) {
      current = { ...current, approved_valid_until: approvedUntil, access_period_pending: false,
        access_expired: Boolean(approvedUntil && approvedUntil < new Date().toISOString().slice(0, 10)), updated_at: new Date().toISOString() }
      onChange?.(snapshot())
      return snapshot()
    },
  }
}

// Optional signup details stay in this tab until the same authenticated user
// confirms their email. Never place contact data in public auth metadata.
const PENDING_KEY = 'xelay:teacher-academic-registration:v1'
const PENDING_TTL = 24 * 60 * 60 * 1000
export function stagePendingTeacherAcademicProfile(userId: string, profile: TeacherAcademicProfile) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ userId, createdAt: Date.now(), profile: teacherAcademicProfilePayload(profile) }))
    return true
  } catch { return false }
}
export function clearPendingTeacherAcademicProfile() {
  try { sessionStorage.removeItem(PENDING_KEY) } catch { /* Storage may be disabled. */ }
}
const consumption = new Map<string, Promise<void>>()
export async function consumePendingTeacherAcademicProfile(userId: string): Promise<void> {
  const current = consumption.get(userId)
  if (current) return current
  const run = async () => {
    let pending: { userId?: string; createdAt?: number; profile?: Partial<TeacherAcademicProfile> } | null = null
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null') } catch { clearPendingTeacherAcademicProfile(); return }
    if (!pending) return
    if (!pending.createdAt || pending.createdAt > Date.now() || Date.now() - pending.createdAt > PENDING_TTL || pending.userId !== userId) { clearPendingTeacherAcademicProfile(); return }
    const auth = await supabase.auth.getUser()
    if (auth.error || auth.data.user?.id !== userId || !auth.data.user.email_confirmed_at) return
    const saved = await supabaseTeacherAcademicRepository.load()
    // A later settings edit takes precedence over a stale registration draft.
    if (!saved.updated_at) await supabaseTeacherAcademicRepository.save({ ...emptyTeacherAcademicProfile(userId), ...pending.profile, user_id: userId })
    clearPendingTeacherAcademicProfile()
  }
  const promise = run().finally(() => consumption.delete(userId))
  consumption.set(userId, promise)
  return promise
}
