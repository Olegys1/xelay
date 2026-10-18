import type { LessonType, TimetableSlot, WeekPattern } from './studyGroupTimetable'

export const MAX_RECOGNITION_PHOTO_BYTES = 8 * 1024 * 1024
export const MAX_RECOGNITION_IMAGE_BYTES = 2 * 1024 * 1024
export const RECOGNITION_LESSON_TYPES: readonly LessonType[] = [
  'lecture', 'seminar', 'practical', 'lab', 'makeup', 'replacement',
  'module', 'final_assessment', 'test', 'other',
]
export type TimetableSourceSelection = {
  id: string
  group_name: string
  study_year: number | null
  study_level: 'bachelor' | 'master' | 'postgraduate' | null
  program: string
  section_label: string
}
export type TimetableSourceAnalysis = {
  version: 2
  kind: 'source_analysis'
  layout: 'single' | 'multiple' | 'unreadable'
  candidates: TimetableSourceSelection[]
  warnings: string[]
  analysis_token: string
}
export type TimetableSourceMatch = {
  status: 'matched' | 'single_unlabelled' | 'not_found' | 'ambiguous'
  group_name: string
  study_year: number | null
  study_level: 'bachelor' | 'master' | 'postgraduate' | null
  program: string
  section_label: string
}
export type RecognizedTimetableLesson = {
  weekday: number
  lesson_number: number
  week_pattern: WeekPattern
  subject: string
  lesson_type: LessonType
  location: string
  online_url: string
  online_url_secondary: string
  date_note: string
  needs_review: boolean
  review_note: string
}
export type TimetableRecognitionResult = {
  version: 1
  source_match: TimetableSourceMatch
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

function sourceIdentity(value: unknown) {
  const row = object(value)
  if (row.study_level !== null && !['bachelor', 'master', 'postgraduate'].includes(row.study_level as string)) throw invalid()
  return {
    group_name: text(row.group_name, 100),
    study_year: row.study_year === null ? null : boundedInteger(row.study_year, 1, 6),
    study_level: row.study_level as TimetableSourceSelection['study_level'],
    program: text(row.program, 160),
    section_label: text(row.section_label, 200),
  }
}

export function normalizeTimetableSourceSelection(value: unknown): TimetableSourceSelection {
  const row = object(value)
  const id = text(row.id, 6, false)
  if (!/^(?:single|c(?:[1-9]|[1-5]\d|6[0-4]))$/.test(id)) throw invalid()
  const identity = sourceIdentity(row)
  if (id === 'single') {
    if (identity.group_name || identity.study_year !== null || identity.study_level !== null || identity.program || identity.section_label) throw invalid()
  } else if (!identity.group_name && !identity.section_label) throw invalid()
  return { id, ...identity }
}

// The server normalizes the provider's unsigned analysis before issuing its token.
// Browser callers must use the default, which requires the issued token.
export function normalizeTimetableSourceAnalysis(value: unknown, requireToken = true): TimetableSourceAnalysis {
  const row = object(value)
  if (row.version !== 2 || row.kind !== 'source_analysis'
    || !['single', 'multiple', 'unreadable'].includes(row.layout as string)
    || !Array.isArray(row.candidates) || row.candidates.length > 64
    || !Array.isArray(row.warnings) || row.warnings.length > 12) throw invalid()
  const candidates = row.candidates.map(normalizeTimetableSourceSelection)
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw invalid()
  if ((row.layout === 'single' && candidates.length !== 1)
    || (row.layout === 'multiple' && (candidates.length < 2 || candidates.some((candidate) => candidate.id === 'single')))
    || (row.layout === 'unreadable' && candidates.length !== 0)) throw invalid()
  const fingerprints = candidates.map(({ id: _id, ...identity }) => JSON.stringify(identity))
  if (new Set(fingerprints).size !== fingerprints.length) throw invalid()
  const warnings = row.warnings.map((warning) => text(warning, 300, false))
  if (row.layout === 'unreadable' && !warnings.length) throw invalid()
  const analysis_token = requireToken ? text(row.analysis_token, 16384, false) : ''
  if (requireToken && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(analysis_token)) throw invalid()
  return { version: 2, kind: 'source_analysis', layout: row.layout as TimetableSourceAnalysis['layout'], candidates, warnings, analysis_token }
}

function normalizeSourceMatch(value: unknown): TimetableSourceMatch {
  const row = object(value)
  if (!['matched', 'single_unlabelled', 'not_found', 'ambiguous'].includes(row.status as string)) throw invalid()
  const identity = sourceIdentity(row)
  if (row.status === 'single_unlabelled' && (identity.group_name || identity.study_year !== null || identity.study_level !== null || identity.program || identity.section_label)) throw invalid()
  if (row.status === 'matched' && !identity.group_name && !identity.section_label) throw invalid()
  return { status: row.status as TimetableSourceMatch['status'], ...identity }
}

const comparableSourceText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, '')
export function timetableSourceMatchesSelection(selection: TimetableSourceSelection, match: TimetableSourceMatch): boolean {
  if (selection.id === 'single') return match.status === 'single_unlabelled'
  return match.status === 'matched' && selection.study_year === match.study_year
    && selection.study_level === match.study_level
    && comparableSourceText(selection.group_name) === comparableSourceText(match.group_name)
    && comparableSourceText(selection.program) === comparableSourceText(match.program)
    && comparableSourceText(selection.section_label) === comparableSourceText(match.section_label)
}

