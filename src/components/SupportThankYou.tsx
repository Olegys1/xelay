import { useEffect, useId, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, CheckCircle2, Crown, Gem, Heart, Medal, Star, X } from 'lucide-react'
import { SixSevenMark, SupporterMark } from './SupporterBadge'
import { formatSupportAmount } from '../lib/teamSupport'
import { supporterTierDetails, type ActiveSupporterTier } from '../lib/supporterTiers'
import './supportCelebration.css'

const tierIcons = { 1: Heart, 2: Medal, 3: Star, 4: Crown, 5: Gem }
const rays = Array.from({ length: 12 }, (_, index) => ({
  '--support-angle': `${index * 30}deg`,
  '--support-ray-delay': `${380 + index % 3 * 65}ms`,
}) as CSSProperties)

export function SupportThankYou({ amountKopiykas, supporterTier, sixSeven = false, onClose, onViewProfile }: {
  amountKopiykas: number
  supporterTier?: ActiveSupporterTier
  sixSeven?: boolean
  onClose: () => void
  onViewProfile: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()
  const details = supporterTier ? supporterTierDetails(supporterTier) : undefined
  const TierIcon = supporterTier ? tierIcons[supporterTier] : Heart
  const hasBadge = Boolean(supporterTier || sixSeven)

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      // Badge explanations live in a portal. Keep their close control reachable
      // without letting the parent trap pull focus behind the explanation.
      const expanded = dialogRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-expanded="true"][aria-controls]')
      const popoverId = expanded?.getAttribute('aria-controls')
      const popover = popoverId ? document.getElementById(popoverId) : null
      if (popover?.getAttribute('role') === 'dialog' && popover.contains(document.activeElement)) {
        if (event.key === 'Tab') {
          const buttons = Array.from(popover.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
            .filter((element) => element.getClientRects().length > 0)
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          event.preventDefault()
          const nextIndex = index < 0 ? event.shiftKey ? buttons.length - 1 : 0 : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
          if (buttons.length) buttons[nextIndex].focus()
          else popover.focus({ preventScroll: true })
        }
        // BadgeInfo handles Escape in the capture phase and restores its trigger.
        return
      }
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
    <div className="xelay-support-celebration fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto px-4 py-6"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        data-support-level={details?.key || 'supporter'}
        className="xelay-support-thanks relative my-auto w-full min-w-0 outline-none">
        <button type="button" onClick={onClose} aria-label="Закрити подяку" className="xelay-support-close"><X size={18} /></button>
        <div className="xelay-support-stage" aria-hidden="true">
          <span className="xelay-support-wordmark">Xelay<span>Разом більше.</span></span>
          <div className="xelay-support-medal-scene">
            <span className="xelay-support-orbit xelay-support-orbit-one" />
            <span className="xelay-support-orbit xelay-support-orbit-two" />
            <span className="xelay-support-rays">{rays.map((style, index) => <i key={index} style={style} />)}</span>
            <div className="xelay-support-medal"><span className="xelay-support-medal-face"><TierIcon size={59} strokeWidth={1.25} /></span><span className="xelay-support-medal-glint" /></div>
          </div>
          <span className="xelay-support-stage-label">{details ? `${details.name} рівень` : 'Створюємо Xelay разом'}</span>
        </div>
        <div className="xelay-support-thanks-body">
          <p className="xelay-support-confirmation"><CheckCircle2 size={14} aria-hidden="true" />Підтримку {formatSupportAmount(amountKopiykas)} грн підтверджено</p>
          <h2 id={titleId} className="xelay-support-thanks-title">Дякуємо.<br /><span>Ви — частинка Xelay.</span></h2>
          <p id={descriptionId} className="xelay-support-thanks-copy">Завдяки вашій підтримці ми розвиваємо Xelay та робимо щоденне навчання зручнішим. Раді, що ви з нами.</p>
          {hasBadge && <div className="xelay-support-badge">{supporterTier && <SupporterMark tier={supporterTier} />}{sixSeven && <SixSevenMark compact={false} />}</div>}
          <p className="xelay-support-badge-note">{hasBadge ? 'Отримані бейджі можна показати або приховати у налаштуваннях профілю.' : 'Ваш внесок уже підтверджено. Дякуємо, що допомагаєте розвивати Xelay.'}</p>
          <div className="xelay-support-thanks-actions">
            <button type="button" onClick={onViewProfile} className="xelay-support-primary">{hasBadge ? 'Переглянути мій бейдж' : 'До мого профілю'}<ArrowUpRight size={17} aria-hidden="true" /></button>
            <button type="button" onClick={onClose} className="xelay-support-secondary">Продовжити в Xelay</button>
          </div>
        </div>
      </div>
    </div>, document.body,
  )
}
