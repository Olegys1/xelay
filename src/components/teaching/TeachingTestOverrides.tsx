import { useEffect, useRef, useState } from 'react'
import { Clock3, Save, ShieldCheck } from 'lucide-react'
import { kyivDeadline, localDeadline, type TeachingSnapshot } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestDetail, type TeachingTestRepository } from '../../lib/teachingTests'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-assessment-phase1.css'

export function TeachingTestOverrides({ test, snapshot, repository, userId, onClose, onSaved }: {
  test: TeachingTest; snapshot: TeachingSnapshot; repository: TeachingTestRepository; userId: string; onClose: () => void; onSaved: (detail: TeachingTestDetail) => void
}) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [student, setStudent] = useState(''), [opens, setOpens] = useState(''), [closes, setCloses] = useState(''), [minutes, setMinutes] = useState('')
  const [excluded, setExcluded] = useState(false), [reason, setReason] = useState('')
  const alive = useRef(true), lock = useRef(false)
  const scope = useRef({ repository, testId: test.id, userId })
  if (scope.current.repository !== repository || scope.current.testId !== test.id || scope.current.userId !== userId) scope.current = { repository, testId: test.id, userId }
  const renderScope = scope.current
  useEffect(() => {
    alive.current = true; lock.current = false; setLoading(true); setDetail(null); setStudent(''); setError(''); setMessage(''); setBusy(false)
    const captured = scope.current
    void repository.detail(test.id).then(value => { if (alive.current && scope.current === captured) setDetail(value) }).catch(failure => { if (alive.current && scope.current === captured) setError(teachingTestError(failure)) }).finally(() => { if (alive.current && scope.current === captured) setLoading(false) })
    return () => { alive.current = false }
  }, [repository, test.id, userId])
  const current = detail?.test || test
  const eligibleEntries = snapshot.entries.filter(entry => entry.active && entry.user_id && current.targets.some(target => target.group_id === entry.group_id) && snapshot.groups.some(group => group.group_id === entry.group_id && group.status === 'accepted' && (group.permissions || snapshot.course.permissions).includes('assignments') && (group.permissions || snapshot.course.permissions).includes('grades')))
  const entries = eligibleEntries.filter((entry, index) => {
    const saved = current.overrides?.find(item => item.user_id === entry.user_id)
    return saved ? entry.group_id === saved.group_id : eligibleEntries.findIndex(item => item.user_id === entry.user_id) === index
  })
  const attempted = new Set(detail?.attempts.map(attempt => attempt.user_id) || [])
  function select(value: string) {
    setStudent(value); setError(''); setMessage('')
    const [user_id, group_id] = value.split(':')
    const override = current.overrides?.find(item => item.user_id === user_id)
    setOpens(override?.opens_at ? localDeadline(override.opens_at) : ''); setCloses(override?.closes_at ? localDeadline(override.closes_at) : ''); setMinutes(override?.duration_seconds ? String(override.duration_seconds / 60) : '')
    setExcluded(Boolean(override?.excluded)); setReason(override?.exclusion_reason || '')
  }
  async function save(reset = false) {
    if (lock.current || !detail || !student || scope.current !== renderScope) return
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
    <div className="teaching-tests" data-teaching-guide="test-individual-access">{error && <p className="teaching-error" role="alert">{error}</p>}{message && <p className="teaching-note" role="status">{message}</p>}{loading ? <p role="status">Перевіряємо спроби студентів…</p> : <>
      <p className="teaching-note"><Clock3 size={15} className="mr-1 inline" />Змінити умови можна лише до початку особистої спроби. Час уже розпочатих робіт залишиться зафіксованим.</p>
      <p className="teaching-note"><ShieldCheck size={15} className="mr-1 inline" />За замовчуванням допущені всі отримувачі тесту. Оберіть студента, щоб змінити його допуск. Це не змінює склад групи чи попередні результати.</p>
      <TeachingField label="Студент"><select className={teachingInput} value={student} disabled={busy} onChange={event => select(event.target.value)}><option value="">Оберіть студента</option>{entries.map(entry => { const key = `${entry.user_id}:${entry.group_id}`, denied = current.overrides?.some(item => item.user_id === entry.user_id && item.excluded); return <option key={entry.id} value={key} disabled={attempted.has(entry.user_id!)}>{entry.full_name} · {snapshot.groups.find(group => group.group_id === entry.group_id)?.group_name}{attempted.has(entry.user_id!) ? ' · уже почав' : denied ? ' · не допущений' : ' · допущений'}</option> })}</select></TeachingField>
      {student && <><fieldset disabled={busy} className="teaching-form">
        <label className="teaching-check"><input type="checkbox" checked={excluded} onChange={event => setExcluded(event.target.checked)} />Не допускати до цього тесту</label>
        {excluded && <TeachingField label="Пояснення для студента" hint="Необов’язково. Це пояснення побачить лише цей студент і викладачі з доступом до тесту."><textarea className={teachingInput} rows={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></TeachingField>}
        <TeachingField label="Відкрити тест за Києвом" hint="Порожнє поле: загальна дата відкриття."><input type="datetime-local" className={teachingInput} value={opens} onChange={event => setOpens(event.target.value)} /></TeachingField><TeachingField label="Закрити тест за Києвом" hint="Порожнє поле: загальна дата закриття."><input type="datetime-local" className={teachingInput} value={closes} onChange={event => setCloses(event.target.value)} /></TeachingField><TeachingField label="На виконання, хвилин" hint={`Загальна тривалість: ${current.duration_seconds / 60} хв.`}><input type="number" min="1" max="1440" step="1" className={teachingInput} value={minutes} onChange={event => setMinutes(event.target.value)} /></TeachingField></fieldset><div className="teaching-test-actions"><TeachingButton primary busy={busy} onClick={() => void save()}><Save size={15} />Зберегти допуск і час</TeachingButton><TeachingButton disabled={busy} onClick={() => void save(true)}>Відновити загальний час</TeachingButton></div></>}
    </>}</div>
  </TeachingModal>
}
