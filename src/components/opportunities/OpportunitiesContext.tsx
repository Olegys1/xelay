import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { OpportunitiesRepository, WorkspaceCommand, WorkspaceSnapshot, CareerFile } from '../../lib/opportunities/types'

export type CareerView = 'opportunities' | 'companies' | 'saved' | 'resume' | 'applications' | 'company' | 'admin' | 'candidates'
export interface ProfileSeed { name: string; education: string; city: string; skills: string[] }
interface WorkspaceContextValue {
  data: WorkspaceSnapshot; busy: boolean; execute: (command: WorkspaceCommand) => Promise<boolean>;
  upload: (file: File, kind: CareerFile['kind']) => Promise<CareerFile>; fileUrl: (file: CareerFile) => Promise<string>;
  toast: (message: string) => void; profileSeed: ProfileSeed | null; view: CareerView; setView: (view: CareerView) => void;
  selectedOpportunityId: string | null; setSelectedOpportunityId: (id: string | null) => void;
  setConversation: (id: string | null) => void;
}
const Context = createContext<WorkspaceContextValue | null>(null)
export function useOpportunities() { const value = useContext(Context); if (!value) throw new Error('OpportunitiesProvider required'); return value }
export function OpportunitiesProvider({ repository, profileSeed = null, children }: { repository: OpportunitiesRepository; profileSeed?: ProfileSeed | null; children: ReactNode }) {
  const [data, setData] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('')
  const [view, setView] = useState<CareerView>('opportunities'); const [selectedOpportunityId, setSelectedOpportunityId] = useState<string | null>(null)
  const generation = useRef(0); const locked = useRef(false); const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mutation = useRef(0)
  const [conversation, setConversation] = useState<string | null>(null)
  useEffect(() => {
    if (!conversation || !repository.conversation) return
    let active = true; let reading = false; let controller: AbortController | null = null
    const refresh = async () => {
      if (!active || reading || locked.current || document.hidden) return
      reading = true; controller = new AbortController()
      const boundary = generation.current, version = mutation.current
      const timeout = window.setTimeout(() => controller?.abort(), 10000)
      try {
        const item = await repository.conversation!(conversation, controller.signal)
        if (active && boundary === generation.current && version === mutation.current && !locked.current) {
          setData(previous => previous ? { ...previous, applications: item
            ? previous.applications.map(row => row.id === item.id ? item : row)
            : previous.applications.filter(row => row.id !== conversation) } : previous)
        }
      } catch { /* A lost connection must not erase a composed message. */ }
      finally { clearTimeout(timeout); reading = false }
    }
    const visibility = () => { if (document.hidden) controller?.abort(); else void refresh() }
    const interval = window.setInterval(() => void refresh(), 8000)
    document.addEventListener('visibilitychange', visibility); void refresh()
    return () => { active = false; controller?.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', visibility) }
  }, [conversation, repository])
  const toast = useCallback((text: string) => { setMessage(text); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setMessage(''), 4500) }, [])
  useEffect(() => { const current = ++generation.current; setData(null); setError(''); setMessage(''); locked.current = false; setBusy(false); setView('opportunities'); const linkedId = new URLSearchParams(window.location.search).get('opportunity'); setSelectedOpportunityId(linkedId && /^[0-9a-f-]{36}$/i.test(linkedId) ? linkedId : null)
    void repository.load().then(result => { if (current === generation.current) { setData(result); setView(linkedId ? 'opportunities' : ['company', 'school'].includes(result.actor.role) ? 'company' : result.actor.role === 'admin' ? 'admin' : 'opportunities') } }).catch(reason => { if (current === generation.current) setError(reason instanceof Error ? reason.message : 'Не вдалося завантажити розділ.') })
    return () => { generation.current += 1; if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [repository])
  useEffect(() => {
    let active = true; let reading = false
    const refresh = async () => {
      if (reading || locked.current || document.visibilityState === 'hidden') return
      reading = true; const current = generation.current; const version = mutation.current
      try { const result = await repository.load(); if (active && current === generation.current && version === mutation.current && !locked.current) setData(result) }
      catch { /* Keep the last saved snapshot; explicit actions still report failures. */ }
      finally { reading = false }
    }
    const storage = (event: StorageEvent) => { if (repository.mode === 'local' && event.key?.startsWith('xelay-opportunities-preview-')) void refresh() }
    const focus = () => { void refresh() }
    window.addEventListener('storage', storage); window.addEventListener('focus', focus)
    return () => { active = false; window.removeEventListener('storage', storage); window.removeEventListener('focus', focus) }
  }, [repository])
  const execute = useCallback(async (command: WorkspaceCommand) => {
    if (locked.current) return false; locked.current = true; mutation.current += 1; setBusy(true); const current = generation.current
    try { const result = await repository.execute(command); if (current !== generation.current) return false; setData(result); return true }
    catch (reason) { if (current === generation.current) toast(reason instanceof Error ? reason.message : 'Не вдалося зберегти зміни.'); return false }
    finally { if (current === generation.current) { locked.current = false; setBusy(false) } }
  }, [repository, toast])
  if (error) return <section className="op-empty" role="alert"><h2>Розділ поки недоступний</h2><p>{error}</p><button className="op-button" onClick={() => window.location.reload()}>Спробувати ще раз</button></section>
  if (!data) return <div className="op-skeleton" role="status" aria-label="Завантаження можливостей"><div /><div /><div /></div>
  return <Context.Provider value={{ data, busy, execute, upload: (file, kind) => repository.upload(file, kind), fileUrl: file => repository.fileUrl(file), toast, profileSeed, view, setView, selectedOpportunityId, setSelectedOpportunityId, setConversation }}>{children}{message && <div className="op-toast" role="status">{message}<button aria-label="Закрити повідомлення" onClick={() => setMessage('')}>×</button></div>}</Context.Provider>
}
