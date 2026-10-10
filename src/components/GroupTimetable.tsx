import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, Image, Loader2, MapPin, Pencil, Plus, Table2, TriangleAlert, X } from 'lucide-react'
import { StudyGroupTimetablePhoto } from './StudyGroupTimetablePhoto'
import { TimetablePhotoRecognition } from './TimetablePhotoRecognition'
import type { TimetableRecognitionResult } from '../lib/timetableRecognition'
import {
  DEFAULT_TIMETABLE_SLOTS, LESSON_TYPES as TYPES, addTimetableDays, importStudyGroupTimetable, isTimetableDate, mondayForDate,
  parseTimetableCell, parseTimetableTsv, scheduleOccursOnDate, timetableImportError, weekPatternOnDate,
  type TimetableLesson, type TimetableLessonDraft, type TimetablePaste, type TimetableSlot, type WeekPattern,
} from '../lib/studyGroupTimetable'

export type GroupTimetableProps = {
  groupId: string
  currentUserId: string
  schedule: TimetableLesson[]
  canEdit: boolean
  selectedDate: string
  onDateChange: (date: string) => void
  onEditLesson: (lesson: TimetableLesson) => void
  onAddLesson: (values: { weekday: number; starts_at: string; ends_at: string; lesson_number: number | null; week_pattern: WeekPattern; week_anchor_date: string | null }) => void
  onImported: () => Promise<void> | void
}

type AlternatingWeek = 'upper' | 'lower'
type WeekGrid = Record<string, string>
type WeekGrids = Record<AlternatingWeek, WeekGrid>
type CellDetails = { location: string; online_url: string; online_url_secondary: string; needs_review: boolean; review_note: string }
type WeekDetails = Record<string, CellDetails>
type WeekDetailsGrids = Record<AlternatingWeek, WeekDetails>
type DisplaySlot = TimetableSlot & { numbers: number[]; hasUnnumbered: boolean }
const emptyCellDetails = (): CellDetails => ({ location: '', online_url: '', online_url_secondary: '', needs_review: false, review_note: '' })

function slotLabel(slot: DisplaySlot): string {
  if (!slot.numbers.length) return 'Без номера'
  const numbered = slot.numbers.length === 1 ? `${slot.numbers[0]} пара` : `Пари ${slot.numbers.join(' / ')}`
  return `${numbered}${slot.hasUnnumbered ? ' · без номера' : ''}`
}

const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя']
const SHORT_DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
const WEEK_NAMES: Record<AlternatingWeek, string> = { upper: 'Верхній', lower: 'Нижній' }
const inputClass = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50 sm:text-sm motion-reduce:transition-none'
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const iconButton = 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40 motion-reduce:transition-none'

function formatDate(date: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }): string {
  if (!isTimetableDate(date)) return ''
  return new Intl.DateTimeFormat('uk-UA', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
}

function todayInKyiv(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function safeLessonUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null } catch { return null }
}

