import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizedScheduleSubjectName } from '../../lib/scheduleSubjects'
import { scheduleOccursOnDate, type TimetableLesson } from '../../lib/studyGroupTimetable'
import { supabaseTeachingRepository, teachingDate, teachingError, type TeachingLessonAssignment, type TeachingRepository } from '../../lib/teaching'
import { TeacherSourceBadge } from './TeacherSourceBadge'
import { TeachingResources } from './TeachingPublications'
import { TeachingSubmissionPanel } from './TeachingSubmissionPanel'
import { TeachingButton, TeachingModal } from './TeachingUI'

export function teacherAssignmentLesson(item: TeachingLessonAssignment, schedule: TimetableLesson[], date: string) {
  if (item.lesson_date !== date || !item.schedule_item_id) return null
  return schedule.find(lesson => lesson.id === item.schedule_item_id && lesson.group_id === item.group_id
    && normalizedScheduleSubjectName(lesson.subject) === normalizedScheduleSubjectName(item.subject_name)
    && scheduleOccursOnDate(lesson, date)) || null
}

export function useTeachingLessonAssignments(groupId: string | undefined, userId: string | undefined, date: string, enabled = true, repository: TeachingRepository = supabaseTeachingRepository) {
  const key = `${groupId || ''}:${userId || ''}:${date}`
  const [data, setData] = useState<{ key: string; assignments: TeachingLessonAssignment[] }>({ key: '', assignments: [] })
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  const reload = useCallback(async () => {
    if (!groupId || !userId || !enabled) return
    const current = ++generation.current
    setLoading(true)
    try {
      const result = await repository.groupAssignments(groupId, date)
      if (current === generation.current) { setData({ key, assignments: result.assignments.filter(item => item.group_id === groupId && item.source === 'teacher' && item.read_only === true) }); setError('') }
    } catch (failure) {
      if (current === generation.current) { setData({ key, assignments: [] }); setError(teachingError(failure)) }
    } finally { if (current === generation.current) setLoading(false) }
  }, [repository, groupId, userId, date, enabled, key])
  useEffect(() => {
    setError(''); void reload()
    const refresh = () => { if (document.visibilityState === 'visible') void reload() }
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 45_000)
    return () => { ++generation.current; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer) }
  }, [reload])
  return { assignments: data.key === key ? data.assignments : [], loading: enabled && (loading || data.key !== key), error, reload }
}

export function TeachingLessonAssignmentCard({ item, userId, repository = supabaseTeachingRepository, onRefresh, archiveReadOnly = false }: { item: TeachingLessonAssignment; userId: string; repository?: TeachingRepository; onRefresh: () => Promise<void>; archiveReadOnly?: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const due = item.targets.find(target => target.group_id === item.group_id)?.due_at
  return <article className="mt-3 min-w-0 rounded-xl border border-sky-200 bg-sky-50/60 p-3.5 dark:border-sky-800 dark:bg-sky-950/25">
    <TeacherSourceBadge /><h5 className="mt-2.5 break-words text-sm font-semibold">{item.title}</h5>
    <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{item.author_name || 'Викладач'} · {item.course_title}{due ? ` · Здати до ${teachingDate(due, true)}` : ''}</p>
    {item.body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{item.body}</p>}
    <TeachingResources publication={item} repository={repository} />
    <div className="mt-3"><TeachingButton onClick={() => setOpen(true)}>Моя робота</TeachingButton></div>
    {open && <TeachingModal title={item.title} description="Вашу роботу бачите ви та викладачі предмета з відповідним дозволом." busy={busy} onClose={() => setOpen(false)}><TeachingSubmissionPanel assignment={item} groupId={item.group_id} userId={userId} repository={repository} onRefresh={onRefresh} defaultExpanded onBusyChange={setBusy} archiveReadOnly={archiveReadOnly} /></TeachingModal>}
  </article>
}

export function TeachingUnplacedAssignments({ items, userId, repository, onRefresh, archiveReadOnly = false }: { items: TeachingLessonAssignment[]; userId: string; repository?: TeachingRepository; onRefresh: () => Promise<void>; archiveReadOnly?: boolean }) {
  if (!items.length) return null
  const hasDatedItems = items.some(item => item.lesson_date || item.targets.find(target => target.group_id === item.group_id)?.placement_mode === 'unplaced')
  return <details open={hasDatedItems} className="mt-5 min-w-0 rounded-2xl border border-border p-4"><summary className="min-h-11 cursor-pointer text-sm font-semibold">Завдання без прив’язки до пари · {items.length}</summary><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Викладач опублікував завдання без конкретної пари або її змінили в розкладі. Ваша робота й бали зберігаються.</p>{items.map(item => <TeachingLessonAssignmentCard key={item.id} item={item} userId={userId} repository={repository} onRefresh={onRefresh} archiveReadOnly={archiveReadOnly} />)}</details>
}
