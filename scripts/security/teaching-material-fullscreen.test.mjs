import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import * as ReactJsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { createTeachingMaterialFullscreen, teachingMaterialFitScale } from '../../src/lib/teachingMaterialFullscreen.ts'
import { PROFILE_NAME_MAX_LENGTH } from '../../src/lib/profileNames.ts'

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
function uiFixture({ decode = () => { throw Error('Unexpected image decode') } } = {}) {
  const states = [], refs = [], effects = []; let index = 0, refIndex = 0
  const full = { expanded: false, native: false, toggle() {}, leave() {}, escape: () => true }
  const hooks = { ...React, useEffect: (callback, deps) => effects.push({ callback, deps }), useId: () => 'synthetic-heading', useRef: initial => refs[refIndex++] ??= { current: initial }, useState(initial) { const i = index++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] } }
  function load(path, imports) {
    const module = { exports: {} }, code = ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    runInNewContext(code, { module, exports: module.exports, window: { devicePixelRatio: 2 }, Promise, Math, AbortController, Blob, createImageBitmap: decode, require(name) { if (name === 'react') return hooks; if (name === 'react/jsx-runtime') return ReactJsx; if (name.endsWith('.css')) return {}; if (!(name in imports)) throw Error('Unexpected viewer dependency: ' + name); return imports[name] } })
    return module.exports
  }
  const icons = new Proxy({}, { get: (_target, name) => props => React.createElement('svg', { ...props, 'data-icon': String(name) }) })
  const ui = load('src/components/teaching/TeachingUI.tsx', { 'lucide-react': icons, './TeachingContextGuide': { TeachingSectionHelp: () => null } })
  const viewer = load('src/components/teaching/TeachingMaterialViewer.tsx', { 'lucide-react': icons, 'pdfjs-dist/build/pdf.worker.min.mjs?url': { default: '/synthetic-worker.js' }, '../../lib/teachingMaterialPreview': { TEACHING_MATERIAL_CHUNK_BYTES: 1024 * 1024, TEACHING_MATERIAL_MAX_PAGES: 1000 }, '../../lib/profileNames': { PROFILE_NAME_MAX_LENGTH }, '../../lib/teachingMaterialFullscreen': { teachingMaterialFitScale }, './useTeachingMaterialFullscreen': { useTeachingMaterialFullscreen: () => full }, './TeachingUI': { ...ui, TeachingModal: 'synthetic-modal' } })
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

test('the empty and busy status keep an identical fixed-height flex slot regardless of inherited line height', () => {
  const f = uiFixture(), props = { publication: { id: 'synthetic-publication', version: 1 }, file: { name: 'Synthetic.pdf', storage_path: 'synthetic/path.pdf' }, repository: {}, onClose() {} }
  const busy = nodes(f.render(props)).find(node => node.props?.className?.includes('teaching-material-status'))
  assert.ok(busy); assert.match(renderToStaticMarkup(busy), /Відкриваємо матеріал/)
  f.states[9] = false; f.states[10] = false
  const idle = nodes(f.render(props)).find(node => node.props?.className?.includes('teaching-material-status'))
  assert.ok(idle); assert.equal(idle.props.className, busy.props.className); assert.equal(idle.props.role, 'status')
  assert.doesNotMatch(renderToStaticMarkup(idle), /Відкриваємо матеріал/)
  const rule = /\.teaching-material-status\s*\{([^}]+)\}/.exec(source('src/components/teaching/teaching-material-viewer.css'))?.[1]
  assert.ok(rule)
  const declarations = Object.fromEntries(rule.split(';').filter(Boolean).map(item => item.split(':').map(value => value.trim())))
  assert.equal(declarations.height, declarations['min-height'])
  assert.equal(declarations.height, declarations['max-height'])
  assert.equal(declarations.height, declarations['line-height'], 'busy text must not grow a reserved minimum-only row')
  assert.equal(declarations.flex, `0 0 ${declarations.height}`, 'the status row must neither shrink nor obtain an auto content basis')
  assert.equal(declarations['white-space'], 'nowrap'); assert.equal(declarations.overflow, 'hidden')
})

