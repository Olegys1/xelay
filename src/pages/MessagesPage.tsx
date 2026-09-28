import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Loader2, MessageCircle, Reply, Send, Smile, Trash2, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { AuthModal } from '../components/AuthModal'

interface ProfileSummary {
  id: string
  full_name: string
  avatar_url: string | null
  faculty: string | null
  specialty: string | null
}

interface MessageRecord {
  id: string
  conversation_id: string
  sender_id: string
  recipient_id: string
  body: string
  created_at: string
  read_at: string | null
  shared_post_id: string | null
  reply_to_message_id: string | null
  deleted_at: string | null
}

interface MessageReaction {
  id: string
  message_id: string
  user_id: string
  emoji: string
}

interface ConversationSummary {
  id: string
  peer: ProfileSummary
  lastMessage: MessageRecord | null
  unreadCount: number
}

export function MessagesPage() {
  const { authUser, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const currentUserId = authUser?.id || ''
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [reactions, setReactions] = useState<Record<string, MessageReaction[]>>({})
  const [replyingTo, setReplyingTo] = useState<MessageRecord | null>(null)
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null)
  const [interactionsAvailable, setInteractionsAvailable] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const interactionSchemaChecked = useRef(false)

  const loadReactions = useCallback(async (messageIds: string[]) => {
    if (!messageIds.length) {
      const { error: schemaError } = await supabase.from('message_reactions').select('id').limit(1)
      setReactions({})
      return !schemaError
    }
    let reactionQuery = supabase
      .from('message_reactions')
      .select('id, message_id, user_id, emoji')
    if (messageIds.length) reactionQuery = reactionQuery.in('message_id', messageIds)
    const { data, error: reactionsError } = await reactionQuery.limit(500)
    if (reactionsError) {
      console.error('Could not load message reactions:', reactionsError)
      setReactions({})
      return false
    }
    const grouped = (data || []).reduce<Record<string, MessageReaction[]>>((result, reaction: MessageReaction) => {
      result[reaction.message_id] ||= []
      result[reaction.message_id].push(reaction)
      return result
    }, {})
    setReactions(grouped)
    return true
  }, [])

  const loadConversations = useCallback(async (showSpinner = false) => {
    if (!authUser?.id) return
    if (showSpinner) setLoading(true)
    const { data, error: conversationsError } = await supabase
      .from('conversations')
      .select('id, user_one_id, user_two_id, created_at')
      .or(`user_one_id.eq.${authUser.id},user_two_id.eq.${authUser.id}`)
      .order('created_at', { ascending: false })

    if (conversationsError) {
      console.error('Could not load conversations:', conversationsError)
      setError('Не вдалося завантажити чати. Перевірте, чи застосована міграція запитів і повідомлень.')
      setLoading(false)
      return
    }

    const rows = data || []
    const peerIds = rows.map((row) => row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id)
    const profiles = peerIds.length
      ? await supabase.from('profiles').select('id, full_name, avatar_url, faculty, specialty').in('id', peerIds)
      : { data: [] }
    const profileById = new Map((profiles.data || []).map((profile: any) => [profile.id, profile as ProfileSummary]))

    const summaries = await Promise.all(rows.map(async (row) => {
      const peerId = row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id
      let [latest, unread] = await Promise.all([
        supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id, deleted_at')
          .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('conversation_id', row.id).eq('recipient_id', authUser.id).is('read_at', null),
      ])
      if (latest.error) {
        let legacyLatest = await supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
          .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (legacyLatest.error) {
          legacyLatest = await supabase.from('messages')
            .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
            .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle() as typeof legacyLatest
        }
        latest = { ...legacyLatest, data: legacyLatest.data ? { ...legacyLatest.data, shared_post_id: legacyLatest.data.shared_post_id || null } : null } as typeof latest
      }
      return {
        id: row.id,
        peer: profileById.get(peerId) || { id: peerId, full_name: 'Учасник Xelay', avatar_url: null, faculty: '', specialty: '' },
        lastMessage: latest.data ? {
          ...latest.data,
          reply_to_message_id: null,
          deleted_at: (latest.data as MessageRecord).deleted_at || null,
        } : null,
        unreadCount: unread.count || 0,
      } satisfies ConversationSummary
    }))

    setConversations(summaries)
    setError('')
    setLoading(false)
  }, [authUser?.id])

  useEffect(() => {
    if (!authUser?.id) {
      setLoading(false)
      return
    }
    void loadConversations(true)
    const interval = window.setInterval(() => void loadConversations(), 5000)
    return () => window.clearInterval(interval)
  }, [authUser?.id, loadConversations])

  const loadMessages = useCallback(async (conversationId: string, showSpinner = false) => {
    if (!authUser?.id || !conversationId) return
    if (showSpinner) setThreadLoading(true)
    const messageResult = await supabase.from('messages')
      .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id, reply_to_message_id, deleted_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(100)

    let loadedMessages: any[] = []
    let messagesError = messageResult.error
    let supportsInteractionColumns = !messageResult.error
    if (messageResult.error) {
      let legacyResult = await supabase.from('messages')
        .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(100)
      if (legacyResult.error) {
        legacyResult = await supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(100) as typeof legacyResult
      }
      messagesError = legacyResult.error
      supportsInteractionColumns = false
      loadedMessages = (legacyResult.data || []).map((message) => ({ ...message, shared_post_id: message.shared_post_id || null }))
    } else {
      loadedMessages = messageResult.data || []
    }

    const data = loadedMessages.map((message: any) => ({
      ...message,
      shared_post_id: message.shared_post_id || null,
      reply_to_message_id: message.reply_to_message_id || null,
      deleted_at: message.deleted_at || null,
    })) as MessageRecord[]

    if (messagesError) {
      console.error('Could not load messages:', messagesError)
      setError('Не вдалося завантажити повідомлення.')
      setThreadLoading(false)
      return
    }

    setMessages((data || []).reverse())
    setThreadLoading(false)
    if (supportsInteractionColumns) {
      const reactionsLoaded = await loadReactions(data.map((message) => message.id))
      setInteractionsAvailable(reactionsLoaded)
      interactionSchemaChecked.current = true
    } else if (!interactionSchemaChecked.current) {
      setInteractionsAvailable(false)
      interactionSchemaChecked.current = true
      setReactions({})
    } else {
      setInteractionsAvailable(false)
    }
    const unreadIds = (data || [])
      .filter((message) => message.recipient_id === authUser.id && !message.read_at)
      .map((message) => message.id)
    if (unreadIds.length) {
      await supabase.from('messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
      void loadConversations()
    }
  }, [authUser?.id, loadConversations, loadReactions])

  useEffect(() => {
    if (!selectedId) return
    setReplyingTo(null)
    setReactionPickerFor(null)
    void loadMessages(selectedId, true)
    const interval = window.setInterval(() => void loadMessages(selectedId), 3000)
    return () => window.clearInterval(interval)
  }, [selectedId, loadMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, selectedId])

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) || null,
    [conversations, selectedId]
  )

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    const body = draft.trim()
    if (!body || !selectedConversation || !authUser?.id || sending) return
    setSending(true)
    setError('')
    try {
      const { data, error: sendError } = await supabase.from('messages').insert({
        conversation_id: selectedConversation.id,
        sender_id: authUser.id,
        recipient_id: selectedConversation.peer.id,
        body,
        ...(replyingTo && interactionsAvailable ? { reply_to_message_id: replyingTo.id } : {}),
      }).select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at').single()
      if (sendError) throw sendError
      setMessages((current) => [...current, {
        ...data,
        shared_post_id: null,
        reply_to_message_id: replyingTo?.id || null,
        deleted_at: null,
      } as MessageRecord])
      setDraft('')
      setReplyingTo(null)
      void loadConversations()
    } catch (sendError) {
      console.error('Could not send message:', sendError)
      setError('Повідомлення не надіслано. Спробуйте ще раз.')
    } finally {
      setSending(false)
    }
  }

  const toggleReaction = async (message: MessageRecord, emoji: string) => {
    if (!authUser?.id || !interactionsAvailable || message.deleted_at) return
    setError('')
    const ownReaction = (reactions[message.id] || []).find((reaction) => reaction.user_id === authUser.id)
    const result = ownReaction?.emoji === emoji
      ? await supabase.from('message_reactions').delete().eq('id', ownReaction.id)
      : await supabase.from('message_reactions').upsert({
        message_id: message.id,
        user_id: authUser.id,
        emoji,
      }, { onConflict: 'message_id,user_id' })
    if (result.error) {
      console.error('Could not update message reaction:', result.error)
      setError('Не вдалося оновити реакцію. Спробуйте ще раз.')
      return
    }
    await loadReactions(messages.map((item) => item.id))
    setReactionPickerFor(null)
  }

  const deleteMessage = async (message: MessageRecord) => {
    if (!authUser?.id || message.sender_id !== authUser.id || message.deleted_at) return
    if (!window.confirm('Видалити повідомлення для обох учасників чату?')) return
    setError('')
    const { error: deleteError } = await supabase.rpc('xelay_delete_message', { p_message_id: message.id })
    if (deleteError) {
      console.error('Could not delete message:', deleteError)
      setError('Не вдалося видалити повідомлення. Перевірте підключення та спробуйте ще раз.')
      return
    }
    setMessages((current) => current.map((item) => item.id === message.id
      ? { ...item, body: '', deleted_at: new Date().toISOString() }
      : item))
    setConversations((current) => current.map((conversation) => conversation.lastMessage?.id === message.id
      ? { ...conversation, lastMessage: { ...conversation.lastMessage, body: '', deleted_at: new Date().toISOString() } }
      : conversation))
    setReactions((current) => ({ ...current, [message.id]: [] }))
    void loadConversations()
  }

  const beginReply = (message: MessageRecord) => {
    if (!message.deleted_at && interactionsAvailable) {
      setReplyingTo(message)
      setReactionPickerFor(null)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  if (authLoading) {
    return <main className="min-h-[60vh] flex items-center justify-center"><Loader2 className="animate-spin" /></main>
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-[70vh] flex items-center justify-center px-4">
        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
        <div className="xelay-card max-w-md p-8 text-center">
          <MessageCircle size={32} className="mx-auto mb-3 text-muted-foreground" />
          <h1 className="text-xl font-bold mb-2">Повідомлення</h1>
          <p className="text-sm text-muted-foreground mb-5">Увійдіть, щоб переглядати особисті чати.</p>
          <button onClick={() => setShowAuthModal(true)} className="rounded-full bg-foreground text-background px-5 py-2.5 font-medium">Увійти</button>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-background">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
        <h1 className="text-2xl font-bold mb-5 px-2 sm:px-0">Повідомлення</h1>
        <section className="xelay-card overflow-hidden h-[calc(100dvh-10rem)] min-h-[440px] max-h-[820px] flex">
          <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-[340px] lg:w-[380px] shrink-0 flex-col border-r border-border`}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-semibold">Ваші чати</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Лише прийняті запити на спілкування</p>
              </div>
              {conversations.some((conversation) => conversation.unreadCount > 0) && (
                <span className="rounded-full bg-foreground text-background px-2 py-0.5 text-xs font-semibold">
                  {conversations.reduce((count, conversation) => count + conversation.unreadCount, 0)}
                </span>
              )}
            </div>
            <div className="overflow-y-auto flex-1">
              {loading ? (
                <div className="py-12 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div>
              ) : conversations.length === 0 ? (
                <div className="px-7 py-12 text-center">
                  <MessageCircle size={28} className="mx-auto mb-3 text-muted-foreground/60" />
                  <p className="text-sm font-medium">Поки немає чатів</p>
                  <p className="text-xs text-muted-foreground mt-1">Чат з’явиться тут, коли користувач прийме ваш запит на спілкування.</p>
                </div>
              ) : conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  onClick={() => setSelectedId(conversation.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left border-b border-border/70 hover:bg-muted/70 ${selectedId === conversation.id ? 'bg-muted' : ''}`}
                >
                  <Avatar profile={conversation.peer} size="w-12 h-12" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{conversation.peer.full_name}</span>
                      {conversation.lastMessage && <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(conversation.lastMessage.created_at)}</span>}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2">
                      <span className={`truncate text-xs ${conversation.unreadCount ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                        {conversation.lastMessage?.sender_id === currentUserId ? 'Ви: ' : ''}{conversation.lastMessage?.deleted_at ? 'Повідомлення видалено' : conversation.lastMessage?.body || 'Почніть розмову'}
                      </span>
                      {conversation.unreadCount > 0 && <span className="h-5 min-w-5 px-1 rounded-full bg-foreground text-background text-[10px] flex items-center justify-center">{conversation.unreadCount}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
            {selectedConversation ? (
              <>
                <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                  <button onClick={() => setSelectedId('')} className="md:hidden p-2 rounded-full hover:bg-muted" aria-label="Назад до списку чатів"><ArrowLeft size={19} /></button>
                  <Avatar profile={selectedConversation.peer} size="w-10 h-10" />
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{selectedConversation.peer.full_name}</h2>
                    <p className="truncate text-xs text-muted-foreground">{[selectedConversation.peer.faculty, selectedConversation.peer.specialty].filter(Boolean).join(' · ') || 'Учасник Xelay'}</p>
                  </div>
                </header>
                {interactionsAvailable === false && (
                  <p className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
                    Щоб увімкнути відповіді, видалення та реакції, потрібно оновити базу даних проєкту.
                  </p>
                )}
                <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3">
                  {threadLoading ? <div className="pt-10 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div> : messages.length === 0 ? (
                    <div className="h-full min-h-48 flex flex-col items-center justify-center text-center">
                      <Avatar profile={selectedConversation.peer} size="w-16 h-16" />
                      <p className="font-semibold mt-3">{selectedConversation.peer.full_name}</p>
                      <p className="text-sm text-muted-foreground mt-1">Ваш запит прийнято. Почніть розмову.</p>
                    </div>
                  ) : messages.map((message) => {
                    const mine = message.sender_id === currentUserId
                    const repliedMessage = message.reply_to_message_id
                      ? messages.find((item) => item.id === message.reply_to_message_id)
                      : null
                    const groupedReactions = (reactions[message.id] || []).reduce<Record<string, { count: number; mine: boolean }>>((result, reaction) => {
                      result[reaction.emoji] ||= { count: 0, mine: false }
                      result[reaction.emoji].count += 1
                      if (reaction.user_id === currentUserId) result[reaction.emoji].mine = true
                      return result
                    }, {})
                    return (
                      <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[88%] sm:max-w-[76%]">
                          <div className={`rounded-2xl px-4 py-2.5 ${mine ? 'bg-foreground text-background rounded-br-md' : 'bg-muted text-foreground rounded-bl-md'}`}>
                            {message.reply_to_message_id && (
                              <div className={`mb-2 rounded-xl border-l-2 px-2.5 py-1.5 text-xs ${mine ? 'border-background/60 bg-background/10 text-background/80' : 'border-foreground/40 bg-background/70 text-muted-foreground'}`}>
                                <span className="mb-0.5 block font-semibold">Відповідь на повідомлення</span>
                                <span className="block truncate">{repliedMessage?.deleted_at ? 'Повідомлення видалено' : repliedMessage?.body || 'Повідомлення з історії чату'}</span>
                              </div>
                            )}
                            <p className={`text-sm whitespace-pre-wrap break-words ${message.deleted_at ? 'italic opacity-70' : ''}`}>
                              {message.deleted_at ? 'Повідомлення видалено' : message.body}
                            </p>
                            {!message.deleted_at && message.shared_post_id && <button onClick={() => navigate({ to: '/news/$id', params: { id: message.shared_post_id! } })} className={`mt-2 rounded-full px-3 py-1.5 text-xs font-semibold ${mine ? 'bg-background/15 hover:bg-background/25' : 'bg-background hover:bg-muted-foreground/10'}`}>Відкрити новину</button>}
                            <p className={`mt-1 text-[10px] ${mine ? 'text-background/65' : 'text-muted-foreground'}`}>{formatTime(message.created_at)}</p>
                          </div>
                          {!message.deleted_at && interactionsAvailable && (
                            <div className={`mt-1 flex flex-wrap items-center gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
                              {Object.entries(groupedReactions).map(([emoji, reaction]) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => void toggleReaction(message, emoji)}
                                  aria-label={`Реакція ${emoji}, ${reaction.count}`}
                                  className={`flex h-7 items-center gap-1 rounded-full border px-2 text-xs ${reaction.mine ? 'border-foreground bg-muted text-foreground' : 'border-border bg-background text-foreground'}`}
                                >
                                  <span>{emoji}</span><span>{reaction.count}</span>
                                </button>
                              ))}
                              <div className="relative flex items-center gap-1">
                                <button type="button" onClick={() => beginReply(message)} title="Відповісти" aria-label="Відповісти" className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                                  <Reply size={15} />
                                </button>
                                <button type="button" onClick={() => setReactionPickerFor(reactionPickerFor === message.id ? null : message.id)} title="Додати реакцію" aria-label="Додати реакцію" className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                                  <Smile size={15} />
                                </button>
                                {mine && <button type="button" onClick={() => void deleteMessage(message)} title="Видалити для обох" aria-label="Видалити повідомлення для обох" className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-red-50 hover:text-red-600">
                                  <Trash2 size={14} />
                                </button>}
                                {reactionPickerFor === message.id && (
                                  <div className={`absolute bottom-9 z-10 flex gap-1 rounded-full border border-border bg-background p-1.5 shadow-lg ${mine ? 'right-0' : 'left-0'}`}>
                                    {['👍', '❤️', '😂', '😮', '🙌', '🔥'].map((emoji) => (
                                      <button key={emoji} type="button" onClick={() => void toggleReaction(message, emoji)} aria-label={`Поставити реакцію ${emoji}`} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted">
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  <div ref={bottomRef} />
                </div>
                <form onSubmit={(event) => void sendMessage(event)} className="flex flex-col gap-2 border-t border-border p-3 sm:p-4">
                  {replyingTo && (
                    <div className="flex items-center gap-3 rounded-xl bg-muted px-3 py-2">
                      <Reply size={16} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold">Відповідь на повідомлення</p>
                        <p className="truncate text-xs text-muted-foreground">{replyingTo.deleted_at ? 'Повідомлення видалено' : replyingTo.body}</p>
                      </div>
                      <button type="button" onClick={() => setReplyingTo(null)} aria-label="Скасувати відповідь" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-background"><X size={16} /></button>
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      rows={1}
                      maxLength={5000}
                      placeholder="Напишіть повідомлення…"
                      className="min-h-11 max-h-32 flex-1 resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
                    />
                    <button type="submit" disabled={!draft.trim() || sending} aria-label="Надіслати повідомлення" className="h-11 w-11 shrink-0 rounded-full bg-foreground text-background flex items-center justify-center disabled:opacity-40">
                      {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={17} />}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="hidden md:flex flex-1 flex-col items-center justify-center text-center px-8">
                <div className="w-16 h-16 rounded-full border border-border flex items-center justify-center mb-4"><MessageCircle size={28} /></div>
                <h2 className="text-xl font-semibold">Ваші повідомлення</h2>
                <p className="text-sm text-muted-foreground mt-2">Оберіть чат або дочекайтеся прийняття запиту на спілкування.</p>
              </div>
            )}
          </div>
        </section>
        {error && <p role="alert" className="mt-3 px-2 text-sm text-red-600">{error}</p>}
      </div>
    </main>
  )
}

function Avatar({ profile, size }: { profile: ProfileSummary; size: string }) {
  const initials = profile.full_name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span className={`${size} shrink-0 overflow-hidden rounded-full bg-muted flex items-center justify-center`}>
      {profile.avatar_url ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : <span className="text-sm font-semibold text-foreground">{initials}</span>}
    </span>
  )
}

function formatTime(value: string) {
  return formatDistanceToNow(new Date(value), { addSuffix: true, locale: uk })
}
