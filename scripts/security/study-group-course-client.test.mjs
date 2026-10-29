// Real course/review client with isolated Auth/RPC/timers. No network, live
// account, environment key, database mutation or transport fallback is used.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = ts.transpileModule(await readFile(new URL('../../src/lib/studyGroupCourse.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const actor = '11111111-1111-4111-8111-111111111111', group = '22222222-2222-4222-8222-222222222222'
const application = '33333333-3333-4333-8333-333333333333', command = '44444444-4444-4444-8444-444444444444'
const other = '55555555-5555-4555-8555-555555555555', reviewId = '66666666-6666-4666-8666-666666666666'
const date = '2026-10-29T14:00:00.123456+00:00', choice = { course: 2, level: 'bachelor', academicYear: 2026 }
const status = { group_id: group, academic_year: 2026, cohort_start_year: 2025, study_level: 'bachelor', current_course: 2,
  archived: false, outside_current_period: false, confirmed: true, needs_confirmation: false }
const receipt = { group_id: group, academic_year: 2026, cohort_start_year: 2025, study_level: 'bachelor', course: 2, confirmed_at: date, replayed: false }
const review = { id: reviewId, status: 'pending', request_id: application, group_id: null, course: 2, academic_year: 2026,
  cohort_start_year: 2025, study_level: 'bachelor', resolution_reason: null, created_at: date }
const collision = { id: group, group_name: 'МА-2', representative_name: 'Synthetic Headman', cohort_start_year: null, study_level: null, snapshot_unchanged: null }
const adminReview = { ...review, kind: 'creation', group_name: 'МА-2', specialty: 'Synthetic OP', academic_unit_name: 'Synthetic faculty', university_name: 'Synthetic university', message: 'Перевірте курс',
  applicant: { id: actor, full_name: 'Synthetic User', username: 'synthetic_user' }, collision_groups: [collision] }
const session = id => ({ data: { session: id ? { user: { id } } : null }, error: null })
const native = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture(options = {}) {
  let listener, sessions = 0, unsubscribed = 0, subscriptions = 0, timerId = 0
  const calls = [], signals = [], timers = new Map(), printed = []
  const defaultData = name => name === 'xelay_study_group_course_status' ? status
    : name === 'xelay_confirm_study_group_course' ? receipt : name === 'xelay_create_study_group_with_course' ? group
      : name === 'xelay_request_study_group_identity_review' ? { id: command, status: 'pending', reused: false }
        : name === 'xelay_my_study_group_identity_reviews' ? [review]
          : name === 'xelay_admin_study_group_identity_reviews' ? { total: 1, items: [adminReview] }
            : { id: reviewId, action: 'confirm_identity', status: 'resolved', group_id: group }
  const supabase = { auth: {
    onAuthStateChange(fn) {
      if (options.subscriptionError) throw new Error('private@example.test provider internals')
      subscriptions++; listener = fn
      return { data: { subscription: { unsubscribe() { unsubscribed++; if (options.unsubscribeError) throw new Error('private cleanup internals') } } } }
    },
    getSession() { const index = sessions++; return options.session ? options.session(index) : Promise.resolve(session(actor)) },
  }, rpc(name, args) { return { abortSignal(signal) {
    calls.push({ name, args }); signals.push(signal)
    return options.rpc ? options.rpc(name, args, signal) : Promise.resolve({ data: defaultData(name), error: null })
  } } } }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require(name) { assert.equal(name, './supabase'); return { supabase } },
    window: { setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id }, clearTimeout(id) { timers.delete(id) } },
    AbortController, Date, console: { log: (...value) => printed.push(value), error: (...value) => printed.push(value), warn: (...value) => printed.push(value) },
    fetch() { throw new Error('NO_NETWORK_ALLOWED') },
  })
  return { api: module.exports, calls, signals, timers, printed, sessions: () => sessions, unsubscribed: () => unsubscribed, subscriptions: () => subscriptions,
    emit: (event, id) => listener?.(event, id ? { user: { id } } : null), emitRaw: (event, value) => listener?.(event, value),
    fire: () => { const values = [...timers.values()]; timers.clear(); for (const timer of values) timer.fn() },
  }
}
function clean(fx, count = 1) {
  assert.equal(fx.timers.size, 0, 'timeout cleared'); assert.equal(fx.unsubscribed(), count, 'Auth subscription cleaned'); assert.equal(fx.printed.length, 0)
}
const confirm = (fx, signal) => fx.api.confirmGroupCourse(actor, group, choice, command, signal)
const response = data => ({ rpc: () => Promise.resolve({ data, error: null }) })
const reviewResponse = rows => response(rows)
const adminResponse = items => response({ total: items.length, items })
async function promptly(promise, cancel) {
  let result = 'pending'
  promise.then(() => { result = 'resolved' }, () => { result = 'rejected' })
  await flush(); cancel(); await flush()
  assert.equal(result, 'rejected', 'cancellation settles even a transport that ignores AbortSignal')
}

