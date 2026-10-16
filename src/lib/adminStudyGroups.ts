import { supabase } from './supabase'

export type AdminStudyGroupSort = 'name' | 'members_desc' | 'members_asc'
export type AdminStudyGroupMemberFilter = 'accepted' | 'pending' | 'inactive'
export type AdminStudyGroupMemberStatus = 'accepted' | 'pending' | 'rejected' | 'removed'

export interface AdminStudyGroupSummary {
  id: string
  group_name: string
  specialty: string
  cohort_start_year: number | null
  study_level: string | null
  university_id: string
  university_name: string
  academic_unit_id: string
  unit_name: string
  representative: { id: string; full_name: string | null; username: string | null }
  accepted_count: number
  pending_count: number
  inactive_count: number
  created_at: string
}

export interface AdminStudyGroupMember {
  user_id: string
  full_name: string | null
  username: string | null
  status: AdminStudyGroupMemberStatus
  is_representative: boolean
  invited_at: string | null
  accepted_at: string | null
}

export interface AdminStudyGroupsPage { items: AdminStudyGroupSummary[]; total: number }
export interface AdminStudyGroupMembersPage { group: AdminStudyGroupSummary; items: AdminStudyGroupMember[]; total: number }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sorts: readonly AdminStudyGroupSort[] = ['name', 'members_desc', 'members_asc']
const filters: readonly AdminStudyGroupMemberFilter[] = ['accepted', 'pending', 'inactive']
const invalidResponse = () => new Error('ADMIN_STUDY_GROUP_RESPONSE_INVALID')
const invalidInput = () => new Error('ADMIN_STUDY_GROUP_INPUT_INVALID')
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  return value as Record<string, unknown>
}
function normalizedQuery(value: string): string {
  if (typeof value !== 'string') throw invalidInput()
  const query = value.trim()
  if (Array.from(query).length > 120 || /[\u0000-\u001f\u007f]/.test(query)) throw invalidInput()
  return query
}
function pagination(limit: number, offset: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 2147483647) throw invalidInput()
}
function summary(value: unknown): AdminStudyGroupSummary {
  const row = record(value), representative = record(row.representative)
  if (!isUuid(row.id) || typeof row.group_name !== 'string' || !row.group_name.trim() || typeof row.specialty !== 'string'
    || !isUuid(row.university_id) || typeof row.university_name !== 'string' || !isUuid(row.academic_unit_id) || typeof row.unit_name !== 'string'
    || !(row.cohort_start_year === null || Number.isInteger(row.cohort_start_year) && Number(row.cohort_start_year) >= 1900 && Number(row.cohort_start_year) <= 2200)
    || !(row.study_level === null || ['bachelor', 'master', 'postgraduate'].includes(String(row.study_level)))
    || !isUuid(representative.id) || !nullableString(representative.full_name) || !nullableString(representative.username)
    || !isCount(row.accepted_count) || row.accepted_count < 1 || !isCount(row.pending_count) || !isCount(row.inactive_count)
    || !isDate(row.created_at)) throw invalidResponse()
  return {
    id: row.id, group_name: row.group_name, specialty: row.specialty,
    cohort_start_year: row.cohort_start_year as number | null, study_level: row.study_level as string | null,
    university_id: row.university_id, university_name: row.university_name, academic_unit_id: row.academic_unit_id, unit_name: row.unit_name,
    representative: { id: representative.id, full_name: representative.full_name, username: representative.username },
    accepted_count: row.accepted_count, pending_count: row.pending_count, inactive_count: row.inactive_count, created_at: row.created_at,
  }
}
function checkPage(value: Record<string, unknown>, limit: number, offset: number): unknown[] {
  if (!Array.isArray(value.items) || value.items.length > limit || !isCount(value.total)
    || value.items.length > value.total || value.items.length > 0 && offset + value.items.length > value.total) throw invalidResponse()
  return value.items
}

export async function loadAdminStudyGroups(query = '', sort: AdminStudyGroupSort = 'name', limit = 20, offset = 0): Promise<AdminStudyGroupsPage> {
  pagination(limit, offset)
  if (!sorts.includes(sort)) throw invalidInput()
  const { data, error } = await supabase.rpc('xelay_admin_study_groups', { p_query: normalizedQuery(query), p_sort: sort, p_limit: limit, p_offset: offset })
  if (error) throw error
  const page = record(data), items = checkPage(page, limit, offset).map(summary)
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalidResponse()
  return { items, total: page.total as number }
}

export async function loadAdminStudyGroupMembers(groupId: string, status: AdminStudyGroupMemberFilter = 'accepted', query = '', limit = 50, offset = 0): Promise<AdminStudyGroupMembersPage> {
  pagination(limit, offset)
  if (!isUuid(groupId) || !filters.includes(status)) throw invalidInput()
  const { data, error } = await supabase.rpc('xelay_admin_study_group_members', { p_group_id: groupId, p_status: status, p_query: normalizedQuery(query), p_limit: limit, p_offset: offset })
  if (error) throw error
  const page = record(data), group = summary(page.group)
  if (group.id.toLowerCase() !== groupId.toLowerCase()) throw invalidResponse()
  const items = checkPage(page, limit, offset).map(value => {
    const row = record(value)
    if (!isUuid(row.user_id) || !nullableString(row.full_name) || !nullableString(row.username) || typeof row.is_representative !== 'boolean'
      || !(status === 'inactive' ? ['rejected', 'removed'].includes(String(row.status)) : row.status === status)
      || row.is_representative !== (row.user_id.toLowerCase() === group.representative.id.toLowerCase())
      || row.is_representative && row.status !== 'accepted'
      || !(row.invited_at === null || isDate(row.invited_at)) || !(row.accepted_at === null || isDate(row.accepted_at))) throw invalidResponse()
    return { user_id: row.user_id, full_name: row.full_name, username: row.username, status: row.status as AdminStudyGroupMemberStatus,
      is_representative: row.is_representative, invited_at: row.invited_at as string | null, accepted_at: row.accepted_at as string | null }
  })
  if (new Set(items.map(item => item.user_id)).size !== items.length) throw invalidResponse()
  const wholeCount = status === 'accepted' ? group.accepted_count : status === 'pending' ? group.pending_count : group.inactive_count
  if ((page.total as number) > wholeCount || !query.trim() && page.total !== wholeCount) throw invalidResponse()
  return { group, items, total: page.total as number }
}

export function adminStudyGroupsError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {}
  const message = typeof value.message === 'string' ? value.message : ''
  if (value.code === 'PGRST202' || value.code === '42883') return 'Перегляд навчальних груп ще підключається. Спробуйте пізніше.'
  if (/ADMIN_MFA_REQUIRED/.test(message) || value.code === '42501') return 'Для перегляду груп потрібен вхід адміністратора з двоетапним підтвердженням.'
  if (/ADMIN_STUDY_GROUP_NOT_FOUND/.test(message)) return 'Цю навчальну групу більше не знайдено. Оновіть список груп.'
  if (/ADMIN_STUDY_GROUP_INPUT_INVALID/.test(message)) return 'Перевірте пошуковий запит і повторіть спробу. Максимум — 120 символів.'
  return 'Не вдалося завантажити групи або їхній склад. Перевірте з’єднання та повторіть спробу.'
}
