import { useEffect, useRef, useState } from 'react'

const keyPrefix = 'xelay-test-tab-exit:'

export type TeachingTestExitAnswer = { question_id: string; answer: unknown; version: number }
type ExitEvent = { id: string; at: number; answer?: TeachingTestExitAnswer }

function restoreEvents(prefix: string): ExitEvent[] {
  try {
    return Object.keys(localStorage)
      .filter(key => key.startsWith(prefix))
      .map(key => {
        const id = key.slice(prefix.length), raw = localStorage.getItem(key) || ''
        if (!/^[0-9a-f-]{36}$/i.test(id) || raw.length > 100000) return null
        try {
          const value = JSON.parse(raw)
          if (typeof value === 'number') return { id, at: value }
          if (!value || !Number.isFinite(value.at)) return null
          return { id, at: value.at }
        } catch { return null }
      })
      .filter((event): event is ExitEvent => event !== null)
      .sort((a, b) => a.at - b.at)
  } catch { return [] }
}

export function useTeachingTestTabGuard(
  scope: string | undefined,
  canSend: () => boolean,
  report: (eventId: string, answer?: TeachingTestExitAnswer) => Promise<boolean>,
  captureAnswer?: () => TeachingTestExitAnswer | undefined,
) {
  const callbacks = useRef({ canSend, report, captureAnswer })
  callbacks.current = { canSend, report, captureAnswer }
  const queued = useRef<ExitEvent[]>([])
  const enqueue = useRef<() => Promise<boolean>>(() => Promise.resolve(false))
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    queued.current = scope ? restoreEvents(`${keyPrefix}${scope}:`) : []
    setPendingCount(queued.current.length)
    if (!scope) return
    const prefix = `${keyPrefix}${scope}:`
    let hidden = document.visibilityState === 'hidden'
    let sending: Promise<boolean> | null = null
    let active = true

    function drain(): Promise<boolean> {
      if (sending) return sending
      if (!active || !queued.current.length || !callbacks.current.canSend()) return Promise.resolve(false)
      const task = (async () => {
        while (active && queued.current.length && callbacks.current.canSend()) {
          const event = queued.current[0]
          if (!await callbacks.current.report(event.id, event.answer)) return false
          try { localStorage.removeItem(prefix + event.id) } catch { /* browser storage can be disabled */ }
          if (!active) return true
          queued.current.shift()
          setPendingCount(queued.current.length)
        }
        return queued.current.length === 0
      })()
      sending = task
      void task.finally(() => { if (sending === task) sending = null }).catch(() => {})
      return task
    }

    function queueExit() {
      // One unresolved exit is enough: retries reuse its identity and last edit.
      if (!queued.current.length) {
        const event = { id: crypto.randomUUID(), at: Date.now(), answer: callbacks.current.captureAnswer?.() }
        queued.current.push(event)
        // Only the opaque, user/attempt-bound event is durable. Answers and
        // question content must never be written into browser storage here.
        try { localStorage.setItem(prefix + event.id, JSON.stringify({ at: event.at })) } catch { /* retain in memory */ }
        setPendingCount(queued.current.length)
      }
      return drain()
    }
    enqueue.current = queueExit

    function updateVisibility(nowHidden: boolean) {
      if (nowHidden && !hidden) void queueExit()
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
      enqueue.current = () => Promise.resolve(false)
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', pageHidden)
      window.removeEventListener('online', drain)
      window.clearInterval(retry)
    }
  }, [scope])

  return { pendingCount: scope ? pendingCount : 0, hasPending: () => Boolean(scope && queued.current.length), requestExit: () => scope ? enqueue.current() : Promise.resolve(true) }
}
