import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { File } from 'node:buffer'
import vm from 'node:vm'
import ts from 'typescript'

const read = name => readFile(new URL('../../' + name, import.meta.url), 'utf8')
const source = await read('src/lib/timetableRecognitionClient.ts')
const sharedSource = await read('src/lib/timetableRecognition.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve() }
const group = '11111111-1111-4111-8111-111111111111'
const candidate = { id: 'c1', group_name: 'МА-2', study_year: 1, study_level: 'bachelor', program: 'Менеджмент', section_label: 'Лівий блок' }
const candidate2 = { ...candidate, id: 'c2', study_level: 'master', section_label: 'Правий блок' }
const token = 'synthetic.' + 'a'.repeat(43)
const imageData = 'data:image/png;base64,iVBORw0KGgo='
const analysis = { version: 2, kind: 'source_analysis', layout: 'multiple', candidates: [candidate, candidate2], warnings: [], analysis_token: token }
const result = (selection = candidate) => ({ version: 1, source_match: { status: selection.id === 'single' ? 'single_unlabelled' : 'matched', ...Object.fromEntries(Object.entries(selection).filter(([key]) => key !== 'id')) }, week_mode: 'every', days: [1], slots: [{ number: 1, starts_at: '08:00', ends_at: '09:20' }], lessons: [{ weekday: 1, lesson_number: 1, week_pattern: 'every', subject: 'Економічна теорія', lesson_type: 'lecture', location: '', online_url: '', online_url_secondary: '', date_note: '', needs_review: false, review_note: '' }], warnings: [] })
function load(text, imports, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, ...globals, require(name) { assert.ok(name in imports, name); return imports[name] } })
  return module.exports
}
const shared = load(sharedSource, {})
function fixture({ reply = () => analysis, status = 200, session, dimensions = [1200, 800], blobSizes = [100], decode = true, fakeTimers = false } = {}) {
  const calls = [], canvases = [], revoked = [], readers = [], timers = new Map()
  let timerId = 0
  class Image {
    naturalWidth = dimensions[0]; naturalHeight = dimensions[1]
    set src(value) { this.value = value; if (value && decode) queueMicrotask(() => this.onload?.()) }
  }
  class FileReader {
    constructor() { readers.push(this) }
    readAsDataURL(blob) { void blob.arrayBuffer().then(bytes => { if (!this.aborted) { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.() } }) }
    abort() { this.aborted = true }
  }
  const document = { createElement(name) {
    assert.equal(name, 'canvas')
    const calls = [], canvas = { width: 0, height: 0, calls, getContext: () => ({ fillRect: (...args) => calls.push(['fillRect', ...args]), save: () => calls.push(['save']), restore: () => calls.push(['restore']), translate: (...args) => calls.push(['translate', ...args]), rotate: (...args) => calls.push(['rotate', ...args]), drawImage: (_image, ...args) => calls.push(['drawImage', ...args]) }), toBlob(callback, mime, quality) { calls.push(['toBlob', mime, quality]); const size = blobSizes.length > 1 ? blobSizes.shift() : blobSizes[0]; callback(new Blob([new Uint8Array(size)], { type: mime })) } }
    canvases.push(canvas); return canvas
  } }
  const api = load(source, { './timetableRecognition': shared, './supabase': { supabase: { auth: { getSession: session || (async () => ({ data: { session: { access_token: 'synthetic-access' } }, error: null })) } } } }, {
    AbortController, DOMException, Error, Blob, File, Uint8Array, Image, FileReader, document, queueMicrotask,
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: url => revoked.push(url) },
    setTimeout: fakeTimers ? (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id } : setTimeout,
    clearTimeout: fakeTimers ? id => timers.delete(id) : clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined }); const body = await reply(url, options); return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body } },
  })
  return { api, calls, canvases, revoked, readers, timers }
}
function png(size = 32, type = 'image/png') { const bytes = new Uint8Array(size); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); return new File([bytes], 'sheet.png', { type }) }
function jpeg(size = 32) { const bytes = new Uint8Array(size); bytes.set([255, 216, 255]); return new File([bytes], 'sheet.jpg', { type: 'image/jpeg' }) }

