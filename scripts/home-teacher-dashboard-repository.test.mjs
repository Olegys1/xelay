// Synthetic repository contracts only. No database, model, browser or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url)), modules = new Map()
function load(file) {
  const filename = resolve(root, file)
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const result = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  vm.runInNewContext(result.outputText, { module, exports: module.exports, Date, Intl, DOMException, URL,
    require(name) { if (['./homeDashboardModel', './homeLessonConference', './studyGroupLinks'].includes(name)) return load(resolve(dirname(filename), `${name}.ts`)); throw new Error(`Unexpected runtime import: ${name}`) },
  }, { filename })
  return module.exports
}
const { loadTeacherHomeDashboard } = load('src/lib/homeTeacherDashboardRepository.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const user = id(1), courseA = id(10), courseB = id(11), groupA = id(20), groupB = id(21)
const clockIso = '2026-10-28T10:15:00+02:00'
const course = (key, permissions = ['assignments', 'materials', 'grades']) => ({ id: key, title: `Subject ${key}`, starts_on: '2026-09-01', ends_on: '2027-01-31', archived_at: null, permissions })
const classroom = (group = groupA, links = [courseA]) => ({ group_id: group, group_name: `Group ${group}`, specialty: 'Economics', study_year: 1, courses: links.map(course_id => ({ course_id, status: 'accepted' })) })
const lesson = (extra = {}) => ({ id: id(30), course_id: courseA, group_id: groupA, subject_name: 'Mathematics', lesson_date: '2026-10-28', starts_at: '09:40:00', ends_at: '11:00:00', lesson_type: 'lecture', source: 'timetable', location: '906', ...extra })
const request = (extra = {}) => ({ id: id(40), course_id: courseA, group_id: groupA, student_name: 'Synthetic student', message: 'Please explain', activity_title: 'Exercise', status: 'open', can_manage: true, can_resolve: true, ...extra })
const publication = (extra = {}) => ({ id: id(50), course_id: courseA, title: 'Synthetic publication', status: 'scheduled', kind: 'assignment', publish_at: '2026-10-29T08:00:00+02:00', targets: [{ group_id: groupA }], ...extra })

function fixture() {
  const calls = []
  const workspace = { teacher_status: { verified: true, has_current_access: true }, courses: [course(courseA)], classrooms: [classroom()], groups: [], teacher_directory: [] }
  const calendar = { lessons: [lesson()] }, scheduled = { items: [publication()] }, enquiries = { requests: [request()] }
  const repository = new Proxy({
    mode: 'local',
    async workspace() { calls.push(['workspace']); return workspace },
    async teacherCalendar(...args) { calls.push(['calendar', ...args]); return calendar },
    async scheduledItems(...args) { calls.push(['scheduled', ...args]); return scheduled },
    async gradeRequests(...args) { calls.push(['requests', ...args]); return enquiries },
  }, { get(source, key) { if (key in source) return source[key]; throw new Error(`Forbidden additional read or write: ${String(key)}`) } })
  return { calls, workspace, calendar, scheduled, enquiries, repository, load: extra => loadTeacherHomeDashboard({ userId: user, clockIso, repository, ...extra }) }
}

test('teacher home uses the exact authorized calendar conference tuple, including a secondary link and codes', async () => {
  const fx = fixture()
  fx.calendar.lessons = [
    lesson({ online_url: 'https://zoom.us/j/123456789?pwd=synthetic', conference_id: '123 456 789', conference_access_code: '000067' }),
    lesson({ id: id(31), starts_at: '11:20:00', ends_at: '12:40:00', online_url: 'javascript:invalid', online_url_secondary: 'https://meet.google.com/synthetic-meet' }),
    lesson({ id: id(32), starts_at: '12:50:00', ends_at: '14:10:00', conference_access_code: '000067' }),
  ]
  const result = await fx.load()
  assert.equal(result.lessons.length, 3)
  assert.deepEqual(plain(result.lessons[0].conference), { href: fx.calendar.lessons[0].online_url, meetingId: '123 456 789', passcode: '000067' })
  assert.equal(result.lessons[1].conference.href, 'https://meet.google.com/synthetic-meet')
  assert.deepEqual(plain(result.lessons[2].conference), { passcode: '000067' })
  assert.deepEqual(fx.calls.map(([name]) => name), ['workspace', 'calendar', 'scheduled', 'requests'], 'No additional group reads are needed')
})

test('conference access is discarded with a foreign group, foreign subject or student seminar row', async () => {
  const fx = fixture()
  const foreignAccess = { online_url: 'https://zoom.us/j/999999999', conference_id: 'PRIVATE_FOREIGN_MEETING' }
  fx.calendar.lessons.push(lesson({ ...foreignAccess, id: id(33), group_id: groupB }))
  fx.calendar.lessons.push(lesson({ ...foreignAccess, id: id(34), course_id: courseB }))
  fx.calendar.lessons.push(lesson({ ...foreignAccess, id: id(35), source: 'seminar' }))
  const result = await fx.load()
  assert.equal(result.lessons.length, 1)
  assert.equal(result.lessons[0].conference, undefined, 'Older calendar rows without a tuple remain without a join action')
  assert.equal(JSON.stringify(result).includes('PRIVATE_FOREIGN_MEETING'), false)
})

test('one bounded account load reuses a workspace and never reads works or seminar allocations', async () => {
  const fx = fixture(), before = plain(fx.workspace)
  const result = await fx.load()
  assert.deepEqual(fx.calls, [['workspace'], ['calendar', '2026-10-26', '2026-11-12'], ['scheduled'], ['requests']])
  assert.equal(result.lessons.length, 1)
  assert.equal(result.tasks[0].kind, 'grade-request')
  assert.equal(result.reviewCountsAvailable, false)
  assert.ok(!result.tasks.some(task => task.kind === 'review'), 'No fabricated submission-review total')
  assert.equal(result.lessons[0].href, `/teaching?course=${courseA}&group=${groupA}&home=calendar&date=2026-10-28`)
  assert.equal(result.tasks[0].href, `/teaching?course=${courseA}&group=${groupA}&home=requests`)
  assert.equal(result.publications[0].href, `/teaching?course=${courseA}&group=${groupA}&home=scheduled`)
  assert.equal(result.groups[0].teachingSubjectIds[0], courseA)
  assert.deepEqual(plain(fx.workspace), before, 'Source objects remain untouched')
  fx.calls.length = 0
  await fx.load({ workspace: fx.workspace })
  assert.ok(!fx.calls.some(([name]) => name === 'workspace'))
})

test('unverified and expired teaching authority fail closed before private reads', async () => {
  for (const status of [{ verified: false }, { verified: true, has_current_access: false }, { status: 'approved' }]) {
    const fx = fixture(); fx.workspace.teacher_status = status
    const result = await fx.load()
    assert.equal(result.teachingVerified, false)
    assert.equal(result.groups.length + result.tasks.length + result.lessons.length, 0)
    assert.deepEqual(fx.calls, [['workspace']])
  }
})

test('a directory group, a pending link and a revoked course grant never authorize a teacher group', async () => {
  const fx = fixture()
  fx.workspace.groups = [{ id: groupB, group_name: 'Directory entry' }]
  fx.workspace.classrooms.push(classroom(groupB, [courseB]))
  fx.workspace.classrooms[0].courses[0].status = 'pending_teacher'
  fx.workspace.courses.push(course(courseB, []))
  const result = await fx.load()
  assert.equal(result.groups.length, 0)
  assert.deepEqual(fx.calls, [['workspace']])
})

test('calendar narrows exact course/group identity and discards legacy seminar-allocation rows', async () => {
  const fx = fixture()
  fx.calendar.lessons.push(lesson(), lesson({ id: id(31), source: 'seminar' }), lesson({ id: id(32), course_id: courseB }), lesson({ id: id(33), group_id: groupB }), lesson({ id: id(34), lesson_date: '2026-10-27', ends_at: '08:00:00' }), lesson({ id: id(35), lesson_date: '2026-11-13' }), lesson({ id: id(36), lesson_date: '2026-02-30' }), lesson({ lesson_date: '2026-10-29' }))
  const result = await fx.load()
  assert.deepEqual(plain(result.lessons.map(item => item.date)), ['2026-10-28', '2026-10-29'])
  assert.equal(new Set(result.lessons.map(item => item.id)).size, 2)
})

test('grade enquiries require the exact grading grant and server can-manage/can-resolve flags', async () => {
  const fx = fixture()
  fx.workspace.courses.push(course(courseB, ['assignments']))
  fx.workspace.classrooms[0].courses.push({ course_id: courseB, status: 'accepted' })
  fx.enquiries.requests.push(request({ id: id(41), course_id: courseB }), request({ id: id(42), group_id: groupB }), request({ id: id(43), status: 'resolved' }), request({ id: id(44), can_manage: false }), request({ id: id(45), can_resolve: false }), request({ id: id(46), can_resolve: undefined }), request())
  const result = await fx.load()
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].dueAt, null, 'A grade enquiry has no invented deadline')
  assert.equal(result.tasks[0].subjectId, courseA)
})

