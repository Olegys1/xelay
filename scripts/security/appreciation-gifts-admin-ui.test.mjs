// Real form callbacks in a synthetic React hook session; no provider traffic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const source = await readFile(new URL('../../src/components/community/AppreciationGiftAdminOffer.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const admin = '11111111-1111-4111-8111-111111111111'
const recipient = '22222222-2222-4222-8222-222222222222'
const other = '33333333-3333-4333-8333-333333333333'
const profile = { id: recipient, full_name: 'Синтетичний одержувач', username: 'synthetic_user' }
const pending = { id: 'gift', claimed_at: null }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(options = {}) {
  const state = [], effects = [], timers = new Map(), calls = [], exports = {}
  let cursor = 0, dirty = false, tree, timerId = 0, listener
  let auth = { authUser: { id: admin }, xelayUser: { id: admin, isPlatformAdmin: true } }
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!state[index]) state[index] = { value: initial }
      return [state[index].value, next => { const value = typeof next === 'function' ? next(state[index].value) : next; if (!Object.is(value, state[index].value)) { state[index].value = value; dirty = true } }]
    },
    useRef(initial) { const index = cursor++; return (state[index] ??= { current: initial }) },
    useEffect(effect, deps) {
      const index = cursor++, previous = state[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects.push(() => { previous?.cleanup?.(); state[index] = { deps, cleanup: effect() } })
    },
  }
  const supabase = {
    auth: { onAuthStateChange(callback) { listener = callback; return { data: { subscription: { unsubscribe() {} } } } } },
    from(table) {
      calls.push(['directSelect', table])
      throw new Error('Direct SELECT cannot see another profile under own-only RLS')
    },
    rpc(name, args) {
      assert.equal(name, 'xelay_profiles_by_ids')
      assert.deepEqual(Object.keys(args), ['p_user_ids'])
      assert.ok(Array.isArray(args.p_user_ids)); assert.equal(args.p_user_ids.length, 1)
      const lookup = { rpc: name, args, id: args.p_user_ids[0] }
      return {
        abortSignal(signal) { lookup.signal = signal; calls.push(['lookup', lookup]); return options.lookup ? options.lookup(lookup) : Promise.resolve({ data: [profile], error: null }) },
      }
    },
  }
  vm.runInNewContext(compiled, {
    exports, AbortController,
    window: { setTimeout(callback, ms) { assert.equal(ms, 18000); const id = ++timerId; timers.set(id, callback); return id }, clearTimeout(id) { timers.delete(id) } },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return runtime
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => React.createElement('svg') })
      if (name === '../../context/AuthContext') return { useAuth: () => auth }
      if (name === '../../lib/supabase') return { supabase }
      if (name === '../../lib/adminBillingTransactions') return { assertAdminBillingIdentity: async (...args) => { calls.push(['identity', ...args]); if (options.identity) await options.identity(...args) } }
      if (name === '../../lib/appreciationGifts') return { offerAppreciationGift: async (...args) => { calls.push(['offer', ...args]); return options.offer ? options.offer(...args) : pending } }
      throw new Error('Unexpected live import: ' + name)
    },
  })
  function render() {
    for (let i = 0; i < 8; i++) {
      dirty = false; cursor = 0; tree = exports.AppreciationGiftAdminOffer()
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('Hook session did not settle')
  }
  const nodes = function* (node = tree) {
    if (!React.isValidElement(node)) return
    yield node
    for (const child of React.Children.toArray(node.props.children)) yield* nodes(child)
  }
  const node = type => [...nodes()].find(value => value.type === type)
  const text = () => renderToStaticMarkup(tree)
  const flush = async () => { await new Promise(setImmediate); render() }
  const input = value => { node('input').props.onChange({ target: { value } }); render() }
  const greetingInput = () => [...nodes()].find(value => value.type === 'input' && value.props.maxLength === 80)
  const greeting = value => { greetingInput().props.onChange({ target: { value } }); render() }
  const verify = async () => { node('form').props.onSubmit({ preventDefault() {} }); await flush() }
  const offer = async () => { [...nodes()].find(value => value.type === 'button' && value.props.type === 'button').props.onClick(); await flush() }
  render()
  return { calls, text, render, input, greeting, greetingInput, verify, offer, flush, timers,
    setAuth(value) { auth = value; render() },
    signOut() { listener('SIGNED_OUT', null); render() },
    expire() { for (const [id, callback] of timers) { timers.delete(id); callback() } render() },
    unmount() { for (const slot of state) slot?.cleanup?.() },
  }
}

