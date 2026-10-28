// Actual player component, local React lifecycle and fake signed URL provider.
// The harness can render before passive effects to check immediate scope gating.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/components/teaching/TeachingGradeVoicePlayer.tsx', import.meta.url), 'utf8')
const jsx = (type, props, key) => ({ type, props, key })
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
const text = value => value == null || typeof value === 'boolean' ? '' : typeof value !== 'object' ? String(value) : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture() {
  let index = 0, dirty = false, tree, attached = null, stateWrites = 0
  const cells = [], pending = [], provider = [], media = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initial) { const i = index++; cells[i] ??= { value: initial }; return [cells[i].value, update => { const next = typeof update === 'function' ? update(cells[i].value) : update; stateWrites++; if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true } }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; const cell = cells[i] = { deps, cleanup: previous?.cleanup }; pending.push(() => { previous?.cleanup?.(); cell.cleanup = callback() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports,
    require(name) {
      const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': { Headphones: 'Headphones', RefreshCw: 'RefreshCw' }, '../../lib/teaching': { teachingError: error => error.message }, './TeachingUI': { TeachingButton: 'TeachingButton' } }
      assert.ok(name in imports, `Known offline import ${name}`); return imports[name]
    },
  })
  function repository(label = 'first') {
    return { label, gradeVoiceUrl(requestId, voice) { const next = deferred(); provider.push({ ...next, requestId, voice, label }); return next.promise } }
  }
  const props = { repository: repository(), requestId: 'synthetic-request', userId: 'synthetic-student', voice: { storage_path: 'synthetic-request/synthetic-teacher/voice.webm', mime_type: 'audio/webm', size: 23, duration_seconds: 19 } }
  function commitMedia() {
    const next = nodes(tree).find(node => node.type === 'audio')
    if (attached && (!next || next.key !== attached.key)) { attached.ref.current = null; attached = null }
    if (!next) return
    if (!attached) {
      const element = { key: next.key, ref: next.props.ref, paused: 0, removed: [], loads: 0,
        pause() { this.paused++ }, removeAttribute(value) { this.removed.push(value) }, load() { this.loads++ } }
      attached = element; media.push(element)
    }
    next.props.ref.current = attached
  }
  function beforeEffects() { index = 0; dirty = false; tree = module.exports.TeachingGradeVoicePlayer(props); commitMedia(); return tree }
  function effects() { pending.splice(0).forEach(effect => effect()) }
  function render() { for (let pass = 0; pass < 30; pass++) { beforeEffects(); effects(); if (!dirty) return tree } throw Error('Unstable player fixture') }
  async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); render() } }
  render()
  return { props, provider, media, repository, beforeEffects, effects, render, settle,
    get tree() { return tree }, get stateWrites() { return stateWrites },
    audio() { return nodes(tree).find(node => node.type === 'audio') },
    button(label) { const found = nodes(tree).find(node => node.type === 'TeachingButton' && text(node) === label); assert.ok(found, label); return found },
    unmount() { if (attached) attached.ref.current = null; attached = null; cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('player requests a signed URL only after listening is explicitly requested, without autoplay or eager media loading', async () => {
  const fx = fixture()
  assert.equal(fx.provider.length, 0); assert.equal(fx.audio(), undefined)
  fx.button('Прослухати відповідь').props.onClick(); fx.render()
  assert.equal(fx.provider.length, 1); assert.equal(fx.provider[0].requestId, fx.props.requestId)
  assert.equal(fx.provider[0].voice, fx.props.voice)
  assert.equal(fx.button('Прослухати відповідь').props.busy, true)
  fx.provider[0].resolve('https://synthetic.test/private/first?token=FAKE'); await fx.settle()
  const audio = fx.audio()
  assert.equal(audio.props.src, 'https://synthetic.test/private/first?token=FAKE')
  assert.equal(audio.props.controls, true); assert.equal(audio.props.preload, 'none'); assert.equal(audio.props.autoPlay, undefined)
  assert.equal(fx.provider.length, 1)
  fx.unmount()
})

test('actor, request, voice path and repository switches hide the old URL before passive effects and stop old playback', async () => {
  for (const change of [
    fx => { fx.props.userId = 'another-student' },
    fx => { fx.props.requestId = 'another-request' },
    fx => { fx.props.voice = { ...fx.props.voice, storage_path: 'another/path/voice.webm' } },
    fx => { fx.props.repository = fx.repository('replacement') },
  ]) {
    const fx = fixture(); fx.button('Прослухати відповідь').props.onClick(); fx.render()
    fx.provider[0].resolve('https://synthetic.test/private/old?token=FAKE'); await fx.settle()
    const old = fx.media[0]
    assert.ok(fx.audio())
    change(fx); fx.beforeEffects()
    assert.equal(fx.audio(), undefined, 'Old audio must disappear in the first changed-scope render')
    assert.ok(!text(fx.tree).includes('Не вдалося'))
    fx.effects(); fx.render()
    assert.equal(old.paused, 1); assert.deepEqual(old.removed, ['src']); assert.equal(old.loads, 1)
    assert.equal(fx.provider.length, 1, 'A new scope must not request its URL automatically')
    fx.unmount()
  }
})

test('a late URL or provider error from the previous actor is ignored even before old effect cleanup runs', async () => {
  for (const failure of [false, true]) {
    const fx = fixture(); fx.button('Прослухати відповідь').props.onClick(); fx.render()
    fx.props.userId = 'new-student'; fx.beforeEffects()
    const previousWrites = fx.stateWrites
    if (failure) fx.provider[0].reject(Error('OLD_PRIVATE_FAILURE'))
    else fx.provider[0].resolve('https://synthetic.test/private/old?token=FAKE')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(fx.stateWrites, previousWrites)
    assert.equal(fx.audio(), undefined); assert.ok(!text(fx.tree).includes('OLD_PRIVATE_FAILURE'))
    fx.effects(); fx.render()
    fx.button('Прослухати відповідь').props.onClick(); fx.render()
    fx.provider[1].resolve('https://synthetic.test/private/new?token=FAKE'); await fx.settle()
    assert.equal(fx.audio().props.src, 'https://synthetic.test/private/new?token=FAKE')
    fx.unmount()
  }
})

test('unmount pauses and detaches audio, and a pending refresh cannot update the unmounted player', async () => {
  const fx = fixture(); fx.button('Прослухати відповідь').props.onClick(); fx.render()
  fx.provider[0].resolve('https://synthetic.test/private/first?token=FAKE'); await fx.settle()
  const old = fx.media[0]
  fx.button('Оновити доступ до запису').props.onClick(); fx.render()
  fx.unmount()
  const writes = fx.stateWrites
  fx.provider[1].resolve('https://synthetic.test/private/late?token=FAKE')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(fx.stateWrites, writes)
  assert.equal(old.paused, 1); assert.deepEqual(old.removed, ['src']); assert.equal(old.loads, 1)
})

test('an error event from detached audio cannot leak an error into a new actor or repository view', async () => {
  const fx = fixture(); fx.button('Прослухати відповідь').props.onClick(); fx.render()
  fx.provider[0].resolve('https://synthetic.test/private/first?token=FAKE'); await fx.settle()
  const detachedError = fx.audio().props.onError
  fx.props.repository = fx.repository('new'); fx.beforeEffects()
  const writes = fx.stateWrites
  detachedError()
  assert.equal(fx.stateWrites, writes)
  fx.effects(); fx.render(); assert.equal(fx.audio(), undefined)
  assert.ok(!text(fx.tree).includes('Не вдалося відтворити'))
  fx.unmount()
})
