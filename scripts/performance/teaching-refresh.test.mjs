// Executes the production visibility hook with deterministic hook slots/events.
// Browser mounting and editor preservation are covered by teaching-browser-fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function hookFixture() {
  const slots = [], cleanups = [], effects = [], microtasks = []
  let cursor = 0, now = 0
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const window = new EventTarget(), module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../../src/lib/useTeachingVisibilityRefresh.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, document, window, Promise,
    Date: { now: () => now }, queueMicrotask: callback => microtasks.push(callback),
    require(name) {
      assert.equal(name, 'react')
      return {
        useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index] },
        useEffect(callback, deps) { const index = cursor++; if (!slots[index] || deps.some((value, dependency) => slots[index][dependency] !== value)) { slots[index] = deps; effects.push({ index, callback }) } },
      }
    },
  })
  return {
    document,
    render(callback, options) { cursor = 0; module.exports.useTeachingVisibilityRefresh(callback, options); for (const effect of effects.splice(0)) { cleanups[effect.index]?.(); cleanups[effect.index] = effect.callback() } },
    emit(type) { (type === 'focus' ? window : document).dispatchEvent(new Event(type)) },
    async flush() { for (const callback of microtasks.splice(0)) callback(); for (let count = 0; count < 4; count++) await Promise.resolve() },
    advance(milliseconds) { now += milliseconds },
    dispose() { for (const cleanup of cleanups) cleanup?.() },
  }
}

test('refresh hook makes no initial request and coalesces focus plus visibility into one callback', async () => {
  const fx = hookFixture(); let calls = 0
  fx.render(() => { calls++ }); await fx.flush(); assert.equal(calls, 0)
  for (let count = 0; count < 5; count++) { fx.emit('visibilitychange'); fx.emit('focus') }
  await fx.flush(); assert.equal(calls, 1)
  fx.emit('focus'); await fx.flush(); assert.equal(calls, 1)
  fx.advance(1000); fx.emit('focus'); await fx.flush(); assert.equal(calls, 2)
  fx.dispose()
})

test('hidden, inactive and edit-blocked views issue no refresh', async () => {
  const fx = hookFixture(); let calls = 0
  const callback = () => { calls++ }
  fx.render(callback)
  fx.document.visibilityState = 'hidden'; fx.emit('visibilitychange'); fx.emit('focus'); await fx.flush()
  fx.document.visibilityState = 'visible'; fx.render(callback, { enabled: false }); fx.emit('focus'); await fx.flush()
  fx.render(callback, { blocked: true }); fx.emit('visibilitychange'); await fx.flush()
  assert.equal(calls, 0)
  fx.render(callback, { enabled: true, blocked: false }); fx.emit('focus'); await fx.flush()
  assert.equal(calls, 1); fx.dispose()
})

test('queued refresh rechecks visibility, editor state and latest account callback', async () => {
  const fx = hookFixture(); let old = 0, current = 0
  fx.render(() => { old++ }); fx.emit('focus')
  fx.render(() => { current++ }, { blocked: true }); await fx.flush()
  assert.equal(old + current, 0)
  fx.render(() => { current++ }); fx.emit('focus')
  fx.document.visibilityState = 'hidden'; await fx.flush(); assert.equal(current, 0)
  fx.document.visibilityState = 'visible'; fx.emit('visibilitychange')
  fx.render(() => { current += 2 }); await fx.flush()
  assert.equal(old, 0); assert.equal(current, 2); fx.dispose()
})

test('unmount cancels queued work and removes both event listeners', async () => {
  const fx = hookFixture(); let calls = 0
  fx.render(() => { calls++ }); fx.emit('focus'); fx.dispose(); await fx.flush()
  fx.emit('focus'); fx.emit('visibilitychange'); await fx.flush()
  assert.equal(calls, 0)
})

test('synchronous and asynchronous refresh failures do not break future refreshes', async () => {
  const fx = hookFixture(); let calls = 0
  fx.render(() => { calls++; throw new Error('Synthetic synchronous failure') })
  fx.emit('focus'); await fx.flush()
  fx.advance(1000); fx.render(() => { calls++; return Promise.reject(new Error('Synthetic asynchronous failure')) })
  fx.emit('focus'); await fx.flush()
  fx.advance(1000); fx.render(() => { calls++ }); fx.emit('focus'); await fx.flush()
  assert.equal(calls, 3); fx.dispose()
})
