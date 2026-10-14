// Execute the production refresh scheduler with fake time and deferred requests; no accounts or network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/notificationUnreadRefresh.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
const { createNotificationUnreadRefresher, notificationChangeAffectsRecipient } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)

function fakeEnvironment() {
  let now = 0
  let visible = true
  let nextId = 0
  const timers = new Map()
  return {
    setVisible(value) { visible = value },
    timerCount: () => timers.size,
    environment: {
      now: () => now,
      isVisible: () => visible,
      setTimeout(callback, delay) {
        const id = ++nextId
        timers.set(id, { callback, due: now + delay })
        return id
      },
      clearTimeout(id) { timers.delete(id) },
    },
    advance(milliseconds) {
      const target = now + milliseconds
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0]
        if (!next) break
        now = next[1].due
        timers.delete(next[0])
        next[1].callback()
      }
      now = target
    },
  }
}

function fixture(environment = fakeEnvironment()) {
  const requests = []
  const counts = []
  const refresher = createNotificationUnreadRefresher({
    environment: environment.environment,
    fetchCount: (signal) => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    onCount: (count) => counts.push(count),
  })
  return { ...environment, refresher, requests, counts }
}

async function settled() { for (let index = 0; index < 4; index += 1) await Promise.resolve() }

test('initial count is authoritative and disconnected fallback is once per 30 seconds', async () => {
  const f = fixture()
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve(4)
  await settled()
  assert.deepEqual(f.counts, [4])
  f.advance(29_999)
  assert.equal(f.requests.length, 1)
  f.advance(1)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(0)
  await settled()
  assert.deepEqual(f.counts, [4, 0])
  f.refresher.dispose()
  assert.equal(f.timerCount(), 0)
})

test('subscribed Realtime reconciles once and then uses 60-second fallback; disconnect restores 30 seconds', async () => {
  const f = fixture()
  f.requests[0].resolve(2)
  await settled()
  f.refresher.realtimeStatus(true)
  f.advance(2_000)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(2)
  await settled()
  f.advance(59_999)
  assert.equal(f.requests.length, 2)
  f.advance(1)
  assert.equal(f.requests.length, 3)
  f.requests[2].resolve(3)
  await settled()
  f.refresher.realtimeStatus(false)
  f.advance(29_999)
  assert.equal(f.requests.length, 3)
  f.advance(1)
  assert.equal(f.requests.length, 4)
  f.refresher.dispose()
})

test('a burst of inserts, updates, deletes and local mark-read events makes one reconciled request', async () => {
  const f = fixture()
  f.requests[0].resolve(2)
  await settled()
  for (let index = 0; index < 20; index += 1) f.refresher.invalidate()
  f.advance(1_999)
  assert.equal(f.requests.length, 1)
  f.advance(1)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(0)
  await settled()
  assert.deepEqual(f.counts, [2, 0])
  f.refresher.dispose()
})

test('an event during a slow request suppresses its stale count and queues only one fresh request', async () => {
  const f = fixture()
  f.refresher.invalidate()
  f.refresher.invalidate()
  f.refresher.refresh()
  f.advance(2_000)
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve(8)
  await settled()
  assert.deepEqual(f.counts, [])
  f.advance(250)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(1)
  await settled()
  assert.deepEqual(f.counts, [1])
  f.refresher.dispose()
})

test('focus refreshes coalesce while one request is in flight and never overlap', async () => {
  const f = fixture()
  for (let index = 0; index < 20; index += 1) f.refresher.refresh()
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve(1)
  await settled()
  f.advance(2_000)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(2)
  await settled()
  f.advance(1_000)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.counts, [1, 2])
  f.refresher.dispose()
})

test('hidden tabs fetch no counts; visibility refresh aborts the old snapshot and updates on return', async () => {
  const f = fixture()
  f.setVisible(false)
  f.refresher.visibilityChanged()
  assert.equal(f.requests[0].signal.aborted, true)
  f.refresher.invalidate()
  f.refresher.refresh()
  f.advance(180_000)
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve(7)
  await settled()
  assert.deepEqual(f.counts, [])
  f.setVisible(true)
  f.refresher.visibilityChanged()
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(1)
  await settled()
  assert.deepEqual(f.counts, [1])
  f.refresher.dispose()
})

