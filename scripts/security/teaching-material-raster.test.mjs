import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import ts from 'typescript'

const compile = async path => ts.transpileModule(await readFile(new URL('../../' + path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const [serverSource, routeSource, clientSource] = await Promise.all([
  compile('server/teachingMaterialFiles.ts'),
  compile('api/security/media-cleanup.ts'),
  compile('src/lib/teachingMaterialPreview.ts'),
])
function load(source, imports, globals = {}) {
  const module = { exports: {} }
  runInNewContext(source, {
    module, exports: module.exports, Buffer, Uint8Array, TextDecoder, TextEncoder, Blob,
    URL, AbortController, AbortSignal, DOMException, Error, setTimeout, clearTimeout,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Unexpected module: ' + name); return imports[name] },
    ...globals,
  })
  return module.exports
}

const origin = 'https://fictional-app.example'
const storage = 'https://fictional-storage.example'
const endpointPath = '/api/security/media-cleanup?xelay_media_route=teaching-material-view'
const student = '10000000-0000-4000-8000-000000000001'
const lecturer = '20000000-0000-4000-8000-000000000002'
const course = '30000000-0000-4000-8000-000000000003'
const itemId = '40000000-0000-4000-8000-000000000004'
const fileId = '50000000-0000-4000-8000-000000000005'
const path = `${course}/${lecturer}/${fileId}.pdf`
const version = 7
const maxRasterBytes = 3.5 * 1024 * 1024
const authorName = 'Synthetic Lecturer'
const viewerName = 'Synthetic Student'
const token = 'fictional-student-token'
const original = Buffer.from('%PDF-1.4\nFictional original bytes, never returned to a restricted browser.\n')
const canvas = createCanvas(2, 2)
canvas.getContext('2d').fillRect(0, 0, 2, 2)
const webp = canvas.toBuffer('image/webp')
const pageCount = 2
const file = { name: 'Fictional lecture.pdf', mime_type: 'application/pdf', size: original.length, storage_path: path }
const publication = { id: itemId, version, allow_download: false, author_name: 'Forged publication author', viewer_name: 'Forged publication viewer' }
const body = { item_id: itemId, path }
const record = value => JSON.parse(JSON.stringify(value))
const unexpected = () => { throw new Error('Unexpected unrelated endpoint') }

class RasterFailure extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function fixture(options = {}) {
  const calls = { auth: [], authorization: [], storage: [], renders: [], browser: [] }
  const access = {
    item_id: itemId, storage_path: path, name: file.name, mime_type: file.mime_type, size: file.size,
    allow_download: false, download_allowed: false, author_name: authorName, viewer_name: viewerName,
    version, ...options.access,
  }
  const state = { granted: true, account: { id: student, email_confirmed_at: '2026-01-01T00:00:00Z' } }
  const service = { auth: {
    async getUser(bearer) {
      calls.auth.push(bearer)
      return bearer === token
        ? { data: { user: { id: student } }, error: null }
        : { data: { user: null }, error: { message: 'Invalid synthetic session' } }
    },
    admin: {
      async getUserById(id) {
        assert.equal(id, student)
        return { data: { user: state.account }, error: null }
      },
    },
  } }
  const caller = { async rpc(name, args) {
    calls.authorization.push([name, record(args)])
    assert.equal(name, 'xelay_teaching_material_file_access')
    if (!state.granted || args.p_item_id !== itemId || args.p_storage_path !== path) {
      return { data: null, error: { code: '42501', message: 'TEACHING_FORBIDDEN' } }
    }
    return { data: { ...access }, error: null }
  } }
  function createClient(url, key, settings) {
    assert.equal(url, storage)
    assert.equal(settings.auth.persistSession, false)
    const bearer = settings.global.headers?.Authorization
    if (!bearer) {
      assert.equal(key, 'fictional-service-key')
      return service
    }
    assert.equal(key, 'fictional-anon-key')
    assert.equal(bearer, 'Bearer ' + token)
    return caller
  }
  async function storageFetch(url, init) {
    calls.storage.push({ url: String(url), range: init.headers.Range })
    assert.equal(String(url), storage + '/storage/v1/object/xelay-teaching-files/' + path)
    assert.equal(init.headers.Authorization, 'Bearer fictional-service-key')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    await options.pauseStorage?.()
    if (options.storageResponse) return options.storageResponse()
    const range = init.headers.Range?.match(/^bytes=(\d+)-(\d+)$/)
    const headers = { 'Content-Type': file.mime_type }
    if (!range) return new Response(original, { headers: { ...headers, 'Content-Length': String(original.length) } })
    const start = Number(range[1]), end = Number(range[2])
    const bytes = original.subarray(start, end + 1)
    return new Response(bytes, {
      status: 206, headers: {
        ...headers, 'Content-Length': String(bytes.length), 'Content-Range': `bytes ${start}-${end}/${original.length}`,
      },
    })
  }
  const server = load(serverSource, {
    '@supabase/supabase-js': { createClient },
    './billing.js': { billingConfiguration: () => ({ origin }) },
    './teachingMaterialRaster.js': {
      TeachingMaterialRasterError: RasterFailure,
      async withTeachingMaterialRaster(metadata, readSource, signal, page) {
        calls.renders.push({ author: metadata.author_name, viewer: metadata.viewer_name, page })
        if (page !== undefined && page > pageCount) throw new RasterFailure(416, 'Немає такої сторінки.')
        const bytes = await readSource(signal)
        assert.deepEqual(Buffer.from(bytes), original)
        await options.pauseRaster?.()
        if (options.rasterFailure) throw new RasterFailure(503, 'Захищений перегляд тимчасово недоступний.')
        return page === undefined ? { pageCount } : { pageCount, bytes: options.rasterBytes ?? webp }
      },
    },
  }, {
    fetch: storageFetch,
    process: { env: {
      SUPABASE_URL: storage, SUPABASE_SERVICE_ROLE_KEY: 'fictional-service-key', SUPABASE_ANON_KEY: 'fictional-anon-key',
    } },
  })
  const route = load(routeSource, {
    '../../server/teachingMaterialFiles.js': server,
    '../../server/opportunitiesFiles.js': { handleOpportunitiesFileValidation: unexpected },
    '../../server/uploadContentVerification.js': { handleUploadContentVerification: unexpected },
    '../../server/mediaMaintenance.js': { authorizeMediaMaintenance: unexpected, cleanDetachedMedia: unexpected, mediaMaintenanceClient: unexpected },
  })
  async function request(payload = body, headers = {}, method = 'POST') {
    const req = Object.assign(new EventEmitter(), {
      method, query: { xelay_media_route: 'teaching-material-view' }, body: payload,
      headers: {
        origin, authorization: 'Bearer ' + token, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers,
      },
    })
    const res = {
      statusCode: 200, headers: new Headers(),
      setHeader(name, value) { this.headers.set(name, String(value)) },
      status(code) { this.statusCode = code; return this },
      json(value) { this.headers.set('content-type', 'application/json'); this.body = record(value); return this },
      send(bytes) { this.bytes = Buffer.from(bytes); return this },
    }
    await route.default(req, res)
    return res
  }
  const client = load(clientSource, {
    './supabase': { supabase: { auth: { getSession: async () => ({
      data: { session: options.noSession ? null : { access_token: token } }, error: null,
    }) } } },
  }, { fetch: async (url, init) => {
    assert.equal(url, endpointPath)
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    const headers = Object.fromEntries(new Headers(init.headers))
    assert.equal(headers.authorization, 'Bearer ' + token)
    const payload = JSON.parse(init.body)
    calls.browser.push(payload)
    const replacement = await options.browserResponse?.(payload)
    if (replacement) return replacement
    const result = await request(payload, headers, init.method)
    return new Response(result.bytes ?? JSON.stringify(result.body), {
      status: result.statusCode, headers: result.headers,
    })
  } })
  return { calls, state, access, client, request }
}

function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /\bprivate\b/)
  assert.match(response.headers.get('cache-control'), /\bno-store\b/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('vary'), /authorization/i)
  assert.equal(response.headers.get('location'), null)
}

test('a restricted browser gets canonical metadata and a WebP page while direct raw ranges are rejected before Storage', async () => {
  const fx = fixture()
  const denied = await fx.request({ ...body, offset: 0, length: original.length })
  assert.equal(denied.statusCode, 403)
  assertPrivate(denied)
  assert.equal(denied.bytes, undefined)
  assert.equal(fx.calls.storage.length, 0)
  assert.equal(fx.calls.renders.length, 0)
  assert.deepEqual(fx.calls.authorization, [['xelay_teaching_material_file_access', { p_item_id: itemId, p_storage_path: path }]])

  const metadata = await fx.client.getTeachingMaterialFileInfo(publication, file)
  assert.equal(metadata.render_mode, 'raster')
  assert.equal(metadata.page_count, pageCount)
  assert.equal(metadata.download_allowed, false)
  assert.equal(metadata.author_name, authorName)
  assert.equal(metadata.viewer_name, viewerName)
  assert.deepEqual(fx.calls.browser, [body])
  assert.deepEqual(fx.calls.renders, [{ author: authorName, viewer: viewerName, page: undefined }])

  const raster = await fx.request({ ...body, page: 2 })
  assert.equal(raster.statusCode, 200)
  assertPrivate(raster)
  assert.equal(raster.headers.get('content-type'), 'image/webp')
  assert.equal(raster.headers.get('content-length'), String(webp.length))
  assert.equal(raster.headers.get('x-teaching-material-version'), String(version))
  assert.equal(raster.headers.get('x-teaching-material-page'), '2')
  assert.equal(raster.headers.get('x-teaching-material-pages'), String(pageCount))
  assert.deepEqual(raster.bytes, webp)
  assert.notDeepEqual(raster.bytes, original)

  await fx.client.getTeachingMaterialFilePage(publication, file, 1)
  assert.deepEqual(fx.calls.browser, [body, { ...body, page: 1 }])
  assert.deepEqual(fx.calls.renders.at(-1), { author: authorName, viewer: viewerName, page: 1 })
  assert.ok(fx.calls.storage.length > 0, 'The authorized server, not the browser, reads the source')
})

test('membership is checked again for pages and every denied path stops before rendering or Storage', async () => {
  const fx = fixture()
  assert.equal((await fx.request()).statusCode, 200)
  const reads = fx.calls.storage.length
  const renders = fx.calls.renders.length
  fx.state.granted = false
  for (const payload of [body, { ...body, page: 1 }, { ...body, offset: 0, length: 8 }]) {
    const denied = await fx.request(payload)
    assert.equal(denied.statusCode, 403)
    assertPrivate(denied)
    assert.equal(denied.bytes, undefined)
  }
  assert.equal(fx.calls.storage.length, reads)
  assert.equal(fx.calls.renders.length, renders)
  assert.equal(fx.calls.authorization.length, 5)
  const other = fixture()
  assert.equal((await other.request({ ...body, item_id: lecturer, page: 1 })).statusCode, 403)
  assert.equal(other.calls.storage.length, 0)
  assert.equal(other.calls.renders.length, 0)
})

function responseGate() {
  const entered = Promise.withResolvers()
  const resumed = Promise.withResolvers()
  return {
    async pause() { entered.resolve(); await resumed.promise },
    async changeDuring(response, change) {
      try {
        await Promise.race([
          entered.promise,
          response.then(result => { throw new Error('Response completed before the read paused: ' + result.statusCode) }),
        ])
        change()
      } finally {
        resumed.resolve()
      }
      return response
    },
  }
}

function assertNoMaterialResponse(response, status) {
  assert.equal(response.statusCode, status)
  assertPrivate(response)
  assert.equal(response.bytes, undefined)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.get('content-range'), null)
  assert.equal(response.headers.get('x-teaching-material-version'), null)
  assert.equal(response.body.render_mode, undefined)
  assert.equal(response.body.page_count, undefined)
}

