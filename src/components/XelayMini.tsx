import { useEffect, useRef, useState, type CSSProperties } from 'react'
import './xelayMini.css'

/** One shared sprite asset. Only the visible hero animates; chat avatars stay still. */
export function XelayMini({ size = 48, animated = false, thinking = false, celebrating = false, decorative = true }: { size?: number; animated?: boolean; thinking?: boolean; celebrating?: boolean; decorative?: boolean }) {
  const node = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!animated || !node.current) return
    let inView = typeof IntersectionObserver === 'undefined'
    const update = () => setVisible(inView && !document.hidden)
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { if (entry) { inView = entry.isIntersecting; update() } })
    observer?.observe(node.current)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [animated])
  return <span ref={node} className={`xelay-mini${animated ? ' xelay-mini--animated' : ''}${thinking ? ' xelay-mini--thinking' : ''}${celebrating ? ' xelay-mini--celebrating' : ''}${visible ? ' is-visible' : ''}`} style={{ '--xelay-mini-size': `${size}px` } as CSSProperties} role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : 'Xelay Mini'}><span className="xelay-mini-shadow"/><span className="xelay-mini-motion"><span className="xelay-mini-sprite"/></span></span>
}
