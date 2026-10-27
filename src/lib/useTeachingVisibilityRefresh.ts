import { useEffect, useRef } from 'react'

type RefreshOptions = { enabled?: boolean; blocked?: boolean }

/** Refresh the visible teaching view once when focus returns, without polling. */
export function useTeachingVisibilityRefresh(callback: () => void | Promise<unknown>, options: RefreshOptions = {}): void {
  const latest = useRef({ callback, enabled: options.enabled !== false, blocked: Boolean(options.blocked) })
  latest.current = { callback, enabled: options.enabled !== false, blocked: Boolean(options.blocked) }

  useEffect(() => {
    let active = true, queued = false, lastRefreshAt = -Infinity
    const allowed = () => active && document.visibilityState === 'visible' && latest.current.enabled && !latest.current.blocked
    const refresh = () => {
      if (!allowed() || queued || Date.now() - lastRefreshAt < 1000) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!allowed() || Date.now() - lastRefreshAt < 1000) return
        lastRefreshAt = Date.now()
        try { void Promise.resolve(latest.current.callback()).catch(() => {}) } catch { /* The view handles its own loading errors. */ }
      })
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])
}
