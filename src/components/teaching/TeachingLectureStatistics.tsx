import { useEffect, useRef, useState } from 'react'
import { ChartNoAxesColumnIncreasing, ClipboardCheck, Film, RefreshCw, Sparkles } from 'lucide-react'
import { courseModuleError, lectureTime, type CourseLectureStatistics, type TeachingCourseModuleRepository } from '../../lib/teachingCourseModules'
import { TeachingSectionHelp, TeachingButton, TeachingField, teachingInput } from './TeachingUI'

type Props = {
  repository: TeachingCourseModuleRepository
  moduleId: string
  groups: { id: string; name: string }[]
  preferredGroupId?: string
}

const testLabels = { not_started: 'Не розпочато', in_progress: 'Виконує', submitted: 'Тест здано' } as const
const percent = (value: number, total: number) => total > 0 ? Math.round(value / total * 100) : 0

export function TeachingLectureStatistics({ repository, moduleId, groups, preferredGroupId }: Props) {
  const [selectedGroup, setSelectedGroup] = useState(preferredGroupId || '')
  const [requestVersion, setRequestVersion] = useState(0)
  const groupId = groups.some(group => group.id === selectedGroup) ? selectedGroup : groups[0]?.id || ''
  const [result, setResult] = useState<{ repository: TeachingCourseModuleRepository; moduleId: string; groupId: string; data: CourseLectureStatistics } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const reads = useRef(0)
  const stats = result?.repository === repository && result.moduleId === moduleId && result.groupId === groupId ? result.data : null

  useEffect(() => {
    if (!groupId || !repository.lectureStatistics) return
    const request = ++reads.current
    setLoading(true)
    setError('')
    void repository.lectureStatistics(moduleId, groupId).then(data => {
      if (request === reads.current && data.module_id === moduleId && data.group_id === groupId) setResult({ repository, moduleId, groupId, data })
    }).catch(failure => {
      if (request === reads.current) { setResult(null); setError(courseModuleError(failure)) }
    }).finally(() => {
      if (request === reads.current) setLoading(false)
    })
    return () => { reads.current++ }
  }, [repository, moduleId, groupId, requestVersion])

  const students = stats?.students || []
  const finishedLecture = students.filter(student => student.watched).length
  const submitted = students.filter(student => student.test_status === 'submitted').length
  const graded = students.filter(student => student.published_score != null && (student.max_points || 0) > 0)
  const average = graded.length ? Math.round(graded.reduce((sum, student) => sum + 100 * (student.published_score || 0) / (student.max_points || 1), 0) / graded.length) : null
  const questions = [...stats?.questions || []].sort((a, b) => b.incorrect - a.incorrect || percent(b.incorrect, b.attempted) - percent(a.incorrect, a.attempted))
  const priority = questions.find(question => question.attempted >= 3 && question.incorrect > 0)

  return <section className="tcm-progress tcm-lecture-statistics" data-teaching-guide="course-lecture-stats" aria-label="Статистика лекції">
    <header className="tcm-heading"><div><span className="tcm-eyebrow"><ChartNoAxesColumnIncreasing size={15} aria-hidden="true" />Аналітика модуля</span><h3>Перегляди та результати тесту <TeachingSectionHelp topic="modules" step="progress" label="Статистика лекції" iconOnly /></h3><p>Прогрес зараховується після 90% відео. Попередні бали й опубліковані результати показано окремо.</p></div><TeachingButton busy={loading} disabled={!groupId} onClick={() => setRequestVersion(version => version + 1)}><RefreshCw size={15} />Оновити статистику</TeachingButton></header>
    <TeachingField label="Група для статистики лекції"><select className={teachingInput} value={groupId} disabled={!groups.length} onChange={event => { setResult(null); setError(''); setSelectedGroup(event.target.value) }}>{!groups.length && <option value="">Немає доступних груп</option>}{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></TeachingField>
    {error && <p className="teaching-error" role="alert">{error}</p>}
    {!stats && !error && <p className="tcm-muted" role="status">{loading ? 'Завантажуємо статистику…' : 'Для цієї групи статистика ще недоступна.'}</p>}
    {stats && <>
      <div className="tcm-stats">
        <div className="tcm-stat"><Film size={21} aria-hidden="true" /><div><strong>{finishedLecture} / {students.length}</strong><small>переглянули лекцію</small></div></div>
        <div className="tcm-stat"><ClipboardCheck size={21} aria-hidden="true" /><div><strong>{submitted}</strong><small>здали тест</small></div></div>
        <div className="tcm-stat"><ChartNoAxesColumnIncreasing size={21} aria-hidden="true" /><div><strong>{average == null ? '—' : `${average}%`}</strong><small>середній опублікований результат</small></div></div>
      </div>
      {!!students.length && <div className="tcm-lecture-table"><table className="teaching-table"><thead><tr><th scope="col">Студент</th><th scope="col">Відео</th><th scope="col">Тест</th><th scope="col">Попередній бал</th><th scope="col">Опубліковано</th></tr></thead><tbody>{students.map(student => <tr key={student.user_id}>
        <td><strong>{student.full_name}</strong></td>
        <td><span className="tcm-chip" data-state={student.watched ? 'complete' : undefined}>{student.watched ? 'Зараховано' : `${percent(student.watched_seconds, stats.lecture_duration_seconds)}%`}</span><small className="block">{lectureTime(student.watched_seconds)} із {lectureTime(stats.lecture_duration_seconds)}</small></td>
        <td>{testLabels[student.test_status]}</td>
        <td>{student.score == null ? '—' : `${student.score} / ${student.max_points ?? '—'}`}</td>
        <td>{student.published_score == null ? '—' : `${student.published_score} / ${student.max_points ?? '—'}`}</td>
      </tr>)}</tbody></table></div>}
      <div className="tcm-lecture-questions"><h4>Де було найбільше помилок</h4>
        {!questions.length ? <p className="tcm-muted">Потрібна хоча б одна оцінена відповідь, щоб порівняти запитання.</p> : questions.map(question => <div key={question.question_id} className="tcm-lecture-question">
          <div><strong>{question.text}</strong><span>{question.incorrect} із {question.attempted} з помилкою</span></div>
          <progress className="tcm-progress-bar" max={100} value={percent(question.incorrect, question.attempted)} aria-label={`Частка помилок. ${question.text}`} />
        </div>)}
      </div>
      <aside className="tcm-lecture-insight"><Sparkles size={20} aria-hidden="true" /><div><h4>Підказка за статистикою</h4><p>{priority ? `Почніть повторення із запитання «${priority.text}». У ньому ${priority.incorrect} помилок із ${priority.attempted} оцінених відповідей.` : finishedLecture >= 3 && submitted * 2 < finishedLecture ? 'Більшість тих, хто переглянув лекцію, ще не здали тест. Можна нагадати групі про перевірку під відео.' : 'Ще замало результатів, щоб визначити типову помилку. Поверніться після перевірки тестів.'}</p></div></aside>
    </>}
  </section>
}