test('admin form confirms one exact public profile before creating only an offer', async () => {
  const fx = fixture()
  fx.input('https://xelay.example/user/' + recipient + '?from=admin')
  assert.doesNotMatch(fx.text(), /Підтверджений одержувач|Надіслати подяку з подарунком/)
  await fx.verify()
  assert.match(fx.text(), /Синтетичний одержувач/); assert.match(fx.text(), /@synthetic_user/)
  assert.equal(fx.calls.filter(([name]) => name === 'lookup').length, 1)
  assert.equal(fx.calls.find(([name]) => name === 'lookup')[1].id, recipient)
  assert.equal(fx.calls.filter(([name]) => name === 'directSelect').length, 0)
  assert.equal(fx.calls.filter(([name]) => name === 'offer').length, 0)
  await fx.offer()
  const offer = fx.calls.find(([name]) => name === 'offer')
  assert.deepEqual(offer.slice(1, 3), [admin, recipient]); assert.equal(offer[3].aborted, false)
  assert.equal(offer[4], '')
  assert.match(fx.text(), /Подяку з подарунком надіслано/)
  assert.match(fx.text(), /після натискання користувачем кнопки «Забрати подарунок»/)
  assert.equal(fx.timers.size, 0)
})

test('own-only profile SELECT cannot be used; confirmation requests only the known target through the profile RPC', async () => {
  const fx = fixture()
  fx.input(recipient); await fx.verify()
  const lookup = fx.calls.find(([name]) => name === 'lookup')[1]
  assert.equal(lookup.rpc, 'xelay_profiles_by_ids')
  assert.deepEqual([...lookup.args.p_user_ids], [recipient])
  assert.equal(lookup.signal.aborted, false)
  assert.equal(fx.calls.filter(([name]) => name === 'directSelect').length, 0)
  assert.match(fx.text(), /Підтверджений одержувач/)
})

test('missing, ambiguous or mismatched profile RPC responses cannot confirm a recipient', async () => {
  for (const data of [[], null, profile, [profile, profile], [{ ...profile, id: other }], [null]]) {
    const fx = fixture({ lookup: async () => ({ data, error: null }) })
    fx.input(recipient); await fx.verify()
    assert.doesNotMatch(fx.text(), /Підтверджений одержувач|Надіслати подяку з подарунком/)
    assert.equal(fx.calls.filter(([name]) => name === 'offer' || name === 'directSelect').length, 0)
  }
})

test('an explicit greeting name is trimmed and kept separate from private profile confirmation', async () => {
  const fx = fixture()
  fx.input(recipient); await fx.verify()
  assert.equal(fx.greetingInput().props.value, '')
  assert.match(fx.text(), /Синтетичний одержувач/)
  fx.greeting('  Тестове ім’я  '); await fx.offer()
  assert.equal(fx.calls.find(([name]) => name === 'offer')[4], 'Тестове ім’я')
  assert.match(fx.text(), /Синтетичний одержувач/)
})

test('changing target or account clears a prior greeting name', async () => {
  for (const change of ['target', 'account', 'signOut']) {
    const fx = fixture()
    fx.input(recipient); await fx.verify(); fx.greeting('Попереднє ім’я')
    if (change === 'target') fx.input(other)
    else if (change === 'signOut') fx.signOut()
    else {
      fx.setAuth({ authUser: { id: other }, xelayUser: { id: other, isPlatformAdmin: true } })
      fx.setAuth({ authUser: { id: admin }, xelayUser: { id: admin, isPlatformAdmin: true } })
    }
    fx.input(recipient); await fx.verify()
    assert.equal(fx.greetingInput().props.value, '')
    await fx.offer()
    assert.equal(fx.calls.find(([name]) => name === 'offer')[4], '')
  }
})

test('a greeting name over eighty characters cannot be sent', async () => {
  const fx = fixture()
  fx.input(recipient); await fx.verify(); fx.greeting('Я'.repeat(81)); await fx.offer()
  assert.equal(fx.calls.filter(([name]) => name === 'offer').length, 0)
  assert.match(fx.text(), /щонайбільше 80 символів/)
})

