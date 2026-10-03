import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Animate appended messages, never the initial history or an older loaded page.
// The same DOM keys and row sizes remain intact, preserving scroll and focus.
export function useRecentItemMotion(items: { id: string; created_at: string }[], scope: string, ready: boolean): Set<string> {
  const [arriving, setArriving] = useState(new Set<string>())
  const snapshot = useRef({ scope: '', initialized: false, seen: new Set<string>(), newest: '' })
  const timer = useRef<number | null>(null)
  useLayoutEffect(() => {
    const previous = snapshot.current
    const newest = items.reduce((value, item) => item.created_at > value ? item.created_at : value, '')
    if (previous.scope !== scope || !ready || !previous.initialized) {
      snapshot.current = { scope, initialized: ready, seen: new Set(items.map((item) => item.id)), newest }
      if (timer.current) window.clearTimeout(timer.current)
      setArriving((current) => current.size ? new Set() : current)
      return
    }
    const added = items.filter((item) => !previous.seen.has(item.id) && item.created_at >= previous.newest).map((item) => item.id)
    snapshot.current = { scope, initialized: true, seen: new Set(items.map((item) => item.id)), newest: newest > previous.newest ? newest : previous.newest }
    if (!added.length) return
    setArriving((current) => new Set([...current, ...added]))
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setArriving(new Set()), 350)
  }, [items, scope, ready])
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  return arriving
}
