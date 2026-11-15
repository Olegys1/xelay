import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

const MAX_PAGES = 1000
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 120_000
const MAX_CACHE_DOCUMENTS = 2
const MAX_CACHE_BYTES = 128 * 1024 * 1024
const MAX_QUEUE = 16
const MAX_WAIT_MS = 5000
const SOURCE_TIMEOUT_MS = 20_000
const WORKER_TIMEOUT_MS = 15_000
const UNSUPPORTED = 'Не вдалося підготувати захищений перегляд. Попросіть викладача додати звичайний PDF або зображення.'
const UNAVAILABLE = 'Захищений перегляд тимчасово недоступний. Спробуйте ще раз.'
const BUSY = 'Переглядач зараз завантажений. Спробуйте за кілька секунд.'

type RasterFile = {
  storage_path: string
  version: number
  size: number
  mime_type: string
  preview_kind: 'pdf' | 'image' | 'text'
  author_name: string
  viewer_name: string
}
type LoadSource = (signal: AbortSignal) => Promise<Uint8Array>
type RasterResult = { pageCount: number; bytes?: Buffer }
type PageRequest = { page: number; viewerName: string; authorName: string }
type CacheEntry = {
  bytes: number
  expires: number
  busy: boolean
  worker?: Worker
  pageCount?: number
  timer?: NodeJS.Timeout
}
type QueueEntry = {
  key: string
  file: RasterFile
  loadSource: LoadSource
  signal: AbortSignal
  page?: number
  resolve: (value: RasterResult) => void
  reject: (reason: unknown) => void
  stopWaiting: () => void
}

export class TeachingMaterialRasterError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const cache = new Map<string, CacheEntry>()
const queue: QueueEntry[] = []
const terminating = new Set<Promise<number | void>>()
const terminationWaiters = new Set<() => void>()
let active = 0

function discard(key: string, entry: CacheEntry) {
  if (cache.get(key) !== entry) return
  cache.delete(key)
  clearTimeout(entry.timer)
  if (entry.worker) {
    const ending = entry.worker.terminate().catch(() => {})
    terminating.add(ending)
    void ending.finally(() => {
      terminating.delete(ending)
      if (!terminating.size) for (const ready of terminationWaiters) ready()
    })
  }
}

function claim(key: string, file: RasterFile): CacheEntry {
  const current = cache.get(key)
  if (current) {
    cache.delete(key)
    cache.set(key, current)
    return current
  }
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  for (const [oldKey, old] of cache) {
    if (cache.size < MAX_CACHE_DOCUMENTS && total + file.size <= MAX_CACHE_BYTES) break
    if (!old.busy) {
      total -= old.bytes
      discard(oldKey, old)
    }
  }
  if (cache.size >= MAX_CACHE_DOCUMENTS || total + file.size > MAX_CACHE_BYTES) {
    throw new TeachingMaterialRasterError(429, BUSY)
  }
  const entry = { bytes: file.size, expires: Infinity, busy: false }
  cache.set(key, entry)
  return entry
}

function readWorker(worker: Worker, signal: AbortSignal, request?: PageRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const failed = () => { cleanup(); reject(new TeachingMaterialRasterError(503, UNAVAILABLE)) }
    const aborted = () => { cleanup(); reject(signal.reason) }
    const received = (value: unknown) => { cleanup(); resolve(value) }
    const timer = setTimeout(failed, WORKER_TIMEOUT_MS)
    function cleanup() {
      clearTimeout(timer)
      worker.off('message', received)
      worker.off('error', failed)
      worker.off('exit', failed)
      signal.removeEventListener('abort', aborted)
    }
    worker.once('message', received)
    worker.once('error', failed)
    worker.once('exit', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (request) {
      try { worker.postMessage(request) } catch { failed() }
    }
  })
}

function validWorkerReply(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TeachingMaterialRasterError(503, UNAVAILABLE)
  const reply = value as Record<string, unknown>
  if (reply.kind === 'unsupported') throw new TeachingMaterialRasterError(415, UNSUPPORTED)
  return reply
}

