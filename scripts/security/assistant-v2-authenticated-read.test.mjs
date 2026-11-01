import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as studyReadHelpers from '../../server/assistant-v2/cloudStudyRead.ts'
import * as gradingHelpers from '../../src/lib/teachingGrading.ts'

// Closed offline module: cannot load a production client, discover environment
// credentials, call a provider, listen on a port, write or reach the network.
const source = readFileSync(new URL('../../server/assistant-v2/authenticatedRead.ts', import.meta.url), 'utf8')
const module = { exports: {} }
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInNewContext(code, { module, exports: module.exports, Date, Intl, URL, AbortSignal, AbortController,structuredClone,
  fetch() { throw new Error('Network forbidden') }, require(name) {if(name==='./cloudStudyRead.ts')return studyReadHelpers;if(name==='../../src/lib/teachingGrading.ts')return gradingHelpers;throw new Error('Module imports forbidden') } })
const { createAuthenticatedAssistantReadService, AUTHENTICATED_ASSISTANT_READ_LIMITS: LIMITS } = module.exports
const clone = value => JSON.parse(JSON.stringify(value))
const id = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const STUDENT = id(1), TEACHER = id(2), PEER = id(3), REPRESENTATIVE = id(4)
const GROUP = id(101), GROUP2 = id(102), FOREIGN = id(103), SUBJECT = id(201), SUBJECT2 = id(202), COURSE = id(301), COURSE2 = id(302)
const CREDENTIAL = 'synthetic-credential-does-not-access-any-service'
const NOW = Date.parse('2026-11-02T10:00:00Z')
const membership = (overrides = {}) => ({ userId: STUDENT, groupId: GROUP, representativeId: REPRESENTATIVE, membershipStatus: 'accepted', subjectIds: [SUBJECT, SUBJECT2], ...overrides })
const grant = (overrides = {}) => ({ userId: TEACHER, groupId: GROUP, courseId: COURSE, subjectId: SUBJECT, connectionStatus: 'accepted', teacherVerified: true, teacherHasCurrentAccess: true, permissions: ['materials', 'assignments', 'grades'], validFrom: null, validUntil: null, ...overrides })
const lesson = (overrides = {}) => ({ kind: 'lesson', id: id(401), groupId: GROUP, subjectId: SUBJECT, courseId: COURSE, title: 'Вища математика', date: '2026-11-02', startsAt: '08:30', endsAt: '09:50', version: 1, archived: false, ...overrides })
const material = (overrides = {}) => ({ kind: 'material', id: id(501), groupId: GROUP, subjectId: SUBJECT, courseId: COURSE, title: 'Лекція', body: 'PROTECTED_CONTENT', published: true, allowAi: false, allowDownload: false, fileId: id(502), fileName: 'PRIVATE_FILE_NAME.pdf', ...overrides })
const grade = (overrides = {}) => ({ kind: 'grade', id: id(601), groupId: GROUP, subjectId: SUBJECT, courseId: COURSE, studentId: STUDENT, activityId: id(602), title: 'Контрольна', points: 8, maxPoints: 10, coefficient: 1.5, published: true, ...overrides })
const request = (topic = 'study', scope = {}) => ({ topic, scope: { groupId: GROUP, ...(topic === 'study' || topic === 'teaching' ? { from: '2026-11-02', to: '2026-11-02' } : {}), ...scope } })
const denied = (operation, expected) => assert.rejects(operation, error => expected.includes(error.code))

