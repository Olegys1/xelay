import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, ClipboardCheck, Clock3, GripVertical, LockKeyhole, Maximize, Play, RefreshCw, Send, Trophy, Undo2 } from 'lucide-react'
import { teachingDate } from '../../lib/teaching'
import { formatTeachingTestWatermark, teachingTestError, type TeachingTest, type TeachingTestAttempt, type TeachingTestDetail, type TeachingTestOption, type TeachingTestQuestion, type TeachingTestRepository } from '../../lib/teachingTests'
import { clearTeachingTestPractice, createTeachingTestPracticeRepository } from '../../lib/teachingTestPractice'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingRubricAssessment } from './TeachingRubrics'
import { TeachingTestQuestionImages } from './TeachingTestQuestionImages'
import { TeachingTestContent } from './TeachingTestContent'
import { useTeachingTestTabGuard } from './useTeachingTestTabGuard'
import './teaching-tests.css'
import './teaching-assessment-phase1.css'

type Answer = TeachingTestAttempt['answers'][string]
type TeachingTestSessionRepository = Pick<TeachingTestRepository, 'detail' | 'mutate'>
type PendingAnswer = { attemptId: string; questionId: string; answer: Answer }
function clock(seconds: number) { const value = Math.max(0, Math.ceil(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
function remaining(deadline: string | null | undefined, now: number) { return deadline ? Math.max(0, (new Date(deadline).getTime() - now) / 1000) : null }
function hasAnswer(answer: Answer | undefined) {
  if (answer == null || answer === '') return false
  if (typeof answer === 'string') return Boolean(answer.trim())
  return Object.values(answer).some(value => typeof value === 'string' && Boolean(value.trim()))
}

function sameAnswer(saved: Answer | undefined, answer: Answer) {
  if (saved === answer) return true
  if (!saved || typeof saved !== 'object' || typeof answer !== 'object' || Array.isArray(saved) !== Array.isArray(answer)) return false
  const savedEntries = new Map(Object.entries(saved)), entries = Object.entries(answer)
  return savedEntries.size === entries.length && entries.every(([key, value]) => savedEntries.get(key) === value)
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
      const qa = test.qa_can_start === true && Boolean(repository.qaStudent)
      const practice = !qa && Boolean(test.can_edit || test.can_review || test.questions.length)
      const ownAttempt = practice ? null : test.my_attempt
      const notAdmitted = !practice && test.my_admission?.allowed === false
      const submitted = ownAttempt?.status === 'submitted'
      const published = Boolean(ownAttempt?.grade_published_at)
      return <article className="teaching-card teaching-student-test-card" key={test.id}>
        <div className="teaching-test-heading">
          <span className="teaching-badge">{test.course_title || 'Робота викладача'}</span>
          {test.qa_own_attempt && <span className="teaching-badge">Тестовий режим · ооо 1</span>}
          {submitted && <span className="teaching-test-submitted-badge"><CheckCircle2 size={15} />Роботу здано</span>}
          {ownAttempt?.status === 'in_progress' && <span className="teaching-badge"><Clock3 size={14} />Виконуєте</span>}
          {notAdmitted && <span className="teaching-badge"><LockKeyhole size={14} />Немає допуску</span>}
        </div>
        <h3 className="mt-3 text-lg font-semibold">{test.title}</h3>
        <div className="teaching-test-meta">{!notAdmitted && <span><ClipboardCheck size={14} />Запитань {test.question_count}</span>}<span><Clock3 size={14} />{test.duration_seconds / 60} хв</span><span>До {test.max_points} балів</span></div>
        <p className="text-xs text-muted-foreground">Доступ з {teachingDate(test.opens_at, true)} до {teachingDate(test.closes_at, true)}</p>
        {submitted && <p className="teaching-student-test-receipt">Здано {teachingDate(ownAttempt.submitted_at, true)} · {published ? ownAttempt.published_absent ? 'Позначено відсутність · Н' : `Результат ${ownAttempt.published_score ?? '—'} із ${test.max_points}` : 'Очікує перевірки викладача'}</p>}
        <div className="teaching-test-actions"><TeachingButton primary={!submitted && !notAdmitted} onClick={() => setSelected(test)}><ArrowRight size={15} />{practice ? 'Пройти пробно' : notAdmitted ? 'Переглянути допуск' : submitted ? published ? 'Переглянути результат' : 'Переглянути здачу' : ownAttempt ? 'Продовжити роботу' : qa ? 'Скласти як студент' : 'Відкрити роботу'}</TeachingButton></div>
      </article>
    })}</div>}
    {selected && <TeachingTestRunner key={`${scope}:${selected.id}`} repository={repository} testId={selected.id} groupId={groupId} userId={userId} qa={selected.qa_can_start === true && Boolean(repository.qaStudent)} onClose={() => { setSelected(null); void load() }} />}
  </section>
}

