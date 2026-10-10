import { useEffect, useId, useRef, useState } from 'react'
import { Check, ImagePlus, Loader2, ScanText, TriangleAlert, X } from 'lucide-react'
import { LESSON_TYPES } from '../lib/studyGroupTimetable'
import type { TimetableRecognitionResult } from '../lib/timetableRecognition'
import { recognizeTimetablePhoto, timetableRecognitionAvailability } from '../lib/timetableRecognitionClient'

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
const weekNames = { every: 'Щотижня', upper: 'Верхній', lower: 'Нижній' }
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'

function errorText(error: unknown): string {
  if (error instanceof Error && error.message && !/^[A-Z_\d]+$/.test(error.message)) return error.message
  return 'Не вдалося розпізнати фото. Перевірте з’єднання або спробуйте чіткіше зображення.'
}

export function TimetablePhotoRecognition({ groupId, hasDraft, onApply }: {
  groupId: string
  hasDraft: boolean
  onApply: (result: TimetableRecognitionResult) => void
}) {
  const inputId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [photoUrl, setPhotoUrl] = useState('')
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null)
  const [availabilityError, setAvailabilityError] = useState('')
  const [statusRefresh, setStatusRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TimetableRecognitionResult | null>(null)
  const [applied, setApplied] = useState(false)
  const request = useRef<AbortController | null>(null)
  const requestVersion = useRef(0)
  const applying = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setAvailability(null); setAvailabilityError('')
    void timetableRecognitionAvailability(groupId, controller.signal).then((status) => {
      if (active) setAvailability(status)
    }).catch((problem: unknown) => {
      if (active && !controller.signal.aborted) setAvailabilityError(errorText(problem))
    })
    return () => { active = false; controller.abort() }
  }, [groupId, statusRefresh])

  useEffect(() => {
    setFile(null); setResult(null); setApplied(false); setError(''); setBusy(false)
    return () => { requestVersion.current += 1; request.current?.abort(); request.current = null }
  }, [groupId])

  useEffect(() => {
    if (!file) { setPhotoUrl(''); return }
    const url = URL.createObjectURL(file)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const cancel = () => {
    requestVersion.current += 1; request.current?.abort(); request.current = null; setBusy(false)
  }
  const chooseFile = (selected: File | null) => {
    cancel(); setResult(null); setApplied(false); setError('')
    if (!selected) { setFile(null); return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || selected.size <= 0 || selected.size > 8 * 1024 * 1024) {
      setFile(null); setError('Оберіть фото JPG, PNG або WebP розміром до 8 МБ.'); return
    }
    setFile(selected)
  }
  const recognize = async () => {
    if (!file || !availability?.available || request.current) return
    const controller = new AbortController(); request.current = controller
    const version = ++requestVersion.current
    setBusy(true); setError(''); setResult(null); setApplied(false)
    try {
      const recognized = await recognizeTimetablePhoto(groupId, file, controller.signal)
      if (requestVersion.current === version && !controller.signal.aborted) setResult(recognized)
    } catch (problem) {
      if (requestVersion.current === version && !controller.signal.aborted) setError(errorText(problem))
    } finally {
      if (requestVersion.current === version) { request.current = null; setBusy(false) }
    }
  }
  const apply = () => {
    if (!result || applied || applying.current) return
    applying.current = true
    try { onApply(result); setApplied(true) } catch (problem) { setError(errorText(problem)) }
    finally { applying.current = false }
  }
  const affected = result?.week_mode === 'upper_only' ? 'верхнього тижня' : result?.week_mode === 'lower_only' ? 'нижнього тижня' : 'обох тижнів'
  const reviewCount = result?.lessons.filter((lesson) => lesson.needs_review || !lesson.subject).length || 0

  return <section className="rounded-2xl border border-primary/20 bg-primary/[0.025] p-4 sm:p-5" aria-labelledby={`${inputId}-title`}>
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ScanText size={21} aria-hidden="true" /></span><div><h3 id={`${inputId}-title`} className="font-semibold">Розпізнати з фото</h3><p className="mt-1 text-sm text-muted-foreground">Завантажте чітке фото або скриншот. Предмети, час і типи занять з’являться у таблиці для перевірки.</p></div></div>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label htmlFor={inputId} className={`${secondaryButton} relative cursor-pointer ${busy ? 'pointer-events-none opacity-50' : ''}`}><ImagePlus size={16} aria-hidden="true" />{file ? 'Замінити фото' : 'Обрати фото'}<input id={inputId} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className="sr-only" onChange={(event) => { chooseFile(event.target.files?.[0] || null); event.target.value = '' }} /></label>
      <span className="text-xs text-muted-foreground">JPG, PNG, WebP · до 8 МБ</span>
    </div>
    {file && <div className="mt-4 grid items-start gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
      {photoUrl && <img src={photoUrl} alt="Обране фото розкладу" className="max-h-64 w-full rounded-xl border border-border bg-background object-contain" />}
      <div className="min-w-0"><div className="flex items-start justify-between gap-2"><p className="break-words text-sm font-medium">{file.name}</p><button type="button" disabled={busy} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50" aria-label="Прибрати обране фото" onClick={() => chooseFile(null)}><X size={17} /></button></div><p id={`${inputId}-disclosure`} className="mt-2 text-xs leading-relaxed text-muted-foreground">Фото буде передано OpenAI для розпізнавання. Перевірте результат перед додаванням.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!availability?.available || busy} aria-describedby={`${inputId}-disclosure`} onClick={() => void recognize()} className={primaryButton}>{busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ScanText size={16} aria-hidden="true" />}{busy ? 'Розпізнаємо…' : 'Розпізнати фото'}</button>{busy && <button type="button" className={secondaryButton} onClick={cancel}>Скасувати</button>}</div></div>
    </div>}
    {!availability && !availabilityError && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Перевіряємо доступність розпізнавання…</p>}
    {availability && !availability.available && <p role="status" className="mt-3 rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground">Розпізнавання ще не підключено.{availability.reason && <span className="mt-1 block text-xs">{availability.reason}</span>}<span className="mt-1 block text-xs">Таблицю нижче можна заповнити вручну або вставити з Excel.</span></p>}
    {availabilityError && <div role="alert" className="mt-3 text-sm text-destructive"><p>{availabilityError}</p><button type="button" className={`${secondaryButton} mt-2 text-foreground`} onClick={() => setStatusRefresh((current) => current + 1)}>Перевірити ще раз</button></div>}
    {error && <p role="alert" className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {busy && <p role="status" className="mt-3 text-xs text-muted-foreground">Зазвичай це займає до хвилини. Заняття ще не додаються до групи.</p>}
    {result && <div className="mt-5 space-y-3 border-t border-primary/15 pt-4">
      <div><h4 className="text-sm font-semibold">Результат розпізнавання</h4><p className="mt-1 text-xs text-muted-foreground">Знайдено {result.lessons.length} записів занять. {result.week_mode === 'every' ? 'Розклад повторюється щотижня.' : result.week_mode === 'alternating' ? 'Розпізнано верхній і нижній тижні.' : `Розпізнано лише ${result.week_mode === 'upper_only' ? 'верхній' : 'нижній'} тиждень; інший залишиться без змін.`}</p></div>
      {(Boolean(result.warnings.length) || reviewCount > 0 || result.slots.some((slot) => !slot.starts_at || !slot.ends_at)) && <div className="rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><p className="flex items-center gap-2 font-medium"><TriangleAlert size={16} aria-hidden="true" />Потрібна перевірка</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{result.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}{reviewCount > 0 && <li>Позначених занять: {reviewCount}. У таблиці виправте їх або виключіть з імпорту.</li>}{result.slots.some((slot) => !slot.starts_at || !slot.ends_at) && <li>Частину часу не вдалося прочитати. Вкажіть його у блоці «Час пар».</li>}</ul></div>}
      <div className="max-h-72 overflow-auto rounded-xl border border-border bg-background"><table className="w-full min-w-[31rem] text-left text-xs"><caption className="sr-only">Заняття, розпізнані з фото</caption><thead className="sticky top-0 bg-muted"><tr><th scope="col" className="p-2.5">День / пара</th><th scope="col" className="p-2.5">Тиждень</th><th scope="col" className="p-2.5">Предмет</th></tr></thead><tbody>{result.lessons.map((lesson, index) => <tr key={`${lesson.week_pattern}:${lesson.weekday}:${lesson.lesson_number}:${index}`} className="border-t border-border"><td className="whitespace-nowrap p-2.5 align-top">{days[lesson.weekday - 1]} · {lesson.lesson_number}</td><td className="p-2.5 align-top">{weekNames[lesson.week_pattern]}</td><td className="p-2.5"><span className="font-medium">{lesson.subject || 'Назву не розпізнано'}</span><span className="mt-1 block text-muted-foreground">{LESSON_TYPES[lesson.lesson_type]}{lesson.location ? ` · ${lesson.location}` : ''}</span>{(lesson.needs_review || !lesson.subject) && <span className="mt-1 block text-amber-700 dark:text-amber-300">{lesson.review_note || 'Перевірте за фото'}</span>}</td></tr>)}</tbody></table></div>
      {!applied && <><p className="text-xs text-muted-foreground">{hasDraft ? `Застосування замінить клітинки ${affected} у вашій чернетці та оновить час пар. ` : 'Результат заповнить чернетку для редагування. '}Дати семестру й понеділок верхнього тижня вкажіть самостійно. Наявний розклад групи зберігається.</p><button type="button" disabled={!result.lessons.length} className={primaryButton} onClick={apply}><Check size={16} aria-hidden="true" />Перенести в таблицю</button></>}
      {applied && <p role="status" className="flex items-center gap-2 text-sm font-medium text-primary"><Check size={16} aria-hidden="true" />Перенесено в чернетку нижче. Перевірте її перед додаванням.</p>}
    </div>}
  </section>
}
