import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, Bell, BookOpen, BriefcaseBusiness, Building2, Check, ChevronRight, Clock3, FileText, LayoutDashboard, LogOut, Menu, MessageCircle, Plus, Search, Send, ShieldCheck, Upload, Users, X } from 'lucide-react'
import { useOpportunities } from './OpportunitiesContext'
import { CareerModal, CompanyMark, EmptyState, Field, StatusPill, dateLabel } from './shared'
import { APPLICATION_LABELS } from '../../lib/opportunities/types'
import type { CareerApplication, Company, Opportunity, OrganizationKind } from '../../lib/opportunities/types'
import { newOrganization, newOrganizationOffer, organizationOfferIssues, organizationVerificationIssues } from '../../lib/opportunities/organizations'
import './OrganizationWorkspace.css'
import { OrganizationOverview } from './OrganizationOverview'

type BusinessView = 'overview' | 'offers' | 'applications' | 'messages' | 'profile'
const formatLabels = { remote: 'Онлайн', office: 'На місці', hybrid: 'Гібридно' }

export function OrganizationWorkspace({ onSignOut }: { onSignOut?: () => void } = {}) {
  const { data, execute, busy, toast } = useOpportunities()
  const [view, setView] = useState<BusinessView>('overview')
  const [selectedCompany, setSelectedCompany] = useState('')
  const [menu, setMenu] = useState(false)
  const [notifications, setNotifications] = useState(false)
  const [profile, setProfile] = useState<Company | null>(null)
  const [offer, setOffer] = useState<Opportunity | null>(null)
  const [conversationId, setConversationId] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const mainRef = useRef<HTMLElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const owned = data.companies.filter(c => data.actor.companyIds.includes(c.id) || c.ownerId === data.actor.id)
  const company = owned.find(c => c.id === selectedCompany) || owned[0]
  const school = company?.kind === 'school' || !company && data.actor.role === 'school'
  const kind: OrganizationKind = school ? 'school' : 'company'
  const offers = data.opportunities.filter(o => o.companyId === company?.id)
  const applications = data.applications.filter(a => a.companyId === company?.id)
  const newApplications = applications.filter(a => a.status === 'sent').length
  const conversation = applications.find(a => a.id === conversationId)
  const unread = data.notifications.filter(n => !n.read).length
  const verified = company?.status === 'approved'
  const navigation = [
    { id: 'overview', label: 'Головна', icon: LayoutDashboard },
    { id: 'offers', label: school ? 'Курси та програми' : 'Вакансії та стажування', icon: school ? BookOpen : BriefcaseBusiness },
    { id: 'applications', label: 'Заявки', icon: Users },
    { id: 'messages', label: 'Повідомлення', icon: MessageCircle },
    { id: 'profile', label: school ? 'Профіль школи' : 'Профіль компанії', icon: Building2 },
  ] as const
  function navigate(next: BusinessView) { setView(next); setMenu(false); setQuery(''); setStatus('all'); window.scrollTo(0, 0) }
  function createOffer() { if (company) setOffer(newOrganizationOffer(company)); else setProfile(newOrganization(data.actor.id, kind)) }
  useEffect(() => {
    if (!menu) return
    const main = mainRef.current; const oldOverflow = document.body.style.overflow
    main?.setAttribute('inert', ''); document.body.style.overflow = 'hidden'
    const focusFrame = requestAnimationFrame(() => sidebarRef.current?.querySelector<HTMLElement>('.org-close-menu')?.focus())
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(false) }
      if (event.key !== 'Tab') return
      const controls = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],select:not(:disabled)') || [])].filter(el => el.offsetParent !== null)
      const first = controls[0], last = controls[controls.length - 1]
      if (!sidebarRef.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { cancelAnimationFrame(focusFrame); main?.removeAttribute('inert'); document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', trap); menuRef.current?.focus() }
  }, [menu])
  const filteredOffers = offers.filter(o => (status === 'all' || o.status === status) && `${o.title} ${o.direction}`.toLowerCase().includes(query.toLowerCase()))
  const filteredApplications = applications.filter(a => (status === 'all' || a.status === status) && `${a.studentName} ${offers.find(o => o.id === a.opportunityId)?.title || ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className={`org-shell ${school ? 'org-school' : ''}`}>
    <header className="org-mobile-bar"><a href="#overview" onClick={e => { e.preventDefault(); navigate('overview') }} className="org-wordmark">Xelay<span>для {school ? 'шкіл' : 'бізнесу'}</span></a><button className="org-icon" ref={menuRef} aria-expanded={menu} aria-controls="org-sidebar" aria-label="Відкрити меню кабінету" onClick={() => setMenu(true)}><Menu /></button></header>
    <aside ref={sidebarRef} id="org-sidebar" className={`org-sidebar ${menu ? 'is-open' : ''}`} aria-label="Кабінет організації" onKeyDown={e => { if (e.key === 'Escape') setMenu(false) }}>
      <div className="org-sidebar-brand"><a className="org-wordmark" href="#overview" onClick={e => { e.preventDefault(); navigate('overview') }}>Xelay<span>для {school ? 'шкіл' : 'бізнесу'}</span></a><button className="org-close-menu org-icon" aria-label="Закрити меню" onClick={() => setMenu(false)}><X /></button></div>
      <div className="org-identity"><CompanyMark company={company} /><div><strong>{company?.name || 'Ваша організація'}</strong><span>{school ? 'Навчальна школа' : 'Компанія'}</span></div></div>
      {owned.length > 1 && <Field label="Організація"><select value={company?.id} onChange={e => { setSelectedCompany(e.target.value); setConversationId(''); navigate('overview') }}>{owned.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <span className="org-nav-label">ВАШ РОБОЧИЙ ПРОСТІР</span>
      <nav>{navigation.map(item => <button key={item.id} className={view === item.id ? 'is-active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span>{item.id === 'applications' && newApplications > 0 && <b>{newApplications}</b>}</button>)}</nav>{onSignOut && <button type="button" className="org-sign-out" onClick={onSignOut}><LogOut size={17} />Вийти з акаунта</button>}
      <div className="org-sidebar-bottom"><div className="org-trust"><ShieldCheck size={19} /><div><strong>{verified ? 'Організацію перевірено' : 'Публікація після перевірки'}</strong><span>{verified ? 'Довіра починається з прозорості' : 'Заповніть профіль і надішліть заявку'}</span></div></div><div className="org-person"><span>{data.actor.name.slice(0, 1)}</span><div><strong>{data.actor.name}</strong><small>Представник організації</small></div></div></div>
    </aside>
    {menu && <button className="org-menu-scrim" aria-label="Закрити меню кабінету" onClick={() => setMenu(false)} />}
    <main className="org-main" ref={mainRef}>
      <header className="org-topbar"><div><span>{school ? 'Простір школи' : 'Простір компанії'}</span><ChevronRight size={14} /><strong>{navigation.find(n => n.id === view)?.label}</strong></div><button className="org-icon" aria-label={`Сповіщення${unread ? `: ${unread} нових` : ''}`} onClick={() => setNotifications(true)}><Bell size={19} />{unread > 0 && <i />}</button></header>
      <div key={`${view}-${company?.id}`} className="org-page">
        {view === 'overview' && <>
          <OrganizationOverview school={school} company={company} offers={offers} applications={applications} onCreate={createOffer} onVerify={() => setProfile(company || newOrganization(data.actor.id, kind))} onNavigate={(target, filter) => { navigate(target); if (filter) setStatus(filter) }} />
          <div className="org-overview-grid"><section className="org-section"><SectionHeader title={school ? 'Ваші програми' : 'Ваші пропозиції'} action="Переглянути всі" onAction={() => navigate('offers')} />{offers.length ? offers.slice(0, 3).map(o => <OfferRow key={o.id} offer={o} onOpen={() => setOffer(o)} count={applications.filter(a => a.opportunityId === o.id).length} />) : <EmptyState title="Перший крок — ваша пропозиція" description="Збережіть чернетку зараз і надішліть її після перевірки профілю." action={<button className="org-button" onClick={createOffer}>Створити чернетку</button>} />}</section><section className="org-section"><SectionHeader title="Останні заявки" action="Усі заявки" onAction={() => navigate('applications')} />{applications.length ? [...applications].reverse().slice(0, 3).map(a => <ApplicationRow key={a.id} application={a} title={offers.find(o => o.id === a.opportunityId)?.title} onOpen={() => setConversationId(a.id)} />) : <div className="org-waiting"><div><MessageCircle size={28} /><span /></div><h3>Тут почнеться знайомство</h3><p>Коли студент відгукнеться, ви побачите заявку й зможете одразу відповісти.</p></div>}</section></div>
          <div className="org-bottom-note"><ShieldCheck size={17} /><p>Студенти самі обирають, які контакти та матеріали надіслати вам.</p><span>Xelay · простір можливостей</span></div>
        </>}
        {view === 'offers' && <><PageTitle eyebrow={school ? 'НАВЧАННЯ, ЯКЕ ВАРТЕ УВАГИ' : 'ЗРОБІТЬ ПЕРШИЙ КРОК'} title={school ? 'Курси та програми' : 'Вакансії та стажування'} description="Створюйте, редагуйте та стежте за статусом публікацій." action={<button className="org-button" onClick={createOffer}><Plus size={18} />{school ? 'Новий курс' : 'Нова пропозиція'}</button>} /><div className="org-toolbar"><SearchField value={query} onChange={setQuery} label="Пошук публікацій" /><Field label="Статус публікації"><select value={status} onChange={e => setStatus(e.target.value)}><option value="all">Усі статуси</option><option value="draft">Чернетки</option><option value="pending">На перевірці</option><option value="approved">Опубліковані</option><option value="changes">Потрібні зміни</option><option value="closed">Завершені</option></select></Field></div>{filteredOffers.length ? <div className="org-section">{filteredOffers.map(o => <OfferRow key={o.id} offer={o} onOpen={() => setOffer(o)} count={applications.filter(a => a.opportunityId === o.id).length} />)}</div> : <EmptyState title="Поки немає публікацій за цим запитом" description="Змініть фільтр або створіть першу пропозицію." />}</>}
        {(view === 'applications' || view === 'messages') && <><PageTitle eyebrow="ЗНАЙОМСТВА, ЩО МАЮТЬ ПРОДОВЖЕННЯ" title={view === 'messages' ? 'Повідомлення' : 'Заявки'} description={school ? 'Запити на навчання й усі домовленості зі студентами.' : 'Кожен кандидат, його резюме та ваша розмова — поруч.'} /><div className="org-toolbar"><SearchField value={query} onChange={setQuery} label="Пошук заявок" /><Field label="Етап заявки"><select value={status} onChange={e => setStatus(e.target.value)}><option value="all">Усі етапи</option>{Object.entries(APPLICATION_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field></div><div className="org-section">{filteredApplications.length ? filteredApplications.map(a => <ApplicationRow key={a.id} application={a} title={offers.find(o => o.id === a.opportunityId)?.title} onOpen={() => setConversationId(a.id)} />) : <EmptyState title="Нові знайомства попереду" description="Заявки та листування з’являться після першого відгуку." />}</div></>}
        {view === 'profile' && <><PageTitle eyebrow="ЗНАЙОМСТВО ПОЧИНАЄТЬСЯ З ДОВІРИ" title={school ? 'Ваша школа' : 'Ваша компанія'} description="Публічна сторінка та дані для перевірки представництва." /><VerificationBanner company={company} onEdit={() => setProfile(company || newOrganization(data.actor.id, kind))} />{company && <section className="org-profile-preview"><CompanyMark company={company} size={72} /><div><span className="org-eyebrow">{school ? 'НАВЧАЛЬНА ШКОЛА' : 'КОМПАНІЯ'}</span><h2>{company.name}</h2><p>{company.tagline}</p><p className="org-prose">{company.description || 'Додайте опис, щоб студенти краще познайомилися з вами.'}</p><div className="org-tags"><span>{company.city || 'Місто не вказано'}</span><span>{company.industry || 'Напрям не вказано'}</span></div>{company.website && /^https:\/\//.test(company.website) && <a className="org-link" href={company.website} target="_blank" rel="noopener noreferrer">Офіційний сайт<ArrowUpRight size={16} /></a>}</div></section>}</>}
      </div>
    </main>
    {profile && <OrganizationEditor key={profile.id} initial={profile} onClose={() => setProfile(null)} />}
    {offer && company && <OrganizationOfferEditor initial={offer} company={company} onClose={() => setOffer(null)} />}
    {conversation && <OrganizationConversation application={conversation} opportunity={offers.find(o => o.id === conversation.opportunityId)} onClose={() => setConversationId('')} />}
    {notifications && <CareerModal title="Сповіщення" onClose={() => setNotifications(false)}><div className="org-notifications">{data.notifications.length ? data.notifications.map(n => <article key={n.id}><div><strong>{n.title}</strong><p>{n.body}</p><small>{dateLabel(n.createdAt)}</small></div>{!n.read && <button className="org-icon" disabled={busy} aria-label={`Прочитано: ${n.title}`} onClick={async () => { if (await execute({ type: 'notification.read', id: n.id })) toast('Позначено прочитаним') }}><Check size={18} /></button>}</article>) : <EmptyState title="Усе актуальне" description="Оновлення перевірок і заявок з’являться тут." />}</div></CareerModal>}
  </div>
}

function SectionHeader({ title, action, onAction }: { title: string; action: string; onAction: () => void }) { return <header className="org-section-head"><h2>{title}</h2><button className="org-link" onClick={onAction}>{action}<ArrowUpRight size={15} /></button></header> }
function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <header className="org-page-title"><div><span className="org-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</header> }
function SearchField({ value, onChange, label }: { value: string; onChange: (s: string) => void; label: string }) { return <label className="org-search"><Search size={18} /><input aria-label={label} placeholder={label} value={value} onChange={e => onChange(e.target.value)} /></label> }
function OfferRow({ offer, onOpen, count }: { offer: Opportunity; onOpen: () => void; count: number }) { return <button className="org-offer-row" onClick={onOpen}><span className="org-offer-icon">{offer.kind === 'course' ? <BookOpen size={22} /> : <BriefcaseBusiness size={22} />}</span><div><strong>{offer.title}</strong><p>{formatLabels[offer.format]} · {offer.compensation || 'Оплату ще не вказано'}</p><span className="org-row-meta"><StatusPill status={offer.status} /><small>{count} заявок</small></span></div><ChevronRight size={19} /></button> }
function ApplicationRow({ application, title, onOpen }: { application: CareerApplication; title?: string; onOpen: () => void }) { const last = application.messages[application.messages.length - 1]; return <button className="org-application-row" onClick={onOpen}><span className="org-avatar">{application.studentName.split(' ').map(s => s[0]).slice(0, 2).join('')}</span><div><strong>{application.studentName}</strong><span>{title}</span><p>{last?.body || application.message || 'Нова заявка'}</p></div><span className="org-app-trailing"><StatusPill status={application.status} /><ChevronRight size={16} /></span></button> }

function VerificationBanner({ company, onEdit }: { company?: Company; onEdit: () => void }) {
  const pending = company?.status === 'pending', approved = company?.status === 'approved'
  return <section className={`org-verification ${approved ? 'is-verified' : ''}`}><span className="org-verification-icon">{pending ? <Clock3 size={23} /> : <ShieldCheck size={23} />}</span><div><h2>{approved ? 'Організацію перевірено' : pending ? 'Заявка вже у команди Xelay' : company?.status === 'changes' || company?.status === 'rejected' ? 'Потрібно уточнити дані' : 'Давайте підтвердимо вашу організацію'}</h2><p>{company?.reviewNote || (approved ? 'Профіль доступний студентам. Зміни даних організації потребують повторної перевірки.' : pending ? 'Поки триває перевірка, можна підготувати чернетки. Рішення з’явиться тут і в сповіщеннях.' : 'Додайте юридичні дані та підтвердження представництва. Після схвалення можна надсилати пропозиції до каталогу.')}</p></div><button className="org-button org-button-outline" onClick={onEdit}>{pending ? 'Переглянути заявку' : approved ? 'Редагувати профіль' : 'Заповнити профіль'}<ArrowRight size={16} /></button></section>
}

export function OrganizationEditor({ initial, onClose }: { initial: Company; onClose: () => void }) {
  const { execute, busy, toast, upload } = useOpportunities()
  const [draft, setDraft] = useState(initial)
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [attested, setAttested] = useState(false)
  const pending = initial.status === 'pending'
  const [submitForReview, setSubmitForReview] = useState(false)
  const set = <K extends keyof Company>(key: K, value: Company[K]) => setDraft(d => ({ ...d, [key]: value }))
  const school = draft.kind === 'school'
  async function save(event: FormEvent) {
    event.preventDefault(); setError('')
    if (pending || uploading) return
    if (submitForReview) {
      const issues = organizationVerificationIssues(draft)
      if (!attested) issues.push('Підтвердьте право представляти організацію.')
      if (issues.length) { setError(issues.join(' ')); return }
    }
    if (!await execute({ type: 'company.save', company: draft })) return
    if (submitForReview && !await execute({ type: 'company.submit', id: draft.id })) { setError('Чернетку збережено. Надсилання не завершилося — відкрийте профіль повторно.'); return }
    toast(submitForReview ? 'Заявку надіслано. Повідомимо про рішення.' : 'Профіль збережено як чернетку.'); onClose()
  }
  return <CareerModal title={pending ? 'Ваша заявка на перевірці' : school ? 'Знайомство зі школою' : 'Знайомство з компанією'} description="Профіль → підтвердження → перевірка командою Xelay" wide onClose={onClose}><form className="org-editor" onSubmit={save} onInvalidCapture={event => { const group = (event.target as HTMLElement).closest('[hidden]'); if (group) setStep(group.querySelector('[type=email]') ? 1 : 0) }}>
    <nav className="org-steps" aria-label="Кроки профілю">{['Публічний профіль', 'Підтвердження'].map((label, i) => <button type="button" key={label} className={step === i ? 'is-active' : ''} onClick={() => setStep(i)}><b>{i + 1}</b>{label}</button>)}</nav>
    <fieldset disabled={busy || pending || uploading}>
      <div hidden={step !== 0} className="org-form-grid"><Field label={school ? 'Назва школи *' : 'Назва компанії *'}><input required minLength={2} maxLength={160} value={draft.name} onChange={e => set('name', e.target.value)} /></Field><Field label="Коротко про вас"><input maxLength={240} value={draft.tagline} onChange={e => set('tagline', e.target.value)} placeholder="Одна фраза, яка вас описує" /></Field><Field label="Напрям"><input maxLength={120} value={draft.industry} onChange={e => set('industry', e.target.value)} placeholder={school ? 'Іноземні мови, аналітика…' : 'Фінанси, технології…'} /></Field><Field label="Місто"><input maxLength={120} value={draft.city} onChange={e => set('city', e.target.value)} /></Field><div className="org-span-2"><Field label="Про організацію"><textarea rows={4} maxLength={5000} value={draft.description} onChange={e => set('description', e.target.value)} placeholder="Чим займаєтеся та що пропонуєте студентам" /></Field></div><Field label="Офіційний сайт або сторінка"><input type="url" placeholder="https://" value={draft.website} onChange={e => set('website', e.target.value)} /></Field><Field label="Посилання на логотип"><input type="url" placeholder="https://…/logo.png" value={draft.logo} onChange={e => set('logo', e.target.value)} /></Field></div>
      <div hidden={step !== 1} className="org-form-grid"><div className="org-private-note org-span-2"><ShieldCheck size={19} /><p>Ці дані бачите лише ви та команда перевірки Xelay. Вони не потрапляють у публічний каталог.</p></div><Field label="Юридична назва / ФОП"><input maxLength={180} value={draft.legalName} onChange={e => set('legalName', e.target.value)} /></Field><Field label="ЄДРПОУ / РНОКПП ФОП" hint="8 або 10 цифр"><input inputMode="numeric" maxLength={10} value={draft.registrationCode} onChange={e => set('registrationCode', e.target.value)} /></Field><Field label="Ім’я представника *"><input required minLength={2} maxLength={120} value={draft.contactName} onChange={e => set('contactName', e.target.value)} /></Field><Field label="Робоча пошта *"><input required type="email" maxLength={254} value={draft.contactEmail} onChange={e => set('contactEmail', e.target.value)} /></Field><div className="org-span-2"><Field label="Ваша роль і підтвердження представництва" hint="Наприклад: керівник, посилання на офіційну сторінку команди або пояснення повноважень. Не додавайте паспортні дані."><textarea rows={3} maxLength={2000} value={draft.verificationNote || ''} onChange={e => set('verificationNote', e.target.value)} /></Field></div><div className="org-span-2"><label className="org-upload"><Upload size={22} /><span><strong>{draft.verificationFile?.name || 'Документ для підтвердження'}</strong><small>За потреби · PDF до 10 МБ · приватне вкладення</small></span><input type="file" accept="application/pdf,.pdf" aria-label="Документ для підтвердження" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setUploading(true); setError(''); try { set('verificationFile', await upload(file, 'company')) } catch (err) { setError(err instanceof Error ? err.message : 'Не вдалося додати файл.') } finally { setUploading(false); e.target.value = '' } }} /></label>{draft.verificationFile && <button type="button" className="org-link" onClick={() => set('verificationFile', null)}>Прибрати вкладення</button>}</div></div>
    </fieldset>
    {!pending && step === 1 && <label className="org-check"><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} /><span>Я маю право представляти цю організацію та підтверджую достовірність даних.</span></label>}
    {initial.status === 'approved' && <p className="org-inline-note">Після збереження профіль і пропозиції стануть недоступними новим відвідувачам до повторного схвалення. Раніше отримані заявки залишаться.</p>}
    {error && <p className="org-error" role="alert">{error}</p>}
    <footer className="org-form-footer"><button type="button" className="org-button org-button-outline" onClick={onClose}>Закрити</button>{!pending && <><button className="org-button org-button-outline" disabled={busy || uploading} onClick={() => setSubmitForReview(false)}>Зберегти чернетку</button>{step === 0 ? <button type="button" className="org-button" onClick={() => setStep(1)}>Підтвердження<ArrowRight size={16} /></button> : <button className="org-button" disabled={busy || uploading || !attested} onClick={() => setSubmitForReview(true)}><Send size={16} />{busy ? 'Зберігаємо…' : 'Надіслати на перевірку'}</button>}</>}</footer>
  </form></CareerModal>
}

function OrganizationOfferEditor({ initial, company, onClose }: { initial: Opportunity; company: Company; onClose: () => void }) {
  const { execute, busy, toast } = useOpportunities()
  const [draft, setDraft] = useState(initial)
  const [publish, setPublish] = useState(false)
  const [error, setError] = useState('')
  const school = company.kind === 'school'
  const locked = initial.status === 'pending' || initial.status === 'closed'
  const set = <K extends keyof Opportunity>(key: K, value: Opportunity[K]) => setDraft(d => ({ ...d, [key]: value }))
  async function save(event: FormEvent) {
    event.preventDefault(); setError('')
    if (publish) { const issues = organizationOfferIssues(draft); if (issues.length) { setError(issues.join(' ')); return } }
    if (!await execute({ type: 'opportunity.save', opportunity: draft })) return
    if (publish && !await execute({ type: 'opportunity.submit', id: draft.id })) { setError('Чернетку збережено. Відкрийте її повторно, щоб надіслати.'); return }
    toast(publish ? 'Пропозицію надіслано на перевірку.' : 'Чернетку збережено.'); onClose()
  }
  return <CareerModal title={school ? 'Курс або навчальна програма' : 'Вакансія або стажування'} description={locked ? 'Публікація доступна для перегляду.' : 'Зрозумілі умови допомагають студентам зробити свій вибір.'} wide onClose={onClose}><form className="org-editor" onSubmit={save}><fieldset disabled={busy || locked}><div className="org-form-grid">
    {!school && <Field label="Тип пропозиції"><select value={draft.kind} onChange={e => set('kind', e.target.value as 'job' | 'internship')}><option value="job">Вакансія</option><option value="internship">Стажування</option></select></Field>}
    <Field label="Назва *"><input required minLength={3} maxLength={180} value={draft.title} onChange={e => set('title', e.target.value)} placeholder={school ? 'Аналітика даних: від Excel до SQL' : 'Junior аналітик / аналітикиня'} /></Field>
    <div className="org-span-2"><Field label="Короткий опис *"><textarea required rows={2} maxLength={500} value={draft.summary} onChange={e => set('summary', e.target.value)} /></Field></div>
    <Field label={school ? 'Вартість навчання' : 'Оплата'}><input maxLength={120} value={draft.compensation} onChange={e => set('compensation', e.target.value)} placeholder={school ? '2 400 грн за весь курс / Безкоштовно' : '18 000–24 000 грн / Без оплати'} /></Field>
    <Field label={school ? 'Тривалість' : 'Зайнятість і графік'}><input maxLength={200} value={draft.employment} onChange={e => set('employment', e.target.value)} placeholder={school ? '6 тижнів, 12 занять' : '20 годин на тиждень'} /></Field>
    <Field label="Формат"><select value={draft.format} onChange={e => set('format', e.target.value as Opportunity['format'])}>{Object.entries(formatLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="Місто"><input maxLength={120} value={draft.city} onChange={e => set('city', e.target.value)} /></Field>
    <Field label="Напрям"><input maxLength={120} value={draft.direction} onChange={e => set('direction', e.target.value)} /></Field><Field label={school ? 'Початковий рівень' : 'Досвід'}><input maxLength={120} value={draft.experience} onChange={e => set('experience', e.target.value)} placeholder={school ? 'З нуля' : 'Без досвіду'} /></Field>
    <Field label="Прийом заявок до"><input type="date" value={draft.deadline} onChange={e => set('deadline', e.target.value)} /></Field><Field label={school ? 'Початок навчання' : 'Початок роботи'}><input type="date" value={draft.startsAt} onChange={e => set('startsAt', e.target.value)} /></Field>
    <div className="org-span-2"><Field label={school ? 'Про курс' : 'Завдання та опис роботи'}><textarea rows={4} maxLength={10000} value={draft.description} onChange={e => set('description', e.target.value)} /></Field></div>
    {school && <><div className="org-span-2"><Field label="Програма навчання"><textarea rows={4} maxLength={6000} value={draft.syllabus || ''} onChange={e => set('syllabus', e.target.value)} placeholder="Тема 1…\nТема 2…\nПрактичний проєкт…" /></Field></div><Field label="Викладачі"><textarea rows={3} maxLength={2000} value={draft.instructors || ''} onChange={e => set('instructors', e.target.value)} /></Field><Field label="Розклад і записи"><textarea rows={3} maxLength={2000} value={draft.schedule || ''} onChange={e => set('schedule', e.target.value)} /></Field></>}
    <Field label={school ? 'Кому підійде' : 'Що очікуєте від кандидата'}><textarea rows={3} maxLength={3000} value={draft.requirements} onChange={e => set('requirements', e.target.value)} /></Field><Field label={school ? 'Результат навчання' : 'Що пропонуєте'}><textarea rows={3} maxLength={3000} value={draft.benefits} onChange={e => set('benefits', e.target.value)} /></Field>
    {!school && <Field label="Оплачувана пропозиція"><select value={draft.paid} onChange={e => set('paid', e.target.value as Opportunity['paid'])}><option value="unspecified">Оберіть</option><option value="yes">Так</option><option value="no">Ні, без оплати</option></select></Field>}
  </div></fieldset>{company.status !== 'approved' && <p className="org-inline-note">Чернетку можна зберегти зараз. Надсилання до каталогу стане доступним після перевірки організації.</p>}{initial.status === 'approved' && <p className="org-inline-note">Редагування поверне публікацію на перевірку. Отримані заявки та переписка збережуться.</p>}{error && <p className="org-error" role="alert">{error}</p>}<footer className="org-form-footer"><button type="button" className="org-button org-button-outline" onClick={onClose}>Закрити</button>{!locked && <><button className="org-button org-button-outline" disabled={busy} onClick={() => setPublish(false)}>Зберегти чернетку</button><button className="org-button" disabled={busy || company.status !== 'approved'} onClick={() => setPublish(true)}><Send size={16} />На перевірку</button></>}{initial.status === 'approved' && <button type="button" className="org-button org-button-outline" disabled={busy} onClick={async () => { if (await execute({ type: 'opportunity.review', id: initial.id, expectedRevision: initial.revision, status: 'closed', note: '' })) { toast('Прийом заявок завершено.'); onClose() } }}>Завершити прийом</button>}</footer></form></CareerModal>
}

function OrganizationConversation({ application, opportunity, onClose }: { application: CareerApplication; opportunity?: Opportunity; onClose: () => void }) {
  const { execute, busy, fileUrl, toast } = useOpportunities()
  const [message, setMessage] = useState('')
  const [showResume, setShowResume] = useState(false)
  const { setConversation } = useOpportunities()
  useEffect(() => { setConversation(application.id); return () => setConversation(null) }, [application.id, setConversation])
  const closed = application.status === 'withdrawn' || application.status === 'completed'
  return <CareerModal title={application.studentName} description={opportunity?.title || 'Заявка'} wide onClose={onClose}><div className="org-conversation"><div className="org-conversation-top"><StatusPill status={application.status} /><span>{dateLabel(application.createdAt)}</span>{!closed && <Field label="Етап заявки"><select disabled={busy} value={application.status} onChange={e => void execute({ type: 'application.status', id: application.id, status: e.target.value as CareerApplication['status'] })}><option value="sent" disabled>Нова заявка</option><option value="reviewing">На розгляді</option><option value="invited">Запрошено</option><option value="completed">Завершено</option></select></Field>}</div><div className="org-application-details"><p>{application.message || 'Без супровідного повідомлення'}</p>{application.contact && <small>Контакт: {application.contact}</small>}{application.resumeShared !== false && <button className="org-link" onClick={() => setShowResume(!showResume)}><FileText size={16} />{showResume ? 'Згорнути резюме' : 'Переглянути резюме'}</button>}{showResume && <div className="org-resume"><h3>{application.resumeSnapshot.headline}</h3><p>{application.resumeSnapshot.about}</p><p>{application.resumeSnapshot.education}</p><div className="org-tags">{application.resumeSnapshot.skills.map(s => <span key={s}>{s}</span>)}</div><p>{application.resumeSnapshot.experience}</p><p>{application.resumeSnapshot.projects}</p>{application.resumeSnapshot.file && <button className="org-link" onClick={async () => { try { const url = await fileUrl(application.resumeSnapshot.file!); if (!/^(https:|blob:)/i.test(url)) throw new Error('Invalid file URL'); const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.click() } catch { toast('Не вдалося відкрити резюме. Спробуйте ще раз.') } }}>Відкрити PDF резюме<ArrowUpRight size={16} /></button>}</div>}</div><div className="org-thread" role="log" aria-label="Переписка щодо заявки">{application.messages.length ? application.messages.map(m => <article key={m.id} className={m.authorId === application.studentId ? 'from-student' : 'from-company'}><small>{m.authorName}</small><p>{m.body}</p><time>{new Date(m.createdAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</time></article>) : <p className="org-thread-start"><MessageCircle size={20} />Почніть розмову. Усі домовленості залишаться тут.</p>}</div>{closed ? <p className="org-inline-note">Заявку завершено. Історія листування збережена.</p> : <form className="org-message-composer" onSubmit={async e => { e.preventDefault(); if (message.trim() && await execute({ type: 'application.message', id: application.id, body: message })) setMessage('') }}><textarea aria-label="Повідомлення студенту" placeholder="Напишіть студенту…" rows={2} maxLength={3000} value={message} onChange={e => setMessage(e.target.value)} /><button className="org-button" aria-label="Надіслати повідомлення" disabled={busy || !message.trim()}><Send size={18} /></button></form>}</div></CareerModal>
}
