import { useState } from 'react'
import { Check, ChevronDown, Save, Settings2 } from 'lucide-react'
import type { TeachingLessonRole } from '../../lib/teaching'
import { LESSON_TYPES } from '../../lib/studyGroupTimetable'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'
import './teaching-lesson-roles.css'

type Props = {
  roles: readonly TeachingLessonRole[]; busy: boolean; disabled?: boolean; error?: string
  preferredCourseId?: string; preferredGroupId?: string
  onSave: (role: TeachingLessonRole, lessonTypes: string[]) => Promise<boolean>
}
const keyOf = (role: TeachingLessonRole) => `${role.course_id}:${role.group_id}`
const sameTypes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(type => b.includes(type))

/** An optional personal timetable preference, never an edit of teaching permissions. */
export function TeachingLessonRoleSettings({ roles, busy, disabled = false, error = '', preferredCourseId, preferredGroupId, onSave }: Props) {
  const [selected, setSelected] = useState(() => roles.find(role => role.course_id === preferredCourseId && role.group_id === preferredGroupId) ? `${preferredCourseId}:${preferredGroupId}` : roles.length === 1 ? keyOf(roles[0]) : '')
  const [draft, setDraft] = useState<{ key: string; version: number; types: string[] } | null>(null)
  const [message, setMessage] = useState('')
  const role = roles.find(role => keyOf(role) === selected)
  const currentDraft = draft?.key === selected ? draft : null
  const types = currentDraft?.types || role?.lesson_types || []
  const changed = Boolean(role && currentDraft && (!role.version || !sameTypes(types, role.lesson_types)))
  const stale = Boolean(role && currentDraft && role.version !== currentDraft.version)
  const blocked = busy || disabled
  function change(next: string[]) {
    if (!role || blocked) return
    setMessage('')
    setDraft({ key: selected, version: currentDraft?.version ?? role.version, types: [...new Set(next)] })
  }
  async function save() {
    if (!role || !changed || stale || blocked) return
    const saved = await onSave({ ...role, version: currentDraft?.version ?? role.version }, [...types])
    if (saved) { setDraft(null); setMessage(types.length ? 'Збережено. Відповідні заняття позначені як ваші. Ручні винятки залишилися без змін.' : 'Збережено. Автоматичний вибір видів вимкнено. Залишилися лише ручні позначки та винятки.') }
  }
  return <details className="teaching-lesson-role-settings">
    <summary><span><Settings2 size={17} aria-hidden="true" /><strong>Які заняття я веду</strong><small>{roles.filter(item => !item.version).length ? `Не налаштовано: ${roles.filter(item => !item.version).length}` : 'Особистий вибір'}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="teaching-lesson-role-content">
      <p>Оберіть види занять окремо для свого предмета та кожної групи. Вони автоматично позначатимуться у вашому розкладі, зокрема після додавання нових пар.</p>
      <p className="teaching-note">Це тільки особисте налаштування розкладу. Воно не змінює права викладачів, завдання, оцінки чи розклад студентів. Ручні позначки та винятки зберігаються.</p>
      {!roles.length ? <p className="teaching-note">Підключіть предмет до групи. Налаштування буде доступне після підтвердження підключення.</p> : <>
        <TeachingField label="Для якого предмета та групи"><select className={teachingInput} value={role ? selected : ''} disabled={blocked} onChange={event => { setSelected(event.target.value); setDraft(null); setMessage('') }}><option value="">Оберіть предмет і групу</option>{roles.map(item => <option key={keyOf(item)} value={keyOf(item)}>{item.course_title} · {item.group_name}</option>)}</select></TeachingField>
        {role && <>
          <div className="teaching-lesson-role-status"><span>Зараз збережено</span><strong>{role.lesson_types.length ? role.lesson_types.map(type => LESSON_TYPES[type as keyof typeof LESSON_TYPES] || type).join(', ') : role.version ? 'Лише ручні позначки' : 'Не визначено'}</strong></div>
          <div role="group" aria-label="Швидкий вибір видів занять" className="teaching-lesson-role-presets">
            {([{ label: 'Лекції', types: ['lecture'] }, { label: 'Семінари', types: ['seminar'] }, { label: 'Лекції та семінари', types: ['lecture', 'seminar'] }] as const).map(preset => <button type="button" key={preset.label} disabled={blocked} aria-pressed={sameTypes(types, preset.types)} onClick={() => change([...preset.types])}>{sameTypes(types, preset.types) && <Check size={14} aria-hidden="true" />}{preset.label}</button>)}
          </div>
          <fieldset className="teaching-lesson-role-types" disabled={blocked}><legend>Або оберіть потрібні види окремо</legend>{Object.entries(LESSON_TYPES).map(([type, label]) => <label key={type}><input type="checkbox" checked={types.includes(type)} onChange={event => change(event.target.checked ? [...types, type] : types.filter(item => item !== type))} /><span>{label}</span></label>)}</fieldset>
          <p className="teaching-note">Практичні й лабораторні обираються окремо та не зараховуються до семінарів автоматично. Порожній вибір залишає тільки ручні позначки пар.</p>
          {stale && <p role="status" className="teaching-note">Це налаштування вже змінилося. Ваш вибір залишився у формі. Спочатку перегляньте актуальний збережений варіант.</p>}
          <div className="teaching-lesson-role-actions"><TeachingButton primary busy={busy} disabled={blocked || !changed || stale} onClick={() => void save()}><Save size={15} />Зберегти мої заняття</TeachingButton><TeachingButton disabled={blocked || !types.length && role.version > 0} onClick={() => change([])}>Лише ручні позначки</TeachingButton>{currentDraft && <TeachingButton disabled={blocked} onClick={() => { setDraft(null); setMessage('') }}>{stale ? 'Взяти актуальні налаштування' : 'Скасувати вибір'}</TeachingButton>}</div>
          {error && <p role="alert" className="teaching-error">{error}</p>}
          {message && <p role="status" className="teaching-note">{message}</p>}
        </>}
      </>}
    </div>
  </details>
}
