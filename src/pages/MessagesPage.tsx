import { ChangeEvent, FormEvent, Fragment, KeyboardEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft, BarChart3, ChevronDown, ChevronUp, Copy, FileText, Loader2, Megaphone, MessageCircle, Paperclip, Pin, PinOff, Reply, Send, Smile, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { AuthModal } from '../components/AuthModal'
import { PremiumBadge } from '../components/PremiumBadge'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { useRecentItemMotion } from '../hooks/useRecentItemMotion'
import { getPublicProfiles } from '../lib/profiles'
import { isMissingDatabaseColumn } from '../lib/databaseCompatibility'
import { StudyAssignmentMessageCard } from '../components/StudyAssignmentMessageCard'
import { ChatMessageMenu } from '../components/ChatMessageMenu'
import { ChatMessageText, ChatMentionSuggestions } from '../components/ChatMentions'
import { copyChatText, type ChatMentionProfile } from '../lib/chatMessageText'
import { parseStudyAssignmentLink } from '../lib/studyAssignmentSharing'
import { ChatPublicationCard } from '../components/ChatPublicationCard'
import { ChatPublicationEditor } from '../components/ChatPublicationEditor'
import { loadChatPublications, publicationError, type ChatArticle, type ChatPublication, type PublicationKind } from '../lib/chatPublications'

interface ProfileSummary {
  id: string
  full_name: string
  username: string | null
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

interface DirectPublicationEditor {
  id: string
  kind: PublicationKind
  userId: string
  conversationId: string
  replyTo: string | null
  article?: ChatArticle
}

interface MessageReaction {
  id: string
  message_id: string
  user_id: string
  emoji: string
}

interface MessageAttachment {
  id: string
  message_id: string
  storage_path: string
  file_name: string
  media_type: 'image' | 'video'
  mime_type: string
  url: string
}

interface PublicPremium {
  user_id: string
  is_premium: boolean
  emoji_status: string | null
  status_text?: string | null
}

const BASIC_MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '🙌', '🔥']
const EXTRA_MESSAGE_REACTIONS = ['🥰', '🎉', '🤩', '💯', '👏', '🤝', '🫶', '🤔', '😢', '😎', '⚡', '📚']
const MAX_PINNED_CONVERSATIONS = 10
const MAX_PINNED_MESSAGES = 20

const MESSAGE_MEDIA_BUCKET = 'xelay-message-media'
const MAX_MESSAGE_MEDIA_FILES = 5
const MAX_MESSAGE_MEDIA_FILE_SIZE = 25 * 1024 * 1024
const MAX_MESSAGE_MEDIA_TOTAL_SIZE = 50 * 1024 * 1024
const MESSAGE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
])

interface ConversationSummary {
  id: string
  createdAt: string
  peer: ProfileSummary
  lastMessage: MessageRecord | null
  unreadCount: number
}

const CommunityChats = lazy(() => import('../components/CommunityChats').then((module) => ({ default: module.CommunityChats })))

export function MessagesPage() {
  const { authUser, isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ from: '/messages' })
  const [resolvedKind, setResolvedKind] = useState<'groups' | 'channels'>('groups')

  useEffect(() => {
    if (!authUser?.id || (!search.space && !search.invite) || search.kind) return
    let active = true
    const request = search.space ? supabase.rpc('xelay_chat_get', { p_space_id: search.space })
      : supabase.rpc('xelay_chat_link_preview', { p_token: search.invite })
    void request.then(({ data }) => {
      if (active) setResolvedKind(data?.space?.kind === 'channel' ? 'channels' : 'groups')
    })
    return () => { active = false }
  }, [authUser?.id, search.space, search.invite, search.kind])

  const selectedTab = search.kind || (search.space || search.invite ? resolvedKind : 'personal')
  return <>
    {isAuthenticated && <nav aria-label="Тип переписки" className="mx-auto flex w-full max-w-6xl gap-1 px-4 pt-5 sm:px-6">
      {([
        { id: 'personal', label: 'Особисті', Icon: MessageCircle },
        { id: 'groups', label: 'Групи', Icon: UsersRound },
        { id: 'channels', label: 'Канали', Icon: Megaphone },
      ] as const).map(({ id, label, Icon }) => <button key={id} aria-current={selectedTab === id ? 'page' : undefined}
        onClick={() => void navigate({ to: '/messages', search: { kind: id } })}
        className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-semibold transition-colors sm:flex-none sm:px-5 ${selectedTab === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
        <Icon size={17} />{label}
      </button>)}
    </nav>}
    {selectedTab === 'personal' ? <MessagesWorkspace key={authUser?.id || 'guest'} initialConversationId={search.conversation} /> :
      <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin" aria-label="Завантаження чатів" /></main>}>
        <main className="xelay-inbox-page min-h-[calc(100dvh-4rem)]"><div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
        <CommunityChats key={authUser?.id || 'guest'} kind={selectedTab === 'channels' ? 'channel' : 'group'} initialSpaceId={search.space} inviteToken={search.invite}
          onBackToList={() => void navigate({ to: '/messages', search: { kind: selectedTab === 'channels' ? 'channels' : 'groups' } })}
          onOpenSpace={(space, kind) => void navigate({ to: '/messages', search: { space, kind: kind === 'channel' ? 'channels' : 'groups' } })} />
        </div></main>
      </Suspense>}
  </>
}

