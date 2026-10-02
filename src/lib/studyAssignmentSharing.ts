import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'
import { announceChatUpdate, chatError, chatRpc, signChatSpaces, type ChatInbox } from './chatSpaces'

export type StudyAssignmentKind = 'seminar' | 'homework'
export interface StudyAssignmentShare {
  kind: StudyAssignmentKind
  id: string
  groupId: string
  groupName: string
  title: string
  subject: string
  date: string
}
export interface StudyAssignmentLink {
  kind: StudyAssignmentKind
  id: string
  groupId: string
  date: string
  href: string
}
export type StudyShareTargetKind = 'personal' | 'group' | 'channel'
export interface StudyShareTarget {
  id: string
  kind: StudyShareTargetKind
  name: string
  username: string | null
  avatarUrl: string | null
  peerId?: string
}
export interface StudyShareTargets {
  targets: StudyShareTarget[]
  warnings: string[]
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const canonicalHosts = new Set(['xelay.ink', 'www.xelay.ink'])

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function validAssignment(assignment: Pick<StudyAssignmentShare, 'kind' | 'id' | 'groupId' | 'date'>) {
  return ['seminar', 'homework'].includes(assignment.kind) && UUID.test(assignment.id) && UUID.test(assignment.groupId) && validDate(assignment.date)
}
function oneLine(value: string, limit: number) {
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function studyAssignmentUrl(assignment: Pick<StudyAssignmentShare, 'kind' | 'id' | 'groupId' | 'date'>) {
  if (!validAssignment(assignment)) throw new Error('STUDY_SHARE_INVALID_ASSIGNMENT')
  const url = new URL(`/groups/${assignment.groupId}`, window.location.origin)
  url.searchParams.set('tab', assignment.kind === 'seminar' ? 'seminars' : 'schedule')
  url.searchParams.set('date', assignment.date)
  url.searchParams.set('assignment', assignment.id)
  url.searchParams.set('kind', assignment.kind)
  return url.toString()
}

export function studyAssignmentShareBody(assignment: StudyAssignmentShare) {
  const url = studyAssignmentUrl(assignment)
  const title = oneLine(assignment.title, 200) || (assignment.kind === 'seminar' ? 'Завдання семінару' : 'Домашнє завдання')
  const date = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv' }).format(new Date(`${assignment.date}T12:00:00Z`))
  return [
    `${assignment.kind === 'seminar' ? 'Семінар' : 'Домашнє завдання'} · ${title}`,
    `Предмет: ${oneLine(assignment.subject, 200) || 'Навчальне завдання'}`,
    `Група: ${oneLine(assignment.groupName, 150) || 'Навчальна група'}`,
    `Дата: ${date}`,
    url,
  ].join('\n')
}

// Only internal links get an assignment action in a chat. A link conveys no
// membership or storage access; the destination still loads through group RLS.
export function parseStudyAssignmentLink(body: string): StudyAssignmentLink | null {
  const links = body.matchAll(/(?:^|[\s(])((?:https?:\/\/[^\s<>"']+)|(?:\/groups\/[0-9a-f-]+\?[^\s<>"']+))/gi)
  for (const candidate of links) {
    try {
      const token = candidate[1]
      const url = new URL(token.replace(/[),.!;]+$/, ''), window.location.origin)
      if (url.username || url.password || url.hash) continue
      if (url.origin !== window.location.origin && !(url.protocol === 'https:' && canonicalHosts.has(url.hostname) && !url.port)) continue
      const match = url.pathname.match(/^\/groups\/([0-9a-f-]+)\/?$/i)
      const kind = url.searchParams.get('kind')
      const id = url.searchParams.get('assignment') || ''
      const date = url.searchParams.get('date') || ''
      if (!match || !kind || !['seminar', 'homework'].includes(kind)) continue
      if (url.searchParams.get('tab') !== (kind === 'seminar' ? 'seminars' : 'schedule')) continue
      if (['kind', 'assignment', 'date', 'tab'].some((key) => url.searchParams.getAll(key).length !== 1)) continue
      const assignment = { kind: kind as StudyAssignmentKind, id, groupId: match[1], date }
      if (!validAssignment(assignment)) continue
      const normalized = new URL(studyAssignmentUrl(assignment))
      return { ...assignment, href: `${normalized.pathname}${normalized.search}` }
    } catch { /* An invalid or external link remains ordinary message text. */ }
  }
  return null
}

async function requireIdentity(userId: string) {
  const result = await supabase.auth.getSession()
  if (result.error || result.data.session?.user.id !== userId) throw new Error('STUDY_SHARE_AUTH_REQUIRED')
}
async function loadPersonalTargets(userId: string): Promise<StudyShareTargets> {
  const conversations: { id: string; user_one_id: string; user_two_id: string }[] = []
  const acceptedPairs = new Set<string>()
  // Page both lists instead of silently dropping contacts after PostgREST's
  // default response limit. Conversations originate from accepted requests.
  await Promise.all([
    (async () => {
      for (let offset = 0; ; offset += 500) {
        const result = await supabase.from('conversations').select('id, user_one_id, user_two_id')
          .or(`user_one_id.eq.${userId},user_two_id.eq.${userId}`).order('created_at', { ascending: false }).order('id').range(offset, offset + 499)
        if (result.error) throw result.error
        conversations.push(...(result.data || []))
        if ((result.data || []).length < 500) break
      }
    })(),
    (async () => {
      for (let offset = 0; ; offset += 500) {
        const result = await supabase.from('connection_requests').select('id, requester_id, recipient_id').eq('status', 'accepted')
          .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`).order('id').range(offset, offset + 499)
        if (result.error) throw result.error
        for (const row of result.data || []) acceptedPairs.add(row.requester_id === userId ? row.recipient_id : row.requester_id)
        if ((result.data || []).length < 500) break
      }
    })(),
  ])
  const rows = conversations.filter((row) => acceptedPairs.has(row.user_one_id === userId ? row.user_two_id : row.user_one_id))
  const peerIds = rows.map((row) => row.user_one_id === userId ? row.user_two_id : row.user_one_id)
  const people = await getPublicProfiles(peerIds)
  if (people.error) throw people.error
  const profiles = new Map(people.data.map((profile) => [profile.id, profile]))
  return {
    targets: rows.map((row) => {
      const peerId = row.user_one_id === userId ? row.user_two_id : row.user_one_id
      const profile = profiles.get(peerId)
      return { id: row.id, kind: 'personal', peerId, name: profile?.full_name || profile?.username || 'Учасник Xelay', username: profile?.username || null, avatarUrl: profile?.avatar_url || null }
    }),
    warnings: [],
  }
}
async function loadCommunityTargets(): Promise<StudyShareTargets> {
  const inbox = await chatRpc<ChatInbox>('xelay_chat_inbox')
  const eligible = (inbox.spaces || []).filter((space) => space.kind === 'group' || (space.kind === 'channel' && ['owner', 'admin'].includes(space.my_role || '')))
  const spaces = await signChatSpaces(eligible)
  return { targets: spaces.map((space) => ({ id: space.id, kind: space.kind, name: space.name, username: space.username, avatarUrl: space.avatar_url || null })), warnings: [] }
}

export async function loadStudyShareTargets(userId: string): Promise<StudyShareTargets> {
  if (!UUID.test(userId)) throw new Error('STUDY_SHARE_AUTH_REQUIRED')
  await requireIdentity(userId)
  const results = await Promise.allSettled([loadPersonalTargets(userId), loadCommunityTargets()])
  await requireIdentity(userId)
  const targets: StudyShareTarget[] = []
  const warnings: string[] = []
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.status === 'fulfilled') targets.push(...result.value.targets)
    else warnings.push(index === 0 ? 'Не вдалося завантажити особисті чати. Спробуйте оновити список.' : 'Не вдалося завантажити групи й канали. Спробуйте оновити список.')
  }
  if (results.every((result) => result.status === 'rejected')) throw new Error('STUDY_SHARE_LOAD_FAILED')
  return { targets, warnings }
}

export async function sendStudyAssignment(assignment: StudyAssignmentShare, target: StudyShareTarget, userId: string) {
  if (!UUID.test(userId) || !UUID.test(target.id)) throw new Error('STUDY_SHARE_AUTH_REQUIRED')
  await requireIdentity(userId)
  const body = studyAssignmentShareBody(assignment)
  const source = await supabase.from(assignment.kind === 'seminar' ? 'study_group_seminars' : 'study_group_homework')
    .select('id').eq('id', assignment.id).eq('group_id', assignment.groupId).eq('lesson_date', assignment.date).maybeSingle()
  if (source.error) throw source.error
  if (!source.data) throw new Error('STUDY_SHARE_INVALID_ASSIGNMENT')
  await requireIdentity(userId)
  if (target.kind === 'personal') {
    if (!target.peerId || !UUID.test(target.peerId) || target.peerId === userId) throw new Error('STUDY_SHARE_CHAT_UNAVAILABLE')
    const result = await supabase.from('messages').insert({ conversation_id: target.id, sender_id: userId, recipient_id: target.peerId, body }).select('id').single()
    if (result.error) throw result.error
  } else {
    await chatRpc('xelay_chat_send', { p_space_id: target.id, p_body: body, p_parent_post_id: null, p_reply_to: null, p_attachments: [], p_shared_news_post_id: null })
  }
  announceChatUpdate()
}

export function studyAssignmentSharingError(error: unknown) {
  const value = error as { code?: string; message?: string }
  if (value?.message === 'STUDY_SHARE_AUTH_REQUIRED') return 'Увійдіть у свій профіль, щоб надіслати завдання.'
  if (value?.message === 'STUDY_SHARE_INVALID_ASSIGNMENT') return 'Це завдання більше не доступне. Оновіть сторінку.'
  if (value?.message === 'STUDY_SHARE_LOAD_FAILED') return 'Не вдалося завантажити чати. Спробуйте ще раз.'
  if (value?.message === 'STUDY_SHARE_CHAT_UNAVAILABLE' || value?.code === '42501') return 'Цей чат більше не доступний для надсилання. Оновіть список чатів.'
  if (value?.message?.includes('CHAT_')) return chatError(error)
  return 'Не вдалося надіслати завдання. Перевірте з’єднання та спробуйте ще раз.'
}
