// Real client and validators, controlled auth/HTTP/timers; no credentials or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const clientSource = await readFile(new URL('../../src/lib/homeworkAiDraftClient.ts', import.meta.url), 'utf8')
const coreSource = await readFile(new URL('../../src/lib/homeworkAiDraft.ts', import.meta.url), 'utf8')
const compileCode = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const clientCode = compileCode(clientSource), coreCode = compileCode(coreSource)
const nativeGlobals = { Error, TypeError, DOMException, AbortController, AbortSignal, URL, TextDecoder, TextEncoder, Uint8Array }
function compiled(code, dependencies = {}, extras = {}) {
  const module = { exports: {} }
  vm.runInNewContext(code, { ...nativeGlobals, module, exports: module.exports, require(name) {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error(`Unexpected dependency: ${name}`)
  }, ...extras })
  return module.exports
}
const core = compiled(coreCode)
const GROUP = '10000000-0000-4000-9000-000000000001'
const USER = '10000000-0000-4000-9000-000000000002'
const OTHER = '10000000-0000-4000-9000-000000000003'
const source = 'Вища математика. На вівторок. Тема: Похідні. Розв’язати задачі 1–5. https://example.org/material'
const input = { source_text: source, reference_date: '2026-10-25' }
const draft = { version: 1, complete: true, general_instructions: '', items: [{
  subject: 'Вища математика', lesson_type: 'practical', date_text: 'На вівторок', lesson_topic: 'Похідні',
  source_fragment: source, links: [{ url: 'https://example.org/material', title: '' }],
}], warnings: [] }
const session = (id = USER, accessToken = 'current-test-jwt') => ({ error: null, data: { session: { user: { id }, access_token: accessToken } } })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const plain = value => JSON.parse(JSON.stringify(value))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const drain = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

function fixture({ sessions, respond } = {}) {
  const calls = [], listeners = new Set(), timers = new Map(), durations = []
  const fetched = deferred(), latestSession = deferred()
  let nextTimer = 0, authReads = 0, unsubscribed = 0
  const auth = {
    onAuthStateChange(callback) {
      listeners.add(callback)
      return { data: { subscription: { unsubscribe() { unsubscribed++; listeners.delete(callback) } } } }
    },
    async getSession() {
      const index = authReads++
      if (index === 1) latestSession.resolve()
      return sessions ? sessions(index) : session()
    },
  }
  const api = compiled(clientCode, { './supabase': { supabase: { auth } }, './homeworkAiDraft': core }, {
    setTimeout(callback, duration) { const id = ++nextTimer; timers.set(id, callback); durations.push(duration); return id },
    clearTimeout(id) { timers.delete(id) },
    async fetch(url, init) {
      calls.push({ url, init }); fetched.resolve()
      return respond ? respond(url, init) : json({ draft })
    },
  })
  return { api, calls, timers, durations, fetched: fetched.promise, latestSession: latestSession.promise,
    emit(event, value) { for (const listener of [...listeners]) listener(event, value) },
    expire() { assert.equal(timers.size, 1); [...timers.values()][0]() },
    get authReads() { return authReads }, get unsubscribed() { return unsubscribed }, get listeners() { return listeners.size },
  }
}
function cleaned(fx) {
  assert.equal(fx.timers.size, 0, 'timeout cleared')
  assert.equal(fx.listeners, 0, 'auth listener removed')
  assert.equal(fx.unsubscribed, 1, 'exactly one auth subscription cleaned')
}

test('GET availability uses the current JWT and only the selected group', async () => {
  const fx = fixture({ respond: () => json({ available: true }) })
  assert.deepEqual(plain(await fx.api.homeworkAiDraftAvailability(GROUP, USER)), { available: true })
  assert.equal(fx.calls.length, 1)
  assert.equal(fx.calls[0].url, `/api/groups/homework-draft?group_id=${GROUP}`)
  assert.deepEqual(plain(fx.calls[0].init.headers), { Authorization: 'Bearer current-test-jwt' })
  assert.equal(fx.calls[0].init.body, undefined)
  assert.equal(fx.calls[0].init.cache, 'no-store')
  assert.deepEqual(fx.durations, [20000])
  assert.equal(fx.authReads, 2)
  cleaned(fx)
})

