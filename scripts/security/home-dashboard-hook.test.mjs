import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const react = uri(`export const useState=(...args)=>globalThis.__homeHookHarness.useState(...args);export const useRef=(...args)=>globalThis.__homeHookHarness.useRef(...args);export const useEffect=(...args)=>globalThis.__homeHookHarness.useEffect(...args);export const useCallback=(...args)=>globalThis.__homeHookHarness.useCallback(...args);`)
const supabase = uri('export const supabase={channel:(...args)=>globalThis.__homeHookEnvironment.channel(...args),removeChannel:(...args)=>globalThis.__homeHookEnvironment.removeChannel(...args)};')
const live = uri(`export function emptyLiveHome(profile,status='loading'){return {role:'student',displayName:profile.name,initials:'T',clockIso:new Date().toISOString(),contexts:['learning'],teachingVerified:false,status,participantCount:0,groups:[],lessons:[],tasks:[],updates:[],publications:[],community:[],news:[]}}export const loadLiveHome=(...args)=>globalThis.__homeHookEnvironment.load(...args);`)
const refresh = uri(compile(await read('src/lib/homeFeedRefresh.ts')))
const model = uri(compile(await read('src/lib/homeDashboardModel.ts')))
const source = compile(await read('src/hooks/useHomeDashboard.ts'))
  .replace(/['"]react['"]/g, JSON.stringify(react))
  .replace(/['"]\.\.\/lib\/supabase['"]/g, JSON.stringify(supabase))
  .replace(/['"]\.\.\/lib\/homeFeedRefresh['"]/g, JSON.stringify(refresh))
  .replace(/['"]\.\.\/lib\/homeDashboardLive['"]/g, JSON.stringify(live))
  .replace(/['"]\.\.\/lib\/homeDashboardModel['"]/g, JSON.stringify(model))
const { useHomeDashboard, homeDashboardProfileScope } = await import(uri(source))
const profile = { id: 'actor-a', userId: 'actor-a', name: 'Actor A', studyGroupIds: ['group-a'], isTeacher: false }

function environment(t, clock = '2026-10-28T08:15:00Z') {
  const previous = { Date: globalThis.Date, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, window: globalThis.window, document: globalThis.document }
  let now = Date.parse(clock), timerId = 0
  const timers = new Map(), requests = [], channels = [], removed = []
  const RealDate = Date
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  globalThis.window = new EventTarget()
  globalThis.document = new EventTarget()
  document.visibilityState = 'visible'
  const env = {
    requests, channels, removed, timers,
    load(actorProfile, actorId, signal) { return new Promise((resolve, reject) => requests.push({ profile: actorProfile, actorId, signal, resolve, reject })) },
    channel(name) {
      const channel = { name, handlers: [], on(kind, config, callback) { channel.handlers.push({ kind, config, callback }); return channel }, subscribe(callback) { channel.status = callback; return channel } }
      channels.push(channel)
      return channel
    },
    async removeChannel(channel) { removed.push(channel) },
    advance(milliseconds) {
      const until = now + milliseconds
      let guard = 0
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        assert.ok(++guard < 500, 'timer loop must remain bounded')
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      now = until
    },
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')) },
  }
  globalThis.__homeHookEnvironment = env
  t.after(() => { Object.assign(globalThis, previous); delete globalThis.__homeHookHarness; delete globalThis.__homeHookEnvironment })
  return env
}

function harness(initialProfile = profile, initialUser = initialProfile.id) {
  const slots = [], effects = []
  let cursor = 0, dirty = false, currentProfile = initialProfile, userId = initialUser, output
  const changed = (before, after) => !before || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]))
  const hooks = {
    useState(initial) {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], next => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; dirty = true }]
    },
    useRef(initial) { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot] },
    useCallback(fn, deps) { const slot = cursor++; if (!slots[slot] || changed(slots[slot].deps, deps)) slots[slot] = { fn, deps }; return slots[slot].fn },
    useEffect(fn, deps) {
      const slot = cursor++
      if (!slots[slot] || changed(slots[slot].deps, deps)) effects.push(() => { slots[slot]?.cleanup?.(); slots[slot] = { deps, cleanup: fn() } })
    },
  }
  const render = () => {
    let guard = 0
    do {
      assert.ok(++guard < 30, 'render loop must settle')
      dirty = false; cursor = 0; globalThis.__homeHookHarness = hooks
      output = useHomeDashboard(currentProfile, userId)
      while (effects.length) effects.shift()()
    } while (dirty)
    return output
  }
  return {
    render,
    get output() { return output },
    change(nextProfile, nextUser = nextProfile.id) { currentProfile = nextProfile; userId = nextUser; return render() },
    async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); return render() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}
const successful = (request, label = 'private-a') => request.resolve({ role: 'student', displayName: request.profile.name, initials: 'T', clockIso: new Date().toISOString(), contexts: ['learning'], teachingVerified: false, status: 'ready', participantCount: 0, groups: [{ id: label }], lessons: [], tasks: [], updates: [], publications: [], community: [], news: [] })

test('identity scopes ignore reordered arrays and irrelevant profile object changes but include actual rights', () => {
  const a = { ...profile, studyGroupIds: ['a', 'b'], editorUnitIds: ['u1', 'u2'] }
  const key = homeDashboardProfileScope(a, a.id)
  assert.equal(homeDashboardProfileScope({ ...a, studyGroupIds: ['b', 'a', 'a'], editorUnitIds: ['u2', 'u1'], bio: 'Changed', avatarUrl: '/other.png' }, a.id), key)
  for (const patch of [{ isTeacher: true }, { isPlatformAdmin: true }, { teacherVerificationStatus: 'revoked' }, { studyGroupIds: ['a'] }, { academicUnitId: 'new-scope' }, { editorUnitIds: [] }]) assert.notEqual(homeDashboardProfileScope({ ...a, ...patch }, a.id), key)
  assert.notEqual(homeDashboardProfileScope(a, 'different-account'), key)
})

test('refresh clicks coalesce, role changes hide protected data and late account results cannot publish', async t => {
  const env = environment(t), h = harness()
  h.render()
  assert.equal(env.requests.length, 1)
  const first = env.requests[0]
  const clicks = [h.output.refresh(), h.output.refresh(), h.output.refresh()]
  assert.equal(env.requests.length, 1)
  h.change({ ...profile, id: 'actor-b', userId: 'actor-b', name: 'Actor B' })
  assert.equal(first.signal.aborted, true)
  assert.deepEqual(h.output.data.groups, [])
  successful(first, 'must-not-leak')
  await h.flush()
  assert.deepEqual(h.output.data.groups, [])
  successful(env.requests[1], 'private-b')
  await h.flush()
  assert.deepEqual(h.output.data.groups, [{ id: 'private-b' }])
  await Promise.all(clicks)
  h.unmount()
  assert.equal(env.removed.length, 2)
  assert.equal(env.timers.size, 0)
})

test('membership revocation clears private state before refresh and cancels any old flight', async t => {
  const env = environment(t), h = harness()
  h.render(); successful(env.requests[0]); await h.flush()
  assert.equal(h.output.data.status, 'ready')
  const oldChannel = env.channels[0]
  assert.ok(oldChannel.handlers.every(row => row.config.filter === 'user_id=eq.actor-a'))
  const refresh = h.output.refresh()
  const oldRead = env.requests[1]
  oldChannel.handlers.find(row => row.config.table === 'study_group_members').callback({ new: { user_id: profile.id, status: 'removed' } })
  h.render()
  assert.deepEqual(h.output.data.groups, [])
  assert.equal(oldRead.signal.aborted, true)
  successful(oldRead, 'revoked-data')
  await h.flush()
  assert.deepEqual(h.output.data.groups, [])
  env.requests[2].reject(new Error('forbidden'))
  await h.flush()
  assert.equal(h.output.data.status, 'error')
  assert.deepEqual(h.output.data.groups, [])
  await refresh
  h.unmount()
})

test('minute progress updates are local, hidden fallback is silent and notification refresh is actor-scoped', async t => {
  const env = environment(t), h = harness()
  h.render(); successful(env.requests[0]); await h.flush()
  const before = h.output.data.clockIso
  env.advance(60_100); await h.flush()
  assert.equal(env.requests.length, 1)
  assert.notEqual(h.output.data.clockIso, before)
  const event = new Event('xelay-notifications-updated'); event.detail = { userId: 'somebody-else' }; window.dispatchEvent(event)
  env.advance(1_000); await h.flush()
  assert.equal(env.requests.length, 1)
  env.visible(false); env.advance(180_000); await h.flush()
  assert.equal(env.requests.length, 1)
  env.visible(true); await h.flush()
  assert.equal(env.requests.length, 2)
  successful(env.requests[1]); await h.flush()
  const own = new Event('xelay-notifications-updated'); own.detail = { userId: profile.id }; window.dispatchEvent(own)
  env.advance(5_100); await h.flush()
  assert.equal(env.requests.length, 3)
  h.unmount()
  assert.equal(env.requests[2].signal.aborted, true)
})

test('crossing Kyiv midnight invalidates once instead of fetching on every clock tick', async t => {
  const env = environment(t, '2026-10-28T21:59:40Z'), h = harness()
  h.render(); successful(env.requests[0]); await h.flush()
  env.advance(21_000); await h.flush()
  assert.equal(env.requests.length, 2)
  assert.equal(h.output.data.clockIso.slice(0, 10), '2026-10-28') // UTC is still the preceding date.
  successful(env.requests[1]); await h.flush()
  env.advance(60_000); await h.flush()
  assert.equal(env.requests.length, 2)
  h.unmount()
})
