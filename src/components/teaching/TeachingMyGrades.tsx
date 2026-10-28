import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, BarChart3, BookOpen, CalendarDays, CheckCheck, ChevronRight, Info, ListChecks, LockKeyhole, MessageSquareText, RefreshCw, Search } from 'lucide-react'
import { buildStudentGradeAnalytics, type StudentSubjectAnalytics } from '../../lib/studentGradeAnalytics'
import { supabaseTeachingRepository, teachingDate, teachingError, type TeachingGroupData, type TeachingOwnGrade, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, teachingInput } from './TeachingUI'
import { TeachingGradeDuck } from './TeachingGradeDuck'
import { TeachingGradeRequestButton } from './TeachingGradeRequestButton'
import { teachingCoefficient, teachingRounding, TEACHING_ROUNDING_OPTIONS } from '../../lib/teachingGrading'
import { TeachingGradingRulesSummary } from './TeachingGradingRulesEditor'
import './teaching-my-grades.css'

type Props = { data: TeachingGroupData; groupId: string; initialCourseId?: string; onRefresh: () => Promise<void>; repository?: TeachingRepository; archiveReadOnly?: boolean }
const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 6 })
const percentNumber = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 })
const points = (value: number | null | undefined) => value === null || value === undefined ? '—' : number.format(value)
const percent = (value: number | null) => value === null ? '—' : `${percentNumber.format(value)}%`
const publicationTime = (grade: TeachingOwnGrade) => Date.parse(grade.published_at || '') || 0
const scoreIsNumeric = (grade: TeachingOwnGrade) => typeof grade.published_score === 'number' && Number.isFinite(grade.published_score)
const differentTotal = (subject: StudentSubjectAnalytics) => subject.earned !== null && Math.abs(subject.assessedEarned - subject.earned) > 0.0000001
const categoryName = (subject: StudentSubjectAnalytics, grade: TeachingOwnGrade) => subject.categories.find(item => item.id === grade.category)?.name || 'Оцінювання'
const moodMessage = (subject: StudentSubjectAnalytics) => subject.assessedPercent === null ? 'Тут скоро з’являться ваші результати' : subject.assessedPercent >= 80 ? 'Гарна робота. Так тримати!' : subject.assessedPercent >= 50 ? 'Крок за кроком — до свого результату' : 'Є що підтягнути. У вас усе вийде'

function SubjectCard({ subject, selected, controls, onSelect }: { subject: StudentSubjectAnalytics; selected: boolean; controls: string; onSelect: () => void }) {
  return <button type="button" className={`my-grades-subject ${selected ? 'my-grades-subject-selected' : ''}`} onClick={onSelect} aria-pressed={selected} aria-controls={controls}>
    <span className="my-grades-subject-top"><span className="my-grades-subject-icon"><BookOpen size={16} aria-hidden="true" /></span><span className="my-grades-subject-semester">{subject.course.semester || 'Ваш предмет'}{subject.course.archived_at && <span className="my-grades-archive">Архів</span>}</span><ChevronRight size={16} className="my-grades-subject-arrow" aria-hidden="true" /></span>
    <span className="my-grades-subject-title">{subject.course.title}</span>
    <span className="my-grades-subject-scoreline"><span><span className="my-grades-subject-score">{points(subject.earned)}<span>{subject.maximum !== null ? ` / ${points(subject.maximum)}` : subject.earned !== null ? ' балів' : ''}</span></span><span className="my-grades-subject-scorelabel">{subject.earned === null ? 'Оцінки ще попереду' : 'Поточний підсумок'}</span></span><TeachingGradeDuck assessedPercent={subject.assessedPercent} /></span>
    {subject.semesterPercent !== null && <progress className="my-grades-progress" max={100} value={Math.max(0, Math.min(100, subject.semesterPercent))} aria-label={`${subject.course.title}: ${percent(subject.semesterPercent)} від максимуму предмета`} />}
    <span className="my-grades-subject-footer"><span>Оцінено робіт: {subject.numericGrades.length}{differentTotal(subject) ? ` · сума ${points(subject.assessedEarned)}` : ''}</span><span>{selected ? 'Відкрито' : 'Роботи'}<ArrowUpRight size={12} aria-hidden="true" /></span></span>
  </button>
}

