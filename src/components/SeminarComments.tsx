import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Loader2, MessageCircle, Pencil, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  SEMINAR_COMMENT_MAX_LENGTH, SeminarComment, SeminarCommentsData,
  addSeminarComment, deleteSeminarComment, loadSeminarComments,
  seminarCommentAccessLost, seminarCommentError, updateSeminarComment,
} from '../lib/seminarComments'

type Props = { seminarId: string; groupId: string; currentUserId: string; canModerate: boolean; canParticipate: boolean; onLicenseRequired?: () => void }

const emptyComments: SeminarCommentsData = { comments: [], profiles: {}, hasMore: false, membershipId: null }
const licenseRequiredNotice = 'Доступ навчальної групи завершився. Коментарі збережені й доступні для перегляду. Надсилання та зміни відновляться після оплати групи.'
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-3.5 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const iconButton = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40 motion-reduce:transition-none'
const textAreaClass = 'block w-full min-w-0 resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50 sm:text-sm motion-reduce:transition-none'

function commentTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric',
  }).format(date)
}

export function SeminarComments({ seminarId, groupId, currentUserId, canModerate, canParticipate, onLicenseRequired }: Props) {
  const scope = `${groupId}:${seminarId}:${currentUserId}`
  const [storedData, setData] = useState<SeminarCommentsData>(emptyComments)
  const [loadedScope, setLoadedScope] = useState('')
  const data = loadedScope === scope ? storedData : emptyComments
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [realtimeUnavailable, setRealtimeUnavailable] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const inputId = useId()
  const alive = useRef(true)
  const sequence = useRef(0)
  const pageCount = useRef(1)
  const mutatingScope = useRef<string | null>(null)
  const refreshPending = useRef(false)
  const latestScope = useRef(scope)
  latestScope.current = scope
  const latestData = useRef(data)
  latestData.current = data
  const latestCanModerate = useRef(canModerate)
  latestCanModerate.current = canModerate
  const latestCanParticipate = useRef(canParticipate)
  latestCanParticipate.current = canParticipate
  const latestOnLicenseRequired = useRef(onLicenseRequired)
  latestOnLicenseRequired.current = onLicenseRequired

  useEffect(() => {
    if (!canParticipate) { setEditingId(null); setDeleteId(null) }
    else setActionError((previous) => previous === licenseRequiredNotice ? '' : previous)
  }, [canParticipate])

  useEffect(() => {
    if (canModerate) return
    setDeleteId((previous) => previous && data.comments.some((comment) => comment.id === previous && comment.author_id === currentUserId) ? previous : null)
  }, [canModerate, currentUserId, data.comments])

  const reload = useCallback(async (foreground = false) => {
    const request = ++sequence.current
    const expectedScope = scope
    if (foreground) setLoading(true)
    try {
      const next = await loadSeminarComments(groupId, seminarId, currentUserId, pageCount.current)
      if (!alive.current || expectedScope !== latestScope.current || request !== sequence.current) return
      setData(next)
      setLoadedScope(expectedScope)
      setLoadError('')
      setEditingId((previous) => previous && next.comments.some((comment) => comment.id === previous) ? previous : null)
      setDeleteId((previous) => previous && next.comments.some((comment) => comment.id === previous) ? previous : null)
    } catch (error) {
      if (!alive.current || expectedScope !== latestScope.current || request !== sequence.current) return
      setData(emptyComments)
      setLoadError(seminarCommentError(error))
      setEditingId(null)
      setDeleteId(null)
      if (seminarCommentAccessLost(error)) { setDraft(''); setEditBody('') }
    } finally {
      if (alive.current && expectedScope === latestScope.current && request === sequence.current) setLoading(false)
    }
  }, [groupId, seminarId, currentUserId, scope])
  const latestReload = useRef(reload)
  latestReload.current = reload

  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1 } }, [])
  useEffect(() => {
    sequence.current += 1
    pageCount.current = 1
    refreshPending.current = false
    setData(emptyComments); setDraft(''); setEditingId(null); setEditBody(''); setDeleteId(null)
    setActionError(''); setLoadError(''); setBusy(''); setRealtimeUnavailable(false)
    void reload(true)
  }, [scope, reload])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expectedScope = scope
    const changed = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!alive.current || expectedScope !== latestScope.current) return
        if (mutatingScope.current === expectedScope) { refreshPending.current = true; return }
        void latestReload.current()
      }, 250)
    }
    const removedComment = (payload: { old: Record<string, unknown> }) => {
      if (!alive.current || expectedScope !== latestScope.current) return
      const id = typeof payload.old?.id === 'string' ? payload.old.id : ''
      if (!latestData.current.comments.some((comment) => comment.id === id)) return
      setData((previous) => ({ ...previous, comments: previous.comments.filter((comment) => comment.id !== id) }))
      changed()
    }
    const removedMembership = (payload: { old: Record<string, unknown> }) => {
      if (!alive.current || expectedScope !== latestScope.current) return
      if (payload.old?.id === latestData.current.membershipId) changed()
    }
    const removedSeminar = (payload: { old: Record<string, unknown> }) => {
      if (!alive.current || expectedScope !== latestScope.current) return
      if (payload.old?.id !== seminarId) return
      sequence.current += 1
      setData(emptyComments); setDraft(''); setEditBody(''); setEditingId(null); setDeleteId(null)
      setLoading(false)
      setLoadError('Це завдання вже видалене або недоступне.')
    }
    const channel = supabase.channel(`seminar-comments:${scope}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'study_group_seminar_comments', filter: `seminar_id=eq.${seminarId}` }, changed)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'study_group_seminar_comments', filter: `seminar_id=eq.${seminarId}` }, changed)
      // With RLS a DELETE carries only the primary key. Match known IDs locally.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_seminar_comments' }, removedComment)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'study_group_members', filter: `group_id=eq.${groupId}` }, changed)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_members' }, removedMembership)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'study_groups', filter: `id=eq.${groupId}` }, changed)
      // The database also touches the parent after comment changes. This
      // provides a permitted, filtered refresh when DELETE is not delivered.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'study_group_seminars', filter: `id=eq.${seminarId}` }, changed)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_seminars' }, removedSeminar)
      .subscribe((status) => {
        if (!alive.current || expectedScope !== latestScope.current) return
        if (status === 'SUBSCRIBED') { setRealtimeUnavailable(false); changed() }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setRealtimeUnavailable(true)
      })
    const refresh = () => { if (!document.hidden) changed() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    // Also recheck access when no Realtime event is available after membership
    // removal. Browsers in the background do not make periodic requests.
    const interval = setInterval(refresh, 60000)
    const auth = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive.current || expectedScope !== latestScope.current || session?.user.id === currentUserId) return
      sequence.current += 1
      setData(emptyComments); setDraft(''); setEditBody(''); setEditingId(null); setDeleteId(null)
      setLoading(false)
      setLoadError('Увійдіть знову, щоб працювати з коментарями.')
    })
    return () => {
      if (timer) clearTimeout(timer)
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      auth.data.subscription.unsubscribe()
      void supabase.removeChannel(channel).catch(() => undefined)
    }
  }, [groupId, seminarId, currentUserId, scope])

  const runMutation = async (name: string, action: () => Promise<unknown>, onSuccess: () => void) => {
    const expectedScope = scope
    if (!latestCanParticipate.current || mutatingScope.current === expectedScope || loading || loadError || loadedScope !== expectedScope) return
    if (name.startsWith('delete:') || name.startsWith('edit:')) {
      const comment = latestData.current.comments.find((item) => item.id === name.slice(name.indexOf(':') + 1))
      const own = comment?.author_id === currentUserId
      if (!comment || (!own && (name.startsWith('edit:') || !latestCanModerate.current))) {
        setDeleteId(null); setEditingId(null); setEditBody('')
        return
      }
    }
    mutatingScope.current = expectedScope
    setBusy(name); setActionError('')
    try {
      await action()
      if (!alive.current || expectedScope !== latestScope.current) return
      onSuccess()
      await latestReload.current()
    } catch (error) {
      if (!alive.current || expectedScope !== latestScope.current) return
      const message = (error as { message?: unknown } | null)?.message
      if (typeof message === 'string' && message.includes('GROUP_LICENSE_REQUIRED')) {
        // Losing paid access does not remove membership or access to the discussion.
        // Keep the loaded comments and draft; the parent refresh can restore writes.
        setActionError(licenseRequiredNotice)
        setEditingId(null); setDeleteId(null)
        latestOnLicenseRequired.current?.()
        return
      }
      setActionError(seminarCommentError(error))
      if (seminarCommentAccessLost(error)) {
        sequence.current += 1
        setData(emptyComments); setDraft(''); setEditBody(''); setEditingId(null); setDeleteId(null)
        setLoadError(seminarCommentError(error))
      }
    } finally {
      if (mutatingScope.current === expectedScope) mutatingScope.current = null
      if (alive.current && expectedScope === latestScope.current) {
        setBusy('')
        if (refreshPending.current) { refreshPending.current = false; void latestReload.current() }
      }
    }
  }

  const submitComment = (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim()) return
    void runMutation('add', () => addSeminarComment(seminarId, draft), () => setDraft(''))
  }
  const submitEdit = (event: FormEvent, comment: SeminarComment) => {
    event.preventDefault()
    if (!editBody.trim()) return
    void runMutation(`edit:${comment.id}`, () => updateSeminarComment(comment.id, editBody), () => { setEditingId(null); setEditBody('') })
  }
  const disabled = Boolean(busy) || loading || Boolean(loadError) || loadedScope !== scope
  const visibleDraft = loadedScope === scope ? draft : ''

  return (
    <section className="mt-5 min-w-0 border-t border-border pt-5" aria-label="Коментарі до завдання">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold"><MessageCircle size={17} className="shrink-0 text-primary" aria-hidden="true" />Коментарі{data.comments.length > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{data.comments.length}{data.hasMore ? '+' : ''}</span>}</h4>
        <button type="button" disabled={Boolean(busy) || loading} className={iconButton} aria-label="Оновити коментарі" title="Оновити коментарі" onClick={() => void reload(true)}><RefreshCw size={16} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} /></button>
      </header>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">Уточнюйте умови, домовляйтеся про роботу в парі або напишіть, яку країну чи тему обрали. Коментарі бачать учасники цієї групи.</p>

      {loadError ? <div role="alert" className="mb-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm"><p>{loadError}</p><button type="button" disabled={loading} className={`${secondaryButton} mt-3`} onClick={() => void reload(true)}>Спробувати ще раз</button></div> : loading && !data.comments.length ? <div role="status" className="mb-4 flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 size={17} className="animate-spin motion-reduce:animate-none" />Завантажуємо коментарі…</div> : !data.comments.length ? <p className="mb-4 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-5 text-center text-sm text-muted-foreground">Поки немає коментарів. Почніть обговорення цього завдання.</p> : (
        <div className="mb-4 space-y-3">
          {data.hasMore && <button type="button" className={`${secondaryButton} w-full`} disabled={disabled} onClick={() => { pageCount.current += 1; void reload(true) }}>Показати попередні коментарі</button>}
          <ol className="space-y-3" aria-label="Обговорення завдання">
            {data.comments.map((comment) => {
              const profile = data.profiles[comment.author_id]
              const name = profile?.full_name || profile?.username || 'Учасник групи'
              const initials = name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()
              const own = comment.author_id === currentUserId
              const edited = new Date(comment.updated_at).getTime() > new Date(comment.created_at).getTime()
              return (
                <li key={comment.id} className="min-w-0 rounded-xl border border-border bg-muted/20 p-3 sm:p-3.5">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Link to="/user/$id" params={{ id: comment.author_id }} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30" aria-label={`Переглянути профіль: ${name}`}>
                      {profile?.avatar_url ? <img src={profile.avatar_url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials}</span>}
                      <span className="min-w-0"><span className="block truncate text-sm font-medium">{name}{own && <span className="ml-1 text-xs text-primary">· Ви</span>}</span>{profile?.username && <span className="block truncate text-xs text-muted-foreground">@{profile.username.replace(/^@/, '')}</span>}</span>
                    </Link>
                    <div className="flex shrink-0 items-center">
                      {canParticipate && own && <button type="button" className={iconButton} disabled={disabled} aria-label="Редагувати свій коментар" title="Редагувати" onClick={() => { setActionError(''); setDeleteId(null); setEditingId(comment.id); setEditBody(comment.body) }}><Pencil size={15} /></button>}
                      {canParticipate && (own || canModerate) && <button type="button" className={iconButton} disabled={disabled} aria-label={`Видалити коментар: ${name}`} title="Видалити" onClick={() => { setActionError(''); setEditingId(null); setDeleteId(comment.id) }}><Trash2 size={15} /></button>}
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground"><time dateTime={comment.created_at}>{commentTime(comment.created_at)}</time>{edited && <span title={commentTime(comment.updated_at)}> · відредаговано</span>}</p>
                  {canParticipate && editingId === comment.id ? (
                    <form className="mt-3 space-y-2" onSubmit={(event) => submitEdit(event, comment)}>
                      <label htmlFor={`${inputId}-edit-${comment.id}`} className="sr-only">Текст коментаря</label>
                      <textarea id={`${inputId}-edit-${comment.id}`} className={textAreaClass} rows={3} maxLength={SEMINAR_COMMENT_MAX_LENGTH} value={editBody} disabled={disabled} autoFocus onChange={(event) => setEditBody(event.target.value)} />
                      <div className="flex flex-wrap items-center gap-2"><button type="submit" className={primaryButton} disabled={disabled || !editBody.trim()}>{busy === `edit:${comment.id}` ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Check size={15} />}Зберегти</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => { setEditingId(null); setEditBody(''); setActionError('') }}><X size={15} />Скасувати</button><span className="ml-auto text-xs text-muted-foreground">{editBody.length}/{SEMINAR_COMMENT_MAX_LENGTH}</span></div>
                    </form>
                  ) : <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{comment.body}</p>}
                  {canParticipate && deleteId === comment.id && (own || canModerate) && <div className="mt-3 rounded-lg border border-primary/20 bg-background p-3" role="group" aria-label="Підтвердження видалення коментаря"><p className="mb-2 text-sm">Видалити цей коментар?</p><div className="flex flex-wrap gap-2"><button type="button" className={primaryButton} disabled={disabled} onClick={() => void runMutation(`delete:${comment.id}`, () => deleteSeminarComment(comment.id), () => setDeleteId(null))}>{busy === `delete:${comment.id}` ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Trash2 size={15} />}Видалити</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => setDeleteId(null)}>Залишити</button></div></div>}
                </li>
              )
            })}
          </ol>
        </div>
      )}
      {actionError && <p role="alert" className="mb-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">{actionError}</p>}
      {realtimeUnavailable && !loadError && <p className="mb-3 text-xs text-muted-foreground">Миттєве оновлення тимчасово недоступне. Обговорення періодично оновлюється; також можна натиснути кнопку оновлення.</p>}
      {canParticipate ? <form className="space-y-2" onSubmit={submitComment}>
        <label htmlFor={inputId} className="block text-sm font-medium">Ваш коментар</label>
        <textarea id={inputId} rows={3} maxLength={SEMINAR_COMMENT_MAX_LENGTH} value={visibleDraft} onChange={(event) => setDraft(event.target.value)} className={textAreaClass} disabled={disabled} placeholder="Наприклад: «Обрали Канаду» або «Ми з Марією готуємо питання разом»" aria-describedby={`${inputId}-hint`} />
        <div className="flex flex-wrap items-center justify-between gap-2"><p id={`${inputId}-hint`} className="text-xs text-muted-foreground">{visibleDraft.length}/{SEMINAR_COMMENT_MAX_LENGTH}</p><button type="submit" className={primaryButton} disabled={disabled || !visibleDraft.trim()}>{busy === 'add' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Send size={16} />}Надіслати</button></div>
      </form> : <p className="text-xs text-muted-foreground">Коментарі доступні для перегляду. Надсилання й редагування відновляться після підтвердження доступу групи.</p>}
    </section>
  )
}
