import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseAssistantReadRepository, verifySupabaseAssistantSession, assistantOccurrenceId } from '../../server/assistant-v2/supabaseReadRepository.ts'
import { createAuthenticatedAssistantReadService } from '../../server/assistant-v2/authenticatedRead.ts'

// Explicit fake SDK; no URL, fetch, project key, environment or live database.
const ident = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const user = ident(1), peer = ident(2), head = ident(3), group = ident(101), foreign = ident(102), studySubject = ident(201), materialSubject = ident(202), course = ident(301), foreignCourse = ident(302), scheduleId = ident(401)
const now = Date.parse('2026-11-02T10:00:00Z')
const clone = value => structuredClone(value)
const jwt = (change = {}) => `header.${Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(now / 1000) + 3600, role: 'authenticated', session_id: 'test-session', ...change })).toString('base64url')}.synthetic-signature`
const courses = [{ id: course, title: 'Вища математика', subject_id: studySubject, archived_at: null, grading_rules: { categories: [{ id: 'seminar', coefficient: 2 }] }, permissions: ['materials', 'assignments', 'grades'] }]
function setup(options = {}) {
  const state = {
    userId: options.userId || user, teacher: options.teacher ?? false, rpcCalls: [], queries: [], authCalls: 0,
    tables: {
      study_group_members: [{ id: ident(11), group_id: group, user_id: options.userId || user, status: 'accepted' }, { id: ident(12), group_id: foreign, user_id: user, status: 'pending' }],
      study_groups: [{ id: group, group_name: 'ЕУБ-1', specialty: 'Економіка', representative_id: head, cohort_start_year: 2026, study_level: 'bachelor' }, { id: foreign, group_name: 'FOREIGN', representative_id: peer }],
      study_group_deputy_requests: [],
      study_group_seminar_subjects: [{ id: studySubject, group_id: group, name: 'Вища математика' }],
      study_group_material_subjects: [{ id: materialSubject, group_id: group, name: 'Вища математика' }],
      study_group_schedule: [{ id: scheduleId, group_id: group, subject: ' Вища   математика ', weekday: 1, starts_at: '08:30:00', ends_at: '09:50:00', lesson_type: 'lecture', location: '203', online_url: 'https://example.com/room', online_url_secondary: 'javascript:alert(1)', online_links_extra: [{ url: 'https://example.com/second', label: 'Meet' }], conference_id: 'PRIVATE_MEETING', conference_access_code: 'PRIVATE_PASS', valid_from: '2026-09-01', valid_until: '2027-01-31', week_pattern: 'every', week_anchor_date: null, excluded_dates: [], updated_at: '2026-10-30T12:00:00Z' }],
      study_group_homework: [{ id: ident(501), group_id: group, schedule_item_id: scheduleId, lesson_date: '2026-11-02', lesson_topic: 'Похідна', body: 'Усі умови без змін.', updated_at: '2026-10-30T12:00:00Z' }],
      study_group_materials: [{ id: ident(601), group_id: group, subject_id: materialSubject, title: 'Лекція', body: 'PRIVATE_MATERIAL', material_date: '2026-11-01', attachments: [{ name: 'lesson.pdf', storage_path: 'PRIVATE_STORAGE_PATH' }], updated_at: '2026-11-01T12:00:00Z' }],
      ...(options.tables || {}),
    },
    teaching: { courses: clone(courses), assignments: [], materials: [], grades: [] },
    calendar: [], library: [], courseSnapshot: { course: clone(courses[0]), groups: [{ group_id: group }], entries: [], activities: [], grades: [], seminars: { questions: [], teams: [], reservations: [] } },
    contextCourses: clone(courses),
    rpcFailure: false, authFailure: false, banned: false, responseUserId: null,
  }
  class Query {
    constructor(table) { this.table = table; this.ops = []; this.columns = ''; this.maximum = 1000 }
    select(columns) { this.columns = columns; return this }
    eq(field, value) { this.ops.push(['eq', field, value]); return this }
    in(field, value) { this.ops.push(['in', field, value]); return this }
    gte(field, value) { this.ops.push(['gte', field, value]); return this }
    lte(field, value) { this.ops.push(['lte', field, value]); return this }
    gt(field, value) { this.ops.push(['gt', field, value]); return this }
    order(field, options) { this.orderBy = field; this.ascending = options.ascending; return this }
    limit(value) { this.maximum = value; return this }
    abortSignal(signal) { this.signal = signal; return this }
    then(resolve, reject) {
      state.queries.push({ table: this.table, columns: this.columns, ops: clone(this.ops), maximum: this.maximum })
      const selected = clone(state.tables[this.table] || []).filter(row => this.ops.every(([op, field, value]) => op === 'eq' ? row[field] === value : op === 'in' ? value.includes(row[field]) : op === 'gte' ? row[field] >= value : op === 'lte' ? row[field] <= value : row[field] > value)).sort((a,b) => a.id.localeCompare(b.id)).slice(0, this.maximum).map(row => Object.fromEntries(this.columns.split(',').filter(name => Object.hasOwn(row, name)).map(name => [name, row[name]])))
      return Promise.resolve({ data: selected, error: null }).then(resolve, reject)
    }
  }
  const client = {
    auth: { async getUser() { state.authCalls++; return { data: { user: state.authFailure ? null : { id: state.responseUserId || state.userId, email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: state.authFailure ? { message: 'PRIVATE_AUTH_ERROR' } : null } } },
    from(table) { return new Query(table) },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args: clone(args) })
      if (state.rpcFailure || name === 'xelay_classroom_workspace' && state.banned) return { data: null, error: { message: 'PRIVATE_RPC_ERROR' } }
      let data
      if (name === 'xelay_classroom_workspace') data = { classrooms: state.teacher ? [{ group_id: group, group_name: 'ЕУБ-1', specialty: 'Економіка', study_year: 1, courses: [{ course_id: course, subject_id: studySubject, status: 'accepted' }] }] : [] }
      else if (name === 'xelay_teaching_group_context') data = { group: { id: args.p_group_id }, courses: clone(state.contextCourses) }
      else if (name === 'xelay_teaching_group') data = clone(state.teaching)
      else if (name === 'xelay_teaching_calendar') data = { lessons: clone(state.calendar) }
      else if (name === 'xelay_teaching_material_library') data = { materials: clone(state.library) }
      else if (name === 'xelay_group_teacher_materials') data = { materials: clone(state.teaching.materials), subjects: [] }
      else if (name === 'xelay_teaching_course') data = clone(state.courseSnapshot)
      else throw new Error('Unexpected RPC ' + name)
      return { data, error: null }
    },
  }
  const repository = createSupabaseAssistantReadRepository({ client, userId: state.userId, now: () => now })
  const getAccess = () => repository.readAccess({ userId: state.userId, membershipLimit: 101, teachingGrantLimit: 201 })
  const query = async (topic, changes = {}) => {
    const access = await getAccess()
    return repository.readPage({ topic, audience: 'student', selections: [{ groupId: group, allowedSubjectIds: access.memberships[0]?.subjectIds }], from: '2026-11-02', to: '2026-11-02', period: 'current', studentId: state.userId, limit: 31, accessRevision: access.revision, ...changes })
  }
  return { state, client, repository, getAccess, query }
}

