import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Megaphone, ShieldCheck } from 'lucide-react'
import type { Campaign, Placement } from '../../lib/opportunities/types'
import { PLACEMENT_LABELS } from '../../lib/opportunities/types'
import { useOpportunities } from './OpportunitiesContext'
import { CareerModal, CompanyMark } from './shared'

/** Receives only repository-qualified campaigns; previewing never records a view. */
export function CampaignPlacement({ campaign, placement, preview = false, onOpen }: { campaign: Campaign; placement: Placement; preview?: boolean; onOpen?: () => void }) {
  const { data, execute, setSelectedOpportunityId, setView, toast } = useOpportunities(); const ref = useRef<HTMLElement>(null); const recorded = useRef(false)
  const company = data.companies.find(c => c.id === campaign.companyId)
  useEffect(() => {
    if (preview || data.actor.role !== 'student' || !ref.current) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => { if (timer) clearTimeout(timer); timer = null }
    const observer = new IntersectionObserver(entries => { clear(); if (entries[0]?.intersectionRatio >= .5 && document.visibilityState === 'visible' && !recorded.current) timer = setTimeout(() => { void execute({ type: 'event.record', campaignId: campaign.id, event: 'impression', placement }).then(ok => { recorded.current = ok }) }, 1000) }, { threshold: [.5] })
    observer.observe(ref.current); document.addEventListener('visibilitychange', clear)
    return () => { clear(); observer.disconnect(); document.removeEventListener('visibilitychange', clear) }
  }, [campaign.id, data.actor.role, execute, placement, preview])
  async function open() {
    if (!preview && data.actor.role === 'student') await execute({ type: 'event.record', campaignId: campaign.id, event: 'click', placement })
    if (campaign.opportunityId) { setSelectedOpportunityId(campaign.opportunityId); setView('opportunities'); onOpen?.(); return }
    try { const link = new URL(campaign.url); if (link.protocol !== 'https:' || link.username || link.password) throw new Error(); if (link.hostname.endsWith('.example')) { toast('Це вигадане посилання локального прикладу.'); return }; window.open(link.href, '_blank', 'noopener,noreferrer') } catch { toast('Посилання поки недоступне.') }
  }
  return <article ref={ref} className={`op-placement op-placement-${placement}`}><div className="op-placement-visual" style={{ backgroundColor: company?.color || '#f0e7ed' }}>{/^https:\/\//i.test(campaign.image) ? <img src={campaign.image} alt="" referrerPolicy="no-referrer" /> : <><span className="op-placement-circle" /><Megaphone size={38} /></>}</div><div className="op-placement-body"><div className="op-placement-company"><CompanyMark company={company} size={33} /><strong>{company?.name || 'Компанія'}</strong><span>Реклама</span></div><h3>{campaign.title}</h3><p>{campaign.body}</p><button className="op-button" onClick={() => void open()}>{campaign.cta || 'Дізнатися більше'}<ArrowUpRight size={17} /></button><small><ShieldCheck size={13} />Перевірене розміщення</small></div></article>
}

export function EntryPlacement({ onOpen }: { onOpen?: () => void }) {
  const { data, execute } = useOpportunities(); const [shown, setShown] = useState<Campaign | null>(null); const attempted = useRef(false)
  useEffect(() => {
    if (attempted.current || data.actor.role !== 'student' || data.actor.premium || !data.settings.enabled || !data.settings.advertisingEnabled || !data.settings.entryEnabled) return
    const campaign = data.campaigns.find(c => c.placements.includes('entry')); if (!campaign) return
    const elapsed = data.preferences.lastEntryAt ? Date.now() - Date.parse(data.preferences.lastEntryAt) : Infinity
    if (elapsed < Math.max(7, data.settings.entryFrequencyDays, campaign.frequencyDays) * 86400000) return
    attempted.current = true
    void execute({ type: 'entry.reserve', campaignId: campaign.id }).then(ok => { if (ok) setShown(campaign) })
  }, [data, execute])
  return shown ? <CareerModal title="Можливість поруч" description="Рекламне розміщення. Можна закрити одразу." onClose={() => setShown(null)}><CampaignPlacement campaign={shown} placement="entry" onOpen={() => { setShown(null); onOpen?.() }} /></CareerModal> : null
}

export function AdvertisingReview({ onOpen }: { onOpen: () => void }) {
  const { data } = useOpportunities(); const [placement, setPlacement] = useState<Placement>('home'); const [entry, setEntry] = useState(false)
  const campaign = data.campaigns[0]
  return <main className="op-workspace"><header className="op-placement-review-title"><p className="op-eyebrow">ПЕРЕГЛЯД РЕКЛАМНИХ МІСЦЬ</p><h2>Помітно. Доречно. Зрозуміло.</h2><p className="op-placement-note">Приклад рекламного оформлення. Попередній перегляд не враховується у статистиці.</p></header><nav className="op-nav" style={{ marginTop: 25 }}>{(Object.keys(PLACEMENT_LABELS) as Placement[]).map(p => <button key={p} className={placement === p ? 'is-active' : ''} onClick={() => setPlacement(p)}>{PLACEMENT_LABELS[p]}</button>)}</nav>{campaign ? <><div className="op-placement-review-area">{placement !== 'entry' ? <CampaignPlacement campaign={campaign} placement={placement} preview onOpen={onOpen} /> : <div className="op-empty"><Megaphone size={30} /><h3>Один спокійний показ</h3><p>Миттєве закриття. Максимум раз на 7 днів. Після входу, поза реєстрацією й важливими переходами.</p><button className="op-button" onClick={() => setEntry(true)}>Відкрити приклад</button></div>}</div><p className="op-placement-note">Власник підписки «Учасник» не бачить рекламних банерів. Каталог можливостей залишається доступним усім.</p>{entry && <CareerModal title="Можливість поруч" description="Локальний приклад реклами — можна закрити одразу." onClose={() => setEntry(false)}><CampaignPlacement campaign={campaign} placement="entry" preview onOpen={() => { setEntry(false); onOpen() }} /></CareerModal>}</> : <div className="op-empty"><h3>Розміщення поки вимкнені</h3><p>Перемкни роль на адміністратора для перегляду всіх макетів або увімкни рекламу в локальних налаштуваннях.</p></div>}</main>
}