// Shared server/client validation. Never imports the browser Supabase client.
export function normalizeTimetableRecognition(value: unknown): TimetableRecognitionResult {
  const row = object(value)
  if (row.version !== 1 || typeof row.week_mode !== 'string' || !['alternating', 'every', 'upper_only', 'lower_only'].includes(row.week_mode)) throw invalid()
  const week_mode = row.week_mode as TimetableRecognitionResult['week_mode']
  const source_match = normalizeSourceMatch(row.source_match)
  if (!['matched', 'single_unlabelled'].includes(source_match.status)) throw invalid()
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
  // The timetable has one shared clock per pair. Overlapping or reversed rows
  // usually indicate a merged neighbouring group/shift and must not be imported.
  let previousEnd = ''
  let previousStart = ''
  for (const slot of slots) {
    if ((slot.starts_at && previousEnd && slot.starts_at < previousEnd)
      || (slot.starts_at && previousStart && slot.starts_at <= previousStart)
      || (slot.ends_at && previousEnd && slot.ends_at <= previousEnd)
      || (slot.ends_at && previousStart && slot.ends_at <= previousStart)) throw invalid()
    if (slot.ends_at) previousEnd = slot.ends_at
    if (slot.starts_at) previousStart = slot.starts_at
  }
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
    const slot = slots.find((slot) => slot.number === lesson_number)!
    const existingNote = text(lesson.review_note, 240)
    const date_note = text(lesson.date_note, 300)
    const missingTime = !slot.starts_at || !slot.ends_at
    const needs_review = lesson.needs_review || missingTime || !subject || lesson_type === 'other' || Boolean(existingNote) || Boolean(date_note)
    const review_note = [date_note ? 'Уточніть дати дії заняття за приміткою на фото.' : '', existingNote, missingTime ? 'Перевірте час початку й завершення пари.' : '', !subject ? 'Прочитайте назву предмета на фото.' : '', lesson_type === 'other' ? 'Уточніть тип заняття.' : '']
      .filter(Boolean).join(' ').slice(0, 240) || (needs_review ? 'Перевірте дані цієї пари на фото.' : '')
    return {
      weekday, lesson_number, week_pattern, subject, lesson_type,
      location: text(lesson.location, 120), online_url: link(lesson.online_url),
      online_url_secondary: link(lesson.online_url_secondary),
      date_note,
      needs_review, review_note,
    }
  })
  if (!Array.isArray(row.warnings) || row.warnings.length > 12) throw invalid()
  const warnings = row.warnings.map((warning) => text(warning, 300, false))
  return { version: 1, source_match, week_mode, days: days.sort((left, right) => left - right), slots, lessons, warnings }
}
