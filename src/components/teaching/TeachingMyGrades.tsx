import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, BarChart3, BookOpen, CheckCheck, MessageSquareText, RefreshCw } from 'lucide-react'
import { buildStudentGradeAnalytics, type StudentSubjectAnalytics } from '../../lib/studentGradeAnalytics'
import { supabaseTeachingRepository, teachingDate, teachingError, type TeachingGroupData, type TeachingOwnGrade, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, teachingInput } from './TeachingUI'
import { TeachingGradeDuck } from './TeachingGradeDuck'
import { TeachingGradeRequestButton } from './TeachingGradeRequestButton'
import { teachingCoefficient, teachingRounding, TEACHING_ROUNDING_OPTIONS } from '../../lib/teachingGrading'
import './teaching-my-grades.css'

type Props = { data: TeachingGroupData; groupId: string; initialCourseId?: string; onRefresh: () => Promise<void>; repository?: TeachingRepository }
const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 6 })
const percentNumber = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 })
const points = (value: number | null | undefined) => value === null || value === undefined ? '—' : number.format(value)
const percent = (value: number | null) => value === null ? '—' : `${percentNumber.format(value)}%`
const publicationTime = (grade: TeachingOwnGrade) => Date.parse(grade.published_at || '') || 0
const scoreIsNumeric = (grade: TeachingOwnGrade) => typeof grade.published_score === 'number' && Number.isFinite(grade.published_score)

function SubjectCard({ subject, selected, controls, onSelect }: { subject: StudentSubjectAnalytics; selected: boolean; controls: string; onSelect: () => void }) {
  const hasTotal = subject.earned !== null
  return <button type="button" className={`my-grades-subject ${selected ? 'my-grades-subject-selected' : ''}`} onClick={onSelect} aria-pressed={selected} aria-controls={controls}>
    <span className="my-grades-subject-top"><span className="my-grades-subject-icon"><BookOpen size={17} aria-hidden="true" /></span><span className="my-grades-subject-semester">{subject.course.semester}{subject.course.archived_at && <span className="my-grades-archive">Архів</span>}</span><ArrowUpRight size={17} className="my-grades-subject-arrow" aria-hidden="true" /></span>
    <span className="my-grades-subject-title">{subject.course.title}</span>
    <span className="my-grades-subject-scoreline"><span className="my-grades-subject-score">{points(subject.earned)}<span>{subject.maximum !== null ? ` / ${points(subject.maximum)}` : hasTotal ? ' балів' : ''}</span></span><TeachingGradeDuck assessedPercent={subject.assessedPercent} /></span>
    {subject.semesterPercent !== null ? <>
      <progress className="my-grades-progress" max={100} value={Math.max(0, Math.min(100, subject.semesterPercent))} aria-label={`${subject.course.title}: ${percent(subject.semesterPercent)} від максимуму предмета`} />
      <span className="my-grades-subject-note">{percent(subject.semesterPercent)} від максимуму предмета</span>
    </> : <span className="my-grades-subject-note">{hasTotal ? 'Загальний максимум не налаштовано' : 'Числових оцінок поки немає'}</span>}
    <span className="my-grades-subject-footer"><span>Оцінено робіт: {subject.numericGrades.length}</span><span>Детальніше</span></span>
  </button>
}

