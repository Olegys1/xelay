// Execute production client/worker logic with isolated mocks. No Auth account,
// provider, network, environment secret or synthetic PostgreSQL is required.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const compiled = new Map(await Promise.all(['src/lib/birthdayProfile.ts', 'server/birthdayEvents.ts', 'server/notificationRetry.ts'].map(async path => [path,
  ts.transpileModule(await readFile(new URL(path, root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText])))
const actor = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', group = '33333333-3333-4333-8333-333333333333'
const native = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const profile = { day: 29, month: 2, share_with_groups: false }
const member = { user_id: other, full_name: '  Synthetic Member  ', avatar_url: null, day: 29, month: 2, days_until: 0, is_today: true }
function timers() {
  const pending = new Map(); let next = 0
  return { pending, setTimeout: (callback, ms) => { const id = ++next; pending.set(id, { callback, ms }); return id },
    clearTimeout: id => pending.delete(id), fire: () => { const rows = [...pending.values()]; pending.clear(); for (const row of rows) row.callback() } }
}
function execute(path, dependencies, globals = {}) {
  const module = { exports: {} }
  const printed = []
  vm.runInNewContext(compiled.get(path), { module, exports: module.exports, require: name => {
    if (!(name in dependencies)) throw new Error('Unexpected import: ' + name)
    return dependencies[name]
  }, URL, AbortController, AbortSignal, Date, console: { log: (...x) => printed.push(x), warn: (...x) => printed.push(x), error: (...x) => printed.push(x) },
  fetch: () => { throw new Error('Live network forbidden in this fixture') }, ...globals })
  return { exports: module.exports, printed }
}
function client(options = {}) {
  const timer = timers(), calls = [], signals = []; let listener, sessions = 0, unsubscribed = 0
  const supabase = { auth: {
    onAuthStateChange: callback => { listener = callback; return { data: { subscription: { unsubscribe: () => { unsubscribed++ } } } } },
    getSession: async () => { const index = sessions++; return options.session ? options.session(index) : { data: { session: { user: { id: actor } } }, error: null } },
  }, rpc: (name, args) => ({ abortSignal: signal => { calls.push({ name, args }); signals.push(signal); return options.rpc ? options.rpc(name, args, signal) : Promise.resolve({ data: profile, error: null }) } }) }
  const module = execute('src/lib/birthdayProfile.ts', { './supabase': { supabase } }, { window: timer })
  return { ...module, calls, signals, timer, emit: (event, identity) => listener?.(event, identity ? { user: { id: identity } } : null), sessions: () => sessions, unsubscribed: () => unsubscribed }
}
const session = id => ({ data: { session: id ? { user: { id } } : null }, error: null })

test('birthday profile parser accepts optional dates without a year and rejects invalid calendar or consent shapes', () => {
  const { exports: api } = client()
  assert.deepEqual(native(api.parseBirthdayProfile({ day: null, month: null, share_with_groups: false })), { day: null, month: null, showToGroup: false })
  assert.deepEqual(native(api.parseBirthdayProfile({ ...profile, birth_year: 1980, email: 'not-projected' })), { day: 29, month: 2, showToGroup: false })
  for (const value of [null, [], {}, { day: null, month: null, share_with_groups: true }, { ...profile, day: 30 }, { ...profile, day: '29' }, { ...profile, month: 13 }, { ...profile, day: 0 }, { ...profile, share_with_groups: 1 }]) assert.throws(() => api.parseBirthdayProfile(value))
  assert.equal(api.validBirthday(31, 4), false)
  assert.equal(api.validBirthday(29, 2), true)
})

test('group parser bounds the disclosed window, rejects duplicates and strips unrelated private fields', () => {
  const { exports: api } = client()
  const value = native(api.parseGroupBirthdays([{ ...member, birth_year: 1980, email: 'not-projected' }]))
  assert.deepEqual(value, [{ userId: other, name: 'Synthetic Member', avatarUrl: null, day: 29, month: 2, isToday: true, daysUntil: 0 }])
  for (const rows of [[member, member], Array(201).fill(member), [{ ...member, days_until: 8 }], [{ ...member, days_until: 1 }], [{ ...member, full_name: '\nprivate' }], [{ ...member, avatar_url: 'javascript:alert(1)' }], [{ ...member, avatar_url: 'https://user:password@example.test/avatar' }]]) assert.throws(() => api.parseGroupBirthdays(rows))
})

