import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, ClipboardCheck, Clock3, GripVertical, LockKeyhole, Play, RefreshCw, Send, Trophy, Undo2 } from 'lucide-react'
import { teachingDate } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestAttempt, type TeachingTestDetail, type TeachingTestQuestion, type TeachingTestRepository } from '../../lib/teachingTests'
import { clearTeachingTestPractice, createTeachingTestPracticeRepository } from '../../lib/teachingTestPractice'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingRubricAssessment } from './TeachingRubrics'
import './teaching-tests.css'
import './teaching-assessment-phase1.css'

type Answer = TeachingTestAttempt['answers'][string]
function clock(seconds: number) { const value = Math.max(0, Math.ceil(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
function remaining(deadline: string | null | undefined, now: number) { return deadline ? Math.max(0, (new Date(deadline).getTime() - now) / 1000) : null }
function hasAnswer(answer: Answer | undefined) {
  if (answer == null || answer === '') return false
  if (typeof answer === 'string') return Boolean(answer.trim())
  return Object.values(answer).some(value => typeof value === 'string' && Boolean(value.trim()))
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
      const practice = Boolean(test.can_edit || test.can_review || test.questions.length)
      const ownAttempt = practice ? null : test.my_attempt
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
        <div className="teaching-test-actions"><TeachingButton primary={!submitted} onClick={() => setSelected(test)}><ArrowRight size={15} />{practice ? 'Пройти пробно' : submitted ? published ? 'Переглянути результат' : 'Переглянути здачу' : ownAttempt ? 'Продовжити роботу' : 'Відкрити роботу'}</TeachingButton></div>
      </article>
    })}</div>}
    {selected && <TeachingTestRunner key={`${scope}:${selected.id}`} repository={repository} testId={selected.id} groupId={groupId} userId={userId} onClose={() => { setSelected(null); void load() }} />}
  </section>
}

export function TeachingTestRunner({ repository, testId, groupId, userId, onClose }: { repository: TeachingTestRepository; testId: string; groupId: string; userId?: string; onClose: () => void }) {
  const scope = `${userId || ''}:${testId}:${groupId}`
  return <TeachingTestResolver key={scope} repository={repository} testId={testId} groupId={groupId} userId={userId} onClose={onClose} />
}

function TeachingTestResolver({ repository, testId, groupId, userId, onClose }: { repository: TeachingTestRepository; testId: string; groupId: string; userId?: string; onClose: () => void }) {
  const [resolved, setResolved] = useState<{ repository: TeachingTestRepository; detail: TeachingTestDetail; source: TeachingTest } | null>(null)
  const [error, setError] = useState(''), [generation, setGeneration] = useState(0)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setResolved(null); setError('')
    void (async () => {
      // List is read-only. Staff detail may close expired student attempts, so
      // rehearsals must never invoke it or any live mutation.
      const list = await repository.list(undefined, groupId || undefined)
      if (!active) return
      const source = list.tests.find(test => test.id === testId)
      if (!source) throw new Error('TEST_FORBIDDEN')
      const staff = Boolean(source.can_edit || source.can_review || source.questions.length)
      if (staff && !userId) throw new Error('TEST_FORBIDDEN')
      const selected = staff ? createTeachingTestPracticeRepository(source, userId!, groupId) : repository
      const detail = await selected.detail(testId)
      if (active) setResolved({ repository: selected, detail, source })
    })().catch(failure => { if (active) setError(teachingTestError(failure)) })
    return () => { active = false }
  }, [repository, testId, groupId, userId, reload, generation])
  function restart() {
    if (!resolved?.detail.practice || !userId) return
    clearTeachingTestPractice(resolved.source, userId)
    setResolved(null); setGeneration(value => value + 1)
  }
  if (!resolved) return <TeachingModal wide title="Тест" onClose={onClose}>{error ? <div role="alert" className="teaching-error"><p>{error}</p><TeachingButton onClick={() => setReload(value => value + 1)}>Спробувати ще раз</TeachingButton></div> : <p role="status">Завантажуємо роботу…</p>}</TeachingModal>
  return <TeachingTestSession key={`${generation}:${resolved.detail.practice ? 'practice' : 'student'}`} repository={resolved.repository} initialDetail={resolved.detail} testId={testId} groupId={groupId} userId={userId} onClose={onClose} onRestart={restart} />
}