test('membership withdrawn while rasterization is in flight blocks both metadata and finished page bytes', async () => {
  for (const payload of [body, { ...body, page: 1 }]) {
    const gate = responseGate()
    const fx = fixture({ pauseRaster: gate.pause })
    const response = await gate.changeDuring(fx.request(payload), () => {
      assert.equal(fx.calls.authorization.length, 1)
      assert.equal(fx.calls.renders.length, 1)
      assert.equal(fx.calls.storage.length, 1)
      fx.state.granted = false
    })
    assertNoMaterialResponse(response, 403)
    assert.equal(fx.calls.authorization.length, 2)
    assert.equal(fx.calls.renders.length, 1)
    assert.equal(fx.calls.storage.length, 1)
  }
})

test('changing the canonical file or watermark identity during rendering discards the stale page', async () => {
  for (const change of [
    { version: version + 1 }, { size: file.size + 1 }, { name: 'Renamed lecture.pdf' },
    { storage_path: path.replace(/\.pdf$/, '.png') }, { mime_type: 'application/octet-stream' },
    { viewer_name: 'Updated Synthetic Student' }, { author_name: 'Updated Synthetic Lecturer' },
  ]) {
    const gate = responseGate()
    const fx = fixture({ pauseRaster: gate.pause })
    const response = await gate.changeDuring(fx.request({ ...body, page: 1 }), () => {
      assert.equal(fx.calls.authorization.length, 1)
      Object.assign(fx.access, change)
    })
    assertNoMaterialResponse(response, 409)
    assert.equal(fx.calls.authorization.length, 2)
    assert.equal(fx.calls.renders.length, 1)
    assert.equal(fx.calls.storage.length, 1)
  }
})

