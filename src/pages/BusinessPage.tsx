import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuth } from '../context/AuthContext'
import { CompanyAccountPanel } from '../components/opportunities/CompanyAccountPanel'
import { OpportunitiesProvider } from '../components/opportunities/OpportunitiesContext'
import { OrganizationWorkspace } from '../components/opportunities/OrganizationWorkspace'
import { createSupabaseOpportunitiesRepository } from '../lib/opportunities/supabaseRepository'
import '../components/opportunities/Opportunities.css'

export function BusinessPage() {
  const { authUser, businessAccount, isLoading, refreshUser, signOut, authReadEpoch } = useAuth()
  const [error, setError] = useState('')
  const repository = useMemo(() => createSupabaseOpportunitiesRepository(), [authUser?.id, authReadEpoch])
  async function leave() { try { setError(''); await signOut() } catch { setError('Не вдалося вийти. Спробуйте ще раз.') } }
  if (isLoading) return <main className="op-empty" role="status">Готуємо ваш кабінет…</main>
  if (!authUser) return <main className="op-business-entry"><Link to="/" className="org-wordmark">Xelay</Link><CompanyAccountPanel mode="supabase" onReady={() => { void refreshUser() }} /><Link to="/opportunities" className="op-button op-button-secondary">Шукаю роботу або навчання</Link></main>
  if (!businessAccount) return <main className="op-empty"><h1>Окремий кабінет організації</h1><p>Зараз ви увійшли в інший тип акаунта. Для компанії або навчальної школи створіть окремий обліковий запис.</p><Link to="/opportunities" className="op-button">До можливостей</Link><button type="button" className="op-button op-button-secondary" onClick={() => void leave()}>Вийти й увійти як організація</button>{error && <p role="alert">{error}</p>}</main>
  return <><OpportunitiesProvider key={`${authUser.id}:${authReadEpoch}`} repository={repository}><OrganizationWorkspace onSignOut={() => void leave()} /></OpportunitiesProvider>{error && <p className="op-toast" role="alert">{error}</p>}</>
}
