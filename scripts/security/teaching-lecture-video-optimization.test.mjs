import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { BlobSource, EncodedPacketSink, Input, MP4 } from 'mediabunny'
import { validateMedia } from '../../server/uploadMediaValidation.ts'
import { remuxTeachingLectureVideo } from '../../src/lib/teachingLectureVideoRemux.worker.ts'

async function packetFingerprints(file) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4] })
  try {
    return await Promise.all((await input.getTracks()).map(async track => {
      const hash = createHash('sha256')
      let packets = 0
      for await (const packet of new EncodedPacketSink(track).packets()) {
        hash.update(packet.data)
        packets++
      }
      return { type: track.type, packets, hash: hash.digest('hex') }
    }))
  } finally { input.dispose() }
}

test('lecture MP4 optimization shrinks the file while preserving encoded audio and video', async () => {
  const bytes = await readFile(new URL('../../src/assets/guides/teacher-course-20261104/04.mp4', import.meta.url))
  const padding = Buffer.alloc(64 * 1024)
  padding.writeUInt32BE(padding.length)
  padding.write('free', 4)
  const original = new File([bytes, padding], 'Лекція.mp4', { type: 'video/mp4', lastModified: 123 })
  const optimized = await remuxTeachingLectureVideo(original)

  assert.ok(optimized && optimized.size < original.size)
  assert.equal(optimized.name, original.name)
  assert.equal(optimized.lastModified, original.lastModified)
  validateMedia(Buffer.from(await optimized.arrayBuffer()), 'mp4')
  const before = await packetFingerprints(original)
  assert.deepEqual(new Set(before.map(track => track.type)), new Set(['video', 'audio']))
  assert.deepEqual(await packetFingerprints(optimized), before)
})