test('multi-target scheduled publications retain only authorized targets and exact action permissions', async () => {
  const fx = fixture()
  fx.workspace.courses.push(course(courseB, ['materials']))
  fx.workspace.classrooms.push(classroom(groupB, [courseB]))
  fx.scheduled.items = [publication({ targets: [{ group_id: groupA }, { group_id: groupB }, { group_id: groupA }] }), publication({ id: id(51), course_id: courseB, targets: [{ group_id: groupB }] }), publication({ id: id(52), course_id: courseB, kind: 'material', targets: [{ group_id: groupB }] }), publication({ id: id(53), status: 'published' }), publication({ id: id(54), publish_at: '2026-10-27T08:00:00Z' }), publication({ id: id(55), publish_at: '2026-10-29T08:00:00' })]
  const result = await fx.load()
  assert.deepEqual(plain(result.publications.map(item => [item.groupId, item.kind])), [[groupA, 'assignment'], [groupB, 'material']])
})

test('permissions skip unnecessary whole-workspace reads', async () => {
  const materials = fixture(); materials.workspace.courses[0].permissions = ['materials']
  await materials.load()
  assert.ok(!materials.calls.some(([name]) => name === 'requests'))
  const grades = fixture(); grades.workspace.courses[0].permissions = ['grades']
  await grades.load()
  assert.ok(!grades.calls.some(([name]) => name === 'scheduled'))
})

