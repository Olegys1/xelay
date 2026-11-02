import { useCallback, useEffect, useRef, useState } from 'react'
import { Megaphone, RefreshCw } from 'lucide-react'
import { teachingDate, teachingError, type TeachingRepository } from '../../lib/teaching'
import type { TeachingAnnouncement } from '../../lib/teachingAudience'
import { TeachingButton } from './TeachingUI'

export function TeachingGroupAnnouncements({ repository, groupId, userId, courseId }: { repository: TeachingRepository; groupId: string; userId: string; courseId?: string }) {
  const source = repository.audiences
  const scopeKey = `${userId}:${groupId}`
  const [result, setResult] = useState<{ source: typeof source; scopeKey: string; items: TeachingAnnouncement[] } | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    if (!source) return
    setLoading(true); setError('')
    try {
      const data = await source.messages(groupId)
      if (request === generation.current) setResult({ source, scopeKey, items: data.announcements })
    } catch (failure) { if (request === generation.current) setError(teachingError(failure)) }
    finally { if (request === generation.current) setLoading(false) }
  }, [source, groupId, scopeKey])
  useEffect(() => { setError(''); void load(); return () => { generation.current++ } }, [load])
  if (!source) return null
  const items = result?.source === source && result.scopeKey === scopeKey ? result.items.filter(item => !courseId || item.course_id === courseId) : []
  if (!items.length && !error) return null
  return <section className="mb-5 rounded-2xl border border-primary/25 bg-primary/5 p-4 sm:p-5" aria-label="Повідомлення викладачів">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="inline-flex items-center gap-2 font-semibold"><Megaphone size={18} className="text-primary" />Повідомлення викладачів</h3><TeachingButton disabled={loading} onClick={() => void load()}><RefreshCw size={14} />Оновити</TeachingButton></div>
    {error && <p role="alert" className="teaching-error mb-3">{error}</p>}
    <div className="space-y-3">{items.map(item => <article key={item.id} className="rounded-xl border border-border bg-card p-4"><h4 className="break-words text-sm font-semibold">{item.title}</h4><p className="mt-1 text-xs text-muted-foreground">{item.author_name}{item.course_title ? ' · ' + item.course_title : ''} · {teachingDate(item.created_at, true)}{item.updated_at !== item.created_at ? ' · відредаговано ' + teachingDate(item.updated_at, true) : ''}</p><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p></article>)}</div>
  </section>
}