function harness(options = {}) {
  const userId = options.userId ?? STUDENT
  const state = {
    now: NOW,
    session: { userId, expiresAt: '2026-11-02T11:00:00Z', accountActive: true, emailConfirmed: true, sessionId: 'offline-session' },
    access: { userId, revision: 'access-1', memberships: options.memberships ?? (userId === STUDENT ? [membership()] : []), teachingGrants: options.grants ?? (userId === TEACHER ? [grant()] : []) },
    rows: options.rows ?? [lesson()], hasMore: false, verifyCalls: 0, accessCalls: 0, pageCalls: 0, factories: 0, queries: [], accessQueries: [],
    onPage: null, onAccess: null, verifyFailure: false, pageFailure: false,
  }
  const service = createAuthenticatedAssistantReadService({
    now: () => state.now,
    verifySession: async credential => {
      state.verifyCalls++; assert.equal(credential, CREDENTIAL)
      if (state.verifyFailure) throw new Error('PRIVATE_AUTH_ERROR_MUST_NOT_LEAK')
      return state.session ? clone(state.session) : null
    },
    createCallerRepository: (session, credential) => {
      state.factories++; assert.equal(session.userId, userId); assert.equal(credential, CREDENTIAL)
      return {
        readAccess: async query => { state.accessCalls++; state.accessQueries.push(query); await state.onAccess?.(state); return clone(state.access) },
        readPage: async query => {
          state.pageCalls++; state.queries.push(query); await state.onPage?.(state)
          if (state.pageFailure) throw new Error('PRIVATE_DATABASE_ERROR_MUST_NOT_LEAK')
          return { rows: clone(state.rows), hasMore: state.hasMore }
        },
      }
    },
  })
  return { state, service, read: (input = request(), signal) => service.read(CREDENTIAL, input, signal) }
}

test('own accepted membership yields bounded caller selection and a whitelisted read projection', async () => {
  const h = harness({ rows: [lesson({ roster: ['PRIVATE_ROSTER'], questions: ['INTERNAL_SEMINAR'], accessToken: 'SECRET', contact: 'PRIVATE_CONTACT' })] })
  const result = await h.read({ ...request(), limit: 2 })
  assert.equal(result.userId, STUDENT)
  assert.equal(result.audience, 'student')
  assert.equal(result.records.length, 1)
  assert.equal(result.externalModelReady, false)
  assert.equal(result.writeActionsEnabled, false)
  assert.equal(result.timeZone, 'Europe/Kyiv')
  assert.equal(result.modelContext.references[0].dataOnly, true)
  assert.equal(h.state.queries[0].limit, 3)
  assert.deepEqual(clone(h.state.queries[0].selections), [{ groupId: GROUP, allowedSubjectIds: [SUBJECT, SUBJECT2] }])
  assert.equal(h.state.verifyCalls, 2)
  assert.equal(h.state.accessCalls, 2)
  assert.equal(h.state.accessQueries[0].membershipLimit, LIMITS.memberships + 1)
  assert.equal(/PRIVATE_ROSTER|INTERNAL_SEMINAR|SECRET|PRIVATE_CONTACT/.test(JSON.stringify(result)), false)
})

test('actor, user, administrator or role supplied by browser are rejected before authentication', async () => {
  for (const extra of [{ actorId: TEACHER }, { userId: TEACHER }, { role: 'admin' }, { actor: 'teacher' }, { permissions: ['grades'] }, { rpc: 'xelay_admin_study_groups' }]) {
    const h = harness()
    await denied(h.read({ ...request(), ...extra }), ['invalid_request'])
    assert.equal(h.state.verifyCalls, 0)
  }
  const h = harness()
  await denied(h.read(request('study', { role: 'teacher' })), ['invalid_request'])
})

test('only the eleven fixed read topics exist; private messages, dean and arbitrary actions fail closed', async () => {
  for (const topic of ['roster', 'messages', 'dean', 'schedule.create', 'constructor', '__proto__', 'SELECT * FROM users']) {
    const h = harness()
    await denied(h.read(request(topic)), ['invalid_request'])
    assert.equal(h.state.pageCalls, 0)
  }
})

test('foreign, pending and removed memberships do not authorize a data query, even for named representative', async () => {
  for (const status of ['pending', 'removed', 'declined']) {
    const h = harness({ memberships: [membership({ membershipStatus: status, representativeId: STUDENT })] })
    await denied(h.read(), ['access_denied'])
    assert.equal(h.state.pageCalls, 0)
  }
  const h = harness()
  await denied(h.read(request('study', { groupId: FOREIGN })), ['access_denied'])
  assert.equal(h.state.pageCalls, 0)
})