test('client sends narrow owner/group RPC arguments and removes dates without retaining disclosure consent', async () => {
  const fx = client({ rpc: (name, args) => Promise.resolve({ data: name === 'xelay_group_birthdays' ? [member] : { day: args.p_day ?? null, month: args.p_month ?? null, share_with_groups: args.p_share_with_groups ?? false }, error: null }) })
  await fx.exports.saveBirthdayProfile(actor, { day: null, month: null, showToGroup: false })
  assert.deepEqual(native(fx.calls[0]), { name: 'xelay_save_my_birthday_profile', args: { p_day: null, p_month: null, p_share_with_groups: false } })
  await fx.exports.loadGroupBirthdays(actor, group)
  assert.deepEqual(native(fx.calls[1]), { name: 'xelay_group_birthdays', args: { p_group_id: group } })
  await assert.rejects(fx.exports.saveBirthdayProfile(actor, { day: null, month: null, showToGroup: true }))
  await assert.rejects(fx.exports.loadGroupBirthdays(actor, '../foreign'))
  assert.equal(fx.calls.length, 2)
  assert.equal(fx.unsubscribed(), 2)
  assert.equal(fx.timer.pending.size, 0)
})

test('client rejects wrong sessions before sending and after receiving without leaking foreign results', async () => {
  const before = client({ session: () => session(other) })
  await assert.rejects(before.exports.loadBirthdayProfile(actor))
  assert.equal(before.calls.length, 0)
  const after = client({ session: index => session(index ? other : actor) })
  await assert.rejects(after.exports.loadBirthdayProfile(actor))
  assert.equal(after.calls.length, 1)
  assert.equal(after.unsubscribed(), 1)
  assert.equal(after.timer.pending.size, 0)
})

async function promptCancellation(promise, cancel) {
  let outcome = 'pending'
  // The VM owns another Promise realm. Observe settlement directly instead of
  // racing its thenable against an already-resolved native Promise.
  promise.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await flush(); cancel(); await flush()
  assert.equal(outcome, 'rejected', 'abort must settle even an uncooperative Auth/transport promise')
}
test('client timeout settles an uncooperative session promise and cleans listeners/timers', async () => {
  const stuck = deferred(), fx = client({ session: () => stuck.promise })
  await promptCancellation(fx.exports.loadBirthdayProfile(actor), () => fx.timer.fire())
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.unsubscribed(), 1)
  assert.equal(fx.timer.pending.size, 0)
})

test('account changes and caller cancellation settle pending RPCs, ignore late replies and clean subscriptions', async () => {
  for (const reason of ['sign-out', 'other-account', 'caller']) {
    const stuck = deferred(), fx = client({ rpc: () => stuck.promise }), controller = new AbortController()
    const pending = fx.exports.loadBirthdayProfile(actor, controller.signal)
    await promptCancellation(pending, () => reason === 'caller' ? controller.abort() : fx.emit(reason === 'sign-out' ? 'SIGNED_OUT' : 'SIGNED_IN', reason === 'other-account' ? other : null))
    assert.equal(fx.signals[0].aborted, true)
    stuck.resolve({ data: profile, error: null }); await flush()
    assert.equal(fx.unsubscribed(), 1)
    assert.equal(fx.timer.pending.size, 0)
  }
})

test('already-aborted client requests create no session or database work', async () => {
  const fx = client(), controller = new AbortController(); controller.abort()
  await assert.rejects(fx.exports.loadBirthdayProfile(actor, controller.signal))
  assert.equal(fx.sessions(), 0)
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.timer.pending.size, 0)
  assert.equal(fx.unsubscribed(), 1)
})

test('client rejects malformed replies and sanitizes RPC failures without leaking provider messages', async () => {
  for (const reply of [{ data: { ...profile, day: 30 }, error: null },
    { data: null, error: { code: '42501', message: 'private@example.test fixture-only-service' } },
    { data: null, error: { code: '22023', message: 'private@example.test fixture-only-service' } },
    { data: null, error: { code: 'PGRST202', message: 'private@example.test fixture-only-service' } }]) {
    const fx = client({ rpc: () => Promise.resolve(reply) })
    await assert.rejects(fx.exports.loadBirthdayProfile(actor), error => !/private@example|fixture-only/.test(error.message))
    assert.equal(fx.timer.pending.size, 0); assert.equal(fx.unsubscribed(), 1); assert.equal(fx.printed.length, 0)
  }
})

