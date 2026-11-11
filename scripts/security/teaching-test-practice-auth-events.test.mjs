// Real AuthProvider and practice repositories in an isolated browser VM.
// All identities and questions are synthetic; no network or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const compile = (source, fileName = 'AuthContext.tsx') => ts.transpileModule(source, { fileName, compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
const authSource = compile(await readFile(new URL('src/context/AuthContext.tsx', root), 'utf8'))
const practiceSource = compile(await readFile(new URL('src/lib/teachingTestPractice.ts', root), 'utf8'), 'teachingTestPractice.ts')
const AUTH_KEY = 'xelay:teacher-practice:auth:v1'
const PREFIX = 'xelay:teacher-practice:'
const plain = value => JSON.parse(JSON.stringify(value))
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept }); return { promise, resolve } }
const session = (userId = 'teacher-a', sessionId = 'session-a', tokenChange = '') => ({ user: { id: userId },
  access_token: 'header.' + Buffer.from(JSON.stringify({ session_id: sessionId, refreshed: tokenChange })).toString('base64url') + '.synthetic-signature' })
const definition = () => ({ id: 'synthetic-test', course_id: 'synthetic-course', title: 'Synthetic rehearsal', description: '', status: 'draft',
  opens_at: '2030-01-01T00:00:00Z', closes_at: '2030-01-02T00:00:00Z', duration_seconds: 1200, max_points: 10,
  category: '', journal_date: '2026-11-11', work_type: 'Тест', allow_skip: true, allow_return: true,
  question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 0, bonus_points: 0, targets: [],
  questions: [{ id: 'synthetic-question', kind: 'choice', text: 'Synthetic unpublished prompt', points: 1, time_limit_seconds: null,
    partial_credit: false, options: ['a', 'b', 'c', 'd'].map(id => ({ id, text: 'Synthetic option ' + id })), buckets: [], answer: 'b' }],
  question_count: 1, version: 2, has_attempts: false, results_finalized_at: null, review_revision: 0, approved_revision: null })
function memoryStorage() {
  const values = new Map()
  return { values, get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}
function fixture({ storage = memoryStorage(), offlineClear = async () => {}, providerSignOut = async () => ({ error: null }) } = {}) {
  const slots = [], effects = [], timers = new Map(), events = [], sessions = []
  let cursor = 0, timerId = 0, callback, currentSession = null, tree, alive = true
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = { createContext: () => ({ Provider: 'auth-provider' }), useContext() {},
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => {
      assert.equal(alive, true, 'no stale write after unmount'); slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
    }] },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] },
    useCallback(fn, deps) { const index = cursor++; if (!equal(slots[index]?.deps, deps)) slots[index] = { value: fn, deps }; return slots[index].value },
    useEffect(fn, deps) { const index = cursor++; if (!equal(slots[index]?.deps, deps)) { const prior = slots[index]; slots[index] = { deps, cleanup: prior?.cleanup };
      effects.push(() => { prior?.cleanup?.(); slots[index].cleanup = fn() }) } },
  }
  const browser = { sessionStorage: storage, setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} }
  const practiceModule = { exports: {} }
  vm.runInNewContext(practiceSource, { module: practiceModule, exports: practiceModule.exports, window: browser,
    crypto: { randomUUID }, Date, Math, console, require(name) { throw Error('Unexpected practice dependency ' + name) } })
  const practice = practiceModule.exports
  const supabase = {
    auth: {
      getSession() { return sessions.length ? sessions.shift() : Promise.resolve({ data: { session: currentSession }, error: null }) },
      onAuthStateChange(fn) { callback = fn; return { data: { subscription: { unsubscribe() { callback = null } } } } },
      async signOut() { events.push('provider'); return providerSignOut() },
    },
    from(table) { assert.equal(table, 'profiles'); const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: null, error: null }) }; return query },
  }
  const module = { exports: {} }, jsx = (type, props) => ({ type, props })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../lib/supabase': { supabase },
    '../lib/studyYearProgression': { currentAcademicYear: () => 2026, isActiveStudentStatus: () => true },
    '../lib/teacherVerification': { loadTeacherVerification: async () => null },
    '../lib/authGoogle': { googleAuthEnabled: false, googleRegistrationRequired: async () => false },
    '../lib/offlineStudy': { establishOfflineOwner: async () => {}, clearOfflineStudy: async () => { events.push('offline'); return offlineClear() },
      getOfflineOwner: async () => null, removeOfflineTeacherCalendar: async () => {} },
    '../lib/teacherAcademicProfile': { clearPendingTeacherAcademicProfile() {}, consumePendingTeacherAcademicProfile: async () => {} },
    '../lib/studyGroupRepresentativeTransfer': {}, '../lib/profileNames': {}, '../lib/teachingTestPractice': practice,
  }
  vm.runInNewContext(authSource, { module, exports: module.exports, require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
    sessionStorage: storage, window: browser, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId }, clearTimeout(id) { timers.delete(id) }, Date, Error, atob, console: { warn() {} } })
  const render = () => { cursor = 0; tree = module.exports.AuthProvider({ children: null }); effects.splice(0).forEach(fn => fn()); return tree.props.value }
  render()
  return { storage, practice, events, render, get value() { return tree.props.value },
    emit(event, next) { currentSession = event === 'SIGNED_OUT' ? null : next; callback(event, next); return render() },
    queueSession(value) { sessions.push(value) },
    async drain() { const ready = [...timers.values()]; timers.clear(); ready.forEach(fn => fn()); await flush(); return render() },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); alive = false },
  }
}
const practices = storage => [...storage.values.keys()].filter(key => key.startsWith(PREFIX) && key !== AUTH_KEY)
async function rehearsal(fx, userId = 'teacher-a') {
  const test = definition(), repo = fx.practice.createTeachingTestPracticeRepository(test, userId, 'synthetic-group')
  const detail = await repo.mutate('start', { id: test.id, expected_user_id: userId, group_id: 'synthetic-group' })
  assert.equal(practices(fx.storage).length, 1)
  return { repo, test, detail }
}