test('deputy capabilities come from approved appointment, not broad platform administrator role', async () => {
  const h = harness({ memberships: [membership({ deputy: { status: 'approved', permissions: ['homework', 'materials', 'admin', 'grades'] }, role: 'administrator' })] })
  const approved = await h.read()
  assert.deepEqual(clone(approved.groupCapabilities), [{ groupId: GROUP, permissions: ['homework', 'materials'] }])
  h.state.access.memberships[0].deputy.status = 'revoked'
  const revoked = await h.read()
  assert.deepEqual(clone(revoked.groupCapabilities), [{ groupId: GROUP, permissions: [] }])
  h.state.access.memberships[0].representativeId = STUDENT
  assert.equal((await h.read()).groupCapabilities[0].permissions.length, 5)
})

test('expired, unconfirmed, inactive and absent sessions never create a caller repository', async () => {
  for (const update of [null, { expiresAt: '2026-11-02T10:00:00Z' }, { accountActive: false }, { emailConfirmed: false }, { accountActive: undefined }, { userId: 'student' }]) {
    const h = harness(); h.state.session = update === null ? null : { ...h.state.session, ...update }
    await denied(h.read(), ['session_invalid'])
    assert.equal(h.state.factories, 0)
  }
})

test('authentication failures are generic and the credential never appears in result', async () => {
  const h = harness(); h.state.verifyFailure = true
  await assert.rejects(h.read(), error => error.code === 'session_unavailable' && !error.message.includes('PRIVATE_AUTH_ERROR'))
  h.state.verifyFailure = false
  assert.equal(JSON.stringify(await h.read()).includes(CREDENTIAL), false)
})

test('every read rechecks session and authoritative membership instead of caching grants', async () => {
  const h = harness()
  await h.read()
  h.state.access.memberships[0].membershipStatus = 'removed'
  await denied(h.read(), ['access_denied'])
  assert.equal(h.state.verifyCalls, 3)
  assert.equal(h.state.accessCalls, 3)
  assert.equal(h.state.pageCalls, 1)
})

test('membership removal and deputy permission revoke during data retrieval prevent any result', async () => {
  const h = harness(); h.state.onPage = state => { state.access.memberships[0].membershipStatus = 'removed' }
  await denied(h.read(), ['access_denied'])
  const deputy = harness({ memberships: [membership({ deputy: { status: 'approved', permissions: ['homework'] } })] })
  deputy.state.onPage = state => { state.access.memberships[0].deputy.permissions = [] }
  await denied(deputy.read(), ['access_changed'])
})

test('session expiry during record or final access retrieval is checked before return', async () => {
  const h = harness(); h.state.onPage = state => { state.now += 3600001 }
  await denied(h.read(), ['session_invalid'])
  const afterAccess = harness(); afterAccess.state.onAccess = state => { if (state.accessCalls === 2) state.now += 3600001 }
  await denied(afterAccess.read(), ['session_invalid'])
})

test('session replacement and authorization revision changes invalidate in-flight results', async () => {
  const h = harness(); h.state.onPage = state => { state.session.sessionId = 'new-session' }
  await denied(h.read(), ['session_changed'])
  const access = harness(); access.state.onPage = state => { state.access.revision = 'access-2' }
  await denied(access.read(), ['access_changed'])
})

test('timestamps require an explicit timezone for sessions, teaching access and deadlines', async () => {
  const session = harness(); session.state.session.expiresAt = '2026-11-02T11:00:00'
  await denied(session.read(), ['session_invalid'])
  const teaching = harness({ userId: TEACHER, grants: [grant({ validUntil: '2026-11-02T11:00:00' })] })
  await denied(teaching.read(request('teaching')), ['repository_invalid_access'])
  const homework = harness({ rows: [{ kind: 'homework', id: id(410), groupId: GROUP, subjectId: SUBJECT, title: 'Домашнє завдання', date: '2026-11-02', body: 'Задача', dueAt: '2026-11-03T12:00:00', published: true }] })
  await denied(homework.read(), ['repository_scope_violation'])
  homework.state.rows[0].dueAt = '2026-11-03T12:00:00+02:00'
  assert.equal((await homework.read()).records.length, 1)
})

