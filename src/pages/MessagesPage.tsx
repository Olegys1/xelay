import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Loader2, MessageCircle, Send } from 'lucide-react'
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
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

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
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
          .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('conversation_id', row.id).eq('recipient_id', authUser.id).is('read_at', null),
      ])
      if (latest.error) {
        const legacyLatest = await supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
          .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        latest = { ...legacyLatest, data: legacyLatest.data ? { ...legacyLatest.data, shared_post_id: null } : null } as typeof latest
      }
      return {
        id: row.id,
        peer: profileById.get(peerId) || { id: peerId, full_name: 'Учасник Xelay', avatar_url: null, faculty: '', specialty: '' },
        lastMessage: latest.data || null,
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
      .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(100)

    let loadedMessages: any[] = []
    let messagesError = messageResult.error
    if (messageResult.error) {
      const legacyResult = await supabase.from('messages')
        .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(100)
      messagesError = legacyResult.error
      loadedMessages = (legacyResult.data || []).map((message) => ({ ...message, shared_post_id: null }))
    } else {
      loadedMessages = messageResult.data || []
    }

    const data = loadedMessages.map((message: any) => ({ ...message, shared_post_id: message.shared_post_id || null }))

    if (messagesError) {
      console.error('Could not load messages:', messagesError)
      setError('Не вдалося завантажити повідомлення.')
      setThreadLoading(false)
      return
    }

    setMessages((data || []).reverse())
    setThreadLoading(false)
    const unreadIds = (data || [])
      .filter((message) => message.recipient_id === authUser.id && !message.read_at)
      .map((message) => message.id)
    if (unreadIds.length) {
      await supabase.from('messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds)
      void loadConversations()
    }
  }, [authUser?.id, loadConversations])

  useEffect(() => {
    if (!selectedId) return
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
      }).select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at').single()
      if (sendError) throw sendError
      setMessages((current) => [...current, { ...data, shared_post_id: null } as MessageRecord])
      setDraft('')
      void loadConversations()
    } catch (sendError) {
      console.error('Could not send message:', sendError)
      setError('Повідомлення не надіслано. Спробуйте ще раз.')
    } finally {
      setSending(false)
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
                        {conversation.lastMessage?.sender_id === currentUserId ? 'Ви: ' : ''}{conversation.lastMessage?.body || 'Почніть розмову'}
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
                <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3">
                  {threadLoading ? <div className="pt-10 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div> : messages.length === 0 ? (
                    <div className="h-full min-h-48 flex flex-col items-center justify-center text-center">
                      <Avatar profile={selectedConversation.peer} size="w-16 h-16" />
                      <p className="font-semibold mt-3">{selectedConversation.peer.full_name}</p>
                      <p className="text-sm text-muted-foreground mt-1">Ваш запит прийнято. Почніть розмову.</p>
                    </div>
                  ) : messages.map((message) => {
                    const mine = message.sender_id === currentUserId
                    return (
                      <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[82%] sm:max-w-[72%] rounded-2xl px-4 py-2.5 ${mine ? 'bg-foreground text-background rounded-br-md' : 'bg-muted text-foreground rounded-bl-md'}`}>
                          <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
                          {message.shared_post_id && <button onClick={() => navigate({ to: '/news/$id', params: { id: message.shared_post_id! } })} className={`mt-2 rounded-full px-3 py-1.5 text-xs font-semibold ${mine ? 'bg-background/15 hover:bg-background/25' : 'bg-background hover:bg-muted-foreground/10'}`}>Відкрити новину</button>}
                          <p className={`mt-1 text-[10px] ${mine ? 'text-background/65' : 'text-muted-foreground'}`}>{formatTime(message.created_at)}</p>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={bottomRef} />
                </div>
                <form onSubmit={(event) => void sendMessage(event)} className="flex items-end gap-2 border-t border-border p-3 sm:p-4">
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
