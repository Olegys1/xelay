/** One bounded, cancelable account read. This never retries Auth or a write.
 * The race also settles callers when an SDK/transport ignores AbortSignal.
 * Only in-flight work is shared; completed roles are never cached here. */
export const AUTH_PROFILE_TIMEOUT_MS = 12_000
export const AUTH_SESSION_TIMEOUT_MS = 12_000

export function createAuthReadScope(timeoutMs = AUTH_PROFILE_TIMEOUT_MS) {
  const controller = new AbortController()
  let rejectAborted: (reason: Error) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
  // A scope can be canceled between reads; keep that rejection observed.
  void aborted.catch(() => {})
  const cancel = (reason: Error = Object.assign(new Error('Account read canceled'), { name: 'AbortError' })) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    rejectAborted(reason)
  }
  const timer = setTimeout(() => cancel(Object.assign(new Error('Account read timed out'), {
    name: 'TimeoutError', code: 'request_timeout',
  })), timeoutMs)
  return {
    signal: controller.signal,
    read<T>(load: (signal: AbortSignal) => PromiseLike<T> | T): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason)
      return Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return load(controller.signal)
      }), aborted])
    },
    cancel,
    dispose() { clearTimeout(timer) },
  }
}

export type AuthReadScope = ReturnType<typeof createAuthReadScope>

export function createAuthProfileFlight() {
  let active: { userId: string; scope: AuthReadScope; promise: Promise<void> } | null = null
  return {
    run(userId: string, load: (scope: AuthReadScope) => Promise<void>): Promise<void> {
      if (active?.userId === userId) return active.promise
      active?.scope.cancel()
      const scope = createAuthReadScope()
      const flight = { userId, scope, promise: Promise.resolve() }
      active = flight
      flight.promise = Promise.resolve().then(() => {
        if (!scope.signal.aborted) return load(scope)
      }).finally(() => {
        scope.dispose()
        if (active === flight) active = null
      })
      return flight.promise
    },
    cancel() {
      const previous = active
      active = null
      previous?.scope.cancel()
      previous?.scope.dispose()
    },
  }
}
