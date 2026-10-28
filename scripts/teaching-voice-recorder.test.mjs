import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const helperSource = await readFile(new URL('src/lib/teachingVoiceRecording.ts', root), 'utf8')
const componentSource = await readFile(new URL('src/components/teaching/TeachingVoiceRecorder.tsx', root), 'utf8')
function load(source, imports = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, require(name) { assert.ok(name in imports, name); return imports[name] }, ...globals })
  return exports
}
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function captureFixture(options = {}) {
  let now = 0, stopped = 0, permissions = 0
  const states = [], times = [], completed = [], errors = [], recorders = [], intervals = new Map(), timeouts = new Map()
  const listeners = new Map(), constraints = []
  const track = { readyState: 'live', stop() { stopped++; this.readyState = 'ended' }, addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) } }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  class Recorder {
    static isTypeSupported(mime) { return (options.supported ?? ['audio/webm;codecs=opus']).includes(mime) }
    constructor(source, settings) { assert.equal(source, stream); this.settings = plain(settings); this.mimeType = options.actualMime ?? settings.mimeType ?? 'audio/mp4'; this.state = 'inactive'; recorders.push(this); if (options.constructorError) throw options.constructorError }
    start(slice) { this.slice = slice; if (options.startError) throw options.startError; this.state = 'recording' }
    data(bytes, type = this.mimeType) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type }) }) }
    stop() { this.state = 'inactive'; if (!options.stopWithoutEvent) { this.data(options.finalBytes ?? 3); this.onstop?.() } }
  }
  let sequence = 0
  const api = load(helperSource, {}, {
    MediaRecorder: options.noRecorder ? undefined : Recorder,
    navigator: { mediaDevices: { async getUserMedia(request) { permissions++; constraints.push(plain(request)); if (options.permissionError) throw options.permissionError; return options.permission?.promise ?? stream } } },
    window: { isSecureContext: options.secure ?? true }, Blob, File,
    performance: { now: () => now }, Date,
    setInterval(fn, ms) { const id = ++sequence; intervals.set(id, { fn, ms }); return id }, clearInterval(id) { intervals.delete(id) },
    setTimeout(fn, ms) { const id = ++sequence; timeouts.set(id, { fn, ms }); return id }, clearTimeout(id) { timeouts.delete(id) },
  })
  const capture = api.createTeachingVoiceCapture({ onState: value => states.push(value), onTime: value => times.push(value), onComplete: value => completed.push(value), onError: value => errors.push(value) })
  return { api, capture, stream, track, recorders, constraints, listeners, states, times, completed, errors, intervals, timeouts,
    get permissions() { return permissions }, get stopped() { return stopped }, tick(value) { now = value; [...intervals.values()].forEach(timer => timer.fn()) }, limit() { [...timeouts.values()].find(timer => timer.ms === 300000)?.fn() } }
}

test('microphone starts only on explicit start and waits for final data before completing an audio-only recording', async () => {
  const fx = captureFixture()
  assert.equal(fx.permissions, 0)
  await fx.capture.start()
  assert.deepEqual(fx.constraints, [{ audio: true, video: false }])
  assert.deepEqual(fx.states, ['requesting', 'recording'])
  assert.equal(fx.recorders[0].settings.mimeType, 'audio/webm;codecs=opus')
  fx.recorders[0].data(5); fx.tick(2300); fx.capture.stop()
  assert.deepEqual(fx.states, ['requesting', 'recording', 'processing', 'idle'])
  assert.equal(fx.completed.length, 1)
  assert.equal(fx.completed[0].file.type, 'audio/webm')
  assert.equal(fx.completed[0].file.size, 8)
  assert.equal(fx.completed[0].file.name, 'voice-reply.webm')
  assert.equal(fx.completed[0].durationSeconds, 3)
  assert.ok(fx.stopped > 0)
  assert.equal(fx.listeners.size + fx.intervals.size + fx.timeouts.size, 0)
  fx.capture.dispose()
})

test('format selection is feature based and supports Ogg plus Safari MP4 with honest file MIME', async () => {
  for (const [supported, mime, ext] of [
    [['audio/ogg;codecs=opus'], 'audio/ogg', 'ogg'],
    [['audio/mp4'], 'audio/mp4', 'm4a'],
    [[], 'audio/mp4', 'm4a'],
  ]) {
    const fx = captureFixture({ supported }); await fx.capture.start(); fx.tick(1000); fx.capture.stop()
    assert.equal(fx.completed[0].file.type, mime)
    assert.equal(fx.completed[0].file.name, `voice-reply.${ext}`)
    assert.equal(fx.recorders[0].settings.audioBitsPerSecond, 64000)
    fx.capture.dispose()
  }
})

