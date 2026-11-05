import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, HelpCircle, Sparkles, X } from 'lucide-react'
import { placeHomeGuide } from '../../lib/homeGuideSteps'
import { readTeachingGuideProgress, saveTeachingGuideProgress, teachingGuideKey, teachingGuideSteps, teachingGuideTopic, TEACHING_GUIDE_LABELS, type TeachingGuideStep, type TeachingGuideTopic } from '../../lib/teachingContextGuide'
import './teaching-context-guide.css'

type ActiveGuide = { owner: string; route: TeachingGuideTopic; topic: TeachingGuideTopic; step: number }
export function useTeachingContextGuideController({ userId, topic, available, blocked, local = false }: { userId: string; topic: TeachingGuideTopic; available: boolean; blocked: boolean; local?: boolean }) {
  const owner = teachingGuideKey(userId, 'overview', local)
  const scope = `${owner}:${topic}`
  const current = useRef({ scope, available, blocked }); current.current = { scope, available, blocked }
  const activeRef = useRef<ActiveGuide | null>(null)
  const [active, setActive] = useState<ActiveGuide | null>(null)
  const [revision, setRevision] = useState(0)
  const visible = active?.owner === owner && active.route === topic ? active : null
  const overview = readTeachingGuideProgress(owner)
  useEffect(() => {
    // Restoring a saved step is always a deliberate action. No tour auto-starts.
    activeRef.current = null; setActive(null)
  }, [scope])
  function start(next: TeachingGuideTopic = topic) {
    if (current.current.scope !== scope || !current.current.available || current.current.blocked || !teachingGuideTopic(next)) return false
    const key = teachingGuideKey(userId, next, local), previous = readTeachingGuideProgress(key)
    const value = { owner, route: topic, topic: next, step: previous?.status === 'complete' ? 0 : previous?.step || 0 }
    activeRef.current = value; setActive(value); saveTeachingGuideProgress(key, { status: 'active', step: value.step })
    return true
  }
  function change(step: number) {
    if (!visible || activeRef.current !== visible || current.current.scope !== scope || !Number.isInteger(step) || step < 0 || step >= 30) return
    const next = { ...visible, step }; activeRef.current = next; setActive(next)
    saveTeachingGuideProgress(teachingGuideKey(userId, next.topic, local), { status: 'active', step })
  }
  function stop(status: 'paused' | 'complete') {
    if (!visible || activeRef.current !== visible || current.current.scope !== scope) return
    saveTeachingGuideProgress(teachingGuideKey(userId, visible.topic, local), { status, step: visible.step })
    activeRef.current = null; setActive(null); setRevision(value => value + 1)
  }
  function dismissOffer() {
    if (current.current.scope !== scope) return
    saveTeachingGuideProgress(owner, { status: 'paused', step: overview?.step || 0 }); setRevision(value => value + 1)
  }
  useEffect(() => { if ((blocked || !available) && visible) stop('paused') }, [available, blocked, visible])
  return { active: visible, open: Boolean(visible && available && !blocked), showOffer: Boolean(available && !blocked && !visible && !overview),
    start, setStep: change, pause: () => stop('paused'), finish: () => stop('complete'), dismissOffer, revision }
}

