import type { LessonType, TimetableSlot, WeekPattern } from './studyGroupTimetable'
import { TIMETABLE_RECOGNITION_MAX_SOURCES } from './timetableRecognitionSources'

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
  clarifications?: TimetableSourceClarification[]
}
export type TimetableSourceClarification = {
  source_index: number
  kind: 'group_columns' | 'week_rows' | 'source_identity' | 'readability'
  question: string
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

const VALIDATION_CODES = [
  'OBJECT', 'TEXT', 'INTEGER', 'TIME_FORMAT', 'URL', 'SOURCE_LEVEL', 'SOURCE_YEAR', 'SOURCE_GROUP', 'SOURCE_PROGRAM', 'SOURCE_SECTION',
  'SOURCE_ID', 'SOURCE_UNLABELLED', 'SOURCE_IDENTITY', 'ANALYSIS_SHAPE', 'ANALYSIS_DUPLICATE_ID', 'ANALYSIS_LAYOUT', 'ANALYSIS_DUPLICATE_SOURCE',
  'ANALYSIS_WARNING', 'ANALYSIS_TOKEN', 'SOURCE_STATUS', 'RESULT_SHAPE', 'DAYS', 'DUPLICATE_DAY', 'SLOTS', 'SLOT_NUMBER', 'SLOT_TIME',
  'SLOT_DURATION', 'DUPLICATE_SLOT', 'SLOT_TIME_ORDER', 'LESSONS', 'LESSON_DAY', 'LESSON_NUMBER', 'LESSON_GRID', 'LESSON_PATTERN', 'LESSON_TYPE',
  'LESSON_REVIEW_FLAG', 'WEEK_PATTERN', 'CELL_CONFLICT', 'SUBJECT', 'REVIEW_NOTE', 'DATE_NOTE', 'LOCATION', 'WARNINGS', 'WARNING', 'INVALID',
] as const
type ValidationCode = typeof VALIDATION_CODES[number]
class TimetableRecognitionValidationError extends Error {
  constructor(readonly validationCode: ValidationCode) { super(`TIMETABLE_RECOGNITION_INVALID_RESULT:${validationCode}`) }
}
const invalid = (code: ValidationCode = 'INVALID') => new TimetableRecognitionValidationError(code)
// Only predefined codes may be exposed to logs or the UI, never source values.
export function timetableRecognitionValidationCode(error: unknown): ValidationCode {
  return error instanceof TimetableRecognitionValidationError && VALIDATION_CODES.includes(error.validationCode) ? error.validationCode : 'INVALID'
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('OBJECT')
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number, empty = true, code: ValidationCode = 'TEXT'): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw invalid(code)
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!empty && !normalized) throw invalid(code)
  return normalized
}
function boundedInteger(value: unknown, minimum: number, maximum: number, code: ValidationCode = 'INTEGER'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw invalid(code)
  return value
}
function time(value: unknown): string {
  const result = text(value, 5, true, 'SLOT_TIME')
  if (result && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(result)) throw invalid('TIME_FORMAT')
  return result ? result.padStart(5, '0') : ''
}
function link(value: unknown): string {
  const result = text(value, 2000, true, 'URL')
  if (!result) return ''
  try {
    const url = new URL(result)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('URL')
    return result
  } catch { throw invalid('URL') }
}

function sourceIdentity(value: unknown) {
  const row = object(value)
  if (row.study_level !== null && !['bachelor', 'master', 'postgraduate'].includes(row.study_level as string)) throw invalid('SOURCE_LEVEL')
  return {
    group_name: text(row.group_name, 100, true, 'SOURCE_GROUP'),
    study_year: row.study_year === null ? null : boundedInteger(row.study_year, 1, 6, 'SOURCE_YEAR'),
    study_level: row.study_level as TimetableSourceSelection['study_level'],
    program: text(row.program, 160, true, 'SOURCE_PROGRAM'),
    section_label: text(row.section_label, 200, true, 'SOURCE_SECTION'),
  }
}

