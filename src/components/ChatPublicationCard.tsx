import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronRight, Copy, FileText, ListChecks, Loader2, Pencil, Square, SquareCheck, Users } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { chatRpc, loadChatProfiles, type ChatProfile } from '../lib/chatSpaces'
import { loadChatPublications, publicationError, type ChatArticle, type ChatPoll, type ChatPublication } from '../lib/chatPublications'
import { copyChatText } from '../lib/chatMessageText'
import { formatSafeDate, safeDateTime } from '../lib/safeDates'
import { ChatDialog, ChatPerson, chatButton, chatPrimary } from './CommunityChatPrimitives'
import { ChatArticleText } from './ChatArticleText'

const coverCache = new Map<string, { url: string; expires: number }>()
export function useArticleCover(path: string | null | undefined) {
  const [cover, setCover] = useState<{ path: string; url: string } | null>(null)
  useEffect(() => {
    if (!path) { setCover(null); return }
    let active = true
    let loading = false
    const load = async () => {
      if (loading || !active) return
      const cached = coverCache.get(path)
      if (cached && cached.expires > Date.now()) { setCover({ path, url: cached.url }); return }
      loading = true
      try {
        const result = await supabase.storage.from('xelay-chat-media').createSignedUrl(path, 600)
        if (!active) return
        if (result.data?.signedUrl) {
          coverCache.set(path, { url: result.data.signedUrl, expires: Date.now() + 8 * 60_000 })
          setCover({ path, url: result.data.signedUrl })
        } else setCover(null)
        for (const [key, value] of coverCache) if (value.expires < Date.now()) coverCache.delete(key)
      } catch { if (active) setCover(null) } finally { loading = false }
    }
    void load()
    const refresh = () => { if (document.visibilityState === 'visible') void load() }
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [path])
  return path && cover?.path === path ? cover.url : ''
}

export function ChatPublicationCard({ publication, onEdit }: { publication: ChatPublication; onEdit?: (article: ChatArticle) => void }) {
  const instance = useId()
  const [current, setCurrent] = useState(publication)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const alive = useRef(true)
  const sequence = useRef(0)
  const changing = useRef(false)
  const pending = useRef(false)
  const source = useRef(publication); source.current = publication
  const applyPublication = (incoming: ChatPublication) => setCurrent((previous) => {
    // A parent history request may have started before our vote or article edit.
    // Preserve the newer server result while that older request finishes.
    if (previous.id === incoming.id && previous.updated_at && incoming.updated_at && Date.parse(previous.updated_at) > Date.parse(incoming.updated_at)) return previous
    return incoming
  })
  useEffect(() => { if (changing.current) { pending.current = true; return }; applyPublication(publication) }, [publication])
  const refresh = useCallback(async () => {
    if (changing.current) { pending.current = true; return }
    const request = ++sequence.current
    const item = source.current
    try {
      const found = await loadChatPublications(item.post_id ? [item.post_id] : [], item.message_id ? [item.message_id] : [])
      if (!alive.current || request !== sequence.current) return
      const next = found.find((value) => value.id === item.id)
      if (next) { applyPublication(next); setUnavailable(false); setError('') }
      else { setUnavailable(true); setError('Публікація більше не доступна. Оновіть чат.') }
    } catch (failure) { if (alive.current && request === sequence.current) setError(publicationError(failure)) }
  }, [])
  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void refresh(), 200) }
    const channel = supabase.channel(`publication:${publication.id}:${instance}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_publications', filter: `id=eq.${publication.id}` }, changed).subscribe()
    window.addEventListener('focus', changed)
    return () => { alive.current = false; sequence.current++; if (timer) clearTimeout(timer); window.removeEventListener('focus', changed); void supabase.removeChannel(channel) }
  }, [publication.id, instance, refresh])
  const pollAction = async (action: () => Promise<ChatPoll>) => {
    if (changing.current) return
    changing.current = true; sequence.current++; setError('')
    try {
      const poll = await action()
      if (alive.current) setCurrent((item) => ({ ...item, poll, updated_at: poll.updated_at || item.updated_at }))
    } catch (failure) { if (alive.current) setError(publicationError(failure)) }
    finally { changing.current = false; if (alive.current && pending.current) { pending.current = false; void refresh() } }
  }
  return <div className="min-w-[min(60vw,16rem)] max-w-full">
    {!unavailable && current.kind === 'poll' && current.poll && <PollCard poll={current.poll} onAction={pollAction} />}
    {!unavailable && current.kind === 'article' && current.article && <ArticleCard article={current.article} onEdit={onEdit} />}
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </div>
}

function PollCard({ poll, onAction }: { poll: ChatPoll; onAction: (action: () => Promise<ChatPoll>) => Promise<void> }) {
  const [choices, setChoices] = useState(poll.my_votes || [])
  const [busy, setBusy] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [votersFor, setVotersFor] = useState<number | null>(null)
  const [clock, setClock] = useState(Date.now())
  const alive = useRef(true)
  const lock = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const votesKey = (poll.my_votes || []).join(',')
  useEffect(() => { setChoices(poll.my_votes || []) }, [votesKey])
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 15_000); return () => clearInterval(timer) }, [])
  const deadline = safeDateTime(poll.closes_at)
  const closed = poll.is_closed || Boolean(poll.closed_at) || (deadline !== null && deadline <= clock)
  const results = closed || showResults || (poll.my_votes || []).length > 0
  const run = async (action: () => Promise<ChatPoll>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try { await onAction(action) } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const vote = (ids: number[]) => run(() => chatRpc<ChatPoll>('xelay_chat_poll_vote', { p_poll_id: poll.id, p_option_ids: ids }))
  const changed = choices.join(',') !== votesKey
  return <section className="max-w-sm" aria-label="Опитування">
    <p className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground"><ListChecks size={13} />{poll.anonymous ? 'Анонімне опитування' : 'Відкрите опитування'}{closed ? ' · завершено' : ''}</p>
    <h3 className="mb-3 whitespace-pre-wrap break-words text-sm font-semibold">{poll.question}</h3>
    <div className="space-y-1.5">{poll.options.map((option) => {
      const checked = choices.includes(option.id)
      const mine = (poll.my_votes || []).includes(option.id)
      const percent = poll.total_voters ? Math.round(option.votes / poll.total_voters * 100) : 0
      return <div key={option.id} className="relative">
        <button type="button" disabled={busy || closed} aria-pressed={checked}
          onClick={() => poll.allows_multiple ? setChoices((current) => current.includes(option.id) ? current.filter((value) => value !== option.id) : [...current, option.id].sort((a, b) => a - b)) : void vote(checked ? [] : [option.id])}
          className={`relative flex min-h-10 w-full items-center gap-2 overflow-hidden rounded-lg border px-2.5 py-2 text-left text-xs disabled:cursor-default ${checked ? 'border-primary/35' : 'border-border/70'} ${closed ? '' : 'hover:border-primary/40'}`}>
          {results && <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-primary/10 transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />}
          <span className="relative shrink-0 text-primary">{poll.allows_multiple ? checked ? <SquareCheck size={15} /> : <Square size={15} /> : mine ? <Check size={15} /> : <span className="block h-3.5 w-3.5 rounded-full border border-primary/40" />}</span>
          <span className="relative min-w-0 flex-1 whitespace-pre-wrap break-words">{option.text}</span>
          {results && <span className="relative shrink-0 font-medium">{percent}%</span>}
        </button>
        {results && !poll.anonymous && option.votes > 0 && <button type="button" className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted-foreground hover:text-primary" onClick={() => setVotersFor(option.id)}><Users size={11} />{option.votes} · хто голосував</button>}
      </div>
    })}</div>
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-muted-foreground">
      <span>{poll.total_voters} учасників проголосувало</span>
      {!closed && poll.allows_multiple && changed && <button type="button" disabled={busy} className="font-semibold text-primary" onClick={() => void vote(choices)}>{busy ? 'Зберігаємо…' : choices.length ? 'Проголосувати' : 'Скасувати голос'}</button>}
      {!closed && !results && <button type="button" onClick={() => setShowResults(true)} className="text-primary">Результати</button>}
      {!closed && (poll.my_votes || []).length > 0 && <button type="button" disabled={busy} onClick={() => void vote([])} className="hover:text-primary">Скасувати голос</button>}
      {busy && <Loader2 size={12} className="animate-spin" aria-label="Зберігаємо голос" />}
    </div>
    {poll.closes_at && <p className="mt-1 text-[10px] text-muted-foreground">{deadline === null ? 'Дату завершення не визначено' : `До ${formatSafeDate(poll.closes_at, new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · Київ`}</p>}
    {!closed && poll.can_close && <button type="button" disabled={busy} className="mt-2 text-[10px] text-muted-foreground hover:text-primary" onClick={() => setConfirmClose(true)}>Завершити опитування</button>}
    {confirmClose && <ChatDialog title="Завершити опитування?" onClose={() => setConfirmClose(false)} busy={busy}><p className="mb-4 text-sm text-muted-foreground">Після завершення результати залишаться доступними, нові голоси не прийматимуться.</p><div className="flex justify-end gap-2"><button type="button" disabled={busy} className={chatButton} onClick={() => setConfirmClose(false)}>Скасувати</button><button type="button" disabled={busy} className={chatPrimary} onClick={() => void run(async () => { const value = await chatRpc<ChatPoll>('xelay_chat_poll_close', { p_poll_id: poll.id }); if (alive.current) setConfirmClose(false); return value })}>{busy && <Loader2 size={15} className="animate-spin" />}Завершити</button></div></ChatDialog>}
    {votersFor !== null && <PollVoters poll={poll} optionId={votersFor} onClose={() => setVotersFor(null)} />}
  </section>
}

function PollVoters({ poll, optionId, onClose }: { poll: ChatPoll; optionId: number; onClose: () => void }) {
  const [people, setPeople] = useState<ChatProfile[]>([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const lock = useRef(false)
  const offset = useRef(0)
  const load = useCallback(async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await chatRpc<{ user_ids: string[]; total: number }>('xelay_chat_poll_voters', { p_poll_id: poll.id, p_option_id: optionId, p_offset: offset.current, p_limit: 50 })
      const profiles = await loadChatProfiles(result.user_ids || [])
      if (!alive.current) return
      offset.current += (result.user_ids || []).length
      setTotal(result.total)
      setPeople((current) => [...current, ...(result.user_ids || []).filter((id) => !current.some((person) => person.id === id)).map((id) => profiles[id] || { id, full_name: null, username: null, avatar_url: null })])
    } catch (failure) { if (alive.current) setError(publicationError(failure)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }, [poll.id, optionId])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
  return <ChatDialog title="Хто проголосував" onClose={onClose}><p className="mb-4 text-sm font-medium">{poll.options.find((option) => option.id === optionId)?.text}</p><div className="space-y-3">{people.map((person) => <ChatPerson key={person.id} id={person.id} profile={person} />)}</div>{error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}{busy && <Loader2 size={18} className="mx-auto mt-3 animate-spin" />}{!busy && people.length < total && <button type="button" className={`${chatButton} mt-4 w-full`} onClick={() => void load()}>Показати ще</button>}{!busy && !people.length && !error && <p className="text-sm text-muted-foreground">Поки немає голосів.</p>}</ChatDialog>
}

function ArticleCard({ article, onEdit }: { article: ChatArticle; onEdit?: (article: ChatArticle) => void }) {
  const [opened, setOpened] = useState(false)
  const [copied, setCopied] = useState(false)
  const cover = useArticleCover(article.cover_path)
  return <section className="max-w-sm" aria-label="Стаття">
    <p className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground"><FileText size={13} />Стаття</p>
    <button type="button" className="block w-full text-left" onClick={() => setOpened(true)}>
      {cover && <img src={cover} alt="" loading="lazy" className="mb-2 max-h-40 w-full rounded-lg object-cover" />}
      <h3 className="break-words text-sm font-semibold">{article.title}</h3>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{article.excerpt || article.body.slice(0, 180)}</p>
      <span className="mt-2 flex items-center gap-1 text-xs font-medium text-primary">Читати статтю<ChevronRight size={13} /></span>
    </button>
    {article.can_edit && onEdit && <button type="button" className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary" onClick={() => onEdit(article)}><Pencil size={11} />Редагувати статтю</button>}
    {opened && <ChatDialog title={article.title} onClose={() => setOpened(false)} wide><article>{cover && <img src={cover} alt="" className="mb-5 max-h-96 w-full rounded-xl object-contain" />}<ChatArticleText body={article.body} /><div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-4"><button type="button" className={chatButton} onClick={() => void copyChatText(`${article.title}\n\n${article.body}`).then(setCopied)}><Copy size={14} />{copied ? 'Скопійовано' : 'Копіювати текст'}</button>{article.can_edit && onEdit && <button type="button" className={chatButton} onClick={() => { setOpened(false); onEdit(article) }}><Pencil size={14} />Редагувати</button>}</div></article></ChatDialog>}
  </section>
}
