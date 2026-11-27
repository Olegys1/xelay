import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Clock3, Gift, PauseCircle, RefreshCw, Sparkles, Ticket, Wallet } from 'lucide-react'
import type { WinterAudience, WinterBenefit, WinterBenefitAction, WinterBenefitsState } from '../../lib/winterBenefits'
import type { WinterBillingOffers, WinterSubscriptionQuote, WinterSubscriptionSelection } from '../../lib/billing'
import { WINTER_REWARDS } from '../../lib/winterCampaign'
import './winterBenefits.css'

export interface WinterBenefitsPanelProps {
  state: WinterBenefitsState | null
  offers: WinterBillingOffers | null
  loading?: boolean
  pending?: boolean
  error?: string
  onRefresh: () => void
  onAction: (action: WinterBenefitAction) => Promise<void>
  onQuote: (selection: WinterSubscriptionSelection) => Promise<WinterSubscriptionQuote>
  onCheckout: (selection: WinterSubscriptionSelection) => Promise<void>
  onCheckPayment: (reference: string) => Promise<void>
  onIssueFriend: () => Promise<{ token: string; percent: number; expiresAt: string }>
  onAcceptFriend: (token: string) => Promise<{ percent: number; expiresAt: string }>
}

const audienceName: Record<WinterAudience, string> = { student: 'Студентська', teacher: 'Викладацька' }
const planName = (id: string | null) => id?.endsWith('max') ? 'Макс' : id?.endsWith('plus') ? 'Плюс' : id?.endsWith('start') ? 'Старт' : 'Немає оплаченої підписки'
const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''
const credits = (value: number) => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value)
const money = (value: number) => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value) + ' грн'
const future = (date: string | null, now: string) => !!date && Date.parse(date) > Date.parse(now)
const quoteReasons: Record<string, string> = { WINTER_AUDIENCE: 'Обери тариф для типу свого акаунта.', WINTER_EXPIRED: 'Строк цієї пропозиції завершився.', WINTER_PAUSED: 'Спочатку віднови підписку з паузи.', WINTER_NOT_EARNED: 'Відкрий відповідний подарунок календаря, щоб отримати цю знижку.', WINTER_CHECKOUT_RESERVED: 'Пропозицію вже закріплено за оплатою. Онови подарунки, щоб її продовжити.' }
const quoteReason = (reason?: string) => quoteReasons[reason || ''] || 'Ця пропозиція недоступна для вибраного тарифу.'

function useObservedServerTime(serverNow: string | undefined, ticking: boolean) {
  const anchor = useRef({ value: serverNow, at: performance.now() })
  if (anchor.current.value !== serverNow) anchor.current = { value: serverNow, at: performance.now() }
  const [, tick] = useState(0)
  useEffect(() => { if (!ticking) return; const timer = window.setInterval(() => tick(value => value + 1), 30_000); return () => window.clearInterval(timer) }, [ticking])
  return serverNow ? Date.parse(serverNow) + performance.now() - anchor.current.at : null
}

/** UI convenience only; the server checks the paid plan again for every action. */
function canUseGift(state: WinterBenefitsState, gift: WinterBenefit, audience: WinterAudience) {
  const sub = state.subscriptions[audience]
  if (!state.eligible || gift.status !== 'available' || !sub.planId || !future(sub.expiresAt, state.serverNow) || future(sub.pausedUntil, state.serverNow)) return false
  if (gift.kind === 'upgrade' && audience === 'student' && sub.planId === 'start') return false
  if (gift.kind === 'pause' && future(sub.upgradeUntil, state.serverNow)) return false
  return Date.parse(state.serverNow) < Date.parse(state.activationEndsAt)
}

function PauseClock({ until, serverNow }: { until: string; serverNow: string }) {
  const anchor = useRef({ value: serverNow, at: performance.now() })
  if (anchor.current.value !== serverNow) anchor.current = { value: serverNow, at: performance.now() }
  const [, tick] = useState(0)
  useEffect(() => { const timer = window.setInterval(() => tick(value => value + 1), 60_000); return () => window.clearInterval(timer) }, [])
  const remaining = Math.max(0, Date.parse(until) - Date.parse(serverNow) - (performance.now() - anchor.current.at))
  const minutes = Math.ceil(remaining / 60_000), hours = Math.floor(minutes / 60)
  return <span>{remaining ? 'Залишилось ' + (hours >= 24 ? Math.floor(hours / 24) + ' дн. ' : '') + hours % 24 + ' год. ' + minutes % 60 + ' хв.' : 'Час паузи минув. Оновіть статус.'}</span>
}

