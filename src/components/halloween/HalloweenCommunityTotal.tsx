import { useEffect, useRef, useState } from 'react'
import { useHalloweenHunt } from '../../context/HalloweenHuntContext'
import { communityPumpkinLabel, loadHalloweenCommunityTotal } from '../../lib/halloweenCommunity'
import { PumpkinArt } from './HalloweenPumpkin'

const number = new Intl.NumberFormat('uk-UA')

/** Community aggregate only. Individual collections stay in the personal tracker. */
export function HalloweenCommunityTotal({ hidden = false }: { hidden?: boolean }) {
  const hunt = useHalloweenHunt()
  const enabled = hunt.available && !hidden
  const [total, setTotal] = useState<number | null>(null)
  const refresh = useRef<((force?: boolean) => void) | null>(null)
  const ownCount = hunt.state?.collected.length ?? 0
  const previousCollection = useRef({ userId: hunt.userId, count: ownCount })

  useEffect(() => {
    if (!enabled) { setTotal(null); return }
    let alive = true, busy = false, queued = false, lastStarted = 0
    let request: AbortController | null = null
    async function update(force = false) {
      if (!alive || document.visibilityState !== 'visible') return
      if (busy) { queued ||= force; return }
      if (!force && Date.now() - lastStarted < 15_000) return
      busy = true; lastStarted = Date.now()
      const controller = new AbortController()
      request = controller
      const timer = window.setTimeout(() => controller.abort(), 8_000)
      try {
        const value = await loadHalloweenCommunityTotal(controller.signal)
        if (alive) setTotal(value)
      } catch { /* Keep the last real count; never replace a failed request with zero. */ }
      finally {
        window.clearTimeout(timer)
        if (request === controller) request = null
        busy = false
        if (queued && alive) { queued = false; void update(true) }
      }
    }
    const run = (force = false) => { void update(force) }
    refresh.current = run
    const visible = () => run()
    window.addEventListener('focus', visible)
    window.addEventListener('online', visible)
    document.addEventListener('visibilitychange', visible)
    const interval = window.setInterval(visible, 60_000)
    run()
    return () => {
      alive = false; request?.abort()
      if (refresh.current === run) refresh.current = null
      window.clearInterval(interval)
      window.removeEventListener('focus', visible)
      window.removeEventListener('online', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [enabled])

  useEffect(() => {
    const previous = previousCollection.current
    previousCollection.current = { userId: hunt.userId, count: ownCount }
    if (previous.userId === hunt.userId && ownCount > previous.count) refresh.current?.(true)
  }, [hunt.userId, ownCount])

  if (!enabled || total === null) return null
  return <aside className="halloween-community-total" aria-label={`Спільна колекція Xelay: ${number.format(total)} ${communityPumpkinLabel(total)}`}>
    <PumpkinArt size={20} />
    <span>Разом зібрано</span>
    <strong>{number.format(total)}</strong>
    <span>{communityPumpkinLabel(total)}</span>
  </aside>
}
