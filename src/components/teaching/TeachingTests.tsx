import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, ClipboardCheck, Clock3, Download, Eye, FileCheck2, History, Pencil, Play, Plus, RefreshCw, Save, Search, Trophy } from 'lucide-react'
import { teachingDate, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { formatTeachingTestWatermark, teachingTestError, type TeachingTest, type TeachingTestAttempt, type TeachingTestDetail, type TeachingTestQuestion, type TeachingTestRepository } from '../../lib/teachingTests'
import { TeachingTestBuilder, TEST_QUESTION_LABELS } from './TeachingTestBuilder'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, TeachingSectionHelp, teachingInput } from './TeachingUI'
import './teaching-tests.css'
import './teaching-test-review.css'
import { TeachingQuestionBank } from './TeachingQuestionBank'
import { TeachingRubricAssessment } from './TeachingRubrics'
import { teachingRubricScore, type TeachingRubricLevels } from '../../lib/teachingRubrics'
import { TeachingTestOverrides } from './TeachingTestOverrides'
import { TeachingTestRunner } from './TeachingTestRunner'
import { TeachingTestAccessCodeDialog } from './TeachingTestAccessCode'
import { TeachingTestQuestionImages } from './TeachingTestQuestionImages'
import { TeachingTestContent } from './TeachingTestContent'
import { teachingReviewActiveAttempts, teachingReviewReadyAt, teachingReviewServerNow } from '../../lib/teachingTestReviewState'
import { downloadTeachingTestReport, formatTeachingTestAnswer, teachingTestCorrectAnswer, teachingTestReportResultStatus, TEACHING_TEST_REPORTS, type TeachingTestReportId } from '../../lib/teachingTestReports'

