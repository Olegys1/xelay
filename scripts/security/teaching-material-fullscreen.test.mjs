import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import * as ReactJsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { createTeachingMaterialFullscreen, teachingMaterialFitScale } from '../../src/lib/teachingMaterialFullscreen.ts'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fullscreenFixture(mode = 'native') {
  const events = new Map(), states = [], pending = [], exits = [], focus = []
  let now = 1000
  const document = { fullscreenElement: null, fullscreenEnabled: true,
    addEventListener(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener) },
    removeEventListener(name, listener) { events.get(name)?.delete(listener) },
    exitFullscreen() { exits.push(document.fullscreenElement); document.fullscreenElement = null; fire(); return Promise.resolve() },
  }
  const fire = () => { for (const key of ['fullscreenchange', 'webkitfullscreenchange']) for (const listener of events.get(key) || []) listener() }
  const target = {}
  if (mode !== 'fallback') target.requestFullscreen = function () {
    assert.equal(this, target)
    if (mode === 'throw') throw Error('Denied')
    if (mode === 'reject') return Promise.reject(Error('Denied'))
    const request = deferred(); pending.push(request); return request.promise
  }
  const control = createTeachingMaterialFullscreen({ document, target: () => target, change: value => states.push(value), restoreFocus: () => focus.push(true), now: () => now })
  return { document, target, states, pending, exits, events, control, fire, focus, advance: delta => { now += delta }, activate(index = 0) { document.fullscreenElement = target; fire(); pending[index]?.resolve() } }
}

test('native fullscreen comes from an explicit request and Escape first collapses without closing the viewer', async () => {
  const f = fullscreenFixture(); assert.equal(f.pending.length, 0)
  f.control.enter(); assert.equal(f.pending.length, 1); assert.deepEqual(f.states.at(-1), { expanded: true, native: false })
  f.activate(); await flush(); assert.deepEqual(f.states.at(-1), { expanded: true, native: true })
  f.document.fullscreenElement = null; f.fire()
  assert.deepEqual(f.states.at(-1), { expanded: false, native: false })
  assert.equal(f.control.escape(), true, 'the same browser Escape must not also cancel the modal')
  f.advance(300); assert.equal(f.control.escape(), false)
  assert.ok(f.focus.length); f.control.dispose()
  assert.equal([...f.events.values()].every(listeners => listeners.size === 0), true)
})

test('unsupported, rejected and throwing fullscreen requests keep an operable expanded fallback', async () => {
  for (const mode of ['fallback', 'reject', 'throw']) {
    const f = fullscreenFixture(mode); f.control.enter(); await flush()
    assert.deepEqual(f.states.at(-1), { expanded: true, native: false }, mode)
    assert.equal(f.control.escape(), true); assert.deepEqual(f.states.at(-1), { expanded: false, native: false })
    f.control.dispose()
  }
})

test('late requests cannot reopen a disposed viewer or exit a newer request on the same surface', async () => {
  const old = fullscreenFixture(); old.control.enter(); old.control.dispose(); old.activate(); await flush()
  assert.deepEqual(old.exits, [old.target]); assert.equal(old.document.fullscreenElement, null)
  const f = fullscreenFixture(); f.control.enter(); f.control.leave(); f.control.enter()
  f.activate(0); await flush(); assert.equal(f.exits.length, 0, 'old completion must not undo the current enter intent')
  f.activate(1); await flush(); assert.deepEqual(f.states.at(-1), { expanded: true, native: true })
  f.control.dispose(); assert.deepEqual(f.exits, [f.target])
})

test('a rejected newer request retains ownership when an older request already activated the same surface', async () => {
  const f = fullscreenFixture(); f.control.enter(); f.control.leave(); f.control.enter()
  f.activate(0); await flush(); f.pending[1].reject(Error('Second request denied')); await flush()
  assert.deepEqual(f.states.at(-1), { expanded: true, native: true })
  f.control.leave(); await flush(); assert.equal(f.document.fullscreenElement, null); assert.deepEqual(f.exits, [f.target])
  f.control.dispose()
})

test('rejected native exit keeps its owner and allows a later exit or cleanup to retry', async () => {
  const f = fullscreenFixture(); f.control.enter(); f.activate(); await flush()
  const exit = f.document.exitFullscreen; let refused = 0
  f.document.exitFullscreen = () => { refused++; return Promise.reject(Error('Busy browser')) }
  f.control.leave(); await flush()
  assert.equal(refused, 1); assert.deepEqual(f.states.at(-1), { expanded: true, native: true })
  f.document.exitFullscreen = exit; f.control.leave(); await flush()
  assert.equal(f.document.fullscreenElement, null); assert.deepEqual(f.exits, [f.target]); f.control.dispose()
})