function TeachingTestSession({ repository, initialDetail, testId, groupId, userId, onClose, onRestart }: { repository: TeachingTestRepository; initialDetail: TeachingTestDetail; testId: string; groupId: string; userId?: string; onClose: () => void; onRestart: () => void }) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(initialDetail), [error, setError] = useState('')
  const practice = Boolean(initialDetail.practice)
  const [actionBusy, setActionBusy] = useState(false), [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved'), [answer, setAnswer] = useState<Answer | undefined>()
  const [rulesAccepted, setRulesAccepted] = useState(false), [confirmFinish, setConfirmFinish] = useState(false), [now, setNow] = useState(Date.now())
  const dataRef = useRef<TeachingTestDetail | null>(null), pending = useRef<{ questionId: string; answer: Answer } | null>(null)
  const processing = useRef<Promise<boolean> | null>(null), actionLock = useRef(false), alive = useRef(true), serverOffset = useRef(0), expirationRead = useRef('')
  const answerTimer = useRef<number | null>(null)
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
    receive(initialDetail)
    const timer = window.setInterval(() => { if (alive.current) setNow(Date.now() - serverOffset.current) }, 250)
    const sync = window.setInterval(() => { if (dataRef.current?.attempt?.status === 'in_progress') void refresh() }, 20000)
    const online = () => { void refresh() }
    window.addEventListener('online', online)
    return () => { alive.current = false; pending.current = null; if (answerTimer.current !== null) window.clearTimeout(answerTimer.current); window.clearInterval(timer); window.clearInterval(sync); window.removeEventListener('online', online) }
  }, [repository, initialDetail, receive, refresh])
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
    if (answerTimer.current !== null) { window.clearTimeout(answerTimer.current); answerTimer.current = null }
    if (processing.current) return processing.current
    const task = (async () => {
      while (pending.current && alive.current) {
        const next = pending.current, state = dataRef.current
        if (!state?.attempt || state.attempt.status !== 'in_progress') { pending.current = null; return false }
        if (next.questionId === state.attempt.current_question?.id && ['numerical', 'calculated'].includes(state.attempt.current_question.kind) && typeof next.answer === 'string' && next.answer.trim() && !/^[-+]?[0-9]+([.,][0-9]+)?$/.test(next.answer.trim())) {
          if (alive.current) { setSaveState('failed'); setError('Допишіть числову відповідь. Можна використати знак мінус, кому або крапку для дробової частини.') }
          return false
        }
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
    if (['short_text', 'numerical', 'calculated', 'cloze', 'essay'].includes(question.kind)) {
      if (answerTimer.current !== null) window.clearTimeout(answerTimer.current)
      setSaveState('saving')
      answerTimer.current = window.setTimeout(() => { answerTimer.current = null; void flushAnswers() }, 450)
    } else void flushAnswers()
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
    setError('')
    try {
      const refreshed = await repository.detail(testId)
      const unsaved = pending.current
      if (unsaved && refreshed.attempt?.status === 'in_progress' && refreshed.attempt.current_question?.id !== unsaved.questionId) {
        setError('Запитання змінилося в іншій вкладці. Вашу незбережену відповідь залишено в полі. Скопіюйте її перед повторним відкриттям роботи.'); setSaveState('failed'); return
      }
      if (refreshed.attempt?.status !== 'in_progress') pending.current = null
      receive(refreshed)
      setSaveState(pending.current ? 'failed' : 'saved')
      if (pending.current) setError('Дані оновлено, вашу відповідь залишено в полі. Натисніть «Повторити збереження».')
    } catch (failure) { setError(teachingTestError(failure)) }
  }
  return <TeachingModal wide title={practice ? `Пробне проходження · ${test?.title || 'Тест'}` : test?.title || 'Тест'} description={test?.course_title} onClose={onClose} busy={actionBusy || saveState === 'saving'}>
    <div className="teaching-tests">
      {practice && <p className="teaching-note" role="note">Це ваше пробне проходження. Відповіді зберігаються лише в цій вкладці до 24 годин. Оцінки, журнал, бонуси та рейтинг студентів не змінюються.</p>}
      {error && <div role="alert" className="teaching-error"><p>{error}</p><div className="teaching-test-actions">{saveState === 'failed' && !locked && <TeachingButton onClick={() => void flushAnswers()}>Повторити збереження</TeachingButton>}<TeachingButton onClick={() => void retry()}><RefreshCw size={14} />Оновити дані тесту</TeachingButton></div></div>}
      {test && !attempt ? <>
        {test.description && <p className="whitespace-pre-wrap text-sm leading-relaxed">{test.description}</p>}
        <div className="teaching-test-rules"><Rule icon={<Clock3 size={20} />} title={`${test.duration_seconds / 60} хвилин на спробу`}>Відлік починається після натискання кнопки початку. Час окремих запитань буде показано під час проходження.</Rule><Rule icon={<LockKeyhole size={20} />} title={practice ? 'Можна пройти ще раз' : 'Одна особиста спроба'}>{practice ? 'Після завершення можна почати нове пробне проходження. Оновлення сторінки продовжує поточне.' : 'Після завершення повторне проходження недоступне. Оновлення сторінки продовжує поточну спробу.'}</Rule><Rule icon={<ArrowLeft size={20} />} title={test.allow_return ? 'Повернення дозволено' : 'Без повернення назад'}>{test.allow_skip ? 'Запитання можна пропускати. ' : 'Перед переходом потрібно відповісти. '}{test.question_timer_policy === 'lock_on_leave' ? 'Після переходу відповідь фіксується.' : 'Таймер відкритого запитання продовжується після переходу.'}</Rule><Rule icon={<ClipboardCheck size={20} />} title={test.restrict_copy ? 'Копіювання тексту обмежено' : 'Копіювання тексту дозволено'}>{practice ? 'Після завершення побачите автоматичний попередній результат. Відкриті відповіді автоматично не оцінюються.' : 'Після завершення відповіді перевірить викладач. Свій результат побачите після публікації балів.'}</Rule>{!practice && test.bonus_percent > 0 && <Rule icon={<Trophy size={20} />} title={`До ${test.bonus_points} бонусних балів`}>Бонус для найкращих {test.bonus_percent}% за результатом і швидкістю. Підсумок не перевищує {test.max_points} балів.</Rule>}</div>
        <p className="teaching-note">Запитань {test.question_count} · до {test.max_points} балів. {practice ? 'Пробне проходження доступне незалежно від строку публікації тесту.' : `Доступ з ${teachingDate(test.opens_at, true)} до ${teachingDate(test.closes_at, true)} за Києвом. Після завершення строку доступу робота закривається.`}</p>
        <label className="teaching-check"><input type="checkbox" checked={rulesAccepted} onChange={event => setRulesAccepted(event.target.checked)} />Я прочитав правила та готовий розпочати</label>
        <TeachingButton primary busy={actionBusy} disabled={!rulesAccepted || now < new Date(test.opens_at).getTime() || now >= new Date(test.closes_at).getTime() || test.status !== 'published'} onClick={() => void action('start')}><Play size={16} />{practice ? 'Почати пробне проходження' : 'Почати тест'}</TeachingButton>
      </> : test && attempt && terminal ? <section className="teaching-test-submitted" aria-label={practice ? 'Результат пробного проходження' : 'Підтвердження здачі роботи'} role="status">
        <span className="teaching-test-receipt-icon"><CheckCircle2 size={38} /></span>
        <p className="teaching-test-receipt-eyebrow">{practice ? 'Лише для вас' : 'Відповіді отримано'}</p>
        <h3>{practice ? 'Пробне проходження завершено' : 'Роботу здано'}</h3>
        <p className="teaching-test-receipt-description">{practice ? 'Це тренувальний результат. У журналі та рейтингу студентів нічого не змінено.' : attempt.grade_published_at ? attempt.published_absent ? 'У журналі опубліковано позначку відсутності.' : 'Викладач перевірив роботу й опублікував результат.' : 'Викладач перевірить відповіді та опублікує ваш результат. Статус роботи збережено у групі.'}</p>
        <dl className="teaching-test-receipt-details">
          <div><dt>{practice ? 'Завершено' : 'Здано'}</dt><dd>{teachingDate(attempt.submitted_at, true)}</dd></div>
          <div><dt>{practice ? 'Автоматичний результат' : 'Стан'}</dt><dd>{practice ? `${attempt.practice_score ?? attempt.auto_score ?? 0} із ${test.max_points}` : attempt.grade_published_at ? 'Результат опубліковано' : 'Очікує перевірки'}</dd></div>
          {attempt.grade_published_at && <div><dt>Ваш результат</dt><dd>{attempt.published_absent ? 'Н · відсутність' : `${attempt.published_score ?? '—'} із ${test.max_points}`}</dd></div>}
        </dl>
        {attempt.published_comment && <p className="teaching-note">{attempt.published_comment}</p>}
        {attempt.published_rubrics?.map(mark => <section key={mark.question_id} className="teaching-test-section"><h4>{mark.text}</h4><TeachingRubricAssessment rubric={mark.rubric} value={mark.levels} maximum={mark.maximum} disabled /></section>)}
        {practice && attempt.requires_manual_review && <p className="teaching-note">У тесті є відкриті відповіді. Їхні бали не включені в автоматичний результат: такі відповіді потребують перевірки викладачем.</p>}
        <div className="teaching-test-actions">{practice && <TeachingButton primary onClick={onRestart}><RefreshCw size={16} />Пройти ще раз</TeachingButton>}<TeachingButton primary={!practice} onClick={onClose}>{practice ? 'Закрити' : 'Повернутися до групи'}<ArrowRight size={16} /></TeachingButton></div>
      </section> : test && attempt && question ? <>
        <div className="teaching-test-clockbar"><div><Clock3 size={19} /><span>Залишилось на тест</span><strong data-urgent={totalLeft !== null && totalLeft < 60}>{clock(totalLeft || 0)}</strong></div>{questionLeft !== null && <div><span>На запитання</span><strong data-urgent={questionLeft < 10}>{clock(questionLeft)}</strong></div>}</div>
        <div className="teaching-test-progress" aria-label={`Запитання ${attempt.current_index + 1} із ${test.question_count}`}><span style={{ width: `${(attempt.current_index + 1) / test.question_count * 100}%` }} /></div>
        <section className="teaching-test-question" data-restrict-copy={test.restrict_copy} onCopy={event => { if (test.restrict_copy) event.preventDefault() }} onContextMenu={event => { if (test.restrict_copy) event.preventDefault() }} onKeyDown={event => { if (test.restrict_copy && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') event.preventDefault() }}>
          <span className="teaching-badge">Запитання {attempt.current_index + 1} із {test.question_count} · вага {question.points}</span><h3>{question.kind === 'cloze' ? 'Заповніть пропуски в тексті' : question.text}</h3>
          {locked && <p className="teaching-note mb-4">{questionExpired ? 'Час запитання завершився. Збережена відповідь зафіксована, можна перейти далі.' : 'Відповідь зафіксована за правилами тесту.'}</p>}
          <QuestionAnswer key={question.id} question={question} answer={answer} disabled={locked || actionBusy || totalLeft === 0} onChange={choose} />
        </section>
        <p role="status" className="teaching-test-status">{saveState === 'saving' ? 'Зберігаємо відповідь…' : saveState === 'failed' ? 'Збереження потребує перевірки' : <><Check size={14} />Відповіді збережено</>}</p>
        {confirmFinish ? <div className="teaching-test-confirm teaching-test-submit-confirm">
          <h4>{practice ? 'Завершити пробне проходження?' : 'Здати роботу?'}</h4>
          <p>Збережено відповідей {answeredCount} із {test.question_count}. {answeredCount < test.question_count && `Без відповіді залишилось ${test.question_count - answeredCount}. `}{practice ? 'Після завершення побачите тренувальний результат.' : 'Після здачі відповіді будуть зафіксовані.'}</p>
          <div className="teaching-test-actions"><TeachingButton primary busy={actionBusy} disabled={saveState === 'saving'} onClick={() => void action('finish')}><Send size={16} />{practice ? 'Так, завершити пробне проходження' : 'Так, здати роботу'}</TeachingButton><TeachingButton disabled={actionBusy} onClick={() => setConfirmFinish(false)}>Продовжити роботу</TeachingButton></div>
        </div> : <div className="teaching-test-navigation">
          <div>{test.allow_return && attempt.current_index > 0 && <TeachingButton disabled={actionBusy || saveState === 'saving'} onClick={() => void action('navigate', attempt.current_index - 1)}><ArrowLeft size={15} />Назад</TeachingButton>}{attempt.current_index < test.question_count - 1 && <TeachingButton disabled={actionBusy || saveState === 'saving' || !test.allow_skip && !hasAnswer(answer) && !locked} onClick={() => void action('navigate', attempt.current_index + 1)}>Далі<ArrowRight size={15} /></TeachingButton>}{test.allow_skip && !locked && attempt.current_index < test.question_count - 1 && <TeachingButton disabled={actionBusy || saveState === 'saving'} onClick={() => void action('navigate', attempt.current_index + 1)}>Пропустити</TeachingButton>}</div>
          <div className="teaching-test-submit-action"><small>{practice ? 'Перевірити тренувальний результат?' : 'Готові передати відповіді?'}</small><TeachingButton primary disabled={actionBusy || saveState === 'saving'} onClick={() => setConfirmFinish(true)}><Send size={17} />{practice ? 'Завершити пробне проходження' : 'Здати роботу'}</TeachingButton></div>
        </div>}
      </> : !error && <p className="teaching-note">Робота зараз недоступна. Оновіть дані або зверніться до викладача.</p>}
    </div>
  </TeachingModal>
}

function Rule({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="teaching-test-rule">{icon}<div><strong>{title}</strong><p>{children}</p></div></div> }

function QuestionAnswer({ question, answer, disabled, onChange }: { question: TeachingTestQuestion; answer?: Answer; disabled: boolean; onChange: (answer: Answer) => void }) {
  const [selected, setSelected] = useState('')
  const [dragged, setDragged] = useState('')
  if (question.kind === 'multiple') {
    const checked = Array.isArray(answer) ? answer : []
    return <><p className="mb-3 text-xs text-muted-foreground">Оберіть усі правильні відповіді.</p><div className="teaching-test-options">{question.options.map((option, index) => <button type="button" key={option.id} className="teaching-test-answer" disabled={disabled} aria-pressed={checked.includes(option.id)} onClick={() => onChange(checked.includes(option.id) ? checked.filter(id => id !== option.id) : [...checked, option.id])}><span>{checked.includes(option.id) ? <Check size={16} /> : String.fromCharCode(65 + index)}</span><span>{option.text}</span></button>)}</div></>
  }
  if (['short_text', 'numerical', 'calculated'].includes(question.kind)) return <TeachingField label={question.kind === 'short_text' ? 'Ваша відповідь' : 'Ваш числовий результат'} hint={question.kind === 'short_text' ? 'Впишіть коротку відповідь.' : 'Введіть число. Для дробової частини можна використати кому або крапку.'}><input className={teachingInput} type="text" inputMode={question.kind === 'short_text' ? 'text' : 'decimal'} maxLength={question.kind === 'short_text' ? 2000 : 100} disabled={disabled} value={typeof answer === 'string' ? answer : ''} autoComplete="off" onChange={event => onChange(event.target.value)} /></TeachingField>
  if (question.kind === 'essay') return <><TeachingField label="Ваша розгорнута відповідь" hint="Відповідь перевірить викладач. Вона зберігається під час введення."><textarea className={teachingInput} rows={9} maxLength={10000} disabled={disabled} value={typeof answer === 'string' ? answer : ''} onChange={event => onChange(event.target.value)} /></TeachingField><p className="text-xs text-muted-foreground">{typeof answer === 'string' ? answer.length : 0} із 10 000 символів</p></>
  if (question.kind === 'cloze') {
    const values = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {}
    const parts = question.text.split(/(\{\{[A-Za-z0-9_-]+\}\})/g)
    let gapIndex = 0
    return <div className="teaching-cloze-answer">{parts.map((part, index) => { const match = /^\{\{([A-Za-z0-9_-]+)\}\}$/.exec(part); if (!match) return <span key={index}>{part}</span>; const id = match[1]; const number = ++gapIndex; return <input key={index} aria-label={`Пропуск ${number}`} className={teachingInput} type="text" maxLength={2000} autoComplete="off" disabled={disabled} value={values[id] || ''} onChange={event => onChange({ ...values, [id]: event.target.value })} /> })}</div>
  }
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