test('an authorized original range is discarded when access or download permission changes during the Storage read', async () => {
  for (const [change, expectedStatus] of [
    [fx => { fx.state.granted = false }, 403],
    [fx => { fx.access.download_allowed = false }, 403],
    [fx => { fx.access.version++ }, 409],
  ]) {
    const gate = responseGate()
    const fx = fixture({ access: { download_allowed: true }, pauseStorage: gate.pause })
    const response = await gate.changeDuring(fx.request({ ...body, offset: 0, length: 8 }), () => {
      assert.equal(fx.calls.authorization.length, 1)
      assert.equal(fx.calls.storage.length, 1)
      change(fx)
    })
    assertNoMaterialResponse(response, expectedStatus)
    assert.equal(fx.calls.authorization.length, 2)
    assert.equal(fx.calls.renders.length, 0)
    assert.equal(fx.calls.storage.length, 1)
  }
})

test('cross-origin and malformed requests cannot spoof a watermark or switch the server to source mode', async () => {
  const fx = fixture()
  assert.equal((await fx.request(body, { origin: 'https://fictional-other.example' })).statusCode, 403)
  assert.equal((await fx.request(body, { 'content-type': 'text/plain' })).statusCode, 415)
  assert.equal((await fx.request(body, { 'content-length': '99999' })).statusCode, 413)
  assert.equal((await fx.request(' '.repeat(3000))).statusCode, 413)
  assert.equal((await fx.request(body, {}, 'GET')).statusCode, 405)
  for (const extra of [
    { viewer_name: 'Forged name' }, { author_name: 'Forged name' }, { download_allowed: true },
    { allow_download: true }, { render_mode: 'source' }, { page: 1, offset: 0, length: 10 },
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: '1' }, { page: 2 ** 53 },
    { offset: 0, length: 1024 * 1024 + 1 },
  ]) {
    const response = await fx.request({ ...body, ...extra })
    assert.equal(response.statusCode, 400, JSON.stringify(extra))
    assertPrivate(response)
  }
  assert.equal((await fx.request({ ...body, path: '../synthetic.pdf', page: 1 })).statusCode, 400)
  assert.equal(fx.calls.auth.length, 0)
  assert.equal(fx.calls.authorization.length, 0)
  assert.equal(fx.calls.storage.length, 0)
  assert.equal(fx.calls.renders.length, 0)
})