function waitForTerminatingWorkers(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!terminating.size) return Promise.resolve()
  return new Promise((resolve, reject) => {
    function cleanup() {
      terminationWaiters.delete(ready)
      signal.removeEventListener('abort', abort)
    }
    function abort() {
      cleanup()
      reject(signal.reason)
    }
    function ready() {
      cleanup()
      resolve()
    }
    terminationWaiters.add(ready)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function startWorker(job: QueueEntry, entry: CacheEntry) {
  const { file, signal, loadSource, key } = job
  const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)])
  while (terminating.size) await waitForTerminatingWorkers(sourceSignal)
  const data = await loadSource(sourceSignal)
  sourceSignal.throwIfAborted()
  if (!(data instanceof Uint8Array) || data.byteLength !== file.size) {
    throw new TeachingMaterialRasterError(415, UNSUPPORTED)
  }
  // Wait for evicted workers to finish before starting another native renderer.
  while (terminating.size) await waitForTerminatingWorkers(sourceSignal)
  sourceSignal.throwIfAborted()
  const bytes = data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data : new Uint8Array(data)
  const worker = new Worker(join(process.cwd(), 'server', 'teachingMaterialRasterWorker.mjs'), {
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    workerData: { kind: file.preview_kind, mime: file.mime_type, bytes },
    transferList: [bytes.buffer as ArrayBuffer],
  })
  entry.worker = worker
  // Keep idle crashes from becoming an unhandled main-thread EventEmitter error.
  worker.on('error', () => {})
  worker.once('exit', () => {
    if (cache.get(key) === entry) {
      cache.delete(key)
      clearTimeout(entry.timer)
    }
  })
  const reply = validWorkerReply(await readWorker(worker, signal))
  const pageCount = Number(reply.pageCount)
  if (reply.kind !== 'ready' || !Number.isSafeInteger(reply.pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    throw new TeachingMaterialRasterError(503, UNAVAILABLE)
  }
  entry.pageCount = pageCount
  entry.expires = Date.now() + CACHE_TTL_MS
  entry.timer = setTimeout(() => { if (!entry.busy) discard(key, entry) }, CACHE_TTL_MS)
  entry.timer.unref()
}

async function run(job: QueueEntry, entry: CacheEntry): Promise<RasterResult> {
  const { key, page, signal } = job
  try {
    if (!entry.worker) await startWorker(job, entry)
    signal.throwIfAborted()
  } catch (error) {
    discard(key, entry)
    throw error
  }
  const pageCount = entry.pageCount!
  if (page === undefined) return { pageCount }
  if (page > pageCount) throw new TeachingMaterialRasterError(416, 'Такої сторінки немає.')

  const worker = entry.worker!
  worker.ref()
  try {
    const reply = validWorkerReply(await readWorker(worker, signal, {
      page, viewerName: job.file.viewer_name, authorName: job.file.author_name,
    }))
    if (reply.kind !== 'page' || !(reply.bytes instanceof Uint8Array)) {
      throw new TeachingMaterialRasterError(503, UNAVAILABLE)
    }
    const bytes = Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength)
    return { pageCount, bytes }
  } catch (error) {
    // A timed out, aborted or failed render may still be running. Terminate
    // its worker before any later request can reuse that document.
    discard(key, entry)
    throw error
  }
}

function drainQueue() {
  for (const [key, entry] of cache) {
    if (!entry.busy && entry.expires <= Date.now()) discard(key, entry)
  }
  while (active < MAX_CACHE_DOCUMENTS) {
    // Do not occupy a second worker slot waiting on the same document.
    const index = queue.findIndex(job => !cache.get(job.key)?.busy)
    if (index < 0) return
    const [job] = queue.splice(index, 1)
    job.stopWaiting()
    let entry: CacheEntry
    try {
      entry = claim(job.key, job.file)
    } catch (error) {
      job.reject(error)
      continue
    }
    entry.busy = true
    active++
    void run(job, entry).then(job.resolve, job.reject).finally(() => {
      entry.busy = false
      active--
      if (entry.expires <= Date.now()) discard(job.key, entry)
      entry.worker?.unref()
      drainQueue()
    })
  }
}

/** Call only after authorizing the canonical attachment as the current viewer. */
export async function withTeachingMaterialRaster(
  file: RasterFile, loadSource: LoadSource, signal: AbortSignal, page?: number,
): Promise<RasterResult> {
  signal.throwIfAborted()
  if (file.preview_kind === 'text' && file.size > MAX_TEXT_BYTES) {
    throw new TeachingMaterialRasterError(415, 'Для захищеного перегляду текстового файлу понад 2 МБ додайте PDF.')
  }
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES)) {
    throw new TeachingMaterialRasterError(416, 'Такої сторінки немає.')
  }
  if (file.preview_kind === 'image' && page === undefined) return { pageCount: 1 }
  if (file.preview_kind === 'image' && page !== 1) {
    throw new TeachingMaterialRasterError(416, 'Такої сторінки немає.')
  }
  const key = JSON.stringify([file.storage_path, file.version, file.size, file.mime_type])
  const cached = cache.get(key)
  if (page === undefined && cached?.pageCount && cached.expires > Date.now()) {
    return { pageCount: cached.pageCount }
  }
  if (queue.length >= MAX_QUEUE) throw new TeachingMaterialRasterError(429, BUSY)

  return new Promise((resolve, reject) => {
    const job: QueueEntry = { key, file, loadSource, signal, page, resolve, reject, stopWaiting }
    const timer = setTimeout(() => cancel(new TeachingMaterialRasterError(429, BUSY)), MAX_WAIT_MS)
    function stopWaiting() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    function cancel(reason: unknown) {
      const index = queue.indexOf(job)
      if (index < 0) return
      queue.splice(index, 1)
      stopWaiting()
      reject(reason)
    }
    function abort() { cancel(signal.reason) }
    queue.push(job)
    signal.addEventListener('abort', abort, { once: true })
    drainQueue()
  })
}
