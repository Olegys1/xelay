import { useSyncExternalStore } from 'react'

// Synthetic identities and records only. No SDK, environment variables or remote API.
type Row = Record<string, any>
type Result = { data: any; error: null | { code: string; message: string }; status: number; count?: number }
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
export const PREVIEW_GROUP_ID = uuid(10)
export const PREVIEW_DATE = '2026-10-27'
const head = uuid(1), student = uuid(2), peer = uuid(3), teacher = uuid(4)
const university = uuid(20), faculty = uuid(21)
const created = '2024-09-01T09:00:00Z'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const profile = (id: string, full_name: string, username: string) => ({ id, full_name, username,
  email: `${username}@example.invalid`, avatar_url: null, university_id: university, academic_unit_id: faculty,
  faculty: 'Економічний факультет', specialty: 'Економіка та управління бізнесом', study_year: 3,
  experience: 'Студент бакалаврату', categories: [], has_seen_onboarding: true, created_at: created })
const profiles = [profile(head, 'Софія Прикладенко', 'sofia_example'), profile(student, 'Андрій Прикладенко', 'andrii_example'),
  profile(peer, 'Олена Прикладенко', 'olena_example'), profile(teacher, 'Викладач Прикладенко', 'teacher_example')]
const group = { id: PREVIEW_GROUP_ID, representative_id: head, representative_request_id: uuid(30), university_id: university,
  academic_unit_id: faculty, specialty: 'Економіка та управління бізнесом', group_name: 'ЕУБ · архів навчання',
  cohort_start_year: 2024, study_level: 'bachelor', created_at: created, supplement_capacity: 3 }
