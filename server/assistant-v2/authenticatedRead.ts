import { projectExtendedStudyRecord, assistantSourcePath } from './cloudStudyRead.ts'
import { calculateTeachingBreakdown, validateTeachingGradingRules, type TeachingGradingRules } from '../../src/lib/teachingGrading.ts'
/** Server-side read boundary, deliberately not mounted on an HTTP route.
 * An adapter must verify the real session and issue all repository reads as that
 * caller (JWT/RLS), never by trusting an actor/role supplied by the browser.
 * No production client, environment discovery, model call or write lives here.
 */
export const AUTHENTICATED_ASSISTANT_READ_TOPICS = ['study', 'materials', 'results', 'teaching', 'gradebook', 'seminars', 'organizer', 'community', 'news', 'opportunities', 'help'] as const
export type AuthenticatedAssistantReadTopic = typeof AUTHENTICATED_ASSISTANT_READ_TOPICS[number]
export const AUTHENTICATED_ASSISTANT_READ_LIMITS = Object.freeze({ rows: 100, defaultRows: 30, memberships: 100, teachingGrants: 200, selections: 100, days: 31, bodyCharacters: 4000, modelBodyCharacters: 2000 })

export interface VerifiedAssistantSession { userId: string; expiresAt: string; accountActive: boolean; emailConfirmed: boolean; sessionId?: string }
export type AssistantGroupPermission = 'schedule' | 'homework' | 'seminars' | 'seminar_resources' | 'materials'
export type AssistantTeachingPermission = 'materials' | 'assignments' | 'grades' | 'manage'
export interface AssistantMembershipGrant {
  userId: string; groupId: string; membershipStatus: 'accepted' | 'pending' | 'declined' | 'removed';
  representativeId: string; subjectIds: string[];
  deputy?: { status: 'approved' | 'pending' | 'revoked' | 'rejected' | 'cancelled'; permissions: AssistantGroupPermission[] }
}
export interface AssistantTeachingGrant {
  userId: string; groupId: string; courseId: string; subjectId: string;
  connectionStatus: 'accepted' | 'pending_teacher' | 'pending_group' | 'removed' | 'rejected';
  teacherVerified: boolean; teacherHasCurrentAccess: boolean; permissions: AssistantTeachingPermission[];
  validFrom?: string | null; validUntil?: string | null
}
export interface AssistantReadAccess {
  userId: string; revision: string; memberships: AssistantMembershipGrant[]; teachingGrants: AssistantTeachingGrant[]
}
export interface AuthenticatedAssistantReadScope {
  groupId?: string; courseId?: string; subjectId?: string; from?: string; to?: string; period?: 'current' | 'archive' | 'all'; query?: string; workspaceId?: string; space?: 'personal' | 'shared' | 'all'
}
export interface AssistantReadSelection { groupId: string; subjectId?: string; courseId?: string; allowedSubjectIds?: string[] }
export interface AssistantCallerReadQuery {
  topic: AuthenticatedAssistantReadTopic; audience: 'student' | 'teacher'; selections: AssistantReadSelection[];
  from?: string; to?: string; period: 'current' | 'archive' | 'all'; studentId?: string;
  limit: number; accessRevision: string; signal?: AbortSignal
  userId?: string; query?: string; workspaceId?: string; space?: 'personal' | 'shared' | 'all'; groupPermissions?: AssistantGroupPermission[]
}
interface AssistantReadRecordBase { id: string; groupId: string; subjectId: string; courseId?: string; version?: number; archived?: boolean; sourcePath?: string; subjectName?: string; teacherName?: string }
export interface AssistantLessonReadRecord extends AssistantReadRecordBase {
  kind: 'lesson'; date: string; title: string; startsAt: string; endsAt: string; location?: string;
  scheduleId?: string; links?: string[]; conferenceId?: string; accessCode?: string
}
export interface AssistantHomeworkReadRecord extends AssistantReadRecordBase {
  kind: 'homework'; date: string; lessonId?: string; title: string; body: string; bodyTruncated?: true; dueAt: string | null; published: boolean
}
export interface AssistantMaterialReadRecord extends AssistantReadRecordBase {
  kind: 'material'; title: string; body: string; bodyTruncated?: true; published: boolean; allowAi: boolean; allowDownload: boolean;
  fileId?: string; fileName?: string
  materialId?: string; materialSourceKind?: 'study' | 'teaching'; rightsVersion?: string
}
export interface AssistantGradeReadRecord extends AssistantReadRecordBase {
  kind: 'grade'; studentId: string; activityId: string; title: string;
  points: number; maxPoints: number; coefficient: number; published: boolean
  category?: string; gradingRules?: TeachingGradingRules
  studentName?: string
}
export interface AssistantExtendedReadRecord extends AssistantReadRecordBase {
  kind: 'seminar' | 'task' | 'question' | 'news' | 'opportunity' | 'help'; title: string; body: string; sourcePath: string;
  date?: string; startsAt?: string; endsAt?: string; dueAt?: string | null; completed?: boolean; space?: 'personal' | 'shared'; workspaceId?: string; canEdit?: boolean;
  format?: 'questions' | 'teams' | 'booking'; selectionVersion?: number; selectionDeadlineAt?: string | null; canReopen?: boolean;
  questions?: { id: string; body: string; position: number; primaryCapacity: number; supplementCapacity: number; occupiedPrimary: number; occupiedSupplement: number }[];
  teams?: { id: string; name: string; capacity: number; occupied: number }[];
  myReservation?: { id: string; role: 'primary' | 'supplement' | 'booking' | 'team'; questionId?: string; teamId?: string };
}
export type AssistantAuthorizedReadRecord = AssistantLessonReadRecord | AssistantHomeworkReadRecord | AssistantMaterialReadRecord | AssistantGradeReadRecord | AssistantExtendedReadRecord
export interface AssistantGradeSummary { subjectId: string; courseId?: string; groupId: string; title: string; workCount: number; points: number; maxPoints: number; weightedPoints: number; weightedMaxPoints: number | null; percentage: number | null; formula: string; partial: boolean; categories: ReturnType<typeof calculateTeachingBreakdown>['categories']; rounding: string }

