const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)

/** This is a view request, never an account identifier or permission grant. */
export function parseOwnGradeSearch(search: Record<string, unknown>): { grades?: 'own'; gradeCourse?: string } {
  if (search.teaching || search.grades !== 'own') return {}
  return { grades: 'own', ...(typeof search.gradeCourse === 'string' && UUID.test(search.gradeCourse) ? { gradeCourse: search.gradeCourse.toLowerCase() } : {}) }
}
export function ownGradeSourcePath(groupId: string, courseId?: string, date?: string) {
  if (!UUID.test(groupId) || courseId !== undefined && !UUID.test(courseId)) throw new Error('invalid_grade_destination')
  return `/groups/${groupId}?tab=schedule&grades=own${courseId ? '&gradeCourse=' + courseId : ''}${validDate(date) ? '&date=' + date : ''}`
}
/** GroupTeachingPanel calls this only after its caller-authenticated group read
 * has completed for the current user/group/year. No query user ID is accepted. */
export function ownGradeLaunchSelection(input: { requested: boolean; requestedCourseId?: string; userId: string; groupId: string; scopeKey: string; loadedScope: string; view: 'schedule' | 'materials'; data: { courses: { id: string }[] } | null }) {
  if (!input.requested || !input.userId || !input.groupId || input.view !== 'schedule' || input.loadedScope !== input.scopeKey || !input.data) return null
  if (input.requestedCourseId && !input.data.courses.some(course => course.id === input.requestedCourseId)) return null
  const courseId = input.requestedCourseId || ''
  return { key: `${input.scopeKey}:own-grades:${courseId}`, courseId }
}
