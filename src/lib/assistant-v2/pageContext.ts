import type { LiveCatalog } from './liveClient'

export interface AssistantPageContext { source: string; ownerId: string; groupId?: string; courseId?: string; subjectId?: string; date?: string; mode: 'learning' | 'teaching'; topic?: 'study' | 'materials' | 'seminars' | 'teaching' | 'gradebook' }
export const ASSISTANT_CONTEXT_EVENT = 'xelay:assistant-context'
let latest: AssistantPageContext | undefined
/** Only current page selections, never contents, credentials or permission grants. */
export function publishAssistantPageContext(context: AssistantPageContext) {
  if (typeof window === 'undefined') return
  latest = { ...context }; window.dispatchEvent(new CustomEvent(ASSISTANT_CONTEXT_EVENT, { detail: { ...context } }))
}
export function releaseAssistantPageContext(source: string) { if (latest?.source === source) latest = undefined }
export function currentAssistantPageContext(ownerId: string) { return latest?.ownerId === ownerId ? { ...latest } : undefined }
export function validateAssistantPageContext(value: unknown, ownerId: string, catalog: LiveCatalog): AssistantPageContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const context = value as AssistantPageContext
  if (context.ownerId !== ownerId || catalog.userId !== ownerId || typeof context.source !== 'string' || !['learning', 'teaching'].includes(context.mode)) return undefined
  const course = context.courseId ? catalog.courses.find(item => item.id === context.courseId && item.teaching && item.teachingGroupIds.length) : undefined
  if (context.courseId && !course) return undefined
  const group = context.groupId ? catalog.groups.find(item => item.id === context.groupId && (context.mode === 'learning' ? item.learning : catalog.courses.some(item => item.teaching && item.teachingGroupIds.includes(context.groupId!) && (!course || item.id === course.id)))) : undefined
  if (context.groupId && !group || context.subjectId && !catalog.subjects.some(subject => subject.id === context.subjectId && subject.groupId === group?.id)) return undefined
  if (context.date && (!/^\d{4}-\d{2}-\d{2}$/.test(context.date) || !Number.isFinite(Date.parse(context.date + 'T00:00:00Z')) || !new Date(context.date + 'T00:00:00Z').toISOString().startsWith(context.date))) return undefined
  if (context.topic && !['study', 'materials', 'seminars', 'teaching', 'gradebook'].includes(context.topic) || context.mode === 'teaching' && context.topic === 'seminars') return undefined
  return { source: context.source, ownerId, mode: context.mode, ...(group ? { groupId: group.id } : {}), ...(course ? { courseId: course.id } : {}), ...(context.subjectId ? { subjectId: context.subjectId } : {}), ...(context.date ? { date: context.date } : {}), ...(context.topic ? { topic: context.topic } : {}) }
}
