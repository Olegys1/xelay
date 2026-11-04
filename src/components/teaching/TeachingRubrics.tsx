import { useEffect, useRef, useState } from 'react'
import { ListChecks, Plus, Trash2 } from 'lucide-react'
import { teachingRubricError, teachingRubricRepository, teachingRubricScore, type TeachingRubric, type TeachingRubricData, type TeachingRubricLevels } from '../../lib/teachingRubrics'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'
import './teaching-rubrics.css'

const freshCriterion = () => ({ id: crypto.randomUUID(), title: '', levels: [{ id: crypto.randomUUID(), label: 'Не виконано', points: 0 }, { id: crypto.randomUUID(), label: 'Частково', points: 1 }, { id: crypto.randomUUID(), label: 'Повністю', points: 2 }] })
export function TeachingRubricEditor({ value, onChange, disabled = false }: { value: TeachingRubric | null; onChange: (rubric: TeachingRubric | null) => void; disabled?: boolean }) {
  const change = (index: number, fields: Partial<TeachingRubric['criteria'][number]>) => onChange({ criteria: value!.criteria.map((item, at) => at === index ? { ...item, ...fields } : item) })
  return <div className="teaching-rubric-editor"><label className="teaching-check"><input type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={event => onChange(event.target.checked ? { criteria: [freshCriterion()] } : null)} />Оцінювати за критеріями</label>{value && <>
    <p className="text-xs text-muted-foreground">Додайте критерії та рівні виконання. Обрані бали будуть пропорційно переведені в максимум роботи.</p>
    {value.criteria.map((criterion, index) => <fieldset key={criterion.id} disabled={disabled} className="teaching-rubric-criterion"><div className="teaching-test-heading"><TeachingField label={`Критерій ${index + 1}`}><input className={teachingInput} maxLength={200} value={criterion.title} onChange={event => change(index, { title: event.target.value })} placeholder="Наприклад, аргументація" /></TeachingField><TeachingButton disabled={disabled || value.criteria.length === 1} onClick={() => onChange({ criteria: value.criteria.filter((_, at) => at !== index) })}><Trash2 size={15} />Прибрати критерій</TeachingButton></div>
      {criterion.levels.map((level, levelIndex) => <div className="teaching-rubric-level" key={level.id}><TeachingField label={`Рівень ${levelIndex + 1}`}><input className={teachingInput} maxLength={300} value={level.label} onChange={event => change(index, { levels: criterion.levels.map(item => item.id === level.id ? { ...item, label: event.target.value } : item) })} /></TeachingField><TeachingField label="Бали"><input className={teachingInput} type="number" min={0} max={10000} step="0.01" value={level.points} onChange={event => change(index, { levels: criterion.levels.map(item => item.id === level.id ? { ...item, points: Number(event.target.value) } : item) })} /></TeachingField><TeachingButton disabled={disabled || criterion.levels.length <= 2} onClick={() => change(index, { levels: criterion.levels.filter(item => item.id !== level.id) })}><Trash2 size={14} /><span className="sr-only">Прибрати рівень</span></TeachingButton></div>)}
      <TeachingButton disabled={disabled || criterion.levels.length >= 10} onClick={() => change(index, { levels: [...criterion.levels, { id: crypto.randomUUID(), label: '', points: 0 }] })}><Plus size={14} />Додати рівень</TeachingButton>
    </fieldset>)}<TeachingButton disabled={disabled || value.criteria.length >= 20} onClick={() => onChange({ criteria: [...value.criteria, freshCriterion()] })}><Plus size={14} />Додати критерій</TeachingButton>
  </>}</div>
}

export function TeachingRubricAssessment({ rubric, value, maximum, onChange, disabled = false }: { rubric: TeachingRubric; value: TeachingRubricLevels; maximum: number; onChange?: (levels: TeachingRubricLevels) => void; disabled?: boolean }) {
  const score = teachingRubricScore(rubric, value, maximum)
  return <div className="teaching-rubric-assessment">{rubric.criteria.map(criterion => <fieldset key={criterion.id} disabled={disabled || !onChange} className="teaching-rubric-criterion"><legend>{criterion.title}</legend><div className="teaching-rubric-choices">{criterion.levels.map(level => <button type="button" key={level.id} className="teaching-rubric-choice" aria-pressed={value[criterion.id] === level.id} disabled={disabled || !onChange} onClick={() => onChange?.({ ...value, [criterion.id]: level.id })}><span>{level.label}</span><strong>{level.points}</strong></button>)}</div></fieldset>)}<p className="teaching-note">{score == null ? 'Оберіть рівень для кожного критерію.' : `За критеріями: ${score} із ${maximum} балів.`}</p></div>
}

