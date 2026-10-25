import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, FileText, Loader2, Sparkles, TriangleAlert, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { homeworkAiBody, homeworkAiTodayInKyiv, normalizeHomeworkAiDraft, normalizeHomeworkAiInput, suggestHomeworkAiDate, type HomeworkAiDraftResult, type HomeworkAiInput } from '../lib/homeworkAiDraft'
import { homeworkAiDraftAvailability, requestHomeworkAiDraft } from '../lib/homeworkAiDraftClient'
import { isTimetableDate, LESSON_TYPES, scheduleOccursOnDate, type TimetableLesson } from '../lib/studyGroupTimetable'

export type HomeworkAiTarget = { lesson: TimetableLesson; date: string }
export type HomeworkAiCarry = { input: HomeworkAiInput; draft: HomeworkAiDraftResult; itemIndex: number }
export type HomeworkAiApply = HomeworkAiCarry & { target: HomeworkAiTarget; expected: { editorKey: string; baseDraftVersion: string; groupId: string; currentUserId: string } }
export type HomeworkAiService = {
  availability: typeof homeworkAiDraftAvailability
  request: typeof requestHomeworkAiDraft
}
type Props = {
  mode: 'bulk' | 'inline'
  groupId: string
  currentUserId: string
  editorKey: string
  baseDraftVersion: string
  canEdit: boolean
  disabled: boolean
  schedule: TimetableLesson[]
  selectedDate: string
  target?: HomeworkAiTarget
  initialExtraction?: HomeworkAiCarry | null
  hasExistingContent?: boolean
  onApply: (value: HomeworkAiApply) => boolean | Promise<boolean>
  service?: HomeworkAiService
  initialSource?: string
  initialReferenceDate?: string
}
const DEFAULT_SERVICE: HomeworkAiService = { availability: homeworkAiDraftAvailability, request: requestHomeworkAiDraft }
const field = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50 sm:text-sm'
const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-3.5 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'
const failure = (error: unknown) => error instanceof Error ? error.message : 'Не вдалося підготувати чернетку. Спробуйте ще раз.'
const subjectKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const dateLabel = (value: string) => isTimetableDate(value) ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)) : 'Оберіть дату'