export function TeachingTestRunner({ repository, testId, groupId, userId, qa = false, onClose }: { repository: TeachingTestRepository; testId: string; groupId: string; userId?: string; qa?: boolean; onClose: () => void }) {
  const scope = `${userId || ''}:${testId}:${groupId}:${qa}`
  return <TeachingTestResolver key={scope} repository={repository} testId={testId} groupId={groupId} userId={userId} qa={qa} onClose={onClose} />
}

function TeachingTestResolver({ repository, testId, groupId, userId, qa = false, onClose }: { repository: TeachingTestRepository; testId: string; groupId: string; userId?: string; qa?: boolean; onClose: () => void }) {
  const [resolved, setResolved] = useState<{ repository: TeachingTestSessionRepository; detail: TeachingTestDetail; source: TeachingTest } | null>(null)
  const [error, setError] = useState(''), [generation, setGeneration] = useState(0)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setResolved(null); setError('')
    void (async () => {
      if (qa) {
        const qaStudent = repository.qaStudent
        if (!userId || !groupId || !qaStudent) throw new Error('TEST_FORBIDDEN')
        const scope = { id: testId, group_id: groupId, expected_user_id: userId }
        const selected: TeachingTestSessionRepository = {
          detail: () => qaStudent('detail', scope),
          mutate: (action, payload) => {
            if (action === 'start' || action === 'save_answer' || action === 'navigate' || action === 'finish' || action === 'record_tab_exit') {
              return qaStudent(action, { ...payload, ...scope })
            }
            return Promise.reject(new Error('TEST_FORBIDDEN'))
          },
        }
        const detail = await selected.detail(testId)
        if (active) setResolved({ repository: selected, detail, source: detail.test })
        return
      }
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
  }, [repository, testId, groupId, userId, qa, reload, generation])
  function restart() {
    if (!resolved?.detail.practice || !userId) return
    clearTeachingTestPractice(resolved.source, userId)
    setResolved(null); setGeneration(value => value + 1)
  }
  if (!resolved) return <TeachingModal wide title="Тест" onClose={onClose}>{error ? <div role="alert" className="teaching-error"><p>{error}</p><TeachingButton onClick={() => setReload(value => value + 1)}>Спробувати ще раз</TeachingButton></div> : <p role="status">Завантажуємо роботу…</p>}</TeachingModal>
  return <TeachingTestSession key={`${generation}:${resolved.detail.practice ? 'practice' : 'student'}`} repository={resolved.repository} initialDetail={resolved.detail} testId={testId} groupId={groupId} userId={userId} qa={qa} onClose={onClose} onRestart={restart} />
}

