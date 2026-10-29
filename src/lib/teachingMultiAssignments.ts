import type { TeachingTarget } from './teaching'

export type MultiAssignmentTargetDraft = {
  groupId: string; lessonDate: string; scheduleItemId: string; placementMode: 'lesson' | 'unplaced';
  deadline: string; deadlineMode?: 'fixed' | 'free'; closesAt: string;
}
type MultiDraft = { version: 1; editor_id: string; source_version: number; targets: MultiAssignmentTargetDraft[] }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const MAX_MULTI_ASSIGNMENT_GROUPS = 30
export function emptyMultiAssignmentTarget(groupId: string): MultiAssignmentTargetDraft {
  return { groupId, lessonDate: '', scheduleItemId: '', placementMode: 'lesson', deadline: '', closesAt: '' }
}
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit
export function validMultiAssignmentTargets(value: unknown): value is MultiAssignmentTargetDraft[] {
  return Array.isArray(value) && value.length < MAX_MULTI_ASSIGNMENT_GROUPS
    && new Set(value.map(target => target?.groupId)).size === value.length
    && value.every(target => target && bounded(target.groupId, 100) && Boolean(target.groupId)
      && bounded(target.lessonDate, 10) && bounded(target.scheduleItemId, 36)
      && (target.placementMode === 'lesson' || target.placementMode === 'unplaced')
      && bounded(target.deadline, 40) && (target.deadlineMode === undefined || target.deadlineMode === 'fixed' || target.deadlineMode === 'free')
      && bounded(target.closesAt, 40))
}
export function multiAssignmentTargets(
  first: MultiAssignmentTargetDraft, additional: MultiAssignmentTargetDraft[], toInstant: (value: string) => string | null,
): TeachingTarget[] {
  const all = [first, ...additional]
  if (!validMultiAssignmentTargets(additional) || !first.groupId || !additional.length
    || new Set(all.map(target => target.groupId)).size !== all.length) throw new Error('TEACHING_INVALID_INPUT')
  return all.map(target => ({ group_id: target.groupId, due_at: toInstant(target.deadline), closes_at: toInstant(target.closesAt),
    lesson_date: target.lessonDate || null, schedule_item_id: target.placementMode === 'lesson' ? target.scheduleItemId || null : null,
    placement_mode: target.placementMode }))
}
function sessionStorage(): DraftStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage } catch { return undefined }
}
// The base editor key already binds account, course, item and originating group.
export const multiAssignmentDraftKey = (editorDraftKey: string) => `${editorDraftKey}:multi-targets:v1`
export function readMultiAssignmentDraft(key: string, editorId: string, sourceVersion: number, allowedGroupIds: string[], storage = sessionStorage()) {
  try {
    const raw = storage?.getItem(key)
    if (!raw || raw.length > 16000) return null
    const draft = JSON.parse(raw) as MultiDraft
    if (draft.version !== 1 || draft.editor_id !== editorId || draft.source_version !== sourceVersion
      || !validMultiAssignmentTargets(draft.targets) || draft.targets.some(target => !allowedGroupIds.includes(target.groupId))) return null
    return draft.targets
  } catch { return null }
}
export function writeMultiAssignmentDraft(key: string, editorId: string, sourceVersion: number, targets: MultiAssignmentTargetDraft[], storage = sessionStorage()) {
  try {
    if (!storage || !validMultiAssignmentTargets(targets)) return false
    if (!targets.length) { storage.removeItem(key); return true }
    storage.setItem(key, JSON.stringify({ version: 1, editor_id: editorId, source_version: sourceVersion, targets } satisfies MultiDraft))
    return true
  } catch { return false }
}
export function clearMultiAssignmentDraft(key: string, storage = sessionStorage()) {
  try { storage?.removeItem(key) } catch { /* Confirmed saves remain successful if browser storage is blocked. */ }
}