/** Implementations must use the verified caller's JWT/RLS and bounded selects.
 * readAccess must be a fresh authoritative read, including the actual deputy
 * appointment and the active teacher's exact course/group/subject grants.
 * readPage returns no roster, seminar reservations, profiles or contacts.
 * Existing permission-gated snapshots may be projected inside an adapter only;
 * their unrelated fields must never leave that adapter or enter a model prompt.
 * Both methods are read-only.
 */
export interface AssistantReadRepository {
  readAccess(options: { userId: string; membershipLimit: number; teachingGrantLimit: number; signal?: AbortSignal }): Promise<AssistantReadAccess>
  readPage(query: AssistantCallerReadQuery): Promise<{ rows: AssistantAuthorizedReadRecord[]; hasMore?: boolean }>
}
export interface AssistantReadModelReference { id: string; kind: AssistantAuthorizedReadRecord['kind']; title: string; text: string; dataOnly: true; aiProcessingBlocked?: true; truncated?: true }
export interface AssistantAuthenticatedReadResult {
  externalModelReady: false; writeActionsEnabled: false;
  userId: string; topic: AuthenticatedAssistantReadTopic; scope: AuthenticatedAssistantReadScope;
  readAt: string; timeZone: 'Europe/Kyiv'; audience: 'student' | 'teacher'; accessRevision: string;
  groupCapabilities: { groupId: string; permissions: AssistantGroupPermission[] }[];
  teachingScopes: { groupId: string; courseId: string; subjectId: string; permissions: AssistantTeachingPermission[] }[];
  records: AssistantAuthorizedReadRecord[]; truncated: boolean;
  modelContext: { references: AssistantReadModelReference[]; dataOnly: true }
  gradeSummary?: AssistantGradeSummary[]
}
export class AssistantReadError extends Error {
  readonly code: string; readonly status: number
  constructor(code: string, status: number) { super(code); this.name = 'AssistantReadError'; this.code = code; this.status = status }
}

const GROUP_PERMISSIONS: AssistantGroupPermission[] = ['schedule', 'homework', 'seminars', 'seminar_resources', 'materials']
const TEACHING_PERMISSIONS: AssistantTeachingPermission[] = ['materials', 'assignments', 'grades', 'manage']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
function fail(code: string, status = 403): never { throw new AssistantReadError(code, status) }
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000'
const identifier = (value: unknown, code = 'invalid_request') => isId(value) ? value.toLowerCase() : fail(code, code === 'invalid_request' ? 400 : 503)
const boundedText = (value: unknown, max: number, required = false): string => {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || required && !value.trim()) fail('repository_invalid_response', 503)
  return value.slice(0, max)
}
const instant = (value: unknown): number => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && dateValue(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN
const dateValue = (value: unknown): value is string => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const clockTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) fail('request_cancelled', 499) }
const safePermissions = <T extends string>(value: unknown, allowed: T[]): T[] => {
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string')) fail('repository_invalid_access', 503)
  return allowed.filter(permission => value.includes(permission))
}

