import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/lib/offlineTeacherCapture.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const userId = '10000000-0000-0000-0000-000000000001'
const sessionId = '10000000-0000-0000-0000-000000000002'
const authSessionId = '10000000-0000-0000-0000-000000000003'
const nextAuthSessionId = '10000000-0000-0000-0000-000000000004'
const groupId = '20000000-0000-0000-0000-000000000001'
const courseId = '30000000-0000-0000-0000-000000000001'
const legacyCourseId = '30000000-0000-0000-0000-000000000002'
const revision = '40000000-0000-0000-0000-000000000001'
const from = '2026-11-09', to = '2026-11-22'
const plain = value => JSON.parse(JSON.stringify(value))
const okay = data => ({ data, status: 200, error: null })
const allowed = okay({ verified: true, has_current_access: true, academic_profile: { contact_phone: 'PRIVATE_PHONE' } })
const token = id => 'fixture.' + Buffer.from(JSON.stringify({ session_id: id })).toString('base64url') + '.local'
const fakeLesson = (index, overrides = {}) => ({
  id: '50000000-0000-0000-0000-' + String(index).padStart(12, '0'),
  course_id: courseId, group_id: groupId, group_name: 'Навчальна група',
  course_title: 'Навчальний предмет', subject_name: 'Предмет із розкладу',
  starts_at: '10:00:00', ends_at: '11:20:00', lesson_date: from,
  lesson_type: 'seminar', source: 'timetable', assigned_to_me: true,
  ...overrides,
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness(options = {}) {
  const events = [], writes = [], removals = []
  let authCount = 0, statusCount = 0
  let shellReady = options.shellReady ?? true
  const storage = {
    OFFLINE_STUDY_DAYS: 14,
    async getOfflineTeacherCalendarRevision(...args) {
      events.push('receipt')
      assert.deepEqual(args, [userId, sessionId])
      if (options.receiptError) throw options.receiptError
      return revision
    },
    async saveOfflineTeacherCalendar(owner, input, session, expectedRevision) {
      events.push('save')
      const args = [owner, plain(input), session, expectedRevision]
      writes.push(args)
      return { ...input, ownerId: owner, sessionId: session, schemaVersion: 1, savedAt: '2026-11-09T12:00:00Z', expiresAt: '2026-11-23T12:00:00Z' }
    },
    async removeOfflineTeacherCalendar(...args) {
      events.push('purge')
      removals.push(args)
      if (options.removalError) throw options.removalError
    },
    offlineStudyError: () => 'Локальне сховище недоступне.',
  }
  const imports = {
    './supabase': { supabase: {
      auth: {
        async getSession() {
          events.push('session')
          const identity = options.sessions?.[authCount++] ?? authSessionId
          return { data: { session: { user: { id: userId }, access_token: token(identity) } }, error: null }
        },
      },
      rpc(name, args) {
        return { abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal)
          assert.equal(signal.aborted, false)
          if (name === 'xelay_teacher_status') {
            events.push('status')
            assert.equal(args, undefined)
            return Promise.resolve(options.statuses?.[statusCount++] || allowed)
          }
          assert.equal(name, 'xelay_teaching_calendar')
          assert.deepEqual(plain(args), { p_from: from, p_to: to })
          events.push('calendar')
          return options.calendar?.(signal) || Promise.resolve(okay({ lessons: [fakeLesson(1)] }))
        } }
      },
    } },
    './seminars': { kyivToday: () => from },
    './studyGroupTimetable': {
      LESSON_TYPES: { seminar: 'Семінар', lecture: 'Лекція', other: 'Заняття' },
      isTimetableDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0, 10) === date,
      addTimetableDays: (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10),
    },
    './offlineStudy': storage,
    './offlineShell': {
      getOfflineShellStatus: () => ({ supported: true, ready: shellReady, preview: false, version: options.shellVersion }),
      async registerOfflineShell() { events.push('register') },
      async prepareOfflineShellPreview() { throw new Error('Unexpected preview') },
      async retryOfflineShellPreparation() { events.push('warm'); shellReady = !options.shellFailure },
    },
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require: name => {
      assert.ok(name in imports, 'All capture imports must be explicit synthetic dependencies')
      return imports[name]
    },
    Date, atob, Error, AbortController, AbortSignal, setTimeout, clearTimeout, navigator: { onLine: options.online ?? true },
    document: { querySelector: () => options.pageVersion ? { content: options.pageVersion } : null },
  })
  return { ...module.exports, events, writes, removals, capture: signal => module.exports.captureOfflineTeacherCalendar({ userId, sessionId, signal }) }
}