test('invalid or missing targets never reach the offer helper', async () => {
  for (const invalid of ['', recipient + 'extra', 'prefix' + recipient, 'https://xelay.example/user/not-a-uuid']) {
    const fx = fixture(); fx.input(invalid); await fx.verify()
    assert.equal(fx.calls.length, 0); assert.match(fx.text(), /Вставте ID/)
  }
  const missing = fixture({ lookup: async () => ({ data: [], error: null }) })
  missing.input(recipient); await missing.verify()
  assert.match(missing.text(), /Профіль із цим ID не знайдено/)
  assert.doesNotMatch(missing.text(), /Надіслати подяку з подарунком/)
})

test('changing the target invalidates confirmation and aborts an old lookup', async () => {
  const waiting = deferred(), fx = fixture({ lookup: () => waiting.promise })
  fx.input(recipient); await fx.verify()
  const signal = fx.calls.find(([name]) => name === 'lookup')[1].signal
  fx.input(other)
  assert.equal(signal.aborted, true)
  waiting.resolve({ data: [profile], error: null }); await fx.flush()
  assert.doesNotMatch(fx.text(), /Підтверджений одержувач|Синтетичний одержувач/)
  assert.equal(fx.calls.filter(([name]) => name === 'offer').length, 0)
})

test('timeout releases the lock and ignores a late successful offer', async () => {
  const waiting = deferred(), fx = fixture({ offer: () => waiting.promise })
  fx.input(recipient); await fx.verify(); await fx.offer()
  fx.expire()
  assert.equal(fx.calls.find(([name]) => name === 'offer')[3].aborted, true)
  assert.match(fx.text(), /Не вдалося підтвердити надсилання/)
  waiting.resolve(pending); await fx.flush()
  assert.doesNotMatch(fx.text(), /Подяку з подарунком надіслано/)
  assert.equal(fx.timers.size, 0)
})

test('sign-out, changed account and unmount abort pending work and suppress stale results', async () => {
  for (const change of ['signOut', 'account', 'unmount']) {
    const waiting = deferred(), fx = fixture({ offer: () => waiting.promise })
    fx.input(recipient); await fx.verify(); await fx.offer()
    if (change === 'signOut') fx.signOut()
    else if (change === 'account') fx.setAuth({ authUser: { id: other }, xelayUser: { id: admin, isPlatformAdmin: true } })
    else fx.unmount()
    assert.equal(fx.calls.find(([name]) => name === 'offer')[3].aborted, true)
    waiting.resolve(pending)
    if (change !== 'unmount') { await fx.flush(); assert.doesNotMatch(fx.text(), /Подяку з подарунком надіслано|Синтетичний одержувач/) }
    assert.equal(fx.timers.size, 0)
  }
})

test('already claimed gift reports the existing result and does not promise another month', async () => {
  const fx = fixture({ offer: async () => ({ ...pending, claimed_at: '2026-10-26T10:00:00Z' }) })
  fx.input(recipient); await fx.verify(); await fx.offer()
  assert.match(fx.text(), /подарунок отримано/); assert.match(fx.text(), /Повторний місяць не надано/)
})

test('the request lock prevents repeated sends before the first request settles', async () => {
  const waiting = deferred(), fx = fixture({ offer: () => waiting.promise })
  fx.input(recipient); await fx.verify(); await fx.offer(); await fx.offer()
  assert.equal(fx.calls.filter(([name]) => name === 'offer').length, 1)
  waiting.resolve(pending); await fx.flush()
  assert.match(fx.text(), /Подяку з подарунком надіслано/)
})

test('provider error details are not rendered and a nonadmin cannot see the form', async () => {
  const fx = fixture({ lookup: async () => ({ data: null, error: new Error('RAW_PROVIDER_SECRET') }) })
  fx.input(recipient); await fx.verify()
  assert.match(fx.text(), /Не вдалося перевірити профіль/); assert.doesNotMatch(fx.text(), /RAW_PROVIDER_SECRET/)
  fx.setAuth({ authUser: { id: admin }, xelayUser: { id: admin, isPlatformAdmin: false } })
  assert.equal(fx.text(), '')
  fx.setAuth({ authUser: { id: admin }, xelayUser: { id: admin, isPlatformAdmin: true }, isLoading: true })
  assert.equal(fx.text(), '')
})
