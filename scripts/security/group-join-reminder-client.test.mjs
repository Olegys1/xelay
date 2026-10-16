// Real typed client helpers with synthetic Supabase responses; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/studyGroupJoinReminder.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const user = '11000000-0000-4000-8000-000000000001'
const other = '11000000-0000-4000-8000-000000000002'
const group = '11000000-0000-4000-8000-000000000003'
const campaign = 'join-study-group-2026-10-16'
const empty = () => ({ data: null, error: null })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function fixture({ respond = empty, write = empty, storage = new Map(), brokenStorage = false } = {}) {
  const calls = [], writes = [], module = { exports: {} }
  const supabase = { from(table) {
    const call = { table, filters: [] }
    const query = {
      select(columns) { call.columns = columns; return query },
      eq(column, value) { call.filters.push([column, value]); return query },
      limit(value) { call.limit = value; return query },
      abortSignal(signal) { call.signal = signal; return query },
      maybeSingle() { calls.push(call); return Promise.resolve().then(() => respond(call, calls.length)) },
      upsert(value, options) { const mutation = { table, value: plain(value), options: plain(options) }; writes.push(mutation); return Promise.resolve().then(() => write(mutation, writes.length)) },
    }
    return query
  } }
  const localStorage = {
    getItem(key) { if (brokenStorage) throw new Error('storage blocked'); return storage.get(key) ?? null },
    setItem(key, value) { if (brokenStorage) throw new Error('storage blocked'); storage.set(key, value) },
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, localStorage, require(name) { assert.equal(name, './supabase'); return { supabase } } })
  return { api: module.exports, calls, writes, storage }
}

