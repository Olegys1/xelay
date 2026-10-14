import test from 'node:test'
import assert from 'node:assert/strict'
import { createHomeFeedRefresh } from '../../src/lib/homeFeedRefresh.ts'
import { loadHomeFeed, loadHomeFeedStats } from '../../src/lib/homeFeedData.ts'
import { createHomeImagePreviews } from '../../src/lib/homeFeedImages.ts'

function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key },
    clearTimeout: (key) => timers.delete(key),
    advance: (duration) => {
      const until = now + duration
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = next[1].at
        timers.delete(next[0])
        next[1].fn()
      }
      now = until
    },
    size: () => timers.size,
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function makeRefresh(overrides = {}) {
  const clock = fakeClock()
  const data = [], errors = []
  let calls = 0
  const refresh = createHomeFeedRefresh({
    initialVisible: true,
    fallbackMs: 60_000,
    minBackgroundIntervalMs: 0,
    clock,
    load: async () => ++calls,
    onData: (value) => data.push(value),
    onError: (error) => errors.push(error),
    ...overrides,
  })
  return { refresh, clock, data, errors, calls: () => calls }
}

test('feed has no 5-second polling and uses one visible fallback per minute', async () => {
  const { refresh, clock, calls } = makeRefresh()
  await refresh.request()
  for (let i = 0; i < 11; i++) { clock.advance(5_000); await flush() }
  assert.equal(calls(), 1)
  clock.advance(5_000)
  await flush()
  assert.equal(calls(), 2)
  refresh.dispose()
})

test('hidden tabs make no background requests; visibility/focus coalesce on return', async () => {
  const { refresh, clock, calls } = makeRefresh()
  await refresh.request()
  refresh.setVisible(false)
  for (let i = 0; i < 12; i++) { refresh.invalidate(); clock.advance(5 * 60_000); await flush() }
  assert.equal(calls(), 1)
  assert.equal(clock.size(), 0)
  refresh.setVisible(true)
  refresh.reconcile()
  refresh.reconcile()
  await flush()
  assert.equal(calls(), 2)
  refresh.dispose()
})

test('initially hidden page waits for visibility and then loads once', async () => {
  const { refresh, clock, calls } = makeRefresh({ initialVisible: false })
  await refresh.request()
  clock.advance(600_000)
  assert.equal(calls(), 0)
  refresh.setVisible(true)
  refresh.reconcile()
  await flush()
  assert.equal(calls(), 1)
  refresh.dispose()
})

test('duplicate manual refresh calls share the in-flight promise without a second query', async () => {
  const pending = deferred()
  let calls = 0
  const { refresh } = makeRefresh({ load: () => { calls++; return pending.promise } })
  const first = refresh.request()
  assert.equal(refresh.request(), first)
  assert.equal(refresh.request(), first)
  assert.equal(calls, 1)
  pending.resolve('ready')
  await first
  assert.equal(calls, 1)
  refresh.dispose()
})

test('a burst of Realtime events is debounced into one refresh', async () => {
  const { refresh, clock, calls } = makeRefresh()
  await refresh.request()
  for (let i = 0; i < 20; i++) { refresh.invalidate(); clock.advance(10) }
  clock.advance(199)
  await flush()
  assert.equal(calls(), 1)
  clock.advance(1)
  await flush()
  assert.equal(calls(), 2)
  refresh.dispose()
})

test('in-flight invalidations queue one new snapshot and never overlap requests', async () => {
  const waits = [deferred(), deferred()]
  let calls = 0, active = 0, maxActive = 0
  const { refresh, data } = makeRefresh({
    load: async () => {
      const index = calls++
      active++
      maxActive = Math.max(maxActive, active)
      const result = await waits[index].promise
      active--
      return result
    },
  })
  const drained = refresh.request()
  for (let i = 0; i < 12; i++) refresh.invalidate()
  assert.equal(calls, 1)
  waits[0].resolve('old snapshot')
  await flush()
  assert.equal(calls, 2)
  assert.deepEqual(data, ['old snapshot'])
  waits[1].resolve('new snapshot')
  await drained
  assert.deepEqual(data, ['old snapshot', 'new snapshot'])
  assert.equal(maxActive, 1)
  refresh.dispose()
})

test('after-write refresh waits for an already-running load plus its queued fresh snapshot', async () => {
  const waits = [deferred(), deferred()]
  let calls = 0
  const { refresh, data } = makeRefresh({ load: () => waits[calls++].promise })
  const first = refresh.request()
  const afterWrite = refresh.request(true)
  waits[0].resolve('before insert')
  await flush()
  assert.equal(calls, 2)
  waits[1].resolve('after insert')
  await afterWrite
  await first
  assert.deepEqual(data, ['before insert', 'after insert'])
  refresh.dispose()
})

