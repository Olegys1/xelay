import type { LessonType, TimetableSlot, WeekPattern } from './studyGroupTimetable'

export const MAX_RECOGNITION_PHOTO_BYTES = 8 * 1024 * 1024
export const MAX_RECOGNITION_IMAGE_BYTES = 2 * 1024 * 1024
export const RECOGNITION_LESSON_TYPES: readonly LessonType[] = [
  'lecture', 'seminar', 'practical', 'lab', 'makeup', 'replacement',
  'module', 'final_assessment', 'test', 'other',
]
export type RecognizedTimetableLesson = {
  weekday: number
  lesson_number: number
  week_pattern: WeekPattern
  subject: string
  lesson_type: LessonType
  location: string
  online_url: string
  online_url_secondary: string
  needs_review: boolean
  review_note: string
}
export type TimetableRecognitionResult = {
  version: 1
  week_mode: 'alternating' | 'every' | 'upper_only' | 'lower_only'
  days: number[]
  slots: TimetableSlot[]
  lessons: RecognizedTimetableLesson[]
  warnings: string[]
}

const invalid = () => new Error('TIMETABLE_RECOGNITION_INVALID_RESULT')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number, empty = true): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw invalid()
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!empty && !normalized) throw invalid()
  return normalized
}
function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw invalid()
  return value
}
function time(value: unknown): string {
  const result = text(value, 5)
  if (result && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw invalid()
  return result
}
function link(value: unknown): string {
  const result = text(value, 2000)
  if (!result) return ''
  try {
    const url = new URL(result)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid()
    return result
  } catch { throw invalid() }
}

// Shared server/client validation. Never imports the browser Supabase client.
export function normalizeTimetableRecognition(value: unknown): TimetableRecognitionResult {
  const row = object(value)
  if (row.version !== 1 || typeof row.week_mode !== 'string' || !['alternating', 'every', 'upper_only', 'lower_only'].includes(row.week_mode)) throw invalid()
  const week_mode = row.week_mode as TimetableRecognitionResult['week_mode']
  if (!Array.isArray(row.days) || !row.days.length || row.days.length > 7) throw invalid()
  const days = row.days.map((day) => boundedInteger(day, 1, 7))
  if (new Set(days).size !== days.length) throw invalid()
  if (!Array.isArray(row.slots) || !row.slots.length || row.slots.length > 12) throw invalid()
  const slots = row.slots.map((value) => {
    const slot = object(value)
    const number = boundedInteger(slot.number, 1, 12)
    const starts_at = time(slot.starts_at)
    const ends_at = time(slot.ends_at)
    if (starts_at && ends_at && starts_at >= ends_at) throw invalid()
    return { number, starts_at, ends_at }
  }).sort((left, right) => left.number - right.number)
  if (new Set(slots.map((slot) => slot.number)).size !== slots.length) throw invalid()
  if (!Array.isArray(row.lessons) || !row.lessons.length || row.lessons.length > 168) throw invalid()
  const occupied = new Map<string, Set<string>>()
  const lessons = row.lessons.map((value): RecognizedTimetableLesson => {
    const lesson = object(value)
    const weekday = boundedInteger(lesson.weekday, 1, 7)
    const lesson_number = boundedInteger(lesson.lesson_number, 1, 12)
    const week_pattern = lesson.week_pattern as WeekPattern
    const lesson_type = lesson.lesson_type as LessonType
    if (!days.includes(weekday) || !slots.some((slot) => slot.number === lesson_number)
      || !['every', 'upper', 'lower'].includes(week_pattern) || !RECOGNITION_LESSON_TYPES.includes(lesson_type)
      || typeof lesson.needs_review !== 'boolean') throw invalid()
    if ((week_mode === 'every' && week_pattern !== 'every')
      || (week_mode === 'upper_only' && week_pattern !== 'upper')
      || (week_mode === 'lower_only' && week_pattern !== 'lower')) throw invalid()
    const key = `${weekday}:${lesson_number}`
    const patterns = occupied.get(key) || new Set<string>()
    if (patterns.has(week_pattern) || patterns.has('every') || (week_pattern === 'every' && patterns.size)) throw invalid()
    patterns.add(week_pattern); occupied.set(key, patterns)
    const subject = text(lesson.subject, 120)
    if (!subject && !lesson.needs_review) throw invalid()
    return {
      weekday, lesson_number, week_pattern, subject, lesson_type,
      location: text(lesson.location, 120), online_url: link(lesson.online_url),
      online_url_secondary: link(lesson.online_url_secondary),
      needs_review: lesson.needs_review, review_note: text(lesson.review_note, 240),
    }
  })
  if (!Array.isArray(row.warnings) || row.warnings.length > 12) throw invalid()
  const warnings = row.warnings.map((warning) => text(warning, 300, false))
  return { version: 1, week_mode, days: days.sort((left, right) => left - right), slots, lessons, warnings }
}