export function HomeworkAiDraft(props: Props) {
  const { mode, groupId, currentUserId, editorKey, baseDraftVersion, canEdit, disabled, schedule, selectedDate, target, initialExtraction, hasExistingContent, onApply, service, initialSource, initialReferenceDate } = props
  const api = service || DEFAULT_SERVICE
  const id = useId()
  const [open, setOpen] = useState(Boolean(initialExtraction))
  const [source, setSource] = useState(initialExtraction?.input.source_text || initialSource || '')
  const [referenceDate, setReferenceDate] = useState(initialExtraction?.input.reference_date || initialReferenceDate || homeworkAiTodayInKyiv())
  const [result, setResult] = useState<HomeworkAiDraftResult | null>(initialExtraction?.draft || null)
  const [usedInput, setUsedInput] = useState<HomeworkAiInput | null>(initialExtraction?.input || null)
  const [itemIndex, setItemIndex] = useState(initialExtraction?.itemIndex || 0)
  const [targets, setTargets] = useState<Record<number, { date: string; lessonId: string }>>({})
  const [available, setAvailable] = useState<{ available: boolean; reason?: string } | null>(null)
  const [checking, setChecking] = useState(false), [busy, setBusy] = useState(false), [applying, setApplying] = useState(false)
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [retry, setRetry] = useState(0)
  const generation = useRef(0), request = useRef<AbortController | null>(null), alive = useRef(true), authValid = useRef(true)
  const context = useRef({ editorKey, baseDraftVersion, groupId, currentUserId, canEdit, disabled })
  context.current = { editorKey, baseDraftVersion, groupId, currentUserId, canEdit, disabled }
  const expected = useRef<{ editorKey: string; baseDraftVersion: string; groupId: string; currentUserId: string } | null>(initialExtraction ? { editorKey, baseDraftVersion, groupId, currentUserId } : null)
  const seenVersion = useRef(baseDraftVersion), applyLocked = useRef(false)
  function invalidate() { ++generation.current; request.current?.abort(); request.current = null; expected.current = null; setBusy(false); setResult(null); setUsedInput(null); setConfirmed(false) }
  function change(action: () => void) { invalidate(); setError(''); setMessage(''); action() }
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current; request.current?.abort() } }, [])
  useEffect(() => {
    authValid.current = true
    if (service) return
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (session && session.user.id !== currentUserId)) {
        authValid.current = false; ++generation.current; request.current?.abort(); expected.current = null
        if (alive.current) { setResult(null); setUsedInput(null); setBusy(false); setConfirmed(false); setError('Акаунт змінився. Відкрийте помічника знову.') }
      }
    })
    return () => subscription.unsubscribe()
  }, [currentUserId, service])
  useEffect(() => {
    invalidate(); setError(''); setMessage(''); setTargets({}); setOpen(Boolean(initialExtraction)); seenVersion.current = baseDraftVersion
    if (initialExtraction) {
      try {
        const input = normalizeHomeworkAiInput(initialExtraction.input)
        const draft = normalizeHomeworkAiDraft(initialExtraction.draft, input)
        setSource(input.source_text); setReferenceDate(input.reference_date); setResult(draft); setUsedInput(input); setItemIndex(initialExtraction.itemIndex)
        expected.current = { editorKey, baseDraftVersion, groupId, currentUserId }
      } catch { setError('Чернетка більше недоступна. Підготуйте її ще раз.') }
    } else { setSource(initialSource || ''); setReferenceDate(initialReferenceDate || homeworkAiTodayInKyiv()); setItemIndex(0) }
  }, [editorKey, groupId, currentUserId, initialExtraction])
  useEffect(() => { if (seenVersion.current !== baseDraftVersion) { seenVersion.current = baseDraftVersion; invalidate() } }, [baseDraftVersion])
  useEffect(() => { if (!canEdit) invalidate(); else if (disabled) { ++generation.current; request.current?.abort(); setBusy(false) } }, [canEdit, disabled])
  useEffect(() => {
    if (!open || !canEdit || disabled) return
    const controller = new AbortController(); setChecking(true); setAvailable(null)
    void api.availability(groupId, currentUserId, controller.signal).then(value => { if (alive.current && !controller.signal.aborted) setAvailable(value) }).catch(e => { if (alive.current && !controller.signal.aborted) setAvailable({ available: false, reason: failure(e) }) }).finally(() => { if (alive.current && !controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [open, canEdit, disabled, groupId, currentUserId, api, retry])

  async function generate() {
    if (busy || request.current || applying || disabled || !canEdit || !available?.available || !authValid.current) return
    let input: HomeworkAiInput
    try { input = normalizeHomeworkAiInput({ source_text: source, reference_date: referenceDate }) } catch(e) { setError(failure(e)); return }
    invalidate(); const controller = new AbortController(); request.current = controller; const sequence = ++generation.current
    const started = { editorKey, baseDraftVersion, groupId, currentUserId }; setBusy(true); setError(''); setMessage('')
    try {
      const draft = normalizeHomeworkAiDraft(await api.request(groupId, currentUserId, input, controller.signal), input)
      const current = context.current
      if (!alive.current || controller.signal.aborted || generation.current !== sequence || !authValid.current || !current.canEdit || current.disabled || Object.entries(started).some(([key,value]) => current[key as keyof typeof started] !== value)) return
      const suggestions: typeof targets = {}
      draft.items.forEach((item,index) => {
        const dateSuggestion = suggestHomeworkAiDate(item.date_text, input.reference_date)
        const date = dateSuggestion || selectedDate
        const matches = dateSuggestion ? schedule.filter(lesson => lesson.group_id === groupId && scheduleOccursOnDate(lesson, date) && subjectKey(lesson.subject) === subjectKey(item.subject) && (!item.lesson_type || lesson.lesson_type === item.lesson_type)) : []
        suggestions[index] = { date, lessonId: matches.length === 1 ? matches[0].id : '' }
      })
      expected.current = started; setResult(draft); setUsedInput(input); setTargets(suggestions); setItemIndex(0); setConfirmed(false)
    } catch(e) { if (alive.current && !controller.signal.aborted && generation.current === sequence) setError(failure(e)) }
    finally { if (request.current === controller) request.current = null; if (alive.current && generation.current === sequence) setBusy(false) }
  }
  const chosen = result?.items[itemIndex]
  const suggestedDate = chosen && usedInput ? suggestHomeworkAiDate(chosen.date_text, usedInput.reference_date) : null
  const mismatch = Boolean(mode === 'inline' && chosen && target && ((chosen.subject && subjectKey(chosen.subject) !== subjectKey(target.lesson.subject)) || (suggestedDate && suggestedDate !== target.date) || (chosen.lesson_type && chosen.lesson_type !== target.lesson.lesson_type)))
  const uncertain = Boolean(mode === 'inline' && chosen && (!chosen.subject || (chosen.date_text && !suggestedDate)))
  const needsConfirmation = mode === 'inline' && Boolean(hasExistingContent || mismatch || uncertain)
  async function apply(index: number) {
    if (!result || !usedInput || disabled || busy || applying || applyLocked.current || !canEdit || !authValid.current) return
    const started = expected.current, current = context.current
    if (!started || Object.entries(started).some(([key,value]) => current[key as keyof typeof started] !== value) || !current.canEdit || current.disabled) { invalidate(); setError('Форма або доступ змінилися. Підготуйте чернетку знову.'); return }
    const selection = targets[index]
    const actualTarget = mode === 'inline' ? target : selection ? { lesson: schedule.find(lesson => lesson.id === selection.lessonId && lesson.group_id === groupId)!, date: selection.date } : undefined
    if (!actualTarget?.lesson || !isTimetableDate(actualTarget.date) || !scheduleOccursOnDate(actualTarget.lesson, actualTarget.date)) { setError('Оберіть дату й наявну пару вашої групи.'); return }
    if (mode === 'inline' && needsConfirmation && !confirmed) return
    applyLocked.current = true; setApplying(true); setError(''); setMessage('')
    try {
      const applied = await onApply({ input: usedInput, draft: result, itemIndex: index, target: actualTarget, expected: started })
      if (alive.current && applied) {
        setMessage(mode === 'bulk' ? 'Чернетку відкрито у формі ДЗ. Перевірте її та натисніть «Зберегти». Решта чернеток залишаються тут.' : 'Тему, опис і посилання підставлено. Перевірте форму та натисніть «Зберегти».')
        if (mode === 'inline') { invalidate(); setOpen(false) }
      }
    } catch(e) { if (alive.current) setError(failure(e)) }
    finally { applyLocked.current = false; if (alive.current) setApplying(false) }
  }
  if (!canEdit) return null
  return <section className="min-w-0 rounded-2xl border border-primary/20 bg-primary/5 p-3.5 sm:p-4" aria-label={mode === 'bulk' ? 'ДЗ із повідомлення викладача' : 'Заповнення ДЗ із ШІ'} onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault() }}>
    <button type="button" disabled={disabled || applying} className="flex min-h-10 w-full items-center gap-2 text-left text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30" aria-expanded={open} aria-controls={`${id}-content`} onClick={() => { if (open) { invalidate(); setOpen(false) } else setOpen(true) }}><Sparkles size={17} aria-hidden="true" /><span className="flex-1">{mode === 'bulk' ? 'ДЗ із повідомлення' : 'Заповнити з ШІ'}</span><ChevronDown size={16} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" /></button>
    {message && <p role="status" className="mt-2 text-sm leading-relaxed text-primary">{message}</p>}
    {open && <div id={`${id}-content`} className="mt-3 space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{mode === 'bulk' ? 'Вставте повідомлення викладача. Помічник розділить його на завдання, а ви перевірите предмети й дати та відкриєте кожне ДЗ у формі.' : 'Вставте повідомлення викладача — помічник підготує тему, повний текст завдання й посилання.'}</p>
      {mode === 'inline' && target && <p className="rounded-xl border border-border bg-background p-3 text-sm"><span className="font-semibold">Заповнюємо цю пару:</span> {target.lesson.subject} · {dateLabel(target.date)} · {target.lesson.starts_at.slice(0,5)}. Предмет і дата форми залишаться обраними вами.</p>}
      <label className="block space-y-1.5"><span className="text-sm font-medium">Повідомлення викладача</span><textarea rows={6} maxLength={12000} disabled={disabled || applying} className={field} value={source} onChange={event => change(() => setSource(event.target.value))} placeholder="Наприклад: на вівторок із вищої математики підготувати задачі 1–5…" /><span className="block text-right text-xs text-muted-foreground">{source.length}/12000</span></label>
      <label className="block space-y-1.5"><span className="text-sm font-medium">Дата вихідного повідомлення</span><input type="date" value={referenceDate} disabled={disabled || applying} onChange={event => change(() => setReferenceDate(event.target.value))} className={field} /><span className="block text-xs leading-relaxed text-muted-foreground">Слова «завтра» та назви днів рахуємо від цієї дати за київським календарем. Для старого повідомлення змініть дату.</span></label>
      <p className="text-xs leading-relaxed text-muted-foreground">{service ? 'Локальний приклад: використовується готова тестова відповідь. Текст нікуди не надсилається, ліміти не витрачаються.' : 'Після натискання «Підготувати чернетку» вставлений текст і дата повідомлення будуть надіслані до OpenAI. До 3 спроб на день для акаунта, спільно із семінарами; до 10 для групи. Помилка або скасування теж можуть витратити спробу.'}</p>
      {checking ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" />Перевіряємо доступність…</p> : available && !available.available && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{available.reason || 'Помічник тимчасово недоступний. Заповніть ДЗ вручну.'}</p><button type="button" className={button} disabled={disabled} onClick={() => setRetry(value => value + 1)}>Перевірити ще раз</button></div>}
      {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`} disabled={disabled || applying || busy || checking || !available?.available || !source.trim()} onClick={() => void generate()}>{busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Sparkles size={16} />}{busy ? 'Готуємо чернетку…' : result ? 'Підготувати ще раз' : 'Підготувати чернетку'}</button>{busy && <button type="button" onClick={() => { invalidate(); setMessage('Підготовку скасовано. Нічого не підставлено.') }} className={button}><X size={15} />Скасувати</button>}</div>
      {result && usedInput && <div className="space-y-3 rounded-xl border border-border bg-background p-3 sm:p-4" aria-label="Попередній перегляд ДЗ"><div className="flex items-center gap-2"><FileText size={17} className="text-primary" /><h3 className="font-semibold">Чернеток: {result.items.length}</h3></div><p className="text-xs leading-relaxed text-muted-foreground">Нічого ще не збережено. Звірте всі умови й посилання з оригіналом. Вставлене повідомлення не надає завданню позначку підтвердженого авторства викладача.</p>
        {result.warnings.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{result.warnings.map((item,index) => <li key={index}>{item}</li>)}</ul>}
        {mode === 'inline' && result.items.length > 1 && <label className="block space-y-1.5"><span className="text-sm font-medium">Яке завдання підставити в цю пару?</span><select value={itemIndex} className={field} onChange={event => { setItemIndex(Number(event.target.value)); setConfirmed(false) }}>{result.items.map((item,index) => <option key={index} value={index}>{index + 1}. {[item.subject, item.lesson_topic, item.date_text].filter(Boolean).join(' · ') || 'Завдання'}</option>)}</select></label>}
        {(mode === 'inline' ? result.items.map((item,index) => ({item,index})).filter(entry => entry.index === itemIndex) : result.items.map((item,index) => ({item,index}))).map(({item,index}) => {
          const choice = targets[index] || { date: suggestHomeworkAiDate(item.date_text, usedInput.reference_date) || selectedDate, lessonId: '' }
          const choices = schedule.filter(lesson => lesson.group_id === groupId && scheduleOccursOnDate(lesson, choice.date)).sort((a,b) => a.starts_at.localeCompare(b.starts_at))
          const hintDate = suggestHomeworkAiDate(item.date_text, usedInput.reference_date)
          return <article key={index} className="space-y-3 rounded-xl border border-border p-3"><div><p className="text-xs font-medium text-primary">Завдання {index + 1}{item.subject ? ` · ${item.subject}` : ''}</p><h4 className="mt-1 font-semibold">{item.lesson_topic || 'Домашнє завдання'}</h4>{item.date_text && <p className="mt-1 text-xs text-muted-foreground">У повідомленні: {item.date_text}{hintDate ? ` → ${dateLabel(hintDate)}` : ' · дату потрібно уточнити'}</p>}</div><p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{homeworkAiBody(result,item)}</p>
            {item.links.length > 0 && <ul className="space-y-1 text-xs text-primary">{item.links.map(link => <li key={link.url} className="break-all">{link.title ? `${link.title}: ` : ''}{link.url}</li>)}</ul>}
            {mode === 'bulk' ? <><div className="grid gap-3 sm:grid-cols-2"><label className="block space-y-1.5"><span className="text-sm font-medium">Дата пари</span><input type="date" value={choice.date} className={field} disabled={applying} onChange={event => setTargets(previous => ({...previous,[index]: {date:event.target.value,lessonId:''}}))} /></label><label className="block space-y-1.5"><span className="text-sm font-medium">Пара вашої групи</span><select className={field} disabled={applying || !choices.length} value={choice.lessonId} onChange={event => setTargets(previous => ({...previous,[index]: {...choice,lessonId:event.target.value}}))}><option value="">Оберіть пару</option>{choices.map(lesson => <option value={lesson.id} key={lesson.id}>{lesson.starts_at.slice(0,5)} · {lesson.subject} · {LESSON_TYPES[lesson.lesson_type]}</option>)}</select></label></div>{!choices.length && <p className="text-xs text-muted-foreground">На цю дату в розкладі немає пар. Оберіть іншу дату або спочатку додайте заняття до розкладу.</p>}{!hintDate && <p className="text-xs text-muted-foreground">Дата не визначена однозначно. Зараз показано обраний день розкладу — перевірте його.</p>}<button type="button" className={button} disabled={applying || disabled || !choice.lessonId} onClick={() => void apply(index)}>{applying ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Check size={15} />}Відкрити форму ДЗ</button></> : <>
              {mismatch && <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-foreground"><TriangleAlert size={15} className="mt-0.5 shrink-0" />У повідомленні зазначено інший предмет, тип заняття або дату. Перевірте, чи це завдання справді для відкритої пари.</p>}
              {uncertain && !mismatch && <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed">Предмет або дату в повідомленні не визначено однозначно. Перевірте, що завдання стосується відкритої пари.</p>}
              {needsConfirmation && <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" /><span>{hasExistingContent ? 'Замінити тему й опис у цій незбереженій формі. ' : ''}{mismatch || uncertain ? 'Я перевірив предмет, тип заняття й дату відкритої пари. ' : ''}Наявні файли залишаться, нові посилання буде додано до наявних.</span></label>}
              <button type="button" className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`} disabled={applying || disabled || (needsConfirmation && !confirmed)} onClick={() => void apply(index)}><Check size={15} />Підставити у форму</button>
            </>}
          </article>
        })}
      </div>}
    </div>}
  </section>
}