function LessonCard({ lesson, canEdit, onEdit }: { lesson: TimetableLesson; canEdit: boolean; onEdit: () => void }) {
  const links = [safeLessonUrl(lesson.online_url), safeLessonUrl(lesson.online_url_secondary)].filter((value): value is string => Boolean(value))
  return <article className={`min-w-0 rounded-xl border p-3 ${lesson.lesson_type === 'lecture' ? 'border-blue-200/70 bg-blue-50/80 dark:border-blue-800/50 dark:bg-blue-950/30' : 'border-primary/15 bg-primary/5'}`}>
    <div className="flex items-start gap-1"><p className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">{lesson.subject}</p>{canEdit && <button type="button" onClick={onEdit} className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Редагувати заняття: ${lesson.subject}`}><Pencil size={14} /></button>}</div>
    <p className="mt-1 text-xs text-muted-foreground">{TYPES[lesson.lesson_type]} · {lesson.lesson_number ? `${lesson.lesson_number} пара` : 'Без номера'} · {lesson.starts_at.slice(0, 5)}–{lesson.ends_at.slice(0, 5)}</p>
    {lesson.location && <p className="mt-2 flex items-start gap-1.5 break-words text-xs text-muted-foreground"><MapPin size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{lesson.location}</p>}
    {links.map((url, index) => <a key={`${url}:${index}`} href={url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 break-words text-xs font-medium text-primary underline-offset-4 hover:underline"><ExternalLink size={12} aria-hidden="true" />{index === 0 ? 'Онлайн-заняття' : 'Друге посилання'}<span className="sr-only"> (відкриється в новій вкладці)</span></a>)}
  </article>
}

export function GroupTimetable(props: GroupTimetableProps) {
  return <TimetableWorkspace key={`${props.groupId}:${props.currentUserId}`} {...props} />
}

function TimetableWorkspace({ groupId, currentUserId, schedule, canEdit, selectedDate, onDateChange, onEditLesson, onAddLesson, onImported }: GroupTimetableProps) {
  const [mode, setMode] = useState<'photo' | 'table'>(schedule.length ? 'table' : 'photo')
  const [fallbackPattern, setFallbackPattern] = useState<AlternatingWeek>('upper')
  const [importing, setImporting] = useState(false)
  const today = todayInKyiv()
  const monday = mondayForDate(selectedDate) || mondayForDate(today)
  const sunday = addTimetableDays(monday, 6)
  const activeLessons = useMemo(() => schedule.filter((lesson) => lesson.valid_from <= sunday && lesson.valid_until >= monday), [schedule, monday, sunday])
  const datedLessons = activeLessons.filter((lesson) => lesson.week_anchor_date && isTimetableDate(lesson.week_anchor_date))
  const anchor = datedLessons[0]?.week_anchor_date || null
  const parities = new Set(datedLessons.map((lesson) => weekPatternOnDate(monday, lesson.week_anchor_date!)))
  const selectedPattern = anchor ? weekPatternOnDate(monday, anchor) : null
  const viewPattern = selectedPattern || fallbackPattern
  const currentAnchors = schedule.filter((lesson) => lesson.week_anchor_date && isTimetableDate(lesson.week_anchor_date) && lesson.valid_from <= today && lesson.valid_until >= today)
  const currentParities = new Set(currentAnchors.map((lesson) => weekPatternOnDate(today, lesson.week_anchor_date!)))
  const currentPattern = currentParities.size === 1 ? [...currentParities][0] : null
  const weekLessons = useMemo(() => activeLessons.filter((lesson) => scheduleOccursOnDate(lesson, addTimetableDays(monday, lesson.weekday - 1))), [activeLessons, monday])
  const weekdays = [1, 2, 3, 4, 5, ...[6, 7].filter((day) => weekLessons.some((lesson) => lesson.weekday === day))]
  const slots = useMemo(() => {
    if (!schedule.length) return DEFAULT_TIMETABLE_SLOTS.map((slot): DisplaySlot => ({ ...slot, numbers: [slot.number], hasUnnumbered: false }))
    const rows: DisplaySlot[] = []
    for (const lesson of weekLessons) {
      const starts_at = lesson.starts_at.slice(0, 5); const ends_at = lesson.ends_at.slice(0, 5)
      let row = rows.find((slot) => slot.starts_at === starts_at && slot.ends_at === ends_at)
      if (!row) { row = { number: 0, numbers: [], hasUnnumbered: false, starts_at, ends_at }; rows.push(row) }
      if (lesson.lesson_number && !row.numbers.includes(lesson.lesson_number)) row.numbers.push(lesson.lesson_number)
      if (!lesson.lesson_number) row.hasUnnumbered = true
      row.numbers.sort((a, b) => a - b)
      row.number = row.numbers.length === 1 ? row.numbers[0] : 0
    }
    return rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at))
  }, [schedule.length, weekLessons])
  const lessonsFor = (day: number, slot: TimetableSlot) => {
    return weekLessons.filter((lesson) => lesson.starts_at.slice(0, 5) === slot.starts_at && lesson.ends_at.slice(0, 5) === slot.ends_at && lesson.weekday === day).sort((a, b) => a.subject.localeCompare(b.subject, 'uk'))
  }
  const choosePattern = (pattern: AlternatingWeek) => {
    setFallbackPattern(pattern)
    if (selectedPattern && pattern !== selectedPattern) onDateChange(addTimetableDays(monday, 7))
  }
  const addAt = (day: number, slot: TimetableSlot) => onAddLesson({ weekday: day, starts_at: slot.starts_at, ends_at: slot.ends_at, lesson_number: slot.number || null, week_pattern: viewPattern, week_anchor_date: anchor })

  return <section className="space-y-5" aria-label="Наш розклад">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Наш розклад</h2><p className="mt-1 text-sm text-muted-foreground">Розклад навчальної групи для всіх її учасників.</p></div>
      {canEdit && <button type="button" className={primaryButton} onClick={() => setImporting(true)}><Table2 size={16} aria-hidden="true" />Завантажити розклад</button>}
    </header>
    <div className="inline-flex max-w-full gap-1 rounded-full border border-border bg-muted/40 p-1" role="group" aria-label="Вигляд розкладу">
      {(['photo', 'table'] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)} className={`inline-flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors motion-reduce:transition-none ${mode === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background'}`}>{value === 'photo' ? <Image size={16} aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />}{value === 'photo' ? 'Фото' : 'Таблиця'}</button>)}
    </div>
    {mode === 'photo' ? <StudyGroupTimetablePhoto groupId={groupId} currentUserId={currentUserId} canEdit={canEdit} /> : <>
      <div className="rounded-2xl border border-border bg-background p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex gap-1 rounded-full bg-muted/60 p-1" role="group" aria-label="Тип тижня">
            {(['upper', 'lower'] as const).map((pattern) => <button type="button" key={pattern} aria-pressed={viewPattern === pattern} onClick={() => choosePattern(pattern)} className={`min-h-10 rounded-full px-4 py-2 text-sm font-medium transition-colors motion-reduce:transition-none ${viewPattern === pattern ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background'}`}>{WEEK_NAMES[pattern]}</button>)}
          </div>
          <p className="text-sm text-muted-foreground">Поточний тиждень: <span className="font-medium text-foreground">{currentPattern ? WEEK_NAMES[currentPattern].toLocaleLowerCase('uk-UA') : 'ще не визначено'}</span>{currentPattern && <span> · {formatDate(today)}</span>}</p>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="flex min-w-0 items-center gap-1"><button type="button" className={iconButton} onClick={() => onDateChange(addTimetableDays(monday, -7))} aria-label="Попередній тиждень"><ChevronLeft size={19} /></button><p aria-live="polite" className="px-1 text-center text-sm font-medium">{formatDate(monday)} — {formatDate(addTimetableDays(monday, weekdays[weekdays.length - 1] - 1), { day: 'numeric', month: 'long', year: 'numeric' })}</p><button type="button" className={iconButton} onClick={() => onDateChange(addTimetableDays(monday, 7))} aria-label="Наступний тиждень"><ChevronRight size={19} /></button></div>
          <div className="flex items-center gap-2"><button type="button" className={secondaryButton} onClick={() => onDateChange(today)}>Сьогодні</button><label className="sr-only" htmlFor="timetable-week-date">Дата тижня</label><input id="timetable-week-date" type="date" value={selectedDate} onChange={(event) => { if (isTimetableDate(event.target.value)) onDateChange(event.target.value) }} className={`${inputClass} max-w-[10rem]`} /></div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{anchor && selectedPattern ? `Понеділок верхнього тижня: ${formatDate(anchor, { day: 'numeric', month: 'long', year: 'numeric' })}.` : 'Для визначення верхнього й нижнього тижня староста вказує понеділок верхнього тижня.'}{parities.size > 1 && ' У вибраному періоді є різні опорні дати; перевірте їх у заняттях.'}</p>
      </div>
      {!schedule.length && <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">У таблиці ще немає занять.{canEdit && ' Завантажте таблицю або додайте окрему пару.'}</p>}
      {Boolean(schedule.length) && !weekLessons.length && <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">У вибраному тижні занять немає.{canEdit && ' Для іншого періоду оберіть дату або заповніть таблицю.'}</p>}
      <div className="hidden overflow-hidden rounded-2xl border border-border lg:block"><table className="w-full table-fixed border-collapse"><caption className="sr-only">{WEEK_NAMES[viewPattern]} тиждень. Розклад за днями та номерами пар.</caption><thead><tr className="bg-muted/40"><th scope="col" className="w-28 border-b border-border p-3 text-left text-xs font-medium text-muted-foreground">Пара / час</th>{weekdays.map((day) => <th scope="col" key={day} className="border-b border-l border-border p-3 text-left"><span className="block text-sm font-medium">{DAYS[day - 1]}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{formatDate(addTimetableDays(monday, day - 1))}</span></th>)}</tr></thead><tbody>{slots.map((slot) => <tr key={`${slot.starts_at}:${slot.ends_at}`}><th scope="row" className="border-t border-border bg-muted/20 p-3 align-top text-left"><span className="block text-sm font-medium">{slotLabel(slot)}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{slot.starts_at}<br />{slot.ends_at}</span></th>{weekdays.map((day) => {
        const lessons = lessonsFor(day, slot)
        return <td key={day} className="border-l border-t border-border p-2 align-top"><div className="space-y-2">{lessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} canEdit={canEdit} onEdit={() => onEditLesson(lesson)} />)}{canEdit && <button type="button" onClick={() => addAt(day, slot)} className="flex min-h-10 w-full items-center justify-center gap-1 rounded-xl text-xs text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary motion-reduce:transition-none" aria-label={`Додати заняття: ${DAYS[day - 1]}, ${slotLabel(slot)}, ${slot.starts_at}`}><Plus size={14} aria-hidden="true" />{lessons.length ? 'Додати' : 'Вільна пара'}</button>}{!canEdit && !lessons.length && <span className="block py-3 text-center text-xs text-muted-foreground" aria-label="Вільна пара">—</span>}</div></td>
      })}</tr>)}</tbody></table></div>
      <div className="space-y-4 lg:hidden">{weekdays.map((day) => <section key={day} aria-labelledby={`timetable-day-${day}`} className="rounded-2xl border border-border bg-background p-4"><h3 id={`timetable-day-${day}`} className="flex flex-wrap items-baseline justify-between gap-2 font-semibold"><span>{DAYS[day - 1]}</span><span className="text-xs font-normal text-muted-foreground">{formatDate(addTimetableDays(monday, day - 1))}</span></h3><div className="mt-3 space-y-3">{slots.map((slot) => {
        const lessons = lessonsFor(day, slot)
        if (!lessons.length && !canEdit) return null
        return <div key={`${slot.starts_at}:${slot.ends_at}`} className="flex items-start gap-3 border-t border-border pt-3"><div className="w-16 shrink-0 pt-1 text-xs text-muted-foreground"><p className="font-medium text-foreground">{slotLabel(slot)}</p><p className="mt-1">{slot.starts_at}<br />{slot.ends_at}</p></div><div className="min-w-0 flex-1 space-y-2">{lessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} canEdit={canEdit} onEdit={() => onEditLesson(lesson)} />)}{canEdit && <button type="button" onClick={() => addAt(day, slot)} className={`${secondaryButton} w-full text-xs`}><Plus size={14} aria-hidden="true" />{lessons.length ? 'Додати заняття' : 'Вільна пара · додати'}</button>}</div></div>
      })}{(!slots.length || (!canEdit && !slots.some((slot) => lessonsFor(day, slot).length))) && <p className="py-2 text-sm text-muted-foreground">Занять немає.</p>}</div></section>)}</div>
    </>}
    {importing && canEdit && <TimetableImporter groupId={groupId} onClose={() => setImporting(false)} onImported={onImported} />}
  </section>
}

