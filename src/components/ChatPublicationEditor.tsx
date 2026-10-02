import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Bold, Heading2, ImagePlus, Italic, Link as LinkIcon, Loader2, Plus, Quote, Trash2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { discardArticleCover, editChatArticle, publicationError, publishChatContent, uploadArticleCover, type ChatArticle, type PublicationKind, type PublicationTarget } from '../lib/chatPublications'
import { fromDateTimeInput } from '../lib/organizerDates'
import { ChatArticleText } from './ChatArticleText'
import { useArticleCover } from './ChatPublicationCard'
import { ChatDialog, chatButton, chatIcon, chatInput, chatPrimary } from './CommunityChatPrimitives'

interface ChatPublicationEditorProps {
  kind: PublicationKind
  userId: string
  target: PublicationTarget
  article?: ChatArticle
  onClose: () => void
  onSaved: () => Promise<void>
}

const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const COVER_MAX = 5 * 1024 * 1024

export function ChatPublicationEditor({ kind, userId, target, article, onClose, onSaved }: ChatPublicationEditorProps) {
  const { authUser } = useAuth()
  const { isPremium, isLoading: billingLoading, error: billingError } = useBilling()
  const formId = useId()
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [anonymous, setAnonymous] = useState(true)
  const [multiple, setMultiple] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [title, setTitle] = useState(article?.title || '')
  const [body, setBody] = useState(article?.body || '')
  const [coverPath, setCoverPath] = useState<string | null>(article?.cover_path || null)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [localCover, setLocalCover] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const selection = useRef({ start: 0, end: 0 })
  const composing = useRef(false)
  const processing = useRef(false)
  const alive = useRef(true)
  const scope = `${userId}:${kind}:${article?.id || ''}:${target.spaceId || ''}:${target.conversationId || ''}:${target.parentPostId || ''}:${target.replyTo || ''}`
  const latestScope = useRef(scope); latestScope.current = scope
  const access = useRef({ userId: authUser?.id, isPremium, billingLoading })
  access.current = { userId: authUser?.id, isPremium, billingLoading }
  const currentCover = useArticleCover(coverPath)
  const coverUrl = localCover || currentCover
  const editing = kind === 'article' && Boolean(article)
  const allowed = authUser?.id === userId && isPremium && !billingLoading && (!editing || article?.can_edit === true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    setQuestion(''); setOptions(['', '']); setAnonymous(true); setMultiple(false); setDeadline('')
    setTitle(article?.title || ''); setBody(article?.body || ''); setCoverPath(article?.cover_path || null)
    setCoverFile(null); setPreview(false); setSaved(false); setError(''); setBusy(false)
    selection.current = { start: 0, end: 0 }
    if (inputRef.current) inputRef.current.value = ''
  }, [scope])
  useEffect(() => {
    if (!coverFile) { setLocalCover(''); return }
    const url = URL.createObjectURL(coverFile)
    setLocalCover(url)
    return () => URL.revokeObjectURL(url)
  }, [coverFile])

  const rememberSelection = () => {
    const field = bodyRef.current
    if (field) selection.current = { start: field.selectionStart, end: field.selectionEnd }
  }
  const format = (before: string, after: string, fallback: string, line = false) => {
    if (busy || !allowed || composing.current) return
    const { start, end } = selection.current
    const chosen = body.slice(start, end) || fallback
    const prefix = line && start > 0 && body[start - 1] !== '\n' ? `\n${before}` : before
    const inserted = `${prefix}${chosen}${after}`
    const next = body.slice(0, start) + inserted + body.slice(end)
    if (next.length > 50_000) { setError('Текст статті може містити до 50 000 символів.'); return }
    setBody(next); setError('')
    const nextSelection = { start: start + prefix.length, end: start + prefix.length + chosen.length }
    selection.current = nextSelection
    requestAnimationFrame(() => {
      const field = bodyRef.current
      if (!alive.current || !field) return
      field.focus(); field.setSelectionRange(nextSelection.start, nextSelection.end)
    })
  }
  const chooseCover = (file?: File) => {
    if (!file) return
    if (!COVER_TYPES.includes(file.type) || file.size > COVER_MAX || file.size === 0) {
      setError('Оберіть JPEG, PNG, WebP або GIF розміром до 5 МБ.')
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setCoverFile(file); setError('')
  }
  const close = () => { if (!processing.current) onClose() }
  const finish = async () => {
    await onSaved()
    if (alive.current && latestScope.current === scope) onClose()
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (processing.current) return
    if (saved) {
      processing.current = true; setBusy(true); setError('')
      try { await finish() } catch { if (alive.current) setError('Публікацію збережено, але список не оновився. Спробуйте оновити його ще раз.') }
      finally { processing.current = false; if (alive.current) setBusy(false) }
      return
    }
    if (!allowed) { setError('Для публікації потрібна активна підписка й право писати в цій переписці.'); return }
    if (Boolean(target.spaceId) === Boolean(target.conversationId)) { setError('Відкрийте потрібну переписку й спробуйте ще раз.'); return }
    const valid = () => alive.current && latestScope.current === scope && access.current.userId === userId && access.current.isPremium && !access.current.billingLoading
    let closesAt: string | null = null
    if (kind === 'poll') {
      const cleanOptions = options.map((option) => option.trim())
      if (!question.trim() || question.trim().length > 500 || cleanOptions.length < 2 || cleanOptions.length > 10 || cleanOptions.some((option) => !option || option.length > 200)) {
        setError('Додайте питання до 500 символів і від 2 до 10 непорожніх варіантів, до 200 символів кожен.'); return
      }
      if (new Set(cleanOptions.map((option) => option.toLocaleLowerCase('uk-UA'))).size !== cleanOptions.length) { setError('Варіанти відповіді мають відрізнятися.'); return }
      if (deadline) {
        const date = fromDateTimeInput(deadline)
        if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError('Оберіть майбутні дату й час завершення за київським часом.'); return }
        closesAt = date.toISOString()
      }
    } else if (!title.trim() || title.trim().length > 200 || !body.trim() || body.length > 50_000) {
      setError('Додайте заголовок до 200 символів і текст до 50 000 символів.'); return
    }
    processing.current = true; setBusy(true); setError('')
    let uploadedPath: string | null = null
    let committed = false
    try {
      if (kind === 'article' && coverFile) uploadedPath = await uploadArticleCover(userId, coverFile)
      if (!valid()) {
        if (alive.current && latestScope.current === scope) setError('Доступ змінився. Перевірте підписку й увійдіть до потрібного акаунта.')
        return
      }
      if (kind === 'poll') {
        await publishChatContent('poll', { question: question.trim(), options: options.map((option) => option.trim()), anonymous, allows_multiple: multiple, closes_at: closesAt }, target)
      } else {
        const content = { title: title.trim(), body: body.trim(), cover_path: uploadedPath || coverPath }
        if (article) await editChatArticle(article.id, content)
        else await publishChatContent('article', content, target)
      }
      committed = true
      if (!alive.current || latestScope.current !== scope) return
      setSaved(true)
      try { await finish() } catch { if (alive.current && latestScope.current === scope) setError('Публікацію збережено, але список не оновився. Натисніть «Оновити список».') }
    } catch (failure) {
      if (alive.current && latestScope.current === scope) setError(publicationError(failure))
    } finally {
      if (uploadedPath && !committed) { try { await discardArticleCover(uploadedPath) } catch { /* The content was not published; the storage cleanup can be retried separately. */ } }
      processing.current = false
      if (alive.current && latestScope.current === scope) setBusy(false)
    }
  }

  return <ChatDialog title={editing ? 'Редагувати статтю' : kind === 'poll' ? 'Нове опитування' : 'Нова стаття'} busy={busy} onClose={close} wide={kind === 'article'}>
    {billingLoading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={17} className="animate-spin" />Перевіряємо підписку…</p> : !allowed ? <div className="space-y-4">
      <p className="text-sm leading-relaxed">{editing && article?.can_edit !== true ? 'Цю статтю зараз не можна редагувати. Перевірте авторство й доступ до переписки.' : 'Створення опитувань і створення та редагування статей доступне з активною підпискою «Учасник». Потрібне також право писати в цій переписці.'}</p>
      {billingError && <p role="alert" className="text-sm text-destructive">{billingError}</p>}
      {!isPremium && <Link to="/subscription" className={chatPrimary} onClick={close}>Переглянути підписку</Link>}
      <p className="text-xs text-muted-foreground">Читання, голосування та завершення свого опитування залишаються безкоштовними.</p>
    </div> : <form onSubmit={(event) => void save(event)} className="space-y-5">
      {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="rounded-xl bg-primary/10 p-3 text-sm">Публікацію збережено. Повторне створення не потрібне.</p>}
      <fieldset disabled={busy || saved} className="min-w-0 space-y-5 disabled:opacity-70">
        {kind === 'poll' ? <>
          <label className="block space-y-1.5" htmlFor={`${formId}-question`}><span className="text-sm font-medium">Питання</span><textarea id={`${formId}-question`} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={500} required rows={3} className={`${chatInput} resize-y`} placeholder="Що хочете запитати?" /><span className="block text-right text-xs text-muted-foreground">{question.length}/500</span></label>
          <div className="space-y-2"><p className="text-sm font-medium">Варіанти відповіді</p>{options.map((option, index) => <div key={index} className="flex items-center gap-2"><input aria-label={`Варіант ${index + 1}`} value={option} onChange={(event) => setOptions((current) => current.map((value, item) => item === index ? event.target.value : value))} maxLength={200} required className={chatInput} placeholder={`Варіант ${index + 1}`} /><button type="button" className={chatIcon} aria-label={`Видалити варіант ${index + 1}`} disabled={options.length <= 2} onClick={() => setOptions((current) => current.filter((_, item) => item !== index))}><Trash2 size={17} /></button></div>)}<button type="button" className={chatButton} disabled={options.length >= 10} onClick={() => setOptions((current) => [...current, ''])}><Plus size={16} />Додати варіант</button><p className="text-xs text-muted-foreground">2–10 варіантів, до 200 символів кожен. Питання й варіанти після публікації не змінюються.</p></div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={multiple} onChange={(event) => setMultiple(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" /><span>Можна обрати кілька відповідей</span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" /><span>Анонімне голосування<span className="mt-1 block text-xs text-muted-foreground">{anonymous ? 'Імена тих, хто голосує, приховані.' : 'Учасники переписки бачитимуть профілі тих, хто голосує.'}</span></span></label>
          <label className="block space-y-1.5" htmlFor={`${formId}-deadline`}><span className="text-sm font-medium">Завершення за київським часом — необов’язково</span><input id={`${formId}-deadline`} type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} className={chatInput} /><span className="block text-xs text-muted-foreground">Без дати опитування триває, доки автор або адміністратор його не завершить.</span></label>
        </> : <>
          <label className="block space-y-1.5" htmlFor={`${formId}-title`}><span className="text-sm font-medium">Заголовок</span><input id={`${formId}-title`} value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} className={chatInput} placeholder="Назва статті" /><span className="block text-right text-xs text-muted-foreground">{title.length}/200</span></label>
          <div className="space-y-3"><p className="text-sm font-medium">Обкладинка — необов’язково</p>{coverUrl && <img src={coverUrl} alt="Попередній перегляд обкладинки" className="max-h-64 w-full rounded-xl object-contain" />}<div className="flex flex-wrap gap-2"><label className={`${chatButton} cursor-pointer focus-within:outline-none focus-within:ring-2 focus-within:ring-primary/50`}><ImagePlus size={17} />{coverUrl ? 'Замінити фото' : 'Додати фото'}<input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={(event) => chooseCover(event.target.files?.[0])} /></label>{(coverFile || coverPath) && <button type="button" className={chatButton} onClick={() => { setCoverFile(null); setCoverPath(null); if (inputRef.current) inputRef.current.value = '' }}><Trash2 size={16} />Прибрати</button>}</div><p className="text-xs text-muted-foreground">JPEG, PNG, WebP або GIF до 5 МБ. Фото доступне читачам цієї переписки.</p></div>
          <div className="space-y-2"><label htmlFor={`${formId}-body`} className="text-sm font-medium">Текст</label><div role="toolbar" aria-label="Форматування тексту" className="flex flex-wrap gap-1 rounded-xl border border-border p-1">{[
            { label: 'Жирний текст', Icon: Bold, before: '**', after: '**', fallback: 'текст' },
            { label: 'Курсив', Icon: Italic, before: '*', after: '*', fallback: 'текст' },
            { label: 'Заголовок', Icon: Heading2, before: '## ', after: '\n', fallback: 'Заголовок', line: true },
            { label: 'Цитата', Icon: Quote, before: '> ', after: '\n', fallback: 'Цитата', line: true },
            { label: 'Посилання', Icon: LinkIcon, before: '[', after: '](https://)', fallback: 'назва посилання' },
          ].map(({ label, Icon, before, after, fallback, line }) => <button key={label} type="button" className={chatIcon} title={label} aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={() => format(before, after, fallback, line)}><Icon size={17} /></button>)}<button type="button" className={`${chatButton} ml-auto min-h-9 py-1`} aria-pressed={preview} onClick={() => setPreview((value) => !value)}>Перегляд</button></div><textarea ref={bodyRef} id={`${formId}-body`} value={body} onChange={(event) => { setBody(event.target.value); rememberSelection() }} onSelect={rememberSelection} onKeyUp={rememberSelection} onClick={rememberSelection} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; rememberSelection() }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current || !((event.ctrlKey || event.metaKey) && !event.altKey)) return
            if (event.key.toLowerCase() === 'b') { event.preventDefault(); rememberSelection(); format('**', '**', 'текст') }
            if (event.key.toLowerCase() === 'i') { event.preventDefault(); rememberSelection(); format('*', '*', 'текст') }
          }} maxLength={50_000} required rows={10} className={`${chatInput} min-h-56 resize-y leading-7`} placeholder="Напишіть статтю…" /><p className="text-right text-xs text-muted-foreground">{body.length.toLocaleString('uk-UA')}/50 000</p><p className="text-xs text-muted-foreground">Виділяйте текст і застосовуйте форматування. Адресу після кнопки посилання замініть на повну адресу сайту. HTML не виконується.</p></div>
          {preview && <section className="space-y-4 rounded-xl border border-border p-4" aria-label="Попередній перегляд статті"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Попередній перегляд</p>{coverUrl && <img src={coverUrl} alt="" className="max-h-64 w-full rounded-lg object-contain" />}<h3 className="break-words text-xl font-semibold">{title || 'Заголовок статті'}</h3>{body.trim() ? <ChatArticleText body={body} /> : <p className="text-sm text-muted-foreground">Текст статті з’явиться тут.</p>}</section>}
        </>}
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><button type="button" className={chatButton} disabled={busy} onClick={close}>Скасувати</button><button type="submit" className={chatPrimary} disabled={busy}>{busy && <Loader2 size={17} className="animate-spin" />}{saved ? 'Оновити список' : editing ? 'Зберегти зміни' : 'Опублікувати'}</button></div>
    </form>}
  </ChatDialog>
}
