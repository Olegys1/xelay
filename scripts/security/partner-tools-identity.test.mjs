import test from 'node:test'
import assert from 'node:assert/strict'

const moduleUrl = new URL('../../src/lib/partnerClickIdentity.ts', import.meta.url)
const load = key => import(moduleUrl.href + '?' + key)
function storage() { const state = new Map(); return { getItem: key => state.get(key) || null, setItem: (key, value) => state.set(key, value), state } }

test('concurrent first clicks share one anonymous browser identity before a cookie response', async () => {
  const { partnerClickBrowserId } = await load('concurrent')
  const store = storage(); let generated = 0
  const options = { storage: store, now: 1000, randomId: () => { generated++; return '11111111-1111-4111-8111-111111111111' } }
  const ids = await Promise.all(Array.from({ length: 100 }, async () => partnerClickBrowserId(options)))
  assert.equal(new Set(ids).size, 1); assert.equal(generated, 1)
})

test('identity persists across a page reload and refreshes its expiry only after a click', async () => {
  const first = await load('first-page'), second = await load('second-page')
  const store = storage(), id = '22222222-2222-4222-8222-222222222222'
  first.partnerClickBrowserId({ storage: store, now: 1000, randomId: () => id })
  assert.equal(second.partnerClickBrowserId({ storage: store, now: 20 * 60000, randomId: () => { throw Error('must not create') } }), id)
  const saved = JSON.parse([...store.state.values()][0]); assert.equal(saved.expiresAt, 20 * 60000 + 86400000)
  assert.deepEqual(Object.keys(saved).sort(), ['expiresAt', 'id'])
})

test('blocked or corrupted browser storage keeps links usable and first-click dedupe stable', async () => {
  const { partnerClickBrowserId } = await load('blocked')
  const broken = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
  const id = '33333333-3333-4333-8333-333333333333'
  assert.equal(partnerClickBrowserId({ storage: broken, randomId: () => id }), id)
  assert.equal(partnerClickBrowserId({ storage: broken, randomId: () => { throw Error('second identity') } }), id)
  const corrupted = { getItem: () => '{bad json', setItem() {} }
  assert.equal(partnerClickBrowserId({ storage: corrupted, randomId: () => { throw Error('second identity') } }), id)
})

test('an expired stored identity rotates on a fresh page; malformed generated ids are rejected', async () => {
  const { partnerClickBrowserId } = await load('expiry')
  const store = storage(); store.state.set('xelay:partner-click:browser:v1', JSON.stringify({ id: '44444444-4444-4444-8444-444444444444', expiresAt: 1 }))
  const id = '55555555-5555-4555-8555-555555555555'
  assert.equal(partnerClickBrowserId({ storage: store, now: 100, randomId: () => id }), id)
  const fresh = await load('invalid')
  assert.throws(() => fresh.partnerClickBrowserId({ storage: null, randomId: () => 'not-an-id' }), /INVALID/)
})