test('absent, invalid and inactive sessions never reach file authorization or rasterization', async () => {
  const fx = fixture()
  for (const authorization of [undefined, 'Bearer expired-synthetic-token']) {
    assert.equal((await fx.request({ ...body, page: 1 }, { authorization })).statusCode, 401)
  }
  for (const account of [
    { ...fx.state.account, email_confirmed_at: null },
    { ...fx.state.account, deleted_at: '2026-01-01T00:00:00Z' },
    { ...fx.state.account, banned_until: '2099-01-01T00:00:00Z' },
  ]) {
    fx.state.account = account
    assert.equal((await fx.request({ ...body, page: 1 })).statusCode, 401)
  }
  assert.equal(fx.calls.authorization.length, 0)
  assert.equal(fx.calls.storage.length, 0)
  assert.equal(fx.calls.renders.length, 0)
  const anonymous = fixture({ noSession: true })
  await assert.rejects(anonymous.client.getTeachingMaterialFileInfo(publication, file))
  assert.deepEqual(anonymous.calls.browser, [])
})

test('a legitimate download permission preserves the existing source preview and version-bound byte ranges', async () => {
  const fx = fixture({ access: { download_allowed: true } })
  const info = await fx.client.getTeachingMaterialFileInfo(publication, file)
  assert.equal(info.allow_download, false, 'The material remains generally restricted when its author can download')
  assert.equal(info.download_allowed, true)
  assert.equal(info.render_mode, 'source')
  assert.equal(info.page_count, undefined)
  assert.equal(fx.calls.storage.length, 0)
  assert.equal(fx.calls.renders.length, 0)
  const chunk = await fx.client.getTeachingMaterialFileChunk(publication, file, 2, 5)
  assert.deepEqual(Buffer.from(chunk), original.subarray(2, 7))
  assert.deepEqual(fx.calls.storage, [{ url: storage + '/storage/v1/object/xelay-teaching-files/' + path, range: 'bytes=2-6' }])
})

