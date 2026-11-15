import { useEffect, useRef, useState } from 'react'
import { Clock3, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { kyivDeadline, localDeadline, teachingDate, type TeachingSnapshot } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestDetail, type TeachingTestRepository, type TeachingTestRetakeGrant } from '../../lib/teachingTests'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-assessment-phase1.css'

export function TeachingTestOverrides({ test, snapshot, repository, userId, onClose, onSaved, onReviewRetake }: {
  test: TeachingTest; snapshot: TeachingSnapshot; repository: TeachingTestRepository; userId: string; onClose: () => void; onSaved: (detail: TeachingTestDetail) => void; onReviewRetake?: (test: TeachingTest) => void
}) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setErrorText] = useState(''), [message, setMessage] = useState('')
  const [errorSignal, setErrorSignal] = useState(0), errorSummary = useRef<HTMLParagraphElement>(null)
  function setError(value: string) { setErrorText(value); if (value) setErrorSignal(sequence => sequence + 1) }
  useEffect(() => { if (error) { errorSummary.current?.focus({ preventScroll: true }); errorSummary.current?.scrollIntoView({ block: 'nearest' }) } }, [error, errorSignal])
  const [student, setStudent] = useState(''), [opens, setOpens] = useState(''), [closes, setCloses] = useState(''), [minutes, setMinutes] = useState('')
  const [excluded, setExcluded] = useState(false), [reason, setReason] = useState('')
  const [retakeOpens, setRetakeOpens] = useState(''), [retakeCloses, setRetakeCloses] = useState(''), [retakeMinutes, setRetakeMinutes] = useState('')
  const [retakeVariant, setRetakeVariant] = useState('random'), [retakeConfirmed, setRetakeConfirmed] = useState(false)
  const retakeRequest = useRef<{ id: string; fingerprint: string } | null>(null)
  const alive = useRef(true), lock = useRef(false)
  const scope = useRef({ repository, testId: test.id, userId })
  if (scope.current.repository !== repository || scope.current.testId !== test.id || scope.current.userId !== userId) scope.current = { repository, testId: test.id, userId }
  const renderScope = scope.current
  useEffect(() => {
    alive.current = true; lock.current = false; setLoading(true); setDetail(null); setStudent(''); setError(''); setMessage(''); setBusy(false); setRetakeConfirmed(false); retakeRequest.current = null
    const captured = scope.current
    void repository.detail(test.id).then(value => { if (alive.current && scope.current === captured) setDetail(value) }).catch(failure => { if (alive.current && scope.current === captured) setError(teachingTestError(failure)) }).finally(() => { if (alive.current && scope.current === captured) setLoading(false) })
    return () => { alive.current = false }
  }, [repository, test.id, userId])
  const current = detail?.test || test
  const conditionsLocked = current.status === 'closed' || Boolean(current.results_finalized_at)
  const eligibleEntries = snapshot.entries.filter(entry => entry.active && entry.user_id && current.targets.some(target => target.group_id === entry.group_id) && snapshot.groups.some(group => group.group_id === entry.group_id && group.status === 'accepted' && (group.permissions || snapshot.course.permissions).includes('assignments') && (group.permissions || snapshot.course.permissions).includes('grades')))
  const entries = eligibleEntries.filter((entry, index) => {
    const started = detail?.attempts.find(attempt => attempt.user_id === entry.user_id)
    const saved = current.overrides?.find(item => item.user_id === entry.user_id)
    return started ? entry.group_id === started.group_id : saved ? entry.group_id === saved.group_id : eligibleEntries.findIndex(item => item.user_id === entry.user_id) === index
  })
  const attempted = new Set(detail?.attempts.map(attempt => attempt.user_id) || [])
  const [selectedUserId] = student.split(':')
  const selectedAttempt = detail?.attempts.find(attempt => attempt.user_id === selectedUserId)
  const grants = (current.retake_grants || []).filter(grant => grant.user_id === selectedUserId).sort((a, b) => a.retake_number - b.retake_number || Date.parse(a.created_at) - Date.parse(b.created_at))
  const nextRetakeNumber = Math.max(1, ...grants.filter(grant => grant.attempt_id).map(grant => grant.retake_number)) + 1
  const serverNow = Date.parse(detail?.server_now || '')
  const activeGrant = grants.find(grant => !grant.revoked_at && grant.status !== 'submitted' && Date.parse(grant.expires_at || grant.closes_at) > serverNow)
  const sourceAttemptId = [...grants].reverse().find(grant => grant.attempt_id)?.attempt_id || selectedAttempt?.id
  const originalActive = selectedAttempt?.status === 'in_progress' && (!Number.isFinite(serverNow) || Date.parse(selectedAttempt.expires_at) > serverNow)
  const mayGrant = current.can_grant_retake === true && Boolean(sourceAttemptId) && !originalActive && !activeGrant
  const personalConditionsLocked = conditionsLocked || attempted.has(selectedUserId)
  const renderGrantState = { student, detail, mayGrant, retakeConfirmed, retakeOpens, retakeCloses, retakeMinutes, retakeVariant }
  const grantState = useRef(renderGrantState); grantState.current = renderGrantState
  const variantValue = (id: string) => id === 'base' || id === 'random' ? `variant:${id}` : id
  function select(value: string) {
    setStudent(value); setError(''); setMessage(''); setRetakeConfirmed(false); setRetakeVariant('random'); retakeRequest.current = null
    const [user_id, group_id] = value.split(':')
    const override = current.overrides?.find(item => item.user_id === user_id)
    setOpens(override?.opens_at ? localDeadline(override.opens_at) : ''); setCloses(override?.closes_at ? localDeadline(override.closes_at) : ''); setMinutes(override?.duration_seconds ? String(override.duration_seconds / 60) : '')
    setExcluded(Boolean(override?.excluded)); setReason(override?.exclusion_reason || '')
    const now = Number.isFinite(serverNow) ? serverNow : Date.now()
    setRetakeOpens(localDeadline(new Date(now).toISOString())); setRetakeCloses(localDeadline(new Date(now + 86400000).toISOString())); setRetakeMinutes(String(current.duration_seconds / 60))
  }
  async function grantRetake() {
    if (lock.current || !alive.current || !detail || !student || !mayGrant || !retakeConfirmed || scope.current !== renderScope || grantState.current !== renderGrantState) return
    const [studentId, groupId] = student.split(':')
    if (!entries.some(entry => entry.user_id === studentId && entry.group_id === groupId) || !sourceAttemptId) return
    const opens_at = kyivDeadline(retakeOpens), closes_at = kyivDeadline(retakeCloses), duration_seconds = Number(retakeMinutes) * 60
    if (!opens_at || !closes_at || Date.parse(closes_at) <= Date.parse(opens_at) || Date.parse(closes_at) <= serverNow) { setError('Вкажіть початок і майбутнє завершення доступу до повторної спроби.'); return }
    if (!Number.isInteger(duration_seconds) || duration_seconds < 60 || duration_seconds > 86400) { setError('Тривалість повторної спроби має бути від 1 до 1440 хвилин.'); return }
    if (retakeVariant !== 'random' && retakeVariant !== 'base' && !current.variants?.some(variant => variantValue(variant.id) === retakeVariant)) { setError('Оберіть наявний варіант або випадкову видачу.'); return }
    const fingerprint = JSON.stringify([current.id, studentId, groupId, sourceAttemptId, retakeVariant, opens_at, closes_at, duration_seconds])
    if (retakeRequest.current?.fingerprint !== fingerprint) retakeRequest.current = { id: crypto.randomUUID(), fingerprint }
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const value = await repository.mutate('grant_retake', { id: current.id, version: current.version, expected_user_id: userId, request_id: retakeRequest.current.id, user_id: studentId, group_id: groupId, source_attempt_id: sourceAttemptId, variant_choice: retakeVariant, opens_at, closes_at, duration_seconds, confirm_retake: true })
      if (!alive.current || scope.current !== renderScope) return
      setDetail(value); setRetakeConfirmed(false); retakeRequest.current = null
      setMessage('Повторну спробу дозволено лише цьому студенту. Попередні відповіді й бали збережено. У журналі залишиться найкращий опублікований бал.')
      onSaved(value)
    } catch (failure) { if (alive.current && scope.current === renderScope) setError(teachingTestError(failure)) }
    finally { if (scope.current === renderScope) { lock.current = false; if (alive.current) setBusy(false) } }
  }
  async function reviewRetake(grant: TeachingTestRetakeGrant) {
    if (lock.current || !alive.current || !onReviewRetake || scope.current !== renderScope) return
    lock.current = true; setBusy(true); setError('')
    try { const value = await repository.detail(grant.child_test_id); if (alive.current && scope.current === renderScope) onReviewRetake(value.test) }
    catch (failure) { if (alive.current && scope.current === renderScope) setError(teachingTestError(failure)) }
    finally { if (scope.current === renderScope) { lock.current = false; if (alive.current) setBusy(false) } }
  }
  async function refresh() {
    if (lock.current || !alive.current || scope.current !== renderScope) return
    lock.current = true; setBusy(true); setError('')
    try { const value = await repository.detail(current.id); if (alive.current && scope.current === renderScope) { setDetail(value); setRetakeConfirmed(false) } }
    catch (failure) { if (alive.current && scope.current === renderScope) setError(teachingTestError(failure)) }
    finally { if (scope.current === renderScope) { lock.current = false; if (alive.current) setBusy(false) } }
  }
  async function save(reset = false) {
    if (lock.current || !alive.current || !detail || !student || conditionsLocked || scope.current !== renderScope) return
    const [studentId, groupId] = student.split(':')
    if (attempted.has(studentId)) { setError('Цей студент уже почав тест. Умови його спроби зафіксовані.'); return }
    const saved = current.overrides?.find(item => item.user_id === studentId)
    // Restoring the time window must not silently change the saved admission decision.
    const admissionExcluded = reset ? Boolean(saved?.excluded) : excluded
    const exclusionReason = reset ? saved?.exclusion_reason || '' : excluded ? reason.trim() : ''
    const opens_at = reset || !opens ? null : kyivDeadline(opens), closes_at = reset || !closes ? null : kyivDeadline(closes)
    if (new Date(closes_at || current.closes_at).getTime() <= new Date(opens_at || current.opens_at).getTime()) { setError('Завершення доступу має бути пізніше за початок.'); return }
    const duration_seconds = reset || !minutes ? null : Number(minutes) * 60
    if (duration_seconds !== null && (!Number.isInteger(duration_seconds) || duration_seconds < 30 || duration_seconds > 86400)) { setError('Тривалість має бути від 1 до 1440 хвилин.'); return }
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const value = await repository.mutate('save_override', { id: current.id, version: current.version, expected_user_id: userId, override: { user_id: studentId, group_id: groupId, opens_at, closes_at, duration_seconds, excluded: admissionExcluded, exclusion_reason: exclusionReason } })
      if (!alive.current || scope.current !== renderScope) return
      setDetail(value); if (reset) { setOpens(''); setCloses(''); setMinutes(''); setExcluded(admissionExcluded); setReason(exclusionReason) }
      setMessage(reset ? 'Загальний час відновлено. Рішення про допуск збережено.' : admissionExcluded ? 'Студент не допущений до цього тесту. Йому буде видно ваше пояснення.' : 'Допуск і час збережено. Студент зможе почати тест за його правилами.')
      onSaved(value)
    } catch (failure) { if (alive.current && scope.current === renderScope) setError(teachingTestError(failure)) }
    finally { if (scope.current === renderScope) { lock.current = false; if (alive.current) setBusy(false) } }
  }
  return <TeachingModal guide={{ topic: 'test-admission', step: 'individual', label: 'Індивідуальні умови' }} title="Допуск та індивідуальні умови" description={current.title} onClose={onClose} busy={busy}>
    <div className="teaching-tests" data-teaching-guide="test-individual-access">{error && <p ref={errorSummary} tabIndex={-1} className="teaching-error" role="alert">{error}</p>}{message && <p className="teaching-note" role="status">{message}</p>}{loading ? <p role="status">Перевіряємо спроби студентів…</p> : <>
      <TeachingButton disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />Оновити спроби й дозволи</TeachingButton>
      {conditionsLocked && <p className="teaching-note" role="status">{current.results_finalized_at ? 'Результати затверджено. Допуск і час зафіксовано.' : 'Приймання відповідей закрито викладачем. Допуск і час зафіксовано.'} {current.can_grant_retake && 'Для вибраного студента можна окремо дозволити повторну спробу.'}</p>}
      {(!conditionsLocked || current.can_grant_retake === true) && <>
      <p className="teaching-note"><Clock3 size={15} className="mr-1 inline" />Для студента, який ще не почав тест, можна встановити особисті дати доступу й тривалість. Час уже розпочатих робіт зафіксовано.</p>
      <p className="teaching-note"><ShieldCheck size={15} className="mr-1 inline" />За замовчуванням допущені всі отримувачі тесту. Оберіть студента, щоб змінити його допуск. Це не змінює склад групи чи попередні результати.</p>
      <TeachingField label="Студент"><select className={teachingInput} value={student} disabled={busy} onChange={event => select(event.target.value)}><option value="">Оберіть студента</option>{entries.map(entry => { const key = `${entry.user_id}:${entry.group_id}`, denied = current.overrides?.some(item => item.user_id === entry.user_id && item.excluded); return <option key={entry.id} value={key}>{entry.full_name} · {snapshot.groups.find(group => group.group_id === entry.group_id)?.group_name}{attempted.has(entry.user_id!) ? ' · уже почав' : denied ? ' · не допущений' : ' · допущений'}</option> })}</select></TeachingField>
      {student && <>
        {attempted.has(selectedUserId) && <p className="teaching-note">Цей студент уже почав тест. Умови його спроби зафіксовані. Щоб він пройшов роботу ще раз, скористайтеся окремим дозволом нижче.</p>}
        <fieldset disabled={busy || personalConditionsLocked} className="teaching-form">
        <label className="teaching-check"><input type="checkbox" checked={excluded} onChange={event => setExcluded(event.target.checked)} />Не допускати до цього тесту</label>
        {excluded && <TeachingField label="Пояснення для студента" hint="Необов’язково. Це пояснення побачить лише цей студент і викладачі з доступом до тесту."><textarea className={teachingInput} rows={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></TeachingField>}
        <TeachingField label="Відкрити тест за Києвом" hint="Порожнє поле: загальна дата відкриття."><input type="datetime-local" className={teachingInput} value={opens} onChange={event => setOpens(event.target.value)} /></TeachingField><TeachingField label="Закрити тест за Києвом" hint="Порожнє поле: загальна дата закриття."><input type="datetime-local" className={teachingInput} value={closes} onChange={event => setCloses(event.target.value)} /></TeachingField><TeachingField label="На виконання, хвилин" hint={`Загальна тривалість: ${current.duration_seconds / 60} хв.`}><input type="number" min="1" max="1440" step="1" className={teachingInput} value={minutes} onChange={event => setMinutes(event.target.value)} /></TeachingField></fieldset><div className="teaching-test-actions"><TeachingButton primary busy={busy} disabled={personalConditionsLocked} onClick={() => void save()}><Save size={15} />Зберегти допуск і час</TeachingButton><TeachingButton disabled={busy || personalConditionsLocked} onClick={() => void save(true)}>Відновити загальний час</TeachingButton></div>
        {current.can_grant_retake === true && selectedAttempt && <section className="teaching-test-section" aria-label="Повторне проходження студента">
          <h3><RotateCcw size={17} className="mr-1 inline" />Повторна спроба №{nextRetakeNumber}</h3>
          <p>Попередня робота й усі відповіді залишаться в історії. Студент отримає окрему спробу з новим таймером. У журналі завжди залишається найкращий опублікований бал: нижчий результат його не зменшить.</p>
          {originalActive && <p className="teaching-note" role="status">Студент ще виконує поточну роботу. Дочекайтеся її завершення або спливу часу.</p>}
          {activeGrant && <p className="teaching-note" role="status">Для цього студента вже відкрита повторна спроба №{activeGrant.retake_number}. Новий дозвіл буде доступний після її завершення або закриття вікна доступу.</p>}
          <fieldset disabled={busy || !mayGrant} className="teaching-form">
            <TeachingField label="Варіант повторної спроби" hint="Вибір застосовується лише до цієї нової спроби. Після початку набір не зміниться."><select className={teachingInput} value={retakeVariant} onChange={event => { setRetakeVariant(event.target.value); setRetakeConfirmed(false) }}><option value="random">Випадковий варіант</option><option value="base">Варіант 1 · {current.base_variant_title || 'Основний набір'}</option>{current.variants?.map((variant, index) => <option value={variantValue(variant.id)} key={variant.id}>Варіант {index + 2} · {variant.title}</option>)}</select></TeachingField>
            <TeachingField label="Відкрити повторну спробу за Києвом"><input type="datetime-local" className={teachingInput} value={retakeOpens} onChange={event => { setRetakeOpens(event.target.value); setRetakeConfirmed(false) }} /></TeachingField>
            <TeachingField label="Закрити повторну спробу за Києвом"><input type="datetime-local" className={teachingInput} value={retakeCloses} onChange={event => { setRetakeCloses(event.target.value); setRetakeConfirmed(false) }} /></TeachingField>
            <TeachingField label="На повторну спробу, хвилин"><input type="number" min="1" max="1440" step="1" className={teachingInput} value={retakeMinutes} onChange={event => { setRetakeMinutes(event.target.value); setRetakeConfirmed(false) }} /></TeachingField>
            <label className="teaching-check"><input type="checkbox" checked={retakeConfirmed} onChange={event => setRetakeConfirmed(event.target.checked)} />Дозволяю нову спробу лише вибраному студенту. Попередні відповіді та оцінки зберігаються.</label>
          </fieldset>
          <TeachingButton primary busy={busy} disabled={!mayGrant || !retakeConfirmed} onClick={() => void grantRetake()}><RotateCcw size={15} />Дозволити повторну спробу</TeachingButton>
        </section>}
        {grants.length > 0 && <section className="teaching-test-section" aria-label="Історія повторних спроб"><h3>Історія повторних спроб</h3>{grants.map(grant => <article className="teaching-card" key={grant.id}><strong>{grant.attempt_id ? 'Спроба' : 'Дозвіл на спробу'} №{grant.retake_number}</strong><p>{!grant.attempt_id && grant.revoked_at ? 'Невикористаний дозвіл закрито' : !grant.attempt_id && Date.parse(grant.closes_at) <= serverNow ? 'Студент не почав. Час дозволу минув' : grant.status === 'submitted' ? 'Роботу здано' : grant.status === 'in_progress' ? 'Студент виконує' : 'Очікує початку студентом'} · {teachingDate(grant.opens_at, true)} — {teachingDate(grant.closes_at, true)}</p>{grant.published_at && <p>Опубліковано за цю спробу: {grant.published_attempt_score ?? '—'}. Найкращий бал у журналі: {grant.published_best_score ?? '—'}.</p>}{onReviewRetake && grant.attempt_id && <TeachingButton disabled={busy} onClick={() => void reviewRetake(grant)}>{grant.published_at ? 'Переглянути опубліковану спробу' : 'Відкрити відповіді й перевірку'}</TeachingButton>}</article>)}</section>}
      </>}
      </>}
    </>}</div>
  </TeachingModal>
}
