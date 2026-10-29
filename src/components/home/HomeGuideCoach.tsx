import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { HomeGuideController } from '../../lib/homeGuide'
import { placeHomeGuide, type HomeGuideStep } from '../../lib/homeGuideSteps'
import { HomeIcon } from './HomeIcons'
import './HomeGuideCoach.css'

interface Props { guide: HomeGuideController; steps: HomeGuideStep[]; rootRef: RefObject<HTMLElement | null>; ready: boolean }
type Placement = ReturnType<typeof placeHomeGuide> & { offscreen: boolean; colors: Record<string, string> }
const variables = ['--hd-card', '--hd-text', '--hd-muted', '--hd-line', '--hd-accent', '--hd-accent-soft', '--hd-accent-ink']
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function HomeGuideCoach({ guide, steps, rootRef, ready }: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const [panelNode, setPanelNode] = useState<HTMLElement | null>(null)
  const attachPanel = useCallback((node: HTMLElement | null) => { panelRef.current = node; setPanelNode(node) }, [])
  const headingRef = useRef<HTMLHeadingElement>(null)
  const priorFocus = useRef<HTMLElement | null>(null)
  const focusedStep = useRef<string | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const titleId = useId(), textId = useId()
  const index = Math.min(Math.max(0, guide.step), steps.length - 1)
  const step = steps[index]
  const visible = guide.available && guide.open && ready && Boolean(step)
  const target = () => step && rootRef.current?.querySelector<HTMLElement>(`[data-home-guide="${step.target}"]`)

  useEffect(() => {
    if (!visible) return
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const panel = panelRef.current
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) {
        const trigger = rootRef.current?.querySelector<HTMLButtonElement>('[data-home-guide-start]')
        if (trigger?.isConnected) trigger.focus({ preventScroll: true })
        else if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true })
      }
      focusedStep.current = null
    }
  }, [visible, rootRef])

  // The parent main ref attaches after child layout effects on first mount.
  // Measure after the commit so the initial tour has a real anchor as well.
  useEffect(() => {
    if (!visible || !step) { setPlacement(null); return }
    let frame = 0
    const anchor = target() || rootRef.current?.querySelector<HTMLElement>('.hd-welcome')
    if (!anchor) { setPlacement(null); return }
    anchor.setAttribute('data-home-guide-active', 'true')
    const measure = () => {
      const root = rootRef.current
      if (!anchor.isConnected || !root) { setPlacement(null); return }
      const rect = anchor.getBoundingClientRect()
      const vv = window.visualViewport
      const viewport = { width: vv?.width || window.innerWidth, height: vv?.height || window.innerHeight, top: vv?.offsetTop || 0, left: vv?.offsetLeft || 0 }
      const style = getComputedStyle(root)
      const colors = Object.fromEntries(variables.map(name => [name, style.getPropertyValue(name).trim()]))
      const panelHeight = panelNode ? Math.max(panelNode.offsetHeight, panelNode.scrollHeight + 2) : 285
      const positioned = placeHomeGuide(rect, { width: Math.min(336, viewport.width - 28), height: panelHeight }, viewport)
      const compact = rect.height < viewport.height - 110
      const overlaps = compact && positioned.top < rect.bottom && positioned.top + Math.min(panelHeight, positioned.maxHeight) > rect.top
      const offscreen = overlaps || rect.bottom < viewport.top + 80 || rect.top > viewport.top + viewport.height - 30 || (compact && (rect.top < viewport.top + 80 || rect.bottom > viewport.top + viewport.height - 14))
      setPlacement({ ...positioned, offscreen, colors })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    observer?.observe(anchor)
    if (panelNode) observer?.observe(panelNode)
    const themeElement = rootRef.current?.closest('[data-theme]')
    const themeObserver = themeElement ? new MutationObserver(schedule) : null
    if (themeElement) themeObserver?.observe(themeElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect(); themeObserver?.disconnect()
      anchor.removeAttribute('data-home-guide-active')
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [visible, step?.id, rootRef, panelNode])

  useEffect(() => {
    if (!visible || !placement || !step || focusedStep.current === step.id) return
    // Auto-start does not pull focus away from another control the person is using.
    if (!focusedStep.current && document.activeElement !== document.body && !rootRef.current?.querySelector('[data-home-guide-start]')?.contains(document.activeElement) && !panelRef.current?.contains(document.activeElement)) return
    focusedStep.current = step.id
    const anchor = target()
    if (anchor && placement.offscreen) anchor.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'instant' : 'smooth' })
    headingRef.current?.focus({ preventScroll: true })
  }, [visible, placement, step?.id, rootRef])

  useEffect(() => {
    if (!visible) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); guide.pause() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [visible, guide.pause])

  if (!visible || !step || !placement) return null
  const last = index === steps.length - 1
  const style = { ...placement.colors, left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight, '--hd-guide-arrow': `${placement.arrow}px` } as CSSProperties
  return createPortal(<aside ref={attachPanel} className="hd-home-guide-panel" style={style} role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={textId} data-side={placement.side} data-offscreen={placement.offscreen || undefined}>
    <div className="hd-home-guide-meta"><span><HomeIcon name="spark" size={14} />Знайомство з головною</span><button type="button" onClick={guide.pause} aria-label="Закрити підказки"><HomeIcon name="close" size={16} /></button></div>
    <div className="hd-home-guide-progress" aria-label={`Крок ${index + 1} з ${steps.length}`}>{steps.map((item, at) => <i key={item.id} data-complete={at <= index || undefined} />)}</div>
    <div key={step.id} className="hd-home-guide-copy"><h2 id={titleId} ref={headingRef} tabIndex={-1}>{target() ? step.title : 'Цей блок зараз недоступний'}</h2><p id={textId}>{target() ? step.text : 'Вміст головної змінився. Можна перейти до наступної підказки або закрити навчання й запустити його ще раз пізніше.'}</p>{target() && step.hint && <small>{step.hint}</small>}</div>
    {placement.offscreen && <button type="button" className="hd-home-guide-return" onClick={() => target()?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'instant' : 'smooth' })}>Показати цей блок<HomeIcon name="arrow" size={14} /></button>}
    <div className="hd-home-guide-footer"><span>{index + 1} / {steps.length}</span><div>{index > 0 ? <button type="button" className="hd-home-guide-back" onClick={() => guide.setStep(index - 1)}>Назад</button> : <button type="button" className="hd-home-guide-back" onClick={guide.pause}>Не зараз</button>}<button type="button" className="hd-home-guide-next" onClick={() => last ? guide.finish() : guide.setStep(index + 1)}>{last ? 'Зрозуміло' : 'Далі'}<HomeIcon name={last ? 'check' : 'arrow'} size={15} /></button></div></div>
  </aside>, document.body)
}
