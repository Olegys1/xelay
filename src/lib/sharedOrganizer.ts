import { supabase } from './supabase'
import { isMissingDatabaseColumn, isMissingDatabaseFunction, isMissingDatabaseTable } from './databaseCompatibility'
import { validDayKey } from './organizerDates'

export interface SharedOrganizerWorkspace {
  id: string
  name: string
  owner_id: string
  created_at: string
  updated_at: string
  member_count: number
}
export interface SharedOrganizerMember {
  workspace_id: string
  user_id: string
  role: 'owner' | 'member'
  full_name: string
  username: string | null
  avatar_url: string | null
  is_premium: boolean
}
export interface SharedOrganizerInvitation {
  id: string
  workspace_id: string
  workspace_name: string
  inviter_name: string
  invitee_id: string
  invitee_name: string
  invitee_username: string
  expires_at: string
  created_at: string
}
export interface SharedOrganizerTask {
  id: string
  workspace_id: string
  created_by: string
  updated_by: string
  assignee_id: string | null
  title: string
  notes: string
  subject: string
  due_at: string | null
  due_date: string | null
  completed: boolean
  created_at: string
  updated_at: string
}
export interface SharedOrganizerTaskInput {
  id?: string | null
  updated_at?: string | null
  title: string
  notes: string
  subject: string
  due_at: string | null
  due_date: string | null
  assignee_id: string | null
  completed: boolean
}
export interface SharedOrganizerOverview {
  workspaces: SharedOrganizerWorkspace[]
  invitations: SharedOrganizerInvitation[]
}
export interface SharedOrganizerSnapshot {
  workspace: SharedOrganizerWorkspace
  members: SharedOrganizerMember[]
  invitations: SharedOrganizerInvitation[]
  tasks: SharedOrganizerTask[]
  total: number
}

export const SHARED_ORGANIZER_UPDATED_EVENT = 'xelay_shared_organizer_updated'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalid = () => new Error('SHARED_ORGANIZER_RESPONSE_INVALID')
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function string(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || Array.from(value).length > max) throw invalid()
  return value
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid()
  return value
}
function timestamp(value: unknown): string {
  const result = string(value, 64)
  if (!Number.isFinite(Date.parse(result))) throw invalid()
  return result
}
function nullableString(value: unknown, max: number): string | null {
  return value === null ? null : string(value, max)
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10000) throw invalid()
  return value.map(parse)
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw invalid()
  return value
}
function workspace(value: unknown): SharedOrganizerWorkspace {
  const row = record(value)
  return { id: uuid(row.id), name: string(row.name, 100), owner_id: uuid(row.owner_id),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), member_count: integer(row.member_count, 5) }
}
function member(value: unknown): SharedOrganizerMember {
  const row = record(value)
  if ((row.role !== 'owner' && row.role !== 'member') || typeof row.is_premium !== 'boolean') throw invalid()
  return { workspace_id: uuid(row.workspace_id), user_id: uuid(row.user_id), role: row.role,
    full_name: string(row.full_name, 500), username: nullableString(row.username, 100),
    avatar_url: nullableString(row.avatar_url, 4096), is_premium: row.is_premium }
}
function invitation(value: unknown): SharedOrganizerInvitation {
  const row = record(value)
  return { id: uuid(row.id), workspace_id: uuid(row.workspace_id), workspace_name: string(row.workspace_name, 100),
    inviter_name: string(row.inviter_name, 500), invitee_id: uuid(row.invitee_id), invitee_name: string(row.invitee_name, 500),
    invitee_username: string(row.invitee_username, 100), expires_at: timestamp(row.expires_at), created_at: timestamp(row.created_at) }
}
function task(value: unknown): SharedOrganizerTask {
  const row = record(value)
  if (typeof row.completed !== 'boolean') throw invalid()
  const date = nullableString(row.due_date, 10)
  if (date !== null && (!validDayKey(date) || date < '0001-01-01' || date > '9999-12-31')) throw invalid()
  const due = row.due_at === null ? null : timestamp(row.due_at)
  if (date !== null && due !== null) throw invalid()
  return { id: uuid(row.id), workspace_id: uuid(row.workspace_id), created_by: uuid(row.created_by),
    updated_by: uuid(row.updated_by), assignee_id: row.assignee_id === null ? null : uuid(row.assignee_id),
    title: string(row.title, 200), notes: string(row.notes), subject: string(row.subject, 120), due_date: date,
    due_at: due, completed: row.completed, created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at) }
}