function MessagesWorkspace({ initialConversationId }: { initialConversationId?: string }) {
  const { authUser, xelayUser, isAuthenticated, isLoading: authLoading } = useAuth()
  const { isPremium } = useBilling()
  const { notify } = useToast()
  const navigate = useNavigate()
  const currentUserId = authUser?.id || ''
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationPins, setConversationPins] = useState<Record<string, string>>({})
  const [peerPremium, setPeerPremium] = useState<Record<string, PublicPremium>>({})
  const [pinsAvailable, setPinsAvailable] = useState<boolean | null>(null)
  const [pinningConversation, setPinningConversation] = useState<string | null>(null)
  const [pinnedMessages, setPinnedMessages] = useState<MessageRecord[]>([])
  const [messagePinsAvailable, setMessagePinsAvailable] = useState<boolean | null>(null)
  const [pinningMessage, setPinningMessage] = useState<string | null>(null)
  const [showPinnedMessages, setShowPinnedMessages] = useState(false)
  const [pinnedPreview, setPinnedPreview] = useState<MessageRecord | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [reactions, setReactions] = useState<Record<string, MessageReaction[]>>({})
  const [messageAttachments, setMessageAttachments] = useState<Record<string, MessageAttachment[]>>({})
  const [publications, setPublications] = useState<Record<string, ChatPublication>>({})
  const [publicationEditor, setPublicationEditor] = useState<DirectPublicationEditor | null>(null)
  const [attachmentMenu, setAttachmentMenu] = useState(false)
  const [mediaAvailable, setMediaAvailable] = useState<boolean | null>(null)
  const [selectedMedia, setSelectedMedia] = useState<File[]>([])
  const [mediaPreview, setMediaPreview] = useState<MessageAttachment | null>(null)
  const [replyingTo, setReplyingTo] = useState<MessageRecord | null>(null)
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null)
  const [interactionsAvailable, setInteractionsAvailable] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [draftCaret, setDraftCaret] = useState(0)
  const [activeMessageActions, setActiveMessageActions] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const arrivingMessages = useRecentItemMotion(messages, `${currentUserId}:${selectedId}`, !threadLoading && !loading)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const threadScrollRef = useRef<HTMLDivElement>(null)
  const threadNearBottom = useRef(true)
  const previousThreadPosition = useRef({ conversationId: '', lastMessageId: '' })
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const attachmentButtonRef = useRef<HTMLButtonElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const bubbleAnchors = useRef<Record<string, { current: HTMLDivElement | null }>>({})
  const interactionSchemaChecked = useRef(false)
  const signedMediaUrlCache = useRef(new Map<string, { url: string; expiresAt: number }>())
  const mediaSchemaStatus = useRef<{ available: boolean | null; checkedAt: number }>({ available: null, checkedAt: 0 })
  const identityRef = useRef(currentUserId)
  const selectedIdRef = useRef(selectedId)
  const conversationSelectionVersion = useRef(0)
  identityRef.current = currentUserId
  selectedIdRef.current = selectedId
  const activeRef = useRef(true)
  const conversationLoading = useRef(false)
  const messageLoading = useRef<{ id: string; sequence: number } | null>(null)
  const pinLoading = useRef<{ id: string; sequence: number } | null>(null)
  const conversationSequence = useRef(0)
  const messageSequence = useRef(0)
  const pinSequence = useRef(0)
  const reactionSequence = useRef(0)
  const attachmentSequence = useRef(0)
  const publicationSequence = useRef(0)
  const publicationSchemaRetryAt = useRef(0)
  const publicationEditorRef = useRef(publicationEditor)
  publicationEditorRef.current = publicationEditor
  const conversationPinLock = useRef(false)
  const messagePinLock = useRef(false)
  const sendingLock = useRef(false)
  const reactionLock = useRef(false)
  const deleteLock = useRef(false)

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      signedMediaUrlCache.current.clear()
    }
  }, [])

  const isCurrent = (ownerId: string, conversationId?: string) => activeRef.current
    && identityRef.current === ownerId
    && (conversationId === undefined || selectedIdRef.current === conversationId)

  const selectConversation = (conversationId: string) => {
    conversationSelectionVersion.current += 1
    setPublicationEditor(null)
    setAttachmentMenu(false)
    setSelectedId(conversationId)
  }

  const loadReactions = useCallback(async (messageIds: string[], conversationId = selectedIdRef.current) => {
    const ownerId = identityRef.current
    if (!ownerId || reactionLock.current || !conversationId) return false
    const sequence = ++reactionSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId
      && selectedIdRef.current === conversationId && sequence === reactionSequence.current
    if (!messageIds.length) {
      const { error: schemaError } = await supabase.from('message_reactions').select('id').limit(1)
      if (!valid()) return false
      setReactions({})
      return !schemaError
    }
    let reactionQuery = supabase
      .from('message_reactions')
      .select('id, message_id, user_id, emoji')
    if (messageIds.length) reactionQuery = reactionQuery.in('message_id', messageIds)
    const { data, error: reactionsError } = await reactionQuery.limit(500)
    if (!valid()) return false
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

  const loadMessageAttachments = useCallback(async (messageIds: string[]) => {
    const ownerId = identityRef.current
    const conversationId = selectedIdRef.current
    if (!ownerId || !conversationId) return false
    const sequence = ++attachmentSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId
      && selectedIdRef.current === conversationId && sequence === attachmentSequence.current
    if (mediaSchemaStatus.current.available === false && Date.now() - mediaSchemaStatus.current.checkedAt < 30_000) {
      return false
    }
    if (!messageIds.length) {
      const { error: schemaError } = await supabase.from('message_attachments').select('id').limit(1)
      if (!valid()) return false
      setMessageAttachments({})
      setMediaAvailable(!schemaError)
      mediaSchemaStatus.current = { available: !schemaError, checkedAt: Date.now() }
      return !schemaError
    }

    const { data, error: attachmentsError } = await supabase.from('message_attachments')
      .select('id, message_id, storage_path, file_name, media_type, mime_type')
      .eq('conversation_id', conversationId)
      .in('message_id', messageIds)
      .order('created_at', { ascending: true })
      .limit((100 + MAX_PINNED_MESSAGES) * MAX_MESSAGE_MEDIA_FILES)
    if (!valid()) return false
    if (attachmentsError) {
      console.error('Could not load private message media:', attachmentsError)
      setMessageAttachments({})
      setMediaAvailable(false)
      mediaSchemaStatus.current = { available: false, checkedAt: Date.now() }
      return false
    }

    let signingFailed = false
    const signAttachment = async (attachment: Omit<MessageAttachment, 'url'>): Promise<MessageAttachment> => {
      const cached = signedMediaUrlCache.current.get(attachment.storage_path)
      if (cached && cached.expiresAt > Date.now() + 60_000) {
        return { ...attachment, url: cached.url }
      }

      const { data: signedUrl, error: signingError } = await supabase.storage
        .from(MESSAGE_MEDIA_BUCKET)
        .createSignedUrl(attachment.storage_path, 10 * 60)
      if (signingError || !signedUrl?.signedUrl) {
        signingFailed = true
        console.error('Could not create a private message media link:', signingError)
        return { ...attachment, url: '' }
      }
      signedMediaUrlCache.current.set(attachment.storage_path, {
        url: signedUrl.signedUrl,
        expiresAt: Date.now() + 9 * 60 * 1000,
      })
      return { ...attachment, url: signedUrl.signedUrl }
    }
    const signedAttachments: MessageAttachment[] = []
    for (let offset = 0; offset < (data || []).length; offset += 6) {
      if (!valid()) return false
      signedAttachments.push(...await Promise.all((data || []).slice(offset, offset + 6).map(signAttachment)))
    }
    if (!valid()) return false
    for (const [path, cached] of signedMediaUrlCache.current) {
      if (cached.expiresAt <= Date.now()) signedMediaUrlCache.current.delete(path)
    }

    const grouped = signedAttachments.reduce<Record<string, MessageAttachment[]>>((result, attachment) => {
      result[attachment.message_id] ||= []
      result[attachment.message_id].push(attachment)
      return result
    }, {})
    setMessageAttachments(grouped)
    setMediaAvailable(!signingFailed)
    mediaSchemaStatus.current = { available: !signingFailed, checkedAt: Date.now() }
    return !signingFailed
  }, [])

  const loadConversations = useCallback(async (showSpinner = false) => {
    if (!authUser?.id || !activeRef.current || conversationLoading.current || conversationPinLock.current) return
    const ownerId = authUser.id
    const sequence = ++conversationSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId && sequence === conversationSequence.current
    conversationLoading.current = true
    if (showSpinner) setLoading(true)
    try {
    const { data, error: conversationsError } = await supabase
      .from('conversations')
      .select('id, user_one_id, user_two_id, created_at')
      .or(`user_one_id.eq.${authUser.id},user_two_id.eq.${authUser.id}`)
      .order('created_at', { ascending: false })

    if (!valid()) return
    if (conversationsError) {
      console.error('Could not load conversations:', conversationsError)
      setError('Не вдалося завантажити чати. Перевірте, чи застосована міграція запитів і повідомлень.')
      setLoading(false)
      return
    }

    const rows = data || []
    const peerIds = rows.map((row) => row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id)
    const [profiles, pinsResult, premiumResult] = await Promise.all([
      peerIds.length ? getPublicProfiles(peerIds) : Promise.resolve({ data: [] }),
      supabase.from('conversation_pins').select('conversation_id, created_at').eq('user_id', authUser.id),
      peerIds.length ? loadPublicPremium([...new Set(peerIds)]) : Promise.resolve({ data: [] }),
    ])
    if (!valid()) return
    setPinsAvailable(!pinsResult.error)
    setConversationPins(Object.fromEntries((pinsResult.data || []).map((pin) => [pin.conversation_id, pin.created_at])))
    setPeerPremium(Object.fromEntries(((premiumResult.data || []) as PublicPremium[]).map((premium) => [premium.user_id, premium])))
    const profileById = new Map<string, ProfileSummary>((profiles.data || []).map((profile: any): [string, ProfileSummary] => [profile.id, profile as ProfileSummary]))

    const summaries = await Promise.all(rows.map(async (row) => {
      const peerId = row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id
      let [latest, unread] = await Promise.all([
        supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id, deleted_at')
          .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('conversation_id', row.id).eq('recipient_id', authUser.id).is('read_at', null),
      ])
      if (isMissingDatabaseColumn(latest.error)) {
        let legacyLatest = await supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
          .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (isMissingDatabaseColumn(legacyLatest.error)) {
          legacyLatest = await supabase.from('messages')
            .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
            .eq('conversation_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle() as typeof legacyLatest
        }
        latest = { ...legacyLatest, data: legacyLatest.data ? { ...legacyLatest.data, shared_post_id: legacyLatest.data.shared_post_id || null } : null } as typeof latest
      }
      if (latest.error || unread.error) throw latest.error || unread.error
      return {
        id: row.id,
        createdAt: row.created_at,
        peer: profileById.get(peerId) || { id: peerId, full_name: 'Учасник Xelay', username: null, avatar_url: null, faculty: '', specialty: '' },
        lastMessage: latest.data ? {
          ...latest.data,
          reply_to_message_id: null,
          deleted_at: (latest.data as MessageRecord).deleted_at || null,
        } : null,
        unreadCount: unread.count || 0,
      } satisfies ConversationSummary
    }))

    if (!valid()) return
    setConversations(summaries)
    if (showSpinner) setError('')
    setLoading(false)
    } catch {
      if (valid()) { setError('Не вдалося оновити чати. Спробуйте ще раз.'); setLoading(false) }
    } finally {
      conversationLoading.current = false
    }
  }, [authUser?.id])

  useEffect(() => {
    setSelectedId('')
    setMessages([])
    setPinnedMessages([])
    setPinnedPreview(null)
    setPublications({})
    setPublicationEditor(null)
    setAttachmentMenu(false)
    setConversationPins({})
    setPeerPremium({})
    if (!authUser?.id) {
      setConversations([])
      setLoading(false)
      return
    }
    void loadConversations(true)
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadConversations()
    }, 5000)
    return () => window.clearInterval(interval)
  }, [authUser?.id, loadConversations])

  useEffect(() => {
    if (!currentUserId || !initialConversationId) return
    let active = true
    const selectionVersion = conversationSelectionVersion.current
    void Promise.resolve(supabase.from('conversations').select('id').eq('id', initialConversationId)
      .or(`user_one_id.eq.${currentUserId},user_two_id.eq.${currentUserId}`).maybeSingle())
      .then(({ data, error: conversationError }) => {
        if (!active || !activeRef.current || identityRef.current !== currentUserId || selectionVersion !== conversationSelectionVersion.current) return
        if (conversationError || !data) {
          setSelectedId('')
          setError('Цей чат більше недоступний. Оберіть іншу переписку.')
          return
        }
        setSelectedId(data.id)
        void loadConversations()
      })
      .catch(() => {
        if (active && activeRef.current && identityRef.current === currentUserId && selectionVersion === conversationSelectionVersion.current) {
          setError('Не вдалося відкрити чат. Оновіть сторінку та спробуйте ще раз.')
        }
      })
    return () => { active = false }
  }, [currentUserId, initialConversationId, loadConversations])

  const loadPinnedMessages = useCallback(async (conversationId: string) => {
    if (!authUser?.id || !conversationId || pinLoading.current?.id === conversationId || messagePinLock.current) return
    const ownerId = authUser.id
    const sequence = ++pinSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId
      && selectedIdRef.current === conversationId && sequence === pinSequence.current
    pinLoading.current = { id: conversationId, sequence }
    try {
    const { data: pins, error: pinsError } = await supabase.from('direct_message_pins')
      .select('message_id, created_at').eq('user_id', authUser.id).eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(MAX_PINNED_MESSAGES)
    if (!valid()) return
    setMessagePinsAvailable(!pinsError)
    if (pinsError || !pins?.length) {
      setPinnedMessages([])
      return
    }
    const { data, error: messagesError } = await supabase.from('messages')
      .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id, reply_to_message_id, deleted_at')
      .eq('conversation_id', conversationId).in('id', pins.map((pin) => pin.message_id)).is('deleted_at', null)
    if (!valid()) return
    if (messagesError) {
      setMessagePinsAvailable(false)
      setPinnedMessages([])
      return
    }
    const byId = new Map((data || []).map((message) => [message.id, message as MessageRecord]))
    setPinnedMessages(pins.map((pin) => byId.get(pin.message_id)).filter((message): message is MessageRecord => Boolean(message)))
    } catch {
      if (valid()) { setMessagePinsAvailable(false); setPinnedMessages([]) }
    } finally {
      if (pinLoading.current?.sequence === sequence) pinLoading.current = null
    }
  }, [authUser?.id])

  const loadMessages = useCallback(async (conversationId: string, showSpinner = false) => {
    if (!authUser?.id || !conversationId || messageLoading.current?.id === conversationId || sendingLock.current || deleteLock.current) return
    const ownerId = authUser.id
    const sequence = ++messageSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId
      && selectedIdRef.current === conversationId && sequence === messageSequence.current
    messageLoading.current = { id: conversationId, sequence }
    if (showSpinner) setThreadLoading(true)
    try {
    const messageResult = await supabase.from('messages')
      .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id, reply_to_message_id, deleted_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(100)
    if (!valid()) return

    let loadedMessages: any[] = []
    let messagesError = messageResult.error
    let supportsInteractionColumns = !messageResult.error
    if (isMissingDatabaseColumn(messageResult.error)) {
      let legacyResult = await supabase.from('messages')
        .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(100)
      if (isMissingDatabaseColumn(legacyResult.error)) {
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

    if (!valid()) return
    if (messagesError) {
      console.error('Could not load messages:', messagesError)
      setError('Не вдалося завантажити повідомлення.')
      setThreadLoading(false)
      return
    }

    setMessages((data || []).reverse())
    setThreadLoading(false)
    if (supportsInteractionColumns) {
      const reactionsLoaded = await loadReactions(data.map((message) => message.id), conversationId)
      if (!valid()) return
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
      await supabase.from('messages').update({ read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId).eq('recipient_id', ownerId).in('id', unreadIds)
      if (!valid()) return
      void loadConversations()
    }
    } catch {
      if (valid()) { setError('Не вдалося оновити повідомлення. Спробуйте ще раз.'); setThreadLoading(false) }
    } finally {
      if (messageLoading.current?.sequence === sequence) messageLoading.current = null
    }
  }, [authUser?.id, loadConversations, loadReactions])

  const loadDirectPublications = useCallback(async (messageIds: string[], conversationId: string) => {
    const ownerId = identityRef.current
    if (!ownerId || !conversationId) return
    const sequence = ++publicationSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId
      && selectedIdRef.current === conversationId && publicationSequence.current === sequence
    if (!messageIds.length) {
      if (valid()) setPublications({})
      return
    }
    if (Date.now() < publicationSchemaRetryAt.current) return
    try {
      const loaded = await loadChatPublications([], messageIds)
      if (!valid()) return
      const readableIds = new Set(messageIds)
      setPublications(Object.fromEntries(loaded
        .filter((publication) => publication.message_id && readableIds.has(publication.message_id))
        .map((publication) => [publication.message_id!, publication])))
      publicationSchemaRetryAt.current = 0
    } catch (loadError) {
      if (!valid()) return
      const code = (loadError as { code?: string })?.code || ''
      if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) {
        publicationSchemaRetryAt.current = Date.now() + 60_000
        return
      }
      setNotice(publicationError(loadError))
    }
  }, [])

  const openPublicationEditor = (kind: PublicationKind, message?: MessageRecord, article?: ChatArticle) => {
    if (!currentUserId || !selectedId || sendingLock.current || (message && (message.deleted_at || message.conversation_id !== selectedId))) return
    if (article && !article.can_edit) return
    setPinnedPreview(null)
    setMediaPreview(null)
    setReactionPickerFor(null)
    setActiveMessageActions(null)
    setAttachmentMenu(false)
    const editor: DirectPublicationEditor = {
      id: crypto.randomUUID(), kind, userId: currentUserId, conversationId: selectedId,
      replyTo: article ? null : replyingTo?.id || null, article,
    }
    publicationEditorRef.current = editor
    setPublicationEditor(editor)
  }

  const handlePublicationSaved = async (editor: DirectPublicationEditor) => {
    if (!isCurrent(editor.userId, editor.conversationId) || publicationEditorRef.current?.id !== editor.id) return
    publicationEditorRef.current = null
    setPublicationEditor(null)
    if (!editor.article) setReplyingTo((current) => current?.id === editor.replyTo ? null : current)
    // Invalidate earlier reads before fetching the newly saved message or article.
    ++messageSequence.current
    ++pinSequence.current
    ++publicationSequence.current
    messageLoading.current = null
    pinLoading.current = null
    publicationSchemaRetryAt.current = 0
    await Promise.all([
      loadMessages(editor.conversationId), loadPinnedMessages(editor.conversationId), loadConversations(),
    ])
  }

  useEffect(() => {
    ++messageSequence.current
    ++pinSequence.current
    ++reactionSequence.current
    ++attachmentSequence.current
    ++publicationSequence.current
    setMessages([])
    setReactions({})
    setMessageAttachments({})
    setPublications({})
    setPublicationEditor(null)
    setAttachmentMenu(false)
    setMediaPreview(null)
    setDraft('')
    setDraftCaret(0)
    setActiveMessageActions(null)
    setNotice('')
    bubbleAnchors.current = {}
    if (!selectedId) return
    setReplyingTo(null)
    setReactionPickerFor(null)
    setSelectedMedia([])
    setPinnedMessages([])
    setPinnedPreview(null)
    setShowPinnedMessages(false)
    void loadMessages(selectedId, true)
    void loadPinnedMessages(selectedId)
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadMessages(selectedId)
      void loadPinnedMessages(selectedId)
    }, 3000)
    return () => {
      ++messageSequence.current
      ++pinSequence.current
      ++reactionSequence.current
      ++attachmentSequence.current
      ++publicationSequence.current
      window.clearInterval(interval)
    }
  }, [selectedId, loadMessages, loadPinnedMessages])

  useEffect(() => {
    if (!selectedId) return
    const ids = [...new Set([...messages, ...pinnedMessages]
      .filter((message) => message.conversation_id === selectedId && !message.deleted_at)
      .map((message) => message.id))]
    void loadMessageAttachments(ids)
    void loadDirectPublications(ids, selectedId)
  }, [messages, pinnedMessages, selectedId, loadMessageAttachments, loadDirectPublications])

  useEffect(() => {
    const threadMessages = messages.filter((message) => message.conversation_id === selectedId)
    const lastMessage = threadMessages[threadMessages.length - 1]
    if (!selectedId || !lastMessage || !threadScrollRef.current) return
    const previous = previousThreadPosition.current
    const changedThread = previous.conversationId !== selectedId
    const newMessage = previous.lastMessageId !== lastMessage.id
    if (changedThread || (newMessage && (threadNearBottom.current || lastMessage.sender_id === currentUserId))) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      threadScrollRef.current.scrollTo({ top: threadScrollRef.current.scrollHeight, behavior: changedThread || reduceMotion ? 'auto' : 'smooth' })
      threadNearBottom.current = true
    }
    previousThreadPosition.current = { conversationId: selectedId, lastMessageId: lastMessage.id }
  }, [messages, selectedId, currentUserId])

  useEffect(() => {
    if (pinnedPreview && !pinnedMessages.some((message) => message.id === pinnedPreview.id)) setPinnedPreview(null)
  }, [pinnedMessages, pinnedPreview])

  useEffect(() => {
    if (!pinnedPreview && !mediaPreview && !reactionPickerFor) return
    const dismissPreview = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinnedPreview(null)
        setMediaPreview(null)
        setReactionPickerFor(null)
      }
    }
    window.addEventListener('keydown', dismissPreview)
    return () => window.removeEventListener('keydown', dismissPreview)
  }, [pinnedPreview, mediaPreview, reactionPickerFor])

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) || null,
    [conversations, selectedId]
  )

  const mentionProfiles = useMemo<ChatMentionProfile[]>(() => [
    ...(selectedConversation ? [selectedConversation.peer] : []),
    ...(xelayUser && xelayUser.id === currentUserId ? [{ id: xelayUser.id, full_name: xelayUser.name, username: xelayUser.username, avatar_url: xelayUser.avatarUrl }] : []),
  ], [selectedConversation, xelayUser, currentUserId])

  const copyMessage = async (message: MessageRecord) => {
    const ownerId = currentUserId
    const copied = await copyChatText(message.body)
    if (!isCurrent(ownerId, message.conversation_id)) return
    setNotice('')
    setError(copied ? '' : 'Не вдалося скопіювати текст. Спробуйте ще раз.')
    notify({ id: 'direct-chat-copy', tone: copied ? 'success' : 'error', title: copied ? 'Текст скопійовано' : 'Не вдалося скопіювати текст', description: copied ? undefined : 'Спробуйте ще раз.' })
  }

  const selectMention = (text: string, caret: number) => {
    setDraft(text); setDraftCaret(caret)
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret) })
  }

  const visibleMessages = messages.filter((message) => message.conversation_id === selectedId)
  const visiblePins = pinnedMessages.filter((message) => message.conversation_id === selectedId && !message.deleted_at)

  const sortedConversations = useMemo(() => [...conversations].sort((left, right) => {
    const leftPin = conversationPins[left.id]
    const rightPin = conversationPins[right.id]
    if (leftPin && !rightPin) return -1
    if (!leftPin && rightPin) return 1
    if (leftPin && rightPin) return rightPin.localeCompare(leftPin)
    return (right.lastMessage?.created_at || right.createdAt).localeCompare(left.lastMessage?.created_at || left.createdAt)
  }), [conversations, conversationPins])

  const toggleConversationPin = async (conversation: ConversationSummary) => {
    if (!authUser?.id || conversationPinLock.current) return
    const ownerId = authUser.id
    const isPinned = Boolean(conversationPins[conversation.id])
    if (pinsAvailable === false) {
      setError('Закріплення чатів стане доступним після оновлення бази даних.')
      notify({ id: 'direct-chat-pin', tone: 'warning', title: 'Закріплення поки недоступне', description: 'Потрібно оновити платформу.' })
      return
    }
    if (!isPinned && Object.keys(conversationPins).length >= MAX_PINNED_CONVERSATIONS) {
      setError(`Можна закріпити до ${MAX_PINNED_CONVERSATIONS} чатів. Спочатку відкріпіть один із них.`)
      notify({ id: 'direct-chat-pin', tone: 'warning', title: 'Досягнуто ліміт закріплених чатів', description: 'Спочатку відкріпіть один із них.' })
      return
    }
    setPinningConversation(conversation.id)
    conversationPinLock.current = true
    ++conversationSequence.current
    setError('')
    try {
    const { error: pinError } = isPinned
      ? await supabase.from('conversation_pins').delete().eq('user_id', authUser.id).eq('conversation_id', conversation.id)
      : await supabase.from('conversation_pins').insert({ user_id: authUser.id, conversation_id: conversation.id })
    if (!isCurrent(ownerId)) return
    if (pinError) {
      setError('Не вдалося змінити закріплення чату. Спробуйте ще раз.')
      notify({ id: 'direct-chat-pin', tone: 'error', title: 'Не вдалося змінити закріплення чату' })
      return
    }
    setConversationPins((current) => {
      const next = { ...current }
      if (isPinned) delete next[conversation.id]
      else next[conversation.id] = new Date().toISOString()
      return next
    })
    notify({ id: 'direct-chat-pin', tone: 'success', title: isPinned ? 'Чат відкріплено' : 'Чат закріплено для вас' })
    } catch {
      if (isCurrent(ownerId)) { setError('Не вдалося змінити закріплення чату. Спробуйте ще раз.'); notify({ id: 'direct-chat-pin', tone: 'error', title: 'Не вдалося змінити закріплення чату' }) }
    } finally {
      conversationPinLock.current = false
      if (isCurrent(ownerId)) { setPinningConversation(null); void loadConversations() }
    }
  }

  const toggleMessagePin = async (message: MessageRecord) => {
    if (!authUser?.id || message.deleted_at || messagePinLock.current || message.conversation_id !== selectedIdRef.current) return
    const ownerId = authUser.id
    const isPinned = pinnedMessages.some((item) => item.id === message.id)
    if (messagePinsAvailable === false) {
      setError('Закріплення повідомлень стане доступним після оновлення бази даних.')
      notify({ id: 'direct-message-pin', tone: 'warning', title: 'Закріплення поки недоступне', description: 'Потрібно оновити платформу.' })
      return
    }
    if (!isPinned && pinnedMessages.length >= MAX_PINNED_MESSAGES) {
      setError(`В одному чаті можна закріпити до ${MAX_PINNED_MESSAGES} повідомлень.`)
      notify({ id: 'direct-message-pin', tone: 'warning', title: 'Досягнуто ліміт закріплених повідомлень', description: 'Спочатку відкріпіть одне з них.' })
      return
    }
    setPinningMessage(message.id)
    messagePinLock.current = true
    ++pinSequence.current
    setError('')
    try {
    const { error: pinError } = isPinned
      ? await supabase.from('direct_message_pins').delete().eq('user_id', authUser.id).eq('message_id', message.id)
      : await supabase.from('direct_message_pins').insert({ user_id: authUser.id, conversation_id: message.conversation_id, message_id: message.id })
    if (!isCurrent(ownerId, message.conversation_id)) return
    if (pinError) {
      setError('Не вдалося змінити закріплення повідомлення. Спробуйте ще раз.')
      notify({ id: 'direct-message-pin', tone: 'error', title: 'Не вдалося змінити закріплення повідомлення' })
      return
    }
    if (isPinned && pinnedPreview?.id === message.id) setPinnedPreview(null)
    notify({ id: 'direct-message-pin', tone: 'success', title: isPinned ? 'Повідомлення відкріплено' : 'Повідомлення закріплено для вас' })
    } catch {
      if (isCurrent(ownerId, message.conversation_id)) { setError('Не вдалося змінити закріплення повідомлення. Спробуйте ще раз.'); notify({ id: 'direct-message-pin', tone: 'error', title: 'Не вдалося змінити закріплення повідомлення' }) }
    } finally {
      messagePinLock.current = false
      if (isCurrent(ownerId)) setPinningMessage(null)
      if (isCurrent(ownerId, message.conversation_id)) void loadPinnedMessages(message.conversation_id)
    }
  }

  const handleMediaSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    if (selectedMedia.length + files.length > MAX_MESSAGE_MEDIA_FILES) {
      setError(`До одного повідомлення можна додати не більше ${MAX_MESSAGE_MEDIA_FILES} файлів.`)
      return
    }
    const invalidType = files.find((file) => !MESSAGE_MEDIA_TYPES.has(file.type))
    if (invalidType) {
      setError(`Формат файлу «${invalidType.name}» не підтримується.`)
      return
    }
    const oversized = files.find((file) => file.size > MAX_MESSAGE_MEDIA_FILE_SIZE)
    if (oversized) {
      setError(`Файл «${oversized.name}» завеликий. Максимум — 25 МБ.`)
      return
    }
    const totalSize = [...selectedMedia, ...files].reduce((total, file) => total + file.size, 0)
    if (totalSize > MAX_MESSAGE_MEDIA_TOTAL_SIZE) {
      setError('Загальний розмір вкладень не може перевищувати 50 МБ.')
      return
    }
    setError('')
    setSelectedMedia((current) => [...current, ...files])
  }

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    const body = draft.trim()
    if ((!body && !selectedMedia.length) || !selectedConversation || !authUser?.id || sendingLock.current || publicationEditorRef.current) return
    const ownerId = authUser.id
    const conversationId = selectedConversation.id
    const files = [...selectedMedia]
    if (selectedMedia.length && !mediaAvailable) {
      setError('Вкладення стануть доступними після оновлення бази даних проєкту.')
      return
    }
    setSending(true)
    sendingLock.current = true
    ++messageSequence.current
    setError('')
    const messageId = crypto.randomUUID()
    const uploadedPaths: string[] = []
    let messageCreationAttempted = false
    try {
      const uploadedMedia = [] as Array<{
        storage_path: string
        file_name: string
        media_type: 'image' | 'video'
        mime_type: string
      }>
      for (const file of files) {
        if (!isCurrent(ownerId)) throw new Error('Account changed')
        const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'media'
        const storagePath = `${selectedConversation.id}/${authUser.id}/${messageId}/${crypto.randomUUID()}-${safeFileName}`
        const { error: uploadError } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET)
          .upload(storagePath, file, { contentType: file.type, upsert: false })
        if (uploadError) throw uploadError
        uploadedPaths.push(storagePath)
        uploadedMedia.push({
          storage_path: storagePath,
          file_name: file.name.slice(0, 255),
          media_type: file.type.startsWith('video/') ? 'video' as const : 'image' as const,
          mime_type: file.type,
        })
      }

      if (!isCurrent(ownerId)) throw new Error('Account changed')
      const messageBody = body || (files.some((file) => file.type.startsWith('video/')) ? 'Відео' : 'Фото')
      messageCreationAttempted = true
      const { data, error: sendError } = await supabase.from('messages').insert({
        id: messageId,
        conversation_id: selectedConversation.id,
        sender_id: authUser.id,
        recipient_id: selectedConversation.peer.id,
        body: messageBody,
        ...(replyingTo && interactionsAvailable ? { reply_to_message_id: replyingTo.id } : {}),
      }).select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at').single()
      if (sendError) throw sendError

      if (uploadedMedia.length) {
        if (!isCurrent(ownerId)) throw new Error('Account changed')
        const { error: attachmentsError } = await supabase.from('message_attachments').insert(uploadedMedia.map((media) => ({
          ...media,
          message_id: messageId,
          conversation_id: selectedConversation.id,
          uploaded_by: authUser.id,
        })))
        if (attachmentsError) throw attachmentsError
      }

      if (!isCurrent(ownerId, conversationId)) return
      setMessages((current) => [...current.filter((item) => item.id !== messageId), {
        ...data,
        shared_post_id: null,
        reply_to_message_id: replyingTo?.id || null,
        deleted_at: null,
      } as MessageRecord])
      setDraft('')
      setSelectedMedia([])
      setReplyingTo(null)
      if (uploadedMedia.length) {
        await loadMessageAttachments([...messages.map((item) => item.id), messageId])
      }
      void loadConversations()
    } catch (sendError) {
      console.error('Could not send message:', sendError)
      if (messageCreationAttempted && isCurrent(ownerId)) {
        await supabase.rpc('xelay_delete_message', { p_message_id: messageId })
      }
      if (uploadedPaths.length && isCurrent(ownerId)) {
        const { error: cleanupError } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).remove(uploadedPaths)
        if (cleanupError) console.error('Could not clean up unsent media:', cleanupError)
      }
      if (isCurrent(ownerId, conversationId)) setError('Повідомлення не надіслано. Спробуйте ще раз.')
    } finally {
      sendingLock.current = false
      if (isCurrent(ownerId)) { setSending(false); void loadConversations() }
    }
  }

  const toggleReaction = async (message: MessageRecord, emoji: string) => {
    if (!authUser?.id || !interactionsAvailable || message.deleted_at || reactionLock.current || message.conversation_id !== selectedIdRef.current) return
    const ownerId = authUser.id
    const ownReaction = (reactions[message.id] || []).find((reaction) => reaction.user_id === authUser.id)
    reactionLock.current = true
    ++reactionSequence.current
    setError('')
    try {
    const result = ownReaction?.emoji === emoji
      ? await supabase.from('message_reactions').delete().eq('id', ownReaction.id).eq('user_id', ownerId)
      : await supabase.from('message_reactions').upsert({
        message_id: message.id,
        user_id: authUser.id,
        emoji,
      }, { onConflict: 'message_id,user_id' })
    if (!isCurrent(ownerId, message.conversation_id)) return
    if (result.error) {
      console.error('Could not update message reaction:', result.error)
      setError('Не вдалося оновити реакцію. Спробуйте ще раз.')
      return
    }
    setReactionPickerFor(null)
    } catch {
      if (isCurrent(ownerId, message.conversation_id)) setError('Не вдалося оновити реакцію. Спробуйте ще раз.')
    } finally {
      reactionLock.current = false
      if (isCurrent(ownerId, message.conversation_id)) void loadReactions(messages.map((item) => item.id), message.conversation_id)
    }
  }

  const deleteMessage = async (message: MessageRecord) => {
    if (!authUser?.id || message.sender_id !== authUser.id || message.deleted_at || deleteLock.current || message.conversation_id !== selectedIdRef.current) return
    if (!window.confirm('Видалити повідомлення для обох учасників чату?')) return
    const ownerId = authUser.id
    deleteLock.current = true
    ++messageSequence.current
    setError('')
    try {
    const attachmentsToRemove = messageAttachments[message.id] || []
    const { error: deleteError } = await supabase.rpc('xelay_delete_message', { p_message_id: message.id })
    if (!isCurrent(ownerId, message.conversation_id)) return
    if (deleteError) {
      console.error('Could not delete message:', deleteError)
      setError('Не вдалося видалити повідомлення. Перевірте підключення та спробуйте ще раз.')
      return
    }
    setMessages((current) => current.map((item) => item.id === message.id
      ? { ...item, body: '', deleted_at: new Date().toISOString() }
      : item))
    setPinnedMessages((current) => current.filter((item) => item.id !== message.id))
    if (pinnedPreview?.id === message.id) setPinnedPreview(null)
    setMessageAttachments((current) => {
      const next = { ...current }
      delete next[message.id]
      return next
    })
    attachmentsToRemove.forEach((attachment) => signedMediaUrlCache.current.delete(attachment.storage_path))
    if (mediaPreview && attachmentsToRemove.some((attachment) => attachment.storage_path === mediaPreview.storage_path)) {
      setMediaPreview(null)
    }
    if (attachmentsToRemove.length) {
      const { error: mediaDeleteError } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET)
        .remove(attachmentsToRemove.map((attachment) => attachment.storage_path))
      if (mediaDeleteError) console.error('Could not remove deleted message media:', mediaDeleteError)
    }
    if (!isCurrent(ownerId, message.conversation_id)) return
    setConversations((current) => current.map((conversation) => conversation.lastMessage?.id === message.id
      ? { ...conversation, lastMessage: { ...conversation.lastMessage, body: '', deleted_at: new Date().toISOString() } }
      : conversation))
    setReactions((current) => ({ ...current, [message.id]: [] }))
    void loadConversations()
    } catch {
      if (isCurrent(ownerId, message.conversation_id)) setError('Не вдалося видалити повідомлення. Спробуйте ще раз.')
    } finally {
      deleteLock.current = false
    }
  }

  const beginReply = (message: MessageRecord) => {
    if (!message.deleted_at && interactionsAvailable) {
      setReplyingTo(message)
      setReactionPickerFor(null)
      composerRef.current?.focus()
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  if (authLoading) {
    return <main className="xelay-inbox-page min-h-[60vh] flex items-center justify-center"><Loader2 className="animate-spin text-primary" /></main>
  }

  if (!isAuthenticated) {
    return (
      <main className="xelay-inbox-page min-h-[70vh] flex items-center justify-center px-4">
        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
        <div className="xelay-inbox-shell max-w-md p-8 text-center">
          <MessageCircle size={32} className="mx-auto mb-3 text-muted-foreground" />
          <h1 className="text-xl font-bold mb-2">Повідомлення</h1>
          <p className="text-sm text-muted-foreground mb-5">Увійдіть, щоб переглядати особисті чати.</p>
          <button onClick={() => setShowAuthModal(true)} className="min-h-11 rounded-full bg-primary text-primary-foreground px-5 py-2.5 font-medium">Увійти</button>
        </div>
      </main>
    )
  }

  return (
    <main className="xelay-inbox-page min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-1 sm:mb-5 sm:gap-3 sm:px-0">
          <h1 className="text-lg font-semibold tracking-tight sm:text-2xl">Повідомлення</h1>
          <button type="button" onClick={() => navigate({ to: '/subscription' })} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-primary/15 bg-background/90 px-3.5 py-2 text-xs font-semibold text-primary shadow-sm transition-colors hover:bg-primary/5 active:scale-[0.98] motion-reduce:transform-none">
            <Sparkles size={15} />{isPremium ? 'Підписка «Учасник»' : 'Можливості «Учасник»'}
          </button>
        </div>
        <section className="xelay-inbox-shell flex h-[calc(100dvh-10rem)] min-h-[420px] overflow-hidden md:h-[calc(100dvh-12rem)] md:min-h-[500px] md:max-h-[840px]">
          <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col border-border md:w-[360px] md:border-r lg:w-[400px]`}>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-5 sm:px-5">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold sm:text-base">Ваші чати</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Лише прийняті запити на спілкування</p>
              </div>
              {conversations.some((conversation) => conversation.unreadCount > 0) && (
                <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground">
                  {conversations.reduce((count, conversation) => count + conversation.unreadCount, 0)}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {loading ? (
                <div className="py-12 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div>
              ) : conversations.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center px-7 py-12 text-center">
                  <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted"><MessageCircle size={25} className="text-muted-foreground" /></span>
                  <p className="text-sm font-medium">Поки немає чатів</p>
                  <p className="mt-2 max-w-64 text-xs leading-relaxed text-muted-foreground">Чат з’явиться тут, коли користувач прийме ваш запит на спілкування.</p>
                </div>
              ) : sortedConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`group flex w-full items-center border-b border-border/60 pr-1 transition-colors hover:bg-muted/60 sm:pr-2 ${selectedId === conversation.id ? 'bg-primary/5' : ''}`}
                >
                  <button type="button" onClick={() => selectConversation(conversation.id)} className="flex min-w-0 flex-1 items-center gap-3 py-4 pl-4 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 sm:pl-5 sm:pr-2">
                  <Avatar profile={conversation.peer} size="w-11 h-11" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{conversation.peer.full_name}</span>
                        <PremiumBadge isPremium={Boolean(peerPremium[conversation.peer.id]?.is_premium)} emojiStatus={peerPremium[conversation.peer.id]?.emoji_status} textStatus={peerPremium[conversation.peer.id]?.status_text} compact />
                      </span>
                      {conversation.lastMessage && <span className="max-w-[32%] shrink-0 text-right text-[10px] leading-relaxed text-muted-foreground">{formatTime(conversation.lastMessage.created_at)}</span>}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2">
                      <span className={`min-w-0 truncate text-sm ${conversation.unreadCount ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                        {conversation.lastMessage?.sender_id === currentUserId ? 'Ви: ' : ''}{conversation.lastMessage?.deleted_at ? 'Повідомлення видалено' : conversation.lastMessage?.body || 'Почніть розмову'}
                      </span>
                      {conversation.unreadCount > 0 && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{conversation.unreadCount}</span>}
                    </span>
                  </span>
                  </button>
                  <button type="button" onClick={() => void toggleConversationPin(conversation)} disabled={Boolean(pinningConversation)} title={conversationPins[conversation.id] ? 'Відкріпити чат' : 'Закріпити чат для себе'} aria-label={conversationPins[conversation.id] ? `Відкріпити чат із ${conversation.peer.full_name}` : `Закріпити чат із ${conversation.peer.full_name}`} aria-pressed={Boolean(conversationPins[conversation.id])} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/10 disabled:opacity-40 ${conversationPins[conversation.id] ? 'text-primary' : 'text-muted-foreground'}`}>
                    {pinningConversation === conversation.id ? <Loader2 size={14} className="animate-spin" /> : conversationPins[conversation.id] ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <div className={`${selectedId ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}>
            {selectedConversation ? (
              <>
                <header className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-3 sm:gap-3 sm:px-5">
                  <button onClick={() => selectConversation('')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-muted md:hidden" aria-label="Назад до списку чатів"><ArrowLeft size={19} /></button>
                  <Link
                    to="/user/$id"
                    params={{ id: selectedConversation.peer.id }}
                    title="Відкрити профіль"
                    aria-label={`Відкрити профіль: ${selectedConversation.peer.full_name}`}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Avatar profile={selectedConversation.peer} size="w-10 h-10" />
                    <div className="min-w-0 flex-1">
                      <h2 className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold"><span className="truncate">{selectedConversation.peer.full_name}</span><PremiumBadge isPremium={Boolean(peerPremium[selectedConversation.peer.id]?.is_premium)} emojiStatus={peerPremium[selectedConversation.peer.id]?.emoji_status} textStatus={peerPremium[selectedConversation.peer.id]?.status_text} compact /></h2>
                      <p className="truncate text-xs text-muted-foreground">{[selectedConversation.peer.faculty, selectedConversation.peer.specialty].filter(Boolean).join(' · ') || 'Учасник Xelay'}</p>
                    </div>
                  </Link>
                  <button type="button" onClick={() => void toggleConversationPin(selectedConversation)} disabled={Boolean(pinningConversation)} title={conversationPins[selectedConversation.id] ? 'Відкріпити чат' : 'Закріпити чат для себе'} aria-label={conversationPins[selectedConversation.id] ? 'Відкріпити чат' : 'Закріпити чат'} aria-pressed={Boolean(conversationPins[selectedConversation.id])} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/10 ${conversationPins[selectedConversation.id] ? 'text-primary' : 'text-muted-foreground'}`}>
                    {conversationPins[selectedConversation.id] ? <PinOff size={17} /> : <Pin size={17} />}
                  </button>
                </header>
                {visiblePins.length > 0 && (
                  <div className="shrink-0 border-b border-primary/15 bg-primary/[0.035]">
                    <button type="button" onClick={() => setShowPinnedMessages((current) => !current)} aria-expanded={showPinnedMessages} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-primary/5">
                      <Pin size={16} className="shrink-0 text-primary" />
                      <span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-primary">Ваші закріплення · {visiblePins.length}</span><span className="block truncate text-xs text-muted-foreground">{visiblePins[0].body}</span></span>
                      {showPinnedMessages ? <ChevronUp size={16} className="shrink-0 text-primary" /> : <ChevronDown size={16} className="shrink-0 text-primary" />}
                    </button>
                    {showPinnedMessages && <div className="max-h-40 space-y-1.5 overflow-y-auto px-3 pb-3">
                      <p className="px-1 text-[10px] text-muted-foreground">Закріплення видно лише вам.</p>
                      {visiblePins.map((message) => <div key={message.id} className="flex items-start gap-1 rounded-xl border border-primary/10 bg-background p-2">
                        <button type="button" onClick={() => setPinnedPreview(message)} className="min-w-0 flex-1 text-left"><span className="line-clamp-2 block break-words text-xs">{message.body}</span><span className="mt-1 block text-[10px] text-muted-foreground">{formatTime(message.created_at)}</span></button>
                        <button type="button" onClick={() => void toggleMessagePin(message)} disabled={Boolean(pinningMessage)} title="Відкріпити повідомлення" aria-label="Відкріпити повідомлення" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/5 disabled:opacity-40"><PinOff size={13} /></button>
                      </div>)}
                    </div>}
                  </div>
                )}
                {interactionsAvailable === false && (
                  <p className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
                    Щоб увімкнути відповіді, видалення та реакції, потрібно оновити базу даних проєкту.
                  </p>
                )}
                {mediaAvailable === false && (
                  <p className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
                    Фото та відео у чаті стануть доступними після оновлення бази даних і приватного сховища.
                  </p>
                )}
                <div ref={threadScrollRef} onScroll={(event) => { const thread = event.currentTarget; threadNearBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100 }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-muted/20 px-3 py-4 sm:px-5">
                  {threadLoading ? <div className="pt-10 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div> : visibleMessages.length === 0 ? (
                    <div className="h-full min-h-48 flex flex-col items-center justify-center text-center">
                      <Link
                        to="/user/$id"
                        params={{ id: selectedConversation.peer.id }}
                        aria-label={`Відкрити профіль: ${selectedConversation.peer.full_name}`}
                        className="flex max-w-full flex-col items-center rounded-xl px-3 py-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      >
                        <Avatar profile={selectedConversation.peer} size="w-16 h-16" />
                        <p className="mt-3 max-w-full break-words font-semibold">{selectedConversation.peer.full_name}</p>
                        <span className="mt-1 text-xs text-primary">Переглянути профіль</span>
                      </Link>
                      <p className="text-sm text-muted-foreground mt-1">Ваш запит прийнято. Почніть розмову.</p>
                    </div>
                  ) : visibleMessages.map((message, index) => {
                    const mine = message.sender_id === currentUserId
                    const previousMessage = visibleMessages[index - 1]
                    const startsDay = !previousMessage || messageDayKey(previousMessage.created_at) !== messageDayKey(message.created_at)
                    const sameSender = !startsDay && previousMessage?.sender_id === message.sender_id
                    const repliedMessage = message.reply_to_message_id
                      ? visibleMessages.find((item) => item.id === message.reply_to_message_id)
                      : null
                    const attachments = message.deleted_at ? [] : (messageAttachments[message.id] || [])
                    const publication = message.deleted_at ? undefined : publications[message.id]
                    const mediaPlaceholder = attachments.length > 0 && ['Фото', 'Відео'].includes(message.body)
                    const mediaOnlyMessage = mediaPlaceholder && !message.reply_to_message_id && !message.shared_post_id && !publication
                    const richMessage = !message.deleted_at && (Boolean(publication) || attachments.length > 0 || Boolean(message.shared_post_id) || Boolean(parseStudyAssignmentLink(message.body)))
                    const pinned = pinnedMessages.some((item) => item.id === message.id)
                    const anchorRef = bubbleAnchors.current[message.id] ||= { current: null }
                    const canOpenActions = !message.deleted_at
                    const openMessageActions = () => { setActiveMessageActions(message.id); setReactionPickerFor(null) }
                    const timestamp = <time dateTime={message.created_at} title={formatMessageTimestamp(message.created_at)}
                      className={`chat-message-meta ${mediaOnlyMessage ? 'absolute bottom-2 right-2 !float-none rounded-full bg-black/65 px-1.5 py-0.5 !text-white' : 'text-muted-foreground'}`}>
                      {pinned && <Pin size={10} aria-label="Закріплено для вас" className="mr-1 inline-block" />}
                      {formatMessageClock(message.created_at)}
                    </time>
                    const groupedReactions = (reactions[message.id] || []).reduce<Record<string, { count: number; mine: boolean }>>((result, reaction) => {
                      result[reaction.emoji] ||= { count: 0, mine: false }
                      result[reaction.emoji].count += 1
                      if (reaction.user_id === currentUserId) result[reaction.emoji].mine = true
                      return result
                    }, {})
                    return (
                      <Fragment key={message.id}>
                        {startsDay && <div className="flex justify-center py-3 first:pt-0">
                          <time dateTime={messageDayKey(message.created_at)} className="rounded-full bg-background/80 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                            {formatMessageDay(message.created_at)}
                          </time>
                        </div>}
                      <div id={`direct-message-${message.id}`} className={`flex ${sameSender ? 'mt-1' : startsDay ? '' : 'mt-3'} ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`group relative flex min-w-0 w-fit max-w-[min(82%,34rem)] flex-col ${mine ? 'items-end' : 'items-start'}`}>
                          <div ref={anchorRef} tabIndex={canOpenActions ? 0 : undefined}
                            aria-haspopup={canOpenActions ? 'menu' : undefined}
                            aria-expanded={canOpenActions ? activeMessageActions === message.id : undefined}
                            onClick={(event) => { if (canOpenActions && isMessageActionTarget(event.target)) openMessageActions() }}
                            onContextMenu={(event) => { if (canOpenActions && isMessageActionTarget(event.target)) { event.preventDefault(); openMessageActions() } }}
                            onKeyDown={(event) => { if (canOpenActions && event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey) || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); openMessageActions() } }}
                            className={`${mediaOnlyMessage
                            ? 'chat-message-bubble relative overflow-hidden !border-0 !bg-transparent !p-0 !shadow-none text-foreground'
                            : `chat-message-bubble ${mine ? 'chat-message-bubble--own rounded-br-md' : 'chat-message-bubble--incoming rounded-bl-md'}`} ${arrivingMessages.has(message.id) ? 'xelay-message-arriving' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}>
                            {message.reply_to_message_id && (
                              <div className="mb-1.5 rounded-lg border-l-2 border-primary/40 bg-primary/5 px-2 py-1 text-xs text-muted-foreground">
                                <span className="mb-0.5 block font-semibold">Відповідь на повідомлення</span>
                                <span className="block truncate">{repliedMessage?.deleted_at ? 'Повідомлення видалено' : repliedMessage?.body || 'Повідомлення з історії чату'}</span>
                              </div>
                            )}
                            {((!publication && !mediaPlaceholder) || message.deleted_at) && <p className={`chat-message-text flow-root ${message.deleted_at ? 'italic opacity-70' : ''}`}>
                              {message.deleted_at ? 'Повідомлення видалено' : <ChatMessageText text={message.body} profiles={mentionProfiles} />}
                              {!richMessage && timestamp}
                            </p>}
                            {publication && <ChatPublicationCard publication={publication} onEdit={(article) => openPublicationEditor('article', message, article)} />}
                            {!message.deleted_at && message.shared_post_id && <button type="button" onClick={() => navigate({ to: '/news/$id', params: { id: message.shared_post_id! } })} className="mt-1.5 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/15">Відкрити новину</button>}
                            {!message.deleted_at && <StudyAssignmentMessageCard body={message.body} />}
                            {attachments.length > 0 && (
                              <div className={`flex max-w-full flex-wrap gap-2 ${mediaOnlyMessage ? '' : 'mt-2'}`}>
                                {attachments.map((attachment) => attachment.media_type === 'video' ? (
                                  <video key={attachment.id} src={attachment.url} controls playsInline preload="metadata" className="max-h-72 w-[min(76vw,28rem)] max-w-full rounded-xl bg-black object-contain" />
                                ) : (
                                  <button key={attachment.id} type="button" onClick={() => setMediaPreview(attachment)} aria-label={`Переглянути фото ${attachment.file_name}`} className="block w-fit max-w-full overflow-hidden rounded-2xl bg-transparent p-0">
                                    <img src={attachment.url} alt={attachment.file_name} loading="lazy" className="block h-auto max-h-72 w-auto max-w-full object-contain" />
                                  </button>
                                ))}
                              </div>
                            )}
                            {richMessage && (mediaOnlyMessage ? timestamp : <div className="mt-1 flow-root">{timestamp}</div>)}
                          </div>
                          {canOpenActions && (
                            <ChatMessageMenu open={activeMessageActions === message.id} onOpenChange={(open) => setActiveMessageActions((current) => open ? message.id : current === message.id ? null : current)} anchorRef={anchorRef}
                              align={mine ? 'right' : 'left'} className={`chat-message-actions absolute top-0 ${mine ? 'right-full mr-1' : 'left-full ml-1'}`} items={[
                              { label: 'Копіювати текст', icon: <Copy size={15} />, onSelect: () => void copyMessage(message), disabled: !message.body },
                              ...(interactionsAvailable ? [{ label: 'Відповісти', icon: <Reply size={15} />, onSelect: () => beginReply(message) },
                              { label: 'Додати реакцію', icon: <Smile size={15} />, onSelect: () => setReactionPickerFor(reactionPickerFor === message.id ? null : message.id) }] : []),
                              { label: pinned ? 'Відкріпити повідомлення' : 'Закріпити для себе',
                                icon: pinningMessage === message.id ? <Loader2 size={15} className="animate-spin" /> : pinned ? <PinOff size={15} /> : <Pin size={15} />,
                                onSelect: () => void toggleMessagePin(message), disabled: Boolean(pinningMessage) },
                              ...(mine && interactionsAvailable ? [{ label: 'Видалити для обох', icon: <Trash2 size={15} />, onSelect: () => void deleteMessage(message), destructive: true }] : []),
                            ]} />
                          )}
                          {!message.deleted_at && interactionsAvailable && Object.keys(groupedReactions).length > 0 && (
                            <div className={`mt-1 flex flex-wrap items-center gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
                              {Object.entries(groupedReactions).map(([emoji, reaction]) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => void toggleReaction(message, emoji)}
                                  aria-label={`Реакція ${emoji}, ${reaction.count}`}
                                  className={`flex h-7 items-center gap-1 rounded-full border px-2 text-xs transition-colors ${reaction.mine ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border bg-background text-foreground'}`}
                                >
                                  <span>{emoji}</span><span>{reaction.count}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          {!message.deleted_at && interactionsAvailable && reactionPickerFor === message.id && (
                            <div className={`mt-2 w-64 max-w-full rounded-2xl border border-primary/15 bg-background p-2.5 shadow-sm ${mine ? 'ml-auto' : ''}`}>
                              <div className="mb-1 flex items-center justify-between gap-2 px-1"><span className="text-[10px] font-semibold text-muted-foreground">Реакції</span><button type="button" onClick={() => setReactionPickerFor(null)} aria-label="Закрити реакції" className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={12} /></button></div>
                              <div className="grid grid-cols-6 gap-1">
                                {BASIC_MESSAGE_REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => void toggleReaction(message, emoji)} aria-label={`Поставити реакцію ${emoji}`} className="flex h-8 items-center justify-center rounded-xl transition-colors hover:bg-primary/5 active:scale-95 motion-reduce:transform-none">{emoji}</button>)}
                              </div>
                              <div className="mt-2 border-t border-primary/10 pt-2">
                                <p className="mb-1 flex items-center gap-1 px-1 text-[10px] font-semibold text-primary"><Sparkles size={11} />Додаткові реакції</p>
                                <div className="grid grid-cols-6 gap-1">
                                  {EXTRA_MESSAGE_REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => void toggleReaction(message, emoji)} aria-label={`Поставити реакцію ${emoji}`} title={emoji} className="relative flex h-8 items-center justify-center rounded-xl transition-colors hover:bg-primary/5 active:scale-95 motion-reduce:transform-none"><span>{emoji}</span></button>)}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      </Fragment>
                    )
                  })}
                </div>
                <form onSubmit={(event) => void sendMessage(event)} className="flex shrink-0 flex-col gap-2 border-t border-border/70 bg-background/90 px-3 py-2.5 sm:px-4">
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
                  {selectedMedia.length > 0 && (
                    <div className="flex flex-wrap gap-2" aria-label="Вкладені файли">
                      {selectedMedia.map((file, index) => (
                        <div key={`${file.name}-${file.lastModified}-${index}`} className="flex max-w-full items-center gap-2 rounded-xl bg-muted px-3 py-2 text-xs">
                          <span className="shrink-0 font-medium">{file.type.startsWith('video/') ? 'Відео' : 'Фото'}</span>
                          <span className="max-w-40 truncate text-muted-foreground">{file.name}</span>
                          <span className="shrink-0 text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} МБ</span>
                          <button type="button" disabled={sending} onClick={() => setSelectedMedia((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label={`Видалити вкладення ${file.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-background disabled:opacity-40"><X size={14} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!sending && <ChatMentionSuggestions value={draft} caret={draftCaret} profiles={mentionProfiles} onSelect={selectMention} inputRef={composerRef} />}
                  <div className="flex items-end gap-2">
                    <textarea
                      ref={composerRef}
                      value={draft}
                      onChange={(event) => { setDraft(event.target.value); setDraftCaret(event.target.selectionStart) }}
                      onSelect={(event) => setDraftCaret(event.currentTarget.selectionStart)}
                      onKeyDown={handleComposerKeyDown}
                      rows={1}
                      disabled={sending}
                      maxLength={5000}
                      placeholder="Напишіть повідомлення…"
                      className="min-h-11 min-w-0 max-h-32 flex-1 resize-y rounded-2xl border border-border bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                    <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={handleMediaSelection} />
                    <div className="relative h-11 w-11 shrink-0">
                      <button ref={attachmentButtonRef} type="button" onClick={() => setAttachmentMenu((current) => !current)}
                        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setAttachmentMenu(true) } }}
                        disabled={sending} aria-label="Додати фото, відео, опитування або статтю" title="Додати до чату" aria-haspopup="menu" aria-expanded={attachmentMenu}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-40">
                        <Paperclip size={18} />
                      </button>
                      <ChatMessageMenu hideTrigger open={attachmentMenu} onOpenChange={setAttachmentMenu} anchorRef={attachmentButtonRef} disabled={sending}
                        items={[
                          { label: 'Фото або відео', icon: <Paperclip size={15} />, disabled: mediaAvailable !== true, onSelect: () => mediaInputRef.current?.click() },
                          { label: 'Опитування', icon: <BarChart3 size={15} />, onSelect: () => openPublicationEditor('poll') },
                          { label: 'Стаття', icon: <FileText size={15} />, onSelect: () => openPublicationEditor('article') },
                        ]} />
                    </div>
                    <button type="submit" disabled={(!draft.trim() && !selectedMedia.length) || sending} aria-label="Надіслати повідомлення" className="h-11 w-11 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40">
                      {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={17} />}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="hidden flex-1 flex-col items-center justify-center bg-muted/20 px-8 text-center md:flex">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/60 bg-background text-primary/70 shadow-sm"><MessageCircle size={28} /></div>
                <h2 className="text-xl font-semibold">Ваші повідомлення</h2>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">Оберіть чат або дочекайтеся прийняття запиту на спілкування.</p>
              </div>
            )}
          </div>
        </section>
        {pinnedPreview && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Закріплене повідомлення">
            <button type="button" onClick={() => setPinnedPreview(null)} aria-label="Закрити повідомлення" className="absolute inset-0 cursor-default" />
            <div className="relative max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-border bg-background p-5 shadow-xl">
              <div className="mb-4 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Pin size={16} className="text-primary" />Закріплено для вас</h2><button type="button" onClick={() => setPinnedPreview(null)} aria-label="Закрити повідомлення" className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={17} /></button></div>
              {publications[pinnedPreview.id]
                ? <ChatPublicationCard publication={publications[pinnedPreview.id]} onEdit={(article) => openPublicationEditor('article', pinnedPreview, article)} />
                : <p className="whitespace-pre-wrap break-words text-sm"><ChatMessageText text={pinnedPreview.body} profiles={mentionProfiles} /></p>}
              <StudyAssignmentMessageCard body={pinnedPreview.body} />
              {(messageAttachments[pinnedPreview.id] || []).map((attachment) => attachment.media_type === 'video'
                ? <video key={attachment.id} src={attachment.url} controls playsInline preload="metadata" className="mt-3 max-h-80 w-full rounded-2xl bg-black object-contain" />
                : <button key={attachment.id} type="button" onClick={() => setMediaPreview(attachment)} aria-label={`Переглянути фото ${attachment.file_name}`} className="mt-3 block max-w-full overflow-hidden rounded-2xl"><img src={attachment.url} alt={attachment.file_name} className="max-h-80 max-w-full object-contain" /></button>)}
              {pinnedPreview.shared_post_id && <button type="button" onClick={() => navigate({ to: '/news/$id', params: { id: pinnedPreview.shared_post_id! } })} className="mt-3 rounded-full bg-primary/5 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10">Відкрити новину</button>}
              <p className="mt-3 text-xs text-muted-foreground">{formatTime(pinnedPreview.created_at)}</p>
              <button type="button" onClick={() => void toggleMessagePin(pinnedPreview)} disabled={Boolean(pinningMessage)} className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/20 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/5 disabled:opacity-40"><PinOff size={14} />Відкріпити повідомлення</button>
            </div>
          </div>
        )}
        {mediaPreview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Перегляд вкладення">
            <button type="button" onClick={() => setMediaPreview(null)} aria-label="Закрити перегляд" className="absolute inset-0 cursor-default" />
            <button type="button" onClick={() => setMediaPreview(null)} aria-label="Закрити перегляд" className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"><X size={22} /></button>
            {mediaPreview.media_type === 'video' ? (
              <video src={mediaPreview.url} controls autoPlay playsInline className="relative z-10 max-h-[88vh] max-w-full rounded-xl" />
            ) : (
              <img src={mediaPreview.url} alt={mediaPreview.file_name} className="relative z-10 max-h-[88vh] max-w-full rounded-xl object-contain" />
            )}
          </div>
        )}
        {publicationEditor && publicationEditor.userId === currentUserId && publicationEditor.conversationId === selectedId && <ChatPublicationEditor
          key={publicationEditor.id}
          kind={publicationEditor.kind}
          userId={publicationEditor.userId}
          target={{ conversationId: publicationEditor.conversationId, replyTo: publicationEditor.replyTo }}
          article={publicationEditor.article}
          onClose={() => { publicationEditorRef.current = null; setPublicationEditor(null) }}
          onSaved={() => handlePublicationSaved(publicationEditor)}
        />}
        {notice && !error && <p role="status" className="mt-3 px-2 text-sm text-muted-foreground">{notice}</p>}
        {error && <p role="alert" className="mt-3 px-2 text-sm text-red-600">{error}</p>}
      </div>
    </main>
  )
}

function isMessageActionTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  if (target.closest('a,button,input,textarea,select,video,audio,summary,[contenteditable="true"],[role="button"],[role="link"]')) return false
  return window.getSelection()?.isCollapsed !== false
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

const messageClockFormatter = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const messageDayKeyFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
})
const messageTimestampFormatter = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function messageDayKey(value: string | Date) {
  return messageDayKeyFormatter.format(typeof value === 'string' ? new Date(value) : value)
}

function formatMessageClock(value: string) {
  return messageClockFormatter.format(new Date(value))
}

function formatMessageTimestamp(value: string) {
  return messageTimestampFormatter.format(new Date(value))
}

function formatMessageDay(value: string) {
  const key = messageDayKey(value)
  const today = messageDayKey(new Date())
  if (key === today) return 'Сьогодні'
  const [year, month, day] = today.split('-').map(Number)
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
  if (key === yesterday) return 'Учора'
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long',
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' as const }),
  }).format(new Date(value))
}

async function loadPublicPremium(userIds: string[]) {
  const batches: string[][] = []
  for (let index = 0; index < userIds.length; index += 100) batches.push(userIds.slice(index, index + 100))
  const results = await Promise.all(batches.map((ids) => supabase.rpc('xelay_public_premium', { p_user_ids: ids })))
  return { data: results.flatMap((result) => result.data || []) as PublicPremium[] }
}
