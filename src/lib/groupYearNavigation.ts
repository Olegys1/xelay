import { groupAcademicYearForDate, groupAcademicYearRange } from './studyGroupAcademicYears'

export function groupTodayInKyiv(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function groupYearChoices({ today, selectedDate, cohortStartYear, createdAt, dates = [] }: {
  today: string; selectedDate: string; cohortStartYear?: number | null; createdAt?: string; dates?: string[]
}): number[] {
  const current = groupAcademicYearForDate(today)
  if (current === null) return []
  // Empty years are selectable too: older files may have been imported later.
  // This never looks up another group or infers membership from its name.
  const candidates = [current - 4, current, groupAcademicYearForDate(selectedDate), groupAcademicYearForDate(createdAt?.slice(0, 10) || ''),
    Number.isInteger(cohortStartYear) ? cohortStartYear! : null, ...dates.map(groupAcademicYearForDate)]
    .filter((year): year is number => year !== null && year >= 1900 && year <= 2199)
  const first = Math.min(current, ...candidates)
  const last = Math.max(current + 1, ...candidates)
  return Array.from({ length: last - first + 1 }, (_, index) => last - index)
}

export function groupDateInAcademicYear(date: string, targetYear: number): string {
  groupAcademicYearRange(targetYear)
  if (groupAcademicYearForDate(date) === null) return `${targetYear}-09-01`
  const month = Number(date.slice(5, 7))
  const year = targetYear + (month < 9 ? 1 : 0)
  const day = Math.min(Number(date.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate())
  return `${year}-${date.slice(5, 7)}-${String(day).padStart(2, '0')}`
}

export function groupYearContainsSchedule(item: { valid_from: string; valid_until: string }, startYear: number): boolean {
  const range = groupAcademicYearRange(startYear)
  return (item.valid_from === '-infinity' || item.valid_from <= range.until)
    && (item.valid_until === 'infinity' || item.valid_until >= range.from)
}

export function groupHomeworkMakesLessonVisible(item: { id: string }, homework: ReadonlyMap<string, unknown>): boolean {
  return homework.has(item.id)
}
