import { useRef, useState } from 'react'
import { ArrowRight, BookOpen, Check, ChevronDown, FileText, Layers3, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { CheckoutLegalConsent } from '../LegalLinks'
import { createStudentPlanCheckout, openHostedCheckout, type BillingConfiguration } from '../../lib/billing'
import { getStudentPlanFeatures, STUDENT_PLANS, type StudentPlanId } from '../../lib/studentPlans'
import './studentSubscriptionCatalogue.css'

const PRESENTATION = {
  start: {
    number: '01', label: 'Свій ритм', eyebrow: 'Для щоденних справ', Icon: BookOpen,
    description: 'Збери справи, нотатки й нагадування в один спокійний навчальний день.',
    features: ['Особистий і спільний органайзери', 'Нотатки, закладки та фокус-таймер', 'Пошук у чатах і відкладені повідомлення', 'Статуси, оформлення, статті й опитування', 'Особиста ціль і план підготовки'],
  },
  plus: {
    number: '02', label: 'Більше практики', eyebrow: 'Для впевненої підготовки', Icon: Layers3,
    description: 'Перетвори повторення на зрозумілу практику й побач, що вже виходить.',
    features: ['Власні картки з інтервалами повторення', 'Конструктор особистих тестів', 'Імпорт та експорт запитань', 'Повторення помилок із поясненнями', 'Історія спроб і прогрес за темами'],
  },
  max: {
    number: '03', label: 'Повна студія', eyebrow: 'Для глибокої роботи', Icon: Sparkles,
    description: 'Працюй зі своїми матеріалами, готуйся до сесії та навчайся з ШІ-помічником.',
    features: ['Навчальний ШІ з твоїми джерелами', 'Тести, фідбек і підказки помічника', 'PDF-студія, цитати й навчальні проєкти', 'Єдиний план сесії та сценарії балів', 'Версії робіт, відновлення й експорт'],
  },
} as const

const COMPARISON: readonly { title: string; note: string; from: StudentPlanId }[] = [
  { title: 'Свій порядок у справах', note: 'Органайзери, нотатки, фокус і спілкування', from: 'start' },
  { title: 'Картки та власні тести', note: 'Практика, повторення помилок і прогрес', from: 'plus' },
  { title: 'Робота з джерелами', note: 'PDF, цитати, структура та версії великих робіт', from: 'max' },
  { title: 'Підготовка до кількох іспитів', note: 'План сесії, навантаження та репетиція з таймером', from: 'max' },
  { title: 'Особистий ШІ-помічник', note: 'Розбір обраних матеріалів у межах ліміту', from: 'max' },
]

function PlanScene({ plan }: { plan: StudentPlanId }) {
  if (plan === 'start') return <div className="ssc-scene ssc-day" aria-hidden="true">
    <div className="ssc-scene-heading"><span>Твій день</span><BookOpen size={15} /></div>
    <div className="ssc-day-task"><span className="ssc-task-done"><Check size={11} /></span><span>Зібрати матеріали</span><small>Готово</small></div>
    <div className="ssc-day-task"><span className="ssc-task-open" /><span>Підготуватися до семінару</span></div>
    <div className="ssc-day-progress"><span /></div>
  </div>
  if (plan === 'plus') return <div className="ssc-scene ssc-practice" aria-hidden="true">
    <div className="ssc-scene-heading"><span>Твоя практика</span><Layers3 size={15} /></div>
    <div className="ssc-practice-cards"><div>Запитання</div><div><Check size={15} /><span>Розуміння</span></div></div>
    <p>Спробуй. Розбери помилки. Повтори.</p>
  </div>
  return <div className="ssc-scene ssc-studio" aria-hidden="true">
    <div className="ssc-scene-heading"><span><i />Помічник поруч</span><Sparkles size={15} /></div>
    <div className="ssc-studio-source"><FileText size={16} /><span>Твій конспект</span><ArrowRight size={15} /></div>
    <div className="ssc-studio-outputs"><span>Пояснення</span><span>Тест</span><span>Фідбек</span></div>
  </div>
}

export function StudentSubscriptionCatalogue({ configuration, userId, loading, onLogin, pageHeading = false, birthdayGiftId }: {
  configuration: BillingConfiguration
  userId?: string
  loading: boolean
  onLogin: () => void
  pageHeading?: boolean
  birthdayGiftId?: string | null
}) {
  const [selected, setSelected] = useState<StudentPlanId>('max')
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const owner = useRef(userId)
  owner.current = userId

  async function buy() {
    if (!userId) { onLogin(); return }
    if (!accepted || busy || loading || lock.current || !configuration.checkoutAvailable) return
    const purchaser = userId
    lock.current = true
    setBusy(true)
    setError('')
    try {
      if (configuration.mode === 'test' && !window.confirm('Це тестова оплата без активації робочого доступу. Продовжити?')) return
      if (birthdayGiftId && !window.confirm(`Застосувати святкову знижку до тарифу «${selectedPlan.name}»? До оплати ${displayPrice} грн. Після відкриття оплати купон закріпиться за цим тарифом; повторний перехід продовжить це саме замовлення.`)) return
      const response = await createStudentPlanCheckout(selected, birthdayGiftId ?? undefined)
      if (owner.current === purchaser) openHostedCheckout(response.checkout)
    } catch (reason) {
      if (owner.current === purchaser) setError(reason instanceof Error ? reason.message : 'Не вдалося підготувати оплату.')
    } finally {
      lock.current = false
      if (owner.current === purchaser) setBusy(false)
    }
  }

  function choose(plan: StudentPlanId) {
    if (busy || selected === plan) return
    setSelected(plan)
    setAccepted(false)
    setError('')
  }

  const selectedPlan = STUDENT_PLANS.find(plan => plan.id === selected)!
  const selectedView = PRESENTATION[selected]
  const basePrice = configuration.studentPlanPrices?.[selected] ?? selectedPlan.monthlyPriceUah
  const discountPercent = { start: 50, plus: 30, max: 20 }[selected]
  const finalPrice = birthdayGiftId ? Math.round(basePrice * (100 - discountPercent)) / 100 : basePrice
  const displayPrice = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(finalPrice)
  const Heading = pageHeading ? 'h1' : 'h2'

  return <section className="ssc" aria-label="Студентські тарифи">
    <header className="ssc-intro">
      <div className="ssc-intro-copy">
        <span className="ssc-kicker"><span />XELAY · ДЛЯ СТУДЕНТІВ</span>
        <Heading>Твій час.<br /><span>Твої можливості.</span></Heading>
        <p>Від порядку в щоденних справах до власної навчальної студії. Обери те, що допоможе саме тобі.</p>
      </div>
      <div className="ssc-intro-aside">
        <span className="ssc-intro-line" aria-hidden="true" />
        <p>Один простір.<br /><strong>Три способи навчатися.</strong></p>
        <div className="ssc-intro-steps" aria-hidden="true"><span>Плануй</span><span>Практикуй</span><span>Створюй</span></div>
      </div>
    </header>

    <div className="ssc-foundation"><span className="ssc-foundation-icon"><ShieldCheck size={20} /></span><p><strong>Навчання доступне кожному.</strong><span>Розклад, ДЗ, матеріали груп і тести викладачів залишаються безкоштовними.</span></p><span className="ssc-foundation-label">З підпискою — більше для себе</span></div>

    <div className="ssc-grid">
      {STUDENT_PLANS.map(plan => {
        const view = PRESENTATION[plan.id]
        const isSelected = selected === plan.id
        const ownFeatures = getStudentPlanFeatures(plan.id).filter(feature => (feature.status === 'existing' || feature.status === 'local') && (plan.id === 'start' || feature.minimumPlan === plan.id))
        return <article key={plan.id} className={`ssc-card ssc-${plan.id}${isSelected ? ' selected' : ''}`} aria-label={`Тариф ${plan.name}`}>
          <div className="ssc-card-top"><span className="ssc-icon"><view.Icon size={22} strokeWidth={1.6} aria-hidden="true" /></span><span className="ssc-edition">{view.label}</span><span className="ssc-card-number" aria-hidden="true">{view.number}</span></div>
          <div className="ssc-identity"><h3>{plan.name}</h3><p>{view.eyebrow}</p></div>
          <div className="ssc-price"><strong>{configuration.studentPlanPrices?.[plan.id] ?? plan.monthlyPriceUah}</strong><span>грн<span>/ місяць</span></span></div>
          <p className="ssc-description">{view.description}</p>
          <PlanScene plan={plan.id} />
          <p className="ssc-includes">{plan.id === 'start' ? 'Твої щоденні інструменти' : <><Check size={14} aria-hidden="true" />{plan.id === 'plus' ? 'Усе зі Старт, а також' : 'Усе з Плюс, а також'}</>}</p>
          <ul className="ssc-highlights">{view.features.map(text => <li key={text}><Check size={15} aria-hidden="true" /><span>{text}</span></li>)}</ul>
          <p className={`ssc-plan-note${plan.id === 'max' ? ' ssc-ai-note' : ''}`}>{plan.id === 'max' ? <><Sparkles size={15} aria-hidden="true" /><span>ШІ має ліміт на період підписки.<br />Без додаткових списань.</span></> : <span>{plan.id === 'start' ? 'Можливості колишнього «Учасника» вже тут.' : 'Для особистої практики у власному темпі.'}</span>}</p>
          <button className="ssc-choice" type="button" disabled={busy} aria-pressed={isSelected} onClick={() => choose(plan.id)}><span>{isSelected ? `Обрано ${plan.name}` : `Обрати ${plan.name}`}</span><span className="ssc-choice-mark">{isSelected ? <Check size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}</span></button>
          <details className="ssc-details"><summary>{plan.id === 'start' ? 'Що саме входить у Старт' : `Детальніше про ${plan.name}`}<ChevronDown size={16} aria-hidden="true" /></summary><div>{plan.id !== 'start' && <p className="ssc-inherited">Можливості попередніх рівнів також включені. Нижче — те, що додає {plan.name}.</p>}{plan.id === 'max' && <div className="ssc-feature"><strong>Навчальний ШІ-помічник</strong><p>Розбирай обрані джерела, створюй особисті тести, отримуй фідбек і вмикай бокові підказки. Матеріали передаються моделі лише з твого дозволу. Кількість роботи з ШІ обмежена лімітом періоду.</p></div>}{ownFeatures.map(feature => <div className="ssc-feature" key={feature.id}><strong>{feature.id === 'start_badge' ? 'Бейдж активної підписки' : feature.title}</strong><p>{feature.id === 'start_badge' ? 'Позначка активної підписки поруч із твоїм ім’ям.' : feature.description.replace(/власних локальних/g, 'власних')}</p></div>)}</div></details>
        </article>
      })}
    </div>

    <details className="ssc-comparison">
      <summary><span className="ssc-comparison-copy"><span className="ssc-kicker">ОБИРАЙ БЕЗ ЗДОГАДОК</span><span>Порівняти можливості</span></span><span className="ssc-comparison-toggle"><ChevronDown size={20} aria-hidden="true" /></span></summary>
      <div className="ssc-comparison-body"><table><caption className="sr-only">Порівняння можливостей студентських тарифів</caption><thead><tr><th scope="col">Можливості</th>{STUDENT_PLANS.map(plan => <th scope="col" key={plan.id}>{plan.name}</th>)}</tr></thead><tbody>{COMPARISON.map(row => <tr key={row.title}><th scope="row">{row.title}<span>{row.note}</span></th>{STUDENT_PLANS.map((plan, index) => <td key={plan.id}>{index >= STUDENT_PLANS.findIndex(item => item.id === row.from) ? <span className="ssc-table-check"><Check size={16} aria-hidden="true" /><span className="sr-only">Включено</span></span> : <><span className="ssc-table-dash" aria-hidden="true">—</span><span className="sr-only">Не включено</span></>}</td>)}</tr>)}</tbody></table><p>Кожен наступний тариф включає всі можливості попереднього. Детальні пояснення — в картці кожного рівня.</p></div>
    </details>

    <div className={`ssc-checkout ssc-checkout-${selected}`}>
      <div className="ssc-checkout-copy">
        <span className="ssc-kicker">НАСТУПНИЙ КРОК</span>
        <div className="ssc-checkout-title" aria-live="polite" aria-atomic="true"><span className="ssc-checkout-icon"><selectedView.Icon size={25} strokeWidth={1.6} aria-hidden="true" /></span><div><span>Твій вибір</span><h3>Xelay {selectedPlan.name}</h3></div><p>{birthdayGiftId && <del>{basePrice} грн</del>}<strong>{displayPrice}</strong><span>грн / місяць</span></p></div>
        {birthdayGiftId && <p className="ssc-discount-applied">Святкова знижка −{discountPercent}% на цю оплату. Остаточну суму підтвердить сторінка оплати.</p>}
        <p>Один календарний місяць. Продовження вручну. Строк нового доступу враховує вже оплачені періоди.</p>
        <p className="ssc-preserved"><ShieldCheck size={17} aria-hidden="true" /><span>Попередні оплати та подаровані можливості зберігаються. Додатковий доступ до викладання не змінює студентський тариф.</span></p>
      </div>
      <div className="ssc-checkout-action"><CheckoutLegalConsent checked={accepted} onChange={setAccepted} disabled={busy} /><button type="button" className="ssc-buy" onClick={() => void buy()} disabled={busy || loading || !!userId && (!accepted || !configuration.checkoutAvailable)}><span>{busy ? 'Готуємо безпечну оплату…' : !userId ? 'Увійти для оформлення' : !configuration.checkoutAvailable ? 'Оплата тимчасово недоступна' : configuration.mode === 'test' ? 'Перейти до тестової оплати' : `Оформити ${selectedPlan.name}`}</span>{busy ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}</button><p className="ssc-checkout-reassurance">Без автоматичного продовження</p>{error && <p className="ssc-error" role="alert">{error}</p>}</div>
    </div>

    <footer className="ssc-footnote"><ShieldCheck size={17} aria-hidden="true" /><p>ШІ працює лише з текстом, який ти обираєш і дозволяєш передати. Відповіді варто звіряти з джерелами. Коли ліміт використано, нові запити призупиняються до наступного оплаченого періоду без додаткових списань. Власні інструменти з позначкою збереження на пристрої не синхронізуються між пристроями.</p></footer>
  </section>
}
