import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const modelUrl = uri(compile(await read('src/lib/homeDashboardModel.ts')))
const { homeKyivClock, selectHomeDashboard } = await import(modelUrl)
const linksUrl = uri(compile(await read('src/lib/studyGroupLinks.ts')))
const conferenceUrl = uri(compile(await read('src/lib/homeLessonConference.ts'))
  .replace(/['"]\.\/homeDashboardModel['"]/g, JSON.stringify(modelUrl))
  .replace(/['"]\.\/studyGroupLinks['"]/g, JSON.stringify(linksUrl)))
const { visibleHomeLessonConference } = await import(conferenceUrl)

const group = { id: 'group-a', name: 'Group A', program: 'Synthetic programme', studyYear: 1, academicYear: '2026/2027',
  status: 'accepted', learning: true, teachingSubjectIds: ['course-a'], gradingSubjectIds: ['course-a'], permissions: ['assignments', 'materials', 'grades'] }
const lesson = (id, date, patch = {}) => ({ id, date, groupId: group.id, subjectId: 'course-a', subject: id,
  context: 'learning', startsAt: '09:40', endsAt: '11:00', type: 'Лекція', href: `/groups/${group.id}?tab=schedule&date=${date}`, ...patch })
const data = (patch = {}) => ({ role: 'student', displayName: 'Synthetic person', initials: 'SP',
  clockIso: '2026-11-07T16:00:00+02:00', contexts: ['learning', 'teaching'], teachingVerified: true,
  preferredGroupId: group.id, status: 'ready', participantCount: 0, groups: [group],
  lessons: [], tasks: [], updates: [], publications: [], community: [], news: [], ...patch })

function assertEmptyDay(view, date, label) {
  assert.equal(view.selectedDate, date)
  assert.equal(view.rangeStart, date)
  assert.equal(view.rangeEnd, date)
  assert.equal(view.dayLabel, label)
  assert.deepEqual(view.lessons, [])
  assert.equal(view.summary.lessons, 0)
  assert.equal(view.focusLesson, undefined)
  assert.equal(view.currentLesson, undefined)
  assert.equal(view.nextLesson, undefined)
  assert.equal(view.emptyState, 'no-lessons')
  assert.equal(view.fallbackNote, undefined)
}

test('today and tomorrow retain the requested empty weekend day for students, headmen and teachers', () => {
  for (const role of ['student', 'headman', 'teacher']) {
    const context = role === 'teacher' ? 'teaching' : 'learning'
    const snapshot = data({ role, lessons: [lesson(`Monday ${role}`, '2026-11-09', { context })] })
    assertEmptyDay(selectHomeDashboard(snapshot, { date: 'today' }), '2026-11-07', 'Сьогодні')
    const tomorrow = selectHomeDashboard(snapshot, { date: 'tomorrow' })
    assertEmptyDay(tomorrow, '2026-11-08', 'Завтра')
    assert.match(tomorrow.dateLabel, /8 листопада/)
  }
})

test('an actual Sunday lesson is retained and Monday never enters the tomorrow result', () => {
  for (const context of ['learning', 'teaching']) {
    const snapshot = data({ lessons: [lesson('Monday', '2026-11-09', { context }), lesson('Sunday', '2026-11-08', { context })] })
    const view = selectHomeDashboard(snapshot, { context, date: 'tomorrow' })
    assert.equal(view.selectedDate, '2026-11-08')
    assert.equal(view.dayLabel, 'Завтра')
    assert.deepEqual(view.lessons.map(row => row.id), ['Sunday'])
    assert.equal(view.summary.lessons, 1)
    assert.equal(view.focusLesson.id, 'Sunday')
    assert.equal(view.focusLesson.state, 'upcoming')
    assert.equal(view.fallbackNote, undefined)
  }
})

test('selected-group and all-group views use only authorized lessons on the exact chosen date', () => {
  const other = { ...group, id: 'group-b', name: 'Group B' }
  const invited = { ...group, id: 'invited-group', status: 'invited' }
  const snapshot = data({ groups: [group, other, invited], lessons: [
    lesson('Monday A', '2026-11-09'),
    lesson('Sunday B', '2026-11-08', { groupId: other.id }),
    lesson('Invited Sunday', '2026-11-08', { groupId: invited.id }),
    lesson('Foreign Sunday', '2026-11-08', { groupId: 'foreign-group' }),
    lesson('Ungrantable teacher Sunday', '2026-11-08', { subjectId: 'foreign-course', context: 'teaching' }),
  ] })
  assertEmptyDay(selectHomeDashboard(snapshot, { groupId: group.id, date: 'tomorrow' }), '2026-11-08', 'Завтра')
  const all = selectHomeDashboard(snapshot, { groupId: 'all', date: 'tomorrow' })
  assert.equal(all.selectedDate, '2026-11-08')
  assert.deepEqual(all.lessons.map(row => row.id), ['Sunday B'])
  const unavailable = selectHomeDashboard(snapshot, { groupId: 'foreign-group', date: 'tomorrow' })
  assert.equal(unavailable.selectedDate, '2026-11-08')
  assert.equal(unavailable.emptyState, 'group-unavailable')
  assert.deepEqual(unavailable.lessons, [])
  assertEmptyDay(selectHomeDashboard(snapshot, { context: 'teaching', date: 'tomorrow' }), '2026-11-08', 'Завтра')
})

test('dual-role accounts never substitute a later teacher lesson or the other role into an empty day', () => {
  const snapshot = data({ lessons: [lesson('Learning Sunday', '2026-11-08'), lesson('Teaching Monday', '2026-11-09', { context: 'teaching' })] })
  assert.deepEqual(selectHomeDashboard(snapshot, { context: 'learning', date: 'tomorrow' }).lessons.map(row => row.id), ['Learning Sunday'])
  assertEmptyDay(selectHomeDashboard(snapshot, { context: 'teaching', date: 'tomorrow' }), '2026-11-08', 'Завтра')
  const denied = selectHomeDashboard({ ...snapshot, teachingVerified: false }, { context: 'teaching', date: 'tomorrow' })
  assert.equal(denied.emptyState, 'pending')
  assert.deepEqual(denied.lessons, [])
})

test('the week remains Monday through Sunday and does not advance to the following teaching week', () => {
  const snapshot = data({ clockIso: '2026-11-08T10:00:00+02:00', lessons: [
    lesson('Previous Sunday', '2026-11-01'), lesson('Monday', '2026-11-02'),
    lesson('Sunday', '2026-11-08'), lesson('Next Monday', '2026-11-09'),
  ] })
  const view = selectHomeDashboard(snapshot, { date: 'week' })
  assert.equal(view.rangeStart, '2026-11-02')
  assert.equal(view.rangeEnd, '2026-11-08')
  assert.equal(view.dayLabel, 'Цього тижня')
  assert.deepEqual(view.lessons.map(row => row.id), ['Monday', 'Sunday'])
  assert.equal(view.fallbackNote, undefined)
})

test('Kyiv midnight, summer time, the autumn transition and a new year retain calendar-day semantics', () => {
  const cases = [
    ['2026-11-07T21:59:00Z', '2026-11-07', '2026-11-08', '2026-11-09'],
    ['2026-11-07T22:01:00Z', '2026-11-08', '2026-11-09', '2026-11-10'],
    ['2026-07-01T21:01:00Z', '2026-07-02', '2026-07-03', '2026-07-04'],
    ['2026-10-24T20:59:00Z', '2026-10-24', '2026-10-25', '2026-10-26'],
    ['2026-10-24T21:01:00Z', '2026-10-25', '2026-10-26', '2026-10-27'],
    ['2026-12-31T22:01:00Z', '2027-01-01', '2027-01-02', '2027-01-03'],
  ]
  for (const [clockIso, today, tomorrow, later] of cases) {
    assert.equal(homeKyivClock(clockIso).date, today)
    const snapshot = data({ clockIso, lessons: [lesson('A later lesson', later)] })
    assertEmptyDay(selectHomeDashboard(snapshot, { date: 'today' }), today, 'Сьогодні')
    assertEmptyDay(selectHomeDashboard(snapshot, { date: 'tomorrow' }), tomorrow, 'Завтра')
  }
})

test('current and completed lessons stay on today instead of jumping to a later class', () => {
  const snapshot = data({ clockIso: '2026-11-07T10:00:00+02:00', lessons: [
    lesson('Finished', '2026-11-07', { startsAt: '08:00', endsAt: '09:20' }),
    lesson('Current', '2026-11-07'),
    lesson('Later today', '2026-11-07', { startsAt: '11:20', endsAt: '12:40' }),
    lesson('Monday', '2026-11-09'),
  ] })
  const view = selectHomeDashboard(snapshot, { date: 'today' })
  assert.equal(view.selectedDate, '2026-11-07')
  assert.deepEqual(view.lessons.map(row => row.state), ['finished', 'current', 'upcoming'])
  assert.equal(view.focusLesson.id, 'Current')
  const completed = selectHomeDashboard({ ...snapshot, clockIso: '2026-11-07T15:00:00+02:00' }, { date: 'today' })
  assert.equal(completed.focusLesson.id, 'Later today')
  assert.equal(completed.focusLesson.state, 'finished')
  assert.equal(completed.selectedDate, '2026-11-07')
})

test('an empty selected schedule does not hide authorized tasks, updates or planned teacher publications', () => {
  const task = { id: 'task', groupId: group.id, title: 'Monday homework', description: 'Actual task', audience: 'learning', kind: 'preparation', status: 'open', dueDate: '2026-11-09', href: '/groups/group-a', actionLabel: 'Open' }
  const update = { id: 'update', groupId: group.id, title: 'New material', description: 'Actual update', audience: 'learning', kind: 'material', createdAt: '2026-11-07T08:00:00Z', href: '/groups/group-a' }
  const publication = { id: 'publication', groupId: group.id, subjectId: 'course-a', title: 'Planned assignment', kind: 'assignment', publishAt: '2026-11-09T08:00:00Z', href: '/teaching' }
  const snapshot = data({ lessons: [lesson('Monday', '2026-11-09')], tasks: [task], updates: [update], publications: [publication] })
  const student = selectHomeDashboard(snapshot, { date: 'tomorrow' })
  assertEmptyDay(student, '2026-11-08', 'Завтра')
  assert.deepEqual(student.tasks.map(row => row.id), ['task'])
  assert.deepEqual(student.updates.map(row => row.id), ['update'])
  const teacher = selectHomeDashboard(snapshot, { context: 'teaching', date: 'tomorrow' })
  assertEmptyDay(teacher, '2026-11-08', 'Завтра')
  assert.deepEqual(teacher.publications.map(row => row.id), ['publication'])
})

test('a Monday conference cannot open from an empty Sunday schedule', () => {
  for (const context of ['learning', 'teaching']) {
    const monday = lesson('Monday conference', '2026-11-09', { context, conference: { href: 'https://meet.google.com/synthetic-monday', passcode: '000067' } })
    const snapshot = data({ lessons: [monday] })
    assert.equal(visibleHomeLessonConference(snapshot, { context, date: 'tomorrow' }, monday.id), null)
    const sunday = lesson('Sunday conference', '2026-11-08', { context, conference: { href: 'https://meet.google.com/synthetic-sunday' } })
    assert.equal(visibleHomeLessonConference({ ...snapshot, lessons: [monday, sunday] }, { context, date: 'tomorrow' }, sunday.id).lesson.id, sunday.id)
  }
})
