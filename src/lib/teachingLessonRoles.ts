import type { LessonType } from './studyGroupTimetableTypes'

export const TEACHING_LESSON_ROLE_TYPES: readonly LessonType[] = [
  'lecture', 'seminar', 'practical', 'lab', 'makeup', 'replacement',
  'module', 'final_assessment', 'test', 'other',
]

/** A teaching responsibility personalizes the calendar; it grants no access. */
export function validateTeachingLessonTypes(value: unknown): LessonType[] {
  if (!Array.isArray(value) || value.length > TEACHING_LESSON_ROLE_TYPES.length
    || value.some(type => typeof type !== 'string' || !TEACHING_LESSON_ROLE_TYPES.includes(type as LessonType))
    || new Set(value).size !== value.length) throw new Error('TEACHING_LESSON_ROLE_INVALID')
  return TEACHING_LESSON_ROLE_TYPES.filter(type => value.includes(type))
}

export function resolveTeachingLessonAssignment(type: string, roleTypes: readonly string[], manual: boolean | undefined): {
  assigned_to_me: boolean; assignment_source: 'manual' | 'role' | 'none'
} {
  if (manual !== undefined) return { assigned_to_me: manual, assignment_source: 'manual' }
  const assigned = roleTypes.includes(type)
  return { assigned_to_me: assigned, assignment_source: assigned ? 'role' : 'none' }
}