test('out-of-range pages and upstream or rendering failures never send the original or a raster fallback', async () => {
  const fx = fixture()
  const outside = await fx.request({ ...body, page: pageCount + 1 })
  assert.equal(outside.statusCode, 416)
  assert.equal(outside.bytes, undefined)
  assertPrivate(outside)
  for (const setup of [
    { rasterFailure: true },
    { storageResponse: () => new Response(original, { headers: { 'content-type': 'text/html' } }) },
  ]) {
    const broken = fixture(setup)
    for (const payload of [body, { ...body, page: 1 }]) {
      const response = await broken.request(payload)
      assert.ok(response.statusCode >= 400)
      assertPrivate(response)
      assert.equal(response.bytes, undefined)
      assert.doesNotMatch(JSON.stringify(response.body), /Fictional original bytes/)
    }
    const before = broken.calls.storage.length
    assert.equal((await broken.request({ ...body, offset: 0, length: original.length })).statusCode, 403)
    assert.equal(broken.calls.storage.length, before)
  }
})

test('the route refuses malformed or oversized renderer output before returning any bytes', async () => {
  const brokenLength = Buffer.from(webp)
  brokenLength.writeUInt32LE(webp.length, 4)
  const oversized = Buffer.alloc(maxRasterBytes + 1)
  webp.copy(oversized)
  oversized.writeUInt32LE(oversized.length - 8, 4)
  for (const rasterBytes of [original, brokenLength, oversized]) {
    const fx = fixture({ rasterBytes })
    const response = await fx.request({ ...body, page: 1 })
    assert.equal(response.statusCode, 503)
    assertPrivate(response)
    assert.equal(response.bytes, undefined)
    assert.equal(response.headers.get('content-type'), 'application/json')
  }
})

