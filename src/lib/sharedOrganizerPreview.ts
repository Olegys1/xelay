/** Isolated, fictional data for the local organizer preview. Never used by the app. */
import type { SharedOrganizerInvitation, SharedOrganizerMember, SharedOrganizerOverview, SharedOrganizerSnapshot, SharedOrganizerTask, SharedOrganizerTaskInput, SharedOrganizerWorkspace } from './sharedOrganizer'
export type { SharedOrganizerInvitation, SharedOrganizerMember, SharedOrganizerOverview, SharedOrganizerSnapshot, SharedOrganizerTask, SharedOrganizerTaskInput, SharedOrganizerWorkspace } from './sharedOrganizer'
export { sharedOrganizerError, isSharedOrganizerAccessError } from './sharedOrganizer'

export const SHARED_ORGANIZER_MEMBER_LIMIT = 35
export const SHARED_ORGANIZER_UPDATED_EVENT = 'xelay_shared_organizer_updated'
export const PREVIEW_ORGANIZER_USER = '00000000-0000-4000-8000-000000000001'
export type PreviewOrganizerScenario = 'team' | 'full' | 'empty'
const workspaceIds = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003']
const uid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const names = [
  ['Олексій Марченко', 'oleksii.m'], ['Марія Коваль', 'maria.k'], ['Софія Бондар', 'sofia.b'],
  ['Артем Мельник', 'artem.m'], ['Дарина Шевченко', 'daryna.sh'], ['Ілля Ткаченко', 'illia.t'],
  ['Вероніка Лисенко', 'veronika.l'], ['Максим Савчук', 'maksym.s'], ['Анна Поліщук', 'anna.p'],
  ['Владислав Кравченко', 'vlad.k'], ['Юлія Романюк', 'yulia.r'], ['Дмитро Клименко', 'dmytro.k'],
]
let version = 0
let state: Map<string, SharedOrganizerSnapshot>
let incoming: SharedOrganizerInvitation[] = []
const stamp = () => new Date(Date.now() + ++version).toISOString()
const copy = <T,>(value: T): T => structuredClone(value)
const fail = (code: string): never => { throw new Error('SHARED_ORGANIZER_' + code) }
const actor = (userId: string) => { if (userId !== PREVIEW_ORGANIZER_USER) fail('AUTH_CHANGED') }
const change = () => window.dispatchEvent(new Event(SHARED_ORGANIZER_UPDATED_EVENT))
const person = (index: number, workspaceId: string): SharedOrganizerMember => ({
  workspace_id: workspaceId, user_id: uid(index), role: index === 1 ? 'owner' : 'member',
  full_name: names[index - 1]?.[0] || `Учасник команди ${index}`, username: names[index - 1]?.[1] || `student.${index}`,
  avatar_url: null, is_premium: true,
})
function snapshot(id: string, userId: string) {
  actor(userId)
  const result = state.get(id)
  if (!result || !result.members.some(member => member.user_id === userId)) fail('WORKSPACE_UNAVAILABLE')
  return result!
}
function workspace(id: string, name: string, count: number): SharedOrganizerSnapshot {
  const at = stamp()
  return { workspace: { id, name, owner_id: PREVIEW_ORGANIZER_USER, created_at: at, updated_at: at, member_count: count }, members: Array.from({ length: count }, (_, index) => person(index + 1, id)), invitations: [], tasks: [], total: 0 }
}
function task(workspaceId: string, title: string, subject: string, index: number, done = false, notes = ''): SharedOrganizerTask {
  const at = stamp()
  return { id: crypto.randomUUID(), workspace_id: workspaceId, created_by: PREVIEW_ORGANIZER_USER, updated_by: PREVIEW_ORGANIZER_USER,
    assignee_id: index % 4 === 0 ? null : uid(index % 8 + 1), title, notes, subject,
    due_date: index % 3 === 0 ? null : `2026-10-${26 + index % 5}`, due_at: null,
    completed: done, created_at: at, updated_at: at }
}
export function resetOrganizerPreview(scenario: PreviewOrganizerScenario = 'team') {
  const main = workspace(workspaceIds[0], 'Економіка · команда курсу', scenario === 'full' ? 35 : 12)
  if (scenario !== 'empty') main.tasks = [
    task(main.workspace.id, 'Зібрати матеріали для спільної презентації', 'Економічна теорія', 1, false, 'Додаємо джерела та ключові тези. Узгоджуємо фінальну структуру на наступній зустрічі.'),
    task(main.workspace.id, 'Підготувати приклади для практичного заняття', 'Вища математика', 2),
    task(main.workspace.id, 'Перевірити розрахунки в таблиці', 'Статистика', 3, false, 'Звірити формули й одиниці вимірювання перед тим, як об’єднувати результати.'),
    task(main.workspace.id, 'Обрати час командної зустрічі', '', 4),
    task(main.workspace.id, 'Дописати висновки до дослідження', 'Маркетинг', 5),
    task(main.workspace.id, 'Оформити список використаних джерел', 'Економічна теорія', 6),
    task(main.workspace.id, 'Домовитися про тему проєкту', 'Маркетинг', 7, true),
    task(main.workspace.id, 'Створити план роботи команди', '', 8, true),
  ]
  main.total = main.tasks.length
  if (scenario !== 'full') main.invitations = [{ id: crypto.randomUUID(), workspace_id: main.workspace.id, workspace_name: main.workspace.name, inviter_name: main.members[0].full_name,
    invitee_id: uid(39), invitee_name: 'Олена Дорошенко', invitee_username: 'olena.d', expires_at: '2026-10-31T12:00:00Z', created_at: stamp() }]
  const project = workspace(workspaceIds[1], 'Дослідження ринку', 3)
  project.tasks = [task(project.workspace.id, 'Погодити питання для опитування', 'Маркетинг', 1)]
  project.tasks[0].assignee_id = uid(2); project.total = 1
  const personalTeam = workspace(workspaceIds[2], 'Наші плани', 2)
  state = new Map([main, project, personalTeam].map(item => [item.workspace.id, item]))
  incoming = []
}
resetOrganizerPreview()