type Controller = ReturnType<typeof useTeachingContextGuideController>
type GuideContext = { controller: Controller; topic: TeachingGuideTopic; available: boolean; blocked: boolean; launch: (topic?: TeachingGuideTopic, trigger?: HTMLElement) => void }
const Context = createContext<GuideContext | null>(null)
function shown(element: HTMLElement) {
  if (element.closest('[hidden]') || element.closest('dialog:not([open])') || !element.getClientRects().length) return false
  const details = element.closest('details:not([open])')
  return !details || element.tagName === 'SUMMARY' || Boolean(element.closest('summary'))
}
function targetFor(root: HTMLElement | null, step: TeachingGuideStep) { return [...root?.querySelectorAll<HTMLElement>(step.target) || []].find(shown) || null }
export function TeachingContextGuideProvider({ userId, topic, available, blocked, local = false, children }: { userId: string; topic: TeachingGuideTopic; available: boolean; blocked: boolean; local?: boolean; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLElement | null>(null)
  const controller = useTeachingContextGuideController({ userId, topic, available, blocked, local })
  const [route, setRoute] = useState<{ owner: string; topic: TeachingGuideTopic; steps: TeachingGuideStep[]; host: HTMLDialogElement | null } | null>(null)
  const [editing, setEditing] = useState(false)
  const owner = teachingGuideKey(userId, 'overview', local)
  function launch(next: TeachingGuideTopic = topic, source?: HTMLElement) {
    const root = rootRef.current
    if (!root || blocked || !available) return
    const dialog = source?.closest<HTMLDialogElement>('dialog[open]') || null
    const existing = root.querySelector<HTMLDialogElement>('dialog[open]')
    if (existing && existing !== dialog) return
    const scope = dialog || root
    const steps = teachingGuideSteps(next).filter(step => targetFor(scope, step))
    if (!steps.length || !controller.start(next)) return
    trigger.current = source || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setRoute({ owner, topic: next, steps, host: dialog })
  }
  const handler = useRef({ launch, controller, route }); handler.current = { launch, controller, route }
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let frame = 0
    const inspect = () => {
      const activeDialog = root.querySelector<HTMLDialogElement>('dialog[open]')
      const field = document.activeElement
      setEditing(Boolean(activeDialog || field instanceof HTMLElement && root.contains(field) && field.matches('input,textarea,select,[contenteditable="true"]')))
      const current = handler.current
      if (current.controller.open && (activeDialog && activeDialog !== current.route?.host || current.route?.host && !current.route.host.open)) current.controller.pause()
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(inspect) }
    const delegated = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-teaching-guide-launch]') : null
      if (!button || !root.contains(button) || button.disabled) return
      const next = button.dataset.teachingGuideLaunch
      if (teachingGuideTopic(next)) { event.preventDefault(); handler.current.launch(next, button) }
    }
    const observer = new MutationObserver(schedule)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'aria-busy'] })
    root.addEventListener('click', delegated); root.addEventListener('focusin', schedule); root.addEventListener('focusout', schedule)
    inspect()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); root.removeEventListener('click', delegated); root.removeEventListener('focusin', schedule); root.removeEventListener('focusout', schedule) }
  }, [owner])
  const activeRoute = route?.owner === owner && route.topic === controller.active?.topic ? route : null
  return <Context.Provider value={{ controller, topic, available, blocked, launch }}><div ref={rootRef} className="teaching-guide-scope" data-teaching-guide-editing={editing || undefined}>
    {children}
    {activeRoute && <TeachingGuideCoach key={`${owner}:${activeRoute.topic}`} controller={controller} steps={activeRoute.steps} rootRef={rootRef} host={activeRoute.host} trigger={trigger} />}
  </div></Context.Provider>
}

export function TeachingGuideLaunch() {
  const context = useContext(Context)
  const [menu, setMenu] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!menu) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(false); button.current?.focus() } }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [menu])
  if (!context) return null
  const { controller, available, blocked, topic, launch } = context
  return <div className="teaching-guide-launch">
    <button ref={button} data-teaching-guide-main-launch type="button" className="teaching-button" disabled={!available || blocked} aria-controls={menu ? id : undefined} aria-expanded={menu} onClick={() => setMenu(value => !value)}><HelpCircle size={15} aria-hidden="true" />Підказки</button>
    {menu && <div id={id} className="teaching-guide-menu" role="group" aria-label="Оберіть підказки"><button type="button" disabled={!available || blocked} onClick={() => { launch(topic, button.current || undefined); setMenu(false) }}>{TEACHING_GUIDE_LABELS[topic]}<ArrowRight size={14} /></button>{topic !== 'overview' && <button type="button" disabled={!available || blocked} onClick={() => { launch('overview', button.current || undefined); setMenu(false) }}>Увесь кабінет<ArrowRight size={14} /></button>}<a href="/guides/#teacher/__first-setup" target="_blank" rel="noopener noreferrer">Докладна інструкція</a>{controller.active && <button type="button" onClick={() => { controller.pause(); setMenu(false) }}>Призупинити підказки</button>}</div>}
  </div>
}
export function TeachingGuideOffer() {
  const context = useContext(Context)
  if (!context?.controller.showOffer) return null
  return <section className="teaching-guide-offer" aria-label="Знайомство з кабінетом викладача"><span className="teaching-guide-offer-icon"><Sparkles size={19} aria-hidden="true" /></span><div><strong>Кабінет стане зрозумілим за кілька кроків</strong><p>Покажемо, де групи, завдання та журнал. Далі в кожному розділі є свої короткі підказки.</p></div><div className="teaching-guide-offer-actions"><button type="button" onClick={event => context.launch('overview', event.currentTarget)}>Показати кабінет<ArrowRight size={15} /></button><button type="button" onClick={context.controller.dismissOffer} aria-label="Відкласти знайомство з кабінетом">Не зараз</button></div></section>
}