test('course parser projects bounded fields, preserving unknown identities and outside-period groups', () => {
  const { api } = fixture()
  assert.deepEqual(native(api.parseGroupCourseStatus({ ...status, private_email: 'private@example.test' }, group)), {
    groupId: group, academicYear: 2026, cohortStartYear: 2025, level: 'bachelor', course: 2,
    archived: false, outsideCurrentPeriod: false, confirmed: true, needsConfirmation: false,
  })
  const unknown = { ...status, cohort_start_year: null, study_level: null, current_course: null, confirmed: false, needs_confirmation: true }
  assert.equal(api.parseGroupCourseStatus(unknown, group).cohortStartYear, null)
  for (const cohort of [2010, 2030]) {
    const outside = api.parseGroupCourseStatus({ ...status, cohort_start_year: cohort, current_course: null, archived: true, outside_current_period: true }, group)
    assert.equal(outside.course, null); assert.equal(outside.archived, true)
  }
  for (const bad of [null, [], {}, { ...status, group_id: other }, { ...status, academic_year: '2026' }, { ...status, academic_year: 2200 },
    { ...status, current_course: 7 }, { ...status, current_course: null }, { ...status, current_course: 1 }, { ...status, study_level: ['bachelor'] },
    { ...status, cohort_start_year: null }, { ...status, archived: true }, { ...status, outside_current_period: true }, { ...status, confirmed: 1 },
    { ...status, needs_confirmation: true }, { ...unknown, confirmed: true, needs_confirmation: false }, { ...unknown, needs_confirmation: false }]) assert.throws(() => api.parseGroupCourseStatus(bad, group))
  assert.throws(() => api.parseGroupCourseStatus({ ...status, group_id: 'bad' }, 'bad'))
})

test('all course and review operations send exact RPC names/arguments without an actor-controlled identity', async () => {
  const fx = fixture()
  await fx.api.loadGroupCourse(actor, group)
  await confirm(fx)
  assert.equal(await fx.api.createStudyGroupWithCourse(actor, application, choice, command), group)
  await fx.api.requestGroupIdentityReview(actor, { applicationId: application }, choice, '  Перевірте курс  ', command)
  await fx.api.requestGroupIdentityReview(actor, { groupId: group }, choice, '', command)
  await fx.api.loadOwnGroupIdentityReviews(actor)
  await fx.api.loadAdminGroupIdentityReviews(actor, 'all', 20)
  await fx.api.resolveGroupIdentityReview(actor, reviewId, 'confirm_identity', '  Підтверджено набір за заявкою  ', group, choice)
  const inputChoice = { p_course: 2, p_study_level: 'bachelor', p_academic_year: 2026 }
  assert.deepEqual(native(fx.calls), [
    { name: 'xelay_study_group_course_status', args: { p_group_id: group } },
    { name: 'xelay_confirm_study_group_course', args: { p_group_id: group, ...inputChoice, p_request_id: command } },
    { name: 'xelay_create_study_group_with_course', args: { p_request_id: application, ...inputChoice, p_request_idempotency: command } },
    { name: 'xelay_request_study_group_identity_review', args: { p_request_id: application, p_group_id: null, ...inputChoice, p_message: 'Перевірте курс', p_command_id: command } },
    { name: 'xelay_request_study_group_identity_review', args: { p_request_id: null, p_group_id: group, ...inputChoice, p_message: '', p_command_id: command } },
    { name: 'xelay_my_study_group_identity_reviews', args: {} },
    { name: 'xelay_admin_study_group_identity_reviews', args: { p_status: 'all', p_limit: 20, p_offset: 20 } },
    { name: 'xelay_admin_resolve_study_group_identity_review', args: { p_review_id: reviewId, p_action: 'confirm_identity', p_reason: 'Підтверджено набір за заявкою', p_existing_group_id: group, ...inputChoice } },
  ])
  assert.equal(fx.sessions(), 16); clean(fx, 8)
})

