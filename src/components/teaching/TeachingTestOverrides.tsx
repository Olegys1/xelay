import { useEffect, useRef, useState } from 'react'
import { Clock3, Save } from 'lucide-react'
import { kyivDeadline, localDeadline, type TeachingSnapshot } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestDetail, type TeachingTestRepository } from '../../lib/teachingTests'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-assessment-phase1.css'

export function TeachingTestOverrides({ test, snapshot, repository, userId, onClose, onSaved }: {
  test: TeachingTest; snapshot: TeachingSnapshot; repository: TeachingTestRepository; userId: string; onClose: () => void; onSaved: (detail: TeachingTestDetail) => void
}) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [student, setStudent] = useState(''), [opens, setOpens] = useState(''), [closes, setCloses] = useState(''), [minutes, setMinutes] = useState('')
  const alive = useRef(true), lock = useRef(false)
  useEffect(() => { alive.current = true; void repository.detail(test.id).then(value => { if (alive.current) setDetail(value) }).catch(failure => { if (alive.current) setError(teachingTestError(failure)) }).finally(() => { if (alive.current) setLoading(false) }); return () => { alive.current = false } }, [repository, test.id])
  const current = detail?.test || test
  const entries = snapshot.entries.filter(entry => entry.active && entry.user_id && current.targets.some(target => target.group_id === entry.group_id) && snapshot.groups.some(group => group.group_id === entry.group_id && group.status === 'accepted' && (group.permissions || snapshot.course.permissions).includes('assignments') && (group.permissions || snapshot.course.permissions).includes('grades')))
  const attempted = new Set(detail?.attempts.map(attempt => `${attempt.user_id}:${attempt.group_id}`) || [])
  function select(value: string) {
    setStudent(value); setError(''); setMessage('')
    const [user_id, group_id] = value.split(':')
    const override = current.overrides?.find(item => item.user_id === user_id && item.group_id === group_id)
    setOpens(override?.opens_at ? localDeadline(override.opens_at) : ''); setCloses(override?.closes_at ? localDeadline(override.closes_at) : ''); setMinutes(override?.duration_seconds ? String(override.duration_seconds / 60) : '')
  }
  async function save(reset = false) {
    if (lock.current || !detail || !student) return
    const [studentId, groupId] = student.split(':')
    if (attempted.has(student)) { setError('Цей студент уже почав тест. Умови його спроби зафіксовані.'); return }
    const opens_at = reset || !opens ? null : kyivDeadline(opens), closes_at = reset || !closes ? null : kyivDeadline(closes)
    if (new Date(closes_at || current.closes_at).getTime() <= new Date(opens_at || current.opens_at).getTime()) { setError('Завершення доступу має бути пізніше за початок.'); return }
    const duration_seconds = reset || !minutes ? null : Number(minutes) * 60
    if (duration_seconds !== null && (!Number.isInteger(duration_seconds) || duration_seconds < 30 || duration_seconds > 86400)) { setError('Тривалість має бути від 1 до 1440 хвилин.'); return }
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const value = await repository.mutate('save_override', { id: current.id, version: current.version, expected_user_id: userId, override: { user_id: studentId, group_id: groupId, opens_at, closes_at, duration_seconds } })
      if (!alive.current) return
      setDetail(value); if (reset) { setOpens(''); setCloses(''); setMinutes('') }
      setMessage(reset ? 'Для студента відновлено загальні умови тесту.' : 'Індивідуальні умови збережено. Студент побачить їх перед початком тесту.')
      onSaved(value)
    } catch (failure) { if (alive.current) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <TeachingModal title="Індивідуальні умови тесту" description={current.title} onClose={onClose} busy={busy}>
    <div className="teaching-tests">{error && <p className="teaching-error" role="alert">{error}</p>}{message && <p className="teaching-note" role="status">{message}</p>}{loading ? <p role="status">Перевіряємо спроби студентів…</p> : <>
      <p className="teaching-note"><Clock3 size={15} className="mr-1 inline" />Змінити умови можна лише до початку особистої спроби. Час уже розпочатих робіт залишиться зафіксованим.</p>
      <TeachingField label="Студент"><select className={teachingInput} value={student} disabled={busy} onChange={event => select(event.target.value)}><option value="">Оберіть студента</option>{entries.map(entry => { const key = `${entry.user_id}:${entry.group_id}`; return <option key={entry.id} value={key} disabled={attempted.has(key)}>{entry.full_name} · {snapshot.groups.find(group => group.group_id === entry.group_id)?.group_name}{attempted.has(key) ? ' · уже почав' : ''}</option> })}</select></TeachingField>
      {student && <><fieldset disabled={busy} className="teaching-form"><TeachingField label="Відкрити тест за Києвом" hint="Порожнє поле: загальна дата відкриття."><input type="datetime-local" className={teachingInput} value={opens} onChange={event => setOpens(event.target.value)} /></TeachingField><TeachingField label="Закрити тест за Києвом" hint="Порожнє поле: загальна дата закриття."><input type="datetime-local" className={teachingInput} value={closes} onChange={event => setCloses(event.target.value)} /></TeachingField><TeachingField label="На виконання, хвилин" hint={`Загальна тривалість: ${current.duration_seconds / 60} хв.`}><input type="number" min="1" max="1440" step="1" className={teachingInput} value={minutes} onChange={event => setMinutes(event.target.value)} /></TeachingField></fieldset><div className="teaching-test-actions"><TeachingButton primary busy={busy} onClick={() => void save()}><Save size={15} />Зберегти умови</TeachingButton><TeachingButton disabled={busy} onClick={() => void save(true)}>Відновити загальні умови</TeachingButton></div></>}
    </>}</div>
  </TeachingModal>
}