test('the canvas blocks its own save menu and drag until current metadata explicitly allows download', () => {
  const f = uiFixture()
  const publication = { id: 'synthetic-publication', version: 2, allow_download: false }
  const file = { name: 'Synthetic.pdf', storage_path: 'synthetic/path.pdf' }
  const props = { publication, file, repository: {}, onClose() {} }
  const metadata = { item_id: publication.id, version: publication.version, storage_path: file.storage_path, name: file.name, preview_kind: 'pdf', size: 128, render_mode: 'source' }
  for (const info of [null, { ...metadata, render_mode: 'raster', page_count: 1, download_allowed: false }, { ...metadata, version: 1, download_allowed: true }]) {
    f.states[0] = info
    const tree = f.render(props), canvas = nodes(tree).find(node => node.type === 'canvas')
    assert.ok(canvas); assert.equal(canvas.props.draggable, false)
    assert.match(canvas.props.className, /teaching-material-canvas-restricted/)
    let prevented = 0
    const event = { preventDefault() { prevented++ } }
    canvas.props.onContextMenu(event); canvas.props.onDragStart(event)
    assert.equal(prevented, 2)
    assert.equal(nodes(tree).filter(node => node.props?.onContextMenu || node.props?.onDragStart).length, 1)
  }
  f.states[0] = { ...metadata, download_allowed: true }
  const allowed = nodes(f.render(props)).find(node => node.type === 'canvas')
  assert.equal(allowed.props.onContextMenu, undefined); assert.equal(allowed.props.onDragStart, undefined)
  assert.equal(allowed.props.draggable, undefined); assert.doesNotMatch(allowed.props.className, /teaching-material-canvas-restricted/)
  f.states[0] = { ...metadata, preview_kind: 'text', download_allowed: true }
  const text = nodes(f.render(props))
  assert.ok(text.some(node => node.type === 'pre'))
  assert.ok(!text.some(node => node.type === 'canvas' || node.props?.onContextMenu || node.props?.onDragStart))
})

test('the actual source viewer keeps page and zoom across fullscreen and reveals only the watermarked PDF render', async () => {
  const f = uiFixture(), pending = [], requested = [], cancelled = [], watermarks = []
  const context = { save() {}, restore() {}, rotate() {}, fillText: text => watermarks.push(text) }
  const attributes = new Map([['data-material-painted', 'true']])
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context,
    removeAttribute(name) { attributes.delete(name) },
    setAttribute(name, value) { assert.ok(watermarks.length > 0, 'a fresh bitmap must be watermarked before publication'); attributes.set(name, value) },
  }
  const pdfPage = { getViewport: ({ scale }) => ({ width: 1600 * scale, height: 900 * scale }), render(options) { const task = deferred(); pending.push(task); requested.push(options); return { promise: task.promise, cancel() { cancelled.push(task) } } } }
  const pdf = { numPages: 2, async getPage(page) { assert.equal(page, 2); return pdfPage } }
  const repository = { materialFileInfo() { throw Error('Fullscreen must not reload file metadata') }, materialFileChunk() { throw Error('Fullscreen must not create raw file requests') } }
  const props = { publication: { id: 'synthetic-publication', version: 1 }, file: { name: 'Synthetic.pdf', storage_path: 'synthetic/path.pdf' }, repository, onClose() {} }
  const viewerName = 'Synthetic viewer '.padEnd(PROFILE_NAME_MAX_LENGTH, 'я')
  const info = { item_id: props.publication.id, storage_path: props.file.storage_path, version: props.publication.version, render_mode: 'source', download_allowed: true, name: 'Synthetic.pdf', preview_kind: 'pdf', author_name: 'Synthetic author '.repeat(20), viewer_name: viewerName }
  f.states.push(info, pdf, null, 2, 0, '', 1.25, 850, 600, false, false, '')
  let tree = f.render(props); nodes(tree).find(node => node.type === 'canvas').props.ref.current = canvas
  const originalLoadDependencies = f.effects[1].deps
  const cleanup = f.effects[2].callback()
  assert.equal(attributes.has('data-material-painted'), false, 'hide the bitmap before any asynchronous PDF work')
  await flush(); assert.equal(pending.length, 1)
  cleanup(); f.full.expanded = true; f.states[7] = 1920; f.states[8] = 720
  tree = f.render(props); const cleanupExpanded = f.effects[2].callback(); await flush()
  assert.equal(pending.length, 1, 'the second render must wait for cancellation to settle on the shared canvas')
  assert.equal(cancelled.length, 1); pending[0].resolve(); await flush(); assert.equal(pending.length, 2)
  assert.equal(attributes.has('data-material-painted'), false, 'an outdated PDF task must not reveal the replacement bitmap')
  assert.equal(nodes(f.render(props)).find(node => node.type === 'canvas').props['aria-busy'], true)
  assert.deepEqual(f.effects[1].deps, originalLoadDependencies, 'expansion must not trigger file metadata or permission reads again')
  assert.equal(f.states[3], 2); assert.equal(f.states[6], 1.25)
  assert.ok(Math.abs(requested[1].viewport.width - 1600) < 0.01); assert.equal(requested[1].viewport.height, 900)
  assert.ok(canvas.width * canvas.height <= 16_000_000)
  assert.equal(watermarks.length, 0); pending[1].resolve(); await flush()
  assert.ok(watermarks.length > 0)
  assert.ok(watermarks.every(label => label.startsWith(`${viewerName} · Synthetic author`) && [...label].length <= 160))
  assert.equal(attributes.get('data-material-painted'), 'true'); assert.equal(f.states[11], '')
  tree = f.render(props)
  assert.equal(nodes(tree).find(node => node.type === 'canvas').props['aria-busy'], undefined)
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /Сторінка 2 з 2/); assert.match(markup, /125%/); assert.doesNotMatch(markup, /<iframe|<object|<a\b|download=/)
  cleanupExpanded()
})