function ImportDialog({ busy, onClose, children, focusKey }: { busy: boolean; onClose: () => void; children: ReactNode; focusKey: string }) {
  const container = useRef<HTMLDivElement>(null)
  const latestClose = useRef(onClose); latestClose.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; container.current?.focus()
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  useEffect(() => { container.current?.focus() }, [focusKey])
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-2 py-3 backdrop-blur-sm sm:px-4 sm:py-5" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) latestClose.current() }}><div ref={container} role="dialog" aria-modal="true" aria-labelledby="timetable-import-title" tabIndex={-1} className="flex max-h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl outline-none" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) latestClose.current()
    if (event.key !== 'Tab') return
    const elements = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []).filter((element) => element.offsetParent !== null)
    const first = elements[0]; const last = elements[elements.length - 1]
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === container.current)) { event.preventDefault(); first.focus() }
  }}><header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6"><h2 id="timetable-import-title" className="text-lg font-semibold">Завантажити розклад</h2><button type="button" className={iconButton} disabled={busy} onClick={onClose} aria-label="Закрити завантаження розкладу"><X size={20} /></button></header><div className="overflow-y-auto p-4 sm:p-6">{children}</div></div></div>
}

function buildLessons(grids: WeekGrids, slots: TimetableSlot[], validFrom: string, validUntil: string, anchor: string, details: WeekDetailsGrids): TimetableLessonDraft[] {
  const lessons: TimetableLessonDraft[] = []
  if (!isTimetableDate(validFrom) || !isTimetableDate(validUntil) || validFrom > validUntil) throw new Error('Вкажіть початок і завершення семестру в правильному порядку.')
  if (!isTimetableDate(anchor) || mondayForDate(anchor) !== anchor) throw new Error('Оберіть саме понеділок верхнього тижня. Парність визначатиметься від цієї дати.')
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
  const orderedSlots = [...slots].sort((left, right) => left.number - right.number)
  for (let index = 0; index < orderedSlots.length; index += 1) {
    const slot = orderedSlots[index]
    if (!timePattern.test(slot.starts_at) || !timePattern.test(slot.ends_at) || slot.starts_at >= slot.ends_at) throw new Error(`Перевірте час ${slot.number} пари: завершення має бути після початку.`)
    if (index && slot.starts_at < orderedSlots[index - 1].ends_at) throw new Error(`Час ${slot.number} пари перетинається з попередньою парою.`)
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const key = `${slot.number}:${weekday}`
      const upper = parseTimetableCell(grids.upper[key] || ''); const lower = parseTimetableCell(grids.lower[key] || '')
      if (((grids.upper[key] || '').trim() && !upper.subject) || ((grids.lower[key] || '').trim() && !lower.subject)) throw new Error(`Впишіть назву предмета: ${DAYS[weekday - 1]}, ${slot.number} пара.`)
      for (const cell of [upper, lower]) {
        if (cell.subject.length > 120) throw new Error(`Скоротіть назву предмета: ${DAYS[weekday - 1]}, ${slot.number} пара (до 120 символів).`)
        if (/[\u0000-\u001f\u007f]/.test(cell.subject)) throw new Error(`Приберіть службові символи з назви предмета: ${DAYS[weekday - 1]}, ${slot.number} пара.`)
      }
      const metadataFor = (pattern: AlternatingWeek, subject: string) => {
        const value = details[pattern][key] || emptyCellDetails()
        if (value.needs_review) throw new Error(`Перевірте позначене заняття: ${WEEK_NAMES[pattern]} тиждень, ${DAYS[weekday - 1]}, ${slot.number} пара. Заповніть назву й позначте «Перевірено» або виключіть клітинку.`)
        if (!subject && [value.location, value.online_url, value.online_url_secondary].some((item) => item.trim())) throw new Error(`Додайте назву предмета або виключіть клітинку: ${WEEK_NAMES[pattern]} тиждень, ${DAYS[weekday - 1]}, ${slot.number} пара.`)
        if (value.location.length > 160 || /[\u0000-\u001f\u007f]/.test(value.location)) throw new Error(`Перевірте аудиторію: ${DAYS[weekday - 1]}, ${slot.number} пара (до 160 символів).`)
        const url = (item: string) => {
          if (!item.trim()) return null
          const safe = safeLessonUrl(item.trim())
          if (!safe || safe.length > 2000) throw new Error(`Вкажіть коректне посилання http:// або https://: ${DAYS[weekday - 1]}, ${slot.number} пара.`)
          return safe
        }
        return { location: value.location.trim(), online_url: url(value.online_url), online_url_secondary: url(value.online_url_secondary) }
      }
      const upperDetails = metadataFor('upper', upper.subject); const lowerDetails = metadataFor('lower', lower.subject)
      const base = { weekday, starts_at: slot.starts_at, ends_at: slot.ends_at, lesson_number: slot.number, valid_from: validFrom, valid_until: validUntil, week_anchor_date: anchor }
      const sameDetails = upperDetails.location === lowerDetails.location && upperDetails.online_url === lowerDetails.online_url && upperDetails.online_url_secondary === lowerDetails.online_url_secondary
      if (upper.subject && upper.subject === lower.subject && upper.lesson_type === lower.lesson_type && sameDetails) lessons.push({ ...base, ...upper, ...upperDetails, week_pattern: 'every', week_anchor_date: null })
      else {
        if (upper.subject) lessons.push({ ...base, ...upper, ...upperDetails, week_pattern: 'upper' })
        if (lower.subject) lessons.push({ ...base, ...lower, ...lowerDetails, week_pattern: 'lower' })
      }
    }
  }
  if (!lessons.length) throw new Error('Впишіть хоча б одне заняття. Порожні клітинки залишаться вільними парами.')
  if (lessons.length > 168) throw new Error('За один раз можна додати не більше 168 занять.')
  return lessons
}