const metadataValue = {
  item_id: itemId, storage_path: path, name: file.name, mime_type: file.mime_type, size: file.size,
  allow_download: false, download_allowed: false, author_name: authorName, viewer_name: viewerName,
  version, preview_kind: 'pdf', render_mode: 'raster', page_count: pageCount,
}
function pageResponse(bytes = webp, extraHeaders = {}, status = 200) {
  const headers = new Headers({
    'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'X-Teaching-Material-Version': String(version),
    'X-Teaching-Material-Page': '1', 'X-Teaching-Material-Pages': String(pageCount), ...extraHeaders,
  })
  return new Response(bytes, { status, headers })
}

test('the client rejects stale, ambiguous and forged metadata instead of assuming source preview', async () => {
  for (const invalid of [
    { render_mode: undefined }, { render_mode: 'source', page_count: undefined }, { page_count: undefined },
    { page_count: 0 }, { page_count: 1001 }, { download_allowed: true }, { version: version + 1 },
    { item_id: lecturer }, { storage_path: 'foreign.pdf' },
  ]) {
    const fx = fixture({ browserResponse: () => Response.json({ ...metadataValue, ...invalid }) })
    await assert.rejects(fx.client.getTeachingMaterialFileInfo(publication, file), Error, JSON.stringify(invalid))
    assert.deepEqual(fx.calls.browser, [body])
    assert.equal(fx.calls.storage.length, 0)
  }
  const canonical = fixture({ access: { allow_download: true } })
  const info = await canonical.client.getTeachingMaterialFileInfo({ ...publication, allow_download: true }, file)
  assert.equal(info.allow_download, true)
  assert.equal(info.download_allowed, false)
  assert.equal(info.render_mode, 'raster', 'An attachment protected elsewhere does not expose source bytes')
})

test('the client rejects wrong version, page, MIME, WebP signature and byte length without requesting source', async () => {
  const wrongResponses = [
    () => pageResponse(webp, { 'X-Teaching-Material-Version': String(version + 1) }),
    () => pageResponse(webp, { 'X-Teaching-Material-Page': '2' }),
    () => pageResponse(webp, { 'X-Teaching-Material-Pages': '0' }),
    () => pageResponse(webp, { 'Content-Type': 'application/pdf' }),
    () => pageResponse(original),
    () => pageResponse(webp, { 'Content-Length': String(webp.length - 1) }),
    () => pageResponse(webp, { 'Content-Length': String(maxRasterBytes + 1) }),
    () => pageResponse(Buffer.alloc(maxRasterBytes + 1), { 'Content-Length': String(webp.length) }),
    () => pageResponse(webp, {}, 206),
    () => Response.json({ error: 'Доступ закрито.' }, { status: 403 }),
  ]
  for (const browserResponse of wrongResponses) {
    const fx = fixture({ browserResponse })
    await assert.rejects(fx.client.getTeachingMaterialFilePage(publication, file, 1))
    assert.deepEqual(fx.calls.browser, [{ ...body, page: 1 }])
    assert.equal(fx.calls.storage.length, 0)
  }
})

// A two-page vector-only PDF with an ordinary xref. No external files, fonts or assets.
function fictionalPdf({ annotation = false } = {}) {
  const stream = (content, dictionary = '') => `<< /Length ${Buffer.byteLength(content)} ${dictionary} >>\nstream\n${content}endstream`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << >> /Contents 4 0 R'
      + (annotation ? ' /Annots [7 0 R]' : '') + ' >>',
    stream('0.12 0.24 0.36 rg\n25 25 110 60 re f\n'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << >> /Contents 6 0 R >>',
    stream('0.35 0.09 0.17 rg\n100 75 165 110 re f\n'),
  ]
  if (annotation) {
    objects.push(
      '<< /Type /Annot /Subtype /Square /Rect [35 135 125 210] /F 4 /P 3 0 R /AP << /N 8 0 R >> >>',
      stream('0.92 0.08 0.08 rg\n0 0 90 75 re f\n', '/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 90 75] /Resources << >>'),
    )
  }
  let source = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) source += `${String(offset).padStart(10, '0')} 00000 n \n`
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source)
}

