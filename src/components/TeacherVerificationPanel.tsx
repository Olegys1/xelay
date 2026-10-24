import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { BadgeCheck, GraduationCap, Loader2, RefreshCw, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import { loadTeacherVerification, reviewTeacherVerification, teacherVerificationError, type TeacherVerificationRequest } from '../lib/teacherVerification'
import { reviewTeacherAcademicPeriod, teacherPositionLabel } from '../lib/teacherAcademicProfile'
import { TeacherAcademicApproval } from './TeacherAcademicSettings'

const STATUS_LABEL = { pending: 'Очікує перевірки', approved: 'Підтверджено', rejected: 'Відхилено', revoked: 'Відкликано' }

export function TeacherVerificationPanel() {
  const { authUser, xelayUser, refreshUser } = useAuth()
  const { notify } = useToast()
  const [requests, setRequests] = useState<TeacherVerificationRequest[]>([])
  const [scopeNames, setScopeNames] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<'pending' | 'periods' | 'approved' | 'history'>('pending')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [decision, setDecision] = useState<{ request: TeacherVerificationRequest; status: 'approved' | 'rejected' | 'revoked' } | null>(null)
  const [reason, setReason] = useState('')
  const [approvedUntil, setApprovedUntil] = useState('')
  const [periodDecision, setPeriodDecision] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const account = authUser?.id
  const accountRef = useRef(account)
  accountRef.current = account

  useEffect(() => {
    let active = true
    setRequests([]); setLoading(true); setError(''); setDecision(null)
    if (!account || !xelayUser?.isPlatformAdmin) { setLoading(false); return }
    void loadTeacherVerification().then(async (result) => {
      if (!active) return
      setRequests(result.requests)
      const universityIds = [...new Set(result.requests.map((request) => request.university_id))]
      const unitIds = [...new Set(result.requests.map((request) => request.academic_unit_id))]
      const [universities, units] = await Promise.all([
        universityIds.length ? supabase.from('universities').select('id,name').in('id', universityIds) : Promise.resolve({ data: [] }),
        unitIds.length ? supabase.from('academic_units').select('id,name').in('id', unitIds) : Promise.resolve({ data: [] }),
      ])
      if (active) setScopeNames(Object.fromEntries([...(universities.data || []), ...(units.data || [])].map((row) => [row.id, row.name])))
    }).catch(() => { if (active) setError('Не вдалося завантажити заявки викладачів. Оновіть список.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [account, xelayUser?.isPlatformAdmin, refresh])

  if (!xelayUser?.isPlatformAdmin) return null
  const pendingCount = requests.filter((request) => request.status === 'pending').length
  const periodCount = requests.filter((request) => request.status === 'approved' && request.academic_profile?.access_period_pending).length
  const visible = requests.filter((request) => filter === 'periods' ? request.status === 'approved' && request.academic_profile?.access_period_pending : filter === 'history' ? ['rejected', 'revoked'].includes(request.status) : request.status === filter)
  const submit = async () => {
    if (!decision || !account || lock.current || (decision.status !== 'approved' && !reason.trim())) return
    lock.current = true; setSaving(true); setError('')
    try {
      await reviewTeacherVerification(decision.request.id, decision.status, reason, approvedUntil || null, decision.request.academic_profile?.updated_at, account)
      if (accountRef.current !== account) return
      notify({ id: 'teacher-review', title: decision.status === 'approved' ? 'Викладача підтверджено' : decision.status === 'rejected' ? 'Заявку відхилено' : 'Статус відкликано', tone: 'success' })
      setDecision(null); setRefresh((value) => value + 1)
      if (decision.request.user_id === account) await refreshUser()
    } catch (failure) { if (accountRef.current === account) setError(teacherVerificationError(failure)) }
    finally { lock.current = false; if (accountRef.current === account) setSaving(false) }
  }

  return <section className="xelay-card mb-6 overflow-hidden" aria-label="Підтвердження викладачів">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
      <div><h2 className="flex items-center gap-2 font-semibold"><GraduationCap size={19} className="text-primary" />Підтвердження викладачів{pendingCount + periodCount > 0 && <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs text-white">{pendingCount + periodCount}</span>}</h2><p className="mt-1 text-xs text-muted-foreground">Перевірте зв’язок людини з кафедрою перед наданням доступу до викладання.</p></div>
      <button type="button" disabled={loading || saving} onClick={() => setRefresh((value) => value + 1)} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border px-3 py-2 text-xs disabled:opacity-50"><RefreshCw size={14} />Оновити</button>
    </header>
    <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3" aria-label="Фільтр заявок">
      {([['pending', 'На перевірці'], ['periods', 'Строки'], ['approved', 'Підтверджені'], ['history', 'Історія']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setDecision(null); setPeriodDecision(null); setError('') }} disabled={saving} className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-sm ${filter === value ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{label}{value === 'periods' && periodCount > 0 && <span className={`rounded-full px-2 py-0.5 text-xs ${filter === value ? 'bg-primary-foreground/20' : 'bg-amber-500/15 text-amber-800 dark:text-amber-200'}`}>{periodCount}</span>}</button>)}
    </div>
    {error && <p role="alert" className="m-4 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    {filter !== 'periods' && periodCount > 0 && <button type="button" onClick={() => { setFilter('periods'); setDecision(null); setError('') }} disabled={saving} className="mx-4 mt-4 rounded-xl bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-900 dark:text-amber-100">Потребують рішення запити на строк викладання: {periodCount}. Відкрити «Строки».</button>}
    {loading ? <div className="flex min-h-28 items-center justify-center"><Loader2 className="animate-spin motion-reduce:animate-none" aria-label="Завантаження заявок" /></div> : !visible.length ? <p className="p-5 text-sm text-muted-foreground">{filter === 'pending' ? 'Нових заявок викладачів немає.' : filter === 'periods' ? 'Запитів на зміну строку викладання немає.' : 'Заявок у цьому списку поки немає.'}</p> : <div className="divide-y divide-border">
      {visible.map((request) => <article key={request.id} className="space-y-3 px-5 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><Link to="/user/$id" params={{ id: request.user_id }} className="font-semibold text-primary hover:underline">{request.full_name || 'Відкрити профіль'}</Link><p className="mt-1 text-sm">{scopeNames[request.academic_unit_id] || 'Факультет'} · {request.department}</p><p className="mt-0.5 text-xs text-muted-foreground">{scopeNames[request.university_id] || 'Університет'}{request.position ? ` · ${request.position}` : ''}{request.academic_profile?.is_postgraduate ? ' · Аспірант' : ''}</p>{request.academic_profile?.position_code && <p className="mt-1 text-xs text-muted-foreground">Посада: {teacherPositionLabel({ position_code: request.academic_profile.position_code, position_other: request.academic_profile.position_other || '' })}</p>}<p className="mt-2 text-xs text-muted-foreground">{STATUS_LABEL[request.status]} · {new Date(request.created_at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}</p>{request.academic_profile?.access_period_pending && <p className="mt-2 text-xs font-medium text-primary">Потрібно погодити зміну строку викладання</p>}{request.academic_profile?.access_expired && <p className="mt-2 text-xs text-destructive">Погоджений строк завершився</p>}</div>
          {request.status === 'pending' && request.user_id !== account && <div className="flex flex-wrap gap-2"><button type="button" disabled={saving} onClick={() => { setDecision({ request, status: 'approved' }); setApprovedUntil((request.academic_profile?.access_period_pending ? request.academic_profile.requested_valid_until : request.academic_profile?.approved_valid_until) || ''); setReason(''); setError('') }} className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"><BadgeCheck size={15} />Підтвердити</button><button type="button" disabled={saving} onClick={() => { setDecision({ request, status: 'rejected' }); setReason(''); setError('') }} className="min-h-10 rounded-full border border-border px-4 py-2 text-sm">Відхилити</button></div>}
          {request.status === 'approved' && request.user_id !== account && <div className="flex flex-wrap gap-2"><button type="button" disabled={saving} onClick={() => setPeriodDecision((value) => value === request.id ? null : request.id)} className="min-h-10 rounded-full border border-border px-4 py-2 text-xs">Строк викладання</button><button type="button" disabled={saving} onClick={() => { setDecision({ request, status: 'revoked' }); setReason(''); setError('') }} className="min-h-10 rounded-full border border-border px-4 py-2 text-xs text-destructive">Відкликати статус</button></div>}
          {request.user_id === account && <p className="text-xs text-muted-foreground">Вашу заявку розглядає інший адміністратор.</p>}
        </div>
        {request.note && <div className="rounded-xl bg-muted/40 p-3 text-sm"><p className="mb-1 text-xs font-medium text-muted-foreground">Інформація для перевірки</p><p className="whitespace-pre-wrap break-words">{request.note}</p></div>}
        {request.review_reason && <p className="text-xs text-muted-foreground">Причина рішення: {request.review_reason}</p>}
        {(periodDecision === request.id || filter === 'periods') && request.user_id !== account && <TeacherAcademicApproval requestedUntil={request.academic_profile?.requested_valid_until || null} approvedUntil={request.academic_profile?.approved_valid_until || null} pending={Boolean(request.academic_profile?.access_period_pending)} saving={saving} onApprove={async (until) => {
          if (!account || lock.current) return
          lock.current = true; setSaving(true)
          try {
            await reviewTeacherAcademicPeriod(request.user_id, until, request.academic_profile?.updated_at, account)
            if (accountRef.current !== account) return
            setPeriodDecision(null); setRefresh((value) => value + 1)
            notify({ id: 'teacher-period-review', title: 'Строк викладання погоджено', tone: 'success' })
          } finally { lock.current = false; if (accountRef.current === account) setSaving(false) }
        }} />}
        {decision?.request.id === request.id && <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{decision.status === 'approved' ? 'Надати підтверджений статус викладача?' : decision.status === 'rejected' ? 'Відхилити заявку?' : 'Відкликати доступ до викладання?'}</p><button type="button" disabled={saving} onClick={() => setDecision(null)} aria-label="Скасувати рішення" className="p-1"><X size={17} /></button></div>
          {decision.status === 'revoked' && <p className="text-xs leading-relaxed text-muted-foreground">Доступ до предметів і журналів буде закрито. Навчальні записи та історія оцінювання збережуться.</p>}
          {decision.status === 'approved' && <label className="block text-sm">Погоджений строк викладання · необов’язково<input type="date" value={approvedUntil} onChange={(event) => setApprovedUntil(event.target.value)} disabled={saving} className="mt-1.5 block min-h-11 w-full max-w-xs rounded-xl border border-border bg-background px-3 text-sm" /><span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">Запитана дата: {request.academic_profile?.requested_valid_until || 'без обмеження'}. Порожнє поле погоджує доступ без кінцевої дати. Аспірантура не встановлює строк автоматично.</span></label>}
          <label htmlFor={`teacher-review-${request.id}`} className="block text-sm">{decision.status === 'approved' ? 'Коментар · необов’язково' : 'Причина, яку побачить заявник'}<textarea id={`teacher-review-${request.id}`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1500} rows={2} disabled={saving} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" /></label>
          <button type="button" disabled={saving || (decision.status !== 'approved' && !reason.trim())} onClick={() => void submit()} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />}{saving ? 'Зберігаємо…' : 'Зберегти рішення'}</button>
        </div>}
      </article>)}
    </div>}
  </section>
}
