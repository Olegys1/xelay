import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Megaphone, RefreshCw, ShieldCheck } from 'lucide-react'
import { teachingDate, teachingError, type TeachingRepository } from '../../lib/teaching'
import type { TeachingAnnouncement } from '../../lib/teachingAudience'
import { TeachingButton } from './TeachingUI'

export function TeachingGroupAnnouncements({ repository, groupId, userId, courseId }: { repository: TeachingRepository; groupId: string; userId: string; courseId?: string }) {
  const source = repository.audiences
  const scopeKey = `${userId}:${groupId}:${courseId || '*'}`
  const [result, setResult] = useState<{ source: typeof source; scopeKey: string; items: TeachingAnnouncement[] } | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [ackBusy, setAckBusy] = useState('')
  const alive = useRef(true), ackLock = useRef(false), current = useRef({ source, scopeKey }); current.current = { source, scopeKey }
  const generation = useRef(0)
  const load = useCallback(async () => {
    if (!alive.current || current.current.source !== source || current.current.scopeKey !== scopeKey) return
    const request = ++generation.current
    if (!source) return
    const valid = () => alive.current && current.current.source === source && current.current.scopeKey === scopeKey && request === generation.current
    setLoading(true); setError('')
    try {
      const data = await source.messages(groupId)
      if (valid()) setResult({ source, scopeKey, items: data.announcements })
    } catch (failure) { if (valid()) setError(teachingError(failure)) }
    finally { if (valid()) setLoading(false) }
  }, [source, groupId, scopeKey])
  useEffect(() => { alive.current = true; setError(''); setAckBusy(''); ackLock.current = false; void load(); return () => { alive.current = false; generation.current++ } }, [load])
  async function acknowledge(item: TeachingAnnouncement) {
    if (!alive.current || ackLock.current || !source?.acknowledge || !item.notification_id || item.acknowledged_at || !item.requires_acknowledgement) return
    const captured = current.current
    if (captured.source !== source || captured.scopeKey !== scopeKey) return
    ackLock.current = true; setAckBusy(item.id); setError('')
    try {
      await source.acknowledge(item.notification_id, userId)
      if (!alive.current || current.current.source !== captured.source || current.current.scopeKey !== captured.scopeKey) return
      window.dispatchEvent(new CustomEvent('xelay-notifications-updated', { detail: { userId } }))
      await load()
    } catch (failure) { if (alive.current && current.current.source === captured.source && current.current.scopeKey === captured.scopeKey) setError(teachingError(failure)) }
    finally { if (alive.current && current.current.source === captured.source && current.current.scopeKey === captured.scopeKey) { ackLock.current = false; setAckBusy('') } }
  }
  if (!source) return null
  const items = result?.source === source && result.scopeKey === scopeKey ? result.items.filter(item => !courseId || item.course_id === courseId) : []
  if (!items.length && !error) return null
  return <section className="mb-5 rounded-2xl border border-primary/25 bg-primary/5 p-4 sm:p-5" aria-label="Повідомлення викладачів">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="inline-flex items-center gap-2 font-semibold"><Megaphone size={18} className="text-primary" />Повідомлення викладачів</h3><TeachingButton disabled={loading} onClick={() => void load()}><RefreshCw size={14} />Оновити</TeachingButton></div>
    {error && <p role="alert" className="teaching-error mb-3">{error}</p>}
    <div className="space-y-3">{items.map(item => <article key={item.id} className="rounded-xl border border-border bg-card p-4"><h4 className="break-words text-sm font-semibold">{item.title}</h4><p className="mt-1 text-xs text-muted-foreground">{item.author_name}{item.course_title ? ' · ' + item.course_title : ''} · {teachingDate(item.created_at, true)}{item.updated_at !== item.created_at ? ' · відредаговано ' + teachingDate(item.updated_at, true) : ''}</p><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>{item.requires_acknowledgement && <div className="mt-4 flex flex-wrap items-center gap-3"><span className="inline-flex items-center gap-1 text-xs font-semibold text-primary"><ShieldCheck size={14} />Обов’язкове повідомлення</span>{item.acknowledged_at ? <span className="inline-flex items-center gap-1 text-xs text-primary"><CheckCircle2 size={14} />Ознайомлення підтверджено · {teachingDate(item.acknowledged_at, true)}</span> : item.notification_id && source.acknowledge ? <TeachingButton primary busy={ackBusy === item.id} disabled={Boolean(ackBusy)} onClick={() => void acknowledge(item)}><CheckCircle2 size={15} />Ознайомився</TeachingButton> : <span className="text-xs text-muted-foreground">Це повідомлення для одержувачів обраних груп.</span>}</div>}</article>)}</div>
  </section>
}
