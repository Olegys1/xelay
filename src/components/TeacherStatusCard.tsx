import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BadgeCheck, BookOpen, Clock3, GraduationCap, Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { loadTeacherVerification, normalizeTeacherVerificationContact, requestTeacherVerification, savedTeacherVerificationContact, teacherVerificationError, type TeacherVerificationContact, type TeacherVerificationStatus } from '../lib/teacherVerification'
import { BadgeInfo } from './BadgeInfo'
import { TeacherAcademicProfileEditor, TeacherAcademicSettings } from './TeacherAcademicSettings'
import { emptyTeacherAcademicProfile, teacherPositionLabel, validateTeacherAcademicProfile } from '../lib/teacherAcademicProfile'
import { TeacherVerificationContactField } from './TeacherVerificationContact'
import { AcademicDepartmentSelect } from './AcademicDepartmentSelect'
import { academicDepartmentMatches } from '../lib/academicDepartments'

export function TeacherBadge({ verified }: { verified?: boolean }) {
  return verified ? <BadgeInfo label="Викладач" description="Статус викладача цього акаунта перевірила й підтвердила команда Xelay. Навчальні дії доступні в межах підключених предметів і груп." className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 dark:text-sky-300"><BadgeCheck size={13} aria-hidden="true" />Викладач</BadgeInfo> : null
}

