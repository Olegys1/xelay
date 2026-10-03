import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Copy, FileDown, FileText, ListChecks, Loader2, MessageCircle, Paperclip, Pencil, Pin, PinOff, Reply, Send, Smile, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  announceChatUpdate, chatError, chatRpc, discardChatFiles, loadChatProfiles, signChatPosts, uploadChatFiles, validateChatFiles,
  type ChatPost, type ChatProfile, type ChatSpaceDetail,
} from '../lib/chatSpaces'
import { ChatAvatar, ChatDialog, ChatSpinner, chatButton, chatIcon, chatInput, chatPrimary } from './CommunityChatPrimitives'
import { StudyAssignmentMessageCard } from './StudyAssignmentMessageCard'
import { ChatMessageMenu } from './ChatMessageMenu'
import { ChatMessageText, ChatMentionSuggestions } from './ChatMentions'
import { copyChatText } from '../lib/chatMessageText'
import { parseStudyAssignmentLink } from '../lib/studyAssignmentSharing'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { useRecentItemMotion } from '../hooks/useRecentItemMotion'
import { type ChatArticle, type PublicationKind } from '../lib/chatPublications'
import { ChatPublicationCard } from './ChatPublicationCard'
import { ChatPublicationEditor } from './ChatPublicationEditor'

const reactions = ['👍', '❤️', '🔥', '👏', '😂', '🎉', '😮', '😢', '🤔', '👎', '💯', '🙏']
const dayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
const dayLabel = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric' })
const timeLabel = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fullDateLabel = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'full', timeStyle: 'short' })
const kyivDay = (value: string) => {
  const parts = dayParts.formatToParts(new Date(value))
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value || '').join('-')
}
type Props = { detail: ChatSpaceDetail; userId: string; parentPost?: ChatPost; knownProfiles?: Record<string, ChatProfile>; onRefresh: () => Promise<void> }

