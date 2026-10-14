interface NotificationRefreshEnvironment {
  now: () => number
  isVisible: () => boolean
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (timer: number) => void
}

interface NotificationUnreadRefreshOptions {
  fetchCount: (signal: AbortSignal) => Promise<number>
  onCount: (count: number) => void
  environment?: NotificationRefreshEnvironment
}

/** One authoritative count request at a time, including when Realtime arrives during a fetch. */
export function createNotificationUnreadRefresher({ fetchCount, onCount, environment }: NotificationUnreadRefreshOptions) {
  const clock = environment ?? {
    now: () => Date.now(),
    isVisible: () => document.visibilityState === 'visible',
    setTimeout: (callback: () => void, delay: number) => window.setTimeout(callback, delay),
    clearTimeout: (timer: number) => window.clearTimeout(timer),
  }
  let active = true
  let pending = false
  let realtimeReady = false
  let revision = 0
  let debounceTimer: number | undefined
  let fallbackTimer: number | undefined
  let request: AbortController | null = null
  let nextRequestAt = Number.NEGATIVE_INFINITY

  const clearDebounce = () => {
    if (debounceTimer !== undefined) clock.clearTimeout(debounceTimer)
    debounceTimer = undefined
  }

  const armFallback = () => {
    if (fallbackTimer !== undefined) clock.clearTimeout(fallbackTimer)
    if (!active) return
    fallbackTimer = clock.setTimeout(() => {
      fallbackTimer = undefined
      refresh()
    }, realtimeReady ? 60_000 : 30_000)
  }

  const schedule = () => {
    if (!active || !clock.isVisible() || request || debounceTimer !== undefined) return
    debounceTimer = clock.setTimeout(() => {
      debounceTimer = undefined
      refresh()
    }, Math.max(250, nextRequestAt - clock.now()))
  }

  const readCount = (controller: AbortController) => new Promise<number>((resolve, reject) => {
    let settled = false
    const settle = (complete: () => void) => {
      if (settled) return
      settled = true
      clock.clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = () => settle(() => reject(new Error('notification_count_aborted')))
    const timeout = clock.setTimeout(() => controller.abort(), 10_000)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      Promise.resolve(fetchCount(controller.signal)).then(
        (count) => settle(() => resolve(count)),
        (error) => settle(() => reject(error)),
      )
    } catch (error) { settle(() => reject(error)) }
  })

  const refresh = () => {
    if (!active) return
    pending = true
    if (!clock.isVisible() || request) {
      if (fallbackTimer === undefined) armFallback()
      return
    }
    if (clock.now() < nextRequestAt) { schedule(); return }
    clearDebounce()
    armFallback()
    pending = false
    const controller = new AbortController()
    request = controller
    // A continuous stream must not turn completion into an immediate request loop.
    nextRequestAt = clock.now() + 2_000
    const requestRevision = revision
    void (async () => {
      try {
        const count = await readCount(controller)
        // A mutation received while this snapshot was loading requires a newer count.
        if (active && !controller.signal.aborted && clock.isVisible() && revision === requestRevision
          && Number.isFinite(count) && count >= 0) onCount(Math.floor(count))
      } catch {
        // Preserve the last known badge on a temporary network error; reconciliation retries.
      } finally {
        if (request === controller) request = null
        if (active && pending) schedule()
      }
    })()
  }

  const invalidate = () => {
    if (!active) return
    revision += 1
    pending = true
    schedule()
  }

  const visibilityChanged = () => {
    if (!active) return
    if (clock.isVisible()) refresh()
    else {
      clearDebounce()
      revision += 1
      pending = true
      request?.abort()
    }
  }

  // Realtime can be absent from an older installation or disconnected in the background.
  refresh()

  return {
    refresh,
    invalidate,
    visibilityChanged,
    realtimeStatus(ready: boolean) {
      if (!active) return
      const becameReady = ready && !realtimeReady
      realtimeReady = ready
      armFallback()
      if (becameReady) invalidate()
    },
    dispose() {
      active = false
      pending = false
      clearDebounce()
      if (fallbackTimer !== undefined) clock.clearTimeout(fallbackTimer)
      request?.abort()
    },
  }
}

/** Delete payloads can contain only the primary key under RLS, so reconcile without trusting a delta. */
export function notificationChangeAffectsRecipient(payload: { new?: unknown; old?: unknown }, recipientId: string): boolean {
  const recipientOf = (row: unknown) => row && typeof row === 'object' && 'recipient_id' in row
    ? String(row.recipient_id) : null
  const currentRecipient = recipientOf(payload.new)
  const previousRecipient = recipientOf(payload.old)
  return currentRecipient === recipientId || previousRecipient === recipientId
    || (currentRecipient === null && previousRecipient === null)
}
