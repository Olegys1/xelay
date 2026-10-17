import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const source = await read('src/components/halloween/HalloweenBadge.tsx')
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const earned = (showBadge = true) => ({ badgeEarned: true, showBadge })
const walk = (node, predicate) => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => walk(child, predicate))
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)]
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node?.props?.children ?? '')

// Execute the actual settings component with deterministic hook lifetimes and
// deferred RPCs. These tests never contact Supabase or modify a real account.
function fixture() {
  let owner = 'alice', cursor = 0, dirty = true, output, timerId = 0
  const cells = [], effects = [], loads = [], saves = [], timers = new Map()
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    useState(initial) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[index].value, next => { cells[index].value = typeof next === 'function' ? next(cells[index].value) : next; dirty = true }] },
    useRef(initial) { const index = cursor++; if (!cells[index]) cells[index] = { current: initial }; return cells[index] },
    useEffect(setup, dependencies) { const index = cursor++; if (!cells[index] || !same(cells[index].dependencies, dependencies)) { const previous = cells[index]; const cell = cells[index] = { dependencies, setup, cleanup: previous?.cleanup }; effects.push(() => { cell.cleanup?.(); cell.cleanup = setup() }) } },
  }
  const module = { exports: {} }
  const imports = {
    react: hooks, 'react/jsx-runtime': jsx,
    '../../lib/halloweenHunt': {
      HALLOWEEN_BADGES_CHANGED: 'badge-change', loadHalloweenBadge: async () => false,
      loadMyHalloweenHunt(signal) { const task = { ...defer(), signal, owner }; loads.push(task); return task.promise },
      saveMyHalloweenBadge(visible, signal) { const task = { ...defer(), visible, signal, owner }; saves.push(task); return task.promise },
    },
    '../BadgeInfo': { BadgeInfo: 'badge-info' }, './HalloweenPumpkin': { PumpkinArt: 'pumpkin-art' },
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, AbortController, Error,
    setTimeout(callback, milliseconds) { assert.equal(milliseconds, 12_000); const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) { assert.ok(name in imports, name); return imports[name] },
  })
  const render = () => {
    for (let loops = 0; dirty; loops++) {
      assert.ok(loops < 20, 'bounded hook render')
      dirty = false; cursor = 0; output = module.exports.HalloweenBadgeSettings({ userId: owner })
      while (effects.length) effects.shift()()
    }
    return output
  }
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); render() }
  const input = () => walk(render(), node => node.type === 'input')[0]
  const retry = () => walk(render(), node => node.type === 'button' && text(node).startsWith('Повторити'))[0]
  const cleanup = () => { for (const cell of cells) cell?.cleanup?.() }
  render()
  return { loads, saves, timers, render, settle, input, retry, cleanup, content: () => text(render()),
    changeOwner(value) { owner = value; dirty = true; render() },
    strictRecreate() { for (const cell of cells) if (cell?.setup) { cell.cleanup?.(); cell.cleanup = cell.setup() }; render() },
    expire() { for (const callback of [...timers.values()]) callback() },
  }
}

test('badge settings expose loading and an unearned disabled row instead of disappearing', async () => {
  const f = fixture()
  assert.match(f.content(), /Завантажуємо бейдж/)
  f.loads[0].resolve({ badgeEarned: false, showBadge: true }); await f.settle()
  assert.match(f.content(), /Бейдж із гарбузом · ще не отримано/)
  assert.match(f.content(), /Зберіть усі 10 гарбузиків/)
  assert.equal(f.input().props.disabled, true); assert.equal(f.input().props.checked, false)
  f.input().props.onChange({ target: { checked: true } }); assert.equal(f.saves.length, 0)
  f.cleanup()
})

test('failed loading has an explicit retry and does not claim the badge is unearned', async () => {
  const f = fixture()
  f.loads[0].reject(new Error('З’єднання недоступне')); await f.settle()
  assert.match(f.content(), /З’єднання недоступне/); assert.doesNotMatch(f.content(), /ще не отримано/)
  assert.ok(f.retry()); f.retry().props.onClick(); f.render()
  assert.equal(f.loads.length, 2)
  f.loads[1].resolve(earned()); await f.settle()
  assert.equal(f.input().props.disabled, false); assert.equal(f.input().props.checked, true)
  f.cleanup()
})

