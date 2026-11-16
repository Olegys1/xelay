import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, Check, RefreshCw, X } from 'lucide-react'
import { listTeachingScheduleRequests, reviewTeachingScheduleRequest, type TeachingScheduleRequest } from '../../lib/teachingSchedule'
import { teachingDate, teachingError } from '../../lib/teaching'

export function ScheduleTeacherRequests({ groupId, currentUserId, onChanged }: { groupId: string; currentUserId: string; onChanged: () => Promise<void> | void }) {
  const [requests, setRequests] = useState<TeachingScheduleRequest[]>([]), [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [unavailable, setUnavailable] = useState(false)
  const scopeKey = `${groupId}:${currentUserId}`
  const scope = useRef(scopeKey)
  scope.current = scopeKey
  const generation = useRef(0), active = useRef(true), pending = useRef(false)
  const isCurrent = () => active.current && scope.current === scopeKey
  const load = useCallback(async () => {
    const token = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await listTeachingScheduleRequests(groupId)
      if (isCurrent() && token === generation.current) { setRequests(result.requests); setUnavailable(false) }
    } catch (failure) {
      if (active.current && token === generation.current) {
        setRequests([])
        if ((failure as { code?: string }).code === '42501') setUnavailable(true)
        else setError(teachingError(failure))
      }
    } finally { if (active.current && token === generation.current) setLoading(false) }
  }, [groupId, currentUserId])
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; generation.current++ } }, [load])
  async function review(request: TeachingScheduleRequest, approve: boolean) {
    if (!isCurrent() || pending.current || loading) return
    pending.current = true; setBusy(request.id); setError(''); setNotice('')
    try {
      const result = await reviewTeachingScheduleRequest(request.id, approve, currentUserId)
      if (!isCurrent()) return
      setNotice(result.status === 'stale' ? 'Розклад або права викладача змінилися. Заявка застаріла, попросіть надіслати нову.' : approve ? 'Зміну погоджено. Розклад групи й календар викладача оновлені.' : 'Заявку відхилено. Розклад залишився без змін.')
      await load()
      if (isCurrent() && result.status === 'approved') await onChanged()
    } catch (failure) { if (isCurrent()) setError(teachingError(failure)) }
    finally { pending.current = false; if (isCurrent()) setBusy('') }
  }
  if (unavailable) return null
  return <details className="rounded-2xl border border-primary/15 bg-primary/[0.025] p-4" open={requests.length > 0 || Boolean(error)}>
    <summary className="cursor-pointer text-sm font-semibold"><CalendarClock size={16} className="mr-2 inline" aria-hidden="true" />Зміни від викладачів{requests.length ? ` · ${requests.length}` : ''}</summary>
    <div className="mt-3 space-y-3"><p className="text-xs leading-relaxed text-muted-foreground">Посилання викладач оновлює одразу. Перенесення й скасування застосовуються тільки після погодження старостою або заступником з правом редагувати розклад.</p>
      <button type="button" disabled={Boolean(busy) || loading} onClick={() => void load()} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border px-3 text-sm disabled:opacity-50"><RefreshCw size={14} />{loading ? 'Завантажуємо…' : 'Оновити запити'}</button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
      {!loading && !requests.length && !error && <p className="text-sm text-muted-foreground">Нових запитів немає.</p>}
      {requests.map(request => <article key={request.id} className="space-y-3 rounded-xl border border-border bg-background p-3">
        <div><h3 className="font-semibold">{request.subject}</h3><p className="text-xs text-muted-foreground">{request.teacher_name} · {request.course_title}</p></div>
        <p className="text-sm">{teachingDate(request.lesson_date)} · {request.original_start.slice(0, 5)}–{request.original_end.slice(0, 5)}<br /><strong>{request.change_kind === 'cancel' ? 'Скасувати це заняття' : `Перенести на ${teachingDate(request.proposed_date!)} · ${request.proposed_start?.slice(0, 5)}–${request.proposed_end?.slice(0, 5)}`}</strong></p>
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{request.reason}</p>
        <p className="text-xs text-muted-foreground">Зміниться лише ця пара. Інші повторення, роботи й оцінки залишаться. Завдання та строки здачі автоматично не переносяться.</p>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(busy) || loading} onClick={() => void review(request, true)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"><Check size={15} />{busy === request.id ? 'Зберігаємо…' : 'Погодити зміну'}</button><button type="button" disabled={Boolean(busy) || loading} onClick={() => void review(request, false)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 text-sm disabled:opacity-50"><X size={15} />Відхилити</button></div>
      </article>)}
    </div>
  </details>
}