test('own results request is explicitly constrained to verified user and published grades', async () => {
  const h = harness({ rows: [grade({ email: 'PRIVATE_EMAIL', student_name: 'PRIVATE_NAME' })] })
  const result = await h.read(request('results'))
  assert.equal(h.state.queries[0].studentId, STUDENT)
  assert.equal(result.records[0].points, 8)
  assert.equal(/PRIVATE_EMAIL|PRIVATE_NAME/.test(JSON.stringify(result)), false)
  assert.equal(JSON.stringify(result.modelContext).includes(STUDENT), false)
  h.state.rows = [grade({ studentId: PEER })]
  await denied(h.read(request('results')), ['repository_scope_violation'])
  h.state.rows = [grade({ published: false })]
  await denied(h.read(request('results')), ['repository_scope_violation'])
})

test('active teacher calendar uses exact course/group/subject pairs across own connected groups', async () => {
  const h = harness({ userId: TEACHER, grants: [grant(), grant({ groupId: GROUP2, courseId: COURSE2, subjectId: SUBJECT2 })], rows: [lesson(), lesson({ id: id(402), groupId: GROUP2, courseId: COURSE2, subjectId: SUBJECT2 })] })
  const result = await h.read(request('teaching', { groupId: undefined }))
  assert.equal(result.records.length, 2)
  assert.equal(result.teachingScopes.length, 2)
  assert.equal(h.state.queries[0].audience, 'teacher')
  assert.equal(h.state.queries[0].selections.every(row => row.groupId && row.courseId && row.subjectId), true)
  assert.equal(result.groupCapabilities.length, 0)
  assert.equal('roster' in result, false)
})

test('teacher row from a different subject, course or group fails closed rather than leaking', async () => {
  for (const alteration of [{ subjectId: SUBJECT2 }, { courseId: COURSE2 }, { groupId: FOREIGN }]) {
    const h = harness({ userId: TEACHER, rows: [lesson(alteration)] })
    await denied(h.read(request('teaching')), ['repository_scope_violation'])
  }
})

test('pending, removed, unverified or expired teaching grants never authorize records', async () => {
  for (const alteration of [{ connectionStatus: 'pending_group' }, { connectionStatus: 'removed' }, { teacherVerified: false }, { teacherHasCurrentAccess: false }, { validUntil: '2026-11-02T10:00:00Z' }, { validFrom: '2026-12-01T00:00:00Z' }]) {
    const h = harness({ userId: TEACHER, grants: [grant(alteration)] })
    await denied(h.read(request('teaching')), ['access_denied'])
    assert.equal(h.state.pageCalls, 0)
  }
  assert.equal((await harness({ userId: TEACHER }).read(request('teaching'))).records.length, 1)
})

test('teacher gradebook requires exact group/course and literal grading permission, not manage alone', async () => {
  for (const permissions of [[], ['materials'], ['manage']]) {
    const h = harness({ userId: TEACHER, grants: [grant({ permissions })], rows: [grade()] })
    await denied(h.read(request('gradebook', { courseId: COURSE })), ['access_denied'])
  }
  const h = harness({ userId: TEACHER, rows: [grade({ studentId: PEER, published: false })] })
  const result = await h.read(request('gradebook', { courseId: COURSE }))
  assert.equal(result.records[0].studentId, PEER)
  assert.equal(result.modelContext.references[0].text.includes('Кількість записів: 1'), true)
  assert.equal(JSON.stringify(result.modelContext).includes(PEER), false)
  assert.equal(JSON.stringify(result.modelContext).includes(STUDENT), false)
  await denied(h.read(request('gradebook')), ['course_required'])
  await denied(h.read(request('gradebook', { courseId: COURSE2 })), ['access_denied'])
})

test('teacher material read requires material grant and never inherits grades/manage as material permission', async () => {
  const h = harness({ userId: TEACHER, grants: [grant({ permissions: ['grades', 'manage'] })], rows: [material()] })
  await denied(h.read(request('materials', { courseId: COURSE })), ['access_denied'])
  h.state.access.teachingGrants[0].permissions.push('materials')
  assert.equal((await h.read(request('materials', { courseId: COURSE }))).records[0].kind, 'material')
})

test('being a teacher in another group does not erase independent student membership', async () => {
  const h = harness({ memberships: [membership()], grants: [grant({ userId: STUDENT, groupId: GROUP2 })] })
  assert.equal((await h.read()).audience, 'student')
  h.state.rows = [lesson({ groupId: GROUP2 })]
  assert.equal((await h.read(request('teaching', { groupId: GROUP2 }))).audience, 'teacher')
  await denied(h.read(request('study', { groupId: GROUP2 })), ['access_denied'])
  h.state.rows = [grade()]
  assert.equal((await h.read(request('results'))).records.length, 1)
})