test('own-account probes are narrow SELECTs and distinguish no group from pending invitations', async () => {
  const signal = new AbortController().signal
  const { api, calls } = fixture()
  assert.equal(api.GROUP_JOIN_REMINDER_ID, campaign)
  assert.deepEqual(plain(await api.loadGroupJoinReminderState(user, signal)), { seen: false, inGroup: false, pendingInvites: false })
  assert.deepEqual(calls.map(({ signal: received, ...call }) => { assert.equal(received, signal); return plain(call) }), [
    { table: 'account_announcement_receipts', columns: 'announcement_id', filters: [['user_id', user], ['announcement_id', campaign]] },
    { table: 'study_group_members', columns: 'group_id', filters: [['user_id', user], ['status', 'accepted']], limit: 1 },
    { table: 'study_groups', columns: 'id', filters: [['representative_id', user]], limit: 1 },
    { table: 'study_group_members', columns: 'group_id', filters: [['user_id', user], ['status', 'pending']], limit: 1 },
  ])
  assert.doesNotMatch(source.slice(source.indexOf('export async function loadGroupJoinReminderState')), /\.rpc\(|\.insert\(|\.update\(|\.delete\(|select\(['"]\*/)
})

test('accepted membership or represented group suppresses the reminder without an invitation query', async () => {
  for (const represented of [false, true]) {
    const { api, calls } = fixture({ respond: call => call.table === (represented ? 'study_groups' : 'study_group_members')
      ? { data: represented ? { id: group } : { group_id: group }, error: null } : empty() })
    assert.deepEqual(plain(await api.loadGroupJoinReminderState(user, new AbortController().signal)), { seen: false, inGroup: true, pendingInvites: false })
    assert.equal(calls.length, 3)
  }
})

test('an invitation is a distinct state and never an accepted membership', async () => {
  const { api, calls } = fixture({ respond: call => call.filters.some(([name, value]) => name === 'status' && value === 'pending')
    ? { data: { group_id: group }, error: null } : empty() })
  assert.deepEqual(plain(await api.loadGroupJoinReminderState(user, new AbortController().signal)), { seen: false, inGroup: false, pendingInvites: true })
  assert.equal(calls.length, 4)
})

test('every failed probe rejects instead of interpreting unknown access or network state as no group', async () => {
  for (const failureIndex of [1, 2, 3, 4]) {
    for (const failure of [{ code: '42501', message: 'forbidden' }, { status: 0, message: 'offline' }]) {
      let index = 0
      const { api } = fixture({ respond: () => ++index === failureIndex ? { data: null, error: failure } : empty() })
      await assert.rejects(api.loadGroupJoinReminderState(user, new AbortController().signal), error => error === failure)
    }
    let index = 0
    const failure = new Error('transport threw')
    const { api } = fixture({ respond: () => { if (++index === failureIndex) throw failure; return empty() } })
    await assert.rejects(api.loadGroupJoinReminderState(user, new AbortController().signal), error => error === failure)
  }
})

test('malformed receipts, memberships, represented groups and invitations reject', async () => {
  for (const [table, status, data] of [
    ['account_announcement_receipts', null, { announcement_id: 'other-campaign' }],
    ['account_announcement_receipts', null, {}], ['study_groups', null, { id: null }],
    ['study_group_members', 'accepted', { group_id: 123 }], ['study_group_members', 'pending', { group_id: null }],
  ]) {
    const { api } = fixture({ respond: call => call.table === table && (!status || call.filters.some(([name, value]) => name === 'status' && value === status))
      ? { data, error: null } : empty() })
    await assert.rejects(api.loadGroupJoinReminderState(user, new AbortController().signal), /RESPONSE_INVALID/)
  }
})

test('aborted initial and pending-invitation reads never become eligible', async () => {
  const controller = new AbortController(); controller.abort()
  const first = fixture()
  await assert.rejects(first.api.loadGroupJoinReminderState(user, controller.signal), /ABORTED/)
  assert.equal(first.calls.length, 3)
  const later = new AbortController()
  const next = fixture({ respond: call => { if (call.filters.some(([name, value]) => name === 'status' && value === 'pending')) later.abort(); return empty() } })
  await assert.rejects(next.api.loadGroupJoinReminderState(user, later.signal), /ABORTED/)
  assert.equal(next.calls.length, 4)
})

test('local receipts use campaign and account identity and survive blocked browser storage in memory', () => {
  const { api, storage } = fixture()
  assert.equal(api.hasSeenGroupJoinReminder(user), false)
  api.rememberGroupJoinReminder(user)
  assert.equal(api.hasSeenGroupJoinReminder(user), true)
  assert.equal(api.hasSeenGroupJoinReminder(other), false)
  assert.equal(storage.get(`xelay:announcement:${campaign}:${user}`), 'seen')
  assert.equal(fixture({ storage }).api.hasSeenGroupJoinReminder(user), true)
  const blocked = fixture({ brokenStorage: true }).api
  assert.equal(blocked.hasSeenGroupJoinReminder(user), false)
  blocked.rememberGroupJoinReminder(user)
  assert.equal(blocked.hasSeenGroupJoinReminder(user), true)
  assert.equal(blocked.hasSeenGroupJoinReminder(other), false)
})

test('receipt persistence deduplicates concurrent and completed writes, preserving account scope', async () => {
  const pending = deferred()
  const { api, writes } = fixture({ write: () => pending.promise })
  const first = api.persistGroupJoinReminder(user), second = api.persistGroupJoinReminder(user)
  await Promise.resolve()
  assert.equal(writes.length, 1)
  pending.resolve(empty())
  await Promise.all([first, second])
  await api.persistGroupJoinReminder(user)
  assert.equal(writes.length, 1)
  await api.persistGroupJoinReminder(other)
  assert.deepEqual(writes, [user, other].map(userId => ({ table: 'account_announcement_receipts', value: { user_id: userId, announcement_id: campaign }, options: { onConflict: 'user_id,announcement_id', ignoreDuplicates: true } })))
})

test('failed receipt persistence remains retryable and never consumes another account', async () => {
  for (const throws of [false, true]) {
    const failure = new Error('offline')
    let count = 0
    const { api, writes } = fixture({ write: () => { if (++count === 1) { if (throws) throw failure; return { error: failure } } return empty() } })
    api.rememberGroupJoinReminder(user)
    await assert.rejects(api.persistGroupJoinReminder(user), error => error === failure)
    assert.equal(api.hasSeenGroupJoinReminder(user), true)
    await api.persistGroupJoinReminder(user)
    await api.persistGroupJoinReminder(user)
    assert.equal(writes.length, 2)
    assert.equal(api.hasSeenGroupJoinReminder(other), false)
  }
})

test('existing server receipt suppresses invitation read and redundant receipt writes', async () => {
  const { api, calls, writes } = fixture({ respond: call => call.table === 'account_announcement_receipts'
    ? { data: { announcement_id: campaign }, error: null } : empty() })
  assert.deepEqual(plain(await api.loadGroupJoinReminderState(user, new AbortController().signal)), { seen: true, inGroup: false, pendingInvites: false })
  assert.equal(calls.length, 3)
  await api.persistGroupJoinReminder(user)
  assert.equal(writes.length, 0)
  await api.persistGroupJoinReminder(other)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].value.user_id, other)
})

test('student audience excludes teacher accounts, verified teachers and platform admins', () => {
  const { api } = fixture()
  const student = { id: user, accountType: 'student', isTeacher: false, isPlatformAdmin: false }
  assert.equal(api.isGroupJoinReminderAudience(student), true)
  assert.equal(api.isGroupJoinReminderAudience({ ...student, accountType: undefined }), true)
  for (const exclusion of [{ accountType: 'teacher' }, { isTeacher: true }, { isPlatformAdmin: true }]) {
    assert.equal(api.isGroupJoinReminderAudience({ ...student, ...exclusion }), false)
  }
})