export function normalizeTimetableSourceSelection(value: unknown): TimetableSourceSelection {
  const row = object(value)
  const id = text(row.id, 6, false, 'SOURCE_ID')
  if (!/^(?:single|c(?:[1-9]|[1-5]\d|6[0-4]))$/.test(id)) throw invalid('SOURCE_ID')
  const identity = sourceIdentity(row)
  if (id === 'single') {
    if (identity.group_name || identity.study_year !== null || identity.study_level !== null || identity.program || identity.section_label) throw invalid('SOURCE_UNLABELLED')
  } else if (!identity.group_name && !identity.section_label) throw invalid('SOURCE_IDENTITY')
  return { id, ...identity }
}

// The server normalizes the provider's unsigned analysis before issuing its token.
// Browser callers must use the default, which requires the issued token.
export function normalizeTimetableSourceClarifications(value: unknown): TimetableSourceClarification[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw invalid('ANALYSIS_SHAPE')
  return value.map((value): TimetableSourceClarification => {
    const question = object(value)
    if (!['group_columns', 'week_rows', 'source_identity', 'readability'].includes(question.kind as string)) throw invalid('ANALYSIS_SHAPE')
    return { source_index: boundedInteger(question.source_index, 1, TIMETABLE_RECOGNITION_MAX_SOURCES, 'ANALYSIS_SHAPE'),
      kind: question.kind as TimetableSourceClarification['kind'], question: text(question.question, 300, false, 'ANALYSIS_WARNING') }
  })
}

export function normalizeTimetableSourceAnalysis(value: unknown, requireToken = true): TimetableSourceAnalysis {
  const row = object(value)
  if (row.version !== 2 || row.kind !== 'source_analysis'
    || !['single', 'multiple', 'unreadable'].includes(row.layout as string)
    || !Array.isArray(row.candidates) || row.candidates.length > 64
    || !Array.isArray(row.warnings) || row.warnings.length > 12) throw invalid('ANALYSIS_SHAPE')
  const candidates = row.candidates.map(normalizeTimetableSourceSelection)
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw invalid('ANALYSIS_DUPLICATE_ID')
  if ((row.layout === 'single' && candidates.length !== 1)
    || (row.layout === 'multiple' && (candidates.length < 2 || candidates.some((candidate) => candidate.id === 'single')))
    || (row.layout === 'unreadable' && candidates.length !== 0)) throw invalid('ANALYSIS_LAYOUT')
  const fingerprints = candidates.map(({ id: _id, ...identity }) => JSON.stringify(identity))
  if (new Set(fingerprints).size !== fingerprints.length) throw invalid('ANALYSIS_DUPLICATE_SOURCE')
  const warnings = row.warnings.map((warning) => text(warning, 300, false, 'ANALYSIS_WARNING'))
  const clarifications = normalizeTimetableSourceClarifications(row.clarifications)
  if (clarifications.length && (row.layout !== 'unreadable' || candidates.length)) throw invalid('ANALYSIS_LAYOUT')
  if (row.layout === 'unreadable' && !warnings.length && !clarifications.length) throw invalid('ANALYSIS_WARNING')
  const analysis_token = requireToken ? text(row.analysis_token, 16384, false, 'ANALYSIS_TOKEN') : ''
  if (requireToken && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(analysis_token)) throw invalid('ANALYSIS_TOKEN')
  return { version: 2, kind: 'source_analysis', layout: row.layout as TimetableSourceAnalysis['layout'], candidates, warnings, analysis_token, clarifications }
}

