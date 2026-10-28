import type { TeachingCourse, TeachingGroupData, TeachingPublication } from './teaching'
import { groupAcademicDateInYear, groupAcademicYearForDate, groupAcademicYearRange } from './studyGroupAcademicYears'

function calendarDate(value: string | null | undefined): string | null {
  if (!value) return null
  if (groupAcademicYearForDate(value) !== null) return value
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  if (groupAcademicYearForDate(value.slice(0, 10)) === null) return null
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time)
  const field = (name: string) => parts.find(part => part.type === name)?.value || ''
  const date = `${field('year')}-${field('month')}-${field('day')}`
  return groupAcademicYearForDate(date) === null ? null : date
}

export function groupTeachingCourseInAcademicYear(course: Pick<TeachingCourse, 'starts_on' | 'ends_on'>, academicYearStart?: number): boolean {
  if (academicYearStart === undefined) return true
  const { from, until } = groupAcademicYearRange(academicYearStart)
  const starts = calendarDate(course.starts_on), ends = calendarDate(course.ends_on)
  return starts !== null && ends !== null && starts <= ends && starts <= until && ends >= from
}

/** Narrows already-authorized group data. It never fetches or grants access. */
export function groupTeachingDataForAcademicYear(data: TeachingGroupData, groupId: string, academicYearStart?: number): TeachingGroupData {
  const courses = data.courses.filter(course => groupTeachingCourseInAcademicYear(course, academicYearStart))
  const courseIds = new Set(courses.map(course => course.id))
  function publicationInYear(item: TeachingPublication, kind: 'assignment' | 'material'): boolean {
    if (!courseIds.has(item.course_id)) return false
    const target = item.targets.find(target => target.group_id === groupId)
    if (!target) return false
    if (academicYearStart === undefined) return true
    const date = kind === 'assignment'
      ? calendarDate(target.lesson_date) || calendarDate(target.due_at)
      : calendarDate(item.material_date) || calendarDate(item.published_at)
    // An undated publication remains with its known teaching period rather
    // than being invented as a current-year item.
    return date === null ? kind === 'assignment' : groupAcademicDateInYear(date, academicYearStart)
  }
  return { ...data, courses,
    grades: data.grades.filter(grade => grade.group_id === groupId && courseIds.has(grade.course_id) && groupAcademicDateInYear(grade.activity_date, academicYearStart)),
    assignments: data.assignments.filter(item => publicationInYear(item, 'assignment')),
    materials: data.materials.filter(item => publicationInYear(item, 'material')),
    pending_invites: data.pending_invites.filter(invite => invite.group_id === groupId),
  }
}
