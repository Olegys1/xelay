import { supabase } from './supabase'

export type ProfileReportTargetKind = 'profile' | 'status'
export type ProfileReportReason = 'harassment' | 'hate' | 'impersonation' | 'inappropriate' | 'spam' | 'privacy' | 'other'
export type ProfileReportStatus = 'open' | 'in_review' | 'resolved' | 'dismissed'
export type ProfileReportFilter = ProfileReportStatus | 'all'
export type ProfileReportAction = 'none' | 'clear_status'

export const PROFILE_REPORT_DETAILS_MIN = 10
export const PROFILE_REPORT_DETAILS_MAX = 2000
export const PROFILE_REPORT_TARGETS: readonly { value: ProfileReportTargetKind; label: string }[] = [
  { value: 'profile', label: 'Профіль' }, { value: 'status', label: 'Статус біля імені' },
]
export const PROFILE_REPORT_REASONS: readonly { value: ProfileReportReason; label: string }[] = [
  { value: 'harassment', label: 'Образи, погрози або цькування' },
  { value: 'hate', label: 'Мова ненависті чи заклики до насильства' },
  { value: 'impersonation', label: 'Видає себе за іншу людину чи організацію' },
  { value: 'inappropriate', label: 'Непристойний або неприйнятний вміст' },
  { value: 'spam', label: 'Спам, шахрайство чи небезпечні посилання' },
  { value: 'privacy', label: 'Розголошення приватних даних' },
  { value: 'other', label: 'Інше порушення правил' },
]
export const PROFILE_REPORT_STATUS_LABELS: Record<ProfileReportStatus, string> = {
  open: 'Нова', in_review: 'На розгляді', resolved: 'Розгляд завершено', dismissed: 'Відхилено',
}

export function getProfileReportReasonLabel(reason: string): string {
  return PROFILE_REPORT_REASONS.find(item => item.value === reason)?.label || 'Інше порушення правил'
}

export interface ProfileReportPerson {
  user_id: string
  full_name: string | null
  username: string | null
  avatar_url: string | null
}
export interface ProfileReportSnapshot extends ProfileReportPerson {
  bio: string | null
  university_id: string | null
  academic_unit_id: string | null
  faculty: string | null
  specialty: string | null
  study_year: number | null
  experience: string | null
  is_premium: boolean
  status_text: string | null
  emoji_status: string | null
}
export interface ProfileReport {
  id: string
  kind: ProfileReportTargetKind
  reason: ProfileReportReason
  details: string
  status: ProfileReportStatus
  version: number
  created_at: string
  updated_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  reporter_id: string | null
  target_user_id: string | null
  reporter_snapshot: ProfileReportPerson
  target_snapshot: ProfileReportSnapshot
}
export interface ProfileReportHistory {
  id: string
  actor_id: string | null
  from_status: ProfileReportStatus | null
  to_status: ProfileReportStatus
  action: ProfileReportAction | 'submit'
  note: string
  created_at: string
  version: number
}
export interface ProfileReportCurrentStatus { is_premium: boolean; status_text: string | null; emoji_status: string | null }
export interface AdminProfileReportDetail {
  report: ProfileReport
  history: ProfileReportHistory[]
  current_status: ProfileReportCurrentStatus | null
}
export interface AdminProfileReportsPage { items: ProfileReport[]; total: number; open_count: number }
export interface ProfileReportReceipt { id: string; status: ProfileReportStatus; duplicate: boolean }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const statuses = Object.keys(PROFILE_REPORT_STATUS_LABELS)
const invalid = () => new Error('PROFILE_REPORT_INVALID_RESPONSE')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function validateProfileReportDetails(details: string): string {
  const length = Array.from(details.trim()).length
  return length < PROFILE_REPORT_DETAILS_MIN ? 'Опишіть проблему щонайменше у 10 символах.'
    : length > PROFILE_REPORT_DETAILS_MAX ? 'Скоротіть опис до 2000 символів.' : ''
}

