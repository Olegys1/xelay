import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, FileCheck2, GraduationCap, Layers3, Loader2, MessageSquareText, ShieldCheck, Sparkles } from 'lucide-react'
import { CheckoutLegalConsent } from '../LegalLinks'
import { createTeacherPlanCheckout, openHostedCheckout, type BillingConfiguration } from '../../lib/billing'
import { legalMerchant } from '../../lib/legal'
import { TEACHER_FREE_FEATURES, TEACHER_PLANS, type TeacherPlanId } from '../../lib/teacherPlans'
import './teacherSubscriptions.css'

function TeacherWorkflowScene() {
  return <div className="tsc-workflow-scene" data-teacher-motion data-inview="false" aria-hidden="true">
    <div className="tsc-scene-caption"><span className="tsc-scene-dot" />ОДИН РОБОЧИЙ ПРОЦЕС<span>ПРИКЛАД</span></div>
    <div className="tsc-workflow-grid" />
    <div className="tsc-workflow-orbit tsc-loop"><span /><span /><span /></div>
    <div className="tsc-workflow-paper tsc-loop"><span><BookOpen size={15} />Ваш матеріал</span><i /><i /><i /><div><span>Тема</span><strong>Наступна пара</strong></div></div>
    <div className="tsc-workflow-note tsc-loop"><span><Sparkles size={14} />Помічник</span><strong>Чернетка тесту</strong><div><i /><span>Два варіанти</span><Check size={12} /></div><div><i /><span>Ключі й пояснення</span><Check size={12} /></div></div>
    <div className="tsc-workflow-approval tsc-loop"><span><CheckCheck size={16} /></span><div>Останній крок<strong>Ваше рішення</strong></div></div>
    <div className="tsc-workflow-bottom"><span>Матеріал</span><i /><span>Чернетка</span><i /><span>Ваша перевірка</span></div>
  </div>
}

function TeacherPlanScene({ plan }: { plan: TeacherPlanId }) {
  return <span className="tsc-plan-scene" data-teacher-motion data-inview="false" data-scene={plan} aria-hidden="true">
    {plan === 'teacher_start' ? <>
      <span className="tsc-start-sheet tsc-start-sheet-back tsc-loop"><span>Варіант 02</span><i /><i /><i /></span>
      <span className="tsc-start-sheet tsc-start-sheet-front tsc-loop"><span><Layers3 size={11} />Варіант 01</span><i /><i /><span className="tsc-start-options"><i /><i /><i /></span></span>
      <span className="tsc-scene-tag tsc-loop"><Check size={11} />Є з чого почати</span>
    </> : plan === 'teacher_plus' ? <>
      <span className="tsc-rubric"><span>Ваші критерії<FileCheck2 size={12} /></span>{[0, 1, 2].map(item => <span className="tsc-rubric-row" key={item}><i /><span className="tsc-loop" /><span className="tsc-rubric-check tsc-loop"><Check size={10} /></span></span>)}</span>
      <span className="tsc-feedback tsc-loop"><MessageSquareText size={13} /><span>Зрозумілий фідбек<strong>Ви перевіряєте й підтверджуєте</strong></span></span>
    </> : <>
      <span className="tsc-groups"><span><i /><span>Група А</span><span className="tsc-group-line tsc-loop" /></span><span><i /><span>Група Б</span><span className="tsc-group-line tsc-loop" /></span><span><i /><span>Група В</span><span className="tsc-group-line tsc-loop" /></span></span>
      <span className="tsc-practice tsc-loop"><Sparkles size={12} /><span>Складна тема<strong>Додаткова практика</strong></span><ArrowRight size={12} /></span>
    </>}
  </span>
}

