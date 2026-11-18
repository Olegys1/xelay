import { useEffect, useMemo, useState } from 'react'
import { FlaskConical, RotateCcw, Moon, Sun, Plus, Smartphone, Monitor } from 'lucide-react'
import type { OrganizationKind, WorkspaceRole } from '../../lib/opportunities/types'
import { createLocalOpportunitiesRepository, resetLocalOpportunities } from '../../lib/opportunities/localRepository'
import { newOrganization } from '../../lib/opportunities/organizations'
import { OpportunitiesProvider } from './OpportunitiesContext'
import { OpportunitiesWorkspace } from './OpportunitiesWorkspace'
import { CompanyAccountPanel } from './CompanyAccountPanel'
import './Opportunities.css'
import './OrganizationWorkspace.css'

const profileSeed = { name: 'Олександра Коваль', education: 'КНУ імені Тараса Шевченка · Економічний факультет · бакалаврат · 2 курс', city: 'Київ', skills: ['Excel', 'Аналіз даних', 'Англійська B2'] }
const PREVIEW_SESSION = 'xelay-business-preview-session-v1'
function previousSession() {
  try { const saved = JSON.parse(sessionStorage.getItem(PREVIEW_SESSION) || '{}'); return { role: ['student', 'company', 'school', 'admin'].includes(saved.role) ? saved.role as WorkspaceRole : 'company' as WorkspaceRole, fresh: saved.fresh === true } } catch { return { role: 'company' as WorkspaceRole, fresh: false } }
}
export function LocalOpportunitiesPreview() {
  const [session, setSession] = useState(previousSession)
  const embedded = new URLSearchParams(location.search).get('embedded') === '1'
  const [phone, setPhone] = useState(false)
  const [registration, setRegistration] = useState(new URLSearchParams(location.search).get('registration') === '1')
  const [revision, setRevision] = useState(0)
  const [reset, setReset] = useState(false)
  const [dark, setDark] = useState(new URLSearchParams(location.search).get('dark') === '1')
  const [error, setError] = useState('')
  const repository = useMemo(() => createLocalOpportunitiesRepository(session.role, false, session.fresh), [session, revision])
  useEffect(() => { sessionStorage.setItem(PREVIEW_SESSION, JSON.stringify(session)) }, [session])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); document.title = 'Xelay · Компанії та школи — локальний перегляд'; return () => document.documentElement.classList.remove('dark') }, [dark])
  useEffect(() => { const visibility = () => document.querySelectorAll('.org-shell').forEach(el => el.setAttribute('data-paused', String(document.hidden))); document.addEventListener('visibilitychange', visibility); return () => document.removeEventListener('visibilitychange', visibility) }, [])
  async function registered(profile?: { kind: OrganizationKind; fullName: string; companyName: string; email: string }) {
    if (!profile) return
    setError('')
    try {
      const next = createLocalOpportunitiesRepository(profile.kind, false, true)
      const data = await next.load()
      if (!data.actor.companyIds.length) await next.execute({ type: 'company.save', company: newOrganization(data.actor.id, profile.kind, { name: profile.companyName || 'Нова організація', contactName: profile.fullName || 'Представник', contactEmail: profile.email }) })
      setSession({ role: profile.kind, fresh: true }); setRegistration(false); setRevision(v => v + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не вдалося підготувати кабінет.') }
  }
  return <>{!embedded && <header className="op-preview-bar"><div className="op-preview-label"><FlaskConical size={15} /><strong>Локальний перегляд</strong></div><label className="op-sr-only" htmlFor="preview-role">Роль перегляду</label><select id="preview-role" value={`${session.fresh ? 'new-' : ''}${session.role}`} onChange={e => { setSession({ role: e.target.value.replace('new-', '') as WorkspaceRole, fresh: e.target.value.startsWith('new-') }); setRegistration(false) }}><option value="company">Компанія · Обрій</option><option value="school">Школа · Вектор</option><option value="student">Студент</option><option value="admin">Модератор</option><option value="new-company">Моя нова компанія</option><option value="new-school">Моя нова школа</option></select><button onClick={() => setRegistration(!registration)}><Plus size={14} />{registration ? 'До кабінету' : 'Нова реєстрація'}</button><button onClick={() => setPhone(!phone)} aria-pressed={phone}>{phone ? <Monitor size={14} /> : <Smartphone size={14} />}{phone ? 'Комп’ютер' : 'Телефон'}</button><button aria-label={dark ? 'Світла тема' : 'Темна тема'} onClick={() => setDark(!dark)}>{dark ? <Sun size={14} /> : <Moon size={14} />}</button><button aria-label="Скинути локальний приклад" onClick={() => setReset(!reset)}><RotateCcw size={14} /></button>{reset && <div className="op-preview-reset" role="alert"><span>Скинути лише вигадані дані цього перегляду?</span><button onClick={async () => { try { await resetLocalOpportunities(); setReset(false); setRevision(v => v + 1); setSession({ role: 'company', fresh: false }); setError('') } catch { setError('Не вдалося скинути приклад.') } }}>Скинути</button><button onClick={() => setReset(false)}>Залишити</button></div>}</header>}<div className="op-preview-intro">Вигадані дані · збереження лише у цьому браузері · без листів, оплат і змін робочого Xelay</div>{error && <p role="alert" className="org-error">{error}</p>}{phone && !embedded ? <div className="org-phone-preview"><iframe key={`${session.role}-${session.fresh}-${revision}-${dark}-${registration}`} title="Мобільний перегляд кабінету" src={`${location.pathname}?embedded=1&dark=${dark ? 1 : 0}&registration=${registration ? 1 : 0}`} /></div> : registration ? <div className="op-workspace"><CompanyAccountPanel mode="local" onReady={profile => void registered(profile)} onClose={() => setRegistration(false)} /></div> : <OpportunitiesProvider repository={repository} profileSeed={session.role === 'student' ? profileSeed : null}><OpportunitiesWorkspace /></OpportunitiesProvider>}</>
}