test('continuous invalidations finish each drain after two passes and rate-limit the remaining work', async () => {
  const waits = [deferred(), deferred(), deferred()]
  let calls = 0, settled = 0
  const { refresh, clock } = makeRefresh({
    minBackgroundIntervalMs: 5_000,
    load: () => waits[calls++].promise,
    onSettled: () => settled++,
  })
  const drain = refresh.request()
  for (let i = 0; i < 10; i++) refresh.invalidate()
  waits[0].resolve('first')
  await flush()
  assert.equal(calls, 2)
  for (let i = 0; i < 10; i++) refresh.invalidate()
  waits[1].resolve('second')
  await drain
  assert.equal(calls, 2)
  assert.equal(settled, 1)
  clock.advance(4_999)
  await flush()
  assert.equal(calls, 2)
  clock.advance(1)
  await flush()
  assert.equal(calls, 3)
  waits[2].resolve('trailing')
  await flush()
  assert.equal(settled, 2)
  refresh.dispose()
})

test('ordinary background invalidations also honor the minimum spacing between attempts', async () => {
  const { refresh, clock, calls } = makeRefresh({ minBackgroundIntervalMs: 5_000 })
  await refresh.request()
  refresh.invalidate()
  clock.advance(400)
  await flush()
  assert.equal(calls(), 1)
  clock.advance(4_600)
  await flush()
  assert.equal(calls(), 2)
  refresh.dispose()
})

test('events every 100ms cannot slide the armed refresh deadline beyond 5 seconds', async () => {
  const { refresh, clock, calls } = makeRefresh({ minBackgroundIntervalMs: 5_000 })
  await refresh.request()
  for (let i = 0; i < 60; i++) {
    clock.advance(100)
    await flush()
    refresh.invalidate()
    if (i < 49) assert.equal(calls(), 1)
  }
  // The event stream is still active; no quiet debounce window occurred.
  assert.equal(clock.now(), 6_000)
  assert.equal(calls(), 2)
  refresh.dispose()
})

test('a write finishing during the second pass still waits for a post-write snapshot', async () => {
  const waits = [deferred(), deferred(), deferred()]
  let calls = 0
  const { refresh, data } = makeRefresh({ load: () => waits[calls++].promise })
  const firstDrain = refresh.request()
  refresh.invalidate()
  waits[0].resolve('first')
  await flush()
  assert.equal(calls, 2)
  let writeDone = false
  const afterWrite = refresh.request(true).then(() => { writeDone = true })
  waits[1].resolve('still before write')
  await firstDrain
  await flush()
  assert.equal(calls, 3)
  assert.equal(writeDone, false)
  waits[2].resolve('contains the write')
  await afterWrite
  assert.equal(writeDone, true)
  assert.deepEqual(data, ['first', 'still before write', 'contains the write'])
  refresh.dispose()
})

test('read timeout aborts hanging sources, reports failure, ignores late success, and permits retry', async () => {
  const hanging = deferred()
  let calls = 0, signal, settled = 0
  const { refresh, clock, data, errors } = makeRefresh({
    readTimeoutMs: 2_000,
    load: (requestSignal) => { signal = requestSignal; return ++calls === 1 ? hanging.promise : Promise.resolve('retry') },
    onSettled: () => settled++,
  })
  const first = refresh.request()
  clock.advance(1_999)
  await flush()
  assert.equal(settled, 0)
  clock.advance(1)
  await first
  assert.equal(settled, 1)
  assert.equal(signal.aborted, true)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].name, 'HomeFeedReadTimeoutError')
  assert.deepEqual(data, [])
  await refresh.request()
  assert.deepEqual(data, ['retry'])
  hanging.resolve('stale late result')
  await flush()
  assert.deepEqual(data, ['retry'])
  assert.equal(errors.length, 1)
  refresh.dispose()
  assert.equal(clock.size(), 0)
})

test('late rejection from a timed-out source is handled and cannot replace a successful retry', async () => {
  const hanging = deferred()
  let calls = 0
  const { refresh, clock, data, errors } = makeRefresh({
    readTimeoutMs: 100,
    load: () => ++calls === 1 ? hanging.promise : Promise.resolve('retry'),
  })
  const first = refresh.request()
  clock.advance(100)
  await first
  await refresh.request()
  hanging.reject(new Error('late rejection'))
  await flush()
  assert.deepEqual(data, ['retry'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].name, 'HomeFeedReadTimeoutError')
  refresh.dispose()
})

