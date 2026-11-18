import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, BookOpen, BriefcaseBusiness, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { HalloweenPumpkin } from '../components/halloween/HalloweenPumpkin'
import { AuthModal } from '../components/AuthModal'
import { OpportunitiesProvider } from '../components/opportunities/OpportunitiesContext'
import { OpportunitiesWorkspace } from '../components/opportunities/OpportunitiesWorkspace'
import { createSupabaseOpportunitiesRepository } from '../lib/opportunities/supabaseRepository'
import '../components/opportunities/Opportunities.css'

export function OpportunitiesPage() {
  const { authUser, xelayUser, businessAccount, authReadEpoch, authReadBlocked, isLoading } = useAuth()
  const [showAuth, setShowAuth] = useState(false)
  const repository = useMemo(() => createSupabaseOpportunitiesRepository(), [authUser?.id, authReadEpoch])
  if (isLoading) return <main className="op-empty" role="status">Завантажуємо можливості…</main>
  if (businessAccount) return <main className="op-empty"><h1>Ваші можливості починаються тут</h1><Link to="/business" className="op-button">До кабінету організації<ArrowUpRight size={18} /></Link></main>
  if (authUser && !authReadBlocked && xelayUser) return <OpportunitiesProvider key={authUser.id + ':' + authReadEpoch} repository={repository} profileSeed={{ name: xelayUser.name, education: '', city: '', skills: [] }}><HalloweenPumpkin pumpkinId="opportunities" perch="center" /><OpportunitiesWorkspace /></OpportunitiesProvider>
  return <main className="op-workspace op-coming-soon">{showAuth && <AuthModal onClose={() => setShowAuth(false)} />}<p className="op-eyebrow">МОЖЛИВОСТІ XELAY</p><h1>Твій наступний крок.<br /><em>Починається тут.</em></h1><p className="op-coming-description">Знаходь роботу, стажування та навчальні програми. Знайомся з перевіреними організаціями й обговорюй деталі прямо у Xelay.</p><div className="op-coming-cards"><article><BriefcaseBusiness size={26} /><h2>Робота й стажування</h2><p>Прозорі умови, окреме резюме та твій перший відгук.</p></article><article><BookOpen size={26} /><h2>Курси та програми</h2><p>Обирай напрям, знайомся з програмою й запитуй про навчання.</p></article><article><ShieldCheck size={26} /><h2>Спілкування напряму</h2><p>Ти вирішуєш, кому передавати контакт і резюме.</p></article></div><button type="button" className="op-button" onClick={() => setShowAuth(true)}>Увійти й переглянути можливості<ArrowUpRight size={18} /></button><Link to="/business" className="op-button op-button-secondary">Я представляю компанію або школу</Link></main>
}
