import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { SEMINAR_FORMATS } from '../lib/seminars'
import { normalizeSeminarAiInput, type SeminarAiDraftResult, type SeminarAiFormat } from '../lib/seminarAiDraft'
import { requestSeminarAiDraft, seminarAiDraftAvailability, type SeminarAiAvailability } from '../lib/seminarAiDraftClient'

export type SeminarAiDraftContext = { editorKey: string; baseDraftVersion: string }
type Props = SeminarAiDraftContext & {
  groupId: string
  currentUserId: string
  initialFormat: SeminarAiFormat
  canEdit: boolean
  disabled: boolean
  hasExistingContent: boolean
  onApply: (draft: SeminarAiDraftResult, expected: SeminarAiDraftContext) => boolean
}

const fieldClass = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50 sm:text-sm'
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-3.5 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'
const numberValue = (value: string) => /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
const failureMessage = (error: unknown) => error instanceof Error ? error.message : 'Не вдалося підготувати чернетку. Спробуйте ще раз.'

export function SeminarAiDraft(props: Props) {
  const { groupId, currentUserId, editorKey, baseDraftVersion, initialFormat, canEdit, disabled, hasExistingContent, onApply } = props
  const id = useId()
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState('')
  const [format, setFormat] = useState<SeminarAiFormat>(initialFormat)
  const [capacity, setCapacity] = useState(initialFormat === 'booking' ? '10' : '1')
  const [teamSize, setTeamSize] = useState('5')
  const [teamCount, setTeamCount] = useState('2')
  const [participants, setParticipants] = useState('30')
  const [teamMode, setTeamMode] = useState<'count' | 'participants'>('count')
  const [availability, setAvailability] = useState<SeminarAiAvailability | null>(null)
  const [checking, setChecking] = useState(false)
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SeminarAiDraftResult | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [applied, setApplied] = useState(false)
  const generation = useRef(0)
  const availabilityGeneration = useRef(0)
  const request = useRef<AbortController | null>(null)
  const availabilityRequest = useRef<AbortController | null>(null)
  const authValid = useRef(true)
  const mounted = useRef(true)
  const context = useRef({ editorKey, baseDraftVersion, canEdit, disabled })
  context.current = { editorKey, baseDraftVersion, canEdit, disabled }
  const expected = useRef<SeminarAiDraftContext | null>(null)

  function invalidate() {
    ++generation.current
    request.current?.abort()
    request.current = null
    expected.current = null
    setBusy(false)
    setResult(null)
    setConfirmed(false)
  }
  function changeInput(action: () => void) {
    invalidate()
    setError('')
    setApplied(false)
    action()
  }
  function close() {
    invalidate()
    ++availabilityGeneration.current
    availabilityRequest.current?.abort()
    setChecking(false)
    setOpen(false)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++generation.current
      ++availabilityGeneration.current
      request.current?.abort()
      availabilityRequest.current?.abort()
    }
  }, [])
  useEffect(() => {
    invalidate()
    setError('')
  }, [editorKey, baseDraftVersion, canEdit, disabled])
  useEffect(() => { setFormat(initialFormat) }, [initialFormat])
  useEffect(() => {
    authValid.current = true
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (session && session.user.id !== currentUserId)) {
        authValid.current = false
        ++generation.current
        ++availabilityGeneration.current
        request.current?.abort()
        availabilityRequest.current?.abort()
        if (mounted.current) {
          setBusy(false); setChecking(false); setResult(null); setAvailability(null); setConfirmed(false)
          setError('Акаунт змінився. Відкрийте завдання знову.')
        }
      } else if (session?.user.id === currentUserId) authValid.current = true
    })
    return () => { subscription.unsubscribe() }
  }, [currentUserId])

  useEffect(() => {
    if (!open || !canEdit || disabled) return
    const controller = new AbortController()
    availabilityRequest.current = controller
    const sequence = ++availabilityGeneration.current
    setAvailability(null)
    setChecking(true)
    void seminarAiDraftAvailability(groupId, currentUserId, controller.signal).then((value) => {
      if (mounted.current && !controller.signal.aborted && sequence === availabilityGeneration.current && authValid.current) setAvailability(value)
    }).catch((failure) => {
      if (mounted.current && !controller.signal.aborted && sequence === availabilityGeneration.current) setAvailability({ available: false, reason: failureMessage(failure) })
    }).finally(() => {
      if (mounted.current && sequence === availabilityGeneration.current) setChecking(false)
    })
    return () => { controller.abort(); ++availabilityGeneration.current }
  }, [open, canEdit, disabled, groupId, currentUserId, editorKey, retry])

  async function generate() {
    if (busy || disabled || !canEdit || !availability?.available || !authValid.current) return
    let input
    try {
      input = normalizeSeminarAiInput({
        source_text: source, format,
        primary_capacity: format === 'teams' ? null : numberValue(capacity),
        team_size: format === 'teams' ? numberValue(teamSize) : null,
        team_count: format === 'teams' && teamMode === 'count' ? numberValue(teamCount) : null,
        participant_count: format === 'teams' && teamMode === 'participants' ? numberValue(participants) : null,
      })
    } catch (failure) { setError(failureMessage(failure)); return }
    invalidate()
    const controller = new AbortController()
    request.current = controller
    const sequence = ++generation.current
    const started = { editorKey, baseDraftVersion }
    setBusy(true); setError(''); setApplied(false)
    try {
      const draft = await requestSeminarAiDraft(groupId, currentUserId, input, controller.signal)
      const current = context.current
      if (!mounted.current || controller.signal.aborted || sequence !== generation.current || !authValid.current
        || !current.canEdit || current.disabled || current.editorKey !== started.editorKey || current.baseDraftVersion !== started.baseDraftVersion) return
      expected.current = started
      setResult(draft)
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && sequence === generation.current) setError(failureMessage(failure))
    } finally {
      if (mounted.current && sequence === generation.current) setBusy(false)
    }
  }

  function apply() {
    const started = expected.current
    const current = context.current
    if (!result || !started || busy || disabled || !canEdit || !authValid.current || (hasExistingContent && !confirmed)) return
    if (current.editorKey !== started.editorKey || current.baseDraftVersion !== started.baseDraftVersion || !onApply(result, started)) {
      invalidate()
      setError('Форма або доступ змінилися. Підготуйте чернетку ще раз.')
      return
    }
    invalidate()
    setApplied(true)
    setOpen(false)
  }

  if (!canEdit) return null
  const automaticTeams = Math.ceil(numberValue(participants) / numberValue(teamSize))
  return <section className="min-w-0 rounded-2xl border border-primary/20 bg-primary/5 p-3.5 sm:p-4" aria-label="Чернетка семінару з тексту" onKeyDown={(event) => {
    // These optional controls live inside the manual editor's form, never submit it.
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
  }}>
    <button type="button" disabled={disabled} onClick={() => open ? close() : setOpen(true)} aria-expanded={open} aria-controls={`${id}-content`} className="flex min-h-10 w-full items-center gap-2 text-left text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
      <Sparkles size={17} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">Заповнити з ШІ</span>
      <ChevronDown size={16} className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
    {applied && <p role="status" className="mt-2 text-sm text-primary">Чернетку підставлено. Перевірте форму й натисніть «Зберегти».</p>}
    {open && <div id={`${id}-content`} className="mt-3 space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">Вставте список питань або умови викладача. Перегляньте чернетку, а потім підставте її в нове завдання.</p>
      <label className="block space-y-1.5"><span className="text-sm font-medium">Текст питань і завдання</span>
        <textarea value={source} rows={6} maxLength={12000} disabled={disabled} onChange={(event) => changeInput(() => setSource(event.target.value))} placeholder={'1. Поняття попиту…\n2. Чинники пропозиції…'} aria-describedby={`${id}-source-count`} className={fieldClass} />
      </label>
      <p id={`${id}-source-count`} className="-mt-2 text-right text-xs text-muted-foreground">{source.length}/12000</p>
      <fieldset disabled={disabled}><legend className="mb-2 text-sm font-medium">Як працюватимемо на семінарі</legend>
        <div className="grid gap-2 sm:grid-cols-3">{SEMINAR_FORMATS.map((item) => <button key={item.id} type="button" aria-pressed={format === item.id} onClick={() => changeInput(() => setFormat(item.id))} className={`${buttonClass} rounded-xl px-2 ${format === item.id ? 'border-primary/30 bg-background text-primary' : 'bg-background/60'}`}>{item.label}</button>)}</div>
      </fieldset>
      {format !== 'teams' ? <label className="block space-y-1.5"><span className="text-sm font-medium">{format === 'booking' ? 'Місць на кожне питання' : 'Основних відповідачів на питання'} · 1–30</span>
        <input type="text" inputMode="numeric" maxLength={2} value={capacity} disabled={disabled} onChange={(event) => changeInput(() => setCapacity(event.target.value))} className={fieldClass} />
      </label> : <div className="space-y-3">
        <label className="block space-y-1.5"><span className="text-sm font-medium">Людей у команді · 1–50</span><input type="text" inputMode="numeric" maxLength={2} value={teamSize} disabled={disabled} onChange={(event) => changeInput(() => setTeamSize(event.target.value))} className={fieldClass} /></label>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled} aria-pressed={teamMode === 'count'} onClick={() => changeInput(() => setTeamMode('count'))} className={`${buttonClass} ${teamMode === 'count' ? 'border-primary/30 bg-background text-primary' : ''}`}>Задати кількість команд</button><button type="button" disabled={disabled} aria-pressed={teamMode === 'participants'} onClick={() => changeInput(() => setTeamMode('participants'))} className={`${buttonClass} ${teamMode === 'participants' ? 'border-primary/30 bg-background text-primary' : ''}`}>Порахувати за учасниками</button></div>
        {teamMode === 'count' ? <label className="block space-y-1.5"><span className="text-sm font-medium">Кількість команд · 1–30</span><input type="text" inputMode="numeric" maxLength={2} value={teamCount} disabled={disabled} onChange={(event) => changeInput(() => setTeamCount(event.target.value))} className={fieldClass} /></label>
          : <label className="block space-y-1.5"><span className="text-sm font-medium">Учасників загалом · 1–300</span><input type="text" inputMode="numeric" maxLength={3} value={participants} disabled={disabled} onChange={(event) => changeInput(() => setParticipants(event.target.value))} className={fieldClass} /></label>}
        {teamMode === 'participants' && Number.isFinite(automaticTeams) && automaticTeams > 0 && <p className={`text-xs ${automaticTeams > 30 ? 'text-destructive' : 'text-muted-foreground'}`}>Вийде команд: {automaticTeams}. Максимум — 30.</p>}
        <p className="text-xs text-muted-foreground">Команди отримають номери й завдання. Людей за командами помічник не розподіляє.</p>
      </div>}
      <p className="text-xs leading-relaxed text-muted-foreground">Вставлений текст буде надіслано до OpenAI для підготовки чернетки.</p>
      <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">До 3 чернеток на день для акаунта спільно для семінарів і ДЗ. Скасування запиту або помилка сервісу теж можуть витратити спробу.</p>
      {checking ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" />Перевіряємо доступність…</p>
        : availability && !availability.available && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{availability.reason}</p><button type="button" disabled={disabled} onClick={() => setRetry((value) => value + 1)} className={buttonClass}><RefreshCw size={14} />Перевірити ще раз</button></div>}
      {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || busy || checking || !availability?.available || !source.trim()} onClick={() => void generate()} className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}>{busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Sparkles size={16} />} {busy ? 'Готуємо чернетку…' : result ? 'Підготувати ще раз' : 'Підготувати чернетку'}</button>{busy && <button type="button" onClick={() => invalidate()} className={buttonClass}><X size={15} />Скасувати</button>}</div>
      {result && <section className="space-y-3 rounded-xl border border-primary/20 bg-background p-3.5" aria-label="Попередній перегляд чернетки">
        <div><h3 className="text-sm font-semibold">Перевірте чернетку</h3><p className="mt-1 text-xs text-muted-foreground">{SEMINAR_FORMATS.find((item) => item.id === result.format)?.label} · {result.format === 'teams' ? `${result.teams.length} команд` : `${result.questions.length} питань`}</p></div>
        <h4 className="break-words font-semibold">{result.title}</h4>
        {result.instructions && <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{result.instructions}</div>}
        <ol className="max-h-80 space-y-2 overflow-y-auto">{result.format === 'teams' ? result.teams.map((team, index) => <li key={index} className="rounded-lg border border-border p-2.5 text-sm"><span className="font-medium">{team.name}</span><span className="mt-1 block text-xs text-muted-foreground">Місць: {team.capacity}</span></li>)
          : result.questions.map((question, index) => <li key={index} className="rounded-lg border border-border p-2.5 text-sm"><p className="whitespace-pre-wrap break-words">{index + 1}. {question.body}</p><p className="mt-1 text-xs text-muted-foreground">{result.format === 'booking' ? 'Місць' : 'Основних відповідачів'}: {question.primary_capacity}</p></li>)}</ol>
        {result.warnings.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <p className="text-xs leading-relaxed text-muted-foreground">ШІ може помилятися. Звірте всі питання й умови з оригіналом. Нічого ще не збережено.</p>
        {hasExistingContent && <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" /><span>Замінити назву, умови, формат і питання або команди у цій незбереженій формі. Файли та посилання залишаться.</span></label>}
        <button type="button" disabled={disabled || busy || (hasExistingContent && !confirmed)} onClick={apply} className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}><Check size={16} />Підставити в форму</button>
      </section>}
    </div>}
  </section>
}
