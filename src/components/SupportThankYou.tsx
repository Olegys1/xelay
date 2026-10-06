import { useEffect, useId, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, CheckCircle2, Heart, Sparkles, X } from 'lucide-react'
import { SupporterMark } from './SupporterBadge'
import { formatSupportAmount } from '../lib/teamSupport'
import './supportCelebration.css'

const particles = Array.from({ length: 18 }, (_, index) => {
  const angle = index * Math.PI * 2 / 18
  const distance = index % 2 ? 105 : 125
  return {
    '--support-x': `${Math.round(Math.cos(angle) * distance)}px`,
    '--support-y': `${Math.round(Math.sin(angle) * distance)}px`,
    '--support-turn': `${index % 2 ? -35 : 35}deg`,
    '--support-delay': `${(index % 4) * 65 + 180}ms`,
  } as CSSProperties
})

export function SupportThankYou({ amountKopiykas, onClose, onViewProfile }: {
  amountKopiykas: number
  onClose: () => void
  onViewProfile: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])
        .filter((element) => element.getClientRects().length > 0)
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); return }
      const outside = !elements.includes(document.activeElement as HTMLButtonElement)
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div className="xelay-support-celebration fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto bg-black/45 px-4 py-6 backdrop-blur-sm"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        className="xelay-support-thanks relative my-auto w-full min-w-0 max-w-sm overflow-hidden rounded-[28px] border border-primary/15 bg-card p-6 shadow-2xl outline-none sm:p-8">
        <button type="button" onClick={onClose} aria-label="Закрити подяку" className="absolute right-2 top-2 z-10 flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><X size={18} /></button>
        <div className="xelay-support-particles" aria-hidden="true">
          {particles.map((style, index) => <span key={index} style={style}>{index % 3 ? <Heart size={13} fill="currentColor" strokeWidth={1} /> : <Sparkles size={15} strokeWidth={1.5} />}</span>)}
        </div>
        <div className="relative">
          <div className="relative mx-auto mb-5 mt-2 flex h-24 w-24 items-center justify-center">
            <span className="xelay-support-ripple absolute inset-0 rounded-full border border-primary/20" aria-hidden="true" />
            <span className="xelay-support-ripple xelay-support-ripple-later absolute inset-0 rounded-full border border-primary/15" aria-hidden="true" />
            <span className="xelay-support-heart relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/15 to-rose-200/30 text-primary"><Heart size={38} fill="currentColor" strokeWidth={1.3} aria-hidden="true" /></span>
          </div>
          <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-primary"><CheckCircle2 size={14} aria-hidden="true" />Підтримку {formatSupportAmount(amountKopiykas)} грн підтверджено</p>
          <h2 id={titleId} className="mt-3 text-center text-2xl font-semibold tracking-tight">Ви — частинка Xelay</h2>
          <p id={descriptionId} className="mt-3 text-center text-sm leading-6 text-muted-foreground">Дякуємо за підтримку! Завдяки вам ми можемо розвивати простір для нашої студентської спільноти.</p>
          <div className="xelay-support-badge mt-5 flex justify-center"><SupporterMark /></div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">Знак нашої подяки вже у вашому профілі.</p>
          <button type="button" onClick={onViewProfile} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90">Переглянути мій бейдж<ArrowUpRight size={16} aria-hidden="true" /></button>
          <button type="button" onClick={onClose} className="mt-2 min-h-11 w-full rounded-2xl text-sm text-muted-foreground transition-colors hover:bg-muted">Продовжити в Xelay</button>
        </div>
      </div>
    </div>, document.body,
  )
}