export function TeacherSubscriptionCatalogue({ configuration, userId, loading, onLogin, pageHeading = true }: {
  configuration: BillingConfiguration; userId?: string; loading: boolean; onLogin: () => void; pageHeading?: boolean
}) {
  const [selected, setSelected] = useState<TeacherPlanId>('teacher_plus')
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const owner = useRef(userId), alive = useRef(true), lock = useRef(false)
  const stage = useRef<HTMLElement>(null)
  owner.current = userId
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setAccepted(false); setError('') }, [userId])
  useEffect(() => {
    const section = stage.current
    if (!section) return
    const scenes = Array.from(section.querySelectorAll<HTMLElement>('[data-teacher-motion]'))
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = () => { section.dataset.motionEnabled = document.visibilityState !== 'hidden' && !preference?.matches ? 'true' : 'false' }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) (entry.target as HTMLElement).dataset.inview = entry.isIntersecting ? 'true' : 'false'
    }, { threshold: 0.05 })
    for (const scene of scenes) { if (observer) observer.observe(scene); else scene.dataset.inview = 'true' }
    update(); document.addEventListener('visibilitychange', update); preference?.addEventListener?.('change', update)
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); preference?.removeEventListener?.('change', update); section.dataset.motionEnabled = 'false' }
  }, [])
  const plan = TEACHER_PLANS.find(item => item.id === selected)!
  const price = configuration.teacherPlanPrices?.[selected] ?? plan.price
  const wrongAudience = Boolean(userId && configuration.subscriptionAudience === 'student')
  const available = configuration.teacherPlansAvailable === true && configuration.checkoutAvailable && legalMerchant.ready && !wrongAudience
  const Heading = pageHeading ? 'h1' : 'h2'

  async function buy() {
    if (!userId) { onLogin(); return }
    if (!available || !accepted || loading || lock.current) return
    const purchaser = userId
    lock.current = true; setBusy(true); setError('')
    try {
      if (configuration.mode === 'test' && !window.confirm('Це тестова оплата без реального списання та без активації робочого доступу. Продовжити?')) return
      const response = await createTeacherPlanCheckout(selected)
      if (alive.current && owner.current === purchaser) openHostedCheckout(response.checkout)
    } catch (reason) {
      if (alive.current && owner.current === purchaser) setError(reason instanceof Error ? reason.message : 'Не вдалося підготувати оплату. Спробуйте ще раз.')
    } finally { lock.current = false; if (alive.current && owner.current === purchaser) setBusy(false) }
  }

  return <section ref={stage} className="tsc" data-motion-enabled="false" aria-label="Тарифи для викладачів">
    <header className="tsc-intro"><div className="tsc-intro-copy"><span className="tsc-eyebrow"><GraduationCap size={16} />XELAY · ДЛЯ ВИКЛАДАЧІВ</span><Heading>Залиште час<br />для <em>головного.</em></Heading><p>Готувати цікаві пари. Давати влучний фідбек. Бачити, де потрібне пояснення. Рутину допоможе зібрати один помічник у вашому кабінеті.</p><div className="tsc-intro-note"><span><ShieldCheck size={17} /></span><p>Помічник пропонує.<strong>Ви вирішуєте, що використати.</strong></p></div></div><TeacherWorkflowScene /></header>
    <div className="tsc-section-heading"><div><span className="tsc-eyebrow">ОБЕРІТЬ СВІЙ МАСШТАБ</span><h2>Від наступної пари<br className="tsc-mobile-break" /> до цілого потоку.</h2></div><p>Три рівні допомоги.<br />Основний кабінет — безкоштовний.</p></div>
    <div className="tsc-plans" role="group" aria-label="Оберіть тариф викладача">
      {TEACHER_PLANS.map(item => {
        const Icon = item.id === 'teacher_start' ? Layers3 : item.id === 'teacher_plus' ? FileCheck2 : Sparkles
        const current = configuration.teacherPlan?.id === item.id
        return <button key={item.id} type="button" className={`tsc-plan${selected === item.id ? ' is-selected' : ''}`} aria-pressed={selected === item.id} disabled={busy} onClick={() => { setSelected(item.id); setAccepted(false); setError('') }}>
          <span className="tsc-plan-top"><span>{item.number} / {item.name}</span><Icon size={22} /></span>
          <TeacherPlanScene plan={item.id} />
          <span className="tsc-price">{configuration.teacherPlanPrices?.[item.id] ?? item.price}<small>грн / місяць</small></span>
          <strong className="tsc-promise">{item.promise}</strong><span className="tsc-description">{item.description}</span>
          <span className="tsc-feature-list">{item.features.map(feature => <span key={feature}><Check size={15} /><span>{feature}</span></span>)}</span>
          <span className="tsc-file-note">Загальний обсяг поки не обмежуємо<br />PDF і текст — до {item.fileLimitMb} МБ</span>
          <span className="tsc-select">{current ? 'Ваш активний тариф' : selected === item.id ? 'Обрано' : `Обрати ${item.name}`}<span>{selected === item.id ? <CheckCheck size={18} /> : <ArrowRight size={18} />}</span></span>
        </button>
      })}
    </div>
    <div className="tsc-checkout" aria-label={`Оформлення тарифу ${plan.name}`}><div className="tsc-checkout-copy"><span className="tsc-eyebrow">ВАШ ВИБІР</span><h2>{plan.name}<span>{new Intl.NumberFormat('uk-UA').format(price)} грн <small>/ місяць</small></span></h2><p>Один оплачений місяць. Без автоматичного продовження та прихованих списань. ШІ має ліміт використання на оплачений період.</p>{configuration.teacherPlan && <p className="tsc-active">Тариф активний до {new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' }).format(new Date(configuration.teacherPlan.expiresAt))}. Оплачене й подароване раніше не зникає.</p>}</div><div className="tsc-checkout-action"><CheckoutLegalConsent checked={accepted} onChange={setAccepted} /><button type="button" className="tsc-primary" onClick={() => void buy()} disabled={Boolean(userId) && (loading || busy || !accepted || !available)}>{busy ? <Loader2 size={18} className="tsc-spin" /> : <ArrowRight size={18} />}{!userId ? 'Увійти й обрати тариф' : busy ? 'Готуємо оплату…' : `Обрати ${plan.name}`}</button>{wrongAudience ? <p role="status">Ці тарифи для акаунтів, зареєстрованих як викладач. Ваш студентський тариф залишається окремим.</p> : !available ? <p role="status">Оформлення ще недоступне. Чинні можливості кабінету залишаються з вами.</p> : null}{error && <p role="alert" className="tsc-error">{error}</p>}</div></div>
    <details className="tsc-free"><summary><span><ShieldCheck size={18} />Основний кабінет залишається безкоштовним</span><ChevronDown size={17} /></summary><div>{TEACHER_FREE_FEATURES.map(feature => <p key={feature}><Check size={15} />{feature}</p>)}</div><p>Тарифи додають допомогу ШІ та зручність роботи. Вони не обмежують наявні інструменти, доступ до ваших матеріалів або безпеку тестів.</p></details>
    <p className="tsc-privacy"><span>Інші підтримувані формати — до 50 МБ на файл. Загальний обсяг бібліотеки поки не обмежуємо.</span></p><p className="tsc-privacy"><ShieldCheck size={16} />Нічого не публікується й не потрапляє в журнал автоматично. Перевірте зміст, ключі та запропоновані бали перед використанням.</p>
  </section>
}
