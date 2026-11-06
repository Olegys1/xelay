import { BlobSource, BufferTarget, Conversion, Input, MP4, Mp4OutputFormat, Output, WEBM, WebMOutputFormat } from 'mediabunny'

const MINIMUM_SAVING = 4 * 1024

export async function remuxTeachingLectureVideo(file: File): Promise<File | null> {
  const isMp4 = /\.mp4$/i.test(file.name)
  if (!isMp4 && !/\.webm$/i.test(file.name)) return null
  const inputFormat = isMp4 ? MP4 : WEBM
  const input = new Input({ source: new BlobSource(file), formats: [inputFormat] })
  try {
    if (!(await input.getVideoTracks()).length) return null
    const sourceTracks = await input.getTracks()
    const sourceDuration = await input.getDurationFromMetadata()
    if (sourceDuration === null || !Number.isFinite(sourceDuration) || sourceDuration < 1) return null

    const target = new BufferTarget()
    const output = new Output({ target, format: isMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat() })
    // Forced copy keeps the original encoded video, audio and subtitle packets.
    // Reject conversions that would drop any source track.
    const conversion = await Conversion.init({ input, output, tracks: 'all', copy: { mode: 'forced' }, showWarnings: false })
    if (!conversion.isValid || conversion.discardedTracks.length || conversion.utilizedTracks.length !== sourceTracks.length) return null
    await conversion.execute()
    const bytes = target.buffer
    if (!bytes || file.size - bytes.byteLength < MINIMUM_SAVING) return null

    const candidate = new File([bytes], file.name, { type: isMp4 ? 'video/mp4' : 'video/webm', lastModified: file.lastModified })
    const check = new Input({ source: new BlobSource(candidate), formats: [inputFormat] })
    try {
      const duration = await check.getDurationFromMetadata()
      if (duration === null || !Number.isFinite(duration) || Math.abs(duration - sourceDuration) > 0.05) return null
      return candidate
    } finally { check.dispose() }
  } finally { input.dispose() }
}

if (typeof document === 'undefined' && typeof self !== 'undefined') {
  self.onmessage = (event: MessageEvent<File>) => {
    void remuxTeachingLectureVideo(event.data).then(result => self.postMessage(result), () => self.postMessage(null))
  }
}
