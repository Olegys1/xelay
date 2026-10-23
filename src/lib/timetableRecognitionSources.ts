// Browser/server contract only. No files, Supabase, credentials or provider calls.
export const TIMETABLE_RECOGNITION_MAX_SOURCES = 10
export const TIMETABLE_RECOGNITION_MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const TIMETABLE_RECOGNITION_MAX_TOTAL_IMAGE_BYTES = 3 * 1024 * 1024
export const TIMETABLE_RECOGNITION_MAX_BODY_BYTES = 4.25 * 1024 * 1024
export const TIMETABLE_RECOGNITION_MAX_TABLE_CHARACTERS = 180000
export const TIMETABLE_RECOGNITION_MAX_SOURCE_NAME_LENGTH = 160
export const TIMETABLE_RECOGNITION_WEEK_HINTS = ['auto', 'upper', 'lower', 'every'] as const
export type TimetableRecognitionWeekHint = typeof TIMETABLE_RECOGNITION_WEEK_HINTS[number]
export type TimetableRecognitionLayoutHint = {
  group_columns: 'auto' | 'shared' | 'split'
  group_column_count: number | null
  group_column_index: number | null
  week_rows: 'auto' | 'upper_lower' | 'lower_upper' | 'none'
  notes: string
}
export const emptyTimetableRecognitionLayoutHint = (): TimetableRecognitionLayoutHint => ({
  group_columns: 'auto', group_column_count: null, group_column_index: null, week_rows: 'auto', notes: '',
})

export type TimetableRecognitionSource = {
  kind: 'image'
  name: string
  image_data_url: string
  week_hint: TimetableRecognitionWeekHint
  layout_hint?: TimetableRecognitionLayoutHint
} | {
  kind: 'spreadsheet'
  name: string
  table_text: string
  layout_hint?: TimetableRecognitionLayoutHint
}

export type TimetableRecognitionTarget = {
  group_name: string
  study_year: number | null
  study_level: 'bachelor' | 'master' | 'postgraduate' | null
  program: string
}
export type TimetableRecognitionPackage = {
  sources: TimetableRecognitionSource[]
  target: TimetableRecognitionTarget
}

const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const SOURCE_KEYS = {
  image: ['kind', 'name', 'image_data_url', 'week_hint'],
  spreadsheet: ['kind', 'name', 'table_text'],
} as const

export class TimetableRecognitionSourcesError extends Error {
  constructor(readonly status: 400 | 413, message: string) { super(message) }
}
function invalid(message = 'Перевірте файли та параметри розпізнавання.'): never {
  throw new TimetableRecognitionSourcesError(400, message)
}
function tooLarge(message: string): never { throw new TimetableRecognitionSourcesError(413, message) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) invalid()
}
function label(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || CONTROLS.test(value)) invalid()
  const result = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (result.length > maximum) invalid()
  if (required && !result) invalid('Додайте назву джерела розкладу.')
  return result
}

/** User explanations are bounded source data, never instructions for the model. */
export function normalizeTimetableRecognitionLayoutHint(value: unknown): TimetableRecognitionLayoutHint {
  if (value === undefined) return emptyTimetableRecognitionLayoutHint()
  const row = record(value)
  exactKeys(row, ['group_columns', 'group_column_count', 'group_column_index', 'week_rows', 'notes'])
  if (!['auto', 'shared', 'split'].includes(row.group_columns as string)
    || !['auto', 'upper_lower', 'lower_upper', 'none'].includes(row.week_rows as string)) invalid('Уточніть поділ таблиці на групи й тижні.')
  if (row.group_columns === 'split') {
    if (!Number.isInteger(row.group_column_count) || Number(row.group_column_count) < 2 || Number(row.group_column_count) > 6
      || !Number.isInteger(row.group_column_index) || Number(row.group_column_index) < 1 || Number(row.group_column_index) > Number(row.group_column_count)) {
      invalid('Укажіть кількість груп у стовпцях і номер своєї групи зліва направо.')
    }
  } else if (row.group_column_count !== null || row.group_column_index !== null) invalid('Номер стовпця потрібен лише для кількох груп поруч.')
  return { group_columns: row.group_columns as TimetableRecognitionLayoutHint['group_columns'],
    group_column_count: row.group_column_count as number | null, group_column_index: row.group_column_index as number | null,
    week_rows: row.week_rows as TimetableRecognitionLayoutHint['week_rows'], notes: label(row.notes, 400) }
}