test('shared aggregate uses unique pending count and does not expose grades without grading permission', async () => {
  const fx = fixture()
  const review = { item_id: id(70), course_id: courseA, group_id: groupA, title: 'Real aggregate queue', submitted_count: 2, ungraded_count: 2, pending_count: 3, last_submitted_at: '2026-10-28T08:00:00Z' }
  const summary = { assignments: [], teacher_reviews: [review, { ...review, item_id: id(71), group_id: groupB }] }
  const result = await fx.load({ summary })
  const tasks = result.tasks.filter(item => item.kind === 'review')
  assert.equal(result.reviewCountsAvailable, true)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].count, 3, 'Overlapping submitted and ungraded counts are not added or maximized')
  fx.workspace.courses[0].permissions = ['assignments']
  const assignmentOnly = (await fx.load({ summary })).tasks.find(item => item.kind === 'review')
  assert.equal(assignmentOnly.count, 2)
  assert.equal(assignmentOnly.requiredPermission, 'assignments')
  assert.ok(!assignmentOnly.description.includes('оцінки'))
})

test('cancellation prevents publishing stale data and pre-aborted loads do not start requests', async () => {
  const fx = fixture(), controller = new AbortController()
  controller.abort()
  await assert.rejects(fx.load({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(fx.calls.length, 0)
  const next = fixture(), pending = new AbortController()
  next.repository.workspace = async () => { pending.abort(); return next.workspace }
  await assert.rejects(next.load({ signal: pending.signal }), { name: 'AbortError' })
  assert.equal(next.calls.length, 0)
})

test('an unavailable source fails the teacher slice instead of advertising an empty successful queue', async () => {
  const fx = fixture()
  fx.repository.gradeRequests = async () => { throw new Error('Synthetic request failure') }
  await assert.rejects(fx.load(), /Synthetic request failure/)
  await assert.rejects(fx.load({ userId: '' }), /HOME_ACCOUNT_REQUIRED/)
})
