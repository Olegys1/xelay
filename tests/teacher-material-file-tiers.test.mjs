// Actual client/server functions and actual SQL, fictional owners only. All
// remote Auth/Storage transport is inert; this never contacts a real project.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import * as path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { uploadValidatorDependencies } from '../scripts/security/upload-content-validator-dependencies.mjs'
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8')
const MiB = 1024 * 1024
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Buffer, Uint8Array, TextDecoder, TextEncoder, Date, URL, Error, DOMException, AbortController, AbortSignal,
    setTimeout, clearTimeout, queueMicrotask, console, require(name) { assert.ok(Object.hasOwn(imports, name), 'Explicit dependency ' + name); return imports[name] }, ...globals,
  })
  return module.exports
}
const limits = load(await read('src/lib/teachingFileLimits.ts'))
const client = load(await read('src/lib/uploadContentVerification.ts'), { './supabase': { supabase: {} } })
const validator = load(await read('server/uploadContentValidation.ts'), { 'node:crypto': crypto, 'node:zlib': zlib, 'node:path': path, ...uploadValidatorDependencies })

test('only an active teacher plan maps to larger preflight sizes; student defaults and images stay50MiB', () => {
  for (const [planId, size] of [['free', 50], ['teacher_start', 100], ['teacher_plus', 150], ['teacher_max', 200]]) {
    const maximum = limits.teachingPlanFileBytes({ audience: 'teacher', planId })
    assert.equal(maximum, size * MiB)
    const file = { name: 'Synthetic.pdf', type: 'application/pdf', size: maximum }
    assert.equal(client.validateAcademicUploadFile(file, maximum).mime, file.type)
    assert.throws(() => client.validateAcademicUploadFile({ ...file, size: maximum + 1 }, maximum), /Максимальний розмір/)
  }
  for (const value of [null, [], {}, { audience: 'student', planId: 'teacher_max' }, { audience: 'unresolved', planId: 'teacher_max' }, { audience: 'teacher', planId: '__proto__' }]) assert.equal(limits.teachingPlanFileBytes(value), 50 * MiB)
  const large = { name: 'Synthetic.pdf', type: 'application/pdf', size: 50 * MiB + 1 }
  assert.throws(() => client.validateAcademicUploadFile(large), /50 МБ/)
  assert.throws(() => client.validateAcademicUploadFile({ ...large, name: 'Synthetic.png', type: 'image/png' }, 200 * MiB), /50 МБ/)
  assert.throws(() => client.validateAcademicUploadFile(large, Number.MAX_SAFE_INTEGER), /50 МБ/)
  for (const [name, type] of [['a.doc','application/msword'], ['a.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['a.csv','text/csv'], ['a.mp4','video/mp4']]) {
    assert.equal(limits.teachingFileMaximum({ name, type }, 200 * MiB), 50 * MiB)
    assert.throws(() => client.validateAcademicUploadFile({ ...large, name, type }, 200 * MiB), /50 МБ/)
  }
  assert.equal(limits.teachingFileMaximum({ name: 'a.pdf', type: 'application/octet-stream' }, 200 * MiB), 200 * MiB)
  assert.equal(limits.teachingFileMaximum({ name: 'a.pdf', type: 'application/msword' }, 200 * MiB), 50 * MiB)
  limits.validateTeachingProtectedFileSizes([{ name: 'a.txt', size: 2 * MiB }, { name: 'a.pdf', size: 200 * MiB }])
  assert.throws(() => limits.validateTeachingProtectedFileSizes([{ name: 'a.txt', size: 2 * MiB + 1 }]), /до 2 МБ/)
})

test('real teacher byte inspection accepts >50MiB without changing the ordinary validator or expanded budgets', async () => {
  const bytes = Buffer.alloc(50 * MiB + 1, 0x61)
  await assert.rejects(validator.validateUploadContent(bytes, 'txt', 'text/plain'), /50 МБ/)
  const result = await validator.validateUploadContent(bytes, 'txt', 'text/plain', undefined, 200 * MiB)
  assert.equal(result.size, bytes.length)
  assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
  await assert.rejects(validator.validateUploadContent(bytes, 'png', 'image/png', undefined, 200 * MiB), /50 МБ/)
  // Large-file opt-in does not alter the untrusted archive child's size bound.
  await assert.rejects(validator.validateUploadContent(Buffer.from('PK\x03\x04broken'), 'zip', 'application/zip', undefined, 200 * MiB), /./)
})

test('paid large-file inspection still rejects a ZIP expansion bomb before unpacking it', async () => {
  function crc(data) { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1 } return (value ^ 0xffffffff) >>> 0 }
  function archive(data) {
    const name = Buffer.from('notes.txt'), packed = zlib.deflateRawSync(data), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), checksum = crc(data)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0x81a40000, 38)
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16)
    return Buffer.concat([local, name, packed, central, name, end])
  }
  const small = archive(Buffer.from('Synthetic ordinary notes.'))
  assert.equal((await validator.validateUploadContent(small, 'zip', 'application/zip', undefined, 200 * MiB)).extension, 'zip')
  const bomb = archive(Buffer.alloc(16 * MiB + 1, 0x61))
  assert.ok(bomb.length < 100000)
  await assert.rejects(validator.validateUploadContent(bomb, 'zip', 'application/zip', undefined, 200 * MiB), error => error.code === 'UPLOAD_ARCHIVE_LIMIT')
})

