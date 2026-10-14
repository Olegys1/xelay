export type RefreshClock = {
  now: () => number
  setTimeout: (callback: () => void, delay: number) => unknown
  clearTimeout: (timer: unknown) => void
}

type RefreshOptions<T> = {
  load: (signal: AbortSignal) => Promise<T>
  onData: (data: T) => void
  onError: (error: unknown) => void
  onStart?: () => void
  onSettled?: () => void
  initialVisible: boolean
  fallbackMs: number
  debounceMs?: number
  reconcileMs?: number
  minBackgroundIntervalMs?: number
  readTimeoutMs?: number
  clock?: RefreshClock
}

const browserClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** One request at a time. Changes received during a request need a fresh pass;
 * duplicate refresh clicks simply wait for the request already in progress. */
export function createHomeFeedRefresh<T>(options: RefreshOptions<T>) {
  const clock = options.clock || browserClock
  const debounceMs = options.debounceMs ?? 400
  const reconcileMs = options.reconcileMs ?? 2_000
  const minBackgroundIntervalMs = options.minBackgroundIntervalMs ?? 5_000
  const readTimeoutMs = options.readTimeoutMs ?? 20_000
  let visible = options.initialVisible
  let disposed = false
  let dirty = false
  let flight: Promise<void> | null = null
  let abort: AbortController | null = null
  let debounceTimer: unknown
  let fallbackTimer: unknown
  let lastAttemptAt = -Infinity
  let revision = 0
  let completedRevision = -1

  const clearDebounce = () => {
    if (debounceTimer !== undefined) clock.clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  const clearFallback = () => {
    if (fallbackTimer !== undefined) clock.clearTimeout(fallbackTimer)
    fallbackTimer = undefined
  }

  // Abort alone does not settle RPCs which ignore AbortSignal. The wrapper
  // settles once, removes its deadline, and ignores every late source result.
  const loadWithDeadline = (currentAbort: AbortController): Promise<T> => new Promise((resolve, reject) => {
    let finished = false
    let timer: unknown
    const settle = (failed: boolean, value: T | unknown) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clock.clearTimeout(timer)
      currentAbort.signal.removeEventListener('abort', cancelled)
      if (failed) reject(value)
      else resolve(value as T)
    }
    const cancelled = () => settle(true, new DOMException('The request was cancelled.', 'AbortError'))
    currentAbort.signal.addEventListener('abort', cancelled, { once: true })
    timer = clock.setTimeout(() => {
      const error = new Error('The feed read took too long. Please retry.')
      error.name = 'HomeFeedReadTimeoutError'
      settle(true, error)
      currentAbort.abort()
    }, readTimeoutMs)
    if (currentAbort.signal.aborted) {
      cancelled()
      return
    }
    try {
      Promise.resolve(options.load(currentAbort.signal)).then(
        (value) => settle(false, value),
        (error) => settle(true, error),
      )
    } catch (error) {
      settle(true, error)
    }
  })

  const scheduleInvalidation = () => {
    if (disposed || !visible || !dirty || flight || debounceTimer !== undefined) return
    // Keep the first deadline: a stream of events must not slide it forever.
    const delay = Math.max(debounceMs, minBackgroundIntervalMs - (clock.now() - lastAttemptAt))
    debounceTimer = clock.setTimeout(() => {
      debounceTimer = undefined
      void request()
    }, delay)
  }

  const request = (queueIfRunning = false): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (queueIfRunning) {
      revision += 1
      dirty = true
    }
    const requiredRevision = revision
    if (!visible) {
      dirty = true
      return Promise.resolve()
    }
    clearDebounce()
    if (flight) {
      if (!queueIfRunning) return flight
      // A write can finish after the bounded second pass already started.
      // Only that explicit write waits for another fresh cycle; a continuous
      // stream of unrelated invalidations cannot keep its promise pending.
      return flight.then(() => {
        if (!disposed && visible && completedRevision < requiredRevision) return request()
      })
    }
    options.onStart?.()
    flight = (async () => {
      let passes = 0
      try {
        do {
          passes += 1
          dirty = false
          const snapshotRevision = revision
          lastAttemptAt = clock.now()
          const currentAbort = new AbortController()
          abort = currentAbort
          try {
            const data = await loadWithDeadline(currentAbort)
            if (!disposed && !currentAbort.signal.aborted) options.onData(data)
          } catch (error) {
            const timedOut = error instanceof Error && error.name === 'HomeFeedReadTimeoutError'
            if (!disposed && (!currentAbort.signal.aborted || timedOut)) options.onError(error)
          } finally {
            completedRevision = Math.max(completedRevision, snapshotRevision)
          }
        } while (!disposed && visible && dirty && passes < 2)
      } finally {
        flight = null
        abort = null
        if (!disposed) {
          options.onSettled?.()
          scheduleInvalidation()
        }
      }
    })()
    return flight
  }

  const invalidate = () => {
    if (disposed) return
    revision += 1
    dirty = true
    scheduleInvalidation()
  }

  const reconcile = () => {
    if (!disposed && visible && (dirty || clock.now() - lastAttemptAt >= reconcileMs)) {
      void request(dirty)
    }
  }

  const armFallback = () => {
    clearFallback()
    if (!disposed && visible) {
      fallbackTimer = clock.setTimeout(() => {
        fallbackTimer = undefined
        void request()
        armFallback()
      }, options.fallbackMs)
    }
  }

  const setVisible = (nextVisible: boolean) => {
    if (disposed || visible === nextVisible) return
    visible = nextVisible
    if (!visible) {
      // Reconcile when returning even if the browser dropped Realtime events.
      revision += 1
      dirty = true
      clearDebounce()
      clearFallback()
    } else {
      armFallback()
      reconcile()
    }
  }

  armFallback()
  return {
    request,
    invalidate,
    reconcile,
    setVisible,
    dispose: () => {
      disposed = true
      dirty = false
      clearDebounce()
      clearFallback()
      abort?.abort()
    },
  }
}
