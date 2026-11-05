import { useEffect, useRef, useState } from 'react'

const keyPrefix = 'xelay-test-tab-exit:'

function restoreEvents(prefix: string): string[] {
  try {
    return Object.keys(localStorage)
      .filter(key => key.startsWith(prefix))
      .sort((a, b) => Number(localStorage.getItem(a)) - Number(localStorage.getItem(b)))
      .map(key => key.slice(prefix.length))
      .filter(id => /^[0-9a-f-]{36}$/i.test(id))
  } catch { return [] }
}

export function useTeachingTestTabGuard(
  scope: string | undefined,
  canSend: () => boolean,
  report: (eventId: string) => Promise<boolean>,
) {
  const callbacks = useRef({ canSend, report })
  callbacks.current = { canSend, report }
  const queued = useRef<string[]>([])
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    queued.current = scope ? restoreEvents(`${keyPrefix}${scope}:`) : []
    setPendingCount(queued.current.length)
    if (!scope) return
    const prefix = `${keyPrefix}${scope}:`
    let hidden = document.visibilityState === 'hidden'
    let sending = false
    let active = true

    async function drain() {
      if (sending || !queued.current.length || !callbacks.current.canSend()) return
      sending = true
      try {
        while (active && queued.current.length && callbacks.current.canSend()) {
          const id = queued.current[0]
          if (!await callbacks.current.report(id)) return
          try { localStorage.removeItem(prefix + id) } catch { /* browser storage can be disabled */ }
          if (!active) return
          queued.current.shift()
          setPendingCount(queued.current.length)
        }
      } finally { sending = false }
    }

    function updateVisibility(nowHidden: boolean) {
      if (nowHidden && !hidden) {
        const id = crypto.randomUUID()
        queued.current.push(id)
        try { localStorage.setItem(prefix + id, String(Date.now())) } catch { /* retain in memory */ }
        setPendingCount(queued.current.length)
      }
      hidden = nowHidden
      void drain()
    }

    const visibilityChanged = () => updateVisibility(document.visibilityState === 'hidden')
    const pageHidden = () => updateVisibility(true)
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('pagehide', pageHidden)
    window.addEventListener('online', drain)
    const retry = window.setInterval(() => void drain(), 2500)
    void drain()
    return () => {
      active = false
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', pageHidden)
      window.removeEventListener('online', drain)
      window.clearInterval(retry)
    }
  }, [scope])

  return { pendingCount: scope ? pendingCount : 0, hasPending: () => Boolean(scope && queued.current.length) }
}