function TeachingGuideCoach({ controller, steps, rootRef, host, trigger }: { controller: Controller; steps: TeachingGuideStep[]; rootRef: RefObject<HTMLDivElement | null>; host: HTMLDialogElement | null; trigger: RefObject<HTMLElement | null> }) {
  const [placement, setPlacement] = useState<(ReturnType<typeof placeHomeGuide> & { offscreen: boolean }) | null>(null)
  const panel = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null), lastStep = useRef('')
  const [panelNode, setPanelNode] = useState<HTMLElement | null>(null)
  const attachPanel = useCallback((node: HTMLElement | null) => { panel.current = node; setPanelNode(node) }, [])
  const id = useId(), index = Math.min(controller.active?.step || 0, steps.length - 1), step = steps[index]
  const visible = controller.open && Boolean(step) && (!host || host.open)
  const current = useRef(controller); current.current = controller
  const target = () => targetFor(host || rootRef.current, step)
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (!visible) return
    const anchor = target()
    if (!anchor) return
    let frame = 0
    const measure = () => {
      if (!anchor.isConnected || !shown(anchor)) { current.current.pause(); return }
      const vv = window.visualViewport, viewport = { width: vv?.width || window.innerWidth, height: vv?.height || window.innerHeight, top: vv?.offsetTop || 0, left: vv?.offsetLeft || 0 }
      const rect = anchor.getBoundingClientRect(), height = panelNode ? Math.max(panelNode.offsetHeight, panelNode.scrollHeight) : 310
      const next = placeHomeGuide(rect, { width: Math.min(350, viewport.width - 28), height }, viewport)
      setPlacement({ ...next, offscreen: rect.top < viewport.top + 76 || rect.bottom > viewport.top + viewport.height - 20 })
    }
    anchor.setAttribute('data-teaching-guide-active', 'true')
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    observer?.observe(anchor); if (panelNode) observer?.observe(panelNode)
    measure(); window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); anchor.removeAttribute('data-teaching-guide-active'); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule) }
  }, [visible, step?.id, rootRef, host, panelNode])
  useEffect(() => {
    if (!visible || !placement || !step || lastStep.current === step.id) return
    lastStep.current = step.id
    if (placement.offscreen) target()?.scrollIntoView({ block: 'center', behavior: reduced() ? 'instant' : 'smooth' })
    heading.current?.focus({ preventScroll: true })
  }, [visible, placement, step?.id])
  useEffect(() => {
    if (!visible || !panelNode) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); current.current.pause() } }
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('keydown', escape, true); const focus = document.activeElement; if (focus === document.body || panelNode.contains(focus)) { const destination = trigger.current?.isConnected ? trigger.current : rootRef.current?.querySelector<HTMLElement>('[data-teaching-guide-main-launch]'); if (destination?.isConnected && !destination.closest('dialog:not([open])')) destination.focus({ preventScroll: true }) } }
  }, [visible, trigger, panelNode, rootRef])
  if (!visible || !placement || !step) return null
  const last = index === steps.length - 1
  const style = { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight } as CSSProperties
  return createPortal(<aside ref={attachPanel} className="teaching-context-coach" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} style={style}>
    <header><span><Sparkles size={14} />{controller.active ? TEACHING_GUIDE_LABELS[controller.active.topic] : 'Підказки'}</span><button type="button" aria-label="Закрити підказки" onClick={controller.pause}><X size={17} /></button></header>
    <div className="teaching-context-progress" aria-label={`Крок ${index + 1} з ${steps.length}`}>{steps.map((item, at) => <span key={item.id} data-complete={at <= index || undefined} />)}</div>
    <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{step.title}</h2><p id={`${id}-body`}>{step.text}</p>{step.hint && <small>{step.hint}</small>}
    {placement.offscreen && <button type="button" className="teaching-context-show" onClick={() => target()?.scrollIntoView({ block: 'center', behavior: reduced() ? 'instant' : 'smooth' })}>Показати цей блок<ArrowRight size={14} /></button>}
    <footer><span>{index + 1} / {steps.length}</span><div>{index > 0 ? <button type="button" onClick={() => controller.setStep(index - 1)}><ArrowLeft size={14} />Назад</button> : <button type="button" onClick={controller.pause}>Не зараз</button>}<button type="button" className="teaching-context-next" onClick={() => last ? controller.finish() : controller.setStep(index + 1)}>{last ? 'Зрозуміло' : 'Далі'}{last ? <Check size={15} /> : <ArrowRight size={15} />}</button></div></footer>
  </aside>, host || document.body)
}
