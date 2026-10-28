import type { TeachingWorkspaceData } from './teaching'

export type TeachingHomeDestination = 'calendar' | 'scheduled' | 'requests' | 'materials' | 'journal' | 'assignments'
export type TeachingHomeView = 'groups' | 'calendar' | 'scheduled' | 'requests' | 'materials' | 'connections'
export type TeachingHomeTab = 'assignments' | 'materials' | 'grades'
export type TeachingHomeTarget = { home?: TeachingHomeDestination; courseId?: string; groupId?: string; date?: string }
const destinations: TeachingHomeDestination[] = ['calendar', 'scheduled', 'requests', 'materials', 'journal', 'assignments']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function teachingHomeDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined
}

export function parseTeachingHomeTarget(search: Record<string, unknown>): TeachingHomeTarget {
  return {
    home: destinations.includes(search.home as TeachingHomeDestination) ? search.home as TeachingHomeDestination : undefined,
    courseId: typeof search.course === 'string' && uuid.test(search.course) ? search.course : undefined,
    groupId: typeof search.group === 'string' && uuid.test(search.group) ? search.group : undefined,
    date: teachingHomeDate(search.date),
  }
}

export function teachingHomePlacement(home?: TeachingHomeDestination, embedded = false): { view: TeachingHomeView; tab: TeachingHomeTab } {
  if (home === 'journal') return { view: 'groups', tab: 'grades' }
  if (home === 'assignments') return { view: 'groups', tab: 'assignments' }
  if (home === 'materials') return embedded ? { view: 'groups', tab: 'materials' } : { view: 'materials', tab: 'assignments' }
  return { view: home || 'groups', tab: 'assignments' }
}

/** Choosing a classroom from the journal landing keeps the user's destination. */
export function teachingHomeSelectionTab(home?: TeachingHomeDestination): TeachingHomeTab {
  return home === 'journal' ? 'grades' : 'assignments'
}

export function canUseTeachingHomePermissions(permissions: readonly string[], home?: TeachingHomeDestination, embedded = false): boolean {
  if (!home) return true
  const { view, tab } = teachingHomePlacement(home, embedded)
  if (view === 'requests' || view === 'groups' && tab === 'grades') return permissions.includes('grades')
  if (view === 'scheduled') return permissions.some(permission => permission === 'assignments' || permission === 'materials')
  if (view === 'materials' || view === 'groups' && tab === 'materials') return permissions.includes('materials')
  if (view === 'groups') return permissions.some(permission => permission === 'assignments' || permission === 'grades')
  return permissions.length > 0
}

/** A URL selects an existing authorized destination; it never grants access.
 * A specifically requested classroom must not silently select another group. */
export function canOpenTeachingHomeTarget(workspace: TeachingWorkspaceData, target: TeachingHomeTarget, embedded = false): boolean {
  if (target.date !== undefined && !teachingHomeDate(target.date)) return false
  if (target.courseId !== undefined && !uuid.test(target.courseId) || target.groupId !== undefined && !uuid.test(target.groupId)) return false
  if (!target.courseId && !target.groupId) return true
  const course = workspace.courses.find(item => item.id === target.courseId)
  if (!course || !course.permissions?.length) return false
  if (target.groupId && !(workspace.classrooms || []).some(group => group.group_id === target.groupId
    && group.courses.some(link => link.course_id === course.id && link.status === 'accepted'))) return false
  return canUseTeachingHomePermissions(course.permissions, target.home, embedded)
}
