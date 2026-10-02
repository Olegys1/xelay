import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { FileDown, Loader2, MessageCircle, Paperclip, Pencil, Pin, Reply, Send, Smile, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  announceChatUpdate, chatError, chatRpc, discardChatFiles, loadChatProfiles, signChatPosts, uploadChatFiles, validateChatFiles,
  type ChatPost, type ChatProfile, type ChatSpaceDetail,
} from '../lib/chatSpaces'
import { ChatAvatar, ChatDialog, ChatPerson, ChatSpinner, chatButton, chatIcon, chatInput, chatPrimary } from './CommunityChatPrimitives'
import { StudyAssignmentMessageCard } from './StudyAssignmentMessageCard'

const reactions = ['👍', '❤️', '🔥', '👏', '😂', '🎉', '😮', '😢', '🤔', '👎', '💯', '🙏']
type Props = { detail: ChatSpaceDetail; userId: string; parentPost?: ChatPost; onRefresh: () => Promise<void> }

export function CommunityChatTimeline({ detail, userId, parentPost, onRefresh }: Props) {
  const space = detail.space
  const [posts, setPosts] = useState<ChatPost[]>([])
  const [profiles, setProfiles] = useState<Record<string, ChatProfile>>({})
  const [loading, setLoading] = useState(true)
  const [olderBusy, setOlderBusy] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
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
  const alive = useRef(true)
  const loadSequence = useRef(0)
  const mutation = useRef(false)
  const nearBottom = useRef(true)
  const latest = useRef(posts); latest.current = posts
  const pendingRefresh = useRef(false)
  const lastRead = useRef(detail.my_membership?.last_read_at || '')
  const parentId = parentPost?.id || null
  const role = detail.my_membership?.role
  const admin = role === 'owner' || role === 'admin'
  const canPost = parentPost ? space.comments_enabled : space.kind === 'group' || admin

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
      const foundProfiles = await loadChatProfiles([...raw, ...retained].map((post) => post.sender_id))
      if (!alive.current || sequence !== loadSequence.current) return
      const previousHeight = scroller.current?.scrollHeight || 0
      const previousTop = scroller.current?.scrollTop || 0
      setProfiles((current) => ({ ...current, ...foundProfiles }))
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
    } catch (failure) { if (alive.current && sequence === loadSequence.current) { setError(chatError(failure)); setLoading(false); if (/CHAT_(POST_NOT_FOUND|MEMBER_REQUIRED|NOT_FOUND|COMMENTS_DISABLED)/.test((failure as { message?: string })?.message || '')) setPosts([]) } }
    finally { if (alive.current && sequence === loadSequence.current) setOlderBusy(false) }
  }, [space.id, parentId, userId])
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

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (mutation.current) return
    mutation.current = true; setBusy(key); setError('')
    try {
      await action(); announceChatUpdate()
      mutation.current = false
      await latestLoad.current(); await onRefresh()
    } catch (failure) { if (alive.current) setError(chatError(failure)) }
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
      if (alive.current) { setDraft(''); setFiles([]); setReply(null); setEditing(null); nearBottom.current = true }
    })
  }
  const addFiles = (next: File[]) => {
    const combined = [...files, ...next]
    const validation = validateChatFiles(combined)
    if (validation) { setError(validation); return }
    setFiles(combined); setError('')
  }
  const startEdit = (post: ChatPost) => { setEditing(post); setDraft(post.body); setReply(null); setFiles([]) }
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
    {parentPost && <div className="mb-3 rounded-xl border border-border bg-muted/40 p-3"><p className="text-sm font-medium">Публікація</p><p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-muted-foreground">{parentPost.body || 'Публікація з вкладенням'}</p>{!parentPost.deleted_at && <StudyAssignmentMessageCard body={parentPost.body} />}</div>}
    <div ref={scroller} onScroll={() => { const element = scroller.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120 }} className={`min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5 ${parentPost ? 'max-h-[45dvh] min-h-[180px]' : 'min-h-[240px]'}`}>
      {loading ? <ChatSpinner /> : <>
        {hasOlder && <div className="flex justify-center"><button className={chatButton} disabled={olderBusy || Boolean(busy)} onClick={() => void load(true)}>{olderBusy && <Loader2 size={15} className="animate-spin" />}Попередні повідомлення</button></div>}
        {!posts.length && !error && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><MessageCircle size={30} className="text-primary/50" /><p className="text-sm">{parentPost ? 'Поки немає коментарів. Почніть обговорення.' : space.kind === 'channel' ? 'Тут з’являться публікації каналу.' : 'Чат готовий. Напишіть перше повідомлення.'}</p></div>}
        {posts.map((post) => {
          const own = post.sender_id === userId
          const channelPost = space.kind === 'channel' && !parentPost
          const referenced = posts.find((item) => item.id === post.reply_to)
          const groupedReactions = (post.reactions || []).reduce<Record<string, { count: number; mine: boolean }>>((items, item) => { items[item.emoji] ||= { count: 0, mine: false }; items[item.emoji].count += 1; items[item.emoji].mine ||= item.user_id === userId; return items }, {})
          return <article id={`community-post-${post.id}`} key={post.id} className={`group relative max-w-[94%] space-y-2 rounded-2xl border p-3 sm:max-w-[85%] sm:p-4 ${channelPost ? 'mx-auto w-full border-border bg-card' : own ? 'ml-auto border-primary/15 bg-primary/5' : 'border-border bg-card'}`}>
            <div className="flex items-center justify-between gap-2">{channelPost ? <div className="flex min-w-0 items-center gap-2"><ChatAvatar space={space} size="h-7 w-7" /><span className="truncate text-sm font-semibold">{space.name}</span></div> : <ChatPerson id={post.sender_id} profile={profiles[post.sender_id]} small />}<time dateTime={post.created_at} className="shrink-0 text-[11px] text-muted-foreground" title={new Date(post.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}>{new Date(post.created_at).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })} · {new Date(post.created_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}</time></div>
            {post.reply_to && <button className="block w-full truncate rounded-lg border-l-2 border-primary bg-muted/60 px-3 py-2 text-left text-xs text-muted-foreground" onClick={() => void openPin(post.reply_to!)}>↳ {referenced?.body || 'Відповідь на повідомлення'}</button>}
            {post.deleted_at ? <p className="text-sm italic text-muted-foreground">Повідомлення видалено</p> : <>
              {post.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{post.body}</p>}
              <StudyAssignmentMessageCard body={post.body} />
              {post.shared_news_post_id && <Link to="/news/$id" params={{ id: post.shared_news_post_id }} className="block rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm font-medium text-primary">Переглянути новину ↗</Link>}
              {(post.attachments || []).map((file, index) => <div key={file.id || `${file.storage_path}:${index}`}>
                {!file.url ? <p className="rounded-xl border border-border p-3 text-xs text-muted-foreground">{file.file_name} · Вкладення тимчасово недоступне</p> : file.media_type === 'image' ? <a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`Відкрити фото ${file.file_name}`}><img src={file.url} alt={file.file_name} loading="lazy" className="max-h-96 w-full rounded-xl object-contain" /></a> : file.media_type === 'video' ? <video src={file.url} controls preload="metadata" className="max-h-96 w-full rounded-xl" /> : <a href={file.url} target="_blank" rel="noopener noreferrer" download={file.file_name} className="flex items-center gap-3 rounded-xl border border-border bg-background p-3 text-sm hover:border-primary/30"><FileDown size={20} className="shrink-0 text-primary" /><span className="min-w-0"><span className="block truncate font-medium">{file.file_name}</span><span className="text-xs text-muted-foreground">{Math.ceil(file.file_size / 1024)} КБ</span></span></a>}
              </div>)}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">{Object.entries(groupedReactions).map(([emoji, state]) => <button key={emoji} className={`rounded-full border px-2.5 py-1 text-xs ${state.mine ? 'border-primary/30 bg-primary/10' : 'border-border bg-muted/50'}`} disabled={Boolean(busy)} onClick={() => run(`react:${post.id}`, () => chatRpc('xelay_chat_react', { p_post_id: post.id, p_emoji: emoji }))}>{emoji} {state.count}</button>)}<button className={chatIcon} title="Реакції" aria-label="Додати реакцію" onClick={() => setReactionFor((current) => current === post.id ? '' : post.id)}><Smile size={15} /></button>{canPost && <button className={chatIcon} aria-label="Відповісти" title="Відповісти" onClick={() => { setReply(post); setEditing(null) }}><Reply size={15} /></button>}{(own || (channelPost && admin)) && <button className={chatIcon} aria-label="Редагувати" title="Редагувати" disabled={Boolean(busy)} onClick={() => startEdit(post)}><Pencil size={14} /></button>}{admin && !parentPost && <button className={chatIcon} aria-label="Закріпити або відкріпити" title="Закріпити або відкріпити" disabled={Boolean(busy)} onClick={() => run(`pin:${post.id}`, () => chatRpc('xelay_chat_pin', { p_post_id: post.id, p_pin: !detail.pins.some((item) => item.id === post.id) }))}><Pin size={14} /></button>}{(own || admin) && <button className={`${chatIcon} hover:text-destructive`} aria-label="Видалити" title="Видалити" disabled={Boolean(busy)} onClick={() => setDeletePost(post)}><Trash2 size={14} /></button>}{post.edited_at && <span className="ml-auto text-[10px] text-muted-foreground">змінено</span>}</div>
              {reactionFor === post.id && <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-background p-2">{reactions.map((emoji) => <button key={emoji} aria-label={`Реакція ${emoji}`} className="rounded-lg px-2 py-1 text-xl hover:bg-muted" disabled={Boolean(busy)} onClick={() => { setReactionFor(''); void run(`react:${post.id}`, () => chatRpc('xelay_chat_react', { p_post_id: post.id, p_emoji: emoji })) }}>{emoji}</button>)}</div>}
              {channelPost && space.comments_enabled && <button className="flex w-full items-center justify-between rounded-xl bg-muted/50 px-3 py-2 text-xs font-medium text-primary hover:bg-muted" onClick={() => setComments(post)}><span className="flex items-center gap-2"><MessageCircle size={15} />Коментарі</span><span>{post.comment_count || 0} →</span></button>}
            </>}
          </article>
        })}
      </>}
    </div>
    {newPosts && <button className="mx-auto mb-2 rounded-full bg-primary px-4 py-2 text-xs text-primary-foreground shadow" onClick={() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; nearBottom.current = true; setNewPosts(false) }}>Нові повідомлення ↓</button>}
    {error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">{error}</p>}
    {canPost ? <form onSubmit={send} className="shrink-0 space-y-2 border-t border-border bg-background px-3 py-3 sm:px-5">
      {(reply || editing) && <div className="flex items-center justify-between gap-2 rounded-xl border-l-2 border-primary bg-primary/5 px-3 py-2"><div className="min-w-0"><span className="block text-xs font-semibold text-primary">{editing ? 'Редагування' : 'Відповідь'}</span><span className="block truncate text-xs text-muted-foreground">{(editing || reply)?.body || 'Вкладення'}</span></div><button type="button" className={chatIcon} aria-label="Скасувати відповідь або редагування" onClick={() => { if (editing) setDraft(''); setReply(null); setEditing(null) }}><X size={16} /></button></div>}
      {files.length > 0 && <div className="flex flex-wrap gap-2">{files.map((file, index) => <span key={`${file.name}:${index}`} className="flex max-w-full items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs"><span className="truncate">{file.name}</span><button type="button" aria-label={`Прибрати ${file.name}`} disabled={Boolean(busy)} onClick={() => setFiles((current) => current.filter((_, item) => item !== index))}><X size={14} /></button></span>)}</div>}
      <div className="flex items-end gap-2"><input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} /><button type="button" className={chatIcon} disabled={Boolean(busy) || Boolean(editing)} aria-label="Прикріпити файли" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button><textarea className={`${chatInput} max-h-36 resize-y`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={10000} placeholder={parentPost ? 'Написати коментар…' : space.kind === 'channel' ? 'Нова публікація…' : 'Повідомлення…'} aria-label="Текст повідомлення" disabled={Boolean(busy)} /><button className={`${chatPrimary} mb-0.5 h-10 w-10 shrink-0 px-0`} aria-label={editing ? 'Зберегти зміни' : 'Надіслати'} disabled={Boolean(busy) || (!draft.trim() && !files.length && !editing?.attachments.length && !editing?.shared_news_post_id)}>{busy === 'send' ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}</button></div>
      {files.length > 0 && <p className="pl-11 text-[11px] text-muted-foreground">До 10 файлів, кожен до 25 МБ, загалом до 100 МБ.</p>}
    </form> : <p className="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">{parentPost ? 'Коментарі вимкнено.' : 'Публікувати можуть власник і адміністратори каналу.'}</p>}
    {comments && <ChatDialog title="Коментарі" onClose={() => setComments(null)} wide><CommunityChatTimeline key={comments.id} detail={detail} userId={userId} parentPost={comments} onRefresh={async () => { await load(); await onRefresh() }} /></ChatDialog>}
    {pinPreview && <ChatDialog title="Повідомлення" onClose={() => setPinPreview(null)}><div className="space-y-3"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{pinPreview.body}</p><StudyAssignmentMessageCard body={pinPreview.body} />{pinPreview.shared_news_post_id && <Link to="/news/$id" params={{ id: pinPreview.shared_news_post_id }} className="text-sm font-medium text-primary">Переглянути новину →</Link>}{pinPreview.attachments.map((file) => !file.url ? <p key={file.storage_path} className="text-sm text-muted-foreground">{file.file_name} · Вкладення недоступне</p> : file.media_type === 'image' ? <img key={file.storage_path} src={file.url} alt={file.file_name} className="max-h-96 w-full rounded-xl object-contain" /> : file.media_type === 'video' ? <video key={file.storage_path} src={file.url} controls preload="metadata" className="max-h-96 w-full rounded-xl" /> : <a key={file.storage_path} href={file.url} target="_blank" rel="noopener noreferrer" download={file.file_name} className="flex items-center gap-2 text-sm text-primary"><FileDown size={18} />{file.file_name}</a>)}</div></ChatDialog>}
    {deletePost && <ChatDialog title="Видалити повідомлення?" busy={Boolean(busy)} onClose={() => setDeletePost(null)}><p className="mb-4 text-sm text-muted-foreground">Повідомлення буде видалене для всіх учасників.</p><div className="flex justify-end gap-2"><button className={chatButton} disabled={Boolean(busy)} onClick={() => setDeletePost(null)}>Скасувати</button><button className={`${chatPrimary} bg-destructive`} disabled={Boolean(busy)} onClick={() => run(`delete:${deletePost.id}`, async () => { await chatRpc('xelay_chat_delete_post', { p_post_id: deletePost.id }); setDeletePost(null) })}>Видалити</button></div></ChatDialog>}
  </div>
}
