import { createHash } from 'node:crypto'
import { ownGradeSourcePath } from '../../src/lib/ownGradeNavigation.ts'
import { isStudyGroupListed, HIDDEN_TEST_STUDY_GROUP_IDS } from '../../src/lib/studyGroupVisibility.ts'
import { EXTENDED_STUDY_TOPICS, readExtendedStudyPage } from './cloudStudyRead.ts'
import { normalizeStudentElectivePlan, projectStudentElectiveTimetable, isPersonalElectiveLesson, type StudentElectivePlan } from '../../src/lib/studentElectiveTimetable.ts'
import type { AssistantReadRepository, AssistantReadAccess, AssistantCallerReadQuery, AssistantAuthorizedReadRecord, AssistantMembershipGrant, AssistantTeachingGrant, VerifiedAssistantSession } from './authenticatedRead.ts'

/** A per-request SDK client, constructed with a public project key plus the
 * verified caller's Authorization header. Never inject a service-role client.
 * No environment lookup, SDK creation, network request or logging at import. */
export interface AssistantCallerClient {
  auth: { getUser(credential?: string): Promise<{ data: { user: any }; error: unknown }> }
  from(table: string): any
  rpc(name: string, args?: Record<string, unknown>): any
  storage?: { from(bucket:string): { download(path:string):Promise<{data:Blob|null;error:unknown}> } }
}
export interface SupabaseAssistantCatalog {
  userId: string
  defaultLearningGroupId?: string
  groups: { id: string; name: string; program: string; studyYear: number; learning: boolean; permissions: string[]; testGroup?: boolean }[]
  subjects: { id: string; groupId: string; name: string; kind: 'study' | 'materials' | 'teacher' }[]
  courses: { id: string; name: string; groupIds: string[]; subjects: { groupId: string; subjectId: string }[]; permissions: string[]; archived: boolean; teaching: boolean; teachingGroupIds: string[] }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GROUP_COLUMNS = 'id,group_name,specialty,representative_id,cohort_start_year,study_level'
const SCHEDULE_COLUMNS = 'id,group_id,weekday,starts_at,ends_at,subject,teacher_name,lesson_type,location,online_url,online_url_secondary,online_links_extra,conference_id,conference_access_code,valid_from,valid_until,week_pattern,week_anchor_date,excluded_dates,updated_at,is_elective_block'
const MAX_ROWS = 1000
const DAY = 86400000
const testGroupIds=new Set<string>(HIDDEN_TEST_STUDY_GROUP_IDS)
/** Concurrency is request-local and bounded. No permission snapshot is cached
 * across requests or reused for the required final access revalidation. */
async function groupBatch<T,R>(items:T[],read:(item:T)=>Promise<R>):Promise<R[]> {
  const results:R[]=[]
  for(let start=0;start<items.length;start+=4)results.push(...await Promise.all(items.slice(start,start+4).map(read)))
  return results
}
const permissionIds = ['schedule', 'homework', 'seminars', 'seminar_resources', 'materials']
const teacherPermissions = ['materials', 'assignments', 'grades', 'manage']
const bad = (code = 'assistant_read_repository_unavailable'): never => { throw Object.assign(new Error(code), { code, status: 503 }) }
const id = (value: unknown): string => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : bad('assistant_read_repository_invalid')
const rows = (value: unknown, maximum = MAX_ROWS): any[] => Array.isArray(value) && value.length <= maximum && value.every(row => row && typeof row === 'object' && !Array.isArray(row)) ? value : bad('assistant_read_repository_invalid')
const plain = (value: unknown, maximum = 300): string => typeof value === 'string' ? value.slice(0, maximum) : ''
const key = (value: unknown) => plain(value, 500).trim().replace(/\s+/gu, ' ').toLowerCase()
const date = (value: unknown): value is string => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const deadline = (value: unknown): string|null => {
  if(value===undefined||value===null)return null
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||!date(value.slice(0,10))||!Number.isFinite(Date.parse(value)))return bad('assistant_read_repository_invalid')
  return value
}
const version = (row: any) => Number.isInteger(row.version) && row.version > 0 ? row.version : Number.isFinite(Date.parse(row.updated_at)) ? Date.parse(row.updated_at) : 1
const shift = (value: string, count: number) => new Date(Date.parse(value + 'T12:00:00Z') + count * DAY).toISOString().slice(0, 10)
const monday = (value: string) => shift(value, 1 - (new Date(value + 'T12:00:00Z').getUTCDay() || 7))
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const coefficient = (rules: any, category: unknown) => {
  const found = Array.isArray(rules?.categories) ? rules.categories.find((row: any) => row.id === category) : undefined
  return typeof found?.coefficient === 'number' && Number.isFinite(found.coefficient) && found.coefficient >= 0 && found.coefficient <= 100 ? found.coefficient : 1
}
export function assistantOccurrenceId(scheduleId: string, lessonDate: string): string {
  const bytes = createHash('sha256').update('xelay:assistant:occurrence:').update(id(scheduleId)).update(':').update(lessonDate).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
function personalElectiveOccurrenceId(ownerId:string,planId:string,meetingId:string,day:string):string {
  const bytes=createHash('sha256').update('xelay:assistant:personal-elective-occurrence:').update(id(ownerId)).update(':').update(id(planId)).update(':').update(id(meetingId)).update(':').update(day).digest().subarray(0,16)
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128
  const hex=bytes.toString('hex')
  return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
function occurs(row: any, lessonDate: string): boolean {
  if (!date(lessonDate) || !Number.isInteger(row.weekday) || row.weekday < 1 || row.weekday > 7
    || !date(row.valid_from) && row.valid_from !== '-infinity' || !date(row.valid_until) && row.valid_until !== 'infinity'
    || row.excluded_dates !== undefined && (!Array.isArray(row.excluded_dates) || row.excluded_dates.some((value: unknown) => !date(value)))) return false
  if (row.excluded_dates?.includes(lessonDate) || (new Date(lessonDate + 'T12:00:00Z').getUTCDay() || 7) !== row.weekday
    || row.valid_from !== '-infinity' && lessonDate < row.valid_from || row.valid_until !== 'infinity' && lessonDate > row.valid_until) return false
  const pattern = row.week_pattern || 'every'
  if (pattern === 'every') return true
  if (!['upper', 'lower'].includes(pattern) || !date(row.week_anchor_date) || monday(row.week_anchor_date) !== row.week_anchor_date) return false
  const offset = Math.round((Date.parse(monday(lessonDate)) - Date.parse(row.week_anchor_date)) / (7 * DAY))
  return (((offset % 2) + 2) % 2 === 0 ? 'upper' : 'lower') === pattern
}
function safeLinks(row: any): string[] {
  return [...new Set([row.online_url, row.online_url_secondary, ...(Array.isArray(row.online_links_extra) ? row.online_links_extra.map((entry: any) => entry?.url) : [])].filter(value => {
    if (typeof value !== 'string' || value.length > 2000) return false
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
  }))].slice(0, 10) as string[]
}
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw Object.assign(new Error('request_cancelled'), { code: 'request_cancelled', status: 499 }) }

/** getUser is the authority; decoding exp/sub happens only AFTER that request
 * succeeded. The narrow existing classroom RPC asserts active/confirmed account
 * using auth.users, including deletion and bans. No broad admin status RPC. */
export async function verifySupabaseAssistantSession(client: AssistantCallerClient, credential: string, now = Date.now()): Promise<VerifiedAssistantSession | null> {
  try {
    if (typeof credential !== 'string' || credential.length > 8192 || credential.split('.').length !== 3) return null
    const result = await client.auth.getUser(credential)
    if (result.error || !result.data?.user?.id || !result.data.user.email_confirmed_at) return null
    const claims = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString('utf8'))
    if (claims.sub !== result.data.user.id || claims.role !== 'authenticated' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now) return null
    const active = await client.rpc('xelay_classroom_workspace')
    if (active.error || !active.data || !Array.isArray(active.data.classrooms)) return null
    rows(active.data.classrooms, 100)
    return { userId: id(result.data.user.id), expiresAt: new Date(claims.exp * 1000).toISOString(), accountActive: true, emailConfirmed: true,
      ...(typeof claims.session_id === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(claims.session_id) ? { sessionId: claims.session_id } : {}) }
  } catch { return null }
}

