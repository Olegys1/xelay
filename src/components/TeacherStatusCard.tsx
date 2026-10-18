import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BadgeCheck, BookOpen, Clock3, GraduationCap, Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { loadTeacherVerification, requestTeacherVerification, teacherVerificationError, type TeacherVerificationStatus } from '../lib/teacherVerification'
import { BadgeInfo } from './BadgeInfo'

export function TeacherBadge({ verified }: { verified?: boolean }) {
  return verified ? <BadgeInfo label="Викладач" description="Статус викладача цього акаунта перевірила й підтвердила команда Xelay. Навчальні дії доступні в межах підключених предметів і груп." className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 dark:text-sky-300"><BadgeCheck size={13} aria-hidden="true" />Викладач</BadgeInfo> : null
}

export function TeacherStatusCard({ onEditProfile, showWorkspaceLink = true }: { onEditProfile?: () => void; showWorkspaceLink?: boolean }) {
  const { authUser, xelayUser, refreshUser } = useAuth()
  const { notify } = useToast()
  const navigate = useNavigate()
  const fieldId = useId()
  const [status, setStatus] = useState<TeacherVerificationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [department, setDepartment] = useState('')
  const [position, setPosition] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const account = authUser?.id
  const accountRef = useRef(account)
  accountRef.current = account

  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setStatus(null)
    if (!account) { setLoading(false); return }
    void loadTeacherVerification().then((result) => {
      if (!active) return
      setStatus(result)
      setDepartment(result.request?.department || authUser?.user_metadata?.teacher_department || '')
      setPosition(result.request?.position || authUser?.user_metadata?.teacher_position || '')
      setNote(result.request?.note || '')
    }).catch(() => { if (active) setError('Не вдалося завантажити статус викладача. Спробуйте оновити.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [account, refresh])

  if (!account) return null
  const pending = status?.status === 'pending'
  const scopeChanged = Boolean(status?.scope_changed || status?.request && ['pending', 'approved'].includes(status.status)
    && (status.request.university_id !== xelayUser?.universityId || status.request.academic_unit_id !== xelayUser?.academicUnitId))
  const verified = status?.verified === true && !scopeChanged
  const canRequest = Boolean(status && (status.status === 'none' || status.status === 'rejected' || scopeChanged))
  const eligible = Boolean(xelayUser?.universityId && xelayUser?.academicUnitId)
  const refreshStatus = () => { setRefresh((value) => value + 1); void refreshUser() }
  const submit = async () => {
    if (lock.current || !eligible || department.trim().length < 2 || !canRequest) return
    lock.current = true; setSaving(true); setError('')
    try {
      await requestTeacherVerification(department, position, note)
      if (accountRef.current !== account) return
      setExpanded(false); setRefresh((value) => value + 1)
      notify({ id: 'teacher-request', tone: 'success', title: 'Заявку надіслано', description: 'Команда Xelay перевірить ваш статус викладача.' })
      await refreshUser()
    } catch (failure) { if (accountRef.current === account) setError(teacherVerificationError(failure)) }
    finally { lock.current = false; if (accountRef.current === account) setSaving(false) }
  }

  return <section className="xelay-card mb-6 overflow-hidden" aria-label="Статус викладача">
    <div className="flex items-start gap-3 p-4 sm:p-5">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${verified ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'bg-primary/5 text-primary'}`}>{pending ? <Clock3 size={20} /> : <GraduationCap size={20} />}</span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{verified ? 'Ваш статус викладача підтверджено' : pending ? 'Підтвердження викладача' : 'Викладаєте в університеті?'}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{verified ? `${status?.request?.department || 'Викладання'}${status?.request?.position ? ` · ${status.request.position}` : ''}` : pending ? 'Заявка на перевірці в команди Xelay. Після підтвердження створіть предмет і запросіть групу або прийміть запрошення старости. Натисніть «Оновити статус», щоб перевірити рішення.' : 'Додайте викладання до свого акаунта: власні групи, завдання, перевірка робіт і приватний журнал балів.'}</p>
        {scopeChanged && <p className="mt-2 rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed">Університет або факультет у профілі змінився. Підтвердьте статус для нового місця викладання.</p>}
        {(status?.status === 'rejected' || status?.status === 'revoked') && <p className="mt-2 rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed">{status.status === 'rejected' ? 'Заявку відхилено.' : 'Статус викладача відкликано.'} {status.request?.review_reason || (status.status === 'revoked' ? 'Зверніться до команди Xelay для уточнення.' : 'Уточніть інформацію та подайте нову заявку.')}</p>}
        {!loading && status && <div className="mt-3 flex flex-wrap gap-2">
          {verified && showWorkspaceLink && <button type="button" onClick={() => navigate({ to: '/teaching' })} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"><BookOpen size={16} />Перейти до викладання</button>}
          {pending && <button type="button" onClick={refreshStatus} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border px-4 py-2 text-xs"><RefreshCw size={14} />Оновити статус</button>}
          {canRequest && <button type="button" onClick={() => setExpanded((value) => !value)} className="min-h-10 rounded-full border border-border px-4 py-2 text-sm font-medium text-primary">{expanded ? 'Згорнути заявку' : 'Підтвердити статус викладача'}</button>}
        </div>}
      </div>
      {loading && <Loader2 size={18} className="shrink-0 animate-spin motion-reduce:animate-none" aria-label="Завантаження статусу" />}
    </div>
    {error && <div className="mx-4 mb-4 text-sm text-destructive" role="alert">{error}{!status && !loading && <button type="button" onClick={refreshStatus} className="ml-2 underline">Оновити</button>}</div>}
    {expanded && canRequest && <div onKeyDown={(event) => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); void submit() } }} className="space-y-3 border-t border-border bg-muted/20 p-4 sm:p-5">
      <p className="text-xs leading-relaxed text-muted-foreground">{xelayUser?.faculty || 'Університет і факультет беруться з вашого профілю.'} Заявка використовує збережені дані профілю. Дані перевірки бачать лише ви та адміністратори Xelay.</p>
      {!eligible && <div className="rounded-xl border border-border bg-background p-3 text-sm">Спочатку оберіть університет і факультет у профілі.{onEditProfile && <button type="button" onClick={onEditProfile} className="ml-2 text-primary underline">Налаштувати профіль</button>}</div>}
      <label htmlFor={`${fieldId}-department`} className="block text-sm font-medium">Кафедра <span className="text-destructive">*</span><input id={`${fieldId}-department`} name="teacher-department" value={department} onChange={(event) => setDepartment(event.target.value)} maxLength={180} disabled={saving} className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm" placeholder="Наприклад, кафедра економічної теорії" /></label>
      <label htmlFor={`${fieldId}-position`} className="block text-sm font-medium">Посада · необов’язково<input id={`${fieldId}-position`} name="teacher-position" value={position} onChange={(event) => setPosition(event.target.value)} maxLength={120} disabled={saving} className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm" placeholder="Доцент, асистент, професор…" /></label>
      <label htmlFor={`${fieldId}-note`} className="block text-sm font-medium">Інформація для підтвердження<textarea id={`${fieldId}-note`} name="teacher-verification-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1500} rows={3} disabled={saving} className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm" placeholder="Посилання на сторінку кафедри або інші дані, за якими команда може підтвердити ваш статус." /></label>
      <button type="button" onClick={() => void submit()} disabled={saving || !eligible || department.trim().length < 2} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />}{saving ? 'Надсилаємо…' : 'Надіслати заявку'}</button>
    </div>}
  </section>
}