function SubjectCategories({ subject }: { subject: StudentSubjectAnalytics }) {
  const rounding = teachingRounding(subject.course.grading_rules.rounding)
  return <section className="my-grades-calculation" aria-label="Як підраховано підсумок предмета">
    <div className="my-grades-section-heading"><div><h3>Як складається підсумок</h3><p>Спочатку додаємо оцінки всередині кожної категорії, потім застосовуємо правила викладача.</p></div></div>
    <div className="my-grades-calculation-summary"><div><span>Сума оцінок за роботи</span><strong>{subject.numericGrades.length ? points(subject.assessedEarned) : '—'}</strong></div><ChevronRight size={18} aria-hidden="true" /><div><span>Поточний підсумок</span><strong>{points(subject.earned)}<small>{subject.maximum !== null ? ` / ${points(subject.maximum)}` : ''}</small></strong></div></div>
    {subject.categories.length ? <div className="my-grades-categories">{subject.categories.map(category => {
      const categoryPercent = category.earned !== null && category.maximum !== null ? category.earned / category.maximum * 100 : null
      const coefficient = teachingCoefficient(subject.course.grading_rules.categories.find(rule => rule.id === category.id)?.coefficient)
      return <div className="my-grades-category" key={category.id}><div><span>{category.name}</span><strong>{points(category.earned)}<small>{category.maximum !== null ? ` / ${points(category.maximum)}` : ''}</small></strong></div>
        {categoryPercent !== null && <progress className="my-grades-progress" max={100} value={Math.max(0, Math.min(100, categoryPercent))} aria-label={`${category.name}: ${points(category.earned)} із ${points(category.maximum)} балів`} />}
        <p>{category.earned === null ? 'Ще немає числових оцінок' : <>{points(category.rawEarned)} балів за роботи{coefficient !== 1 ? ` × ${points(coefficient)}` : ''}{category.maximum !== null ? ` · максимум категорії ${points(category.maximum)}` : ''}</>}</p>
      </div>
    })}</div> : <p className="my-grades-muted">Категорії ще не налаштовано. Опубліковані оцінки додаються звичайною сумою.</p>}
    {rounding !== 'none' && <p className="my-grades-muted">Округлення підсумку: {TEACHING_ROUNDING_OPTIONS.find(option => option.id === rounding)?.label.toLowerCase()}.</p>}
    <TeachingGradingRulesSummary rules={subject.course.grading_rules} groupOverride={subject.course.grading_scope === 'group'} />
  </section>
}