test('crop geometry maps real source pixels, swaps rotated dimensions and rejects invalid boundaries', () => {
  const { api } = fixture()
  assert.deepEqual(plain(api.timetablePhotoGeometry(6000, 4000, { rotation: 90, crop: { left: 25, top: 25, right: 75, bottom: 75 } })), { left: 1500, top: 1000, cropWidth: 3000, cropHeight: 2000, rotation: 90, width: 2000, height: 3000, unchanged: false })
  assert.equal(api.timetablePhotoGeometry(1200, 800).unchanged, true)
  for (const crop of [{ left: 25, top: 0, right: 25, bottom: 100 }, { left: -1, top: 0, right: 100, bottom: 100 }, { left: 0, top: 0, right: 101, bottom: 100 }, { left: 0, top: 90, right: 100, bottom: 40 }, { left: 0 }, { left: NaN, top: 0, right: 100, bottom: 100 }]) assert.throws(() => api.timetablePhotoGeometry(100, 100, { crop }))
  for (const [width, height] of [[0, 100], [100, -1], [10000, 10000], [1.5, 100]]) assert.throws(() => api.timetablePhotoGeometry(width, height))
  assert.throws(() => api.timetablePhotoGeometry(100, 100, { rotation: 45 }))
})

test('small PNG screenshots retain exact original bytes without lossy conversion, with MIME from content', async () => {
  const fx = fixture(), file = png(64, 'image/jpeg')
  assert.equal(await fx.api.prepareTimetablePhoto(file), `data:image/png;base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`)
  assert.equal(fx.canvases.length, 0); assert.deepEqual(fx.revoked, ['blob:synthetic'])
})

test('cropping and rotation draw only the requested rectangle and preview the actual exported image', async () => {
  const fx = fixture({ dimensions: [6000, 4000] })
  assert.match(await fx.api.prepareTimetablePhoto(png(), { rotation: 90, crop: { left: 25, top: 25, right: 75, bottom: 75 } }), /^data:image\/png;base64,/)
  const canvas = fx.canvases[0]
  assert.equal(canvas.width, 2000); assert.equal(canvas.height, 3000)
  assert.deepEqual(canvas.calls.find(call => call[0] === 'drawImage'), ['drawImage', 1500, 1000, 3000, 2000, -1500, -1000, 3000, 2000])
  assert.equal(canvas.calls.find(call => call[0] === 'rotate')[1], Math.PI / 2)
})

test('oversized photos retain 4096-pixel detail and quality 0.9, rather than degrading text to quality 0.65', async () => {
  const fx = fixture({ dimensions: [8000, 6000], blobSizes: [2 * 1024 * 1024 + 1, 100] })
  await fx.api.prepareTimetablePhoto(jpeg())
  const canvas = fx.canvases[0], draws = canvas.calls.filter(call => call[0] === 'drawImage'), exports = canvas.calls.filter(call => call[0] === 'toBlob')
  assert.equal(Math.round(draws[0].at(-2)), 4096)
  assert.deepEqual(exports.map(call => call[2]), [0.9, 0.9])
  assert.ok(Math.max(canvas.width, canvas.height) <= 4096)
})