function SubjectCategories({ subject }: { subject: StudentSubjectAnalytics }) {
  const weighted = subject.course.grading_rules.categories.some(category => teachingCoefficient(category.coefficient) !== 1)
  const rounding = teachingRounding(subject.course.grading_rules.rounding)
  return <section className="my-grades-panel" aria-label="Бали за категоріями">
    <div className="my-grades-section-heading"><div><h3>З чого складаються бали</h3><p>Підсумок враховує коефіцієнти, максимуми категорій і правила округлення предмета.</p></div><span className="my-grades-total">{points(subject.earned)}<small>{subject.maximum !== null ? ` / ${points(subject.maximum)}` : ' балів'}</small></span></div>
    {(weighted || rounding !== 'none') && <p className="my-grades-muted">{weighted ? 'Бали за окремі роботи показані без множення. До підсумку категорії застосовано коефіцієнт викладача. ' : ''}{rounding !== 'none' ? `Округлення підсумку: ${TEACHING_ROUNDING_OPTIONS.find(option => option.id === rounding)?.label.toLowerCase()}.` : ''}</p>}
    {subject.categories.length ? <div className="my-grades-categories">{subject.categories.map(category => {
      const categoryPercent = category.earned !== null && category.maximum !== null ? category.earned / category.maximum * 100 : null
      const coefficient = teachingCoefficient(subject.course.grading_rules.categories.find(rule => rule.id === category.id)?.coefficient)
      return <div className="my-grades-category" key={category.id}>
        <div><span>{category.name}</span><strong>{points(category.earned)}<small>{category.maximum !== null ? ` / ${points(category.maximum)}` : ''}</small></strong></div>
        {categoryPercent !== null && <progress className="my-grades-progress" max={100} value={Math.max(0, Math.min(100, categoryPercent))} aria-label={`${category.name}: ${points(category.earned)} із ${points(category.maximum)} балів`} />}
        {category.earned === null ? <p>Ще немає числових оцінок</p> : category.rawEarned !== null && coefficient !== 1 ? <p>{points(category.rawEarned)} сирих балів × {points(coefficient)}; зараховано {points(category.earned)} з урахуванням максимуму категорії.</p> : category.rawEarned !== null && category.rawEarned > category.earned ? <p>Отримано {points(category.rawEarned)} балів; зараховано максимум категорії.</p> : null}
      </div>
    })}</div> : <p className="my-grades-muted">Категорії оцінювання ще не налаштовані. Опубліковані бали враховуються звичайною сумою.</p>}
  </section>
}

