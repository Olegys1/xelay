import { nextWinterBoundary } from './winterCampaign'

interface WinterClockRuntime {
  now: () => number
  schedule: (callback: () => void, delay: number) => () => void
  onResume: (callback: () => void) => () => void
}

/** One boundary timer shared by every consumer. It controls cosmetics, never rewards. */
export function createWinterClock(runtime: WinterClockRuntime) {
  let snapshot = runtime.now()
  const listeners = new Set<() => void>()
  let cancelTimer: (() => void) | undefined
  let removeResume: (() => void) | undefined
  const refresh = () => {
    cancelTimer?.(); cancelTimer = undefined
    const next = runtime.now()
    if (next !== snapshot) {
      snapshot = next
      listeners.forEach(listener => listener())
    }
    if (!listeners.size) return
    const boundary = nextWinterBoundary(next)
    // Browsers clamp timers above ~24.8 days. Long waits use bounded chunks,
    // rather than a repeating interval or requests to the application API.
    if (boundary !== null) cancelTimer = runtime.schedule(refresh, Math.min(2_147_483_600, Math.max(1, boundary - next)))
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) { removeResume = runtime.onResume(refresh); refresh() }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          cancelTimer?.(); cancelTimer = undefined
          removeResume?.(); removeResume = undefined
        }
      }
    },
  }
}