export function TeachingMyGrades({ data, groupId, initialCourseId = '', onRefresh, repository = supabaseTeachingRepository, archiveReadOnly = false }: Props) {
  const subjects = useMemo(() => buildStudentGradeAnalytics(data, groupId), [data, groupId])
  const [semester, setSemester] = useState('__latest__'), [courseId, setCourseId] = useState(initialCourseId)
  const [detailView, setDetailView] = useState<'works' | 'calculation'>('works')
  const [resultKind, setResultKind] = useState('all'), [query, setQuery] = useState(''), [visibleCount, setVisibleCount] = useState(8)
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('')
  const refreshGeneration = useRef(0), refreshLock = useRef(false), detailsId = useId()
  const subjectRail = useRef<HTMLDivElement>(null)
  useEffect(() => { setSemester('__latest__'); setCourseId(initialCourseId); setDetailView('works'); setResultKind('all'); setQuery(''); setVisibleCount(8); setError(''); refreshGeneration.current++; refreshLock.current = false; setRefreshing(false) }, [groupId, initialCourseId])
  useEffect(() => () => { refreshGeneration.current++ }, [])
  const semesters = useMemo(() => [...new Set([...subjects].sort((a, b) => b.course.starts_on.localeCompare(a.course.starts_on)).map(subject => subject.course.semester))], [subjects])
  const initialSubject = subjects.find(subject => subject.course.id === initialCourseId)
  const latestSubject = [...subjects].sort((a, b) => Number(Boolean(a.course.archived_at)) - Number(Boolean(b.course.archived_at)) || b.course.starts_on.localeCompare(a.course.starts_on))[0]
  const preferredSemester = initialSubject?.course.semester ?? latestSubject?.course.semester ?? ''
  const currentSemester = semester === '__latest__' ? preferredSemester : semester === '__all__' ? '__all__' : semesters.includes(semester) ? semester : preferredSemester
  const semesterSubjects = subjects.filter(subject => currentSemester === '__all__' || subject.course.semester === currentSemester)
  const selectedSubject = semesterSubjects.find(subject => subject.course.id === courseId) || semesterSubjects[0] || null
  const currentCourseId = selectedSubject?.course.id || ''
  useEffect(() => {
    const rail = subjectRail.current
    if (!rail) return
    let frame = 0
    const revealSelected = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!window.matchMedia('(max-width: 760px)').matches) return
        const selected = rail.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
        if (!selected) return
        const railBox = rail.getBoundingClientRect(), selectedBox = selected.getBoundingClientRect()
        if (selectedBox.left >= railBox.left + 2 && selectedBox.right <= railBox.right - 2) return
        // Align with the card's snap point. Aligning only its right edge can
        // land between mandatory snap points and snap back to the wrong card.
        const left = rail.scrollLeft + selectedBox.left - railBox.left - 3
        rail.scrollTo({ left: Math.max(0, left), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      })
    }
    revealSelected()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealSelected)
    observer?.observe(rail)
    return () => { cancelAnimationFrame(frame); observer?.disconnect() }
  }, [currentCourseId, currentSemester])
  const numericCount = semesterSubjects.reduce((sum, subject) => sum + subject.numericGrades.length, 0)
  const withResults = semesterSubjects.filter(subject => subject.numericGrades.length > 0).length
  const allResults = selectedSubject?.grades || []
  const normalizedQuery = query.trim().toLocaleLowerCase('uk-UA')
  const results = allResults.filter(grade => (resultKind === 'all' || (resultKind === 'numeric' ? scoreIsNumeric(grade) : !scoreIsNumeric(grade))) && (!normalizedQuery || `${grade.activity_title} ${grade.published_comment} ${selectedSubject ? categoryName(selectedSubject, grade) : ''}`.toLocaleLowerCase('uk-UA').includes(normalizedQuery))).sort((a, b) => publicationTime(b) - publicationTime(a) || a.id.localeCompare(b.id))
  useEffect(() => { setVisibleCount(8) }, [currentSemester, currentCourseId, resultKind, query])
  const refresh = useCallback(async () => { if (refreshLock.current) return; refreshLock.current = true; const generation = ++refreshGeneration.current; setRefreshing(true); setError(''); try { await onRefresh() } catch (failure) { if (generation === refreshGeneration.current) setError(teachingError(failure)) } finally { if (generation === refreshGeneration.current) { refreshLock.current = false; setRefreshing(false) } } }, [onRefresh])
  useEffect(() => { void refresh() }, [refresh, groupId])
  function selectSemester(value: string) { setSemester(value); setCourseId(''); setResultKind('all'); setQuery(''); setDetailView('works') }
  function selectCourse(value: string) { setCourseId(value); setResultKind('all'); setQuery(''); setDetailView('works') }

  return <section className="my-grades" aria-label="Аналітика моїх балів" aria-busy={refreshing}>
    <header className="my-grades-heading"><div><span className="my-grades-eyebrow"><BarChart3 size={14} aria-hidden="true" />Студентський кабінет</span><h2>Мої бали<span className="my-grades-heading-dot">.</span></h2><p>Кожен предмет — окремо. Кожна оцінка — зрозуміло.</p></div><TeachingButton onClick={() => void refresh()} busy={refreshing}><RefreshCw size={15} className={refreshing ? 'my-grades-refreshing' : ''} aria-hidden="true" />{refreshing ? 'Оновлюємо' : 'Оновити'}</TeachingButton></header>
    {error && <p className="teaching-error" role="alert">{error} Уже завантажені результати залишаються доступними.</p>}
    {!subjects.length ? <div className="my-grades-panel"><TeachingEmpty icon={<BookOpen size={24} />} title="Предмети ще не підключено" description="Коли викладачі підключать предмети до групи й опублікують ваші результати, тут з’являться бали та відгуки." /></div> : <>
      <div className="my-grades-toolbar"><TeachingField label="Навчальний семестр"><select name="my-grades-semester" className={teachingInput} value={currentSemester} onChange={event => selectSemester(event.target.value)}>{semesters.map(item => <option key={item} value={item}>{item || 'Без назви семестру'}</option>)}<option value="__all__">Усі семестри, включно з архівом</option></select></TeachingField><div className="my-grades-quick-stats" aria-label="Коротка статистика"><span><BookOpen size={15} aria-hidden="true" />Предметів: <strong>{semesterSubjects.length}</strong></span><span><CheckCheck size={15} aria-hidden="true" />Оцінено робіт: <strong>{numericCount}</strong></span><span className="my-grades-quick-extra">Предметів з оцінками: {withResults}</span></div></div>
      <div className="my-grades-workspace"><aside className="my-grades-subject-list" aria-label="Предмети та підсумки"><div className="my-grades-list-heading"><h3>Ваші предмети</h3><span>{semesterSubjects.length}</span><p className="my-grades-rail-hint">Гортайте предмети<ChevronRight size={12} aria-hidden="true" /></p></div><div className="my-grades-subjects" ref={subjectRail}>{semesterSubjects.map(subject => <SubjectCard subject={subject} selected={currentCourseId === subject.course.id} controls={detailsId} onSelect={() => selectCourse(subject.course.id)} key={subject.course.id} />)}</div></aside>
        <div id={detailsId} className="my-grades-details" aria-live="polite" aria-atomic="false">{selectedSubject && <>
          <section className="my-grades-subject-hero" key={`hero-${selectedSubject.course.id}`} aria-label={`Підсумок: ${selectedSubject.course.title}`}><div className="my-grades-hero-content"><div className="my-grades-hero-meta"><span><CalendarDays size={13} aria-hidden="true" />{selectedSubject.course.semester || 'Семестр не вказано'}</span>{selectedSubject.course.archived_at && <span className="my-grades-archive">Архів</span>}</div><h3>{selectedSubject.course.title}</h3><div className="my-grades-hero-score"><strong>{points(selectedSubject.earned)}</strong>{selectedSubject.maximum !== null && <span>із {points(selectedSubject.maximum)} балів</span>}</div><p className="my-grades-hero-label">{selectedSubject.earned === null ? 'Числових оцінок поки немає' : 'Поточний підсумок'}</p><p className="my-grades-hero-mood">{moodMessage(selectedSubject)}</p></div><div className="my-grades-hero-duck"><TeachingGradeDuck assessedPercent={selectedSubject.assessedPercent} /><span>{selectedSubject.assessedPercent === null ? 'Чекаємо на оцінки' : `${percent(selectedSubject.assessedPercent)} за оціненими роботами`}</span></div><div className="my-grades-hero-bottom"><span><ListChecks size={14} aria-hidden="true" />Оцінено робіт: {selectedSubject.numericGrades.length}</span><span>Сума оцінок: <strong>{selectedSubject.numericGrades.length ? points(selectedSubject.assessedEarned) : '—'}</strong></span>{selectedSubject.lastPublishedAt && <span>Оновлено {teachingDate(selectedSubject.lastPublishedAt)}</span>}</div></section>
          <div className="my-grades-view-switch" role="group" aria-label="Деталі предмета"><button type="button" aria-pressed={detailView === 'works'} className={detailView === 'works' ? 'is-selected' : ''} onClick={() => setDetailView('works')}><ListChecks size={16} aria-hidden="true" />За що бали<span>{allResults.length}</span></button><button type="button" aria-pressed={detailView === 'calculation'} className={detailView === 'calculation' ? 'is-selected' : ''} onClick={() => setDetailView('calculation')}><BarChart3 size={16} aria-hidden="true" />Як пораховано</button></div>
          <section className="my-grades-panel my-grades-detail-panel" key={`${selectedSubject.course.id}-${detailView}`} aria-label={detailView === 'works' ? 'Опубліковані результати робіт' : 'Підсумок за категоріями'}>{detailView === 'calculation' ? <SubjectCategories subject={selectedSubject} /> : <>
            <div className="my-grades-section-heading"><div><h3>Роботи та оцінки</h3><p>Дата, отримані бали й відгук викладача — для кожної роботи.</p></div></div>
            <div className="my-grades-result-filters"><label className="my-grades-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Знайти роботу або відгук</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Знайти роботу або відгук" /></label><TeachingField label="Показати"><select name="my-grades-result-kind" className={teachingInput} value={resultKind} onChange={event => setResultKind(event.target.value)}><option value="all">Усі результати</option><option value="numeric">З балами</option><option value="feedback">Без числової оцінки</option></select></TeachingField></div>
            {!results.length ? <TeachingEmpty icon={<BookOpen size={22} />} title={allResults.length ? 'Нічого не знайдено' : 'Оцінки ще попереду'} description={allResults.length ? 'Спробуйте іншу назву або покажіть усі результати.' : 'Бали та відгуки з’являться після публікації викладачем. Відсутність оцінки не означає нуль.'} /> : <><div className="my-grades-results">{results.slice(0, visibleCount).map(grade => {
              const numeric = scoreIsNumeric(grade), maximum = Number.isFinite(grade.max_points) && grade.max_points > 0 ? grade.max_points : null
              const percentage = numeric && maximum !== null ? grade.published_score! / maximum * 100 : null
              const tone = percentage === null ? 'waiting' : percentage >= 80 ? 'good' : percentage >= 50 ? 'steady' : 'attention'
              return <article className={`my-grades-result my-grades-result-${tone}`} key={grade.id}><div className="my-grades-result-top"><div className="my-grades-result-copy"><p className="my-grades-result-category">{categoryName(selectedSubject, grade)}</p><h4>{grade.activity_title || 'Робота'}</h4><p className="my-grades-result-meta"><CalendarDays size={12} aria-hidden="true" />{grade.activity_date ? teachingDate(grade.activity_date) : 'Дата роботи не вказана'}</p></div><div className={`my-grades-result-score ${numeric ? '' : 'my-grades-result-no-score'}`}>{numeric ? <><strong>{points(grade.published_score)}</strong>{maximum !== null && <small>із {points(maximum)}</small>}</> : <span>Без балів</span>}</div></div>
                {grade.published_comment?.trim() && <div className="my-grades-comment"><MessageSquareText size={15} aria-hidden="true" /><div><span>Відгук викладача</span><p>{grade.published_comment}</p></div></div>}
                <div className="my-grades-result-bottom"><p className="my-grades-result-published">Опубліковано {teachingDate(grade.published_at, true)}</p>{!archiveReadOnly && <TeachingGradeRequestButton repository={repository} grade={grade} />}</div></article>
            })}</div><div className="my-grades-results-footer"><p>Показано {Math.min(visibleCount, results.length)} із {results.length}</p>{visibleCount < results.length && <TeachingButton onClick={() => setVisibleCount(value => value + 8)}>Показати ще</TeachingButton>}</div></>}
            {differentTotal(selectedSubject) && <div className="my-grades-info"><Info size={16} aria-hidden="true" /><p>Сума оцінок за роботи — {points(selectedSubject.assessedEarned)}. За правилами викладача у підсумок зараховано {points(selectedSubject.earned)}. Розрахунок доступний у вкладці «Як пораховано».</p></div>}
          </>}</section><p className="my-grades-duck-note">Настрій каченяти залежить від результату вже оцінених робіт: від 80% — радіє, від 50% — спокійне, нижче 50% — потребує підтримки.</p>
        </>}</div>
      </div><p className="my-grades-privacy"><LockKeyhole size={13} aria-hidden="true" />Ваші результати бачите ви та викладачі з відповідним доступом. Тут показані лише опубліковані оцінки.</p>
    </>}
  </section>
}
