import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { GraduationCap, Pause, Play, Sparkles } from 'lucide-react'
import './OrganizationSculpture.css'

// The first cabinet's orbits and glass core. No render loop, remote assets or
// per-frame React updates. Movement stops outside the viewport.
export function OrganizationSculpture({ school = false }: { school?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [inactive, setInactive] = useState(false)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    const visibility = () => setInactive(document.hidden || !visible)
    const preference = () => setReduced(media.matches)
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      visibility()
    }, { threshold: .05 })
    observer.observe(element)
    document.addEventListener('visibilitychange', visibility)
    media.addEventListener('change', preference)
    preference()
    visibility()
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      media.removeEventListener('change', preference)
    }
  }, [])

  return <div ref={host} className="org-sculpture" data-paused={paused || inactive || reduced}>
    <div className="org-signal" aria-hidden="true">
      <div className="org-signal-aura" />
      <div className="org-signal-meridian" />
      <div className="org-signal-stars">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--star': i, '--x': `${13 + (i * 37) % 77}%`, '--y': `${9 + (i * 23) % 83}%` } as CSSProperties} />)}</div>
      <div className="org-orbit org-orbit-one"><i /><i /><i /><span /></div>
      <div className="org-orbit org-orbit-two"><i /><i /><i /><span /></div>
      <div className="org-orbit org-orbit-three"><i /><i /><span /></div>
      <div className="org-signal-core">
        <div className="org-core-depth org-core-depth-back" />
        <div className="org-core-depth org-core-depth-middle" />
        <div className="org-core-face"><span className="org-core-glint" />{school ? <GraduationCap size={49} strokeWidth={1.25} /> : <Sparkles size={49} strokeWidth={1.25} />}<span className="org-core-edge" /></div>
      </div>
      <span className="org-orbit-label org-orbit-label-one"><i />{school ? 'НОВИЙ ДОСВІД' : 'НОВІ ТАЛАНТИ'}</span>
      <span className="org-orbit-label org-orbit-label-two"><i />{school ? 'БІЛЬШЕ МОЖЛИВОСТЕЙ' : 'СПІЛЬНЕ МАЙБУТНЄ'}</span>
    </div>
    <button className="org-motion-control" type="button" disabled={reduced} aria-label={paused ? 'Відтворити анімацію' : 'Призупинити анімацію'} title={reduced ? 'Рух вимкнено в налаштуваннях пристрою' : undefined} onClick={() => setPaused(value => !value)}>{paused || reduced ? <Play size={13} /> : <Pause size={13} />}</button>
  </div>
}
