import { supabase } from './supabase'

export type WeekPattern = 'every' | 'upper' | 'lower'
export const LESSON_TYPES = {
  lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне', lab: 'Лабораторна',
  makeup: 'Відпрацювання', replacement: 'Заміна', module: 'Модуль',
  final_assessment: 'Підсумкова робота', test: 'Контрольна робота', other: 'Заняття',
} as const
export type LessonType = keyof typeof LESSON_TYPES
export type AcademicPeriod = 'custom' | 'semester1' | 'semester2' | 'year'

export function academicYearForDate(date: string): number {
  if (!isTimetableDate(date)) return new Date().getFullYear()
  const year = Number(date.slice(0, 4))
  return Number(date.slice(5, 7)) >= 9 ? year : year - 1
}

// Editable date shortcuts, not an institution's official academic calendar.
export function academicPeriodDates(period: Exclude<AcademicPeriod, 'custom'>, year: number): { valid_from: string; valid_until: string } {
  if (!Number.isInteger(year) || year < 1900 || year > 2199) throw new Error('Оберіть навчальний рік від 1900 до 2199.')
  const fromYear = String(year).padStart(4, '0')
  const nextYear = String(year + 1).padStart(4, '0')
  if (period === 'semester1') return { valid_from: `${fromYear}-09-01`, valid_until: `${nextYear}-01-31` }
  if (period === 'semester2') return { valid_from: `${nextYear}-02-01`, valid_until: `${nextYear}-06-30` }
  return { valid_from: `${fromYear}-09-01`, valid_until: `${nextYear}-08-31` }
}

export type TimetableLesson = {
  id: string
  group_id: string
  weekday: number
  starts_at: string
  ends_at: string
  subject: string
  lesson_type: LessonType
  location: string
  online_url: string | null
  online_url_secondary?: string | null
  valid_from: string
  valid_until: string
  created_by: string
  updated_at?: string
  week_pattern?: WeekPattern
  week_anchor_date?: string | null
  lesson_number?: number | null
}
export type TimetableLessonDraft = Omit<TimetableLesson, 'id' | 'group_id' | 'created_by' | 'updated_at'>
export type TimetableSlot = { number: number; starts_at: string; ends_at: string }

export const DEFAULT_TIMETABLE_SLOTS: TimetableSlot[] = [
  { number: 1, starts_at: '08:00', ends_at: '09:20' },
  { number: 2, starts_at: '09:40', ends_at: '11:00' },
  { number: 3, starts_at: '11:20', ends_at: '12:40' },
  { number: 4, starts_at: '12:50', ends_at: '14:10' },
  { number: 5, starts_at: '14:30', ends_at: '15:50' },
]

const DAY = 86_400_000

// UTC is used as a calendar arithmetic container, never as the time of a lesson.
// This avoids changing the week at a local DST transition or in another timezone.
function dateMilliseconds(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day] = match.map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.getTime()
}

export function isTimetableDate(value: string): boolean {
  return dateMilliseconds(value) !== null
}

export function addTimetableDays(value: string, days: number): string {
  const milliseconds = dateMilliseconds(value)
  if (milliseconds === null) return ''
  return new Date(milliseconds + days * DAY).toISOString().slice(0, 10)
}

export function mondayForDate(value: string): string {
  const milliseconds = dateMilliseconds(value)
  if (milliseconds === null) return ''
  const weekday = new Date(milliseconds).getUTCDay() || 7
  return addTimetableDays(value, 1 - weekday)
}

export function weekPatternOnDate(value: string, upperWeekMonday: string): 'upper' | 'lower' {
  const date = dateMilliseconds(mondayForDate(value))
  const anchor = dateMilliseconds(mondayForDate(upperWeekMonday))
  if (date === null || anchor === null) throw new Error('TIMETABLE_INVALID_DATE')
  const weekOffset = Math.floor((date - anchor) / (7 * DAY))
  return ((weekOffset % 2) + 2) % 2 === 0 ? 'upper' : 'lower'
}