test('offline projection preserves personal roles, legacy timetable and homework titles without sensitive fields', () => {
  const h = harness()
  const own = fakeLesson(1, {
    location: 'Ауд. 402 https://meet.example.invalid/?token=PRIVATE_URL',
    teacher_name: 'PRIVATE_TEACHER', online_url: 'https://meet.example.invalid/',
    conference_access_code: 'PRIVATE_ACCESS_CODE', can_grade: true, grades: [5],
    homework: [
      {
        source: 'teacher', title: 'Розібрати приклад https://storage.example.invalid/?token=PRIVATE_URL',
        due_at: '2026-11-10T17:30:00+02:00', audience_label: 'Для підгрупи',
        body: 'PRIVATE_BODY', author_name: 'PRIVATE_AUTHOR', attachments: ['PRIVATE_ATTACHMENT'],
      },
      { source: 'group', title: 'ДЗ групи', due_at: null, audience_label: 'PRIVATE_NAMES' },
      { source: 'teacher', title: 'PRIVATE_DRAFT', status: 'draft' },
      { source: 'teacher', title: 'PRIVATE_WITHDRAWN', withdrawn_at: '2026-11-09T12:00:00Z' },
    ],
  })
  const result = plain(h.projectOfflineTeacherCalendar({
    lessons: [
      fakeLesson(2, { assigned_to_me: false, assignment_source: 'manual', subject_name: 'Пара колеги' }),
      fakeLesson(3, { course_id: legacyCourseId, assigned_to_me: false, subject_name: 'Старий розклад', lesson_date: to }),
      fakeLesson(4, { source: 'seminar', subject_name: 'Стара роздача тем' }),
      fakeLesson(5, { lesson_date: '2026-11-23', subject_name: 'Поза діапазоном' }),
      own, own,
    ],
    teaching_roles: [{ course_id: courseId, group_id: groupId, version: 2 }, { course_id: legacyCourseId, group_id: groupId, version: 0 }],
  }, from, to))
  assert.deepEqual(result.lessons.map(row => row.subject), ['Предмет із розкладу', 'Старий розклад'])
  assert.equal(result.lessons[0].location, 'Ауд. 402')
  assert.deepEqual(result.lessons[0].homework, [
    { title: 'Розібрати приклад', dueAt: '2026-11-10T15:30:00.000Z', audience: 'Для підгрупи' },
    { title: 'ДЗ групи' },
  ])
  assert.equal(result.lessons[1].homework, undefined)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https:|grades|conference|teacher_name|attachments/)
  assert.equal(h.writes.length, 0, 'Projection is a pure operation')
})

test('explicit capture reserves a local revision first and warms the shell before the final verified save', async () => {
  const h = harness({ shellReady: false })
  const result = await h.capture()
  assert.deepEqual(h.events, ['receipt', 'session', 'status', 'calendar', 'register', 'warm', 'session', 'status', 'session', 'save'])
  assert.equal(result.rangeStart, from)
  assert.equal(result.rangeEnd, to)
  assert.equal(result.lessons[0].startsAt, '10:00')
  assert.equal(result.lessons[0].endsAt, '11:20')
  assert.deepEqual([h.writes[0][0], ...h.writes[0].slice(2)], [userId, sessionId, revision])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PHONE|access_token|academic_profile/)
})

