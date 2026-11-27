import { useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, LockKeyhole, RefreshCw, Sparkles } from 'lucide-react'
import { WINTER_REWARDS, type WinterAdventState } from '../../lib/winterCampaign'
import { WinterGiftBox, winterRewardLabel } from './WinterGiftArt'
import { WinterScratchCard } from './WinterScratchCard'
import { WinterEffectsControl } from './WinterDecorations'
import './winter.css'
import './winterGifts.css'

export interface WinterCalendarViewProps {
  state: WinterAdventState | null
  onClaim: (day: number) => Promise<void>
  loading?: boolean
  pending?: boolean
  error?: string
  onRefresh?: () => void
  onSignIn?: () => void
  preview?: boolean
  benefitsPanel?: ReactNode
}

/** Server dates and claim state control availability; local clock never unlocks a gift. */
export function WinterCalendarView({ state, onClaim, loading = false, pending = false, error = '', onRefresh, onSignIn, preview = false, benefitsPanel }: WinterCalendarViewProps) {
  const [chosenDay, setChosenDay] = useState<number | null>(null)
  const [claimingDay, setClaimingDay] = useState<number | null>(null)
  const [claimError, setClaimError] = useState('')
  const claiming = useRef(false)
  const detail = useRef<HTMLElement>(null)
  const count = state?.claimedDays.length || 0
  const day = chosenDay ?? Math.max(1, state?.currentDay || 1)
  const reward = WINTER_REWARDS[day - 1]
  const opened = Boolean(state?.claimedDays.includes(day))
  const available = Boolean(state?.eligible && state.phase === 'active' && day <= state.currentDay)
  const busy = pending || claimingDay !== null
  const choose = (next: number, scroll = false) => {
    if (busy) return
    setChosenDay(next); setClaimError('')
    if (scroll && window.matchMedia('(max-width: 720px)').matches) window.requestAnimationFrame(() => detail.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches || !document.querySelector('.winter-decorations') ? 'auto' : 'smooth', block: 'start',
    }))
  }
  const claim = async () => {
    if (claiming.current || busy || !available || opened) return
    claiming.current = true; setClaimingDay(day); setClaimError('')
    try { await onClaim(day) }
    catch (reason) { setClaimError(reason instanceof Error ? reason.message : 'Не вдалося зберегти подарунок. Спробуйте ще раз.'); throw reason }
    finally { claiming.current = false; setClaimingDay(null) }
  }
  return <main className="winter-page winter-gifts-calendar" data-winter-preview={preview || undefined}>
    <div className="winter-page-top"><a href="/" className="winter-back"><ArrowLeft size={16}/>До Xelay</a><WinterEffectsControl/></div>
    {preview && <p className="winter-preview-note">Локальний перегляд. Вигаданий акаунт, без нарахувань і платежів.</p>}
    <header className="wg-intro"><div><span className="wg-eyebrow">XELAY · ГРУДЕНЬ 2026</span><h1>Щодня<br/>трохи <em>більше.</em></h1><p>Відкривай подарунки, зберігай бонуси й обирай, коли ними скористатися.</p><div className="wg-offer-summary"><span><b>150</b> бонусних кредитів</span><span><b>7</b> днів підписки</span><span><b>3</b> дні Макса</span><span><b>7</b> днів паузи</span></div></div><div className="wg-intro-aside"><span className="wg-intro-count">31<span>день</span></span><span className="wg-intro-dates">01.12<i/>31.12</span><a href="#winter-calendar">До подарунків<ArrowRight size={15}/></a></div></header>
    <div className="winter-status-strip"><span><Sparkles size={16}/>{count ? 'Відкрито ' + count + ' із 31 подарунка' : 'Перший подарунок чекає на тебе'}</span><small>Пропущені дні можна відкрити до кінця грудня.</small></div>
    {(error || claimError) && <div className="winter-error" role="alert"><p>{claimError || error}</p>{onRefresh && <button type="button" onClick={onRefresh} disabled={loading || busy}><RefreshCw size={15}/>Оновити календар</button>}</div>}
    {loading && !state && <p className="winter-loading" role="status">Відкриваємо календар…</p>}
    {state?.phase === 'upcoming' && <aside className="winter-notice"><span>Зустрінемось 1 грудня.</span><p>Перший подарунок відкриється о 00:00 за Києвом. До цього часу нічого не нараховується.</p></aside>}
    {state?.phase === 'ended' && <aside className="winter-notice"><span>Дякуємо за цей грудень.</span><p>Нові віконця вже не відкриваються. Збережені подарунки можна використати за їхніми умовами нижче.</p></aside>}
    {state && !state.eligible && state.phase === 'active' && <aside className="winter-notice"><span>{state.ineligibleReason === 'guest' ? 'Збережи подарунки у своєму акаунті.' : 'Ще один крок до подарунків.'}</span><p>{state.ineligibleReason === 'guest' ? 'Увійди в Xelay, щоб відкривати календар і використовувати бонуси.' : state.ineligibleReason === 'email_unconfirmed' ? 'Підтвердь пошту свого акаунта й повернися до календаря.' : 'Заверши налаштування акаунта, щоб відкрити календар.'}</p>{state.ineligibleReason === 'guest' && onSignIn && <button className="winter-primary-button" type="button" onClick={onSignIn}>Увійти в Xelay<ArrowRight size={16}/></button>}</aside>}
    <section className="wg-calendar-layout" id="winter-calendar" aria-label="Твій грудневий календар">
      <div className="wg-calendar"><div className="wg-calendar-heading"><h2>Твій грудень</h2><span>{count} / 31 відкрито</span></div><div className="wg-day-grid">{WINTER_REWARDS.map(item => {
        const collected = Boolean(state?.claimedDays.includes(item.day)), future = !state || item.day > state.currentDay
        return <button type="button" key={item.day} className={'wg-day' + (collected ? ' is-collected' : '') + (future ? ' is-future' : '')} aria-label={item.day + ' грудня: ' + item.name + (collected ? ', відкрито' : future ? ', ще не відкрився' : state?.phase === 'ended' ? ', не відкрито' : ', можна відкрити')} aria-pressed={day === item.day} onClick={() => choose(item.day, true)} disabled={busy}>
          <WinterGiftBox day={item.day} compact/><span className="wg-day-kind">{winterRewardLabel(item)}</span>{future && !collected && <LockKeyhole size={11} className="wg-day-lock" aria-hidden="true"/>}{collected && <Check size={12} className="wg-day-check" aria-hidden="true"/>}
        </button>
      })}</div><p className="wg-calendar-note">Дні відкриваються за київським часом. Подарунок спочатку зберігається в акаунті; активацію, тариф і спосіб використання обираєш ти.</p></div>
      <aside className="wg-detail" id="winter-gift-detail" ref={detail} aria-label={'Подарунок за ' + day + ' грудня'}><div className="wg-detail-top"><span>{String(day).padStart(2, '0')}<small>грудня</small></span><span className="wg-kind-pill">{winterRewardLabel(reward)}</span></div>
        <WinterScratchCard key={day} reward={reward} opened={opened} available={available} busy={busy} onOpen={claim}/>
        <div className="wg-detail-copy" aria-live="polite"><span className="wg-eyebrow">{opened ? 'ТВІЙ ПОДАРУНОК' : 'ПОДИВИСЯ, ЩО ВСЕРЕДИНІ'}</span><h2>{reward.name}</h2>{reward.kind === 'credits' && <p className="wg-credit-condition"><Sparkles size={13}/>Для оплаченої підписки з ШІ</p>}{reward.kind === 'credit_bonus' && <p className="wg-credit-condition"><Sparkles size={13}/>Бонус до пакета кредитів студентського Макса</p>}<p>{opened ? reward.description : available ? 'Зітри морозний візерунок або натисни кнопку, щоб відкрити подарунок.' : state?.phase === 'ended' ? 'Цей подарунок не було відкрито до завершення календаря.' : 'Віконце відкриється ' + day + ' грудня.'}</p>{opened && <a className="winter-text-link" href="#winter-benefits">Використати подарунки<ArrowRight size={15}/></a>}</div>
        <nav className="wg-detail-navigation" aria-label="Перегляд днів"><button type="button" onClick={() => choose(Math.max(1, day - 1))} disabled={day === 1 || busy} aria-label="Попередній день"><ArrowLeft size={16}/></button><span>{day} / 31</span><button type="button" onClick={() => choose(Math.min(31, day + 1))} disabled={day === 31 || busy} aria-label="Наступний день"><ArrowRight size={16}/></button></nav>
      </aside>
    </section>
    <section className="winter-benefits-section" id="winter-benefits" aria-label="Мої подарунки">{benefitsPanel || <><h2>Мої подарунки</h2><p>{state?.eligible ? 'Завантажуємо збережені подарунки…' : 'Увійди у свій акаунт, щоб переглянути подарунки.'}</p></>}</section>
    <footer className="wg-proposal-footer"><span>Xelay</span><p>Календар працює з 1 до 31 грудня 2026 року. Кредити потрібно активувати до 31 січня 2027 року з оплаченою підпискою з ШІ. Інші бонуси й пропозиції діють до 28 лютого. Умови кожного подарунка видно до його використання.</p></footer>
  </main>
}