test('initial guest and SIGNED_OUT erase every account rehearsal and legacy key while preserving unrelated storage', async () => {
  for (const event of ['INITIAL_SESSION', 'SIGNED_OUT']) {
    const fx = fixture(); fx.storage.setItem('ordinary-setting', 'keep')
    fx.storage.setItem(PREFIX + 'v1:teacher-a:old-test:1', '{"questions":["synthetic secret"]}')
    fx.storage.setItem(PREFIX + 'v2:teacher-b:old-test:1', '{}')
    fx.emit(event, null)
    assert.equal(practices(fx.storage).length, 0); assert.equal(fx.storage.getItem(AUTH_KEY), null)
    assert.equal(fx.storage.getItem('ordinary-setting'), 'keep'); fx.unmount()
  }
})

test('explicit logout fences active repositories synchronously before offline deletion or provider completion', async () => {
  const pending = deferred(), fx = fixture({ offlineClear: () => pending.promise })
  fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
  const logout = fx.value.signOut()
  assert.equal(practices(fx.storage).length, 0); assert.deepEqual(fx.events, ['offline'])
  await assert.rejects(open.repo.detail(open.test.id), /TEST_FORBIDDEN/)
  pending.resolve(); await logout
  assert.deepEqual(fx.events, ['offline', 'provider']); assert.equal(fx.render().authUser, null); fx.unmount()
})

test('logout cleanup remains effective when offline deletion or the Auth provider fails', async () => {
  for (const failure of ['offline', 'provider-error', 'provider-throw']) {
    const fx = fixture({ offlineClear: async () => { if (failure === 'offline') throw Error('OFFLINE_CLEAR_NOT_CONFIRMED') },
      providerSignOut: async () => { if (failure === 'provider-throw') throw Error('Synthetic provider failure'); return { error: Error('Synthetic provider failure') } } })
    fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
    await assert.rejects(fx.value.signOut(), /OFFLINE_CLEAR_NOT_CONFIRMED|Synthetic provider failure/)
    assert.equal(practices(fx.storage).length, 0); await assert.rejects(open.repo.detail(open.test.id), /TEST_FORBIDDEN/)
    assert.equal(fx.events.includes('provider'), failure !== 'offline'); fx.unmount()
  }
})

test('account change and same-user new session erase progress and invalidate an already open rehearsal', async () => {
  for (const next of [session('student-b', 'session-b'), session('teacher-a', 'new-session')]) {
    const fx = fixture(); fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
    fx.emit('SIGNED_IN', next)
    assert.equal(practices(fx.storage).length, 0); await assert.rejects(open.repo.detail(open.test.id), /TEST_FORBIDDEN/)
    assert.deepEqual(JSON.parse(fx.storage.getItem(AUTH_KEY)), { userId: next.user.id, sessionId: next.user.id === 'teacher-a' ? 'new-session' : 'session-b' })
    fx.unmount()
  }
})

test('ordinary token refresh and repeated same-session events preserve active progress without storing tokens', async () => {
  const fx = fixture(); fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
  for (const event of ['TOKEN_REFRESHED', 'SIGNED_IN', 'INITIAL_SESSION', 'USER_UPDATED']) {
    const before = [...fx.storage.values.entries()]
    fx.emit(event, session('teacher-a', 'session-a', event))
    assert.deepEqual([...fx.storage.values.entries()], before)
    assert.equal((await open.repo.detail(open.test.id)).attempt.id, open.detail.attempt.id)
  }
  const marker = JSON.parse(fx.storage.getItem(AUTH_KEY))
  assert.deepEqual(Object.keys(marker).sort(), ['sessionId', 'userId'])
  assert.equal(JSON.stringify([...fx.storage.values.values()]).includes('synthetic-signature'), false); fx.unmount()
})

