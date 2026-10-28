import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const compiled = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const modelUrl = uri(compiled(await read('src/lib/homeDashboardModel.ts')))
const timetableSource = await read('src/lib/studyGroupTimetable.ts')
const timetablePure = timetableSource.slice(timetableSource.indexOf('export const LESSON_TYPES'), timetableSource.indexOf('export function timetableImportError'))
const timetableUrl = uri(compiled(timetablePure))
const linksUrl = uri(compiled(await read('src/lib/studyGroupLinks.ts')))
const repositorySource = await read('src/lib/homeDashboardRepository.ts')
const repositoryJs = compiled(repositorySource)
  .replace(/import \{ supabase \} from ['"]\.\/supabase['"];?/, 'const supabase = globalThis.__homeDashboardTestClient;')
  .replace(/import \{ loadStudyGroupScheduleHistory \} from ['"]\.\/studyGroupScheduleRead['"];?/, 'const loadStudyGroupScheduleHistory = (...args) => globalThis.__homeDashboardTestSchedule(...args);')
  .replace(/['"]\.\/homeDashboardModel['"]/g, JSON.stringify(modelUrl))
  .replace(/['"]\.\/studyGroupTimetable['"]/g, JSON.stringify(timetableUrl))
  .replace(/['"]\.\/studyGroupLinks['"]/g, JSON.stringify(linksUrl))
let defaultClient
globalThis.__homeDashboardTestClient = {
  auth: { getSession: (...args) => defaultClient.auth.getSession(...args) },
  from: (...args) => defaultClient.from(...args),
  rpc: (...args) => defaultClient.rpc(...args),
}
globalThis.__homeDashboardTestSchedule = async groupId => ({ data: [{ ...slot, group_id: groupId }], error: null })
const { loadLearningHomeDashboard, normalizeHomeTeachingSummary } = await import(uri(repositoryJs))
const { selectHomeDashboard } = await import(modelUrl)

const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const actor = id(1), groupId = id(2), otherGroup = id(3), slotId = id(4), courseId = id(5), itemId = id(6)
const clockIso = '2026-10-28T10:15:00+02:00'
const group = { id: groupId, group_name: 'Test group', representative_id: id(99), specialty: 'Economics', cohort_start_year: 2026, study_level: 'bachelor' }
const slot = { id: slotId, group_id: groupId, weekday: 3, starts_at: '09:40:00', ends_at: '11:00:00', subject: 'Mathematics', lesson_type: 'lecture', location: '203', online_url: null, conference_id: 'synthetic123', conference_access_code: 'synthetic', valid_from: '2026-09-01', valid_until: '2027-01-31', created_by: actor, week_pattern: 'every', excluded_dates: [] }
const course = { id: courseId, title: 'Mathematics', subject_id: id(7), archived_at: null }
const assignment = { id: itemId, course_id: courseId, title: 'Teacher task', body: 'Actual published task', targets: [{ group_id: groupId, due_at: '2026-10-29T17:00:00Z', lesson_date: '2026-10-29' }], status: 'published', published_at: '2026-10-27T14:00:00Z', author_name: 'Synthetic teacher', submission_format: 'written' }
const ownState = status => ({ item_id: itemId, course_id: courseId, group_id: groupId, user_id: actor, status, effective_closes_at: null })

function fixture(patch = {}) {
  const calls = []
  let actorChecks = 0
  const source = {
    assertActor: async () => { actorChecks++; if (patch.accountChanged && actorChecks > 1) throw new Error('ACCOUNT_CHANGED') },
    access: async () => ({ groups: patch.groups || [group], memberships: patch.memberships || [{ group_id: groupId, user_id: actor, status: 'accepted' }], deputies: patch.deputies || [] }),
    schedule: async (id, current) => { calls.push(['schedule', id]); assert.equal(current(), true); return patch.schedule || [slot] },
    homework: async (ids, from, until) => { calls.push(['homework', ids, from, until]); return patch.homework || [] },
    longTerm: async (ids, from, until) => { calls.push(['longTerm', ids, from, until]); return patch.longTerm || [] },
    materials: async ids => { calls.push(['materials', ids]); return patch.materials || [] },
    teachingGroup: async id => { calls.push(['teachingGroup', id]); return patch.teaching || { courses: [course], assignments: [], materials: [], grades: [], pending_invites: [] } },
    summary: async ids => { calls.push(['summary', ids]); if (patch.summaryError) throw new Error('RPC missing'); return patch.summary || { assignments: [], teacher_reviews: [] } },
  }
  return { source, calls, checkCount: () => actorChecks }
}
const dashboard = slice => ({ role: 'student', displayName: 'Test', initials: 'T', clockIso, contexts: ['learning'], teachingVerified: false, status: 'ready', participantCount: 0, community: [], news: [], ...slice })
const load = fixture => loadLearningHomeDashboard({ userId: actor, clockIso, source: fixture.source })

test('fresh accepted membership, ownership and actual deputy grants define learning access', async () => {
  const fx = fixture({ groups: [group, { ...group, id: otherGroup }, { ...group, id: id(40), representative_id: actor }], memberships: [{ group_id: groupId, user_id: actor, status: 'pending' }, { group_id: otherGroup, user_id: id(88), status: 'accepted' }], schedule: [] })
  const result = await load(fx)
  assert.deepEqual(result.groups.map(row => [row.id, row.status]), [[groupId, 'invited'], [id(40), 'accepted']])
  assert.equal(result.pendingInvitations, 1)
  assert.equal(result.isHeadman, true)
  assert.ok(fx.calls.filter(call => call[0] === 'schedule').every(call => call[1] === id(40)))
  assert.equal(result.groups.find(row => row.id === id(40)).studyYear, 1)
  const deputy = await load(fixture({ deputies: [{ group_id: groupId, user_id: actor, status: 'approved', permissions: ['homework', 'invite_members'] }] }))
  assert.deepEqual(deputy.groups[0].permissions, ['homework', 'members'])
  const revoked = await load(fixture({ deputies: [{ group_id: groupId, user_id: actor, status: 'revoked', permissions: ['schedule'] }] }))
  assert.deepEqual(revoked.groups[0].permissions, [])
})

test('an accepted invite is discovered without changing any profile group list or cache', async () => {
  const fx = fixture({ memberships: [{ group_id: groupId, user_id: actor, status: 'pending' }] })
  assert.equal((await load(fx)).lessons.length, 0)
  fx.source.access = async () => ({ groups: [group], memberships: [{ group_id: groupId, user_id: actor, status: 'accepted' }], deputies: [] })
  assert.ok((await load(fx)).lessons.length > 0)
})

test('the real shared occurrence algorithm respects upper/lower, cancellation, single dates and Saturday custom times', async () => {
  const fx = fixture({ schedule: [{ ...slot, week_pattern: 'upper', week_anchor_date: '2026-10-19' }, { ...slot, id: id(8), weekday: 6, starts_at: '08:30:00', ends_at: '09:50:00', valid_from: '2026-10-31', valid_until: '2026-10-31' }, { ...slot, id: id(9), excluded_dates: ['2026-10-28'] }] })
  const result = await load(fx)
  assert.equal(result.lessons.some(row => row.id === `${slotId}:2026-10-28`), false)
  assert.equal(result.lessons.some(row => row.id === `${slotId}:2026-11-04`), true)
  assert.equal(result.lessons.some(row => row.id === `${id(9)}:2026-10-28`), false)
  assert.equal(result.lessons.find(row => row.id === `${id(8)}:2026-10-31`).startsAt, '08:30')
})

test('ordinary homework keeps preparation semantics, has no invented deadline and follows its real occurrence', async () => {
  const ordinary = { id: id(10), group_id: groupId, schedule_item_id: slotId, lesson_date: '2026-10-28', lesson_topic: 'Read chapter', body: 'Prepare discussion' }
  const result = await load(fixture({ homework: [ordinary, { ...ordinary, id: id(11), group_id: otherGroup }, { ...ordinary, id: id(12), lesson_date: '2026-10-29' }] }))
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].kind, 'preparation')
  assert.equal(result.tasks[0].dueAt, null)
  assert.equal(result.tasks[0].dueDate, undefined)
  assert.equal(selectHomeDashboard(dashboard(result)).tasks[0].overdue, false)
  assert.equal(result.lessons.find(row => row.date === '2026-10-28').homeworkId, ordinary.id)
})

test('calendar-only long term deadlines remain dates and expire only on the following Kyiv day', async () => {
  const result = await load(fixture({ longTerm: [{ id: id(13), group_id: groupId, subject: 'Mathematics', title: 'Long task', description: 'Actual task', due_date: '2026-10-28', closed_at: null }, { id: id(14), group_id: groupId, subject: 'Mathematics', title: 'Closed task', description: '', due_date: '2026-10-27', closed_at: clockIso }] }))
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].dueDate, '2026-10-28')
  assert.equal(result.tasks[0].dueAt, null)
  const today = selectHomeDashboard(dashboard(result)).tasks[0]
  assert.equal(today.overdue, false)
  assert.match(today.dueLabel, /28/)
  assert.equal(selectHomeDashboard({ ...dashboard(result), clockIso: '2026-10-29T00:01:00+02:00' }).tasks[0].overdue, true)
})

test('dual-role accounts never mix teacher calendar rows into their own student timetable', async () => {
  const result = await load(fixture())
  const learningLesson = result.lessons.find(row => row.date === '2026-10-28')
  const dual = { ...dashboard(result), contexts: ['learning', 'teaching'], teachingVerified: true,
    groups: result.groups.map(row => ({ ...row, teachingSubjectIds: [courseId] })),
    lessons: [learningLesson, { ...learningLesson, id: 'distinct-calendar-id', subjectId: courseId, context: 'teaching' }] }
  assert.deepEqual(selectHomeDashboard(dual, { context: 'learning' }).lessons.map(row => row.id), [learningLesson.id])
  assert.deepEqual(selectHomeDashboard(dual, { context: 'teaching' }).lessons.map(row => row.id), ['distinct-calendar-id'])
})

test('a teacher material grant never grants editing or management inside the same student group', async () => {
  const result = await load(fixture())
  const dual = { ...dashboard(result), contexts: ['learning', 'teaching'], teachingVerified: true,
    groups: result.groups.map(row => ({ ...row, permissions: ['materials'], learningPermissions: [], teachingPermissions: ['materials'], teachingSubjectIds: [courseId] })),
    tasks: [{ id: 'student-edit', groupId, title: 'Student management', description: '', kind: 'group-request', audience: 'management', status: 'open', href: '/', actionLabel: 'Open', requiredPermission: 'materials' },
      { id: 'teacher-edit', groupId, subjectId: courseId, title: 'Teacher materials', description: '', kind: 'review', audience: 'teaching', status: 'open', href: '/', actionLabel: 'Open', requiredPermission: 'materials' }] }
  const learning = selectHomeDashboard(dual, { context: 'learning' })
  assert.equal(learning.canManage, false)
  assert.deepEqual(learning.quickActions, [])
  assert.deepEqual(learning.tasks, [])
  const teaching = selectHomeDashboard(dual, { context: 'teaching' })
  assert.equal(teaching.quickActions.some(row => row.kind === 'materials'), true)
  assert.deepEqual(teaching.tasks.map(row => row.id), ['teacher-edit'])
})

test('unknown submission status is a publication update, never an invented unsubmitted task', async () => {
  for (const extra of [{ summaryError: true }, { summary: { assignments: [], teacher_reviews: [] } }]) {
    const result = await load(fixture({ ...extra, teaching: { courses: [course], assignments: [assignment], materials: [], grades: [], pending_invites: [] } }))
    assert.equal(result.tasks.length, 0)
    assert.equal(result.updates[0].title, assignment.title)
    assert.equal(result.updates[0].isNew, undefined)
  }
})

test('old published assignments with a future deadline or lesson stay visible when own state is unavailable', async () => {
  const old = { ...assignment, published_at: '2026-09-01T10:00:00Z' }
  const futureDeadline = { ...old, targets: [{ group_id: groupId, due_at: '2026-11-01T17:00:00Z' }] }
  const futureLesson = { ...old, id: id(61), targets: [{ group_id: groupId, lesson_date: '2026-10-29', due_at: null }] }
  const past = { ...old, id: id(62), targets: [{ group_id: groupId, lesson_date: '2026-10-01', due_at: '2026-10-01T17:00:00Z' }] }
  const result = await load(fixture({ summaryError: true, teaching: { courses: [course], assignments: [futureDeadline, futureLesson, past], materials: [], grades: [], pending_invites: [] } }))
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(new Set(result.updates.map(row => row.id)), new Set([`assignment:${groupId}:${itemId}`, `assignment:${groupId}:${id(61)}`]))
  assert.ok(result.updates.every(row => row.createdAt === old.published_at))
})

test('explicit aggregate null and known submission states produce accurate work status', async () => {
  for (const [state, expected] of [[null, 'open'], ['draft', 'in-progress'], ['returned', 'returned'], ['submitted', 'submitted'], ['reviewed', 'submitted']]) {
    const result = await load(fixture({ summary: { assignments: [ownState(state)], teacher_reviews: [] }, teaching: { courses: [course], assignments: [assignment], materials: [], grades: [], pending_invites: [] } }))
    assert.equal(result.tasks[0].status, expected)
    assert.equal(result.tasks[0].dueAt, assignment.targets[0].due_at)
    assert.equal(selectHomeDashboard(dashboard(result)).tasks.length, expected === 'submitted' ? 0 : 1)
  }
})

test('published own grades preserve actual zero while unpublished and missing grades never become zero', async () => {
  const base = { id: id(15), group_id: groupId, course_id: courseId, published_at: '2026-10-28T08:00:00Z', activity_title: 'Test', max_points: 5, published_score: 0, published_comment: '' }
  const result = await load(fixture({ teaching: { courses: [course], assignments: [], materials: [], pending_invites: [], grades: [base, { ...base, id: id(16), published_score: null }, { ...base, id: id(17), published_at: null }, { ...base, id: id(18), group_id: otherGroup }] } }))
  assert.equal(result.updates.length, 1)
  assert.match(result.updates[0].description, /^0 з 5/)
  assert.match(result.updates[0].href, /groups\//)
})

test('server publications must be published, targeted to the accepted group and attached to a visible course', async () => {
  const result = await load(fixture({ summary: { assignments: [ownState(null)], teacher_reviews: [] }, teaching: { courses: [course], assignments: [{ ...assignment, status: 'draft' }, { ...assignment, id: id(19), targets: [{ group_id: otherGroup }] }, { ...assignment, id: id(20), course_id: id(999) }], materials: [], grades: [], pending_invites: [] } }))
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.updates, [])
})

test('one group read is shared by all its occurrences and does not fetch a classroom per assignment', async () => {
  const fx = fixture({ schedule: Array.from({ length: 40 }, (_, index) => ({ ...slot, id: id(100 + index) })) })
  const result = await load(fx)
  assert.ok(result.lessons.length > 40)
  assert.equal(fx.calls.filter(call => call[0] === 'schedule').length, 1)
  assert.equal(fx.calls.filter(call => call[0] === 'teachingGroup').length, 1)
  assert.equal(fx.calls.filter(call => call[0] === 'homework').length, 1)
  assert.equal(fx.calls.filter(call => call[0] === 'summary').length, 1)
  assert.equal(fx.checkCount(), 2)
  assert.doesNotMatch(repositorySource, /\.classroom\(|classroomSeminars|study_group_seminar_questions|study_group_seminar_teams|\.insert\(|\.update\(|\.delete\(/)
})

test('pending and group-less accounts fetch no private group content', async () => {
  const fx = fixture({ memberships: [{ group_id: groupId, user_id: actor, status: 'pending' }] })
  assert.equal((await load(fx)).pendingInvitations, 1)
  assert.deepEqual(fx.calls, [])
  const empty = fixture({ groups: [] })
  assert.equal((await load(empty)).groups.length, 0)
  assert.deepEqual(empty.calls, [])
})

test('abort and account changes discard the whole result', async () => {
  await assert.rejects(load(fixture({ accountChanged: true })), /ACCOUNT_CHANGED/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loadLearningHomeDashboard({ userId: actor, clockIso, signal: controller.signal, source: fixture().source }), { name: 'AbortError' })
})

test('aggregate normalization rejects unknown state, missing counts, malformed and foreign actor fields', () => {
  assert.throws(() => normalizeHomeTeachingSummary({ assignments: [{ ...ownState(null), status: 'unknown' }], teacher_reviews: [] }))
  assert.throws(() => normalizeHomeTeachingSummary({ assignments: [{ ...ownState(null), user_id: 'bad' }], teacher_reviews: [] }))
  assert.throws(() => normalizeHomeTeachingSummary({ assignments: [], teacher_reviews: [{ item_id: itemId, course_id: courseId, group_id: groupId, title: 'Queue', submitted_count: 2, ungraded_count: 1, last_submitted_at: null }] }))
})

function queryClient(tables, rowCap = 1) {
  const calls = []
  const builder = (name, rpcValue) => {
    const filters = [], orders = []
    let cap = Infinity, columns = ''
    const q = {
      select(value) { columns = value; return q },
      eq(key, value) { filters.push(['eq', key, value]); return q },
      in(key, value) { filters.push(['in', key, value]); return q },
      is(key, value) { filters.push(['eq', key, value]); return q },
      gte(key, value) { filters.push(['gte', key, value]); return q },
      lte(key, value) { filters.push(['lte', key, value]); return q },
      gt(key, value) { filters.push(['gt', key, value]); return q },
      order(key, options) { orders.push([key, options?.ascending !== false]); return q },
      limit(value) { cap = value; return q },
      abortSignal() { return q },
      then(resolve, reject) {
        calls.push({ name, filters, columns, cap })
        if (rpcValue) return Promise.resolve({ data: rpcValue, error: null }).then(resolve, reject)
        let rows = structuredClone(tables[name] || []).filter(row => filters.every(([kind, key, value]) => kind === 'eq' ? row[key] === value : kind === 'in' ? value.includes(row[key]) : kind === 'gt' ? row[key] > value : kind === 'gte' ? row[key] >= value : row[key] <= value))
        for (const [key, asc] of orders.reverse()) rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (asc ? 1 : -1))
        rows = rows.slice(0, Math.min(rowCap, cap))
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
      },
    }
    return q
  }
  return {
    calls,
    auth: { getSession: async () => ({ data: { session: { user: { id: actor } } }, error: null }) },
    from: name => builder(name),
    rpc: (name, args) => {
      if (name === 'xelay_home_teaching_summary') {
        calls.push({ name: 'summary-args', args })
        return builder(name, { assignments: [], teacher_reviews: [] })
      }
      assert.equal(name, 'xelay_teaching_group')
      assert.ok([groupId, id(40)].includes(args.p_group_id))
      return builder(name, { courses: [], assignments: [], materials: [], grades: [], pending_invites: [] })
    },
  }
}

test('default reads use current actor filters, accepted groups only and keyset pagination below the API cap', async () => {
  defaultClient = queryClient({
    study_group_members: [{ id: id(20), group_id: groupId, user_id: actor, status: 'accepted' }, { id: id(21), group_id: otherGroup, user_id: actor, status: 'pending' }, { id: id(22), group_id: id(23), user_id: id(88), status: 'accepted' }],
    study_groups: [group, { ...group, id: otherGroup }, { ...group, id: id(40), representative_id: actor }],
    study_group_deputy_requests: [{ id: id(50), group_id: groupId, user_id: actor, status: 'approved', permissions: ['materials'] }],
  })
  const result = await loadLearningHomeDashboard({ userId: actor, clockIso })
  assert.equal(result.groups.length, 3)
  assert.equal(result.groups.filter(row => row.learning).length, 2)
  assert.equal(result.pendingInvitations, 1)
  assert.deepEqual(result.groups.find(row => row.id === groupId).permissions, ['materials'])
  assert.ok(defaultClient.calls.some(call => call.name === 'study_group_members' && call.filters.some(([kind, key]) => kind === 'gt' && key === 'id')))
  for (const call of defaultClient.calls.filter(call => ['study_group_homework', 'study_group_materials', 'study_group_long_term_tasks'].includes(call.name))) {
    const scope = call.filters.find(([kind, key]) => kind === 'in' && key === 'group_id')[2]
    assert.deepEqual(new Set(scope), new Set([groupId, id(40)]))
    assert.equal(scope.includes(otherGroup), false)
  }
  assert.deepEqual(new Set(defaultClient.calls.find(call => call.name === 'summary-args').args.p_group_ids), new Set([groupId, id(40)]))
})
