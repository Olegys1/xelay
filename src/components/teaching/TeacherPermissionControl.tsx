import { useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { teachingError, type TeachingGroup, type TeachingPermission, type TeachingRepository, type TeachingTeacher } from '../../lib/teaching'
import { TeachingButton, TeachingModal } from './TeachingUI'
import { TeachingColleagueScope } from './TeachingColleagueScope'
import type { TeachingGroupScope } from '../../lib/teachingColleagues'

export function TeacherPermissionControl({ teacher, groups, repository, onRefresh }: { teacher: TeachingTeacher; groups: TeachingGroup[]; repository: TeachingRepository; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const [permissions, setPermissions] = useState<TeachingPermission[]>(teacher.permissions)
  const initialScope = (): TeachingGroupScope => ({ group_scope: 'selected', group_ids: groups.filter(group => group.status === 'accepted' && (teacher.group_scope !== 'selected' || teacher.group_ids?.includes(group.group_id))).map(group => group.group_id) })
  const [scope, setScope] = useState<TeachingGroupScope>(initialScope)
  const lock = useRef(false)
  async function save() {
    if (lock.current || committed || !permissions.length || !scope.group_ids.length) return
    lock.current = true
    setBusy(true); setError('')
    try { await repository.mutate('update_teacher', { teacher_link_id: teacher.id, permissions, ...scope }); setCommitted(true); await onRefresh(); setOpen(false) } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <><TeachingButton onClick={() => { setPermissions(teacher.permissions); setScope(initialScope()); setError(''); setCommitted(false); setOpen(true) }}><Settings2 size={15} />Групи й дозволи</TeachingButton>{open && <TeachingModal title="Доступ колеги до предмета" description={teacher.full_name} onClose={() => setOpen(false)} busy={busy}><div className="teaching-form">{error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p className="teaching-note">Дозволи збережено. Оновіть список викладачів.</p> : <TeachingColleagueScope groups={groups} scope={scope} onScope={setScope} permissions={permissions} onPermissions={setPermissions} disabled={busy} />}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setOpen(false)}>Закрити</TeachingButton>{!committed && <TeachingButton primary busy={busy} disabled={!permissions.length || !scope.group_ids.length} onClick={() => void save()}>Зберегти дозволи</TeachingButton>}</div></div></TeachingModal>}</>
}
