// The real client transport runs against offline Auth/Storage/RPC fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { File } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const source = (await readFile(new URL('../src/lib/teachingGradeVoice.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.env.VITE_SUPABASE_URL', JSON.stringify('https://offline.supabase.co'))
const requestId = randomUUID(), userId = randomUUID(), uploadId = randomUUID()
const voice = { storage_path: `${requestId}/${userId}/${uploadId}.webm`, mime_type: 'audio/webm', size: 16, duration_seconds: 5.4 }
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(options = {}) {
  const calls = [], uploads = []
  let sessions = 0
  const session = { access_token: 'offline-only-token', user: { id: userId } }
  const exports = {}
  const signedUrl = `https://offline.supabase.co/storage/v1/object/sign/teaching-grade-voices/${voice.storage_path}?token=offline`
  const supabase = {
    auth: { async getSession() {
      calls.push({ kind: 'auth' }); const number = sessions++
      return { data: { session: options.sessions ? options.sessions[number] ?? null : session }, error: null }
    } },
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args: plain(args) })
      if (options.rpc) return options.rpc(name, args)
      if (name === 'xelay_teaching_prepare_grade_voice') return { data: {
        storage_path: `${args.p_request_id}/${userId}/${args.p_upload_id}.${({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' })[args.p_mime_type]}`,
        mime_type: args.p_mime_type, size: args.p_size, duration_seconds: args.p_duration_seconds,
      }, error: null }
      throw Error(`Unexpected RPC ${name}`)
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'teaching-grade-voices')
      return {
        async createSignedUrl(path, ttl) {
          calls.push({ kind: 'signed', path, ttl })
          return { data: options.urlMissing ? null : { signedUrl: options.signedUrl ?? signedUrl }, error: options.storageError ?? null }
        },
        async remove(paths) {
          calls.push({ kind: 'remove', paths })
          return { data: paths, error: options.storageError ?? null }
        },
      }
    } },
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require(name) {
      if (name === './supabase') return { supabase }
      if (name === './teachingFileUpload') return { uploadTeachingStorageFile: async input => {
        uploads.push(input); calls.push({ kind: 'upload' }); if (options.upload) return options.upload(input)
      } }
      throw Error(`Unexpected offline import ${name}`)
    },
    crypto: { randomUUID }, File, Blob, URL, DOMException, AbortSignal, AbortController,
  })
  return { exports, calls, uploads, session }
}

test('voice descriptors only allow the exact request/uploader/path and bounded audio metadata', () => {
  const fx = fixture()
  assert.deepEqual(plain(fx.exports.validateTeachingGradeVoice(requestId, voice, userId)), voice)
  const cases = [
    { ...voice, storage_path: `https://attacker.example/${voice.storage_path}` },
    { ...voice, storage_path: `${randomUUID()}/${userId}/${uploadId}.webm` },
    { ...voice, storage_path: `${requestId}/${userId}/${uploadId}.mp4` },
    { ...voice, storage_path: `${requestId}/${userId}/../voice.webm` },
    { ...voice, storage_path: `${requestId}/${userId}/${uploadId}.webm?x=1` },
    { ...voice, mime_type: 'video/webm' }, { ...voice, mime_type: '__proto__' },
    { ...voice, size: 0 }, { ...voice, size: 0.5 }, { ...voice, size: 10 * 1024 * 1024 + 1 },
    { ...voice, duration_seconds: 0 }, { ...voice, duration_seconds: Number.NaN }, { ...voice, duration_seconds: 300.01 },
  ]
  for (const value of cases) assert.throws(() => fx.exports.validateTeachingGradeVoice(requestId, value), /VOICE_INVALID/)
  assert.throws(() => fx.exports.validateTeachingGradeVoice(requestId, voice, randomUUID()), /VOICE_INVALID/)
  assert.throws(() => fx.exports.validateTeachingGradeVoice('not-a-request', voice), /VOICE_INVALID/)
})