test('POST sends a minimal normalized body, never the user, roster or timetable', async () => {
  const fx = fixture()
  const result = await fx.api.requestHomeworkAiDraft(GROUP, USER, { ...input, source_text: `  ${source}  ` })
  assert.deepEqual(plain(result), draft)
  const { url, init } = fx.calls[0]
  assert.equal(url, '/api/groups/homework-draft')
  assert.equal(init.method, 'POST')
  assert.deepEqual(plain(init.headers), { Authorization: 'Bearer current-test-jwt', 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(init.body), { group_id: GROUP, ...input })
  assert.deepEqual(fx.durations, [118000])
  assert.equal(fx.calls.length, 1)
  cleaned(fx)
})

test('invalid identifiers or input never call HTTP or read a session', async () => {
  for (const [groupId, actorId, body] of [['bad', USER, input], [GROUP, 'bad', input], [GROUP, USER, { ...input, source_text: '' }], [GROUP, USER, { ...input, reference_date: '2026-02-30' }]]) {
    const fx = fixture()
    await assert.rejects(fx.api.requestHomeworkAiDraft(groupId, actorId, body))
    assert.equal(fx.calls.length, 0)
    assert.equal(fx.authReads, 0)
    assert.equal(fx.listeners, 0)
    assert.equal(fx.timers.size, 0)
  }
})

test('a different or absent current account never sends the message', async () => {
  for (const value of [session(OTHER), { error: null, data: { session: null } }, { error: new Error('auth unavailable'), data: { session: null } }]) {
    const fx = fixture({ sessions: () => value })
    await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input), /Увійдіть знову/)
    assert.equal(fx.calls.length, 0)
    cleaned(fx)
  }
})

test('a pre-aborted request makes no HTTP/session call and cleans its subscription', async () => {
  const fx = fixture(), controller = new AbortController()
  controller.abort(new Error('cancelled before start'))
  await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input, controller.signal), /cancelled before start/)
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.authReads, 0)
  cleaned(fx)
})

test('a sign-out before the provider result rejects immediately and ignores its late reply', async () => {
  const response = deferred(), fx = fixture({ respond: () => response.promise })
  const pending = fx.api.requestHomeworkAiDraft(GROUP, USER, input)
  const rejected = assert.rejects(pending, /Акаунт змінився/)
  await fx.fetched
  fx.emit('SIGNED_OUT', null)
  await rejected
  response.resolve(json({ draft }))
  await drain()
  assert.equal(fx.authReads, 1)
  cleaned(fx)
})

test('an account-change event during the final session check discards the completed provider result', async () => {
  const latest = deferred(), fx = fixture({ sessions: index => index === 0 ? session() : latest.promise })
  const pending = fx.api.requestHomeworkAiDraft(GROUP, USER, input)
  const rejected = assert.rejects(pending, /Акаунт змінився/)
  await fx.latestSession
  fx.emit('SIGNED_IN', { user: { id: OTHER }, access_token: 'other-token' })
  await rejected
  latest.resolve(session())
  await drain()
  assert.equal(fx.calls.length, 1)
  cleaned(fx)
})

test('the final session check also rejects a changed account without an auth event', async () => {
  const fx = fixture({ sessions: index => index === 0 ? session() : session(OTHER) })
  await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input), /Акаунт змінився/)
  assert.equal(fx.calls.length, 1)
  cleaned(fx)
})

test('refreshing the same account does not invalidate a legitimate request', async () => {
  const response = deferred(), fx = fixture({ respond: () => response.promise })
  const pending = fx.api.requestHomeworkAiDraft(GROUP, USER, input)
  await fx.fetched
  fx.emit('TOKEN_REFRESHED', { user: { id: USER }, access_token: 'refreshed-token' })
  response.resolve(json({ draft }))
  assert.deepEqual(plain(await pending), draft)
  cleaned(fx)
})

test('timeout covers a stalled initial auth lookup as well as a stalled provider', async () => {
  for (const phase of ['auth', 'provider']) {
    const stalled = deferred(), fx = fixture(phase === 'auth' ? { sessions: () => stalled.promise } : { respond: () => stalled.promise })
    const pending = fx.api.requestHomeworkAiDraft(GROUP, USER, input)
    const rejected = assert.rejects(pending, /триває задовго/)
    if (phase === 'provider') await fx.fetched
    fx.expire()
    await rejected
    if (phase === 'auth') { assert.equal(fx.calls.length, 0); stalled.resolve(session()) }
    else { assert.equal(fx.calls[0].init.signal.aborted, true); stalled.resolve(json({ draft })) }
    await drain()
    cleaned(fx)
  }
})

