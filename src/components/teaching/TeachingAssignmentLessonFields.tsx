import { useEffect, useId, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { isTimetableDate, LESSON_TYPES, scheduleOccursOnDate, type TimetableLesson } from '../../lib/studyGroupTimetable'
import { teachingError, type TeachingCourse, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

export function TeachingAssignmentLessonFields({ repository, course, groupId, date, deadline, scheduleItemId, placementMode, disabled, onDateChange, onLessonChange, onPlacementChange, onValidityChange }: { repository: TeachingRepository; course: TeachingCourse; groupId: string; date: string; deadline: string; scheduleItemId: string; placementMode: 'lesson' | 'unplaced'; disabled: boolean; onDateChange: (date: string) => void; onLessonChange: (id: string) => void; onPlacementChange: (mode: 'lesson' | 'unplaced') => void; onValidityChange: (valid: boolean) => void }) {
  const lessonOrderHintId = useId()
  const [data, setData] = useState<{ key: string; lessons: TimetableLesson[] }>({ key: '', lessons: [] })
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const autoSelectKey = useRef<string | null>(null)
  const key = `${course.id}:${groupId}:${date}`
  const lessons = data.key === key ? data.lessons : []
  const validDate = isTimetableDate(date) && date >= course.starts_on && date <= course.ends_on
  const valid = placementMode === 'unplaced' ? validDate || !date && isTimetableDate(deadline.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)
    : validDate && lessons.some(lesson => lesson.id === scheduleItemId && lesson.group_id === groupId && scheduleOccursOnDate(lesson, date))
  useEffect(() => { onValidityChange(valid) }, [valid, onValidityChange])
  useEffect(() => {
    const current = ++generation.current
    setError(''); setLoading(false)
    if (!groupId || !isTimetableDate(date) || placementMode === 'unplaced') return
    setLoading(true)
    void repository.assignmentLessons(course.id, groupId, date).then(result => {
      if (current === generation.current) {
        const next = result.lessons.filter(lesson => lesson.group_id === groupId && scheduleOccursOnDate(lesson, date))
        setData({ key, lessons: next })
        if (autoSelectKey.current === key) { autoSelectKey.current = null; if (next.length === 1) onLessonChange(next[0].id) }
      }
    }).catch(failure => { if (current === generation.current) { setData({ key, lessons: [] }); setError(teachingError(failure)) } }).finally(() => { if (current === generation.current) setLoading(false) })
    return () => { ++generation.current }
  }, [repository, course.id, groupId, date, key, revision, placementMode, onLessonChange])
  return <fieldset className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/40 p-4 dark:border-sky-800 dark:bg-sky-950/20">
    <legend className="px-1 text-sm font-semibold">Пара в розкладі групи</legend>
    <p className="text-xs leading-relaxed text-muted-foreground">Завдання можна показати під конкретною парою поряд із ДЗ групи або окремо на вибрану дату. Розклад і семінари веде староста.</p>
    <div className="flex flex-wrap gap-3 text-sm"><label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="assignment-placement" checked={placementMode === 'lesson'} disabled={disabled} onChange={() => onPlacementChange('lesson')} />До конкретної пари</label><label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="assignment-placement" checked={placementMode === 'unplaced'} disabled={disabled} onChange={() => { onPlacementChange('unplaced'); onLessonChange('') }} />Без прив’язки до пари</label></div>
    {placementMode === 'lesson' && <p id={lessonOrderHintId} className="rounded-lg bg-sky-100/70 px-3 py-2 text-sm leading-relaxed text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">Спочатку оберіть дату заняття. Потім оберіть пару з розкладу на цей день.</p>}
    <div className="grid gap-3 sm:grid-cols-2"><TeachingField label={placementMode === 'lesson' ? 'Дата заняття' : deadline ? 'Дата показу завдання · або використаємо дату здачі' : 'Дата показу завдання · обов’язкова для вільного терміну'}><input name="assignment-lesson-date" type="date" min={course.starts_on} max={course.ends_on} value={date} className={teachingInput} aria-describedby={placementMode === 'lesson' ? lessonOrderHintId : undefined} disabled={disabled || !groupId} onChange={event => { autoSelectKey.current = `${course.id}:${groupId}:${event.target.value}`; onDateChange(event.target.value); onLessonChange('') }} /></TeachingField>
      {placementMode === 'lesson' && <TeachingField label="Конкретна пара"><select name="assignment-schedule-item" value={scheduleItemId} className={teachingInput} aria-describedby={lessonOrderHintId} disabled={disabled || loading || !date || !groupId} onChange={event => onLessonChange(event.target.value)}><option value="">{!date ? 'Спочатку оберіть дату' : loading ? 'Завантажуємо пари…' : 'Оберіть пару'}</option>{scheduleItemId && !lessons.some(lesson => lesson.id === scheduleItemId) && <option value={scheduleItemId} disabled>Попередня пара недоступна</option>}{lessons.map(lesson => <option value={lesson.id} key={lesson.id}>{lesson.starts_at.slice(0, 5)}–{lesson.ends_at.slice(0, 5)} · {LESSON_TYPES[lesson.lesson_type]} · {lesson.subject}</option>)}</select></TeachingField>}</div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {placementMode === 'lesson' && date && !loading && !error && !lessons.length && <p role="status" className="text-xs leading-relaxed text-muted-foreground">На цю дату в розкладі немає пари цього предмета. Оберіть іншу дату, «Без прив’язки до пари» або попросіть старосту уточнити розклад.</p>}
    {placementMode === 'lesson' && date && <TeachingButton disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />Оновити пари</TeachingButton>}
    <p className="text-xs leading-relaxed text-muted-foreground">Чернетку можна зберегти до вибору дати й пари.</p>
  </fieldset>
}