function normalizedRequest(value: unknown, now: number) {
  if (!object(value) || !exact(value, ['topic', 'scope', 'limit']) || !AUTHENTICATED_ASSISTANT_READ_TOPICS.includes(value.topic as AuthenticatedAssistantReadTopic)) fail('invalid_request', 400)
  const topic = value.topic as AuthenticatedAssistantReadTopic
  const input = value.scope === undefined ? {} : value.scope
  if (!object(input) || !exact(input, ['groupId', 'courseId', 'subjectId', 'from', 'to', 'period', 'query', 'workspaceId', 'space'])) fail('invalid_request', 400)
  const scope: AuthenticatedAssistantReadScope = {}
  for (const key of ['groupId', 'courseId', 'subjectId'] as const) if (input[key] !== undefined) scope[key] = identifier(input[key])
  if (input.period !== undefined && !['current', 'archive', 'all'].includes(input.period as string)) fail('invalid_request', 400)
  scope.period = input.period as AuthenticatedAssistantReadScope['period'] ?? 'current'
  if(input.query!==undefined){if(typeof input.query!=='string'||input.query.length>6000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.query))fail('invalid_request',400);scope.query=input.query.replace(/\s+/gu,' ').trim()}
  if(input.workspaceId!==undefined)scope.workspaceId=identifier(input.workspaceId)
  if(input.space!==undefined){if(topic!=='organizer'||!['personal','shared','all'].includes(input.space as string))fail('invalid_request',400);scope.space=input.space as 'personal'|'shared'|'all'}
  if(scope.workspaceId&&topic!=='organizer')fail('invalid_request',400)
  if(scope.workspaceId)scope.space='shared'
  if (topic === 'study' || topic === 'teaching' || topic === 'seminars') {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
    const from = input.from ?? today, to = input.to ?? from
    if (!dateValue(from) || !dateValue(to) || to < from || (Date.parse(to) - Date.parse(from)) / 86400000 >= AUTHENTICATED_ASSISTANT_READ_LIMITS.days) fail('invalid_date_range', 400)
    scope.from = from; scope.to = to
  } else if (input.from !== undefined || input.to !== undefined) fail('invalid_request', 400)
  if (['study', 'results', 'materials', 'gradebook', 'seminars'].includes(topic) && !scope.groupId) fail('group_required', 400)
  if(['organizer','community','news','opportunities','help'].includes(topic)&&(scope.groupId||scope.courseId||scope.subjectId))fail('invalid_request',400)
  // A teaching course and the group's study subject are different identifiers.
  if (['study', 'results'].includes(topic) && scope.courseId) fail('study_subject_required', 400)
  if (topic === 'gradebook' && !scope.courseId) fail('course_required', 400)
  const limit = value.limit === undefined ? AUTHENTICATED_ASSISTANT_READ_LIMITS.defaultRows : value.limit
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > AUTHENTICATED_ASSISTANT_READ_LIMITS.rows) fail('invalid_limit', 400)
  return { topic, scope, limit: limit as number }
}

function checkedSession(value: VerifiedAssistantSession | null, now: number): VerifiedAssistantSession {
  if (!value || !isId(value.userId) || value.accountActive !== true || value.emailConfirmed !== true || !Number.isFinite(instant(value.expiresAt)) || instant(value.expiresAt) <= now
    || value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value.sessionId))) fail('session_invalid', 401)
  return { userId: value.userId.toLowerCase(), expiresAt: value.expiresAt, accountActive: true, emailConfirmed: true, ...(value.sessionId ? { sessionId: value.sessionId } : {}) }
}