// Each call uses the account captured before the request, including its bearer
// header. A sign-in change cannot turn a delayed click into another user's write.
async function rpc(name: string, parameters: Record<string, unknown>, expectedUserId: string): Promise<unknown> {
  const { data: auth, error: authError } = await supabase.auth.getSession()
  const session = auth.session
  if (authError || !session?.user.id || !session.access_token) throw new Error('SHARED_ORGANIZER_AUTH_REQUIRED')
  if (session.user.id !== expectedUserId) throw new Error('SHARED_ORGANIZER_AUTH_CHANGED')
  const { data, error } = await supabase.rpc(name, parameters).setHeader('Authorization', `Bearer ${session.access_token}`)
  const { data: current, error: currentError } = await supabase.auth.getSession()
  if (currentError || current.session?.user.id !== expectedUserId) throw new Error('SHARED_ORGANIZER_AUTH_CHANGED')
  if (error) throw error
  return data
}
function changed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHARED_ORGANIZER_UPDATED_EVENT))
}
export async function loadSharedOrganizerOverview(userId: string): Promise<SharedOrganizerOverview> {
  const row = record(await rpc('xelay_shared_organizer_overview', {}, userId))
  return { workspaces: array(row.workspaces, workspace), invitations: array(row.invitations, invitation) }
}
export async function loadSharedOrganizerWorkspace(workspaceId: string, userId: string, offset = 0, limit = 100): Promise<SharedOrganizerSnapshot> {
  uuid(workspaceId)
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('SHARED_ORGANIZER_INVALID_PAGE')
  }
  const row = record(await rpc('xelay_shared_organizer_workspace', { p_workspace_id: workspaceId, p_offset: offset, p_limit: limit }, userId))
  const result = { workspace: workspace(row.workspace), members: array(row.members, member),
    invitations: array(row.invitations, invitation), tasks: array(row.tasks, task), total: integer(row.total, 10000) }
  if (result.workspace.id !== workspaceId || result.members.length > 5
    || !result.members.some((item) => item.user_id === userId)
    || result.members.some((item) => item.workspace_id !== workspaceId)
    || result.invitations.some((item) => item.workspace_id !== workspaceId)
    || result.tasks.some((item) => item.workspace_id !== workspaceId)) throw invalid()
  return result
}
export async function createSharedOrganizer(name: string, userId: string): Promise<string> {
  const result = uuid(await rpc('xelay_create_shared_organizer', { p_name: name.trim() }, userId))
  changed()
  return result
}
export async function renameSharedOrganizer(workspaceId: string, name: string, version: string, userId: string): Promise<void> {
  await rpc('xelay_rename_shared_organizer', { p_workspace_id: uuid(workspaceId), p_name: name.trim(), p_expected_updated_at: timestamp(version) }, userId)
  changed()
}
export async function inviteSharedOrganizer(workspaceId: string, username: string, userId: string): Promise<string> {
  const result = uuid(await rpc('xelay_invite_shared_organizer', { p_workspace_id: uuid(workspaceId), p_username: username.trim().replace(/^@/, '') }, userId))
  changed()
  return result
}
export async function respondSharedOrganizerInvitation(invitationId: string, accept: boolean, userId: string): Promise<string | null> {
  const result = await rpc('xelay_respond_shared_organizer_invite', { p_invitation_id: uuid(invitationId), p_accept: accept }, userId)
  changed()
  return result === null ? null : uuid(result)
}
export async function cancelSharedOrganizerInvitation(invitationId: string, userId: string): Promise<void> {
  await rpc('xelay_cancel_shared_organizer_invite', { p_invitation_id: uuid(invitationId) }, userId)
  changed()
}
export async function removeSharedOrganizerMember(workspaceId: string, targetUserId: string, userId: string): Promise<void> {
  await rpc('xelay_remove_shared_organizer_member', { p_workspace_id: uuid(workspaceId), p_user_id: uuid(targetUserId) }, userId)
  changed()
}
export async function saveSharedOrganizerTask(workspaceId: string, input: SharedOrganizerTaskInput, userId: string): Promise<SharedOrganizerTask> {
  if ((input.due_date !== null && (!validDayKey(input.due_date) || input.due_date < '0001-01-01' || input.due_date > '9999-12-31'))
    || (input.due_date !== null && input.due_at !== null)
    || (input.due_at !== null && (!Number.isFinite(Date.parse(input.due_at))
      || Date.parse(input.due_at) < Date.parse('0001-01-01T00:00:00Z')
      || Date.parse(input.due_at) >= Date.parse('+010000-01-01T00:00:00Z')))) {
    throw new Error('SHARED_ORGANIZER_INVALID_DEADLINE')
  }
  const result = task(await rpc('xelay_save_shared_organizer_task', {
    p_workspace_id: uuid(workspaceId), p_task_id: input.id ? uuid(input.id) : null,
    p_expected_updated_at: input.updated_at ? timestamp(input.updated_at) : null,
    p_title: input.title.trim(), p_notes: input.notes.trim(), p_subject: input.subject.trim(),
    p_due_date: input.due_date, p_due_at: input.due_at,
    p_assignee_id: input.assignee_id ? uuid(input.assignee_id) : null, p_completed: input.completed,
  }, userId))
  if (result.workspace_id !== workspaceId) throw invalid()
  changed()
  return result
}
export async function deleteSharedOrganizerTask(workspaceId: string, taskId: string, version: string, userId: string): Promise<void> {
  await rpc('xelay_delete_shared_organizer_task', { p_workspace_id: uuid(workspaceId), p_task_id: uuid(taskId), p_expected_updated_at: timestamp(version) }, userId)
  changed()
}
export async function archiveSharedOrganizer(workspaceId: string, version: string, userId: string): Promise<void> {
  await rpc('xelay_archive_shared_organizer', { p_workspace_id: uuid(workspaceId), p_expected_updated_at: timestamp(version) }, userId)
  changed()
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message || '')
export function isSharedOrganizerAccessError(error: unknown): boolean {
  return /SHARED_ORGANIZER_(AUTH_REQUIRED|AUTH_CHANGED|PARTICIPANT_REQUIRED|NOT_MEMBER|WORKSPACE_UNAVAILABLE)/.test(errorMessage(error))
}
export function sharedOrganizerError(error: unknown): string {
  const value = error as { code?: string; message?: unknown } | null
  if (isMissingDatabaseColumn(value) || isMissingDatabaseFunction(value) || isMissingDatabaseTable(value)) {
    return 'Спільний органайзер ще не підключено. Спробуйте пізніше.'
  }
  const labels: Record<string, string> = {
    AUTH_REQUIRED: 'Увійдіть до свого акаунта.',
    AUTH_CHANGED: 'Акаунт змінився. Оновіть сторінку.',
    PARTICIPANT_REQUIRED: 'Для спільного органайзера потрібна активна підписка «Учасник».',
    INVALID_NAME: 'Назва має містити від 1 до 100 символів.',
    WORKSPACE_UNAVAILABLE: 'Органайзер заархівовано або у вас більше немає доступу.',
    NOT_MEMBER: 'У вас більше немає доступу до цього органайзера.',
    OWNER_REQUIRED: 'Керувати учасниками й налаштуваннями може лише власник.',
    OWNED_WORKSPACE_LIMIT: 'Можна створити не більше 10 активних спільних органайзерів.',
    CREATE_RATE_LIMIT: 'Ліміт створення органайзерів на сьогодні вичерпано. Спробуйте завтра.',
    INVALID_USERNAME: 'Вкажіть точний нік користувача, наприклад @your_friend.',
    USER_NOT_FOUND: 'Користувача з таким ніком не знайдено.',
    INVITEE_PARTICIPANT_REQUIRED: 'Для запрошення потрібна активна підписка «Учасник» у цієї людини.',
    SELF_INVITE: 'Ви вже є власником цього органайзера.',
    ALREADY_MEMBER: 'Ця людина вже в органайзері.',
    INVITATION_PENDING: 'Запрошення для цієї людини вже надіслано.',
    WORKSPACE_FULL: 'До 5 людей разом із власником. Очікувані запрошення також займають місце.',
    INVITE_RATE_LIMIT: 'Ліміт запрошень на сьогодні вичерпано. Спробуйте завтра.',
    INVITEE_INVITATION_LIMIT: 'У цієї людини забагато запрошень. Спробуйте пізніше.',
    INVITATION_UNAVAILABLE: 'Запрошення вже прийнято, скасовано або воно недоступне.',
    INVITATION_EXPIRED: 'Термін запрошення минув. Попросіть власника надіслати нове.',
    OWNER_CANNOT_LEAVE: 'Власник може заархівувати органайзер. Вийти окремо від команди не можна.',
    MEMBER_UNAVAILABLE: 'Учасник уже вийшов або його видалено.',
    INVALID_TASK: 'Перевірте назву (до 200 символів), предмет (до 120) і нотатки (до 10 000).',
    INVALID_DEADLINE: 'Оберіть коректну дату або дату з часом за Києвом.',
    ASSIGNEE_UNAVAILABLE: 'Відповідальний має бути учасником з активною підпискою.',
    TASK_UNAVAILABLE: 'Завдання видалене або більше недоступне. Оновіть список.',
    TASK_LIMIT: 'У цьому органайзері вже 1 000 завдань. Видаліть непотрібні.',
    CONFLICT: 'Завдання або органайзер уже змінилися. Ваш текст залишився у формі; оновіть список.',
    INVALID_PAGE: 'Не вдалося відкрити цю частину списку. Оновіть сторінку.',
    INVALID_INVITATION: 'Не вдалося надіслати запрошення. Перевірте нік і повторіть дію.',
    IDENTITY_IMMUTABLE: 'Не вдалося змінити налаштування доступу. Оновіть список.',
    RESPONSE_INVALID: 'Не вдалося прочитати спільний органайзер. Оновіть сторінку.',
  }
  const message = errorMessage(error)
  for (const [code, label] of Object.entries(labels)) if (message.includes('SHARED_ORGANIZER_' + code)) return label
  if (value?.code === '42501') return 'Дія недоступна. Перевірте свій акаунт і підписку.'
  return 'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз.'
}
