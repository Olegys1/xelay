import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'
import { isValidUserSearch, normalizeUserSearch, parseUserSearchResult } from './userSearch'
import type { ChatPublication } from './chatPublications'

export type ChatSpaceKind = 'group' | 'channel'
export type ChatSpaceRole = 'owner' | 'admin' | 'member'
export interface ChatSpace {
  id: string; kind: ChatSpaceKind; visibility: 'public' | 'private'; username: string | null
  name: string; description: string; avatar_path: string | null; avatar_url?: string | null; owner_id: string | null
  system_kind?: 'faculty' | null; university_id?: string | null; academic_unit_id?: string | null
  comments_enabled: boolean; join_approval: boolean; history_visible: boolean
  created_at: string; updated_at: string; member_count: number
  my_role?: ChatSpaceRole | null; my_muted?: boolean; unread_count?: number; last_post?: ChatPost | null
}
export interface ChatMember {
  space_id: string; user_id: string; role: ChatSpaceRole; status: 'active' | 'left' | 'banned'
  joined_at: string; last_read_at: string | null; muted: boolean; visible_from: string | null
  is_platform_admin?: boolean
}
export interface ChatProfile { id: string; full_name: string | null; username: string | null; avatar_url: string | null }
export interface ChatAttachment {
  id?: string; storage_path: string; file_name: string; mime_type: string; file_size: number
  media_type?: 'image' | 'video' | 'file'; url?: string
}
export interface ChatPost {
  id: string; space_id: string; sender_id: string; body: string; created_at: string; updated_at?: string
  edited_at?: string | null; deleted_at?: string | null; parent_post_id: string | null; reply_to: string | null
  shared_news_post_id?: string | null; attachments: ChatAttachment[]; reactions: { emoji: string; user_id: string }[]; comment_count: number; is_pinned_for_me?: boolean
  publication?: ChatPublication | null
}
export interface ChatInvitation {
  id: string; space_id: string; user_id: string; invited_by: string; status: string; created_at: string; space?: ChatSpace
}
export interface ChatJoinRequest { id: string; space_id: string; user_id: string; status: string; created_at: string }
export interface ChatInviteLink { id: string; space_id: string; token?: string; expires_at: string | null; max_uses: number | null; used_count: number; revoked_at: string | null }
export interface ChatSpaceDetail {
  space: ChatSpace; my_membership: ChatMember | null; members: ChatMember[]; invitations: ChatInvitation[]
  join_requests: ChatJoinRequest[]; invite_links: ChatInviteLink[]; pins: ChatPost[]; personal_pins?: ChatPost[]; is_admin?: boolean
  can_manage_admins?: boolean
}
export interface ChatInbox { spaces: ChatSpace[]; invitations: ChatInvitation[]; join_requests?: (ChatJoinRequest & { space: ChatSpace })[] }
export interface FacultyChat { space: ChatSpace | null; my_membership: ChatMember | null }

export const CHAT_MEDIA_BUCKET = 'xelay-chat-media'
export const CHAT_AVATAR_BUCKET = CHAT_MEDIA_BUCKET
export const CHAT_MAX_FILES = 10
export const CHAT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const CHAT_MAX_TOTAL_BYTES = 100 * 1024 * 1024
const safeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'text/plain', 'text/csv', 'application/rtf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/x-zip-compressed'])

export async function chatRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const result = await supabase.rpc(name, args)
  if (result.error) throw result.error
  return result.data as T
}

