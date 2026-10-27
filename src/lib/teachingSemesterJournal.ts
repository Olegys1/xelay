import type { TeachingCourse, TeachingEntry, TeachingSnapshot } from './teaching'
import { calculateTeachingBreakdown, teachingRulesForGroup } from './teachingGrading'

export type TeachingSemesterPeriod = 'current' | 'previous' | 'upcoming' | 'all'
export type TeachingJournalSort = 'name' | 'total_desc' | 'total_asc'
export const TEACHING_JOURNAL_SORTS = [
  { id: 'name', label: 'За ПІБ · А–Я' },
  { id: 'total_desc', label: 'За опублікованими балами · від більшого' },
  { id: 'total_asc', label: 'За опублікованими балами · від меншого' },
] as const

export function teachingSemesterPeriod(course: TeachingCourse, today: string): Exclude<TeachingSemesterPeriod, 'all'> {
  if (course.archived_at || course.ends_on < today) return 'previous'
  return course.starts_on > today ? 'upcoming' : 'current'
}

export function teachingSemesterKey(course: TeachingCourse): string {
  return JSON.stringify([course.semester, course.starts_on, course.ends_on])
}

export function nextTeachingSemester(course: Pick<TeachingCourse, 'ends_on'>) {
  const year = Number(course.ends_on.slice(0, 4)), month = Number(course.ends_on.slice(5, 7))
  if (month >= 7 || month === 1) {
    const nextYear = month >= 7 ? year + 1 : year
    return { semester: `Весняний семестр ${nextYear}`, starts_on: `${nextYear}-02-01`, ends_on: `${nextYear}-06-30` }
  }
  return { semester: `Осінній семестр ${year}`, starts_on: `${year}-09-01`, ends_on: `${year}-12-31` }
}

export function teachingSemesters(courses: TeachingCourse[], period: TeachingSemesterPeriod, today: string) {
  return [...new Map(courses.filter(course => period === 'all' || teachingSemesterPeriod(course, today) === period)
    .map(course => [teachingSemesterKey(course), { key: teachingSemesterKey(course), label: course.semester, starts_on: course.starts_on, ends_on: course.ends_on }])).values()]
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on) || a.label.localeCompare(b.label, 'uk'))
}

export type TeachingStatementRow = { entry: TeachingEntry; total: number | null; assessed: number; pendingDrafts: number }

/** A statement contains only published results for this subject and group. */
export function teachingStatementRows(snapshot: TeachingSnapshot, groupId: string, sort: TeachingJournalSort = 'name'): TeachingStatementRow[] {
  if (!snapshot.course.permissions.includes('grades')) return []
  const entries = snapshot.entries.filter(entry => entry.active && entry.course_id === snapshot.course.id && entry.group_id === groupId)
  const activities = snapshot.activities.filter(activity => activity.course_id === snapshot.course.id && activity.group_id === groupId)
  const activityIds = new Set(activities.map(activity => activity.id))
  const entryIds = new Set(entries.map(entry => entry.id))
  const byEntry = new Map<string, Map<string, TeachingSnapshot['grades'][number]>>()
  for (const grade of snapshot.grades) {
    if (!entryIds.has(grade.entry_id) || !activityIds.has(grade.activity_id)) continue
    if (!byEntry.has(grade.entry_id)) byEntry.set(grade.entry_id, new Map())
    byEntry.get(grade.entry_id)!.set(grade.activity_id, grade)
  }
  const rules = teachingRulesForGroup(snapshot, groupId)
  const rows = entries.map(entry => {
    const grades = byEntry.get(entry.id)
    const calculation = calculateTeachingBreakdown(rules, activities.map(activity => { const grade = grades?.get(activity.id); return { category: activity.category, score: grade?.published_at ? grade.published_score : undefined } }))
    return { entry, total: calculation.numericCount ? calculation.total : null, assessed: calculation.numericCount,
      pendingDrafts: [...grades?.values() || []].filter(grade => 'draft_score' in grade && (grade.draft_score !== grade.published_score || (grade.draft_comment ?? '') !== grade.published_comment)).length }
  })
  return rows.sort((a, b) => {
    if (sort !== 'name') {
      if (a.total === null && b.total !== null) return 1
      if (b.total === null && a.total !== null) return -1
      if (a.total !== null && b.total !== null && a.total !== b.total) return sort === 'total_desc' ? b.total - a.total : a.total - b.total
    }
    return a.entry.full_name.localeCompare(b.entry.full_name, 'uk') || a.entry.id.localeCompare(b.entry.id)
  })
}