export function scheduleOccursOnDate(item: TimetableLesson, date: string): boolean {
  const milliseconds = dateMilliseconds(date)
  const from = item.valid_from === '-infinity' ? -Infinity : dateMilliseconds(item.valid_from)
  const until = item.valid_until === 'infinity' ? Infinity : dateMilliseconds(item.valid_until)
  if (milliseconds === null || from === null || until === null || from > until) return false
  if ((new Date(milliseconds).getUTCDay() || 7) !== item.weekday || milliseconds < from || milliseconds > until) return false
  const pattern = item.week_pattern || 'every'
  if (pattern === 'every') return true
  if (!item.week_anchor_date || !isTimetableDate(item.week_anchor_date) || mondayForDate(item.week_anchor_date) !== item.week_anchor_date) return false
  return weekPatternOnDate(date, item.week_anchor_date) === pattern
}

export function timetableImportError(error: unknown): string {
  const item = error as { code?: string; message?: string } | null
  const message = item?.message || ''
  if (message.includes('AUTH_REQUIRED')) return 'Увійдіть знову, щоб завантажити розклад.'
  if (message.includes('MEMBER_REQUIRED')) return 'Розклад доступний лише прийнятим учасникам групи.'
  if (message.includes('GROUP_LICENSE_REQUIRED')) return 'Не вдалося підтвердити безкоштовний доступ групи. Оновіть сторінку або зверніться до підтримки.'
  if (message.includes('TIMETABLE_COPY_SOURCE_EMPTY')) return 'На обрану дату немає пар для копіювання. Перевірте день, період і чергування тижнів.'
  if (message.includes('TIMETABLE_COPY_CONFLICT')) return 'На цю дату вже є інша пара в той самий час. Копіювання скасовано повністю; наявні пари збережені.'
  if (message.includes('TIMETABLE_COPY_SOURCE_CHANGED')) return 'Розклад джерела змінився. Оновіть попередній перегляд і повторіть копіювання.'
  if (message.includes('TIMETABLE_COPY_INVALID')) return 'Оберіть різні дати джерела й призначення. Дата призначення має бути суботою або неділею.'
  if (message.includes('PERMISSION_REQUIRED') || message.includes('REPRESENTATIVE_REQUIRED') || item?.code === '42501') return 'Завантажувати розклад може староста або заступник із правом керувати розкладом.'
  if (message.includes('TIMETABLE_TOO_MANY') || message.includes('TIMETABLE_LIMIT')) return 'За один раз можна додати не більше 168 занять.'
  if (message.includes('STUDY_GROUP_SCHEDULE_HAS_HOMEWORK')) return 'Для цієї пари вже є домашні завдання на дати, які не відповідають новому повторенню. Збережіть день, період і чергування тижнів, що охоплюють ці завдання.'
  if (message.includes('Homework date must match')) return 'Дата домашнього завдання має відповідати дню, періоду й верхньому або нижньому тижню цієї пари.'
  if (message.includes('INVALID') || item?.code === '23514' || item?.code === '22023') return 'Перевірте назви предметів, час, період семестру та понеділок верхнього тижня.'
  if (item?.code === 'PGRST202' || item?.code === '42883' || message.includes('Could not find the function')) return 'Завантаження розкладу ще не налаштовано. Зверніться до адміністратора.'
  if (message.includes('TIMETABLE_DUPLICATE_LESSON') || item?.code === '23505') return 'Таке заняття вже існує в цьому періоді. Перевірте поточний розклад перед повторним додаванням.'
  return 'Не вдалося завантажити розклад. Перевірте з’єднання та спробуйте ще раз.'
}

export async function importStudyGroupTimetable(groupId: string, lessons: TimetableLessonDraft[]): Promise<void> {
  if (!lessons.length || lessons.length > 168) throw new Error('TIMETABLE_INVALID_INPUT')
  const { error } = await supabase.rpc('xelay_import_study_group_timetable', { p_group_id: groupId, p_lessons: lessons })
  if (error) throw error
}

export type ScheduleCopyPreview = { copied: number; skipped: number; source_signature: string; lessons: TimetableLesson[] }
export async function copyStudyGroupScheduleDay(groupId: string, sourceDate: string, targetDate: string, preview: boolean, signature: string | null = null): Promise<ScheduleCopyPreview> {
  const { data, error } = await supabase.rpc('xelay_copy_study_group_schedule_day', {
    p_group_id: groupId, p_source_date: sourceDate, p_target_date: targetDate,
    p_preview: preview, p_expected_signature: signature,
  })
  if (error) throw error
  if (!data || typeof data !== 'object' || !Number.isInteger(data.copied) || data.copied < 0
    || !Number.isInteger(data.skipped) || data.skipped < 0 || typeof data.source_signature !== 'string'
    || !Array.isArray(data.lessons)) throw new Error('TIMETABLE_COPY_RESPONSE_UNKNOWN')
  return data as ScheduleCopyPreview
}