function person(value: unknown): ProfileReportPerson {
  const row = object(value)
  if (!isUuid(row.user_id) || !['full_name', 'username', 'avatar_url'].every(key => nullableString(row[key]))) throw invalid()
  return row as unknown as ProfileReportPerson
}
function report(value: unknown): ProfileReport {
  const row = object(value)
  if (!isUuid(row.id) || !PROFILE_REPORT_TARGETS.some(item => item.value === row.kind)
    || !PROFILE_REPORT_REASONS.some(item => item.value === row.reason)
    || typeof row.details !== 'string' || !statuses.includes(String(row.status))
    || !count(row.version) || row.version < 1 || !isDate(row.created_at) || !isDate(row.updated_at)
    || !(row.reviewed_at === null || isDate(row.reviewed_at))
    || !['reporter_id', 'target_user_id', 'reviewed_by'].every(key => row[key] === null || isUuid(row[key]))) throw invalid()
  person(row.reporter_snapshot)
  const snapshot = object(person(row.target_snapshot))
  if (!['bio', 'faculty', 'specialty', 'experience', 'status_text', 'emoji_status'].every(key => nullableString(snapshot[key]))
    || !['university_id', 'academic_unit_id'].every(key => snapshot[key] === null || isUuid(snapshot[key]))
    || !(snapshot.study_year === null || count(snapshot.study_year)) || typeof snapshot.is_premium !== 'boolean') throw invalid()
  return row as unknown as ProfileReport
}
function history(value: unknown): ProfileReportHistory[] {
  if (!Array.isArray(value)) throw invalid()
  for (const entry of value) {
    const row = object(entry)
    if (!isUuid(row.id) || !(row.actor_id === null || isUuid(row.actor_id))
      || !(row.from_status === null || statuses.includes(String(row.from_status))) || !statuses.includes(String(row.to_status))
      || !['submit', 'none', 'clear_status'].includes(String(row.action)) || typeof row.note !== 'string'
      || !isDate(row.created_at) || !count(row.version) || row.version < 1) throw invalid()
  }
  return value as ProfileReportHistory[]
}
function currentStatus(value: unknown): ProfileReportCurrentStatus | null {
  if (value === null) return null
  const row = object(value)
  if (typeof row.is_premium !== 'boolean' || !nullableString(row.status_text) || !nullableString(row.emoji_status)) throw invalid()
  return row as unknown as ProfileReportCurrentStatus
}

export async function submitProfileReport(input: {
  targetUserId: string; targetKind: ProfileReportTargetKind; reason: ProfileReportReason; details: string; requestId: string
}): Promise<ProfileReportReceipt> {
  if (!isUuid(input.targetUserId) || !isUuid(input.requestId)
    || !PROFILE_REPORT_TARGETS.some(item => item.value === input.targetKind)
    || !PROFILE_REPORT_REASONS.some(item => item.value === input.reason) || validateProfileReportDetails(input.details)) throw new Error('PROFILE_REPORT_INVALID_INPUT')
  const { data, error } = await supabase.rpc('xelay_submit_profile_report', {
    p_request_id: input.requestId, p_target_user_id: input.targetUserId, p_kind: input.targetKind,
    p_reason: input.reason, p_details: input.details.trim(),
  })
  if (error) throw error
  const receipt = object(data)
  if (!isUuid(receipt.id) || !statuses.includes(String(receipt.status)) || typeof receipt.duplicate !== 'boolean') throw invalid()
  return receipt as unknown as ProfileReportReceipt
}

export async function loadAdminProfileReports(input: { status: ProfileReportFilter; limit?: number; offset?: number }): Promise<AdminProfileReportsPage> {
  const limit = input.limit ?? 20, offset = input.offset ?? 0
  if (!['all', ...statuses].includes(input.status) || !count(limit) || limit < 1 || limit > 100 || !count(offset)) throw new Error('PROFILE_REPORT_INVALID_INPUT')
  const { data, error } = await supabase.rpc('xelay_admin_profile_reports', { p_status: input.status, p_limit: limit, p_offset: offset })
  if (error) throw error
  const page = object(data)
  if (!Array.isArray(page.items) || page.items.length > limit || !count(page.total) || !count(page.open_count)) throw invalid()
  return { items: page.items.map(report), total: page.total, open_count: page.open_count }
}