const subjects = ['Вища математика', 'Мікроекономіка', 'Фінанси']
const years = [2024, 2025, 2026]
const filePath = (id: number) => `${PREVIEW_GROUP_ID}/${peer}/${uuid(id)}.pdf`
const attachment = (id: number, name: string) => ({ path: filePath(id), file_name: name, mime_type: 'application/pdf', file_size: 673 })
const schedule: Row[] = [], homework: Row[] = [], materialSubjects: Row[] = [], materials: Row[] = []
const seminarSchedule: Row[] = [], seminars: Row[] = [], seminarQuestions: Row[] = [], reservations: Row[] = []
const presentations: Row[] = [], assignments: Row[] = [], courses: Row[] = []
for (const [index, year] of years.entries()) {
  const date = `${year}-10-27`, subjectId = uuid(40 + index), courseId = uuid(50 + index), title = subjects[index]
  const day = new Date(`${date}T12:00:00Z`).getUTCDay() || 7
  const range = { valid_from: `${year}-09-01`, valid_until: `${year + 1}-06-30` }
  materialSubjects.push({ id: subjectId, group_id: PREVIEW_GROUP_ID, name: title, created_by: head, created_at: created, updated_at: created, has_schedule_sources: true })
  courses.push({ id: courseId, owner_id: teacher, university_id: university, academic_unit_id: faculty, title,
    semester: `Осінній семестр ${year}`, starts_on: `${year}-09-01`, ends_on: `${year + 1}-01-31`,
    grading_rules: { categories: [], total_max: 100 }, archived_at: null, created_at: created, updated_at: created, version: 1, permissions: [] })
  for (let slot = 0; slot < 2; slot++) {
    const lessonId = uuid(100 + index * 10 + slot)
    schedule.push({ id: lessonId, group_id: PREVIEW_GROUP_ID, weekday: day, starts_at: slot ? '09:40:00' : '08:00:00',
      ends_at: slot ? '11:00:00' : '09:20:00', subject: title, teacher_name: 'Викладач Прикладенко',
      lesson_type: slot ? 'seminar' : 'lecture', location: slot ? '203/2' : '225/2', online_url: null, online_url_secondary: null,
      online_url_label: '', online_url_secondary_label: '', conference_id: '', conference_access_code: '',
      week_pattern: 'every', week_anchor_date: null, lesson_number: slot + 1, excluded_dates: [],
      ...range, ...(index === 1 && slot === 1 ? { valid_until: '2025-10-20' } : {}), created_by: head, created_at: created, updated_at: created })
    homework.push({ id: uuid(200 + index * 10 + slot), group_id: PREVIEW_GROUP_ID, schedule_item_id: lessonId,
      lesson_date: date, lesson_topic: slot ? `Семінар · ${year}/${year + 1}` : `Лекція · ${year}/${year + 1}`,
      body: slot ? `Підготуйте питання до семінару з предмета «${title}». Це збережене ДЗ за ${year}/${year + 1} навчальний рік.`
        : `Опрацюйте конспект лекції та приклади. Домашнє завдання ${year}/${year + 1} збереглося у своїй групі.`,
      url: null, resource_links: [], resource_link_labels: {}, attachments: [], created_by: head, created_at: `${date}T08:00:00Z` })
    if (slot === 1) {
      const seminarId = uuid(300 + index), questionId = uuid(350 + index)
      seminarSchedule.push({ id: uuid(400 + index), group_id: PREVIEW_GROUP_ID, subject_id: subjectId, weekday: day,
        starts_at: '09:40:00', ends_at: '11:00:00', ...range, created_by: head, source_schedule_id: lessonId,
        source_managed: true, source_active: true, week_pattern: 'every', week_anchor_date: null, excluded_dates: [] })
      seminars.push({ id: seminarId, group_id: PREVIEW_GROUP_ID, subject_id: subjectId, schedule_id: uuid(400 + index),
        lesson_date: date, starts_at: '09:40:00', ends_at: '11:00:00', title: `Семінар: ${title} · ${year}/${year + 1}`,
        instructions: 'Збережені питання й вибір одногрупників залишилися на своїй даті.', format: 'questions', created_by: head,
        resource_links: [], resource_attachments: [], teaching_course_id: null, teaching_author_id: null })
      seminarQuestions.push({ id: questionId, seminar_id: seminarId, position: 1, body: `Основні поняття: ${title}`, primary_capacity: 1, supplement_capacity: 3 })
      reservations.push({ id: uuid(450 + index), seminar_id: seminarId, user_id: student, role: 'primary', question_id: questionId, team_id: null, created_at: `${date}T07:00:00Z` })
    }
  }
  materials.push({ id: uuid(500 + index), group_id: PREVIEW_GROUP_ID, subject_id: subjectId,
    title: `Матеріали лекції · ${year}/${year + 1}`, material_date: date,
    body: `Конспект і презентація з предмета «${title}». Архів відкриває той самий файл, не створюючи нової копії.`,
    links: [], attachments: [attachment(600 + index, `lecture-${year}.pdf`)], created_by: head,
    created_at: `${date}T12:00:00Z`, updated_at: `${date}T12:00:00Z` })
  presentations.push({ id: uuid(700 + index), group_id: PREVIEW_GROUP_ID, created_by: peer, author_name: 'Олена Прикладенко',
    subject: title, title: `Презентація одногрупниці · ${year}/${year + 1}`, lesson_date: date,
    description: 'Збережена після виступу презентація для одногрупників.', links: [],
    attachments: [attachment(800 + index, `presentation-${year}.pdf`)], version: 1,
    created_at: `${date}T12:00:00Z`, updated_at: `${date}T12:00:00Z` })
  assignments.push({ id: uuid(900 + index), course_id: courseId, title: `Завдання від викладача · ${year}/${year + 1}`,
    body: 'Відповідь, коментар викладача й історія збереглися разом із завданням.', links: [], attachments: [],
    targets: [{ group_id: PREVIEW_GROUP_ID, due_at: `${date}T18:00:00Z`, lesson_date: date, schedule_item_id: uuid(100 + index * 10), placement_mode: 'lesson' }],
    status: 'published', published_at: `${date}T07:00:00Z`, created_by: teacher, author_name: 'Викладач Прикладенко', version: 1,
    submission_format: 'written', max_points: 10, group_id: PREVIEW_GROUP_ID, subject_id: subjectId, subject_name: title,
    course_title: title, lesson_date: date, schedule_item_id: uuid(100 + index * 10), source: 'teacher', read_only: true })
}
const tables: Record<string, Row[]> = {
  profiles, study_groups: [group], universities: [{ id: university, name: 'Київський національний університет імені Тараса Шевченка', slug: 'knu', is_active: true }],
  academic_units: [{ id: faculty, university_id: university, name: 'Економічний факультет', slug: 'economics', is_active: true }],
  study_group_members: profiles.slice(0, 3).map((item, index) => ({ id: uuid(1000 + index), group_id: PREVIEW_GROUP_ID,
    user_id: item.id, invited_by: head, status: 'accepted', created_at: created })),
  class_representative_requests: [{ id: uuid(30), user_id: head, status: 'approved', group_name: group.group_name, cohort_start_year: 2024,
    study_level: 'bachelor', university_id: university, academic_unit_id: faculty, created_at: created }],
  study_group_schedule: schedule, study_group_homework: homework, study_group_material_subjects: materialSubjects,
  study_group_materials: materials, study_group_seminar_subjects: materialSubjects,
  study_group_seminar_schedule: seminarSchedule, study_group_seminars: seminars,
  study_group_seminar_questions: seminarQuestions, study_group_seminar_teams: [], study_group_seminar_reservations: reservations,
  study_group_long_term_tasks: years.map((year, index) => ({ id: uuid(1100 + index), group_id: PREVIEW_GROUP_ID, subject: subjects[index],
    subject_key: subjects[index].toLowerCase(), title: `Підсумковий проєкт ${year}/${year + 1}`, description: 'Збережений довгостроковий проєкт своєї групи.',
    due_date: `${year + 1}-01-15`, created_at: `${year}-10-01T12:00:00Z`, updated_at: `${year}-10-01T12:00:00Z`, created_by: head,
    closed_at: index < 2 ? `${year + 1}-02-01T12:00:00Z` : null, resource_links: [], resource_link_labels: {}, resource_attachments: [] })),
  study_group_timetable_photos: [], study_group_deputy_requests: [],
  study_group_seminar_comments: years.map((year, index) => ({ id: uuid(1400 + index), group_id: PREVIEW_GROUP_ID,
    seminar_id: uuid(300 + index), author_id: peer, body: `Обговорення ${year}/${year + 1}: приклади до відповіді збережені разом із семінаром.`,
    created_at: `${year}-10-27T10:00:00Z`, updated_at: `${year}-10-27T10:00:00Z` })),
  study_group_seminar_file_cleanup: [],
}
let role: 'head' | 'student' = 'head'
let revision = 0
const authListeners = new Set<() => void>(), listeners = new Set<() => void>()
const calls: Row[] = []
let stats: Row = { role, revision, reads: 0, writes: 0, blockedExternalRequests: 0, calls: [] }
function record(name: string, kind: 'read' | 'blocked-write' | 'blocked-external', detail: Row = {}) {
  calls.push({ name, kind, detail, at: new Date().toISOString() })
  stats = { role, revision: ++revision, reads: calls.filter(item => item.kind === 'read').length,
    writes: calls.filter(item => item.kind === 'blocked-write').length,
    blockedExternalRequests: calls.filter(item => item.kind === 'blocked-external').length, calls: [...calls] }
  listeners.forEach(listener => listener())
}
function identity() {
  const row = profiles.find(item => item.id === (role === 'head' ? head : student))!
  return { authUser: { id: row.id, email: row.email }, xelayUser: { ...row, fullName: row.full_name,
    accountType: 'student', isTeacher: false, isAdmin: false, isPremium: false }, isLoading: false, isAuthenticated: true,
    isPasswordRecovery: false, googleRegistrationStatus: 'ready', refreshUser: async () => {}, signOut: async () => {},
    clearPasswordRecovery: () => {}, markPasswordRecovery: () => {} }
}
let authState = identity()
const ok = (data: any): Result => ({ data: clone(data), error: null, status: 200 })
const deny = (name: string, detail: Row = {}): Result => {
  record(name, 'blocked-write', detail)
  return { data: null, error: { code: 'LOCAL_PREVIEW_WRITE_DENIED', message: 'У цьому локальному прикладі збереження вимкнено. Дані вигадані, робочий сервер не підключено.' }, status: 403 }
}
class Query {
  filters: ((row: Row) => boolean)[] = []; orderings: [string, boolean][] = []; maximum?: number; offset = 0
  singleRow = false; head = false; count = false; action = 'select'; signal?: AbortSignal; promise?: Promise<Result>
  constructor(public table: string) {}
  select(_fields = '*', options: Row = {}) { this.head = options.head === true; this.count = Boolean(options.count); return this }
  eq(key: string, value: any) { this.filters.push(row => row[key] === value); return this }
  neq(key: string, value: any) { this.filters.push(row => row[key] !== value); return this }
  in(key: string, values: any[]) { this.filters.push(row => values.includes(row[key])); return this }
  is(key: string, value: any) { this.filters.push(row => value === null ? row[key] == null : row[key] === value); return this }
  gt(key: string, value: any) { this.filters.push(row => row[key] > value); return this }
  gte(key: string, value: any) { this.filters.push(row => row[key] >= value); return this }
  lt(key: string, value: any) { this.filters.push(row => row[key] < value); return this }
  lte(key: string, value: any) { this.filters.push(row => row[key] <= value); return this }
  order(key: string, options: Row = {}) { this.orderings.push([key, options.ascending !== false]); return this }
  limit(value: number) { this.maximum = value; return this }
  range(from: number, to: number) { this.offset = from; this.maximum = to - from + 1; return this }
  maybeSingle() { this.singleRow = true; return this }
  single() { this.singleRow = true; return this }
  abortSignal(signal: AbortSignal) { this.signal = signal; return this }
  returns() { return this }
  or(expression: string) {
    const alternatives = expression.split(',').map(part => part.match(/^([a-z_]+)\.(eq|lt|lte|gt|gte|is)\.(.+)$/))
    if (alternatives.every(Boolean)) this.filters.push(row => alternatives.some(match => {
      const [, key, op, value] = match!
      return op === 'eq' ? String(row[key]) === value : op === 'lt' ? row[key] < value : op === 'lte' ? row[key] <= value
        : op === 'gt' ? row[key] > value : op === 'gte' ? row[key] >= value : value === 'null' && row[key] == null
    }))
    else throw new Error(`Unsupported local query filter: ${expression}`)
    return this
  }
  insert() { this.action = 'insert'; return this }
  upsert() { this.action = 'upsert'; return this }
  update() { this.action = 'update'; return this }
  delete() { this.action = 'delete'; return this }
  then(resolve: (value: Result) => any, reject?: (error: unknown) => any) {
    if (!this.promise) this.promise = Promise.resolve().then(() => {
      if (this.action !== 'select') return deny(`${this.table}:${this.action}`)
      record(this.table, 'read')
      if (this.signal?.aborted) return { data: null, error: { code: 'ABORTED', message: 'Local read cancelled' }, status: 0 }
      let data = (tables[this.table] || []).filter(row => this.filters.every(test => test(row)))
      data = [...data].sort((a, b) => { for (const [field, asc] of this.orderings) {
        const difference = String(a[field] ?? '').localeCompare(String(b[field] ?? ''))
        if (difference) return asc ? difference : -difference
      } return 0 })
      const count = data.length
      data = data.slice(this.offset, this.maximum === undefined ? undefined : this.offset + this.maximum)
      return { ...ok(this.head ? null : this.singleRow ? data[0] || null : data), ...(this.count ? { count } : {}) }
    })
    return this.promise.then(resolve, reject)
  }
}
const permissions = ['schedule', 'homework', 'seminars', 'seminar_resources', 'seminar_comments', 'materials', 'invite_members', 'remove_members']
export const supabase: any = {
  from: (table: string) => new Query(table),
  async rpc(name: string, args: Row = {}) {
    if (args.p_group_id && args.p_group_id !== PREVIEW_GROUP_ID) return { data: null, error: { code: '42501', message: 'LOCAL_GROUP_MEMBER_REQUIRED' }, status: 403 }
    const read = (data: any) => { record(name, 'read', args); return ok(data) }
    if (name === 'xelay_profiles_by_ids') return read(profiles.filter(row => args.p_user_ids?.includes(row.id)))
    if (name === 'xelay_study_group_permissions') return read(role === 'head' ? permissions : [])
    if (name === 'xelay_list_study_group_deputies') return read([])
    if (name === 'xelay_group_billing_status') return read({ is_free: true, is_active: true, can_edit: true, payment_required: false,
      enforcement_enabled: false, source: 'free', can_participate: true, server_now: new Date().toISOString() })
    if (name === 'xelay_group_teacher_assignments') return read({ assignments: assignments.filter(item => item.lesson_date === args.p_lesson_date) })
    if (name === 'xelay_group_teacher_materials') return read({ subjects: [], materials: [] })
    if (name === 'xelay_teaching_group') return read({ courses, assignments, materials: [], pending_invites: [], grades: [] })
    if (name === 'xelay_teaching_workspace') return read({ teacher_status: { status: 'none', verified: false }, courses: [], groups: [], teacher_directory: [], roster_claims: [] })
    if (name === 'xelay_classroom_workspace') return read({ classrooms: [] })
    if (name === 'xelay_teacher_status') return read({ verified: false, status: 'none', request: null })
    if (name === 'xelay_group_presentations') return read({ presentations, subjects, can_moderate: role === 'head' })
    if (name === 'xelay_can_view_seminars') return read(args.p_group_id === PREVIEW_GROUP_ID)
    if (name === 'xelay_seminar_streak') return read(0)
    if (name === 'xelay_material_file_cleanup_paths') return read([])
    if (name === 'xelay_academic_group_teachers') return read({ teachers: [] })
    if (name === 'xelay_classroom_assignment') {
      const item = assignments.find(row => row.id === args.p_item_id)
      if (!item) return { data: null, error: { code: '42501', message: 'LOCAL_ASSIGNMENT_NOT_FOUND' }, status: 403 }
      const submission = { id: uuid(1200 + assignments.indexOf(item)), item_id: item.id, course_id: item.course_id,
        group_id: PREVIEW_GROUP_ID, user_id: authState.authUser.id, status: item.lesson_date < '2026-09-01' ? 'reviewed' : 'draft',
        body: `Моя збережена відповідь за ${item.lesson_date.slice(0, 4)} рік.`, links: [], attachments: [], version: 2,
        attempt: 1, submitted_at: `${item.lesson_date}T12:00:00Z`, feedback: 'Дякую за роботу. Аргументацію зараховано.',
        reviewed_at: `${item.lesson_date}T15:00:00Z`, reviewed_by: teacher, reviewer_name: 'Викладач Прикладенко',
        student_name: authState.xelayUser.full_name, grade_version: 1, published_score: 8, published_comment: 'Зараховано' }
      return read({ item, group, permissions: [], my_submission: submission, submissions: [], students: [], can_submit: true,
        can_save_draft: true, course_archived_at: null, is_assessed: true, max_points: 10,
        history: [{ id: uuid(1300 + assignments.indexOf(item)), submission_id: submission.id, attempt: 1, event: 'submitted',
          body: 'Збережена попередня спроба.', links: [], attachments: [], feedback: '', created_at: `${item.lesson_date}T12:00:00Z`, actor_name: authState.xelayUser.full_name }] })
    }
    if (/save|mutate|delete|reserve|submit|withdraw|upload|remove|cancel|set_|create|respond|invite|ack_|publish|collect|update|add_/i.test(name)) return deny(name, args)
    record(name, 'read', { ...args, unimplemented: true })
    return { data: null, error: { code: 'PGRST202', message: `Local read not implemented: ${name}` }, status: 404 }
  },
  channel(name: string) { return { name, on() { return this }, subscribe() { return this }, unsubscribe: async () => 'ok' } },
  removeChannel: async () => 'ok',
  auth: {
    getSession: async () => ({ data: { session: { user: authState.authUser, access_token: 'synthetic-preview-only-no-server-token' } }, error: null }),
    getUser: async () => ({ data: { user: authState.authUser }, error: null }),
    signUp: async () => deny('auth.signUp'), signInWithPassword: async () => deny('auth.signIn'), signInWithOAuth: async () => deny('auth.signInWithOAuth'),
    signOut: async () => deny('auth.signOut'), resend: async () => deny('auth.resend'), resetPasswordForEmail: async () => deny('auth.resetPassword'),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  storage: { from(bucket: string) { return {
    createSignedUrl: async (path: string, _seconds: number, options?: Row) => {
      record(`storage:${bucket}:read`, 'read', { path })
      return { data: { signedUrl: `/__xelay-group-archive/presentation.pdf${options?.download ? '?download=1' : ''}` }, error: null }
    },
    download: async (path: string) => { record(`storage:${bucket}:download`, 'read', { path }); return { data: await (await fetch('/__xelay-group-archive/presentation.pdf')).blob(), error: null } },
    upload: async () => deny(`storage:${bucket}:upload`), remove: async () => deny(`storage:${bucket}:remove`),
    getPublicUrl: () => ({ data: { publicUrl: '/__xelay-group-archive/presentation.pdf' } }),
  } } },
}
// Match the SDK's awaitable RPC builder for the real offline capture path.
// Only synthetic reads run; cancellation never reaches a network or a real store.
const localRpc = supabase.rpc.bind(supabase)
supabase.rpc = (name: string, args: Row = {}) => {
  const pending: Promise<Result> = localRpc(name, args)
  return Object.assign(pending, { abortSignal(signal: AbortSignal): Promise<Result> {
    const aborted = (): Result => ({ data: null, error: { code: 'ABORTED', message: 'Local read cancelled' }, status: 0 })
    if (signal.aborted) return Promise.resolve(aborted())
    return new Promise((resolve, reject) => {
      const abort = () => resolve(aborted())
      signal.addEventListener('abort', abort, { once: true })
      pending.then(value => { signal.removeEventListener('abort', abort); resolve(signal.aborted ? aborted() : value) },
        error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  } })
}
export function emailLinkVerifier() { return supabase }
export function useAuth() { return useSyncExternalStore(listener => { authListeners.add(listener); return () => { authListeners.delete(listener) } }, () => authState) }
export const archivePreviewFixture = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  snapshot: () => stats,
  setRole(next: 'head' | 'student') { if (next === role) return; role = next; authState = identity(); authListeners.forEach(listener => listener()); record('preview.role', 'read', { role }) },
  resetMetrics() { calls.splice(0); stats = { role, revision: ++revision, reads: 0, writes: 0, blockedExternalRequests: 0, calls: [] }; listeners.forEach(listener => listener()) },
  blockedExternal(url: string) { record('external-request', 'blocked-external', { url }) },
}

// The real group page can prepare an offline copy, but this preview keeps it in RAM.
const offline = new Map<string, Row>()
export async function getOfflineOwner() { return { id: authState.authUser.id, displayName: authState.xelayUser.full_name, sessionId: 'synthetic-preview-session' } }
export async function loadOfflineGroup(userId: string, groupId: string) { return offline.get(`${userId}:${groupId}`) || null }
export async function saveOfflineGroupSnapshot(userId: string, input: Row) { const value = { ...clone(input), ownerId: userId, sessionId: 'synthetic-preview-session', savedAt: new Date().toISOString(), expiresAt: '2026-11-11T00:00:00Z' }; offline.set(`${userId}:${input.groupId}`, value); return value }
export async function removeOfflineGroupSnapshot(userId: string, groupId: string) { offline.delete(`${userId}:${groupId}`) }
export async function establishOfflineOwner() { return getOfflineOwner() }
export async function clearOfflineStudy() { offline.clear() }
export async function listOfflineGroups() { return [...offline.values()] }
export function offlineStudyError(error: unknown) { return error instanceof Error ? error.message : 'Локальний приклад офлайн-копії.' }
export const OFFLINE_STUDY_DAYS = 14, OFFLINE_STUDY_TTL_MS = 14 * 86400000, OFFLINE_STUDY_CHANGED = 'xelay:local-archive-offline'