function checkedAccess(value: AssistantReadAccess, userId: string): AssistantReadAccess {
  if (!value || value.userId !== userId || typeof value.revision !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value.revision)
    || !Array.isArray(value.memberships) || value.memberships.length > AUTHENTICATED_ASSISTANT_READ_LIMITS.memberships
    || !Array.isArray(value.teachingGrants) || value.teachingGrants.length > AUTHENTICATED_ASSISTANT_READ_LIMITS.teachingGrants) fail('repository_invalid_access', 503)
  const memberships = value.memberships.map(row => {
    if (!row || row.userId !== userId || !isId(row.groupId) || !isId(row.representativeId) || !['accepted', 'pending', 'declined', 'removed'].includes(row.membershipStatus)
      || !Array.isArray(row.subjectIds) || row.subjectIds.length > 100 || row.subjectIds.some(id => !isId(id))) fail('repository_invalid_access', 503)
    if (row.deputy && !['approved', 'pending', 'revoked', 'rejected', 'cancelled'].includes(row.deputy.status)) fail('repository_invalid_access', 503)
    return { userId, groupId: row.groupId.toLowerCase(), representativeId: row.representativeId.toLowerCase(), membershipStatus: row.membershipStatus,
      subjectIds: [...new Set(row.subjectIds.map(id => id.toLowerCase()))].sort(),
      ...(row.deputy ? { deputy: { status: row.deputy.status, permissions: safePermissions(row.deputy.permissions, GROUP_PERMISSIONS) } } : {}) }
  })
  if (new Set(memberships.map(row => row.groupId)).size !== memberships.length) fail('repository_invalid_access', 503)
  const teachingGrants = value.teachingGrants.map(row => {
    if (!row || row.userId !== userId || !isId(row.groupId) || !isId(row.courseId) || !isId(row.subjectId)
      || !['accepted', 'pending_teacher', 'pending_group', 'removed', 'rejected'].includes(row.connectionStatus)
      || typeof row.teacherVerified !== 'boolean' || typeof row.teacherHasCurrentAccess !== 'boolean'
      || row.validFrom != null && !Number.isFinite(instant(row.validFrom)) || row.validUntil != null && !Number.isFinite(instant(row.validUntil))) fail('repository_invalid_access', 503)
    return { userId, groupId: row.groupId.toLowerCase(), courseId: row.courseId.toLowerCase(), subjectId: row.subjectId.toLowerCase(), connectionStatus: row.connectionStatus,
      teacherVerified: row.teacherVerified, teacherHasCurrentAccess: row.teacherHasCurrentAccess, permissions: safePermissions(row.permissions, TEACHING_PERMISSIONS),
      validFrom: row.validFrom ?? null, validUntil: row.validUntil ?? null }
  })
  if (new Set(teachingGrants.map(row => `${row.groupId}/${row.courseId}`)).size !== teachingGrants.length) fail('repository_invalid_access', 503)
  return { userId, revision: value.revision, memberships, teachingGrants }
}

function authorization(access: AssistantReadAccess, request: ReturnType<typeof normalizedRequest>, now: number) {
  const { topic, scope } = request
  const member = access.memberships.find(row => row.groupId === scope.groupId && row.membershipStatus === 'accepted')
  const grants = access.teachingGrants.filter(row => row.connectionStatus === 'accepted' && row.teacherVerified && row.teacherHasCurrentAccess
    && (row.validFrom === null || instant(row.validFrom) <= now) && (row.validUntil === null || instant(row.validUntil) > now)
    && (!scope.groupId || row.groupId === scope.groupId) && (!scope.courseId || row.courseId === scope.courseId) && (!scope.subjectId || row.subjectId === scope.subjectId))
  let audience: AssistantCallerReadQuery['audience'], selections: AssistantReadSelection[]
  if(['organizer','community','news','opportunities','help'].includes(topic))return {audience:'student' as const,selections:[],groupCapabilities:[],teachingScopes:[]}
  if(topic==='seminars'&&(scope.courseId||grants.some(g=>g.groupId===scope.groupId)))fail('teacher_seminar_private')
  if (topic === 'study' || topic === 'results' || topic === 'seminars' || topic === 'materials' && member && !scope.courseId) {
    if (!member || scope.subjectId && !member.subjectIds.includes(scope.subjectId)) fail('access_denied')
    audience = 'student'
    selections = [{ groupId: member.groupId, ...(scope.subjectId ? { subjectId: scope.subjectId } : {}), allowedSubjectIds: member.subjectIds }]
  } else {
    const permission = topic === 'gradebook' ? 'grades' : topic === 'materials' ? 'materials' : null
    const allowed = grants.filter(grant => !permission || grant.permissions.includes(permission))
    if (!allowed.length) fail('access_denied')
    audience = 'teacher'; selections = allowed.map(({ groupId, courseId, subjectId }) => ({ groupId, courseId, subjectId }))
  }
  if (selections.length > AUTHENTICATED_ASSISTANT_READ_LIMITS.selections) fail('scope_too_large', 400)
  selections.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const groupCapabilities = member && audience === 'student' ? [{ groupId: member.groupId,
    permissions: member.representativeId === access.userId ? [...GROUP_PERMISSIONS] : member.deputy?.status === 'approved' ? member.deputy.permissions : [] }] : []
  const teachingScopes = audience === 'teacher' ? grants.filter(grant => selections.some(row => row.groupId === grant.groupId && row.courseId === grant.courseId))
    .map(({ groupId, courseId, subjectId, permissions }) => ({ groupId, courseId, subjectId, permissions })).sort((a, b) => `${a.groupId}/${a.courseId}`.localeCompare(`${b.groupId}/${b.courseId}`)) : []
  return { audience, selections, groupCapabilities, teachingScopes }
}

