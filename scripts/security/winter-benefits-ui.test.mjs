import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = name => readFile(new URL('../../' + name, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('a benefit action cannot silently switch to a newly signed-in account', async () => {
  let sessionOwner = userB, requests = 0
  const module = { exports: {} }
  vm.runInNewContext(compile(await read('src/lib/winterBenefitsClient.ts')), {
    module, exports: module.exports, DOMException,
    fetch() { requests++; throw Error('must not send') },
    require(name) {
      if (name === './supabase') return { supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: sessionOwner }, access_token: 'fixture' } } }) } } }
      if (name === './winterBenefits') return { parseWinterBenefitAction: x => x, parseWinterBenefitsState: x => x }
      throw Error(name)
    },
  })
  await assert.rejects(module.exports.requestWinterBenefits(userA, { action: 'activate_credits' }), /Акаунт змінився/)
  assert.equal(requests, 0)
  sessionOwner = userA
  const controller = new AbortController(); controller.abort()
  await assert.rejects(module.exports.requestWinterBenefits(userA, undefined, controller.signal), { name: 'AbortError' })
  assert.equal(requests, 0)
})

const source = compile(await read('src/hooks/useWinterBenefits.ts'))
function harness() {
  let cursor = 0, dirty = false, result, user = userA, nextTimer = 0
  const slots = [], effects = [], requests = [], redirects = [], timers = new Map()
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const hooks = {
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useState(initial) { const index = cursor++, slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, next => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true } }] },
    useCallback(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) slots[index] = { deps, fn }; return slots[index].fn },
    useEffect(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() } }) },
  }
  const deferred = (kind, account, action) => new Promise((resolve, reject) => requests.push({ kind, account, action, resolve, reject }))
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, AbortController, Error,
    window: { setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) }, addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === 'react') return hooks
      if (name.endsWith('/winterBenefitsClient')) return { requestWinterBenefits: (account, action) => deferred(action ? 'mutation' : 'wallet', account, action) }
      if (name.endsWith('/aiCreditTerms')) return { WINTER_BENEFITS_TERMS_VERSION: 'fixture' }
      if (name.endsWith('/billing')) return {
        getWinterBillingOffers: account => deferred('offers', account),
        createWinterSubscriptionCheckout: (selection, account) => deferred('checkout', account, selection),
        quoteWinterSubscription: (selection, account) => deferred('quote', account, selection),
        issueWinterFriendCoupon: account => deferred('issue', account),
        acceptWinterFriendCoupon: (token, account) => deferred('accept', account, token),
        openHostedCheckout: value => redirects.push(value),
      }
      throw Error(name)
    },
  })
  const render = () => { cursor = 0; dirty = false; result = module.exports.useWinterBenefits(user, false); while (effects.length) effects.shift()(); return result }
  const settle = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); if (dirty) render() } }
  render()
  return { requests, redirects, settle, get result() { return result }, switchTo(next) { user = next; return render() }, unmount() { for (const slot of slots) slot?.cleanup?.() } }
}

test('wallet and offers are hidden immediately on account switch and late reads never restore them', async () => {
  const h = harness()
  h.requests[0].resolve({ marker: 'wallet-a' }); h.requests[1].resolve({ marker: 'offers-a' }); await h.settle()
  assert.equal(h.result.state.marker, 'wallet-a'); assert.equal(h.result.offers.marker, 'offers-a')
  const immediate = h.switchTo(userB)
  assert.equal(immediate.state, null); assert.equal(immediate.offers, null)
  await h.settle(); assert.equal(h.requests.length, 4)
  h.switchTo(null); await h.settle()
  h.requests[2].resolve({ marker: 'wallet-b' }); h.requests[3].resolve({ marker: 'offers-b' }); await h.settle()
  assert.equal(h.result.state, null); assert.equal(h.result.offers, null)
  h.unmount()
})

test('checkout cannot redirect a newly signed-in user and duplicate clicks cannot create another request', async () => {
  const h = harness()
  h.requests[0].resolve({}); h.requests[1].resolve({}); await h.settle()
  const selection = { audience: 'student', planId: 'plus', termMonths: 1, source: 'own' }
  const action = h.result.onCheckout(selection)
  await assert.rejects(h.result.onCheckout(selection), /Попередня дія/)
  assert.equal(h.requests.filter(item => item.kind === 'checkout').length, 1)
  assert.equal(h.requests[2].account, userA)
  h.switchTo(userB); await h.settle()
  h.requests[2].resolve({ checkout: { action: 'fixture-bank', fields: {} } })
  await assert.rejects(action, /Акаунт змінився/)
  assert.equal(h.redirects.length, 0)
  h.unmount()
})

test('failed mutation keeps the last confirmed wallet and never applies an optimistic gift', async () => {
  const h = harness()
  h.requests[0].resolve({ availableCredits: 0 }); h.requests[1].resolve({}); await h.settle()
  const action = h.result.onAction({ action: 'activate_credits' })
  h.requests[2].reject(Error('network failed'))
  await assert.rejects(action, /network failed/); await h.settle()
  assert.equal(h.result.state.availableCredits, 0)
  assert.equal(h.result.pending, false)
  assert.match(h.result.error, /network failed/)
  assert.equal(h.requests.length, 3, 'no automatic mutation retry')
  h.unmount()
})