test('retry identities remain caller-supplied and valid reviewed-case replays are acknowledged', async () => {
  const fx = fixture({ rpc: () => Promise.resolve({ data: { ...receipt, replayed: true }, error: null }) })
  await confirm(fx); await confirm(fx)
  assert.equal(fx.calls.length, 2); assert.ok(fx.calls.every(call => call.args.p_request_id === command)); clean(fx, 2)
  for (const reviewStatus of ['pending', 'resolved', 'closed']) {
    const replay = fixture(response({ id: reviewId, status: reviewStatus, reused: true }))
    assert.deepEqual(native(await replay.api.requestGroupIdentityReview(actor, { groupId: group }, choice, '', command)), { id: reviewId, reused: true, status: reviewStatus })
    assert.equal(replay.calls.length, 1); assert.equal(replay.calls[0].args.p_command_id, command); clean(replay)
  }
  for (const code of ['PGRST202', '42883', '503']) {
    const unavailable = fixture({ rpc: () => Promise.resolve({ data: null, error: { code, message: 'missing or temporarily unavailable' } }) })
    await assert.rejects(unavailable.api.createStudyGroupWithCourse(actor, application, choice, command))
    assert.equal(unavailable.calls.length, 1); assert.equal(unavailable.calls[0].name, 'xelay_create_study_group_with_course'); clean(unavailable)
  }
})

test('invalid IDs, scope, controls, choices and pagination fail before Auth or transport work', async () => {
  const fx = fixture(), invalidChoices = [null, {}, { ...choice, course: 0 }, { ...choice, course: '2' }, { ...choice, course: 7 }, { ...choice, level: ['bachelor'] },
    { ...choice, level: 'other' }, { ...choice, academicYear: 2200 }, { ...choice, academicYear: 1900, course: 6 }]
  for (const bad of invalidChoices) await assert.rejects(fx.api.confirmGroupCourse(actor, group, bad, command))
  for (const args of [['bad', group, choice, command], [actor, 'bad', choice, command], [actor, group, choice, 'bad']]) await assert.rejects(fx.api.confirmGroupCourse(...args))
  for (const scope of [null, {}, { groupId: group, applicationId: application }, { groupId: 'bad' }, { groupId: group, applicationId: '' }]) await assert.rejects(fx.api.requestGroupIdentityReview(actor, scope, choice, '', command))
  for (const message of ['x'.repeat(1001), 'private\u0001text', 'bad\u007ftext', null]) await assert.rejects(fx.api.requestGroupIdentityReview(actor, { groupId: group }, choice, message, command))
  for (const reason of ['', 'too short', 'x'.repeat(1001), 'unsafe\u0000reason', null]) await assert.rejects(fx.api.resolveGroupIdentityReview(actor, reviewId, 'close', reason, null, null))
  await assert.rejects(fx.api.resolveGroupIdentityReview(actor, reviewId, 'distinct', 'Пояснення перевірки', null, choice))
  for (const [filter, offset] of [['invalid', 0], ['pending', -1], ['pending', 100001], ['pending', '0']]) await assert.rejects(fx.api.loadAdminGroupIdentityReviews(actor, filter, offset))
  assert.equal(fx.sessions(), 0); assert.equal(fx.calls.length, 0); clean(fx, 0)
})

