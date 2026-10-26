import { useId, type CSSProperties } from 'react'
import { Check, ChevronRight, Gift, LoaderCircle, X } from 'lucide-react'
import '../birthday/birthdayGiftCard.css'
import './appreciationGiftCard.css'

const PARTICLES = Array.from({ length: 32 }, (_, index) => ({
  '--birthday-x': `${Math.cos(index / 31 * Math.PI) * (105 + index % 5 * 23)}px`,
  '--birthday-y': `${-Math.sin(index / 31 * Math.PI) * (135 + index % 4 * 25) + 110}px`,
  '--birthday-turn': `${(index % 2 ? 1 : -1) * (160 + index * 29)}deg`,
  '--birthday-delay': `${index % 7 * 30}ms`,
}) as CSSProperties)

/** Original vector mark for the local appreciation badge. */
export function CommunitySparkMark({ compact = false }: { compact?: boolean }) {
  const id = `community-spark-${useId().replace(/:/g, '')}`
  return <svg viewBox="0 0 144 144" fill="none" aria-hidden="true" focusable="false" className={compact ? 'community-spark-mark community-spark-mark--compact' : 'community-spark-mark'}>
    <defs>
      <linearGradient id={`${id}-field`} x1="29" y1="16" x2="111" y2="131" gradientUnits="userSpaceOnUse"><stop stopColor="#a33856" /><stop offset=".5" stopColor="#800020" /><stop offset="1" stopColor="#4d1429" /></linearGradient>
      <linearGradient id={`${id}-gold`} x1="66" y1="38" x2="108" y2="99" gradientUnits="userSpaceOnUse"><stop stopColor="#fff3c7" /><stop offset=".5" stopColor="#edcb8c" /><stop offset="1" stopColor="#c49350" /></linearGradient>
    </defs>
    <circle cx="72" cy="72" r="66" className="community-spark-outer" />
    <circle cx="72" cy="72" r="58" fill={`url(#${id}-field)`} />
    <circle cx="72" cy="72" r="52" stroke="#f5d5a2" strokeOpacity=".2" />
    <path d="M28 104C38 88 51 75 72 65M38 115c12-14 23-24 39-32M25 88c11-10 21-18 35-24" stroke="#e7b98b" strokeOpacity=".45" strokeWidth="3" strokeLinecap="round" />
    <path d="m88 32 7.5 23L119 65l-25 7.5L84 100l-8-25-22-9 23-9L88 32Z" fill={`url(#${id}-gold)`} />
    <path d="m88 42 3.5 16L107 65l-18 4.5L84 86l-4.5-15.5L67 66l14-5 7-19Z" fill="#fff8dd" fillOpacity=".63" />
    <path d="m110 24 1.9 6.1L118 32l-6.1 1.9L110 40l-1.9-6.1L102 32l6.1-1.9L110 24Z" fill="#d1a25e" />
    <path d="m118 93 1.6 5.4L125 100l-5.4 1.6L118 107l-1.6-5.4L111 100l5.4-1.6L118 93Z" fill="#edcb8c" />
    <circle cx="43" cy="42" r="2.5" fill="#f5d5a2" fillOpacity=".7" />
    <circle cx="55" cy="105" r="2" fill="#f5d5a2" fillOpacity=".7" />
  </svg>
}

export function AppreciationGiftCard({ claimed, busy, burst, recipientName, onClaim, onClose, validUntil = null, error = '', badgeVisible = true }: {
  claimed: boolean; busy: boolean; burst: number; recipientName: string; onClaim(): void; onClose(): void; validUntil?: string | null; error?: string; badgeVisible?: boolean
}) {
  const titleId = useId()
  const errorId = useId()
  const until = validUntil && Number.isFinite(Date.parse(validUntil)) ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv' }).format(new Date(validUntil)).replace(/\.$/, '') : null
  return <section className={`birthday-gift-card community-thanks-card ${burst ? 'community-thanks-card--celebrating' : ''}`} aria-labelledby={titleId} aria-busy={busy}>
    <div className="birthday-gift-card-wash" aria-hidden="true" />
    <button type="button" disabled={busy} className="birthday-gift-close" aria-label="Закрити подяку" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    {claimed && burst > 0 && <div key={burst} className="birthday-gift-celebration community-thanks-confetti" aria-hidden="true">{PARTICLES.map((style, index) => <span key={index} style={style} />)}</div>}
    <div className="birthday-gift-content community-thanks-content">
      <p className="birthday-gift-eyebrow"><span />Від своїх — своїй<span /></p>
      <div className="community-thanks-hero"><CommunitySparkMark /><span className="community-thanks-hero-caption">ІСКРА XELAY</span></div>
      <p className="community-thanks-recipient">{recipientName.trim() ? `${recipientName.trim()},` : 'Дякуємо тобі,'}</p>
      <h2 id={titleId} className="birthday-gift-title community-thanks-title">ти неймовірна!</h2>
      <div className="community-thanks-message"><p>Дякуємо, що розповідаєш про Xelay і приводиш до нас нових людей. Це дуже допомагає платформі рости.</p><p>Продовжуй ділитися Xelay зі своїми — разом зробимо тут ще більше корисного.</p></div>
      <div className="community-thanks-rewards">
        <div className="community-thanks-reward"><span className="community-thanks-reward-icon"><Gift size={19} strokeWidth={1.6} aria-hidden="true" /></span><div><span>Трохи більше можливостей</span><strong>1 місяць «Учасника»</strong></div>{claimed ? <Check size={17} className="community-thanks-reward-check" aria-hidden="true" /> : <span className="community-thanks-reward-tag">Подарунок</span>}</div>
        <div className="community-thanks-reward"><span className="community-thanks-reward-badge"><CommunitySparkMark compact /></span><div><span>Особлива відзнака у профілі</span><strong>Бейдж «Іскра Xelay»</strong></div>{claimed && <Check size={17} className="community-thanks-reward-check" aria-hidden="true" />}</div>
      </div>
      {claimed ? <div className="community-thanks-success" role="status"><p><Check size={14} aria-hidden="true" />Подарунок отримано</p><span>«Учасник» активний до <strong>{until || 'дату, вказану у вашій підписці'}</strong>.<br />{badgeVisible ? 'Бейдж уже прикрашає твій профіль.' : 'Бейдж отримано. Його можна показати в налаштуваннях профілю.'}</span></div> : <>{error && <p id={errorId} className="birthday-gift-error" role="alert">{error}</p>}<button type="button" className="birthday-gift-claim community-thanks-claim" disabled={busy} aria-describedby={error ? errorId : undefined} onClick={onClaim}>{busy ? <><LoaderCircle size={17} className="birthday-gift-spinner" aria-hidden="true" />Готуємо твою іскру…</> : <>Забрати подарунок<ChevronRight size={17} aria-hidden="true" /></>}</button></>}
      <p className="birthday-gift-terms">Без оплати та автопродовження</p>
      <p className="community-thanks-signature">Ще трохи — і розцілуємо всією командою <span aria-hidden="true">💛</span><strong>Xelay</strong></p>
    </div>
  </section>
}
