import { supabase } from './supabase'
import { studyGroupIdentityLabel } from './studyGroupIdentity'

export type GroupQuickAccessKind = 'schedule' | 'chat'
export type GroupQuickAccessOption = { id: string; name: string; detail: string }
export const GROUP_QUICK_ACCESS_TIMEOUT_MS = 12_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GROUP_COLUMNS = 'id,group_name,specialty,cohort_start_year,study_level'
const invalid = () => new Error('GROUP_QUICK_ACCESS_RESPONSE_INVALID')
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const storageKey = (userId: string, kind: GroupQuickAccessKind) => `xelay:group-quick-access:${userId}:${kind}`

function rows(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data) || data.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw invalid()
  return data as Record<string, unknown>[]
}
function ids(data: unknown, field: string): string[] {
  return [...new Set(rows(data).map(row => {
    if (!isId(row[field])) throw invalid()
    return (row[field] as string).toLowerCase()
  }))]
}
function check(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}
function sorted(options: GroupQuickAccessOption[]) {
  return [...new Map(options.map(option => [option.id, option])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.detail.localeCompare(b.detail, 'uk') || a.id.localeCompare(b.id))
}

/** Only accepted academic membership or actual representative ownership grants a shortcut. */
export async function loadScheduleQuickAccess(userId: string, signal: AbortSignal): Promise<GroupQuickAccessOption[]> {
  if (!isId(userId)) throw invalid()
  check(signal)
  const [memberships, owned] = await Promise.all([
    supabase.from('study_group_members').select('group_id').eq('user_id', userId).eq('status', 'accepted').abortSignal(signal),
    supabase.from('study_groups').select(GROUP_COLUMNS).eq('representative_id', userId).abortSignal(signal),
  ])
  check(signal)
  if (memberships.error || owned.error) throw memberships.error || owned.error
  const memberIds = ids(memberships.data, 'group_id')
  const accepted = memberIds.length
    ? await supabase.from('study_groups').select(GROUP_COLUMNS).in('id', memberIds).abortSignal(signal)
    : { data: [], error: null }
  check(signal)
  if (accepted.error) throw accepted.error
  return sorted([...rows(owned.data), ...rows(accepted.data)].map(row => {
    if (!isId(row.id) || typeof row.group_name !== 'string' || !row.group_name.trim()
      || !(row.specialty === null || typeof row.specialty === 'string')
      || !(row.cohort_start_year === null || Number.isInteger(row.cohort_start_year)
        && Number(row.cohort_start_year) >= 1900 && Number(row.cohort_start_year) <= 2199)
      || !(row.study_level === null || ['bachelor', 'master', 'postgraduate'].includes(String(row.study_level)))) throw invalid()
    return {
      id: row.id.toLowerCase(), name: row.group_name.trim(),
      detail: [studyGroupIdentityLabel({ cohort_start_year: row.cohort_start_year as number | null, study_level: row.study_level as string | null }), row.specialty].filter(Boolean).join(' · '),
    }
  }))
}

/** Read metadata only; never create, join, or infer a chat from an academic group name. */
export async function loadChatQuickAccess(userId: string, signal: AbortSignal): Promise<GroupQuickAccessOption[]> {
  if (!isId(userId)) throw invalid()
  check(signal)
  const memberships = await supabase.from('chat_members').select('space_id')
    .eq('user_id', userId).eq('status', 'active').abortSignal(signal)
  check(signal)
  if (memberships.error) throw memberships.error
  const spaceIds = ids(memberships.data, 'space_id')
  if (!spaceIds.length) return []
  const spaces = await supabase.from('chat_spaces').select('id,name,kind,system_kind')
    .in('id', spaceIds).eq('kind', 'group').is('system_kind', null).abortSignal(signal)
  check(signal)
  if (spaces.error) throw spaces.error
  return sorted(rows(spaces.data).map(row => {
    if (!isId(row.id) || typeof row.name !== 'string' || !row.name.trim()
      || row.kind !== 'group' || row.system_kind !== null || !spaceIds.includes(row.id.toLowerCase())) throw invalid()
    return { id: row.id.toLowerCase(), name: row.name.trim(), detail: 'Груповий чат, у якому ви берете участь' }
  }))
}

export function readGroupQuickAccess(userId: string, kind: GroupQuickAccessKind): string | null {
  if (!isId(userId)) return null
  try {
    const value = localStorage.getItem(storageKey(userId, kind))
    return isId(value) ? value.toLowerCase() : null
  } catch { return null }
}
export function saveGroupQuickAccess(userId: string, kind: GroupQuickAccessKind, id: string | null): boolean {
  if (!isId(userId) || id !== null && !isId(id)) return false
  try {
    if (id === null) localStorage.removeItem(storageKey(userId, kind))
    else localStorage.setItem(storageKey(userId, kind), id.toLowerCase())
    return true
  } catch { return false }
}
export function groupQuickAccessPath(kind: GroupQuickAccessKind, id: string): string {
  if (!isId(id)) throw invalid()
  return kind === 'schedule' ? `/groups/${encodeURIComponent(id.toLowerCase())}?tab=schedule`
    : `/messages?kind=groups&space=${encodeURIComponent(id.toLowerCase())}`
}
