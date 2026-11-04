import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, ClipboardCheck, Clock3, GripVertical, LockKeyhole, Play, RefreshCw, Send, Trophy, Undo2 } from 'lucide-react'
import { teachingDate } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestAttempt, type TeachingTestDetail, type TeachingTestQuestion, type TeachingTestRepository } from '../../lib/teachingTests'
import { TeachingButton, TeachingEmpty, TeachingModal } from './TeachingUI'
import './teaching-tests.css'

type Answer = TeachingTestAttempt['answers'][string]
function clock(seconds: number) { const value = Math.max(0, Math.ceil(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
function remaining(deadline: string | null | undefined, now: number) { return deadline ? Math.max(0, (new Date(deadline).getTime() - now) / 1000) : null }
function hasAnswer(answer: Answer | undefined) {
  if (answer == null || answer === '') return false
  return typeof answer !== 'object' || Object.keys(answer).length > 0
}

export function TeachingGroupTests({ repository, groupId, courseId, userId }: { repository: TeachingTestRepository; groupId: string; courseId?: string; userId?: string }) {
  const [tests, setTests] = useState<TeachingTest[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [selected, setSelected] = useState<TeachingTest | null>(null)
  const scope = `${userId || ''}:${groupId}:${courseId || ''}`
  const currentScope = useRef(scope); currentScope.current = scope
  const load = useCallback(async () => {
    const captured = scope
    setLoading(true); setError('')
    try { const data = await repository.list(courseId, groupId); if (currentScope.current === captured) setTests(data.tests) }
    catch (failure) { if (currentScope.current === captured) setError(teachingTestError(failure)) }
    finally { if (currentScope.current === captured) setLoading(false) }
  }, [repository, groupId, courseId, scope])
  useEffect(() => { setTests([]); setSelected(null); void load() }, [load])
  return <section className="teaching-tests">
    <div className="teaching-test-heading"><div><h2>Тести викладачів</h2><p>Контрольні, заліки та інші роботи для вашої групи й підгрупи.</p></div><TeachingButton disabled={loading} onClick={() => void load()}><RefreshCw size={15} />Оновити</TeachingButton></div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {loading ? <p role="status" className="teaching-note">Завантажуємо тести…</p> : !tests.length ? <div className="teaching-card"><TeachingEmpty icon={<ClipboardCheck size={25} />} title="Поки немає тестів" description="Коли викладач опублікує тест для вас, він з’явиться тут." /></div> : <div className="teaching-list">{tests.map(test => {
      const ownAttempt = test.my_attempt
      const submitted = ownAttempt?.status === 'submitted'
      const published = Boolean(ownAttempt?.grade_published_at)
      return <article className="teaching-card teaching-student-test-card" key={test.id}>
        <div className="teaching-test-heading">
          <span className="teaching-badge">{test.course_title || 'Робота викладача'}</span>
          {submitted && <span className="teaching-test-submitted-badge"><CheckCircle2 size={15} />Роботу здано</span>}
          {ownAttempt?.status === 'in_progress' && <span className="teaching-badge"><Clock3 size={14} />Виконуєте</span>}
        </div>
        <h3 className="mt-3 text-lg font-semibold">{test.title}</h3>
        <div className="teaching-test-meta"><span><ClipboardCheck size={14} />Запитань {test.question_count}</span><span><Clock3 size={14} />{test.duration_seconds / 60} хв</span><span>До {test.max_points} балів</span></div>
        <p className="text-xs text-muted-foreground">Доступ з {teachingDate(test.opens_at, true)} до {teachingDate(test.closes_at, true)}</p>
        {submitted && <p className="teaching-student-test-receipt">Здано {teachingDate(ownAttempt.submitted_at, true)} · {published ? ownAttempt.published_absent ? 'Позначено відсутність · Н' : `Результат ${ownAttempt.published_score ?? '—'} із ${test.max_points}` : 'Очікує перевірки викладача'}</p>}
        <div className="teaching-test-actions"><TeachingButton primary={!submitted} onClick={() => setSelected(test)}><ArrowRight size={15} />{submitted ? published ? 'Переглянути результат' : 'Переглянути здачу' : ownAttempt ? 'Продовжити роботу' : 'Відкрити роботу'}</TeachingButton></div>
      </article>
    })}</div>}
    {selected && <TeachingTestRunner key={`${scope}:${selected.id}`} repository={repository} testId={selected.id} groupId={groupId} userId={userId} onClose={() => { setSelected(null); void load() }} />}
  </section>
}

export function TeachingTestRunner({ repository, testId, groupId, userId, onClose }: { repository: TeachingTestRepository; testId: string; groupId: string; userId?: string; onClose: () => void }) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [actionBusy, setActionBusy] = useState(false), [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved'), [answer, setAnswer] = useState<Answer | undefined>()
  const [rulesAccepted, setRulesAccepted] = useState(false), [confirmFinish, setConfirmFinish] = useState(false), [now, setNow] = useState(Date.now())
  const dataRef = useRef<TeachingTestDetail | null>(null), pending = useRef<{ questionId: string; answer: Answer } | null>(null)
  const processing = useRef<Promise<boolean> | null>(null), actionLock = useRef(false), alive = useRef(true), serverOffset = useRef(0), expirationRead = useRef('')
  const receive = useCallback((value: TeachingTestDetail) => {
    const current = dataRef.current
    if (current?.attempt && value.test.id === current.test.id && (!value.attempt || value.attempt.id === current.attempt.id && value.attempt.version < current.attempt.version)) return
    dataRef.current = value
    serverOffset.current = Date.now() - new Date(value.server_now).getTime()
    if (!alive.current) return
    setDetail(value); setNow(Date.now() - serverOffset.current)
    if (!pending.current) setAnswer(value.attempt?.current_question ? value.attempt.answers[value.attempt.current_question.id] : undefined)
  }, [])
  const refresh = useCallback(async () => {
    if (actionLock.current || processing.current) return
    try { receive(await repository.detail(testId)) }
    catch (failure) { if (alive.current) setError(teachingTestError(failure)) }
  }, [repository, testId, receive])
  useEffect(() => {
    alive.current = true
    void repository.detail(testId).then(receive).catch(failure => { if (alive.current) setError(teachingTestError(failure)) }).finally(() => { if (alive.current) setLoading(false) })
    const timer = window.setInterval(() => { if (alive.current) setNow(Date.now() - serverOffset.current) }, 250)
    const sync = window.setInterval(() => { if (dataRef.current?.attempt?.status === 'in_progress') void refresh() }, 20000)
    const online = () => { void refresh() }
    window.addEventListener('online', online)
    return () => { alive.current = false; pending.current = null; window.clearInterval(timer); window.clearInterval(sync); window.removeEventListener('online', online) }
  }, [repository, testId, receive, refresh])
  const attempt = detail?.attempt, test = detail?.test, question = attempt?.current_question
  const totalLeft = remaining(attempt?.expires_at, now), questionLeft = remaining(attempt?.question_expires_at, now)
  const questionExpired = questionLeft !== null && questionLeft <= 0
  const locked = Boolean(question && (questionExpired || attempt?.locked.includes(question.id)))
  const terminal = attempt?.status === 'submitted'
  const answeredCount = attempt ? Object.values(attempt.answers).filter(hasAnswer).length : 0
  useEffect(() => {
    if (!attempt || terminal || totalLeft === null || totalLeft > 0) return
    const key = `${attempt.id}:${attempt.expires_at}`
    if (expirationRead.current === key || actionBusy || saveState === 'saving') return
    expirationRead.current = key; void refresh()
  }, [attempt?.id, attempt?.expires_at, terminal, totalLeft, refresh, actionBusy, saveState])

  async function flushAnswers(): Promise<boolean> {
    if (processing.current) return processing.current
    const task = (async () => {
      while (pending.current && alive.current) {
        const next = pending.current, state = dataRef.current
        if (!state?.attempt || state.attempt.status !== 'in_progress') { pending.current = null; return false }
        pending.current = null
        if (alive.current) { setSaveState('saving'); setError('') }
        try {
          const result = await repository.mutate('save_answer', { id: testId, expected_user_id: state.attempt.user_id, version: state.attempt.version, question_id: next.questionId, answer: next.answer })
          receive(result)
        } catch (failure) {
          if (alive.current && !pending.current) pending.current = next
          if (alive.current) { setError(teachingTestError(failure)); setSaveState('failed') }
          return false
        }
      }
      if (alive.current) setSaveState('saved')
      return true
    })()
    processing.current = task
    try { return await task } finally { processing.current = null }
  }
  function choose(value: Answer) {
    if (!question || locked || actionLock.current || terminal) return
    setAnswer(value); setConfirmFinish(false)
    pending.current = { questionId: question.id, answer: value }
    void flushAnswers()
  }
  async function action(name: 'start' | 'navigate' | 'finish', index?: number) {
    if (actionLock.current) return
    actionLock.current = true; setActionBusy(true); setError('')
    try {
      if (name !== 'start') {
        if (pending.current && locked) pending.current = null
        if (!await flushAnswers()) return
      }
      if (!alive.current) return
      const current = dataRef.current
      const result = await repository.mutate(name, { id: testId, expected_user_id: current?.attempt?.user_id || userId, group_id: groupId, ...(current?.attempt ? { version: current.attempt.version } : {}), ...(index == null ? {} : { index }) })
      pending.current = null; receive(result); setConfirmFinish(false); setSaveState('saved')
    } catch (failure) { setError(teachingTestError(failure)) }
    finally { actionLock.current = false; if (alive.current) setActionBusy(false) }
  }
  async function retry() {
    if (actionLock.current || processing.current) return
    setError(''); pending.current = null; setSaveState('saved'); await refresh()
  }
  return <TeachingModal wide title={test?.title || 'Тест'} description={test?.course_title} onClose={onClose} busy={actionBusy || saveState === 'saving'}>
    <div className="teaching-tests">
      {error && <div role="alert" className="teaching-error"><p>{error}</p><div className="teaching-test-actions">{saveState === 'failed' && !locked && <TeachingButton onClick={() => void flushAnswers()}>Повторити збереження</TeachingButton>}<TeachingButton onClick={() => void retry()}><RefreshCw size={14} />Оновити дані тесту</TeachingButton></div></div>}
      {loading ? <p role="status">Завантажуємо роботу…</p> : test && !attempt ? <>
        {test.description && <p className="whitespace-pre-wrap text-sm leading-relaxed">{test.description}</p>}
        <div className="teaching-test-rules"><Rule icon={<Clock3 size={20} />} title={`${test.duration_seconds / 60} хвилин на спробу`}>Відлік починається після натискання «Почати тест». Час окремих запитань буде показано під час проходження.</Rule><Rule icon={<LockKeyhole size={20} />} title="Одна особиста спроба">Після завершення повторне проходження недоступне. Оновлення сторінки продовжує поточну спробу.</Rule><Rule icon={<ArrowLeft size={20} />} title={test.allow_return ? 'Повернення дозволено' : 'Без повернення назад'}>{test.allow_skip ? 'Запитання можна пропускати. ' : 'Перед переходом потрібно відповісти. '}{test.question_timer_policy === 'lock_on_leave' ? 'Після переходу відповідь фіксується.' : 'Таймер відкритого запитання продовжується після переходу.'}</Rule><Rule icon={<ClipboardCheck size={20} />} title={test.restrict_copy ? 'Копіювання тексту обмежено' : 'Копіювання тексту дозволено'}>Після завершення відповіді перевірить викладач. Свій результат побачите після публікації балів.</Rule>{test.bonus_percent > 0 && <Rule icon={<Trophy size={20} />} title={`До ${test.bonus_points} бонусних балів`}>Бонус для найкращих {test.bonus_percent}% за результатом і швидкістю. Підсумок не перевищує {test.max_points} балів.</Rule>}</div>
        <p className="teaching-note">Запитань {test.question_count} · до {test.max_points} балів. Доступ з {teachingDate(test.opens_at, true)} до {teachingDate(test.closes_at, true)} за Києвом. Після завершення строку доступу робота закривається.</p>
        <label className="teaching-check"><input type="checkbox" checked={rulesAccepted} onChange={event => setRulesAccepted(event.target.checked)} />Я прочитав правила та готовий розпочати</label>
        <TeachingButton primary busy={actionBusy} disabled={!rulesAccepted || now < new Date(test.opens_at).getTime() || now >= new Date(test.closes_at).getTime() || test.status !== 'published'} onClick={() => void action('start')}><Play size={16} />Почати тест</TeachingButton>
      </> : test && attempt && terminal ? <section className="teaching-test-submitted" aria-label="Підтвердження здачі роботи" role="status">
        <span className="teaching-test-receipt-icon"><CheckCircle2 size={38} /></span>
        <p className="teaching-test-receipt-eyebrow">Відповіді отримано</p>
        <h3>Роботу здано</h3>
        <p className="teaching-test-receipt-description">{attempt.grade_published_at ? attempt.published_absent ? 'У журналі опубліковано позначку відсутності.' : 'Викладач перевірив роботу й опублікував результат.' : 'Викладач перевірить відповіді та опублікує ваш результат. Статус роботи збережено у групі.'}</p>
        <dl className="teaching-test-receipt-details">
          <div><dt>Здано</dt><dd>{teachingDate(attempt.submitted_at, true)}</dd></div>
          <div><dt>Стан</dt><dd>{attempt.grade_published_at ? 'Результат опубліковано' : 'Очікує перевірки'}</dd></div>
          {attempt.grade_published_at && <div><dt>Ваш результат</dt><dd>{attempt.published_absent ? 'Н · відсутність' : `${attempt.published_score ?? '—'} із ${test.max_points}`}</dd></div>}
        </dl>
        {attempt.published_comment && <p className="teaching-note">{attempt.published_comment}</p>}
        <TeachingButton primary onClick={onClose}>Повернутися до групи<ArrowRight size={16} /></TeachingButton>
      </section> : test && attempt && question ? <>
        <div className="teaching-test-clockbar"><div><Clock3 size={19} /><span>Залишилось на тест</span><strong data-urgent={totalLeft !== null && totalLeft < 60}>{clock(totalLeft || 0)}</strong></div>{questionLeft !== null && <div><span>На запитання</span><strong data-urgent={questionLeft < 10}>{clock(questionLeft)}</strong></div>}</div>
        <div className="teaching-test-progress" aria-label={`Запитання ${attempt.current_index + 1} із ${test.question_count}`}><span style={{ width: `${(attempt.current_index + 1) / test.question_count * 100}%` }} /></div>
        <section className="teaching-test-question" data-restrict-copy={test.restrict_copy} onCopy={event => { if (test.restrict_copy) event.preventDefault() }} onContextMenu={event => { if (test.restrict_copy) event.preventDefault() }} onKeyDown={event => { if (test.restrict_copy && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') event.preventDefault() }}>
          <span className="teaching-badge">Запитання {attempt.current_index + 1} із {test.question_count} · вага {question.points}</span><h3>{question.text}</h3>
          {locked && <p className="teaching-note mb-4">{questionExpired ? 'Час запитання завершився. Збережена відповідь зафіксована, можна перейти далі.' : 'Відповідь зафіксована за правилами тесту.'}</p>}
          <QuestionAnswer key={question.id} question={question} answer={answer} disabled={locked || actionBusy || totalLeft === 0} onChange={choose} />
        </section>
        <p role="status" className="teaching-test-status">{saveState === 'saving' ? 'Зберігаємо відповідь…' : saveState === 'failed' ? 'Збереження потребує перевірки' : <><Check size={14} />Відповіді збережено</>}</p>
        {confirmFinish ? <div className="teaching-test-confirm teaching-test-submit-confirm">
          <h4>Здати роботу?</h4>
          <p>Збережено відповідей {answeredCount} із {test.question_count}. {answeredCount < test.question_count && `Без відповіді залишилось ${test.question_count - answeredCount}. `}Після здачі відповіді будуть зафіксовані.</p>
          <div className="teaching-test-actions"><TeachingButton primary busy={actionBusy} disabled={saveState === 'saving'} onClick={() => void action('finish')}><Send size={16} />Так, здати роботу</TeachingButton><TeachingButton disabled={actionBusy} onClick={() => setConfirmFinish(false)}>Продовжити роботу</TeachingButton></div>
        </div> : <div className="teaching-test-navigation">
          <div>{test.allow_return && attempt.current_index > 0 && <TeachingButton disabled={actionBusy || saveState === 'saving'} onClick={() => void action('navigate', attempt.current_index - 1)}><ArrowLeft size={15} />Назад</TeachingButton>}{attempt.current_index < test.question_count - 1 && <TeachingButton disabled={actionBusy || saveState === 'saving' || !test.allow_skip && answer == null && !locked} onClick={() => void action('navigate', attempt.current_index + 1)}>Далі<ArrowRight size={15} /></TeachingButton>}{test.allow_skip && !locked && attempt.current_index < test.question_count - 1 && <TeachingButton disabled={actionBusy || saveState === 'saving'} onClick={() => void action('navigate', attempt.current_index + 1)}>Пропустити</TeachingButton>}</div>
          <div className="teaching-test-submit-action"><small>Готові передати відповіді?</small><TeachingButton primary disabled={actionBusy || saveState === 'saving'} onClick={() => setConfirmFinish(true)}><Send size={17} />Здати роботу</TeachingButton></div>
        </div>}
      </> : !error && <p className="teaching-note">Робота зараз недоступна. Оновіть дані або зверніться до викладача.</p>}
    </div>
  </TeachingModal>
}

function Rule({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="teaching-test-rule">{icon}<div><strong>{title}</strong><p>{children}</p></div></div> }

function QuestionAnswer({ question, answer, disabled, onChange }: { question: TeachingTestQuestion; answer?: Answer; disabled: boolean; onChange: (answer: Answer) => void }) {
  const [selected, setSelected] = useState('')
  const [dragged, setDragged] = useState('')
  if (question.kind === 'choice' || question.kind === 'boolean') return <div className="teaching-test-options">{question.options.map((option, index) => <button type="button" key={option.id} className="teaching-test-answer" disabled={disabled} aria-pressed={answer === option.id} onClick={() => onChange(option.id)}><span>{question.kind === 'boolean' ? option.id === 'true' ? '✓' : '×' : String.fromCharCode(65 + index)}</span><span>{option.text}</span></button>)}</div>
  if (question.kind === 'sequence') {
    const order = Array.isArray(answer) ? answer : question.options.map(option => option.id)
    const move = (id: string, target: number) => { const next = order.filter(item => item !== id); next.splice(target, 0, id); onChange(next) }
    return <><p className="mb-3 text-xs text-muted-foreground">Перетягніть елементи або скористайтеся стрілками. Якщо поточний порядок підходить, збережіть його кнопкою.</p><div className="teaching-test-sequence">{order.map((id, index) => <div className="teaching-test-sequence-row" key={id} draggable={!disabled} onDragStart={event => { setDragged(id); event.dataTransfer.setData('text/x-xelay-option', id) }} onDragOver={event => { if (!disabled) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (!disabled && dragged && order.includes(dragged)) move(dragged, index); setDragged('') }}><GripVertical size={16} aria-hidden="true" /><span>{index + 1}</span><p>{question.options.find(option => option.id === id)?.text}</p><div><button type="button" className="teaching-icon-button" disabled={disabled || !index} aria-label={`Елемент ${index + 1} вище`} onClick={() => move(id, index - 1)}><ArrowUp size={16} /></button><button type="button" className="teaching-icon-button" disabled={disabled || index === order.length - 1} aria-label={`Елемент ${index + 1} нижче`} onClick={() => move(id, index + 1)}><ArrowDown size={16} /></button></div></div>)}</div><div className="teaching-test-actions"><TeachingButton disabled={disabled} onClick={() => onChange(order)}><Check size={15} />Зберегти поточний порядок</TeachingButton></div></>
  }
  const placements = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {}
  const place = (id: string, bucket: string) => { if (disabled || !question.options.some(option => option.id === id)) return; onChange({ ...placements, [id]: bucket }); setSelected(''); setDragged('') }
  const chip = (option: TeachingTestQuestion['options'][number]) => <button key={option.id} type="button" className="teaching-test-chip" disabled={disabled} draggable={!disabled} aria-pressed={selected === option.id} onClick={() => setSelected(current => current === option.id ? '' : option.id)} onDragStart={event => { setDragged(option.id); event.dataTransfer.setData('text/x-xelay-option', option.id) }}><GripVertical size={14} aria-hidden="true" />{option.text}</button>
  return <><p className="mb-3 text-xs text-muted-foreground">Перетягніть елемент у категорію. На телефоні натисніть на елемент, потім на назву категорії.</p><div className="teaching-test-chip-list">{question.options.filter(option => !placements[option.id]).map(chip)}</div>{selected && placements[selected] && <TeachingButton disabled={disabled} onClick={() => { const next = { ...placements }; delete next[selected]; onChange(next); setSelected('') }}><Undo2 size={14} />Повернути вибраний елемент</TeachingButton>}<div className="teaching-test-buckets">{question.buckets.map(bucket => <section className="teaching-test-bucket" key={bucket.id} onDragOver={event => { if (!disabled) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (dragged) place(dragged, bucket.id) }}><h4><button type="button" className="w-full rounded-md py-2 text-left" disabled={disabled || !selected} onClick={() => place(selected, bucket.id)} aria-label={`Розмістити вибраний елемент у категорії ${bucket.text}`}>{bucket.text}{selected && <span className="ml-2 text-xs text-primary">Розмістити сюди</span>}</button></h4><div className="teaching-test-chip-list">{question.options.filter(option => placements[option.id] === bucket.id).map(chip)}</div></section>)}</div></>
}