function BenefitRow({ gift, state, busy, onUse }: { gift: WinterBenefit; state: WinterBenefitsState; busy: boolean; onUse: (day: number, audience: WinterAudience) => void }) {
  const [selection, setSelection] = useState<WinterAudience | ''>('')
  const availableAudiences = (['student', 'teacher'] as const).filter(audience => canUseGift(state, gift, audience))
  const selected = selection && availableAudiences.includes(selection) ? selection : availableAudiences[0] || ''
  const reward = WINTER_REWARDS[gift.day - 1]
  const available = gift.status === 'available'
  return <article className={'wb-benefit-row' + (available ? '' : ' is-used')}>
    <span className="wb-day-tag">{gift.day}<small>груд.</small></span>
    <div className="wb-benefit-copy"><strong>{reward.name}</strong><p>{available ? gift.kind === 'pause' ? 'Платні можливості призупиняться. Час підписки збережеться.' : gift.kind === 'upgrade' ? 'Для оплаченої підписки з ШІ. У Максі це додатковий день; квота ШІ не оновлюється.' : 'Додається до чинної оплаченої підписки без нової квоти ШІ.' : gift.convertedToExtension ? 'Додано до строку оплаченого Макса.' : gift.status === 'active' ? 'Діє до ' + dateLabel(gift.activeUntil) : gift.status === 'expired' ? 'Строк активації минув.' : 'Використано' + (gift.audience ? ' · ' + audienceName[gift.audience].toLowerCase() : '')}</p>
      {available && !selected && <small>Подарунок зачекає на відповідну оплачену підписку. Активну паузу або день Макса спершу потрібно завершити.</small>}
    </div>
    {available && <div className="wb-benefit-action">{selected && <label className="winter-visually-hidden" htmlFor={'winter-audience-' + gift.day}>Для якої підписки використати подарунок</label>}{selected && <select id={'winter-audience-' + gift.day} value={selected} onChange={event => setSelection(event.target.value as WinterAudience)} disabled={busy}>{availableAudiences.map(audience => <option key={audience} value={audience}>{audienceName[audience]}</option>)}</select>}<button type="button" className="wb-secondary" disabled={busy || !selected} onClick={() => { if (selected) onUse(gift.day, selected) }}>{gift.kind === 'pause' ? 'Поставити на паузу' : 'Активувати'}<ArrowRight size={14}/></button></div>}
    {!available && <span className="wb-used-mark"><Check size={16}/>{gift.status === 'active' ? 'Активний' : gift.status === 'expired' ? 'Завершено' : 'Готово'}</span>}
  </article>
}

