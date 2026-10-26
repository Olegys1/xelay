// Pure clock arithmetic shared by the real copy form and its local preview.
// These are timetable wall-clock times, not instants or timezone conversions.
export const DEFAULT_TIMETABLE_SLOTS = [
  { number: 1, starts_at: '08:00', ends_at: '09:20' },
  { number: 2, starts_at: '09:40', ends_at: '11:00' },
  { number: 3, starts_at: '11:20', ends_at: '12:40' },
  { number: 4, starts_at: '12:50', ends_at: '14:10' },
  { number: 5, starts_at: '14:30', ends_at: '15:50' },
]

export function scheduleCopyClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)) return null
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
}

function clock(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) throw new Error('TIMETABLE_COPY_CUSTOM_TIME_INVALID')
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function firstShiftSlotTime(firstStart: string, lessonNumber: number): { starts_at: string; ends_at: string } {
  const start = scheduleCopyClockMinutes(firstStart)
  if (start === null || !/^\d{2}:\d{2}$/.test(firstStart)) throw new Error('TIMETABLE_COPY_FIRST_SHIFT_START_INVALID')
  const slot = DEFAULT_TIMETABLE_SLOTS.find(item => item.number === lessonNumber)
  if (!slot) throw new Error('TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID')
  const offset = start - 8 * 60
  return { starts_at: clock(scheduleCopyClockMinutes(slot.starts_at)! + offset), ends_at: clock(scheduleCopyClockMinutes(slot.ends_at)! + offset) }
}
