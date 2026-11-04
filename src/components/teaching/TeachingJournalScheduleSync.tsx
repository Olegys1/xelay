import { useEffect, useRef, useState } from 'react'
import { CalendarDays, RefreshCw } from 'lucide-react'
import { teachingDate, teachingError, type TeachingJournalScheduleSync as SyncResult, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton } from './TeachingUI'

/** Mounted under an account/course/group key; never synchronizes student journals. */
export function TeachingJournalScheduleSync({ repository, userId, courseId, groupId, from, to, blocked, onRefresh }: {
  repository: TeachingRepository; userId: string; courseId: string; groupId: string; from: string; to: string; blocked: boolean; onRefresh: () => Promise<void>
}) {
  const [result, setResult] = useState<SyncResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const refresh = useRef(onRefresh); refresh.current = onRefresh
  const automatic = useRef(false)
  const [requested, setRequested] = useState(false)
  useEffect(() => {
    if (!automatic.current && !blocked) { automatic.current = true; setRequested(true) }
  }, [blocked])
  useEffect(() => {
    if (!requested || !repository.syncJournalSchedule) return
    let active = true
    setBusy(true); setError('')
    void repository.syncJournalSchedule(courseId, groupId, from, to, userId).then(async value => {
      if (!active) return
      setResult(value)
      if (value.created || value.linked || value.updated || value.retained) await refresh.current()
    }).catch(failure => { if (active) setError(teachingError(failure)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [repository, userId, courseId, groupId, from, to, requested, revision])
  if (!repository.syncJournalSchedule) return null
  return <section aria-label="Заняття з розкладу в журналі" className="teaching-note mb-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="flex items-center gap-2 font-semibold"><CalendarDays size={16} />Заняття з розкладу</p><p className="mt-1 text-xs">{teachingDate(from)} — {teachingDate(to)}. Колонки додаються автоматично; бали виставляєте й публікуєте ви.</p></div><TeachingButton busy={busy} disabled={blocked || busy} onClick={() => { setRequested(true); setRevision(value => value + 1) }}><RefreshCw size={14} />Оновити з розкладу</TeachingButton></div>
    {busy ? <p role="status" className="mt-2 text-xs">Звіряємо заняття з розкладом групи…</p> : error ? <p role="alert" className="mt-2 text-xs">{error} Збережені роботи й бали залишаються доступними. Повторіть оновлення.</p> : result && <p role="status" className="mt-2 text-xs">{result.created ? `Додано занять: ${result.created}. ` : 'Колонки звірено. '}{result.linked || result.represented ? 'Заняття, які вже мають завдання, враховані без зайвих колонок. ' : ''}{result.retained ? `Збережено колонок для змінених або прибраних пар: ${result.retained}. ` : ''}Особистий порядок колонок і попередні оцінки збережено.</p>}
    <p className="mt-2 text-xs">Максимум нової колонки береться з відповідного шаблону оцінювання. Без шаблону початковий максимум — 5 балів; його можна змінити в параметрах роботи.</p>
  </section>
}