test('teachers cannot request internal seminars and extraneous roster/reservations are never projected', async () => {
  const h = harness({ userId: TEACHER, rows: [lesson({ roster: ['PRIVATE_STUDENT'], teams: ['PRIVATE_TEAM'], reservations: ['PRIVATE_RESERVATION'], questions: ['PRIVATE_QUESTION'] })] })
  const result = await h.read(request('teaching'))
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false)
  await denied(h.read(request('seminars')), ['teacher_seminar_private'])
  h.state.rows = [{ ...lesson(), kind: 'seminar', questions: ['PRIVATE_QUESTION'] }]
  await denied(h.read(request('teaching')), ['repository_scope_violation'])
})

test('protected material body is display-only; no body, file name or private file reference enters model projection', async () => {
  const h = harness({ rows: [material()] })
  const result = await h.read(request('materials'))
  assert.equal(result.records[0].body, 'PROTECTED_CONTENT')
  const model = JSON.stringify(result.modelContext)
  assert.equal(/PROTECTED_CONTENT|PRIVATE_FILE_NAME/.test(model), false)
  assert.equal(model.includes(id(502)), false)
  assert.equal(result.modelContext.references[0].aiProcessingBlocked, true)
  h.state.rows = [material({ allowAi: true, body: 'ALLOWED_TEXT', allowDownload: true })]
  assert.match((await h.read(request('materials'))).modelContext.references[0].text, /ALLOWED_TEXT/)
})

test('material policy or content changed during retrieval cannot return the previous model projection', async () => {
  for (const alteration of [{ allowAi: false }, { allowDownload: false }, { body: 'REPLACED_CONTENT' }, { version: 2 }, { fileId: id(503) }]) {
    const h = harness({ rows: [material({ allowAi: true, allowDownload: true, version: 1 })] })
    h.state.onPage = state => { if (state.pageCalls === 2) Object.assign(state.rows[0], alteration) }
    await denied(h.read(request('materials')), ['material_changed'])
    assert.equal(h.state.pageCalls, 2)
  }
  const revoked = harness({ rows: [material()] })
  revoked.state.onPage = state => { if (state.pageCalls === 2) state.access.memberships[0].membershipStatus = 'removed' }
  await denied(revoked.read(request('materials')), ['access_denied'])
})

test('students cannot receive unpublished materials, current and archived periods remain distinct', async () => {
  const h = harness({ rows: [material({ published: false })] })
  await denied(h.read(request('materials')), ['repository_scope_violation'])
  h.state.rows = [material({ archived: true })]
  await denied(h.read(request('materials')), ['repository_scope_violation'])
  assert.equal((await h.read(request('materials', { period: 'archive' }))).records.length, 1)
  assert.equal((await h.read(request('materials', { period: 'all' }))).records.length, 1)
})

test('row limit is enforced, bounded extra row signals truncation and cannot hide unauthorized content', async () => {
  const h = harness({ rows: [lesson(), lesson({ id: id(402) })] })
  const result = await h.read({ ...request(), limit: 1 })
  assert.equal(result.records.length, 1)
  assert.equal(result.truncated, true)
  h.state.rows[1].groupId = FOREIGN
  await denied(h.read({ ...request(), limit: 1 }), ['repository_scope_violation'])
  h.state.rows = [lesson(), lesson({ id: id(402) }), lesson({ id: id(403) })]
  await denied(h.read({ ...request(), limit: 1 }), ['repository_invalid_response'])
  for (const limit of [0, 101, 1.5, '100', -5]) await denied(h.read({ ...request(), limit }), ['invalid_limit'])
})