test('catalog reads only caller accepted membership and actual namespace IDs', async () => {
  const h = setup()
  const catalog = await h.repository.catalog()
  assert.deepEqual(catalog.groups.map(row => row.id), [group])
  assert.equal(catalog.groups[0].studyYear, 1)
  assert.ok(catalog.subjects.some(row => row.id === studySubject && row.kind === 'study'))
  assert.ok(catalog.subjects.some(row => row.id === materialSubject && row.kind === 'materials'))
  assert.equal(catalog.courses[0].teaching, false)
  assert.deepEqual(catalog.courses[0].teachingGroupIds, [])
  const membership = h.state.queries.find(row => row.table === 'study_group_members')
  assert.ok(membership.ops.some(([op, field, value]) => op === 'eq' && field === 'user_id' && value === user))
  assert.ok(membership.ops.some(([op, field, value]) => op === 'eq' && field === 'status' && value === 'accepted'))
  assert.ok(h.state.queries.every(row => row.columns !== '*' && !row.columns.includes('full_name')))
  assert.ok(!h.state.rpcCalls.some(row => /teacher_status|teaching_workspace$/.test(row.name)))
})

test('ownership without a separate membership row is accepted, deputy rights remain explicit', async () => {
  const h = setup()
  h.state.tables.study_group_members = []
  h.state.tables.study_groups[0].representative_id = user
  const access = await h.getAccess()
  assert.equal(access.memberships[0].membershipStatus, 'accepted')
  const catalog = await h.repository.catalog()
  assert.ok(catalog.groups[0].permissions.includes('schedule'))
  const deputy = setup({ tables: { study_group_deputy_requests: [{ id: ident(81), group_id: group, user_id: user, status: 'approved', permissions: ['homework', 'admin'] }] } })
  assert.deepEqual((await deputy.getAccess()).memberships[0].deputy.permissions, ['homework'])
})