const clock = Date.parse('2026-10-29T12:00:00Z')
const counters = { today: '2026-10-29', processed: 2, gifts_offered: 1, group_notifications: 3, has_more: false }
function worker(options = {}) {
  const timer = timers(), calls = [], clients = [], signals = []
  class FixedDate extends Date { static now() { return clock } }
  const environment = { BIRTHDAY_EVENTS_ENABLED: 'true', SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only-service', ...options.env }
  const createClient = (...args) => {
    clients.push(args)
    if (options.createThrows) throw new Error('Sensitive fixture-only-service must never escape')
    return { rpc: (name, args) => ({ abortSignal: signal => { calls.push({ name, args }); signals.push(signal); return options.rpc ? options.rpc(name, args, signal) : Promise.resolve({ data: counters, error: null }) } }) }
  }
  const { exports: api, printed } = execute('server/birthdayEvents.ts', { '@supabase/supabase-js': { createClient } },
    { process: { env: environment }, Date: FixedDate, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout })
  return { api, timer, calls, clients, signals, printed, deadline: clock + 53000 }
}
test('birthday worker defaults off and rejects missing config or insufficient budget without creating a client', async () => {
  for (const env of [{ BIRTHDAY_EVENTS_ENABLED: undefined }, { BIRTHDAY_EVENTS_ENABLED: 'false' }, { BIRTHDAY_EVENTS_ENABLED: 'TRUE' }]) {
    const fx = worker({ env }), result = await fx.api.processBirthdayEvents(fx.deadline)
    assert.equal(result.enabled, false); assert.equal(result.status, 'disabled'); assert.equal(fx.clients.length, 0)
  }
  for (const env of [{ SUPABASE_URL: 'http://synthetic.supabase.co' }, { SUPABASE_URL: 'https://name:password@synthetic.supabase.co' }, { SUPABASE_SERVICE_ROLE_KEY: '' }, { SUPABASE_URL: 'https://synthetic.supabase.co?key=value' }]) {
    const fx = worker({ env }); assert.equal((await fx.api.processBirthdayEvents(fx.deadline)).status, 'unavailable'); assert.equal(fx.clients.length, 0)
  }
  for (const deadline of [clock, clock + 1999, NaN]) {
    const fx = worker(); assert.equal((await fx.api.processBirthdayEvents(deadline)).status, 'deadline'); assert.equal(fx.clients.length, 0)
  }
})

test('birthday worker calls one bounded RPC and returns counters only even when provider data contains personal fields', async () => {
  const fx = worker({ rpc: () => Promise.resolve({ data: { ...counters, email: 'private@example.test', day: 29, month: 10, user_id: actor }, error: null }) })
  const result = native(await fx.api.processBirthdayEvents(fx.deadline))
  assert.deepEqual(result, { enabled: true, status: 'processed', processed: 2, giftsOffered: 1, groupNotifications: 3, hasMore: false })
  assert.deepEqual(native(fx.calls), [{ name: 'xelay_process_due_birthdays', args: { p_limit: 25 } }])
  assert.equal(fx.clients.length, 1); assert.equal(fx.timer.pending.size, 0); assert.equal(fx.signals[0].aborted, true)
  assert.equal(fx.clients[0][2].auth.persistSession, false); assert.equal(fx.clients[0][2].auth.autoRefreshToken, false)
  assert.equal(fx.printed.length, 0)
})

test('birthday worker fails closed on impossible counter shapes and maps only missing RPC errors to migration waiting', async () => {
  for (const data of [null, [], { ...counters, processed: 26 }, { ...counters, gifts_offered: 3 }, { ...counters, group_notifications: 26 }, { ...counters, group_notifications: -1 }, { ...counters, processed: 1.5 }, { ...counters, has_more: 'yes' }]) {
    const fx = worker({ rpc: () => Promise.resolve({ data, error: null }) }); assert.equal((await fx.api.processBirthdayEvents(fx.deadline)).status, 'unavailable')
  }
  for (const code of ['PGRST202', '42883', '42501', 'XX000']) {
    const fx = worker({ rpc: () => Promise.resolve({ data: null, error: { code, message: 'fixture-only-service personal@example.test' } }) })
    const result = await fx.api.processBirthdayEvents(fx.deadline)
    assert.equal(result.status, ['PGRST202', '42883'].includes(code) ? 'waiting_for_migration' : 'unavailable')
    assert.doesNotMatch(JSON.stringify(result), /fixture-only|personal@example/); assert.equal(fx.printed.length, 0)
  }
})

test('birthday worker deadline aborts a stuck RPC and exceptions do not leak configuration or personal data', async () => {
  const fx = worker({ rpc: () => deferred().promise })
  const pending = fx.api.processBirthdayEvents(fx.deadline); await flush()
  assert.equal([...fx.timer.pending.values()][0].ms, 5000)
  fx.timer.fire()
  assert.equal((await pending).status, 'deadline'); assert.equal(fx.signals[0].aborted, true); assert.equal(fx.timer.pending.size, 0)
  const failure = worker({ createThrows: true }), response = await failure.api.processBirthdayEvents(failure.deadline)
  assert.equal(response.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(response), /fixture-only|Sensitive/); assert.equal(failure.printed.length, 0)
})

function retry(options = {}) {
  const calls = [], response = { headers: {}, statusCode: null, body: null, setHeader(name, value) { this.headers[name] = value }, status(value) { this.statusCode = value; return this }, json(value) { this.body = value; return this } }
  const mail = {
    notificationPrivateResponse: () => calls.push('private'), authorizeNotificationWorker: () => { calls.push('authorize'); if (options.unauthorized) throw new Error('forbidden') },
    notificationEmailConfiguration: () => { calls.push('mail-config'); if (options.mailConfigThrows) throw new Error('missing mail'); return {} },
    notificationEmailWorkerSchemaReady: async () => options.schemaReady !== false,
    deliverNotificationEmail: async () => { calls.push('mail-deliver'); return { processed: false } },
    notificationEmailWorkerHeartbeat: async () => calls.push('heartbeat'), notificationEmailWorkerDisable: async () => calls.push('disable'),
    sendNotificationEmailError: (res, error) => res.status(options.unauthorized ? 401 : 503).json({ error: 'sanitized' }),
  }
  const module = execute('server/notificationRetry.ts', { './notificationEmail.js': mail,
    './adminRepresentativeAlerts.js': { deliverAdminRepresentativeAlert: async () => { calls.push('admin-alerts'); return { sent: 0 } } },
    './securityMonitor.js': { deliverAdminSecurityAlerts: async () => { calls.push('security'); return { state: 'disabled' } } },
    './opportunitiesDigest.js': { deliverOpportunitiesDigest: async () => ({ enabled: false }) },
    './birthdayEvents.js': { processBirthdayEvents: async () => { calls.push('birthday'); if (options.birthdayThrows) throw new Error('private details'); return { status: 'processed', processed: 1 } } },
  }, { setTimeout: () => { throw new Error('Unexpected sleep') } })
  return { handler: module.exports.default, calls, response }
}
test('existing worker authenticates before birthday work and keeps GET/unauthorized requests free of new activity', async () => {
  for (const [method, unauthorized, status] of [['GET', false, 405], ['POST', true, 401]]) {
    const fx = retry({ unauthorized }); await fx.handler({ method }, fx.response)
    assert.equal(fx.response.statusCode, status); assert.equal(fx.calls.includes('birthday'), false); assert.equal(fx.calls.includes('mail-deliver'), false)
  }
})

test('birthday work survives missing mail configuration and its own failures cannot interrupt mail, heartbeat or security', async () => {
  const absentMail = retry({ mailConfigThrows: true }); await absentMail.handler({ method: 'POST' }, absentMail.response)
  assert.equal(absentMail.response.statusCode, 503); assert.ok(absentMail.calls.indexOf('birthday') < absentMail.calls.indexOf('mail-config'))
  for (const schemaReady of [true, false]) {
    const fx = retry({ birthdayThrows: true, schemaReady }); await fx.handler({ method: 'POST' }, fx.response)
    assert.equal(fx.response.statusCode, 200); assert.equal(fx.response.body.birthday_events, null)
    assert.equal(fx.calls.includes('security'), true); assert.equal(fx.calls.includes('heartbeat'), true)
    assert.equal(fx.calls.includes('mail-deliver'), schemaReady); assert.equal(fx.calls.includes('disable'), false)
    assert.doesNotMatch(JSON.stringify(fx.response.body), /private details/)
  }
})
