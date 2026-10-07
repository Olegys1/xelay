import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { FileDown, Loader2, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useBilling } from '../context/BillingContext'
import { ChatDialog, chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'
import { chatRpc, loadChatProfiles, signChatPosts, type ChatPost, type ChatProfile } from '../lib/chatSpaces'
import { participantMessageError } from '../lib/participantMessaging'
import { ChatMessageText } from './ChatMentions'
import { ChatPublicationCard } from './ChatPublicationCard'
import { formatSafeDate } from '../lib/safeDates'
import { loadChatPublications, type ChatPublication } from '../lib/chatPublications'
import type { ChatMentionProfile } from '../lib/chatMessageText'

type SearchResult = { id: string; sender_id: string; body: string; created_at: string; attachments: { file_name: string; media_type: string }[] }
type Preview = { message: SearchResult; attachments: { file_name: string; media_type: string; url: string }[]; post?: ChatPost; publication?: ChatPublication }
type Props = { kind: 'direct' | 'group' | 'channel'; containerId: string; profiles: ChatMentionProfile[]; userId: string; onClose: () => void }
const PAGE_SIZE = 30
const dateLabel = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' })

/** Searches the server's accessible history, independently of loaded timeline pages. */
export function ConversationSearch({ kind, containerId, profiles, userId, onClose }: Props) {
  const { isPremium, isLoading: billingLoading } = useBilling()
  const [query, setQuery] = useState('')
  const [author, setAuthor] = useState('')
  const [authorQuery, setAuthorQuery] = useState('')
  const [foundAuthors, setFoundAuthors] = useState<ChatProfile[]>([])
  const [resultProfiles, setResultProfiles] = useState<Record<string, ChatProfile>>({})
  const [authorsBusy, setAuthorsBusy] = useState(false)
  const [authorsError, setAuthorsError] = useState('')
  const [from, setFrom] = useState('')
  const [through, setThrough] = useState('')
  const [media, setMedia] = useState('all')
  const [results, setResults] = useState<SearchResult[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewBusy, setPreviewBusy] = useState('')
  const alive = useRef(true)
  const sequence = useRef(0)
  const committedFilters = useRef<Record<string, unknown> | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current } }, [])
  useEffect(() => {
    if (!isPremium) { setFoundAuthors([]); return }
    let active = true
    const timer = window.setTimeout(() => {
      setAuthorsBusy(true); setAuthorsError('')
      void (async () => {
        try {
          const ids = await chatRpc<string[]>('xelay_conversation_search_authors', { p_kind: kind, p_container_id: containerId, p_query: authorQuery.trim(), p_limit: 30 })
          const found = await loadChatProfiles(ids)
          if (active && alive.current) setFoundAuthors(Object.values(found))
        } catch (failure) { if (active && alive.current) setAuthorsError(participantMessageError(failure)) }
        finally { if (active && alive.current) setAuthorsBusy(false) }
      })()
    }, 350)
    return () => { active = false; window.clearTimeout(timer) }
  }, [isPremium, authorQuery, kind, containerId])
  const filtersChanged = () => { ++sequence.current; setResults([]); setPreview(null); setPreviewBusy(''); setHasMore(false); setSearched(false); setError(''); setBusy(false); committedFilters.current = null }

  async function run(older = false) {
    if (!isPremium || busy) return
    const filters = older ? committedFilters.current : {
      p_kind: kind, p_container_id: containerId, p_query: query.trim(), p_author_id: author || null,
      p_from: from || null, p_through: through || null, p_media: media,
    }
    if (!filters) return
    const requestId = ++sequence.current
    setBusy(true); setError(''); setPreview(null)
    try {
      const last = older ? results[results.length - 1] : undefined
      const rows = await chatRpc<SearchResult[]>('xelay_search_conversation_messages', {
        ...filters, p_before: last?.created_at || null, p_before_id: last?.id || null, p_limit: PAGE_SIZE,
      })
      const profileRows = rows.length ? await loadChatProfiles(rows.map((row) => row.sender_id)) : {}
      if (!alive.current || requestId !== sequence.current) return
      setResultProfiles((current) => ({ ...current, ...profileRows }))
      committedFilters.current = filters
      setResults((current) => older ? [...current, ...rows.filter((row) => !current.some((existing) => existing.id === row.id))] : rows)
      setHasMore(rows.length === PAGE_SIZE); setSearched(true)
    } catch (failure) { if (alive.current && requestId === sequence.current) setError(participantMessageError(failure)) }
    finally { if (alive.current && requestId === sequence.current) setBusy(false) }
  }

  async function openResult(row: SearchResult) {
    if (previewBusy) return
    const requestId = ++sequence.current
    setPreviewBusy(row.id); setError('')
    try {
      // Fetch current content and authorize media again before generating URLs;
      // search results never contain reusable private URLs or Storage paths.
      if (kind === 'direct') {
        const { data: current, error: messageError } = await supabase.from('messages')
          .select('id,sender_id,body,created_at,deleted_at').eq('id', row.id).eq('conversation_id', containerId).maybeSingle()
        if (messageError) throw messageError
        if (!current || current.deleted_at) throw new Error('CHAT_MEMBER_REQUIRED')
        const { data, error: mediaError } = await supabase.from('message_attachments')
          .select('file_name,media_type,storage_path').eq('message_id', row.id).eq('conversation_id', containerId)
        if (mediaError) throw mediaError
        const files = data || []
        const signed = files.length ? await supabase.storage.from('xelay-message-media').createSignedUrls(files.map((file) => file.storage_path), 300) : { data: [], error: null }
        if (signed.error) throw signed.error
        const urls = new Map((signed.data || []).map((file) => [file.path, file.signedUrl]))
        const [publication] = await loadChatPublications([], [row.id])
        if (alive.current && requestId === sequence.current) setPreview({ message: { ...row, ...current }, publication, attachments: files.map((file) => ({ ...file, url: urls.get(file.storage_path) || '' })) })
      } else {
        const found = await chatRpc<ChatPost[]>('xelay_chat_posts_by_ids', { p_space_id: containerId, p_post_ids: [row.id] })
        if (!found.length) throw new Error('CHAT_MEMBER_REQUIRED')
        const [post] = await signChatPosts(found)
        if (alive.current && requestId === sequence.current) setPreview({ message: { ...row, body: post.body }, attachments: post.attachments.map((file) => ({ ...file, media_type: file.media_type || 'file', url: file.url || '' })), post })
      }
    } catch (failure) { if (alive.current && requestId === sequence.current) setError(participantMessageError(failure)) }
    finally { if (alive.current && requestId === sequence.current) setPreviewBusy('') }
  }

  const submit = (event: FormEvent) => { event.preventDefault(); void run() }
  const allProfiles = [...new Map([...profiles, ...Object.values(resultProfiles), ...foundAuthors].map((profile) => [profile.id, profile])).values()]
  const authorOptions = authorQuery.trim() ? foundAuthors : allProfiles
  const profileName = (id: string) => id === userId ? 'Ви' : allProfiles.find((profile) => profile.id === id)?.full_name || allProfiles.find((profile) => profile.id === id)?.username || 'Учасник Xelay'
  return <ChatDialog title="Пошук у переписці" onClose={onClose}>
    {billingLoading ? <p className="text-sm text-muted-foreground">Перевіряємо підписку…</p> : !isPremium ? <div className="space-y-3"><p className="text-sm text-muted-foreground">З «Учасником» шукайте в усій доступній історії за текстом, автором, датами, файлами та посиланнями.</p><Link to="/subscription" className={chatPrimary} onClick={onClose}>Переглянути підписку</Link></div> : <>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs font-medium">Текст або назва файла<input className={`${chatInput} mt-1`} value={query} maxLength={150} onChange={(event) => { setQuery(event.target.value); filtersChanged() }} placeholder="Що знайти?" autoFocus /></label>
        <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-medium">Автор<input className={`${chatInput} mt-1`} value={authorQuery} maxLength={80} onChange={(event) => { setAuthorQuery(event.target.value); setAuthor(''); filtersChanged() }} placeholder="Ім&apos;я або @нік" aria-label="Знайти автора в історії чату" /><select className={`${chatInput} mt-1`} value={author} onChange={(event) => { setAuthor(event.target.value); filtersChanged() }}><option value="">Усі</option>{[...new Map([{ id: userId, full_name: 'Ви', username: null, avatar_url: null }, ...authorOptions].map((profile) => [profile.id, profile])).values()].map((profile) => <option key={profile.id} value={profile.id}>{profileName(profile.id)}</option>)}</select></label>
          <label className="block text-xs font-medium">Тип<select className={`${chatInput} mt-1`} value={media} onChange={(event) => { setMedia(event.target.value); filtersChanged() }}><option value="all">Усе</option><option value="photo">Фото</option><option value="video">Відео</option><option value="file">Файли</option><option value="link">Посилання</option></select></label></div>
        <div className="grid grid-cols-2 gap-3"><label className="block min-w-0 text-xs font-medium">Від<input type="date" className={`${chatInput} mt-1`} value={from} max={through || undefined} onChange={(event) => { setFrom(event.target.value); filtersChanged() }} /></label><label className="block min-w-0 text-xs font-medium">До<input type="date" className={`${chatInput} mt-1`} value={through} min={from || undefined} onChange={(event) => { setThrough(event.target.value); filtersChanged() }} /></label></div>
        {authorsBusy && <p role="status" className="text-[11px] text-muted-foreground">Шукаємо авторів у доступній історії…</p>}
        {authorsError && <p className="text-[11px] text-destructive">{authorsError}</p>}
        {authorQuery.trim() && !authorsBusy && !authorsError && !foundAuthors.length && <p className="text-[11px] text-muted-foreground">Авторів за цим ім’ям не знайдено.</p>}
        <p className="text-[11px] text-muted-foreground">Знайдіть автора за ім’ям або ніком і оберіть його у списку. Дати враховують час Києва. Пошук охоплює всю доступну історію, включно з раніше не завантаженими повідомленнями.</p>
        <button className={`${chatPrimary} w-full`} disabled={busy || Boolean(previewBusy)}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}Знайти</button>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {preview && <section className="mt-4 space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-3" aria-label="Знайдене повідомлення"><p className="text-xs font-medium">{profileName(preview.message.sender_id)} · {formatSafeDate(preview.message.created_at, dateLabel)}</p>{(preview.publication || preview.post?.publication) ? <ChatPublicationCard publication={(preview.publication || preview.post?.publication)!} /> : <p className="whitespace-pre-wrap break-words text-sm"><ChatMessageText text={preview.message.body} profiles={allProfiles} /></p>}{preview.attachments.map((file, index) => !file.url ? <p key={index} className="text-xs text-muted-foreground">{file.file_name} · Вкладення недоступне</p> : file.media_type === 'image' ? <a key={index} href={file.url} target="_blank" rel="noopener noreferrer"><img src={file.url} alt={file.file_name} loading="lazy" className="max-h-72 max-w-full rounded-xl object-contain" /></a> : file.media_type === 'video' ? <video key={index} src={file.url} controls playsInline preload="metadata" className="max-h-72 w-full rounded-xl" /> : <a key={index} href={file.url} target="_blank" rel="noopener noreferrer" download={file.file_name} className="flex items-center gap-2 break-all text-sm text-primary"><FileDown size={16} className="shrink-0" />{file.file_name}</a>)}</section>}
      <div className="mt-4 space-y-2" aria-live="polite">{searched && !results.length && <p className="py-3 text-center text-sm text-muted-foreground">Нічого не знайдено. Спробуйте інший текст або фільтри.</p>}{results.map((row) => <button type="button" key={row.id} onClick={() => void openResult(row)} disabled={Boolean(previewBusy)} className="block w-full rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted disabled:opacity-50"><span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span className="truncate">{profileName(row.sender_id)}</span><span className="shrink-0">{formatSafeDate(row.created_at, dateLabel)}</span></span><span className="mt-1 block line-clamp-3 whitespace-pre-wrap break-words text-sm">{row.body || 'Вкладення'}</span>{row.attachments.length > 0 && <span className="mt-1 block truncate text-xs text-primary">{row.attachments.map((file) => file.file_name).join(' · ')}</span>}{previewBusy === row.id && <Loader2 size={14} className="mt-1 animate-spin" />}</button>)}</div>
      {hasMore && <button type="button" className={`${chatButton} mt-3 w-full`} onClick={() => void run(true)} disabled={busy || Boolean(previewBusy)}>Ще результати</button>}
    </>}
  </ChatDialog>
}