test('invalid and oversized access snapshots fail before data retrieval', async () => {
  for (const change of [
    state => { state.access.userId = PEER },
    state => { state.access.memberships[0].userId = PEER },
    state => { state.access.memberships.push(clone(state.access.memberships[0])) },
    state => { state.access.memberships = Array.from({ length: 101 }, (_, index) => membership({ groupId: id(1000 + index) })) },
    state => { state.access.teachingGrants = Array.from({ length: 201 }, (_, index) => grant({ userId: STUDENT, groupId: id(1000 + index) })) },
  ]) {
    const h = harness(); change(h.state)
    await denied(h.read(), ['repository_invalid_access'])
    assert.equal(h.state.pageCalls, 0)
  }
})

test('date ranges and real identifiers are bounded; teaching course never substitutes for study subject', async () => {
  const h = harness()
  for (const scope of [{ from: '2026-02-30' }, { from: '2026-11-10', to: '2026-11-02' }, { from: '2026-11-01', to: '2026-12-02' }, { groupId: 'g1' }]) {
    await denied(h.read(request('study', scope)), ['invalid_date_range', 'invalid_request'])
  }
  await denied(h.read(request('study', { courseId: COURSE })), ['study_subject_required'])
  await denied(h.read(request('study', { subjectId: id(999) })), ['access_denied'])
  assert.equal((await h.read(request('study', { subjectId: SUBJECT }))).records.length, 1)
  await denied(h.read(request('results', { from: '2026-11-02' })), ['invalid_request'])
})

test('default day uses Kyiv time, not machine or UTC date', async () => {
  const h = harness({ rows: [lesson({ date: '2026-11-03' })] })
  h.state.now = Date.parse('2026-11-02T22:30:00Z'); h.state.session.expiresAt = '2026-11-03T12:00:00Z'
  const result = await h.read({ topic: 'study', scope: { groupId: GROUP } })
  assert.equal(result.scope.from, '2026-11-03')
  assert.equal(result.scope.to, '2026-11-03')
})

test('repository errors, invalid clock and malformed rows fail without leaking raw errors', async () => {
  const h = harness(); h.state.pageFailure = true
  await assert.rejects(h.read(), error => error.code === 'repository_unavailable' && !error.message.includes('PRIVATE_DATABASE_ERROR'))
  h.state.pageFailure = false; h.state.now = NaN
  await denied(h.read(), ['clock_unavailable'])
  const badLink = harness({ rows: [lesson({ links: ['javascript:alert(1)'] })] })
  await denied(badLink.read(), ['repository_invalid_response'])
  const badGrade = harness({ rows: [grade({ points: 500, maxPoints: 10 })] })
  await denied(badGrade.read(request('results')), ['repository_scope_violation'])
})

test('cancelled reads do not begin or return after repository work', async () => {
  const first = new AbortController(); first.abort()
  const h = harness(); await denied(h.read(request(), first.signal), ['request_cancelled'])
  assert.equal(h.state.verifyCalls, 0)
  const next = new AbortController(); h.state.onPage = () => next.abort()
  await denied(h.read(request(), next.signal), ['request_cancelled'])
})

test('text and model projection are bounded and meeting secrets stay out of model references', async () => {
  const h = harness({ rows: [material({ allowAi: true, body: 'x'.repeat(10000) })] })
  const result = await h.read(request('materials'))
  assert.equal(result.records[0].body.length, LIMITS.bodyCharacters)
  assert.equal(result.records[0].bodyTruncated, true)
  assert.equal(result.modelContext.references[0].text.length, LIMITS.modelBodyCharacters)
  assert.equal(result.modelContext.references[0].truncated, true)
  h.state.rows = [material({ allowAi: true, body: 'x'.repeat(2500) })]
  const modelOnlyTruncation = await h.read(request('materials'))
  assert.equal('bodyTruncated' in modelOnlyTruncation.records[0], false)
  assert.equal(modelOnlyTruncation.modelContext.references[0].truncated, true)
  h.state.rows = [lesson({ conferenceId: 'PRIVATE_MEETING_ID', accessCode: 'PRIVATE_ACCESS_CODE', links: ['https://example.com/PRIVATE_LINK'] })]
  const schedule = await h.read()
  assert.equal(schedule.records[0].conferenceId, 'PRIVATE_MEETING_ID')
  assert.equal(/PRIVATE_MEETING_ID|PRIVATE_ACCESS_CODE|PRIVATE_LINK/.test(JSON.stringify(schedule.modelContext)), false)
})
