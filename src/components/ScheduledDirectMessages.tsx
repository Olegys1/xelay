import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Clock3, Loader2, Pencil, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { ChatDialog, chatButton, chatIcon, chatInput, chatPrimary } from './CommunityChatPrimitives'
import { chatRpc } from '../lib/chatSpaces'
import { participantMessageError } from '../lib/participantMessaging'
import { formatSafeDate } from '../lib/safeDates'

type Job = { id: string; body: string; scheduled_at: string; status: 'pending' | 'sent' | 'cancelled' | 'failed'; failure_code: string | null; attempts: number }
type ScheduleAttempt = { p_owner_id: string; p_job_id: string; p_conversation_id: string; p_body: string; p_scheduled_at: string; p_reply_to: string | null }
// Keep an ambiguous request when the dialog is closed; reopening verifies the
// same UUID instead of silently scheduling the same draft a second time.
const pendingAttempts = new Map<string, ScheduleAttempt>()
type Props = { userId: string; conversationId: string; initialBody: string; replyTo: string | null; hasFiles: boolean; onSaved: (body: string) => void; onClose: () => void }
const toLocalInput = (date: Date) => {
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const dateLabel = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' })
const statuses = { pending: 'Очікує відправки', sent: 'Надіслано', cancelled: 'Скасовано', failed: 'Не надіслано' }
const failures: Record<string, string> = { PARTICIPANT_EXPIRED: 'Підписка завершилась до часу відправки.', CONTACT_UNAVAILABLE: 'Контакт більше не доступний для відправки.', REPLY_UNAVAILABLE: 'Повідомлення для відповіді більше не доступне.', MESSAGE_REMOVED: 'Повідомлення вже видалене.', MESSAGE_CONFLICT: 'Не вдалося підтвердити відправку.', TEMPORARY_DELIVERY_FAILURE: 'Тимчасова помилка відправки.', OWNER_CANCELLED: 'Скасовано вами.' }

export function ScheduledDirectMessages({ userId, conversationId, initialBody, replyTo, hasFiles, onSaved, onClose }: Props) {
  const { isPremium, isLoading: billingLoading } = useBilling()
  const { notify } = useToast()
  const attemptKey = `${userId}:${conversationId}`
  const [body, setBody] = useState(() => pendingAttempts.get(attemptKey)?.p_body || initialBody)
  const [when, setWhen] = useState(() => toLocalInput(new Date(pendingAttempts.get(attemptKey)?.p_scheduled_at || Date.now() + 60 * 60 * 1000)))
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Job | null>(null)
  const [uncertain, setUncertain] = useState(() => pendingAttempts.has(attemptKey))
  const attempt = useRef<ScheduleAttempt | null>(pendingAttempts.get(attemptKey) || null)
  const alive = useRef(true)
  const sequence = useRef(0)
  const initialReply = useRef(replyTo)

  async function load() {
    const request = ++sequence.current
    try {
      const [runtime, pending, closed] = await Promise.all([
        supabase.rpc('xelay_participant_runtime_status'),
        supabase.from('scheduled_direct_messages').select('id,body,scheduled_at,status,failure_code,attempts').eq('owner_id', userId).eq('conversation_id', conversationId).eq('status', 'pending').order('scheduled_at', { ascending: true }).limit(50),
        supabase.from('scheduled_direct_messages').select('id,body,scheduled_at,status,failure_code,attempts').eq('owner_id', userId).eq('conversation_id', conversationId).neq('status', 'pending').order('updated_at', { ascending: false }).limit(20),
      ])
      if (runtime.error) throw runtime.error
      if (pending.error) throw pending.error
      if (closed.error) throw closed.error
      if (!alive.current || request !== sequence.current) return
      setReady(runtime.data?.scheduled_enabled === true)
      setJobs([...(pending.data || []), ...(closed.data || [])] as Job[])
    } catch (failure) { if (alive.current && request === sequence.current) { setReady(false); setError(participantMessageError(failure)) } }
    finally { if (alive.current && request === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true; void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => { alive.current = false; ++sequence.current; window.clearInterval(timer) }
  }, [userId, conversationId])

  async function save(event?: FormEvent) {
    event?.preventDefault()
    if (busy || (!uncertain && (!isPremium || !ready))) return
    setBusy('save'); setError('')
    try {
      const date = new Date(when)
      if (!uncertain && (!body.trim() || body.length > 5000 || !Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 60_000 || date.getTime() > Date.now() + 90 * 24 * 60 * 60 * 1000)) throw new Error('SCHEDULE_INVALID_INPUT')
      let saved: Job
      if (editing) {
        saved = await chatRpc<Job>('xelay_update_scheduled_direct_message', { p_job_id: editing.id, p_body: body.trim(), p_scheduled_at: date.toISOString() })
      } else {
        if (!attempt.current && pendingAttempts.size >= 20) throw new Error('SCHEDULE_CONFIRM_LIMIT')
        attempt.current ||= { p_owner_id: userId, p_job_id: crypto.randomUUID(), p_conversation_id: conversationId, p_body: body.trim(), p_scheduled_at: date.toISOString(), p_reply_to: initialReply.current }
        pendingAttempts.set(attemptKey, attempt.current)
        saved = await chatRpc<Job>('xelay_schedule_direct_message', attempt.current)
      }
      if (!alive.current) return
      const scheduledBody = attempt.current?.p_body || body.trim()
      attempt.current = null; pendingAttempts.delete(attemptKey); setUncertain(false); setEditing(null)
      if (saved.status === 'cancelled' || saved.status === 'failed') { setError('Цю відправку вже завершено без надсилання. Текст залишено у чернетці.'); await load(); return }
      setBody(''); initialReply.current = null
      if (!editing) onSaved(scheduledBody)
      notify({ tone: 'success', title: saved.status === 'sent' ? 'Вже надіслано' : 'Відкладено', description: saved.status === 'sent' ? 'Попередню відправку підтверджено без повторення.' : 'Повідомлення збережено для відправки у вибраний час.' })
      await load()
    } catch (failure) {
      if (!alive.current) return
      if (!editing && attempt.current) {
        // A timeout may hide a successful commit. Preserve the original UUID
        // and immutable request for verification instead of creating a duplicate.
        const { data, error: lookupError } = await supabase.from('scheduled_direct_messages').select('id,body,status').eq('owner_id', userId).eq('id', attempt.current.p_job_id).maybeSingle()
        if (!alive.current) return
        if (!lookupError && data) {
          const scheduledBody = attempt.current.p_body
          attempt.current = null; pendingAttempts.delete(attemptKey); setUncertain(false)
          if (data.status === 'cancelled' || data.status === 'failed') { setError('Цю відправку вже завершено без надсилання. Текст залишено у чернетці.'); await load(); return }
          setBody(''); initialReply.current = null; onSaved(scheduledBody); await load()
          notify({ tone: 'success', title: data.status === 'sent' ? 'Вже надіслано' : 'Відкладено', description: 'Збереження підтверджено. Повторного повідомлення не створено.' })
          return
        }
        // A definitive RPC error before insert is safe to correct; ambiguous
        // network failures retain the exact attempt until retried or dismissed.
        if ((failure as { code?: string }).code && !lookupError) { attempt.current = null; pendingAttempts.delete(attemptKey); setUncertain(false) }
        else setUncertain(true)
      }
      setError(participantMessageError(failure))
    } finally { if (alive.current) setBusy('') }
  }

  async function cancel(job: Job) {
    if (busy) return
    setBusy(job.id); setError('')
    try {
      await chatRpc('xelay_cancel_scheduled_direct_message', { p_job_id: job.id })
      if (alive.current) { if (editing?.id === job.id) { setEditing(null); setBody('') }; await load(); notify({ tone: 'success', title: 'Відправку скасовано' }) }
    } catch (failure) { if (alive.current) setError(participantMessageError(failure)) }
    finally { if (alive.current) setBusy('') }
  }

  return <ChatDialog title="Відкладені повідомлення" busy={Boolean(busy)} onClose={onClose}>
    <p className="mb-4 text-xs leading-relaxed text-muted-foreground">Текстові повідомлення в особистих чатах: від 1 хвилини до 90 днів уперед. Час відповідає часовому поясу вашого пристрою. Для відправки потрібні активний «Учасник» і прийнятий контакт.</p>
    {billingLoading || loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />Завантаження…</p> : !isPremium ? <div className="space-y-3"><p className="text-sm text-muted-foreground">Відкладені повідомлення доступні з підпискою «Учасник». Раніше заплановані можна скасувати нижче.</p><Link to="/subscription" className={chatPrimary} onClick={onClose}>Переглянути підписку</Link></div> : <>
      {!ready && <p role="status" className="mb-3 rounded-xl bg-muted p-3 text-xs text-muted-foreground">Відкладена відправка ще не підключена або тимчасово недоступна. Нові повідомлення зараз не плануються.</p>}
      {hasFiles && <p className="mb-3 text-xs text-muted-foreground">Вкладення залишаться у звичайній чернетці. Відкласти можна лише текст.</p>}
      <form onSubmit={(event) => void save(event)} className="space-y-3">
        <label className="block text-xs font-medium">{editing ? 'Змінити текст' : 'Текст повідомлення'}<textarea className={`${chatInput} mt-1 min-h-24 resize-y`} value={body} disabled={!ready || Boolean(busy) || uncertain} maxLength={5000} onChange={(event) => setBody(event.target.value)} /></label>
        <label className="block min-w-0 text-xs font-medium">Дата й час<input type="datetime-local" className={`${chatInput} mt-1`} value={when} disabled={!ready || Boolean(busy) || uncertain} min={toLocalInput(new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000))} max={toLocalInput(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000))} onChange={(event) => setWhen(event.target.value)} required /></label>
        {uncertain && <p role="status" className="text-xs text-muted-foreground">Збереження не підтверджено. Натисніть «Перевірити збереження»: ми повторимо ту саму операцію без дублювання.</p>}
        <div className="flex flex-wrap gap-2"><button className={chatPrimary} disabled={(!ready && !uncertain) || Boolean(busy) || (!body.trim() && !uncertain)}>{busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Clock3 size={15} />}{uncertain ? 'Перевірити збереження' : editing ? 'Зберегти зміни' : 'Відкласти'}</button>{editing && <button type="button" className={chatButton} disabled={Boolean(busy)} onClick={() => { setEditing(null); setBody('') }}>Скасувати редагування</button>}<button type="button" className={chatButton} disabled={Boolean(busy)} onClick={() => void load()}>Оновити</button></div>
      </form>
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {!isPremium && uncertain && <button type="button" className={`${chatButton} mt-3`} disabled={Boolean(busy)} onClick={() => void save()}>Перевірити попереднє збереження</button>}
    {jobs.length > 0 && <section className="mt-5 space-y-2" aria-label="Заплановані відправки"><h3 className="text-sm font-semibold">Ваші повідомлення в цьому чаті</h3>{jobs.map((job) => <article key={job.id} className="rounded-xl border border-border p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{formatSafeDate(job.scheduled_at, dateLabel)}</span><span className={`text-[11px] ${job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{statuses[job.status]}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm">{job.body}</p>{job.failure_code && <p className="mt-1 text-[11px] text-muted-foreground">{failures[job.failure_code] || 'Не вдалося підтвердити відправку.'}{job.status === 'pending' && ' Спробуємо автоматично ще раз.'}</p>}{job.status === 'pending' && <div className="mt-2 flex justify-end gap-1">{isPremium && ready && <button type="button" className={chatIcon} disabled={Boolean(busy) || uncertain} onClick={() => { setEditing(job); setBody(job.body); setWhen(toLocalInput(new Date(job.scheduled_at))); setError('') }} aria-label="Редагувати відкладене повідомлення"><Pencil size={15} /></button>}<button type="button" className={`${chatIcon} text-destructive`} disabled={Boolean(busy)} onClick={() => void cancel(job)} aria-label="Скасувати відкладену відправку"><Trash2 size={15} /></button></div>}</article>)}</section>}
    <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">Якщо підписка закінчиться до відправки, повідомлення буде скасоване. За тимчасового збою відправка може запізнитись; текст збережеться у цьому списку. Тут показано всі очікувані та 20 останніх завершених відправок.</p>
  </ChatDialog>
}