function realRasterFixture(source, extension, mime, kind) {
  const input = {
    storage_path: `${course}/${lecturer}/${randomUUID()}.${extension}`,
    version, size: source.length, mime_type: mime, preview_kind: kind,
    author_name: authorName, viewer_name: viewerName,
  }
  const loadSource = async signal => {
    signal.throwIfAborted()
    return new Uint8Array(source)
  }
  return { input, loadSource }
}

test('an aborted request waiting on a stuck worker termination stops without fetching or starting another worker', { timeout: 5000 }, async () => {
  const rendering = Promise.withResolvers()
  const workerExit = Promise.withResolvers()
  const workers = []
  let terminations = 0
  class DelayedExitWorker extends EventEmitter {
    constructor() {
      super()
      workers.push(this)
      queueMicrotask(() => this.emit('message', { kind: 'ready', pageCount: 1 }))
    }
    ref() {}
    unref() {}
    postMessage() { rendering.resolve() }
    terminate() { terminations++; return workerExit.promise }
  }
  const { withTeachingMaterialRaster } = load(await compile('server/teachingMaterialRaster.ts'), {
    'node:path': { join }, 'node:worker_threads': { Worker: DelayedExitWorker },
  }, { process: { cwd: () => 'fictional-fixture' } })
  const first = realRasterFixture(Buffer.from('Fictional first document.'), 'txt', 'text/plain', 'text')
  const abortFirst = new AbortController()
  const firstRequest = withTeachingMaterialRaster(first.input, first.loadSource, abortFirst.signal, 1)
  await Promise.race([rendering.promise, firstRequest.then(() => { throw new Error('Render finished before cancellation') })])
  abortFirst.abort()
  await assert.rejects(firstRequest, { name: 'AbortError' })
  assert.equal(terminations, 1)

  const next = realRasterFixture(Buffer.from('Fictional next document.'), 'txt', 'text/plain', 'text')
  let sourceReads = 0
  const readSource = async signal => { sourceReads++; return next.loadSource(signal) }
  const abortNext = new AbortController()
  try {
    const waiting = withTeachingMaterialRaster(next.input, readSource, abortNext.signal)
    abortNext.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    assert.equal(sourceReads, 0)
    assert.equal(workers.length, 1)
  } finally {
    workerExit.resolve(0)
  }
  const recovered = await withTeachingMaterialRaster(next.input, readSource, new AbortController().signal)
  assert.equal(recovered.pageCount, 1)
  assert.equal(sourceReads, 1)
  assert.equal(workers.length, 2)
})

let realRenderer
function loadRealRenderer() {
  if (realRenderer) return realRenderer
  // The deployment compiles TypeScript, while Node's default test runner strips
  // types only. Keep import.meta URLs so the real runtime finds fonts and workers.
  const serverRoot = new URL('../../server/', import.meta.url).href
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (!url.startsWith(serverRoot) || !url.endsWith('.ts')) return nextLoad(url, context)
    const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    return { format: 'module', source, shortCircuit: true }
  } })
  realRenderer = import('../../server/teachingMaterialRaster.ts').finally(() => hook.deregister())
  return realRenderer
}

async function rasterPixelHash(bytes) {
  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP')
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8)
  assert.ok(bytes.length <= maxRasterBytes)
  const image = await loadImage(bytes)
  assert.ok(image.width > 0 && image.width <= 2000)
  assert.ok(image.height > 0 && image.height <= 2000)
  assert.ok(image.width * image.height <= 3_000_000)
  const surface = createCanvas(image.width, image.height)
  const context = surface.getContext('2d')
  context.drawImage(image, 0, 0)
  return createHash('sha256').update(context.getImageData(0, 0, image.width, image.height).data).digest('hex')
}

