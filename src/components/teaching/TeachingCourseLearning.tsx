import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, CheckCircle2, Circle, ClipboardCheck, ExternalLink, Layers3, LockKeyhole, RefreshCw } from 'lucide-react'
import { teachingDate } from '../../lib/teaching'
import {
  courseCompletionLabels, courseModuleError, courseResourceLabels,
  type CourseLearningData, type CourseLearningItem, type TeachingCourseModuleRepository,
} from '../../lib/teachingCourseModules'
import { useTeachingVisibilityRefresh } from '../../lib/useTeachingVisibilityRefresh'
import { TeachingButton } from './TeachingUI'
import { TeachingLecturePlayer } from './TeachingLecturePlayer'
import './teaching-course-modules.css'

type Props = {
  repository: TeachingCourseModuleRepository; courseId: string; groupId: string; userId: string
  onOpen: (item: CourseLearningItem) => void | Promise<void>; refreshKey?: string | number
}

const delayReason = (availableAt: string | null | undefined) => availableAt
  ? `Час очікування спливає ${teachingDate(availableAt, true)} за Києвом.`
  : ''

/** Shows only the server projection of the current student's course progress. */
export function TeachingCourseLearning({ repository, courseId, groupId, userId, onOpen, refreshKey }: Props) {
  const scope = useMemo(() => ({}), [repository, courseId, groupId, userId])
  const live = useRef(scope); live.current = scope
  const reads = useRef(0)
  const lock = useRef<object | null>(null)
  const [snapshot, setSnapshot] = useState<{ scope: object; data: CourseLearningData } | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<{ scope: object; id: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const data = snapshot?.scope === scope ? snapshot.data : null
  const latest = useRef(data); latest.current = data
  const busyId = working?.scope === scope ? working.id : ''
  const active = () => live.current === scope
  const prerequisiteItems = new Map((data?.modules || []).flatMap(module => module.items.map(item => [item.id, item] as const)))
  function prerequisiteReason(ids: string[]): string {
    const pending = [...new Set(ids)].map(id => prerequisiteItems.get(id)).filter(item => !item?.completed)
    if (!pending.length) return ''
    const descriptions = pending.map(item => {
      if (!item?.available) return 'виконати попередній крок, який готується'
      if (item.completion === 'acknowledged') return `підтвердити прочитання «${item.title}»`
      if (item.completion === 'submitted') return `здати «${item.title}»`
      if (item.completion === 'passed') return `отримати опублікований результат від ${item.pass_percent ?? 0}% за «${item.title}»`
      return `отримати опублікований бал за «${item.title}»`
    })
    return `Спочатку: ${descriptions.join('; ')}.`
  }

  async function refresh() {
    if (!active() || lock.current === scope) return
    const request = ++reads.current
    setLoading(true); setError('')
    try {
      const next = await repository.student(courseId, groupId)
      if (active() && request === reads.current) setSnapshot({ scope, data: next })
    } catch (failure) { if (active() && request === reads.current) setError(courseModuleError(failure)) }
    finally { if (active() && request === reads.current) setLoading(false) }
  }
  useEffect(() => {
    live.current = scope
    setSnapshot(null); setError(''); setNotice(''); setWorking(null)
    void refresh()
    return () => { reads.current++; if (live.current === scope) live.current = {}; if (lock.current === scope) lock.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  const seenRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (seenRefreshKey.current !== refreshKey) { seenRefreshKey.current = refreshKey; void refresh() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, scope])
  useTeachingVisibilityRefresh(refresh, { enabled: Boolean(data), blocked: Boolean(busyId) || loading })

  function accessible(id: string) {
    if (!active() || lock.current === scope) return null
    for (const module of latest.current?.modules || []) {
      const item = module.items.find(entry => entry.id === id)
      // The server keeps an already started attempt/submission accessible even
      // if the module's prerequisites have changed since it was started.
      if (item) return !item.locked && item.available ? item : null
    }
    return null
  }
  async function open(id: string) {
    const item = accessible(id)
    if (!item) return
    lock.current = scope; setWorking({ scope, id }); setError('')
    try { await onOpen(item) }
    catch (failure) { if (active()) setError(courseModuleError(failure)) }
    finally { if (lock.current === scope) lock.current = null; if (active()) setWorking(null) }
  }
  async function acknowledge(id: string) {
    const item = accessible(id)
    if (!item || item.resource_type !== 'material' || item.completion !== 'acknowledged' || item.completed) return
    lock.current = scope; ++reads.current; setLoading(false); setWorking({ scope, id }); setError(''); setNotice('')
    try {
      const next = await repository.acknowledge(id, groupId, userId)
      if (!active()) return
      setSnapshot({ scope, data: next }); setNotice('Матеріал позначено прочитаним. Прогрес та умови наступних кроків оновлено.')
    } catch (failure) { if (active()) setError(courseModuleError(failure)) }
    finally { if (lock.current === scope) lock.current = null; if (active()) setWorking(null) }
  }
  async function recordLectureProgress(id: string, position: number, expectedStoragePath?: string) {
    const module = latest.current?.modules.find(item => item.id === id)
    if (!expectedStoragePath || module?.lecture?.file?.storage_path !== expectedStoragePath || module.lecture.locked || module.locked || !repository.recordLectureProgress || !active() || lock.current === scope) throw new Error('COURSE_LECTURE_LOCKED')
    lock.current = scope
    ++reads.current
    setLoading(false)
    try {
      const next = await repository.recordLectureProgress(id, groupId, userId, position, expectedStoragePath)
      if (active() && next.course_id === courseId && next.group_id === groupId) setSnapshot({ scope, data: next })
    } finally {
      if (lock.current === scope) lock.current = null
    }
  }

  function lectureBlock(module: CourseLearningData['modules'][number]) {
    if (!module.lecture) return null
    const lecture = module.lecture
    const test = module.items.find(item => item.id === lecture.test_item_id)
    return <div className="tcm-lecture-block">
      <TeachingLecturePlayer
        key={lecture.file?.storage_path || module.id}
        lecture={{ ...lecture, locked: lecture.locked || module.locked }}
        lockedReason={module.available_at ? 'Відео відкриється після завершення часу очікування.' : undefined}
        resolveVideo={repository.lectureUrl}
        recordProgress={position => recordLectureProgress(module.id, position, lecture.file?.storage_path)}
      />
      <div className="tcm-lecture-test" data-teaching-guide="course-lecture-student-test">
        <span className="tcm-lecture-test-icon">{test?.completed ? <CheckCircle2 size={20} aria-hidden="true" /> : !test?.available || test.locked ? <LockKeyhole size={20} aria-hidden="true" /> : <ClipboardCheck size={20} aria-hidden="true" />}</span>
        <div>
          <span className="tcm-eyebrow">Крок 02 · Перевірка знань</span>
          <h4>{test?.available ? test.title : 'Тест після лекції'}</h4>
          <p>{test?.completed ? 'Вимогу для цього тесту виконано.' : !lecture.completed && test?.available && !test.locked ? 'Розпочату спробу можна продовжити.' : module.available_at && !lecture.completed ? 'Після відкриття модуля перегляньте відео, щоб розпочати тест.' : !lecture.completed ? 'Завершіть перегляд, щоб відкрити тест.' : !test?.available ? 'Тест з’явиться після публікації викладачем.' : test.locked ? test.reason || 'Виконайте умови відкриття тесту.' : courseCompletionLabels[test.completion]}</p>
          {test && test.score !== null && <p>Опублікований результат <strong>{test.score}{test.max_points !== null ? ` / ${test.max_points}` : ''}</strong></p>}
        </div>
        {test?.available && !test.locked && <TeachingButton primary={!test.completed} busy={busyId === test.id} disabled={Boolean(busyId)} onClick={() => void open(test.id)}><ExternalLink size={14} />{test.completed ? 'Переглянути тест' : 'Відкрити тест'}</TeachingButton>}
      </div>
    </div>
  }

  return <section className="tcm-workspace" aria-label="Мій маршрут курсу">
    <header className="tcm-heading" data-teaching-guide="course-lecture-student"><div><span className="tcm-eyebrow"><Layers3 size={14} aria-hidden="true" />Крок за кроком</span><h2>Лекції й тести</h2><p>Дивіться відео, проходьте тести під лекціями й відкривайте наступні теми. Тут також є матеріали та завдання вашого курсу.</p></div><TeachingButton busy={loading} disabled={Boolean(busyId)} onClick={() => void refresh()}><RefreshCw size={15} />Оновити прогрес</TeachingButton></header>
    {error && <p className="teaching-error" role="alert">{error}</p>}{data && notice && <p className="teaching-note" role="status">{notice}</p>}
    {!data ? <p className="tcm-empty" role="status">{loading ? 'Завантажуємо ваш маршрут…' : 'Не вдалося отримати маршрут. Спробуйте оновити дані.'}</p> : !data.modules.length ? <div className="tcm-empty">Викладач ще не опублікував модулі для цієї групи. Завдання й матеріали доступні у звичних розділах предмета.</div> : <>
      <div className="tcm-learning-hero"><div><span className="tcm-eyebrow"><BookOpen size={14} aria-hidden="true" />Ваш навчальний маршрут</span><h2>{data.course_title}</h2><p>Завершуйте обов’язкові кроки, щоб рухатися далі. Для матеріалу підтвердіть прочитання, для роботи виконайте зазначену умову. Бал зараховується до прогресу після його публікації викладачем.</p></div><div className="tcm-learning-total"><strong>{data.percent}%</strong><span>{data.completed} із {data.total} обов’язкових кроків виконано</span><progress className="tcm-progress-bar" max={100} value={data.percent} aria-label="Мій прогрес у курсі" /></div></div>
      <div className="tcm-learning-modules">{data.modules.map((module, index) => <article className="tcm-learning-module" data-locked={module.locked} key={module.id}><header><span className="tcm-module-index">{String(index + 1).padStart(2, '0')}</span><div><h3>{module.title}</h3><div className="tcm-actions"><span className="tcm-chip" data-state={module.locked ? 'locked' : module.total > 0 && module.completed >= module.total ? 'complete' : undefined}>{module.locked ? <><LockKeyhole size={12} aria-hidden="true" />Ще закрито</> : <>{module.completed} із {module.total} обов’язкових кроків</>}</span>{!module.locked && module.total > 0 && module.completed >= module.total && <span className="tcm-chip" data-state="complete"><CheckCircle2 size={12} aria-hidden="true" />Модуль виконано</span>}</div></div></header>{module.description && <p>{module.description}</p>}{module.locked && <div className="tcm-lock-reasons"><LockKeyhole size={16} aria-hidden="true" /><span>{delayReason(module.available_at) || prerequisiteReason(module.prerequisite_item_ids) || module.reason || 'Спочатку виконайте попередні умови цього модуля.'}</span></div>}
        {lectureBlock(module)}
        <div className="tcm-learning-items">{module.items.filter(item => item.id !== module.lecture?.test_item_id).map(item => { const locked = item.locked; const usable = !locked && item.available; const Icon = locked ? LockKeyhole : item.completed ? CheckCircle2 : item.resource_type === 'material' ? BookOpen : item.resource_type === 'test' ? ClipboardCheck : Circle; return <div key={item.id} className="tcm-learning-item" data-complete={item.completed} data-locked={locked || !item.available}><Icon size={20} aria-hidden="true" /><div><span className="tcm-chip" data-state={locked || !item.available ? 'locked' : undefined}>{courseResourceLabels[item.resource_type]}</span><h4>{item.available ? item.title : 'Крок готується'}</h4>{item.available ? <><p>{item.required ? 'Обов’язковий крок' : 'Додатковий крок'} · {item.completed ? 'Виконано' : `Умова: ${courseCompletionLabels[item.completion]}`}{item.completion === 'passed' && !item.completed ? ` · від ${item.pass_percent ?? 0}%` : ''}</p>{locked && <p>{prerequisiteReason([...module.prerequisite_item_ids, ...item.prerequisite_item_ids]) || delayReason(module.available_at) || item.reason || module.reason || 'Спочатку виконайте попередні умови.'}</p>}{item.score !== null && <p>Опублікований результат: <strong>{item.score}{item.max_points !== null ? ` / ${item.max_points}` : ''}</strong></p>}</> : <p>Викладач ще готує цей ресурс. Після публікації та виконання умов його можна буде відкрити.</p>}</div><div className="tcm-actions">{usable && <><TeachingButton disabled={Boolean(busyId)} busy={busyId === item.id} onClick={() => void open(item.id)}><ExternalLink size={14} />{module.locked && item.resource_type !== 'material' ? 'Продовжити роботу' : item.resource_type === 'material' ? 'Відкрити матеріал' : item.resource_type === 'test' ? 'Відкрити тест' : 'Відкрити завдання'}</TeachingButton>{item.resource_type === 'material' && item.completion === 'acknowledged' && !item.completed && <TeachingButton primary disabled={Boolean(busyId)} onClick={() => void acknowledge(item.id)}><CheckCircle2 size={14} />Позначити прочитаним</TeachingButton>}</>}{locked && <span className="tcm-chip" data-state="locked">Ще закрито</span>}</div></div> })}</div>
      </article>)}</div>
    </>}
  </section>
}