test('known hidden test IDs stay absent for ordinary members and visible for the configured developer viewer', async () => {
  const hidden = '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'
  const h = setup()
  h.state.tables.study_group_members.push({ id: ident(13), group_id: hidden, user_id: user, status: 'accepted' })
  h.state.tables.study_groups.push({ id: hidden, group_name: 'Test', representative_id: user })
  assert.ok(!(await h.repository.catalog()).groups.some(row => row.id === hidden))
  const developer = '04f587f8-1604-4f53-aabc-d1699c938b1d'
  const permitted = setup({ userId: developer })
  permitted.state.tables.study_groups = [{ id: hidden, group_name: 'Test', representative_id: developer }]
  permitted.state.tables.study_group_members = []
  permitted.state.tables.study_group_seminar_subjects = []
  permitted.state.tables.study_group_material_subjects = []
  assert.ok((await permitted.repository.catalog()).groups.some(row => row.id === hidden))
})

test('real schedule rows expand exact dated occurrences and retain their original timetable UUID', async () => {
  const h = setup()
  const page = await h.query('study', { to: '2026-11-09' })
  const lessons = page.rows.filter(row => row.kind === 'lesson')
  assert.equal(lessons.length, 2)
  assert.notEqual(lessons[0].id, lessons[1].id)
  assert.equal(lessons[0].scheduleId, scheduleId)
  assert.equal(lessons[0].id, assistantOccurrenceId(scheduleId, '2026-11-02'))
  assert.equal(lessons[0].startsAt, '08:30')
  assert.deepEqual(lessons[0].links, ['https://example.com/room', 'https://example.com/second'])
  assert.equal(lessons[0].accessCode, 'PRIVATE_PASS')
  const homework = page.rows.find(row => row.kind === 'homework')
  assert.equal(homework.body, 'Усі умови без змін.')
  assert.equal(homework.lessonId, lessons[0].id)
  assert.equal(homework.dueAt, null)
})

test('group homework reads the real due_at column without inventing a deadline for older rows',async()=>{
  const h=setup(),due='2026-11-03T18:30:00+00:00'
  h.state.tables.study_group_homework[0].due_at=due
  const page=await h.query('study'),work=page.rows.find(row=>row.kind==='homework')
  assert.equal(work.dueAt,due);assert.equal(work.body,'Усі умови без змін.')
  assert.ok(h.state.queries.find(row=>row.table==='study_group_homework').columns.split(',').includes('due_at'))
  h.state.tables.study_group_homework[0].due_at=null
  assert.equal((await h.query('study')).rows.find(row=>row.kind==='homework').dueAt,null)
  delete h.state.tables.study_group_homework[0].due_at
  assert.equal((await h.query('study')).rows.find(row=>row.kind==='homework').dueAt,null)
})

test('invalid or timezone-free homework deadlines fail closed rather than silently becoming free submission',async()=>{
  for(const due of ['infinity','2026-02-31T18:30:00Z','2026-11-03T25:30:00Z','2026-11-03T18:30:00','javascript:alert(1)',12]){
    const h=setup();h.state.tables.study_group_homework[0].due_at=due
    await assert.rejects(h.query('study'),{code:'assistant_read_repository_invalid'})
  }
})

test('published teacher homework retains its target deadline with the same validation',async()=>{
  const h=setup(),due='2026-11-03T18:30:00.123456+02:00'
  h.state.teaching.assignments=[{id:ident(511),course_id:course,status:'published',title:'Контрольна',body:'Точні умови',targets:[{group_id:group,lesson_date:'2026-11-02',due_at:due}]}]
  const work=(await h.query('study')).rows.find(row=>row.id===assistantOccurrenceId(ident(511),'2026-11-02'))
  assert.equal(work.dueAt,due)
  h.state.teaching.assignments[0].targets[0].due_at='infinity'
  await assert.rejects(h.query('study'),{code:'assistant_read_repository_invalid'})
})