test('the real renderer embeds both author and viewer names in PDF page pixels even with a shared source cache', { timeout: 25_000 }, async () => {
  const { withTeachingMaterialRaster } = await loadRealRenderer()
  const { input, loadSource } = realRasterFixture(fictionalPdf(), 'pdf', 'application/pdf', 'pdf')
  const signal = AbortSignal.timeout(20_000)
  const metadata = await withTeachingMaterialRaster(input, loadSource, signal)
  assert.equal(metadata.pageCount, 2)
  assert.equal(metadata.bytes, undefined)
  const first = await withTeachingMaterialRaster(input, loadSource, signal, 1)
  const second = await withTeachingMaterialRaster(input, loadSource, signal, 2)
  const anotherViewer = await withTeachingMaterialRaster({ ...input, viewer_name: 'Another Fictional Viewer' }, loadSource, signal, 1)
  const anotherAuthor = await withTeachingMaterialRaster({ ...input, author_name: 'Another Fictional Lecturer' }, loadSource, signal, 1)
  const firstHash = await rasterPixelHash(first.bytes)
  assert.notEqual(firstHash, await rasterPixelHash(second.bytes), 'Different source pages should not render as the same image')
  assert.notEqual(firstHash, await rasterPixelHash(anotherViewer.bytes), 'A cached source must not reuse another viewer’s pixels')
  assert.notEqual(firstHash, await rasterPixelHash(anotherAuthor.bytes), 'Changing only the author must change the watermarked pixels')
  await assert.rejects(withTeachingMaterialRaster(input, loadSource, signal, 3), { status: 416 })
})

test('the real renderer preserves a visible PDF annotation appearance in the protected page image', { timeout: 25_000 }, async () => {
  const { withTeachingMaterialRaster } = await loadRealRenderer()
  const { input, loadSource } = realRasterFixture(fictionalPdf({ annotation: true }), 'pdf', 'application/pdf', 'pdf')
  const result = await withTeachingMaterialRaster(input, loadSource, AbortSignal.timeout(20_000), 1)
  const image = await loadImage(result.bytes)
  const surface = createCanvas(image.width, image.height)
  const context = surface.getContext('2d')
  context.drawImage(image, 0, 0)
  // Point (80, 170) in PDF coordinates lies inside the annotation and outside
  // the page's main content. It would be white if /Annots were disabled.
  const x = Math.floor(image.width * 80 / 320)
  const y = Math.floor(image.height * (240 - 170) / 240)
  const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data
  assert.ok(red > 150 && green < 100 && blue < 100 && alpha === 255, `Annotation center RGBA: ${red},${green},${blue},${alpha}`)
})

test('the real renderer turns protected PNG, TXT and CSV into watermarked page images and rejects corrupt source bytes', { timeout: 25_000 }, async () => {
  const { withTeachingMaterialRaster } = await loadRealRenderer()
  const bitmap = createCanvas(320, 240)
  const context = bitmap.getContext('2d')
  context.fillStyle = '#ccd7ec'
  context.fillRect(0, 0, bitmap.width, bitmap.height)
  context.fillStyle = '#a5123f'
  context.fillRect(18, 30, 180, 50)
  const signal = AbortSignal.timeout(20_000)
  for (const [source, extension, mime, kind] of [
    [bitmap.toBuffer('image/png'), 'png', 'image/png', 'image'],
    [Buffer.from('Fictional assignment\nТекст для локальної перевірки.\n'), 'txt', 'text/plain', 'text'],
    [Buffer.from('topic,score\nFictional,5\n'), 'csv', 'text/csv', 'text'],
  ]) {
    const { input, loadSource } = realRasterFixture(source, extension, mime, kind)
    const metadata = await withTeachingMaterialRaster(input, loadSource, signal)
    assert.equal(metadata.pageCount, 1)
    assert.equal(metadata.bytes, undefined)
    const result = await withTeachingMaterialRaster(input, loadSource, signal, 1)
    assert.equal(result.pageCount, 1)
    assert.notDeepEqual(result.bytes, source)
    await rasterPixelHash(result.bytes)
  }
  const corrupt = realRasterFixture(Buffer.from('Not a valid PNG.'), 'png', 'image/png', 'image')
  await assert.rejects(withTeachingMaterialRaster(corrupt.input, corrupt.loadSource, signal, 1), { status: 415 })
})
