type Waiter = (result: boolean | null) => void
type Read = { silent: boolean; started: boolean; invalidated: boolean; controller: AbortController; waiters: Waiter[] }

/** One workspace/session only. No responses or permissions are cached here. */
export function createStudyGroupRefresh(load: (silent: boolean, signal: AbortSignal) => Promise<boolean>) {
  let current: Read | null = null
  let queued: Read | null = null
  const create = (silent: boolean): Read => ({ silent, started: false, invalidated: false, controller: new AbortController(), waiters: [] })
  const settle = (read: Read, result: boolean | null) => {
    read.waiters.splice(0).forEach(resolve => resolve(result))
  }
  const schedule = (read: Read) => {
    // Batch focus/online/realtime events delivered in the same turn before any
    // transport starts. A later data change needs one fresh, serial read.
    void Promise.resolve().then(async () => {
      if (current !== read || read.invalidated || read.controller.signal.aborted) return
      read.started = true
      let result = false
      try { result = await load(read.silent, read.controller.signal) }
      catch { /* The page reports read failures; the coordinator remains usable. */ }
      finally {
        settle(read, read.invalidated || read.controller.signal.aborted ? null : result)
        if (current === read) {
          current = queued
          queued = null
          if (current) schedule(current)
        }
      }
    })
  }
  return {
    request(silent = false, fresh = true): Promise<boolean | null> {
      return new Promise(resolve => {
        if (!current) {
          current = create(silent)
          current.waiters.push(resolve)
          schedule(current)
          return
        }
        if (!current.started && !current.invalidated) {
          current.silent = current.silent && silent
          current.waiters.push(resolve)
          return
        }
        if (!fresh && !current.invalidated && !current.controller.signal.aborted && !queued) {
          current.waiters.push(resolve)
          return
        }
        queued ??= create(silent)
        queued.silent = queued.silent && silent
        queued.waiters.push(resolve)
        // New server data must not be overwritten by a response that was read
        // before the event/mutation. All its callers await the fresh result.
        queued.waiters.push(...current.waiters.splice(0))
        current.controller.abort()
      })
    },
    cancel() {
      if (queued) { queued.invalidated = true; queued.controller.abort(); settle(queued, null); queued = null }
      if (!current) return
      current.invalidated = true
      current.controller.abort()
      settle(current, null)
      // A started transport settles before a new one runs, even when its
      // provider ignores abort. An unstarted microtask can simply be dropped.
      if (!current.started) current = null
    },
  }
}