test('the controller neither replaces nor exits another element fullscreen and supports WebKit void requests', async () => {
  const f = fullscreenFixture(), other = {}; f.document.fullscreenElement = other
  f.control.enter(); assert.equal(f.pending.length, 0); f.control.dispose(); assert.equal(f.exits.length, 0)
  const webkit = fullscreenFixture('fallback'); webkit.document.fullscreenEnabled = false
  webkit.target.webkitRequestFullscreen = () => { webkit.document.webkitFullscreenElement = webkit.target; webkit.fire() }
  delete webkit.document.exitFullscreen
  webkit.document.webkitExitFullscreen = () => { webkit.exits.push(webkit.document.webkitFullscreenElement); webkit.document.webkitFullscreenElement = null; webkit.fire() }
  webkit.control.enter(); await flush(); assert.deepEqual(webkit.states.at(-1), { expanded: true, native: true })
  webkit.control.leave(); assert.deepEqual(webkit.exits, [webkit.target]); webkit.control.dispose()
})

test('a deferred WebKit void activation after collapse exits only the cancelled viewer surface', async () => {
  const f = fullscreenFixture('fallback'); f.document.fullscreenEnabled = false
  f.target.webkitRequestFullscreen = () => {}
  f.document.webkitExitFullscreen = () => { f.exits.push(f.document.webkitFullscreenElement); f.document.webkitFullscreenElement = null; f.fire() }
  f.control.enter(); await flush()
  assert.deepEqual(f.states.at(-1), { expanded: true, native: false })
  f.control.leave(); await flush()
  f.document.webkitFullscreenElement = f.target; f.fire(); await flush()
  assert.deepEqual(f.states.at(-1), { expanded: false, native: false })
  assert.equal(f.document.webkitFullscreenElement, null); assert.deepEqual(f.exits, [f.target])
  const other = {}; f.document.webkitFullscreenElement = other; f.fire(); f.control.dispose()
  assert.equal(f.document.webkitFullscreenElement, other); assert.equal(f.exits.length, 1)
})

test('expanded fit accounts for both stage dimensions and zoom while normal fit ignores canvas-dependent height', () => {
  assert.equal(teachingMaterialFitScale(1600, 900, 1920, 720, 1), 0.8)
  assert.equal(teachingMaterialFitScale(900, 1600, 1920, 800, 1), 0.5)
  assert.equal(teachingMaterialFitScale(1600, 900, 1920, 720, 1.5), 1.2000000000000002)
  assert.equal(teachingMaterialFitScale(1600, 900, 850, null, 1), 850 / 1600)
  for (const args of [[0, 900, 500, 300, 1], [100, 100, 500, -1, 1], [100, 100, NaN, 300, 1]]) assert.throws(() => teachingMaterialFitScale(...args))
})

const source = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
function uiFixture() {
  const states = [], refs = [], effects = []; let index = 0, refIndex = 0
  const full = { expanded: false, native: false, toggle() {}, leave() {}, escape: () => true }
  const hooks = { ...React, useEffect: (callback, deps) => effects.push({ callback, deps }), useId: () => 'synthetic-heading', useRef: initial => refs[refIndex++] ??= { current: initial }, useState(initial) { const i = index++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] } }
  function load(path, imports) {
    const module = { exports: {} }, code = ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    runInNewContext(code, { module, exports: module.exports, window: { devicePixelRatio: 2 }, Promise, Math, AbortController, require(name) { if (name === 'react') return hooks; if (name === 'react/jsx-runtime') return ReactJsx; if (name.endsWith('.css')) return {}; if (!(name in imports)) throw Error('Unexpected viewer dependency: ' + name); return imports[name] } })
    return module.exports
  }
  const icons = new Proxy({}, { get: (_target, name) => props => React.createElement('svg', { ...props, 'data-icon': String(name) }) })
  const ui = load('src/components/teaching/TeachingUI.tsx', { 'lucide-react': icons, './TeachingContextGuide': { TeachingSectionHelp: () => null } })
  const viewer = load('src/components/teaching/TeachingMaterialViewer.tsx', { 'lucide-react': icons, 'pdfjs-dist/build/pdf.worker.min.mjs?url': { default: '/synthetic-worker.js' }, '../../lib/teachingMaterialPreview': { TEACHING_MATERIAL_CHUNK_BYTES: 1024 * 1024 }, '../../lib/teachingMaterialFullscreen': { teachingMaterialFitScale }, './useTeachingMaterialFullscreen': { useTeachingMaterialFullscreen: () => full }, './TeachingUI': { ...ui, TeachingModal: 'synthetic-modal' } })
  return { states, refs, effects, full, ui, render(props) { index = 0; refIndex = 0; effects.length = 0; return viewer.TeachingMaterialViewer(props) } }
}

