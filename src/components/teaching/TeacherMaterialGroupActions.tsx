import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { teachingError, type TeachingCourse, type TeachingGroupMaterial, type TeachingPublication, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { PublicationEditor } from './TeachingPublications'
import { TeachingMaterialWithdrawal } from './TeachingMaterialWithdrawal'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'

/** Edit the canonical teacher publication, never its read-only group projection. */
export function TeacherMaterialGroupActions({ repository, groupId, userId, material, onRefresh }: {
  repository: TeachingRepository; groupId: string; userId: string;
  material?: TeachingGroupMaterial; onRefresh: () => Promise<void>;
}) {
  const [choosing, setChoosing] = useState(false), [courses, setCourses] = useState<TeachingCourse[]>([])
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [editor, setEditor] = useState<{ snapshot: TeachingSnapshot; initial: TeachingPublication | null } | null>(null)
  const generation = useRef(0), lock = useRef(false)
  useEffect(() => () => { ++generation.current }, [])
  async function edit(courseId: string, expected?: TeachingGroupMaterial) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    const sequence = ++generation.current
    try {
      const snapshot = await repository.course(courseId)
      if (sequence !== generation.current) return
      if (snapshot.course.archived_at || !snapshot.course.permissions.includes('materials')
        || !snapshot.groups.some(group => group.group_id === groupId && group.status === 'accepted')) throw new Error('TEACHING_FORBIDDEN')
      const initial = expected ? snapshot.materials.find(item => item.id === expected.id) : null
      if (expected && (!initial || initial.created_by !== userId || expected.can_edit === false)) throw new Error('TEACHING_MATERIAL_AUTHOR_REQUIRED')
      if (expected && initial?.version !== expected.version) throw new Error('Матеріал уже змінився. Оновіть список і відкрийте його знову.')
      setEditor({ snapshot, initial: initial || null }); setChoosing(false)
    } catch (failure) { if (sequence === generation.current) setError(teachingError(failure)) }
    finally { if (sequence === generation.current) setBusy(false); lock.current = false }
  }
  async function choose() {
    if (lock.current) return
    lock.current = true; setChoosing(true); setBusy(true); setError(''); setSelected(''); setCourses([])
    const sequence = ++generation.current
    try {
      const context = await repository.groupContext(groupId)
      if (sequence !== generation.current) return
      const available = context.courses.filter(course => !course.archived_at && course.permissions.includes('materials'))
      setCourses(available); if (available.length === 1) setSelected(available[0].id)
    } catch { if (sequence === generation.current) setError('Спочатку підключіть цю групу до свого предмета у розділі «Викладання».') }
    finally { if (sequence === generation.current) setBusy(false); lock.current = false }
  }
  if (material && material.created_by !== userId) return null
  return <>
    <div className="flex flex-wrap gap-2">
      {!material ? <TeachingButton primary disabled={busy} onClick={() => void choose()}><Plus size={15} />Додати матеріал від викладача</TeachingButton>
        : material.can_edit && <TeachingButton disabled={busy} onClick={() => void edit(material.course_id, material)}><Pencil size={15} />Редагувати свій матеріал</TeachingButton>}
      {material?.can_withdraw && <TeachingMaterialWithdrawal material={material} repository={repository} onWithdrawn={onRefresh} />}
    </div>
    {error && !choosing && <p role="alert" className="teaching-error mt-3">{error}</p>}
    {choosing && <TeachingModal title="Матеріал від викладача" description="Виберіть свій предмет. Ця група вже буде вибрана в редакторі." busy={busy} onClose={() => setChoosing(false)}>
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {!busy && !error && !courses.length && <p className="text-sm">Для цієї групи немає вашого підключеного предмета з дозволом на матеріали. Підключіть його у «Викладанні».</p>}
      <TeachingField label="Предмет"><select className={teachingInput} value={selected} onChange={event => setSelected(event.target.value)} disabled={busy}><option value="">Оберіть предмет</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title} · {course.semester}</option>)}</select></TeachingField>
      <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setChoosing(false)}>Скасувати</TeachingButton><TeachingButton primary busy={busy} disabled={!selected} onClick={() => void edit(selected)}>Додати матеріал</TeachingButton></div>
    </TeachingModal>}
    {editor && <PublicationEditor kind="material" initial={editor.initial} groupId={groupId} snapshot={editor.snapshot} repository={repository} userId={userId} onClose={() => setEditor(null)} onRefresh={onRefresh} />}
  </>
}