export function parseTimetableCell(value: string): Pick<TimetableLessonDraft, 'subject' | 'lesson_type'> {
  const text = value.trim().replace(/\s+/g, ' ')
  const match = /\s*\((лекція|лекц\.?|семінар|сем\.?|практичне|практична|практ\.?|лабораторна|лабораторне|лаб\.?|відпрацювання|заміна|модуль|підсумкова робота|контрольна робота|заняття|інше)\)\s*$/iu.exec(text)
  if (!match) return { subject: text, lesson_type: 'other' }
  const label = match[1].toLocaleLowerCase('uk-UA')
  const lesson_type: TimetableLesson['lesson_type'] = label.startsWith('лек') ? 'lecture'
    : label.startsWith('сем') ? 'seminar' : label.startsWith('практ') ? 'practical' : label.startsWith('лаб') ? 'lab'
    : label === 'відпрацювання' ? 'makeup' : label === 'заміна' ? 'replacement' : label === 'модуль' ? 'module'
    : label === 'підсумкова робота' ? 'final_assessment' : label === 'контрольна робота' ? 'test' : 'other'
  return { subject: text.slice(0, match.index).trim(), lesson_type }
}

export type TimetablePaste = { cells: string[][]; times: { starts_at: string; ends_at: string }[] | null }

// Clipboard TSV from Excel/Sheets may quote cells containing tabs or newlines.
function readTsv(value: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false
  const input = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === '"' && (quoted || cell === '')) {
      if (quoted && input[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (!quoted && (character === '\t' || character === '\n')) {
      row.push(cell); cell = ''
      if (character === '\n') { rows.push(row); row = [] }
    } else cell += character
  }
  if (quoted) throw new Error('Незакриті лапки в таблиці. Скопіюйте прямокутний діапазон ще раз.')
  if (cell || row.length) { row.push(cell); rows.push(row) }
  while (rows.length && rows[rows.length - 1].every((value) => !value.trim())) rows.pop()
  return rows
}

export function parseTimetableTsv(value: string): TimetablePaste {
  const rows = readTsv(value)
  if (!rows.length) throw new Error('Спочатку вставте таблицю з п’ятьма стовпцями днів.')
  const headerOffset = rows[0].length === 6 ? 1 : 0
  const weekdayHeaders = [/^(пн|понеділок|monday)$/iu, /^(вт|вівторок|tuesday)$/iu, /^(ср|середа|wednesday)$/iu, /^(чт|четвер|thursday)$/iu, /^(пт|п[’']?ятниця|friday)$/iu]
  if (weekdayHeaders.every((pattern, index) => pattern.test((rows[0][index + headerOffset] || '').trim()))) rows.shift()
  if (!rows.length || rows.length > 12) throw new Error('Таблиця має містити від 1 до 12 рядків пар.')
  const columns = rows[0].length
  if (![5, 6].includes(columns) || rows.some((row) => row.length !== columns)) throw new Error('Потрібно п’ять стовпців: Пн–Пт. Перед ними можна додати один стовпець часу.')
  const times = columns === 6 ? rows.map((row) => {
    const match = /^(?:\d{1,2}[.)]?\s+)?(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})$/.exec(row[0].trim())
    if (!match) throw new Error('Час у першому стовпці має вигляд 08:00–09:20.')
    const starts_at = `${match[1].padStart(2, '0')}:${match[2]}`
    const ends_at = `${match[3].padStart(2, '0')}:${match[4]}`
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(starts_at) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(ends_at) || starts_at >= ends_at) throw new Error('Перевірте початок і завершення кожної пари у таблиці.')
    return { starts_at, ends_at }
  }) : null
  return { cells: rows.map((row) => row.slice(columns === 6 ? 1 : 0).map((cell) => cell.trim())), times }
}
