import { useCallback, useEffect, useRef, useState } from 'react'
import { UsersRound } from 'lucide-react'
import { kyivDeadline, teachingDate, teachingError, type TeachingCourse, type TeachingGroup, type TeachingRepository } from '../../lib/teaching'
import { teachingGroupDirectoryLabel } from '../../lib/teachingGroupDirectory'
import { isStudyGroupListed } from '../../lib/studyGroupVisibility'
import { emptyMultiAssignmentTarget, MAX_MULTI_ASSIGNMENT_GROUPS, type MultiAssignmentTargetDraft } from '../../lib/teachingMultiAssignments'
import { isTimetableDate, LESSON_TYPES, scheduleOccursOnDate, type TimetableLesson } from '../../lib/studyGroupTimetable'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'
import { fiveDaysAfter } from './TeachingPublicationTimingFields'
import { assignmentDeadlineMode } from '../../lib/teachingAssignmentDeadline'
import { TeachingAssignmentDeadlineFields } from './TeachingAssignmentDeadlineFields'

export function TeachingMultiAssignmentTargets({ groups, targets, repository, course, disabled, onChange, onValidityChange }: {
  groups: TeachingGroup[]; targets: MultiAssignmentTargetDraft[]; repository: TeachingRepository; course: TeachingCourse; disabled: boolean;
  onChange: (targets: MultiAssignmentTargetDraft[]) => void; onValidityChange: (groupId: string, valid: boolean) => void;
}) {
  const update = useCallback((groupId: string, patch: Partial<MultiAssignmentTargetDraft>) => {
    onChange(targets.map(target => target.groupId === groupId ? { ...target, ...patch } : target))
  }, [onChange, targets])
  return <fieldset className="space-y-4 rounded-xl border border-border p-4" disabled={disabled}>
    <legend className="flex items-center gap-2 px-1 text-sm font-semibold"><UsersRound size={16} />Це саме завдання для інших груп</legend>
    <p className="text-xs leading-relaxed text-muted-foreground">Умова, файли й правила оцінювання спільні. Для кожної групи окремо оберіть пару, термін здачі та закриття. Студенти бачитимуть лише роботи своєї групи.</p>
    <div className="grid gap-2 sm:grid-cols-2">{groups.filter(group => isStudyGroupListed(group.group_id)).map(group => <label key={group.group_id} className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" name={`multi-assignment-group-${group.group_id}`} className="mt-1 accent-primary" checked={targets.some(target => target.groupId === group.group_id)} disabled={disabled || !targets.some(target => target.groupId === group.group_id) && targets.length >= MAX_MULTI_ASSIGNMENT_GROUPS - 1} onChange={event => onChange(event.target.checked ? [...targets, emptyMultiAssignmentTarget(group.group_id)] : targets.filter(target => target.groupId !== group.group_id))} /><span>{teachingGroupDirectoryLabel({ ...group, id: group.group_id })}</span></label>)}</div>
    {targets.filter(target => isStudyGroupListed(target.groupId)).map(target => { const group = groups.find(candidate => candidate.group_id === target.groupId); return group ? <MultiAssignmentTargetFields key={target.groupId} group={group} target={target} repository={repository} course={course} disabled={disabled} onChange={update} onValidityChange={onValidityChange} /> : <p key={target.groupId} role="alert" className="teaching-error">Доступ до вибраної групи змінився. Приберіть її або відкрийте редактор повторно.</p> })}
  </fieldset>
}

function MultiAssignmentTargetFields({ group, target, repository, course, disabled, onChange, onValidityChange }: {
  group: TeachingGroup; target: MultiAssignmentTargetDraft; repository: TeachingRepository; course: TeachingCourse; disabled: boolean;
  onChange: (groupId: string, patch: Partial<MultiAssignmentTargetDraft>) => void; onValidityChange: (groupId: string, valid: boolean) => void;
}) {
  const [data, setData] = useState<{ key: string; lessons: TimetableLesson[] }>({ key: '', lessons: [] })
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const key = `${course.id}:${target.groupId}:${target.lessonDate}`
  const lessons = data.key === key ? data.lessons : []
  const validDate = isTimetableDate(target.lessonDate) && target.lessonDate >= course.starts_on && target.lessonDate <= course.ends_on
  const valid = target.placementMode === 'unplaced' ? validDate || !target.lessonDate && isTimetableDate(target.deadline.slice(0, 10))
    : validDate && lessons.some(lesson => lesson.id === target.scheduleItemId)
  useEffect(() => { onValidityChange(target.groupId, valid) }, [target.groupId, valid, onValidityChange])
  useEffect(() => {
    const current = ++generation.current
    setError(''); setLoading(false)
    if (!isTimetableDate(target.lessonDate) || target.placementMode !== 'lesson') return
    setLoading(true)
    void repository.assignmentLessons(course.id, target.groupId, target.lessonDate).then(result => {
      if (generation.current === current) setData({ key, lessons: result.lessons.filter(lesson => lesson.group_id === target.groupId && scheduleOccursOnDate(lesson, target.lessonDate)) })
    }).catch(failure => { if (generation.current === current) { setData({ key, lessons: [] }); setError(teachingError(failure)) } }).finally(() => { if (generation.current === current) setLoading(false) })
    return () => { ++generation.current }
  }, [repository, course.id, target.groupId, target.lessonDate, target.placementMode, key, revision])
  const prefix = `multi-assignment-${target.groupId}`
  return <fieldset className="space-y-3 rounded-xl bg-background p-4"><legend className="px-1 text-sm font-semibold">{teachingGroupDirectoryLabel({ ...group, id: group.group_id })}</legend>
    <TeachingField label="Де показувати завдання"><select name={`${prefix}-placement`} value={target.placementMode} className={teachingInput} disabled={disabled} onChange={event => onChange(target.groupId, { placementMode: event.target.value as 'lesson' | 'unplaced', scheduleItemId: '' })}><option value="lesson">До конкретної пари</option><option value="unplaced">Без прив’язки до пари</option></select></TeachingField>
    <div className="grid gap-3 sm:grid-cols-2"><TeachingField label={target.placementMode === 'lesson' ? 'Дата заняття' : target.deadline ? 'Дата показу · або використаємо дату здачі' : 'Дата показу · обов’язкова для вільного терміну'}><input type="date" name={`${prefix}-date`} min={course.starts_on} max={course.ends_on} className={teachingInput} value={target.lessonDate} disabled={disabled} onChange={event => onChange(target.groupId, { lessonDate: event.target.value, scheduleItemId: '' })} /></TeachingField>
      {target.placementMode === 'lesson' && <TeachingField label="Конкретна пара"><select name={`${prefix}-lesson`} className={teachingInput} value={target.scheduleItemId} disabled={disabled || loading || !target.lessonDate} onChange={event => onChange(target.groupId, { scheduleItemId: event.target.value })}><option value="">{loading ? 'Завантажуємо пари…' : !target.lessonDate ? 'Спочатку оберіть дату' : 'Оберіть пару'}</option>{target.scheduleItemId && !lessons.some(lesson => lesson.id === target.scheduleItemId) && <option value={target.scheduleItemId} disabled>Попередня пара недоступна</option>}{lessons.map(lesson => <option key={lesson.id} value={lesson.id}>{lesson.starts_at.slice(0, 5)}–{lesson.ends_at.slice(0, 5)} · {LESSON_TYPES[lesson.lesson_type]} · {lesson.subject}</option>)}</select></TeachingField>}</div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {target.placementMode === 'lesson' && target.lessonDate && !loading && !error && !lessons.length && <p className="text-xs text-muted-foreground">На цю дату немає пари цього предмета. Оберіть іншу дату або показ без прив’язки до пари.</p>}
    {target.placementMode === 'lesson' && target.lessonDate && <TeachingButton disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>Оновити пари</TeachingButton>}
    <TeachingAssignmentDeadlineFields name={prefix} mode={assignmentDeadlineMode(target.deadline, target.deadlineMode)} deadline={target.deadline} onMode={deadlineMode => onChange(target.groupId, { deadlineMode, ...(deadlineMode === 'free' ? { deadline: '' } : {}) })} onDeadline={deadline => onChange(target.groupId, { deadline })} disabled={disabled} />
    <TeachingField label="Остаточно закрити приймання · необов’язково"><input name={`${prefix}-closes`} type="datetime-local" className={teachingInput} min={target.deadline || undefined} value={target.closesAt} disabled={disabled} onChange={event => onChange(target.groupId, { closesAt: event.target.value })} /></TeachingField>
    <TeachingButton disabled={disabled || !target.deadline} onClick={() => onChange(target.groupId, { closesAt: fiveDaysAfter(target.deadline) })}>Доздача протягом 5 днів</TeachingButton>
  </fieldset>
}

export function TeachingMultiAssignmentPreview({ targets, groups, lessonLabels }: { targets: MultiAssignmentTargetDraft[]; groups: TeachingGroup[]; lessonLabels: Record<string, string> }) {
  return <div className="space-y-3"><p className="text-sm leading-relaxed">Перевірте кожну групу. Умова й файли спільні; здані роботи та бали зберігаються окремо.</p><div className="space-y-3">{targets.filter(target => isStudyGroupListed(target.groupId)).map(target => <div key={target.groupId} className="rounded-xl border border-border p-3 text-sm"><p className="font-semibold">{groups.find(group => group.group_id === target.groupId)?.group_name || 'Група недоступна'}</p><p>{target.lessonDate ? teachingDate(target.lessonDate) : 'Дату не вказано'} · {target.placementMode === 'unplaced' ? 'Без прив’язки до пари' : lessonLabels[target.groupId] || 'Пару не вибрано'}</p><p>Термін: {target.deadline ? teachingDate(kyivDeadline(target.deadline), true) : 'Вільний термін здачі'}</p><p>Приймання: {target.closesAt ? `до ${teachingDate(kyivDeadline(target.closesAt), true)}` : 'Без остаточного закриття'}</p></div>)}</div></div>
}