test('authoritative teacher denial and a calendar 403 invalidate the previous copy before reporting', async () => {
  for (const setup of [
    { statuses: [okay({ verified: true, has_current_access: false })] },
    { calendar: async () => ({ data: null, status: 403, error: { code: 'ACCESS_DENIED' } }) },
    { statuses: [allowed, okay({ verified: false, has_current_access: false })] },
  ]) {
    const h = harness(setup)
    await assert.rejects(h.capture(), failure => {
      assert.equal(h.isOfflineTeacherAccessDenied(failure), true)
      assert.match(h.offlineTeacherCaptureError(failure), /прибрано з пристрою/)
      return true
    })
    assert.deepEqual(h.removals, [[userId, sessionId]])
    assert.deepEqual(h.writes, [])
  }
})

test('the new teacher copy is not saved while an older release controls offline navigation', async () => {
  const h = harness({ shellVersion: 'older-release', pageVersion: 'current-release' })
  await assert.rejects(h.capture(), /Оновити Xelay/)
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.removals, [])
})

test('failed local removal does not claim a revoked copy was erased', async () => {
  const h = harness({ statuses: [okay({ verified: false, has_current_access: false })], removalError: new Error('fixture storage unavailable') })
  await assert.rejects(h.capture(), failure => {
    assert.equal(h.isOfflineTeacherAccessDenied(failure), true)
    assert.match(h.offlineTeacherCaptureError(failure), /Не вдалося підтвердити видалення/)
    return true
  })
  assert.deepEqual(h.writes, [])
})

test('network failures, malformed calendar and failed shell preparation leave an earlier copy untouched', async () => {
  for (const setup of [
    { calendar: async () => ({ data: null, status: 503, error: { message: 'PRIVATE_UPSTREAM_ERROR' } }) },
    { calendar: async () => okay({ lessons: null }) },
    { shellReady: false, shellFailure: true },
  ]) {
    const h = harness(setup)
    await assert.rejects(h.capture(), failure => {
      assert.equal(h.isOfflineTeacherAccessDenied(failure), false)
      assert.doesNotMatch(h.offlineTeacherCaptureError(failure), /PRIVATE_UPSTREAM_ERROR/)
      return true
    })
    assert.deepEqual(h.removals, [])
    assert.deepEqual(h.writes, [])
  }
})

test('same-account auth replacement during the calendar read rejects its late response', async () => {
  for (const calendar of [
    undefined,
    async () => ({ data: null, status: 403, error: { code: 'ACCESS_DENIED' } }),
  ]) {
    const h = harness({ sessions: [authSessionId, nextAuthSessionId], calendar })
    await assert.rejects(h.capture(), failure => /сеанс змінився/.test(h.offlineTeacherCaptureError(failure)))
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.removals, [])
  }
})

test('offline, stale receipt and a cancelled in-flight capture make no snapshot writes', async () => {
  const offline = harness({ online: false })
  await assert.rejects(offline.capture(), /немає інтернету/)
  assert.deepEqual(offline.events, [])

  const stale = harness({ receiptError: new Error('OFFLINE_OWNER_CHANGED') })
  await assert.rejects(stale.capture(), failure => /сеанс змінився/.test(stale.offlineTeacherCaptureError(failure)))
  assert.deepEqual(stale.events, ['receipt'])

  const started = deferred(), pending = deferred()
  const capture = harness({ calendar(signal) { started.resolve(signal); return pending.promise } })
  const controller = new AbortController()
  const saving = capture.capture(controller.signal)
  const requestSignal = await started.promise
  controller.abort()
  await assert.rejects(saving, { name: 'AbortError' })
  assert.equal(requestSignal.aborted, true)
  pending.resolve(okay({ lessons: [fakeLesson(9)] }))
  assert.deepEqual(capture.writes, [])
  assert.deepEqual(capture.removals, [])
})
