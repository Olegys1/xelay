import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, CloudCheck, FileCheck2, History, Loader2, LockKeyhole, Plus, RefreshCw, Send, ShieldCheck, Sparkles, X } from 'lucide-react'
import { createTeacherLearningClient, type TeacherLearningClient } from '../../lib/teacherLearningClient'
import type { TeacherLearningBundle, TeacherLearningDraft, TeacherLearningKind, TeacherLearningRequest, TeacherLearningStatus } from '../../lib/teacherLearning'
import { availableTeacherGroups, teacherBudgetPercent, teacherQuestionsAsAiken, TEACHER_LEARNING_MODES } from '../../lib/teacherLearningPresentation'
import { supabase } from '../../lib/supabase'
import './teacherAssistant.css'

export type TeacherAssistantContext = { courseId?: string; groupId?: string; section?: string }
type Props = { userId: string; context?: TeacherAssistantContext; client?: TeacherLearningClient; onClose: () => void; onOpenTests?: (courseId: string, groupId?: string) => void }
const planNames = { free: 'Без підписки', teacher_start: 'Старт', teacher_plus: 'Плюс', teacher_max: 'Макс' }
type QueueItem = { request: TeacherLearningRequest; label: string; state: 'pending' | 'working' | 'done' | 'failed'; terminal?: boolean }
const terminalGenerationErrors = new Set(['generation_failed', 'invalid_output', 'moderation_failed', 'timeout', 'refused'])

export default function TeacherAssistant(props: Props) {
  const client = useMemo(() => props.client ?? createTeacherLearningClient({ currentUserId: () => props.userId, session: async () => {
    const { data, error } = await supabase.auth.getSession()
    if (error || data.session?.user.id !== props.userId) return null
    return { userId: props.userId, accessToken: data.session.access_token }
  } }), [props.client, props.userId])
  return <TeacherAssistantWorkspace key={props.userId} {...props} client={client} />
}