export function TeachingAssignmentRubricSettings({ assignmentId, groupId, userId, disabled, onSaved }: { assignmentId: string; groupId: string; userId?: string; disabled?: boolean; onSaved?: () => void }) {
  const [data, setData] = useState<TeachingRubricData | null>(null), [value, setValue] = useState<TeachingRubric | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(false)
  const scope = assignmentId + ':' + groupId, current = useRef(scope); current.current = scope
  useEffect(() => { let active = true; setData(null); setOpen(false); setError(''); void teachingRubricRepository.get(assignmentId, groupId).then(data => { if (active) { setData(data); setValue(data.rubric) } }).catch(failure => { if (active) setError(teachingRubricError(failure)) }); return () => { active = false } }, [scope])
  async function save() {
    if (busy || !data || current.current !== scope) return
    setBusy(true); setError('')
    try { const next = await teachingRubricRepository.mutate('save_rubric', { assignment_id: assignmentId, group_id: groupId, expected_user_id: userId, version: data.version, rubric: value }); if (current.current === scope) { setData(next); setValue(next.rubric); setOpen(false); onSaved?.() } }
    catch (failure) { if (current.current === scope) setError(teachingRubricError(failure)) }
    finally { if (current.current === scope) setBusy(false) }
  }
  return <section className="teaching-note mb-4"><TeachingButton disabled={disabled || busy || !data?.can_edit} onClick={() => setOpen(value => !value)}><ListChecks size={15} />{data?.rubric ? 'Критерії оцінювання завдання' : 'Налаштувати критерії оцінювання'}</TeachingButton>{error && <p role="alert" className="teaching-error mt-3">{error}</p>}{open && <div className="mt-4 space-y-3"><TeachingRubricEditor value={value} onChange={setValue} disabled={disabled || busy} /><p className="text-xs text-muted-foreground">Критерії однакові для всіх груп цього завдання. Після першого оцінювання змінювати їх не можна.</p><TeachingButton primary busy={busy} onClick={() => void save()}>Зберегти критерії</TeachingButton></div>}</section>
}

export function TeachingSubmissionRubric({ assignmentId, groupId, submissionId, userId, maximum, submissionVersion, gradeVersion, disabled, student = false, onSaved }: { assignmentId: string; groupId: string; submissionId: string; userId?: string; maximum: number; submissionVersion: number; gradeVersion?: number; disabled?: boolean; student?: boolean; onSaved?: () => Promise<void> }) {
  const [data, setData] = useState<TeachingRubricData | null>(null), [levels, setLevels] = useState<TeachingRubricLevels>({}), [feedback, setFeedback] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [saved, setSaved] = useState(false)
  const scope = assignmentId + ':' + groupId + ':' + submissionId + ':' + submissionVersion, current = useRef(scope); current.current = scope
  useEffect(() => { let active = true; setData(null); setError(''); setSaved(false); setConfirmed(false); void teachingRubricRepository.get(assignmentId, groupId).then(data => { if (active) { setData(data); const mark = data.marks.find(mark => mark.submission_id === submissionId); setLevels(mark?.levels || {}); setFeedback(mark?.feedback || '') } }).catch(failure => { if (active && !student) setError(teachingRubricError(failure)) }); return () => { active = false } }, [scope, student])
  const mark = data?.marks.find(mark => mark.submission_id === submissionId), rubric = mark?.rubric || data?.rubric
  if (!rubric || student && !mark) return error ? <p role="alert" className="teaching-error">{error}</p> : null
  const score = teachingRubricScore(rubric, levels, maximum)
  async function save() {
    if (busy || !confirmed || !data || score == null || current.current !== scope) return
    setBusy(true); setError('')
    try { const next = await teachingRubricRepository.mutate('assess_submission', { assignment_id: assignmentId, group_id: groupId, submission_id: submissionId, expected_user_id: userId, rubric_version: data.version, submission_version: submissionVersion, grade_version: gradeVersion || 0, version: mark?.version || 0, levels, feedback, reason: 'Оцінено за критеріями' }); if (current.current === scope) { setData(next); setSaved(true); await onSaved?.() } }
    catch (failure) { if (current.current === scope) setError(teachingRubricError(failure)) }
    finally { if (current.current === scope) setBusy(false) }
  }
  return <section className="teaching-rubric-section mt-4"><h3 className="font-semibold">Оцінювання за критеріями</h3><TeachingRubricAssessment rubric={rubric} value={levels} maximum={maximum} disabled={disabled || student || busy || saved} onChange={student ? undefined : value => { setLevels(value); setConfirmed(false) }} />{error && <p role="alert" className="teaching-error">{error}</p>}{student ? mark?.feedback && <p>{mark.feedback}</p> : <><TeachingField label="Коментар до критеріїв"><textarea className={teachingInput} rows={2} maxLength={2000} value={feedback} disabled={disabled || busy || saved} onChange={event => { setFeedback(event.target.value); setConfirmed(false) }} /></TeachingField>{saved ? <p role="status" className="teaching-note">Оцінку збережено в чернетку журналу. Студент побачить її після публікації в журналі.</p> : <><label className="teaching-check"><input type="checkbox" checked={confirmed} disabled={disabled || busy || !data?.can_grade || score == null} onChange={event => setConfirmed(event.target.checked)} />Підтверджую оцінювання за всіма критеріями</label><TeachingButton primary disabled={disabled || !confirmed || score == null || !data?.can_grade} busy={busy} onClick={() => void save()}>Зберегти оцінку в чернетку журналу</TeachingButton></>}</>}</section>
}
