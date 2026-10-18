import { useEffect, useId, useRef, useState } from 'react'
import { Check, Crop, ImagePlus, Loader2, RotateCw, ScanText, TriangleAlert, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { LESSON_TYPES } from '../lib/studyGroupTimetable'
import type { TimetableRecognitionResult, TimetableSourceAnalysis, TimetableSourceSelection } from '../lib/timetableRecognition'
import {
  analyzeTimetablePhoto, prepareTimetablePhoto, recognizeTimetablePhoto, timetableRecognitionAvailability,
  timetableSourceMatches, TimetableRecognitionRequestError, type TimetablePhotoOptions,
} from '../lib/timetableRecognitionClient'

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
const weekNames = { every: 'Щотижня', upper: 'Верхній', lower: 'Нижній' }
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const fieldClass = 'mt-1 min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50'
const fullCrop = { left: 0, top: 0, right: 100, bottom: 100 }
const levelNames: Record<string, string> = { bachelor: 'Бакалаврат', master: 'Магістратура', postgraduate: 'Аспірантура' }

function errorText(error: unknown): string {
  if (error instanceof Error && error.message && !/^[A-Z_\d]+$/.test(error.message)) return error.message
  return 'Не вдалося розпізнати фото. Перевірте з’єднання або спробуйте чіткіше зображення.'
}
function sourceLabel(source: TimetableSourceSelection): string {
  return [source.group_name, source.study_level ? levelNames[source.study_level] : '', source.study_year ? `${source.study_year} курс` : '', source.program, source.section_label].filter(Boolean).join(' · ') || 'Один розклад без підпису групи'
}
const compareLabel = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, '')

