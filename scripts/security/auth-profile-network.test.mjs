// Real AuthProvider callbacks with isolated hooks and synthetic responses. No network or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/context/AuthContext.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const representativeModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../../src/lib/studyGroupRepresentativeTransfer.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: representativeModule, exports: representativeModule.exports, require(name) {
  assert.equal(name, './supabase'); return { supabase: {} }
} })
const response = (data, error = null, status = 200) => ({ data, error, status })
const network = () => response(null, { message: 'TypeError: Load failed', code: '' }, 0)
const user = id => ({ id, email: `${id}@example.test`, email_confirmed_at: '2026-10-16T00:00:00Z' })
const row = id => ({ id, full_name: `Synthetic ${id}`, username: id, email: `${id}@example.test`,
  study_year: 1, experience: 'bachelor', study_year_auto_advance: false, account_type: 'student',
  university_id: 'university', academic_unit_id: 'faculty', categories: ['General'],
  created_at: '2026-10-15T12:00:00.000Z' })
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve() }

function fixture({ googleEnabled = false, registration = async () => false } = {}) {
  const slots = [], effects = [], timers = []
  let cursor = 0, authCallback, result, alive = true
  const queues = new Map(), calls = []
  let sessionUser = user('account-a'), sessionCalls = 0
  const changed = (previous, next) => !previous || previous.length !== next.length || previous.some((value, index) => value !== next[index])
  const react = {
    createContext: () => ({ Provider: 'auth-provider' }), useContext: () => {},
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, value => {
        assert.equal(alive, true, 'A completed stale request wrote after unmount')
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
      }]
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] },
    useCallback(fn, dependencies) {
      const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) slots[index] = { value: fn, dependencies }
      return slots[index].value
    },
    useEffect(fn, dependencies) {
      const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) {
        const previous = slots[index]
        slots[index] = { dependencies, cleanup: previous?.cleanup }
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn() })
      }
    },
  }
  const next = async table => {
    calls.push(table)
    const queued = queues.get(table)?.shift()
    if (queued !== undefined) return typeof queued === 'function' ? queued() : queued
    if (table === 'profiles') return response(sessionUser ? row(sessionUser.id) : null)
    if (table === 'user_roles') return response([{ role: 'ADMIN' }, { role: 'FACULTY_EDITOR', academic_unit_id: 'faculty' }])
    if (table === 'class_representative_requests') return response([{ id: 'approved-request', status: 'approved' }])
    if (table === 'study_group_members') return response([{ group_id: 'group-a', status: 'accepted' }])
    if (table === 'representative-status') return response(null, { code: 'PGRST202', message: 'Missing xelay_my_study_group_representative_status in schema cache' }, 404)
    if (table === 'teacher') return { status: 'approved', verified: true, request: { department: 'Department', position: 'Teacher' } }
    throw new Error(`Unexpected synthetic table ${table}`)
  }
  const supabase = {
    from(table) {
      const builder = { select: () => builder, eq: () => builder, in: () => builder, order: () => builder,
        maybeSingle: () => next(table), then: (resolve, reject) => next(table).then(resolve, reject) }
      return builder
    },
    auth: {
      getSession: async () => {
        sessionCalls++
        const queued = queues.get('session')?.shift()
        if (queued !== undefined) return typeof queued === 'function' ? queued() : queued
        return { data: { session: sessionUser ? { user: sessionUser } : null }, error: null }
      },
      onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } } },
      signOut: async () => ({ error: null }),
    },
    rpc(name) { assert.equal(name, 'xelay_my_study_group_representative_status'); return next('representative-status') },
  }
  const storage = new Map()
  const exports = {}, jsx = (type, props) => ({ type, props })
  vm.runInNewContext(compiled, {
    exports, require(name) {
      const dependencies = {
        react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../lib/supabase': { supabase },
        '../lib/studyYearProgression': { currentAcademicYear: () => 2026, isActiveStudentStatus: () => true },
        '../lib/teacherVerification': { loadTeacherVerification: () => next('teacher') },
        '../lib/authGoogle': { googleAuthEnabled: googleEnabled, googleRegistrationRequired: registration },
        '../lib/offlineStudy': { establishOfflineOwner: async () => {}, clearOfflineStudy: async () => {} },
        '../lib/teacherAcademicProfile': { clearPendingTeacherAcademicProfile() {}, consumePendingTeacherAcademicProfile: async () => {} },
        '../lib/studyGroupRepresentativeTransfer': representativeModule.exports,
      }
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected import ${name}`)
      return dependencies[name]
    },
    setTimeout(callback) { timers.push(callback); return timers.length }, clearTimeout() {},
    window: { setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Date, atob, console: { warn() {} },
  }, { filename: 'AuthContext.tsx' })
  const render = () => {
    cursor = 0
    result = exports.AuthProvider({ children: null })
    effects.splice(0).forEach(effect => effect())
    return result.props.value
  }
  render()
  return {
    render, calls, get value() { return result.props.value }, sessionCalls: () => sessionCalls,
    set sessionUser(value) { sessionUser = value },
    queue(table, value) { const list = queues.get(table) || []; list.push(value); queues.set(table, list) },
    async refresh(options) { await result.props.value.refreshUser(options); return render() },
    async emit(nextUser) {
      sessionUser = nextUser
      authCallback(nextUser ? 'SIGNED_IN' : 'SIGNED_OUT', nextUser ? { user: nextUser } : null)
      render()
      timers.splice(0).forEach(callback => callback())
      await flush()
      return render()
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); alive = false },
  }
}

test('a transient primary profile failure preserves only the same-account cached snapshot and recovers later', async () => {
  const fx = fixture()
  const before = (await fx.refresh()).xelayUser
  assert.equal(before.id, 'account-a')
  fx.queue('profiles', network())
  const failed = await fx.refresh()
  assert.equal(failed.authUser.id, 'account-a')
  assert.equal(failed.xelayUser, before)
  assert.equal(failed.isLoading, false)
  fx.queue('profiles', response({ ...row('account-a'), full_name: 'Recovered profile' }))
  assert.equal((await fx.refresh()).xelayUser.name, 'Recovered profile')
  fx.unmount()
})

test('network throws, timeout responses and temporary server failures retain a same-account profile', async () => {
  for (const failure of [
    () => { throw new TypeError('Failed to fetch') },
    () => { throw Object.assign(new Error('Timed out'), { name: 'TimeoutError' }) },
    response(null, { message: 'Request timed out' }, 408),
    response(null, { message: 'Service temporarily unavailable' }, 503),
  ]) {
    const fx = fixture(), before = (await fx.refresh()).xelayUser
    fx.queue('profiles', failure)
    assert.equal((await fx.refresh()).xelayUser, before)
    fx.unmount()
  }
})

test('authoritative null, missing resource, authentication and permission denials clear cached profiles', async () => {
  for (const failure of [
    response(null), response(null, { message: 'Not found' }, 404),
    response(null, { message: 'Invalid JWT', code: 'PGRST301' }, 401),
    response(null, { message: 'Forbidden', code: '42501' }, 403),
    response(null, { message: 'Permission denied', code: '42501' }, 0),
    response(null, { message: 'Invalid query', code: '22023' }, 400),
    () => { throw new TypeError('Cannot read properties of undefined') },
  ]) {
    const fx = fixture()
    assert.ok((await fx.refresh()).xelayUser)
    fx.queue('profiles', failure)
    const after = await fx.refresh()
    assert.equal(after.xelayUser, null)
    assert.equal(after.isLoading, false)
    fx.unmount()
  }
})

test('first-load failures cannot invent a profile or cached privileges', async () => {
  const fx = fixture()
  fx.queue('profiles', network())
  const after = await fx.refresh()
  assert.equal(after.authUser.id, 'account-a')
  assert.equal(after.xelayUser, null)
  assert.equal(after.isLoading, false)
  fx.unmount()
})

test('secondary transport failures preserve known fields only for their own unavailable lookup', async () => {
  for (const table of ['user_roles', 'class_representative_requests', 'study_group_members', 'teacher']) {
    const fx = fixture(), before = (await fx.refresh()).xelayUser
    assert.equal(before.isPlatformAdmin, true)
    assert.equal(before.isClassRepresentative, true)
    if (table === 'teacher') fx.queue(table, () => { throw new TypeError('Load failed') })
    else fx.queue(table, network())
    const after = await fx.refresh()
    assert.deepEqual(after.xelayUser, before)
    assert.equal(after.isLoading, false)
    fx.unmount()
  }
})

test('fresh profile data and successful revocations win even while another lookup is unavailable', async () => {
  for (const failure of [network(), () => { throw new TypeError('Load failed') }]) {
    const fx = fixture()
    await fx.refresh()
    fx.queue('profiles', response({ ...row('account-a'), full_name: 'Fresh name' }))
    fx.queue('study_group_members', failure)
    fx.queue('user_roles', response([]))
    fx.queue('class_representative_requests', response([]))
    fx.queue('teacher', { status: 'revoked', verified: false, request: null })
    const after = (await fx.refresh()).xelayUser
    assert.equal(after.name, 'Fresh name')
    assert.equal(after.isPlatformAdmin, false)
    assert.deepEqual(Array.from(after.editorUnitIds), [])
    assert.deepEqual(Array.from(after.editorUniversityIds), [])
    assert.equal(after.isClassRepresentative, false)
    assert.equal(after.classRepresentativeRequestId, undefined)
    assert.equal(after.isTeacher, false)
    assert.equal(after.teacherVerificationStatus, 'revoked')
    assert.deepEqual(Array.from(after.studyGroupIds), ['group-a'])
    fx.unmount()
  }
})

test('secondary failures on first load grant no missing roles, while authoritative denials override cache', async () => {
  const fx = fixture()
  fx.queue('user_roles', network())
  assert.equal((await fx.refresh()).xelayUser.isPlatformAdmin, false)
  const before = (await fx.refresh()).xelayUser
  assert.equal(before.isPlatformAdmin, true)
  fx.queue('user_roles', response(null, { code: '42501', message: 'Forbidden' }, 403))
  fx.queue('study_group_members', network())
  const forbidden = await fx.refresh()
  assert.notEqual(forbidden.xelayUser, before)
  assert.equal(forbidden.xelayUser.isPlatformAdmin, false)
  fx.queue('user_roles', response(null, { code: 'PGRST301', message: 'Invalid JWT' }, 401))
  assert.equal((await fx.refresh()).xelayUser, null)
  fx.unmount()
})

test('refreshing a different account clears the previous profile before its request finishes', async () => {
  const fx = fixture()
  assert.equal((await fx.refresh()).xelayUser.id, 'account-a')
  const pending = deferred()
  fx.sessionUser = user('account-b')
  fx.queue('profiles', pending.promise)
  const operation = fx.value.refreshUser()
  await flush()
  const switched = fx.render()
  assert.equal(switched.authUser.id, 'account-b')
  assert.equal(switched.xelayUser, null)
  pending.resolve(network())
  await operation
  assert.equal(fx.render().xelayUser, null)
  fx.unmount()
})

test('an old in-flight profile cannot restore the previous account after switching', async () => {
  const fx = fixture()
  await fx.refresh()
  const pending = deferred()
  fx.queue('profiles', pending.promise)
  const oldOperation = fx.value.refreshUser()
  await flush()
  fx.sessionUser = user('account-b')
  const updated = await fx.refresh()
  assert.equal(updated.xelayUser.id, 'account-b')
  pending.resolve(response(row('account-a')))
  await oldOperation
  assert.equal(fx.render().xelayUser.id, 'account-b')
  fx.unmount()
})

test('a successful role revocation and sign-out always replace or clear the cache', async () => {
  const fx = fixture()
  assert.equal((await fx.refresh()).xelayUser.isPlatformAdmin, true)
  fx.queue('user_roles', response([]))
  fx.queue('class_representative_requests', response([]))
  const revoked = await fx.refresh()
  assert.equal(revoked.xelayUser.isPlatformAdmin, false)
  assert.equal(revoked.xelayUser.isClassRepresentative, false)
  const signedOut = await fx.emit(null)
  assert.equal(signedOut.authUser, null)
  assert.equal(signedOut.xelayUser, null)
  assert.equal(signedOut.isLoading, false)
  fx.unmount()
})

test('Google registration requirement and unavailable status both prevent profile and role exposure', async () => {
  for (const [registration, expected] of [[async () => true, 'required'], [async () => { throw Error('Synthetic status unavailable') }, 'error']]) {
    const fx = fixture({ googleEnabled: true, registration })
    const value = await fx.refresh()
    assert.equal(value.googleRegistrationStatus, expected)
    assert.equal(value.xelayUser, null)
    assert.deepEqual(fx.calls, [])
    fx.unmount()
  }
  const ready = fixture({ googleEnabled: true })
  assert.equal((await ready.refresh()).googleRegistrationStatus, 'ready')
  assert.equal(ready.value.xelayUser.id, 'account-a')
  ready.unmount()
})

test('a delayed Google registration result cannot overwrite the next account status or profile', async () => {
  const pending = deferred()
  let calls = 0
  const fx = fixture({ googleEnabled: true, registration: () => ++calls === 1 ? pending.promise : Promise.resolve(false) })
  const previous = fx.value.refreshUser()
  await flush()
  fx.sessionUser = user('account-b')
  assert.equal((await fx.refresh()).xelayUser.id, 'account-b')
  pending.resolve(true)
  await previous
  assert.equal(fx.render().googleRegistrationStatus, 'ready')
  assert.equal(fx.value.xelayUser.id, 'account-b')
  fx.unmount()
})

const ownerGroup = '11111111-1111-4111-8111-111111111111'
const availableRequest = '22222222-2222-4222-8222-222222222222'
const status = ({ owned = [], available = [], canCreate = false } = {}) => response({
  is_representative: owned.length > 0 || canCreate, owned_group_ids: owned,
  available_request_ids: available, can_create_group: canCreate,
})

test('current representative status revokes transferred approval without rewriting its immutable request history', async () => {
  const fx = fixture()
  fx.queue('representative-status', status({ owned: [ownerGroup], available: [availableRequest] }))
  fx.queue('class_representative_requests', response([{ id: availableRequest, status: 'approved' }]))
  assert.equal((await fx.refresh()).xelayUser.isClassRepresentative, true)
  fx.queue('representative-status', status())
  fx.queue('class_representative_requests', response([{ id: availableRequest, status: 'approved' }]))
  const ordinary = (await fx.refresh()).xelayUser
  assert.equal(ordinary.isClassRepresentative, false)
  assert.equal(ordinary.classRepresentativeRequestId, undefined)
  assert.equal(ordinary.studyGroupRepresentativeStatusSource, 'current')
  assert.deepEqual(Array.from(ordinary.studyGroupRepresentativeStatus.ownedGroupIds), [])
  assert.ok(ordinary.studyGroupIds.includes('group-a'), 'ordinary accepted membership remains')
  fx.unmount()
})

test('new owner without an application gets live ownership and group navigation without extra session reads', async () => {
  const fx = fixture(), before = fx.sessionCalls()
  fx.queue('representative-status', status({ owned: [ownerGroup] }))
  fx.queue('class_representative_requests', response([]))
  fx.queue('study_group_members', response([]))
  const owner = (await fx.refresh()).xelayUser
  assert.equal(owner.isClassRepresentative, true)
  assert.equal(owner.classRepresentativeRequestId, undefined)
  assert.equal(owner.studyGroupRepresentativeStatusSource, 'current')
  assert.ok(owner.studyGroupIds.includes(ownerGroup))
  assert.equal(fx.sessionCalls() - before, 1, 'status parser/RPC must not perform an extra Auth session lookup')
  fx.unmount()
})

test('unused approval remains creation-eligible, while pending details never revive a transferred approval', async () => {
  const fx = fixture()
  fx.queue('representative-status', status({ available: [availableRequest], canCreate: true }))
  fx.queue('class_representative_requests', response([{ id: availableRequest, status: 'approved' }]))
  const eligible = (await fx.refresh()).xelayUser
  assert.equal(eligible.isClassRepresentative, true)
  assert.equal(eligible.classRepresentativeRequestId, availableRequest)
  assert.equal(eligible.studyGroupRepresentativeStatus.canCreateGroup, true)
  fx.queue('representative-status', status())
  fx.queue('class_representative_requests', response([{ id: 'pending-request', status: 'pending' }, { id: availableRequest, status: 'approved' }]))
  const pending = (await fx.refresh()).xelayUser
  assert.equal(pending.isClassRepresentative, false)
  assert.equal(pending.classRepresentativeRequestId, 'pending-request')
  fx.unmount()
})

test('temporary current-status outage preserves only same-account fields; authoritative denial and malformed data fail closed', async () => {
  const fx = fixture()
  fx.queue('representative-status', status({ owned: [ownerGroup] }))
  const before = (await fx.refresh()).xelayUser
  fx.queue('representative-status', network())
  const temporary = (await fx.refresh()).xelayUser
  assert.equal(temporary.isClassRepresentative, true)
  assert.equal(temporary.studyGroupRepresentativeStatus, before.studyGroupRepresentativeStatus)
  for (const failure of [response(null, { code: '42501', message: 'Permission denied' }, 403), response({ is_representative: true })]) {
    fx.queue('representative-status', failure)
    const denied = (await fx.refresh()).xelayUser
    assert.equal(denied.isClassRepresentative, false)
    assert.equal(denied.studyGroupRepresentativeStatusSource, 'unavailable')
    assert.equal(denied.classRepresentativeRequestId, undefined)
  }
  fx.unmount()
})

test('a missing status RPC is legacy-only before schema success and cannot resurrect old approval on repeated errors', async () => {
  const fx = fixture()
  assert.equal((await fx.refresh()).xelayUser.studyGroupRepresentativeStatusSource, 'legacy')
  fx.queue('representative-status', status())
  assert.equal((await fx.refresh()).xelayUser.isClassRepresentative, false)
  for (let attempt = 0; attempt < 2; attempt++) {
    const missing = (await fx.refresh()).xelayUser
    assert.equal(missing.isClassRepresentative, false)
    assert.equal(missing.studyGroupRepresentativeStatusSource, 'unavailable')
    assert.equal(missing.classRepresentativeRequestId, undefined)
  }
  fx.unmount()
})

test('a delayed current-status response cannot restore an outgoing account after a switch', async () => {
  const fx = fixture(), oldStatus = deferred()
  fx.queue('representative-status', oldStatus.promise)
  const old = fx.value.refreshUser()
  await flush()
  fx.sessionUser = user('account-b')
  fx.queue('representative-status', status())
  assert.equal((await fx.refresh()).xelayUser.id, 'account-b')
  oldStatus.resolve(status({ owned: [ownerGroup] }))
  await old
  const current = fx.render().xelayUser
  assert.equal(current.id, 'account-b')
  assert.equal(current.isClassRepresentative, false)
  fx.unmount()
})

test('a confirmed role change cannot restore former authority through a transient primary-profile cache', async () => {
  const fx = fixture()
  fx.queue('representative-status', status({ owned: [ownerGroup] }))
  const before = (await fx.refresh()).xelayUser
  assert.equal(before.isClassRepresentative, true)
  fx.queue('profiles', network())
  const changed = (await fx.refresh({ representativeStatusChanged: true })).xelayUser
  assert.equal(changed.name, before.name)
  assert.equal(changed.isPlatformAdmin, before.isPlatformAdmin, 'unrelated trusted fields remain intact')
  assert.equal(changed.isClassRepresentative, false)
  assert.equal(changed.classRepresentativeRequestId, undefined)
  assert.equal(changed.studyGroupRepresentativeStatus, undefined)
  assert.equal(changed.studyGroupRepresentativeStatusSource, 'unavailable')
  const missing = (await fx.refresh()).xelayUser
  assert.equal(missing.isClassRepresentative, false, 'known post-transfer schema cannot fall back to historic approval')
  assert.equal(missing.studyGroupRepresentativeStatusSource, 'unavailable')
  fx.unmount()
})

test('confirmed transfer invalidates older role fetches before an awaiting session refresh can restore them', async () => {
  const fx = fixture()
  fx.queue('representative-status', status({ owned: [ownerGroup] }))
  await fx.refresh()
  const oldStatus = deferred()
  fx.queue('representative-status', oldStatus.promise)
  const oldRefresh = fx.value.refreshUser()
  await flush()
  const sessionRefresh = deferred()
  fx.queue('session', sessionRefresh.promise)
  fx.queue('profiles', network())
  const confirmedRefresh = fx.value.refreshUser({ representativeStatusChanged: true })
  oldStatus.resolve(status({ owned: [ownerGroup] }))
  await oldRefresh
  assert.equal(fx.render().xelayUser.isClassRepresentative, false, 'old status must not cross the confirmed transfer fence')
  sessionRefresh.resolve({ data: { session: { user: user('account-a') } }, error: null })
  await confirmedRefresh
  assert.equal(fx.render().xelayUser.studyGroupRepresentativeStatusSource, 'unavailable')
  fx.unmount()
})
