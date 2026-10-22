import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Pencil, Plus, RefreshCw } from 'lucide-react'
import { teachingDate, teachingError, type TeachingCourse, type TeachingOwnedMaterial, type TeachingPublication, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { PublicationEditor, TeachingResources } from './TeachingPublications'
import { TeachingMaterialWithdrawal } from './TeachingMaterialWithdrawal'

export function TeachingMyMaterials({ repository, userId }: { repository: TeachingRepository; userId: string }) {
  return <TeachingMyMaterialsContents key={`${repository.mode}:${userId}`} repository={repository} userId={userId} />
}

function TeachingMyMaterialsContents({ repository, userId }: { repository: TeachingRepository; userId: string }) {
  const [items, setItems] = useState<TeachingOwnedMaterial[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [coursePicker, setCoursePicker] = useState(false), [courses, setCourses] = useState<TeachingCourse[]>([])
  const [selectedCourseId, setSelectedCourseId] = useState(''), [selectedSnapshot, setSelectedSnapshot] = useState<TeachingSnapshot | null>(null)
  const [preparing, setPreparing] = useState(''), [editorError, setEditorError] = useState('')
  const [editor, setEditor] = useState<{ snapshot: TeachingSnapshot; initial: TeachingPublication | null; groupId?: string } | null>(null)
  const generation = useRef(0)
  const editorGeneration = useRef(0)
  const editorLock = useRef(false)
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try { const data = await repository.myMaterials(); if (current === generation.current) { setItems(data.materials); setError('') } }
    catch (failure) { if (current === generation.current) setError(teachingError(failure)) }
    finally { if (current === generation.current) setLoading(false) }
  }, [repository, userId])
  useEffect(() => { setItems([]); setEditor(null); setCoursePicker(false); void load(); return () => { ++generation.current; ++editorGeneration.current; editorLock.current = false } }, [load])

  async function startCreate() {
    if (editorLock.current) return
    editorLock.current = true
    const sequence = ++editorGeneration.current
    setCoursePicker(true); setEditorError(''); setSelectedCourseId(''); setSelectedSnapshot(null); setCourses([]); setPreparing('courses')
    try {
      const workspace = await repository.workspace()
      if (sequence === editorGeneration.current) setCourses(workspace.courses.filter(course => !course.archived_at && course.permissions.includes('materials')))
    } catch (failure) { if (sequence === editorGeneration.current) setEditorError(teachingError(failure)) }
    finally { if (sequence === editorGeneration.current) { setPreparing(''); editorLock.current = false } }
  }
  async function selectCourse(courseId: string) {
    const sequence = ++editorGeneration.current
    setSelectedCourseId(courseId); setSelectedSnapshot(null); setEditorError('')
    if (!courseId) { setPreparing(''); editorLock.current = false; return }
    editorLock.current = true; setPreparing('course')
    try {
      const snapshot = await repository.course(courseId)
      if (sequence !== editorGeneration.current) return
      if (snapshot.course.archived_at || !snapshot.course.permissions.includes('materials')) throw new Error('TEACHING_FORBIDDEN')
      setSelectedSnapshot(snapshot)
    } catch (failure) { if (sequence === editorGeneration.current) setEditorError(teachingError(failure)) }
    finally { if (sequence === editorGeneration.current) { setPreparing(''); editorLock.current = false } }
  }
  async function editMaterial(item: TeachingOwnedMaterial) {
    if (editorLock.current || item.created_by !== userId || item.can_edit === false || item.withdrawn_at || item.course_archived_at) return
    editorLock.current = true
    const sequence = ++editorGeneration.current
    setPreparing(item.id); setEditorError('')
    try {
      const snapshot = await repository.course(item.course_id)
      if (sequence !== editorGeneration.current) return
      const material = snapshot.materials.find(candidate => candidate.id === item.id)
      if (!material || material.created_by !== userId || snapshot.course.archived_at || !snapshot.course.permissions.includes('materials')) throw new Error('TEACHING_FORBIDDEN')
      const activeGroup = snapshot.groups.find(group => group.status === 'accepted' && (material.targets.length === 0 || material.targets.some(target => target.group_id === group.group_id)))
      if (!activeGroup) throw new Error('Немає активної підключеної групи для редагування цього матеріалу. Відкликання залишається доступним.')
      setEditor({ snapshot, initial: material, groupId: material.targets.length ? activeGroup.group_id : undefined })
    } catch (failure) { if (sequence === editorGeneration.current) setEditorError(teachingError(failure)) }
    finally { if (sequence === editorGeneration.current) { setPreparing(''); editorLock.current = false } }
  }
  function closePicker() {
    ++editorGeneration.current; editorLock.current = false; setPreparing(''); setCoursePicker(false); setEditorError('')
  }
  return <section className="space-y-4" aria-label="Мої матеріали">
    <div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-xl text-sm leading-relaxed text-muted-foreground">Створюйте й редагуйте свої матеріали для груп. Відкликання доступне також після завершення семестру чи відключення від предмета.</p><div className="flex flex-wrap gap-2"><TeachingButton primary disabled={Boolean(preparing)} onClick={() => void startCreate()}><Plus size={15} />Додати матеріал</TeachingButton><TeachingButton disabled={loading || Boolean(preparing)} onClick={() => void load()}><RefreshCw size={15} />Оновити</TeachingButton></div></div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {editorError && !coursePicker && <p role="alert" className="teaching-error">{editorError}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Завантажуємо ваші матеріали…</p>}
    {!loading && !error && !items.length && <TeachingEmpty icon={<FileText size={24} />} title="Ви ще не додавали матеріалів" description="Натисніть «Додати матеріал», оберіть предмет і групу. Публікація з’явиться в матеріалах цієї групи." />}
    <div className="teaching-list">{items.map(item => <article className="teaching-card" key={item.id}>
      <div className="flex flex-wrap gap-2"><span className="teaching-badge">{item.withdrawn_at ? 'Відкликано' : item.status === 'published' ? 'Опубліковано' : item.status === 'scheduled' ? `Заплановано · ${teachingDate(item.publish_at, true)}` : 'Чернетка'}</span>{item.course_archived_at && <span className="teaching-badge">Семестр завершено</span>}</div>
      <h3 className="mt-3 break-words font-semibold">{item.title}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{item.course_title} · {item.author_name}{item.published_at ? ` · ${teachingDate(item.published_at)}` : ''}</p>
      {item.body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>}
      {!item.withdrawn_at && <TeachingResources publication={item} repository={repository} kind="material" />}
      {!item.withdrawn_at && <div className="mt-4 flex flex-wrap gap-2">
        {item.created_by === userId && item.can_edit !== false && !item.course_archived_at && <TeachingButton disabled={Boolean(preparing)} busy={preparing === item.id} onClick={() => void editMaterial(item)}><Pencil size={15} />Редагувати</TeachingButton>}
        {item.can_withdraw && <TeachingMaterialWithdrawal material={item} repository={repository} onWithdrawn={load} />}
      </div>}
    </article>)}</div>
    {coursePicker && <TeachingModal title="Додати матеріал" description="Оберіть предмет, а потім групу для публікації." onClose={closePicker}>
      <div className="space-y-4">
        {editorError && <p role="alert" className="teaching-error">{editorError}</p>}
        {preparing === 'courses' ? <p role="status" className="text-sm text-muted-foreground">Завантажуємо ваші предмети…</p> : courses.length ? <TeachingField label="Ваш предмет"><select name="my-material-course" className={teachingInput} value={selectedCourseId} onChange={event => void selectCourse(event.target.value)} disabled={Boolean(preparing)}><option value="">Оберіть предмет</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title} · {course.semester}</option>)}</select></TeachingField> : !editorError && <p className="teaching-note">Потрібен активний предмет із дозволом на матеріали. Створіть предмет або прийміть запрошення колеги.</p>}
        {preparing === 'course' && <p role="status" className="text-sm text-muted-foreground">Перевіряємо підключені групи…</p>}
        {selectedSnapshot && !selectedSnapshot.groups.some(group => group.status === 'accepted') && <p className="teaching-note">Спочатку підключіть навчальну групу до цього предмета й дочекайтеся підтвердження старости.</p>}
        <div className="teaching-form-actions"><TeachingButton onClick={closePicker}>Скасувати</TeachingButton><TeachingButton primary disabled={Boolean(preparing) || !selectedSnapshot || !selectedSnapshot.groups.some(group => group.status === 'accepted')} onClick={() => { if (selectedSnapshot) { setEditor({ snapshot: selectedSnapshot, initial: null }); setCoursePicker(false); setEditorError('') } }}>Продовжити</TeachingButton></div>
      </div>
    </TeachingModal>}
    {editor && <PublicationEditor key={editor.initial?.id || `new:${editor.snapshot.course.id}`} kind="material" initial={editor.initial} groupId={editor.groupId} snapshot={editor.snapshot} repository={repository} userId={userId} onClose={() => setEditor(null)} onRefresh={load} />}
  </section>
}