test('preflight and post-response session identities fence every result and sanitize malformed Auth', async () => {
  for (const identity of [other, null]) {
    const before = fixture({ session: async () => session(identity) })
    await assert.rejects(confirm(before)); assert.equal(before.calls.length, 0); clean(before)
    const after = fixture({ session: async index => session(index ? identity : actor) })
    await assert.rejects(confirm(after)); assert.equal(after.calls.length, 1); clean(after)
  }
  for (const bad of [null, undefined, {}, { data: null }, { data: { session: {} } }, { data: { session: { user: { id: actor } } }, error: { message: 'private@example.test SQL secret' } }]) {
    for (const at of [0, 1]) {
      const fx = fixture({ session: async index => index === at ? bad : session(actor) })
      await assert.rejects(confirm(fx), error => !/private@|SQL|secret|Cannot read/.test(error.message)); clean(fx)
    }
  }
})

test('confirmation, creation and review receipts must bind the requested choices and stay bounded', async () => {
  for (const data of [null, [], {}, { ...receipt, group_id: other }, { ...receipt, course: 1 }, { ...receipt, academic_year: 2025 },
    { ...receipt, cohort_start_year: 2024 }, { ...receipt, study_level: ['bachelor'] }, { ...receipt, replayed: 1 },
    ...['yesterday', '2026-02-30T10:00:00Z', '2026-10-29T24:00:00Z', '2026-10-29', '2026-10-29T10:00:00' + ' '.repeat(100)].map(confirmed_at => ({ ...receipt, confirmed_at }))]) {
    const fx = fixture(response(data)); await assert.rejects(confirm(fx), /перевірити результат/); clean(fx)
  }
  for (const data of [null, '', [], {}, 'bad', { group_id: group }]) {
    const fx = fixture(response(data)); await assert.rejects(fx.api.createStudyGroupWithCourse(actor, application, choice, command)); clean(fx)
  }
  for (const data of [null, {}, { id: other, status: 'pending', reused: false }, { id: command, status: ['pending'], reused: false },
    { id: command, status: 'resolved', reused: false }, { id: command, status: 'pending', reused: 'true' }]) {
    const fx = fixture(response(data)); await assert.rejects(fx.api.requestGroupIdentityReview(actor, { groupId: group }, choice, '', command)); clean(fx)
  }
})

test('own review parser strips unrelated details, bounds lists and enforces exact scope/cohort/time/status semantics', async () => {
  const good = fixture(reviewResponse([{ ...review, private_email: 'private@example.test' }, { ...review, id: other, status: 'resolved', resolution_reason: 'Курс перевірено адміністратором' }]))
  const rows = await good.api.loadOwnGroupIdentityReviews(actor)
  assert.equal(rows.length, 2); assert.equal(rows[1].status, 'resolved'); assert.ok(!JSON.stringify(rows).includes('private@')); clean(good)
  for (const data of [null, {}, Array(21).fill(review), [review, review], [null], [{ ...review, status: ['pending'] }],
    [{ ...review, study_level: ['bachelor'] }], [{ ...review, cohort_start_year: 2024 }], [{ ...review, request_id: null }],
    [{ ...review, group_id: group }], [{ ...review, created_at: 'yesterday' }], [{ ...review, created_at: '2026-02-30T10:00:00Z' }],
    [{ ...review, resolution_reason: 'Unexpected pending resolution' }], [{ ...review, status: 'closed', resolution_reason: null }]]) {
    const fx = fixture(reviewResponse(data)); await assert.rejects(fx.api.loadOwnGroupIdentityReviews(actor)); clean(fx)
  }
})

test('admin review parser accepts unknown legacy anchors and missing profile joins without granting unchanged status', async () => {
  const fx = fixture(adminResponse([{ ...adminReview, applicant: { id: null, full_name: null, username: null }, collision_groups: [{ ...collision, representative_name: null }] }]))
  const page = await fx.api.loadAdminGroupIdentityReviews(actor)
  assert.deepEqual(native(page.items[0].applicant), { id: null, name: '', username: '' })
  assert.deepEqual(native(page.items[0].collisionGroups[0]), { id: group, name: 'МА-2', representative: '', cohort: null, level: null, unchanged: false }); clean(fx)
  for (const row of [{ ...adminReview, kind: ['creation'] }, { ...adminReview, kind: 'group' }, { ...adminReview, applicant: { id: null, full_name: 'Wrong identity', username: null } },
    { ...adminReview, collision_groups: [collision, collision] }, { ...adminReview, collision_groups: Array(201).fill(collision) },
    { ...adminReview, collision_groups: [{ ...collision, study_level: 'bachelor' }] }, { ...adminReview, collision_groups: [{ ...collision, snapshot_unchanged: 'true' }] },
    { ...adminReview, message: 'x'.repeat(1001) }, { ...adminReview, group_name: 'bad\u007fname' }]) {
    const bad = fixture(adminResponse([row])); await assert.rejects(bad.api.loadAdminGroupIdentityReviews(actor)); clean(bad)
  }
  for (const value of [null, {}, { total: -1, items: [] }, { total: 1000001, items: [] }, { total: 0, items: [adminReview] }, { total: 2, items: [adminReview, adminReview] }, { total: 21, items: Array(21).fill(adminReview) }]) {
    const bad = fixture(response(value)); await assert.rejects(bad.api.loadAdminGroupIdentityReviews(actor)); clean(bad)
  }
})