function normalizeSourceMatch(value: unknown): TimetableSourceMatch {
  const row = object(value)
  if (!['matched', 'single_unlabelled', 'not_found', 'ambiguous'].includes(row.status as string)) throw invalid('SOURCE_STATUS')
  const identity = sourceIdentity(row)
  if (row.status === 'single_unlabelled' && (identity.group_name || identity.study_year !== null || identity.study_level !== null || identity.program || identity.section_label)) throw invalid('SOURCE_UNLABELLED')
  if (row.status === 'matched' && !identity.group_name && !identity.section_label) throw invalid('SOURCE_IDENTITY')
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

export type TimetableSourceMismatchField = 'status' | 'group_name' | 'study_year' | 'study_level' | 'program' | 'section_label'
// Diagnostic field names only. Never return either candidate's actual values.
export function timetableSourceMismatchFields(selection: TimetableSourceSelection, match: TimetableSourceMatch): TimetableSourceMismatchField[] {
  if (selection.id === 'single') return match.status === 'single_unlabelled' ? [] : ['status']
  const fields: TimetableSourceMismatchField[] = []
  if (match.status !== 'matched') fields.push('status')
  if (comparableSourceText(selection.group_name) !== comparableSourceText(match.group_name)) fields.push('group_name')
  if (selection.study_year !== match.study_year) fields.push('study_year')
  if (selection.study_level !== match.study_level) fields.push('study_level')
  if (comparableSourceText(selection.program) !== comparableSourceText(match.program)) fields.push('program')
  if (comparableSourceText(selection.section_label) !== comparableSourceText(match.section_label)) fields.push('section_label')
  return fields
}

function findFullNumericDate(value: string): string | null {
  const pattern = /(?:^|[^\d])(?:(\d{2})\.(\d{2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2}))(?!\d)/g
  for (const match of value.matchAll(pattern)) {
    const year = Number(match[3] || match[4])
    const month = Number(match[2] || match[5])
    const day = Number(match[1] || match[6])
    if (year < 1000 || month < 1 || month > 12 || day < 1) continue
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const monthLength = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    if (day <= monthLength) return match[3] ? `${match[1]}.${match[2]}.${match[3]}` : `${match[4]}-${match[5]}-${match[6]}`
  }
  return null
}

// Call only after the server has verified the signed selection and source match.
// A header date is evidence to review, never an automatically assigned period.
export function applyTimetableSourceDateGuard(result: TimetableRecognitionResult, selection: TimetableSourceSelection): TimetableRecognitionResult {
  const source = [selection.section_label, selection.program, selection.group_name]
    .map((text) => ({ text, date: findFullNumericDate(text) })).find((value) => value.date)
  if (!source || !result.lessons.some((lesson) => !lesson.date_note)) return result
  const fullNote = `У підписі обраного розкладу є дата. Перевірте її значення на фото: ${source.text}`
  // Never truncate away the detected date, even if identity limits grow later.
  const date_note = fullNote.length <= 300 ? fullNote
    : `У підписі обраного розкладу є дата ${source.date}. Перевірте її значення на фото.`
  const warning = 'У підписі обраного блоку є дата. Для занять без власної примітки додано нагадування перевірити період за оригіналом.'
  return normalizeTimetableRecognition({
    ...result,
    lessons: result.lessons.map((lesson) => lesson.date_note ? lesson : { ...lesson, date_note, needs_review: true }),
    warnings: result.warnings.includes(warning) ? result.warnings : [...result.warnings.slice(0, 11), warning],
  })
}

// Shared server/client validation. Never imports the browser Supabase client.
export function normalizeTimetableRecognition(value: unknown): TimetableRecognitionResult {
  const row = object(value)
  if (row.version !== 1 || typeof row.week_mode !== 'string' || !['alternating', 'every', 'upper_only', 'lower_only'].includes(row.week_mode)) throw invalid('RESULT_SHAPE')
  const week_mode = row.week_mode as TimetableRecognitionResult['week_mode']
  const source_match = normalizeSourceMatch(row.source_match)
  if (!['matched', 'single_unlabelled'].includes(source_match.status)) throw invalid('SOURCE_STATUS')
  if (!Array.isArray(row.days) || !row.days.length || row.days.length > 7) throw invalid('DAYS')
  const days = row.days.map((day) => boundedInteger(day, 1, 7, 'DAYS'))
  if (new Set(days).size !== days.length) throw invalid('DUPLICATE_DAY')
  if (!Array.isArray(row.slots) || !row.slots.length || row.slots.length > 12) throw invalid('SLOTS')
  const slots = row.slots.map((value) => {
    const slot = object(value)
    const number = boundedInteger(slot.number, 1, 12, 'SLOT_NUMBER')
    const starts_at = time(slot.starts_at)
    const ends_at = time(slot.ends_at)
    if (starts_at && ends_at && starts_at >= ends_at) throw invalid('SLOT_DURATION')
    return { number, starts_at, ends_at }
  }).sort((left, right) => left.number - right.number)
  if (new Set(slots.map((slot) => slot.number)).size !== slots.length) throw invalid('DUPLICATE_SLOT')
  // The timetable has one shared clock per pair. Overlapping or reversed rows
  // usually indicate a merged neighbouring group/shift and must not be imported.
  let previousEnd = ''
  let previousStart = ''
  for (const slot of slots) {
    if ((slot.starts_at && previousEnd && slot.starts_at < previousEnd)
      || (slot.starts_at && previousStart && slot.starts_at <= previousStart)
      || (slot.ends_at && previousEnd && slot.ends_at <= previousEnd)
      || (slot.ends_at && previousStart && slot.ends_at <= previousStart)) throw invalid('SLOT_TIME_ORDER')
    if (slot.ends_at) previousEnd = slot.ends_at
    if (slot.starts_at) previousStart = slot.starts_at
  }
  if (!Array.isArray(row.lessons) || !row.lessons.length || row.lessons.length > 168) throw invalid('LESSONS')
  const occupied = new Map<string, Set<string>>()
  const lessons = row.lessons.map((value): RecognizedTimetableLesson => {
    const lesson = object(value)
    const weekday = boundedInteger(lesson.weekday, 1, 7, 'LESSON_DAY')
    const lesson_number = boundedInteger(lesson.lesson_number, 1, 12, 'LESSON_NUMBER')
    const week_pattern = lesson.week_pattern as WeekPattern
    const lesson_type = lesson.lesson_type as LessonType
    if (!days.includes(weekday) || !slots.some((slot) => slot.number === lesson_number)) throw invalid('LESSON_GRID')
    if (!['every', 'upper', 'lower'].includes(week_pattern)) throw invalid('LESSON_PATTERN')
    if (!RECOGNITION_LESSON_TYPES.includes(lesson_type)) throw invalid('LESSON_TYPE')
    if (typeof lesson.needs_review !== 'boolean') throw invalid('LESSON_REVIEW_FLAG')
    if ((week_mode === 'every' && week_pattern !== 'every')
      || (week_mode === 'upper_only' && week_pattern !== 'upper')
      || (week_mode === 'lower_only' && week_pattern !== 'lower')) throw invalid('WEEK_PATTERN')
    const key = `${weekday}:${lesson_number}`
    const patterns = occupied.get(key) || new Set<string>()
    if (patterns.has(week_pattern) || patterns.has('every') || (week_pattern === 'every' && patterns.size)) throw invalid('CELL_CONFLICT')
    patterns.add(week_pattern); occupied.set(key, patterns)
    const subject = text(lesson.subject, 120, true, 'SUBJECT')
    const slot = slots.find((slot) => slot.number === lesson_number)!
    const existingNote = text(lesson.review_note, 240, true, 'REVIEW_NOTE')
    const date_note = text(lesson.date_note, 300, true, 'DATE_NOTE')
    const missingTime = !slot.starts_at || !slot.ends_at
    const needs_review = lesson.needs_review || missingTime || !subject || lesson_type === 'other' || Boolean(existingNote) || Boolean(date_note)
    const standardNotes = [date_note ? 'Уточніть дати дії заняття за приміткою на фото.' : '', missingTime ? 'Перевірте час початку й завершення пари.' : '', !subject ? 'Прочитайте назву предмета на фото.' : '', lesson_type === 'other' ? 'Уточніть тип заняття.' : '']
      .filter((note) => Boolean(note) && !existingNote.includes(note))
    // The same value passes through this validator on both server and client.
    // Keep its existing note and only append standard hints not already present.
    const review_note = [existingNote, ...standardNotes].filter(Boolean).join(' ').slice(0, 240)
      || (needs_review ? 'Перевірте дані цієї пари на фото.' : '')
    return {
      weekday, lesson_number, week_pattern, subject, lesson_type,
      location: text(lesson.location, 120, true, 'LOCATION'), online_url: link(lesson.online_url),
      online_url_secondary: link(lesson.online_url_secondary),
      date_note,
      needs_review, review_note,
    }
  })
  if (!Array.isArray(row.warnings) || row.warnings.length > 12) throw invalid('WARNINGS')
  const warnings = row.warnings.map((warning) => text(warning, 300, false, 'WARNING'))
  return { version: 1, source_match, week_mode, days: days.sort((left, right) => left - right), slots, lessons, warnings }
}