/** Count canonical base64 bytes and verify the supported image signature without Node APIs. */
export function timetableRecognitionImageByteLength(value: unknown): number {
  if (typeof value !== 'string') return invalid('Оберіть зображення JPG, PNG або WebP.')
  if (value.length > Math.ceil(TIMETABLE_RECOGNITION_MAX_IMAGE_BYTES / 3) * 4 + 32) {
    return tooLarge('Одне зображення має бути не більше 2 МБ.')
  }
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length % 4 !== 0) return invalid('Не вдалося прочитати зображення. Оберіть JPG, PNG або WebP.')
  const data = match[2]
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  // Canonical encoding has zero unused tail bits. This also prevents alternative
  // base64 spellings of one image from bypassing package identity checks.
  if ((padding === 2 && (BASE64.indexOf(data[data.length - 3]) & 15) !== 0)
    || (padding === 1 && (BASE64.indexOf(data[data.length - 2]) & 3) !== 0)) return invalid('Зображення має некоректне кодування.')
  const bytes = data.length / 4 * 3 - padding
  if (bytes > TIMETABLE_RECOGNITION_MAX_IMAGE_BYTES) return tooLarge('Одне зображення має бути не більше 2 МБ.')
  if (bytes < 12) return invalid('Зображення пошкоджене або має інший формат.')
  const byteAt = (index: number) => {
    const offset = Math.floor(index / 3) * 4
    const a = BASE64.indexOf(data[offset])
    const b = BASE64.indexOf(data[offset + 1])
    const c = BASE64.indexOf(data[offset + 2])
    const d = BASE64.indexOf(data[offset + 3])
    return index % 3 === 0 ? (a << 2) | (b >> 4) : index % 3 === 1 ? ((b & 15) << 4) | (c >> 2) : ((c & 3) << 6) | d
  }
  const magic = match[1] === 'jpeg' ? [0xff, 0xd8, 0xff].every((byte, index) => byteAt(index) === byte)
    : match[1] === 'png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => byteAt(index) === byte)
      : [0x52, 0x49, 0x46, 0x46].every((byte, index) => byteAt(index) === byte)
        && [0x57, 0x45, 0x42, 0x50].every((byte, index) => byteAt(index + 8) === byte)
  if (!magic) return invalid('Зображення пошкоджене або має інший формат.')
  return bytes
}

export function normalizeTimetableRecognitionSources(value: unknown): TimetableRecognitionSource[] {
  if (!Array.isArray(value) || !value.length) return invalid('Додайте хоча б одне зображення або таблицю розкладу.')
  if (value.length > TIMETABLE_RECOGNITION_MAX_SOURCES) return tooLarge(`Можна додати не більше ${TIMETABLE_RECOGNITION_MAX_SOURCES} джерел розкладу.`)
  let imageBytes = 0
  let tableCharacters = 0
  return value.map((item): TimetableRecognitionSource => {
    const row = record(item)
    if (row.kind !== 'image' && row.kind !== 'spreadsheet') return invalid('Додайте зображення або таблицю розкладу.')
    exactKeys(row, row.layout_hint === undefined ? SOURCE_KEYS[row.kind] : [...SOURCE_KEYS[row.kind], 'layout_hint'])
    const name = label(row.name, TIMETABLE_RECOGNITION_MAX_SOURCE_NAME_LENGTH, true)
    const layout_hint = normalizeTimetableRecognitionLayoutHint(row.layout_hint)
    if (row.kind === 'image') {
      imageBytes += timetableRecognitionImageByteLength(row.image_data_url)
      if (imageBytes > TIMETABLE_RECOGNITION_MAX_TOTAL_IMAGE_BYTES) return tooLarge('Зображення разом мають бути не більше 3 МБ. Зменште їхній розмір або кількість.')
      if (!TIMETABLE_RECOGNITION_WEEK_HINTS.includes(row.week_hint as TimetableRecognitionWeekHint)) return invalid('Оберіть тиждень для зображення.')
      return { kind: 'image', name, image_data_url: row.image_data_url as string, week_hint: row.week_hint as TimetableRecognitionWeekHint, layout_hint }
    }
    if (typeof row.table_text !== 'string' || CONTROLS.test(row.table_text)) return invalid('Не вдалося прочитати текст таблиці.')
    tableCharacters += row.table_text.length
    if (tableCharacters > TIMETABLE_RECOGNITION_MAX_TABLE_CHARACTERS) return tooLarge('Таблиці разом завеликі. Залиште потрібний курс або групу: до 180 000 символів.')
    const table_text = row.table_text.replace(/\r\n?/g, '\n').trim()
    if (!table_text) return invalid('Таблиця порожня. Оберіть заповнений аркуш розкладу.')
    return { kind: 'spreadsheet', name, table_text, layout_hint }
  })
}

