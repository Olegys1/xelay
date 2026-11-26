import { useSyncExternalStore } from 'react'
import { createWinterClock } from '../lib/winterClock'
import { WINTER_STARTS_AT, winterDecorationsAvailable, winterPhase } from '../lib/winterCampaign'

const clock = createWinterClock({
  now: () => Date.now(),
  schedule(callback, delay) {
    const timer = window.setTimeout(callback, delay)
    return () => window.clearTimeout(timer)
  },
  onResume(callback) {
    const visible = () => { if (!document.hidden) callback() }
    window.addEventListener('focus', visible)
    window.addEventListener('pageshow', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', visible)
      window.removeEventListener('pageshow', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  },
})

export function useWinterCampaign() {
  const now = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot)
  return { now, started: now >= Date.parse(WINTER_STARTS_AT), decorationsAvailable: winterDecorationsAvailable(now), phase: winterPhase(now) }
}
