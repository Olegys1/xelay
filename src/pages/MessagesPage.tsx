import { ChangeEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ChevronDown, ChevronUp, Loader2, LockKeyhole, MessageCircle, Paperclip, Pin, PinOff, Reply, Send, Smile, Sparkles, Trash2, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { AuthModal } from '../components/AuthModal'
import { PremiumBadge } from '../components/PremiumBadge'
import { useBilling } from '../context/BillingContext'
import { getPublicProfiles } from '../lib/profiles'
import { isMissingDatabaseColumn } from '../lib/databaseCompatibility'

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
}

const BASIC_MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '🙌', '🔥']
const PREMIUM_MESSAGE_REACTIONS = ['🥰', '🎉', '🤩', '💯', '👏', '🤝', '🫶', '🤔', '😢', '😎', '⚡', '📚']
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

export function MessagesPage() {
  const { authUser } = useAuth()
  return <MessagesWorkspace key={authUser?.id || 'guest'} />
}

function MessagesWorkspace() {
  const { authUser, isAuthenticated, isLoading: authLoading } = useAuth()
  const { isPremium } = useBilling()
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
  const [mediaAvailable, setMediaAvailable] = useState<boolean | null>(null)
  const [selectedMedia, setSelectedMedia] = useState<File[]>([])
  const [mediaPreview, setMediaPreview] = useState<MessageAttachment | null>(null)
  const [replyingTo, setReplyingTo] = useState<MessageRecord | null>(null)
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null)
  const [interactionsAvailable, setInteractionsAvailable] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const threadScrollRef = useRef<HTMLDivElement>(null)
  const threadNearBottom = useRef(true)
  const previousThreadPosition = useRef({ conversationId: '', lastMessageId: '' })
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const interactionSchemaChecked = useRef(false)
  const signedMediaUrlCache = useRef(new Map<string, { url: string; expiresAt: number }>())
  const mediaSchemaStatus = useRef<{ available: boolean | null; checkedAt: number }>({ available: null, checkedAt: 0 })
  const identityRef = useRef(currentUserId)
  const selectedIdRef = useRef(selectedId)
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
        peer: profileById.get(peerId) || { id: peerId, full_name: 'Учасник Xelay', avatar_url: null, faculty: '', specialty: '' },
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

  useEffect(() => {
    ++messageSequence.current
    ++pinSequence.current
    ++reactionSequence.current
    ++attachmentSequence.current
    setMessages([])
    setReactions({})
    setMessageAttachments({})
    setMediaPreview(null)
    setDraft('')
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
      window.clearInterval(interval)
    }
  }, [selectedId, loadMessages, loadPinnedMessages])

  useEffect(() => {
    if (!selectedId) return
    const ids = [...new Set([...messages, ...pinnedMessages]
      .filter((message) => message.conversation_id === selectedId && !message.deleted_at)
      .map((message) => message.id))]
    void loadMessageAttachments(ids)
  }, [messages, pinnedMessages, selectedId, loadMessageAttachments])

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
    if (!isPinned && !isPremium) {
      void navigate({ to: '/subscription' })
      return
    }
    if (pinsAvailable === false) {
      setError('Закріплення чатів стане доступним після оновлення бази даних.')
      return
    }
    if (!isPinned && Object.keys(conversationPins).length >= MAX_PINNED_CONVERSATIONS) {
      setError(`Можна закріпити до ${MAX_PINNED_CONVERSATIONS} чатів. Спочатку відкріпіть один із них.`)
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
      setError('Не вдалося змінити закріплення чату. Перевірте передплату та спробуйте ще раз.')
      return
    }
    setConversationPins((current) => {
      const next = { ...current }
      if (isPinned) delete next[conversation.id]
      else next[conversation.id] = new Date().toISOString()
      return next
    })
    } catch {
      if (isCurrent(ownerId)) setError('Не вдалося змінити закріплення чату. Спробуйте ще раз.')
    } finally {
      conversationPinLock.current = false
      if (isCurrent(ownerId)) { setPinningConversation(null); void loadConversations() }
    }
  }

  const toggleMessagePin = async (message: MessageRecord) => {
    if (!authUser?.id || message.deleted_at || messagePinLock.current || message.conversation_id !== selectedIdRef.current) return
    const ownerId = authUser.id
    const isPinned = pinnedMessages.some((item) => item.id === message.id)
    if (!isPinned && !isPremium) {
      void navigate({ to: '/subscription' })
      return
    }
    if (messagePinsAvailable === false) {
      setError('Закріплення повідомлень стане доступним після оновлення бази даних.')
      return
    }
    if (!isPinned && pinnedMessages.length >= MAX_PINNED_MESSAGES) {
      setError(`В одному чаті можна закріпити до ${MAX_PINNED_MESSAGES} повідомлень.`)
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
      setError('Не вдалося змінити закріплення повідомлення. Перевірте передплату та спробуйте ще раз.')
      return
    }
    if (isPinned && pinnedPreview?.id === message.id) setPinnedPreview(null)
    } catch {
      if (isCurrent(ownerId, message.conversation_id)) setError('Не вдалося змінити закріплення повідомлення. Спробуйте ще раз.')
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
    if ((!body && !selectedMedia.length) || !selectedConversation || !authUser?.id || sendingLock.current) return
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
    if (!BASIC_MESSAGE_REACTIONS.includes(emoji) && !isPremium && ownReaction?.emoji !== emoji) {
      setReactionPickerFor(null)
      void navigate({ to: '/subscription' })
      return
    }
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
          <button onClick={() => setShowAuthModal(true)} className="rounded-full bg-primary text-primary-foreground px-5 py-2.5 font-medium">Увійти</button>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-background">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 px-2 sm:px-0">
          <h1 className="text-2xl font-bold">Повідомлення</h1>
          <button type="button" onClick={() => navigate({ to: '/subscription' })} className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 active:scale-[0.98] motion-reduce:transform-none">
            <Sparkles size={15} />{isPremium ? 'Підписка «Учасник»' : 'Можливості «Учасник»'}
          </button>
        </div>
        <section className="xelay-card overflow-hidden h-[calc(100dvh-10rem)] min-h-[440px] max-h-[820px] flex">
          <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-[340px] lg:w-[380px] shrink-0 flex-col border-r border-border`}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-semibold">Ваші чати</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Лише прийняті запити на спілкування</p>
              </div>
              {conversations.some((conversation) => conversation.unreadCount > 0) && (
                <span className="rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-xs font-semibold">
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
              ) : sortedConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`group flex w-full items-center border-b border-border/70 pr-2 transition-colors hover:bg-muted/70 ${selectedId === conversation.id ? 'bg-primary/5' : ''}`}
                >
                  <button type="button" onClick={() => setSelectedId(conversation.id)} className="flex min-w-0 flex-1 items-center gap-3 py-3.5 pl-4 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30">
                  <Avatar profile={conversation.peer} size="w-12 h-12" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{conversation.peer.full_name}</span>
                        <PremiumBadge isPremium={Boolean(peerPremium[conversation.peer.id]?.is_premium)} emojiStatus={peerPremium[conversation.peer.id]?.emoji_status} compact />
                      </span>
                      {conversation.lastMessage && <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(conversation.lastMessage.created_at)}</span>}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2">
                      <span className={`truncate text-xs ${conversation.unreadCount ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                        {conversation.lastMessage?.sender_id === currentUserId ? 'Ви: ' : ''}{conversation.lastMessage?.deleted_at ? 'Повідомлення видалено' : conversation.lastMessage?.body || 'Почніть розмову'}
                      </span>
                      {conversation.unreadCount > 0 && <span className="h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center">{conversation.unreadCount}</span>}
                    </span>
                  </span>
                  </button>
                  <button type="button" onClick={() => void toggleConversationPin(conversation)} disabled={Boolean(pinningConversation)} title={conversationPins[conversation.id] ? 'Відкріпити чат' : isPremium ? 'Закріпити чат для себе' : 'Закріплення чатів із підпискою «Учасник»'} aria-label={conversationPins[conversation.id] ? `Відкріпити чат із ${conversation.peer.full_name}` : `Закріпити чат із ${conversation.peer.full_name}`} aria-pressed={Boolean(conversationPins[conversation.id])} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/10 disabled:opacity-40 ${conversationPins[conversation.id] ? 'text-primary' : 'text-muted-foreground'}`}>
                    {pinningConversation === conversation.id ? <Loader2 size={14} className="animate-spin" /> : conversationPins[conversation.id] ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <div className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
            {selectedConversation ? (
              <>
                <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                  <button onClick={() => setSelectedId('')} className="md:hidden p-2 rounded-full hover:bg-muted" aria-label="Назад до списку чатів"><ArrowLeft size={19} /></button>
                  <Avatar profile={selectedConversation.peer} size="w-10 h-10" />
                  <div className="min-w-0 flex-1">
                    <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold"><span className="truncate">{selectedConversation.peer.full_name}</span><PremiumBadge isPremium={Boolean(peerPremium[selectedConversation.peer.id]?.is_premium)} emojiStatus={peerPremium[selectedConversation.peer.id]?.emoji_status} compact /></h2>
                    <p className="truncate text-xs text-muted-foreground">{[selectedConversation.peer.faculty, selectedConversation.peer.specialty].filter(Boolean).join(' · ') || 'Учасник Xelay'}</p>
                  </div>
                  <button type="button" onClick={() => void toggleConversationPin(selectedConversation)} disabled={Boolean(pinningConversation)} title={conversationPins[selectedConversation.id] ? 'Відкріпити чат' : isPremium ? 'Закріпити чат для себе' : 'Закріплення чатів із підпискою «Учасник»'} aria-label={conversationPins[selectedConversation.id] ? 'Відкріпити чат' : 'Закріпити чат'} aria-pressed={Boolean(conversationPins[selectedConversation.id])} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/10 ${conversationPins[selectedConversation.id] ? 'text-primary' : 'text-muted-foreground'}`}>
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
                <div ref={threadScrollRef} onScroll={(event) => { const thread = event.currentTarget; threadNearBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100 }} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3">
                  {threadLoading ? <div className="pt-10 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div> : visibleMessages.length === 0 ? (
                    <div className="h-full min-h-48 flex flex-col items-center justify-center text-center">
                      <Avatar profile={selectedConversation.peer} size="w-16 h-16" />
                      <p className="font-semibold mt-3">{selectedConversation.peer.full_name}</p>
                      <p className="text-sm text-muted-foreground mt-1">Ваш запит прийнято. Почніть розмову.</p>
                    </div>
                  ) : visibleMessages.map((message) => {
                    const mine = message.sender_id === currentUserId
                    const repliedMessage = message.reply_to_message_id
                      ? visibleMessages.find((item) => item.id === message.reply_to_message_id)
                      : null
                    const attachments = message.deleted_at ? [] : (messageAttachments[message.id] || [])
                    const mediaPlaceholder = attachments.length > 0 && ['Фото', 'Відео'].includes(message.body)
                    const mediaOnlyMessage = mediaPlaceholder && !message.reply_to_message_id && !message.shared_post_id
                    const groupedReactions = (reactions[message.id] || []).reduce<Record<string, { count: number; mine: boolean }>>((result, reaction) => {
                      result[reaction.emoji] ||= { count: 0, mine: false }
                      result[reaction.emoji].count += 1
                      if (reaction.user_id === currentUserId) result[reaction.emoji].mine = true
                      return result
                    }, {})
                    return (
                      <div key={message.id} id={`direct-message-${message.id}`} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className="min-w-0 max-w-[88%] sm:max-w-[76%]">
                          <div className={mediaOnlyMessage
                            ? 'overflow-hidden rounded-2xl bg-transparent text-foreground'
                            : `rounded-2xl px-4 py-2.5 ${mine ? 'bg-primary text-primary-foreground rounded-br-md' : 'bg-muted text-foreground rounded-bl-md'}`}>
                            {message.reply_to_message_id && (
                              <div className={`mb-2 rounded-xl border-l-2 px-2.5 py-1.5 text-xs ${mine ? 'border-background/60 bg-background/10 text-background/80' : 'border-foreground/40 bg-background/70 text-muted-foreground'}`}>
                                <span className="mb-0.5 block font-semibold">Відповідь на повідомлення</span>
                                <span className="block truncate">{repliedMessage?.deleted_at ? 'Повідомлення видалено' : repliedMessage?.body || 'Повідомлення з історії чату'}</span>
                              </div>
                            )}
                            {(!mediaPlaceholder || message.deleted_at) && <p className={`text-sm whitespace-pre-wrap break-words ${message.deleted_at ? 'italic opacity-70' : ''}`}>
                              {message.deleted_at ? 'Повідомлення видалено' : message.body}
                            </p>}
                            {!message.deleted_at && message.shared_post_id && <button onClick={() => navigate({ to: '/news/$id', params: { id: message.shared_post_id! } })} className={`mt-2 rounded-full px-3 py-1.5 text-xs font-semibold ${mine ? 'bg-background/15 hover:bg-background/25' : 'bg-background hover:bg-muted-foreground/10'}`}>Відкрити новину</button>}
                            {attachments.length > 0 && (
                              <div className={`flex max-w-full flex-wrap gap-2 ${mediaOnlyMessage ? '' : 'mt-2'}`}>
                                {attachments.map((attachment) => attachment.media_type === 'video' ? (
                                  <video key={attachment.id} src={attachment.url} controls playsInline preload="metadata" className="max-h-72 w-[min(76vw,28rem)] rounded-2xl bg-black object-contain" />
                                ) : (
                                  <button key={attachment.id} type="button" onClick={() => setMediaPreview(attachment)} aria-label={`Переглянути фото ${attachment.file_name}`} className="block w-fit max-w-full overflow-hidden rounded-2xl bg-transparent p-0">
                                    <img src={attachment.url} alt={attachment.file_name} loading="lazy" className="block h-auto max-h-72 w-auto max-w-full object-contain" />
                                  </button>
                                ))}
                              </div>
                            )}
                            <p className={`mt-1 text-[10px] ${mediaOnlyMessage ? (mine ? 'inline-flex rounded-full bg-foreground/75 px-2 py-1 text-background' : 'inline-flex rounded-full bg-muted px-2 py-1 text-foreground') : (mine ? 'text-background/65' : 'text-muted-foreground')}`}>{formatTime(message.created_at)}</p>
                          </div>
                          {!message.deleted_at && interactionsAvailable && (
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
                              <div className="relative flex items-center gap-1">
                                <button type="button" onClick={() => beginReply(message)} title="Відповісти" aria-label="Відповісти" className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                                  <Reply size={15} />
                                </button>
                                <button type="button" onClick={() => setReactionPickerFor(reactionPickerFor === message.id ? null : message.id)} title="Додати реакцію" aria-label="Додати реакцію" className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                                  <Smile size={15} />
                                </button>
                                <button type="button" onClick={() => void toggleMessagePin(message)} disabled={Boolean(pinningMessage)} title={pinnedMessages.some((item) => item.id === message.id) ? 'Відкріпити повідомлення' : isPremium ? 'Закріпити повідомлення для себе' : 'Закріплення повідомлень із підпискою «Учасник»'} aria-label={pinnedMessages.some((item) => item.id === message.id) ? 'Відкріпити повідомлення' : 'Закріпити повідомлення для себе'} aria-pressed={pinnedMessages.some((item) => item.id === message.id)} className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-primary/5 disabled:opacity-40 ${pinnedMessages.some((item) => item.id === message.id) ? 'text-primary' : 'text-muted-foreground'}`}>
                                  {pinningMessage === message.id ? <Loader2 size={13} className="animate-spin" /> : pinnedMessages.some((item) => item.id === message.id) ? <PinOff size={14} /> : <Pin size={14} />}
                                </button>
                                {mine && <button type="button" onClick={() => void deleteMessage(message)} title="Видалити для обох" aria-label="Видалити повідомлення для обох" className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-red-50 hover:text-red-600">
                                  <Trash2 size={14} />
                                </button>}
                              </div>
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
                                  {PREMIUM_MESSAGE_REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => void toggleReaction(message, emoji)} aria-label={isPremium ? `Поставити реакцію ${emoji}` : `Реакція ${emoji} доступна з підпискою «Учасник»`} title={isPremium ? emoji : 'Доступно з підпискою «Учасник»'} className={`relative flex h-8 items-center justify-center rounded-xl transition-colors hover:bg-primary/5 active:scale-95 motion-reduce:transform-none ${isPremium ? '' : 'opacity-60'}`}><span>{emoji}</span>{!isPremium && <LockKeyhole size={8} className="absolute bottom-0.5 right-0.5 text-primary" />}</button>)}
                                </div>
                                {!isPremium && <button type="button" onClick={() => navigate({ to: '/subscription' })} className="mt-2 w-full rounded-full bg-primary/5 py-1.5 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/10">Відкрити всі реакції · 100 грн/місяць</button>}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
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
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      rows={1}
                      disabled={sending}
                      maxLength={5000}
                      placeholder="Напишіть повідомлення…"
                      className="min-h-11 min-w-0 max-h-32 flex-1 resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                    <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={handleMediaSelection} />
                    <button type="button" onClick={() => mediaInputRef.current?.click()} disabled={sending || mediaAvailable !== true} aria-label="Додати фото або відео" title="Додати фото або відео" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-40">
                      <Paperclip size={18} />
                    </button>
                    <button type="submit" disabled={(!draft.trim() && !selectedMedia.length) || sending} aria-label="Надіслати повідомлення" className="h-11 w-11 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40">
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
        {pinnedPreview && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Закріплене повідомлення">
            <button type="button" onClick={() => setPinnedPreview(null)} aria-label="Закрити повідомлення" className="absolute inset-0 cursor-default" />
            <div className="relative max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-border bg-background p-5 shadow-xl">
              <div className="mb-4 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Pin size={16} className="text-primary" />Закріплено для вас</h2><button type="button" onClick={() => setPinnedPreview(null)} aria-label="Закрити повідомлення" className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={17} /></button></div>
              <p className="whitespace-pre-wrap break-words text-sm">{pinnedPreview.body}</p>
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

async function loadPublicPremium(userIds: string[]) {
  const batches: string[][] = []
  for (let index = 0; index < userIds.length; index += 100) batches.push(userIds.slice(index, index + 100))
  const results = await Promise.all(batches.map((ids) => supabase.rpc('xelay_public_premium', { p_user_ids: ids })))
  return { data: results.flatMap((result) => result.data || []) as PublicPremium[] }
}