export function TeacherAssistantWorkspace({ userId, context, client, onClose, onOpenTests }: Props & { client: TeacherLearningClient }) {
  const [status, setStatus] = useState<TeacherLearningStatus | null>(null), [history, setHistory] = useState<TeacherLearningDraft[]>([])
  const [courseId, setCourseId] = useState(context?.courseId || ''), [groupIds, setGroupIds] = useState<string[]>(context?.groupId ? [context.groupId] : [])
  const [kind, setKind] = useState<TeacherLearningKind>('questions'), [prompt, setPrompt] = useState(''), [sourceText, setSourceText] = useState(''), [rubricText, setRubricText] = useState('')
  const [submissionIds, setSubmissionIds] = useState<string[]>([]), [testId, setTestId] = useState(''), [questionCount, setQuestionCount] = useState(5), [variantCount, setVariantCount] = useState(2)
  const [consent, setConsent] = useState(false), [draft, setDraft] = useState<TeacherLearningDraft | null>(null), [dirty, setDirty] = useState(false), [verified, setVerified] = useState(false)
  const [exportVariant, setExportVariant] = useState(1)
  const [busy, setBusy] = useState<'loading' | 'generating' | 'saving' | ''>('loading'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0)
  const [candidates, setCandidates] = useState<{ submissions: { id: string; label: string }[]; tests: { id: string; title: string }[] }>({ submissions: [], tests: [] }), [candidatesLoading, setCandidatesLoading] = useState(false)
  const [queue, setQueue] = useState<QueueItem[]>([]), queueRef = useRef<QueueItem[]>([]), stopQueue = useRef(false)
  const alive = useRef(true), operation = useRef(0), lock = useRef(false), abort = useRef<AbortController | null>(null), dirtyRef = useRef(false)
  dirtyRef.current = dirty
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); const current = ++operation.current
    setBusy('loading'); setError(''); setStatus(null); setHistory([]); setDraft(null); setDirty(false)
    Promise.all([client.status(controller.signal), client.history(controller.signal)]).then(([next, previous]) => {
      if (!alive.current || controller.signal.aborted || current !== operation.current) return
      if (next.userId !== userId) throw new Error('Акаунт змінився. Відкрийте помічника ще раз.')
      setStatus(next); setHistory(previous.drafts)
      const course = next.courses.find(item => item.id === context?.courseId) ?? next.courses[0]
      setCourseId(course?.id || ''); setGroupIds(course ? availableTeacherGroups(next, course.id, context?.groupId ? [context.groupId] : course.groups[0] ? [course.groups[0].id] : []) : [])
    }).catch(reason => { if (alive.current && !controller.signal.aborted && current === operation.current) setError(reason instanceof Error ? reason.message : 'Не вдалося відкрити помічника.') }).finally(() => { if (alive.current && current === operation.current) setBusy('') })
    const preventLoss = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault() }
    window.addEventListener('beforeunload', preventLoss)
    return () => { alive.current = false; operation.current++; controller.abort(); abort.current?.abort(); window.removeEventListener('beforeunload', preventLoss) }
  }, [client, userId, retry])
  const selectedCourse = status?.courses.find(item => item.id === courseId)
  const needsReview = kind === 'rubric_review', needsTest = kind === 'quality' || kind === 'error_practice'
  const allowed = Boolean(status?.allowedModes.includes(kind)), readOnly = !status?.canEdit
  const variants = Array.from(new Set(draft?.bundle.questions.map(question => question.variant) || [])).sort((a, b) => a - b)
  const selectedExportVariant = variants.includes(exportVariant) ? exportVariant : variants[0]
  useEffect(() => {
    setCandidates({ submissions: [], tests: [] }); setSubmissionIds([]); setTestId('')
    if (!courseId || !groupIds.length || !needsReview && !needsTest || !allowed) return
    const controller = new AbortController(); setCandidatesLoading(true)
    client.candidates({ courseId, groupIds }, controller.signal).then(value => {
      if (!controller.signal.aborted) setCandidates(value)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не вдалося отримати доступні роботи.') }).finally(() => { if (!controller.signal.aborted) setCandidatesLoading(false) })
    return () => controller.abort()
  }, [client, courseId, groupIds.join(','), needsReview, needsTest, allowed])

  function changeContext(nextCourseId: string, nextGroups: string[]) {
    if (busy) return
    setCourseId(nextCourseId); setGroupIds(status ? availableTeacherGroups(status, nextCourseId, nextGroups) : [])
    setConsent(false); setError(''); setNotice('')
  }
  function close() {
    if (dirty && !window.confirm('У чернетці є незбережені зміни. Зберегти їх можна кнопкою під результатом. Закрити без збереження?')) return
    onClose()
  }
  function edit(bundle: TeacherLearningBundle, notes = draft?.teacherNotes || '') {
    if (!draft || readOnly || busy) return
    setDraft({ ...draft, bundle, teacherNotes: notes, status: 'draft' }); setDirty(true); setVerified(false); setNotice('')
  }
  function openDraft(value: TeacherLearningDraft) {
    if (busy || dirty && !window.confirm('Відкрити іншу чернетку без збереження поточних змін?')) return
    setDraft(structuredClone(value)); setVerified(value.status === 'accepted'); setDirty(false); setError(''); setNotice('')
  }
  async function runQueue() {
    if (!status?.canGenerate || lock.current) return
    lock.current = true; setBusy('generating'); setError(''); setNotice('')
    const controller = new AbortController(); abort.current = controller; const current = ++operation.current
    stopQueue.current = false
    try {
      for (const item of queueRef.current) {
        if (item.state === 'done' || item.terminal || stopQueue.current) continue
        item.state = 'working'; setQueue(queueRef.current.map(value => ({ ...value })))
        try {
          const result = await client.generate(item.request, controller.signal)
          if (!alive.current || current !== operation.current) return
          item.state = 'done'; setQueue(queueRef.current.map(value => ({ ...value })))
          setDraft(result); setHistory(previous => [result, ...previous.filter(value => value.id !== result.id)]); setDirty(false); setVerified(false)
        } catch (reason) {
          if (!alive.current || current !== operation.current) return
          item.state = 'failed'
          item.terminal = Boolean(reason && typeof reason === 'object' && 'code' in reason && terminalGenerationErrors.has(String(reason.code)))
          setQueue(queueRef.current.map(value => ({ ...value }))); throw reason
        }
      }
      if (!alive.current || current !== operation.current) return
      setNotice(stopQueue.current ? 'Чергу призупинено. Готові чернетки збережено; наступні роботи не надсилалися.' : queueRef.current.some(item => item.state !== 'done') ? 'Готові чернетки збережено. Для невдалих відповідей можна окремо створити новий запит.' : 'Чернетки збережено у вашому акаунті. Перевірте кожну перед використанням.')
    } catch (reason) { if (alive.current && current === operation.current) setError(reason instanceof Error ? reason.message : 'Не вдалося завершити чергу. Готові чернетки збережено, запити залишилися у цій вкладці.') }
    finally {
      lock.current = false
      if (alive.current && current === operation.current) { setBusy(''); void client.status().then(next => { if (alive.current && current === operation.current) setStatus(next) }).catch(() => {}) }
    }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault()
    if (!status?.canGenerate || !allowed || !consent || !prompt.trim() || !courseId || !groupIds.length || lock.current || needsReview && !submissionIds.length || needsTest && !testId) return
    if (dirty && !window.confirm('Створити нову чернетку без збереження поточних змін?')) return
    const targets = needsReview ? submissionIds : ['']
    queueRef.current = targets.map(id => ({ label: id ? candidates.submissions.find(item => item.id === id)?.label || 'Вибрана робота' : TEACHER_LEARNING_MODES.find(mode => mode.id === kind)?.label || 'Чернетка', state: 'pending', request: {
      requestId: crypto.randomUUID(), kind, courseId, groupIds: [...groupIds], prompt: prompt.trim(), consent: true,
      ...(sourceText.trim() ? { sourceText: sourceText.trim() } : {}), ...(rubricText.trim() ? { rubricText: rubricText.trim() } : {}),
      ...(id ? { submissionId: id } : {}), ...(needsTest ? { testId } : {}),
      ...(kind === 'questions' || kind === 'variants' || kind === 'error_practice' ? { questionCount } : {}), ...(kind === 'variants' ? { variantCount } : {}),
    } }))
    setQueue(queueRef.current.map(item => ({ ...item }))); await runQueue()
  }
  async function restartFailed() {
    if (!status?.canGenerate || lock.current || !queueRef.current.some(item => item.state === 'failed' && item.terminal)) return
    if (!window.confirm('Для невдалих відповідей буде створено нові запити. Нова генерація використовує ліміт ШІ; уже готові роботи повторно не оброблятимуться. Продовжити?')) return
    queueRef.current = queueRef.current.map(item => item.state === 'failed' && item.terminal ? { ...item, request: { ...item.request, requestId: crypto.randomUUID() }, state: 'pending', terminal: false } : item)
    setQueue(queueRef.current.map(item => ({ ...item }))); await runQueue()
  }
  async function save(accept: boolean) {
    if (!draft || !status?.canEdit || lock.current || accept && !verified) return
    lock.current = true; setBusy('saving'); setError(''); setNotice('')
    const controller = new AbortController(); abort.current = controller; const current = ++operation.current
    try {
      const saved = await client.saveDraft({ id: draft.id, expectedRevision: draft.revision, bundle: draft.bundle, teacherNotes: draft.teacherNotes, status: accept ? 'accepted' : 'draft' }, controller.signal)
      if (!alive.current || current !== operation.current) return
      setDraft(saved); setHistory(previous => [saved, ...previous.filter(item => item.id !== saved.id)]); setDirty(false); setVerified(saved.status === 'accepted')
      setNotice(accept ? 'Перевірену чернетку збережено. У журнал нічого не записано.' : 'Чернетку збережено. У журнал нічого не записано.')
    } catch (reason) { if (alive.current && current === operation.current) setError(reason instanceof Error ? reason.message : 'Не вдалося зберегти. Ваші зміни залишилися у відкритій чернетці.') }
    finally { lock.current = false; if (alive.current && current === operation.current) setBusy('') }
  }
  function download() {
    if (!draft) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ title: draft.bundle.title, status: draft.status, bundle: draft.bundle, teacherNotes: draft.teacherNotes }, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'xelay-teacher-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function copyQuestions() {
    if (!draft || draft.status !== 'accepted' || dirty) return
    try {
      const bundle = variants.length > 1 ? { ...draft.bundle, questions: draft.bundle.questions.filter(question => question.variant === selectedExportVariant) } : draft.bundle
      await navigator.clipboard.writeText(teacherQuestionsAsAiken(bundle))
      if (alive.current) setNotice(`${variants.length > 1 ? `Запитання варіанта ${selectedExportVariant}` : 'Запитання'} скопійовано у форматі AIKEN. У «Тести» відкрийте імпорт і вставте текст.`)
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'Не вдалося скопіювати запитання. Завантажте чернетку.') }
  }

  return <section className="tla" aria-label="Помічник викладача">
    <header className="tla-header"><div className="tla-heading"><span className="tla-mark"><Sparkles size={20} /></span><div><span>ВАШ ПОМІЧНИК У ВИКЛАДАННІ</span><h2>Від ідеї — до готової чернетки.</h2></div></div><div className="tla-header-actions">{status && <span className="tla-quota" title="Ліміт на оплачений місяць">{planNames[status.planId]}<small>ШІ · {teacherBudgetPercent(status)}%</small></span>}<button type="button" className="tla-icon" onClick={close} aria-label="Закрити помічника" disabled={Boolean(busy)}><X size={20} /></button></div></header>
    {busy === 'loading' && <p className="tla-status" role="status"><Loader2 size={17} className="tla-spin" />Відкриваємо ваші чернетки та перевіряємо доступ…</p>}
    {error && <div role="alert" className="tla-warning"><p>{error}</p>{!status && <button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Спробувати ще раз</button>}{draft && dirty && <button type="button" onClick={download}><ArrowDownToLine size={14} />Копія змін</button>}</div>}
    {status && <>
      {(!status.canGenerate || !status.available) && <div className="tla-access"><LockKeyhole size={18} /><div><strong>{status.audience === 'student' ? 'У вас студентський тип підписки' : 'Більше допомоги у щоденній роботі'}</strong><p>Ваш кабінет, матеріали, тести й журнал працюють як раніше. Платний помічник додає підготовку та розбір чернеток; збережена історія залишається доступною.</p><a href="/subscription?audience=teacher">Тарифи для викладачів<ArrowRight size={14} /></a></div></div>}
      <div className="tla-context"><label><span>Предмет</span><select aria-label="Предмет помічника" value={courseId} disabled={Boolean(busy)} onChange={event => changeContext(event.target.value, [])}><option value="">Оберіть предмет</option>{status.courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><label><span>Що підготувати</span><select aria-label="Завдання помічника" value={kind} disabled={Boolean(busy)} onChange={event => { setKind(event.target.value as TeacherLearningKind); setConsent(false); setError('') }}>{TEACHER_LEARNING_MODES.map(mode => <option key={mode.id} value={mode.id} disabled={!status.allowedModes.includes(mode.id)}>{mode.label}{!status.allowedModes.includes(mode.id) ? ' · у старшому тарифі' : ''}</option>)}</select></label><span className="tla-context-note">{TEACHER_LEARNING_MODES.find(mode => mode.id === kind)?.hint}</span></div>
      {selectedCourse && <fieldset className="tla-groups"><legend>{status.planId === 'teacher_max' ? 'Групи для цієї чернетки' : 'Група'}</legend>{selectedCourse.groups.map(group => <label key={group.id}><input type="checkbox" checked={groupIds.includes(group.id)} disabled={Boolean(busy)} onChange={event => changeContext(courseId, status.planId === 'teacher_max' ? event.target.checked ? [...groupIds, group.id] : groupIds.filter(id => id !== group.id) : event.target.checked ? [group.id] : [])} />{group.name}</label>)}{!selectedCourse.groups.length && <p>До предмета ще не підключено груп. Спочатку підключіть навчальну групу у своєму кабінеті — це безкоштовно.</p>}</fieldset>}
      {(needsReview || needsTest) && <div className="tla-selected-work">{!groupIds.length ? <p>Оберіть групу, щоб побачити доступні {needsReview ? 'здані роботи' : 'тести'}.</p> : candidatesLoading ? <p role="status"><Loader2 size={14} className="tla-spin" />Шукаємо доступні роботи…</p> : needsReview ? <div className="tla-work-field"><span>Здані текстові роботи зі збереженою рубрикою</span><div className="tla-work-choices" role="group" aria-label="Роботи для розбору">{candidates.submissions.map(item => <label key={item.id}><input type="checkbox" checked={submissionIds.includes(item.id)} disabled={Boolean(busy) || !submissionIds.includes(item.id) && submissionIds.length >= 20} onChange={event => { setSubmissionIds(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); setConsent(false) }} />{item.label}</label>)}</div><small>Оберіть до 20 робіт. Файли в цьому пакеті не аналізуються. Кожна текстова робота розбирається за збереженою рубрикою, а готові чернетки залишаються в історії.</small>{!candidates.submissions.length && <small>Потрібна здана текстова відповідь і збережена рубрика завдання. Додайте критерії у завданні, якщо їх ще немає.</small>}</div> : <label><span>Тест для розбору</span><select aria-label="Тест для розбору" value={testId} onChange={event => { setTestId(event.target.value); setConsent(false) }}><option value="">Оберіть тест</option>{candidates.tests.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>{!candidates.tests.length && <small>У вибраних групах немає доступних тестів.</small>}</label>}</div>}
      <form className="tla-composer" onSubmit={event => void generate(event)}><label className="tla-prompt-label" htmlFor="teacher-assistant-prompt">Що допомогти зробити?</label><textarea id="teacher-assistant-prompt" value={prompt} maxLength={2400} disabled={Boolean(busy)} onChange={event => setPrompt(event.target.value)} placeholder={needsReview ? 'На що звернути увагу під час розбору роботи?' : needsTest ? 'Наприклад: знайди неоднозначні запитання й запропонуй, як їх уточнити.' : 'Наприклад: підготуй тест з попиту й пропозиції для першого курсу.'} rows={3} /><details className="tla-source"><summary><span><Plus size={15} />Матеріал та критерії</span><ChevronDown size={15} /></summary><div><label><span>Ваш текст · необов’язково</span><textarea value={sourceText} maxLength={12000} disabled={Boolean(busy)} onChange={event => { setSourceText(event.target.value); setConsent(false) }} placeholder="Додайте тільки ту частину матеріалу, яку потрібно використати." rows={4} /></label><label><span>{needsReview ? 'Уточнення до збережених критеріїв · необов’язково' : 'Критерії · за потреби'}</span><textarea aria-label="Уточнення критеріїв" value={rubricText} maxLength={4000} disabled={Boolean(busy)} onChange={event => { setRubricText(event.target.value); setConsent(false) }} placeholder={needsReview ? 'Наприклад: поясни, як студент може посилити аргументацію. Оцінюємо за рубрикою завдання.' : 'Наприклад: правильність — 5 балів, аргументація — 3, приклад — 2. Максимум 10.'} rows={3} /></label></div></details>{['questions', 'variants', 'error_practice'].includes(kind) && <div className="tla-counts"><label>{kind === 'variants' ? 'Запитань у варіанті' : 'Запитань'}<select aria-label="Кількість запитань" value={questionCount} disabled={Boolean(busy)} onChange={event => setQuestionCount(Number(event.target.value))}>{[3,5,10].filter(number => kind !== 'variants' || number * variantCount <= 20).map(number => <option key={number} value={number}>{number}</option>)}</select></label>{kind === 'variants' && <label>Варіантів<select aria-label="Кількість варіантів" value={variantCount} disabled={Boolean(busy)} onChange={event => { const count = Number(event.target.value); setVariantCount(count); if (questionCount * count > 20) setQuestionCount(5) }}>{[2,3].map(number => <option key={number} value={number}>{number}</option>)}</select></label>}</div>}<div className="tla-compose-footer"><label className="tla-consent"><input type="checkbox" checked={consent} disabled={Boolean(busy) || !status.canGenerate} onChange={event => setConsent(event.target.checked)} /><span>Дозволяю передати цей запит, обраний текст{needsReview ? ' і текст вибраних зданих робіт зі збереженими критеріями' : needsTest ? ' і дозволений контекст вибраного тесту' : ''} моделі для підготовки чернетки.</span></label><button type="submit" className="tla-primary" disabled={Boolean(busy) || !status.canGenerate || !allowed || !prompt.trim() || !consent || !courseId || !groupIds.length || needsReview && !submissionIds.length || needsTest && !testId}>{busy === 'generating' ? <Loader2 size={17} className="tla-spin" /> : <Send size={17} />}{busy === 'generating' ? 'Готуємо чернетку…' : 'Підготувати'}</button></div></form>
      {queue.length > 0 && <div className="tla-queue" aria-label="Черга помічника"><div><strong>Готово {queue.filter(item => item.state === 'done').length} з {queue.length}</strong>{busy === 'generating' ? <button type="button" onClick={() => { stopQueue.current = true; setNotice('Зупинимося після поточної роботи. Її запит уже надіслано.') }}>Зупинити після поточної</button> : queue.some(item => item.state === 'failed' && item.terminal) ? <button type="button" disabled={!status.canGenerate} onClick={() => void restartFailed()}>Новий запит для невдалих</button> : queue.some(item => item.state !== 'done') && <button type="button" disabled={!status.canGenerate} onClick={() => void runQueue()}>Продовжити незавершені</button>}</div><ol>{queue.map(item => <li key={item.request.requestId}><span>{item.state === 'done' ? <Check size={13} /> : item.state === 'working' ? <Loader2 size={13} className="tla-spin" /> : <History size={13} />}{item.label}</span><small>{({ pending: 'Очікує', working: 'Готуємо', done: 'Збережено', failed: 'Потрібно повторити' })[item.state]}</small></li>)}</ol>{queue.some(item => item.state === 'failed' && item.terminal) && <p>Новий запит для невдалої відповіді використовує ліміт ШІ. Готові чернетки не генеруються повторно.</p>}</div>}
      {history.length > 0 && <details className="tla-history"><summary><span><History size={16} />Ваші чернетки <small>{history.length}</small></span><ChevronDown size={16} /></summary><div>{history.map(item => <button type="button" key={item.id} disabled={Boolean(busy)} aria-pressed={draft?.id === item.id} onClick={() => openDraft(item)}><span>{item.status === 'accepted' ? <FileCheck2 size={15} /> : <History size={15} />}{item.bundle.title}</span><small>{new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', timeZone: 'Europe/Kyiv' }).format(new Date(item.updatedAt))}</small></button>)}</div></details>}
      {notice && <p role="status" className="tla-notice"><CloudCheck size={16} />{notice}</p>}
      {draft && <article className="tla-draft" aria-label="Чернетка помічника"><div className="tla-draft-heading"><div><span>{draft.status === 'accepted' && !dirty ? 'ПЕРЕВІРЕНО ВАМИ' : 'ЧЕРНЕТКА · ПОТРІБНА ВАША ПЕРЕВІРКА'}</span><h3>{draft.bundle.title}</h3></div><button type="button" className="tla-text-button" onClick={download}><ArrowDownToLine size={15} />Копія</button></div><p className="tla-summary">{draft.bundle.summary}</p>{draft.bundle.warnings.map((warning, index) => <p className="tla-draft-warning" key={index}><ShieldCheck size={15} />{warning}</p>)}<TeacherDraftEditor bundle={draft.bundle} readOnly={readOnly || Boolean(busy)} onChange={bundle => edit(bundle)} /><label className="tla-teacher-note"><span>Ваша примітка до чернетки</span><textarea rows={2} value={draft.teacherNotes} maxLength={4000} disabled={readOnly || Boolean(busy)} onChange={event => edit(draft.bundle, event.target.value)} /></label><div className="tla-draft-footer"><label className="tla-consent"><input type="checkbox" checked={verified} disabled={readOnly || Boolean(busy)} onChange={event => setVerified(event.target.checked)} /><span>{draft.bundle.review ? 'Я перевірив/-ла критерії, запропоновані бали та фідбек. Це не публікує оцінку.' : 'Я перевірив/-ла зміст, правильні відповіді та відповідність матеріалу.'}</span></label><div className="tla-save-actions"><button type="button" disabled={readOnly || Boolean(busy) || !dirty} onClick={() => void save(false)}>{busy === 'saving' ? <Loader2 size={15} className="tla-spin" /> : <CloudCheck size={15} />}Зберегти зміни</button><button type="button" className="tla-primary" disabled={readOnly || Boolean(busy) || !verified} onClick={() => void save(true)}><Check size={15} />Зберегти перевірену чернетку</button></div></div>{draft.bundle.questions.length > 0 && <div className="tla-import">{variants.length > 1 && <label>Для імпорту<select aria-label="Варіант для імпорту" value={selectedExportVariant} onChange={event => setExportVariant(Number(event.target.value))}>{variants.map(value => <option key={value} value={value}>Варіант {value}</option>)}</select></label>}<button type="button" disabled={draft.status !== 'accepted' || dirty || Boolean(busy)} onClick={() => void copyQuestions()}>Скопіювати для імпорту<ArrowRight size={14} /></button>{onOpenTests && <button type="button" onClick={() => onOpenTests(draft.request.courseId, draft.request.groupIds[0])}>Відкрити тести<ArrowRight size={14} /></button>}<p>Перевірте чернетку, скопіюйте запитання та вставте їх у звичайний імпорт тестів. Кожен варіант імпортуйте окремо. Студенти нічого не бачать до вашої публікації.</p></div>}</article>}
      <footer className="tla-safety"><ShieldCheck size={15} />ШІ може помилятися. Чернетки приватні. Помічник не виставляє оцінок і не публікує роботи замість вас.</footer>
    </>}
  </section>
}

export function TeacherDraftEditor({ bundle, readOnly, onChange }: { bundle: TeacherLearningBundle; readOnly: boolean; onChange: (bundle: TeacherLearningBundle) => void }) {
  function question(index: number, patch: Partial<TeacherLearningBundle['questions'][number]>) { onChange({ ...bundle, questions: bundle.questions.map((item, at) => at === index ? { ...item, ...patch } : item) }) }
  return <div className="tla-result">
    {bundle.questions.map((item, index) => <fieldset key={item.id} className="tla-question"><legend>{index + 1}. {item.variant > 0 ? `Варіант ${item.variant}` : 'Запитання'}<span>{item.points} б.</span></legend><textarea aria-label={`Запитання ${index + 1}`} value={item.text} maxLength={2000} rows={2} disabled={readOnly} onChange={event => question(index, { text: event.target.value })} /><div className="tla-choices">{item.choices.map((choice, at) => <label key={at}><input type="radio" name={`teacher-key-${item.id}`} checked={item.correctIndex === at} disabled={readOnly} onChange={() => question(index, { correctIndex: at })} aria-label={`Правильна відповідь ${at + 1} запитання ${index + 1}`} /><input type="text" aria-label={`Варіант ${at + 1} запитання ${index + 1}`} value={choice} maxLength={500} disabled={readOnly} onChange={event => question(index, { choices: item.choices.map((value, choiceAt) => choiceAt === at ? event.target.value : value) })} /></label>)}</div><p>{item.explanation}</p></fieldset>)}
    {bundle.tasks.map((task, index) => <section className="tla-task" key={index}><h4>{task.title}</h4><textarea aria-label={`Умова завдання ${index + 1}`} rows={4} maxLength={3000} value={task.instructions} disabled={readOnly} onChange={event => onChange({ ...bundle, tasks: bundle.tasks.map((item, at) => at === index ? { ...item, instructions: event.target.value } : item) })} /><ul>{task.criteria.map((criterion, at) => <li key={at}>{criterion}</li>)}</ul></section>)}
    {bundle.review && <div className="tla-review"><div className="tla-review-score"><span>Запропоновано · потребує вашого підтвердження</span><strong>{bundle.review.suggestedScore}<small> / {bundle.review.maxScore}</small></strong></div>{bundle.review.criteria.map((criterion, index) => <section key={index}><div><h4>{criterion.title}</h4><label><span className="sr-only">Пропонований бал: {criterion.title}</span><input type="number" min={0} max={criterion.maxPoints} step="0.25" value={criterion.points} disabled={readOnly} onChange={event => {
      if (!bundle.review) return
      const points = Number(event.target.value); if (!Number.isFinite(points)) return
      const criteria = bundle.review.criteria.map((item, at) => at === index ? { ...item, points: Math.min(item.maxPoints, Math.max(0, points)) } : item)
      onChange({ ...bundle, review: { ...bundle.review, criteria, suggestedScore: Math.min(bundle.review.maxScore, criteria.reduce((sum, item) => sum + item.points, 0)) } })
    }} /> / {criterion.maxPoints}</label></div><p>{criterion.comment}</p>{criterion.evidence.map((evidence, at) => <blockquote key={at}>{evidence}</blockquote>)}</section>)}<label><span>Фідбек, який можна відредагувати</span><textarea rows={4} maxLength={3000} value={bundle.review.feedback} disabled={readOnly} onChange={event => { if (bundle.review) onChange({ ...bundle, review: { ...bundle.review, feedback: event.target.value } }) }} /></label></div>}
    {bundle.quality.map((item, index) => <section className="tla-quality" key={index}><h4>{item.issue}</h4><p>{item.suggestion}</p><small>Запитання {item.questionId}</small></section>)}
  </div>
}
