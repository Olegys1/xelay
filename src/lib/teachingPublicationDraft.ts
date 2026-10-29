import { TEACHING_MAX_FILE_BYTES, type TeachingFile } from './teaching'

export type TeachingPublicationDraftFields = {
  selectedGroup: string; title: string; body: string; links: string[]; linkTitles: string[];
  attachments: TeachingFile[]; deadline: string; deadlineMode?: 'fixed' | 'free'; assessed: boolean; maxPoints: string; category: string;
  lessonDate?: string; scheduleItemId?: string; placementMode?: 'lesson' | 'unplaced';
  publishMode?: 'now' | 'scheduled'; publishAt?: string; closesAt?: string; submissionFormat?: 'written' | 'oral' | 'defense';
  allowDownload?: boolean; workType?: string;
}
export type TeachingPublicationDraft = {
  version: 1; source_version: number; editor_id: string; fields: TeachingPublicationDraftFields; pending_file_names: string[];
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const maxDraftLength = 200000
const bounded = (value: unknown, length: number): value is string => typeof value === 'string' && value.length <= length
const strings = (value: unknown, count: number, length: number): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => bounded(item, length))

function sessionDraftStorage(): DraftStorage | undefined {
  try { return typeof window !== 'undefined' ? window.sessionStorage : undefined } catch { return undefined }
}
export function teachingPublicationDraftKey(userId: string, courseId: string, kind: string, itemId?: string, groupId?: string) {
  return 'xelay:teaching-publication-draft:v1:' + JSON.stringify([userId, courseId, kind, itemId || 'new', groupId || 'unassigned'])
}
export function readTeachingPublicationDraft(key: string, sourceVersion: number, storage = sessionDraftStorage()): TeachingPublicationDraft | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw || raw.length > maxDraftLength) return null
    const value = JSON.parse(raw) as TeachingPublicationDraft
    const fields = value?.fields
    if (value.version !== 1 || value.source_version !== sourceVersion || !Number.isSafeInteger(value.source_version)
      || !bounded(value.editor_id, 36) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.editor_id)
      || !fields || !bounded(fields.selectedGroup, 200) || !bounded(fields.title, 480) || !bounded(fields.body, 100000)
      || !strings(fields.links, 20, 2000) || !strings(fields.linkTitles, 20, 160) || fields.linkTitles.length !== fields.links.length
      || !bounded(fields.deadline, 40) || fields.deadlineMode !== undefined && fields.deadlineMode !== 'fixed' && fields.deadlineMode !== 'free'
      || typeof fields.assessed !== 'boolean' || !bounded(fields.maxPoints, 30)
      || !bounded(fields.category, 100) || !strings(value.pending_file_names, 10, 240)
      || fields.lessonDate !== undefined && !bounded(fields.lessonDate, 10)
      || fields.scheduleItemId !== undefined && !bounded(fields.scheduleItemId, 36)
      || fields.placementMode !== undefined && fields.placementMode !== 'lesson' && fields.placementMode !== 'unplaced'
      || fields.publishMode !== undefined && fields.publishMode !== 'now' && fields.publishMode !== 'scheduled'
      || fields.publishAt !== undefined && !bounded(fields.publishAt, 40)
      || fields.closesAt !== undefined && !bounded(fields.closesAt, 40)
      || fields.submissionFormat !== undefined && !['written', 'oral', 'defense'].includes(fields.submissionFormat)
      || fields.workType !== undefined && !bounded(fields.workType, 100)
      || fields.allowDownload !== undefined && typeof fields.allowDownload !== 'boolean'
      || !Array.isArray(fields.attachments) || fields.attachments.length > 10
      || fields.attachments.some(file => !file || !bounded(file.storage_path, 512) || !bounded(file.name, 240)
        || !bounded(file.mime_type, 160) || !Number.isFinite(file.size) || file.size < 1 || file.size > TEACHING_MAX_FILE_BYTES)) return null
    return value
  } catch { return null }
}
export function writeTeachingPublicationDraft(key: string, value: TeachingPublicationDraft, storage = sessionDraftStorage()) {
  try {
    if (!storage) return false
    const raw = JSON.stringify(value)
    if (raw.length > maxDraftLength) return false
    storage.setItem(key, raw)
    return true
  } catch { return false }
}
export function clearTeachingPublicationDraft(key: string, storage = sessionDraftStorage()) {
  try { storage?.removeItem(key) } catch { /* A blocked store must not prevent closing a confirmed save. */ }
}
