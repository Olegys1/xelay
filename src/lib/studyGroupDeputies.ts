import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'
import { isMissingDatabaseFunction } from './databaseCompatibility'
import type { StudyGroupMemberProfile } from './studyGroupMembers'

export type StudyGroupPermission = 'schedule' | 'homework' | 'seminars' | 'seminar_resources' | 'seminar_comments' | 'invite_members' | 'remove_members'

export const STUDY_GROUP_CONTENT_PERMISSIONS = ['schedule', 'homework', 'seminars', 'seminar_resources'] as const
export type StudyGroupContentPermission = typeof STUDY_GROUP_CONTENT_PERMISSIONS[number]

export const STUDY_GROUP_PERMISSIONS: { key: StudyGroupPermission; label: string; description: string }[] = [
  { key: 'schedule', label: 'Редагувати розклад', description: 'Додавати, змінювати та видаляти пари. Для видалення пари з ДЗ також потрібне право керувати домашніми завданнями.' },
  { key: 'homework', label: 'Керувати домашніми завданнями', description: 'Додавати, змінювати та видаляти звичайне ДЗ і його матеріали.' },
  { key: 'seminars', label: 'Керувати семінарами', description: 'Редагувати предмети, розклад семінарів, завдання, питання та команди. Для видалення завдання з файлами чи посиланнями також потрібне право керувати матеріалами.' },
  { key: 'seminar_resources', label: 'Керувати матеріалами семінарів', description: 'Додавати, змінювати та видаляти посилання й файли семінарів.' },
  { key: 'seminar_comments', label: 'Модерувати коментарі семінарів', description: 'Видаляти коментарі інших учасників під семінарами.' },
  { key: 'invite_members', label: 'Запрошувати учасників', description: 'Надсилати запрошення до цієї навчальної групи.' },
  { key: 'remove_members', label: 'Видаляти учасників', description: 'Видаляти учасників і скасовувати запрошення до цієї групи.' },
]

export type StudyGroupDeputyStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'revoked'
export type StudyGroupDeputyRequest = {
  id: string
  group_id: string
  user_id: string
  status: StudyGroupDeputyStatus
  permissions: StudyGroupPermission[]
  message: string | null
  created_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  updated_at: string
  profile?: StudyGroupMemberProfile
}

function normalizePermissions(value: unknown): StudyGroupPermission[] {
  if (!Array.isArray(value)) return []
  return STUDY_GROUP_PERMISSIONS.filter(({ key }) => value.includes(key)).map(({ key }) => key)
}

export function canManageStudyGroupContent({ groupId, userId, representativeId, memberStatus, deputies, permission }: {
  groupId: string; userId: string; representativeId: string; memberStatus?: string; deputies: unknown
  permission: StudyGroupContentPermission
}): boolean {
  if (!groupId || !userId || !STUDY_GROUP_CONTENT_PERMISSIONS.includes(permission)) return false
  if (userId === representativeId) return true
  if (memberStatus !== 'accepted' || !Array.isArray(deputies)) return false
  // Check the actual appointment, including when an older server gives platform
  // administrators every permission. A platform role alone cannot edit content.
  return deputies.some((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const deputy = value as Partial<StudyGroupDeputyRequest>
    return deputy.group_id === groupId && deputy.user_id === userId
      && deputy.status === 'approved' && normalizePermissions(deputy.permissions).includes(permission)
  })
}

export function isStudyGroupDeputySchemaMissing(error: unknown) {
  const value = error as { code?: string; message?: string } | null
  return isMissingDatabaseFunction(value) || ['42P01', 'PGRST205'].includes(value?.code || '')
}

export function studyGroupDeputyError(error: unknown): string {
  if (isStudyGroupDeputySchemaMissing(error)) return 'Призначення заступників поки недоступне. Для цієї функції потрібно оновити базу даних платформи.'
  const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message || '')
  const labels: Record<string, string> = {
    DEPUTY_AUTH_REQUIRED: 'Увійдіть знову, щоб продовжити.',
    DEPUTY_GROUP_NOT_FOUND: 'Групу вже змінено або видалено. Оновіть сторінку.',
    DEPUTY_MEMBER_REQUIRED: 'Заступником можна призначити лише учасника цієї групи, який прийняв запрошення.',
    DEPUTY_REPRESENTATIVE_REQUIRED: 'Призначати заступників та змінювати їхні права може староста цієї групи.',
    DEPUTY_REQUEST_NOT_FOUND: 'Призначення вже змінено або видалено. Оновіть список.',
    DEPUTY_ALREADY_ACTIVE: 'Цей учасник уже є заступником. Його права можна змінити у списку заступників.',
    DEPUTY_INVALID_PERMISSIONS: 'Не вдалося зберегти вибрані права. Оновіть сторінку та спробуйте ще раз.',
    DEPUTY_NOT_APPROVED: 'Цей учасник уже не є заступником. Оновіть список.',
    DEPUTY_CANNOT_ASSIGN_REPRESENTATIVE: 'Староста вже має всі права на керування цією групою.',
  }
  for (const [code, label] of Object.entries(labels)) if (message.includes(code)) return label
  return 'Не вдалося виконати дію. Оновіть список та спробуйте ще раз.'
}

export async function loadStudyGroupPermissions(groupId: string): Promise<StudyGroupPermission[]> {
  const { data, error } = await supabase.rpc('xelay_study_group_permissions', { p_group_id: groupId })
  if (error) throw error
  return normalizePermissions(data)
}

export async function loadStudyGroupDeputies(groupId: string): Promise<{ requests: StudyGroupDeputyRequest[]; profilesUnavailable: boolean }> {
  const { data, error } = await supabase.rpc('xelay_list_study_group_deputies', { p_group_id: groupId })
  if (error) throw error
  const requests = ((Array.isArray(data) ? data : []) as StudyGroupDeputyRequest[])
    .map((row) => ({ ...row, permissions: normalizePermissions(row.permissions) }))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
  const profiles = await getPublicProfiles(requests.map((request) => request.user_id))
  const byId = new Map<string, StudyGroupMemberProfile>((profiles.data || []).map((profile) => [profile.id, profile]))
  return { requests: requests.map((request) => ({ ...request, profile: byId.get(request.user_id) })), profilesUnavailable: Boolean(profiles.error) }
}

export async function assignStudyGroupDeputy(groupId: string, userId: string, permissions: StudyGroupPermission[]): Promise<string> {
  const { data, error } = await supabase.rpc('xelay_assign_study_group_deputy', {
    p_group_id: groupId, p_user_id: userId, p_permissions: permissions,
  })
  if (error) throw error
  return data as string
}

export async function updateStudyGroupDeputyPermissions(requestId: string, permissions: StudyGroupPermission[]): Promise<void> {
  const { error } = await supabase.rpc('xelay_update_study_group_deputy_permissions', { p_request_id: requestId, p_permissions: permissions })
  if (error) throw error
}

export async function revokeStudyGroupDeputy(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('xelay_revoke_study_group_deputy', { p_request_id: requestId })
  if (error) throw error
}
