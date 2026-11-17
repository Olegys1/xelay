import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, Layers3, Leaf, MoveUpRight, ShieldCheck, Sparkles, Stars, Users, X } from 'lucide-react'
import { STUDENT_PLANS, calculateStudentPlanEconomics, type StudentPlanId } from '../../lib/studentPlans'
import { createSeminarActivityFixture } from '../../lib/seminarActivityFixture'
import {StudentPlanCards} from './StudentPlanCatalog'
export {StudentPlanCards} from './StudentPlanCatalog'
import {StudentLearningGuide} from './StudentLearningGuide'
import './student-workspace-preview.css'

const StudyWorkbench = lazy(() => import('./StudyWorkbench'))
const StudentDeskTools = lazy(() => import('./StudentDeskTools'))
const StudentPracticeLab = lazy(() => import('./StudentPracticeLab'))
const MaxLearningStudio = lazy(() => import('./MaxLearningStudio'))
const StudentPurchaseCelebration = lazy(() => import('./StudentPurchaseCelebration'))
const SeminarActivityPanel = lazy(() => import('../SeminarActivityPanel').then(module => ({default:module.SeminarActivityPanel})))

type Page = 'workspace' | 'plans' | 'seminars' | 'tools' | 'practice' | 'session'
const pages: { id: Page; label: string; icon: typeof BookOpen }[] = [
  { id: 'workspace', label: 'Мій простір', icon: BookOpen },
  { id: 'tools', label: 'Мої інструменти', icon: Leaf },
  { id: 'practice', label: 'Моя практика', icon: Layers3 },
  { id: 'session', label: 'Студія Макс', icon: Stars },
  { id: 'plans', label: 'Тарифи', icon: Sparkles },
  { id: 'seminars', label: 'Семінари', icon: Users },
]
export function StudentWorkspacePreview({ seminarPanel }: { seminarPanel?: React.ReactNode }) {
  const startAtAssistant=typeof window!=='undefined'&&new URLSearchParams(window.location.search).get('max')==='assistant'
  const [page, setPage] = useState<Page>(startAtAssistant?'session':'plans')
  const [plan, setPlan] = useState<StudentPlanId>(startAtAssistant?'max':'plus')
  const [economics, setEconomics] = useState(false)
  const [animationPlan,setAnimationPlan]=useState<StudentPlanId|null>(null)
  const dialog = useRef<HTMLElement>(null)
  const economicsOpener = useRef<HTMLElement | null>(null)
  const [fixture] = useState(() => createSeminarActivityFixture())
  useEffect(() => { document.title = 'Xelay · Твій навчальний простір' }, [])
  useEffect(() => {
    if (!economics) return
    const previous = economicsOpener.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEconomics(false)
      if (event.key === 'Tab') {
        const focusable = [...dialog.current?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]') || []].filter(el => !el.hasAttribute('disabled'))
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handler)
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = previousOverflow; previous?.focus() }
  }, [economics])
  function selectPlan(value: StudentPlanId) { setPlan(value); setPage(value === 'max' ? 'session' : value === 'plus' ? 'practice' : 'tools'); window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }
  return <div className="swp-root">
    <div inert={economics||!!animationPlan}><div className="swp-preview-label"><span />Локальний перегляд · власні матеріали та навчальні приклади · без змін робочої бази</div>
    <header className="swp-header"><a className="swp-logo" href="#" onClick={event => { event.preventDefault(); setPage('workspace') }}>Xelay<span>K N U</span></a><nav aria-label="Навчальний простір">{pages.map(item => <button key={item.id} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'active' : ''}><item.icon size={16} />{item.label}</button>)}</nav><div className="swp-profile"><span className="swp-profile-label">Студентський простір</span><span className="swp-avatar">О</span></div></header>
    <main className="swp-main" key={page}>{['workspace','tools','practice','plans'].includes(page)&&<StudentLearningGuide guideId={page==='tools'?'tools':page==='practice'?'practice':page==='plans'?'plans':'workspace'}/>}<Suspense fallback={<div className="swp-loading" role="status"><span/>Відкриваємо простір…</div>}>
      {page === 'plans' && <StudentPlanCards selected={plan} onSelect={selectPlan} onPreviewAnimation={setAnimationPlan} />}
      {['workspace', 'tools', 'practice', 'session'].includes(page) && <><div className="swp-workspace-plan"><span><Sparkles size={15} />Твій режим</span><select aria-label="Тариф для локального перегляду" value={plan} onChange={e => setPlan(e.target.value as StudentPlanId)}>{STUDENT_PLANS.map(p => <option key={p.id} value={p.id}>{p.name} · {p.monthlyPriceUah} ₴</option>)}</select><button onClick={() => setPage('plans')}>Порівняти тарифи <MoveUpRight size={13} /></button></div>{page === 'workspace' && <StudyWorkbench plan={plan} />}{page === 'tools' && <StudentDeskTools />}{page === 'practice' && <StudentPracticeLab plan={plan} />}{page === 'session' && <MaxLearningStudio plan={plan} localTutor initialTab={startAtAssistant?'assistant':'overview'} />}</>}
      {page === 'seminars' && <section className="swp-seminars"><span className="swp-kicker"><Users size={15} /> Навчальна група · ЕК-демо</span><h1>Кожен внесок<br />має значення.</h1><p className="swp-seminar-description">Стежте за записами на участь у семінарах разом.<br />Це статистика записів, а не підтверджених виступів чи оцінок.</p><div className="swp-seminar-shell"><div className="swp-seminar-title"><BookOpen size={20} /><h2>Семінари</h2><span>Доступно всій групі</span></div>{seminarPanel || <SeminarActivityPanel groupId={fixture.groupId} currentUserId="demo-student-1" fixture={fixture} defaultOpen />}</div></section>}
    </Suspense></main>
    <footer className="swp-footer"><span><ShieldCheck size={15} />Твої матеріали. Твій темп.</span><button onClick={event => { economicsOpener.current = event.currentTarget; setEconomics(true) }}>Розрахунок для обговорення <ArrowRight size={13} /></button></footer></div>
    {animationPlan&&<Suspense fallback={<div className="swp-loading" role="status">Відкриваємо анімацію…<button onClick={()=>setAnimationPlan(null)}>Закрити</button></div>}><StudentPurchaseCelebration key={animationPlan} plan={animationPlan} onClose={()=>setAnimationPlan(null)} onContinue={()=>{selectPlan(animationPlan);setAnimationPlan(null)}}/></Suspense>}
    {economics && <div className="swp-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setEconomics(false) }}><section ref={dialog} className="swp-economics" role="dialog" aria-modal="true" aria-label="Економіка концепції"><button className="swp-close" aria-label="Закрити розрахунок" autoFocus onClick={() => setEconomics(false)}><X size={21} /></button><span className="swp-kicker">Робоча гіпотеза</span><h2>Зростати без збитків<br />від кожного запиту.</h2><p>Початковий розрахунок, а не обіцянка прибутку. Потрібен пілот із реальним використанням.</p><div className="swp-economics-scroll"><table><thead><tr><th>На місяць</th><th>Старт</th><th>Плюс</th><th>Макс</th></tr></thead><tbody>{[["Ціна","priceUah"],["Резерв витрат на ШІ","aiUah"],["Комісія 2%","paymentFeeUah"],["Інші змінні витрати + резерв","otherVariableUah"],["До постійних витрат і податків","contributionUah"]].map(([label, field]) => <tr key={field}><th>{label}</th>{STUDENT_PLANS.map(p => <td key={p.id}>{Number(calculateStudentPlanEconomics(p.id)[field as keyof ReturnType<typeof calculateStudentPlanEconomics>]).toLocaleString("uk-UA", {maximumFractionDigits:2})} ₴</td>)}</tr>)}</tbody></table></div><p className="swp-economics-assumptions">Розрахунок використовує окремі внутрішні ліміти тарифів. Фактична комісія залежить від договору. Податки, робота команди й постійна інфраструктура не відняті. Витрати на сильні моделі, зображення, голос і повторні запити мають входити у спільний ліміт.</p><div className="swp-economics-note"><CheckCheck size={20} /><span>Для наступного етапу: перевірити звичайний і піковий тиждень, погодити зрозумілі ліміти дій та умови для подарованих підписок.</span></div><button className="swp-plan-choose" onClick={() => setEconomics(false)}>Повернутися до перегляду<ArrowRight size={16} /></button></section></div>}
  </div>
}