export function TeachingMyGrades({ data, groupId, initialCourseId = '', onRefresh, repository = supabaseTeachingRepository }: Props) {
  const subjects = useMemo(() => buildStudentGradeAnalytics(data, groupId), [data, groupId])
  const [semester, setSemester] = useState('')
  const [courseId, setCourseId] = useState(initialCourseId)
  const [resultKind, setResultKind] = useState('all')
  const [visibleCount, setVisibleCount] = useState(8)
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('')
  const refreshGeneration = useRef(0), refreshLock = useRef(false)
  const detailsId = useId()
  useEffect(() => {
    setSemester(''); setCourseId(initialCourseId); setResultKind('all'); setVisibleCount(8); setError('')
    refreshGeneration.current++; refreshLock.current = false; setRefreshing(false)
  }, [groupId, initialCourseId])
  useEffect(() => () => { refreshGeneration.current++ }, [])
  const semesters = [...new Set(subjects.map(subject => subject.course.semester).filter(Boolean))]
  const currentSemester = semesters.includes(semester) ? semester : ''
  const semesterSubjects = subjects.filter(subject => !currentSemester || subject.course.semester === currentSemester)
  const currentCourseId = semesterSubjects.some(subject => subject.course.id === courseId) ? courseId : ''
  const visibleSubjects = semesterSubjects.filter(subject => !currentCourseId || subject.course.id === currentCourseId)
  const selectedSubject = visibleSubjects.length === 1 && currentCourseId ? visibleSubjects[0] : null
  const allResults = visibleSubjects.flatMap(subject => subject.grades).sort((a, b) => publicationTime(b) - publicationTime(a) || a.id.localeCompare(b.id))
  const results = allResults.filter(grade => resultKind === 'all' || (resultKind === 'numeric' ? scoreIsNumeric(grade) : !scoreIsNumeric(grade)))
  const numericCount = visibleSubjects.reduce((sum, subject) => sum + subject.numericGrades.length, 0)
  const feedbackOnlyCount = visibleSubjects.reduce((sum, subject) => sum + subject.feedbackOnlyCount, 0)
  const withResults = visibleSubjects.filter(subject => subject.numericGrades.length > 0).length
  const assessedEarned = visibleSubjects.reduce((sum, subject) => sum + subject.assessedEarned, 0)
  const assessedMaximum = visibleSubjects.reduce((sum, subject) => sum + subject.assessedMaximum, 0)
  const assessedPercent = assessedMaximum > 0 ? assessedEarned / assessedMaximum * 100 : null
  useEffect(() => { setVisibleCount(8) }, [currentSemester, currentCourseId, resultKind])
  const refresh = useCallback(async () => {
    if (refreshLock.current) return
    refreshLock.current = true
    const generation = ++refreshGeneration.current
    setRefreshing(true); setError('')
    try { await onRefresh() }
    catch (failure) { if (generation === refreshGeneration.current) setError(teachingError(failure)) }
    finally { if (generation === refreshGeneration.current) { refreshLock.current = false; setRefreshing(false) } }
  }, [onRefresh])
  useEffect(() => { void refresh() }, [refresh, groupId])
  function selectSemester(value: string) { setSemester(value); setCourseId(''); setResultKind('all') }
  function selectCourse(value: string) { setCourseId(value); setResultKind('all') }

  return <section className="my-grades" aria-label="Аналітика моїх балів" aria-busy={refreshing}>
    <header className="my-grades-heading"><div><span className="teaching-eyebrow"><BarChart3 size={14} aria-hidden="true" />Моя успішність</span><h2>Усі результати в одному місці</h2><p>Предмети цієї групи, ваші опубліковані бали та відгуки викладачів.</p></div><TeachingButton onClick={() => void refresh()} busy={refreshing}><RefreshCw size={15} aria-hidden="true" />{refreshing ? 'Оновлюємо' : 'Оновити'}</TeachingButton></header>
    {error && <p className="teaching-error" role="alert">{error} Уже завантажені результати залишаються доступними.</p>}
    {!subjects.length ? <div className="my-grades-panel"><TeachingEmpty icon={<BookOpen size={24} />} title="Предмети ще не підключено" description="Коли викладачі підключать предмети до групи й опублікують ваші результати, тут з’явиться загальний огляд успішності." /></div> : <>
      <div className="my-grades-filters"><TeachingField label="Семестр"><select name="my-grades-semester" className={teachingInput} value={currentSemester} onChange={event => selectSemester(event.target.value)}><option value="">Усі семестри</option>{semesters.map(item => <option key={item} value={item}>{item || 'Без назви семестру'}</option>)}</select></TeachingField><TeachingField label="Предмет"><select name="my-grades-course" className={teachingInput} value={currentCourseId} onChange={event => selectCourse(event.target.value)}><option value="">Усі предмети</option>{semesterSubjects.map(subject => <option key={subject.course.id} value={subject.course.id}>{subject.course.title}{!currentSemester ? ` · ${subject.course.semester}` : ''}{subject.course.archived_at ? ' · архів' : ''}</option>)}</select></TeachingField></div>
      <div className="my-grades-stats" aria-label="Коротка статистика">
        <div className="my-grades-stat"><span><BookOpen size={15} aria-hidden="true" />Предметів</span><strong>{visibleSubjects.length}</strong><small>Із числовими оцінками: {withResults}</small></div>
        <div className="my-grades-stat"><span><CheckCheck size={15} aria-hidden="true" />Оцінено робіт</span><strong>{numericCount}</strong><small>Враховано також виставлені нулі</small></div>
        <div className="my-grades-stat my-grades-stat-accent"><span><BarChart3 size={15} aria-hidden="true" />Результат оцінених робіт</span><strong>{percent(assessedPercent)}</strong><small>{assessedMaximum > 0 ? `${points(assessedEarned)} із ${points(assessedMaximum)} можливих балів` : 'Ще немає оцінок із відомим максимумом'}</small></div>
        <div className="my-grades-stat"><span><MessageSquareText size={15} aria-hidden="true" />Відгуків без балів</span><strong>{feedbackOnlyCount}</strong><small>Опубліковані коментарі без оцінки</small></div>
      </div>
      <p className="my-grades-explanation">Відсоток показує, скільки балів ви отримали за вже оцінені роботи. Каченя усміхається від 80%, спокійне від 50% до менш ніж 80%, сумує нижче 50%. Без оцінок — чекає на них.</p>

      <section aria-label="Огляд предметів"><div className="my-grades-section-heading"><div><h3>{selectedSubject ? 'Обраний предмет' : 'Бали за предметами'}</h3><p>{selectedSubject ? 'Ваш підсумок і правила оцінювання предмета.' : 'Оберіть предмет, щоб переглянути категорії та окремі роботи.'}</p></div>{currentCourseId && <TeachingButton onClick={() => selectCourse('')}><ArrowLeft size={14} aria-hidden="true" />Усі предмети</TeachingButton>}</div>
        <div className={`my-grades-subjects ${selectedSubject ? 'my-grades-subjects-single' : ''}`}>{visibleSubjects.map(subject => <SubjectCard subject={subject} selected={currentCourseId === subject.course.id} controls={detailsId} onSelect={() => selectCourse(subject.course.id)} key={subject.course.id} />)}</div>
      </section>
      <div id={detailsId} className="my-grades-details">
        {selectedSubject && <SubjectCategories subject={selectedSubject} />}
        <section className="my-grades-panel" aria-label="Опубліковані результати робіт"><div className="my-grades-section-heading"><div><h3>{selectedSubject ? 'Результати робіт' : 'Останні результати'}</h3><p>Поточні результати за датою останньої публікації.</p></div><TeachingField label="Показати"><select name="my-grades-result-kind" className={teachingInput} value={resultKind} onChange={event => setResultKind(event.target.value)}><option value="all">Усі результати</option><option value="numeric">З балами</option><option value="feedback">Без числової оцінки</option></select></TeachingField></div>
          {!results.length ? <TeachingEmpty icon={<BookOpen size={22} />} title={allResults.length ? 'Таких результатів поки немає' : 'Результатів поки немає'} description={allResults.length ? 'Оберіть інший тип результатів або перегляньте всі.' : 'Бали та відгуки з’являться після публікації викладачем. Відсутність оцінки не означає нуль.'} /> : <>
            <div className="my-grades-results">{results.slice(0, visibleCount).map(grade => {
              const subject = visibleSubjects.find(item => item.course.id === grade.course_id)
              const numeric = scoreIsNumeric(grade)
              const maximum = Number.isFinite(grade.max_points) && grade.max_points > 0 ? grade.max_points : null
              const category = subject?.categories.find(item => item.id === grade.category)?.name
              return <article className="my-grades-result" key={grade.id}>
                <div className="my-grades-result-top"><div className="my-grades-result-copy"><p className="my-grades-result-subject">{subject?.course.title || grade.course_title}</p><h4>{grade.activity_title || 'Робота'}</h4><p className="my-grades-result-meta">{category || 'Оцінювання'}{grade.activity_date ? ` · Робота від ${teachingDate(grade.activity_date)}` : ''}</p></div><div className={`my-grades-result-score ${numeric ? '' : 'my-grades-result-no-score'}`}>{numeric ? <>{points(grade.published_score)}{maximum !== null && <small> / {points(maximum)}</small>}</> : <span>Без балів</span>}</div></div>
                {grade.published_comment?.trim() && <div className="my-grades-comment"><MessageSquareText size={15} aria-hidden="true" /><p>{grade.published_comment}</p></div>}
                <p className="my-grades-result-published">Опубліковано {teachingDate(grade.published_at, true)}</p>
                <TeachingGradeRequestButton repository={repository} grade={grade} />
              </article>
            })}</div>
            <div className="my-grades-results-footer"><p>Показано {Math.min(visibleCount, results.length)} із {results.length}</p>{visibleCount < results.length && <TeachingButton onClick={() => setVisibleCount(value => value + 8)}>Показати ще</TeachingButton>}</div>
          </>}
        </section>
      </div>
      <p className="my-grades-privacy">Тут лише ваші опубліковані результати. Чернетки викладача й бали інших студентів не враховуються.</p>
    </>}
  </section>
}
