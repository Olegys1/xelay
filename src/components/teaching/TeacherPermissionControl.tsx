import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { TEACHING_PERMISSIONS, teachingError, type TeachingPermission, type TeachingRepository, type TeachingTeacher } from '../../lib/teaching'
import { TeachingButton, TeachingModal } from './TeachingUI'

export function TeacherPermissionControl({ teacher, repository, onRefresh }: { teacher: TeachingTeacher; repository: TeachingRepository; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const [permissions, setPermissions] = useState<TeachingPermission[]>(teacher.permissions)
  async function save() {
    if (busy || committed || !permissions.length) return
    setBusy(true); setError('')
    try { await repository.mutate('update_teacher', { teacher_link_id: teacher.id, permissions }); setCommitted(true); await onRefresh(); setOpen(false) } catch (failure) { setError(teachingError(failure)) } finally { setBusy(false) }
  }
  return <><TeachingButton onClick={() => { setPermissions(teacher.permissions); setError(''); setCommitted(false); setOpen(true) }}><Settings2 size={15} />Дозволи</TeachingButton>{open && <TeachingModal title="Дозволи викладача" description={teacher.full_name} onClose={() => setOpen(false)} busy={busy}><div className="teaching-form">{error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p className="teaching-note">Дозволи збережено. Оновіть список викладачів.</p> : <fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold">Доступ лише до цього предмета</legend>{TEACHING_PERMISSIONS.map(p => <label className="teaching-check" key={p.id}><input type="checkbox" checked={permissions.includes(p.id)} disabled={busy} onChange={event => setPermissions(event.target.checked ? [...permissions, p.id] : permissions.filter(id => id !== p.id))} />{p.label}</label>)}</fieldset>}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setOpen(false)}>Закрити</TeachingButton>{!committed && <TeachingButton primary busy={busy} disabled={!permissions.length} onClick={() => void save()}>Зберегти дозволи</TeachingButton>}</div></div></TeachingModal>}</>
}