function projectRecord(raw: AssistantAuthorizedReadRecord, query: AssistantCallerReadQuery): AssistantAuthorizedReadRecord {
  if(['seminars','organizer','community','news','opportunities','help'].includes(query.topic))return projectExtendedStudyRecord(raw,query)
  if (!object(raw) || !isId(raw.id) || !isId(raw.groupId) || !isId(raw.subjectId) || raw.courseId !== undefined && !isId(raw.courseId)
    || raw.version !== undefined && (!Number.isInteger(raw.version) || raw.version < 0) || raw.archived !== undefined && typeof raw.archived !== 'boolean') fail('repository_invalid_response', 503)
  const match = query.selections.some(selection => selection.groupId === raw.groupId && (!selection.courseId || selection.courseId === raw.courseId)
    && (!selection.subjectId || selection.subjectId === raw.subjectId) && (!selection.allowedSubjectIds || selection.allowedSubjectIds.includes(raw.subjectId)))
  if (!match || query.period === 'current' && raw.archived === true || query.period === 'archive' && raw.archived !== true) fail('repository_scope_violation', 503)
  const base = { id: raw.id, groupId: raw.groupId, subjectId: raw.subjectId, ...(raw.courseId ? { courseId: raw.courseId } : {}),
    ...(raw.version !== undefined ? { version: raw.version } : {}), archived: raw.archived === true,
    ...(raw.sourcePath!==undefined?{sourcePath:assistantSourcePath(raw.sourcePath)}:{}),...(raw.subjectName!==undefined?{subjectName:boundedText(raw.subjectName,240)}:{}),...(raw.teacherName!==undefined?{teacherName:boundedText(raw.teacherName,240)}:{}) }
  const title = boundedText(raw.title, 300, true)
  if (raw.kind === 'lesson' && ['study', 'teaching'].includes(query.topic)) {
    if (!dateValue(raw.date) || !clockTime(raw.startsAt) || !clockTime(raw.endsAt) || raw.endsAt <= raw.startsAt || raw.date < query.from! || raw.date > query.to!
      || raw.scheduleId !== undefined && !isId(raw.scheduleId)) fail('repository_scope_violation', 503)
    if (raw.links !== undefined && (!Array.isArray(raw.links) || raw.links.length > 10)) fail('repository_invalid_response', 503)
    const links = (raw.links ?? []).map(value => {
      if (typeof value !== 'string' || value.length > 2000) fail('repository_invalid_response', 503)
      let parsed: URL; try { parsed = new URL(value) } catch { return fail('repository_invalid_response', 503) }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('repository_invalid_response', 503)
      return value
    })
    return { ...base, kind: 'lesson', date: raw.date, title, startsAt: raw.startsAt, endsAt: raw.endsAt, links,
      ...(raw.scheduleId ? { scheduleId: raw.scheduleId } : {}),
      ...(raw.location !== undefined ? { location: boundedText(raw.location, 300) } : {}),
      ...(raw.conferenceId !== undefined ? { conferenceId: boundedText(raw.conferenceId, 180) } : {}),
      ...(raw.accessCode !== undefined ? { accessCode: boundedText(raw.accessCode, 180) } : {}) }
  }
  if (raw.kind === 'homework' && query.topic === 'study') {
    if (!dateValue(raw.date) || raw.date < query.from! || raw.date > query.to! || raw.published !== true || raw.lessonId !== undefined && !isId(raw.lessonId)
      || raw.dueAt !== null && !Number.isFinite(instant(raw.dueAt))) fail('repository_scope_violation', 503)
    return { ...base, kind: 'homework', date: raw.date, title, body: boundedText(raw.body, AUTHENTICATED_ASSISTANT_READ_LIMITS.bodyCharacters),
      ...(raw.body.length > AUTHENTICATED_ASSISTANT_READ_LIMITS.bodyCharacters ? { bodyTruncated: true } : {}), dueAt: raw.dueAt, published: true,
      ...(raw.lessonId ? { lessonId: raw.lessonId } : {}) }
  }
  if (raw.kind === 'material' && query.topic === 'materials') {
    if (typeof raw.published !== 'boolean' || query.audience === 'student' && !raw.published || typeof raw.allowAi !== 'boolean' || typeof raw.allowDownload !== 'boolean'
      || raw.fileId !== undefined && !isId(raw.fileId)) fail('repository_scope_violation', 503)
    if(raw.materialId!==undefined&&!isId(raw.materialId)||raw.materialSourceKind!==undefined&&!['study','teaching'].includes(raw.materialSourceKind)||raw.rightsVersion!==undefined&&!/^[a-f\d]{32}$/.test(raw.rightsVersion))fail('repository_invalid_response',503)
    return { ...base, kind: 'material', title, body: boundedText(raw.body, AUTHENTICATED_ASSISTANT_READ_LIMITS.bodyCharacters),
      ...(raw.body.length > AUTHENTICATED_ASSISTANT_READ_LIMITS.bodyCharacters ? { bodyTruncated: true } : {}), published: raw.published, allowAi: raw.allowAi, allowDownload: raw.allowDownload,
      ...(raw.fileId ? { fileId: raw.fileId } : {}), ...(raw.fileName !== undefined ? { fileName: boundedText(raw.fileName, 180) } : {}),
      ...(raw.materialId?{materialId:identifier(raw.materialId,'repository_invalid_response')}:{}),...(raw.materialSourceKind?{materialSourceKind:raw.materialSourceKind}:{}),...(raw.rightsVersion?{rightsVersion:boundedText(raw.rightsVersion,100)}:{}) }
  }
  if (raw.kind === 'grade' && ['results', 'gradebook'].includes(query.topic)) {
    if (!isId(raw.studentId) || !isId(raw.activityId) || !Number.isFinite(raw.points) || raw.points < 0 || raw.points > 1000000
      || !Number.isFinite(raw.maxPoints) || raw.maxPoints <= 0 || raw.maxPoints > 1000000 || raw.points > raw.maxPoints
      || !Number.isFinite(raw.coefficient) || raw.coefficient < 0 || raw.coefficient > 100 || typeof raw.published !== 'boolean'
      || query.topic === 'results' && (raw.studentId !== query.studentId || !raw.published)) fail('repository_scope_violation', 503)
    if(raw.gradingRules){try{validateTeachingGradingRules(raw.gradingRules)}catch{return fail('repository_invalid_response',503)}}
    return { ...base, kind: 'grade', studentId: raw.studentId, activityId: raw.activityId, title, points: raw.points, maxPoints: raw.maxPoints, coefficient: raw.coefficient, published: raw.published,
      ...(raw.category!==undefined?{category:boundedText(raw.category,100)}:{}),...(raw.gradingRules?{gradingRules:structuredClone(raw.gradingRules)}:{}),...(query.topic==='gradebook'&&raw.studentName!==undefined?{studentName:boundedText(raw.studentName,240)}:{}) }
  }
  return fail('repository_scope_violation', 503)
}

