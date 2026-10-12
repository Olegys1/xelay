import { useState, type FormEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { defaultTeachingSemester, teachingError, TEACHING_PERMISSIONS, type TeachingCategory, type TeachingCourse, type TeachingPermission, type TeachingRepository, type TeachingSnapshot, type TeachingWorkspaceData } from '../../lib/teaching'
import { TeachingButton, TeachingField, teachingInput, TeachingModal } from './TeachingUI'

export type CourseDialog = 'course' | 'settings' | 'copy' | 'group' | 'teacher' | 'archive'
export function TeachingCourseForms({ dialog, snapshot, workspace, repository, onSaved, onClose }: { dialog: CourseDialog; snapshot: TeachingSnapshot | null; workspace: TeachingWorkspaceData; repository: TeachingRepository; onSaved: (id?: string) => Promise<void>; onClose: () => void }) {
  const course = snapshot?.course
  const [id] = useState(crypto.randomUUID())
  const defaults = defaultTeachingSemester()
  const [title, setTitle] = useState(course?.title || '')
  const [semester, setSemester] = useState(dialog === 'copy' ? defaults.semester : course?.semester || defaults.semester)
  const [starts, setStarts] = useState(dialog === 'copy' ? defaults.starts_on : course?.starts_on || defaults.starts_on)
  const [ends, setEnds] = useState(dialog === 'copy' ? defaults.ends_on : course?.ends_on || defaults.ends_on)
  const [categories, setCategories] = useState<TeachingCategory[]>(course?.grading_rules?.categories || [])
  const [total, setTotal] = useState(course?.grading_rules?.total_max?.toString() || '')
  const [groupId, setGroupId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [teacherId, setTeacherId] = useState('')
  const [permissions, setPermissions] = useState<TeachingPermission[]>(['materials', 'assignments'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [committed, setCommitted] = useState(false)
  const titles: Record<CourseDialog, string> = { course: 'Новий предмет', settings: 'Налаштування предмета', copy: 'Новий семестр', group: 'Підключити групу', teacher: 'Запросити викладача', archive: course?.archived_at ? 'Відновити предмет' : 'Завершити семестр' }
  const groups = workspace.groups.filter(g => !snapshot?.groups.some(link => link.group_id === g.id && ['accepted', 'pending_group', 'pending_teacher'].includes(link.status)))
  const group = groups.find(g => g.id === groupId)
  const directory = workspace.teacher_directory.filter(t => (t.user_id || t.id) !== course?.owner_id && !snapshot?.teachers.some(link => link.user_id === (t.user_id || t.id) && ['pending', 'accepted'].includes(link.status)))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || committed) return
    setError(''); setBusy(true)
    try {
      let action: string, payload: Record<string, unknown>
      const coursePayload = { title: title.trim(), semester: semester.trim(), starts_on: starts, ends_on: ends, grading_rules: { categories, ...(total ? { total_max: Number(total) } : {}) } }
      if (['course', 'settings', 'copy'].includes(dialog)) {
        if (!title.trim() || !semester.trim() || starts > ends) throw new Error('Перевірте назву предмета, семестр і порядок дат.')
        if (categories.some(c => !c.name.trim() || !Number.isFinite(c.max_points) || c.max_points <= 0)) throw new Error('Кожна категорія має мати назву й додатний максимальний бал.')
        if (total && (!Number.isFinite(Number(total)) || Number(total) <= 0)) throw new Error('Максимальний підсумок має бути додатним числом.')
        action = dialog === 'course' ? 'create_course' : dialog === 'copy' ? 'copy_course' : 'update_course'
        payload = dialog === 'course' ? { ...coursePayload, id } : { ...coursePayload, ...(dialog === 'copy' ? { id } : {}), course_id: course!.id, version: course!.version }
      } else if (dialog === 'group') {
        if (!groupId) throw new Error('Оберіть групу.')
        action = 'invite_group'; payload = { course_id: course!.id, group_id: groupId, subject_id: subjectId || null }
      } else if (dialog === 'teacher') {
        if (!teacherId || !permissions.length) throw new Error('Оберіть викладача та хоча б один дозвіл.')
        action = 'invite_teacher'; payload = { course_id: course!.id, user_id: teacherId, permissions }
      } else {
        action = 'archive_course'; payload = { course_id: course!.id, archived: !course!.archived_at, version: course!.version }
      }
      const result = await repository.mutate(action, payload)
      setCommitted(true)
      await onSaved(dialog === 'course' || dialog === 'copy' ? result.id : undefined)
      onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { setBusy(false) }
  }
  return <TeachingModal title={titles[dialog]} onClose={onClose} busy={busy} description={dialog === 'group' ? 'Група з’явиться після підтвердження старостою.' : dialog === 'teacher' ? 'Викладач отримає лише вибрані дозволи й має прийняти запрошення.' : undefined}>
    <form onSubmit={submit} className="teaching-form">
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {committed ? <p role="status" className="teaching-note">Зміни збережено. Якщо сторінка не оновилася, закрийте вікно та оновіть список.</p> : <>
      {['course', 'settings', 'copy'].includes(dialog) && <>
        {dialog !== 'copy' && <TeachingField label="Назва предмета"><input name="course-title" className={teachingInput} value={title} onChange={e => setTitle(e.target.value)} required maxLength={160} placeholder="Наприклад, Економічна теорія" disabled={busy} autoFocus /></TeachingField>}
        <TeachingField label="Семестр"><input name="semester" className={teachingInput} value={semester} onChange={e => setSemester(e.target.value)} required maxLength={100} disabled={busy} /></TeachingField>
        <div className="grid grid-cols-2 gap-3"><TeachingField label="Початок"><input name="starts-on" type="date" className={teachingInput} value={starts} onChange={e => setStarts(e.target.value)} required disabled={busy} /></TeachingField><TeachingField label="Завершення"><input name="ends-on" type="date" className={teachingInput} value={ends} onChange={e => setEnds(e.target.value)} required min={starts} disabled={busy} /></TeachingField></div>
        {dialog === 'copy' ? <p className="teaching-note">Структура предмета й матеріали будуть скопійовані. Нові групи потрібно підтвердити; журнал нового семестру почнеться без балів.</p> : <>
          <fieldset className="space-y-3"><legend className="text-sm font-semibold">Правила оцінювання</legend><p className="text-xs leading-relaxed text-muted-foreground">Можна налаштувати пізніше. Максимум категорії обмежує суму її робіт, а загальний максимум — підсумок предмета.</p>
          {categories.map((category, index) => <div key={category.id} className="flex items-end gap-2"><TeachingField label={`Категорія ${index + 1}`}><input name={`category-${index}`} value={category.name} className={teachingInput} maxLength={100} required onChange={e => setCategories(categories.map(c => c.id === category.id ? { ...c, name: e.target.value } : c))} disabled={busy} /></TeachingField><div className="w-24 shrink-0"><TeachingField label="До балів"><input name={`category-max-${index}`} type="number" min="0.01" max="10000" step="0.01" required className={teachingInput} value={category.max_points} onChange={e => setCategories(categories.map(c => c.id === category.id ? { ...c, max_points: Number(e.target.value) } : c))} disabled={busy} /></TeachingField></div><button type="button" className="teaching-icon-button" aria-label={`Прибрати категорію ${category.name}`} disabled={busy || Boolean(snapshot?.activities.some(a => a.category === category.id))} title="Категорію з роботами можна перейменувати, але не прибрати" onClick={() => setCategories(categories.filter(c => c.id !== category.id))}><X size={16} /></button></div>)}
          <TeachingButton disabled={busy || categories.length >= 12} onClick={() => setCategories([...categories, { id: crypto.randomUUID(), name: '', max_points: 20 }])}><Plus size={16} />Додати категорію</TeachingButton>
          </fieldset><TeachingField label="Загальний максимальний бал" hint="Залиште порожнім для звичайного підсумовування всіх робіт."><input name="total-max" className={teachingInput} type="number" min="0.01" max="10000" step="0.01" value={total} onChange={e => setTotal(e.target.value)} disabled={busy} placeholder="Наприклад, 100" /></TeachingField>
        </>}
      </>}
      {dialog === 'group' && <>
        <TeachingField label="Навчальна група"><select name="group" className={teachingInput} value={groupId} onChange={e => { setGroupId(e.target.value); setSubjectId('') }} required disabled={busy}><option value="">Оберіть групу</option>{groups.map(g => <option key={g.id} value={g.id}>{g.group_name}{g.specialty ? ` · ${g.specialty}` : ''}</option>)}</select></TeachingField>
        {!!group?.subjects?.length && <TeachingField label="Предмет у семінарах групи" hint="Зв’язок дозволить бачити розподіл виступів на семінарах."><select name="seminar-subject" className={teachingInput} value={subjectId} onChange={e => setSubjectId(e.target.value)} disabled={busy}><option value="">За назвою предмета</option>{group.subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></TeachingField>}
        {!groups.length && <p className="teaching-note">Немає інших груп для підключення у вашому університеті.</p>}
      </>}
      {dialog === 'teacher' && <>
        <TeachingField label="Підтверджений викладач"><select name="teacher" className={teachingInput} value={teacherId} onChange={e => setTeacherId(e.target.value)} required disabled={busy}><option value="">Оберіть викладача</option>{directory.map(t => <option key={t.user_id || t.id} value={t.user_id || t.id}>{t.full_name} · {t.department}</option>)}</select></TeachingField>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold">Доступ до предмета</legend>{TEACHING_PERMISSIONS.map(p => <label key={p.id} className="teaching-check"><input type="checkbox" checked={permissions.includes(p.id)} disabled={busy} onChange={e => setPermissions(e.target.checked ? [...permissions, p.id] : permissions.filter(id => id !== p.id))} />{p.label}</label>)}</fieldset>
      </>}
      {dialog === 'archive' && <p className="teaching-note">{course?.archived_at ? 'Предмет знову стане доступним для редагування в межах ваших дозволів.' : 'Матеріали, завдання й опубліковані бали залишаться доступними. Нові зміни будуть закриті до відновлення предмета.'}</p>}
      </>}
      <div className="teaching-form-actions"><TeachingButton onClick={onClose} disabled={busy}>{committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{!committed && <TeachingButton primary type="submit" busy={busy}>{dialog === 'group' || dialog === 'teacher' ? 'Надіслати запрошення' : dialog === 'copy' ? 'Створити новий семестр' : dialog === 'archive' ? course?.archived_at ? 'Відновити' : 'Перенести в архів' : 'Зберегти'}</TeachingButton>}</div>
    </form>
  </TeachingModal>
}