function TeachingTestSession({ repository, initialDetail, testId, groupId, userId, qa = false, onClose, onRestart }: { repository: TeachingTestSessionRepository; initialDetail: TeachingTestDetail; testId: string; groupId: string; userId?: string; qa?: boolean; onClose: () => void; onRestart: () => void }) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(initialDetail), [error, setError] = useState('')
  const practice = Boolean(initialDetail.practice)
  const [actionBusy, setActionBusy] = useState(false), [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved'), [answer, setAnswer] = useState<Answer | undefined>()
  const [rulesAccepted, setRulesAccepted] = useState(false), [confirmFinish, setConfirmFinish] = useState(false), [now, setNow] = useState(Date.now())
  const [accessCode, setAccessCode] = useState('')
  const dataRef = useRef<TeachingTestDetail | null>(null), pending = useRef<PendingAnswer | null>(null)
  const processing = useRef<Promise<boolean> | null>(null), actionLock = useRef(false), alive = useRef(true), serverOffset = useRef(0), expirationRead = useRef('')
  const answerTimer = useRef<number | null>(null)
  const fullscreenRoot = useRef<HTMLDivElement>(null)
  const fullscreenRequest = useRef<HTMLElement | null>(null)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const leaveFullscreen = useCallback(() => {
    const target = fullscreenRequest.current
    fullscreenRequest.current = null
    if (target && document.fullscreenElement === target) void document.exitFullscreen().catch(() => {})
  }, [])
  useEffect(() => {
    const changed = () => setNativeFullscreen(Boolean(fullscreenRoot.current && document.fullscreenElement === fullscreenRoot.current))
    document.addEventListener('fullscreenchange', changed)
    return () => { document.removeEventListener('fullscreenchange', changed); leaveFullscreen() }
  }, [leaveFullscreen])
  function enterFullscreen() {
    const target = fullscreenRoot.current
    if (!target?.requestFullscreen || document.fullscreenEnabled === false || document.fullscreenElement) return
    fullscreenRequest.current = target
    void target.requestFullscreen().then(() => {
      if (fullscreenRequest.current !== target && document.fullscreenElement === target) void document.exitFullscreen().catch(() => {})
    }).catch(() => { if (fullscreenRequest.current === target) fullscreenRequest.current = null })
  }
  const receive = useCallback((value: TeachingTestDetail) => {
    const current = dataRef.current
    if (current?.attempt && value.test.id === current.test.id && (!value.attempt || value.attempt.id === current.attempt.id && value.attempt.version < current.attempt.version)) return
    if (value.attempt && value.attempt.id === current?.attempt?.id && (value.attempt.tab_exit_count ?? 0) < (current.attempt.tab_exit_count ?? 0)) {
      value = { ...value, attempt: { ...value.attempt, tab_exit_count: current.attempt.tab_exit_count } }
    }
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
  useEffect(() => { if (terminal) leaveFullscreen() }, [terminal, leaveFullscreen])
  const questionCount = attempt?.question_count ?? test?.question_count ?? 0
  const needsCode = Boolean(!practice && test?.require_access_code && !attempt)
  const guardScope = test?.restrict_tab_switch && attempt && !terminal ? `${attempt.user_id}:${attempt.id}` : undefined
  const tabGuard = useTeachingTestTabGuard(guardScope, () => !actionLock.current, reportTabExit)
  const answeredCount = attempt ? Object.values(attempt.answers).filter(hasAnswer).length : 0
  useEffect(() => {
    if (!attempt || terminal || totalLeft === null || totalLeft > 0) return
    const key = `${attempt.id}:${attempt.expires_at}`
    if (expirationRead.current === key || actionBusy || saveState === 'saving') return
    expirationRead.current = key; void refresh()
  }, [attempt?.id, attempt?.expires_at, terminal, totalLeft, refresh, actionBusy, saveState])

  function confirmClosedSave(attempt: TeachingTestAttempt | null | undefined, last: PendingAnswer) {
    pending.current = null
    const saved = attempt?.id === last.attemptId && sameAnswer(attempt.answers[last.questionId], last.answer)
    if (alive.current) {
      setSaveState(saved ? 'saved' : 'failed')
      if (!saved) setError('Останню відповідь не збережено. Спробу вже завершено.')
    }
    return saved
  }
  async function flushAnswers(): Promise<boolean> {
    if (answerTimer.current !== null) { window.clearTimeout(answerTimer.current); answerTimer.current = null }
    if (processing.current) return processing.current
    const task = (async () => {
      while (pending.current && alive.current) {
        const next = pending.current, state = dataRef.current
        if (!state?.attempt || state.attempt.status !== 'in_progress') return confirmClosedSave(state?.attempt, next)
        if (state.attempt.id !== next.attemptId) {
          if (alive.current) { setSaveState('failed'); setError('Відкрито іншу спробу. Скопіюйте незбережену відповідь перед повторним відкриттям тесту.') }
          return false
        }
        if (next.questionId === state.attempt.current_question?.id && ['numerical', 'calculated'].includes(state.attempt.current_question.kind) && typeof next.answer === 'string' && next.answer.trim() && !/^[-+]?[0-9]+([.,][0-9]+)?$/.test(next.answer.trim())) {
          if (alive.current) { setSaveState('failed'); setError('Допишіть числову відповідь. Можна використати знак мінус, кому або крапку для дробової частини.') }
          return false
        }
        pending.current = null
        if (alive.current) { setSaveState('saving'); setError('') }
        try {
          const result = await repository.mutate('save_answer', { id: testId, expected_user_id: state.attempt.user_id, version: state.attempt.version, question_id: next.questionId, answer: next.answer })
          receive(result)
          if (result.attempt?.status === 'submitted') return confirmClosedSave(result.attempt, pending.current ?? next)
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
  async function reportTabExit(eventId: string): Promise<boolean> {
    if (!alive.current) return false
    const current = dataRef.current?.attempt
    if (current?.status !== 'in_progress') return true
    actionLock.current = true
    try {
      if (pending.current || processing.current) await flushAnswers()
      if (!alive.current) return false
      const result = await repository.mutate('record_tab_exit', { id: testId, attempt_id: current.id, expected_user_id: current.user_id, event_id: eventId })
      if (result.attempt?.status === 'submitted') { pending.current = null; setConfirmFinish(false); setSaveState('saved'); setError('') }
      receive(result)
      return true
    } catch (failure) {
      if (alive.current) setError(teachingTestError(failure))
      return false
    } finally { actionLock.current = false }
  }
  function choose(value: Answer) {
    if (!attempt || !question || locked || actionLock.current || tabGuard.hasPending() || terminal) return
    setAnswer(value); setConfirmFinish(false)
    pending.current = { attemptId: attempt.id, questionId: question.id, answer: value }
    const serverNow = Date.now() - serverOffset.current
    const timeLeft = Math.min(remaining(attempt.expires_at, serverNow) ?? Infinity, remaining(attempt.question_expires_at, serverNow) ?? Infinity)
    // Keep enough time to send the last edit even when only the question timer is expiring.
    if (timeLeft > 1.5 && ['short_text', 'numerical', 'calculated', 'cloze', 'essay'].includes(question.kind)) {
      if (answerTimer.current !== null) window.clearTimeout(answerTimer.current)
      setSaveState('saving')
      answerTimer.current = window.setTimeout(() => { answerTimer.current = null; void flushAnswers() }, 450)
    } else void flushAnswers()
  }
  async function action(name: 'start' | 'navigate' | 'finish', index?: number) {
    if (actionLock.current || tabGuard.hasPending()) return
    actionLock.current = true; setActionBusy(true); setError('')
    try {
      if (name !== 'start') {
        if (pending.current && locked) pending.current = null
        if (!await flushAnswers()) return
      }
      if (!alive.current) return
      const current = dataRef.current
      if (name === 'start' && current?.test.my_admission?.allowed === false) throw new Error('TEST_NOT_ADMITTED')
      const result = await repository.mutate(name, { id: testId, expected_user_id: current?.attempt?.user_id || userId, group_id: groupId, ...(current?.attempt ? { version: current.attempt.version } : {}), ...(index == null ? {} : { index }), ...(name === 'start' && needsCode ? { access_code: accessCode } : {}) })
      if (name === 'start') setAccessCode('')
      pending.current = null; receive(result); setConfirmFinish(false); setSaveState('saved')
    } catch (failure) {
      if (name === 'start') leaveFullscreen()
      setError(teachingTestError(failure))
    }
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
  const inProgress = Boolean(attempt && !terminal)
  const allowExternalLinks = Boolean(test?.allow_external_links)
  return <TeachingModal wide viewport={inProgress} title={practice ? `Пробне проходження · ${test?.title || 'Тест'}` : qa ? `Тестова спроба · ${test?.title || 'Тест'}` : test?.title || 'Тест'} description={test?.course_title} onClose={onClose} busy={Boolean(guardScope) || actionBusy || saveState === 'saving'}>
    <div ref={fullscreenRoot} className="teaching-test-screen" data-active={inProgress || undefined}>
    <div className="teaching-tests teaching-test-screen-content">
      {practice && <p className="teaching-note" role="note">Це ваше пробне проходження. Відповіді зберігаються лише в цій вкладці до 24 годин. Оцінки, журнал, бонуси та рейтинг студентів не змінюються.</p>}
      {qa && <p className="teaching-note" role="note">Це тестова спроба в «ооо 1». Відповіді зберігаються на сервері. Опублікований тестовий бал видно тут, окремо від журналу.</p>}
      {error && <div role="alert" className="teaching-error"><p>{error}</p><div className="teaching-test-actions">{saveState === 'failed' && !terminal && !locked && <TeachingButton onClick={() => void flushAnswers()}>Повторити збереження</TeachingButton>}<TeachingButton onClick={() => void retry()}><RefreshCw size={14} />Оновити дані тесту</TeachingButton></div></div>}
      {test && !attempt && test.my_admission?.allowed === false ? <section className="teaching-card" role="status"><LockKeyhole size={25} /><h3>Викладач поки не допустив вас до тесту</h3><p className="whitespace-pre-wrap">{test.my_admission.reason || 'Зверніться до викладача, щоб уточнити умови допуску.'}</p><p className="teaching-note">Спробу не розпочато. Після зміни допуску оновіть дані тесту.</p><TeachingButton disabled={actionBusy} onClick={() => void refresh()}><RefreshCw size={15} />Перевірити допуск</TeachingButton></section> : test && !attempt ? <>
        {test.description && <p className="whitespace-pre-wrap text-sm leading-relaxed">{test.description}</p>}
        <div className="teaching-test-rules"><Rule icon={<Clock3 size={20} />} title={`${test.duration_seconds / 60} хвилин на спробу`}>Відлік починається після натискання кнопки початку. Час окремих запитань буде показано під час проходження.</Rule><Rule icon={<LockKeyhole size={20} />} title={practice ? 'Можна пройти ще раз' : 'Одна особиста спроба'}>{practice ? 'Після завершення можна почати нове пробне проходження. Оновлення сторінки продовжує поточне.' : 'Після завершення повторне проходження недоступне. Оновлення сторінки продовжує поточну спробу.'}</Rule><Rule icon={<ArrowLeft size={20} />} title={test.allow_return ? 'Повернення дозволено' : 'Без повернення назад'}>{test.allow_skip ? 'Запитання можна пропускати. ' : 'Перед переходом потрібно відповісти. '}{test.question_timer_policy === 'lock_on_leave' ? 'Після переходу відповідь фіксується.' : 'Таймер відкритого запитання продовжується після переходу.'}</Rule><Rule icon={<ClipboardCheck size={20} />} title={test.restrict_copy ? 'Копіювання тексту обмежено' : 'Копіювання тексту дозволено'}>{practice ? 'Після завершення побачите автоматичний попередній результат. Відкриті відповіді автоматично не оцінюються.' : 'Після завершення відповіді перевірить викладач. Свій результат побачите після публікації балів.'}</Rule>{!practice && test.bonus_percent > 0 && <Rule icon={<Trophy size={20} />} title={`До ${test.bonus_points} бонусних балів`}>Бонус для найкращих {test.bonus_percent}% за результатом і швидкістю. Підсумок не перевищує {test.max_points} балів.</Rule>}</div>
        <p className="teaching-note">Запитань {test.question_count} · до {test.max_points} балів. {practice ? 'Пробне проходження доступне незалежно від строку публікації тесту.' : `Доступ з ${teachingDate(test.opens_at, true)} до ${teachingDate(test.closes_at, true)} за Києвом. Після завершення строку доступу робота закривається.`}</p>
        {test.restrict_tab_switch && <p className="teaching-note">Залишайтеся у вкладці тесту. Перший вихід викликає попередження, другий автоматично здає роботу. Перехід в інший застосунок або згортання браузера також може зарахуватися.</p>}
        {allowExternalLinks && <p className="teaching-note">Викладач дозволив зовнішні посилання. Вони відкриваються в новій вкладці, а таймер продовжує відлік.{test.restrict_tab_switch && ' Контроль виходів застосовується і до цих переходів.'}</p>}
        {test.discourage_capture && <p className="teaching-note">Під час тесту на запитаннях буде позначка вашої спроби.</p>}
        {needsCode && <TeachingField label="Код від викладача"><input className={teachingInput} type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={8} value={accessCode} onChange={event => setAccessCode(event.target.value.toUpperCase().replace(/[^0-9A-F]/g, ''))} /></TeachingField>}
        <label className="teaching-check"><input type="checkbox" checked={rulesAccepted} onChange={event => setRulesAccepted(event.target.checked)} />Я прочитав правила та готовий розпочати</label>
        <TeachingButton primary busy={actionBusy} disabled={!rulesAccepted || (needsCode && accessCode.length !== 8) || now < new Date(test.opens_at).getTime() || now >= new Date(test.closes_at).getTime() || test.status !== 'published'} onClick={() => { if (actionLock.current) return; enterFullscreen(); void action('start') }}><Play size={16} />{practice ? 'Почати пробне проходження' : 'Почати тест'}</TeachingButton>
      </> : test && attempt && terminal ? <section className="teaching-test-submitted" aria-label={practice ? 'Результат пробного проходження' : 'Підтвердження здачі роботи'} role="status">
        <span className="teaching-test-receipt-icon"><CheckCircle2 size={38} /></span>
        <p className="teaching-test-receipt-eyebrow">{practice ? 'Лише для вас' : 'Відповіді отримано'}</p>
        <h3>{practice ? 'Пробне проходження завершено' : 'Роботу здано'}</h3>
        {attempt.completion_reason === 'tab_switch' && <p className="teaching-note">Роботу автоматично здано після другого виходу із вкладки.</p>}
        <p className="teaching-test-receipt-description">{practice ? 'Це тренувальний результат. У журналі та рейтингу студентів нічого не змінено.' : qa ? attempt.grade_published_at ? 'Тестовий бал опубліковано для цього акаунта.' : 'Спробу збережено. Опублікуйте тестовий бал після перевірки.' : attempt.grade_published_at ? attempt.published_absent ? 'У журналі опубліковано позначку відсутності.' : 'Викладач перевірив роботу й опублікував результат.' : 'Викладач перевірить відповіді та опублікує ваш результат. Статус роботи збережено у групі.'}</p>
        <dl className="teaching-test-receipt-details">
          <div><dt>{practice ? 'Завершено' : 'Здано'}</dt><dd>{teachingDate(attempt.submitted_at, true)}</dd></div>
          <div><dt>{practice ? 'Автоматичний результат' : 'Стан'}</dt><dd>{practice ? `${attempt.practice_score ?? attempt.auto_score ?? 0} із ${test.max_points}` : attempt.grade_published_at ? 'Результат опубліковано' : 'Очікує перевірки'}</dd></div>
          {attempt.grade_published_at && <div><dt>{qa ? 'Ваш тестовий бал' : 'Ваш результат'}</dt><dd>{attempt.published_absent ? 'Н · відсутність' : `${attempt.published_score ?? '—'} із ${test.max_points}`}</dd></div>}
        </dl>
        {attempt.published_comment && <p className="teaching-note">{attempt.published_comment}</p>}
        {attempt.published_rubrics?.map(mark => <section key={mark.question_id} className="teaching-test-section"><h4>{mark.text}</h4><TeachingRubricAssessment rubric={mark.rubric} value={mark.levels} maximum={mark.maximum} disabled /></section>)}
        {practice && attempt.requires_manual_review && <p className="teaching-note">У тесті є відкриті відповіді. Їхні бали не включені в автоматичний результат: такі відповіді потребують перевірки викладачем.</p>}
        <div className="teaching-test-actions">{practice && <TeachingButton primary onClick={onRestart}><RefreshCw size={16} />Пройти ще раз</TeachingButton>}<TeachingButton primary={!practice} onClick={onClose}>{practice ? 'Закрити' : 'Повернутися до групи'}<ArrowRight size={16} /></TeachingButton></div>
      </section> : test && attempt && question ? <>
        <header className="teaching-test-screen-header">
          <div className="teaching-test-clockbar">
            <div className="teaching-test-screen-title"><span>{practice ? 'ПРОБНЕ ПРОХОДЖЕННЯ' : test.course_title || 'ТЕСТ XELAY'}</span><strong>{test.title}</strong></div>
            <div><Clock3 size={19} aria-hidden="true" /><span>На тест</span><strong data-urgent={totalLeft !== null && totalLeft < 60}>{clock(totalLeft || 0)}</strong></div>
            {questionLeft !== null && <div><span>На запитання</span><strong data-urgent={questionLeft < 10}>{clock(questionLeft)}</strong></div>}
            {!nativeFullscreen && <button type="button" className="teaching-icon-button" onClick={enterFullscreen} aria-label="Розгорнути на весь екран" title="Розгорнути на весь екран"><Maximize size={17} /></button>}
          </div>
          <div className="teaching-test-screen-progress"><span>Запитання {attempt.current_index + 1} з {questionCount}</span><span>Відповіли на {answeredCount} з {questionCount}</span><div className="teaching-test-progress" role="progressbar" aria-label="Збережені відповіді" aria-valuenow={answeredCount} aria-valuemin={0} aria-valuemax={questionCount}><span style={{ width: `${answeredCount / questionCount * 100}%` }} /></div></div>
        </header>
        {test.restrict_tab_switch && (tabGuard.pendingCount > 0 || attempt.tab_exit_count === 1) && <div role="alert" className="teaching-error">{tabGuard.pendingCount ? 'Перевіряємо стан спроби. Залишайтеся у вкладці.' : 'Ви залишили вкладку тесту. Наступний вихід автоматично здасть роботу.'}</div>}
        <section className="teaching-test-question" data-capture-deterrent={test.discourage_capture || undefined} data-restrict-copy={test.restrict_copy} onCopy={event => { if (test.restrict_copy) event.preventDefault() }} onContextMenu={event => { if (test.restrict_copy) event.preventDefault() }} onKeyDown={event => { if (test.restrict_copy && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') event.preventDefault() }}>
          {test.discourage_capture && <div className="teaching-test-watermark" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(index => <span key={index}>{formatTeachingTestWatermark(attempt)}</span>)}</div>}
          <span className="teaching-badge">Вага запитання · {question.points}</span><h3>{question.kind === 'cloze' ? 'Заповніть пропуски в тексті' : <TeachingTestContent text={question.text} allowExternalLinks={allowExternalLinks} />}</h3>
          <TeachingTestQuestionImages key={question.id} images={question.images} eager />
          {locked && <p className="teaching-note mb-4">{questionExpired ? 'Час запитання завершився. Збережена відповідь зафіксована, можна перейти далі.' : 'Відповідь зафіксована за правилами тесту.'}</p>}
          <QuestionAnswer key={question.id} question={question} answer={answer} disabled={locked || actionBusy || tabGuard.pendingCount > 0 || totalLeft === 0} allowExternalLinks={allowExternalLinks} onChange={choose} />
        </section>
        <p role="status" className="teaching-test-status">{saveState === 'saving' ? 'Зберігаємо відповідь…' : saveState === 'failed' ? 'Збереження потребує перевірки' : <><Check size={14} />Відповіді збережено</>}</p>
        {confirmFinish ? <div className="teaching-test-confirm teaching-test-submit-confirm">
          <h4>{practice ? 'Завершити пробне проходження?' : 'Здати роботу?'}</h4>
          <p>Збережено відповідей {answeredCount} із {questionCount}. {answeredCount < questionCount && `Без відповіді залишилось ${questionCount - answeredCount}. `}{practice ? 'Після завершення побачите тренувальний результат.' : 'Після здачі відповіді будуть зафіксовані.'}</p>
          <div className="teaching-test-actions"><TeachingButton primary busy={actionBusy} disabled={tabGuard.pendingCount > 0 || saveState === 'saving'} onClick={() => void action('finish')}><Send size={16} />{practice ? 'Так, завершити пробне проходження' : 'Так, здати роботу'}</TeachingButton><TeachingButton disabled={actionBusy} onClick={() => setConfirmFinish(false)}>Продовжити роботу</TeachingButton></div>
        </div> : <div className="teaching-test-navigation">
          <div>{test.allow_return && attempt.current_index > 0 && <TeachingButton disabled={actionBusy || tabGuard.pendingCount > 0 || saveState === 'saving'} onClick={() => void action('navigate', attempt.current_index - 1)}><ArrowLeft size={15} />Назад</TeachingButton>}{attempt.current_index < questionCount - 1 && <TeachingButton disabled={actionBusy || tabGuard.pendingCount > 0 || saveState === 'saving' || !test.allow_skip && !hasAnswer(answer) && !locked} onClick={() => void action('navigate', attempt.current_index + 1)}>Далі<ArrowRight size={15} /></TeachingButton>}{test.allow_skip && !locked && attempt.current_index < questionCount - 1 && <TeachingButton disabled={actionBusy || tabGuard.pendingCount > 0 || saveState === 'saving'} onClick={() => void action('navigate', attempt.current_index + 1)}>Пропустити</TeachingButton>}</div>
          <div className="teaching-test-submit-action"><small>{practice ? 'Перевірити тренувальний результат?' : 'Готові передати відповіді?'}</small><TeachingButton primary disabled={actionBusy || tabGuard.pendingCount > 0 || saveState === 'saving'} onClick={() => setConfirmFinish(true)}><Send size={17} />{practice ? 'Завершити пробне проходження' : 'Здати роботу'}</TeachingButton></div>
        </div>}
      </> : !error && <p className="teaching-note">Робота зараз недоступна. Оновіть дані або зверніться до викладача.</p>}
    </div>
    </div>
  </TeachingModal>
}

function Rule({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="teaching-test-rule">{icon}<div><strong>{title}</strong><p>{children}</p></div></div> }

function AnswerOption({ option, marker, pressed, disabled, allowExternalLinks, onChoose }: {
  option: TeachingTestOption; marker: string; pressed: boolean; disabled: boolean; allowExternalLinks: boolean; onChoose: () => void
}) {
  return <div className="teaching-test-answer-card" data-pressed={pressed} data-disabled={disabled}>
    <span className="teaching-test-answer-marker" aria-hidden="true">{pressed ? <Check size={17} /> : marker}</span>
    <div className="teaching-test-answer-content">
      {option.text && <TeachingTestContent text={option.text} allowExternalLinks={allowExternalLinks} />}
      <TeachingTestQuestionImages images={option.images} eager compact />
    </div>
    <button type="button" className="teaching-test-answer-hit" aria-label={`Варіант ${marker} · ${option.text || option.images?.[0]?.alt || 'Зображення'}`} aria-pressed={pressed} disabled={disabled} onClick={onChoose} />
  </div>
}

function QuestionAnswer({ question, answer, disabled, allowExternalLinks, onChange }: { question: TeachingTestQuestion; answer?: Answer; disabled: boolean; allowExternalLinks: boolean; onChange: (answer: Answer) => void }) {
  const [selected, setSelected] = useState('')
  const [dragged, setDragged] = useState('')
  if (question.kind === 'multiple') {
    const checked = Array.isArray(answer) ? answer : []
    return <><p className="mb-3 text-xs text-muted-foreground">Оберіть усі правильні відповіді.</p><div className="teaching-test-options">{question.options.map((option, index) => <AnswerOption key={option.id} option={option} marker={String.fromCharCode(65 + index)} disabled={disabled} allowExternalLinks={allowExternalLinks} pressed={checked.includes(option.id)} onChoose={() => onChange(checked.includes(option.id) ? checked.filter(id => id !== option.id) : [...checked, option.id])} />)}</div></>
  }
  if (['short_text', 'numerical', 'calculated'].includes(question.kind)) return <TeachingField label={question.kind === 'short_text' ? 'Ваша відповідь' : 'Ваш числовий результат'} hint={question.kind === 'short_text' ? 'Впишіть коротку відповідь.' : 'Введіть число. Для дробової частини можна використати кому або крапку.'}><input className={teachingInput} type="text" inputMode={question.kind === 'short_text' ? 'text' : 'decimal'} maxLength={question.kind === 'short_text' ? 2000 : 100} disabled={disabled} value={typeof answer === 'string' ? answer : ''} autoComplete="off" onChange={event => onChange(event.target.value)} /></TeachingField>
  if (question.kind === 'essay') return <><TeachingField label="Ваша розгорнута відповідь" hint="Відповідь перевірить викладач. Вона зберігається під час введення."><textarea className={teachingInput} rows={9} maxLength={10000} disabled={disabled} value={typeof answer === 'string' ? answer : ''} onChange={event => onChange(event.target.value)} /></TeachingField><p className="text-xs text-muted-foreground">{typeof answer === 'string' ? answer.length : 0} із 10 000 символів</p></>
  if (question.kind === 'cloze') {
    const values = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {}
    const parts = question.text.split(/(\{\{[A-Za-z0-9_-]+\}\})/g)
    let gapIndex = 0
    return <div className="teaching-cloze-answer">{parts.map((part, index) => { const match = /^\{\{([A-Za-z0-9_-]+)\}\}$/.exec(part); if (!match) return <TeachingTestContent key={index} text={part} allowExternalLinks={allowExternalLinks} />; const id = match[1]; const number = ++gapIndex; return <input key={index} aria-label={`Пропуск ${number}`} className={teachingInput} type="text" maxLength={2000} autoComplete="off" disabled={disabled} value={values[id] || ''} onChange={event => onChange({ ...values, [id]: event.target.value })} /> })}</div>
  }
  if (question.kind === 'choice' || question.kind === 'boolean') return <div className="teaching-test-options">{question.options.map((option, index) => <AnswerOption key={option.id} option={option} marker={question.kind === 'boolean' ? option.id === 'true' ? '✓' : '×' : String.fromCharCode(65 + index)} disabled={disabled} allowExternalLinks={allowExternalLinks} pressed={answer === option.id} onChoose={() => onChange(option.id)} />)}</div>
  if (question.kind === 'sequence') {
    const order = Array.isArray(answer) ? answer : question.options.map(option => option.id)
    const move = (id: string, target: number) => { const next = order.filter(item => item !== id); next.splice(target, 0, id); onChange(next) }
    return <><p className="mb-3 text-xs text-muted-foreground">Перетягніть елементи або скористайтеся стрілками. Якщо поточний порядок підходить, збережіть його кнопкою.</p><div className="teaching-test-sequence">{order.map((id, index) => <div className="teaching-test-sequence-row" key={id} draggable={!disabled} onDragStart={event => { setDragged(id); event.dataTransfer.setData('text/x-xelay-option', id) }} onDragOver={event => { if (!disabled) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (!disabled && dragged && order.includes(dragged)) move(dragged, index); setDragged('') }}><GripVertical size={16} aria-hidden="true" /><span>{index + 1}</span><p><TeachingTestContent text={question.options.find(option => option.id === id)?.text || ''} allowExternalLinks={allowExternalLinks} /></p><div><button type="button" className="teaching-icon-button" disabled={disabled || !index} aria-label={`Елемент ${index + 1} вище`} onClick={() => move(id, index - 1)}><ArrowUp size={16} /></button><button type="button" className="teaching-icon-button" disabled={disabled || index === order.length - 1} aria-label={`Елемент ${index + 1} нижче`} onClick={() => move(id, index + 1)}><ArrowDown size={16} /></button></div></div>)}</div><div className="teaching-test-actions"><TeachingButton disabled={disabled} onClick={() => onChange(order)}><Check size={15} />Зберегти поточний порядок</TeachingButton></div></>
  }
  const placements = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {}
  const place = (id: string, bucket: string) => { if (disabled || !question.options.some(option => option.id === id)) return; onChange({ ...placements, [id]: bucket }); setSelected(''); setDragged('') }
  const chip = (option: TeachingTestOption) => <div key={option.id} className="teaching-test-chip teaching-test-rich-chip" data-pressed={selected === option.id} draggable={!disabled} onDragStart={event => { setDragged(option.id); event.dataTransfer.setData('text/x-xelay-option', option.id) }}>
    <GripVertical size={14} aria-hidden="true" /><TeachingTestContent text={option.text} allowExternalLinks={allowExternalLinks} />
    <button type="button" className="teaching-test-answer-hit" aria-label={option.text} aria-pressed={selected === option.id} disabled={disabled} onClick={() => setSelected(current => current === option.id ? '' : option.id)} />
  </div>
  return <><p className="mb-3 text-xs text-muted-foreground">Перетягніть елемент у категорію. На телефоні натисніть на елемент, потім на назву категорії.</p><div className="teaching-test-chip-list">{question.options.filter(option => !placements[option.id]).map(chip)}</div>{selected && placements[selected] && <TeachingButton disabled={disabled} onClick={() => { const next = { ...placements }; delete next[selected]; onChange(next); setSelected('') }}><Undo2 size={14} />Повернути вибраний елемент</TeachingButton>}<div className="teaching-test-buckets">{question.buckets.map(bucket => <section className="teaching-test-bucket" key={bucket.id} onDragOver={event => { if (!disabled) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (dragged) place(dragged, bucket.id) }}><h4><button type="button" className="w-full rounded-md py-2 text-left" disabled={disabled || !selected} onClick={() => place(selected, bucket.id)} aria-label={`Розмістити вибраний елемент у категорії ${bucket.text}`}>{bucket.text}{selected && <span className="ml-2 text-xs text-primary">Розмістити сюди</span>}</button></h4><div className="teaching-test-chip-list">{question.options.filter(option => placements[option.id] === bucket.id).map(chip)}</div></section>)}</div></>
}