export function normalizeTimetableRecognitionTarget(value: unknown): TimetableRecognitionTarget {
  const row = record(value)
  exactKeys(row, ['group_name', 'study_year', 'study_level', 'program'])
  if (row.study_year !== null && (typeof row.study_year !== 'number' || !Number.isInteger(row.study_year) || row.study_year < 1 || row.study_year > 6)) {
    return invalid('Оберіть курс від 1 до 6 або залиште його невідомим.')
  }
  if (row.study_level !== null && !['bachelor', 'master', 'postgraduate'].includes(row.study_level as string)) return invalid('Перевірте рівень навчання.')
  return {
    group_name: label(row.group_name, 100), study_year: row.study_year as number | null,
    study_level: row.study_level as TimetableRecognitionTarget['study_level'], program: label(row.program, 160),
  }
}

/** Works for a package or the final POST body; the token/selection also take space. */
export function timetableRecognitionPackageByteLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (typeof serialized !== 'string') return invalid()
  return new TextEncoder().encode(serialized).byteLength
}

export function normalizeTimetableRecognitionPackage(sources: unknown, target: unknown): TimetableRecognitionPackage {
  const result = { sources: normalizeTimetableRecognitionSources(sources), target: normalizeTimetableRecognitionTarget(target) }
  if (timetableRecognitionPackageByteLength(result) > TIMETABLE_RECOGNITION_MAX_BODY_BYTES) return tooLarge('Файли разом завеликі для одного запиту. Зменште зображення або виберіть меншу частину таблиці.')
  return result
}

const comparable = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA')
  .replace(/[’ʼ`]/g, "'").replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, '')
function groupParts(value: string): { prefix: string; number: number } | null {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[‐‑‒–—−]/g, '-')
    .replace(/^(?:група|гр\.?|group)\s*(?=№?\s*\d)/u, '').replace(/\s*(?:група|гр\.?|group)$/u, '').trim()
    .replace(/^№\s*(?=\d)/u, '')
  const match = /^(?:([\p{L}][\p{L}\s.'’ʼ]*)[\s-]*)?(\d{1,3})$/u.exec(normalized)
  return match ? { prefix: comparable(match[1] || ''), number: Number(match[2]) } : null
}
function groupsConflict(target: string, visible: string): boolean {
  if (comparable(target) === comparable(visible)) return false
  const left = groupParts(target)
  const right = groupParts(visible)
  // A printed "4 група" may omit a programme prefix from "ЕУБ-4".
  // Two different explicit prefixes are never interchangeable, even at number 4.
  if (left && right) return left.number !== right.number || Boolean(left.prefix && right.prefix && left.prefix !== right.prefix)
  return true
}

export type TimetableRecognitionTargetMismatchField = 'group_name' | 'study_year' | 'study_level' | 'program'
/** Missing visible headers are unknown, not evidence copied from the target. */
export function timetableRecognitionTargetMismatchFields(
  target: TimetableRecognitionTarget, visible: TimetableRecognitionTarget,
): TimetableRecognitionTargetMismatchField[] {
  const fields: TimetableRecognitionTargetMismatchField[] = []
  if (target.group_name && visible.group_name && groupsConflict(target.group_name, visible.group_name)) fields.push('group_name')
  if (target.study_year !== null && visible.study_year !== null && target.study_year !== visible.study_year) fields.push('study_year')
  if (target.study_level !== null && visible.study_level !== null && target.study_level !== visible.study_level) fields.push('study_level')
  if (target.program && visible.program && comparable(target.program) !== comparable(visible.program)) fields.push('program')
  return fields
}