export function chatError(error: unknown): string {
  const value = error as { code?: string; message?: string }
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(value?.code || '')) return 'Групи й канали ще не підключені. Потрібно виконати міграцію чатів у Supabase.'
  const message = value?.message || ''
  const translations: Record<string, string> = {
    CHAT_AUTH_REQUIRED: 'Увійдіть у профіль, щоб продовжити.', CHAT_MEMBER_REQUIRED: 'Цей чат доступний лише його учасникам.',
    CHAT_ADMIN_REQUIRED: 'Ця дія доступна адміністратору.', CHAT_OWNER_REQUIRED: 'Ця дія доступна власнику.',
    CHAT_NOT_FOUND: 'Чат або повідомлення більше не доступні.', CHAT_BANNED: 'Доступ до цього чату обмежений адміністратором.',
    CHAT_USERNAME_TAKEN: 'Цей публічний адрес уже зайнятий. Спробуйте інший.', CHAT_INVALID_INPUT: 'Перевірте заповнені поля.',
    CHAT_INVITE_EXPIRED: 'Запрошення більше не діє. Попросіть нове посилання.', CHAT_INVITE_INVALID: 'Посилання-запрошення недійсне.',
    CHAT_OWNER_CANNOT_LEAVE: 'Спершу передайте право власності іншому учаснику.', CHAT_COMMENTS_DISABLED: 'Власник вимкнув коментарі.',
    CHAT_RATE_LIMIT: 'Забагато дій за короткий час. Спробуйте трохи пізніше.', CHAT_POST_FORBIDDEN: 'Ви не маєте права публікувати тут.',
    CHAT_ALREADY_MEMBER: 'Ця людина вже є учасником.', CHAT_SELF_INVITE: 'Ви вже є учасником цього чату.',
    CHAT_MEMBER_LIMIT: 'У цьому чаті вже максимальна кількість учасників.', CHAT_SPACE_LIMIT: 'Ви вже створили максимальну кількість спільнот.',
    CHAT_LINK_LIMIT: 'Спершу вимкніть невикористані посилання-запрошення.', CHAT_PIN_LIMIT: 'Можна закріпити до 10 повідомлень. Спершу відкріпіть одне з попередніх.',
    CHAT_LINK_INVALID: 'Це посилання більше не діє. Попросіть адміністратора створити нове.', CHAT_INVALID_USERNAME: 'Адрес має містити 4–32 латинські літери, цифри або _. Перший символ — літера.',
    CHAT_INVITE_REQUIRED: 'Для вступу потрібне запрошення адміністратора.', CHAT_TRANSFER_REQUIRED: 'Перед виходом передайте право власності іншому учаснику.',
    CHAT_INVITATION_CLOSED: 'Це запрошення вже оброблено або скасовано.', CHAT_INVITATION_NOT_FOUND: 'Це запрошення більше не доступне.',
    CHAT_REQUEST_CLOSED: 'Заявку вже оброблено або скасовано.', CHAT_REQUEST_NOT_FOUND: 'Ця заявка більше не доступна.',
    CHAT_POST_NOT_FOUND: 'Повідомлення більше не доступне.', CHAT_POST_OWNER_REQUIRED: 'Змінювати це повідомлення може його автор.',
    CHAT_MEMBER_NOT_FOUND: 'Ця людина більше не є учасником чату.', CHAT_PROTECTED_MEMBER: 'Ця дія недоступна для власника або адміністратора.',
    CHAT_PROTECTED_PLATFORM_ADMIN: 'Права адміністратора платформи не можна змінити в цьому чаті.',
    CHAT_INVALID_PARENT: 'Публікація для коментаря більше не доступна.', CHAT_INVALID_REPLY: 'Повідомлення для відповіді більше не доступне.',
    CHAT_INVALID_MEDIA: 'Не вдалося прикріпити файл. Перевірте його формат і розмір.', CHAT_ATTACHMENT_LIMIT: 'До 10 файлів, кожен до 25 МБ, загалом до 100 МБ.',
    CHAT_NEWS_ACCESS_DENIED: 'Цю новину зараз неможливо переслати.', CHAT_EMPTY_POST: 'Додайте текст або вкладення.', CHAT_INVALID_REACTION: 'Ця реакція недоступна.',
    CHAT_FACULTY_SCOPE_REQUIRED: 'Оберіть університет і факультет у профілі. Цей чат доступний лише учасникам відповідного факультету.',
    CHAT_SYSTEM_MANAGED: 'Це спільний чат факультету. Його назва, тип і доступ закріплені за факультетом.',
    CHAT_PERSONAL_PIN_LIMIT: 'Можна зберегти до 20 повідомлень у цьому чаті. Спершу приберіть одне з попередніх.',
  }
  for (const [code, text] of Object.entries(translations)) if (message.includes(code)) return text
  return 'Не вдалося виконати дію. Оновіть сторінку та спробуйте ще раз.'
}