test('upper/lower weeks, exclusions and copied lesson links come from the exact source row', async () => {
  const h = setup()
  h.state.tables.study_group_schedule[0].week_pattern = 'upper'
  h.state.tables.study_group_schedule[0].week_anchor_date = '2026-11-02'
  h.state.tables.study_group_schedule[0].excluded_dates = ['2026-11-16']
  const page = await h.query('study', { to: '2026-11-23' })
  assert.deepEqual(page.rows.filter(row => row.kind === 'lesson').map(row => row.date), ['2026-11-02'])
  h.state.tables.study_group_schedule[0].week_pattern = 'lower'
  const lower = await h.query('study', { to: '2026-11-23' })
  assert.deepEqual(lower.rows.filter(row => row.kind === 'lesson').map(row => row.date), ['2026-11-09', '2026-11-23'])
  assert.equal(lower.rows.filter(row => row.kind === 'homework').length, 0)
})

test('dated lessons are chronological regardless of UUID order, with homework beside its related lesson', async () => {
  const h = setup()
  const base = h.state.tables.study_group_schedule[0]
  h.state.tables.study_group_schedule = [
    { ...base, id: scheduleId, starts_at: '12:50:00', ends_at: '14:10:00' },
    { ...base, id: ident(402), starts_at: '08:00:00', ends_at: '09:20:00' },
    { ...base, id: ident(403), starts_at: '11:20:00', ends_at: '12:40:00' },
    { ...base, id: ident(404), starts_at: '09:40:00', ends_at: '11:00:00' },
  ]
  h.state.tables.study_group_homework[0].schedule_item_id = ident(404)
  const page = await h.query('study')
  assert.deepEqual(page.rows.filter(row => row.kind === 'lesson').map(row => row.startsAt), ['08:00', '09:40', '11:20', '12:50'])
  assert.deepEqual(page.rows.slice(0, 4).map(row => row.kind), ['lesson', 'lesson', 'homework', 'lesson'])
  assert.equal(page.rows[2].lessonId, page.rows[1].id)
})

test('teacher calendar matches group and course and rejects mismatched subject labels', async () => {
  const h = setup({ teacher: true })
  const access = await h.getAccess()
  assert.equal(access.teachingGrants[0].subjectId, studySubject)
  const teachingCatalog = await h.repository.catalog()
  assert.equal(teachingCatalog.courses[0].teaching, true)
  assert.deepEqual(teachingCatalog.courses[0].teachingGroupIds, [group])
  const calendarRow = { id: scheduleId, group_id: group, course_id: course, source: 'timetable', subject_name: 'Вища математика', lesson_date: '2026-11-02', starts_at: '08:30:00', ends_at: '09:50:00' }
  h.state.calendar = [calendarRow, { ...calendarRow, id: ident(402), course_id: foreignCourse, subject_name: 'Історія економіки' }, { ...calendarRow, id: ident(403), source: 'seminar', questions: ['INTERNAL_STUDENT_QUESTION'] }]
  const query = { topic: 'teaching', audience: 'teacher', selections: [{ groupId: group, courseId: course, subjectId: studySubject }], from: '2026-11-02', to: '2026-11-02', period: 'current', limit: 31, accessRevision: access.revision }
  const result = await h.repository.readPage(query)
  assert.equal(result.rows.length, 1)
  assert.ok(!JSON.stringify(result).includes('INTERNAL_STUDENT_QUESTION'))
  h.state.calendar = [{ ...calendarRow, subject_name: 'Історія економіки' }]
  await assert.rejects(h.repository.readPage(query), error => error.code === 'assistant_teacher_subject_mismatch')
})

test('own published grades retain coefficients while raw names and unpublished results stay out', async () => {
  const h = setup()
  h.state.teaching.grades = [{ id: ident(701), course_id: course, group_id: group, activity_id: ident(702), activity_title: 'Семінар', published_score: 4, max_points: 5, published_at: '2026-11-01T12:00:00Z', grading_rules: courses[0].grading_rules, category: 'seminar', full_name: 'PRIVATE_NAME' }, { id: ident(703), course_id: course, group_id: group, activity_id: ident(702), published_score: 5, max_points: 5, published_at: null }]
  const result = await h.query('results')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].studentId, user)
  assert.equal(result.rows[0].coefficient, 2)
  const destination = new URL(result.rows[0].sourcePath, 'https://www.xelay.ink')
  assert.equal(destination.pathname, `/groups/${group}`)
  assert.equal(destination.searchParams.get('grades'), 'own')
  assert.equal(destination.searchParams.get('gradeCourse'), course)
  assert.equal(destination.searchParams.has('teaching'), false)
  assert.equal(destination.searchParams.has('userId'), false)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_NAME'))
  h.state.teaching.grades[0].user_id = peer
  await assert.rejects(h.query('results'), error => error.code === 'assistant_read_repository_scope_violation')
})

