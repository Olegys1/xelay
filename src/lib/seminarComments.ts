import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'

export const SEMINAR_COMMENT_MAX_LENGTH = 4000
export const SEMINAR_COMMENT_PAGE_SIZE = 50

export type SeminarComment = {
  id: string
  group_id: string
  seminar_id: string
  author_id: string
  body: string
  created_at: string
  updated_at: string
}

export type SeminarCommentProfile = {
  id: string
  full_name: string | null
  username: string | null
  avatar_url: string | null
}

export type SeminarCommentsData = {
  comments: SeminarComment[]
  profiles: Record<string, SeminarCommentProfile>
  hasMore: boolean
  membershipId: string | null
}

const COMMENT_ERRORS: Record<string, string> = {
  SEMINAR_AUTH_REQUIRED: 'Увійдіть знову, щоб працювати з коментарями.',
  SEMINAR_MEMBER_REQUIRED: 'Коментарі доступні лише учасникам із доступом до цієї групи.',
  SEMINAR_NOT_FOUND: 'Це завдання вже видалене або недоступне.',
  SEMINAR_COMMENT_NOT_FOUND: 'Коментар уже видалено або він недоступний. Оновіть обговорення.',
  SEMINAR_COMMENT_INVALID_INPUT: 'Напишіть коментар від 1 до 4000 символів.',
  SEMINAR_COMMENT_OWNER_REQUIRED: 'Редагувати можна лише власний коментар. Для видалення чужих коментарів потрібне право модерації семінарів.',
  STUDY_GROUP_PERMISSION_REQUIRED: 'Для цієї дії потрібне право модерації коментарів семінарів. Оновіть сторінку та перевірте доступ.',
  GROUP_LICENSE_REQUIRED: 'Для нових коментарів потрібен активний доступ навчальної групи.',
}

export function seminarCommentError(error: unknown) {
  const item = error as { code?: string; message?: string } | null
  if (['PGRST205', '42P01', 'PGRST202', '42883'].includes(item?.code || '')) {
    return 'Коментарі до семінарів ще не підключені. Потрібно застосувати нову міграцію семінарів у Supabase та оновити сторінку.'
  }
  const code = Object.keys(COMMENT_ERRORS).find((key) => item?.message?.includes(key))
  return code ? COMMENT_ERRORS[code] : 'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз.'
}

export function seminarCommentAccessLost(error: unknown) {
  const item = error as { code?: string; message?: string } | null
  return item?.code === '42501' || ['SEMINAR_AUTH_REQUIRED', 'SEMINAR_MEMBER_REQUIRED', 'SEMINAR_NOT_FOUND'].some((code) => item?.message?.includes(code))
}

async function assertCommentAccess(groupId: string) {
  const result = await supabase.rpc('xelay_can_view_seminars', { p_group_id: groupId })
  if (result.error) throw result.error
  if (result.data !== true) throw { message: 'SEMINAR_MEMBER_REQUIRED' }
}

// Pages use a stable (created_at, id) cursor rather than an offset. A new
// comment arriving during a refresh cannot shift an older page or duplicate it.
export async function loadSeminarComments(groupId: string, seminarId: string, currentUserId: string, pageCount = 1): Promise<SeminarCommentsData> {
  await assertCommentAccess(groupId)
  const [seminarResult, membershipResult] = await Promise.all([
    supabase.from('study_group_seminars').select('id').eq('id', seminarId).eq('group_id', groupId).maybeSingle(),
    supabase.from('study_group_members').select('id').eq('group_id', groupId).eq('user_id', currentUserId).eq('status', 'accepted').maybeSingle(),
  ])
  if (seminarResult.error) throw seminarResult.error
  if (!seminarResult.data) throw { message: 'SEMINAR_NOT_FOUND' }
  if (membershipResult.error) throw membershipResult.error

  const comments: SeminarComment[] = []
  let hasMore = false
  let cursor: SeminarComment | undefined
  for (let page = 0; page < Math.max(1, pageCount); page += 1) {
    let query = supabase.from('study_group_seminar_comments')
      .select('id,group_id,seminar_id,author_id,body,created_at,updated_at')
      .eq('group_id', groupId).eq('seminar_id', seminarId)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(SEMINAR_COMMENT_PAGE_SIZE + 1)
    if (cursor) {
      // Values originate from database UUID/timestamptz columns, not user input.
      query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
    }
    const result = await query
    if (result.error) throw result.error
    const rows = (result.data || []) as SeminarComment[]
    hasMore = rows.length > SEMINAR_COMMENT_PAGE_SIZE
    const pageComments = rows.slice(0, SEMINAR_COMMENT_PAGE_SIZE)
    comments.push(...pageComments)
    cursor = pageComments[pageComments.length - 1]
    if (!hasMore || !cursor) break
  }
  const profiles = await getPublicProfiles(comments.map((comment) => comment.author_id))
  if (profiles.error) throw profiles.error
  // Do not retain loaded private text if membership was withdrawn mid-request.
  await assertCommentAccess(groupId)
  return {
    comments: comments.reverse(),
    profiles: Object.fromEntries((profiles.data as SeminarCommentProfile[]).map((profile) => [profile.id, profile])),
    hasMore,
    membershipId: membershipResult.data?.id || null,
  }
}

function validateBody(body: string) {
  const value = body.trim()
  if (!value || [...value].length > SEMINAR_COMMENT_MAX_LENGTH) throw { message: 'SEMINAR_COMMENT_INVALID_INPUT' }
  return value
}

export async function addSeminarComment(seminarId: string, body: string) {
  const result = await supabase.rpc('xelay_add_seminar_comment', { p_seminar_id: seminarId, p_body: validateBody(body) })
  if (result.error) throw result.error
  return result.data as string
}

export async function updateSeminarComment(commentId: string, body: string) {
  const result = await supabase.rpc('xelay_update_seminar_comment', { p_comment_id: commentId, p_body: validateBody(body) })
  if (result.error) throw result.error
}

export async function deleteSeminarComment(commentId: string) {
  const result = await supabase.rpc('xelay_delete_seminar_comment', { p_comment_id: commentId })
  if (result.error) throw result.error
}