export function TeachingTests({ snapshot, repository, teachingRepository, userId, groupId, readonly = false, onOpenJournal, onRefresh, focusedTestId, onTestFocusHandled }: {
  snapshot: TeachingSnapshot; repository: TeachingTestRepository; teachingRepository: TeachingRepository; userId: string; groupId?: string; readonly?: boolean
  onOpenJournal?: () => void; onRefresh?: () => Promise<void>
  focusedTestId?: string; onTestFocusHandled?: (testId: string) => void
}) {
  const [tests, setTests] = useState<TeachingTest[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [editing, setEditing] = useState<TeachingTest | 'new' | null>(null), [viewing, setViewing] = useState<TeachingTest | null>(null), [message, setMessage] = useState('')
  const [bankOpen, setBankOpen] = useState(false)
  const [overrides, setOverrides] = useState<TeachingTest | null>(null)
  const [running, setRunning] = useState<{ test: TeachingTest; qa: boolean } | null>(null)
  const [accessCodeTest, setAccessCodeTest] = useState<TeachingTest | null>(null)
  const focusedTestCard = useRef<HTMLElement>(null)
  const scope = `${userId}:${snapshot.course.id}:${groupId || ''}`
  const currentScope = useRef(scope); currentScope.current = scope
  const permissions = snapshot.groups.find(group => group.group_id === groupId)?.permissions || snapshot.course.permissions
  const canCreate = !readonly && !snapshot.course.archived_at && permissions.includes('assignments') && permissions.includes('grades')
  const load = useCallback(async () => {
    const captured = scope
    setLoading(true); setError('')
    try { const data = await repository.list(snapshot.course.id, groupId); if (currentScope.current === captured) setTests(data.tests) }
    catch (failure) { if (currentScope.current === captured) setError(teachingTestError(failure)) }
    finally { if (currentScope.current === captured) setLoading(false) }
  }, [repository, snapshot.course.id, groupId, scope])
  useEffect(() => { setTests([]); setEditing(null); setViewing(null); setBankOpen(false); setOverrides(null); setRunning(null); setAccessCodeTest(null); setMessage(''); void load() }, [load])
  useEffect(() => {
    if (!focusedTestId || loading || error) return
    const test = tests.find(test => test.id === focusedTestId)
    if (!test) setMessage('Пов’язаний тест недоступний у цій групі. Поверніться до модуля та оберіть інший тест.')
    else if (canCreate && test.can_edit !== false && !test.has_attempts) setEditing(test)
    else focusedTestCard.current?.focus()
    onTestFocusHandled?.(focusedTestId)
  }, [focusedTestId, loading, error, tests, canCreate, onTestFocusHandled])
  async function saved(detail: TeachingTestDetail) { setEditing(null); setMessage(detail.test.status === 'published' ? 'Тест опубліковано для вибраних отримувачів.' : 'Чернетку тесту збережено.'); await load(); if (detail.test.status === 'published') await onRefresh?.() }
  return <section className="teaching-tests">
    {canCreate && <div data-teaching-guide="test-bank" className="teaching-test-actions"><TeachingButton onClick={() => setBankOpen(true)}>Банк запитань та імпорт тестів</TeachingButton></div>}
    {bankOpen && canCreate && <TeachingQuestionBank courseId={snapshot.course.id} userId={userId} onClose={() => setBankOpen(false)} />}
    {overrides && canCreate && <TeachingTestOverrides test={overrides} snapshot={snapshot} repository={repository} userId={userId} onClose={() => setOverrides(null)} onSaved={detail => { setOverrides(detail.test); void load() }} />}
    {accessCodeTest && canCreate && <TeachingTestAccessCodeDialog key={`${scope}:${accessCodeTest.id}`} repository={repository} testId={accessCodeTest.id} userId={userId} onClose={() => setAccessCodeTest(null)} />}
    <div data-teaching-guide="test-heading" className="teaching-test-heading"><div><h2>Тести</h2><p>Контрольні та заліки з таймером, різними типами запитань і перевіркою результатів перед публікацією балів.</p></div><div className="teaching-test-actions">{canCreate && <TeachingButton primary onClick={() => setEditing('new')}><Plus size={16} />Створити тест</TeachingButton>}<TeachingButton disabled={loading} onClick={() => void load()}><RefreshCw size={15} />Оновити</TeachingButton></div></div>
    {message && <p className="teaching-note" role="status">{message}</p>}
    {error && <p className="teaching-error" role="alert">{error}</p>}
    {loading ? <p role="status" className="teaching-note">Завантажуємо тести…</p> : !tests.length ? <div className="teaching-card"><TeachingEmpty icon={<ClipboardCheck size={26} />} title="Перший тест починається тут" description="Додайте запитання, оберіть групи та правила проходження. Після виконання перевірте відповіді й передайте бали в журнал.">{canCreate && <TeachingButton primary onClick={() => setEditing('new')}><Plus size={15} />Створити тест</TeachingButton>}</TeachingEmpty></div> : <div data-teaching-guide="test-list" className="teaching-list">{tests.map(test => <article className="teaching-card" key={test.id} ref={test.id === focusedTestId ? focusedTestCard : undefined} tabIndex={-1}>
      <div className="teaching-test-heading"><div><span className="teaching-badge">{test.status === 'draft' ? 'Чернетка' : test.status === 'closed' || new Date(test.closes_at).getTime() <= Date.now() ? 'Доступ завершено' : 'Опубліковано'}</span>{test.qa_own_attempt && <span className="teaching-badge">Тестовий режим · ооо 1</span>}<h3 className="mt-3 text-lg font-semibold">{test.title}</h3></div>{test.results_finalized_at && <span className="teaching-badge"><CheckCircle2 size={13} />Результати підготовлено</span>}</div>
      {test.description && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{test.description}</p>}
      <div className="teaching-test-meta"><span><ClipboardCheck size={14} />Запитань {test.question_count}</span><span><Clock3 size={14} />{test.duration_seconds / 60} хв</span><span>До {test.max_points} балів</span><span>Одна спроба</span>{test.bonus_percent > 0 && <span><Trophy size={14} />Бонус для {test.bonus_percent}%</span>}</div>
      <p className="text-xs text-muted-foreground">Доступ з {teachingDate(test.opens_at, true)} до {teachingDate(test.closes_at, true)}</p>
      <div className="teaching-test-actions">
        <TeachingButton onClick={() => setViewing(test)}><Eye size={15} />{test.can_review ? 'Відповіді й перевірка' : 'Переглянути'}</TeachingButton>
        {test.qa_can_start && repository.qaStudent && <TeachingButton primary onClick={() => setRunning({ test, qa: true })}><Play size={15} />{test.my_attempt?.status === 'submitted' ? test.my_attempt.grade_published_at ? 'Переглянути тестовий бал' : 'Переглянути здачу' : test.my_attempt ? 'Продовжити тестову спробу' : 'Скласти як студент'}</TeachingButton>}
        {Boolean(test.can_edit || test.can_review || test.questions.length) && <TeachingButton onClick={() => setRunning({ test, qa: false })}><Play size={15} />Пройти пробно</TeachingButton>}
        {canCreate && test.can_edit !== false && !test.has_attempts && <TeachingButton onClick={() => setEditing(test)}><Pencil size={15} />Редагувати</TeachingButton>}
      </div>
      {canCreate && test.can_edit !== false && <div className="teaching-test-actions">{!test.qa_own_attempt && <TeachingButton onClick={() => setOverrides(test)}>Допуск та індивідуальні умови</TeachingButton>}{test.require_access_code && <TeachingButton onClick={() => setAccessCodeTest(test)}>Код доступу</TeachingButton>}</div>}{test.has_attempts && <p className="mt-3 text-xs text-muted-foreground">{test.qa_own_attempt ? 'Тестову спробу розпочато. Умови й запитання зафіксовано.' : 'Студенти вже почали роботу. Умови й запитання зафіксовано.'}</p>}
    </article>)}</div>}
    {editing && canCreate && <TeachingTestBuilder key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? null : editing} snapshot={snapshot} teachingRepository={teachingRepository} repository={repository} userId={userId} groupId={groupId} onClose={() => setEditing(null)} onSaved={detail => void saved(detail)} />}
    {viewing && <TeachingTestReview key={`${scope}:${viewing.id}`} test={viewing} repository={repository} userId={userId} readonly={readonly} groups={snapshot.groups} groupId={groupId} courseTitle={snapshot.course.title} onClose={() => setViewing(null)} onChanged={load} onRefresh={onRefresh} onOpenJournal={onOpenJournal} />}
    {running && <TeachingTestRunner key={`${scope}:${running.test.id}`} repository={repository} testId={running.test.id} groupId={groupId || running.test.targets[0]?.group_id || ''} userId={userId} qa={running.qa} onClose={() => { setRunning(null); if (running.qa) void load() }} />}
  </section>
}

function ReviewAnswer({ question, answer, correct = false }: { question: TeachingTestQuestion; answer?: TeachingTestAttempt['answers'][string]; correct?: boolean }) {
  const value = correct ? question.answer : answer
  if (question.kind === 'choice' || question.kind === 'multiple' || question.kind === 'boolean') {
    const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    const options = ids.map(id => question.options.find(option => option.id === id)).filter(option => option != null)
    if (options.length) return <div className="teaching-test-review-option-answer">{options.map(option => <div key={option.id}><TeachingTestContent text={option.text.trim() || `Варіант ${question.options.indexOf(option) + 1}`} /><TeachingTestQuestionImages images={option.images} compact /></div>)}</div>
  }
  return <p>{correct ? teachingTestCorrectAnswer(question) : formatTeachingTestAnswer(question, answer)}</p>
}