test('teacher gradebook immediately whitelists the authorized snapshot without roster, contact, audit or seminar content', async () => {
  const h = setup({ teacher: true })
  const access = await h.getAccess()
  h.state.courseSnapshot.entries = [{ id: ident(801), user_id: peer, course_id: course, group_id: group, full_name: 'PRIVATE_NAME', active: true, contact: 'PRIVATE_CONTACT' }]
  h.state.courseSnapshot.activities = [{ id: ident(802), course_id: course, group_id: group, title: 'Робота', category: 'seminar', max_points: 10 }]
  h.state.courseSnapshot.grades = [{ id: ident(803), course_id: course, group_id: group, entry_id: ident(801), activity_id: ident(802), draft_score: 8, published_score: 5, published_at: '2026-11-01T12:00:00Z' }]
  h.state.courseSnapshot.audit = ['PRIVATE_AUDIT']
  const result = await h.repository.readPage({ topic: 'gradebook', audience: 'teacher', selections: [{ groupId: group, courseId: course, subjectId: studySubject }], period: 'current', limit: 31, accessRevision: access.revision })
  assert.equal(result.rows[0].points, 8)
  assert.equal(result.rows[0].published, false)
  assert.equal(result.rows[0].studentId, peer)
  assert.equal(result.rows[0].studentName,'PRIVATE_NAME')
  assert.ok(!/PRIVATE_CONTACT|PRIVATE_AUDIT/.test(JSON.stringify(result)))
  h.state.courseSnapshot.seminars.questions = ['INTERNAL']
  await assert.rejects(h.repository.readPage({ topic: 'gradebook', audience: 'teacher', selections: [{ groupId: group, courseId: course, subjectId: studySubject }], period: 'current', limit: 31, accessRevision: access.revision }), error => error.code === 'assistant_teacher_seminar_boundary')
})

test('group material content remains display-only and storage paths never leave the adapter', async () => {
  const h = setup()
  const page = await h.query('materials')
  assert.equal(page.rows[0].body, 'PRIVATE_MATERIAL')
  assert.equal(page.rows[0].allowAi, false)
  assert.equal(page.rows[0].fileName, 'lesson.pdf')
  assert.ok(!JSON.stringify(page).includes('PRIVATE_STORAGE_PATH'))
  const read = createAuthenticatedAssistantReadService({ verifySession: async () => ({ userId: user, accountActive: true, emailConfirmed: true, expiresAt: '2026-11-03T00:00:00Z' }), createCallerRepository: () => h.repository, now: () => now })
  const result = await read.read('synthetic-credential', { topic: 'materials', scope: { groupId: group } })
  assert.ok(!JSON.stringify(result.modelContext).includes('PRIVATE_MATERIAL'))
})

test('teacher library retains only requested visible target and applies expiry and withdrawal', async () => {
  const h = setup({ teacher: true })
  const access = await h.getAccess()
  h.state.library = [{ id: ident(901), course_id: course, title: 'Лекція', body: 'PRIVATE_TEACHER_BODY', status: 'published', allow_download: false, version: 2, targets: [{ group_id: group }, { group_id: foreign }], collaborators: [{ full_name: 'PRIVATE_COLLEAGUE' }], target_group_names: ['PRIVATE_FOREIGN_GROUP'] }]
  const query = { topic: 'materials', audience: 'teacher', selections: [{ groupId: group, courseId: course, subjectId: studySubject }], period: 'current', limit: 31, accessRevision: access.revision }
  const result = await h.repository.readPage(query)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].allowAi, false)
  assert.equal(result.rows[0].allowDownload, false)
  assert.ok(!/PRIVATE_COLLEAGUE|PRIVATE_FOREIGN_GROUP/.test(JSON.stringify(result)))
  h.state.library[0].withdrawn_at = '2026-11-01T12:00:00Z'
  assert.equal((await h.repository.readPage(query)).rows.length, 0)
})