test('listening requests a short private signed URL and never creates a public URL', async () => {
  const fx = fixture()
  assert.match(await fx.exports.gradeVoiceUrl(requestId, voice), /\/object\/sign\/teaching-grade-voices\//)
  assert.deepEqual(fx.calls.map(call => call.kind), ['auth', 'signed', 'auth'])
  assert.deepEqual(fx.calls[1], { kind: 'signed', path: voice.storage_path, ttl: 120 })
})

test('invalid descriptors, denied storage and account changes cannot return an audio link', async () => {
  const invalid = fixture()
  await assert.rejects(invalid.exports.gradeVoiceUrl(randomUUID(), voice), /VOICE_INVALID/)
  assert.equal(invalid.calls.length, 0)
  const denied = fixture({ storageError: { message: 'FORBIDDEN' } })
  await assert.rejects(denied.exports.gradeVoiceUrl(requestId, voice), error => error.message === 'FORBIDDEN')
  const signedOut = fixture({ sessions: [null] })
  await assert.rejects(signedOut.exports.gradeVoiceUrl(requestId, voice), /ACTOR_CHANGED/)
  const changed = fixture({ sessions: [{ access_token: 'offline', user: { id: userId } }, { access_token: 'offline2', user: { id: randomUUID() } }] })
  await assert.rejects(changed.exports.gradeVoiceUrl(requestId, voice), /ACTOR_CHANGED/)
})

test('signed URL responses cannot redirect private audio to another origin or object', async () => {
  for (const signedUrl of ['https://attacker.example/audio', 'javascript:alert(1)',
    `https://offline.supabase.co/storage/v1/object/public/teaching-grade-voices/${voice.storage_path}`,
    `https://offline.supabase.co/storage/v1/object/sign/teaching-grade-voices/${randomUUID()}/${userId}/${uploadId}.webm?token=x`]) {
    const fx = fixture({ signedUrl })
    await assert.rejects(fx.exports.gradeVoiceUrl(requestId, voice), /VOICE_UNAVAILABLE/)
  }
})

test('upload reserves exact metadata, checks the current account, and uses the existing progress uploader', async () => {
  for (const [mime, extension] of [['audio/webm;codecs=opus', 'webm'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/mp4', 'mp4']]) {
    const progress = [], signal = new AbortController().signal
    const file = new File([new Uint8Array(16)], `voice.${extension}`, { type: mime })
    const fx = fixture({ upload(input) { input.onProgress?.(51); input.onProgress?.(100) } })
    const saved = plain(await fx.exports.uploadGradeVoice(requestId, userId, { file, durationSeconds: 5.4 }, value => progress.push(value), signal))
    assert.match(saved.storage_path, new RegExp(`^${requestId}/${userId}/[a-f0-9-]+\\.${extension}$`))
    assert.equal(saved.mime_type, mime.split(';')[0])
    assert.equal(saved.size, 16)
    assert.equal(saved.duration_seconds, 5.4)
    assert.deepEqual(fx.calls.map(call => call.kind), ['auth', 'rpc', 'auth', 'upload', 'auth'])
    assert.equal(fx.uploads[0].file, file)
    assert.equal(fx.uploads[0].signal, signal)
    assert.equal(fx.uploads[0].accessToken, 'offline-only-token')
    assert.equal(fx.uploads[0].bucket, 'teaching-grade-voices')
    assert.deepEqual(progress, [51, 100])
  }
})

test('wrong files, missing/changed accounts and server refusal never upload private bytes', async () => {
  const file = new File([new Uint8Array(16)], 'voice.webm', { type: 'audio/webm' })
  const invalid = [
    { file: new File([], 'empty.webm', { type: 'audio/webm' }), durationSeconds: 1 },
    { file: new File(['x'], 'video.webm', { type: 'video/webm' }), durationSeconds: 1 },
    { file: new File(['x'], 'recording.mp3', { type: 'audio/mpeg' }), durationSeconds: 1 },
    { file, durationSeconds: 301 }, { file, durationSeconds: 0 },
  ]
  for (const recording of invalid) {
    const fx = fixture()
    await assert.rejects(fx.exports.uploadGradeVoice(requestId, userId, recording), /VOICE_INVALID/)
    assert.equal(fx.calls.length, 0)
  }
  const denied = fixture({ rpc: async () => ({ data: null, error: { message: 'TEACHING_FORBIDDEN' } }) })
  await assert.rejects(denied.exports.uploadGradeVoice(requestId, userId, { file, durationSeconds: 1 }), error => error.message === 'TEACHING_FORBIDDEN')
  assert.equal(denied.uploads.length, 0)
  const switched = fixture({ sessions: [{ access_token: 'old', user: { id: userId } }, { access_token: 'new', user: { id: randomUUID() } }] })
  await assert.rejects(switched.exports.uploadGradeVoice(requestId, userId, { file, durationSeconds: 1 }), /ACTOR_CHANGED/)
  assert.equal(switched.uploads.length, 0)
})

test('an unexpected server path or metadata is never trusted for an upload', async () => {
  const file = new File([new Uint8Array(16)], 'voice.webm', { type: 'audio/webm' })
  for (const patch of [{ storage_path: `${requestId}/${userId}/${randomUUID()}.webm` }, { size: 17 }, { duration_seconds: 99 }, { mime_type: 'video/webm' }]) {
    const fx = fixture({ rpc: async (_name, args) => ({ data: { ...voice, storage_path: `${requestId}/${userId}/${args.p_upload_id}.webm`, duration_seconds: 1, ...patch }, error: null }) })
    await assert.rejects(fx.exports.uploadGradeVoice(requestId, userId, { file, durationSeconds: 1 }), /VOICE_INVALID/)
    assert.equal(fx.uploads.length, 0)
  }
})

test('cancellation and failed upload preserve the original failure and attempt only guarded cleanup', async () => {
  const file = new File([new Uint8Array(16)], 'voice.webm', { type: 'audio/webm' })
  const controller = new AbortController(); controller.abort()
  const aborted = fixture()
  await assert.rejects(aborted.exports.uploadGradeVoice(requestId, userId, { file, durationSeconds: 1 }, undefined, controller.signal), error => error.name === 'AbortError')
  assert.equal(aborted.calls.length, 0)
  const failure = new Error('Offline upload unavailable')
  const fx = fixture({ upload() { throw failure }, storageError: { message: 'Cannot remove a used voice' } })
  await assert.rejects(fx.exports.uploadGradeVoice(requestId, userId, { file, durationSeconds: 1 }), error => error === failure)
  assert.equal(fx.calls.filter(call => call.kind === 'remove').length, 1)
  assert.equal(fx.calls.filter(call => call.kind === 'rpc').length, 1)
})

test('discard cannot delete another uploader voice and propagates the authoritative used-file refusal', async () => {
  const other = fixture()
  await assert.rejects(other.exports.discardGradeVoice(requestId, { ...voice, storage_path: `${requestId}/${randomUUID()}/${uploadId}.webm` }), /ACTOR_CHANGED/)
  assert.equal(other.calls.some(call => call.kind === 'remove'), false)
  const used = fixture({ storageError: { message: 'TEACHING_GRADE_VOICE_IN_USE' } })
  await assert.rejects(used.exports.discardGradeVoice(requestId, voice), error => error.message === 'TEACHING_GRADE_VOICE_IN_USE')
  assert.deepEqual(used.calls.map(call => call.kind), ['auth', 'remove'])
})
