import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, CalendarDays, Check, Clock3, RefreshCw } from 'lucide-react'
import { kyivToday, seminarStartMilliseconds } from '../../lib/seminars'
import { addTimetableDays, LESSON_TYPES } from '../../lib/studyGroupTimetable'
import { teachingDate, teachingError, type TeachingCalendarLesson, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, teachingInput } from './TeachingUI'
import './teaching-workflow.css'

type Props = {
  repository: TeachingRepository; userId: string;
  courses: { id: string; title: string; semester: string }[];
  initialCourseId?: string | null; initialGroupId?: string;
  onOpenJournal: (lesson: TeachingCalendarLesson) => void;
}
type CalendarSelection = {
  repository: TeachingRepository; userId: string; contextCourseId: string; contextGroupId: string;
  courseId: string; groupId: string; onlyMine: boolean;
}
const slotKey = (lesson: TeachingCalendarLesson) => `${lesson.course_id}:${lesson.group_id}:${lesson.source}:${lesson.id}`

export function TeachingCalendar({ repository, userId, courses, initialCourseId, initialGroupId, onOpenJournal }: Props) {
  const [from, setFrom] = useState(kyivToday)
  const [lessons, setLessons] = useState<TeachingCalendarLesson[]>([])
  const [loadedScope, setLoadedScope] = useState<{ repository: TeachingRepository; key: string } | null>(null)
  const contextCourseId = initialCourseId || '', contextGroupId = initialGroupId || ''
  const defaultSelection = (): CalendarSelection => ({ repository, userId, contextCourseId, contextGroupId, courseId: contextCourseId, groupId: contextGroupId, onlyMine: false })
  const [selection, setSelection] = useState<CalendarSelection>(defaultSelection)
  const selectionMatches = (value: CalendarSelection) => value.repository === repository && value.userId === userId && value.contextCourseId === contextCourseId && value.contextGroupId === contextGroupId
  const currentSelection = selectionMatches(selection) ? selection : defaultSelection()
  const { courseId, groupId: group, onlyMine } = currentSelection
  const updateSelection = (update: (value: CalendarSelection) => CalendarSelection) => setSelection(value => update(selectionMatches(value) ? value : defaultSelection()))
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now)
  const generation = useRef(0), mutation = useRef<symbol | null>(null), alive = useRef(true)
  const scopeKey = `${userId}:${from}`
  const scope = useRef({ repository, key: scopeKey })
  scope.current = { repository, key: scopeKey }
  const scopeLoaded = loadedScope?.repository === repository && loadedScope.key === scopeKey
  const currentLessons = scopeLoaded ? lessons : []
  const to = addTimetableDays(from, 6)
  const load = useCallback(async () => {
    const isCurrent = () => alive.current && scope.current.repository === repository && scope.current.key === scopeKey
    if (!isCurrent()) return
    const current = ++generation.current
    setLoading(true); setError(''); setLessons([]); setLoadedScope(null)
    try {
      const result = await repository.teacherCalendar(from, addTimetableDays(from, 6))
      if (current === generation.current && isCurrent()) { setLessons(result.lessons); setLoadedScope({ repository, key: scopeKey }) }
    } catch (failure) { if (current === generation.current && isCurrent()) { setError(teachingError(failure)); setLoadedScope({ repository, key: scopeKey }) } }
    finally { if (current === generation.current && isCurrent()) setLoading(false) }
  }, [repository, from, scopeKey])
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => { setSelection({ repository, userId, contextCourseId, contextGroupId, courseId: contextCourseId, groupId: contextGroupId, onlyMine: false }) }, [userId, repository, contextCourseId, contextGroupId])
  useEffect(() => { mutation.current = null; setBusy(''); void load(); return () => { generation.current++ } }, [load])
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
  const subjectLessons = currentLessons.filter(lesson => !courseId || lesson.course_id === courseId)
  const groups = useMemo(() => [...new Map(currentLessons.filter(lesson => !courseId || lesson.course_id === courseId).map(lesson => [lesson.group_id, lesson.group_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'uk')), [currentLessons, courseId])
  const filtered = subjectLessons.filter(lesson => (!group || lesson.group_id === group) && (!onlyMine || lesson.assigned_to_me))
    .sort((a, b) => a.lesson_date.localeCompare(b.lesson_date) || a.starts_at.localeCompare(b.starts_at) || a.group_name.localeCompare(b.group_name, 'uk'))
  const dates = [...new Set(filtered.map(lesson => lesson.lesson_date))]
  async function assign(lesson: TeachingCalendarLesson) {
    const isCurrent = () => alive.current && scope.current.repository === repository && scope.current.key === scopeKey
    if (mutation.current || !scopeLoaded || !isCurrent()) return
    const token = Symbol('calendar-assignment')
    mutation.current = token; setBusy(slotKey(lesson)); setError('')
    const current = generation.current
    try {
      const result = await repository.setCalendarLesson(lesson.course_id, lesson.group_id, lesson.id, lesson.source, !lesson.assigned_to_me)
      if (current === generation.current && isCurrent() && mutation.current === token) setLessons(rows => rows.map(row => slotKey(row) === slotKey(lesson) ? { ...row, assigned_to_me: result.assigned } : row))
    } catch (failure) { if (current === generation.current && isCurrent() && mutation.current === token) setError(teachingError(failure)) }
    finally { if (isCurrent() && mutation.current === token) { mutation.current = null; setBusy('') } }
  }
  return <section aria-label="Мій розклад викладання" className="teaching-calendar">
    <div className="teaching-workflow-heading"><div><span className="teaching-eyebrow"><CalendarDays size={15} />Усі групи в одному місці</span><h2>Мій розклад</h2><p>Заняття ваших предметів у підключених групах. Позначте пари, які ведете особисто.</p></div><TeachingButton onClick={() => void load()} disabled={loading || Boolean(busy)}><RefreshCw size={15} />Оновити</TeachingButton></div>
    <div className="teaching-calendar-toolbar">
      <div className="flex flex-wrap items-center gap-2"><TeachingButton disabled={Boolean(busy)} onClick={() => setFrom(addTimetableDays(from, -7))} title="Попередні сім днів"><ArrowLeft size={16} /></TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => setFrom(kyivToday())}>Сьогодні</TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => setFrom(addTimetableDays(from, 7))} title="Наступні сім днів"><ArrowRight size={16} /></TeachingButton><span className="text-sm font-medium">{teachingDate(from)} — {teachingDate(to)}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><TeachingField label="Показати від дати"><input className={teachingInput} type="date" value={from} disabled={Boolean(busy)} onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setFrom(event.target.value) }} /></TeachingField><TeachingField label="Ваш предмет"><select className={teachingInput} value={courseId} disabled={loading || Boolean(busy)} onChange={event => { const nextCourseId = event.target.value; updateSelection(value => ({ ...value, courseId: nextCourseId, groupId: '' })) }}><option value="">Усі мої предмети</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title} · {course.semester}</option>)}</select></TeachingField><TeachingField label="Група"><select className={teachingInput} value={group} disabled={loading || Boolean(busy)} onChange={event => { const nextGroupId = event.target.value; updateSelection(value => ({ ...value, groupId: nextGroupId })) }}><option value="">Усі групи</option>{group && !groups.some(([id]) => id === group) && <option value={group}>Обрана навчальна група · без занять у ці дні</option>}{groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></TeachingField></div>
      <label className="teaching-check"><input type="checkbox" checked={onlyMine} onChange={event => { const nextOnlyMine = event.target.checked; updateSelection(value => ({ ...value, onlyMine: nextOnlyMine })) }} />Лише пари, які веду я</label>
    </div>
    <p className="teaching-note mb-4">Заняття беруться з поточного розкладу групи. Особиста позначка діє для повторень цієї пари в межах предмета та не змінює розклад студентів.</p>
    {scopeLoaded && error && <p role="alert" className="teaching-error mb-4">{error}</p>}
    {loading || !scopeLoaded ? <p className="teaching-note" aria-busy="true">Завантажуємо заняття…</p> : !filtered.length ? <TeachingEmpty icon={<CalendarDays size={25} />} title={onlyMine ? 'Особистих пар у ці дні ще немає' : 'У ці дні занять не знайдено'} description={onlyMine ? 'Вимкніть фільтр і позначте потрібні заняття.' : 'Оберіть інший тиждень. Предмет має бути підключений до групи та відповідати предмету в її розкладі.'} /> : dates.map(date => <section key={date} className="teaching-calendar-day"><h3>{new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`))}</h3><div className="teaching-calendar-list">{filtered.filter(lesson => lesson.lesson_date === date).map(lesson => {
      const start = seminarStartMilliseconds({ lesson_date: date, starts_at: lesson.starts_at })
      const end = seminarStartMilliseconds({ lesson_date: date, starts_at: lesson.ends_at })
      const ongoing = clock >= start && clock < end
      return <article key={`${slotKey(lesson)}:${date}`} className={`teaching-calendar-lesson ${ongoing ? 'teaching-calendar-ongoing' : ''}`}><div className="teaching-calendar-time"><Clock3 size={15} /><strong>{lesson.starts_at.slice(0, 5)}</strong><span>{lesson.ends_at.slice(0, 5)}</span></div><div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><span className="teaching-badge teaching-badge-blue">{lesson.group_name}</span>{ongoing && <span className="teaching-badge">Пара триває</span>}</div><h4>{lesson.subject_name || lesson.course_title}</h4>{lesson.subject_name.trim().toLocaleLowerCase('uk-UA') !== lesson.course_title.trim().toLocaleLowerCase('uk-UA') && <p className="teaching-note">Предмет викладання: {lesson.course_title}</p>}<p>{LESSON_TYPES[lesson.lesson_type as keyof typeof LESSON_TYPES] || 'Заняття'}{lesson.location ? ` · ${lesson.location}` : ''}</p><div className="mt-3 flex flex-wrap gap-2"><TeachingButton onClick={() => onOpenJournal(lesson)}><BookOpen size={15} />{lesson.can_grade === false ? 'Відкрити групу' : 'Відкрити журнал'}</TeachingButton><TeachingButton busy={busy === slotKey(lesson)} disabled={Boolean(busy)} onClick={() => void assign(lesson)}>{lesson.assigned_to_me && <Check size={15} />}{lesson.assigned_to_me ? 'Веду я · прибрати позначку' : 'Додати до моїх пар'}</TeachingButton></div></div></article>
    })}</div></section>)}
  </section>
}
