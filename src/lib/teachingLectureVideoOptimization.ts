const MAX_LECTURE_SIZE = 50 * 1024 * 1024
const OPTIMIZATION_TIMEOUT = 15_000

/** Use the original whenever a lossless rewrite is unavailable or saves no space. */
export function optimizeTeachingLectureVideo(file: File, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted()
  if (!file.size || file.size > MAX_LECTURE_SIZE || !/\.(mp4|webm)$/i.test(file.name) || typeof Worker === 'undefined') {
    return Promise.resolve(file)
  }

  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(new URL('./teachingLectureVideoRemux.worker.ts', import.meta.url), { type: 'module' }) }
    catch { resolve(file); return }

    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    const finish = (optimized?: File | null) => {
      cleanup()
      resolve(optimized instanceof File && optimized.size > 0 && optimized.size < file.size ? optimized : file)
    }
    const abort = () => { cleanup(); reject(signal.reason) }
    const timeout = setTimeout(finish, OPTIMIZATION_TIMEOUT)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => finish(event.data)
    worker.onerror = () => finish()
    worker.onmessageerror = () => finish()
    try { worker.postMessage(file) }
    catch { finish() }
  })
}
