const STUDY_PROGRAM_YEARS: Readonly<Record<string, number>> = {
  bachelor: 4,
  master: 2,
  postgraduate: 4,
}

export function isActiveStudentStatus(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(STUDY_PROGRAM_YEARS, status)
}

export function defaultStudyProgramYears(status: string): number | null {
  return isActiveStudentStatus(status) ? STUDY_PROGRAM_YEARS[status] : null
}

export function effectiveStudyProgramYears(status: string, studyYear?: number | null, explicit?: number | null): number | null {
  if (!isActiveStudentStatus(status)) return null
  if (Number.isInteger(explicit) && explicit! >= 1 && explicit! <= 6) return explicit!
  // Existing fifth/sixth-year profiles keep their current course until clarified.
  return Math.max(defaultStudyProgramYears(status)!, studyYear || 1)
}

export function currentAcademicYear(date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: 'numeric',
  }).formatToParts(date)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  return month >= 9 ? year : year - 1
}