export async function loadAdminProfileReport(id: string): Promise<AdminProfileReportDetail> {
  if (!isUuid(id)) throw new Error('PROFILE_REPORT_INVALID_INPUT')
  const { data, error } = await supabase.rpc('xelay_admin_profile_report', { p_report_id: id })
  if (error) throw error
  const detail = object(data)
  return { report: report(detail.report), history: history(detail.history), current_status: currentStatus(detail.current_status) }
}

export async function reviewProfileReport(input: {
  reportId: string; expectedVersion: number; status: ProfileReportStatus; note: string; action: ProfileReportAction
}): Promise<{ report: ProfileReport; history: ProfileReportHistory[] }> {
  const note = input.note.trim()
  if (!isUuid(input.reportId) || !count(input.expectedVersion) || input.expectedVersion < 1
    || !['in_review', 'resolved', 'dismissed'].includes(input.status) || !['none', 'clear_status'].includes(input.action)
    || Array.from(note).length > 2000 || (input.status !== 'in_review' && Array.from(note).length < 10)
    || (input.action === 'clear_status' && input.status !== 'resolved')) throw new Error('PROFILE_REPORT_INVALID_INPUT')
  const { data, error } = await supabase.rpc('xelay_admin_review_profile_report', {
    p_report_id: input.reportId, p_expected_version: input.expectedVersion, p_status: input.status, p_note: note, p_action: input.action,
  })
  if (error) throw error
  const detail = object(data)
  return { report: report(detail.report), history: history(detail.history) }
}

export function profileReportError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {}
  const message = typeof value.message === 'string' ? value.message : ''
  if (value.code === 'PGRST202' || value.code === '42883') return 'Скарги ще підключаються. Спробуйте пізніше або зверніться до підтримки.'
  if (/ADMIN_MFA_REQUIRED/.test(message)) return 'Для розгляду скарг потрібен вхід адміністратора з підтвердженням захисту.'
  if (/REPORT_(?:AUTH_REQUIRED|REPORTER_UNAVAILABLE)|AUTH_REQUIRED/.test(message)) return 'Увійдіть у свій акаунт, щоб надіслати скаргу.'
  if (/REPORT_SELF/.test(message)) return 'На власний профіль скаржитися не потрібно: його можна змінити в налаштуваннях.'
  if (/REPORT_(?:RATE|LIMIT)/.test(message)) return 'Денний ліміт скарг вичерпано. Повторіть спробу завтра; про термінову проблему повідомте підтримку.'
  if (/REPORT_TARGET_STATUS_NOT_FOUND/.test(message)) return 'Цей статус уже змінено або він більше не відображається. Оновіть профіль.'
  if (/REPORT_STATUS_CHANGED/.test(message)) return 'Статус уже відрізняється від збереженого у скарзі. Оновіть дані й перевірте його перед наступною дією.'
  if (/REPORT_REQUEST_CONFLICT/.test(message)) return 'Дані звернення змінилися. Перевірте опис і спробуйте надіслати його ще раз.'
  if (/REPORT_(?:CONFLICT|CLOSED|FINALIZED)/.test(message)) return 'Інший адміністратор уже оновив цю скаргу. Оновіть список перед наступною дією.'
  if (/REPORT_(?:TARGET_NOT_FOUND|NOT_FOUND)/.test(message)) return 'Профіль або скаргу більше не знайдено. Оновіть сторінку.'
  if (/REPORT_\w*INVALID|REPORT_REQUEST_ID_REQUIRED|PROFILE_REPORT_INVALID_INPUT/.test(message)) return 'Перевірте тип, причину й опис. Для завершення розгляду потрібне пояснення від 10 до 2000 символів.'
  if (value.code === '42501') return 'Ця дія недоступна для поточного акаунта. Перевірте свій вхід і права доступу.'
  return 'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз. Введений текст залишиться у формі.'
}