test('the modal surface contains its title, explicit close and protected content; Escape interception is optional', () => {
  const f = uiFixture(); let closes = 0, intercept = true
  const props = { title: 'Synthetic material', children: React.createElement('canvas', { role: 'img' }), onClose: () => closes++, surfaceRef: { current: null }, headingActions: React.createElement('button', null, 'Fullscreen'), onEscape: () => intercept }
  const tree = f.ui.TeachingModal(props), html = renderToStaticMarkup(tree)
  assert.match(html, /teaching-modal-surface/); assert.match(html, /Synthetic material/); assert.match(html, /aria-label="Закрити"/); assert.match(html, /<canvas/)
  tree.props.onCancel({ preventDefault() {} }); assert.equal(closes, 0)
  nodes(tree).find(node => node.props?.['aria-label'] === 'Закрити').props.onClick(); assert.equal(closes, 1)
  intercept = false; tree.props.onCancel({ preventDefault() {} }); assert.equal(closes, 2)
  let ordinaryCloses = 0
  const ordinary = f.ui.TeachingModal({ title: 'Other dialog', children: 'Unchanged', onClose() { ordinaryCloses++ } })
  assert.doesNotMatch(renderToStaticMarkup(ordinary), /teaching-modal-surface/)
  ordinary.props.onCancel({ preventDefault() {} }); assert.equal(ordinaryCloses, 1)
  let busyEscapes = 0, busyCloses = 0
  const busy = f.ui.TeachingModal({ title: 'Busy dialog', children: 'Wait', busy: true, onEscape() { busyEscapes++; return true }, onClose() { busyCloses++ } })
  busy.props.onCancel({ preventDefault() {} }); assert.equal(busyEscapes, 0); assert.equal(busyCloses, 0)
  assert.equal(nodes(busy).find(node => node.props?.['aria-label'] === 'Закрити').props.disabled, true)
})

test('the actual viewer keeps page, zoom and protected canvas across fullscreen and serializes cancelled PDF renders', async () => {
  const f = uiFixture(), pending = [], requested = [], cancelled = [], watermarks = []
  const context = { save() {}, restore() {}, rotate() {}, fillText: text => watermarks.push(text) }
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context }
  const pdfPage = { getViewport: ({ scale }) => ({ width: 1600 * scale, height: 900 * scale }), render(options) { const task = deferred(); pending.push(task); requested.push(options); return { promise: task.promise, cancel() { cancelled.push(task) } } } }
  const pdf = { numPages: 2, async getPage(page) { assert.equal(page, 2); return pdfPage } }
  const info = { name: 'Synthetic.pdf', preview_kind: 'pdf', author_name: 'Synthetic author', viewer_name: 'Synthetic viewer' }
  f.states.push(info, pdf, null, 2, 0, '', 1.25, 850, 600, false, false, '')
  const repository = { materialFileInfo() { throw Error('Fullscreen must not reload file metadata') }, materialFileChunk() { throw Error('Fullscreen must not create raw file requests') } }
  const props = { publication: { id: 'synthetic-publication', version: 1 }, file: { name: 'Synthetic.pdf', storage_path: 'synthetic/path.pdf' }, repository, onClose() {} }
  let tree = f.render(props); nodes(tree).find(node => node.type === 'canvas').props.ref.current = canvas
  const originalLoadDependencies = f.effects[1].deps
  const cleanup = f.effects[2].callback(); await flush(); assert.equal(pending.length, 1)
  cleanup(); f.full.expanded = true; f.states[7] = 1920; f.states[8] = 720
  tree = f.render(props); const cleanupExpanded = f.effects[2].callback(); await flush()
  assert.equal(pending.length, 1, 'the second render must wait for cancellation to settle on the shared canvas')
  assert.equal(cancelled.length, 1); pending[0].reject(Error('Rendering cancelled')); await flush(); assert.equal(pending.length, 2)
  assert.deepEqual(f.effects[1].deps, originalLoadDependencies, 'expansion must not trigger file metadata or permission reads again')
  assert.equal(f.states[3], 2); assert.equal(f.states[6], 1.25)
  assert.ok(Math.abs(requested[1].viewport.width - 1600) < 0.01); assert.equal(requested[1].viewport.height, 900)
  assert.ok(canvas.width * canvas.height <= 16_000_000)
  assert.equal(watermarks.length, 0); pending[1].resolve(); await flush()
  assert.ok(watermarks.length > 0); assert.ok(watermarks.every(text => text === 'Synthetic author · Synthetic viewer')); assert.equal(f.states[11], '')
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /Сторінка 2 з 2/); assert.match(markup, /125%/); assert.doesNotMatch(markup, /<iframe|<object|<a\b|download=/)
  cleanupExpanded()
})
