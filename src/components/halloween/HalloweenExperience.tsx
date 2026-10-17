import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, ChevronUp, Gift, Sparkles, X } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useHalloweenHunt } from '../../context/HalloweenHuntContext'
import { useOnboarding } from '../../context/OnboardingContext'
import { useTheme } from '../../context/ThemeContext'
import { PUMPKIN_IDS } from '../../lib/halloweenHunt'
import { PumpkinArt } from './HalloweenPumpkin'
import { ThemeToggle } from '../ThemeToggle'

const dismissalKey = (userId?: string) => `xelay:halloween-2026:welcome:${userId || 'guest'}`
const readDismissed = (userId?: string) => { try { return localStorage.getItem(dismissalKey(userId)) === 'dismissed' } catch { return false } }

export function HalloweenExperience({ pathname, blocked = false, onAuthRequest }: { pathname: string; blocked?: boolean; onAuthRequest: () => void }) {
  const hunt = useHalloweenHunt()
  const { suspended } = useOnboarding()
  const { theme } = useTheme()
  const [dismissed, setDismissed] = useState(() => ({ userId: hunt.userId, value: readDismissed(hunt.userId) }))
  const [open, setOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const showTracker = pathname !== '/halloween' && !pathname.startsWith('/messages')
  const visible = hunt.available && !blocked && !suspended && !modalOpen && !pathname.startsWith('/admin') && !pathname.startsWith('/reset-password') && !pathname.startsWith('/auth/')
  const close = () => { setOpen(false); chip.current?.focus({ preventScroll: true }) }
  useEffect(() => { setDismissed({ userId: hunt.userId, value: readDismissed(hunt.userId) }); setOpen(false) }, [hunt.userId])
  useEffect(() => {
    if (!hunt.available) return
    const check = () => setModalOpen(Boolean(document.querySelector('[role="dialog"][aria-modal="true"],.xelay-dialog-backdrop')))
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'class'] })
    check()
    return () => observer.disconnect()
  }, [hunt.available])
  useEffect(() => {
    if (!visible || !showTracker) { setOpen(false); return }
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !chip.current?.contains(event.target)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true) }
  }, [open, visible, showTracker])
  useEffect(() => {
    if (!hunt.celebration) return
    const timer = setTimeout(hunt.clearCelebration, hunt.celebration.completed ? 7000 : 3800)
    return () => clearTimeout(timer)
  }, [hunt.celebration, hunt.clearCelebration])
  if (!visible) return null
  const count = hunt.state?.collected.length || 0
  const introDismissed = dismissed.userId === hunt.userId && dismissed.value
  const dismiss = () => {
    setDismissed({ userId: hunt.userId, value: true })
    try { localStorage.setItem(dismissalKey(hunt.userId), 'dismissed') } catch { /* In-memory dismissal remains available. */ }
  }
  return <>
    {pathname === '/' && !introDismissed && !hunt.state?.completed && <aside className="halloween-intro" aria-label="Осіннє полювання Xelay">
      <PumpkinArt size={80} />
      <div className="halloween-intro-copy"><span className="halloween-kicker">Xelay · гарбузовий сезон до 1 листопада</span><h2>З Гелловіном, спільното Xelay!</h2><p>{theme === 'halloween' ? 'Увімкнули затишну тему й сховали 10 гарбузиків.' : 'Підготували затишну тему й сховали 10 гарбузиків.'} Зберіть усіх — отримайте світний бейдж. А перші 10 учасників, які завершать збір, — ще й місяць «Учасника» у подарунок.</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1"><Link to="/halloween" className="halloween-cta">{hunt.userId ? 'Знайти гарбузики' : 'Як це працює'}<ArrowRight size={14} /></Link><ThemeToggle textLabel="Змінити тему" /></div>
        <p className="halloween-welcome-note">Світлу або темну тему можна повернути будь-коли.</p>
      </div><button type="button" className="halloween-close" onClick={dismiss} aria-label="Закрити підказку про полювання"><X size={16} /></button>
    </aside>}
    {showTracker && <button type="button" ref={chip} className="halloween-chip" aria-label={`Полювання: зібрано ${count} з 10 гарбузиків`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}><PumpkinArt size={32} /><span>{count}/10</span>{open ? <ChevronUp size={13} /> : <Sparkles size={13} />}</button>}
    {open && showTracker && <section ref={panel} id={panelId} tabIndex={-1} className="halloween-progress-panel" aria-label="Прогрес полювання" role="dialog">
      <button type="button" className="halloween-close" onClick={close} aria-label="Закрити прогрес полювання"><X size={16} /></button>
      <span className="halloween-kicker">Осінь має свої секрети</span><h2 className="mt-2">{hunt.state?.completed ? 'Магію зібрано ✧' : 'Гарбузики грають у хованки'}</h2>
      <p className="mt-2">{hunt.state?.completed ? hunt.state.subscriptionWon ? 'Світний бейдж — ваш. Місяць «Учасника» додано до вашого доступу.' : 'Світний бейдж уже ваш. Усі 10 призових підписок знайшли своїх власників.' : 'Шукайте маленьких мешканців у різних розділах Xelay. Натисніть на гарбузика, щоб запросити його до колекції.'}</p>
      <PumpkinProgress collected={hunt.state?.collected || []} />
      {hunt.loading && <p role="status">Перевіряємо вашу колекцію…</p>}
      {hunt.error && <p role="alert">{hunt.error}<button type="button" onClick={() => { void hunt.refresh() }} className="ml-2 underline">Повторити</button></p>}
      {hunt.state && !hunt.state.completed && <p className="flex items-center gap-2"><Gift size={14} aria-hidden="true" />Призових місяців залишилося: <strong>{hunt.state.winnersRemaining}/10</strong></p>}
      {!hunt.userId ? <button type="button" className="halloween-cta mt-3" onClick={() => { close(); onAuthRequest() }}>Увійти та збирати</button> : <Link to="/halloween" className="halloween-cta mt-3" onClick={() => setOpen(false)}>Колекція та підказки<ArrowRight size={14} /></Link>}
    </section>}
    {hunt.celebration && <div key={hunt.celebration.key} className="halloween-celebration" role="status" aria-live="polite">
      <div className="halloween-confetti" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ '--dx': `${Math.cos(index * 2.4) * 130}px`, '--dy': `${Math.sin(index * 2.4) * 90 - 20}px`, '--turn': `${index * 31}deg`, '--confetti': index % 2 ? '#b39acb' : '#e7a746' } as CSSProperties} />)}</div>
      <PumpkinArt size={56} /><div><strong>{hunt.celebration.completed ? 'Уся гарбузова компанія з вами!' : 'Знайшовся ще один!'}</strong><p>{hunt.celebration.completed ? hunt.celebration.subscriptionWon ? 'Світний бейдж + місяць «Учасника» ✨' : 'Світний бейдж чекає у профілі ✨' : `${hunt.celebration.count} із 10 у вашій колекції`}</p></div>
      <button type="button" onClick={hunt.clearCelebration} className="halloween-close" aria-label="Закрити привітання"><X size={14} /></button>
    </div>}
  </>
}

export function PumpkinProgress({ collected }: { collected: readonly string[] }) {
  return <div className="halloween-progress-track" aria-label={`Зібрано ${collected.length} із 10 гарбузиків`}>{PUMPKIN_IDS.map((id, index) => <span key={id} className={`halloween-progress-dot ${collected.includes(id) ? 'halloween-progress-dot--found' : ''}`} aria-label={collected.includes(id) ? `Гарбузик ${index + 1}: знайдено` : `Гарбузик ${index + 1}: ще ховається`}>{collected.includes(id) ? <PumpkinArt size={25} /> : index + 1}</span>)}</div>
}