test('dispose immediately settles even a source which ignores AbortSignal and never resolves', async () => {
  let signal, callbacks = 0
  const { refresh, clock } = makeRefresh({
    load: (requestSignal) => { signal = requestSignal; return new Promise(() => undefined) },
    onData: () => callbacks++,
    onError: () => callbacks++,
    onSettled: () => callbacks++,
  })
  const started = refresh.request()
  refresh.dispose()
  await started
  assert.equal(signal.aborted, true)
  assert.equal(callbacks, 0)
  assert.equal(clock.size(), 0)
})

test('hidden in-flight invalidations wait until return rather than draining in background', async () => {
  const pending = deferred()
  let calls = 0
  const { refresh } = makeRefresh({ load: () => ++calls === 1 ? pending.promise : Promise.resolve('fresh') })
  const started = refresh.request()
  refresh.setVisible(false)
  refresh.invalidate()
  pending.resolve('ready')
  await started
  assert.equal(calls, 1)
  refresh.setVisible(true)
  await flush()
  assert.equal(calls, 2)
  refresh.dispose()
})

test('errors settle normally and a retry succeeds without losing the previous successful data', async () => {
  let attempt = 0
  let rendered = 'cached'
  let settled = 0
  const { refresh, errors } = makeRefresh({
    load: async () => { if (++attempt === 1) throw new Error('offline'); return 'new' },
    onData: (value) => { rendered = value },
    onSettled: () => settled++,
  })
  await refresh.request()
  assert.equal(rendered, 'cached')
  assert.equal(errors.length, 1)
  assert.equal(settled, 1)
  await refresh.request()
  assert.equal(rendered, 'new')
  assert.equal(settled, 2)
  refresh.dispose()
})

test('dispose cancels timers and aborts a request; late data/error/settled cannot update an old account', async () => {
  for (const completion of ['resolve', 'reject']) {
    const pending = deferred()
    let signal, callbacks = 0
    const { refresh, clock } = makeRefresh({
      load: (requestSignal) => { signal = requestSignal; return pending.promise },
      onData: () => callbacks++,
      onError: () => callbacks++,
      onSettled: () => callbacks++,
    })
    const started = refresh.request()
    refresh.invalidate()
    refresh.dispose()
    assert.equal(signal.aborted, true)
    assert.equal(clock.size(), 0)
    if (completion === 'resolve') pending.resolve('stale account')
    else pending.reject(new Error('late failure'))
    await started
    await refresh.request()
    clock.advance(120_000)
    assert.equal(callbacks, 0)
  }
})

function row(id, extra = {}) {
  return { id, user_id: 'author', author_name: 'Author', author_avatar: '', content: id, category: 'General Questions', created_at: '2026-10-14T10:00:00Z', ...extra }
}
function source(rows, images = []) {
  return {
    questions: async () => ({ data: rows, error: null }),
    images: async () => ({ data: images, error: null }),
    authors: async (rows) => rows,
  }
}
const activeSignal = () => new AbortController().signal

test('image query contains only displayed question IDs; pinned/order/50-card order is preserved', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(`question-${i}`, { is_pinned: i === 0 }))
  let imageIds
  const fakeSource = source(rows)
  fakeSource.images = async (ids) => {
    imageIds = ids
    return { data: [{ question_id: 'question-1', image_url: 'https://example.test/photo.png' }], error: null }
  }
  const loaded = await loadHomeFeed(fakeSource, [], activeSignal())
  assert.deepEqual(imageIds, rows.map((question) => question.id))
  assert.equal(imageIds.length, 50)
  assert.deepEqual(loaded.questions.map((question) => question.id), rows.map((question) => question.id))
  assert.equal(loaded.questions[0].is_pinned, true)
  assert.deepEqual(loaded.questions[1].images, ['https://example.test/photo.png'])
})

test('empty feed skips all image requests', async () => {
  const fakeSource = source([])
  fakeSource.images = () => { throw new Error('must not load photos') }
  const loaded = await loadHomeFeed(fakeSource, [], activeSignal())
  assert.deepEqual(loaded.questions, [])
  assert.equal(loaded.imagesError, false)
})

test('temporary image errors keep existing photos and fresh text; successful removal clears photos', async () => {
  const previous = [row('one', { images: ['old-photo'], content: 'old' })]
  const fakeSource = source([row('one', { content: 'updated' }), row('two')])
  fakeSource.images = async () => ({ data: null, error: new Error('network') })
  const failed = await loadHomeFeed(fakeSource, previous, activeSignal())
  assert.equal(failed.imagesError, true)
  assert.deepEqual(failed.questions[0].images, ['old-photo'])
  assert.equal(failed.questions[0].content, 'updated')
  assert.deepEqual(failed.questions[1].images, [])
  fakeSource.images = async () => ({ data: [], error: null })
  const removed = await loadHomeFeed(fakeSource, failed.questions, activeSignal())
  assert.deepEqual(removed.questions[0].images, [])
  assert.equal(removed.imagesError, false)
})

