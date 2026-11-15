import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { observeGroupReferralRead } from '../lib/groupReferralRepository'
import type { ReferralObserveInput } from '../lib/groupReferralTypes'

/** Observe only a resource actually displayed in a visible, authenticated group page. */
export function GroupReferralReadMarker({ actorId, groupId, kind, resourceId }: ReferralObserveInput & { actorId: string }) {
  const marker = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = marker.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    let active = true, visible = false, timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => { if (timer) clearTimeout(timer); timer = undefined }
    const record = async () => {
      const retry = await observeGroupReferralRead(supabase, actorId, { groupId, kind, resourceId })
      if (active && visible && document.visibilityState === 'visible' && retry !== null) timer = setTimeout(() => { if (active && visible && document.visibilityState === 'visible') void record() }, Math.max(1000, retry))
    }
    const schedule = () => {
      cancel()
      if (visible && document.visibilityState === 'visible' && navigator.onLine) timer = setTimeout(() => { void record() }, 1500)
    }
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); schedule() })
    observer.observe(element); document.addEventListener('visibilitychange', schedule); window.addEventListener('online', schedule)
    return () => { active = false; cancel(); observer.disconnect(); document.removeEventListener('visibilitychange', schedule); window.removeEventListener('online', schedule) }
  }, [actorId, groupId, kind, resourceId])
  return <span ref={marker} aria-hidden="true" className="pointer-events-none block h-px w-px" />
}