function modelReferences(records: AssistantAuthorizedReadRecord[], topic: AuthenticatedAssistantReadTopic): AssistantReadModelReference[] {
  if (topic === 'gradebook') {
    // A teacher may view grades, but the model does not need a student roster or
    // identifiable grade rows to explain this authorized read.
    const groups = new Map<string, { title: string; count: number; sum: number }>()
    for (const row of records) if (row.kind === 'grade') {
      const value = groups.get(row.activityId) ?? { title: row.title, count: 0, sum: 0 }; value.count++; value.sum += row.points; groups.set(row.activityId, value)
    }
    return [...groups].map(([id, row]) => ({ id, kind: 'grade', title: row.title, text: `Кількість записів: ${row.count}. Сума балів у вибірці: ${row.sum}.`, dataOnly: true }))
  }
  return records.map(row => {
    let text: string
    if (row.kind === 'material') {
      if (!row.allowAi) return { id: row.id, kind: row.kind, title: row.title, text: 'Автор не дозволив передавати вміст матеріалу ШІ.', dataOnly: true as const, aiProcessingBlocked: true as const }
      text = row.body.slice(0, AUTHENTICATED_ASSISTANT_READ_LIMITS.modelBodyCharacters)
    } else if (row.kind === 'lesson') text = `${row.date} ${row.startsAt}–${row.endsAt}${row.location ? ` · ${row.location}` : ''}`
    else if (row.kind === 'homework') text = `${row.date}: ${row.body.slice(0, AUTHENTICATED_ASSISTANT_READ_LIMITS.modelBodyCharacters)}${row.dueAt ? ` · Термін: ${row.dueAt}` : ''}`
    else if(row.kind==='grade') text = `${row.points}/${row.maxPoints} · Коефіцієнт: ${row.coefficient}`
    else text=row.body.slice(0,AUTHENTICATED_ASSISTANT_READ_LIMITS.modelBodyCharacters)
    const truncated = (row.kind === 'material' || row.kind === 'homework') && (row.bodyTruncated || row.body.length > AUTHENTICATED_ASSISTANT_READ_LIMITS.modelBodyCharacters)
    return { id: row.id, kind: row.kind, title: row.title, text, dataOnly: true as const, ...(truncated ? { truncated: true as const } : {}) }
  })
}