export function TimetablePhotoRecognition({ groupId, destinationName, destinationCourse, destinationProgram, destinationStudyLevel, hasDraft, onApply }: {
  groupId: string
  destinationName?: string
  destinationCourse?: number | null
  destinationProgram?: string
  destinationStudyLevel?: string | null
  hasDraft: boolean
  onApply: (result: TimetableRecognitionResult) => void
}) {
  const { authUser } = useAuth()
  const identity = `${authUser?.id || ''}:${groupId}`
  const currentIdentity = useRef(identity); currentIdentity.current = identity
  const inputId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [photoUrl, setPhotoUrl] = useState('')
  const [preparedImage, setPreparedImage] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [preparationError, setPreparationError] = useState('')
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0)
  const [cropEnabled, setCropEnabled] = useState(false)
  const [crop, setCrop] = useState(fullCrop)
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null)
  const [availabilityError, setAvailabilityError] = useState('')
  const [statusRefresh, setStatusRefresh] = useState(0)
  const [busy, setBusy] = useState<'analyze' | 'extract' | null>(null)
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState<TimetableSourceAnalysis | null>(null)
  const [courseFilter, setCourseFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [result, setResult] = useState<TimetableRecognitionResult | null>(null)
  const [applied, setApplied] = useState(false)
  const [confirmedSource, setConfirmedSource] = useState(false)
  const [confirmedReplacement, setConfirmedReplacement] = useState(false)
  const request = useRef<AbortController | null>(null)
  const requestVersion = useRef(0)
  const applying = useRef(false)
  const appliedResult = useRef<TimetableRecognitionResult | null>(null)
  const currentResult = useRef<TimetableRecognitionResult | null>(null)
  const resultOwner = useRef('')
  const photoDialog = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setAvailability(null); setAvailabilityError('')
    void timetableRecognitionAvailability(groupId, controller.signal).then((status) => {
      if (active && currentIdentity.current === identity) setAvailability(status)
    }).catch((problem: unknown) => {
      if (active && currentIdentity.current === identity && !controller.signal.aborted) setAvailabilityError(errorText(problem))
    })
    return () => { active = false; controller.abort() }
  }, [groupId, identity, statusRefresh])

  useEffect(() => {
    setFile(null); setPreparedImage(''); setAnalysis(null); setSelectedId(''); setResult(null)
    setApplied(false); setError(''); setBusy(null); setConfirmedSource(false); setConfirmedReplacement(false)
    setRotation(0); setCropEnabled(false); setCrop(fullCrop); setCourseFilter(''); setLevelFilter('')
    photoDialog.current?.close()
    return () => { requestVersion.current += 1; request.current?.abort(); request.current = null }
  }, [identity])

  useEffect(() => {
    if (!file) { setPhotoUrl(''); return }
    const url = URL.createObjectURL(file)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    setPreparedImage(''); setPreparationError('')
    if (!file) { setPreparing(false); return }
    const controller = new AbortController()
    let active = true
    setPreparing(true)
    const options: TimetablePhotoOptions = { rotation, crop: cropEnabled ? crop : fullCrop }
    void prepareTimetablePhoto(file, options, controller.signal).then((image) => {
      if (active && currentIdentity.current === identity) setPreparedImage(image)
    }).catch((problem) => {
      if (active && !controller.signal.aborted && currentIdentity.current === identity) setPreparationError(errorText(problem))
    }).finally(() => {
      if (active && currentIdentity.current === identity) setPreparing(false)
    })
    return () => { active = false; controller.abort() }
  }, [file, rotation, cropEnabled, crop.left, crop.top, crop.right, crop.bottom, identity])

  const cancel = () => {
    requestVersion.current += 1; request.current?.abort(); request.current = null; setBusy(null)
  }
  const clearResult = () => {
    resultOwner.current = ''
    appliedResult.current = null
    currentResult.current = null
    setResult(null); setApplied(false); setConfirmedSource(false); setConfirmedReplacement(false); setError('')
  }
  const invalidateImage = () => {
    photoDialog.current?.close()
    cancel(); clearResult(); setAnalysis(null); setSelectedId(''); setCourseFilter(''); setLevelFilter(''); setPreparedImage('')
  }
  const chooseFile = (selected: File | null) => {
    invalidateImage(); setRotation(0); setCropEnabled(false); setCrop(fullCrop)
    if (!selected) { setFile(null); return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || selected.size <= 0 || selected.size > 8 * 1024 * 1024) {
      setFile(null); setError('Оберіть фото JPG, PNG або WebP розміром до 8 МБ.'); return
    }
    setFile(selected)
  }
  const selected = analysis?.candidates.find((candidate) => candidate.id === selectedId) || null
  const chooseSource = (id: string) => { cancel(); clearResult(); setSelectedId(id) }
  const destination = [destinationName || 'Поточна навчальна група', destinationStudyLevel ? levelNames[destinationStudyLevel] : '', destinationCourse ? `${destinationCourse} курс` : '', destinationProgram].filter(Boolean).join(' · ')
  const sourceDiffers = Boolean(selected && ((selected.group_name && destinationName && compareLabel(selected.group_name) !== compareLabel(destinationName))
    || (selected.study_year && destinationCourse && selected.study_year !== destinationCourse)
    || (selected.study_level && destinationStudyLevel && selected.study_level !== destinationStudyLevel)
    || (selected.program && destinationProgram && compareLabel(selected.program) !== compareLabel(destinationProgram))))
  const unlabelledSource = Boolean(selected && !selected.group_name)
  const unknownSourceFields = selected ? [
    destinationName && !selected.group_name ? 'назву групи' : '',
    destinationCourse && !selected.study_year ? 'курс' : '',
    destinationStudyLevel && !selected.study_level ? 'рівень освіти' : '',
    destinationProgram && !selected.program ? 'освітню програму' : '',
  ].filter(Boolean) : []
  const requiresSourceConfirmation = sourceDiffers || unlabelledSource || unknownSourceFields.length > 0
  const sourceMatches = Boolean(result && selected && timetableSourceMatches(result, selected))

  const analyze = async () => {
    if (!preparedImage || !availability?.available || request.current || preparing) return
    const controller = new AbortController(); request.current = controller
    const version = ++requestVersion.current, owner = identity
    setBusy('analyze'); clearResult(); setAnalysis(null); setSelectedId(''); setCourseFilter(''); setLevelFilter('')
    try {
      const found = await analyzeTimetablePhoto(groupId, preparedImage, controller.signal)
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) {
        setAnalysis(found)
        // Only an unambiguous single schedule can be preselected. A sheet with
        // several groups always requires the user to choose its source column.
        setSelectedId(found.layout === 'single' && found.candidates.length === 1 ? found.candidates[0].id : '')
      }
    } catch (problem) {
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) setError(errorText(problem))
    } finally {
      if (requestVersion.current === version && currentIdentity.current === owner) { request.current = null; setBusy(null) }
    }
  }
  const recognize = async () => {
    if (!preparedImage || !analysis || !selected || !availability?.available || request.current || preparing) return
    const controller = new AbortController(); request.current = controller
    const version = ++requestVersion.current, owner = identity
    setBusy('extract'); clearResult()
    try {
      const recognized = await recognizeTimetablePhoto(groupId, preparedImage, selected, analysis.analysis_token, controller.signal)
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) { resultOwner.current = owner; currentResult.current = recognized; setResult(recognized) }
    } catch (problem) {
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) {
        if (problem instanceof TimetableRecognitionRequestError && problem.status === 409) { setAnalysis(null); setSelectedId('') }
        setError(errorText(problem))
      }
    } finally {
      if (requestVersion.current === version && currentIdentity.current === owner) { request.current = null; setBusy(null) }
    }
  }
  const apply = () => {
    if (!result || currentResult.current !== result || resultOwner.current !== currentIdentity.current || appliedResult.current === result || applied || applying.current || !sourceMatches || (requiresSourceConfirmation && !confirmedSource) || (hasDraft && !confirmedReplacement)) return
    applying.current = true
    appliedResult.current = result
    try { onApply(result); setApplied(true) } catch (problem) { appliedResult.current = null; setError(errorText(problem)) }
    finally { applying.current = false }
  }
  const affected = result?.week_mode === 'upper_only' ? 'верхнього тижня' : result?.week_mode === 'lower_only' ? 'нижнього тижня' : 'обох тижнів'
  const reviewCount = result?.lessons.filter((lesson) => lesson.needs_review || !lesson.subject || Boolean(lesson.date_note)).length || 0
  const missingTimeCount = result?.slots.filter((slot) => !slot.starts_at || !slot.ends_at).length || 0
  const courseOptions = Array.from(new Set((analysis?.candidates || []).map((candidate) => candidate.study_year))).sort((left, right) => (left || 99) - (right || 99))
  const levelOptions = Array.from(new Set((analysis?.candidates || []).map((candidate) => candidate.study_level)))
  const visibleCandidates = (analysis?.candidates || []).filter((candidate) => (!courseFilter || String(candidate.study_year ?? 'unknown') === courseFilter) && (!levelFilter || (candidate.study_level ?? 'unknown') === levelFilter))

  return <section className="rounded-2xl border border-primary/20 bg-primary/[0.025] p-4 sm:p-5" aria-labelledby={`${inputId}-title`}>
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ScanText size={21} aria-hidden="true" /></span><div><h3 id={`${inputId}-title`} className="font-semibold">Розпізнати з фото</h3><p className="mt-1 text-sm text-muted-foreground">Фото розкладу або скриншот таблиці з Excel. Спочатку оберіть потрібну групу на зображенні, потім перевірте заняття.</p></div></div>
    <div className="mt-3 rounded-xl border border-border bg-background px-3 py-2 text-xs"><span className="text-muted-foreground">Додати до групи: </span><strong className="font-medium">{destination}</strong></div>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label htmlFor={inputId} className={`${secondaryButton} relative cursor-pointer ${busy ? 'pointer-events-none opacity-50' : ''}`}><ImagePlus size={16} aria-hidden="true" />{file ? 'Замінити фото' : 'Обрати фото'}<input id={inputId} type="file" accept="image/jpeg,image/png,image/webp" disabled={Boolean(busy)} className="sr-only" onChange={(event) => { chooseFile(event.target.files?.[0] || null); event.target.value = '' }} /></label>
      <span className="text-xs text-muted-foreground">JPG, PNG, WebP · до 8 МБ</span>
    </div>
    {file && <div className="mt-4 grid items-start gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div>{(preparedImage || photoUrl) && <button type="button" onClick={() => photoDialog.current?.showModal()} aria-label="Збільшити обране фото розкладу" className="block w-full rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><img src={preparedImage || photoUrl} alt={preparedImage ? 'Фото розкладу, підготовлене для розпізнавання' : 'Обране фото розкладу'} className="max-h-80 w-full rounded-xl border border-border bg-background object-contain" /></button>}<p className="mt-1 text-xs text-muted-foreground">Натисніть на фото, щоб збільшити.</p></div>
      <div className="min-w-0"><div className="flex items-start justify-between gap-2"><p className="break-words text-sm font-medium">{file.name}</p><button type="button" disabled={Boolean(busy)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50" aria-label="Прибрати обране фото" onClick={() => chooseFile(null)}><X size={17} /></button></div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => { invalidateImage(); setRotation(((rotation + 90) % 360) as 0 | 90 | 180 | 270) }}><RotateCw size={15} aria-hidden="true" />Повернути на 90°</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} aria-expanded={cropEnabled} aria-controls={`${inputId}-crop`} onClick={() => { invalidateImage(); setCropEnabled(!cropEnabled); setCrop(fullCrop) }}><Crop size={15} aria-hidden="true" />{cropEnabled ? 'Скасувати обрізання' : 'Обрізати фото'}</button></div>
        {cropEnabled && <fieldset id={`${inputId}-crop`} className="mt-3 rounded-xl border border-border p-3"><legend className="px-1 text-xs font-medium">Межі потрібної області, % від оригіналу</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['left', 'top', 'right', 'bottom'] as const).map((side) => <label key={side} className="text-xs text-muted-foreground">{{ left: 'Ліва', top: 'Верхня', right: 'Права', bottom: 'Нижня' }[side]}<input type="number" min="0" max="100" step="1" className={fieldClass} value={crop[side]} disabled={Boolean(busy)} onChange={(event) => { invalidateImage(); setCrop({ ...crop, [side]: event.target.value === '' ? 0 : Number(event.target.value) }) }} /></label>)}</div><p className="mt-2 text-xs text-muted-foreground">Залиште заголовки групи, курсу, дні та час пар. Перегляд ліворуч показує результат обрізання й повороту.</p></fieldset>}
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Для великої таблиці краще залишити потрібну групу разом із заголовками. Якщо дрібний текст не читається на фото, завантажте ближчий знімок.</p>
        <p id={`${inputId}-disclosure`} className="mt-2 text-xs leading-relaxed text-muted-foreground">Фото буде передано OpenAI для розпізнавання після натискання кнопки. Заняття спочатку з’являться у чернетці для перевірки.</p>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!availability?.available || Boolean(busy) || preparing || !preparedImage} aria-describedby={`${inputId}-disclosure`} onClick={() => void analyze()} className={primaryButton}>{busy === 'analyze' || preparing ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ScanText size={16} aria-hidden="true" />}{preparing ? 'Готуємо фото…' : busy === 'analyze' ? 'Шукаємо групи…' : analysis ? 'Знайти групи ще раз' : 'Знайти групи на фото'}</button>{busy && <button type="button" className={secondaryButton} onClick={cancel}>Скасувати</button>}</div>
      </div>
    </div>}
    {!availability && !availabilityError && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Перевіряємо доступність розпізнавання…</p>}
    {availability && !availability.available && <p role="status" className="mt-3 rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground">Розпізнавання ще не підключено.{availability.reason && <span className="mt-1 block text-xs">{availability.reason}</span>}<span className="mt-1 block text-xs">Таблицю нижче можна заповнити вручну або вставити з Excel.</span></p>}
    {availabilityError && <div role="alert" className="mt-3 text-sm text-destructive"><p>{availabilityError}</p><button type="button" className={`${secondaryButton} mt-2 text-foreground`} onClick={() => setStatusRefresh((current) => current + 1)}>Перевірити ще раз</button></div>}
    {(error || preparationError) && <p role="alert" className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error || preparationError}</p>}
    {busy && <p role="status" className="mt-3 text-xs text-muted-foreground">{busy === 'analyze' ? 'Визначаємо, які групи та курси є на зображенні.' : 'Читаємо заняття лише для обраної групи.'} Це може зайняти до двох хвилин. Розклад ще не змінюється.</p>}
    {analysis && <div className="mt-5 space-y-3 rounded-xl border border-border bg-background p-3 sm:p-4">
      <h4 className="text-sm font-semibold">1. Оберіть розклад на фото</h4>
      {analysis.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{analysis.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
      {analysis.layout === 'unreadable' ? <p className="text-sm text-muted-foreground">Не вдалося надійно визначити розклад. Обріжте фото до потрібної таблиці із заголовками або завантажте чіткіший знімок.</p> : <>
        {analysis.layout === 'multiple' ? <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium">Рівень освіти на фото<select className={fieldClass} value={levelFilter} disabled={Boolean(busy)} onChange={(event) => { cancel(); clearResult(); setSelectedId(''); setLevelFilter(event.target.value) }}><option value="">Усі рівні</option>{levelOptions.map((level) => <option key={level ?? 'unknown'} value={level ?? 'unknown'}>{level ? levelNames[level] : 'Рівень не вказано'}</option>)}</select></label><label className="text-xs font-medium">Курс на фото<select className={fieldClass} value={courseFilter} disabled={Boolean(busy)} onChange={(event) => { cancel(); clearResult(); setSelectedId(''); setCourseFilter(event.target.value) }}><option value="">Усі курси</option>{courseOptions.map((course) => <option key={course ?? 'unknown'} value={course ?? 'unknown'}>{course ? `${course} курс` : 'Курс не вказано'}</option>)}</select></label><label className="min-w-0 text-xs font-medium sm:col-span-2">Група та освітня програма на фото<select className={fieldClass} value={selectedId} disabled={Boolean(busy)} onChange={(event) => chooseSource(event.target.value)}><option value="">Оберіть потрібну групу</option>{visibleCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{sourceLabel(candidate)}</option>)}</select></label></div> : selected && <p className="text-sm"><span className="text-muted-foreground">Знайдено: </span><strong className="font-medium">{sourceLabel(selected)}</strong></p>}
        <p className="text-xs text-muted-foreground">{analysis.layout === 'multiple' ? 'Однакові назви груп можуть бути на різних курсах. Перевірте також освітню програму та підпис блоку.' : 'Якщо на фото є інші групи, обріжте його до потрібної або зробіть чіткіший знімок і повторіть пошук.'}</p>
        {sourceDiffers && <p className="flex items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><TriangleAlert size={16} className="shrink-0" aria-hidden="true" />Підпис обраного розкладу відрізняється від групи призначення «{destination}». Перед перенесенням переконайтеся, що обрали правильний стовпець.</p>}
        {unknownSourceFields.length > 0 && <p className="rounded-xl border border-border p-3 text-xs text-muted-foreground">На фото не визначено {unknownSourceFields.join(', ')}. Переконайтеся, що це розклад вашої групи; ці дані не будуть вгадуватися.</p>}
        <button type="button" disabled={!selected || Boolean(busy) || !preparedImage || preparing || !availability?.available} className={primaryButton} onClick={() => void recognize()}>{busy === 'extract' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ScanText size={16} aria-hidden="true" />}{busy === 'extract' ? 'Розпізнаємо заняття…' : 'Розпізнати обраний розклад'}</button>
      </>}
    </div>}
    {result && selected && resultOwner.current === identity && <div className="mt-5 space-y-3 border-t border-primary/15 pt-4">
      <div><h4 className="text-sm font-semibold">2. Перевірте результат</h4><p className="mt-1 text-xs text-muted-foreground">З фото: {sourceLabel(selected)}<br />До групи: {destination}</p></div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl border border-border bg-background p-2"><strong className="block text-lg">{result.lessons.length}</strong>занять</div><div className="rounded-xl border border-border bg-background p-2"><strong className="block text-lg">{reviewCount}</strong>перевірити</div><div className="rounded-xl border border-border bg-background p-2"><strong className="block text-lg">{missingTimeCount}</strong>пар без часу</div></div>
      <p className="text-xs leading-relaxed text-muted-foreground">ШІ може помилятися навіть без позначок. Звірте всі заняття з фото перед додаванням.</p>
      <p className="text-xs text-muted-foreground">{result.week_mode === 'every' ? 'Розклад повторюється щотижня.' : result.week_mode === 'alternating' ? 'Розпізнано верхній і нижній тижні.' : `Розпізнано лише ${result.week_mode === 'upper_only' ? 'верхній' : 'нижній'} тиждень; інший залишиться без змін.`}</p>
      {(Boolean(result.warnings.length) || reviewCount > 0 || missingTimeCount > 0) && <div className="rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><p className="flex items-center gap-2 font-medium"><TriangleAlert size={16} aria-hidden="true" />Потрібна перевірка</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{result.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}{reviewCount > 0 && <li>Позначених занять: {reviewCount}. У таблиці виправте їх або виключіть з імпорту.</li>}{result.lessons.some((lesson) => lesson.date_note) && <li>Є примітки про дати або кількість пар. Встановіть окремий період цих занять у чернетці.</li>}{missingTimeCount > 0 && <li>Частину часу не вдалося прочитати. Вкажіть його у блоці «Час пар».</li>}</ul></div>}
      <div className="max-h-72 overflow-auto rounded-xl border border-border bg-background"><table className="w-full min-w-[31rem] text-left text-xs"><caption className="sr-only">Заняття, розпізнані з фото для обраної групи</caption><thead className="sticky top-0 bg-muted"><tr><th scope="col" className="p-2.5">День / пара</th><th scope="col" className="p-2.5">Час</th><th scope="col" className="p-2.5">Тиждень</th><th scope="col" className="p-2.5">Предмет</th></tr></thead><tbody>{result.lessons.map((lesson, index) => {
        const slot = result.slots.find((item) => item.number === lesson.lesson_number)
        return <tr key={`${lesson.week_pattern}:${lesson.weekday}:${lesson.lesson_number}:${index}`} className="border-t border-border"><td className="whitespace-nowrap p-2.5 align-top">{days[lesson.weekday - 1]} · {lesson.lesson_number}</td><td className="whitespace-nowrap p-2.5 align-top">{slot?.starts_at || '?'}–{slot?.ends_at || '?'}</td><td className="p-2.5 align-top">{weekNames[lesson.week_pattern]}</td><td className="p-2.5"><span className="font-medium">{lesson.subject || 'Назву не розпізнано'}</span><span className="mt-1 block text-muted-foreground">{LESSON_TYPES[lesson.lesson_type]}{lesson.location ? ` · ${lesson.location}` : ''}</span>{lesson.date_note && <span className="mt-1 block font-medium text-amber-700 dark:text-amber-300">Період: {lesson.date_note}</span>}{(lesson.needs_review || !lesson.subject) && <span className="mt-1 block text-amber-700 dark:text-amber-300">{lesson.review_note || 'Перевірте за фото'}</span>}</td></tr>
      })}</tbody></table></div>
      {!applied && <>
        {!sourceMatches && <p role="alert" className="text-sm text-destructive">Група у результаті не збігається з обраною на фото. Повторіть розпізнавання.</p>}
        {requiresSourceConfirmation && <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-amber-300/50 p-3 text-xs"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={confirmedSource} onChange={(event) => setConfirmedSource(event.target.checked)} /><span>{unlabelledSource ? `Підтверджую: цей розклад без назви групи належить групі «${destination}».` : unknownSourceFields.length > 0 ? `Підтверджую належність розкладу до групи «${destination}», хоча частину підписів не визначено.` : `Перевірив(-ла) підписи: обраний розклад потрібно додати саме до групи «${destination}».`}</span></label>}
        <p className="text-xs text-muted-foreground">{hasDraft ? `Застосування замінить клітинки ${affected} у вашій чернетці та оновить час пар. ` : 'Результат заповнить чернетку для редагування. '}Дати семестру й понеділок верхнього тижня вкажіть самостійно. Наявний розклад групи зберігається.</p>
        {hasDraft && <label className="flex cursor-pointer items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={confirmedReplacement} onChange={(event) => setConfirmedReplacement(event.target.checked)} /><span>Замінити відповідні клітинки моєї поточної чернетки.</span></label>}
        <button type="button" disabled={!result.lessons.length || !sourceMatches || (requiresSourceConfirmation && !confirmedSource) || (hasDraft && !confirmedReplacement)} className={primaryButton} onClick={apply}><Check size={16} aria-hidden="true" />Перенести в чернетку</button>
      </>}
      {applied && <p role="status" className="flex items-center gap-2 text-sm font-medium text-primary"><Check size={16} aria-hidden="true" />Перенесено в чернетку нижче. Перевірте її перед додаванням.</p>}
    </div>}
    <dialog ref={photoDialog} aria-label="Перегляд фото для розпізнавання" className="m-auto max-h-[90dvh] w-[96vw] max-w-6xl rounded-2xl border border-border bg-background p-3 text-foreground shadow-xl backdrop:bg-black/80 sm:p-5" onKeyDown={(event) => event.stopPropagation()} onMouseDown={(event) => { if (event.target === event.currentTarget) photoDialog.current?.close() }}>
      <div className="sticky top-0 z-10 mb-3 flex items-center justify-between gap-3 bg-background"><p className="text-sm font-medium">Фото для розпізнавання</p><button type="button" autoFocus onClick={() => photoDialog.current?.close()} aria-label="Закрити перегляд фото" className={secondaryButton}><X size={17} aria-hidden="true" />Закрити</button></div>
      {(preparedImage || photoUrl) && <div className="overflow-auto rounded-xl bg-white"><img src={preparedImage || photoUrl} alt="Збільшене фото розкладу для перевірки" className="mx-auto h-auto w-auto max-w-none" /></div>}
    </dialog>
  </section>
}
