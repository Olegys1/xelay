import { useState } from 'react'
import { localTeachingTimetable } from '../../lib/localTeachingRepository'
import { LESSON_TYPES, scheduleOccursOnDate } from '../../lib/studyGroupTimetable'
import type { TeachingRepository } from '../../lib/teaching'
import { GroupTeachingPanel } from './GroupTeachingPanel'
import { TeachingLessonAssignmentCard, TeachingUnplacedAssignments, teacherAssignmentLesson, useTeachingLessonAssignments } from './TeachingLessonAssignments'
import { TeachingButton, teachingInput } from './TeachingUI'

export function LocalTeachingSchedulePreview({ groupId, userId, canInvite, repository }: { groupId: string; userId: string; canInvite: boolean; repository: TeachingRepository }) {
  const [date, setDate] = useState('2026-10-15')
  const timetable = localTeachingTimetable(groupId)
  const lessons = timetable.filter(lesson => scheduleOccursOnDate(lesson, date))
  const assignments = useTeachingLessonAssignments(groupId, userId, date, true, repository)
  const unplaced = assignments.assignments.filter(item => !teacherAssignmentLesson(item, timetable, date))
  return <>
    <GroupTeachingPanel groupId={groupId} userId={userId} canInvite={canInvite} showAssignments={false} repository={repository} />
    <section className="teaching-card"><header className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">Розклад і ДЗ</h2><p className="mt-1 text-xs text-muted-foreground">Локальний приклад: ДЗ старости й завдання викладача під конкретною парою.</p></div><label className="space-y-1 text-xs font-medium"><span className="block">Дата</span><input type="date" value={date} onChange={event => setDate(event.target.value)} className={teachingInput} /></label></header>
      {assignments.error && <p role="alert" className="teaching-error">{assignments.error}<TeachingButton onClick={() => void assignments.reload()}>Оновити</TeachingButton></p>}
      <div className="space-y-4">{lessons.map(lesson => <article key={lesson.id} className="grid min-w-0 grid-cols-[58px_minmax(0,1fr)] gap-3"><div className="pt-4 text-right text-xs text-muted-foreground"><p className="font-semibold">{lesson.starts_at.slice(0, 5)}</p><p className="mt-1">{lesson.ends_at.slice(0, 5)}</p></div><div className="min-w-0 rounded-2xl border border-border bg-muted/20 p-4"><p className="text-xs text-muted-foreground">{LESSON_TYPES[lesson.lesson_type]} · {lesson.location}</p><h3 className="mt-1 font-semibold">{lesson.subject}</h3>{lesson.lesson_type === 'seminar' && <div className="mt-3 border-t border-border pt-3"><p className="text-xs font-semibold">Домашнє завдання групи</p><p className="mt-1 text-sm leading-relaxed">Повторіть графіки попиту й пропозиції. Підготуйте по одному прикладу зміни кожної кривої.</p><p className="mt-1 text-xs text-muted-foreground">Додано старостою · окремо від завдання викладача</p></div>}{assignments.assignments.filter(item => teacherAssignmentLesson(item, timetable, date)?.id === lesson.id).map(item => <TeachingLessonAssignmentCard key={item.id} item={item} userId={userId} repository={repository} onRefresh={assignments.reload} />)}</div></article>)}</div>
      {!lessons.length && <p className="py-4 text-sm text-muted-foreground">На цю дату пар не заплановано.</p>}
      <TeachingUnplacedAssignments items={unplaced} userId={userId} repository={repository} onRefresh={assignments.reload} />
    </section>
  </>
}
