import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { Check, ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react'
import './birthdayGiftCard.css'

export interface BirthdayGiftCardProps {
  recipientName?: string
  claimedAt?: string | null
  validUntil?: string | null
  busy?: boolean
  error?: string
  onClaim: () => void | Promise<void>
  onClose?: () => void
  celebrating?: boolean
}

const PIECES = Array.from({ length: 28 }, (_, index) => {
  const angle = (index / 27) * Math.PI
  const distance = 92 + (index % 5) * 24
  return {
    '--birthday-x': `${Math.cos(angle) * distance}px`,
    '--birthday-y': `${-Math.sin(angle) * (distance + 15) + 95}px`,
    '--birthday-turn': `${(index % 2 ? 1 : -1) * (140 + index * 31)}deg`,
    '--birthday-delay': `${(index % 7) * 28}ms`,
  } as CSSProperties
})

function GiftIllustration({ claimed }: { claimed: boolean }) {
  const id = useId().replace(/:/g, '')
  return <svg className="birthday-gift-art" viewBox="0 0 220 152" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-box`} x1="67" y1="78" x2="155" y2="143" gradientUnits="userSpaceOnUse">
        <stop stopColor="currentColor" stopOpacity=".96" />
        <stop offset="1" stopColor="currentColor" stopOpacity=".74" />
      </linearGradient>
    </defs>
    <ellipse cx="111" cy="139" rx="64" ry="7" className="birthday-gift-art-shadow" />
    <circle cx="110" cy="77" r="64" className="birthday-gift-art-halo" />
    <circle cx="37" cy="67" r="2.5" className="birthday-gift-art-dot" />
    <circle cx="173" cy="118" r="2" className="birthday-gift-art-dot" />
    <path d="m177 39 2.4 7.6L187 49l-7.6 2.4L177 59l-2.4-7.6L167 49l7.6-2.4L177 39Z" className="birthday-gift-art-spark" />
    <path d="m47 102 1.8 5.2L54 109l-5.2 1.8L47 116l-1.8-5.2L40 109l5.2-1.8L47 102Z" className="birthday-gift-art-spark" />
    <g className="birthday-gift-art-box">
      <path d="M67 78h87v46a12 12 0 0 1-12 12H79a12 12 0 0 1-12-12V78Z" fill={`url(#${id}-box)`} />
      <path d="M103 79h16v57h-16z" className="birthday-gift-art-ribbon" />
      <path d="M69 84h84" stroke="#000" strokeOpacity=".1" strokeWidth="3" />
    </g>
    <g className={`birthday-gift-art-lid ${claimed ? 'birthday-gift-art-lid--open' : ''}`}>
      <path d="M110 63c-19 1-35-4-34-16 1-8 9-11 16-6 8 6 13 15 18 22Z" className="birthday-gift-art-bow" />
      <path d="M111 63c18 1 34-4 33-16-1-8-9-11-16-6-8 6-12 15-17 22Z" className="birthday-gift-art-bow" />
      <path d="M83 46c-3 7 11 12 20 13-6-9-15-17-20-13ZM137 46c3 7-10 12-19 13 5-9 14-17 19-13Z" className="birthday-gift-art-bow-inner" />
      <rect x="60" y="63" width="102" height="21" rx="5" fill="currentColor" />
      <path d="M103 63h16v21h-16z" className="birthday-gift-art-ribbon" />
    </g>
    {claimed && <g className="birthday-gift-art-check">
      <circle cx="151" cy="116" r="19" className="birthday-gift-art-check-circle" />
      <path d="m143 116 5 5 10-11" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </g>}
  </svg>
}

function readableDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv' }).format(date)
}

/** Presentational card. The owner supplies claiming, errors, and any dialog behavior. */
export function BirthdayGiftCard({ recipientName, claimedAt, validUntil, busy = false, error, onClaim, onClose, celebrating = false }: BirthdayGiftCardProps) {
  const titleId = useId()
  const errorId = useId()
  const claimed = Boolean(claimedAt)
  const until = readableDate(validUntil)
  const previousCelebrating = useRef(celebrating)
  const sequence = useRef(0)
  const [burst, setBurst] = useState<number | null>(null)

  useEffect(() => {
    const requested = celebrating && !previousCelebrating.current
    previousCelebrating.current = celebrating
    if (!claimed) { setBurst(null); return }
    // Reopening an already claimed gift never starts a celebration by itself.
    if (requested) setBurst(++sequence.current)
  }, [celebrating, claimed])

  useEffect(() => {
    if (burst === null) return
    const timer = window.setTimeout(() => setBurst(null), 2200)
    return () => window.clearTimeout(timer)
  }, [burst])

  return <section className={`birthday-gift-card ${claimed ? 'birthday-gift-card--claimed' : ''} ${burst !== null ? 'birthday-gift-card--celebrating' : ''}`} aria-labelledby={titleId} aria-busy={busy}>
    <div className="birthday-gift-card-wash" aria-hidden="true" />
    {onClose && <button type="button" disabled={busy} className="birthday-gift-close" aria-label="Закрити подарунок" onClick={onClose}><X size={18} aria-hidden="true" /></button>}
    {burst !== null && claimed && <div key={burst} className="birthday-gift-celebration" aria-hidden="true">{PIECES.map((style, index) => <span key={index} style={style} />)}</div>}
    <div className="birthday-gift-content">
      <p className="birthday-gift-eyebrow"><span />Маленька радість від Xelay<span /></p>
      <GiftIllustration claimed={claimed} />
      {recipientName?.trim() && <p className="birthday-gift-recipient">{recipientName.trim()}</p>}
      <h2 id={titleId} className="birthday-gift-title">{claimed ? 'Подарунок уже твій!' : 'З днем народження!'}</h2>
      <p className="birthday-gift-message">{claimed ? 'Нехай попереду буде ще більше приємних відкриттів і приводів усміхнутися.' : 'Нехай здійснюються мрії, знаходяться свої люди, а кожен день дарує щось хороше.'}</p>
      <div className="birthday-gift-benefit">
        <span className="birthday-gift-benefit-icon" aria-hidden="true">{claimed ? <Check size={19} strokeWidth={1.8} /> : <Sparkles size={19} strokeWidth={1.6} />}</span>
        <div><p className="birthday-gift-benefit-label">{claimed ? 'Твій святковий місяць' : 'Для тебе — у подарунок'}</p><p className="birthday-gift-benefit-title">1 місяць «Учасника»</p></div>
        <span className="birthday-gift-benefit-tag">Подарунок</span>
      </div>
      {claimed ? <div className="birthday-gift-success" role="status" aria-live="polite">
        <p>{until ? <>Статус активний до <time dateTime={validUntil || undefined}>{until}</time></> : 'Місяць «Учасника» активовано.'}</p>
        <span>Користуйся всіма можливостями із задоволенням.</span>
      </div> : <>
        {error && <p id={errorId} className="birthday-gift-error" role="alert">{error}</p>}
        <button type="button" className="birthday-gift-claim" disabled={busy} aria-describedby={error ? errorId : undefined} onClick={() => { void onClaim() }}>
          {busy ? <><LoaderCircle size={18} className="birthday-gift-spinner" aria-hidden="true" />Отримуємо подарунок…</> : <>Забрати подарунок<ChevronRight size={17} aria-hidden="true" /></>}
        </button>
      </>}
      <p className="birthday-gift-terms">Без оплати та автопродовження</p>
      <div className="birthday-gift-signature"><span />З теплом, команда Xelay<span /></div>
    </div>
  </section>
}