test('invalid image bytes, oversized files and cancelled preparation cannot produce an upload', async () => {
  const fx = fixture()
  await assert.rejects(fx.api.prepareTimetablePhoto(new File(['fake image'], 'fake.png', { type: 'image/png' })), /JPG/)
  await assert.rejects(fx.api.prepareTimetablePhoto(png(8 * 1024 * 1024 + 1)), /8 МБ/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(fx.api.prepareTimetablePhoto(png(), {}, controller.signal), error => error.name === 'AbortError')
  assert.equal(fx.calls.length, 0)
  const pending = fixture({ decode: false }), active = new AbortController()
  const operation = pending.api.prepareTimetablePhoto(png(), {}, active.signal)
  await flush(); active.abort(); await assert.rejects(operation, error => error.name === 'AbortError'); await flush()
  assert.deepEqual(pending.revoked, ['blob:synthetic'])
})

test('analysis and extraction send the same prepared image and exact chosen degree/course/source with its token', async () => {
  const fx = fixture({ reply: (_url, options) => JSON.parse(options.body).action === 'analyze' ? analysis : result(candidate2) })
  const found = await fx.api.analyzeTimetablePhoto(group, imageData)
  const extracted = await fx.api.recognizeTimetablePhoto(group, imageData, found.candidates[1], found.analysis_token)
  assert.equal(extracted.source_match.study_level, 'master')
  assert.deepEqual(fx.calls.map(call => call.body), [{ action: 'analyze', group_id: group, image_data_url: imageData }, { action: 'extract', source_selection: candidate2, analysis_token: token, group_id: group, image_data_url: imageData }])
  assert.ok(fx.calls.every(call => call.options.headers.Authorization === 'Bearer synthetic-access' && call.options.cache === 'no-store'))
})

test('an unexpected source, degree, course, malformed output or unsigned analysis is rejected before a draft can use it', async () => {
  for (const unexpected of [result(candidate2), { ...result(), source_match: { ...result().source_match, group_name: 'ЕУБ-4' } }, { ...result(), source_match: { ...result().source_match, study_year: 2 } }]) {
    const fx = fixture({ reply: () => unexpected }); await assert.rejects(fx.api.recognizeTimetablePhoto(group, imageData, candidate, token), /не підтверджено/)
  }
  for (const wrong of [null, {}, { ...result(), lessons: [] }]) await assert.rejects(fixture({ reply: () => wrong }).api.recognizeTimetablePhoto(group, imageData, candidate, token), /неповний/)
  await assert.rejects(fixture({ reply: () => ({ ...analysis, analysis_token: '' }) }).api.analyzeTimetablePhoto(group, imageData), /визначити групи/)
})

test('unlabelled source is accepted only as a single unlabelled schedule, never substituted for a named group', async () => {
  const single = { id: 'single', group_name: '', study_year: null, study_level: null, program: '', section_label: '' }, fx = fixture({ reply: () => result(single) })
  assert.equal((await fx.api.recognizeTimetablePhoto(group, imageData, single, token)).source_match.status, 'single_unlabelled')
  await assert.rejects(fx.api.recognizeTimetablePhoto(group, imageData, candidate, token), /не підтверджено/)
  assert.equal(fx.api.timetableSourceMatches(result(candidate), single), false)
})

test('the client cannot extract without a selected source/token and surfaces expired selection for re-analysis', async () => {
  const fx = fixture()
  await assert.rejects(fx.api.recognizeTimetablePhoto(group, imageData, null, token), /оберіть групу/)
  await assert.rejects(fx.api.recognizeTimetablePhoto(group, imageData, candidate, ''), /оберіть групу/)
  assert.equal(fx.calls.length, 0)
  const expired = fixture({ status: 409, reply: () => ({ error: 'Повторіть пошук груп на фото.' }) })
  await assert.rejects(expired.api.recognizeTimetablePhoto(group, imageData, candidate, token), error => error instanceof expired.api.TimetableRecognitionRequestError && error.status === 409 && /Повторіть/.test(error.message))
})

test('abort during session lookup and finite deadlines prevent late network requests', async () => {
  const session = deferred(), controller = new AbortController(), fx = fixture({ session: () => session.promise })
  const operation = fx.api.analyzeTimetablePhoto(group, imageData, controller.signal)
  controller.abort(); await assert.rejects(operation, error => error.name === 'AbortError')
  session.resolve({ data: { session: { access_token: 'late' } }, error: null }); await flush(); assert.equal(fx.calls.length, 0)
  const waiting = deferred(), deadline = fixture({ session: () => waiting.promise, fakeTimers: true })
  const timed = deadline.api.analyzeTimetablePhoto(group, imageData)
  deadline.timers.values().next().value.callback()
  await assert.rejects(timed, /задовго/)
  waiting.resolve({ data: { session: { access_token: 'late' } }, error: null }); await flush(); assert.equal(deadline.calls.length, 0); assert.equal(deadline.timers.size, 0)
})

test('availability and recognition require a valid group and signed-in session', async () => {
  const fx = fixture()
  await assert.rejects(fx.api.analyzeTimetablePhoto('bad', imageData), /навчальну групу/)
  assert.equal(fx.calls.length, 0)
  const guest = fixture({ session: async () => ({ data: { session: null }, error: null }) })
  await assert.rejects(guest.api.timetableRecognitionAvailability(group), /Увійдіть/)
  assert.equal(guest.calls.length, 0)
  const allowed = fixture({ reply: () => ({ available: true }) })
  assert.deepEqual(plain(await allowed.api.timetableRecognitionAvailability(group)), { available: true })
})
