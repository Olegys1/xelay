import type { CSSProperties } from 'react'
import { ArrowRight, ArrowUpRight, BookOpen, BriefcaseBusiness, FileText, Plus, ShieldCheck, Users } from 'lucide-react'
import type { CareerApplication, Company, Opportunity } from '../../lib/opportunities/types'
import './OrganizationOverview.css'
import { OrganizationSculpture } from './OrganizationSculpture'

type OverviewDestination = 'offers' | 'applications' | 'messages' | 'profile'
type OverviewProps = {
  school: boolean
  company?: Company
  offers: Opportunity[]
  applications: CareerApplication[]
  onCreate: () => void
  onVerify: () => void
  onNavigate: (view: OverviewDestination, status?: string) => void
}

export function OrganizationOverview({ school, company, offers, applications, onCreate, onVerify, onNavigate }: OverviewProps) {
  const published = offers.filter(offer => offer.status === 'approved').length
  const pending = offers.filter(offer => offer.status === 'pending').length
  const drafts = offers.filter(offer => offer.status === 'draft').length
  const changes = offers.filter(offer => offer.status === 'changes').length
  const newApplications = applications.filter(application => application.status === 'sent').length
  const invited = applications.filter(application => application.status === 'invited').length
  const verified = company?.status === 'approved'
  const inReview = company?.status === 'pending'
  const next = !verified ? {
    icon: ShieldCheck,
    label: inReview ? 'Ваш профіль на перевірці' : 'Почнемо з довіри',
    description: inReview ? 'Тим часом підготуйте першу публікацію.' : 'Підтвердьте організацію, щоб публікувати можливості.',
    action: inReview ? 'Створити чернетку' : 'Підтвердити організацію',
    onClick: inReview ? onCreate : onVerify,
  } : newApplications > 0 ? {
    icon: Users, label: 'На вас чекають нові знайомства',
    description: `Нових заявок: ${newApplications}. Познайомтеся зі студентами та оберіть наступний крок.`,
    action: 'Переглянути заявки', onClick: () => onNavigate('applications', 'sent'),
  } : changes > 0 ? {
    icon: FileText, label: 'Ще трохи — і можна публікувати',
    description: `Пропозицій із зауваженнями модератора: ${changes}.`,
    action: 'Переглянути зауваження', onClick: () => onNavigate('offers', 'changes'),
  } : drafts > 0 ? {
    icon: FileText, label: 'Ваші ідеї вже чекають на старт',
    description: `Незавершених чернеток: ${drafts}. Поверніться, коли зручно.`,
    action: 'До чернеток', onClick: () => onNavigate('offers', 'draft'),
  } : {
    icon: school ? BookOpen : BriefcaseBusiness,
    label: pending ? 'Публікації на перевірці' : 'Простір для вашої наступної ідеї',
    description: pending ? `На розгляді команди Xelay: ${pending}. Рішення буде у сповіщеннях.` : school ? 'Додайте програму, на яку ви самі хотіли б записатися.' : 'Розкажіть, кого ви шукаєте і що можете запропонувати.',
    action: pending ? 'Переглянути статус' : school ? 'Додати курс' : 'Створити вакансію',
    onClick: pending ? () => onNavigate('offers', 'pending') : onCreate,
  }
  const metrics = [
    { value: published, label: school ? 'Схвалені курси' : 'Схвалені публікації', target: 'offers' as const, status: 'approved', note: 'Пройшли перевірку Xelay' },
    { value: newApplications, label: 'Нові заявки', target: 'applications' as const, status: 'sent', note: 'На першому етапі знайомства' },
    { value: invited, label: school ? 'Запрошення на навчання' : 'Запрошення на співбесіду', target: 'applications' as const, status: 'invited', note: 'Наступний крок знайомства' },
    { value: drafts, label: 'Ваші чернетки', target: 'offers' as const, status: 'draft', note: 'Збережені до слушного моменту' },
  ]

  return <>
    <section className="org-editorial-hero" aria-labelledby="organization-overview-title">
      <div className="org-editorial-copy">
        <div className="org-editorial-eyebrow"><span className="org-editorial-line" /><span>{school ? 'НАВЧАЙТЕ. НАДИХАЙТЕ. ЗРОСТАЙТЕ.' : 'ЛЮДИ СТВОРЮЮТЬ МОЖЛИВОСТІ.'}</span></div>
        <h1 id="organization-overview-title">{school ? <>Ваші знання.<br /><em>Їхній новий початок.</em></> : <>Ваша наступна<br /><em>сильна команда.</em></>}</h1>
        <p>{school ? 'Знайдіть тих, хто хоче більшого. Від першого інтересу до навчання — разом із Xelay.' : 'Знайомтеся зі студентами, з якими хочеться будувати майбутнє. Перша розмова починається тут.'}</p>
        <div className="org-editorial-actions"><button type="button" className="org-button org-create-button" onClick={onCreate}><Plus size={17} />{school ? 'Створити курс' : 'Створити можливість'}<ArrowUpRight size={17} /></button><button type="button" className="org-editorial-secondary" onClick={() => onNavigate('offers')}>{school ? 'Мої програми' : 'Мої публікації'}<ArrowRight size={16} /></button></div>
      </div>
      <OrganizationSculpture school={school} />
    </section>

    <section className="org-next-step" aria-label="Ваш наступний крок">
      <div className="org-next-icon"><next.icon size={21} strokeWidth={1.6} /><i /></div>
      <div><span>ВАШ НАСТУПНИЙ КРОК</span><h2>{next.label}</h2><p>{next.description}</p></div>
      <button type="button" onClick={next.onClick}>{next.action}<ArrowUpRight size={18} /></button>
    </section>

    <div className="org-summary-strip" aria-label="Стан вашої організації">{metrics.map((metric, index) => <button type="button" key={metric.label} style={{ '--org-delay': `${index * 65}ms` } as CSSProperties} onClick={() => onNavigate(metric.target, metric.status)}>
      <span className="org-summary-label">{metric.label}<ArrowUpRight size={15} /></span><strong>{metric.value.toString().padStart(2, '0')}</strong><small>{metric.note}</small>
    </button>)}</div>
  </>
}
