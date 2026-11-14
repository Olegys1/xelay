import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// The real guard runs with a fictional history/DOM. No browser or platform API.
function fixture(requestLeave, { active = true, routerPresent = true } = {}) {
  const effects = [], windowEvents = new Map(), documentEvents = new Map(), destinations = []
  let blocker, unblocked = false
  const hooks = { useRef: value => ({ current: value }), useEffect: fn => effects.push(fn) }
  const router = { history: { block(options) { blocker = options; return () => { unblocked = true } } } }
  class Element {
    constructor(anchor = null) { this.anchor = anchor }
    closest() { return this.anchor }
  }
  const window = { location: { href: 'https://xelay.example/groups/synthetic', origin: 'https://xelay.example', pathname: '/groups/synthetic', search: '', assign: value => destinations.push(value) },
    addEventListener: (name, fn) => windowEvents.set(name, fn), removeEventListener: name => windowEvents.delete(name) }
  const document = { addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) }
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../../src/components/teaching/TeachingTestExitGuard.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, window, document, URL, Element,
    require: name => name === 'react' ? hooks : name === '@tanstack/react-router' ? { useRouter: () => routerPresent ? router : undefined } : assert.fail(name) })
  module.exports.TeachingTestExitGuard({ active, requestLeave })
  const cleanup = effects.map(fn => fn())
  return { destinations, windowEvents, documentEvents, get blocker() { return blocker }, get unblocked() { return unblocked },
    leavePage() { let prevented = false; const event = { returnValue: undefined, preventDefault() { prevented = true } }; windowEvents.get('beforeunload')?.(event); return { prevented, returnValue: event.returnValue } },
    click(href, { middle = false, download = false } = {}) {
      let prevented = false, stopped = false
      const anchor = { href, hasAttribute: name => name === 'download' && download }
      const event = { target: new Element(anchor), defaultPrevented: false, button: middle ? 1 : 0,
        preventDefault() { prevented = true }, stopImmediatePropagation() { stopped = true } }
      documentEvents.get(middle ? 'auxclick' : 'click')?.(event)
      return { prevented, stopped }
    }, cleanup() { cleanup.forEach(fn => fn?.()) } }
}
const flush = async () => { for (let step = 0; step < 8; step++) await Promise.resolve() }

test('native refresh/close only requests the browser warning; cancelling it creates no exit request', () => {
  let requests = 0
  const h = fixture(async () => { requests++; return false })
  assert.deepEqual(h.leavePage(), { prevented: true, returnValue: '' })
  assert.equal(requests, 0)
  assert.equal(h.blocker.enableBeforeUnload, false, 'the router must not install a competing native handler')
  assert.equal(h.windowEvents.has('blur'), false)
  assert.equal(h.documentEvents.has('focusout'), false, 'opening a legitimate dialog or file picker is not an exit')
  h.cleanup(); assert.equal(h.windowEvents.size, 0); assert.equal(h.documentEvents.size, 0); assert.equal(h.unblocked, true)
})

test('route/back navigation is blocked on Stay and released only after a successful submission receipt', async () => {
  let allowed = false
  const h = fixture(async () => allowed)
  assert.equal(await h.blocker.blockerFn({ action: 'BACK' }), true)
  assert.equal(h.leavePage().prevented, true)
  allowed = true
  assert.equal(await h.blocker.blockerFn({ action: 'PUSH' }), false)
  assert.equal(h.leavePage().prevented, false)
  h.cleanup()
})

test('external and middle-click links wait for confirmation; cancellation never opens another page', async () => {
  let resolve, requests = 0
  const h = fixture(() => { requests++; return new Promise(done => { resolve = done }) })
  assert.deepEqual(h.click('https://partner.example/reading', { middle: true }), { prevented: true, stopped: true })
  assert.equal(h.destinations.length, 0)
  h.click('https://partner.example/another')
  assert.equal(requests, 1, 'one navigation intent owns the pending confirmation')
  assert.equal(await h.blocker.blockerFn({ action: 'BACK' }), true)
  resolve(false); await flush(); assert.equal(h.destinations.length, 0)
  h.click('https://partner.example/reading'); resolve(true); await flush()
  assert.deepEqual(h.destinations, ['https://partner.example/reading'])
  assert.equal(h.leavePage().prevented, false)
  h.cleanup()
})

test('an errored confirmation fails closed and permits a later retry', async () => {
  let failed = true
  const h = fixture(async () => { if (failed) throw Error('Synthetic unavailable receipt'); return true })
  assert.equal(await h.blocker.blockerFn({ action: 'PUSH' }), true)
  h.click('https://partner.example/reading'); await flush()
  assert.equal(h.destinations.length, 0)
  failed = false
  assert.equal(await h.blocker.blockerFn({ action: 'PUSH' }), false)
  h.cleanup()
})

test('opt-out installs nothing; same-document anchors and downloads are not departures', async () => {
  const inactive = fixture(async () => assert.fail('opt-out'), { active: false })
  assert.equal(inactive.blocker, undefined); assert.equal(inactive.windowEvents.size, 0); assert.equal(inactive.documentEvents.size, 0)
  inactive.cleanup()
  const h = fixture(async () => assert.fail('non-navigation'), { routerPresent: false })
  assert.equal(h.click('https://xelay.example/groups/synthetic#question').prevented, false)
  assert.equal(h.click('https://xelay.example/file.pdf', { download: true }).prevented, false)
  assert.equal(h.click('javascript:void(0)').prevented, false)
  assert.equal(h.click('http://[').prevented, false)
  await flush(); assert.deepEqual(h.destinations, [])
  h.cleanup()
})