export function createSupabaseAssistantReadRepository(options: { client: AssistantCallerClient; userId: string; credential?: string; now?: () => number; verifiedSession?: VerifiedAssistantSession }): AssistantReadRepository & { catalog(signal?: AbortSignal): Promise<SupabaseAssistantCatalog> } {
  const client = options.client, userId = id(options.userId), now = options.now || Date.now
  // Private per-request handoff from the immediately preceding verified caller.
  // It can replace only the first, redundant identity lookup. Every final check
  // and every subsequent access() still performs fresh authoritative reads.
  let initialIdentity=options.verifiedSession?structuredClone(options.verifiedSession):undefined
  if(initialIdentity&&(initialIdentity.userId!==userId||initialIdentity.accountActive!==true||initialIdentity.emailConfirmed!==true||!Number.isFinite(Date.parse(initialIdentity.expiresAt))||Date.parse(initialIdentity.expiresAt)<=now()))bad('assistant_account_changed')
  let lastAccess: AssistantReadAccess | null = null
  let lastAccessStudyGroupId:string|undefined
  let lastAccessPublicOnly=false
  let latestCatalog: SupabaseAssistantCatalog | null = null
  let latestCourseRows = new Map<string, any>()
  const readResult = (value: any) => {
    if (!value || value.error) bad()
    if (Buffer.byteLength(JSON.stringify(value.data ?? null)) > 4_000_000) bad('assistant_read_repository_too_large')
    return value.data
  }
  async function assertUser(signal?: AbortSignal) {
    abort(signal)
    const result = await client.auth.getUser(options.credential)
    abort(signal)
    if (result.error || result.data?.user?.id !== userId || !result.data.user.email_confirmed_at) bad('assistant_account_changed')
  }
  const rpc = async (name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<any> => {
    abort(signal)
    const call = client.rpc(name, args)
    const value = readResult(await (signal && typeof call.abortSignal === 'function' ? call.abortSignal(signal) : call))
    abort(signal); return value
  }
  async function table(tableName: string, columns: string, filter: (query: any) => any, maximum: number, signal?: AbortSignal): Promise<any[]> {
    const output: any[] = []; let after = ''
    const cap = Math.min(MAX_ROWS + 1, maximum)
    while (true) {
      abort(signal)
      const requested = Math.min(100, cap + 1 - output.length)
      let query = filter(client.from(tableName).select(columns)).order('id', { ascending: true }).limit(requested)
      if (after) query = query.gt('id', after)
      if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
      const page = rows(readResult(await query), Math.min(100, cap + 1 - output.length))
      abort(signal)
      if (!page.length) return output
      if (page.some(row => !UUID.test(row.id) || after && row.id.toLowerCase() <= after)) bad('assistant_read_repository_invalid')
      const ids = page.map(row => id(row.id))
      if (new Set(ids).size !== ids.length || ids.some((value, index) => index && value <= ids[index - 1])) bad('assistant_read_repository_invalid')
      output.push(...page)
      if (output.length > cap) bad('assistant_read_repository_too_large')
      after = ids[ids.length - 1]!
      if (page.length < requested) return output
    }
  }
  async function access(signal?: AbortSignal, membershipLimit = 101, teachingLimit = 201,studyGroupId?:string,publicOnly=false): Promise<AssistantReadAccess> {
    if (!Number.isInteger(membershipLimit) || membershipLimit < 1 || membershipLimit > 101 || !Number.isInteger(teachingLimit) || teachingLimit < 1 || teachingLimit > 201) bad('assistant_read_repository_invalid')
    if(studyGroupId!==undefined&&!UUID.test(studyGroupId))bad('assistant_read_repository_scope_violation')
    if(typeof publicOnly!=='boolean'||publicOnly&&studyGroupId!==undefined)bad('assistant_read_repository_scope_violation')
    if(initialIdentity){const verified=initialIdentity;initialIdentity=undefined;abort(signal);if(Date.parse(verified.expiresAt)<=now())bad('assistant_account_changed')}
    else await assertUser(signal)
    if(publicOnly){
      // Published group-free topics do not use membership/course grants at all.
      // Retain both caller identity and the authoritative active-account RPC;
      // this snapshot is explicitly unusable for private/group/organizer data.
      const [,classroom]=await Promise.all([assertUser(signal),rpc('xelay_classroom_workspace',undefined,signal)])
      rows(classroom.classrooms,100)
      const result={userId,memberships:[],teachingGrants:[],revision:fingerprint({memberships:[],teachingGrants:[]})}
      lastAccess=result;lastAccessStudyGroupId=undefined;lastAccessPublicOnly=true
      latestCatalog={userId,groups:[],subjects:[],courses:[]};latestCourseRows=new Map()
      return result
    }
    const [memberships, owned, deputies, classroom] = await Promise.all([
      table('study_group_members', 'id,group_id,user_id,status', query => {const q=query.eq('user_id',userId).eq('status','accepted');return studyGroupId?q.eq('group_id',studyGroupId):q}, membershipLimit, signal),
      table('study_groups', GROUP_COLUMNS, query => {const q=query.eq('representative_id',userId);return studyGroupId?q.eq('id',studyGroupId):q}, membershipLimit, signal),
      table('study_group_deputy_requests', 'id,group_id,user_id,status,permissions', query => {const q=query.eq('user_id',userId).eq('status','approved');return studyGroupId?q.eq('group_id',studyGroupId):q}, membershipLimit, signal),
      // A normalized student timetable read needs no teaching grants from
      // unrelated groups. The service still checks live account activity before
      // and after retrieval; all membership/deputy rows here remain fresh.
      studyGroupId?Promise.resolve({classrooms:[]}):rpc('xelay_classroom_workspace', undefined, signal),
    ])
    if (memberships.some(row => row.user_id !== userId || row.status !== 'accepted') || owned.some(row => row.representative_id !== userId)
      || deputies.some(row => row.user_id !== userId || row.status !== 'approved')) bad('assistant_read_repository_scope_violation')
    const ownedIds = owned.map(row => id(row.id))
    const joinedIds = [...new Set(memberships.map(row => id(row.group_id)))].filter(value => !ownedIds.includes(value) && isStudyGroupListed(value, userId))
    const joined = joinedIds.length ? await table('study_groups', GROUP_COLUMNS, query => query.in('id', joinedIds), membershipLimit, signal) : []
    if (joined.some(row => !joinedIds.includes(id(row.id)))) bad('assistant_read_repository_scope_violation')
    const groups = [...owned, ...joined].filter(row => isStudyGroupListed(row.id, userId))
    if (groups.length >= membershipLimit) bad('assistant_read_repository_too_large')
    const catalog: SupabaseAssistantCatalog = { userId, groups: [], subjects: [], courses: [] }
    const resultMembers: AssistantMembershipGrant[] = [], resultGrants: AssistantTeachingGrant[] = []
    const courseRows = new Map<string, any>()
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(now()))
    const academicYear = Number(today.slice(0,4)) - (Number(today.slice(5,7)) < 9 ? 1 : 0)
    const groupIds=groups.map(group=>id(group.id)),groupSet=new Set(groupIds)
    const [studySubjects,materialSubjects,groupData]=await Promise.all([
      groupIds.length?table('study_group_seminar_subjects','id,group_id,name',query=>query.in('group_id',groupIds),1000,signal):Promise.resolve([]),
      groupIds.length?table('study_group_material_subjects','id,group_id,name',query=>query.in('group_id',groupIds),1000,signal):Promise.resolve([]),
      groupBatch(groups,group=>rpc('xelay_teaching_group',{p_group_id:id(group.id)},signal)),
    ])
    for(const list of [studySubjects,materialSubjects]){
      if(list.some(row=>!groupSet.has(row.group_id)))bad('assistant_read_repository_scope_violation')
      const counts=new Map<string,number>();for(const row of list){counts.set(row.group_id,(counts.get(row.group_id)||0)+1);if((counts.get(row.group_id)||0)>100)bad('assistant_read_repository_too_large')}
    }
    for (let index=0;index<groups.length;index++) {
      const group=groups[index],groupId=id(group.id),teaching=groupData[index]
      for (const [list, kind] of [[studySubjects, 'study'], [materialSubjects, 'materials']] as const) for (const subject of list.filter(row=>row.group_id===groupId)) {
        if (subject.group_id !== groupId) bad('assistant_read_repository_scope_violation')
        catalog.subjects.push({ id: id(subject.id), groupId, name: plain(subject.name, 180), kind })
      }
      for (const course of rows(teaching.courses, 200)) {
        const courseId = id(course.id), subjectId = course.subject_id && UUID.test(course.subject_id) ? id(course.subject_id) : courseId
        courseRows.set(courseId, course)
        if (!catalog.subjects.some(row => row.groupId === groupId && row.id === subjectId)) catalog.subjects.push({ id: subjectId, groupId, name: plain(course.title, 180), kind: 'teacher' })
        addCourse(catalog, course, groupId, subjectId, [])
      }
      const deputy = deputies.find(row => row.group_id === groupId)
      const perms = group.representative_id === userId ? [...permissionIds] : deputy && Array.isArray(deputy.permissions) ? permissionIds.filter(value => deputy.permissions.includes(value)) : []
      resultMembers.push({ userId, groupId, representativeId: id(group.representative_id), membershipStatus: 'accepted', subjectIds: [...new Set(catalog.subjects.filter(row => row.groupId === groupId).map(row => row.id))].sort(),
        ...(deputy ? { deputy: { status: 'approved', permissions: perms as any } } : {}) })
      const year = Number.isInteger(group.cohort_start_year) ? academicYear - group.cohort_start_year + 1 : 0
      catalog.groups.push({ id: groupId, name: plain(group.group_name, 180), program: plain(group.specialty, 240), studyYear: year >= 1 && year <= 6 ? year : 0, learning: true, permissions: perms, ...(testGroupIds.has(groupId)?{testGroup:true}:{}) })
    }
    const rooms=rows(classroom.classrooms,100).filter(room=>isStudyGroupListed(room.group_id,userId))
    const roomData=await groupBatch(rooms,room=>rpc('xelay_teaching_group_context',{p_group_id:id(room.group_id)},signal))
    for (let index=0;index<rooms.length;index++) {
      const room=rooms[index]
      const groupId = id(room.group_id)
      const contexts=roomData[index]
      if (id(contexts.group?.id || contexts.group?.group_id) !== groupId) bad('assistant_read_repository_scope_violation')
      const accepted = rows(room.courses, 200)
      for (const course of rows(contexts.courses, 200)) {
        const courseId = id(course.id)
        // A pending subject mapping is not permission to guess a subject UUID.
        // Keep other groups readable; the teaching link must be completed in
        // Xelay before this specific course can be selected by the assistant.
        if (!course.subject_id || !UUID.test(course.subject_id)) continue
        const subjectId = id(course.subject_id)
        if (!accepted.some(link => link.course_id === courseId && link.subject_id === subjectId && link.status === 'accepted')) bad('assistant_read_repository_scope_violation')
        const permissions = Array.isArray(course.permissions) ? teacherPermissions.filter(value => course.permissions.includes(value)) : []
        if (!permissions.length) continue
        resultGrants.push({ userId, groupId, courseId, subjectId, connectionStatus: 'accepted', teacherVerified: true, teacherHasCurrentAccess: true, permissions: permissions as any, validFrom: null, validUntil: null })
        courseRows.set(courseId, course)
        addCourse(catalog, course, groupId, subjectId, permissions)
        if (!catalog.subjects.some(row => row.groupId === groupId && row.id === subjectId)) catalog.subjects.push({ id: subjectId, groupId, name: plain(course.title, 180), kind: 'teacher' })
      }
      if (!catalog.groups.some(row => row.id === groupId)) catalog.groups.push({ id: groupId, name: plain(room.group_name, 180), program: plain(room.specialty, 240), studyYear: Number.isInteger(room.study_year) ? room.study_year : 0, learning: false, permissions: [], ...(testGroupIds.has(groupId)?{testGroup:true}:{}) })
    }
    if (resultGrants.length >= teachingLimit) bad('assistant_read_repository_too_large')
    resultMembers.sort((a,b) => a.groupId.localeCompare(b.groupId)); resultGrants.sort((a,b) => `${a.groupId}/${a.courseId}`.localeCompare(`${b.groupId}/${b.courseId}`))
    const regularLearning=catalog.groups.filter(group=>group.learning&&!testGroupIds.has(group.id))
    if(regularLearning.length===1)catalog.defaultLearningGroupId=regularLearning[0].id
    const result = { userId, memberships: resultMembers, teachingGrants: resultGrants, revision: fingerprint({ memberships: resultMembers, teachingGrants: resultGrants }) }
    lastAccess = result; lastAccessStudyGroupId=studyGroupId;lastAccessPublicOnly=false;latestCatalog = catalog; latestCourseRows = courseRows
    await assertUser(signal)
    return result
  }
  function addCourse(catalog: SupabaseAssistantCatalog, course: any, groupId: string, subjectId: string, permissions: string[]) {
    const courseId = id(course.id)
    let item = catalog.courses.find(row => row.id === courseId)
    if (!item) { item = { id: courseId, name: plain(course.title, 180), groupIds: [], subjects: [], permissions: [], archived: !!course.archived_at, teaching: false, teachingGroupIds: [] }; catalog.courses.push(item) }
    if (!item.groupIds.includes(groupId)) item.groupIds.push(groupId)
    if (!item.subjects.some(row => row.groupId === groupId && row.subjectId === subjectId)) item.subjects.push({ groupId, subjectId })
    item.permissions = [...new Set([...item.permissions, ...permissions])].sort()
    if (permissions.length) { item.teaching = true; if (!item.teachingGroupIds.includes(groupId)) item.teachingGroupIds.push(groupId) }
  }
  const archivedAt = (value: unknown) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()))
    const year = Number(today.slice(0,4)) - (Number(today.slice(5,7)) < 9 ? 1 : 0)
    return typeof value === 'string' && date(value.slice(0,10)) && value.slice(0,10) < `${year}-09-01`
  }
  function timetableSubject(groupId: string, name: unknown): string | undefined {
    const found = latestCatalog!.subjects.filter(row => row.groupId === groupId && row.kind === 'study' && key(row.name) === key(name))
    // The schedule stores its authoritative subject label independently from
    // seminar subjects. Do not manufacture an ID or drop a valid group lesson.
    return found.length===1?found[0].id:undefined
  }
  const courseSubject = (courseId: string, groupId: string) => latestCatalog!.courses.find(row => row.id === courseId)?.subjects.find(row => row.groupId === groupId)?.subjectId || bad('assistant_subject_mapping_missing')
  const inPeriod = (record: AssistantAuthorizedReadRecord, query: AssistantCallerReadQuery) => query.period === 'all' || (query.period === 'archive' ? record.archived === true : !record.archived)

  async function readPage(query: AssistantCallerReadQuery) {
    await assertUser(query.signal)
    const extra=EXTENDED_STUDY_TOPICS.includes(query.topic as any)
    if (!lastAccess || !latestCatalog || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 101 || query.accessRevision !== lastAccess.revision || query.selections.length > 100 || !query.selections.length&&!extra || query.userId!==undefined&&query.userId!==userId) bad('assistant_read_repository_scope_violation')
    if(lastAccessStudyGroupId&&(query.topic!=='study'||query.audience!=='student'||query.selections.some(selection=>selection.groupId!==lastAccessStudyGroupId)))bad('assistant_read_repository_scope_violation')
    if(lastAccessPublicOnly&&(!['community','news','opportunities','help'].includes(query.topic)||query.audience!=='student'||query.selections.length!==0))bad('assistant_read_repository_scope_violation')
    if (['study', 'teaching','seminars'].includes(query.topic) && (!date(query.from) || !date(query.to) || query.to < query.from || Date.parse(query.to) - Date.parse(query.from) > 30 * DAY)) bad('assistant_read_date_range_invalid')
    const accessState = lastAccess!
    for (const selection of query.selections) {
      if (query.audience === 'student') {
        const member = accessState.memberships.find(row => row.groupId === selection.groupId)
        if (!member || selection.subjectId && !member.subjectIds.includes(selection.subjectId) || query.topic === 'results' && query.studentId !== userId) bad('assistant_read_repository_scope_violation')
      } else {
        const grant = accessState.teachingGrants.find(row => row.groupId === selection.groupId && row.courseId === selection.courseId && row.subjectId === selection.subjectId)
        if (!grant || query.topic === 'gradebook' && !grant.permissions.includes('grades') || query.topic === 'materials' && !grant.permissions.includes('materials')) bad('assistant_read_repository_scope_violation')
      }
    }
    if(extra){
      if(query.topic==='seminars'&&(query.audience!=='student'||query.selections.some(s=>lastAccess!.teachingGrants.some(g=>g.groupId===s.groupId&&g.connectionStatus==='accepted'&&g.teacherVerified&&g.teacherHasCurrentAccess))))bad('assistant_teacher_seminar_boundary')
      const page=await readExtendedStudyPage({client,userId,query,now});await assertUser(query.signal);return page
    }
    const result: AssistantAuthorizedReadRecord[] = []
    const push = (record: AssistantAuthorizedReadRecord) => {
      if (inPeriod(record, query) && query.selections.some(selection => selection.groupId === record.groupId && (!selection.courseId || selection.courseId === record.courseId) && (!selection.subjectId || selection.subjectId === record.subjectId))) {
        record.subjectName ||= latestCatalog!.subjects.find(s=>s.id===record.subjectId&&s.groupId===record.groupId)?.name||''
        record.sourcePath ||= query.audience==='teacher'?`/teaching?group=${record.groupId}${record.courseId?'&course='+record.courseId:''}&home=${record.kind==='grade'?'journal':record.kind==='material'?'materials':'calendar'}${'date'in record&&record.date?'&date='+record.date:''}`:record.kind==='grade'?ownGradeSourcePath(record.groupId,record.courseId):`/groups/${record.groupId}?tab=${record.kind==='material'?'materials':'schedule'}${'date'in record&&record.date?'&date='+record.date:''}`
        result.push(record)
      }
    }
    if (query.topic === 'study') {
      if (query.audience !== 'student' || !date(query.from) || !date(query.to)) bad('assistant_read_repository_scope_violation')
      for (const selection of query.selections) {
        // These reads use the same already-authorized caller/group but do not
        // depend on one another. Keep the final auth/access checks unchanged.
        const [schedule,homework,teaching]=await Promise.all([
          table('study_group_schedule', SCHEDULE_COLUMNS, call => call.eq('group_id', selection.groupId).lte('valid_from', query.to).gte('valid_until', query.from), MAX_ROWS, query.signal),
          table('study_group_homework', 'id,group_id,schedule_item_id,lesson_date,lesson_topic,body,due_at,updated_at', call => call.eq('group_id', selection.groupId).gte('lesson_date', query.from).lte('lesson_date', query.to), MAX_ROWS, query.signal),
          rpc('xelay_teaching_group',{p_group_id:selection.groupId},query.signal),
        ])
        if (schedule.some(row => row.group_id !== selection.groupId)) bad('assistant_read_repository_scope_violation')
        const hasElectiveBlocks=schedule.some(row=>row.is_elective_block===true),projectedDays=new Map<string,any[]>()
        let electivePlans:StudentElectivePlan[]=[]
        if(hasElectiveBlocks){
          const rawPlans=await table('student_elective_plans','id,user_id,group_id,valid_from,valid_until,configured,version,lessons,created_at,updated_at',call=>call.eq('user_id',userId).eq('group_id',selection.groupId).lte('valid_from',query.to).gte('valid_until',query.from),32,query.signal)
          try{electivePlans=rawPlans.map(normalizeStudentElectivePlan)}catch{bad('assistant_elective_plan_invalid')}
          if(electivePlans.some(plan=>plan.user_id!==userId||plan.group_id!==selection.groupId)||new Set(electivePlans.map(plan=>plan.id)).size!==electivePlans.length)bad('assistant_read_repository_scope_violation')
        }
        for(let day=query.from!;day<=query.to!;day=shift(day,1)){
          const projected=hasElectiveBlocks?projectStudentElectiveTimetable(schedule,electivePlans,userId,selection.groupId,day):schedule
          const occurring=projected.filter(row=>isPersonalElectiveLesson(row)||occurs(row,day))
          projectedDays.set(day,occurring)
          for(const row of occurring){
          if(isPersonalElectiveLesson(row)){
            push({kind:'lesson',id:personalElectiveOccurrenceId(userId,row.personal_elective_plan_id!,row.personal_elective_id!,day),groupId:selection.groupId,date:day,title:plain(row.subject,180),subjectName:plain(row.subject,180),teacherName:plain(row.teacher_name,240),sourcePath:`/groups/${selection.groupId}?tab=schedule&date=${day}`,
              startsAt:plain(row.starts_at).slice(0,5),endsAt:plain(row.ends_at).slice(0,5),location:plain(row.location,300),links:safeLinks(row),conferenceId:plain(row.conference_id,180),accessCode:plain(row.conference_access_code,180),archived:archivedAt(day),
              personalElective:true,electiveOwnerId:userId,electivePlanId:row.personal_elective_plan_id,electiveMeetingId:row.personal_elective_id})
            continue
          }
          const subjectId=timetableSubject(selection.groupId,row.subject)
          const record: any = { kind: 'lesson', id: assistantOccurrenceId(row.id, day), scheduleId: id(row.id), groupId: selection.groupId, ...(subjectId?{subjectId}:{}), subjectName:plain(row.subject,180),date: day, title: plain(row.subject, 180), teacherName:plain(row.teacher_name,240),sourcePath:`/groups/${selection.groupId}?tab=schedule&date=${day}`,startsAt: plain(row.starts_at).slice(0,5), endsAt: plain(row.ends_at).slice(0,5), location: plain(row.location, 300), links: safeLinks(row), conferenceId: plain(row.conference_id, 180), accessCode: plain(row.conference_access_code, 180), version: version(row), archived: archivedAt(day) }
          push(record)
          }
        }
        for (const row of homework) {
          if (row.group_id !== selection.groupId) bad('assistant_read_repository_scope_violation')
          const lesson = schedule.find(item => item.id === row.schedule_item_id)
          if (!lesson || !projectedDays.get(row.lesson_date)?.some(item=>!isPersonalElectiveLesson(item)&&item.id===lesson.id)) continue
          const subjectId=timetableSubject(selection.groupId,lesson.subject)
          push({ kind: 'homework', id: id(row.id), groupId: selection.groupId, ...(subjectId?{subjectId}:{}),subjectName:plain(lesson.subject,180),lessonId: assistantOccurrenceId(lesson.id, row.lesson_date), date: row.lesson_date, teacherName:plain(lesson.teacher_name,240),sourcePath:`/groups/${selection.groupId}?tab=schedule&date=${row.lesson_date}&assignment=${id(row.id)}&kind=homework`,title: plain(row.lesson_topic, 240) || `ДЗ · ${plain(lesson.subject, 180)}`, body: plain(row.body, 50000), dueAt: deadline(row.due_at), published: true, version: version(row), archived: archivedAt(row.lesson_date) })
        }
        for (const item of rows(teaching.assignments)) for (const target of rows(item.targets, 100)) {
          if (target.group_id !== selection.groupId || !date(target.lesson_date) || target.lesson_date < query.from! || target.lesson_date > query.to! || item.status !== 'published') continue
          const courseId = id(item.course_id)
          push({ kind: 'homework', id: assistantOccurrenceId(item.id, target.lesson_date), groupId: selection.groupId, subjectId: courseSubject(courseId, selection.groupId), courseId, date: target.lesson_date,sourcePath:`/groups/${selection.groupId}?tab=schedule&date=${target.lesson_date}`,title: plain(item.title, 240), body: plain(item.body, 50000), dueAt: deadline(target.due_at), published: true, version: version(item), archived: !!latestCourseRows.get(courseId)?.archived_at })
        }
      }
    } else if (query.topic === 'teaching') {
      if (query.audience !== 'teacher' || !date(query.from) || !date(query.to)) bad('assistant_read_repository_scope_violation')
      const calendar = await rpc('xelay_teaching_calendar', { p_from: query.from, p_to: query.to }, query.signal)
      // Keep the assistant's personal teaching schedule consistent with Home.
      // A role is a preference within an existing exact course/group grant;
      // it never grants access or changes student timetable/assignment reads.
      const selectedPairs = new Set(query.selections.map(item => `${item.courseId}:${item.groupId}`))
      const roleRows = calendar.teaching_roles === undefined ? [] : rows(calendar.teaching_roles, 3000)
      const configuredRoles = new Set(roleRows.filter(role => Number.isSafeInteger(role.version) && role.version > 0 && selectedPairs.has(`${role.course_id}:${role.group_id}`)).map(role => `${role.course_id}:${role.group_id}`))
      for (const row of rows(calendar.lessons, 3000)) {
        if (row.source !== 'timetable') continue
        const selected = query.selections.find(item => item.groupId === row.group_id && item.courseId === row.course_id)
        if (!selected) continue
        const expected = latestCatalog!.subjects.find(item => item.groupId === selected.groupId && item.id === selected.subjectId)
        if (!expected || key(row.subject_name || row.course_title) !== key(expected.name)) bad('assistant_teacher_subject_mismatch')
        if (configuredRoles.has(`${row.course_id}:${row.group_id}`) && row.assigned_to_me !== true) continue
        push({ kind: 'lesson', id: assistantOccurrenceId(row.id, row.lesson_date), scheduleId: id(row.id), groupId: id(row.group_id), subjectId: selected.subjectId!, courseId: id(row.course_id), date: row.lesson_date, teacherName:plain(row.teacher_name,240), title: plain(row.subject_name || row.course_title, 180), startsAt: plain(row.starts_at).slice(0,5), endsAt: plain(row.ends_at).slice(0,5), location: plain(row.location, 300), links: safeLinks(row), conferenceId: plain(row.conference_id, 180), accessCode: plain(row.conference_access_code, 180), archived: false } as any)
      }
    } else if (query.topic === 'results') {
      for (const selection of query.selections) {
        const teaching = await rpc('xelay_teaching_group', { p_group_id: selection.groupId }, query.signal)
        for (const row of rows(teaching.grades)) {
          if (row.group_id !== selection.groupId) bad('assistant_read_repository_scope_violation')
          if (row.user_id !== undefined && row.user_id !== userId) bad('assistant_read_repository_scope_violation')
          if (!row.published_at || typeof row.published_score !== 'number') continue
          const courseId = id(row.course_id)
          push({ kind: 'grade', id: id(row.id), groupId: selection.groupId, courseId, subjectId: courseSubject(courseId, selection.groupId),studentId: userId, activityId: id(row.activity_id), title: plain(row.activity_title, 180),subjectName:plain(latestCourseRows.get(courseId)?.title,240),sourcePath:ownGradeSourcePath(selection.groupId,courseId,date(row.activity_date)?row.activity_date:latestCourseRows.get(courseId)?.starts_on),points: row.published_score, maxPoints: row.max_points, coefficient: coefficient(row.grading_rules, row.category),category:plain(row.category,100),...(row.grading_rules?{gradingRules:row.grading_rules}:{}),published: true, archived: !!latestCourseRows.get(courseId)?.archived_at })
        }
      }
    } else if (query.topic === 'gradebook') {
      for (const courseId of [...new Set(query.selections.map(selection => selection.courseId!))]) {
        const snapshot = await rpc('xelay_teaching_course', { p_course_id: courseId }, query.signal)
        if (id(snapshot.course?.id) !== courseId) bad('assistant_read_repository_scope_violation')
        if (['questions', 'teams', 'reservations'].some(field => Array.isArray(snapshot.seminars?.[field]) && snapshot.seminars[field].length)) bad('assistant_teacher_seminar_boundary')
        const entries = rows(snapshot.entries, 3000), activities = rows(snapshot.activities, 3000), gradeRows = rows(snapshot.grades, 5000)
        for (const row of gradeRows) {
          const selection = query.selections.find(item => item.groupId === row.group_id && item.courseId === courseId)
          if (!selection || row.course_id !== courseId) continue
          const entry = entries.find(item => item.id === row.entry_id && item.course_id === courseId && item.group_id === selection.groupId && item.active === true)
          const activity = activities.find(item => item.id === row.activity_id && item.course_id === courseId && item.group_id === selection.groupId)
          const points = typeof row.draft_score === 'number' ? row.draft_score : row.published_score
          if (!entry || !activity || !UUID.test(entry.user_id) || typeof points !== 'number') continue
          const rules = rows(snapshot.groups, 200).find(item => item.group_id === selection.groupId)?.grading_rules_override || snapshot.course.grading_rules
          push({ kind: 'grade', id: id(row.id), courseId, groupId: selection.groupId, subjectId: selection.subjectId!, studentId: id(entry.user_id), studentName:plain(entry.full_name,240), activityId: id(activity.id), title: plain(activity.title, 180), points, maxPoints: activity.max_points, coefficient: coefficient(rules, activity.category), published: !!row.published_at && points === row.published_score, version: version(row), archived: !!snapshot.course.archived_at })
        }
      }
    } else if (query.topic === 'materials') {
      if (query.audience === 'student') {
        for (const selection of query.selections) {
          const materialRows = await table('study_group_materials', 'id,group_id,subject_id,title,body,material_date,attachments,updated_at', call => call.eq('group_id', selection.groupId), MAX_ROWS, query.signal)
          for (const row of materialRows) {
            if (row.group_id !== selection.groupId) bad('assistant_read_repository_scope_violation')
            push({ kind: 'material', id: id(row.id),materialId:id(row.id),materialSourceKind:'study',groupId: selection.groupId, subjectId: id(row.subject_id), title: plain(row.title, 240), body: plain(row.body, 50000), published: true, allowAi: false, allowDownload: true, version: version(row), archived: archivedAt(row.material_date), ...(Array.isArray(row.attachments) && (row.attachments[0]?.name||row.attachments[0]?.file_name) ? { fileName: plain(row.attachments[0].name||row.attachments[0].file_name, 180) } : {}) })
          }
          const projected = await rpc('xelay_group_teacher_materials', { p_group_id: selection.groupId }, query.signal)
          for (const row of rows(projected.materials)) {
            if (row.group_id !== selection.groupId) bad('assistant_read_repository_scope_violation')
            const courseId = id(row.course_id)
            const subjectId = UUID.test(row.subject_id) ? id(row.subject_id) : courseSubject(courseId, selection.groupId)
            push({ kind: 'material', id: id(row.source_item_id || row.id),materialId:id(row.source_item_id||row.id),materialSourceKind:'teaching',groupId: selection.groupId, subjectId, courseId, title: plain(row.title, 240), body: plain(row.body, 50000), published: true, allowAi: false, allowDownload: row.allow_download === true, version: version(row), archived: !!row.course_archived_at, ...(row.attachments?.[0]?.name ? { fileName: plain(row.attachments[0].name||row.attachments[0].file_name, 180) } : {}) })
          }
        }
      } else {
        const library = await rpc('xelay_teaching_material_library', undefined, query.signal)
        for (const row of rows(library.materials)) for (const target of rows(row.targets, 100)) {
          const selection = query.selections.find(item => item.groupId === target.group_id && item.courseId === row.course_id)
          if (!selection || row.withdrawn_at || row.access_until && Date.parse(row.access_until) <= now()) continue
          push({ kind: 'material', id: assistantOccurrenceId(row.id, target.group_id),materialId:id(row.id),materialSourceKind:'teaching',groupId: selection.groupId, subjectId: selection.subjectId!, courseId: selection.courseId, title: plain(row.title, 240), body: plain(row.body, 50000), published: row.status === 'published', allowAi: false, allowDownload: row.allow_download === true, version: version(row), archived: !!row.course_archived_at, ...(row.attachments?.[0]?.name ? { fileName: plain(row.attachments[0].name||row.attachments[0].file_name, 180) } : {}) })
        }
      }
    } else bad('assistant_read_topic_unsupported')
    await assertUser(query.signal)
    const lessonTimes = new Map(result.filter(row => row.kind === 'lesson').map(row => [row.id, row.startsAt]))
    const rowDate = (row: AssistantAuthorizedReadRecord) => 'date' in row && typeof row.date==='string' ? row.date : ''
    const rowTime = (row: AssistantAuthorizedReadRecord) => row.kind === 'lesson' ? row.startsAt
      : row.kind === 'homework' && row.lessonId ? lessonTimes.get(row.lessonId) || '99:99' : '99:99'
    const rowOrder = (row: AssistantAuthorizedReadRecord) => row.kind === 'lesson' ? 0 : row.kind === 'homework' ? 1 : 2
    result.sort((a,b) => rowDate(a).localeCompare(rowDate(b)) || rowTime(a).localeCompare(rowTime(b))
      || a.groupId.localeCompare(b.groupId) || rowOrder(a) - rowOrder(b) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    const selected=result.slice(0,query.limit)
    if(query.topic==='materials')for(const kind of ['study','teaching'] as const){
      const materials=selected.filter(r=>r.kind==='material'&&r.materialSourceKind===kind)
      if(!materials.length)continue
      try{
        const grants=rows(await rpc('xelay_assistant_material_ai_batch',{p_kind:kind,p_material_ids:[...new Set(materials.map(r=>(r as any).materialId))]},query.signal),101)
        for(const r of materials)if(r.kind==='material'){const g=grants.find(g=>g.id===r.materialId&&g.sourceKind===kind);r.allowAi=g?.allowAi===true;if(typeof g?.rightsVersion==='string'&&/^[a-f\d]{32}$/.test(g.rightsVersion))r.rightsVersion=g.rightsVersion}
      }catch{abort(query.signal);/* Missing migration/network permission fails closed for AI only. */}
    }
    return { rows: selected, hasMore: result.length > query.limit }
  }
  return {
    readAccess: input => input.userId === userId ? access(input.signal, input.membershipLimit, input.teachingGrantLimit,input.studyGroupId,input.publicOnly) : Promise.reject(Object.assign(new Error('assistant_account_changed'), { code: 'assistant_account_changed' })),
    readPage,
    async catalog(signal) { await access(signal); return structuredClone(latestCatalog!) },
  }
}