test('raster byte admission refuses a second200MiB source before loading it and releases reservations after abort', async () => {
  const raster = load(await read('server/teachingMaterialRaster.ts'), { 'node:path': path, 'node:worker_threads': { Worker: class extends EventEmitter {} } })
  const first = new AbortController()
  let loads = 0
  const record = size => ({ storage_path: randomUUID(), version: 1, size, mime_type: 'application/pdf', preview_kind: 'pdf', author_name: 'Synthetic Teacher', viewer_name: 'Synthetic Student' })
  const pending = raster.withTeachingMaterialRaster(record(200 * MiB), signal => {
    loads++
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, first.signal)
  await Promise.resolve()
  const second = () => { loads++; throw Error('Must not load a second large source') }
  await assert.rejects(raster.withTeachingMaterialRaster(record(200 * MiB), second, new AbortController().signal), { status: 429 })
  assert.equal(loads, 1)
  first.abort()
  await assert.rejects(pending)
  await new Promise(resolve => setTimeout(resolve, 0))
  await assert.rejects(raster.withTeachingMaterialRaster(record(200 * MiB), () => { loads++; throw Error('Synthetic read failure after slot release') }, new AbortController().signal), /Synthetic read failure/)
  assert.equal(loads, 2)
  await assert.rejects(raster.withTeachingMaterialRaster(record(200 * MiB + 1), second, new AbortController().signal), { status: 415 })
  assert.equal(loads, 2)
})

test('content scanner admits at most256MiB of encoded bytes and releases a cancelled large download', async () => {
  const user = randomUUID(), storagePath = `${randomUUID()}/${user}/${randomUUID()}.txt`, bucket = 'xelay-teaching-files'
  const candidate = { object_id: randomUUID(), bucket_id: bucket, storage_path: storagePath, owner_id: user, size: 200 * MiB, mime_type: 'text/plain', created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:00:00Z', storage_version: 'synthetic-version', already_verified: false }
  const account = { id: user, email_confirmed_at: '2026-01-01' }
  const service = { auth: { getUser: async () => ({ data: { user: account } }), admin: { getUserById: async () => ({ data: { user: account } }) } }, rpc() { throw Error('No receipt expected') } }
  const caller = { rpc: async () => ({ data: candidate }) }
  let fetches = 0
  const entered = Promise.withResolvers(), origin = 'https://fictional-xelay.invalid'
  const endpoint = load(await read('server/uploadContentVerification.ts'), { 'node:crypto': crypto, '@supabase/supabase-js': { createClient: (_url, _key, options) => options.global.headers ? caller : service }, './uploadContentValidation.js': validator }, {
    process: { env: { SUPABASE_URL: 'https://fictional-storage.invalid', XELAY_PUBLIC_URL: origin, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SUPABASE_ANON_KEY: 'synthetic-anon' } },
    fetch: async (_url, init) => {
      fetches++; entered.resolve()
      if (fetches === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
      return new Response(Buffer.from('no'), { headers: { 'content-type': 'text/plain', 'content-length': '2' } })
    },
  })
  const req = () => Object.assign(new EventEmitter(), { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', authorization: 'Bearer synthetic-token' }, body: { bucket, path: storagePath } })
  const response = () => ({ setHeader() {}, status(value) { this.statusCode = value; return this }, json(value) { this.body = value; return this } })
  const first = req(), firstResponse = response(), pending = endpoint.handleUploadContentVerification(first, firstResponse)
  await entered.promise
  const secondResponse = response()
  await endpoint.handleUploadContentVerification(req(), secondResponse)
  assert.equal(secondResponse.statusCode, 429); assert.equal(fetches, 1)
  first.aborted = true; first.emit('aborted'); await pending
  const recovered = response()
  await endpoint.handleUploadContentVerification(req(), recovered)
  assert.equal(recovered.statusCode, 409); assert.equal(fetches, 2, 'Cancelled reservation is returned before another file read')
})

test('an authorized200MiB original is read only in a version-bound1MiB range; ignored Range is cancelled', async () => {
  const owner = randomUUID(), item = randomUUID(), storagePath = `${randomUUID()}/${owner}/${randomUUID()}.pdf`
  const metadata = { item_id: item, storage_path: storagePath, name: 'Synthetic.pdf', mime_type: 'application/pdf', size: 200 * MiB, allow_download: true, download_allowed: true, author_name: 'Synthetic Teacher', viewer_name: 'Synthetic Student', version: 2 }
  let reads = 0, checks = 0, ignored = false, cancelled = false, delivered = 0
  const origin = 'https://fictional-xelay.invalid', storage = 'https://fictional-storage.invalid'
  const caller = { async rpc(name) { assert.equal(name, 'xelay_teaching_material_file_access'); checks++; return { data: metadata, error: null } } }
  const service = { auth: { getUser: async () => ({ data: { user: { id: owner } } }), admin: { getUserById: async () => ({ data: { user: { id: owner, email_confirmed_at: '2026-01-01' } } }) } } }
  const endpoint = load(await read('server/teachingMaterialFiles.ts'), { '@supabase/supabase-js': { createClient: (_url, _key, options) => options.global.headers ? caller : service }, './billing.js': { billingConfiguration: () => ({ origin }) } }, {
    process: { env: { SUPABASE_URL: storage, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SUPABASE_ANON_KEY: 'synthetic-anon' } },
    fetch: async (_url, init) => {
      reads++
      assert.equal(init.headers.Range, `bytes=${metadata.size - 97}-${metadata.size - 1}`)
      if (ignored) return new Response(new ReadableStream({ pull(controller) { delivered++; controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true } }), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(metadata.size) } })
      return new Response(Buffer.alloc(97, 0x61), { status: 206, headers: { 'content-type': 'application/pdf', 'content-length': '97', 'content-range': `bytes ${metadata.size - 97}-${metadata.size - 1}/${metadata.size}` } })
    },
  })
  async function request(length = MiB) {
    const req = { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', authorization: 'Bearer synthetic-token' }, body: { item_id: item, path: storagePath, offset: metadata.size - 97, length } }
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this }, send(value) { this.body = value; return this } }
    await endpoint.handleTeachingMaterialFileView(req, res)
    return res
  }
  const response = await request()
  assert.equal(response.statusCode, 206)
  assert.equal(response.body.length, 97)
  assert.equal(reads, 1); assert.equal(checks, 2)
  assert.equal((await request(MiB + 1)).statusCode, 400)
  assert.equal(reads, 1)
  metadata.download_allowed = false
  assert.equal((await request()).statusCode, 403)
  assert.equal(reads, 1, 'A restricted student cannot fetch original bytes')
  metadata.download_allowed = true; ignored = true
  assert.equal((await request()).statusCode, 409)
  assert.equal(cancelled, true)
  assert.ok(delivered <= 1, 'Ignored Range is rejected before draining the object')
})

test('real PostgreSQL plan, Storage ACL, quarantine, retained read and expiry guards enforce each exact file boundary', { timeout: 120000 }, async t => {
  const { createTeacherBackendFixture } = await import('./helpers/teacherBackendFixture.mjs')
  const { verifyStoredBytes } = await import('../scripts/security/upload-content-workflow-bridge.mjs')
  const fx = await createTeacherBackendFixture()
  t.after(() => fx.close())
  const { db, ids, groups, asUser, ownerCall, serviceCall } = fx
  const bucketSettings = async () => (await db.query('select * from storage.buckets order by id')).rows
  const settingsBefore = await bucketSettings()
  await db.exec(await read('supabase/migrations/20261117212138_teacher_material_file_tiers.sql'))
  assert.deepEqual(await bucketSettings(), settingsBefore, 'Installing upload policies preserves every bucket and its configuration')
  const count = (await db.query("select file_size_limit,public from storage.buckets where id='xelay-teaching-files'")).rows[0]
  assert.equal(Number(count.file_size_limit), 50 * MiB); assert.equal(count.public, false)
  // Simulate the later Storage API setting in this Postgres-only fixture.
  // The following cases exercise the actual per-account RLS and receipt checks.
  await db.query("update storage.buckets set file_size_limit=$1 where id='xelay-teaching-files'", [200 * MiB])
  assert.equal(Number((await db.query("select file_size_limit from storage.buckets where id='xelay-submission-files'")).rows[0].file_size_limit), 50 * MiB)
  const cap = (user = ids.owner, mime = '') => ownerCall('xelay_teaching_upload_file_limit', [mime], user).then(Number)
  assert.equal(await cap(), 50 * MiB)
  assert.equal(await cap(ids.studentA), 50 * MiB)
  await db.query("update auth.users set raw_user_meta_data=$2::jsonb where id=$1", [ids.studentA, JSON.stringify({ planId: 'teacher_max', teacher_plan_id: 'teacher_max', paid: true })])
  assert.equal(await cap(ids.studentA), 50 * MiB, 'Editable metadata cannot become a paid entitlement')
  async function upload(size, options = {}) {
    const user = options.user || ids.owner, bucket = options.bucket || 'xelay-teaching-files'
    const storagePath = `${options.parent || ids.course}/${user}/${randomUUID()}.${options.extension || 'txt'}`
    await asUser(user, 'insert into storage.objects(bucket_id,name,owner,owner_id,metadata)values($1,$2,$3::uuid,$3::text,$4::jsonb)',
      [bucket, storagePath, user, JSON.stringify({ size, mimetype: options.mime || 'text/plain' })])
    return { storagePath, bucket, user, descriptor: { storage_path: storagePath, name: 'Synthetic.' + (options.extension || 'txt'), size, mime_type: options.mime || 'text/plain' } }
  }
  await upload(50 * MiB)
  await assert.rejects(upload(50 * MiB + 1), /row-level security|policy/i)
  // Retained volume has no new account quota: many independent valid free
  // objects exceed both a single paid file and the scanner's rolling budget.
  for (let i = 0; i < 22; i++) await upload(50 * MiB)
  assert.equal(Number((await db.query("select sum((metadata->>'size')::bigint) total from storage.objects where bucket_id='xelay-teaching-files'")).rows[0].total), 23 * 50 * MiB)
  const assignment = randomUUID(), submission = randomUUID()
  await fx.classroom(ids.owner, 'save_group_assignment', { id: assignment, version: 0, expected_user_id: ids.owner, course_id: ids.course, title: 'Synthetic submission boundary', body: '', links: [], attachments: [], status: 'published', submission_format: 'written', max_points: 10, targets: [{ group_id: groups[0], placement_mode: 'unplaced', lesson_date: fx.dates.lesson_a }] })
  await fx.classroom(ids.studentA, 'reserve_submission', { id: submission, item_id: assignment, group_id: groups[0] })
  await upload(50 * MiB, { user: ids.studentA, bucket: 'xelay-submission-files', parent: submission })
  await assert.rejects(upload(50 * MiB + 1, { user: ids.studentA, bucket: 'xelay-submission-files', parent: submission }), /row-level security|policy/i)
  const paidFiles = []
  for (const [plan, limit] of [['teacher_start', 100], ['teacher_plus', 150], ['teacher_max', 200]]) {
    // Previous grants remain recorded but are revoked only in this synthetic
    // fixture so the current exact tier can be exercised independently.
    await db.query('update xelay_teacher_private.grants set revoked_at=now() where user_id=$1', [ids.owner])
    await fx.createPaidTeacher(plan)
    assert.equal(await cap(), limit * MiB)
    const file = await upload(limit * MiB)
    paidFiles.push(file)
    await assert.rejects(upload(limit * MiB + 1), /row-level security|policy/i)
    await assert.rejects(upload(50 * MiB + 1, { extension: 'png', mime: 'image/png' }), /row-level security|policy/i)
    for (const [extension, mime] of [['doc','application/msword'], ['docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['csv','text/csv']]) {
      await upload(50 * MiB, { extension, mime })
      await assert.rejects(upload(50 * MiB + 1, { extension, mime }), /row-level security|policy/i)
    }
    await assert.rejects(upload(limit * MiB, { extension: 'doc', mime: 'application/pdf' }), /row-level security|policy/i)
    assert.equal(await cap(ids.owner, 'image/png'), 50 * MiB)
    const candidate = await ownerCall('xelay_upload_scan_candidate', [file.bucket, file.storagePath])
    assert.equal(Number(candidate.size), limit * MiB)
    await assert.rejects(ownerCall('xelay_upload_scan_candidate', [file.bucket, file.storagePath], ids.colleague), /FORBIDDEN/)
    const saved = await serviceCall('xelay_record_upload_content_verification', [candidate, 'a'.repeat(64), 'b'.repeat(64), 'text/plain', 1])
    assert.equal(saved, true)
    // Neither a student nor a teacher can mint a content receipt.
    await assert.rejects(ownerCall('xelay_record_upload_content_verification', [candidate, 'a'.repeat(64), 'b'.repeat(64), 'text/plain', 1]), /permission denied/)
  }
  const latest = paidFiles.at(-1), material = randomUUID()
  // A paid teacher's larger scan allowance applies only to teaching PDF/text.
  // Seed a synthetic pre-existing regular upload owned by the same teacher.
  const regularPath = `${ids.course}/${ids.owner}/${randomUUID()}.txt`
  await db.query("insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values('xelay-submission-files',$1,$2::uuid,$2::text,$3::jsonb)",
    [regularPath, ids.owner, JSON.stringify({ size: 100, mimetype: 'text/plain' })])
  const image = await upload(100, { extension: 'png', mime: 'image/png' })
  // Pin the current ten-minute window so a clock boundary between the
  // previous tier cases and these assertions does not change the test.
  await db.query("update public.xelay_upload_scan_budgets set total_bytes=$2,window_start=to_timestamp(floor(extract(epoch from clock_timestamp())/600)*600) where owner_id=$1", [ids.owner, 250 * MiB])
  for (const [bucket, path] of [['xelay-submission-files', regularPath], [image.bucket, image.storagePath]]) {
    await assert.rejects(ownerCall('xelay_upload_scan_candidate', [bucket, path]), /UPLOAD_VERIFICATION_RATE_LIMIT/)
  }
  await fx.mutate(ids.owner, 'save_library_material', { expected_user_id: ids.owner, course_id: ids.course, id: material, version: 0,
    title: 'Synthetic large restricted lecture', body: '', links: [], link_labels: {}, attachments: [latest.descriptor],
    target_group_ids: [groups[0]], status: 'published', allow_download: false, rights_accepted: true, rights_terms_version: '2026-10-27.1' })
  const studentRead = await ownerCall('xelay_teaching_material_file_access', [material, latest.storagePath], ids.studentA)
  assert.equal(studentRead.size, 200 * MiB); assert.equal(studentRead.download_allowed, false)
  const originalRead = await asUser(ids.studentA, 'select id from storage.objects where bucket_id=$1 and name=$2', [latest.bucket, latest.storagePath])
  assert.equal(originalRead.rows.length, 0)
  await assert.rejects(ownerCall('xelay_teaching_material_file_access', [material, latest.storagePath], ids.outsider), /FORBIDDEN/)

  // Real >50MiB HTTP→validator→SQL receipt path, with actual inert bytes.
  const bytes = Buffer.alloc(50 * MiB + 1, 0x61), actual = await upload(bytes.length)
  const verified = await verifyStoredBytes({ db, asUser, actor: ids.owner, bucket: actual.bucket, path: actual.storagePath, bytes })
  assert.equal(verified.statusCode, 200, JSON.stringify(verified.body))
  assert.equal(verified.body.verified, true)
  const fresh = await upload(60 * MiB), freshCandidate = await ownerCall('xelay_upload_scan_candidate', [fresh.bucket, fresh.storagePath])
  await db.query('update xelay_teacher_private.grants set revoked_at=now() where user_id=$1', [ids.owner])
  assert.equal(await cap(), 50 * MiB)
  await assert.rejects(upload(50 * MiB + 1), /row-level security|policy/i)
  assert.equal(await serviceCall('xelay_record_upload_content_verification', [freshCandidate, 'a'.repeat(64), 'b'.repeat(64), 'text/plain', 1]), false)
  await assert.rejects(ownerCall('xelay_upload_scan_candidate', [fresh.bucket, fresh.storagePath]), /UPLOAD_PLAN_FILE_LIMIT/)
  assert.equal((await ownerCall('xelay_upload_scan_candidate', [latest.bucket, latest.storagePath])).already_verified, true)
  assert.equal((await ownerCall('xelay_teaching_material_file_access', [material, latest.storagePath], ids.studentA)).download_allowed, false)
  const existing = await fx.item(material)
  await fx.mutate(ids.owner, 'save_library_material', { expected_user_id: ids.owner, course_id: ids.course, id: material, version: existing.version,
    title: 'Retained large lecture after expiry', body: '', links: [], link_labels: {}, attachments: [latest.descriptor], target_group_ids: [groups[0]], status: 'published', allow_download: false,
    rights_accepted: true, rights_terms_version: '2026-10-27.1' })
  assert.equal((await fx.item(material)).title, 'Retained large lecture after expiry')
  assert.equal((await asUser(ids.owner, 'select id from storage.objects where bucket_id=$1 and name=$2', [latest.bucket, latest.storagePath])).rows.length, 1)
})