export async function searchChatSpaces(term: string, kind?: ChatSpaceKind, signal?: AbortSignal): Promise<ChatSpace[]> {
  let request = supabase.rpc('xelay_chat_search', { p_query: term.trim().replace(/^@/, ''), p_kind: kind || null, p_limit: 20 })
  if (signal) request = request.abortSignal(signal)
  const result = await request
  if (result.error) throw result.error
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return signChatSpaces((result.data || []) as ChatSpace[])
}
export async function loadChatProfiles(ids: (string | null | undefined)[]): Promise<Record<string, ChatProfile>> {
  const profileIds = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!profileIds.length) return {}
  const result = await getPublicProfiles(profileIds)
  if (result.error) throw result.error
  return Object.fromEntries((result.data || []).map((profile) => [profile.id, profile]))
}
export async function loadFacultyChat(rejoin = false): Promise<FacultyChat> {
  const result = await chatRpc<FacultyChat>('xelay_chat_faculty', { p_rejoin: rejoin })
  if (!result?.space) return { space: null, my_membership: null }
  const [space] = await signChatSpaces([result.space])
  return { space, my_membership: result.my_membership || null }
}
export async function pinChatPostForMe(postId: string, pin: boolean): Promise<void> {
  await chatRpc('xelay_chat_pin_for_me', { p_post_id: postId, p_pin: pin })
}
export async function loadChatContacts(userId: string): Promise<ChatProfile[]> {
  const result = await supabase.from('conversations').select('user_one_id, user_two_id').or(`user_one_id.eq.${userId},user_two_id.eq.${userId}`).limit(100)
  if (result.error) throw result.error
  const ids = (result.data || []).map((row) => row.user_one_id === userId ? row.user_two_id : row.user_one_id)
  return Object.values(await loadChatProfiles(ids))
}
export async function searchChatInvitees(query: string) {
  const term = normalizeUserSearch(query)
  if (!isValidUserSearch(term)) throw new Error('CHAT_INVALID_INPUT')
  const data = await chatRpc<unknown>('xelay_search_users', { p_query: term })
  return parseUserSearchResult(data)
}
export function chatAvatarUrl(space: ChatSpace): string | null {
  return space.avatar_url || null
}
export function validateChatFiles(files: File[]) {
  if (files.length > CHAT_MAX_FILES) return `Можна прикріпити не більше ${CHAT_MAX_FILES} файлів.`
  if (files.some((file) => !safeTypes.has(file.type))) return 'Оберіть фото, відео, PDF, текстовий документ, офісний файл або ZIP.'
  if (files.some((file) => file.size > CHAT_MAX_FILE_BYTES)) return 'Один файл має бути до 25 МБ.'
  if (files.reduce((sum, file) => sum + file.size, 0) > CHAT_MAX_TOTAL_BYTES) return 'Загальний розмір файлів має бути до 100 МБ.'
  return ''
}
export async function uploadChatFiles(spaceId: string, userId: string, files: File[]): Promise<ChatAttachment[]> {
  const validation = validateChatFiles(files)
  if (validation) throw new Error(validation)
  const uploaded: ChatAttachment[] = []
  try {
    for (const file of files) {
      const extension = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'bin'
      const storage_path = `${userId}/${crypto.randomUUID()}/file.${extension}`
      const result = await supabase.storage.from(CHAT_MEDIA_BUCKET).upload(storage_path, file, { contentType: file.type, upsert: false })
      if (result.error) throw result.error
      uploaded.push({ storage_path, file_name: file.name.slice(0, 240), mime_type: file.type, file_size: file.size, media_type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file' })
    }
    return uploaded
  } catch (error) {
    if (uploaded.length) await discardChatFiles(uploaded)
    throw error
  }
}
export async function discardChatFiles(files: ChatAttachment[]) {
  if (files.length) await supabase.storage.from(CHAT_MEDIA_BUCKET).remove(files.map((file) => file.storage_path))
}
const mediaUrls = new Map<string, { url: string; expires: number }>()
export async function signChatSpaces(spaces: ChatSpace[]): Promise<ChatSpace[]> {
  const paths = [...new Set(spaces.map((space) => space.avatar_path).filter(Boolean))] as string[]
  const result = paths.length ? await supabase.storage.from(CHAT_MEDIA_BUCKET).createSignedUrls(paths, 600) : { data: [], error: null }
  const urls = new Map((result.data || []).map((item) => [item.path, item.signedUrl]))
  return spaces.map((space) => ({ ...space, avatar_url: space.avatar_path ? urls.get(space.avatar_path) || null : null }))
}
export async function signChatPosts(posts: ChatPost[]): Promise<ChatPost[]> {
  const paths = [...new Set(posts.flatMap((post) => (post.attachments || []).map((file) => file.storage_path)))]
  const missing = paths.filter((path) => (mediaUrls.get(path)?.expires || 0) <= Date.now() + 60_000)
  if (missing.length) {
    const result = await supabase.storage.from(CHAT_MEDIA_BUCKET).createSignedUrls(missing, 10 * 60)
    for (const item of result.data || []) if (item.path && item.signedUrl) mediaUrls.set(item.path, { url: item.signedUrl, expires: Date.now() + 9 * 60_000 })
  }
  for (const [path, item] of mediaUrls) if (item.expires <= Date.now()) mediaUrls.delete(path)
  return posts.map((post) => ({ ...post, attachments: (post.attachments || []).map((file) => ({ ...file, url: mediaUrls.get(file.storage_path)?.url || '' })), reactions: post.reactions || [] }))
}

export function chatInviteUrl(token: string) {
  const url = new URL('/messages', window.location.origin)
  url.searchParams.set('invite', token)
  return url.toString()
}
export function clearChatMediaCache() { mediaUrls.clear() }
export function announceChatUpdate() { window.dispatchEvent(new Event('xelay-chat-updated')) }
