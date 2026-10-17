import { useEffect, useState } from 'react'
import { loadProfileBadgePreferences, PROFILE_BADGES_CHANGED, type ProfileBadgePreferences } from '../lib/profileBadgePreferences'

// Unknown visibility hides the decorative marks until the server answers.
export function useProfileBadgeVisibility(userId?: string) {
  const [snapshot, setSnapshot] = useState<{ userId: string; value: ProfileBadgePreferences } | null>(null)
  useEffect(() => {
    let active = true, version = 0
    let controller: AbortController | null = null
    setSnapshot(null)
    if (!userId) return
    const refresh = async () => {
      if (!active || document.visibilityState !== 'visible') return
      controller?.abort()
      const request = ++version
      const pending = new AbortController(); controller = pending
      const deadline = window.setTimeout(() => pending.abort(), 12_000)
      try {
        const value = await loadProfileBadgePreferences(userId, pending.signal)
        if (active && request === version) setSnapshot({ userId, value })
      } catch { if (active && request === version) setSnapshot(null) }
      finally { window.clearTimeout(deadline) }
    }
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ userId: string }>).detail?.userId !== userId) return
      setSnapshot(null); void refresh()
    }
    void refresh()
    window.addEventListener(PROFILE_BADGES_CHANGED, changed)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, 60_000)
    return () => {
      active = false; ++version; controller?.abort(); window.clearInterval(interval)
      window.removeEventListener(PROFILE_BADGES_CHANGED, changed)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [userId])
  return snapshot?.userId === userId ? snapshot?.value ?? null : null
}
