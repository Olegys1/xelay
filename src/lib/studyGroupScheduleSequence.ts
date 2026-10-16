import { supabase } from './supabase'
import { validFirstShiftCopyLessons, validScheduleCopySlotAssignments, type ScheduleCopyLesson, type ScheduleCopySlotAssignment, type ScheduleCopyTimeMode, type TimetableLesson } from './studyGroupTimetable'

export const MAX_SCHEDULE_COPY_DATES = 26
export type ScheduleCopyPair = { source_date: string; target_date: string }
export type ScheduleCopySequenceDay = ScheduleCopyPair & { copied: number; skipped: number; lessons: ScheduleCopyLesson[]; empty?: boolean; slot_assignments?: ScheduleCopySlotAssignment[] }
export type ScheduleCopySequencePreview = { copied: number; skipped: number; source_signature: string; days: ScheduleCopySequenceDay[] }

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function weekday(value: string) { return new Date(`${value}T12:00:00Z`).getUTCDay() || 7 }
function addDays(value: string, amount: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function scheduleCopyCycle(weekdays: number[], firstWeekday: number): number[] {
  const days = [...new Set(weekdays)].sort((left, right) => left - right)
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 5)) {
    throw new Error('Оберіть принаймні один день із понеділка по п’ятницю.')
  }
  const start = days.indexOf(firstWeekday)
  if (start < 0) throw new Error('Оберіть перший день циклу серед позначених днів.')
  return [...days.slice(start), ...days.slice(0, start)]
}

export function buildScheduleCopySequence(firstTarget: string, until: string, weekdays: number[], firstWeekday: number): ScheduleCopyPair[] {
  if (!validDate(firstTarget) || weekday(firstTarget) < 6) throw new Error('Оберіть першу дату копіювання: суботу або неділю.')
  if (!validDate(until) || until < firstTarget) throw new Error('Оберіть кінцеву дату не раніше першого заняття.')
  const cycle = scheduleCopyCycle(weekdays, firstWeekday)
  const pairs: ScheduleCopyPair[] = []
  for (let target = firstTarget; target <= until; target = addDays(target, 7)) {
    if (pairs.length === MAX_SCHEDULE_COPY_DATES) throw new Error(`За один раз можна скопіювати розклад щонайбільше на ${MAX_SCHEDULE_COPY_DATES} дат. Скоротіть період.`)
    const sourceWeekday = cycle[pairs.length % cycle.length]
    const source = addDays(target, sourceWeekday - weekday(target))
    if (!validDate(source)) throw new Error('Дата джерела має бути від 1900 до 2200 року.')
    pairs.push({ source_date: source, target_date: target })
  }
  return pairs
}

function validPair(value: ScheduleCopyPair, previous?: string): boolean {
  return validDate(value.source_date) && weekday(value.source_date) <= 5
    && validDate(value.target_date) && weekday(value.target_date) >= 6
    && (!previous || value.target_date > previous)
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1008

export async function copyStudyGroupScheduleSequence(groupId: string, pairs: ScheduleCopyPair[], preview: boolean, signature: string | null = null, timeMode: ScheduleCopyTimeMode = 'original', slotAssignments: Record<string, ScheduleCopySlotAssignment[]> = {}): Promise<ScheduleCopySequencePreview> {
  if (!pairs.length || pairs.length > MAX_SCHEDULE_COPY_DATES || pairs.some((pair, index) => !validPair(pair, pairs[index - 1]?.target_date))) throw new Error('COPY_SEQUENCE_INVALID_INPUT')
  if (!['original', 'first_shift'].includes(timeMode)) throw new Error('TIMETABLE_COPY_TIME_MODE_INVALID')
  if (!slotAssignments || typeof slotAssignments !== 'object' || Array.isArray(slotAssignments)
    || Object.entries(slotAssignments).some(([date, assignments]) => !pairs.some((pair) => pair.source_date === date) || !validScheduleCopySlotAssignments(assignments))) throw new Error('TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID')
  const args = {
    p_group_id: groupId, p_pairs: pairs, p_preview: preview, p_expected_signature: signature,
  }
  const { data, error } = timeMode === 'original'
    ? await supabase.rpc('xelay_copy_study_group_schedule_sequence', args)
    : await supabase.rpc('xelay_copy_study_group_schedule_sequence_with_time_mode', { ...args, p_time_mode: timeMode, p_slot_assignments: slotAssignments })
  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data) || !count(data.copied) || !count(data.skipped)
    || typeof data.source_signature !== 'string' || !data.source_signature || !Array.isArray(data.days) || data.days.length !== pairs.length) {
    throw new Error('COPY_SEQUENCE_RESPONSE_UNKNOWN')
  }
  let copied = 0; let skipped = 0
  for (let index = 0; index < data.days.length; index++) {
    const day = data.days[index]
    if (!day || day.source_date !== pairs[index].source_date || day.target_date !== pairs[index].target_date
      || !count(day.copied) || !count(day.skipped) || !Array.isArray(day.lessons) || day.empty !== undefined && typeof day.empty !== 'boolean'
      || day.lessons.some((lesson: unknown) => {
        const item = lesson as Partial<TimetableLesson> | null
        return !item || typeof item.id !== 'string' || typeof item.subject !== 'string'
          || typeof item.starts_at !== 'string' || typeof item.ends_at !== 'string' || typeof item.lesson_type !== 'string'
      })) throw new Error('COPY_SEQUENCE_RESPONSE_UNKNOWN')
    if (timeMode === 'first_shift' && (preview && day.lessons.length !== day.copied + day.skipped || !validScheduleCopySlotAssignments(day.slot_assignments)
      || !validFirstShiftCopyLessons(day.lessons, day.slot_assignments, preview))) throw new Error('COPY_SEQUENCE_RESPONSE_UNKNOWN')
    copied += day.copied; skipped += day.skipped
  }
  if (copied !== data.copied || skipped !== data.skipped || copied + skipped > 1008) throw new Error('COPY_SEQUENCE_RESPONSE_UNKNOWN')
  return data as ScheduleCopySequencePreview
}

export function scheduleCopySequenceError(error: unknown): string | null {
  const value = error && typeof error === 'object' ? error as { message?: unknown } : {}
  const message = typeof value.message === 'string' ? value.message : ''
  if (/COPY_SEQUENCE_(LIMIT|TOO_MANY)/.test(message)) return `За один раз можна скопіювати до ${MAX_SCHEDULE_COPY_DATES} дат і до 1008 пар. Скоротіть період.`
  if (message.includes('COPY_SEQUENCE_INVALID')) return 'Перевірте дати: призначення — суботи чи неділі, джерела — будні. Дати призначення не мають повторюватися.'
  if (message.includes('COPY_SEQUENCE_RESPONSE_UNKNOWN')) return 'Не вдалося підтвердити результат копіювання. Оновіть розклад і перегляд перед повторною спробою.'
  if (error instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(message)) return message
  return null
}