export async function loadSharedOrganizerOverview(userId: string): Promise<SharedOrganizerOverview> {
  actor(userId)
  return copy({ workspaces: [...state.values()].filter(item => item.members.some(member => member.user_id === userId)).map(item => ({ ...item.workspace, member_count: item.members.length })), invitations: incoming })
}
export async function loadSharedOrganizerWorkspace(workspaceId: string, userId: string, offset = 0, limit = 100): Promise<SharedOrganizerSnapshot> {
  const item = snapshot(workspaceId, userId)
  return copy({ ...item, workspace: { ...item.workspace, member_count: item.members.length }, tasks: item.tasks.slice(offset, offset + limit), total: item.tasks.length })
}
export async function createSharedOrganizer(name: string, userId: string): Promise<string> {
  actor(userId); if (!name.trim() || name.trim().length > 100) fail('INVALID_NAME')
  const id = crypto.randomUUID(); state.set(id, workspace(id, name.trim(), 1)); change(); return id
}
export async function renameSharedOrganizer(workspaceId: string, name: string, expectedVersion: string, userId: string): Promise<void> {
  const item = snapshot(workspaceId, userId)
  if (item.workspace.updated_at !== expectedVersion) fail('CONFLICT')
  if (!name.trim() || name.trim().length > 100) fail('INVALID_NAME')
  item.workspace.name = name.trim(); item.workspace.updated_at = stamp(); change()
}
export async function inviteSharedOrganizer(workspaceId: string, username: string, userId: string): Promise<string> {
  const item = snapshot(workspaceId, userId)
  if (item.workspace.owner_id !== userId) fail('OWNER_REQUIRED')
  const nick = username.trim().replace(/^@/, '').toLowerCase()
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,29}$/u.test(nick)) fail('INVALID_USERNAME')
  if (item.members.some(member => member.username === nick)) fail('ALREADY_MEMBER')
  if (item.invitations.some(invitation => invitation.invitee_username === nick)) fail('INVITATION_PENDING')
  if (item.members.length + item.invitations.length >= 35) fail('WORKSPACE_FULL')
  const candidates = [{ name: 'Данило Коваль', nick: 'danylo.koval', id: uid(40) }, { name: 'Ірина Мазур', nick: 'iryna.mazur', id: uid(41) }]
  const match = candidates.find(candidate => candidate.nick === nick)
  if (!match) fail('USER_NOT_FOUND')
  const id = crypto.randomUUID()
  item.invitations.push({ id, workspace_id: workspaceId, workspace_name: item.workspace.name, inviter_name: item.members[0].full_name,
    invitee_id: match!.id, invitee_name: match!.name, invitee_username: nick, created_at: stamp(), expires_at: '2026-10-31T12:00:00Z' })
  change(); return id
}
export async function respondSharedOrganizerInvitation(invitationId: string, accept: boolean, userId: string): Promise<string | null> {
  actor(userId); const invitation = incoming.find(item => item.id === invitationId)
  if (!invitation) fail('INVITATION_UNAVAILABLE')
  incoming = incoming.filter(item => item.id !== invitationId)
  if (accept) { const item = state.get(invitation!.workspace_id)!; item.members.push(person(1, item.workspace.id)); change(); return item.workspace.id }
  change(); return null
}
export async function cancelSharedOrganizerInvitation(invitationId: string, userId: string): Promise<void> {
  actor(userId)
  for (const item of state.values()) {
    if (item.workspace.owner_id === userId && item.invitations.some(invitation => invitation.id === invitationId)) {
      item.invitations = item.invitations.filter(invitation => invitation.id !== invitationId); change(); return
    }
  }
  fail('INVITATION_UNAVAILABLE')
}
export async function removeSharedOrganizerMember(workspaceId: string, targetUserId: string, userId: string): Promise<void> {
  const item = snapshot(workspaceId, userId)
  if (targetUserId === item.workspace.owner_id) fail('OWNER_CANNOT_LEAVE')
  if (item.workspace.owner_id !== userId && targetUserId !== userId) fail('OWNER_REQUIRED')
  item.members = item.members.filter(member => member.user_id !== targetUserId); change()
}
export async function saveSharedOrganizerTask(workspaceId: string, input: SharedOrganizerTaskInput, userId: string): Promise<SharedOrganizerTask> {
  const item = snapshot(workspaceId, userId)
  const previous = input.id ? item.tasks.find(task => task.id === input.id) : null
  if (input.id && !previous) fail('TASK_UNAVAILABLE')
  if (previous && input.updated_at !== previous.updated_at) fail('CONFLICT')
  if (!input.title.trim() || input.title.trim().length > 200) fail('INVALID_TASK')
  if (input.assignee_id && !item.members.some(member => member.user_id === input.assignee_id && member.is_premium)) fail('ASSIGNEE_UNAVAILABLE')
  const at = stamp()
  const result: SharedOrganizerTask = { ...input, id: previous?.id || crypto.randomUUID(), workspace_id: workspaceId,
    title: input.title.trim(), created_by: previous?.created_by || userId, updated_by: userId, created_at: previous?.created_at || at, updated_at: at }
  if (previous) item.tasks = item.tasks.map(task => task.id === result.id ? result : task)
  else item.tasks.unshift(result)
  change(); return copy(result)
}
export async function deleteSharedOrganizerTask(workspaceId: string, taskId: string, expectedVersion: string, userId: string): Promise<void> {
  const item = snapshot(workspaceId, userId), previous = item.tasks.find(task => task.id === taskId)
  if (!previous) fail('TASK_UNAVAILABLE')
  if (previous!.updated_at !== expectedVersion) fail('CONFLICT')
  item.tasks = item.tasks.filter(task => task.id !== taskId); change()
}
export async function archiveSharedOrganizer(workspaceId: string, expectedVersion: string, userId: string): Promise<void> {
  const item = snapshot(workspaceId, userId)
  if (item.workspace.updated_at !== expectedVersion) fail('CONFLICT')
  if (item.workspace.owner_id !== userId) fail('OWNER_REQUIRED')
  state.delete(workspaceId); change()
}