export function WinterBenefitsPanel({ state, offers, loading = false, pending = false, error = '', onRefresh, onAction, onQuote, onCheckout, onCheckPayment, onIssueFriend, onAcceptFriend }: WinterBenefitsPanelProps) {
  const [selection, setSelection] = useState<WinterSubscriptionSelection>({ audience: 'student', planId: 'plus', termMonths: 1, source: 'own' })
  const [quote, setQuote] = useState<WinterSubscriptionQuote | null>(null)
  const quoteVersion = useRef(0)
  const [terms, setTerms] = useState(false)
  const [friendTerms, setFriendTerms] = useState(false)
  const [resumeTerms, setResumeTerms] = useState(false)
  const [friendInput, setFriendInput] = useState('')
  const [issuedToken, setIssuedToken] = useState('')
  const [message, setMessage] = useState('')
  const [localError, setLocalError] = useState('')
  const [working, setWorking] = useState(false)
  const synchronousBusy = useRef(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const busy = pending || working || loading
  const run = async (action: () => Promise<void>, success = '') => {
    if (busy || synchronousBusy.current) return
    synchronousBusy.current = true; setWorking(true); setLocalError(''); setMessage('')
    const current = generation.current
    try { await action(); if (current === generation.current) setMessage(success) }
    catch (cause) { if (current === generation.current) setLocalError(cause instanceof Error ? cause.message : 'Не вдалося виконати дію. Спробуйте ще раз.') }
    finally { if (current === generation.current) { synchronousBusy.current = false; setWorking(false) } }
  }
  const change = (next: WinterSubscriptionSelection) => { quoteVersion.current++; setSelection(next); setQuote(null); setTerms(false); setLocalError(''); setMessage('') }
  const activePaused = state ? (['student', 'teacher'] as const).filter(audience => future(state.subscriptions[audience].pausedUntil, state.serverNow)) : []
  const canActivateCredits = !!state?.eligible && !state.promo.activatedAt && state.promo.collectedCredits > 0 && Date.parse(state.serverNow) < Date.parse(state.promo.activationEndsAt) && (['student', 'teacher'] as const).some(audience => {
    const sub = state.subscriptions[audience]
    return !!sub.planId && (audience === 'teacher' || sub.planId !== 'start') && future(sub.expiresAt, state.serverNow) && !future(sub.pausedUntil, state.serverNow)
  })
  const offerToken = offers?.friend.issuedToken || issuedToken
  const canBuyStudentCredits = !!state?.eligible && state.subscriptions.student.effectivePlanId === 'max' && !future(state.subscriptions.student.upgradeUntil, state.serverNow) && !future(state.subscriptions.student.pausedUntil, state.serverNow) && (!state.subscriptions.student.planId || future(state.subscriptions.student.expiresAt, state.serverNow))
  const pendingOrder = offers?.pendingOrder
  useEffect(() => { setResumeTerms(false) }, [pendingOrder?.orderReference])
  const estimatedNow = useObservedServerTime(state?.serverNow, !!pendingOrder || !!quote)
  const pendingExpired = !!pendingOrder && (pendingOrder.status === 'expired' || estimatedNow === null || Date.parse(pendingOrder.expiresAt) <= estimatedNow)
  const offersExpired = !!offers && !!state && Date.parse(offers.expiresAt) <= Date.parse(state.serverNow)
  const maxOffer = offers ? Math.max(offers.monthly.start, offers.monthly.plus, offers.monthly.max, offers.annualPercent, offers.friend.acceptedPercent) : 0
  const quoteExpired = !!quote && (estimatedNow === null || Date.parse(quote.expiresAt) <= estimatedNow)
  const displayPlan = selection.planId.replace('teacher_', '')
  return <div className="winter-benefits" aria-busy={busy}>
    <div className="wb-heading"><div><span className="wg-eyebrow">ТЕ, ЩО ТИ ВЖЕ ВІДКРИВ</span><h2>Мої подарунки</h2></div><button type="button" className="wb-refresh" onClick={onRefresh} disabled={busy}><RefreshCw size={15}/>Оновити</button></div>
    {(error || localError) && <p className="wb-message is-error" role="alert">{localError || error}</p>}
    {message && <p className="wb-message" role="status"><Check size={16}/>{message}</p>}
    {busy && <p className="wb-pending" role="status">{loading ? 'Завантажуємо подарунки…' : 'Перевіряємо та зберігаємо…'}</p>}
    {!state && !loading && <p className="wb-empty">Гаманець подарунків зараз недоступний. Оновіть дані, щоб побачити збережені бонуси.</p>}
    {state && <>
      <div className="wb-summary-grid"><article className="wb-wallet"><span className="wb-card-label"><Wallet size={18}/>Бонусні кредити</span><div className="wb-wallet-total">{credits(state.promo.availableCredits)}<small>готові до використання</small></div><dl><div><dt>З календаря</dt><dd>{state.promo.collectedCredits} / 150</dd></div>{state.promo.purchaseBonusCredits > 0 && <div><dt>За покупку пакета</dt><dd>{credits(state.promo.purchaseBonusCredits)}</dd></div>}<div><dt>У роботі</dt><dd>{credits(state.promo.reservedCredits)}</dd></div><div><dt>Використано</dt><dd>{credits(state.promo.spentCredits)}</dd></div></dl>
        {state.promo.activatedAt ? <p className="wb-note"><Check size={14}/>{state.promo.usable ? 'Активовано. Нові кредитні подарунки додаватимуться автоматично.' : state.promo.spentCredits + state.promo.reservedCredits >= state.promo.collectedCredits + state.promo.purchaseBonusCredits ? 'Бонусні кредити вже використані або зарезервовані поточним запитом.' : 'Активовано. Для використання віднови оплачену підписку з ШІ.'}</p> : <><p className="wb-note">Активуй з оплаченою підпискою з ШІ до 31 січня. Якщо вона вже є, повторна покупка не потрібна. Після активації залишок не згорає.</p><button type="button" className="winter-primary-button" disabled={busy || !canActivateCredits} onClick={() => { void run(() => onAction({ action: 'activate_credits' }), 'Бонусні кредити активовано.') }}><Sparkles size={16}/>Активувати кредити</button>{!canActivateCredits && state.promo.collectedCredits > 0 && <p className="wb-fine">{Date.parse(state.serverNow) >= Date.parse(state.promo.activationEndsAt) ? 'Строк активації бонусних кредитів завершився.' : 'Потрібна чинна оплачена підписка з ШІ без паузи. Студентський Старт не підходить.'}</p>}</>}
      </article><article className="wb-subscriptions"><span className="wb-card-label"><Clock3 size={18}/>Твої підписки</span>{(['student', 'teacher'] as const).map(audience => {
        const sub = state.subscriptions[audience]
        return <div className="wb-subscription" key={audience}><small>{audienceName[audience]}</small><strong>{planName(sub.planId)}</strong>{sub.expiresAt && <p>Поточний оплачений період до {dateLabel(sub.expiresAt)}</p>}{future(sub.upgradeUntil, state.serverNow) && <p className="wb-note">Подарунковий Макс до {dateLabel(sub.upgradeUntil)}</p>}{activePaused.includes(audience) && <div className="wb-pause"><PauseCircle size={16}/><div><strong>Пауза до {dateLabel(sub.pausedUntil)}</strong><PauseClock until={sub.pausedUntil!} serverNow={state.serverNow}/><button type="button" className="wb-link" disabled={busy} onClick={() => { void run(() => onAction({ action: 'resume', audience }), 'Підписку відновлено.') }}>Відновити зараз</button></div></div>}</div>
      })}<p className="wb-fine">Бонусні дні не створюють нову місячну квоту ШІ. Усі зміни показуються після підтвердження сервера.</p></article></div>
      <section className="wb-days"><h3><Gift size={18}/>Дні та паузи</h3><p className="wb-section-note">Використай до 28 лютого 2027 року. Кожен подарунок застосовується один раз до вибраної оплаченої підписки.</p>{state.benefits.length ? state.benefits.map(gift => <BenefitRow key={gift.day} gift={gift} state={state} busy={busy} onUse={(day, audience) => { void run(() => onAction({ action: 'redeem', day, audience }), 'Подарунок застосовано. Новий строк видно вище.') }}/>) : <p className="wb-empty">Відкривай календар, і тут з’являтимуться твої додаткові дні та паузи.</p>}</section>
    </>}
    {offers && <section className="wb-offers"><h3><Ticket size={18}/>Зимові пропозиції</h3><p className="wb-section-note">Одна знижка на власну підписку за календар: своя або отримана від друга, на місяць або рік. Окремо можна подарувати один купон іншій людині. Пізніші дні можуть відкрити кращу пропозицію. Знижки не складаються.</p>
      <div className="wb-offer-chips"><span>Старт {offers.monthly.start ? '−' + offers.monthly.start + '%' : 'ще не відкрито'}</span><span>Плюс {offers.monthly.plus ? '−' + offers.monthly.plus + '%' : 'ще не відкрито'}</span><span>Макс {offers.monthly.max ? '−' + offers.monthly.max + '%' : 'ще не відкрито'}</span><span>Рік {offers.annualPercent ? '−' + offers.annualPercent + '%' : 'ще не відкрито'}</span></div>
      {offers.subscriptionUsed ? <p className="wb-message"><Check size={16}/>Зимову знижку на підписку вже використано.</p> : pendingOrder ? <div className="wb-quote wb-pending-order">
        <span className="wg-eyebrow">ОПЛАТА ЩЕ НЕ ПІДТВЕРДЖЕНА</span><h4>{audienceName[pendingOrder.audience]} підписка {planName(pendingOrder.planId)}</h4><p><strong>{money(pendingOrder.amount)}</strong><span>−{pendingOrder.discountPercent}% · {pendingOrder.termMonths === 12 ? '12 місяців' : '1 місяць'}</span></p><p className="wb-fine">{pendingExpired ? 'Строк платіжної форми минув. Перевір статус: поки платіжний сервіс не підтвердить завершення замовлення, нова оплата недоступна.' : 'Тариф і строк збережено. Можна повернутися до тієї самої оплати або перевірити, чи вона вже пройшла.'}</p>
        {!pendingExpired && <><label className="wb-consent"><input type="checkbox" checked={resumeTerms} disabled={busy} onChange={event => setResumeTerms(event.target.checked)}/><span>Погоджуюсь з <a href="/terms" target="_blank" rel="noopener noreferrer">умовами оплати</a> та <a href="/refund-policy" target="_blank" rel="noopener noreferrer">повернення коштів</a>.</span></label><button type="button" className="winter-primary-button" disabled={busy || !resumeTerms} onClick={() => { if (resumeTerms) void run(() => onCheckout({ audience: pendingOrder.audience, planId: pendingOrder.planId, termMonths: pendingOrder.termMonths, source: pendingOrder.source })) }}>Продовжити оплату<ArrowRight size={16}/></button></>}
        <button type="button" className="wb-secondary" disabled={busy} onClick={() => { void run(() => onCheckPayment(pendingOrder.orderReference), 'Статус перевірено. Якщо оплата ще обробляється, зачекай трохи й онови його.') }}><RefreshCw size={14}/>Перевірити оплату</button>
      </div> : offersExpired ? <p className="wb-message">Строк зимових пропозицій завершився.</p> : <>
        <fieldset className="wb-quote-form" disabled={busy}><legend>Обери підписку і перевір остаточну суму</legend><label>Для кого<select value={selection.audience} onChange={event => { const audience = event.target.value as WinterAudience; change({ ...selection, audience, planId: (audience === 'teacher' ? 'teacher_' + displayPlan : displayPlan) as WinterSubscriptionSelection['planId'] }) }}><option value="student">Для студента</option><option value="teacher">Для викладача</option></select></label><label>Тариф<select value={displayPlan} onChange={event => change({ ...selection, planId: (selection.audience === 'teacher' ? 'teacher_' + event.target.value : event.target.value) as WinterSubscriptionSelection['planId'] })}><option value="start">Старт</option><option value="plus">Плюс</option><option value="max">Макс</option></select></label><label>Період<select value={selection.termMonths} onChange={event => change({ ...selection, termMonths: Number(event.target.value) as 1 | 12 })}><option value={1}>1 місяць</option><option value={12} disabled={selection.source === 'friend'}>12 місяців</option></select></label><label>Пропозиція<select value={selection.source} onChange={event => change({ ...selection, source: event.target.value as 'own' | 'friend', termMonths: event.target.value === 'friend' ? 1 : selection.termMonths })}><option value="own">Мій календар</option><option value="friend" disabled={!offers.friend.acceptedPercent}>Код від друга{offers.friend.acceptedPercent ? ' · −' + offers.friend.acceptedPercent + '%' : ''}</option></select></label></fieldset>
        <button type="button" className="wb-secondary" disabled={busy || !maxOffer || offers.paused[selection.audience]} onClick={() => { setQuote(null); setTerms(false); const version = ++quoteVersion.current; void run(async () => { const next = await onQuote(selection); if (version === quoteVersion.current) setQuote(next) }) }}>Перевірити ціну<ArrowRight size={15}/></button>{offers.paused[selection.audience] && <p className="wb-fine">Спочатку віднови цю підписку з паузи.</p>}
        {quote && <div className="wb-quote" aria-live="polite">{quote.available && !quoteExpired ? <><p><s>{money(quote.listAmount)}</s><strong>{money(quote.amount)}</strong><span>−{quote.discountPercent}% · {quote.termMonths === 12 ? 'за 12 місяців' : 'за місяць'}</span></p><p className="wb-fine">Одна оплата без автоматичного продовження. Після переходу до WayForPay вибраний тариф і строк фіксуються для цієї знижки. Якщо не завершиш оплату, повернися до тієї самої комбінації.</p><label className="wb-consent"><input type="checkbox" checked={terms} disabled={busy} onChange={event => setTerms(event.target.checked)}/><span>Погоджуюсь з <a href="/terms" target="_blank" rel="noopener noreferrer">умовами оплати й зимових подарунків</a> та <a href="/refund-policy" target="_blank" rel="noopener noreferrer">повернення коштів</a>.</span></label><button type="button" className="winter-primary-button" disabled={busy || !terms} onClick={() => { if (terms) void run(() => onCheckout({ audience: quote.audience, planId: quote.planId, termMonths: quote.termMonths, source: quote.source })) }}>До оплати {money(quote.amount)}<ArrowRight size={16}/></button></> : <p>{quoteExpired ? 'Ціна потребує оновлення. Перевір її ще раз.' : quoteReason(quote.reason)}</p>}</div>}
      </>}
      <details className="wb-friend"><summary>Подарувати знижку або використати код друга</summary><p>Код передаєш самостійно. Створення коду закріплює поточну знижку для друга; твоя власна знижка збережеться. Одержувач може використати один купон на свою підписку за календар.</p><label className="wb-consent"><input type="checkbox" checked={friendTerms} disabled={busy} onChange={event => setFriendTerms(event.target.checked)}/><span>Приймаю <a href="/terms" target="_blank" rel="noopener noreferrer">умови зимової пропозиції</a>.</span></label>
        {offerToken ? <label className="wb-token">Твій код для друга<input readOnly value={offerToken} onFocus={event => event.currentTarget.select()} aria-label="Код знижки для друга"/><small>Скопіюй і передай людині, якій хочеш подарувати знижку.</small></label> : <button type="button" className="wb-secondary" disabled={busy || offersExpired || !friendTerms || !offers.friend.percent} onClick={() => { void run(async () => { const result = await onIssueFriend(); setIssuedToken(result.token) }, 'Код створено. Він нікому не надсилався.') }}>Створити код{offers.friend.percent ? ' на −' + offers.friend.percent + '%' : ''}</button>}
        <div className="wb-friend-accept"><label>Код, який подарували тобі<input autoComplete="off" spellCheck={false} maxLength={180} value={friendInput} disabled={busy} onChange={event => setFriendInput(event.target.value)} placeholder="Встав код друга"/></label><button type="button" className="wb-secondary" disabled={busy || offersExpired || !friendTerms || !friendInput.trim() || offers.subscriptionUsed} onClick={() => { void run(async () => { await onAcceptFriend(friendInput.trim()); setFriendInput(''); change({ ...selection, source: 'friend', termMonths: 1 }) }, 'Код прийнято. Перевір ціну перед оплатою.') }}>Перевірити код</button></div>
      </details>
      <aside className="wb-credit-bonus"><Sparkles size={20}/><div><strong>{offers.creditBonus.used ? 'Бонус до покупки кредитів уже використано' : offers.creditBonus.percent ? '+' + offers.creditBonus.percent + '% до покупки кредитів' : 'Бонус до покупки кредитів ще попереду'}</strong><p>{offers.creditBonus.percent ? 'До пакета кредитів студентського Макса, максимум ' + offers.creditBonus.capCredits + ' бонусних кредитів. Куплені кредити залишаються окремо. Бонус застосовується автоматично до відповідної покупки.' : 'Бонус до пакета кредитів студентського Макса. Відкрий відповідне віконце календаря, щоб зберегти пропозицію.'}</p>{offers.creditBonus.percent > 0 && !offers.creditBonus.used && !offersExpired && canBuyStudentCredits && <a className="wb-link" href="/learning">Докупити у студентському Максі<ArrowRight size={14}/></a>}</div></aside>
    </section>}
    {!offers && !loading && <p className="wb-empty">Пропозиції на оплату поки не завантажилися. Перевір їх повторно перед покупкою.</p>}
  </div>
}