test('same-session reload resumes descriptor progress; missing, malformed or different boundary markers purge it', async () => {
  for (const marker of ['same', 'missing', 'malformed', 'different-user', 'different-session']) {
    const storage = memoryStorage(), first = fixture({ storage }); first.emit('INITIAL_SESSION', session())
    const open = await rehearsal(first); first.unmount()
    if (marker === 'missing') storage.removeItem(AUTH_KEY)
    if (marker === 'malformed') storage.setItem(AUTH_KEY, '{broken')
    if (marker === 'different-user') storage.setItem(AUTH_KEY, JSON.stringify({ userId: 'another', sessionId: 'session-a' }))
    if (marker === 'different-session') storage.setItem(AUTH_KEY, JSON.stringify({ userId: 'teacher-a', sessionId: 'another' }))
    const second = fixture({ storage }); second.emit('INITIAL_SESSION', session())
    const resumed = second.practice.createTeachingTestPracticeRepository(open.test, 'teacher-a', 'synthetic-group')
    assert.equal((await resumed.detail(open.test.id)).attempt?.id ?? null, marker === 'same' ? open.detail.attempt.id : null)
    assert.equal(practices(storage).length, marker === 'same' ? 1 : 0); second.unmount()
  }
})

test('matching-session bootstrap purges legacy records from every account without resetting safe descriptor progress', async () => {
  const storage = memoryStorage(), first = fixture({ storage }); first.emit('INITIAL_SESSION', session())
  const open = await rehearsal(first); first.unmount()
  storage.setItem(PREFIX + 'v1:teacher-a:another-test:9', '{"questions":["synthetic old prompt"]}')
  storage.setItem(PREFIX + 'v1:another-account:other-test:1', '{"answer":"synthetic old key"}')
  const second = fixture({ storage }); second.emit('INITIAL_SESSION', session())
  assert.equal([...storage.values.keys()].some(key => key.startsWith(PREFIX + 'v1:')), false)
  const resumed = second.practice.createTeachingTestPracticeRepository(open.test, 'teacher-a', 'synthetic-group')
  assert.equal((await resumed.detail(open.test.id)).attempt.id, open.detail.attempt.id)
  assert.equal(practices(storage).length, 1); second.unmount()
})

test('manual session refresh clears changed or absent identities but a stale response cannot clear the next account', async () => {
  const fx = fixture(); fx.emit('INITIAL_SESSION', session()); const old = await rehearsal(fx)
  const pending = deferred(); fx.queueSession(pending.promise)
  const refresh = fx.value.refreshUser()
  fx.emit('SIGNED_IN', session('teacher-b', 'session-b')); const newer = await rehearsal(fx, 'teacher-b')
  pending.resolve({ data: { session: session() }, error: null }); await refresh
  assert.equal(fx.render().authUser.id, 'teacher-b')
  assert.equal((await newer.repo.detail(newer.test.id)).attempt.id, newer.detail.attempt.id)
  await assert.rejects(old.repo.detail(old.test.id), /TEST_FORBIDDEN/)
  fx.queueSession(Promise.resolve({ data: { session: null }, error: null })); await fx.value.refreshUser()
  assert.equal(practices(fx.storage).length, 0); await assert.rejects(newer.repo.detail(newer.test.id), /TEST_FORBIDDEN/); fx.unmount()
})

test('getSession account/session boundaries also purge practice without relying on an Auth event', async () => {
  for (const next of [session('teacher-b', 'session-b'), session('teacher-a', 'new-session')]) {
    const fx = fixture(); fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
    fx.queueSession(Promise.resolve({ data: { session: next }, error: null }))
    await fx.value.refreshUser()
    assert.equal(practices(fx.storage).length, 0); await assert.rejects(open.repo.detail(open.test.id), /TEST_FORBIDDEN/)
    assert.equal(fx.render().authUser.id, next.user.id); fx.unmount()
  }
})

test('a session response received after explicit logout cannot restore the practice boundary or progress', async () => {
  const offline = deferred(), fx = fixture({ offlineClear: () => offline.promise })
  fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
  const pending = deferred(); fx.queueSession(pending.promise)
  const refresh = fx.value.refreshUser(), logout = fx.value.signOut()
  pending.resolve({ data: { session: session() }, error: null }); await refresh
  assert.equal(fx.storage.getItem(AUTH_KEY), null); assert.equal(practices(fx.storage).length, 0)
  await assert.rejects(open.repo.detail(open.test.id), /TEST_FORBIDDEN/)
  offline.resolve(); await logout; assert.equal(fx.render().authUser, null); fx.unmount()
})

test('SIGNED_OUT with stale session data fails closed and missing session identifiers cannot preserve a prior rehearsal', async () => {
  for (const next of [session(), { user: { id: 'teacher-a' }, access_token: 'invalid-token' }]) {
    const fx = fixture(); fx.emit('INITIAL_SESSION', session()); const open = await rehearsal(fx)
    fx.emit(next.access_token === 'invalid-token' ? 'SIGNED_IN' : 'SIGNED_OUT', next)
    assert.equal(practices(fx.storage).length, 0); await assert.rejects(open.repo.detail(open.test.id), /TEST_FORBIDDEN/)
    if (next.access_token !== 'invalid-token') assert.equal(fx.value.authUser, null)
    fx.unmount()
  }
})