test('admin mutation accepts only the matching action/status/group receipt and close preserves the case scope', async () => {
  for (const action of ['confirm_identity', 'distinct']) {
    const fx = fixture(response({ id: reviewId, action, status: 'resolved', group_id: group }))
    assert.equal((await fx.api.resolveGroupIdentityReview(actor, reviewId, action, 'Перевірено документи набору', group, choice)).groupId, group); clean(fx)
    for (const data of [{ id: other, action, status: 'resolved', group_id: group }, { id: reviewId, action, status: 'closed', group_id: group },
      { id: reviewId, action, status: 'resolved', group_id: other }, { id: reviewId, action, status: 'resolved', group_id: null }]) {
      const bad = fixture(response(data)); await assert.rejects(bad.api.resolveGroupIdentityReview(actor, reviewId, action, 'Перевірено документи набору', group, choice)); clean(bad)
    }
  }
  for (const closedGroup of [null, group]) {
    const fx = fixture(response({ id: reviewId, action: 'close', status: 'closed', group_id: closedGroup }))
    assert.equal((await fx.api.resolveGroupIdentityReview(actor, reviewId, 'close', 'Пояснення закриття звернення', null, null)).groupId, closedGroup)
    assert.deepEqual(native(fx.calls[0].args), { p_review_id: reviewId, p_action: 'close', p_reason: 'Пояснення закриття звернення', p_existing_group_id: null, p_course: null, p_study_level: null, p_academic_year: null }); clean(fx)
  }
})

test('known server failures are useful, bounded and never echo SQL, contacts, details or hints', async () => {
  const cases = [
    ['PT409', 'GROUP_IDENTITY_NEEDS_REVIEW', /адміністратору/], ['23505', 'duplicate identity', /адміністратору/],
    ['42501', 'ADMIN_MFA_REQUIRED', /двоетапний/], ['42501', 'GROUP_REVIEW_SELF_REVIEW', /інший адміністратор/],
    ['PT409', 'GROUP_REVIEW_STALE', /вже змінилася/], ['22023', 'GROUP_COURSE_REQUEST_REUSED', /вже використано/],
    ['PT409', 'GROUP_COURSE_CONFIRMATION_REQUIRED', /підтвердити курс/], ['42501', 'GROUP_COURSE_NOT_OWNER', /Немає чинного доступу/],
    ['22023', 'GROUP_COURSE_INVALID_INPUT', /Перевірте курс/], ['PT409', 'GROUP_REVIEW_PENDING', /очікує/],
    ['22023', 'GROUP_REVIEW_CAPACITY', /надто багато/], ['PGRST202', 'missing RPC', /ще підключається/], ['XX000', 'unexpected SQL', /не вдалося перевірити/i],
  ]
  for (const [code, message, pattern] of cases) {
    const fx = fixture({ rpc: () => Promise.resolve({ data: receipt, error: { code, message: message + ' private@example.test SELECT secret', details: 'private-token', hint: 'secret-record' } }) })
    await assert.rejects(confirm(fx), error => pattern.test(error.message) && error.message.length < 300 && !/private@|SELECT|secret|token/.test(error.message)); clean(fx)
  }
  const { api } = fixture(), collisionError = api.groupCourseError({ code: 'PT409', message: 'GROUP_ALREADY_EXISTS' })
  assert.equal(api.groupCourseNeedsReview(collisionError), true)
  assert.equal(api.groupCourseNeedsReview(api.groupCourseError({ code: '503', message: 'private error' })), false)
})

