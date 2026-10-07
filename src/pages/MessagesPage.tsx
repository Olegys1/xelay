import { ChangeEvent, FormEvent, Fragment, KeyboardEvent, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft, BarChart3, Check, CheckCheck, ChevronDown, ChevronUp, Clock3, Copy, FileText, Loader2, Megaphone, MessageCircle, Paperclip, Pin, PinOff, Reply, RotateCcw, Search, Send, Smile, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'
import { formatSafeDate, parseSafeDate } from '../lib/safeDates'
import { reservePrivateMedia } from '../lib/privateMedia'
import { useAuth } from '../context/AuthContext'
import { MiniGuide } from '../components/MiniGuide'
import { CHAT_GUIDE } from '../lib/pageGuides'
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
import { ConversationSearch } from '../components/ConversationSearch'
import { ScheduledDirectMessages } from '../components/ScheduledDirectMessages'
import { useParticipantAppearance } from '../lib/participantAppearance'
import './participantAppearance.css'

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
  delivery?: 'queued' | 'uploading' | 'sending' | 'failed'
  deliveryError?: string
  retryable?: boolean
  local_created_at?: string
}

interface OutgoingMessage {
  message: MessageRecord
  files: Array<{ file: File; path: string; preview: MessageAttachment; uploaded: boolean; attempted: boolean }>
  status: 'queued' | 'running' | 'failed'
  commitAttempted: boolean
}

interface CachedThread {
  messages: MessageRecord[]
  reactions: Record<string, MessageReaction[]>
  attachments: Record<string, MessageAttachment[]>
  publications: Record<string, ChatPublication>
  pins: MessageRecord[]
  draft: string
  files: File[]
  reply: MessageRecord | null
  hasMore: boolean
  scrollTop: number
  nearBottom: boolean
}

const MESSAGE_PAGE_SIZE = 40
const MAX_CACHED_THREADS = 20
const MAX_CACHED_MESSAGES = 400

function mergeMessages(current: MessageRecord[], incoming: MessageRecord[]) {
  const rows = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const existing = rows.get(message.id)
    // A read receipt must not be lost to an older request that started before it.
    rows.set(message.id, existing?.deleted_at
      ? { ...message, body: '', deleted_at: existing.deleted_at, delivery: undefined, deliveryError: undefined, local_created_at: undefined, read_at: message.read_at || existing.read_at || null }
      : { ...message, local_created_at: message.delivery ? existing?.local_created_at || message.local_created_at : undefined, read_at: message.read_at || existing?.read_at || null })
  }
  return [...rows.values()].sort((left, right) => (left.delivery && left.local_created_at || left.created_at).localeCompare(right.delivery && right.local_created_at || right.created_at) || left.id.localeCompare(right.id))
}