function exampleGrids(): WeekGrids {
  const upper: WeekGrid = {
    '1:1': 'Історія економіки (лекція)', '2:1': 'Вища математика (лекція)', '3:1': 'Менеджмент (семінар)', '4:1': 'Основи зеленої економіки (семінар)',
    '1:2': 'Основи нац. спротиву (лекція)', '2:2': 'Вступ до ун. ст. (лекція)', '3:2': 'Іноземна мова (семінар)', '4:2': 'Основи нац. спротиву (семінар)',
    '2:3': 'Економічна теорія (лекція)', '3:3': 'Історія економіки (семінар)',
    '1:4': 'Вища математика (семінар)', '2:4': 'Економічна теорія (семінар)',
    '3:5': 'Тайм-менеджмент (лекція)', '4:5': 'Менеджмент (лекція)', '5:5': 'Основи зеленої економіки (лекція)',
  }
  return { upper, lower: { ...upper, '4:3': 'Тайм-менеджмент (семінар)' } }
}

function DraftWeek({ pattern, slots, grid, details = {}, onChange, onDetailsChange, onExclude, weekdays = [1, 2, 3, 4, 5, 6, 7], readonly = false }: {
  pattern: AlternatingWeek
  slots: TimetableSlot[]
  grid: WeekGrid
  details?: WeekDetails
  onChange?: (key: string, value: string) => void
  onDetailsChange?: (key: string, value: CellDetails) => void
  onExclude?: (key: string) => void
  weekdays?: number[]
  readonly?: boolean
}) {
  const [mobileDay, setMobileDay] = useState(1)
  const cell = (slot: TimetableSlot, day: number) => {
    const key = `${slot.number}:${day}`; const value = grid[key] || ''
    const metadata = details[key] || emptyCellDetails()
    const parsed = parseTimetableCell(value)
    if (readonly) {
      return parsed.subject ? <div className="rounded-lg bg-primary/5 p-2"><p className="break-words text-sm font-medium">{parsed.subject}</p><p className="mt-1 text-xs text-muted-foreground">{TYPES[parsed.lesson_type]}</p>{metadata.location && <p className="mt-1 break-words text-xs text-muted-foreground">{metadata.location}</p>}{[metadata.online_url, metadata.online_url_secondary].filter(Boolean).map((url, index) => <p key={`${url}:${index}`} className="mt-1 break-all text-xs text-primary">{url}</p>)}</div> : <span className="block p-2 text-xs text-muted-foreground">Вільна пара</span>
    }
    return <div className={`min-w-0 space-y-1.5 rounded-lg ${metadata.needs_review ? 'bg-amber-50 p-1.5 dark:bg-amber-950/20' : ''}`}>
      <textarea rows={3} maxLength={230} value={value} onChange={(event) => onChange?.(key, event.target.value)} aria-label={`${WEEK_NAMES[pattern]} тиждень, ${DAYS[day - 1]}, ${slot.number} пара`} placeholder="Предмет (тип)" className={`w-full min-w-0 resize-y rounded-lg border bg-background p-2 text-base leading-snug outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 sm:text-sm ${metadata.needs_review ? 'border-amber-400' : 'border-border'}`} />
      {metadata.needs_review && <div className="space-y-2 px-1 pb-1 text-xs"><p className="flex items-start gap-1.5 text-amber-800 dark:text-amber-200"><TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" /><span>{metadata.review_note || 'Перевірте предмет і тип за фото.'}</span></p><button type="button" className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-amber-300 bg-background px-2 font-medium disabled:opacity-50" disabled={!parsed.subject} onClick={() => onDetailsChange?.(key, { ...metadata, needs_review: false, review_note: '' })}><Check size={13} aria-hidden="true" />Перевірено</button>{!parsed.subject && <p className="text-amber-800 dark:text-amber-200">Впишіть назву або виключіть цю клітинку.</p>}<button type="button" onClick={() => onExclude?.(key)} className="block min-h-8 text-muted-foreground underline underline-offset-2 hover:text-foreground">Виключити з імпорту</button></div>}
      {onDetailsChange && <details className="min-w-0 text-xs"><summary className="cursor-pointer break-words py-1 text-muted-foreground hover:text-primary">{metadata.location || metadata.online_url || metadata.online_url_secondary ? 'Аудиторія / посилання · є' : 'Аудиторія / посилання'}</summary><div className="space-y-2 pt-2"><label className="block">Аудиторія<input type="text" value={metadata.location} maxLength={160} onChange={(event) => onDetailsChange(key, { ...metadata, location: event.target.value })} className={`${inputClass} mt-1 !px-2 !py-2`} /></label><label className="block">Посилання<input type="url" value={metadata.online_url} maxLength={2000} onChange={(event) => onDetailsChange(key, { ...metadata, online_url: event.target.value })} placeholder="https://" className={`${inputClass} mt-1 !px-2 !py-2`} /></label><label className="block">Друге посилання<input type="url" value={metadata.online_url_secondary} maxLength={2000} onChange={(event) => onDetailsChange(key, { ...metadata, online_url_secondary: event.target.value })} placeholder="https://" className={`${inputClass} mt-1 !px-2 !py-2`} /></label>{!metadata.needs_review && (value || metadata.location || metadata.online_url || metadata.online_url_secondary) && <button type="button" onClick={() => onExclude?.(key)} className="min-h-8 text-muted-foreground underline underline-offset-2 hover:text-foreground">Очистити клітинку</button>}</div></details>}
    </div>
  }
  return <section className="min-w-0 rounded-xl border border-border p-3 sm:p-4"><h3 className="mb-3 font-semibold">{WEEK_NAMES[pattern]} тиждень</h3><div className="hidden overflow-x-auto md:block"><table className={`w-full table-fixed ${weekdays.length > 5 ? 'min-w-[58rem]' : ''}`}><caption className="sr-only">{WEEK_NAMES[pattern]} тиждень: {readonly ? 'попередній перегляд' : 'редагування'}</caption><thead><tr><th scope="col" className="w-20 p-1 text-left text-xs text-muted-foreground">Пара</th>{weekdays.map((day) => <th key={day} scope="col" className="p-1 text-left text-xs font-medium">{SHORT_DAYS[day - 1]}</th>)}</tr></thead><tbody>{slots.map((slot) => <tr key={slot.number}><th scope="row" className="p-1 pt-3 text-left align-top text-xs"><span className="block font-medium">{slot.number}</span><span className="mt-1 block font-normal text-muted-foreground">{slot.starts_at || 'Час?'}<br />{slot.ends_at || 'Час?'}</span></th>{weekdays.map((day) => <td key={day} className="p-1 align-top">{cell(slot, day)}</td>)}</tr>)}</tbody></table></div><div className="md:hidden"><label className="block text-sm font-medium">День тижня<select className={`${inputClass} mt-1.5`} value={mobileDay} onChange={(event) => setMobileDay(Number(event.target.value))}>{weekdays.map((day) => <option key={day} value={day}>{DAYS[day - 1]}</option>)}</select></label><div className="mt-3 space-y-3">{slots.map((slot) => <div key={slot.number}><p className="mb-1.5 text-xs font-medium">{slot.number} пара <span className="font-normal text-muted-foreground">· {slot.starts_at || 'час?'}–{slot.ends_at || 'час?'}</span></p>{cell(slot, mobileDay)}</div>)}</div></div></section>
}