function checkedPage(page: Awaited<ReturnType<AssistantReadRepository['readPage']>>, query: AssistantCallerReadQuery) {
  if (!page || !Array.isArray(page.rows) || page.rows.length > query.limit || page.hasMore !== undefined && typeof page.hasMore !== 'boolean') fail('repository_invalid_response', 503)
  // Inspect the extra row as well; pagination never hides an ACL violation.
  const rows = page.rows.map(row => projectRecord(row, query))
  if (new Set(rows.map(row => `${row.kind}/${row.id}`)).size !== rows.length) fail('repository_invalid_response', 503)
  return { rows, hasMore: page.hasMore === true }
}

export function createAuthenticatedAssistantReadService(dependencies: {
  verifySession: (credential: string, signal?: AbortSignal) => Promise<VerifiedAssistantSession | null>;
  createCallerRepository: (session: VerifiedAssistantSession, credential: string) => Promise<AssistantReadRepository> | AssistantReadRepository;
  now?: () => number;
}) {
  if (typeof dependencies.verifySession !== 'function' || typeof dependencies.createCallerRepository !== 'function') throw new TypeError('authenticated_read_dependencies_required')
  const clock = dependencies.now ?? Date.now
  const now = () => { const value = clock(); return Number.isFinite(value) ? value : fail('clock_unavailable', 503) }
  return {
    async read(credential: string, input: unknown, signal?: AbortSignal): Promise<AssistantAuthenticatedReadResult> {
      cancelled(signal)
      const start = now()
      const request = normalizedRequest(input, start)
      if (typeof credential !== 'string' || credential.length < 16 || credential.length > 8192 || /\s/.test(credential)) fail('session_invalid', 401)
      let session: VerifiedAssistantSession
      try { session = checkedSession(await dependencies.verifySession(credential, signal), now()) } catch (error) { if (error instanceof AssistantReadError) throw error; return fail('session_unavailable', 503) }
      cancelled(signal)
      let repository: AssistantReadRepository
      try { repository = await dependencies.createCallerRepository(session, credential) } catch { return fail('repository_unavailable', 503) }
      if (!repository || typeof repository.readAccess !== 'function' || typeof repository.readPage !== 'function') fail('repository_unavailable', 503)
      const accessOptions = { userId: session.userId, membershipLimit: AUTHENTICATED_ASSISTANT_READ_LIMITS.memberships + 1, teachingGrantLimit: AUTHENTICATED_ASSISTANT_READ_LIMITS.teachingGrants + 1, signal }
      let access: AssistantReadAccess, permit: ReturnType<typeof authorization>
      try { access = checkedAccess(await repository.readAccess(accessOptions), session.userId); permit = authorization(access, request, now()) }
      catch (error) { if (error instanceof AssistantReadError) throw error; return fail('repository_unavailable', 503) }
      cancelled(signal)
      const query: AssistantCallerReadQuery = { topic: request.topic, audience: permit.audience, selections: permit.selections, period: request.scope.period!,
        ...(request.scope.from ? { from: request.scope.from, to: request.scope.to } : {}), ...(request.topic === 'results' ? { studentId: session.userId } : {}),
        userId:session.userId,...(request.scope.query?{query:request.scope.query}:{}),...(request.scope.workspaceId?{workspaceId:request.scope.workspaceId}:{}),...(request.scope.space?{space:request.scope.space}:{}),groupPermissions:permit.groupCapabilities.flatMap(g=>g.permissions),
        limit: request.limit + 1, accessRevision: access.revision, signal }
      let page: Awaited<ReturnType<AssistantReadRepository['readPage']>>
      try { page = await repository.readPage(query) } catch { return fail('repository_unavailable', 503) }
      cancelled(signal)
      const projected = checkedPage(page, query)
      if (['materials','organizer','seminars'].includes(request.topic)) {
        // Permission revisions do not describe material content/protection.
        // A second bounded read catches an author's policy/file/version change
        // during retrieval. This is still a local preparation boundary: an
        // eventual provider dispatch must separately approve its data policy.
        let latestPage: Awaited<ReturnType<AssistantReadRepository['readPage']>>
        try { latestPage = await repository.readPage(query) } catch { return fail('repository_unavailable', 503) }
        cancelled(signal)
        if (JSON.stringify(checkedPage(latestPage, query)) !== JSON.stringify(projected)) fail(request.topic==='materials'?'material_changed':'access_changed', 409)
      }
      // Revalidate after asynchronous data retrieval; no cached permission grant
      // survives a session expiry, membership removal or delegated-right revoke.
      try {
        const latestSession = checkedSession(await dependencies.verifySession(credential, signal), now())
        if (latestSession.userId !== session.userId || latestSession.sessionId !== session.sessionId) fail('session_changed', 401)
        const latestAccess = checkedAccess(await repository.readAccess(accessOptions), session.userId)
        const latestPermit = authorization(latestAccess, request, now())
        if (latestAccess.revision !== access.revision || JSON.stringify(latestPermit) !== JSON.stringify(permit)) fail('access_changed', 409)
        checkedSession(latestSession, now())
      } catch (error) { if (error instanceof AssistantReadError) throw error; return fail('session_or_access_unavailable', 503) }
      cancelled(signal)
      const records = projected.rows.slice(0, request.limit)
      return { externalModelReady: false, writeActionsEnabled: false, userId: session.userId, topic: request.topic, scope: request.scope, readAt: new Date(now()).toISOString(), timeZone: 'Europe/Kyiv',
        audience: permit.audience, accessRevision: access.revision, groupCapabilities: permit.groupCapabilities, teachingScopes: permit.teachingScopes,
        records, truncated: projected.hasMore || projected.rows.length > request.limit, modelContext: { references: modelReferences(records, request.topic), dataOnly: true },
        ...(request.topic==='results'?{gradeSummary:gradeSummaries(records,projected.hasMore||projected.rows.length>request.limit)}:{}) }
    },
  }
}