test('thrown image requests retain photos as well as returned errors', async () => {
  const fakeSource = source([row('one')])
  fakeSource.images = async () => { throw new Error('offline') }
  const loaded = await loadHomeFeed(fakeSource, [row('one', { images: ['old-photo'] })], activeSignal())
  assert.deepEqual(loaded.questions[0].images, ['old-photo'])
  assert.equal(loaded.imagesError, true)
})

test('question errors and incomplete responses reject without extra image/author requests', async () => {
  for (const response of [{ data: null, error: new Error('offline') }, { data: null, error: null }]) {
    const fakeSource = source([])
    fakeSource.questions = async () => response
    fakeSource.images = () => { throw new Error('unexpected images') }
    fakeSource.authors = () => { throw new Error('unexpected authors') }
    await assert.rejects(loadHomeFeed(fakeSource, [row('cached')], activeSignal()))
  }
})

test('abort after the first response prevents starting image/author work', async () => {
  const controller = new AbortController()
  const fakeSource = source([row('one')])
  fakeSource.questions = async () => { controller.abort(); return { data: [row('one')], error: null } }
  fakeSource.images = () => { throw new Error('unexpected images') }
  fakeSource.authors = () => { throw new Error('unexpected authors') }
  await assert.rejects(loadHomeFeed(fakeSource, [], controller.signal), { name: 'AbortError' })
})

test('unchanged rows preserve card object identity', async () => {
  const previous = [row('one', { images: ['same-photo'] }), row('two', { images: [] })]
  const loaded = await loadHomeFeed(source([row('one'), row('two')], [{ question_id: 'one', image_url: 'same-photo' }]), previous, activeSignal())
  assert.equal(loaded.questions[0], previous[0])
  assert.equal(loaded.questions[1], previous[1])
})

test('counter failures preserve only the failed counter; a valid zero is displayed', async () => {
  const previous = { questions: 33, members: 208 }
  const first = await loadHomeFeedStats({
    questionCount: async () => ({ data: 0, error: null }),
    memberCount: async () => ({ data: null, error: new Error('offline') }),
  }, previous, activeSignal())
  assert.deepEqual(first, { questions: 0, members: 208 })
  const second = await loadHomeFeedStats({
    questionCount: async () => { throw new Error('offline') },
    memberCount: async () => ({ data: 210, error: null }),
  }, previous, activeSignal())
  assert.deepEqual(second, { questions: 33, members: 210 })
  const invalid = await loadHomeFeedStats({
    questionCount: async () => ({ data: NaN, error: null }),
    memberCount: async () => ({ data: -1, error: null }),
  }, previous, activeSignal())
  assert.deepEqual(invalid, previous)
})

test('independent counters use their 5-minute fallback instead of the feed interval', async () => {
  const { refresh, clock, calls } = makeRefresh({ fallbackMs: 300_000, reconcileMs: 60_000 })
  await refresh.request()
  clock.advance(60_000)
  await flush()
  assert.equal(calls(), 1)
  clock.advance(240_000)
  await flush()
  assert.equal(calls(), 2)
  refresh.dispose()
})

test('selected image previews create one URL per file and revoke all once on removal/unmount', () => {
  const files = [new Blob(['a']), new Blob(['b'])]
  const created = [], revoked = []
  const previews = createHomeImagePreviews(files, {
    createObjectURL: (file) => { const url = `blob:${created.length}`; created.push(file); return url },
    revokeObjectURL: (url) => revoked.push(url),
  })
  assert.equal(created.length, 2)
  assert.deepEqual(previews.previews.map((preview) => preview.file), files)
  assert.deepEqual(previews.previews.map((preview) => preview.url), ['blob:0', 'blob:1'])
  previews.dispose()
  previews.dispose()
  assert.deepEqual(revoked, ['blob:0', 'blob:1'])
})

test('failed preview creation also releases URLs created before the failure', () => {
  const revoked = []
  let calls = 0
  assert.throws(() => createHomeImagePreviews([new Blob(['a']), new Blob(['b'])], {
    createObjectURL: () => { if (++calls === 2) throw new Error('failed'); return 'blob:first' },
    revokeObjectURL: (url) => revoked.push(url),
  }))
  assert.deepEqual(revoked, ['blob:first'])
})