test('starting in a hidden tab defers initial hydration until visible', async () => {
  const environment = fakeEnvironment()
  environment.setVisible(false)
  const f = fixture(environment)
  f.advance(90_000)
  assert.equal(f.requests.length, 0)
  f.setVisible(true)
  f.refresher.visibilityChanged()
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve(0)
  await settled()
  assert.deepEqual(f.counts, [0])
  f.refresher.dispose()
})

test('cleanup on account change aborts the old request and late callbacks cannot overwrite the new account', async () => {
  const old = fixture()
  old.refresher.invalidate()
  old.refresher.dispose()
  const current = fixture()
  old.requests[0].resolve(99)
  current.requests[0].resolve(2)
  await settled()
  old.refresher.refresh()
  old.refresher.invalidate()
  old.refresher.realtimeStatus(true)
  old.advance(180_000)
  assert.deepEqual(old.counts, [])
  assert.equal(old.requests.length, 1)
  assert.equal(old.requests[0].signal.aborted, true)
  assert.equal(old.timerCount(), 0)
  assert.deepEqual(current.counts, [2])
  current.refresher.dispose()
})

test('temporary failures preserve the last badge and retry without a tight loop', async () => {
  const f = fixture()
  f.requests[0].resolve(2)
  await settled()
  f.refresher.invalidate()
  f.advance(2_000)
  f.requests[1].reject(new Error('offline'))
  await settled()
  assert.deepEqual(f.counts, [2])
  f.advance(29_999)
  assert.equal(f.requests.length, 2)
  f.advance(1)
  assert.equal(f.requests.length, 3)
  f.requests[2].resolve(5)
  await settled()
  assert.deepEqual(f.counts, [2, 5])
  f.refresher.dispose()
})

test('sustained events and repeated refreshes are bounded while still making progress', async () => {
  const f = fixture()
  f.requests[0].resolve(1)
  await settled()
  let completed = 1
  for (let index = 0; index < 200; index += 1) {
    f.refresher.invalidate()
    f.refresher.refresh()
    f.advance(100)
    const started = f.requests.length
    assert.ok(started - completed <= 1, 'requests never overlap')
    for (; completed < started; completed += 1) f.requests[completed].resolve(completed + 1)
    await settled()
  }
  assert.ok(f.requests.length >= 5, 'continuous events cannot defer every refresh indefinitely')
  assert.ok(f.requests.length <= 11, 'no more than one request starts per two seconds')
  f.refresher.dispose()
})

test('a hanging count expires even when fetch ignores AbortSignal, and its late result cannot overwrite a retry', async () => {
  const f = fixture()
  f.requests[0].resolve(2)
  await settled()
  f.refresher.invalidate()
  f.advance(2_000)
  assert.equal(f.requests.length, 2)
  f.advance(9_999)
  assert.equal(f.requests[1].signal.aborted, false)
  f.advance(1)
  await settled()
  assert.equal(f.requests[1].signal.aborted, true)
  assert.deepEqual(f.counts, [2])
  f.refresher.refresh()
  assert.equal(f.requests.length, 3)
  f.requests[2].resolve(0)
  await settled()
  f.requests[1].resolve(99)
  await settled()
  assert.deepEqual(f.counts, [2, 0])
  f.refresher.dispose()
  assert.equal(f.timerCount(), 0)
})

test('a mutation queued behind a timeout gets one bounded retry instead of staying blocked', async () => {
  const f = fixture()
  f.refresher.invalidate()
  f.advance(10_000)
  await settled()
  assert.equal(f.requests[0].signal.aborted, true)
  f.advance(250)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(3)
  await settled()
  assert.deepEqual(f.counts, [3])
  f.requests[0].resolve(88)
  await settled()
  assert.deepEqual(f.counts, [3])
  f.refresher.dispose()
})

test('recipient filter accepts own mutations and reduced delete payloads, never a known other recipient', () => {
  for (const payload of [
    { new: { recipient_id: 'one', is_read: false } },
    { new: { recipient_id: 'one', is_read: true }, old: { recipient_id: 'one' } },
    { old: { recipient_id: 'one' } },
    { old: { id: 'deleted-row' }, new: {} },
  ]) assert.equal(notificationChangeAffectsRecipient(payload, 'one'), true)
  assert.equal(notificationChangeAffectsRecipient({ new: { recipient_id: 'two' } }, 'one'), false)
  assert.equal(notificationChangeAffectsRecipient({ old: { recipient_id: 'two' }, new: {} }, 'one'), false)
})
