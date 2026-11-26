import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, LockKeyhole, RefreshCw, Sparkles } from 'lucide-react'
import { WINTER_MILESTONES, WINTER_REWARDS, type WinterAdventState } from '../../lib/winterCampaign'
import { WinterGlyph, WinterScene } from './WinterArt'
import { WinterScratchCard } from './WinterScratchCard'
import { WinterEffectsControl } from './WinterDecorations'
import './winter.css'

export interface WinterCalendarViewProps {
  state: WinterAdventState | null
  onClaim: (day: number) => Promise<void>
  loading?: boolean
  error?: string
  onRefresh?: () => void
  onSignIn?: () => void
  preview?: boolean
}

/** Presentation-only fixture entry. Actual progress always comes from the server. */
export function WinterCalendarView({ state, onClaim, loading = false, error = '', onRefresh, onSignIn, preview = false }: WinterCalendarViewProps) {
  const [chosenDay, setChosenDay] = useState<number | null>(null)
  const [claimingDay, setClaimingDay] = useState<number | null>(null)
  const [claimError, setClaimError] = useState('')
  const [celebration, setCelebration] = useState(false)
  const [collectionOpen, setCollectionOpen] = useState(false)
  const count = state?.claimedDays.length || 0
  const day = chosenDay ?? Math.max(1, state?.currentDay || 1)
  const reward = WINTER_REWARDS[day - 1]
  const opened = Boolean(state?.claimedDays.includes(day))
  const available = Boolean(state?.eligible && state.phase === 'active' && day <= state.currentDay)
  const choose = (next: number) => { setChosenDay(next); setClaimError(''); setCelebration(false) }
  const claim = async () => {
    if (claimingDay !== null || !available || opened) return
    setClaimingDay(day); setClaimError(''); setCelebration(false)
    try { await onClaim(day); setCelebration(true) }
    catch (reason) { setClaimError(reason instanceof Error ? reason.message : 'Не вдалося зберегти подарунок. Спробуйте ще раз.'); throw reason }
    finally { setClaimingDay(null) }
  }
  return <main className="winter-page" data-winter-preview={preview || undefined}>
    <div className="winter-page-top"><a href="/" className="winter-back"><ArrowLeft size={16}/>До Xelay</a><WinterEffectsControl/></div>
    {preview && <p className="winter-preview-note">Локальний перегляд. Подарунки тут не змінюють акаунт.</p>}
    <header className="winter-hero">
      <div className="winter-hero-copy"><span className="winter-eyebrow"><span/>ГРУДЕНЬ У XELAY · 2026</span><h1>Зима, яку<br/>збираєш <em>ти.</em></h1><p>Маленькі подарунки для довгих зимових вечорів. Відкривайте по одному щодня й збирайте свою колекцію.</p><a href="#winter-calendar" className="winter-text-link">До календаря<ArrowRight size={16}/></a></div>
      <WinterScene collected={count} celebrating={celebration}/>
      <div className="winter-hero-caption"><span>01 — 31 грудня</span><span>Трохи тепла між парами.</span></div>
    </header>
    <div className="winter-status-strip"><span><Sparkles size={16}/>{count ? `${count} з 31 подарунка у вашій колекції` : 'Ваша зимова колекція починається тут'}</span><small>Пропущені дні можна відкрити до кінця грудня.</small></div>
    {(error || claimError) && <div className="winter-error" role="alert"><p>{claimError || error}</p>{onRefresh && <button type="button" onClick={onRefresh} disabled={loading}><RefreshCw size={15}/>Оновити колекцію</button>}</div>}
    {loading && !state && <p className="winter-loading" role="status">Відкриваємо календар…</p>}
    {state?.phase === 'upcoming' && <aside className="winter-notice"><span>Зустрінемось 1 грудня.</span><p>Перший подарунок відкриється опівночі за Києвом. Участь безкоштовна.</p></aside>}
    {state?.phase === 'ended' && <aside className="winter-notice"><span>Дякуємо за цей грудень.</span><p>Календар завершився. Ваші {count} подарунків залишаються в зимовій колекції.</p></aside>}
    {state && !state.eligible && state.phase === 'active' && <aside className="winter-notice"><span>{state.ineligibleReason === 'guest' ? 'Збережіть свою зиму в акаунті.' : 'Ще один крок до подарунків.'}</span><p>{state.ineligibleReason === 'guest' ? 'Увійдіть у Xelay, щоб колекція залишалась з вами на всіх пристроях.' : state.ineligibleReason === 'email_unconfirmed' ? 'Підтвердьте пошту свого акаунта й поверніться до календаря.' : 'Завершіть налаштування акаунта, щоб відкрити календар.'}</p>{state.ineligibleReason === 'guest' && onSignIn && <button className="winter-primary-button" type="button" onClick={onSignIn}>Увійти в Xelay<ArrowRight size={16}/></button>}</aside>}
    <section className="winter-calendar-layout" id="winter-calendar" aria-label="Ваш грудневий календар">
      <div className="winter-calendar-main"><div className="winter-section-heading"><div><span className="winter-eyebrow">ТРИДЦЯТЬ ОДИН МАЛЕНЬКИЙ СЮРПРИЗ</span><h2>Ваш грудень</h2></div><span className="winter-year-mark">2026</span></div>
        <div className="winter-calendar-grid">{WINTER_REWARDS.map(item => {
          const collected = Boolean(state?.claimedDays.includes(item.day)), future = !state || item.day > state.currentDay, isCurrent = state?.phase === 'active' && item.day === state.currentDay
          return <button type="button" key={item.day} className={`winter-day${collected ? ' is-collected' : ''}${future ? ' is-future' : ''}${isCurrent ? ' is-today' : ''}`} aria-label={`${item.day} грудня${collected ? `, отримано: ${item.name}` : future ? ', ще не відкрився' : state?.phase === 'ended' ? ', не відкрито' : ', можна відкрити'}`} aria-pressed={day === item.day} onClick={() => choose(item.day)} disabled={claimingDay !== null}>
            <span className="winter-day-number">{String(item.day).padStart(2, '0')}</span>{collected ? <WinterGlyph symbol={item.symbol}/> : <span className="winter-day-mark" aria-hidden="true">{future ? <LockKeyhole size={12}/> : '✧'}</span>}{collected && <Check size={11} className="winter-day-check"/>}{isCurrent && <span className="winter-today-dot"/>}
          </button>
        })}</div><p className="winter-calendar-footnote">Кожне віконце відкривається за київським часом. Можна повернутись і забрати подарунки за попередні дні.</p>
      </div>
      <aside className="winter-gift-detail" aria-label={`Подарунок за ${day} грудня`}>
        <div className="winter-gift-date"><span>{String(day).padStart(2, '0')}</span><div>грудня<small>{opened ? 'ваш подарунок' : state && day <= state.currentDay ? 'відкрийте сюрприз' : 'попереду ще трохи зими'}</small></div><span className="winter-gift-star" aria-hidden="true">✦</span></div>
        <WinterScratchCard key={day} reward={reward} opened={opened} available={available} busy={claimingDay === day} onOpen={claim}/>
        <div className="winter-gift-copy" aria-live="polite"><h3>{opened ? reward.name : 'Під снігом щось є.'}</h3><p>{opened ? reward.description : available ? 'Проведіть пальцем або мишею по віконцю. Можна й просто натиснути кнопку.' : state?.phase === 'ended' ? 'Це віконце не було відкрито до завершення календаря.' : `Подарунок за ${day} грудня чекатиме тут до кінця місяця.`}</p></div>
        <div className="winter-gift-navigation"><button type="button" onClick={() => choose(Math.max(1, day - 1))} disabled={day === 1 || claimingDay !== null} aria-label="Попередній день"><ArrowLeft size={16}/></button><span>{day} / 31</span><button type="button" onClick={() => choose(Math.min(31, day + 1))} disabled={day === 31 || claimingDay !== null} aria-label="Наступний день"><ArrowRight size={16}/></button></div>
      </aside>
    </section>
    <section className="winter-collection"><div className="winter-section-heading"><div><span className="winter-eyebrow">ЗАЛИШИТЬСЯ НА ЗГАДКУ</span><h2>Маленькі відзнаки</h2></div><span className="winter-collection-label">У зимовій колекції</span></div><div className="winter-milestones">{WINTER_MILESTONES.map(item => <div key={item.id} className={`winter-milestone${count >= item.count ? ' is-earned' : ''}`}><div className="winter-medal"><WinterGlyph symbol={item.symbol}/>{count >= item.count && <Check size={13}/>}</div><strong>{item.name}</strong><span>{count >= item.count ? 'У колекції' : `${item.count} відкритих подарунків`}</span></div>)}</div>
      <button className="winter-collection-toggle" type="button" aria-expanded={collectionOpen} aria-controls="winter-keepsakes" onClick={() => setCollectionOpen(value => !value)}>{collectionOpen ? 'Сховати подарунки' : `Усі мої подарунки · ${count}`}<ChevronDown size={17}/></button>
      {collectionOpen && <div id="winter-keepsakes" className="winter-keepsakes">{count ? WINTER_REWARDS.filter(item => state?.claimedDays.includes(item.day)).map(item => <button key={item.id} type="button" onClick={() => { choose(item.day); document.getElementById('winter-calendar')?.scrollIntoView({ behavior: 'auto', block: 'start' }) }}><WinterGlyph symbol={item.symbol}/><span>{item.name}<small>{item.day} грудня</small></span></button>) : <p>Тут з’являться подарунки, які ви відкриєте.</p>}</div>}
    </section>
    <footer className="winter-rules"><span className="winter-wordmark">Xelay</span><p>Участь безкоштовна. Збирайте зимові прикраси й відзнаки у цьому календарі з 1 до 31 грудня 2026 року. Прогрес зберігається у вашому акаунті. Ці подарунки не змінюють підписку чи ліміт ШІ.</p></footer>
  </main>
}