type ReviewMode = 'auto' | 'full' | 'zero' | 'custom'
type ReviewMarkDraft = { mode: ReviewMode; points: string; reason: string; rubric_levels?: TeachingRubricLevels }
type ReviewDraft = { version: number; marks: Record<string, ReviewMarkDraft> }
const pointsText = (value: number | null | undefined) => typeof value === 'number' ? new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value) : 'Очікує'
const elapsedText = (value?: number) => value == null ? 'Триває' : `${Math.floor(value / 60)} хв ${Math.round(value % 60)} с`
function manualPointsDefault(value: number, maximum: number) {
  const roundedMaximum = Math.round(maximum * 100) / 100
  const cap = roundedMaximum <= maximum ? roundedMaximum : Math.floor(maximum * 100) / 100
  return Math.max(0, Math.min(Math.round(value * 100) / 100, cap))
}

function TeachingTestReview({ test, repository, userId, readonly, groups = [], groupId, courseTitle, onClose, onChanged, onRefresh, onOpenJournal }: {
  test: TeachingTest; repository: TeachingTestRepository; userId: string; readonly: boolean; onClose: () => void; onChanged: () => Promise<void>; onRefresh?: () => Promise<void>; onOpenJournal?: () => void
  groups?: Pick<TeachingSnapshot['groups'][number], 'group_id' | 'group_name'>[]; groupId?: string; courseTitle?: string
}) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [selected, setSelected] = useState(''), [approved, setApproved] = useState(false), [transferConfirmed, setTransferConfirmed] = useState(false), [confirmDiscard, setConfirmDiscard] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const [closeConfirmed, setCloseConfirmed] = useState(false), [showClose, setShowClose] = useState(false)
  const [search, setSearch] = useState(''), [filterGroup, setFilterGroup] = useState(groupId || ''), [filterStatus, setFilterStatus] = useState('')
  const [checked, setChecked] = useState(() => new Set<string>())
  const [showExport, setShowExport] = useState(false), [exporting, setExporting] = useState(false), [exportMessage, setExportMessage] = useState('')
  const [clock, setClock] = useState(Date.now())
  const receivedAt = useRef(Date.now())
  const lock = useRef(false), alive = useRef(true)
  const exportAbort = useRef<AbortController | null>(null)
  const exportTrigger = useRef<HTMLButtonElement>(null)
  const receive = useCallback((value: TeachingTestDetail) => {
    if (!alive.current) return
    setDetail(value)
    receivedAt.current = Date.now(); setClock(Date.now())
    setApproved(false); setTransferConfirmed(false); setCloseConfirmed(false); setShowClose(false)
    setSelected(current => value.attempts.some(attempt => attempt.id === current) ? current : value.attempts.find(attempt => attempt.status === 'submitted')?.id || '')
  }, [])
  const load = useCallback(async () => {
    try { receive(await repository.detail(test.id)) }
    catch (failure) { if (alive.current) setError(teachingTestError(failure)) }
    finally { if (alive.current) setLoading(false) }
  }, [repository, test.id, receive])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; exportAbort.current?.abort() } }, [load])
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const current = detail?.test || test
  const qa = current.qa_own_attempt === true
  const serverNow = teachingReviewServerNow(detail?.server_now, receivedAt.current, clock)
  const readyAt = teachingReviewReadyAt(current)
  const closed = Boolean(detail && (current.status === 'closed' || Number.isFinite(serverNow) && serverNow >= readyAt))
  const activeAttempts = teachingReviewActiveAttempts(detail?.attempts || [], serverNow)
  const submitted = detail?.attempts.filter(attempt => attempt.status === 'submitted') || []
  const qaPublished = qa ? submitted.find(attempt => attempt.grade_published_at) : undefined
  const canReview = !readonly && Boolean(current.can_review) && !qaPublished
  const ranking = [...(detail?.attempts || [])].sort((left, right) => Number(right.status === 'submitted') - Number(left.status === 'submitted') || (right.score ?? -1) - (left.score ?? -1) || (left.elapsed_seconds ?? Infinity) - (right.elapsed_seconds ?? Infinity) || left.id.localeCompare(right.id))
  const rankById = new Map(ranking.map((attempt, index) => [attempt.id, index + 1]))
  const groupNames = new Map(groups.map(group => [group.group_id, group.group_name]))
  const searchText = search.trim().toLocaleLowerCase('uk-UA')
  const visibleAttempts = ranking.filter(attempt => (!filterGroup || attempt.group_id === filterGroup) && (!filterStatus || attempt.status === filterStatus)
    && (!searchText || `${attempt.student_name || ''} ${attempt.id.slice(-8)}`.toLocaleLowerCase('uk-UA').includes(searchText)))
  const exportable = visibleAttempts.filter(attempt => attempt.status === 'submitted')
  const checkedAttempts = exportable.filter(attempt => checked.has(attempt.id))
  const mayExport = Boolean(detail && current.can_review && !qa)
  const selectedAttempt = detail?.attempts.find(attempt => attempt.id === selected)
  const selectedQuestions = selectedAttempt?.questions || current.questions
  const existingGrade = selectedAttempt?.current_grade || selectedAttempt?.grade_snapshot
  const selectedDraft = selectedAttempt ? drafts[selectedAttempt.id] : undefined
  const hasDrafts = Object.keys(drafts).length > 0
  const staleDraft = Boolean(selectedAttempt && selectedDraft && selectedAttempt.version !== selectedDraft.version)
  const resultsApproved = current.approved_revision != null && current.approved_revision === current.review_revision && Boolean(current.results_finalized_at)
  const average = submitted.length ? submitted.reduce((sum, attempt) => sum + (attempt.score || 0), 0) / submitted.length : 0
  const unreviewedEssays = submitted.reduce((count, attempt) => count + (attempt.questions || current.questions).filter(question => question.kind === 'essay' && !attempt.question_results?.find(result => result.question_id === question.id)?.manual).length, 0)
  const actionState = useRef({ canReview, hasDrafts, closeConfirmed, canClose: Boolean(current.can_close), activeAttempts, submitted: submitted.length, approved, closed, unreviewedEssays, transferConfirmed, resultsApproved, qa })
  actionState.current = { canReview, hasDrafts, closeConfirmed, canClose: Boolean(current.can_close), activeAttempts, submitted: submitted.length, approved, closed, unreviewedEssays, transferConfirmed, resultsApproved, qa }
  const authoredQuestions = [...current.questions, ...(current.variants || []).flatMap(variant => variant.questions)]
  const questionsById = new Map(authoredQuestions.map(question => [question.id, question]))
  const errorCounts = new Map<string, { text: string; seen: number; incorrect: number }>()
  for (const attempt of submitted) {
    for (const result of attempt.question_results || []) {
      const question = questionsById.get(result.question_id)
      if (!question || question.kind === 'essay' && !result.manual) continue
      const stats = errorCounts.get(result.question_id) || { text: question.text, seen: 0, incorrect: 0 }
      stats.seen++
      if (result.points < result.max_points - 0.000001) stats.incorrect++
      errorCounts.set(result.question_id, stats)
    }
  }
  const errors = [...errorCounts].filter(([, stats]) => stats.incorrect > 0).sort(([, left], [, right]) => right.incorrect - left.incorrect).slice(0, 3)

  function clearExportSelection() { setChecked(new Set()); setShowExport(false); setExportMessage('') }

  async function exportReport(format: TeachingTestReportId) {
    if (!mayExport || exportAbort.current || !alive.current) return
    const item = TEACHING_TEST_REPORTS.find(report => report.id === format)
    const attempts = item?.scope === 'selected' ? checkedAttempts : exportable
    if (!attempts.length) return
    const request = new AbortController()
    exportAbort.current = request
    setExporting(true); setShowExport(false); setExportMessage('')
    try {
      await downloadTeachingTestReport(format, { title: current.title, courseTitle: courseTitle || current.course_title || 'Тест Xelay', maxPoints: current.max_points, finalized: resultsApproved, groupNames, attempts }, request.signal)
    } catch (failure) {
      if (!request.signal.aborted) setExportMessage(failure instanceof Error ? failure.message : 'Не вдалося підготувати звіт.')
    } finally {
      if (exportAbort.current === request) {
        exportAbort.current = null
        if (alive.current) setExporting(false)
      }
    }
  }

  function changeMark(questionId: string, fields: Partial<ReviewMarkDraft>) {
    if (!selectedAttempt) return
    const result = selectedAttempt.question_results?.find(result => result.question_id === questionId)
    if (!result) return
    setApproved(false); setTransferConfirmed(false)
    setDrafts(value => {
      const draft: ReviewDraft = value[selectedAttempt.id] || { version: selectedAttempt.version, marks: {} }
      const mark = draft.marks[questionId] || { mode: result.mode, points: String(result.points), reason: result.reason || '' }
      return { ...value, [selectedAttempt.id]: { ...draft, marks: { ...draft.marks, [questionId]: { ...mark, ...fields } } } }
    })
  }
  async function saveReview() {
    if (!canReview || !selectedAttempt || !selectedDraft || !detail || lock.current || staleDraft) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const marks = Object.entries(selectedDraft.marks).map(([question_id, mark]) => {
        const question = selectedQuestions.find(question => question.id === question_id)
        const maximum = question?.points || 0
        if (mark.reason.trim().length < 2) throw new Error('Додайте коротку причину до кожної зміненої оцінки.')
        if (mark.mode === 'custom' && (!mark.points.trim() || !Number.isFinite(Number(mark.points)) || Number(mark.points) < 0 || Number(mark.points) > maximum)) throw new Error(`Бали за запитання мають бути від 0 до ${maximum}.`)
        if (question?.rubric && teachingRubricScore(question.rubric, mark.rubric_levels || {}, maximum) == null) throw new Error('Оберіть рівень за кожним критерієм зміненого запитання.')
        return { question_id, mode: mark.mode, reason: mark.reason.trim(), ...(mark.mode === 'custom' ? { points: Number(mark.points) } : {}), ...(mark.rubric_levels ? { rubric_levels: mark.rubric_levels } : {}) }
      })
      const updated = await repository.mutate('save_review', { id: test.id, attempt_id: selectedAttempt.id, expected_user_id: userId, version: selectedDraft.version, marks })
      if (!alive.current) return
      receive(updated)
      setDrafts(value => Object.fromEntries(Object.entries(value).filter(([id]) => id !== selectedAttempt.id)))
      setMessage('Перевірку роботи збережено. Підсумок оновлено, бонуси будуть перераховані після затвердження всіх результатів.')
      await onChanged()
    } catch (failure) { if (alive.current) setError(failure instanceof Error && !failure.message.includes('TEST_') && !failure.message.includes('TEACHING_') ? failure.message : teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function action(name: 'close_test' | 'finalize_results' | 'review_results' | 'qa_publish') {
    const state = actionState.current
    if (!detail || lock.current || !state.canReview || !alive.current) return
    if (state.hasDrafts) { setError('Спочатку збережіть або скасуйте зміни у відкритих роботах.'); return }
    if (name === 'close_test' && (!state.canClose || !state.closeConfirmed || state.activeAttempts > 0 || !state.submitted)) return
    if (name === 'finalize_results' && (!state.approved || !state.closed || state.unreviewedEssays > 0)) return
    if (name === 'review_results' && (state.qa || !state.transferConfirmed || !state.resultsApproved)) return
    if (name === 'qa_publish' && (!state.qa || !state.transferConfirmed || !state.resultsApproved || state.submitted !== 1)) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const updated = await repository.mutate(name, {
        id: test.id, expected_user_id: userId, version: detail.test.version,
        ...(name === 'close_test' ? { confirm_close_all: true } : {}),
        ...(name === 'qa_publish' ? { confirm_qa_publish: true } : {}),
      })
      if (!alive.current) return
      receive(updated); setApproved(false); setTransferConfirmed(false)
      const messages = {
        close_test: state.qa ? 'Доступ до тесту закрито. Затвердьте перевірку та опублікуйте тестовий бал.' : 'Доступ до тесту закрито. Тепер перевірте відповіді, окремо затвердьте результати й передайте бали в журнал.',
        finalize_results: state.qa ? 'Перевірку затверджено. Тепер можна опублікувати тестовий бал.' : 'Перевірку всіх відповідей затверджено. Рейтинг і бонуси перераховано за остаточними балами та часом.',
        review_results: 'Усі доступні перевірені результати передано в чернетку журналу. Для показу студентам відкрийте журнал і опублікуйте бали.',
        qa_publish: 'Тестовий бал опубліковано. Його можна переглянути у власній спробі.',
      }
      setMessage(messages[name])
      await onChanged()
      if (name === 'review_results') await onRefresh?.()
    } catch (failure) { if (alive.current) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function refresh() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    await load(); lock.current = false; if (alive.current) setBusy(false)
  }
  function close() { if (hasDrafts) setConfirmDiscard(true); else onClose() }
  function openJournal() {
    if (hasDrafts) { setError('Збережіть або скасуйте зміни в роботах перед переходом до журналу.'); return }
    onClose(); onOpenJournal?.()
  }
  return <TeachingModal wide guide={{ topic: 'test-review', label: 'Перевірка тесту' }} title={test.title} description={qa ? 'Перевірка власної спроби · ооо 1' : 'Перевірка відповідей, результати та журнал'} onClose={close} busy={busy}>
    <div className="teaching-tests">
      {error && <div role="alert" className="teaching-error"><p>{error}</p><div className="teaching-test-actions"><TeachingButton disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />Оновити дані, зберігши мої правки</TeachingButton></div></div>}
      {message && <p role="status" className="teaching-note">{message}</p>}
      {qaPublished && <p className="teaching-note" role="status">Опублікований тестовий бал · {pointsText(qaPublished.published_score)} із {current.max_points}</p>}
      {unreviewedEssays > 0 && <p role="status" className="teaching-note">Відкритих відповідей для ручної перевірки: {unreviewedEssays}. Перевірте їх перед затвердженням результатів і бонусів.</p>}
      {confirmDiscard && <div className="teaching-test-confirm"><h4>У роботах залишились незбережені правки</h4><p>Можна повернутися до перевірки або закрити вікно й відкинути ці правки.</p><div className="teaching-test-actions"><TeachingButton primary onClick={() => setConfirmDiscard(false)}>Продовжити перевірку</TeachingButton><TeachingButton onClick={onClose}>Відкинути правки й закрити</TeachingButton></div></div>}
      {loading ? <p role="status">Завантажуємо відповіді…</p> : <>
        <div className="teaching-test-review-overview"><div><span>Завершили роботу</span><strong>{submitted.length}<small> із {detail?.attempts.length || 0}, хто почав</small></strong></div><div><span>Середній бал за відповіді</span><strong>{pointsText(average)}<small> із {current.max_points}</small></strong></div><div><span>Завершення спроб</span><strong>{detail?.attempts.length ? Math.round(submitted.length / detail.attempts.length * 100) : 0}%</strong></div><div><span>Дата в журналі</span><strong>{teachingDate(current.journal_date || current.opens_at)}</strong><small>{current.work_type || 'Тест'}</small></div></div>
        <div className="teaching-test-heading"><p className="text-xs text-muted-foreground">{closed ? 'Доступ до тесту завершено.' : `Тест доступний до ${teachingDate(current.closes_at, true)}.`} Попередні бали вже показані нижче. Підсумок разом із бонусом обмежений {current.max_points} балами.</p><TeachingButton disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />Оновити відповіді</TeachingButton></div>
        {detail?.attempts.length ? <section className="teaching-test-results" aria-label="Результати тесту">
          <div className="teaching-test-results-heading"><div><span>ПІДСУМКИ ТЕСТУ</span><h3>Результати та відповіді</h3><p>Відкрийте роботу для перевірки або виберіть здані роботи для окремого звіту.</p></div><span className="teaching-badge">{resultsApproved ? 'Результати затверджено' : 'Попередні результати'}</span></div>
          <div className="teaching-test-results-filters">
            <TeachingField label="Пошук студента"><div className="teaching-test-results-search"><Search size={16} aria-hidden="true" /><input className={teachingInput} type="search" value={search} placeholder="Прізвище або код спроби" onChange={event => { setSearch(event.target.value); clearExportSelection() }} /></div></TeachingField>
            {groupNames.size > 1 && <TeachingField label="Група"><select className={teachingInput} value={filterGroup} onChange={event => { setFilterGroup(event.target.value); clearExportSelection() }}><option value="">Усі доступні групи</option>{groups.map(group => <option key={group.group_id} value={group.group_id}>{group.group_name}</option>)}</select></TeachingField>}
            <TeachingField label="Стан спроби"><select className={teachingInput} value={filterStatus} onChange={event => { setFilterStatus(event.target.value); clearExportSelection() }}><option value="">Усі спроби</option><option value="submitted">Здані</option><option value="in_progress">Виконуються</option></select></TeachingField>
          </div>
          {visibleAttempts.length ? <div className="teaching-table-wrap teaching-test-review-table-wrap"><table className="teaching-table teaching-test-review-table"><thead><tr>
            {mayExport && <th className="teaching-test-review-select"><input type="checkbox" aria-label="Вибрати всі видимі здані роботи" disabled={!exportable.length || exporting} checked={exportable.length > 0 && checkedAttempts.length === exportable.length} ref={node => { if (node) node.indeterminate = checkedAttempts.length > 0 && checkedAttempts.length < exportable.length }} onChange={event => setChecked(event.target.checked ? new Set(exportable.map(attempt => attempt.id)) : new Set())} /></th>}
            <th>Студент і місце</th><th>Час</th><th>Автоматично</th><th>За перевіркою</th><th>Бонус</th><th>Разом</th><th>Стан</th><th>Робота</th>
          </tr></thead><tbody>{visibleAttempts.map(attempt => <tr key={attempt.id} data-selected={selected === attempt.id}>
            {mayExport && <td className="teaching-test-review-select"><input type="checkbox" aria-label={`Вибрати роботу · ${attempt.student_name || attempt.id.slice(-8)}`} disabled={attempt.status !== 'submitted' || exporting} checked={checked.has(attempt.id)} onChange={event => setChecked(previous => { const next = new Set(previous); if (event.target.checked) next.add(attempt.id); else next.delete(attempt.id); return next })} /></td>}
            <td className="teaching-test-review-student"><strong>{attempt.student_name || 'Учасник групи'}</strong><small className="block text-muted-foreground">{groupNames.get(attempt.group_id) || 'Група'} · {attempt.id.slice(-8).toUpperCase()}</small><div className="teaching-test-review-rank">{attempt.status === 'submitted' ? <span>{attempt.rank || rankById.get(attempt.id)} місце</span> : <span>Виконує</span>}{attempt.bonus_winner && <span className="teaching-badge"><Trophy size={12} />Призове місце</span>}{drafts[attempt.id] && <span className="teaching-badge">Є правки</span>}</div></td>
            <td className="teaching-test-review-time">{elapsedText(attempt.elapsed_seconds)}</td><td>{pointsText(attempt.auto_score)}</td><td>{pointsText(attempt.score)}</td><td>{resultsApproved ? `+${pointsText(attempt.bonus_score || 0)}` : 'Після перевірки'}</td><td><strong>{pointsText(resultsApproved ? attempt.final_score : attempt.score)}</strong><small className="block text-muted-foreground">із {current.max_points}</small></td><td>{teachingTestReportResultStatus(attempt, resultsApproved)}{attempt.review_note && <p className="mt-2 text-xs text-muted-foreground">{attempt.review_note}</p>}</td><td><TeachingButton disabled={busy} onClick={() => setSelected(attempt.id)}>{selected === attempt.id ? 'Відкрито' : 'Перевірити'}</TeachingButton></td>
          </tr>)}</tbody></table></div> : <TeachingEmpty icon={<Search size={22} />} title="Робіт за фільтрами немає" description="Змініть групу, стан або пошуковий запит." />}
          {mayExport && <div className="teaching-test-export-bar" data-teaching-guide="review-exports">
            <div className="teaching-test-export-control">
              <button type="button" ref={exportTrigger} className="teaching-button teaching-button-primary" disabled={!exportable.length || exporting} aria-expanded={showExport} onClick={() => setShowExport(value => !value)}><Download size={16} />{exporting ? 'Готуємо файл…' : 'Експортувати'}<ChevronDown size={14} aria-hidden="true" /></button>
              {showExport && <div className="teaching-test-export-menu" role="group" aria-label="Формати експорту" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setShowExport(false); exportTrigger.current?.focus() } }}><p>Здані роботи за фільтрами</p>{TEACHING_TEST_REPORTS.map((report, index) => <div key={report.id}>{report.scope === 'selected' && TEACHING_TEST_REPORTS[index - 1]?.scope !== 'selected' && <p>Тільки вибрані роботи</p>}<button type="button" disabled={report.scope === 'selected' && !checkedAttempts.length} onClick={() => void exportReport(report.id)}>{report.label}</button></div>)}</div>}
            </div>
            <TeachingSectionHelp topic="test-review" step="exports" label="Експорт відповідей" iconOnly />
            <p>Здано за фільтрами: {exportable.length} · вибрано: {checkedAttempts.length}{hasDrafts ? ' · У файлі лише збережена перевірка.' : ''}</p>
            {exportMessage && <p className="teaching-error" role="alert">{exportMessage}</p>}
          </div>}
        </section> : <TeachingEmpty icon={<FileCheck2 size={25} />} title="Відповідей поки немає" description="Тут з’являться спроби студентів із вибраних груп і підгруп." />}
        {errors.length > 0 && <section className="teaching-test-review-errors"><h3>Запитання, які варто розібрати з групою</h3>{errors.map(([id, stats]) => <div key={id}><p><TeachingTestContent text={stats.text} /></p><span>Помилки у {stats.incorrect} із {stats.seen} робіт із цим запитанням</span></div>)}</section>}
        <p className="text-xs leading-relaxed text-muted-foreground">Рейтинг спочатку враховує бали за правильність, потім час виконання. Призові місця та бонуси визначаються після затвердження перевірки.</p>
        {selectedAttempt && <section data-teaching-guide="review-answers" className="teaching-test-section teaching-test-review-work"><div className="teaching-test-heading"><div><h3>{selectedAttempt.student_name || 'Робота студента'}</h3><p>Автоматично {pointsText(selectedAttempt.auto_score)} · за перевіркою {pointsText(selectedAttempt.score)} із {current.max_points}</p></div><span className="teaching-badge">{selectedAttempt.status === 'submitted' ? 'Відповіді зафіксовано' : 'Студент ще виконує роботу'}</span></div>
          {selectedAttempt.completion_reason === 'tab_switch' && <p className="teaching-note">Роботу автоматично здано після другого виходу із вкладки.</p>}
          {current.discourage_capture && <p className="text-xs text-muted-foreground">Позначка спроби на екрані <code>{formatTeachingTestWatermark(selectedAttempt)}</code></p>}
          {!qa && existingGrade?.id && <p className="teaching-note">У журналі вже є оцінка. Чернетка {existingGrade.draft_absent ? 'Н' : pointsText(existingGrade.draft_score)}, опубліковано {existingGrade.published_absent ? 'Н' : pointsText(existingGrade.published_score)}. Після підтвердження перевірки й перенесення результат тесту оновить чернетку цієї оцінки.</p>}
          {staleDraft && <div className="teaching-test-confirm"><h4>Робота вже оновилася</h4><p>Ваші правки збережені у формі. Звірте їх з актуальними відповідями й оцінками нижче, потім підтвердьте застосування до нової версії.</p><TeachingButton disabled={busy} onClick={() => setDrafts(value => ({ ...value, [selectedAttempt.id]: { ...value[selectedAttempt.id], version: selectedAttempt.version } }))}>Застосувати мої правки до оновленої роботи</TeachingButton></div>}
          <div className="teaching-test-review-details">{selectedQuestions.map((question, index) => {
            const result = selectedAttempt.question_results?.find(result => result.question_id === question.id)
            const mark = selectedDraft?.marks[question.id]
            const mode = mark?.mode || result?.mode || 'auto'
            const effectivePoints = mark ? mode === 'full' ? question.points : mode === 'zero' ? 0 : mode === 'auto' ? result?.automatic_points || 0 : Number(mark.points) : result?.points
            const status = effectivePoints == null || question.kind === 'essay' && !mark && !result?.manual ? 'pending' : effectivePoints >= question.points - 0.000001 ? 'full' : effectivePoints <= 0 ? 'zero' : 'partial'
            const history = selectedAttempt.review_history?.filter(event => event.question_id === question.id) || []
            return <article key={question.id} className="teaching-test-review-question" data-result={status}>
              <div className="teaching-test-heading"><span className="teaching-badge">{index + 1} · {TEST_QUESTION_LABELS[question.kind]}</span><span className="teaching-test-review-result" data-result={status}>{status === 'full' ? 'Правильно' : status === 'zero' ? 'Неправильно' : status === 'partial' ? 'Частково правильно' : 'Очікує перевірки'} · {pointsText(effectivePoints)} із {question.points}</span></div><h4 className="mt-3"><TeachingTestContent text={question.text} /></h4>
              <TeachingTestQuestionImages images={question.images} />
              <div className="teaching-test-review-answer-grid"><div><strong>Відповідь студента</strong><ReviewAnswer question={question} answer={selectedAttempt.answers[question.id]} /></div><div><strong>{question.kind === 'essay' ? 'Спосіб оцінювання' : 'Правильна відповідь'}</strong><ReviewAnswer question={question} correct /></div></div>
              {result && <div className="teaching-test-review-mark-summary"><span>Автоматично {pointsText(result.automatic_points)} із {result.max_points}</span><span>{result.manual ? 'Ручна перевірка викладача' : 'Автоматична перевірка'}{result.reason ? ` · ${result.reason}` : ''}</span></div>}
              {question.rubric && <div className="space-y-3"><TeachingRubricAssessment rubric={question.rubric} value={mark?.rubric_levels || result?.rubric_levels || {}} maximum={question.points} disabled={busy || !canReview || selectedAttempt.status !== 'submitted'} onChange={canReview ? levels => changeMark(question.id, { rubric_levels: levels, mode: 'custom', points: String(teachingRubricScore(question.rubric!, levels, question.points) ?? ''), reason: mark?.reason || result?.reason || 'Оцінено за критеріями' }) : undefined} /><TeachingField label="Пояснення оцінки за критеріями"><input className={teachingInput} maxLength={2000} disabled={busy || !canReview || selectedAttempt.status !== 'submitted'} value={mark?.reason || result?.reason || ''} onChange={event => changeMark(question.id, { reason: event.target.value })} /></TeachingField></div>}
              {canReview && selectedAttempt.status === 'submitted' && result && !question.rubric && <fieldset disabled={busy} className="teaching-test-review-mark"><TeachingField label="Результат перевірки"><select className={teachingInput} value={mode} onChange={event => { const nextMode = event.target.value as ReviewMode; changeMark(question.id, { mode: nextMode, points: String(nextMode === 'full' ? question.points : nextMode === 'zero' ? 0 : nextMode === 'auto' ? result.automatic_points : manualPointsDefault(result.points, question.points)), ...(nextMode === 'auto' && !mark?.reason ? { reason: 'Повернено автоматичну перевірку' } : {}) }) }}><option value="auto" disabled={question.kind === 'essay'}>Автоматичний результат</option><option value="full">Правильно, повний бал</option><option value="zero">Неправильно, 0 балів</option><option value="custom">Частково правильно, свої бали</option></select></TeachingField>{mode === 'custom' && <TeachingField label={`Балів від 0 до ${question.points}`}><input className={teachingInput} type="number" min="0" max={question.points} step="0.01" value={mark?.points ?? result.points} onChange={event => changeMark(question.id, { points: event.target.value })} /></TeachingField>}<TeachingField label="Причина зміни" hint="Зберігається в історії перевірки цієї роботи."><input className={teachingInput} maxLength={2000} value={mark?.reason ?? result.reason ?? ''} placeholder="Наприклад, відповідь правильна за змістом" onChange={event => changeMark(question.id, { reason: event.target.value })} /></TeachingField></fieldset>}
              {history.length > 0 && <details className="teaching-test-review-history"><summary><History size={14} />Історія перевірки · {history.length}</summary>{history.map(event => <div key={event.id}><p>{pointsText(event.old_points)} → {pointsText(event.new_points)} балів · {event.actor_name}</p><small>{teachingDate(event.created_at, true)} · {event.reason}</small></div>)}</details>}
            </article>
          })}</div>
          {canReview && selectedDraft && <div className="teaching-test-review-save"><p>Правки цієї роботи очікують збереження.</p><div className="teaching-test-actions"><TeachingButton disabled={busy} onClick={() => setDrafts(value => Object.fromEntries(Object.entries(value).filter(([id]) => id !== selectedAttempt.id)))}>Скасувати правки роботи</TeachingButton><TeachingButton primary busy={busy} disabled={staleDraft} onClick={() => void saveReview()}><Save size={15} />Зберегти перевірку роботи</TeachingButton></div></div>}
        </section>}
        {canReview && submitted.length > 0 && <section className="teaching-test-review-bulk">
          {!closed && <div data-teaching-guide="review-readiness" className="teaching-test-confirm" role="status"><h4>Чому підтвердження поки недоступне</h4><p>Здавання роботи окремими студентами не завершує строк доступу для решти. Перевірку й бонуси можна затвердити після {Number.isFinite(readyAt) ? teachingDate(new Date(readyAt).toISOString(), true) : 'оновлення даних тесту'}. Враховано також пізніші індивідуальні терміни.</p>{activeAttempts > 0 && <p>Зараз виконують тест: {activeAttempts}. Їхні спроби не перериватимуться.</p>}{current.can_close && <TeachingButton disabled={busy || hasDrafts} onClick={() => { setShowClose(value => !value); setCloseConfirmed(false) }}>{showClose ? 'Скасувати дострокове закриття' : 'Завершити приймання робіт раніше'}</TeachingButton>}{showClose && current.can_close && <div className="mt-3"><p>Це закриє тест для всіх його груп, підгруп та індивідуальних умов. Студенти, які ще не почали, більше не зможуть пройти його. Збережені відповіді залишаться; оцінки й бонуси затверджуються окремо. Відновити приймання цією кнопкою не можна.</p><label className="teaching-check"><input type="checkbox" checked={closeConfirmed} disabled={busy || hasDrafts || activeAttempts > 0} onChange={event => setCloseConfirmed(event.target.checked)} />Підтверджую закриття доступу до всього тесту</label><TeachingButton primary busy={busy} disabled={!closeConfirmed || hasDrafts || activeAttempts > 0} onClick={() => void action('close_test')}>Закрити доступ і перейти до перевірки</TeachingButton>{activeAttempts > 0 && <p>Спочатку дочекайтеся завершення поточних спроб, потім оновіть відповіді.</p>}</div>}</div>}
          {hasDrafts && <p className="teaching-note" role="status">Для підтвердження збережіть або скасуйте незбережені правки в роботах.</p>}
          <div data-teaching-guide="review-approve" className="teaching-test-confirm">
            <h4>{qa ? '1. Затвердити перевірку' : '1. Затвердити перевірку всіх робіт'}</h4>
            <p>{qa ? 'Звірте збережену відповідь і бали за неї.' : 'Збережені ручні оцінки та автоматичні результати решти запитань стануть основою рейтингу. Бонуси будуть перераховані за цими балами й часом виконання.'}</p>
            {resultsApproved && <p className="teaching-test-review-approved"><CheckCircle2 size={16} />{qa ? 'Перевірку затверджено' : 'Перевірку затверджено, бонуси розраховано'}</p>}
            <label className="teaching-check"><input type="checkbox" checked={approved} disabled={busy || hasDrafts || !closed || unreviewedEssays > 0} onChange={event => setApproved(event.target.checked)} />{qa ? 'Я перевірив відповідь і тестовий бал' : 'Я перевірив результати та наявні оцінки в журналі'}</label>
            <TeachingButton primary busy={busy} disabled={!approved || !closed || hasDrafts || unreviewedEssays > 0} onClick={() => void action('finalize_results')}><Trophy size={16} />{qa ? 'Затвердити тестовий результат' : resultsApproved ? 'Оновити підтвердження та звірити журнал' : 'Затвердити всі відповіді й перерахувати бонуси'}</TeachingButton>
            {!closed && <p>Затвердження стане доступним після завершення строку тесту.</p>}
          </div>
          <div data-teaching-guide="review-transfer" className="teaching-test-confirm">
            <h4>{qa ? '2. Опублікувати тестовий бал' : '2. Передати всі оцінки в журнал'}</h4>
            {qa
              ? <p>Результат буде видно автору у власній спробі. Бал зберігається окремо від журналу.</p>
              : <p>Перевірені результати потраплять у колонку «{current.work_type || 'Тест'}» за {teachingDate(current.journal_date || current.opens_at)}. Після перенесення їх можна опублікувати в журналі для студентів.</p>}
            <label className="teaching-check"><input type="checkbox" checked={transferConfirmed} disabled={busy || !resultsApproved || hasDrafts} onChange={event => setTransferConfirmed(event.target.checked)} />{qa ? 'Підтверджую публікацію тестового бала' : 'Підтверджую перенесення всіх перевірених результатів у чернетки журналу'}</label>
            <TeachingButton primary busy={busy} disabled={!transferConfirmed || !resultsApproved || hasDrafts || qa && submitted.length !== 1} onClick={() => void action(qa ? 'qa_publish' : 'review_results')}><ClipboardCheck size={16} />{qa ? 'Опублікувати тестовий бал' : 'Передати всі оцінки в журнал'}</TeachingButton>
          </div>
        </section>}
        {!qa && onOpenJournal && <TeachingButton disabled={busy} onClick={openJournal}><ClipboardCheck size={16} />Відкрити журнал для публікації балів</TeachingButton>}
      </>}
    </div>
  </TeachingModal>
}