test('the raster viewer reads pages only, closes a late bitmap and reuses the current one when zooming', async () => {
  const decodes = [], requests = [], painted = [], closed = []
  const f = uiFixture({ decode(blob) { assert.equal(blob.type, 'image/webp'); const task = deferred(); decodes.push(task); return task.promise } })
  const publication = { id: 'raster-material', version: 4 }, file = { name: 'Protected.txt', storage_path: 'synthetic/text.txt' }
  const metadata = { item_id: publication.id, version: publication.version, storage_path: file.storage_path, name: file.name, preview_kind: 'text', size: 384, render_mode: 'raster', download_allowed: false, page_count: 2 }
  let rawReads = 0
  const repository = {
    async materialFileInfo() { return metadata },
    async materialFileChunk() { rawReads++; throw Error('Protected source must not be requested') },
    async materialFilePage(item, attachment, page, signal) { assert.equal(item, publication); assert.equal(attachment, file); requests.push({ page, signal }); return new ArrayBuffer(12) },
  }
  const props = { publication, file, repository, onClose() {} }
  f.render(props); const cleanupMetadata = f.effects[1].callback(); await flush()
  let tree = f.render(props)
  assert.match(renderToStaticMarkup(tree), /Сторінка 1 з 2/)
  assert.equal(f.effects[4].callback(), undefined, 'protected text must use the raster path too')
  const cleanupFirstPage = f.effects[3].callback(); await flush()
  assert.deepEqual(requests.map(request => request.page), [1]); assert.equal(decodes.length, 1)
  cleanupFirstPage(); f.states[3] = 2
  f.render(props); const cleanupSecondPage = f.effects[3].callback(); await flush()
  assert.equal(requests[0].signal.aborted, true); assert.deepEqual(requests.map(request => request.page), [1, 2])
  decodes[0].resolve({ width: 800, height: 450, close: () => closed.push(1) }); await flush()
  assert.deepEqual(closed, [1]); assert.equal(f.states[12], null, 'late page 1 must never replace page 2')
  const active = { width: 800, height: 450, close: () => closed.push(2) }
  decodes[1].resolve(active); await flush()

  tree = f.render(props)
  const attributes = new Map()
  const context = { fillRect() {}, drawImage(bitmap) { painted.push(bitmap) }, fillText() { throw Error('Server watermark must not be applied twice') } }
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context, removeAttribute: name => attributes.delete(name), setAttribute: (name, value) => attributes.set(name, value) }
  nodes(tree).find(node => node.type === 'canvas').props.ref.current = canvas
  const pageDependencies = f.effects[3].deps
  const cleanupPaint = f.effects[2].callback(); await flush()
  assert.deepEqual(painted, [active]); assert.equal(attributes.get('data-material-painted'), 'true')
  cleanupPaint(); f.states[6] = 1.5; f.full.expanded = true
  tree = f.render(props); const cleanupZoom = f.effects[2].callback(); await flush()
  assert.deepEqual(f.effects[3].deps, pageDependencies)
  assert.deepEqual(painted, [active, active]); assert.deepEqual(requests.map(request => request.page), [1, 2]); assert.equal(rawReads, 0)
  assert.match(renderToStaticMarkup(tree), /Сторінка 2 з 2/)
  cleanupZoom(); cleanupSecondPage(); cleanupMetadata(); assert.deepEqual(closed, [1, 2])
})

test('a repository returning old protected source metadata cannot start a raw read', async () => {
  const f = uiFixture(), publication = { id: 'legacy-material', version: 2 }, file = { name: 'Legacy.pdf', storage_path: 'synthetic/legacy.pdf' }
  let rawReads = 0
  const props = { publication, file, repository: {
    async materialFileInfo() { return { item_id: publication.id, storage_path: file.storage_path, version: publication.version, download_allowed: false, preview_kind: 'pdf', size: 384 } },
    async materialFileChunk() { rawReads++; throw Error('Raw read forbidden') },
  }, onClose() {} }
  f.render(props); const cleanup = f.effects[1].callback(); await flush()
  assert.equal(rawReads, 0); assert.equal(f.states[0], null); assert.ok(f.states[11]); cleanup()
})
