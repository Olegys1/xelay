// Actual client verification/adapters with synthetic sessions, storage and fetch.
// No network, real accounts, malware or proof of the server's byte validator.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const verifySource = await read('src/lib/uploadContentVerification.ts')
const teachingSource = await read('src/lib/teaching.ts')
const presentationSource = await read('src/lib/studyGroupPresentations.ts')
const materialSource = await read('src/lib/studyGroupMaterialFiles.ts')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function load(source, imports, globals = {}) {
  const exports = {}
  new Function('exports', 'require', ...Object.keys(globals), compile(source))(exports, name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected isolated import ${name}`)
    return imports[name]
  }, ...Object.values(globals))
  return exports
}
function parsed(source) { return ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }
function variable(source, name) {
  const ast = parsed(source)
  const node = ast.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(item => item.name.getText(ast) === name)
  assert.ok(node, name)
  return node.initializer.getText(ast)
}
function functions(source, names, context, extra = '') {
  const ast = parsed(source)
  const declarations = names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name)
    assert.ok(node, name)
    return node.getText(ast).replace(/^export\s+/, '')
  }).join('\n')
  return load(`export function make(context:any) { const {${Object.keys(context).join(',')}} = context; ${extra}\n${declarations}; return {${names.join(',')}}; }`, {}).make(context)
}
const user = '11111111-1111-4111-8111-111111111111'
const parent = '22222222-2222-4222-8222-222222222222'
const other = '33333333-3333-4333-8333-333333333333'
const object = '44444444-4444-4444-8444-444444444444'
const path = `${parent}/${user}/${object}.pdf`
const file = () => new File(['synthetic payload, server response is explicitly fixture-controlled'], 'notes.pdf', { type: 'application/pdf' })
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

function fixture(options = {}) {
  const events = [], progress = [], stages = []
  let listener, unsubscribed = false, session = { user: { id: user }, access_token: 'synthetic-test-token' }
  const supabase = {
    auth: {
      async getSession() { events.push(['session']); return { data: { session }, error: options.sessionError || null } },
      onAuthStateChange(callback) { listener = callback; return { data: { subscription: { unsubscribe() { unsubscribed = true } } } } },
    },
    storage: { from(bucket) { return {
      async upload(storagePath, rawFile, config) { events.push(['storage', bucket, storagePath, rawFile, config]); options.onStorage?.(); return { error: options.storageError || null } },
      async remove() { throw new Error('Unverified storage must not be removed by the client') },
    } } },
    async rpc() { throw new Error('Unexpected mutation/cleanup of an unverified file') },
  }
  const api = load(verifySource, { './supabase': { supabase } }, {
    async fetch(url, init) {
      events.push(['verify', url, init])
      options.onRequest?.({ changeAccount })
      if (options.networkError) throw options.networkError
      return options.response ? options.response() : response({ verified: true, validation_version: 1 })
    },
  })
  function changeAccount(next = other) { session = next ? { user: { id: next }, access_token: 'another-synthetic-token' } : null; listener?.('SIGNED_OUT', session) }
  function rawUpload(input) {
    events.push(['raw', input])
    input.onProgress?.(0); input.onProgress?.(100)
    options.onStorage?.()
    return Promise.resolve()
  }
  const materials = load(materialSource, { './supabase': { supabase }, './uploadContentVerification': api }, { crypto: webcrypto })
  const teaching = functions(teachingSource, ['validateTeachingFile','uploadPrivateTeachingFile'], {
    supabase, uploadTeachingStorageFile: rawUpload, verifyUploadedContent: api.verifyUploadedContent,
    validateAcademicUploadFile: api.validateAcademicUploadFile, crypto: webcrypto,
  }, `const TEACHING_FILE_MIME_TYPES = ${variable(teachingSource, 'TEACHING_FILE_MIME_TYPES')};
    const TEACHING_MAX_FILE_BYTES = ${variable(teachingSource, 'TEACHING_MAX_FILE_BYTES')};`)
  const format = functions(presentationSource, ['validateGroupPresentationFile'], {
    validateAcademicUploadFile: api.validateAcademicUploadFile, validateMaterialFiles: materials.validateMaterialFiles,
  }, `const mime = ${variable(presentationSource, 'mime')};`)
  const ast = parsed(presentationSource)
  const repository = ast.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(item => item.name.getText(ast) === 'supabaseGroupPresentationRepository')
  const upload = repository.initializer.properties.find(item => item.name?.getText(ast) === 'upload')
  assert.ok(upload)
  const presentationUpload = load(`export function make(context:any) { const {${['supabase','validateGroupPresentationFile','uploadPresentationBytes','verifyUploadedContent','crypto'].join(',')}} = context;
    const uuid = ${variable(presentationSource, 'uuid')}; const GROUP_PRESENTATION_BUCKET = 'xelay-group-presentations';
    const materialFileName = context.materialFileName; return ({${upload.getText(ast)}}).upload; }`, {}).make({
      supabase, validateGroupPresentationFile: format.validateGroupPresentationFile,
      uploadPresentationBytes: (storagePath, rawFile, mimeType, accessToken, onProgress, signal) => rawUpload({ storagePath, file: rawFile, mimeType, accessToken, onProgress, signal }),
      verifyUploadedContent: api.verifyUploadedContent, materialFileName: materials.materialFileName, crypto: webcrypto,
    })
  return {
    api, materials, events, progress, stages, changeAccount,
    get unsubscribed() { return unsubscribed },
    verify: (override = {}) => api.verifyUploadedContent({ bucket: 'xelay-submission-files', path, userId: user, onProgress: value => progress.push(value), onStage: value => stages.push(value), ...override }),
    teaching: (override = {}) => teaching.uploadPrivateTeachingFile('xelay-submission-files', parent, user, file(), value => progress.push(value), override.signal),
    presentation: (override = {}) => presentationUpload(parent, user, file(), value => progress.push(value), override.signal),
  }
}

test('verification uses only the local endpoint, current bearer and exact object, then reports completion', async () => {
  const fx = fixture()
  await fx.verify()
  const [, url, init] = fx.events.find(([kind]) => kind === 'verify')
  assert.equal(url, '/api/security/media-cleanup?xelay_upload_route=verify')
  assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
  assert.equal(init.headers.Authorization, 'Bearer synthetic-test-token')
  assert.deepEqual(JSON.parse(init.body), { bucket: 'xelay-submission-files', path })
  assert.deepEqual(fx.progress, [99,100])
  assert.deepEqual(fx.stages, ['Перевіряємо вміст файлу'])
  assert.equal(fx.events.filter(([kind]) => kind === 'session').length, 2)
  assert.equal(fx.unsubscribed, true)
})

test('missing, false, wrong-version, malformed, oversized or non-JSON receipts never report100', async () => {
  for (const candidate of [
    () => response({ verified: false, validation_version: 1 }),
    () => response({ verified: true, validation_version: 2 }),
    () => response({ verified: true }),
    () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x'.repeat(4097), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('<script>synthetic</script>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  ]) {
    const fx = fixture({ response: candidate })
    await assert.rejects(fx.verify(), /Не вдалося завершити перевірку вмісту/)
    assert.equal(fx.progress.includes(100), false)
    assert.equal(fx.unsubscribed, true)
  }
})

test('denied content and transport failures keep a safe message instead of exposing provider text', async () => {
  for (const options of [
    { response: () => new Response('SECRET-SYNTHETIC-DIAGNOSTIC', { status: 422 }) },
    { response: () => new Response('SECRET-SYNTHETIC-DIAGNOSTIC', { status: 503 }) },
    { networkError: new Error('SECRET-SYNTHETIC-DIAGNOSTIC') },
  ]) {
    const fx = fixture(options)
    await assert.rejects(fx.verify(), error => !error.message.includes('SECRET-SYNTHETIC') && /перевірку вмісту|перевірки вмісту/.test(error.message))
    assert.equal(fx.progress.includes(100), false)
  }
})

test('actor, bucket and object-scope mismatches fail before requesting verification', async () => {
  for (const override of [{ userId: other }, { bucket: 'avatars' }, { path: `${parent}/${other}/${object}.pdf` }, { path: `${parent}/${user}/${object}.exe` }]) {
    const fx = fixture()
    await assert.rejects(fx.verify(override))
    assert.equal(fx.events.some(([kind]) => kind === 'verify'), false)
    assert.equal(fx.progress.includes(100), false)
  }
  const stale = fixture(); stale.changeAccount()
  await assert.rejects(stale.verify(), /Акаунт змінився/)
  assert.equal(stale.events.some(([kind]) => kind === 'verify'), false)
})

test('an account change while verification is in flight aborts it and never returns success', async () => {
  const fx = fixture({ onRequest({ changeAccount }) { changeAccount() } })
  await assert.rejects(fx.verify(), /Акаунт змінився/)
  assert.equal(fx.events.find(([kind]) => kind === 'verify')[2].signal.aborted, true)
  assert.equal(fx.progress.includes(100), false)
  assert.equal(fx.unsubscribed, true)
})

test('cancelled verification never reports success or makes cleanup mutations', async () => {
  const cancellation = new AbortController(); cancellation.abort()
  const fx = fixture()
  await assert.rejects(fx.verify({ signal: cancellation.signal }), { name: 'AbortError' })
  assert.equal(fx.events.some(([kind]) => kind === 'verify'), false)
  assert.equal(fx.progress.includes(100), false)
})

test('new-file allowlist refuses legacy/macro/archive/active formats while accepting bounded modern descriptors', () => {
  const fx = fixture()
  for (const extension of ['doc','xls','ppt','docm','xlsm','pptm','zip','html','svg','exe','mp3','mp4']) {
    assert.throws(() => fx.api.validateAcademicUploadFile(new File(['synthetic'], `document.${extension}`, { type: 'application/octet-stream' })), /формат|форматі/)
    assert.equal(fx.api.ACADEMIC_UPLOAD_ACCEPT.split(',').includes(`.${extension}`), false)
  }
  for (const [extension, mime] of Object.entries(fx.api.ACADEMIC_UPLOAD_MIME_TYPES)) {
    assert.equal(fx.api.validateAcademicUploadFile({ name: `safe.${extension}`, type: mime, size: 1024 }).mime, mime)
  }
  for (const input of [
    { name: 'safe.pdf', type: 'text/html', size: 10 },
    { name: '../safe.pdf', type: 'application/pdf', size: 10 },
    { name: 'spoof\u202eexe.pdf', type: 'application/pdf', size: 10 },
    { name: 'safe.pdf', type: 'application/pdf', size: 0 },
    { name: 'safe.pdf', type: 'application/pdf', size: 50 * 1024 * 1024 + 1 },
  ]) assert.throws(() => fx.api.validateAcademicUploadFile(input))
})

test('actual teaching and presentation upload callbacks cannot return metadata before the receipt', async () => {
  for (const method of ['teaching','presentation']) {
    const good = fixture()
    const attachment = await good[method]()
    assert.ok(attachment.storage_path || attachment.path)
    assert.deepEqual(good.progress, [0,98,99,100])
    assert.ok(good.events.findIndex(([kind]) => kind === 'raw') < good.events.findIndex(([kind]) => kind === 'verify'))
    const denied = fixture({ response: () => new Response('{}', { status: 422 }) })
    await assert.rejects(denied[method](), /Файл не пройшов перевірку/)
    assert.equal(denied.progress.includes(100), false)
  }
})

test('actual ordinary-material uploader returns only verified files and keeps a denied object quarantined', async () => {
  const good = fixture()
  const attachments = await good.materials.uploadMaterialFiles(parent, user, [file()])
  assert.equal(attachments.length, 1)
  assert.ok(good.events.findIndex(([kind]) => kind === 'storage') < good.events.findIndex(([kind]) => kind === 'verify'))
  const denied = fixture({ response: () => new Response('{}', { status: 422 }) })
  await assert.rejects(denied.materials.uploadMaterialFiles(parent, user, [file()]), /Файл не пройшов перевірку/)
  assert.equal(denied.events.filter(([kind]) => kind === 'storage').length, 1)
})

test('an account change or cancellation after the raw transfer cannot publish an attachment', async () => {
  for (const method of ['teaching','presentation']) {
    const cancellation = new AbortController()
    const fx = fixture({ onStorage() { cancellation.abort() } })
    await assert.rejects(fx[method]({ signal: cancellation.signal }), { name: 'AbortError' })
    assert.equal(fx.events.some(([kind]) => kind === 'verify'), false)
    assert.equal(fx.progress.includes(100), false)
    const changed = fixture({ onStorage() { changed.changeAccount() } })
    await assert.rejects(changed[method](), /Акаунт змінився/)
    assert.equal(changed.events.some(([kind]) => kind === 'verify'), false)
    assert.equal(changed.progress.includes(100), false)
  }
  const cancellation = new AbortController()
  const fx = fixture({ onStorage() { cancellation.abort() } })
  await assert.rejects(fx.materials.uploadMaterialFiles(parent, user, [file()], { signal: cancellation.signal }), { name: 'AbortError' })
  assert.equal(fx.events.some(([kind]) => kind === 'verify'), false)
})

test('historical ordinary ZIP and legacy Office descriptors remain readable, but cannot become new uploads', () => {
  const fx = fixture()
  for (const [extension, mime] of [['zip','application/zip'],['doc','application/msword'],['xls','application/vnd.ms-excel'],['ppt','application/vnd.ms-powerpoint']]) {
    const descriptor = { path: `${parent}/${user}/${object}.${extension}`, file_name: `historic.${extension}`, mime_type: mime, file_size: 10 }
    assert.deepEqual(fx.materials.getMaterialAttachments([descriptor]), [descriptor])
    assert.throws(() => fx.materials.validateMaterialFiles([new File(['synthetic'], `new.${extension}`, { type: mime })]))
  }
})
