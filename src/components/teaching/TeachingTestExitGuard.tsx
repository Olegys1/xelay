import { useEffect, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'

/** Browser chrome cannot show our wording. It gets a native leave warning;
 * actual pagehide/visibilitychange is recorded separately by the tab guard. */
export function TeachingTestExitGuard({ active, requestLeave }: { active: boolean; requestLeave: () => Promise<boolean> }) {
  const router = useRouter({ warn: false })
  const callbacks = useRef({ active, requestLeave, permitted: false })
  callbacks.current.active = active
  callbacks.current.requestLeave = requestLeave

  useEffect(() => {
    if (!active) return
    callbacks.current.permitted = false
    let navigating = false
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!callbacks.current.active || callbacks.current.permitted) return
      event.preventDefault()
      event.returnValue = ''
    }
    const clickedLink = (event: MouseEvent) => {
      if (!callbacks.current.active || callbacks.current.permitted || event.defaultPrevented || event.button > 1) return
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!target || target.hasAttribute('download')) return
      let url: URL
      try { url = new URL(target.href, window.location.href) } catch { return }
      if (!['http:', 'https:'].includes(url.protocol)) return
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (navigating) return
      navigating = true
      void callbacks.current.requestLeave().then(allowed => {
        if (!allowed) return
        callbacks.current.permitted = true
        // Do not open an empty new tab before the confirmed save has completed.
        window.location.assign(url.href)
      }).catch(() => { /* A failed confirmation must never navigate. */ }).finally(() => { navigating = false })
    }
    const unblock = router?.history.block({
      blockerFn: async () => {
        if (!callbacks.current.active || callbacks.current.permitted) return false
        if (navigating) return true
        navigating = true
        try {
          const allowed = await callbacks.current.requestLeave()
          if (allowed) callbacks.current.permitted = true
          return !allowed
        } catch { return true } finally { navigating = false }
      },
      enableBeforeUnload: false,
    })
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', clickedLink, true)
    document.addEventListener('auxclick', clickedLink, true)
    return () => {
      unblock?.()
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', clickedLink, true)
      document.removeEventListener('auxclick', clickedLink, true)
    }
  }, [active, router])
  return null
}