function emptyThread(): CachedThread {
  return { messages: [], reactions: {}, attachments: {}, publications: {}, pins: [], draft: '', files: [], reply: null, hasMore: false, scrollTop: 0, nearBottom: true }
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
    {isAuthenticated && <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-3 px-4 py-3 sm:px-6">
      {authUser && <MiniGuide userId={authUser.id} topic="chats" label="Підказки для чатів" steps={CHAT_GUIDE} layout="toolbar" />}
      <nav aria-label="Тип переписки" className="order-1 flex min-w-0 gap-1">
      {([
        { id: 'personal', label: 'Особисті', Icon: MessageCircle },
        { id: 'groups', label: 'Групи', Icon: UsersRound },
        { id: 'channels', label: 'Канали', Icon: Megaphone },
      ] as const).map(({ id, label, Icon }) => <button key={id} aria-current={selectedTab === id ? 'page' : undefined}
        onClick={() => void navigate({ to: '/messages', search: { kind: id } })}
        className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-semibold transition-colors max-[399px]:gap-1 max-[399px]:px-2 max-[399px]:text-xs sm:flex-none sm:px-5 ${selectedTab === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
        <Icon size={17} className="shrink-0 max-[359px]:hidden" />{label}
      </button>)}
      </nav>
    </div>}
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
  const { chatTheme, chatWallpaper } = useParticipantAppearance()
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
  const [conversationSearch, setConversationSearch] = useState(false)
  const [scheduledMessages, setScheduledMessages] = useState(false)
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
  const [olderLoading, setOlderLoading] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [newMessagesBelow, setNewMessagesBelow] = useState(false)
  const [contentRevision, setContentRevision] = useState(0)
  const arrivingMessages = useRecentItemMotion(messages, `${currentUserId}:${selectedId}`, !threadLoading && !loading)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const threadScrollRef = useRef<HTMLDivElement>(null)
  const threadContentRef = useRef<HTMLDivElement>(null)
  const threadNearBottom = useRef(true)
  const smoothScrollUntil = useRef(0)
  const previousThreadPosition = useRef({ conversationId: '', lastMessageId: '' })
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const mediaPreviewRef = useRef(mediaPreview)
  mediaPreviewRef.current = mediaPreview
  const attachmentButtonRef = useRef<HTMLButtonElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const bubbleAnchors = useRef<Record<string, { current: HTMLDivElement | null }>>({})
  const interactionSchemaChecked = useRef(false)
  const signedMediaUrlCache = useRef(new Map<string, { url: string; expiresAt: number }>())
  const localMediaUrls = useRef(new Set<string>())
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
  const outgoing = useRef(new Map<string, OutgoingMessage>())
  const sendQueueRunning = useRef(false)
  const idempotentSendAvailable = useRef(false)
  const realtimeReady = useRef({ inbox: false, thread: false })
  const reactionLocks = useRef(new Map<string, string>())
  const olderRequest = useRef(0)
  const prependPosition = useRef<{ conversationId: string; height: number; top: number } | null>(null)
  const threadCache = useRef(new Map<string, CachedThread>())
  const messagesRef = useRef(messages)
  const reactionsRef = useRef(reactions)
  const attachmentsRef = useRef(messageAttachments)
  const publicationsRef = useRef(publications)
  const pinsRef = useRef(pinnedMessages)
  const draftRef = useRef(draft)
  const filesRef = useRef(selectedMedia)
  const replyRef = useRef(replyingTo)
  const hasOlderRef = useRef(hasOlderMessages)
  messagesRef.current = messages
  reactionsRef.current = reactions
  attachmentsRef.current = messageAttachments
  publicationsRef.current = publications
  pinsRef.current = pinnedMessages
  draftRef.current = draft
  filesRef.current = selectedMedia
  replyRef.current = replyingTo
  hasOlderRef.current = hasOlderMessages
  const deleteLock = useRef(false)

  useEffect(() => {
    activeRef.current = true
    const { data: authChanges } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== currentUserId) identityRef.current = session?.user.id || ''
    })
    return () => {
      activeRef.current = false
      signedMediaUrlCache.current.clear()
      threadCache.current.clear()
      for (const url of localMediaUrls.current) URL.revokeObjectURL(url)
      localMediaUrls.current.clear()
      outgoing.current.clear()
      reactionLocks.current.clear()
      authChanges.subscription.unsubscribe()
    }
  }, [])

  const isCurrent = (ownerId: string, conversationId?: string) => activeRef.current
    && identityRef.current === ownerId
    && (conversationId === undefined || selectedIdRef.current === conversationId)

  const trimThreadCache = () => {
    while (threadCache.current.size > MAX_CACHED_THREADS) {
      const key = threadCache.current.keys().next().value!
      const cached = threadCache.current.get(key)!
      threadCache.current.delete(key)
      const protectedUrls = new Set([...outgoing.current.values()].flatMap((operation) => operation.files.map((media) => media.preview.url)))
      if (key !== selectedIdRef.current) for (const attachment of Object.values(cached.attachments).flat()) {
        if (localMediaUrls.current.has(attachment.url) && !protectedUrls.has(attachment.url)) {
          URL.revokeObjectURL(attachment.url); localMediaUrls.current.delete(attachment.url)
        }
      }
    }
  }

  const reconcileDeletedMessages = (rows: MessageRecord[], conversationId: string) => {
    if (selectedIdRef.current !== conversationId) return
    const deleted = new Set(rows.filter((message) => message.deleted_at).map((message) => message.id))
    if (!deleted.size) return
    const paths = new Set([...deleted].flatMap((id) => (attachmentsRef.current[id] || []).map((media) => media.storage_path)))
    setMessageAttachments((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !deleted.has(id))))
    setReactions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !deleted.has(id))))
    setPublications((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !deleted.has(id))))
    setPinnedMessages((current) => current.filter((message) => !deleted.has(message.id)))
    setPinnedPreview((current) => current && deleted.has(current.id) ? null : current)
    setMediaPreview((current) => current && paths.has(current.storage_path) ? null : current)
    setReplyingTo((current) => current && deleted.has(current.id) ? { ...current, body: '', deleted_at: new Date().toISOString() } : current)
    for (const path of paths) signedMediaUrlCache.current.delete(path)
    for (const id of deleted) for (const media of attachmentsRef.current[id] || []) {
      if (localMediaUrls.current.has(media.url)) { URL.revokeObjectURL(media.url); localMediaUrls.current.delete(media.url) }
    }
  }

  const cleanupMessageMedia = useCallback(async (ownerId: string, knownPaths: string[] = []) => {
    const valid = () => activeRef.current && identityRef.current === ownerId
    if (!valid()) return false
    try {
      const pending = await supabase.rpc('xelay_private_media_cleanup_paths', { p_bucket_id: MESSAGE_MEDIA_BUCKET, p_limit: 100 })
      if (!valid()) return false
      const receipts = (pending.data || []) as Array<{ storage_path: string }>
      const protectedPaths = new Set([...outgoing.current.values()].flatMap((operation) => operation.files.map((media) => media.path)))
      let remaining = [...new Set([...knownPaths, ...receipts.map((item) => item.storage_path)])].filter((path) => !protectedPaths.has(path))
      if (!remaining.length) return !pending.error
      for (let attempt = 0; attempt < 2 && remaining.length; attempt += 1) {
        if (!valid()) return false
        const result = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).remove(remaining)
        if (!valid()) return false
        if (result.error) {
          console.error('Could not clean up private media:', result.error)
          continue
        }
        // Storage can return success with no rows when SELECT/DELETE did not authorize a path.
        const removed = new Set((result.data || []).map((item) => item.name))
        remaining = remaining.filter((path) => !removed.has(path))
      }
      return remaining.length === 0 && !pending.error
    } catch (cleanupError) {
      console.error('Could not retry private media cleanup:', cleanupError)
      return false
    }
  }, [])

  useEffect(() => {
    if (!currentUserId) return
    const clean = () => { if (document.visibilityState === 'visible') void cleanupMessageMedia(currentUserId) }
    clean()
    const interval = window.setInterval(clean, 60_000)
    return () => window.clearInterval(interval)
  }, [currentUserId, cleanupMessageMedia])

  const selectConversation = (conversationId: string) => {
    conversationSelectionVersion.current += 1
    const previous = selectedIdRef.current
    if (previous) {
      const cached = threadCache.current.get(previous) || emptyThread()
      cached.scrollTop = threadScrollRef.current?.scrollTop || 0
      cached.nearBottom = threadNearBottom.current
      threadCache.current.set(previous, cached)
    }
    setPublicationEditor(null)
    setAttachmentMenu(false)
    setSelectedId(conversationId)
  }

  const loadReactions = useCallback(async (messageIds: string[], conversationId = selectedIdRef.current) => {
    const ownerId = identityRef.current
    if (!ownerId || !conversationId) return false
    const sequence = ++reactionSequence.current
    const valid = () => activeRef.current && identityRef.current === ownerId
      && selectedIdRef.current === conversationId && sequence === reactionSequence.current
    if (!messageIds.length) {
      const { error: schemaError } = await supabase.from('message_reactions').select('id').limit(1)
      if (!valid()) return false
      setReactions({})
      return !schemaError
    }
    const data: MessageReaction[] = []
    let reactionsError: unknown = null
    for (let offset = 0; offset < messageIds.length; offset += 100) {
      const result = await supabase.from('message_reactions').select('id, message_id, user_id, emoji')
        .in('message_id', messageIds.slice(offset, offset + 100)).limit(200)
      if (!valid()) return false
      if (result.error) { reactionsError = result.error; break }
      data.push(...(result.data || []))
    }
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
    setReactions((current) => {
      for (const id of messageIds) {
        if (reactionLocks.current.has(id)) grouped[id] = current[id] || []
      }
      return { ...current, ...Object.fromEntries(messageIds.map((id) => [id, grouped[id] || []])) }
    })
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

    const data: Array<Omit<MessageAttachment, 'url'>> = []
    let attachmentsError: unknown = null
    for (let offset = 0; offset < messageIds.length; offset += 100) {
      const result = await supabase.from('message_attachments')
        .select('id, message_id, storage_path, file_name, media_type, mime_type')
        .eq('conversation_id', conversationId).in('message_id', messageIds.slice(offset, offset + 100))
        .order('created_at', { ascending: true }).limit(100 * MAX_MESSAGE_MEDIA_FILES)
      if (!valid()) return false
      if (result.error) { attachmentsError = result.error; break }
      data.push(...(result.data || []) as Array<Omit<MessageAttachment, 'url'>>)
    }
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
    const cached = threadCache.current.get(conversationId)
    if (cached) cached.attachments = { ...cached.attachments, ...Object.fromEntries(messageIds.map((id) => [id, grouped[id] || []])) }
    setMessageAttachments((current) => {
      const next = { ...current, ...Object.fromEntries(messageIds.map((id) => [id, grouped[id] || []])) }
      const retainedUrls = new Set(Object.values(next).flatMap((items) => items.map((item) => item.url)))
      for (const id of messageIds) for (const previous of current[id] || []) {
        if (localMediaUrls.current.has(previous.url) && !retainedUrls.has(previous.url) && mediaPreviewRef.current?.url !== previous.url) {
          URL.revokeObjectURL(previous.url); localMediaUrls.current.delete(previous.url)
        }
      }
      return next
    })
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
    const aggregate = await supabase.rpc('xelay_direct_conversation_summaries')
    if (!valid()) return
    const aggregated = !aggregate.error && Array.isArray(aggregate.data)
    if (aggregated) idempotentSendAvailable.current = true
    const result = aggregated ? { data: aggregate.data, error: null }
      : ['PGRST202', '42883'].includes(aggregate.error?.code || '')
        ? await supabase.from('conversations').select('id, user_one_id, user_two_id, created_at')
          .or(`user_one_id.eq.${ownerId},user_two_id.eq.${ownerId}`).order('created_at', { ascending: false })
        : { data: null, error: aggregate.error || new Error('Invalid conversation summary response') }
    const { data, error: conversationsError } = result

    if (!valid()) return
    if (conversationsError) {
      console.error('Could not load conversations:', conversationsError)
      setError('Не вдалося завантажити чати. Перевірте, чи застосована міграція запитів і повідомлень.')
      setLoading(false)
      return
    }

    const rows = data || []
    const peerIds = rows.map((row: any) => row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id) as string[]
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

    const summaries = await Promise.all(rows.map(async (row: any) => {
      const peerId = row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id
      if (aggregated) return {
        id: row.id, createdAt: row.created_at,
        peer: profileById.get(peerId) || { id: peerId, full_name: 'Учасник Xelay', username: null, avatar_url: null, faculty: '', specialty: '' },
        lastMessage: row.last_message ? { ...row.last_message, delivery: undefined } as MessageRecord : null,
        unreadCount: Number(row.unread_count) || 0,
      } satisfies ConversationSummary
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
    setConversations((current) => summaries.map((conversation) => {
      const previous = current.find((item) => item.id === conversation.id)
      if (previous?.lastMessage?.id === conversation.lastMessage?.id && previous?.lastMessage?.deleted_at) {
        conversation.lastMessage = { ...conversation.lastMessage!, body: '', deleted_at: previous.lastMessage.deleted_at }
      }
      const pending = [...outgoing.current.values()].filter((operation) => operation.message.conversation_id === conversation.id)
        .map((operation) => operation.message).sort((left, right) => right.created_at.localeCompare(left.created_at))[0]
      return pending && pending.created_at > (conversation.lastMessage?.created_at || '')
        ? { ...conversation, lastMessage: pending } : conversation
    }))
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
    let refreshTimer = 0
    const refresh = () => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => { if (document.visibilityState === 'visible') void loadConversations() }, 180)
    }
    const channel = supabase.channel(`direct-inbox:${authUser.id}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `sender_id=eq.${authUser.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `recipient_id=eq.${authUser.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_one_id=eq.${authUser.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_two_id=eq.${authUser.id}` }, refresh)
      .subscribe((status) => { realtimeReady.current.inbox = status === 'SUBSCRIBED'; if (status === 'SUBSCRIBED') refresh() })
    const interval = window.setInterval(() => {
      if (!realtimeReady.current.inbox && document.visibilityState === 'visible') void loadConversations()
    }, 60_000)
    const resume = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      realtimeReady.current.inbox = false
      window.clearInterval(interval); window.clearTimeout(refreshTimer)
      window.removeEventListener('focus', resume); window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      void supabase.removeChannel(channel)
    }
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
        selectConversation(data.id)
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
    if (!authUser?.id || !conversationId || messageLoading.current?.id === conversationId || deleteLock.current) return
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
      .order('id', { ascending: false })
      .limit(MESSAGE_PAGE_SIZE)
    if (!valid()) return

    let loadedMessages: any[] = []
    let messagesError = messageResult.error
    let supportsInteractionColumns = !messageResult.error
    if (isMissingDatabaseColumn(messageResult.error)) {
      let legacyResult = await supabase.from('messages')
        .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at, shared_post_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE)
      if (isMissingDatabaseColumn(legacyResult.error)) {
        legacyResult = await supabase.from('messages')
          .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(MESSAGE_PAGE_SIZE) as typeof legacyResult
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

    const ordered = data.reverse()
    const previous = messagesRef.current.filter((message) => message.conversation_id === conversationId)
    const previousServer = previous.filter((message) => !message.delivery)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
    const lastCached = previousServer[previousServer.length - 1]
    let refreshed = ordered
    let resetHistory = false
    if (lastCached && ordered[0]?.created_at > lastCached.created_at) {
      const gap = await supabase.from('messages').select('*').eq('conversation_id', conversationId)
        .gte('created_at', lastCached.created_at).order('created_at').order('id').limit(MAX_CACHED_MESSAGES + 1)
      if (!valid()) return
      if (gap.error) throw gap.error
      if ((gap.data || []).length > MAX_CACHED_MESSAGES) resetHistory = true
      else refreshed = (gap.data || []) as MessageRecord[]
    }
    setMessages((current) => mergeMessages(resetHistory ? current.filter((message) => message.delivery) : current, refreshed))
    reconcileDeletedMessages(refreshed, conversationId)
    if (supportsInteractionColumns && !resetHistory) {
      const refreshedIds = new Set(refreshed.map((message) => message.id))
      const olderRecords = previousServer.filter((message) => !refreshedIds.has(message.id))
      for (let offset = 0; offset < olderRecords.length; offset += 100) {
        const batch = olderRecords.slice(offset, offset + 100)
        const metadata = await supabase.from('messages').select('id, read_at, deleted_at')
          .eq('conversation_id', conversationId).in('id', batch.map((message) => message.id)).limit(100)
        if (!valid()) return
        if (metadata.error) throw metadata.error
        const byId = new Map(batch.map((message) => [message.id, message]))
        const updates = (metadata.data || []).map((row) => ({ ...byId.get(row.id)!, ...row, body: row.deleted_at ? '' : byId.get(row.id)!.body }))
        const retainedIds = new Set(updates.map((message) => message.id))
        const missingIds = new Set(batch.filter((message) => !retainedIds.has(message.id)).map((message) => message.id))
        setMessages((current) => mergeMessages(current.filter((message) => !missingIds.has(message.id)), updates))
        reconcileDeletedMessages(updates, conversationId)
      }
    }
    if (!previousServer.length || resetHistory) setHasOlderMessages(data.length === MESSAGE_PAGE_SIZE)
    const confirmedIds = new Set(refreshed.map((message) => message.id))
    for (const id of confirmedIds) outgoing.current.delete(id)
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
    const unreadIds = refreshed
      .filter((message) => message.recipient_id === authUser.id && !message.read_at)
      .map((message) => message.id)
    if (unreadIds.length && document.visibilityState === 'visible' && document.hasFocus()) {
      await supabase.from('messages').update({ read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId).eq('recipient_id', ownerId).in('id', unreadIds).is('read_at', null)
      if (!valid()) return
      window.dispatchEvent(new Event('xelay-chat-updated'))
      void loadConversations()
    }
    } catch {
      if (valid()) { setError('Не вдалося оновити повідомлення. Спробуйте ще раз.'); setThreadLoading(false) }
    } finally {
      if (messageLoading.current?.sequence === sequence) messageLoading.current = null
    }
  }, [authUser?.id, loadConversations, loadReactions])

  const loadOlderMessages = async () => {
    const conversationId = selectedIdRef.current
    const ownerId = identityRef.current
    const oldest = messagesRef.current.filter((message) => message.conversation_id === conversationId && !message.delivery)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))[0]
    if (!ownerId || !oldest || olderLoading || !hasOlderRef.current) return
    const sequence = ++olderRequest.current
    const valid = () => isCurrent(ownerId, conversationId) && sequence === olderRequest.current
    setOlderLoading(true)
    try {
      const { data, error: historyError } = await supabase.from('messages').select('*')
        .eq('conversation_id', conversationId)
        .or(`created_at.lt.${oldest.created_at},and(created_at.eq.${oldest.created_at},id.lt.${oldest.id})`)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MESSAGE_PAGE_SIZE)
      if (!valid()) return
      if (historyError) throw historyError
      const thread = threadScrollRef.current
      if (thread) { prependPosition.current = { conversationId, height: thread.scrollHeight, top: thread.scrollTop }; threadNearBottom.current = false }
      setMessages((current) => mergeMessages(current, (data || []) as MessageRecord[]))
      reconcileDeletedMessages((data || []) as MessageRecord[], conversationId)
      setHasOlderMessages((data || []).length === MESSAGE_PAGE_SIZE)
      void loadReactions((data || []).map((message) => message.id), conversationId)
      const unreadIds = (data || []).filter((message) => message.recipient_id === ownerId && !message.read_at).map((message) => message.id)
      if (unreadIds.length && document.visibilityState === 'visible' && document.hasFocus()) {
        const read = await supabase.from('messages').update({ read_at: new Date().toISOString() })
          .eq('conversation_id', conversationId).eq('recipient_id', ownerId).in('id', unreadIds).is('read_at', null)
        if (!valid()) return
        if (!read.error) { window.dispatchEvent(new Event('xelay-chat-updated')); void loadConversations() }
      }
    } catch {
      if (valid()) setError('Не вдалося завантажити попередні повідомлення. Спробуйте ще раз.')
    } finally {
      if (valid()) setOlderLoading(false)
    }
  }

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
    if (!currentUserId || !selectedId || (message && (message.delivery || message.deleted_at || message.conversation_id !== selectedId))) return
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

  useLayoutEffect(() => {
    ++messageSequence.current
    ++pinSequence.current
    ++reactionSequence.current
    ++attachmentSequence.current
    ++publicationSequence.current
    ++olderRequest.current
    const cached = threadCache.current.get(selectedId)
    const pendingMessages = [...outgoing.current.values()].filter((operation) => operation.message.conversation_id === selectedId).map((operation) => operation.message)
    setMessages(mergeMessages(cached?.messages || [], pendingMessages))
    setReactions(cached?.reactions || {})
    setMessageAttachments(cached?.attachments || {})
    setPublications(cached?.publications || {})
    setPublicationEditor(null)
    setAttachmentMenu(false)
    setMediaPreview(null)
    setDraft(cached?.draft || '')
    setDraftCaret(cached?.draft.length || 0)
    setActiveMessageActions(null)
    setNotice('')
    bubbleAnchors.current = {}
    if (!selectedId) return
    setReplyingTo(cached?.reply || null)
    setReactionPickerFor(null)
    setSelectedMedia(cached?.files || [])
    setPinnedMessages(cached?.pins || [])
    setHasOlderMessages(cached?.hasMore || false)
    setOlderLoading(false)
    setNewMessagesBelow(false)
    threadNearBottom.current = cached?.nearBottom ?? true
    setPinnedPreview(null)
    setShowPinnedMessages(false)
    void loadMessages(selectedId, !cached?.messages.length)
    void loadPinnedMessages(selectedId)
    let refreshTimer = 0
    const refresh = () => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        if (!isCurrent(currentUserId, selectedId) || document.visibilityState !== 'visible') return
        void loadMessages(selectedId); void loadPinnedMessages(selectedId)
        setContentRevision((revision) => revision + 1)
      }, 200)
    }
    const markRead = (message: MessageRecord) => {
      if (message.recipient_id !== currentUserId || message.read_at || document.visibilityState !== 'visible' || !document.hasFocus()) return
      void supabase.from('messages').update({ read_at: new Date().toISOString() })
        .eq('id', message.id).eq('conversation_id', selectedId).eq('recipient_id', currentUserId).is('read_at', null)
        .then(() => { if (isCurrent(currentUserId, selectedId)) window.dispatchEvent(new Event('xelay-chat-updated')) })
    }
    const channel = supabase.channel(`direct-thread:${currentUserId}:${selectedId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedId}` }, (event) => {
        if (!isCurrent(currentUserId, selectedId)) return
        if (event.eventType === 'DELETE') { refresh(); return }
        const message = event.new as MessageRecord
        if (!message.id || message.conversation_id !== selectedId) return
        outgoing.current.delete(message.id)
        setMessages((current) => mergeMessages(current, [message]))
        if (message.deleted_at) {
          reconcileDeletedMessages([message], selectedId)
        }
        markRead(message)
        window.dispatchEvent(new Event('xelay-chat-updated'))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (event) => {
        if (!isCurrent(currentUserId, selectedId)) return
        const reaction = (event.eventType === 'DELETE' ? event.old : event.new) as MessageReaction
        const messageId = reaction.message_id || Object.keys(reactionsRef.current).find((id) => reactionsRef.current[id].some((item) => item.id === reaction.id))
        if (!messageId || reactionLocks.current.has(messageId) || !messagesRef.current.some((message) => message.id === messageId)) return
        setReactions((current) => ({ ...current, [messageId]: event.eventType === 'DELETE'
          ? (current[messageId] || []).filter((item) => item.id !== reaction.id)
          : [...(current[messageId] || []).filter((item) => item.id !== reaction.id && item.user_id !== reaction.user_id), reaction] }))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_attachments', filter: `conversation_id=eq.${selectedId}` }, () => {
        if (isCurrent(currentUserId, selectedId)) setContentRevision((revision) => revision + 1)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_publications' }, (event) => {
        if (!isCurrent(currentUserId, selectedId)) return
        const publication = (event.eventType === 'DELETE' ? event.old : event.new) as { id?: string; message_id?: string }
        if (publication.message_id && messagesRef.current.some((message) => message.id === publication.message_id)
          || Object.values(publicationsRef.current).some((item) => item.id === publication.id)) {
          setContentRevision((revision) => revision + 1)
        }
      })
      .subscribe((status) => { realtimeReady.current.thread = status === 'SUBSCRIBED'; if (status === 'SUBSCRIBED') refresh() })
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      refresh()
    }, 60_000)
    const resume = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', resume); window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      const threadMessages = messagesRef.current.filter((message) => message.conversation_id === selectedId)
      if (threadMessages.length || draftRef.current || filesRef.current.length) {
        const retained = [...threadMessages.slice(-MAX_CACHED_MESSAGES).filter((message) => !message.delivery), ...threadMessages.filter((message) => message.delivery)]
        const retainedIds = new Set([...retained, ...pinsRef.current].map((message) => message.id))
        const previousCached = threadCache.current.get(selectedId)
        threadCache.current.delete(selectedId)
        threadCache.current.set(selectedId, {
          messages: mergeMessages([], retained),
          reactions: Object.fromEntries(Object.entries(reactionsRef.current).filter(([id]) => retainedIds.has(id))),
          attachments: Object.fromEntries(Object.entries(attachmentsRef.current).filter(([id]) => retainedIds.has(id))),
          publications: Object.fromEntries(Object.entries(publicationsRef.current).filter(([id]) => retainedIds.has(id))),
          pins: pinsRef.current, draft: draftRef.current, files: filesRef.current, reply: replyRef.current,
          hasMore: hasOlderRef.current || threadMessages.length > MAX_CACHED_MESSAGES,
          scrollTop: selectedIdRef.current === selectedId ? threadScrollRef.current?.scrollTop || 0 : previousCached?.scrollTop || 0,
          nearBottom: selectedIdRef.current === selectedId ? threadNearBottom.current : previousCached?.nearBottom ?? true,
        })
        trimThreadCache()
      }
      ++messageSequence.current
      ++pinSequence.current
      ++reactionSequence.current
      ++attachmentSequence.current
      ++publicationSequence.current
      ++olderRequest.current
      realtimeReady.current.thread = false
      window.clearInterval(interval)
      window.clearTimeout(refreshTimer)
      window.removeEventListener('focus', resume); window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      void supabase.removeChannel(channel)
    }
  }, [selectedId, currentUserId, loadMessages, loadPinnedMessages])

  const contentIds = [...new Set([...messages, ...pinnedMessages]
    .filter((message) => message.conversation_id === selectedId && !message.deleted_at && !message.delivery)
    .map((message) => message.id))].sort().join(',')
  useEffect(() => {
    if (!selectedId) return
    const ids = contentIds ? contentIds.split(',') : []
    void loadMessageAttachments(ids)
    void loadDirectPublications(ids, selectedId)
  }, [contentIds, contentRevision, selectedId, loadMessageAttachments, loadDirectPublications])

  useLayoutEffect(() => {
    const threadMessages = messages.filter((message) => message.conversation_id === selectedId)
    const lastMessage = threadMessages[threadMessages.length - 1]
    if (!selectedId || !lastMessage || !threadScrollRef.current) return
    const previous = previousThreadPosition.current
    const changedThread = previous.conversationId !== selectedId
    const newMessage = previous.lastMessageId !== lastMessage.id
    const prepend = prependPosition.current
    if (prepend?.conversationId === selectedId) {
      threadScrollRef.current.scrollTop = prepend.top + threadScrollRef.current.scrollHeight - prepend.height
      prependPosition.current = null
      return
    }
    const cached = threadCache.current.get(selectedId)
    if (changedThread && cached && !cached.nearBottom) {
      threadScrollRef.current.scrollTop = cached.scrollTop
      threadNearBottom.current = false
    } else
    if (changedThread || (newMessage && (threadNearBottom.current || lastMessage.sender_id === currentUserId))) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      smoothScrollUntil.current = changedThread || reduceMotion ? 0 : Date.now() + 550
      threadScrollRef.current.scrollTo({ top: threadScrollRef.current.scrollHeight, behavior: changedThread || reduceMotion ? 'auto' : 'smooth' })
      threadNearBottom.current = true
      setNewMessagesBelow(false)
    } else if (newMessage && lastMessage.sender_id !== currentUserId) {
      setNewMessagesBelow(true)
    }
    previousThreadPosition.current = { conversationId: selectedId, lastMessageId: lastMessage.id }
  }, [messages, selectedId, currentUserId])

  useLayoutEffect(() => {
    const composer = composerRef.current
    if (!composer) return
    composer.style.height = 'auto'
    composer.style.height = `${Math.min(composer.scrollHeight, 128)}px`
  }, [draft, selectedId])

  useEffect(() => {
    const thread = threadScrollRef.current
    const content = threadContentRef.current
    if (!selectedId || !thread || !content) return
    let settleTimer = 0
    const keepPosition = () => {
      if (!threadNearBottom.current || prependPosition.current) return
      if (Date.now() < smoothScrollUntil.current) {
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(keepPosition, smoothScrollUntil.current - Date.now() + 10)
      } else thread.scrollTop = thread.scrollHeight
    }
    const observer = new ResizeObserver(keepPosition)
    observer.observe(content); observer.observe(thread)
    window.visualViewport?.addEventListener('resize', keepPosition)
    return () => { observer.disconnect(); window.clearTimeout(settleTimer); window.visualViewport?.removeEventListener('resize', keepPosition) }
  }, [selectedId, threadLoading, loading, conversations.length])

  useEffect(() => {
    if (pinnedPreview && !pinnedMessages.some((message) => message.id === pinnedPreview.id)) setPinnedPreview(null)
  }, [pinnedMessages, pinnedPreview])

  useEffect(() => {
    const retained = new Set([
      ...Object.values(messageAttachments).flat().map((media) => media.url),
      ...[...threadCache.current.values()].flatMap((cached) => Object.values(cached.attachments).flat().map((media) => media.url)),
      ...[...outgoing.current.values()].flatMap((operation) => operation.files.map((media) => media.preview.url)),
      ...(mediaPreview ? [mediaPreview.url] : []),
    ])
    for (const url of localMediaUrls.current) if (!retained.has(url)) {
      URL.revokeObjectURL(url); localMediaUrls.current.delete(url)
    }
  }, [messageAttachments, mediaPreview])

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
    if (!authUser?.id || message.delivery || message.deleted_at || messagePinLock.current || message.conversation_id !== selectedIdRef.current) return
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
    const cachedDraftBytes = [...threadCache.current.entries()].filter(([id]) => id !== selectedId)
      .reduce((total, [, cached]) => total + cached.files.reduce((sum, file) => sum + file.size, 0), 0)
    if (cachedDraftBytes + totalSize > 100 * 1024 * 1024) {
      setError('У чернетках забагато файлів. Надішліть або приберіть вкладення в інших чатах.')
      return
    }
    setError('')
    setSelectedMedia((current) => [...current, ...files])
  }

  const updateOutgoing = (operation: OutgoingMessage, message: MessageRecord) => {
    if (!isCurrent(operation.message.sender_id)) return
    operation.message = message
    const cached = threadCache.current.get(message.conversation_id) || emptyThread()
    cached.messages = mergeMessages(cached.messages, [message])
    threadCache.current.set(message.conversation_id, cached)
    trimThreadCache()
    if (selectedIdRef.current === message.conversation_id) setMessages((current) => mergeMessages(current, [message]))
    setConversations((current) => current.map((conversation) => conversation.id === message.conversation_id
      && (!conversation.lastMessage || conversation.lastMessage.id === message.id || conversation.lastMessage.created_at <= message.created_at)
      ? { ...conversation, lastMessage: message } : conversation))
  }

  const processSendQueue = async () => {
    if (sendQueueRunning.current || !activeRef.current) return
    sendQueueRunning.current = true
    try {
      while (activeRef.current) {
        const operation = [...outgoing.current.values()].find((item) => item.status === 'queued')
        if (!operation) break
        operation.status = 'running'
        const { sender_id: ownerId, conversation_id: conversationId, id: messageId } = operation.message
        const valid = () => isCurrent(ownerId)
        const checkIdentity = async () => {
          const { data } = await supabase.auth.getSession()
          if (!valid() || data.session?.user.id !== ownerId) throw new Error('CHAT_AUTH_CHANGED')
        }
        const verifyExisting = async (record: MessageRecord) => {
          if (record.sender_id !== ownerId || record.recipient_id !== operation.message.recipient_id || record.conversation_id !== conversationId
            || (!record.deleted_at && (record.body !== operation.message.body || (record.reply_to_message_id || null) !== operation.message.reply_to_message_id || record.shared_post_id))) {
            throw new Error('DIRECT_MESSAGE_ID_CONFLICT')
          }
          if (record.deleted_at) return
          const attachments = await supabase.from('message_attachments').select('storage_path, file_name, media_type, mime_type')
            .eq('message_id', messageId).eq('conversation_id', conversationId).limit(MAX_MESSAGE_MEDIA_FILES + 1)
          if (!valid()) throw new Error('CHAT_AUTH_CHANGED')
          if (attachments.error) throw attachments.error
          const canonical = (items: Array<{ storage_path: string; file_name: string; media_type: string; mime_type: string }>) => JSON.stringify(
            items.map((item) => [item.storage_path, item.file_name, item.media_type, item.mime_type]).sort((left, right) => left[0].localeCompare(right[0])))
          if (canonical(attachments.data || []) !== canonical(operation.files.map((media) => media.preview))) throw new Error('DIRECT_MESSAGE_ID_CONFLICT')
        }
        const acknowledge = (record: MessageRecord) => {
          if (!valid()) return
          const selected = selectedIdRef.current === conversationId
          const previews = record.deleted_at || !selected ? [] : operation.files.map((media) => media.preview)
          const cached = threadCache.current.get(conversationId) || emptyThread()
          cached.attachments[messageId] = record.deleted_at || !selected ? [] : attachmentsRef.current[messageId]?.length
            ? attachmentsRef.current[messageId] : previews.filter((media) => localMediaUrls.current.has(media.url))
          threadCache.current.set(conversationId, cached)
          if (selectedIdRef.current === conversationId && previews.length) {
            setMessageAttachments((current) => ({ ...current, [messageId]: current[messageId]?.length ? current[messageId] : previews }))
          }
          updateOutgoing(operation, { ...record, delivery: undefined, deliveryError: undefined })
          reconcileDeletedMessages([record], conversationId)
          outgoing.current.delete(messageId)
          if (!selected || record.deleted_at) for (const media of operation.files) {
            if (mediaPreviewRef.current?.url !== media.preview.url) {
              URL.revokeObjectURL(media.preview.url); localMediaUrls.current.delete(media.preview.url)
            }
          }
          if (selectedIdRef.current === conversationId) setContentRevision((revision) => revision + 1)
          window.dispatchEvent(new Event('xelay-chat-updated'))
          void loadConversations()
        }
        try {
          await checkIdentity()
          if (operation.commitAttempted) {
            const existing = await supabase.from('messages').select('*').eq('id', messageId)
              .eq('conversation_id', conversationId).eq('sender_id', ownerId).maybeSingle()
            if (!valid()) break
            if (existing.error) throw existing.error
            if (existing.data) { await verifyExisting(existing.data as MessageRecord); acknowledge(existing.data as MessageRecord); continue }
            if (!idempotentSendAvailable.current) throw new Error('DIRECT_SAFE_RETRY_UNAVAILABLE')
          }
          for (const media of operation.files) {
            await checkIdentity()
            updateOutgoing(operation, { ...operation.message, delivery: 'uploading', deliveryError: undefined })
            if (media.attempted) {
              const directory = media.path.slice(0, media.path.lastIndexOf('/'))
              const name = media.path.slice(media.path.lastIndexOf('/') + 1)
              const info = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).list(directory, { search: name, limit: 2 })
              if (!valid()) break
              if (info.error) throw info.error
              const stored = info.data?.find((item) => item.name === name)
              if (stored) {
                if (Number(stored.metadata?.size) !== media.file.size || stored.metadata?.mimetype !== media.file.type) throw new Error('PRIVATE_MEDIA_INVALID')
                media.uploaded = true
                continue
              }
            }
            await reservePrivateMedia(MESSAGE_MEDIA_BUCKET, media.path)
            await checkIdentity()
            media.attempted = true
            const upload = await supabase.storage.from(MESSAGE_MEDIA_BUCKET)
              .upload(media.path, media.file, { contentType: media.file.type, upsert: false })
            if (!valid()) break
            if (upload.error) throw upload.error
            media.uploaded = true
          }
          await checkIdentity()
          updateOutgoing(operation, { ...operation.message, delivery: 'sending', deliveryError: undefined })
          operation.commitAttempted = true
          const payload = {
            p_message_id: messageId, p_conversation_id: conversationId, p_body: operation.message.body,
            p_reply_to: operation.message.reply_to_message_id,
            p_attachments: operation.files.map(({ preview }) => ({
              storage_path: preview.storage_path, file_name: preview.file_name,
              media_type: preview.media_type, mime_type: preview.mime_type,
            })),
          }
          if (!idempotentSendAvailable.current) throw new Error('DIRECT_SAFE_RETRY_UNAVAILABLE')
          const result = await supabase.rpc('xelay_send_direct_message_checked', { ...payload, p_sender_id: ownerId })
          if (!valid()) break
          if (result.error) throw result.error
          if (!result.data) throw new Error('Message response missing')
          acknowledge(result.data as MessageRecord)
        } catch (sendError) {
          if (!valid()) break
          // A disconnected response can hide a committed message. Reconcile its exact UUID
          // before exposing retry; never delete files while the result is uncertain.
          if (operation.commitAttempted) {
            try {
              const existing = await supabase.from('messages').select('*').eq('id', messageId)
                .eq('conversation_id', conversationId).eq('sender_id', ownerId).maybeSingle()
              if (!valid()) break
              if (!existing.error && existing.data) { await verifyExisting(existing.data as MessageRecord); acknowledge(existing.data as MessageRecord); continue }
            } catch { /* Keep the same payload for an explicit retry after reconnection. */ }
          }
          if (!outgoing.current.has(messageId)) continue
          operation.status = 'failed'
          const reason = String((sendError as { message?: string })?.message || '')
          updateOutgoing(operation, { ...operation.message, delivery: 'failed', deliveryError: privateMessageError(sendError), retryable: !/DIRECT_MESSAGE_ID_CONFLICT|DIRECT_MESSAGE_REMOVED|CHAT_CONNECTION_REQUIRED|CHAT_MEMBER_REQUIRED/.test(reason) })
        }
      }
    } finally { sendQueueRunning.current = false }
  }

  const retryMessage = (message: MessageRecord) => {
    const operation = outgoing.current.get(message.id)
    if (!operation || operation.status !== 'failed' || !isCurrent(message.sender_id, message.conversation_id)) return
    operation.status = 'queued'
    updateOutgoing(operation, { ...operation.message, delivery: 'queued', deliveryError: undefined })
    void processSendQueue()
  }

  const discardLocalMessage = async (message: MessageRecord) => {
    const operation = outgoing.current.get(message.id)
    if (!operation || operation.status !== 'failed' || !isCurrent(message.sender_id, message.conversation_id)) return
    if (operation.commitAttempted) {
      try {
        const existing = await supabase.from('messages').select('*').eq('id', message.id)
          .eq('conversation_id', message.conversation_id).eq('sender_id', message.sender_id).maybeSingle()
        if (!isCurrent(message.sender_id, message.conversation_id)) return
        if (existing.error) throw existing.error
        if (existing.data) { updateOutgoing(operation, existing.data as MessageRecord); outgoing.current.delete(message.id); return }
      } catch {
        setError('Спочатку відновіть з’єднання, щоб перевірити стан цього повідомлення.')
        return
      }
    }
    outgoing.current.delete(message.id)
    for (const media of operation.files) { URL.revokeObjectURL(media.preview.url); localMediaUrls.current.delete(media.preview.url) }
    setMessages((current) => current.filter((item) => item.id !== message.id))
    const cached = threadCache.current.get(message.conversation_id)
    if (cached) cached.messages = cached.messages.filter((item) => item.id !== message.id)
    // Reserved, unbound objects are cleaned by the existing server receipt sweep.
    void loadConversations()
  }

  const sendMessage = (event?: FormEvent) => {
    event?.preventDefault()
    const body = draftRef.current.trim()
    const files = [...filesRef.current]
    if ((!body && !files.length) || !selectedConversation || !currentUserId || publicationEditorRef.current) return
    if (!idempotentSendAvailable.current) {
      notify({ tone: 'warning', title: 'Оновлення чату ще не підключено', description: 'Потрібно застосувати оновлення бази даних. Ваша чернетка збережена.' })
      return
    }
    if (files.length && !mediaAvailable) { setError('Вкладення стануть доступними після оновлення бази даних проєкту.'); return }
    const pendingBytes = [...outgoing.current.values()].reduce((total, operation) => total + operation.files.reduce((sum, item) => sum + item.file.size, 0), 0)
    if (outgoing.current.size >= 20 || pendingBytes + files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
      notify({ tone: 'warning', title: 'Зачекайте завершення надсилання', description: 'Черга заповнена. Повторіть або приберіть повідомлення з помилкою.' })
      return
    }
    const messageId = crypto.randomUUID()
    const conversationId = selectedConversation.id
    const message: MessageRecord = {
      id: messageId, conversation_id: conversationId, sender_id: currentUserId, recipient_id: selectedConversation.peer.id,
      body: body || (files.some((file) => file.type.startsWith('video/')) ? 'Відео' : 'Фото'),
      created_at: new Date().toISOString(), local_created_at: new Date().toISOString(), read_at: null, shared_post_id: null,
      reply_to_message_id: interactionsAvailable ? replyRef.current?.id || null : null, deleted_at: null, delivery: 'queued',
    }
    const operation: OutgoingMessage = {
      message, status: 'queued', commitAttempted: false,
      files: files.map((file) => {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'media'
        const path = `${conversationId}/${currentUserId}/${messageId}/${crypto.randomUUID()}-${safeName}`
        const url = URL.createObjectURL(file)
        localMediaUrls.current.add(url)
        return { file, path, uploaded: false, attempted: false, preview: {
          id: path, message_id: messageId, storage_path: path, file_name: file.name.slice(0, 255),
          media_type: file.type.startsWith('video/') ? 'video' as const : 'image' as const, mime_type: file.type, url,
        } }
      }),
    }
    outgoing.current.set(messageId, operation)
    updateOutgoing(operation, message)
    draftRef.current = ''; filesRef.current = []; replyRef.current = null
    setDraft(''); setDraftCaret(0); setSelectedMedia([]); setReplyingTo(null); setError(''); setAttachmentMenu(false)
    requestAnimationFrame(() => { if (isCurrent(currentUserId, conversationId)) composerRef.current?.focus() })
    void processSendQueue()
  }

  const toggleReaction = async (message: MessageRecord, emoji: string) => {
    if (!authUser?.id || !interactionsAvailable || message.delivery || message.deleted_at || reactionLocks.current.has(message.id) || message.conversation_id !== selectedIdRef.current) return
    const ownerId = authUser.id
    const ownReaction = (reactionsRef.current[message.id] || []).find((reaction) => reaction.user_id === ownerId)
    const token = crypto.randomUUID()
    reactionLocks.current.set(message.id, token)
    const replaceOwn = (reaction: MessageReaction | undefined) => {
      if (!isCurrent(ownerId) || reactionLocks.current.get(message.id) !== token) return
      const update = (current: Record<string, MessageReaction[]>) => ({ ...current, [message.id]: [
        ...(current[message.id] || []).filter((item) => item.user_id !== ownerId), ...(reaction ? [reaction] : []),
      ] })
      if (selectedIdRef.current === message.conversation_id) setReactions((current) => {
        const next = update(current); reactionsRef.current = next; return next
      })
      else {
        const cached = threadCache.current.get(message.conversation_id)
        if (cached) cached.reactions = update(cached.reactions)
      }
    }
    replaceOwn(ownReaction?.emoji === emoji ? undefined : { id: ownReaction?.id || token, message_id: message.id, user_id: ownerId, emoji })
    ++reactionSequence.current
    setError(''); setReactionPickerFor(null)
    try {
    const result = ownReaction?.emoji === emoji
      ? await supabase.from('message_reactions').delete().eq('id', ownReaction.id).eq('user_id', ownerId)
      : await supabase.from('message_reactions').upsert({
        message_id: message.id,
        user_id: authUser.id,
        emoji,
      }, { onConflict: 'message_id,user_id' }).select('id, message_id, user_id, emoji').single()
    if (result.error) throw result.error
    replaceOwn(ownReaction?.emoji === emoji ? undefined : result.data as MessageReaction)
    } catch {
      replaceOwn(ownReaction)
      if (isCurrent(ownerId, message.conversation_id)) setError('Не вдалося оновити реакцію. Спробуйте ще раз.')
    } finally {
      if (reactionLocks.current.get(message.id) === token) reactionLocks.current.delete(message.id)
      if (isCurrent(ownerId, message.conversation_id)) void loadReactions([message.id], message.conversation_id)
    }
  }

  const deleteMessage = async (message: MessageRecord) => {
    if (!authUser?.id || message.delivery || message.sender_id !== authUser.id || message.deleted_at || deleteLock.current || message.conversation_id !== selectedIdRef.current) return
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
      const removed = await cleanupMessageMedia(ownerId, attachmentsToRemove.map((attachment) => attachment.storage_path))
      if (!removed && isCurrent(ownerId)) notify({ id: 'direct-media-cleanup', tone: 'warning', title: 'Повідомлення видалено', description: 'Файли ще очікують очищення. Спробуємо знову, поки чат відкритий.' })
    } else {
      // The message may have attachments that have not loaded into this page's cache yet.
      const removed = await cleanupMessageMedia(ownerId)
      if (!removed && isCurrent(ownerId)) notify({ id: 'direct-media-cleanup', tone: 'warning', title: 'Повідомлення видалено', description: 'Очищення файлів буде повторено, поки чат відкритий.' })
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
    if (!message.delivery && !message.deleted_at && interactionsAvailable) {
      setReplyingTo(message)
      setReactionPickerFor(null)
      composerRef.current?.focus()
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
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
                  <button type="button" onClick={() => setConversationSearch(true)} title="Пошук у переписці" aria-label="Пошук у переписці" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-primary"><Search size={17} /></button>
                  <button type="button" onClick={() => setScheduledMessages(true)} title="Відкладені повідомлення" aria-label="Відкладені повідомлення" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-primary"><Clock3 size={17} /></button>
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
                <div ref={threadScrollRef} onWheel={(event) => { smoothScrollUntil.current = 0; if (event.deltaY < 0) threadNearBottom.current = false }}
                  onTouchMove={() => { smoothScrollUntil.current = 0; threadNearBottom.current = false }}
                  onKeyDown={(event) => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) { smoothScrollUntil.current = 0; if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) threadNearBottom.current = false } }}
                  onScroll={(event) => {
                  const thread = event.currentTarget
                  if (Date.now() < smoothScrollUntil.current) return
                  threadNearBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100
                  if (threadNearBottom.current) setNewMessagesBelow(false)
                }} className={`xelay-chat-theme-${chatTheme} xelay-chat-wallpaper-${chatWallpaper} min-h-0 flex-1 overflow-y-auto overscroll-contain bg-muted/20 px-3 py-4 sm:px-5`}>
                  <div ref={threadContentRef}>
                  {hasOlderMessages && <div className="flex justify-center pb-3"><button type="button" onClick={() => void loadOlderMessages()} disabled={olderLoading}
                    className="inline-flex min-h-9 items-center gap-2 rounded-full bg-background/90 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
                    {olderLoading ? <Loader2 size={13} className="animate-spin" /> : <ChevronUp size={13} />}Попередні повідомлення
                  </button></div>}
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
                    const attachments = message.deleted_at ? [] : message.delivery
                      ? outgoing.current.get(message.id)?.files.map((media) => media.preview) || [] : (messageAttachments[message.id] || [])
                    const publication = message.deleted_at ? undefined : publications[message.id]
                    const mediaPlaceholder = attachments.length > 0 && ['Фото', 'Відео'].includes(message.body)
                    const mediaOnlyMessage = mediaPlaceholder && !message.reply_to_message_id && !message.shared_post_id && !publication
                    const richMessage = !message.deleted_at && (Boolean(publication) || attachments.length > 0 || Boolean(message.shared_post_id) || Boolean(parseStudyAssignmentLink(message.body)))
                    const pinned = pinnedMessages.some((item) => item.id === message.id)
                    const anchorRef = bubbleAnchors.current[message.id] ||= { current: null }
                    const canOpenActions = !message.deleted_at && !message.delivery
                    const openMessageActions = () => { setActiveMessageActions(message.id); setReactionPickerFor(null) }
                    const timestamp = <time dateTime={message.created_at} title={formatMessageTimestamp(message.created_at)}
                      className={`chat-message-meta ${mediaOnlyMessage ? 'absolute bottom-2 right-2 !float-none rounded-full bg-black/65 px-1.5 py-0.5 !text-white' : 'text-muted-foreground'}`}>
                      {pinned && <Pin size={10} aria-label="Закріплено для вас" className="mr-1 inline-block" />}
                      {formatMessageClock(message.created_at)}
                      {mine && !message.deleted_at && <span className="ml-1 inline-flex align-middle" aria-label={message.delivery === 'failed' ? 'Не надіслано' : message.delivery ? 'Надсилання' : message.read_at ? 'Прочитано' : 'Надіслано'}>
                        {message.delivery === 'failed' ? <span className="font-bold text-red-600">!</span>
                          : message.delivery ? <Clock3 size={11} />
                            : message.read_at ? <CheckCheck size={12} className="text-primary" /> : <Check size={12} />}
                      </span>}
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
                          {message.delivery && <div role={message.delivery === 'failed' ? 'alert' : 'status'} className={`mt-1 max-w-full text-[11px] ${message.delivery === 'failed' ? 'text-red-600' : 'text-muted-foreground'}`}>
                            {message.delivery === 'failed' ? <>
                              <p className="max-w-72 break-words leading-relaxed">{message.deliveryError}</p>
                              <div className="mt-1 flex justify-end gap-2">
                                {message.retryable !== false && <button type="button" onClick={() => retryMessage(message)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-semibold hover:bg-red-500/5"><RotateCcw size={12} />Повторити</button>}
                                <button type="button" onClick={() => void discardLocalMessage(message)} className="min-h-8 rounded-lg px-2 text-muted-foreground hover:bg-muted">Прибрати</button>
                              </div>
                            </> : message.delivery === 'uploading' ? <span className="inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Завантаження вкладення…</span> : message.delivery === 'queued' ? 'У черзі' : 'Надсилання…'}
                          </div>}
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
                </div>
                {newMessagesBelow && <button type="button" onClick={() => {
                  threadNearBottom.current = true; setNewMessagesBelow(false)
                  threadScrollRef.current?.scrollTo({ top: threadScrollRef.current.scrollHeight,
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
                }} className="flex shrink-0 items-center justify-center gap-1 border-t border-border/50 bg-background/95 py-2 text-xs font-semibold text-primary"><ChevronDown size={14} />Нові повідомлення</button>}
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
                          <button type="button" onClick={() => setSelectedMedia((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label={`Видалити вкладення ${file.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-background disabled:opacity-40"><X size={14} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  <ChatMentionSuggestions value={draft} caret={draftCaret} profiles={mentionProfiles} onSelect={selectMention} inputRef={composerRef} />
                  <div className="flex items-end gap-2">
                    <textarea
                      ref={composerRef}
                      value={draft}
                      onChange={(event) => { setDraft(event.target.value); setDraftCaret(event.target.selectionStart) }}
                      onSelect={(event) => setDraftCaret(event.currentTarget.selectionStart)}
                      onKeyDown={handleComposerKeyDown}
                      rows={1}
                      maxLength={5000}
                      placeholder="Напишіть повідомлення…"
                      className="min-h-11 min-w-0 max-h-32 flex-1 resize-none overflow-y-auto rounded-2xl border border-border bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={handleMediaSelection} />
                    <div className="relative h-11 w-11 shrink-0">
                      <button ref={attachmentButtonRef} type="button" onClick={() => setAttachmentMenu((current) => !current)}
                        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setAttachmentMenu(true) } }}
                        aria-label="Додати фото, відео, опитування або статтю" title="Додати до чату" aria-haspopup="menu" aria-expanded={attachmentMenu}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-40">
                        <Paperclip size={18} />
                      </button>
                      <ChatMessageMenu hideTrigger open={attachmentMenu} onOpenChange={setAttachmentMenu} anchorRef={attachmentButtonRef}
                        items={[
                          { label: 'Фото або відео', icon: <Paperclip size={15} />, disabled: mediaAvailable !== true, onSelect: () => mediaInputRef.current?.click() },
                          { label: 'Опитування', icon: <BarChart3 size={15} />, onSelect: () => openPublicationEditor('poll') },
                          { label: 'Стаття', icon: <FileText size={15} />, onSelect: () => openPublicationEditor('article') },
                          { label: 'Відкласти текст', icon: <Clock3 size={15} />, onSelect: () => setScheduledMessages(true) },
                        ]} />
                    </div>
                    <button type="submit" disabled={!draft.trim() && !selectedMedia.length} aria-label="Надіслати повідомлення" className="h-11 w-11 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center transition-transform active:scale-95 motion-reduce:transform-none disabled:opacity-40">
                      <Send size={17} />
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
        {selectedConversation && conversationSearch && <ConversationSearch key={`search:${currentUserId}:${selectedConversation.id}`} kind="direct" containerId={selectedConversation.id} userId={currentUserId} profiles={mentionProfiles} onClose={() => setConversationSearch(false)} />}
        {selectedConversation && scheduledMessages && <ScheduledDirectMessages key={`schedule:${currentUserId}:${selectedConversation.id}`} userId={currentUserId} conversationId={selectedConversation.id} initialBody={draft} replyTo={replyingTo?.id || null} hasFiles={selectedMedia.length > 0} onClose={() => setScheduledMessages(false)} onSaved={(scheduledBody) => { setDraft((current) => current.trim() === scheduledBody ? '' : current); setReplyingTo((current) => current?.id === replyingTo?.id ? null : current) }} />}
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
  const date = parseSafeDate(value)
  return date ? formatDistanceToNow(date, { addSuffix: true, locale: uk }) : 'Дату не визначено'
}

function privateMessageError(error: unknown) {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  if (/DIRECT_MESSAGE_RATE_LIMIT|CHAT_RATE_LIMIT/.test(code)) return 'Ви надсилаєте повідомлення надто часто. Зачекайте трохи та спробуйте знову.'
  if (/PRIVATE_MEDIA_UPLOAD_RATE_LIMIT/.test(code)) return 'Зараз забагато завантажень. Зачекайте трохи та спробуйте знову.'
  if (/PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED/.test(code)) return 'Час завантаження минув. Оберіть файл ще раз та повторіть надсилання.'
  if (/PRIVATE_MEDIA_QUOTA/.test(code)) return 'Досягнуто ліміту приватних файлів. Видаліть непотрібні вкладення та спробуйте знову.'
  if (/PRIVATE_MEDIA_ATTACHMENT_LIMIT/.test(code)) return 'Можна надіслати до 5 файлів загальним розміром до 50 МБ.'
  if (/PRIVATE_MEDIA_INVALID|CHAT_INVALID_MEDIA/.test(code)) return 'Не вдалося перевірити вкладення. Оберіть файл ще раз.'
  if (/DIRECT_SAFE_RETRY_UNAVAILABLE|PGRST202/.test(code)) return 'Безпечне повторення стане доступним після оновлення платформи.'
  if (/CHAT_AUTH_CHANGED|CHAT_AUTH_REQUIRED/.test(code)) return 'Сесію входу змінено. Увійдіть до свого облікового запису ще раз.'
  if (/CHAT_CONNECTION_REQUIRED|CHAT_MEMBER_REQUIRED/.test(code)) return 'Переписка більше недоступна. Перевірте запит на спілкування.'
  if (/DIRECT_MESSAGE_ID_CONFLICT|DIRECT_MESSAGE_REMOVED/.test(code)) return 'Це повідомлення більше не можна надіслати. Приберіть його з черги.'
  return 'Надсилання не підтверджено. Натисніть «Повторити» — дублікат не створиться.'
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
  return formatSafeDate(value, messageDayKeyFormatter, 'unknown-date')
}

function formatMessageClock(value: string) {
  return formatSafeDate(value, messageClockFormatter, '—')
}

function formatMessageTimestamp(value: string) {
  return formatSafeDate(value, messageTimestampFormatter)
}

function formatMessageDay(value: string) {
  if (!parseSafeDate(value)) return 'Дату не визначено'
  const key = messageDayKey(value)
  const today = messageDayKey(new Date())
  if (key === today) return 'Сьогодні'
  const [year, month, day] = today.split('-').map(Number)
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
  if (key === yesterday) return 'Учора'
  return formatSafeDate(value, new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long',
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' as const }),
  }))
}

async function loadPublicPremium(userIds: string[]) {
  const batches: string[][] = []
  for (let index = 0; index < userIds.length; index += 100) batches.push(userIds.slice(index, index + 100))
  const results = await Promise.all(batches.map((ids) => supabase.rpc('xelay_public_premium', { p_user_ids: ids })))
  return { data: results.flatMap((result) => result.data || []) as PublicPremium[] }
}
