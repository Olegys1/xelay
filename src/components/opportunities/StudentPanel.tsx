import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowDownToLine, ArrowRight, BadgeCheck, Bell, Bookmark, Check, CheckCheck, ChevronDown,
  Clock3, Copy, ExternalLink, Eye, EyeOff, FileText, Flag, Globe2, GraduationCap, Heart,
  MapPin, MessageCircle, Search, Send, ShieldCheck, SlidersHorizontal, Sparkles, Upload, X,
} from 'lucide-react'
import { useOpportunities } from './OpportunitiesContext'
import { CareerModal, CompanyMark, EmptyState, Field, StatusPill, dateLabel } from './shared'
import { APPLICATION_LABELS, KIND_LABELS, emptyResume } from '../../lib/opportunities/types'
import type { ApplicationStatus, CareerApplication, CareerFile, CareerResume, Company, Opportunity, OpportunityKind } from '../../lib/opportunities/types'
import './StudentPanel.css'

const FORMAT_LABELS = { remote: 'Дистанційно', office: 'На місці', hybrid: 'Гібридно' }
const KIND_KEYS = Object.keys(KIND_LABELS) as OpportunityKind[]
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date())
const expired = (item: Opportunity) => item.status === 'closed' || Boolean(item.deadline && item.deadline < today())
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} КБ` : `${(size / (1024 * 1024)).toFixed(1)} МБ`

function safeLink(value: string, allowBlob = false) {
  try {
    const url = new URL(value)
    return (!url.username && !url.password && (url.protocol === 'https:' || (allowBlob && url.protocol === 'blob:'))) ? url.href : ''
  } catch { return '' }
}

function ReadSection({ title, children }: { title: string; children: ReactNode }) {
  if (!children) return null
  return <section className="op-student-read-section"><h3>{title}</h3><div>{children}</div></section>
}

function CareerFileButton({ file }: { file: CareerFile }) {
  const { fileUrl, toast } = useOpportunities()
  const [loading, setLoading] = useState(false)
  const open = async () => {
    setLoading(true)
    try {
      const url = safeLink(await fileUrl(file), true)
      if (!url) throw new Error('Файл поки недоступний.')
      const anchor = document.createElement('a')
      anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.download = file.name
      anchor.click()
    } catch (error) { toast(error instanceof Error ? error.message : 'Не вдалося відкрити файл.') }
    finally { setLoading(false) }
  }
  return <button type="button" className="op-student-file" onClick={() => void open()} disabled={loading}><FileText size={20} /><span><strong>{file.name}</strong><small>PDF · {sizeLabel(file.size)}</small></span><ArrowDownToLine size={17} /><span className="op-sr-only">{loading ? 'Відкриваємо файл' : 'Відкрити файл'}</span></button>
}

function ResumeSnapshot({ resume, showContact = true }: { resume: CareerResume; showContact?: boolean }) {
  return <div className="op-student-resume-preview">
    <header><span className="op-eyebrow">Кар’єрне резюме</span><h3>{resume.fullName}</h3>{resume.headline && <p>{resume.headline}</p>}</header>
    <div className="op-student-meta">{resume.city && <span><MapPin size={15} />{resume.city}</span>}{resume.format && <span><Globe2 size={15} />{resume.format}</span>}{resume.availability && <span><Clock3 size={15} />{resume.availability}</span>}</div>
    {resume.seeking.length > 0 && <div className="op-student-tags">{resume.seeking.map(kind => <span key={kind}>{KIND_LABELS[kind]}</span>)}</div>}
    <ReadSection title="Про мене">{resume.about}</ReadSection>
    <ReadSection title="Освіта">{resume.education}</ReadSection>
    {resume.skills.length > 0 && <ReadSection title="Навички"><div className="op-student-tags">{resume.skills.map(skill => <span key={skill}>{skill}</span>)}</div></ReadSection>}
    <ReadSection title="Мови">{resume.languages}</ReadSection>
    <ReadSection title="Досвід">{resume.experience}</ReadSection>
    <ReadSection title="Проєкти та досягнення">{resume.projects}</ReadSection>
    <ReadSection title="Побажання щодо оплати">{resume.salary}</ReadSection>
    {safeLink(resume.portfolioUrl) && <ReadSection title="Портфоліо"><a href={safeLink(resume.portfolioUrl)} target="_blank" rel="noopener noreferrer" className="op-student-inline-link">Відкрити портфоліо <ExternalLink size={15} /></a></ReadSection>}
    {showContact && <ReadSection title="Контакт для відповіді">{resume.contact}</ReadSection>}
    {showContact && resume.file && <ReadSection title="Прикріплене резюме"><CareerFileButton file={resume.file} /></ReadSection>}
  </div>
}

function OpportunityCard({ item, company, campaignId, onOpen }: { item: Opportunity; company?: Company; campaignId?: string; onOpen: () => void }) {
  const { data, busy, execute } = useOpportunities()
  const ref = useRef<HTMLElement>(null)
  const recorded = useRef<string | null>(null)
  const saved = data.savedIds.includes(item.id)
  const isExpired = expired(item)
  const studentActions = data.actor.role === 'student'
  useEffect(() => {
    if (!studentActions || !campaignId || !ref.current || recorded.current === campaignId || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new IntersectionObserver(entries => {
      const visible = entries[0]?.isIntersecting && entries[0].intersectionRatio >= 0.5 && document.visibilityState === 'visible'
      if (timer) { clearTimeout(timer); timer = null }
      if (visible) timer = setTimeout(() => {
        if (document.visibilityState !== 'visible') return
        void execute({ type: 'event.record', campaignId, event: 'impression', placement: 'catalog' }).then(ok => { if (ok) recorded.current = campaignId })
      }, 1000)
    }, { threshold: [0, 0.5, 1] })
    observer.observe(ref.current)
    return () => { observer.disconnect(); if (timer) clearTimeout(timer) }
  }, [campaignId, execute, studentActions])
  const toggleSaved = async () => {
    if (await execute({ type: 'saved.toggle', id: item.id }) && campaignId && !saved) await execute({ type: 'event.record', campaignId, event: 'save', placement: 'catalog' })
  }
  return <article ref={ref} className={`op-student-card ${campaignId ? 'op-student-card-promoted' : ''} ${isExpired ? 'op-student-card-expired' : ''}`}>
    <div className="op-student-card-top"><div className="op-student-company-row"><CompanyMark company={company} /><div><strong>{company?.name || 'Компанія'}</strong><span>{company?.status === 'approved' && <BadgeCheck size={13} />} {company?.industry || 'Можливості для студентів'}</span></div></div>{studentActions && <button type="button" className={`op-icon-button ${saved ? 'op-student-is-saved' : ''}`} aria-label={saved ? 'Прибрати зі збереженого' : 'Зберегти можливість'} aria-pressed={saved} onClick={() => void toggleSaved()} disabled={busy}><Bookmark size={19} fill={saved ? 'currentColor' : 'none'} /></button>}</div>
    <div className="op-student-card-labels"><span className="op-student-kind">{KIND_LABELS[item.kind]}</span>{campaignId && <span className="op-student-ad-label">Реклама</span>}{isExpired && <span className="op-student-ended-label">Завершено</span>}</div>
    <button type="button" className="op-student-card-title" onClick={onOpen}><h3>{item.title}</h3></button>
    <p className="op-student-card-summary">{item.summary}</p>
    <div className="op-student-meta"><span><MapPin size={15} />{item.city || 'Місто не вказане'}</span><span><Globe2 size={15} />{FORMAT_LABELS[item.format]}</span>{item.experience && <span><GraduationCap size={15} />{item.experience}</span>}</div>
    <div className="op-student-card-bottom"><div><strong>{item.compensation || (item.paid === 'no' ? 'Без оплати' : 'Оплату не вказано')}</strong><small>{item.deadline ? `${isExpired ? 'Завершено' : 'Відгук до'} ${dateLabel(item.deadline)}` : 'Без кінцевої дати'}</small></div><button type="button" className="op-student-card-arrow" aria-label={`Детальніше: ${item.title}`} onClick={onOpen}><ArrowRight size={20} /></button></div>
  </article>
}

export function StudentPanel() {
  const context = useOpportunities()
  const { data, busy, execute, toast, profileSeed, view, setView, selectedOpportunityId, setSelectedOpportunityId } = context
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<OpportunityKind | 'all'>('all')
  const [format, setFormat] = useState('all')
  const [city, setCity] = useState('all')
  const [direction, setDirection] = useState('all')
  const [experience, setExperience] = useState('all')
  const [paid, setPaid] = useState('all')
  const [sort, setSort] = useState('recommended')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [detailMode, setDetailMode] = useState<'detail' | 'apply' | 'report'>('detail')
  const [applyMessage, setApplyMessage] = useState('')
  const [applyContact, setApplyContact] = useState('')
  const [applyConsent, setApplyConsent] = useState(false)
  const [applyError, setApplyError] = useState('')
  const [reportReason, setReportReason] = useState('')
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [applicationFilter, setApplicationFilter] = useState<ApplicationStatus | 'all'>('all')
  const [messageDraft, setMessageDraft] = useState('')
  const [withdrawConfirm, setWithdrawConfirm] = useState(false)
  const [candidate, setCandidate] = useState<CareerResume | null>(null)
  const [resumeDraft, setResumeDraft] = useState<CareerResume>(() => data.resume || emptyResume(data.actor))
  const [resumeSkills, setResumeSkills] = useState((data.resume?.skills || []).join(', '))
  const [resumeDirty, setResumeDirty] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const [resumePreview, setResumePreview] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [digest, setDigest] = useState(data.preferences.digest)
  const [digestDirections, setDigestDirections] = useState(data.preferences.directions.join(', '))
  const resumeFileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (data.resume) { setResumeDraft(data.resume); setResumeSkills(data.resume.skills.join(', ')); setResumeDirty(false) }
  }, [data.resume?.id, data.resume?.updatedAt])
  useEffect(() => { setDetailMode('detail'); setApplyError(''); setApplyConsent(false); setApplyMessage(''); setApplyContact(data.resume?.contact || ''); setReportReason('') }, [selectedOpportunityId])
  useEffect(() => { setMessageDraft(''); setWithdrawConfirm(false) }, [applicationId])

  const visibleCompanies = data.companies.filter(company => company.status === 'approved')
  const companyById = new Map(data.companies.map(company => [company.id, company]))
  const publicItems = data.opportunities.filter(item => (item.status === 'approved' || item.status === 'closed') && companyById.get(item.companyId)?.status === 'approved')
  const activeItems = publicItems.filter(item => item.status === 'approved' && !expired(item))
  const promotions = useMemo(() => {
    const map = new Map<string, string>()
    if (data.actor.premium || !data.settings.advertisingEnabled) return map
    for (const campaign of data.campaigns) {
      if (campaign.status !== 'approved' || !campaign.placements.includes('catalog')) continue
      if (!campaign.startsAt || !campaign.endsAt || campaign.startsAt.slice(0, 10) > today() || campaign.endsAt.slice(0, 10) < today()) continue
      // Student snapshots expose only paid, audience-eligible campaigns; billing
      // documents remain private to the company and administrators.
      if (data.actor.role !== 'student' && !data.orders.some(order => order.campaignId === campaign.id && order.status === 'paid' && order.startsAt <= today() && order.endsAt >= today())) continue
      const item = data.opportunities.find(opportunity => opportunity.id === campaign.opportunityId)
      if (item?.status === 'approved' && !expired(item) && companyById.get(item.companyId)?.status === 'approved') map.set(item.id, campaign.id)
    }
    return map
  }, [data.campaigns, data.orders, data.opportunities, data.companies, data.actor.premium, data.settings.advertisingEnabled])
  const hidden = (item: Opportunity) => data.hiddenIds.includes(item.id) || data.preferences.hiddenCompanyIds.includes(item.companyId)
  const baseItems = (view === 'saved' ? publicItems.filter(item => data.savedIds.includes(item.id)) : activeItems).filter(item => (view === 'saved' && showHidden) || !hidden(item))
  const searchText = query.trim().toLocaleLowerCase('uk-UA')
  const catalogueItems = baseItems.filter(item =>
    (!searchText || [item.title, item.summary, item.direction, item.city, companyById.get(item.companyId)?.name].join(' ').toLocaleLowerCase('uk-UA').includes(searchText)) &&
    (kind === 'all' || item.kind === kind) && (format === 'all' || item.format === format) &&
    (city === 'all' || item.city === city) && (direction === 'all' || item.direction === direction) &&
    (experience === 'all' || item.experience === experience) && (paid === 'all' || item.paid === paid)
  ).sort((a, b) => {
    if (sort === 'deadline') return (a.deadline || '9999').localeCompare(b.deadline || '9999')
    const promoted = Number(promotions.has(b.id)) - Number(promotions.has(a.id))
    return promoted || b.createdAt.localeCompare(a.createdAt)
  })
  const filterCount = [kind, format, city, direction, experience, paid].filter(value => value !== 'all').length
  const selected = publicItems.find(item => item.id === selectedOpportunityId)
  const selectedCompany = selected ? companyById.get(selected.companyId) : undefined
  const openedCompany = visibleCompanies.find(company => company.id === companyId)
  const myApplications = data.applications.filter(application => application.studentId === data.actor.id)
  const openedApplication = myApplications.find(application => application.id === applicationId)
  const existingApplication = selected ? myApplications.find(application => application.opportunityId === selected.id) : undefined
  const candidateAccess = data.actor.role === 'admin' || (data.actor.role === 'company' && data.actor.companyIds.some(id => companyById.get(id)?.status === 'approved'))
  const candidateItems = candidateAccess ? data.candidateResumes.filter(resume => resume.visibility === 'employers' && (!searchText || [resume.headline, resume.education, resume.city, resume.skills.join(' ')].join(' ').toLocaleLowerCase('uk-UA').includes(searchText))) : []
  const optionValues = (field: 'city' | 'direction' | 'experience') => [...new Set(activeItems.map(item => item[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'))

  const openOpportunity = (item: Opportunity) => {
    setCompanyId(null); setSelectedOpportunityId(item.id)
    const campaignId = promotions.get(item.id)
    if (campaignId && data.actor.role === 'student') void execute({ type: 'event.record', campaignId, event: 'click', placement: 'catalog' })
  }
  const resetFilters = () => { setQuery(''); setKind('all'); setFormat('all'); setCity('all'); setDirection('all'); setExperience('all'); setPaid('all') }
  const shareOpportunity = async (item: Opportunity) => {
    const path = window.location.pathname.includes('.local') ? window.location.pathname : '/opportunities'
    const url = `${window.location.origin}${path}?opportunity=${encodeURIComponent(item.id)}`
    try {
      if (navigator.share) await navigator.share({ title: item.title, text: `${companyById.get(item.companyId)?.name || 'Xelay'} · ${item.title}`, url })
      else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); toast('Посилання скопійовано.') }
      else throw new Error('Браузер не дозволив скопіювати посилання. Відкрийте сторінку через захищене з’єднання.')
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) toast(error instanceof Error ? error.message : 'Не вдалося поділитися посиланням.') }
  }
  const hideOpportunity = async (item: Opportunity) => {
    const wasHidden = data.hiddenIds.includes(item.id)
    if (await execute({ type: 'hidden.toggle', id: item.id })) {
      toast(wasHidden ? 'Можливість знову з’являтиметься в каталозі.' : 'Можливість приховано. Повернути її можна в налаштуваннях каталогу.')
      if (!wasHidden) setSelectedOpportunityId(null)
      const campaignId = promotions.get(item.id)
      if (campaignId && !wasHidden) await execute({ type: 'event.record', campaignId, event: 'hide', placement: 'catalog' })
    }
  }
  const submitApplication = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected || busy) return
    if (!data.resume?.headline.trim()) { setApplyError('Спочатку збережіть резюме з бажаною посадою або напрямом.'); return }
    if (applyContact.trim().length < 4) { setApplyError('Вкажіть контакт, за яким компанія зможе вам відповісти.'); return }
    if (!applyConsent) { setApplyError('Підтвердіть передачу вибраних даних цій компанії.'); return }
    setApplyError('')
    if (await execute({ type: 'application.submit', opportunityId: selected.id, message: applyMessage.trim(), contact: applyContact.trim(), consent: true })) {
      setSelectedOpportunityId(null); setView('applications'); toast('Відгук надіслано. Його стан і відповіді компанії — у «Моїх відгуках».')
    }
  }
  const patchResume = <K extends keyof CareerResume>(key: K, value: CareerResume[K]) => { setResumeDraft(current => ({ ...current, [key]: value })); setResumeDirty(true); setResumeError('') }
  const normalizedResume = () => ({ ...resumeDraft, skills: [...new Set(resumeSkills.split(',').map(value => value.trim()).filter(Boolean))] })
  const saveResume = async (event: FormEvent) => {
    event.preventDefault()
    const draft = normalizedResume()
    if (!draft.fullName.trim() || !draft.headline.trim()) { setResumeError('Вкажіть ім’я та бажану посаду або напрям.'); return }
    if (draft.portfolioUrl.trim() && !safeLink(draft.portfolioUrl.trim())) { setResumeError('Для портфоліо потрібне повне захищене посилання, що починається з https://.'); return }
    if (draft.skills.length > 30 || draft.skills.some(skill => skill.length > 80)) { setResumeError('Додайте до 30 навичок, не більше 80 символів кожна.'); return }
    if (!draft.seeking.length) { setResumeError('Оберіть хоча б один тип можливостей.'); return }
    setResumeError('')
    if (await execute({ type: 'resume.save', resume: { ...draft, fullName: draft.fullName.trim(), headline: draft.headline.trim(), portfolioUrl: draft.portfolioUrl.trim(), contact: draft.contact.trim() } })) {
      setResumeDirty(false); toast('Кар’єрне резюме збережено. Основний профіль залишається окремим.')
    }
  }
  const uploadResume = async (file?: File) => {
    if (!file) return
    setUploading(true); setResumeError('')
    try {
      if (file.size > 10 * 1024 * 1024 || file.size === 0) throw new Error('Оберіть PDF розміром до 10 МБ.')
      const magic = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer())
      if (magic !== '%PDF-' || !file.name.toLowerCase().endsWith('.pdf')) throw new Error('Резюме можна прикріпити лише у форматі PDF.')
      patchResume('file', await context.upload(file, 'resume'))
      toast('PDF прикріплено. Збережіть резюме, щоб застосувати зміни.')
    } catch (error) { setResumeError(error instanceof Error ? error.message : 'Не вдалося завантажити PDF.') }
    finally { setUploading(false); if (resumeFileInput.current) resumeFileInput.current.value = '' }
  }

  const catalogue = <>
    <section className="op-student-hero"><div><span className="op-eyebrow">Твій наступний крок</span><h2>{view === 'saved' ? 'Збережені можливості' : 'Можливості для тебе'}</h2><p>{view === 'saved' ? 'Повертайся до цікавих пропозицій у зручний момент. Завершені залишаються тут для довідки.' : 'Обирайте напрям та умови, які підходять саме вам.'}</p></div><div className="op-student-hero-action"><Sparkles size={25} /><strong>{activeItems.length}</strong><span>актуальних пропозицій</span></div></section>
    <div className="op-student-search-row"><div className="op-student-search"><Search size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Посада, компанія або напрям" aria-label="Знайти можливість" />{query && <button type="button" aria-label="Очистити пошук" onClick={() => setQuery('')}><X size={17} /></button>}</div><button type="button" className={`op-button op-button-secondary ${filtersOpen ? 'op-student-filter-active' : ''}`} onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen} aria-controls="career-catalogue-filters"><SlidersHorizontal size={17} />Фільтри{filterCount > 0 && <span className="op-student-filter-count">{filterCount}</span>}</button>{data.actor.role === 'student' && <button type="button" className="op-icon-button op-student-preferences-button" aria-label="Налаштування сповіщень і прихованих компаній" onClick={() => { setDigest(data.preferences.digest); setDigestDirections(data.preferences.directions.join(', ')); setPreferencesOpen(true) }}><Bell size={20} /></button>}</div>
    <div className="op-student-kind-tabs" role="group" aria-label="Тип можливості"><button type="button" className={kind === 'all' ? 'is-active' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>Усе</button>{KIND_KEYS.map(value => <button key={value} type="button" className={kind === value ? 'is-active' : ''} aria-pressed={kind === value} onClick={() => setKind(value)}>{KIND_LABELS[value]}</button>)}</div>
    {filtersOpen && <section id="career-catalogue-filters" className="op-student-filters"><Field label="Формат"><select value={format} onChange={event => setFormat(event.target.value)}><option value="all">Будь-який</option>{Object.entries(FORMAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Місто"><select value={city} onChange={event => setCity(event.target.value)}><option value="all">Усі міста</option>{optionValues('city').map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Напрям"><select value={direction} onChange={event => setDirection(event.target.value)}><option value="all">Усі напрями</option>{optionValues('direction').map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Досвід"><select value={experience} onChange={event => setExperience(event.target.value)}><option value="all">Будь-який</option>{optionValues('experience').map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Оплата"><select value={paid} onChange={event => setPaid(event.target.value)}><option value="all">Усі пропозиції</option><option value="yes">Оплачувані</option><option value="no">Без оплати</option><option value="unspecified">Оплату не вказано</option></select></Field><button type="button" className="op-student-text-button" onClick={resetFilters}>Скинути фільтри</button></section>}
    <div className="op-student-result-row"><p><strong>{catalogueItems.length}</strong> {view === 'saved' ? 'у збереженому' : 'за вашим вибором'}{filterCount > 0 && <button type="button" onClick={resetFilters}>Скинути</button>}</p><label>Порядок<select value={sort} onChange={event => setSort(event.target.value)}><option value="recommended">Рекомендовані</option><option value="deadline">За терміном подачі</option></select></label></div>
    {view === 'saved' && <label className="op-student-check op-student-hidden-switch"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} /><span>Показувати також приховані збережені пропозиції</span></label>}
    {catalogueItems.length ? <div className="op-student-card-grid">{catalogueItems.map(item => <OpportunityCard key={item.id} item={item} company={companyById.get(item.companyId)} campaignId={!expired(item) ? promotions.get(item.id) : undefined} onOpen={() => openOpportunity(item)} />)}</div> : <EmptyState title={view === 'saved' && !data.savedIds.length ? 'Зберігайте те, що зацікавило' : 'Поки немає відповідних пропозицій'} description={view === 'saved' && !data.savedIds.length ? 'Натисніть на закладку біля можливості — вона з’явиться тут.' : 'Спробуйте інший запит або приберіть частину фільтрів.'} action={<button type="button" className="op-button op-button-secondary" onClick={() => { resetFilters(); if (view === 'saved') setView('opportunities') }}>{view === 'saved' ? 'Переглянути можливості' : 'Скинути фільтри'}<ArrowRight size={17} /></button>} />}
    {view !== 'saved' && data.actor.role === 'student' && <aside className="op-student-resume-nudge"><FileText size={25} /><div><h3>{data.resume ? 'Резюме готове до наступного кроку' : 'Твій досвід починається з резюме'}</h3><p>{data.resume ? 'Перевірте актуальність навичок та оберіть, кому відкривати кар’єрний профіль.' : 'Навчальні проєкти, навички та інтереси теж мають значення. Створіть окремий кар’єрний профіль.'}</p></div><button type="button" className="op-button op-button-secondary" onClick={() => setView('resume')}>{data.resume ? 'Моє резюме' : 'Створити резюме'}<ArrowRight size={17} /></button></aside>}
  </>

  const companyCatalogue = <>
    <div className="op-student-page-title"><span className="op-eyebrow">Знайомство з роботодавцями</span><h2>Компанії, з якими можна почати</h2><p>Дізнавайтеся про команди, переглядайте їхні можливості та обирайте свій напрям.</p></div>
    <label className="op-student-search"><Search size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Назва, сфера або місто" aria-label="Пошук компаній" /></label>
    <div className="op-student-company-grid">{visibleCompanies.filter(company => !searchText || [company.name, company.industry, company.city].join(' ').toLocaleLowerCase('uk-UA').includes(searchText)).map(company => <article className="op-student-company-card" key={company.id}><CompanyMark company={company} size={56} /><div className="op-student-company-badges"><span><BadgeCheck size={14} />Перевірено</span>{company.partner && <span><Heart size={14} />Партнер Xelay</span>}</div><h3>{company.name}</h3><p>{company.tagline || company.industry}</p><div className="op-student-meta"><span><MapPin size={15} />{company.city || 'Місто не вказане'}</span></div><button type="button" className="op-student-company-link" onClick={() => { setSelectedOpportunityId(null); setCompanyId(company.id) }}>{activeItems.filter(item => item.companyId === company.id).length} актуальних пропозицій<ArrowRight size={18} /></button></article>)}</div>
    {!visibleCompanies.some(company => !searchText || [company.name, company.industry, company.city].join(' ').toLocaleLowerCase('uk-UA').includes(searchText)) && <EmptyState title="Компанії ще з’являться" description="Тут будуть перевірені роботодавці та партнери з актуальними пропозиціями." />}
  </>

  const resumeEditor = <>
    <div className="op-student-page-title"><span className="op-eyebrow">Окремо від основного профілю</span><h2>Моє кар’єрне резюме</h2><p>Розкажіть, що вмієте і який наступний крок шукаєте. Навіть якщо це ваша перша робота.</p></div>
    <div className="op-student-resume-layout"><form className="op-student-resume-form" onSubmit={event => void saveResume(event)}>
      <div className="op-student-resume-toolbar"><span><ShieldCheck size={17} />{resumeDraft.visibility === 'private' ? 'Приватне до вашого рішення' : 'Відкрите перевіреним роботодавцям'}</span><button type="button" className="op-student-text-button" onClick={() => setResumePreview(true)}><Eye size={16} />Переглянути</button></div>
      {profileSeed && <button type="button" className="op-student-import-profile" onClick={() => { setResumeDraft(current => ({ ...current, fullName: profileSeed.name || current.fullName, education: profileSeed.education || current.education })); setResumeDirty(true); toast('Ім’я та освіту скопійовано. Зміни в резюме не змінюють основний профіль.') }}><Copy size={18} /><span>Скопіювати ім’я та освіту з профілю<small>Далі можна редагувати їх незалежно</small></span><ArrowRight size={18} /></button>}
      <section className="op-student-form-section"><div className="op-student-section-number">01</div><div><h3>Хто ви та що шукаєте</h3><div className="op-form-grid"><Field label="Ім’я та прізвище *"><input required maxLength={120} autoComplete="name" value={resumeDraft.fullName} onChange={event => patchResume('fullName', event.target.value)} /></Field><Field label="Бажана посада або напрям *" hint="Наприклад: стажування з маркетингу"><input required maxLength={160} placeholder="Що хочете спробувати?" value={resumeDraft.headline} onChange={event => patchResume('headline', event.target.value)} /></Field></div><Field label="Про мене" hint="Коротко про інтереси, сильні сторони та мотивацію"><textarea rows={4} maxLength={2500} value={resumeDraft.about} onChange={event => patchResume('about', event.target.value)} placeholder="Навчаюся, цікавлюся…" /></Field><fieldset className="op-student-seeking"><legend>Мене цікавить *</legend>{(['job', 'internship', 'course'] as OpportunityKind[]).map(value => <label key={value} className={`op-student-seeking-option ${resumeDraft.seeking.includes(value) ? 'is-active' : ''}`}><input type="checkbox" checked={resumeDraft.seeking.includes(value)} onChange={event => patchResume('seeking', event.target.checked ? [...resumeDraft.seeking, value] : resumeDraft.seeking.filter(kindValue => kindValue !== value))} />{value === 'job' ? 'Робота / підробіток' : value === 'internship' ? 'Стажування / практика' : 'Кар’єрне навчання'}</label>)}</fieldset></div></section>
      <section className="op-student-form-section"><div className="op-student-section-number">02</div><div><h3>Освіта та навички</h3><Field label="Освіта"><textarea rows={3} maxLength={3000} placeholder="Університет, спеціальність, курс або роки навчання" value={resumeDraft.education} onChange={event => patchResume('education', event.target.value)} /></Field><Field label="Навички" hint="Розділяйте комами: Excel, аналітика, Figma"><input maxLength={2400} value={resumeSkills} onChange={event => { setResumeSkills(event.target.value); setResumeDirty(true) }} placeholder="Що вже вмієте?" /></Field><Field label="Мови та рівень володіння"><input maxLength={1000} value={resumeDraft.languages} onChange={event => patchResume('languages', event.target.value)} placeholder="Українська — вільно, англійська — B2" /></Field></div></section>
      <section className="op-student-form-section"><div className="op-student-section-number">03</div><div><h3>Досвід, який має значення</h3><Field label="Досвід" hint="Робота, волонтерство, участь у студентських командах"><textarea rows={4} maxLength={5000} value={resumeDraft.experience} onChange={event => patchResume('experience', event.target.value)} /></Field><Field label="Проєкти та досягнення" hint="Можна додати навчальний проєкт або власну ініціативу"><textarea rows={4} maxLength={5000} value={resumeDraft.projects} onChange={event => patchResume('projects', event.target.value)} /></Field><Field label="Посилання на портфоліо"><input type="url" maxLength={2000} placeholder="https://…" value={resumeDraft.portfolioUrl} onChange={event => patchResume('portfolioUrl', event.target.value)} /></Field></div></section>
      <section className="op-student-form-section"><div className="op-student-section-number">04</div><div><h3>Зручні умови та контакт</h3><div className="op-form-grid"><Field label="Місто"><input maxLength={120} value={resumeDraft.city} onChange={event => patchResume('city', event.target.value)} /></Field><Field label="Формат"><select value={resumeDraft.format} onChange={event => patchResume('format', event.target.value)}>{['Будь-який', 'Дистанційно', 'На місці', 'Гібридно'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Коли можете працювати"><input maxLength={240} placeholder="Наприклад: 15–20 годин на тиждень" value={resumeDraft.availability} onChange={event => patchResume('availability', event.target.value)} /></Field><Field label="Побажання щодо оплати" hint="Необов’язково"><input maxLength={160} value={resumeDraft.salary} onChange={event => patchResume('salary', event.target.value)} /></Field></div><Field label="Контакт для відгуків" hint="Email, телефон або Telegram. Перед кожним відгуком його можна змінити."><input maxLength={240} value={resumeDraft.contact} onChange={event => patchResume('contact', event.target.value)} placeholder="Як з вами зв’язатися?" /></Field></div></section>
      <section className="op-student-form-section"><div className="op-student-section-number">05</div><div><h3>PDF та видимість</h3><input ref={resumeFileInput} type="file" accept="application/pdf,.pdf" className="op-sr-only" aria-label="Прикріпити PDF резюме" onChange={event => void uploadResume(event.target.files?.[0])} />{resumeDraft.file ? <div className="op-student-file-row"><CareerFileButton file={resumeDraft.file} /><button type="button" className="op-icon-button" aria-label="Прибрати PDF з резюме" disabled={busy || uploading} onClick={() => patchResume('file', null)}><X size={17} /></button></div> : <button type="button" className="op-student-upload" onClick={() => resumeFileInput.current?.click()} disabled={uploading || busy}><Upload size={22} /><strong>{uploading ? 'Завантажуємо PDF…' : 'Прикріпити готове резюме'}</strong><span>PDF до 10 МБ · необов’язково</span></button>}<label className="op-student-visibility"><input type="checkbox" checked={resumeDraft.visibility === 'employers'} onChange={event => patchResume('visibility', event.target.checked ? 'employers' : 'private')} /><div><strong>Відкритий до пропозицій</strong><p>Перевірені роботодавці зможуть бачити кар’єрний опис у каталозі кандидатів. Контакт і PDF туди не передаються. Ви можете вимкнути це будь-коли.</p></div></label></div></section>
      {resumeError && <p className="op-form-error" role="alert">{resumeError}</p>}<div className="op-student-resume-save"><span>{resumeDirty ? 'Є незбережені зміни' : data.resume ? `Збережено ${dateLabel(data.resume.updatedAt)}` : 'Поки не збережено'}</span><button type="submit" className="op-button" disabled={busy || uploading}>{busy ? 'Зберігаємо…' : 'Зберегти резюме'}<Check size={18} /></button></div>
    </form><aside className="op-student-resume-aside"><div className="op-student-aside-icon"><FileText size={29} /></div><h3>Ваш основний профіль — окремо</h3><p>Це резюме для роботи та стажувань. Його зміни не впливають на профіль у спільноті.</p><ul><li><ShieldCheck size={17} />Чернетку бачите лише ви.</li><li><Send size={17} />Перед відгуком видно всі дані, які отримає компанія.</li><li><Copy size={17} />Надісланий відгук зберігає версію резюме на момент подачі.</li></ul><small>Відкликання заявки зупиняє подальшу взаємодію у Xelay. Уже завантажений компанією файл технічно відкликати неможливо.</small></aside></div>
  </>

  const applicationInbox = <>
    <div className="op-student-page-title"><span className="op-eyebrow">Усі наступні кроки в одному місці</span><h2>Мої відгуки</h2><p>Стежте за станом заявки та відповідайте компанії. Листування щодо відгуків безкоштовне.</p></div>
    <div className="op-student-kind-tabs" role="group" aria-label="Стан відгуку"><button type="button" className={applicationFilter === 'all' ? 'is-active' : ''} aria-pressed={applicationFilter === 'all'} onClick={() => setApplicationFilter('all')}>Усі · {myApplications.length}</button>{(Object.keys(APPLICATION_LABELS) as ApplicationStatus[]).map(status => <button key={status} type="button" className={applicationFilter === status ? 'is-active' : ''} aria-pressed={applicationFilter === status} onClick={() => setApplicationFilter(status)}>{APPLICATION_LABELS[status]}</button>)}</div>
    <div className="op-student-application-list">{myApplications.filter(application => applicationFilter === 'all' || application.status === applicationFilter).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(application => { const item = data.opportunities.find(opportunity => opportunity.id === application.opportunityId), company = companyById.get(application.companyId); return <button type="button" key={application.id} className="op-student-application-card" onClick={() => setApplicationId(application.id)}><CompanyMark company={company} /><div><span>{company?.name || 'Компанія'}</span><h3>{item?.title || 'Пропозиція недоступна'}</h3><p>{application.messages.length ? `${application.messages.length} повідомлень · оновлено ${dateLabel(application.updatedAt)}` : `Надіслано ${dateLabel(application.createdAt)}`}</p></div><StatusPill status={application.status} /><ChevronDown size={19} /></button> })}</div>
    {!myApplications.some(application => applicationFilter === 'all' || application.status === applicationFilter) && <EmptyState title={myApplications.length ? 'Тут ще немає відгуків' : 'Ваша перша можливість попереду'} description={myApplications.length ? 'Коли статус заявки зміниться, вона з’явиться у відповідній вкладці.' : 'Оберіть пропозицію та надішліть резюме. Відповіді й подальші кроки будуть тут.'} action={<button className="op-button" type="button" onClick={() => setView('opportunities')}>Знайти можливість<ArrowRight size={17} /></button>} />}
  </>

  return <div className="op-student-panel">
    {(view === 'opportunities' || view === 'saved') && catalogue}
    {view === 'companies' && companyCatalogue}
    {view === 'resume' && resumeEditor}
    {view === 'applications' && applicationInbox}
    {view === 'candidates' && (candidateAccess ? <><div className="op-student-page-title"><span className="op-eyebrow">Добровільні кар’єрні профілі</span><h2>Відкриті до пропозицій</h2><p>Тут лише ті студенти, які самі відкрили резюме роботодавцям. Контакти та PDF доступні після окремого відгуку.</p></div><label className="op-student-search"><Search size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Напрям, навичка або місто" aria-label="Пошук кандидатів" /></label>{candidateItems.length ? <div className="op-student-card-grid">{candidateItems.map(resume => <article key={resume.id} className="op-student-card op-student-candidate"><div className="op-student-candidate-avatar">{resume.fullName.split(' ').filter(Boolean).map(part => part[0]).slice(0, 2).join('')}</div><span className="op-student-kind">Відкритий до пропозицій</span><h3>{resume.fullName}</h3><strong>{resume.headline}</strong><p>{resume.education}</p><div className="op-student-tags">{resume.skills.slice(0, 5).map(skill => <span key={skill}>{skill}</span>)}</div><button type="button" className="op-button op-button-secondary" onClick={() => setCandidate(resume)}>Переглянути резюме<ArrowRight size={17} /></button></article>)}</div> : <EmptyState title="Каталог кандидатів поступово наповнюється" description="Студент сам вирішує, чи відкривати кар’єрний профіль перевіреним компаніям." />}</> : <EmptyState title="Доступ для перевірених роботодавців" description="Каталог містить добровільно відкриті кар’єрні профілі. Доступ з’явиться після перевірки вашої компанії." action={<button className="op-button" type="button" onClick={() => setView('company')}>Кабінет компанії<ArrowRight size={17} /></button>} />)}

    {selectedOpportunityId && !selected && <CareerModal title="Можливість поки недоступна" onClose={() => setSelectedOpportunityId(null)}><EmptyState title="Це оголошення не опубліковане" description="Можливо, компанія редагує матеріал або він більше недоступний. Перегляньте актуальні пропозиції в каталозі." /></CareerModal>}
    {selected && <CareerModal title={detailMode === 'apply' ? 'Відгук на можливість' : detailMode === 'report' ? 'Повідомити про проблему' : selected.title} description={detailMode === 'apply' ? `${selectedCompany?.name || 'Компанія'} · ${selected.title}` : detailMode === 'report' ? 'Команда Xelay перевірить ваш сигнал.' : `${KIND_LABELS[selected.kind]} · ${selectedCompany?.name || 'Компанія'}`} onClose={() => setSelectedOpportunityId(null)} wide>
      {detailMode === 'detail' && <div className="op-student-detail"><button type="button" className="op-student-detail-company" onClick={() => { setCompanyId(selected.companyId); setSelectedOpportunityId(null) }}><CompanyMark company={selectedCompany} /><span><strong>{selectedCompany?.name}</strong><small><BadgeCheck size={14} />Компанію перевірено</small></span><ArrowRight size={18} /></button><div className="op-student-detail-facts"><span><MapPin size={17} />{selected.city || 'Місто не вказане'}</span><span><Globe2 size={17} />{FORMAT_LABELS[selected.format]}</span><span><Clock3 size={17} />{selected.employment || 'Зайнятість не вказана'}</span><span><GraduationCap size={17} />{selected.experience || 'Досвід не вказано'}</span></div><div className="op-student-detail-compensation"><strong>{selected.compensation || (selected.paid === 'no' ? 'Без оплати' : 'Оплату не вказано')}</strong>{selected.kind === 'internship' && <span>{selected.paid === 'yes' ? 'Оплачуване стажування' : selected.paid === 'no' ? 'Неоплачуване стажування' : 'Компанія не вказала, чи оплачується стажування'}</span>}</div><ReadSection title="Про можливість">{selected.description || selected.summary}</ReadSection><ReadSection title="Що знадобиться">{selected.requirements}</ReadSection><ReadSection title="Що пропонує компанія">{selected.benefits}</ReadSection>{selected.startsAt && <ReadSection title="Початок">{dateLabel(selected.startsAt)}</ReadSection>}{selected.files.length > 0 && <ReadSection title="Матеріали"><div className="op-student-files">{selected.files.map(file => <CareerFileButton key={file.id} file={file} />)}</div></ReadSection>}
        <div className="op-student-detail-actions"><div>{data.actor.role !== 'student' ? <p className="op-student-muted">Відгуки надсилають студенти зі свого акаунта.</p> : expired(selected) ? <p className="op-student-ended-note"><Clock3 size={18} />Термін подачі завершено. Нові відгуки недоступні.</p> : existingApplication ? <button type="button" className="op-button" onClick={() => { setSelectedOpportunityId(null); setView('applications'); setApplicationId(existingApplication.id) }}><CheckCheck size={18} />{existingApplication.status === 'withdrawn' ? 'Переглянути відкликаний відгук' : 'Відгук уже надіслано'}</button> : selected.applicationMode === 'external' ? safeLink(selected.externalUrl) ? <a className="op-button" href={safeLink(selected.externalUrl)} target="_blank" rel="noopener noreferrer">Подати заявку на сайті компанії<ExternalLink size={17} /></a> : <p className="op-form-error">Компанія поки не додала коректне посилання для відгуку.</p> : <button type="button" className="op-button" onClick={() => setDetailMode('apply')}>Відгукнутися безкоштовно<ArrowRight size={18} /></button>}<small>{selected.applicationMode === 'external' ? 'Ви перейдете на зовнішній сайт. Xelay не бачить стан цієї заявки.' : selected.deadline ? `Відгук до ${dateLabel(selected.deadline)}` : 'Відгуки без кінцевої дати'}</small></div>{data.actor.role === 'student' && <button type="button" className="op-button op-button-secondary" disabled={busy} onClick={() => void execute({ type: 'saved.toggle', id: selected.id })}><Bookmark size={17} fill={data.savedIds.includes(selected.id) ? 'currentColor' : 'none'} />{data.savedIds.includes(selected.id) ? 'Збережено' : 'Зберегти'}</button>}</div>
        <div className="op-student-detail-secondary"><button type="button" onClick={() => void shareOpportunity(selected)}><Copy size={15} />Поділитися</button>{data.actor.role === 'student' && <><button type="button" disabled={busy} onClick={() => void hideOpportunity(selected)}>{data.hiddenIds.includes(selected.id) ? <Eye size={15} /> : <EyeOff size={15} />}{data.hiddenIds.includes(selected.id) ? 'Показувати знову' : 'Приховати'}</button><button type="button" onClick={() => setDetailMode('report')}><Flag size={15} />Поскаржитися</button></>}</div>
      </div>}
      {detailMode === 'apply' && <form className="op-student-apply-form" onSubmit={event => void submitApplication(event)}><div className="op-student-recipient"><ShieldCheck size={22} /><div><strong>Одержувач: {selectedCompany?.name}</strong><p>Передаємо лише наведені нижче дані. Резюме зберігається у версії на момент відгуку.</p></div></div>{data.resume?.headline.trim() ? <details className="op-student-snapshot-details" open><summary><FileText size={18} />Резюме, яке отримає компанія<ChevronDown size={17} /></summary><ResumeSnapshot resume={{ ...data.resume, contact: applyContact }} /></details> : <div className="op-student-apply-no-resume"><FileText size={27} /><h3>Спочатку додайте кар’єрне резюме</h3><p>Достатньо вказати бажаний напрям, освіту та навички. Досвід роботи необов’язковий.</p><button type="button" className="op-button op-button-secondary" onClick={() => { setSelectedOpportunityId(null); setView('resume') }}>Створити резюме<ArrowRight size={17} /></button></div>}<Field label="Контакт для відповіді *" hint="Саме цей контакт побачить компанія"><input required maxLength={240} value={applyContact} onChange={event => { setApplyContact(event.target.value); setApplyError('') }} placeholder="Email, телефон або Telegram" /></Field><Field label="Коротке повідомлення" hint="Необов’язково. Що зацікавило вас у цій пропозиції?"><textarea rows={3} maxLength={3000} value={applyMessage} onChange={event => setApplyMessage(event.target.value)} /></Field><label className="op-student-check op-student-apply-consent"><input type="checkbox" checked={applyConsent} onChange={event => { setApplyConsent(event.target.checked); setApplyError('') }} /><span>Погоджуюся передати компанії <strong>{selectedCompany?.name}</strong> показане резюме, прикріплений PDF, вибраний контакт та повідомлення для розгляду цього відгуку.</span></label>{applyError && <p className="op-form-error" role="alert">{applyError}</p>}<div className="op-modal-actions"><button type="button" className="op-button op-button-secondary" onClick={() => setDetailMode('detail')}>Назад</button><button type="submit" className="op-button" disabled={busy || !data.resume?.headline.trim() || expired(selected)}>{busy ? 'Надсилаємо…' : 'Надіслати відгук'}<Send size={17} /></button></div></form>}
      {detailMode === 'report' && <form className="op-student-report-form" onSubmit={event => { event.preventDefault(); if (reportReason.trim().length < 10) { toast('Опишіть проблему хоча б у 10 символах.'); return } void execute({ type: 'report.submit', opportunityId: selected.id, reason: reportReason.trim() }).then(ok => { if (ok) { toast('Скаргу передано команді Xelay.'); setDetailMode('detail') } }) }}><Field label="Що викликає сумнів?" hint="Наприклад: неправдиві умови, підозріле посилання або вимога переказати гроші"><textarea required minLength={10} maxLength={2000} rows={5} value={reportReason} onChange={event => setReportReason(event.target.value)} /></Field><p className="op-student-muted">Компанія не отримує текст скарги та ваш контакт через цю форму.</p><div className="op-modal-actions"><button type="button" className="op-button op-button-secondary" onClick={() => setDetailMode('detail')}>Назад</button><button className="op-button" type="submit" disabled={busy || reportReason.trim().length < 10}>Надіслати скаргу<Flag size={16} /></button></div></form>}
    </CareerModal>}

    {openedCompany && <CareerModal title={openedCompany.name} description={openedCompany.tagline || openedCompany.industry} onClose={() => setCompanyId(null)} wide><div className="op-student-detail"><div className="op-student-company-profile-head"><CompanyMark company={openedCompany} size={68} /><div><span><BadgeCheck size={15} />Компанію перевірено</span>{openedCompany.partner && <span><Heart size={15} />Партнер Xelay</span>}</div></div><ReadSection title="Про компанію">{openedCompany.description}</ReadSection><div className="op-student-meta"><span><MapPin size={17} />{openedCompany.city || 'Місто не вказане'}</span>{safeLink(openedCompany.website) && <a href={safeLink(openedCompany.website)} target="_blank" rel="noopener noreferrer">Сайт компанії<ExternalLink size={15} /></a>}</div><h3 className="op-student-subheading">Актуальні можливості</h3>{activeItems.filter(item => item.companyId === openedCompany.id).length ? <div className="op-student-company-opportunities">{activeItems.filter(item => item.companyId === openedCompany.id).map(item => <button type="button" key={item.id} onClick={() => openOpportunity(item)}><div><span>{KIND_LABELS[item.kind]}</span><strong>{item.title}</strong><small>{FORMAT_LABELS[item.format]} · {item.compensation || 'Оплату не вказано'}</small></div><ArrowRight size={19} /></button>)}</div> : <p className="op-student-muted">Компанія поки не опублікувала актуальних пропозицій.</p>}<button className="op-student-text-button" type="button" disabled={busy} onClick={() => { const isHidden = data.preferences.hiddenCompanyIds.includes(openedCompany.id); void execute({ type: 'preferences.save', preferences: { ...data.preferences, hiddenCompanyIds: isHidden ? data.preferences.hiddenCompanyIds.filter(id => id !== openedCompany.id) : [...data.preferences.hiddenCompanyIds, openedCompany.id] } }).then(ok => { if (ok) toast(isHidden ? 'Пропозиції компанії знову показуватимуться.' : 'Пропозиції компанії приховано з вашого каталогу.') }) }}><EyeOff size={16} />{data.preferences.hiddenCompanyIds.includes(openedCompany.id) ? 'Знову показувати пропозиції компанії' : 'Не показувати пропозиції цієї компанії'}</button></div></CareerModal>}

    {openedApplication && <CareerModal title={data.opportunities.find(item => item.id === openedApplication.opportunityId)?.title || 'Ваш відгук'} description={companyById.get(openedApplication.companyId)?.name || 'Компанія'} onClose={() => setApplicationId(null)} wide><ApplicationConversation application={openedApplication} draft={messageDraft} setDraft={setMessageDraft} withdrawConfirm={withdrawConfirm} setWithdrawConfirm={setWithdrawConfirm} /></CareerModal>}
    {resumePreview && <CareerModal title="Перегляд кар’єрного резюме" description={resumeDirty ? 'Попередній перегляд поточних змін. Щоб застосувати їх, збережіть резюме.' : 'Так виглядає ваше резюме перед відгуком.'} onClose={() => setResumePreview(false)} wide><div className="op-student-detail"><ResumeSnapshot resume={normalizedResume()} /></div></CareerModal>}
    {candidate && candidateAccess && <CareerModal title="Кар’єрний профіль" description="Студент сам відкрив цей опис перевіреним роботодавцям." onClose={() => setCandidate(null)} wide><div className="op-student-detail"><ResumeSnapshot resume={candidate} showContact={false} /><div className="op-student-recipient"><ShieldCheck size={21} /><p>Контакт і PDF не розкриваються в каталозі. Опублікуйте відповідну можливість — кандидат зможе відгукнутися та сам передати їх.</p></div><button type="button" className="op-button op-button-secondary" onClick={() => { setCandidate(null); setView('company') }}>Мої можливості<ArrowRight size={17} /></button></div></CareerModal>}
    {preferencesOpen && <CareerModal title="Мої налаштування можливостей" description="Обирайте, що хочете бачити та отримувати." onClose={() => setPreferencesOpen(false)}><form className="op-student-preferences" onSubmit={event => { event.preventDefault(); void execute({ type: 'preferences.save', preferences: { ...data.preferences, digest, directions: [...new Set(digestDirections.split(',').map(value => value.trim()).filter(Boolean))] } }).then(ok => { if (ok) { setPreferencesOpen(false); toast('Налаштування збережено.') } }) }}><label className="op-student-check"><input type="checkbox" checked={digest} onChange={event => setDigest(event.target.checked)} /><span><strong>Щотижнева добірка можливостей</strong><small>Вподобання для запуску сервісу. У локальному прикладі листи не надсилаються. Відповіді на заявки приходять окремо.</small></span></label><Field label="Цікаві напрями" hint="Через кому; залиште порожнім, щоб бачити всі напрями"><input maxLength={1000} value={digestDirections} onChange={event => setDigestDirections(event.target.value)} placeholder="Маркетинг, фінанси, аналітика" /></Field>{data.preferences.hiddenCompanyIds.length > 0 && <ReadSection title="Приховані компанії"><div className="op-student-hidden-companies">{data.preferences.hiddenCompanyIds.map(id => <div key={id}><span>{companyById.get(id)?.name || 'Компанія'}</span><button type="button" className="op-student-text-button" disabled={busy} onClick={() => void execute({ type: 'preferences.save', preferences: { ...data.preferences, hiddenCompanyIds: data.preferences.hiddenCompanyIds.filter(value => value !== id) } })}>Показувати знову</button></div>)}</div></ReadSection>}{data.hiddenIds.length > 0 && <ReadSection title="Приховані пропозиції"><div className="op-student-hidden-companies">{data.hiddenIds.map(id => <div key={id}><span>{publicItems.find(item => item.id === id)?.title || 'Пропозиція недоступна'}</span><button type="button" className="op-student-text-button" disabled={busy} onClick={() => void execute({ type: 'hidden.toggle', id })}>Показувати знову</button></div>)}</div></ReadSection>}<div className="op-modal-actions"><button className="op-button" type="submit" disabled={busy}>Зберегти<Check size={17} /></button></div></form></CareerModal>}
  </div>
}

function ApplicationConversation({ application, draft, setDraft, withdrawConfirm, setWithdrawConfirm }: { application: CareerApplication; draft: string; setDraft: (value: string) => void; withdrawConfirm: boolean; setWithdrawConfirm: (value: boolean) => void }) {
  const { data, busy, execute, toast } = useOpportunities()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }, [application.messages.length])
  const closed = application.status === 'withdrawn' || application.status === 'completed'
  return <div className="op-student-conversation"><div className="op-student-application-status"><StatusPill status={application.status} /><span>Відгук від {dateLabel(application.createdAt)}</span></div><details className="op-student-snapshot-details"><summary><FileText size={18} />Що ви надіслали<ChevronDown size={17} /></summary><ResumeSnapshot resume={{ ...application.resumeSnapshot, contact: application.contact }} />{application.message && <ReadSection title="Супровідне повідомлення">{application.message}</ReadSection>}<p className="op-student-muted">Збережена версія на момент відгуку. Подальші зміни вашого резюме її не змінюють.</p></details><section className="op-student-messages" aria-label="Листування щодо відгуку"><div className="op-student-conversation-note"><MessageCircle size={17} />Розмова щодо цієї заявки · безкоштовно</div>{application.messages.length ? application.messages.map(message => <article key={message.id} className={`op-student-message ${message.authorId === data.actor.id ? 'op-student-message-own' : ''}`}><span>{message.authorName}</span><p>{message.body}</p><time dateTime={message.createdAt}>{new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(new Date(message.createdAt))}</time></article>) : <p className="op-student-messages-empty">Коли компанія відповість, повідомлення з’явиться тут. Ви також можете написати першими.</p>}<div ref={endRef} /></section>{closed ? <p className="op-student-ended-note"><ShieldCheck size={17} />{application.status === 'withdrawn' ? 'Відгук відкликано. Нові повідомлення недоступні.' : 'Листування завершено.'}</p> : <form className="op-student-message-composer" onSubmit={event => { event.preventDefault(); if (!draft.trim()) return; void execute({ type: 'application.message', id: application.id, body: draft.trim() }).then(ok => { if (ok) setDraft('') }) }}><label className="op-sr-only" htmlFor={`career-message-${application.id}`}>Повідомлення компанії</label><textarea id={`career-message-${application.id}`} rows={2} maxLength={3000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Напишіть компанії…" /><button type="submit" className="op-button" aria-label="Надіслати повідомлення" disabled={busy || !draft.trim()}><Send size={18} /></button></form>}{!closed && <div className="op-student-withdraw">{withdrawConfirm ? <><p>Відкликати цей відгук? Компанія побачить його новий статус. Уже завантажені нею файли технічно відкликати неможливо.</p><div><button type="button" className="op-button op-button-secondary" onClick={() => setWithdrawConfirm(false)} disabled={busy}>Залишити відгук</button><button type="button" className="op-button op-button-danger" disabled={busy} onClick={() => void execute({ type: 'application.status', id: application.id, status: 'withdrawn' }).then(ok => { if (ok) { setWithdrawConfirm(false); toast('Відгук відкликано.') } })}>Відкликати</button></div></> : <button type="button" className="op-student-text-button" onClick={() => setWithdrawConfirm(true)}>Відкликати відгук</button>}</div>}</div>
}