function gradeSummaries(records:AssistantAuthorizedReadRecord[],partial:boolean):AssistantGradeSummary[] {
  const groups=new Map<string,AssistantGradeReadRecord[]>()
  for(const r of records)if(r.kind==='grade'){const key=`${r.groupId}/${r.subjectId}/${r.courseId||''}`;groups.set(key,[...(groups.get(key)||[]),r])}
  return [...groups.values()].flatMap(rows=>{
    const rules=rows[0].gradingRules;if(!rules||rows.some(x=>JSON.stringify(x.gradingRules)!==JSON.stringify(rules)))return []
    const b=calculateTeachingBreakdown(rules,rows.map(r=>({category:r.category||'',score:r.points}))),max=Number.isFinite(b.maximum)?b.maximum:null
    return [{groupId:rows[0].groupId,subjectId:rows[0].subjectId,...(rows[0].courseId?{courseId:rows[0].courseId}:{}),title:rows[0].subjectName||'Навчальний предмет',workCount:rows.length,points:b.rawTotal,maxPoints:rows.reduce((sum,r)=>sum+r.maxPoints,0),weightedPoints:b.total,weightedMaxPoints:max,percentage:max?Math.round(b.total/max*10000)/100:null,formula:'Сума балів категорії × коефіцієнт → максимум категорії → округлення → загальний максимум',partial,categories:b.categories.map(c=>({...c,maximum:Number.isFinite(c.maximum)?c.maximum:1000000})),rounding:b.rounding}]
  })
}
