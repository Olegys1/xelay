import { useEffect, useRef, useState } from 'react'
import { useWinterEffects } from './WinterDecorations'
import './winterHoliday.css'

/** Cosmetic scene; local assets, no requests to application services. */
export function WinterHolidayArt() {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const { enabled } = useWinterEffects()
  useEffect(() => {
    let inView = typeof IntersectionObserver === 'undefined'
    const update = () => setVisible(inView && !document.hidden)
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { inView = Boolean(entry?.isIntersecting); update() })
    if (ref.current) observer?.observe(ref.current)
    document.addEventListener('visibilitychange', update); update()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])
  useEffect(() => {
    const art = ref.current
    const host = art?.closest<HTMLElement>('.winter-home-banner,.winter-scene')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
    if (!art || !host || !enabled || !visible) return
    let frame = 0, clientX = 0, clientY = 0, following = false
    const paint = () => {
      frame = 0
      let x = 0, y = 0
      if (following && !motion.matches && fine.matches) {
        const box = host.getBoundingClientRect()
        if (box.width && box.height) {
          x = Math.max(-6, Math.min(6, (clientX - box.left - box.width / 2) / box.width * 12))
          y = Math.max(-4, Math.min(4, (clientY - box.top - box.height / 2) / box.height * 8))
        }
      }
      art.style.setProperty('--winter-look-x', `${x}px`); art.style.setProperty('--winter-look-y', `${y}px`)
    }
    const move = (event: PointerEvent) => {
      if (motion.matches || !fine.matches) return
      clientX = event.clientX; clientY = event.clientY; following = true
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const reset = () => { following = false; if (!frame) frame = requestAnimationFrame(paint) }
    host.addEventListener('pointermove', move, { passive: true }); host.addEventListener('pointerleave', reset)
    motion.addEventListener('change', reset); fine.addEventListener('change', reset)
    return () => { cancelAnimationFrame(frame); host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', reset); motion.removeEventListener('change', reset); fine.removeEventListener('change', reset); art.style.removeProperty('--winter-look-x'); art.style.removeProperty('--winter-look-y') }
  }, [enabled, visible])
  return <div ref={ref} className="winter-holiday-art" data-animated={enabled && visible} aria-hidden="true">
    <span className="winter-cinematic-night-sky"/>
    <span className="winter-cinematic-halo"/>
    <div className="winter-cinematic-drift"><div className="winter-cinematic-parallax">
      <img className="winter-cinematic-image" src="/images/winter/cinematic-globe-v1-720.webp" srcSet="/images/winter/cinematic-globe-v1-720.webp 720w, /images/winter/cinematic-globe-v1-1200.webp 1200w" sizes="(max-width:600px) 360px, 520px" width="1200" height="800" alt="" decoding="sync" loading="eager" draggable={false}/>
      <span className="winter-globe-lights"><i/><i/><i/></span>
      <span className="winter-globe-snow">{Array.from({length:18},(_,i)=><i key={i} style={{left:`${8+(i*17)%84}%`,animationDelay:`-${i*.83}s`,animationDuration:`${6+(i%5)*1.1}s`}}/>)}</span>
      <span className="winter-cinematic-reflection"/>
    </div></div>
    <span className="winter-cinematic-dust">{Array.from({length:12},(_,i)=><i key={i} style={{left:`${13+i*6}%`,top:`${12+(i*19)%65}%`,animationDelay:`-${i*1.3}s`}}/>)}</span>
  </div>
}
