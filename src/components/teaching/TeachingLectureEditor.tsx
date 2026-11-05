import { useEffect, useRef, useState } from 'react'
import { ClipboardCheck, Film, Play, Upload } from 'lucide-react'
import type { TeachingFile } from '../../lib/teaching'
import { courseCompletionLabels, courseModuleError, lectureTime, type CourseCompletionRule, type CourseLecture, type CourseModuleItem, type CourseResource, type TeachingCourseModuleRepository } from '../../lib/teachingCourseModules'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

type Props = {
  lecture: CourseLecture
  linkedTest?: CourseModuleItem
  tests: CourseResource[]
  groups: string[]
  courseId: string
  userId: string
  repository: TeachingCourseModuleRepository
  disabled: boolean
  onUploadState: (busy: boolean) => void
  onVideo: (file: TeachingFile, duration: number) => void
  onTest: (id: string) => void
  onCondition: (patch: Partial<CourseModuleItem>) => void
}

export function TeachingLectureEditor({ lecture, linkedTest, tests, groups, courseId, userId, repository, disabled, onUploadState, onVideo, onTest, onCondition }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const upload = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const latest = useRef({ onUploadState, onVideo })
  latest.current = { onUploadState, onVideo }

  useEffect(() => () => upload.current?.abort(), [])

  async function uploadVideo(file?: File) {
    if (!file || !repository.uploadLecture || upload.current || disabled) return
    const controller = new AbortController()
    upload.current = controller
    latest.current.onUploadState(true)
    setProgress(0)
    setError('')
    try {
      const result = await repository.uploadLecture(courseId, userId, file, percent => {
        if (!controller.signal.aborted) setProgress(percent)
      }, controller.signal)
      if (!controller.signal.aborted) latest.current.onVideo(result.file, result.duration_seconds)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const message = failure instanceof Error && /^[А-ЯІЇЄҐ]/u.test(failure.message) ? failure.message : courseModuleError(failure)
        setError(message)
      }
    } finally {
      if (upload.current === controller) {
        upload.current = null
        latest.current.onUploadState(false)
        if (!controller.signal.aborted) setProgress(null)
      }
    }
  }

  const selectedTest = tests.find(test => test.id === linkedTest?.resource_id)
  const canGrade = Boolean(selectedTest?.max_points && selectedTest.max_points > 0)
  return <div className="tcm-lecture-editor">
    <section data-teaching-guide="course-lecture-video">
      <div className="tcm-lecture-step"><span className="tcm-lecture-test-icon"><Film size={19} aria-hidden="true" /></span><div><span className="tcm-eyebrow">Крок 01</span><h4>Відеолекція</h4><p>Додайте MP4 або WebM до 50 МБ. Xelay перевірить файл і збереже його для вибраних груп.</p></div></div>
      <div className="tcm-lecture-upload">
        <div><strong>{lecture.file?.name || 'Відео ще не додано'}</strong>{lecture.file && <p>Тривалість {lectureTime(lecture.duration_seconds)} · {Math.max(.1, Math.round(lecture.file.size / 1024 / 1024 * 10) / 10)} МБ</p>}</div>
        <input ref={input} type="file" accept=".mp4,.webm,video/mp4,video/webm" hidden onChange={event => { void uploadVideo(event.target.files?.[0]); event.target.value = '' }} />
        <TeachingButton disabled={disabled || !repository.uploadLecture} busy={progress !== null} onClick={() => input.current?.click()}><Upload size={15} />{lecture.file ? 'Замінити відео' : 'Вибрати відео'}</TeachingButton>
      </div>
      {progress !== null && <div className="tcm-lecture-upload-progress" role="status"><progress className="tcm-progress-bar" aria-label="Завантаження відеолекції" value={progress} max={100} /><p>{progress < 99 ? `Завантажуємо відео · ${progress}%` : 'Перевіряємо вміст відео…'}</p></div>}
      {error && <p className="teaching-error" role="alert">{error}</p>}
      {lecture.file && repository.lectureUrl && <LectureFilePreview key={lecture.file.storage_path} file={lecture.file} resolveUrl={repository.lectureUrl} />}
    </section>
    <section data-teaching-guide="course-lecture-test">
      <div className="tcm-lecture-step"><span className="tcm-lecture-test-icon"><ClipboardCheck size={19} aria-hidden="true" /></span><div><span className="tcm-eyebrow">Крок 02</span><h4>Тест під відео</h4><p>Оберіть тест цього предмета. Для студентів він відкриється після 90% послідовного перегляду.</p></div></div>
      <TeachingField label="Пов’язаний тест" hint="Для нового тесту відкрийте вкладку «Тести», створіть його й поверніться до модуля."><select className={teachingInput} value={linkedTest?.resource_id || ''} disabled={disabled || progress !== null} onChange={event => onTest(event.target.value)}><option value="">Оберіть тест для цієї лекції</option>{tests.map(test => <option key={test.id} value={test.id} disabled={groups.some(group => !test.group_ids.includes(group))}>{test.title}{test.status !== 'published' ? ' · чернетка' : ''}</option>)}</select></TeachingField>
      {linkedTest && <div className="tcm-form-grid">
        <TeachingField label="Коли відкривається наступна лекція"><select className={teachingInput} value={linkedTest.completion} disabled={disabled || progress !== null} onChange={event => {
          const completion = event.target.value as CourseCompletionRule
          onCondition({ completion, pass_percent: completion === 'passed' ? linkedTest.pass_percent ?? 60 : null })
        }}>
          <option value="submitted">{courseCompletionLabels.submitted}</option>
          <option value="graded" disabled={!canGrade}>{courseCompletionLabels.graded}</option>
          <option value="passed" disabled={!canGrade}>{courseCompletionLabels.passed}</option>
        </select></TeachingField>
        {linkedTest.completion === 'passed' && <TeachingField label="Мінімальний результат, %"><input className={teachingInput} type="number" min={0} max={100} step={1} value={linkedTest.pass_percent ?? ''} disabled={disabled || progress !== null} onChange={event => onCondition({ pass_percent: event.target.value === '' ? null : Number(event.target.value) })} /></TeachingField>}
      </div>}
      {!selectedTest && !tests.length && <p className="tcm-muted">Вільних тестів ще немає. Створіть тест у цьому предметі.</p>}
      {selectedTest?.status === 'draft' && <p className="tcm-muted">Тест ще в чернетках. Модуль можна зберегти, а для публікації лекції спочатку опублікуйте тест.</p>}
      {selectedTest && groups.some(group => !selectedTest.group_ids.includes(group)) && <p className="teaching-error" role="alert">Тест має охоплювати всі вибрані групи лекції.</p>}
      {selectedTest?.whole_group_ids && groups.some(group => !selectedTest.whole_group_ids?.includes(group)) && <p className="tcm-muted">Перед публікацією відкрийте доступ до тесту всім студентам вибраних груп.</p>}
    </section>
  </div>
}

function LectureFilePreview({ file, resolveUrl }: {
  file: TeachingFile
  resolveUrl: (file: TeachingFile) => Promise<string>
}) {
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  async function open() {
    setLoading(true)
    setError(false)
    try { setSource(await resolveUrl(file)) }
    catch { setError(true) }
    finally { setLoading(false) }
  }

  return <div className="mt-3">
    {source ? <div className="tcm-video-stage"><video src={source} controls playsInline preload="metadata" aria-label="Попередній перегляд лекції" onError={() => { setSource(''); setError(true) }} /></div>
      : <TeachingButton busy={loading} onClick={() => void open()}><Play size={15} />Переглянути відео</TeachingButton>}
    {error && <p className="teaching-error mt-2" role="alert">Не вдалося відкрити відео. Перевірте з’єднання та спробуйте ще раз.</p>}
  </div>
}
