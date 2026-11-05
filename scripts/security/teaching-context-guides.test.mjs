// Actual guide controller and delegated UI handlers; no server or real account.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
function compile(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Map, Set, JSON, Number, String, Object, Array, ...globals, require(name) { assert.ok(name in imports, 'Known guide dependency ' + name); return imports[name] } })
  return module.exports
}
function fixture(mode = 'controller') {
  const values = new Map(), writes = [], cells = [], effects = [], listeners = new Map()
  const storage = { getItem: key => values.get(key) || null, setItem(key, value) { values.set(key, value); writes.push({ key, value: JSON.parse(value) }) } }
  const helpers = compile(read('src/lib/teachingContextGuide.ts'), {}, { localStorage: storage })
  let index = 0, dirty = false, value, tree, mounted = true, context
  class Element {
    constructor({ kind = 'anchor', inside = true, disabled = false, topic } = {}) { Object.assign(this, { kind, inside, disabled, dataset: { teachingGuideLaunch: topic } }) }
    getClientRects() { return [1] }
    closest(selector) { if (selector === 'button[data-teaching-guide-launch]') return this.kind === 'button' ? this : null; if (selector === 'dialog[open]') return this.host || null; return null }
    matches() { return false }
  }
  const body = new Element({ kind: 'body', inside: false }), anchor = new Element(), root = new Element({ kind: 'root' })
  root.contains = element => element?.inside === true
  root.querySelector = selector => selector === 'dialog[open]' ? root.dialog || null : null
  root.querySelectorAll = () => [anchor]
  root.addEventListener = (name, fn) => listeners.set(name, fn)
  root.removeEventListener = name => listeners.delete(name)
  const same = (a, b) => a && b && a.length === b.length && a.every((item, at) => Object.is(item, b[at]))
  const hooks = {
    createContext: () => ({ Provider: 'GuideProvider' }), useContext: () => context,
    useState(initial) { const at = index++; cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[at].value, next => { if (!mounted) return; const result = typeof next === 'function' ? next(cells[at].value) : next; if (!Object.is(cells[at].value, result)) { cells[at].value = result; dirty = true } }] },
    useRef(initial) { const at = index++; return cells[at] ??= { current: initial } },
    useId() { const at = index++; return `guide-${at}` },
    useEffect(fn, deps) { const at = index++; if (!cells[at] || !same(cells[at].deps, deps)) { const prior = cells[at]; cells[at] = { deps, cleanup: prior?.cleanup }; effects.push(() => { prior?.cleanup?.(); cells[at].cleanup = fn() }) } },
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const api = compile(read('src/components/teaching/TeachingContextGuide.tsx'), { react: hooks, 'react-dom': { createPortal: node => node }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, name) => String(name) }), '../../lib/teachingContextGuide': helpers,
    '../../lib/homeGuideSteps': { placeHomeGuide() { throw Error('Coach geometry is covered separately and not a controller side effect') } }, './teaching-context-guide.css': {},
  }, { localStorage: storage, document: { activeElement: body, body }, HTMLElement: Element, Element,
    MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: fn => { fn(); return 1 }, cancelAnimationFrame() {} })
  const props = { userId: 'fictional-teacher-one', topic: 'overview', available: true, blocked: false, local: true, children: 'Fictional workspace' }
  const render = () => {
    for (let n = 0; n < 30; n++) {
      index = 0; dirty = false
      if (mode === 'controller') value = api.useTeachingContextGuideController(props)
      else { tree = api.TeachingContextGuideProvider(props); context = tree.props.value; value = context.controller; const wrapper = nodes(tree).find(node => node.props.className === 'teaching-guide-scope'); wrapper.props.ref.current = root }
      effects.splice(0).forEach(fn => fn())
      if (!dirty) return
    }
    throw Error('Guide hooks did not settle')
  }
  render()
  return { api, helpers, props, writes, values, root, Element, render, get current() { return value }, get tree() { return tree },
    click(options = {}) { let prevented = 0; const button = new Element({ kind: 'button', ...options }); button.host = options.host; listeners.get('click')({ target: button, preventDefault() { prevented++ } }); render(); return { button, prevented } },
    unmount() { mounted = false; cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('first visit offers help without automatically running it; pause, resume, finish and deliberate restart persist only UI choices', () => {
  const f = fixture()
  assert.equal(f.current.open, false); assert.equal(f.current.showOffer, true); assert.equal(f.writes.length, 0)
  f.current.start(); f.render(); assert.equal(f.current.open, true); assert.equal(f.current.active.step, 0)
  f.current.setStep(2); f.render(); f.current.pause(); f.render()
  assert.equal(f.current.open, false); assert.equal(f.current.showOffer, false)
  f.current.start(); f.render(); assert.equal(f.current.active.step, 2)
  f.current.finish(); f.render(); assert.equal(f.current.open, false)
  f.current.start(); f.render(); assert.equal(f.current.active.step, 0)
  for (const write of f.writes) assert.deepEqual(Object.keys(write.value).sort(), ['status', 'step'])
  f.unmount()
})

test('account and route changes isolate the guide before effects; captured callbacks cannot update a different guide', () => {
  const f = fixture(); f.current.start(); f.render(); f.current.setStep(1); f.render()
  const old = f.current
  f.props.userId = 'fictional-teacher-two'; f.render()
  assert.equal(f.current.open, false); assert.equal(f.current.showOffer, true)
  const before = f.writes.length
  old.setStep(4); old.finish(); old.pause(); assert.equal(old.start(), false); f.render(); assert.equal(f.writes.length, before)
  f.current.start(); f.render(); const second = f.current
  f.props.topic = 'grades'; f.render(); assert.equal(f.current.open, false)
  second.finish(); f.render(); assert.equal(f.writes.length, before + 1)
  f.current.start(); f.render(); assert.equal(f.current.active.topic, 'grades')
  second.setStep(3); f.render(); assert.equal(f.current.active.step, 0)
  f.unmount()
})

test('pending or busy workspace never opens a tour, and a running guide pauses without resuming into an active operation', () => {
  const f = fixture(); f.props.available = false; f.render()
  assert.equal(f.current.showOffer, false); assert.equal(f.current.start(), false)
  f.props.available = true; f.render(); f.current.start('tests'); f.render(); assert.equal(f.current.open, true)
  f.props.blocked = true; f.render(); assert.equal(f.current.open, false); assert.equal(f.current.active, null)
  f.props.blocked = false; f.render(); assert.equal(f.current.open, false)
  f.current.start('tests'); f.render(); assert.equal(f.current.active.topic, 'tests')
  f.props.available = false; f.render(); assert.equal(f.current.open, false); assert.equal(f.current.active, null)
  f.props.available = true; f.render(); assert.equal(f.current.open, false, 'a recovered workspace does not resume a guide by itself')
  f.unmount()
})

test('dismissing the small offer does not mark every topic complete, and reloading never starts a stored active topic', () => {
  const f = fixture(); f.current.dismissOffer(); f.render(); assert.equal(f.current.showOffer, false)
  assert.equal(f.helpers.readTeachingGuideProgress(f.helpers.teachingGuideKey(f.props.userId, 'tests', true)), null)
  f.current.start('tests'); f.render(); f.current.setStep(2); f.render()
  f.props.topic = 'tests'; f.render(); assert.equal(f.current.open, false)
  f.current.start('tests'); f.render(); assert.equal(f.current.active.step, 2)
  f.unmount()
})

test('an old callback cannot pause or complete a newly started topic in the same account', () => {
  const f = fixture(); f.current.start(); f.render(); const old = f.current
  f.current.pause(); f.render(); f.current.start('grades'); f.render()
  const before = f.writes.length
  old.finish(); old.pause(); old.setStep(3); f.render()
  assert.equal(f.current.active.topic, 'grades'); assert.equal(f.current.active.step, 0); assert.equal(f.writes.length, before)
  f.unmount()
})

test('manual hints in a native dialog stay in that dialog; disabled, foreign and unknown launchers do nothing', () => {
  const f = fixture('provider')
  const dialog = new f.Element({ kind: 'dialog' }); dialog.open = true; dialog.querySelectorAll = () => [new f.Element()]; f.root.dialog = dialog
  let result = f.click({ topic: 'test-review' }); assert.equal(result.prevented, 1); assert.equal(f.current.open, false, 'outside launcher cannot escape an open native dialog')
  result = f.click({ topic: 'test-review', host: dialog }); assert.equal(result.prevented, 1); assert.equal(f.current.open, true)
  assert.ok(nodes(f.tree).some(node => node.props.host === dialog && node.props.steps.length > 0), 'coach stays inside native dialog top layer')
  f.current.pause(); f.render(); f.root.dialog = null; f.click({ topic: 'tests' }); assert.equal(f.current.open, true)
  f.current.pause(); f.render(); const before = f.writes.length
  f.click({ topic: 'tests', disabled: true }); f.click({ topic: 'tests', inside: false }); f.click({ topic: 'untrusted-topic' })
  assert.equal(f.writes.length, before); assert.equal(f.current.open, false)
  f.unmount()
})

test('every cabinet block has a short route with exact helpful copy; timing, variant freezing and publication remain explained separately', () => {
  const f = fixture()
  for (const topic of f.helpers.TEACHING_GUIDE_TOPICS) {
    const steps = f.helpers.teachingGuideSteps(topic)
    assert.ok(steps.length >= 2 && steps.length <= 5, topic)
    assert.equal(new Set(steps.map(step => step.id)).size, steps.length)
    assert.ok(steps.every(step => step.target && step.title && step.text.length > 50))
  }
  assert.match(text(f.helpers.teachingGuideSteps('test-editor').map(step => step.text)), /3 із набору 20|3.*20/)
  assert.match(text(f.helpers.teachingGuideSteps('test-review').map(step => step.text)), /активних спроб немає/)
  assert.match(text(f.helpers.teachingGuideSteps('test-review').map(step => step.text)), /чернетки журналу/)
  assert.equal(f.helpers.normalizeTeachingGuideProgress({ status: 'active', step: -1 }), null)
  assert.equal(f.helpers.normalizeTeachingGuideProgress({ status: 'active', step: 1000 }), null)
  assert.equal(f.helpers.normalizeTeachingGuideProgress({ status: 'active', step: 1.1 }), null)
  assert.notEqual(f.helpers.teachingGuideKey('person', 'overview', false), f.helpers.teachingGuideKey('person', 'overview', true))
  assert.deepEqual(plain(f.helpers.normalizeTeachingGuideProgress({ status: 'paused', step: 1, privateText: 'never stored' })), { status: 'paused', step: 1 })
  f.unmount()
})
