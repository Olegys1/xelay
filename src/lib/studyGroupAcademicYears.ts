/** A group's academic year runs from 1 September through 31 August. */
function academicDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') return null
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null
}

export function groupAcademicYearForDate(date: string): number | null {
  if (!academicDate(date)) return null
  return Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 9 ? 1 : 0)
}

export function groupAcademicYearRange(start: number): { from: string; until: string } {
  if (!Number.isInteger(start) || start < 1899 || start > 2200) throw new Error('Перевірте навчальний рік.')
  return { from: `${start}-09-01`, until: `${start + 1}-08-31` }
}

/** An unspecified scope keeps legacy/unknown dates visible, never assigns them to a year. */
export function groupAcademicDateInYear(date: string, start?: number | null): boolean {
  if (start === undefined || start === null) return true
  const range = groupAcademicYearRange(start)
  return academicDate(date) !== null && date >= range.from && date <= range.until
}