test('caller cancellation aborts HTTP and removes the forwarded abort listener', async () => {
  const response = deferred(), fx = fixture({ respond: () => response.promise }), controller = new AbortController()
  let added = 0, removed = 0
  const observed = {
    get aborted() { return controller.signal.aborted }, get reason() { return controller.signal.reason },
    addEventListener(...args) { added++; controller.signal.addEventListener(...args) },
    removeEventListener(...args) { removed++; controller.signal.removeEventListener(...args) },
  }
  const pending = fx.api.requestHomeworkAiDraft(GROUP, USER, input, observed)
  const rejected = assert.rejects(pending, /explicit cancellation/)
  await fx.fetched
  controller.abort(new Error('explicit cancellation'))
  await rejected
  assert.equal(fx.calls[0].init.signal.aborted, true)
  assert.equal(added, 1)
  assert.equal(removed, 1)
  response.resolve(json({ draft }))
  await drain()
  cleaned(fx)
})

test('body limits count UTF-8 bytes and cancel an oversized streamed response', async () => {
  let cancelled = false
  const oversized = new TextEncoder().encode('ї'.repeat(80000))
  assert.ok(oversized.length > 150000)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(oversized) }, cancel() { cancelled = true } })
  const fx = fixture({ respond: () => new Response(stream, { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input), /Чернетка завелика/)
  assert.equal(cancelled, true)
  cleaned(fx)
})

test('an oversized declared response is rejected and cancelled before JSON is read', async () => {
  let cancelled = false
  const stream = new ReadableStream({ cancel() { cancelled = true } })
  const fx = fixture({ respond: () => new Response(stream, { headers: { 'content-length': '150001', 'content-type': 'application/json' } }) })
  await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input), /Чернетка завелика/)
  assert.equal(cancelled, true)
  cleaned(fx)
})

test('malformed JSON or a malformed/invented draft never reaches the caller as a usable result', async () => {
  const responses = [
    () => new Response('PRIVATE PROVIDER TEXT', { headers: { 'content-type': 'application/json' } }),
    () => json({ draft: { secret: 'PRIVATE PROVIDER TEXT' } }),
    () => json({ draft: { ...draft, items: [{ ...draft.items[0], lesson_topic: 'INVENTED PRIVATE PROVIDER TEXT' }] } }),
  ]
  for (const respond of responses) {
    const fx = fixture({ respond })
    await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input), error => {
      assert.doesNotMatch(error.message, /PRIVATE PROVIDER TEXT/)
      return true
    })
    cleaned(fx)
  }
})

test('HTTP statuses map to bounded public messages without exposing provider/server details', async () => {
  for (const status of [400, 401, 403, 413, 422, 429, 500, 503, 504]) {
    const fx = fixture({ respond: () => json({ error: 'SECRET TOKEN AND PROVIDER STACK', details: '<script>private()</script>' }, status) })
    await assert.rejects(fx.api.requestHomeworkAiDraft(GROUP, USER, input), error => {
      assert.equal(error.name, 'HomeworkAiRequestError')
      assert.equal(error.status, status)
      assert.ok(error.message.length < 300)
      assert.doesNotMatch(error.message, /SECRET|TOKEN|STACK|script|private/)
      return true
    })
    cleaned(fx)
  }
})

test('availability fails closed on malformed replies while preserving explicit denial', async () => {
  for (const respond of [() => json({ error: 'PRIVATE' }, 503), () => json({ available: 'yes', reason: 'PRIVATE' }), () => new Response('not JSON')]) {
    const fx = fixture({ respond })
    const result = await fx.api.homeworkAiDraftAvailability(GROUP, USER)
    assert.equal(result.available, false)
    assert.doesNotMatch(result.reason, /PRIVATE/)
    cleaned(fx)
  }
  for (const status of [401, 403]) {
    const fx = fixture({ respond: () => json({ error: 'PRIVATE' }, status) })
    await assert.rejects(fx.api.homeworkAiDraftAvailability(GROUP, USER), error => error.status === status && !error.message.includes('PRIVATE'))
    cleaned(fx)
  }
})