export function CommunityChatTimeline({ detail, userId, parentPost, knownProfiles, onRefresh }: Props) {
  const space = detail.space
  const { isPremium } = useBilling()
  const { notify } = useToast()
  const [attachmentMenu, setAttachmentMenu] = useState(false)
  const [publicationEditor, setPublicationEditor] = useState<{ kind: PublicationKind; article?: ChatArticle } | null>(null)
  const [posts, setPosts] = useState<ChatPost[]>([])
  const [profiles, setProfiles] = useState<Record<string, ChatProfile>>(knownProfiles || {})
  const profileCache = useRef<Record<string, ChatProfile>>(knownProfiles || {})
  const [loading, setLoading] = useState(true)
  const arrivingPosts = useRecentItemMotion(posts, `${userId}:${space.id}:${parentPost?.id || ''}`, !loading)
  const [olderBusy, setOlderBusy] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [draftCaret, setDraftCaret] = useState(0)
  const [activeMessageActions, setActiveMessageActions] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [reply, setReply] = useState<ChatPost | null>(null)
  const [editing, setEditing] = useState<ChatPost | null>(null)
  const [comments, setComments] = useState<ChatPost | null>(null)
  const [reactionFor, setReactionFor] = useState('')
  const [deletePost, setDeletePost] = useState<ChatPost | null>(null)
  const [busy, setBusy] = useState('')
  const [newPosts, setNewPosts] = useState(false)
  const [pinPreview, setPinPreview] = useState<ChatPost | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const bubbleAnchors = useRef<Record<string, { current: HTMLDivElement | null }>>({})
  const alive = useRef(true)
  const loadSequence = useRef(0)
  const mutation = useRef(false)
  const nearBottom = useRef(true)
  const latest = useRef(posts); latest.current = posts
  const pendingRefresh = useRef(false)
  const lastRead = useRef(detail.my_membership?.last_read_at || '')
  const parentId = parentPost?.id || null
  const role = detail.my_membership?.role
  const admin = Boolean(detail.is_admin) || role === 'owner' || role === 'admin'
  const canPost = parentPost ? space.comments_enabled : space.kind === 'group' || admin
  const memberIds = [...new Set([userId, ...detail.members.filter((member) => member.status === 'active').map((member) => member.user_id)])].sort().join(',')
  const mentionProfiles = useMemo(() => Object.values(profiles), [profiles])
  const suggestedProfiles = useMemo(() => {
    const activeIds = new Set(memberIds.split(','))
    return Object.values(profiles).filter((profile) => activeIds.has(profile.id))
  }, [profiles, memberIds])
  const personalPins = detail.personal_pins || []

  useEffect(() => {
    if (!knownProfiles) return
    profileCache.current = { ...profileCache.current, ...knownProfiles }
    setProfiles((current) => ({ ...current, ...knownProfiles }))
  }, [knownProfiles])

  useEffect(() => {
    if (!composer.current) return
    composer.current.style.height = 'auto'
    composer.current.style.height = `${Math.min(composer.current.scrollHeight, 128)}px`
  }, [draft, canPost])

  const load = useCallback(async (older = false) => {
    if (mutation.current) { pendingRefresh.current = true; return }
    const sequence = ++loadSequence.current
    if (older) setOlderBusy(true)
    const before = older ? latest.current[0]?.created_at : null
    try {
      const raw = await chatRpc<ChatPost[]>('xelay_chat_posts', { p_space_id: space.id, p_parent_post_id: parentId, p_before: before, p_limit: 40 })
      const previousIds = new Set(latest.current.map((post) => post.id))
      let retained: ChatPost[] = []
      if (!older && previousIds.size) {
        const ids = [...previousIds]
        for (let offset = 0; offset < ids.length; offset += 400) retained.push(...await chatRpc<ChatPost[]>('xelay_chat_posts_by_ids', { p_space_id: space.id, p_post_ids: ids.slice(offset, offset + 400) }))
      }
      const signed = await signChatPosts(raw)
      const signedRetained = await signChatPosts(retained)
      const missingProfileIds = [...new Set([...memberIds.split(','), ...raw.map((post) => post.sender_id), ...retained.map((post) => post.sender_id)])].filter((id) => id && !profileCache.current[id])
      const foundProfiles = missingProfileIds.length ? await loadChatProfiles(missingProfileIds) : {}
      if (!alive.current || sequence !== loadSequence.current) return
      const previousHeight = scroller.current?.scrollHeight || 0
      const previousTop = scroller.current?.scrollTop || 0
      if (Object.keys(foundProfiles).length) {
        profileCache.current = { ...profileCache.current, ...foundProfiles }
        setProfiles((current) => ({ ...current, ...foundProfiles }))
      }
      setPosts((current) => {
        const fresh = [...signed].reverse()
        if (older) return [...fresh.filter((post) => !current.some((old) => old.id === post.id)), ...current]
        // Keep previously loaded pages when new messages arrive; replace the
        // current page so edits/reactions stay in sync without losing history.
        return [...signedRetained.filter((post) => !fresh.some((item) => item.id === post.id)), ...fresh].sort((a, b) => a.created_at.localeCompare(b.created_at))
      })
      if (older || latest.current.length <= 40) setHasOlder(raw.length === 40)
      setLoading(false); setError('')
      requestAnimationFrame(() => {
        if (!alive.current || !scroller.current) return
        if (older) scroller.current.scrollTop = previousTop + scroller.current.scrollHeight - previousHeight
        else if (nearBottom.current) { scroller.current.scrollTop = scroller.current.scrollHeight; setNewPosts(false) }
        else if (signed.some((post) => !previousIds.has(post.id))) setNewPosts(true)
      })
      if (!parentId && raw[0] && document.visibilityState === 'visible' && raw[0].created_at > lastRead.current) {
        await chatRpc('xelay_chat_read', { p_space_id: space.id, p_through: raw[0].created_at })
        lastRead.current = raw[0].created_at
        if (alive.current) announceChatUpdate()
      }
      return true
    } catch (failure) {
      if (alive.current && sequence === loadSequence.current) { setError(chatError(failure)); setLoading(false); if (/CHAT_(POST_NOT_FOUND|MEMBER_REQUIRED|NOT_FOUND|COMMENTS_DISABLED)/.test((failure as { message?: string })?.message || '')) setPosts([]); return false }
    }
    finally { if (alive.current && sequence === loadSequence.current) setOlderBusy(false) }
  }, [space.id, parentId, userId, memberIds])
  const latestLoad = useRef(load); latestLoad.current = load
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; loadSequence.current += 1 } }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void latestLoad.current(), 240) }
    const channel = supabase.channel(`community-timeline:${space.id}:${parentId || 'main'}:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_posts', filter: `space_id=eq.${space.id}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_spaces', filter: `id=eq.${space.id}` }, changed)
      .subscribe()
    window.addEventListener('focus', changed)
    return () => { if (timer) clearTimeout(timer); window.removeEventListener('focus', changed); void supabase.removeChannel(channel) }
  }, [space.id, parentId, userId])

  const run = async (key: string, action: () => Promise<unknown>, confirmation?: string) => {
    if (mutation.current) return
    mutation.current = true; setBusy(key); setError(''); setNotice('')
    let committed = false
    try {
      await action(); committed = true; announceChatUpdate()
      mutation.current = false
      const loaded = await latestLoad.current(); await onRefresh()
      if (alive.current && loaded === false) {
        notify({ id: 'community-chat-action', tone: 'warning', title: 'Дію виконано', description: 'Не вдалося оновити повідомлення. Оновіть чат, щоб побачити зміни.' })
      } else if (alive.current && confirmation) notify({ id: 'community-chat-action', tone: 'success', title: confirmation })
    } catch (failure) { if (alive.current) {
      const message = committed ? 'Дію виконано, але чат не вдалося оновити. Оновіть сторінку.' : chatError(failure)
      setError(message)
      notify({ id: 'community-chat-action', tone: committed ? 'warning' : 'error', title: committed ? 'Потрібно оновити чат' : 'Не вдалося виконати дію', description: message })
    } }
    finally { mutation.current = false; if (alive.current) { setBusy(''); if (pendingRefresh.current) { pendingRefresh.current = false; void latestLoad.current() } } }
  }
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim() && !files.length && !editing?.attachments.length && !editing?.shared_news_post_id) return
    const validation = validateChatFiles(files)
    if (validation) { setError(validation); return }
    void run('send', async () => {
      if (editing) await chatRpc('xelay_chat_edit', { p_post_id: editing.id, p_body: draft })
      else {
        const uploaded = await uploadChatFiles(space.id, userId, files)
        try { await chatRpc('xelay_chat_send', { p_space_id: space.id, p_body: draft, p_parent_post_id: parentId, p_reply_to: reply?.id || null, p_attachments: uploaded, p_shared_news_post_id: null }) }
        catch (failure) { await discardChatFiles(uploaded); throw failure }
      }
      if (alive.current) { setDraft(''); setDraftCaret(0); setFiles([]); setReply(null); setEditing(null); nearBottom.current = true }
    })
  }
  const addFiles = (next: File[]) => {
    const combined = [...files, ...next]
    const validation = validateChatFiles(combined)
    if (validation) { setError(validation); return }
    setFiles(combined); setError('')
  }
  const startEdit = (post: ChatPost) => { setEditing(post); setDraft(post.body); setDraftCaret(post.body.length); setReply(null); setFiles([]) }
  const copyMessage = async (post: ChatPost) => {
    const copied = await copyChatText(post.body)
    if (!alive.current) return
    setNotice('')
    setError(copied ? '' : 'Не вдалося скопіювати текст. Спробуйте ще раз.')
    notify({ id: 'community-chat-copy', tone: copied ? 'success' : 'error', title: copied ? 'Текст скопійовано' : 'Не вдалося скопіювати текст', description: copied ? undefined : 'Спробуйте ще раз.' })
  }
  const selectMention = (text: string, caret: number) => {
    setDraft(text); setDraftCaret(caret)
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(caret, caret) })
  }
  const jumpTo = (id: string) => document.getElementById(`community-post-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const openPin = async (id: string) => {
    if (document.getElementById(`community-post-${id}`)) { jumpTo(id); return }
    try {
      const found = await chatRpc<ChatPost[]>('xelay_chat_posts_by_ids', { p_space_id: space.id, p_post_ids: [id] })
      if (!found.length) { setError('Це закріплене повідомлення більше не доступне.'); return }
      const [signed] = await signChatPosts(found)
      if (alive.current) setPinPreview(signed)
    } catch (failure) { if (alive.current) setError(chatError(failure)) }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    {!parentPost && Boolean(detail.pins?.length) && <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-primary/5 px-4 py-2" aria-label="Закріплені повідомлення"><Pin size={15} className="mt-1 shrink-0 text-primary" />{detail.pins.map((post) => <button key={post.id} className="max-w-64 shrink-0 truncate text-left text-xs text-primary" onClick={() => void openPin(post.id)}>{post.body || 'Вкладення'}</button>)}</div>}
    {personalPins.some((post) => !parentId || post.parent_post_id === parentId) && <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-muted/30 px-4 py-2" aria-label="Ваші закріплені повідомлення"><span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-primary"><Pin size={13} />Для вас</span>{personalPins.filter((post) => !parentId || post.parent_post_id === parentId).map((post) => <span key={post.id} className="flex shrink-0 items-center gap-1"><button className="max-w-52 truncate text-left text-xs text-muted-foreground hover:text-primary" onClick={() => void openPin(post.id)}>{post.body || 'Вкладення'}</button><button className={chatIcon} disabled={Boolean(busy)} aria-label="Відкріпити повідомлення для себе" onClick={() => void run(`personal-pin:${post.id}`, () => chatRpc('xelay_chat_pin_for_me', { p_post_id: post.id, p_pin: false }), 'Повідомлення відкріплено для вас')}><PinOff size={13} /></button></span>)}</div>}
    {parentPost && <div className="mb-3 rounded-xl border border-border bg-muted/40 p-3"><p className="text-sm font-medium">Публікація</p><p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-muted-foreground">{parentPost.body ? <ChatMessageText text={parentPost.body} profiles={mentionProfiles} /> : 'Публікація з вкладенням'}</p>{!parentPost.deleted_at && <StudyAssignmentMessageCard body={parentPost.body} />}</div>}
    <div ref={scroller} onScroll={() => { const element = scroller.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120 }} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-5 ${parentPost ? 'max-h-[45dvh] min-h-[180px]' : 'min-h-[240px]'}`}>
      {loading ? <ChatSpinner /> : <>
        {hasOlder && <div className="flex justify-center"><button className={chatButton} disabled={olderBusy || Boolean(busy)} onClick={() => void load(true)}>{olderBusy && <Loader2 size={15} className="animate-spin" />}Попередні повідомлення</button></div>}
        {!posts.length && !error && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><MessageCircle size={30} className="text-primary/50" /><p className="text-sm">{parentPost ? 'Поки немає коментарів. Почніть обговорення.' : space.kind === 'channel' ? 'Тут з’являться публікації каналу.' : 'Чат готовий. Напишіть перше повідомлення.'}</p></div>}
        {posts.map((post, index) => {
          const own = post.sender_id === userId
          const channelPost = space.kind === 'channel' && !parentPost
          const outgoing = own && !channelPost
          const previous = posts[index - 1]
          const day = kyivDay(post.created_at)
          const startsDay = !previous || kyivDay(previous.created_at) !== day
          const sameSender = previous && !startsDay && (channelPost || previous.sender_id === post.sender_id)
          const sender = profiles[post.sender_id]
          const senderName = sender?.full_name || sender?.username || 'Учасник Xelay'
          const hasRichContent = Boolean(post.publication || post.attachments?.length || post.shared_news_post_id || parseStudyAssignmentLink(post.body))
          const referenced = posts.find((item) => item.id === post.reply_to)
          const anchorRef = bubbleAnchors.current[post.id] ||= { current: null }
          const isPinnedForMe = Boolean(post.is_pinned_for_me || personalPins.some((item) => item.id === post.id))
          const canOpenActions = !post.deleted_at && !busy
          const openMessageActions = () => { setActiveMessageActions(post.id); setReactionFor('') }
          const groupedReactions = (post.reactions || []).reduce<Record<string, { count: number; mine: boolean }>>((items, item) => { items[item.emoji] ||= { count: 0, mine: false }; items[item.emoji].count += 1; items[item.emoji].mine ||= item.user_id === userId; return items }, {})
          const metadata = <span className="chat-message-meta whitespace-nowrap text-muted-foreground">{!post.deleted_at && isPinnedForMe && <Pin size={10} aria-label="Закріплено для вас" className="mr-1 inline-block" />}{!post.deleted_at && post.edited_at && <span className="mr-1">змінено</span>}<time dateTime={post.created_at} title={fullDateLabel.format(new Date(post.created_at))}>{timeLabel.format(new Date(post.created_at))}</time></span>
          const menuItems = [
            { label: 'Копіювати текст', icon: <Copy size={15} />, onSelect: () => void copyMessage(post), disabled: !post.body },
            { label: 'Додати реакцію', icon: <Smile size={15} />, onSelect: () => setReactionFor((current) => current === post.id ? '' : post.id) },
            ...(canPost ? [{ label: 'Відповісти', icon: <Reply size={15} />, onSelect: () => { setReply(post); setEditing(null); composer.current?.focus() } }] : []),
            ...(post.publication?.article?.can_edit ? [{ label: 'Редагувати статтю', icon: <Pencil size={15} />, onSelect: () => setPublicationEditor({ kind: 'article', article: post.publication!.article! }) }]
              : !post.publication && (own || (channelPost && admin)) ? [{ label: 'Редагувати', icon: <Pencil size={15} />, onSelect: () => { startEdit(post); composer.current?.focus() } }] : []),
            { label: isPinnedForMe ? 'Відкріпити для себе' : 'Закріпити для себе', icon: isPinnedForMe ? <PinOff size={15} /> : <Pin size={15} />, onSelect: () => { void run(`personal-pin:${post.id}`, () => chatRpc('xelay_chat_pin_for_me', { p_post_id: post.id, p_pin: !isPinnedForMe }), isPinnedForMe ? 'Повідомлення відкріплено для вас' : 'Повідомлення закріплено для вас') } },
            ...(admin && !parentPost ? [{ label: detail.pins.some((item) => item.id === post.id) ? 'Відкріпити для всіх' : 'Закріпити для всіх', icon: <Pin size={15} />, onSelect: () => { void run(`pin:${post.id}`, () => chatRpc('xelay_chat_pin', { p_post_id: post.id, p_pin: !detail.pins.some((item) => item.id === post.id) }), detail.pins.some((item) => item.id === post.id) ? 'Повідомлення відкріплено для всіх' : 'Повідомлення закріплено для всіх') } }] : []),
            ...(own || admin ? [{ label: 'Видалити', icon: <Trash2 size={15} />, onSelect: () => setDeletePost(post), destructive: true }] : []),
          ]
          return <Fragment key={post.id}>
            {startsDay && <div role="separator" aria-label={dayLabel.format(new Date(post.created_at))} className="my-3 flex justify-center"><time dateTime={day} className="rounded-full bg-muted/80 px-3 py-1 text-[11px] text-muted-foreground">{dayLabel.format(new Date(post.created_at))}</time></div>}
            <article id={`community-post-${post.id}`} className={`relative flex items-end gap-1.5 ${outgoing ? 'justify-end pl-8' : 'pr-8'}`} style={{ marginTop: startsDay ? 0 : sameSender ? 4 : 12 }}>
              {!own && !channelPost && <Link to="/user/$id" params={{ id: post.sender_id }} aria-label={`Профіль: ${senderName}`} className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{sender?.avatar_url ? <img src={sender.avatar_url} alt="" className="h-full w-full object-cover" loading="lazy" /> : senderName.slice(0, 2).toUpperCase()}</Link>}
              <div className={`group relative min-w-0 w-fit ${channelPost ? 'max-w-[min(82%,38rem)]' : 'max-w-[min(82%,34rem)]'}`}>
                <div ref={anchorRef} tabIndex={!post.deleted_at ? 0 : undefined} aria-haspopup={!post.deleted_at ? 'menu' : undefined} aria-expanded={!post.deleted_at ? activeMessageActions === post.id : undefined}
                  onClick={(event) => { if (canOpenActions && isMessageActionTarget(event.target)) openMessageActions() }}
                  onContextMenu={(event) => { if (canOpenActions && isMessageActionTarget(event.target)) { event.preventDefault(); openMessageActions() } }}
                  onKeyDown={(event) => { if (canOpenActions && event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey) || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); openMessageActions() } }}
                  className={`chat-message-bubble ${arrivingPosts.has(post.id) ? 'xelay-message-arriving' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${channelPost ? 'chat-message-bubble--channel' : outgoing ? 'chat-message-bubble--own' : 'chat-message-bubble--incoming'}`}>
                  {channelPost ? <div className="mb-1.5 flex min-w-0 items-center gap-1.5"><ChatAvatar space={space} size="h-5 w-5" /><span className="min-w-0 truncate text-xs font-semibold text-primary">{space.name}</span></div>
                    : !own && <Link to="/user/$id" params={{ id: post.sender_id }} className="mb-1 block truncate text-xs font-medium text-primary hover:underline">{senderName}</Link>}
                  {post.reply_to && <button className="mb-1.5 block max-w-full truncate rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1 text-left text-[11px] text-muted-foreground" onClick={() => void openPin(post.reply_to!)}>↳ {referenced?.body || 'Відповідь на повідомлення'}</button>}
                  {post.deleted_at ? <p className="chat-message-text italic text-muted-foreground">Повідомлення видалено{metadata}</p> : <>
                    {post.body && !post.publication && <p className="chat-message-text"><ChatMessageText text={post.body} profiles={mentionProfiles} />{!hasRichContent && metadata}</p>}
                    {post.publication && <ChatPublicationCard key={post.publication.id} publication={post.publication} onEdit={(article) => setPublicationEditor({ kind: 'article', article })} />}
                    <div className="max-w-full [&>a]:mt-2"><StudyAssignmentMessageCard body={post.body} /></div>
                    {post.shared_news_post_id && <Link to="/news/$id" params={{ id: post.shared_news_post_id }} className="mt-2 block max-w-full rounded-lg border border-primary/15 bg-primary/5 px-2.5 py-2 text-xs font-medium text-primary">Переглянути новину ↗</Link>}
                    {(post.attachments || []).map((file, attachmentIndex) => <div key={file.id || `${file.storage_path}:${attachmentIndex}`} className="mt-2 max-w-full">
                      {!file.url ? <p className="rounded-lg border border-border px-2.5 py-2 text-xs text-muted-foreground">{file.file_name} · Вкладення тимчасово недоступне</p> : file.media_type === 'image' ? <a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`Відкрити фото ${file.file_name}`} className="block max-w-full"><img src={file.url} alt={file.file_name} loading="lazy" className="max-h-80 w-auto max-w-full rounded-lg object-contain" /></a> : file.media_type === 'video' ? <video src={file.url} controls preload="metadata" className="max-h-80 w-full max-w-full rounded-lg" /> : <a href={file.url} target="_blank" rel="noopener noreferrer" download={file.file_name} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-xs hover:border-primary/30"><FileDown size={17} className="shrink-0 text-primary" /><span className="min-w-0"><span className="block truncate font-medium">{file.file_name}</span><span className="text-[10px] text-muted-foreground">{Math.ceil(file.file_size / 1024)} КБ</span></span></a>}
                    </div>)}
                    {(!post.body || hasRichContent) && <p className="chat-message-text mt-1 min-h-4">{metadata}</p>}
                    {Object.keys(groupedReactions).length > 0 && <div className="clear-both mt-1.5 flex flex-wrap items-center gap-1">{Object.entries(groupedReactions).map(([emoji, state]) => <button key={emoji} className={`rounded-full border px-2 py-0.5 text-[11px] ${state.mine ? 'border-primary/25 bg-primary/10' : 'border-border bg-muted/50'}`} disabled={Boolean(busy)} onClick={() => run(`react:${post.id}`, () => chatRpc('xelay_chat_react', { p_post_id: post.id, p_emoji: emoji }))}>{emoji} {state.count}</button>)}</div>}
                    {reactionFor === post.id && <div className="clear-both mt-1.5 flex flex-wrap gap-1 rounded-lg border border-border bg-background p-1.5">{reactions.map((emoji) => <button key={emoji} aria-label={`Реакція ${emoji}`} className="rounded-lg px-1.5 py-1 text-lg hover:bg-muted" disabled={Boolean(busy)} onClick={() => { setReactionFor(''); void run(`react:${post.id}`, () => chatRpc('xelay_chat_react', { p_post_id: post.id, p_emoji: emoji })) }}>{emoji}</button>)}</div>}
                    {channelPost && space.comments_enabled && <button className="clear-both mt-2 flex w-full items-center justify-between gap-3 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-muted" onClick={() => setComments(post)}><span className="flex items-center gap-1.5"><MessageCircle size={13} />Коментарі</span><span>{post.comment_count || 0} →</span></button>}
                  </>}
                </div>
                {!post.deleted_at && <ChatMessageMenu open={activeMessageActions === post.id} onOpenChange={(open) => setActiveMessageActions((current) => open ? post.id : current === post.id ? null : current)} anchorRef={anchorRef}
                  items={menuItems} align={outgoing ? 'left' : 'right'} disabled={Boolean(busy)} className={`absolute top-0 ${outgoing ? 'right-full mr-1' : 'left-full ml-1'}`} />}
              </div>
            </article>
          </Fragment>
        })}
      </>}
    </div>
    {newPosts && <button className="mx-auto mb-2 rounded-full bg-primary px-4 py-2 text-xs text-primary-foreground shadow" onClick={() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; nearBottom.current = true; setNewPosts(false) }}>Нові повідомлення ↓</button>}
    {notice && !error && <p role="status" className="shrink-0 px-4 py-2 text-sm text-muted-foreground">{notice}</p>}
    {error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">{error}</p>}
    {canPost ? <form onSubmit={send} className="shrink-0 space-y-1.5 border-t border-border bg-background px-3 py-2 sm:px-5">
      {(reply || editing) && <div className="flex items-center justify-between gap-2 rounded-xl border-l-2 border-primary bg-primary/5 px-3 py-2"><div className="min-w-0"><span className="block text-xs font-semibold text-primary">{editing ? 'Редагування' : 'Відповідь'}</span><span className="block truncate text-xs text-muted-foreground">{(editing || reply)?.body || 'Вкладення'}</span></div><button type="button" className={chatIcon} aria-label="Скасувати відповідь або редагування" onClick={() => { if (editing) setDraft(''); setReply(null); setEditing(null) }}><X size={16} /></button></div>}
      {files.length > 0 && <div className="flex flex-wrap gap-2">{files.map((file, index) => <span key={`${file.name}:${index}`} className="flex max-w-full items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs"><span className="truncate">{file.name}</span><button type="button" aria-label={`Прибрати ${file.name}`} disabled={Boolean(busy)} onClick={() => setFiles((current) => current.filter((_, item) => item !== index))}><X size={14} /></button></span>)}</div>}
      {!busy && <ChatMentionSuggestions value={draft} caret={draftCaret} profiles={suggestedProfiles} onSelect={selectMention} inputRef={composer} />}
      {attachmentMenu && !editing && <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-popover p-1" aria-label="Додати до чату">
        <button type="button" className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs hover:bg-muted" onClick={() => { setAttachmentMenu(false); fileInput.current?.click() }}><Paperclip size={14} />Файл</button>
        <button type="button" className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs hover:bg-muted" onClick={() => { setAttachmentMenu(false); setPublicationEditor({ kind: 'poll' }) }}><ListChecks size={14} />Опитування{!isPremium && <span className="text-[10px] text-primary">Учасник</span>}</button>
        <button type="button" className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs hover:bg-muted" onClick={() => { setAttachmentMenu(false); setPublicationEditor({ kind: 'article' }) }}><FileText size={14} />Стаття{!isPremium && <span className="text-[10px] text-primary">Учасник</span>}</button>
      </div>}
      <div className="flex items-end gap-2"><input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} /><button type="button" className={chatIcon} disabled={Boolean(busy) || Boolean(editing)} aria-label="Додати файл, опитування або статтю" aria-expanded={attachmentMenu} onClick={() => setAttachmentMenu((current) => !current)}><Paperclip size={18} /></button><textarea ref={composer} className={`${chatInput} min-h-10 max-h-32 resize-none overflow-y-auto`} value={draft} onChange={(event) => { setDraft(event.target.value); setDraftCaret(event.target.selectionStart) }} onSelect={(event) => setDraftCaret(event.currentTarget.selectionStart)} rows={1} maxLength={10000} placeholder={parentPost ? 'Написати коментар…' : space.kind === 'channel' ? 'Нова публікація…' : 'Повідомлення…'} aria-label="Текст повідомлення" disabled={Boolean(busy)} /><button className={`${chatPrimary} h-10 w-10 shrink-0 px-0`} aria-label={editing ? 'Зберегти зміни' : 'Надіслати'} disabled={Boolean(busy) || (!draft.trim() && !files.length && !editing?.attachments.length && !editing?.shared_news_post_id)}>{busy === 'send' ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}</button></div>
      {files.length > 0 && <p className="pl-11 text-[11px] text-muted-foreground">До 10 файлів, кожен до 25 МБ, загалом до 100 МБ.</p>}
    </form> : <p className="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">{parentPost ? 'Коментарі вимкнено.' : 'Публікувати можуть власник і адміністратори каналу.'}</p>}
    {publicationEditor && canPost && <ChatPublicationEditor kind={publicationEditor.kind} article={publicationEditor.article} userId={userId} target={{ spaceId: space.id, parentPostId: parentId, replyTo: reply?.id || null }}
      onClose={() => setPublicationEditor(null)} onSaved={async () => { const creating = !publicationEditor.article; setPublicationEditor(null); if (creating) { setReply(null); nearBottom.current = true }; announceChatUpdate(); await latestLoad.current(); await onRefresh() }} />}
    {comments && <ChatDialog title="Коментарі" onClose={() => setComments(null)} wide><CommunityChatTimeline key={comments.id} detail={detail} userId={userId} parentPost={comments} knownProfiles={profiles} onRefresh={async () => { await load(); await onRefresh() }} /></ChatDialog>}
    {pinPreview && <ChatDialog title="Повідомлення" onClose={() => setPinPreview(null)}><div className="space-y-3">
      {pinPreview.publication ? <ChatPublicationCard key={pinPreview.publication.id} publication={pinPreview.publication} onEdit={(article) => { setPinPreview(null); setPublicationEditor({ kind: 'article', article }) }} /> : <p className="whitespace-pre-wrap break-words text-sm leading-relaxed"><ChatMessageText text={pinPreview.body} profiles={mentionProfiles} /></p>}
      <StudyAssignmentMessageCard body={pinPreview.body} />
      {pinPreview.shared_news_post_id && <Link to="/news/$id" params={{ id: pinPreview.shared_news_post_id }} className="text-sm font-medium text-primary">Переглянути новину →</Link>}
      {pinPreview.attachments.map((file) => !file.url ? <p key={file.storage_path} className="text-sm text-muted-foreground">{file.file_name} · Вкладення недоступне</p> : file.media_type === 'image' ? <img key={file.storage_path} src={file.url} alt={file.file_name} className="max-h-96 w-full rounded-xl object-contain" /> : file.media_type === 'video' ? <video key={file.storage_path} src={file.url} controls preload="metadata" className="max-h-96 w-full rounded-xl" /> : <a key={file.storage_path} href={file.url} target="_blank" rel="noopener noreferrer" download={file.file_name} className="flex items-center gap-2 text-sm text-primary"><FileDown size={18} />{file.file_name}</a>)}
    </div></ChatDialog>}
    {deletePost && <ChatDialog title="Видалити повідомлення?" busy={Boolean(busy)} onClose={() => setDeletePost(null)}><p className="mb-4 text-sm text-muted-foreground">Повідомлення буде видалене для всіх учасників.</p><div className="flex justify-end gap-2"><button className={chatButton} disabled={Boolean(busy)} onClick={() => setDeletePost(null)}>Скасувати</button><button className={`${chatPrimary} bg-destructive`} disabled={Boolean(busy)} onClick={() => run(`delete:${deletePost.id}`, async () => { await chatRpc('xelay_chat_delete_post', { p_post_id: deletePost.id }); setDeletePost(null) })}>Видалити</button></div></ChatDialog>}
  </div>
}

function isMessageActionTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  if (target.closest('a,button,input,textarea,select,video,audio,summary,[contenteditable="true"],[role="button"],[role="link"]')) return false
  return window.getSelection()?.isCollapsed !== false
}
