import { supabase } from './supabase'
import { chatRpc, chatError } from './chatSpaces'

export type PublicationKind = 'poll' | 'article'
export interface ChatPoll {
  id: string; question: string; options: { id: number; text: string; votes: number }[]
  anonymous: boolean; allows_multiple: boolean; closes_at: string | null; closed_at: string | null
  is_closed: boolean; total_voters: number; my_votes: number[]; can_close: boolean
  updated_at?: string
}
export interface ChatArticle {
  id: string; title: string; body: string; excerpt: string; cover_path: string | null
  updated_at: string; can_edit: boolean
}
export interface ChatPublication {
  id: string; kind: PublicationKind; post_id: string | null; message_id: string | null
  poll?: ChatPoll | null; article?: ChatArticle | null; updated_at?: string
}
export interface PublicationTarget {
  spaceId?: string; conversationId?: string; parentPostId?: string | null; replyTo?: string | null
}
export interface PollContent {
  question: string; options: string[]; anonymous: boolean; allows_multiple: boolean; closes_at: string | null
}
export interface ArticleContent { title: string; body: string; cover_path: string | null }

export function publicationError(error: unknown): string {
  const message = (error as { message?: string })?.message || ''
  const codes: Record<string, string> = {
    PARTICIPANT_REQUIRED: 'Для створення й редагування потрібна активна підписка «Учасник».',
    CHAT_PARTICIPANT_REQUIRED: 'Для створення й редагування потрібна активна підписка «Учасник».',
    CHAT_POLL_CLOSED: 'Це опитування вже завершене.', POLL_CLOSED: 'Це опитування вже завершене.',
    CHAT_POLL_ANONYMOUS: 'Це анонімне опитування. Імена тих, хто голосував, приховані.', POLL_ANONYMOUS: 'Імена в анонімному опитуванні приховані.',
    CHAT_PUBLICATION_NOT_FOUND: 'Ця публікація більше не доступна.',
    CHAT_PUBLICATION_INVALID_INPUT: 'Перевірте заповнені поля публікації та час завершення.',
    CHAT_POLL_INVALID_OPTIONS: 'Оберіть доступні варіанти відповіді.',
    CHAT_POLL_SINGLE_OPTION: 'У цьому опитуванні можна обрати лише одну відповідь.',
    CHAT_PUBLICATION_AUTHOR_REQUIRED: 'Ця дія доступна автору або адміністратору публікації.',
    CHAT_PUBLICATION_EDIT_FORBIDDEN: 'Ви більше не маєте права публікувати в цій переписці.',
    CHAT_INVALID_POLL: 'Перевірте питання, варіанти відповіді та час завершення.',
    CHAT_INVALID_ARTICLE: 'Перевірте заголовок, текст і зображення статті.',
    CHAT_PUBLICATION_EDIT_REQUIRED: 'Цю публікацію потрібно редагувати через її власне меню.',
  }
  for (const [code, text] of Object.entries(codes)) if (message.includes(code)) return text
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes((error as { code?: string })?.code || '')) return 'Опитування та статті ще не підключені. Оновлення платформи готується.'
  return chatError(error)
}

export async function loadChatPublications(postIds: string[] = [], messageIds: string[] = []): Promise<ChatPublication[]> {
  const posts = [...new Set(postIds.filter(Boolean))]
  const messages = [...new Set(messageIds.filter(Boolean))]
  const results: ChatPublication[] = []
  for (let offset = 0; offset < Math.max(posts.length, messages.length); offset += 100) {
    const data = await chatRpc<ChatPublication[]>('xelay_chat_publications', {
      p_post_ids: posts.slice(offset, offset + 100), p_message_ids: messages.slice(offset, offset + 100),
    })
    results.push(...(data || []))
  }
  return results
}
export async function publishChatContent(kind: PublicationKind, content: PollContent | ArticleContent, target: PublicationTarget) {
  return chatRpc<ChatPublication>('xelay_chat_publish', {
    p_kind: kind, p_content: content, p_space_id: target.spaceId || null,
    p_conversation_id: target.conversationId || null, p_parent_post_id: target.parentPostId || null, p_reply_to: target.replyTo || null,
  })
}
export async function editChatArticle(id: string, content: ArticleContent) {
  return chatRpc<ChatArticle>('xelay_chat_article_edit', {
    p_article_id: id, p_title: content.title, p_body: content.body, p_cover_path: content.cover_path,
  })
}
export async function uploadArticleCover(userId: string, file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('CHAT_INVALID_ARTICLE')
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type]
  const path = `${userId}/${crypto.randomUUID()}/cover.${extension}`
  const result = await supabase.storage.from('xelay-chat-media').upload(path, file, { contentType: file.type, upsert: false })
  if (result.error) throw result.error
  return path
}
export async function discardArticleCover(path: string) {
  if (path) await supabase.storage.from('xelay-chat-media').remove([path])
}