test('20-second timeout settles hung preflight Auth, RPC and post-response Auth, with no retries or late disclosure', async () => {
  for (const stage of ['before', 'rpc', 'after']) {
    const stuck = deferred(), fx = fixture({ session: index => stage === (index ? 'after' : 'before') ? stuck.promise : Promise.resolve(session(actor)),
      rpc: () => stage === 'rpc' ? stuck.promise : Promise.resolve({ data: receipt, error: null }) })
    const pending = confirm(fx)
    await flush(); assert.equal([...fx.timers.values()][0].delay, 20000)
    await promptly(pending, fx.fire); clean(fx)
    assert.equal(fx.calls.length, stage === 'before' ? 0 : 1)
    stuck.resolve(stage === 'rpc' ? { data: receipt, error: null } : session(actor)); await flush()
    assert.equal(fx.calls.length, stage === 'before' ? 0 : 1)
  }
})

test('caller cancellation, signout, account switch and malformed session events abort and fence late results', async () => {
  for (const reason of ['caller', 'signout', 'account', 'malformed']) {
    const stuck = deferred(), fx = fixture({ rpc: () => stuck.promise }), controller = new AbortController()
    const pending = confirm(fx, controller.signal)
    await promptly(pending, () => reason === 'caller' ? controller.abort() : reason === 'malformed' ? fx.emitRaw('SIGNED_IN', {}) : fx.emit(reason === 'signout' ? 'SIGNED_OUT' : 'SIGNED_IN', reason === 'account' ? other : null))
    assert.equal(fx.signals[0].aborted, true); assert.equal(fx.calls.length, 1); clean(fx)
    stuck.resolve({ data: receipt, error: null }); await flush(); assert.equal(fx.sessions(), 1)
  }
  const early = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(confirm(early, controller.signal)); assert.equal(early.calls.length, 0); assert.equal(early.sessions(), 0); clean(early)
})

test('same-account token refresh is allowed, and caller AbortSignal listeners are removed after settlement', async () => {
  const stuck = deferred(), fx = fixture({ rpc: () => stuck.promise }), controller = new AbortController(), listeners = new Set()
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (type, callback, options) => { if (type === 'abort') listeners.add(callback); add(type, callback, options) }
  controller.signal.removeEventListener = (type, callback, options) => { if (type === 'abort') listeners.delete(callback); remove(type, callback, options) }
  const pending = confirm(fx, controller.signal); await flush()
  fx.emit('TOKEN_REFRESHED', actor); assert.equal(fx.signals[0].aborted, false)
  stuck.resolve({ data: receipt, error: null }); await pending
  assert.equal(listeners.size, 0); clean(fx)
})

test('sync/async Auth, subscription and network failures are sanitized and leave no timer behind', async () => {
  for (const at of [0, 1]) for (const sync of [true, false]) {
    const fx = fixture({ session(index) { if (index !== at) return Promise.resolve(session(actor)); const error = new Error('private@example.test SQL secret'); if (sync) throw error; return Promise.reject(error) } })
    await assert.rejects(confirm(fx), error => /перевірити результат/.test(error.message) && !/private@|SQL|secret/.test(error.message)); clean(fx)
  }
  const subscription = fixture({ subscriptionError: true })
  await assert.rejects(confirm(subscription), /перевірити результат/); clean(subscription, 0)
  const network = fixture({ rpc: () => Promise.reject(new Error('private@example.test SQL secret')) })
  await assert.rejects(confirm(network), error => /перевірити результат/.test(error.message) && !/private@|SQL|secret/.test(error.message)); clean(network)
  const malformed = fixture(response(null)); await assert.rejects(confirm(malformed)); clean(malformed)
  const badEnvelope = fixture({ rpc: () => Promise.resolve(null) }); await assert.rejects(confirm(badEnvelope), /перевірити результат/); clean(badEnvelope)
  const cleanup = fixture({ unsubscribeError: true }); assert.equal((await confirm(cleanup)).groupId, group); clean(cleanup)
})