test('cancel or disposal during the permission dialog stops a late microphone stream and emits no file', async () => {
  for (const action of ['cancel', 'dispose']) {
    const permission = deferred(), fx = captureFixture({ permission })
    const start = fx.capture.start()
    assert.equal(fx.states.at(-1), 'requesting')
    fx.capture[action]()
    const stateCount = fx.states.length
    permission.resolve(fx.stream); await start
    assert.ok(fx.stopped > 0)
    assert.equal(fx.completed.length + fx.errors.length + fx.recorders.length, 0)
    assert.equal(fx.states.length, stateCount)
  }
})

test('permission refusals, unavailable microphone and recorder failures settle with a useful error and no leaked stream', async () => {
  for (const [options, message] of [
    [{ permissionError: { name: 'NotAllowedError' } }, /Дозвольте доступ/],
    [{ permissionError: { name: 'NotFoundError' } }, /Мікрофон не знайдено/],
    [{ permissionError: { name: 'NotReadableError' } }, /інший застосунок/],
    [{ startError: Error('recorder refused') }, /Не вдалося записати/],
    [{ constructorError: Error('constructor refused') }, /Не вдалося записати/],
  ]) {
    const fx = captureFixture(options); await fx.capture.start()
    assert.match(fx.errors[0], message); assert.equal(fx.states.at(-1), 'idle')
    assert.equal(fx.completed.length, 0)
    assert.equal(fx.listeners.size + fx.intervals.size + fx.timeouts.size, 0)
    if (options.startError || options.constructorError) assert.ok(fx.stopped > 0)
    fx.capture.dispose()
  }
  const insecure = captureFixture({ secure: false }); await insecure.capture.start(); assert.equal(insecure.permissions, 0); assert.match(insecure.errors[0], /HTTPS/)
  const unsupported = captureFixture({ noRecorder: true }); await unsupported.capture.start(); assert.equal(unsupported.permissions, 0); assert.match(unsupported.errors[0], /не підтримує запис/)
})

test('five-minute limit stops capture, while oversize or badly delayed recordings are discarded', async () => {
  const max = captureFixture(); await max.capture.start(); max.tick(300000); max.limit()
  assert.equal(max.completed[0].durationSeconds, 300); assert.ok(max.stopped > 0)
  const oversized = captureFixture(); await oversized.capture.start(); oversized.tick(1000); oversized.recorders[0].data(10 * 1024 * 1024 + 1)
  assert.equal(oversized.completed.length, 0); assert.match(oversized.errors[0], /10 МБ/); assert.equal(oversized.states.at(-1), 'idle')
  const delayed = captureFixture(); await delayed.capture.start(); delayed.tick(340000); delayed.limit()
  assert.equal(delayed.completed.length, 0); assert.match(delayed.errors[0], /довше 5 хвилин/)
})

test('microphone track ending completes once and explicit cancellation discards a recording without final callback', async () => {
  const ended = captureFixture(); await ended.capture.start(); ended.tick(1500); ended.listeners.get('ended')()
  assert.equal(ended.completed.length, 1); assert.equal(ended.completed[0].durationSeconds, 2)
  ended.capture.stop(); assert.equal(ended.completed.length, 1)
  const cancelled = captureFixture(); await cancelled.capture.start(); cancelled.recorders[0].data(20); cancelled.capture.cancel()
  assert.equal(cancelled.completed.length, 0); assert.ok(cancelled.stopped > 0); assert.equal(cancelled.states.at(-1), 'idle')
  cancelled.capture.dispose()
})

test('a missing final browser event cannot leave recording busy forever or keep the microphone open', async () => {
  const fx = captureFixture({ stopWithoutEvent: true })
  await fx.capture.start(); fx.tick(1500); fx.capture.stop()
  assert.equal(fx.states.at(-1), 'processing'); assert.ok(fx.stopped > 0)
  ;[...fx.timeouts.values()].find(timer => timer.ms === 5000).fn()
  assert.equal(fx.states.at(-1), 'idle'); assert.equal(fx.completed.length, 0)
  assert.match(fx.errors[0], /завершити запис/)
  assert.equal(fx.intervals.size + fx.timeouts.size, 0)
})