function TimetableImporter({ groupId, onClose, onImported }: { groupId: string; onClose: () => void; onImported: () => Promise<void> | void }) {
  const [grids, setGrids] = useState<WeekGrids>({ upper: {}, lower: {} })
  const [cellDetails, setCellDetails] = useState<WeekDetailsGrids>({ upper: {}, lower: {} })
  const [slots, setSlots] = useState<TimetableSlot[]>(DEFAULT_TIMETABLE_SLOTS.map((slot) => ({ ...slot })))
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [anchor, setAnchor] = useState('')
  const [stage, setStage] = useState<'edit' | 'preview' | 'saved'>('edit')
  const [lessons, setLessons] = useState<TimetableLessonDraft[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const errorElement = useRef<HTMLParagraphElement>(null)
  const [pasteText, setPasteText] = useState('')
  const [pasteWeek, setPasteWeek] = useState<AlternatingWeek>('upper')
  const [pastePreview, setPastePreview] = useState<TimetablePaste | null>(null)
  useEffect(() => { if (error) errorElement.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  const updateCell = (pattern: AlternatingWeek, key: string, value: string) => setGrids((current) => ({ ...current, [pattern]: { ...current[pattern], [key]: value } }))
  const updateDetails = (pattern: AlternatingWeek, key: string, value: CellDetails) => setCellDetails((current) => ({ ...current, [pattern]: { ...current[pattern], [key]: value } }))
  const excludeCell = (pattern: AlternatingWeek, key: string) => {
    updateCell(pattern, key, '')
    setCellDetails((current) => { const next = { ...current[pattern] }; delete next[key]; return { ...current, [pattern]: next } })
  }
  const applyRecognition = (recognized: TimetableRecognitionResult) => {
    const targetWeeks: AlternatingWeek[] = recognized.week_mode === 'upper_only' ? ['upper'] : recognized.week_mode === 'lower_only' ? ['lower'] : ['upper', 'lower']
    const nextGrids: WeekGrids = { upper: { ...grids.upper }, lower: { ...grids.lower } }
    const nextDetails: WeekDetailsGrids = { upper: { ...cellDetails.upper }, lower: { ...cellDetails.lower } }
    for (const pattern of targetWeeks) { nextGrids[pattern] = {}; nextDetails[pattern] = {} }
    for (const lesson of recognized.lessons) {
      const patterns: AlternatingWeek[] = lesson.week_pattern === 'every' ? targetWeeks : targetWeeks.filter((pattern) => pattern === lesson.week_pattern)
      const key = `${lesson.lesson_number}:${lesson.weekday}`
      for (const pattern of patterns) {
        nextGrids[pattern][key] = lesson.subject ? `${lesson.subject} (${TYPES[lesson.lesson_type].toLocaleLowerCase('uk-UA')})` : ''
        nextDetails[pattern][key] = { location: lesson.location, online_url: lesson.online_url || '', online_url_secondary: lesson.online_url_secondary || '', needs_review: lesson.needs_review || !lesson.subject, review_note: lesson.review_note }
      }
    }
    const recognizedSlots = new Map(recognized.slots.map((slot) => [slot.number, slot]))
    const retainedWeeks = (['upper', 'lower'] as const).filter((pattern) => !targetWeeks.includes(pattern))
    const retainedNumbers = retainedWeeks.flatMap((pattern) => [...new Set([...Object.keys(nextGrids[pattern]), ...Object.keys(nextDetails[pattern])])].filter((key) => {
      const details = nextDetails[pattern][key]
      return Boolean(nextGrids[pattern][key]?.trim()) || Boolean(details && (details.needs_review || details.location || details.online_url || details.online_url_secondary))
    }).map((key) => Number(key.split(':')[0])))
    for (const number of new Set(retainedNumbers)) {
      const incoming = recognizedSlots.get(number)
      if (!incoming) continue
      const existing = slots.find((slot) => slot.number === number)
      if (!existing || existing.starts_at !== incoming.starts_at || existing.ends_at !== incoming.ends_at) {
        throw new Error(`Час ${number} пари на фото відрізняється від іншого тижня у чернетці. Завершіть імпорт одного тижня, потім відкрийте новий імпорт для іншого, або спочатку узгодьте час пар у чернетці. Дані чернетки збережено.`)
      }
    }
    const numbers = [...new Set([...recognized.slots.map((slot) => slot.number), ...retainedNumbers])].sort((left, right) => left - right)
    const nextSlots = numbers.map((number) => {
      const recognizedSlot = recognizedSlots.get(number)
      if (recognizedSlot) return { ...recognizedSlot }
      const existing = retainedNumbers.includes(number) ? slots.find((slot) => slot.number === number) : null
      return existing ? { ...existing } : { number, starts_at: '', ends_at: '' }
    })
    setGrids(nextGrids); setCellDetails(nextDetails); setSlots(nextSlots); setPastePreview(null); setError('')
    setNotice('Фото перенесено в чернетку. Перевірте предмети, типи, час і позначені клітинки. Дати семестру та понеділок верхнього тижня вкажіть нижче.')
  }
  const preview = () => {
    setError(''); setNotice('')
    try { setLessons(buildLessons(grids, slots, validFrom, validUntil, anchor, cellDetails)); setStage('preview') } catch (problem) { setError(problem instanceof Error ? problem.message : 'Перевірте таблицю.'); }
  }
  const preparePaste = () => {
    setError(''); setPastePreview(null)
    try {
      const parsed = parseTimetableTsv(pasteText)
      if (!parsed.times && parsed.cells.length > Math.max(0, ...slots.map((slot) => slot.number))) throw new Error('Додайте потрібну кількість пар або вставте стовпець часу перед днями.')
      setPastePreview(parsed)
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Не вдалося прочитати таблицю.') }
  }
  const applyPaste = () => {
    if (!pastePreview) return
    setSlots((current) => {
      const imported = pastePreview.cells.map((_, index) => {
        const number = index + 1
        const time = pastePreview.times?.[index]
        return time ? { number, ...time } : current.find((slot) => slot.number === number) || { number, starts_at: '', ends_at: '' }
      })
      const byNumber = new Map(current.map((slot) => [slot.number, slot]))
      imported.forEach((slot) => byNumber.set(slot.number, slot))
      return [...byNumber.values()].sort((left, right) => left.number - right.number)
    })
    const grid: WeekGrid = {}
    pastePreview.cells.forEach((row, index) => row.forEach((value, dayIndex) => { grid[`${index + 1}:${dayIndex + 1}`] = value }))
    setGrids((current) => ({ ...current, [pasteWeek]: grid })); setPastePreview(null); setPasteText('')
    setCellDetails((current) => ({ ...current, [pasteWeek]: {} }))
    setNotice(`Таблицю вставлено у ${WEEK_NAMES[pasteWeek].toLocaleLowerCase('uk-UA')} тиждень. Перевірте обидва тижні перед додаванням.`)
  }
  const confirmImport = async () => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await importStudyGroupTimetable(groupId, lessons)
      setStage('saved')
      try { await onImported() } catch { setNotice('Розклад додано, але список не вдалося оновити. Оновіть сторінку, щоб побачити заняття.') }
    } catch (problem) { setError(timetableImportError(problem)) }
    finally { saving.current = false; setBusy(false) }
  }
  const addSlot = () => {
    const occupied = new Set(slots.map((slot) => slot.number))
    const number = Array.from({ length: 12 }, (_, index) => index + 1).find((value) => !occupied.has(value))
    if (!number) return
    const maximum = Math.max(0, ...occupied)
    if (number < maximum) { setSlots((current) => [...current, { number, starts_at: '', ends_at: '' }].sort((left, right) => left.number - right.number)); return }
    const previous = slots[slots.length - 1]
    const [hour, minute] = previous.ends_at.split(':').map(Number)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) { setSlots((current) => [...current, { number, starts_at: '', ends_at: '' }]); return }
    const start = Math.min(hour * 60 + minute + 20, 23 * 60 - 20)
    const end = Math.min(start + 80, 23 * 60 + 59)
    const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    setSlots((current) => [...current, { number, starts_at: time(start), ends_at: time(end) }])
  }
  const removeLastSlot = () => {
    const number = slots[slots.length - 1].number
    setSlots((current) => current.slice(0, -1))
    const clean = <T,>(grid: Record<string, T>) => Object.fromEntries(Object.entries(grid).filter(([key]) => !key.startsWith(`${number}:`)))
    setGrids((current) => ({ upper: clean(current.upper), lower: clean(current.lower) }))
    setCellDetails((current) => ({ upper: clean(current.upper), lower: clean(current.lower) }))
  }
  const previewSlots = pastePreview?.cells.map((_, index) => {
    const number = index + 1
    const time = pastePreview.times?.[index]
    return time ? { number, ...time } : slots.find((slot) => slot.number === number) || { number, starts_at: '', ends_at: '' }
  }) || []
  const previewGrid: WeekGrid = {}
  pastePreview?.cells.forEach((row, index) => row.forEach((value, dayIndex) => { previewGrid[`${index + 1}:${dayIndex + 1}`] = value }))
  const pendingReview = Object.values(cellDetails).reduce((total, week) => total + Object.values(week).filter((cell) => cell.needs_review).length, 0)

  return <ImportDialog busy={busy} onClose={onClose} focusKey={stage}>
    {error && <p ref={errorElement} role="alert" className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="mb-4 rounded-xl border border-border bg-muted/40 p-3 text-sm">{notice}</p>}
    {stage === 'saved' ? <div className="mx-auto max-w-lg py-8 text-center"><Check className="mx-auto mb-4 text-primary" size={32} aria-hidden="true" /><h3 className="text-lg font-semibold">Розклад додано</h3><p className="mt-2 text-sm text-muted-foreground">Додано {lessons.length} записів занять до розкладу групи.</p><button type="button" disabled={busy} className={`${primaryButton} mt-6`} onClick={onClose}>Готово</button></div> : stage === 'preview' ? <div className="space-y-5">
      <div><h3 className="text-lg font-semibold">Перевірте розклад</h3><p className="mt-2 text-sm text-muted-foreground">{formatDate(validFrom, { day: 'numeric', month: 'long', year: 'numeric' })} — {formatDate(validUntil, { day: 'numeric', month: 'long', year: 'numeric' })}. Понеділок верхнього тижня: {formatDate(anchor, { day: 'numeric', month: 'long', year: 'numeric' })}.</p><p className="mt-2 text-sm">Буде додано <strong>{lessons.length}</strong> записів. {lessons.filter((lesson) => lesson.week_pattern === 'every').length} занять повторюватимуться щотижня. Порожні клітинки залишаться вільними.</p></div>
      <DraftWeek pattern="upper" slots={slots} grid={grids.upper} details={cellDetails.upper} readonly /><DraftWeek pattern="lower" slots={slots} grid={grids.lower} details={cellDetails.lower} readonly />
      <p className="text-sm text-muted-foreground">Заняття буде додано до наявного розкладу. Поточні записи зберігаються.</p>
      <div className="flex flex-wrap justify-end gap-3"><button type="button" disabled={busy} onClick={() => { setStage('edit'); setError('') }} className={secondaryButton}>Повернутися до редагування</button><button type="button" disabled={busy} onClick={() => void confirmImport()} className={primaryButton}>{busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy ? 'Додаємо…' : 'Підтвердити й додати'}</button></div>
    </div> : <div className="space-y-6">
      <div><p className="text-sm text-muted-foreground">Розпізнайте фото, вставте таблицю з Excel / Google Sheets або заповніть два тижні вручну. Предмет можна вказати як «Вища математика (лекція)». Без типу буде «Заняття».</p><button type="button" className={`${secondaryButton} mt-3`} onClick={() => { setGrids(exampleGrids()); setCellDetails({ upper: {}, lower: {} }); setSlots(DEFAULT_TIMETABLE_SLOTS.map((slot) => ({ ...slot }))); setNotice('Приклад ЕУБ-4 заповнено. Вкажіть дати семестру й понеділок верхнього тижня та перевірте назви.'); setPastePreview(null); setError('') }}><CalendarDays size={16} aria-hidden="true" />Приклад ЕУБ-4</button></div>
      <TimetablePhotoRecognition groupId={groupId} hasDraft={Object.values(grids).some((grid) => Object.values(grid).some((value) => Boolean(value.trim()))) || Object.values(cellDetails).some((grid) => Object.values(grid).some((value) => value.needs_review || value.location || value.online_url || value.online_url_secondary))} onApply={applyRecognition} />
      <div className="grid gap-4 sm:grid-cols-3"><label className="text-sm font-medium">Початок семестру<input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} className={`${inputClass} mt-1.5`} /></label><label className="text-sm font-medium">Завершення семестру<input type="date" min={validFrom || undefined} value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className={`${inputClass} mt-1.5`} /></label><label className="text-sm font-medium">Понеділок верхнього тижня<input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} className={`${inputClass} mt-1.5`} /><span className="mt-1.5 block text-xs font-normal text-muted-foreground">Оберіть дату за розкладом університету.</span></label></div>
      <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Вставити з Excel / Google Sheets</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">Скопіюйте п’ять стовпців Пн–Пт. Першим можна додати час у форматі 08:00–09:20. Заголовок із назвами днів необов’язковий. Порожні клітинки означають вільні пари.</p><label className="block text-sm font-medium">Тиждень<select className={`${inputClass} mt-1.5 max-w-xs`} value={pasteWeek} onChange={(event) => { setPasteWeek(event.target.value as AlternatingWeek); setPastePreview(null) }}><option value="upper">Верхній</option><option value="lower">Нижній</option></select></label><label className="block text-sm font-medium">Таблиця<textarea rows={5} value={pasteText} onChange={(event) => { setPasteText(event.target.value); setPastePreview(null) }} placeholder="Вставте скопійований діапазон тут" className={`${inputClass} mt-1.5 font-mono`} /></label><button type="button" className={secondaryButton} onClick={preparePaste}>Переглянути вставлене</button>{pastePreview && <div className="space-y-3"><DraftWeek pattern={pasteWeek} slots={previewSlots} grid={previewGrid} weekdays={[1, 2, 3, 4, 5]} readonly /><p className="text-xs text-muted-foreground">Вставлення заповнить клітинки вибраного тижня.{pastePreview.times && ' Час пар оновиться для обох тижнів.'}</p><button type="button" className={primaryButton} onClick={applyPaste}>Вставити у {WEEK_NAMES[pasteWeek].toLocaleLowerCase('uk-UA')} тиждень</button></div>}</div></details>
      <section className="rounded-xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Час пар</h3><div className="flex flex-wrap gap-2"><button type="button" disabled={slots.length <= 1} className={secondaryButton} onClick={removeLastSlot}>Прибрати останню</button><button type="button" disabled={slots.length >= 12} className={secondaryButton} onClick={addSlot}><Plus size={15} aria-hidden="true" />Додати пару</button></div></div><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{slots.map((slot, index) => <div key={slot.number} className="flex items-center gap-2"><span className="w-6 shrink-0 text-sm font-medium">{slot.number}.</span><label className="min-w-0 flex-1"><span className="sr-only">Початок {slot.number} пари</span><input type="time" value={slot.starts_at} onChange={(event) => setSlots((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, starts_at: event.target.value } : row))} className={inputClass} /></label><span aria-hidden="true" className="text-muted-foreground">–</span><label className="min-w-0 flex-1"><span className="sr-only">Завершення {slot.number} пари</span><input type="time" value={slot.ends_at} onChange={(event) => setSlots((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ends_at: event.target.value } : row))} className={inputClass} /></label></div>)}</div></section>
      {pendingReview > 0 && <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-100"><TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" /><span>Залишилося перевірити клітинок: {pendingReview}. У позначених клітинках виправте дані й натисніть «Перевірено» або «Виключити з імпорту».</span></p>}
      <DraftWeek pattern="upper" slots={slots} grid={grids.upper} details={cellDetails.upper} onChange={(key, value) => updateCell('upper', key, value)} onDetailsChange={(key, value) => updateDetails('upper', key, value)} onExclude={(key) => excludeCell('upper', key)} />
      <div className="flex justify-center"><button type="button" className={secondaryButton} onClick={() => { setGrids((current) => ({ ...current, lower: { ...current.upper } })); setCellDetails((current) => ({ ...current, lower: Object.fromEntries(Object.entries(current.upper).map(([key, value]) => [key, { ...value }])) })); setNotice('Верхній тиждень скопійовано в нижній. Внесіть відмінності перед переглядом.') }}><Copy size={15} aria-hidden="true" />Скопіювати верхній у нижній</button></div>
      <DraftWeek pattern="lower" slots={slots} grid={grids.lower} details={cellDetails.lower} onChange={(key, value) => updateCell('lower', key, value)} onDetailsChange={(key, value) => updateDetails('lower', key, value)} onExclude={(key) => excludeCell('lower', key)} />
      <p className="text-xs text-muted-foreground">Однакові заняття в обох тижнях об’єднаються в щотижневі записи. Наявний розклад зберігається.</p>
      <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-4"><button type="button" className={secondaryButton} onClick={onClose}>Скасувати</button><button type="button" className={primaryButton} onClick={preview}>Переглянути розклад<ChevronRight size={16} aria-hidden="true" /></button></div>
    </div>}
  </ImportDialog>
}
