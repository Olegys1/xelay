import { useRef, useState, type FormEvent } from 'react'
import { Clock3, RefreshCw } from 'lucide-react'
import { localDeadline, teachingDate, type TeachingRepository, type TeachingSubmissionData } from '../../lib/teaching'
import { teachingSubmissionError } from './TeachingSubmissionPanel'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { publicationTime } from './TeachingPublicationTimingFields'

export function TeachingSubmissionExtension({ repository, data, groupId, onSaved, onClose }: { repository: TeachingRepository; data: TeachingSubmissionData; groupId: string; onSaved: () => Promise<void>; onClose: () => void }) {
  const [studentId, setStudentId] = useState(data.students[0]?.user_id || '')
  const [deadline, setDeadline] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [needsRefresh, setNeedsRefresh] = useState(false)
  const lock = useRef(false), operationId = useRef(crypto.randomUUID())
  const extension = data.submission_extensions?.find(row => row.user_id === studentId)
  const groupClose = data.item.targets.find(target => target.group_id === groupId)?.closes_at
  async function save(remove = false) {
    if (lock.current || needsRefresh) return
    let closes: string | null = null
    try { closes = remove ? null : publicationTime(deadline) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Перевірте дату й час.'); return }
    if (!studentId || !remove && (!groupClose || !closes || Date.parse(closes) <= Date.now() || Date.parse(closes) <= Date.parse(groupClose))) { setError('Оберіть студента та майбутній час пізніше загального закриття.'); return }
    lock.current = true; setBusy(true); setError('')
    try { await repository.classroomMutate('set_submission_extension', { id: operationId.current, request_id: operationId.current, item_id: data.item.id, group_id: groupId, user_id: studentId, closes_at: closes, version: extension?.version || 0 }); await onSaved(); onClose() }
    catch (failure) { setError(teachingSubmissionError(failure)); setNeedsRefresh(true) }
    finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title="Індивідуальний термін" description={data.item.title} busy={busy} onClose={onClose}><form className="teaching-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void save() }}><p className="teaching-note">Продовження відкриє здавання лише обраному студенту. Загальний термін групи та можливість виставляти бали збережуться.</p>{error && <p role="alert" className="teaching-error">{error}</p>}<TeachingField label="Студент"><select className={teachingInput} name="extension-student" value={studentId} onChange={event => { setStudentId(event.target.value); setDeadline(''); operationId.current = crypto.randomUUID(); setError('') }} disabled={busy || needsRefresh}>{data.students.map(student => <option value={student.user_id} key={student.user_id}>{student.full_name}</option>)}</select></TeachingField><p className="text-xs text-muted-foreground">Закриття для групи: {groupClose ? teachingDate(groupClose, true) : 'не встановлено — здавання відкрите'}{extension?.closes_at && <span className="mt-1 block">Індивідуально відкрито до {teachingDate(extension.closes_at, true)}</span>}</p><TeachingField label="Продовжити до" hint="Дата й час за Києвом."><input type="datetime-local" name="extension-closes-at" className={teachingInput} required value={deadline} min={localDeadline(new Date(Math.max(Date.now(), groupClose ? Date.parse(groupClose) : 0)).toISOString())} onChange={event => setDeadline(event.target.value)} disabled={busy || needsRefresh || !groupClose} /></TeachingField><div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>Закрити</TeachingButton>{needsRefresh ? <TeachingButton primary busy={busy} onClick={() => { setBusy(true); void onSaved().then(onClose).catch(failure => setError(teachingSubmissionError(failure))).finally(() => setBusy(false)) }}><RefreshCw size={14} />Оновити дані</TeachingButton> : <>{extension?.closes_at && <TeachingButton disabled={busy} onClick={() => void save(true)}>Повернути загальний термін</TeachingButton>}<TeachingButton primary type="submit" busy={busy} disabled={!studentId || !groupClose}><Clock3 size={14} />Продовжити термін</TeachingButton></>}</div></form></TeachingModal>
}