const jsx = (type, props) => ({ type, props })
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children)
function componentFixture(value = null) {
  let position = 0, dirty = false, tree, callbacks, destroyed = 0, starts = 0, cancels = 0
  const cells = [], effects = [], changed = [], busy = [], created = [], revoked = []
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    useState(initial) { const index = position++; cells[index] ??= { value: initial }; return [cells[index].value, update => { const next = typeof update === 'function' ? update(cells[index].value) : update; if (!Object.is(next, cells[index].value)) { cells[index].value = next; dirty = true } }] },
    useRef(initial) { const index = position++; cells[index] ??= { current: initial }; return cells[index] },
    useEffect(callback, deps) { const index = position++; if (!cells[index] || !same(cells[index].deps, deps)) { const previous = cells[index]; cells[index] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[index].cleanup = callback() }) } },
  }
  const helper = load(helperSource, {}, { Date })
  const api = load(componentSource, {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': Object.fromEntries(['Loader2', 'Mic', 'RotateCcw', 'Square', 'Trash2', 'X'].map(v => [v, v])),
    './TeachingUI': { TeachingButton: 'TeachingButton' },
    '../../lib/teachingVoiceRecording': {
      ...helper,
      createTeachingVoiceCapture(next) {
        callbacks = next
        return { async start() { starts++; callbacks.onState('requesting') }, stop() { callbacks.onState('processing') }, cancel() { cancels++; callbacks.onState('idle') }, dispose() { destroyed++ } }
      },
    },
  }, {
    URL: { createObjectURL(file) { created.push(file); return `blob:voice-${created.length}` }, revokeObjectURL(url) { revoked.push(url) } },
  })
  const props = { value, onChange(next) { changed.push(next) }, onRecordingChange(next) { busy.push(next) } }
  function render() { for (let i = 0; i < 20; i++) { dirty = false; position = 0; tree = api.TeachingVoiceRecorder(props); effects.splice(0).forEach(run => run()); if (!dirty) return } throw Error('Render loop') }
  render()
  return { props, render, changed, busy, created, revoked, get tree() { return tree }, get callbacks() { return callbacks }, get starts() { return starts }, get cancels() { return cancels }, get destroyed() { return destroyed }, button(label) { const result = nodes(tree).find(node => node.type === 'TeachingButton' && text(node).trim() === label); assert.ok(result, label); return result }, unmount() { cells.forEach(cell => cell?.cleanup?.()) } }
}

test('recording UI leaves microphone off on mount and disables submission through permission, capture and finalization states', () => {
  const fx = componentFixture()
  assert.equal(fx.starts, 0)
  fx.button('Записати голосове').props.onClick(); fx.render()
  assert.equal(fx.starts, 1); assert.equal(fx.busy.at(-1), true); assert.match(text(fx.tree), /Дозвольте доступ/)
  fx.callbacks.onState('recording'); fx.callbacks.onTime(42); fx.render()
  assert.match(text(fx.tree), /0:42\s+\/ 5:00/)
  fx.button('Зупинити запис').props.onClick(); fx.render()
  assert.equal(fx.busy.at(-1), true); assert.match(text(fx.tree), /Готуємо запис/)
  fx.callbacks.onState('idle'); fx.render(); assert.equal(fx.busy.at(-1), false)
  fx.unmount(); assert.equal(fx.destroyed, 1)
})

test('audio preview is local without autoplay, and its URL is revoked on replacement and unmount', () => {
  const first = { file: new File(['demo'], 'voice.webm', { type: 'audio/webm' }), durationSeconds: 17 }, fx = componentFixture(first)
  const audio = nodes(fx.tree).find(node => node.type === 'audio')
  assert.equal(audio.props.src, 'blob:voice-1'); assert.equal(audio.props.controls, true); assert.equal(audio.props.preload, 'metadata'); assert.equal(audio.props.autoPlay, undefined)
  fx.props.value = { file: new File(['other'], 'voice.m4a', { type: 'audio/mp4' }), durationSeconds: 20 }; fx.render()
  assert.deepEqual(fx.revoked, ['blob:voice-1'])
  fx.button('Прибрати запис').props.onClick(); assert.equal(fx.changed.at(-1), null)
  fx.unmount(); assert.deepEqual(fx.revoked, ['blob:voice-1', 'blob:voice-2']); assert.equal(fx.busy.at(-1), false)
})

test('a disabled recorder cancels capture and keeps all record/discard actions disabled', () => {
  const fx = componentFixture({ file: new File(['demo'], 'voice.webm', { type: 'audio/webm' }), durationSeconds: 17 })
  fx.callbacks.onState('recording'); fx.render(); fx.props.disabled = true; fx.render()
  assert.equal(fx.cancels, 1); assert.equal(fx.busy.at(-1), false)
  assert.equal(fx.button('Перезаписати').props.disabled, true)
  assert.equal(fx.button('Прибрати запис').props.disabled, true)
  fx.unmount()
})
