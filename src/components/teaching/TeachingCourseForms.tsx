import { useRef, useState, type FormEvent } from 'react'
import { defaultTeachingSemester, teachingError, TEACHING_PERMISSIONS, type TeachingCourse, type TeachingPermission, type TeachingRepository, type TeachingSnapshot, type TeachingWorkspaceData } from '../../lib/teaching'
import { TeachingButton, TeachingField, teachingInput, TeachingModal } from './TeachingUI'
import { teachingGroupDirectoryLabel, teachingGroupDirectoryMatches } from '../../lib/teachingGroupDirectory'
import { calculateTeachingTotal, teachingCoefficient, teachingRounding, type TeachingRounding, type TeachingWorkPreset, validateTeachingGradingRules } from '../../lib/teachingGrading'
import { TeachingGradingRulesEditor } from './TeachingGradingRulesEditor'

export type CourseDialog = 'course' | 'settings' | 'copy' | 'group' | 'teacher' | 'archive'
export function TeachingCourseForms({ dialog, snapshot, workspace, repository, onSaved, onClose }: { dialog: CourseDialog; snapshot: TeachingSnapshot | null; workspace: TeachingWorkspaceData; repository: TeachingRepository; onSaved: (id?: string) => Promise<void>; onClose: () => void }) {
  const course = snapshot?.course
  const categoryInUse = (id: string) => Boolean(snapshot?.activities.some(activity => activity.category === id) || snapshot?.assignments.some(assignment => assignment.category === id))
  const [id] = useState(() => crypto.randomUUID())
  const defaults = defaultTeachingSemester()
  const [title, setTitle] = useState(course?.title || '')
  const [semester, setSemester] = useState(dialog === 'copy' ? defaults.semester : course?.semester || defaults.semester)
  const [starts, setStarts] = useState(dialog === 'copy' ? defaults.starts_on : course?.starts_on || defaults.starts_on)
  const [ends, setEnds] = useState(dialog === 'copy' ? defaults.ends_on : course?.ends_on || defaults.ends_on)
  const [categories, setCategories] = useState<NonNullable<typeof course>['grading_rules']['categories']>(course?.grading_rules?.categories || [])
  const [presets, setPresets] = useState<TeachingWorkPreset[]>(course?.grading_rules.presets || [])
  const [total, setTotal] = useState(course?.grading_rules?.total_max?.toString() || '')
  const [rounding, setRounding] = useState<TeachingRounding>(teachingRounding(course?.grading_rules?.rounding))
  const [groupId, setGroupId] = useState('')
  const [groupQuery, setGroupQuery] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [teacherId, setTeacherId] = useState('')
  const [permissions, setPermissions] = useState<TeachingPermission[]>(['materials', 'assignments'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [committed, setCommitted] = useState(false)
  const lock = useRef(false)
  const titles: Record<CourseDialog, string> = { course: 'Новий предмет', settings: 'Налаштування предмета', copy: 'Новий семестр', group: 'Підключити групу', teacher: 'Запросити викладача', archive: course?.archived_at ? 'Відновити предмет' : 'Завершити семестр' }
  const groups = workspace.groups.filter(g => !snapshot?.groups.some(link => link.group_id === g.id && ['accepted', 'pending_group', 'pending_teacher'].includes(link.status)))
  const group = groups.find(g => g.id === groupId)
  const visibleGroups = groups.filter(item => teachingGroupDirectoryMatches(item, groupQuery) || item.id === groupId)
  const directory = workspace.teacher_directory.filter(t => (t.user_id || t.id) !== course?.owner_id && !snapshot?.teachers.some(link => link.user_id === (t.user_id || t.id) && ['pending', 'accepted'].includes(link.status)))
  const nextRules = { categories, presets, ...(total ? { total_max: Number(total) } : {}), rounding }
  const normalizedRules = (rules: typeof nextRules | NonNullable<typeof course>['grading_rules']) => JSON.stringify({ categories: rules.categories.map(category => ({ ...category, coefficient: teachingCoefficient(category.coefficient) })), total_max: rules.total_max ?? null, rounding: teachingRounding(rules.rounding), presets: rules.presets || [] })
  const rulesChanged = dialog === 'settings' && Boolean(course && normalizedRules(course.grading_rules) !== normalizedRules(nextRules))
  const exampleEntry = snapshot?.entries.find(entry => snapshot.grades.some(grade => grade.entry_id === entry.id && grade.published_at && grade.published_score !== null))
  const exampleValues = exampleEntry && snapshot ? snapshot.activities.filter(activity => activity.group_id === exampleEntry.group_id).map(activity => ({ category: activity.category, score: snapshot.grades.find(grade => grade.activity_id === activity.id && grade.entry_id === exampleEntry.id && grade.published_at)?.published_score })) : []
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (lock.current || committed) return
    lock.current = true; setError(''); setBusy(true)
    try {
      let action: string, payload: Record<string, unknown>
      validateTeachingGradingRules(nextRules)
      const coursePayload = { title: title.trim(), semester: semester.trim(), starts_on: starts, ends_on: ends, grading_rules: nextRules }
      if (['course', 'settings', 'copy'].includes(dialog)) {
        if (!title.trim() || !semester.trim() || starts > ends) throw new Error('Перевірте назву предмета, семестр і порядок дат.')
        if (categories.some(c => !c.name.trim() || !Number.isFinite(c.max_points) || c.max_points <= 0 || c.max_points > 10000 || Math.round(c.max_points * 100) / 100 !== c.max_points)) throw new Error('Кожна категорія має мати назву та максимум від 0,01 до 10 000 балів, до двох знаків після коми.')
        if (categories.some(category => { const value = category.coefficient ?? 1; return !Number.isFinite(value) || value < 0 || value > 100 || Math.round(value * 10000) / 10000 !== value })) throw new Error('Коефіцієнт категорії — число від 0 до 100, до чотирьох знаків після коми.')
        if (total && (!Number.isFinite(Number(total)) || Number(total) <= 0 || Number(total) > 10000 || Math.round(Number(total) * 100) / 100 !== Number(total))) throw new Error('Максимальний підсумок — від 0,01 до 10 000 балів, до двох знаків після коми.')
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
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title={titles[dialog]} onClose={onClose} busy={busy} description={dialog === 'group' ? 'Група з’явиться після підтвердження старостою.' : dialog === 'teacher' ? 'Викладач отримає лише вибрані дозволи й має прийняти запрошення.' : undefined}>
    <form onSubmit={submit} className="teaching-form">
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {committed ? <p role="status" className="teaching-note">Зміни збережено. Якщо сторінка не оновилася, закрийте вікно та оновіть список.</p> : <>
      {['course', 'settings', 'copy'].includes(dialog) && <>
        {dialog !== 'copy' && <TeachingField label="Назва предмета"><input name="course-title" className={teachingInput} value={title} onChange={e => setTitle(e.target.value)} required maxLength={160} placeholder="Наприклад, Економічна теорія" disabled={busy} autoFocus /></TeachingField>}
        <TeachingField label="Семестр"><input name="semester" className={teachingInput} value={semester} onChange={e => setSemester(e.target.value)} required maxLength={100} disabled={busy} /></TeachingField>
        <div className="grid grid-cols-2 gap-3"><TeachingField label="Початок"><input name="starts-on" type="date" className={teachingInput} value={starts} onChange={e => setStarts(e.target.value)} required disabled={busy} /></TeachingField><TeachingField label="Завершення"><input name="ends-on" type="date" className={teachingInput} value={ends} onChange={e => setEnds(e.target.value)} required min={starts} disabled={busy} /></TeachingField></div>
        {dialog === 'copy' ? <p className="teaching-note">Структура предмета та чернетки завдань будуть скопійовані. Нові групи потрібно підтвердити; журнал нового семестру почнеться без балів. Матеріали залишаться у своєму початковому предметі під керуванням викладача, який їх додав.</p> : <>
          <details className="teaching-simple-assessment" open={dialog === 'settings'}><summary>Правила оцінювання та шаблони робіт</summary><TeachingGradingRulesEditor rules={nextRules} disabled={busy} categoryInUse={categoryInUse} onChange={rules => { setCategories(rules.categories); setPresets(rules.presets || []); setTotal(rules.total_max?.toString() || ''); setRounding(teachingRounding(rules.rounding)) }} />{rulesChanged && <div role="status" className="teaching-note mt-4"><p className="font-semibold">Підсумки студентів із загальними правилами предмета перерахуються.</p><p className="mt-2">Початкові оцінки та історія збережуться. Окремі правила груп залишаться чинними.</p>{exampleEntry && course && !snapshot?.groups.find(group => group.group_id === exampleEntry.group_id)?.grading_rules_override && <p className="mt-2">Приклад: {exampleEntry.full_name} — {calculateTeachingTotal(course.grading_rules, exampleValues)} → {calculateTeachingTotal(nextRules, exampleValues)} балів.</p>}</div>}</details>
        </>}
      </>}
      {dialog === 'group' && <>
        {groups.length > 8 && <TeachingField label="Знайти групу"><input name="group-directory-search" className={teachingInput} value={groupQuery} onChange={event => setGroupQuery(event.target.value)} disabled={busy} placeholder="Назва, курс, факультет або староста" /></TeachingField>}
        <TeachingField label="Навчальна група" hint="Перевірте курс, рівень освіти та старосту: групи з однаковою назвою можуть навчатися на різних курсах."><select name="group" className={teachingInput} value={groupId} onChange={e => { setGroupId(e.target.value); setSubjectId('') }} required disabled={busy}><option value="">Оберіть групу</option>{visibleGroups.map(g => <option key={g.id} value={g.id}>{teachingGroupDirectoryLabel(g)}</option>)}</select></TeachingField>
        {group && <p className="teaching-note" role="status">{teachingGroupDirectoryLabel(group)}</p>}
        {!!group?.subjects?.length && <TeachingField label="Предмет у розкладі групи" hint="Оберіть відповідний предмет, щоб пов’язати його з розкладом групи."><select name="course-group-subject" className={teachingInput} value={subjectId} onChange={e => setSubjectId(e.target.value)} disabled={busy}><option value="">За назвою предмета</option>{group.subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></TeachingField>}
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