export function TeacherStatusCard({ onEditProfile, showWorkspaceLink = true }: { onEditProfile?: () => void; showWorkspaceLink?: boolean }) {
  const { authUser, xelayUser, refreshUser } = useAuth()
  const { notify } = useToast()
  const navigate = useNavigate()
  const fieldId = useId()
  const [status, setStatus] = useState<TeacherVerificationStatus | null>(null)
  const [loadedAccount, setLoadedAccount] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [academicExpanded, setAcademicExpanded] = useState(false)
  const [department, setDepartment] = useState('')
  const [requestAcademic, setRequestAcademic] = useState(() => emptyTeacherAcademicProfile())
  const [note, setNote] = useState('')
  const [contact, setContact] = useState<TeacherVerificationContact>({ kind: 'telegram', value: '' })
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const submission = useRef(0)
  const account = authUser?.id
  const accountRef = useRef(account)
  accountRef.current = account

  useEffect(() => {
    let active = true
    submission.current += 1; lock.current = false
    setLoading(true); setSaving(false); setError(''); setStatus(null); setLoadedAccount(null); setContact({ kind: 'telegram', value: '' }); setExpanded(false)
    if (!account) { setLoading(false); return }
    void loadTeacherVerification().then((result) => {
      if (!active) return
      setStatus(result)
      setLoadedAccount(account)
      setDepartment(result.academic_profile?.department || result.request?.department || authUser?.user_metadata?.teacher_department || '')
      const legacyPosition = result.request?.position || authUser?.user_metadata?.teacher_position || ''
      setRequestAcademic(result.academic_profile || { ...emptyTeacherAcademicProfile(account), position_code: legacyPosition ? 'other' : '', position_other: legacyPosition })
      setNote(result.request?.note || '')
      setContact(savedTeacherVerificationContact(result.request))
    }).catch(() => { if (active) setError('Не вдалося завантажити статус викладача. Спробуйте оновити.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; submission.current += 1 }
  }, [account, refresh])

  if (!account) return null
  const pending = status?.status === 'pending'
  const scopeChanged = Boolean(status?.scope_changed || status?.request && ['pending', 'approved'].includes(status.status)
    && (status.request.university_id !== xelayUser?.universityId || status.request.academic_unit_id !== xelayUser?.academicUnitId))
  const verified = status?.verified === true && !scopeChanged
  const expired = verified && status?.has_current_access === false
  const academicPosition = status?.academic_profile ? teacherPositionLabel(status.academic_profile) : ''
  const canRequest = Boolean(status && loadedAccount === account && (status.status === 'none' || status.status === 'rejected' || scopeChanged))
  const eligible = Boolean(xelayUser?.universityId && xelayUser?.academicUnitId)
  const refreshStatus = () => { setRefresh((value) => value + 1); void refreshUser() }
  const submit = async () => {
    if (lock.current || !eligible || !canRequest) return
    if (!academicDepartmentMatches(department, requestAcademic.department_options || [])) { setError('Оберіть кафедру свого факультету.'); return }
    if (!normalizeTeacherVerificationContact(contact)) { setError(teacherVerificationError(new Error(contact.value.trim() ? 'TEACHER_REQUEST_CONTACT_INVALID' : 'TEACHER_REQUEST_CONTACT_REQUIRED'))); return }
    const validation = validateTeacherAcademicProfile(requestAcademic)
    if (validation) { setError(validation); return }
    const currentSubmission = ++submission.current
    lock.current = true; setSaving(true); setError('')
    try {
      await requestTeacherVerification(department, teacherPositionLabel(requestAcademic), note, { ...requestAcademic, department: department.trim() }, contact)
      if (accountRef.current !== account || submission.current !== currentSubmission) return
      setExpanded(false); setRefresh((value) => value + 1)
      notify({ id: 'teacher-request', tone: 'success', title: 'Заявку надіслано', description: 'Команда Xelay перевірить ваш статус викладача.' })
      await refreshUser()
    } catch (failure) { if (accountRef.current === account && submission.current === currentSubmission) setError(teacherVerificationError(failure)) }
    finally { if (submission.current === currentSubmission) { lock.current = false; if (accountRef.current === account) setSaving(false) } }
  }

  return <section className="xelay-card mb-6 overflow-hidden" aria-label="Статус викладача">
    <div className="flex items-start gap-3 p-4 sm:p-5">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${verified ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'bg-primary/5 text-primary'}`}>{pending ? <Clock3 size={20} /> : <GraduationCap size={20} />}</span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{verified ? 'Ваш статус викладача підтверджено' : pending ? 'Підтвердження викладача' : 'Викладаєте в університеті?'}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{verified ? `${status?.academic_profile?.department || status?.request?.department || 'Викладання'}${academicPosition || status?.request?.position ? ` · ${academicPosition || status?.request?.position}` : ''}${status?.academic_profile?.is_postgraduate ? ' · Аспірант' : ''}` : pending ? 'Заявка на перевірці в команди Xelay. Після підтвердження створіть предмет і запросіть групу або прийміть запрошення старости. Натисніть «Оновити статус», щоб перевірити рішення.' : 'Додайте викладання до свого акаунта: власні групи, завдання, перевірка робіт і приватний журнал балів.'}</p>
        {expired && <p className="mt-2 rounded-xl bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200">Погоджений строк викладання завершився. Історія оцінок і матеріалів збережена; для нових завдань та оцінювання запросіть продовження в налаштуваннях нижче.</p>}
        {scopeChanged && <p className="mt-2 rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed">Університет або факультет у профілі змінився. Підтвердьте статус для нового місця викладання.</p>}
        {(status?.status === 'rejected' || status?.status === 'revoked') && <p className="mt-2 rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed">{status.status === 'rejected' ? 'Заявку відхилено.' : 'Статус викладача відкликано.'} {status.request?.review_reason || (status.status === 'revoked' ? 'Зверніться до команди Xelay для уточнення.' : 'Уточніть інформацію та подайте нову заявку.')}</p>}
        {!loading && status && <div className="mt-3 flex flex-wrap gap-2">
          {verified && showWorkspaceLink && <button type="button" onClick={() => navigate({ to: '/teaching' })} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"><BookOpen size={16} />Перейти до викладання</button>}
          {pending && <button type="button" onClick={refreshStatus} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border px-4 py-2 text-xs"><RefreshCw size={14} />Оновити статус</button>}
          {canRequest && <button type="button" onClick={() => setExpanded((value) => !value)} className="min-h-10 rounded-full border border-border px-4 py-2 text-sm font-medium text-primary">{expanded ? 'Згорнути заявку' : 'Підтвердити статус викладача'}</button>}
          {(verified || pending || xelayUser?.accountType === 'teacher') && <button type="button" onClick={() => setAcademicExpanded((value) => !value)} className="min-h-10 rounded-full border border-border px-4 py-2 text-sm">{academicExpanded ? 'Згорнути налаштування' : 'Кафедра, посада та контакти'}</button>}
        </div>}
      </div>
      {loading && <Loader2 size={18} className="shrink-0 animate-spin motion-reduce:animate-none" aria-label="Завантаження статусу" />}
    </div>
    {error && <div className="mx-4 mb-4 text-sm text-destructive" role="alert">{error}{!status && !loading && <button type="button" onClick={refreshStatus} className="ml-2 underline">Оновити</button>}</div>}
    {academicExpanded && <div className="border-t border-border p-4 sm:p-5"><TeacherAcademicSettings accountId={account} onSaved={() => { setRefresh((value) => value + 1) }} /></div>}
    {expanded && canRequest && <div onKeyDown={(event) => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); void submit() } }} className="space-y-3 border-t border-border bg-muted/20 p-4 sm:p-5">
      <p className="text-xs leading-relaxed text-muted-foreground">{xelayUser?.faculty || 'Університет і факультет беруться з вашого профілю.'} Заявка використовує збережені дані профілю. Дані перевірки бачать лише ви та адміністратори Xelay.</p>
      {!eligible && <div className="rounded-xl border border-border bg-background p-3 text-sm">Спочатку оберіть університет і факультет у профілі.{onEditProfile && <button type="button" onClick={onEditProfile} className="ml-2 text-primary underline">Налаштувати профіль</button>}</div>}
      <AcademicDepartmentSelect id={`${fieldId}-department`} name="teacher-department" value={department} onChange={setDepartment} options={requestAcademic.department_options || []} disabled={saving || !eligible} required />
      <TeacherVerificationContactField id={`${fieldId}-contact`} value={contact} onChange={setContact} disabled={saving} reusableValue={contact.kind === 'telegram' ? requestAcademic.contact_telegram : requestAcademic.contact_phone} />
      <TeacherAcademicProfileEditor value={requestAcademic} onChange={setRequestAcademic} disabled={saving} />
      <label htmlFor={`${fieldId}-note`} className="block text-sm font-medium">Інформація для підтвердження<textarea id={`${fieldId}-note`} name="teacher-verification-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1500} rows={3} disabled={saving} className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm" placeholder="Посилання на сторінку кафедри або інші дані, за якими команда може підтвердити ваш статус." /></label>
      <button type="button" onClick={() => void submit()} disabled={saving || !eligible || department.trim().length < 2} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />}{saving ? 'Надсилаємо…' : 'Надіслати заявку'}</button>
    </div>}
  </section>
}