test('hide and restore wait for server confirmation and retain the earned badge', async () => {
  const f = fixture(); f.loads[0].resolve(earned()); await f.settle()
  f.input().props.onChange({ target: { checked: false } }); f.render()
  assert.equal(f.saves[0].visible, false); assert.equal(f.input().props.checked, true); assert.equal(f.input().props.disabled, true)
  f.saves[0].resolve(earned(false)); await f.settle()
  assert.equal(f.input().props.checked, false); assert.equal(f.input().props.disabled, false)
  f.input().props.onChange({ target: { checked: true } }); f.saves[1].resolve(earned(true)); await f.settle()
  assert.equal(f.saves[1].visible, true); assert.equal(f.input().props.checked, true)
  f.cleanup()
})

test('failed saving preserves the last server state and retries the same visibility choice', async () => {
  const f = fixture(); f.loads[0].resolve(earned()); await f.settle()
  f.input().props.onChange({ target: { checked: false } }); f.saves[0].reject(new Error('Не збережено')); await f.settle()
  assert.equal(f.input().props.checked, true); assert.match(f.content(), /Не збережено/)
  const retry = f.retry(); retry.props.onClick(); retry.props.onClick()
  assert.equal(f.saves.length, 2); assert.equal(f.saves[1].visible, false)
  f.saves[1].resolve(earned(false)); await f.settle()
  assert.equal(f.input().props.checked, false)
  f.cleanup()
})

test('stalled loading and saving terminate after 12 seconds with a retry', async () => {
  const f = fixture(); f.expire(); await f.settle()
  assert.equal(f.loads[0].signal.aborted, true); assert.match(f.content(), /надто довго/); assert.ok(f.retry())
  f.retry().props.onClick(); f.render(); f.loads[1].resolve(earned()); await f.settle()
  f.input().props.onChange({ target: { checked: false } }); f.expire(); await f.settle()
  assert.equal(f.saves[0].signal.aborted, true); assert.equal(f.input().props.checked, true)
  assert.match(f.content(), /надто довго/); assert.ok(f.retry())
  f.cleanup()
})

test('account changes abort the old save and reject late results from the old owner', async () => {
  const f = fixture(); f.loads[0].resolve(earned()); await f.settle()
  f.input().props.onChange({ target: { checked: false } }); f.changeOwner('bob')
  assert.equal(f.saves[0].signal.aborted, true); assert.match(f.content(), /Завантажуємо бейдж/)
  f.loads[1].resolve({ badgeEarned: false, showBadge: false }); f.saves[0].resolve(earned(false)); await f.settle()
  assert.match(f.content(), /ще не отримано/); assert.equal(f.input().props.disabled, true)
  f.cleanup()
})

test('StrictMode effect recreation aborts the discarded load without clearing the replacement request', async () => {
  const f = fixture(); f.strictRecreate()
  assert.equal(f.loads.length, 2); assert.equal(f.loads[0].signal.aborted, true)
  f.loads[0].resolve({ badgeEarned: false, showBadge: false }); f.loads[1].resolve(earned()); await f.settle()
  assert.equal(f.input().props.checked, true)
  f.input().props.onChange({ target: { checked: false } }); assert.equal(f.saves.length, 1)
  f.cleanup(); assert.equal(f.saves[0].signal.aborted, true); await f.settle()
})

test('all current Halloween screens describe the reward as a badge with a pumpkin', async () => {
  for (const path of ['src/components/halloween/HalloweenExperience.tsx', 'src/pages/HalloweenPage.tsx', 'src/context/HalloweenHuntContext.tsx', 'src/components/halloween/HalloweenBadge.tsx']) {
    const copy = await read(path)
    assert.doesNotMatch(copy, /[Сс]вітний\s+(?:гарбузовий\s+)?бейдж/)
    assert.match(copy, /[Бб]ейдж із гарбузом/)
  }
})