test('verified session uses Auth authority first, rejects service tokens, expiry and active-account failure', async () => {
  const h = setup()
  const accepted = await verifySupabaseAssistantSession(h.client, jwt(), now)
  assert.equal(accepted.userId, user)
  assert.equal(accepted.accountActive, true)
  assert.equal(accepted.sessionId, 'test-session')
  for (const token of [jwt({ sub: peer }), jwt({ role: 'service_role' }), jwt({ exp: Math.floor(now / 1000) - 1 }), 'not.a.jwt']) assert.equal(await verifySupabaseAssistantSession(h.client, token, now), null)
  h.state.banned = true
  assert.equal(await verifySupabaseAssistantSession(h.client, jwt(), now), null)
  h.state.banned = false; h.state.authFailure = true
  const before = h.state.rpcCalls.length
  assert.equal(await verifySupabaseAssistantSession(h.client, jwt(), now), null)
  assert.equal(h.state.rpcCalls.length, before)
})

test('account switching, direct foreign selection, cancellation and raw errors fail closed', async () => {
  const h = setup()
  const access = await h.getAccess()
  await assert.rejects(h.repository.readPage({ topic: 'study', audience: 'student', selections: [{ groupId: foreign }], from: '2026-11-02', to: '2026-11-02', period: 'current', limit: 31, accessRevision: access.revision }), error => error.code === 'assistant_read_repository_scope_violation')
  h.state.responseUserId = peer
  await assert.rejects(h.repository.catalog(), error => error.code === 'assistant_account_changed')
  h.state.responseUserId = null; h.state.rpcFailure = true
  await assert.rejects(h.repository.catalog(), error => !error.message.includes('PRIVATE_RPC_ERROR'))
  const controller = new AbortController(); controller.abort()
  const before = h.state.queries.length
  await assert.rejects(h.repository.catalog(controller.signal), error => error.code === 'request_cancelled')
  assert.equal(h.state.queries.length, before)
})

test('bounded keyset pages preserve all rows before response truncation without a redundant final query', async () => {
  const h = setup()
  const base = h.state.tables.study_group_schedule[0]
  h.state.tables.study_group_schedule = Array.from({ length: 205 }, (_, index) => ({ ...base, id: ident(10000 + index) }))
  const page = await h.query('study')
  assert.equal(page.rows.length, 31)
  assert.equal(page.hasMore, true)
  const reads = h.state.queries.filter(row => row.table === 'study_group_schedule')
  assert.equal(reads.length, 3)
  assert.ok(reads.every(row => row.maximum <= 100))
  assert.ok(reads[1].ops.some(([operation, field]) => operation === 'gt' && field === 'id'))
})

test('missing teacher subject mapping does not guess one or break independent student membership', async () => {
  const h = setup({ teacher: true })
  h.state.contextCourses[0].subject_id = null
  const access = await h.getAccess()
  assert.equal(access.teachingGrants.length, 0)
  assert.equal(access.memberships.length, 1)
  assert.ok((await h.query('study')).rows.some(row => row.kind === 'lesson'))
})

test('the adapter itself bounds date spans even if invoked without the higher-level read service', async () => {
  const h = setup()
  const access = await h.getAccess()
  const before = h.state.queries.length
  await assert.rejects(h.repository.readPage({ topic: 'study', audience: 'student', selections: [{ groupId: group }], from: '2026-11-02', to: '2027-11-02', period: 'current', limit: 31, accessRevision: access.revision }), error => error.code === 'assistant_read_date_range_invalid')
  assert.equal(h.state.queries.length, before)
})

test('actual teacher names and source links point to supported schedule/homework deep-link parameters',async()=>{
 const h=setup();h.state.tables.study_group_schedule[0].teacher_name='Synthetic Lecturer'
 const page=await h.query('study'),lesson=page.rows.find(r=>r.kind==='lesson'),homework=page.rows.find(r=>r.kind==='homework')
 assert.equal(lesson.teacherName,'Synthetic Lecturer');assert.equal(homework.teacherName,'Synthetic Lecturer')
 const target=new URL(homework.sourcePath,'https://www.xelay.ink')
 assert.equal(target.searchParams.get('assignment'),h.state.tables.study_group_homework[0].id)
 assert.equal(target.searchParams.get('kind'),'homework');assert.equal(target.searchParams.get('date'),'2026-11-02')
})
