import { useEffect, useId, useRef, useState } from 'react'
import { CalendarClock, Check, Eye, GraduationCap, Loader2, ShieldCheck } from 'lucide-react'
import {
  emptyTeacherAcademicProfile, supabaseTeacherAcademicRepository, teacherAcademicProfileError,
  TEACHER_POSITION_OPTIONS, validateTeacherAcademicProfile,
  type TeacherAcademicProfile, type TeacherAcademicRepository, type TeacherPositionCode,
} from '../lib/teacherAcademicProfile'
import { AcademicDepartmentSelect } from './AcademicDepartmentSelect'

type EditorProps = {
  value: TeacherAcademicProfile
  onChange(value: TeacherAcademicProfile): void
  disabled?: boolean
  showContacts?: boolean
  showDepartment?: boolean
}
export function TeacherAcademicProfileEditor({ value, onChange, disabled = false, showContacts = true, showDepartment = false }: EditorProps) {
  const id = useId()
  const update = (patch: Partial<TeacherAcademicProfile>) => onChange({ ...value, ...patch })
  const input = 'mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-60'
  return <div className="space-y-5">
    {showDepartment && <AcademicDepartmentSelect id={`${id}-department`} name="teacher-profile-department" value={value.department} onChange={department => update({ department })} options={value.department_options || []} disabled={disabled} />}
    <div className="grid gap-4 sm:grid-cols-2">
      <label htmlFor={`${id}-position`} className="block text-sm font-medium">Посада · необов’язково<select id={`${id}-position`} value={value.position_code} disabled={disabled} onChange={(event) => update({ position_code: event.target.value as TeacherPositionCode })} className={input}>{TEACHER_POSITION_OPTIONS.map((position) => <option key={position.value} value={position.value}>{position.label}</option>)}</select></label>
      {value.position_code === 'other' && <label htmlFor={`${id}-other`} className="block text-sm font-medium">Назва посади<input id={`${id}-other`} value={value.position_other} onChange={(event) => update({ position_other: event.target.value })} maxLength={120} disabled={disabled} className={input} placeholder="Вкажіть свою посаду" /></label>}
    </div>
    <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm"><input type="checkbox" checked={value.is_postgraduate} onChange={(event) => update({ is_postgraduate: event.target.checked })} disabled={disabled} className="mt-0.5 h-4 w-4 accent-primary" /><span><span className="font-medium">Навчаюся в аспірантурі</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Це окрема від посади ознака. Вона не встановлює строк викладання автоматично.</span></span></label>
    <div className="rounded-2xl border border-border bg-muted/20 p-4">
      <button type="button" aria-pressed={!value.requested_valid_until} onClick={() => update({ requested_valid_until: null })} disabled={disabled} className={`mb-3 min-h-10 rounded-full border px-4 py-2 text-sm font-medium disabled:opacity-50 ${!value.requested_valid_until ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'}`}>Без обмеження строку</button>
      <label htmlFor={`${id}-until`} className="block text-sm font-medium">Запитуваний строк викладання · необов’язково<input id={`${id}-until`} type="date" value={value.requested_valid_until || ''} onChange={(event) => update({ requested_valid_until: event.target.value || null })} disabled={disabled} className={`${input} max-w-xs`} /></label>
      <p role="status" className="mt-2 text-sm font-medium text-primary">Обрано: {value.requested_valid_until ? `до ${value.requested_valid_until}` : 'без обмеження строку'}.</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Оберіть «Без обмеження строку» або вкажіть кінцеву дату. Зміну строку погоджує адміністрація; збереження профілю не подовжує чинний доступ.</p>
      {value.approved_valid_until && <p className={`mt-2 text-sm ${value.access_expired ? 'text-destructive' : 'text-muted-foreground'}`}>{value.access_expired ? 'Строк викладання завершився' : 'Доступ погоджено'} до {new Date(`${value.approved_valid_until}T12:00:00Z`).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}. Історія оцінок і матеріалів зберігається.</p>}
      {value.access_period_pending && <p className="mt-2 text-xs text-primary">Запит на зміну строку очікує рішення адміністрації.</p>}
    </div>
    {showContacts && <fieldset className="space-y-4 rounded-2xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold">Контакти для студентів · необов’язково</legend>
      <p className="text-xs leading-relaxed text-muted-foreground">Кожен контакт прихований, доки ви самі не дозволите його показ. Пошта для входу не публікується. Налаштування для груп і відкритого профілю незалежні.</p>
      {([
        ['email', 'Контактна пошта', 'email', 'teacher@example.com'],
        ['phone', 'Телефон', 'tel', '+380…'],
        ['telegram', 'Telegram', 'text', '@username'],
      ] as const).map(([kind, label, type, placeholder]) => <div key={kind} className="space-y-2 rounded-xl bg-muted/30 p-3">
        <label htmlFor={`${id}-${kind}`} className="block text-sm font-medium">{label}<input id={`${id}-${kind}`} type={type} autoComplete="off" value={value[`contact_${kind}`]} onChange={(event) => update({ [`contact_${kind}`]: event.target.value })} disabled={disabled} maxLength={kind === 'email' ? 254 : kind === 'phone' ? 40 : 33} className={input} placeholder={placeholder} /></label>
        <div className="flex flex-col gap-2 text-xs sm:flex-row sm:flex-wrap sm:gap-x-5">
          <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={value[`${kind}_visible_to_groups`]} onChange={(event) => update({ [`${kind}_visible_to_groups`]: event.target.checked })} disabled={disabled || !value[`contact_${kind}`].trim()} className="h-4 w-4 accent-primary" />Показувати учасникам моїх груп</label>
          <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={value[`${kind}_visible_public`]} onChange={(event) => update({ [`${kind}_visible_public`]: event.target.checked })} disabled={disabled || !value[`contact_${kind}`].trim()} className="h-4 w-4 accent-primary" />Показувати у відкритому профілі</label>
        </div>
        {value[`contact_${kind}`].trim() && !value[`${kind}_visible_to_groups`] && !value[`${kind}_visible_public`] && <p className="text-xs text-muted-foreground">Бачите тільки ви.</p>}
      </div>)}
    </fieldset>}
  </div>
}

export function TeacherAcademicSettings({ repository = supabaseTeacherAcademicRepository, accountId = '', onSaved }: {
  repository?: TeacherAcademicRepository; accountId?: string; onSaved?: (value: TeacherAcademicProfile) => void
}) {
  const [value, setValue] = useState(() => emptyTeacherAcademicProfile(accountId))
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    generation.current += 1
    setLoading(true); setLoaded(false); setSaving(false); setError(''); setSaved(false)
    repository.load().then((result) => {
      if (accountId && result.user_id !== accountId) throw new Error('TEACHING_AUTH_CHANGED')
      if (active) { setValue(result); setLoaded(true) }
    }).catch((failure) => { if (active) setError(teacherAcademicProfileError(failure)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; generation.current += 1 }
  }, [repository, accountId, refresh])
  const ready = loaded && (!accountId || value.user_id === accountId)
  const save = async () => {
    if (lock.current || loading || !ready) return
    const validation = validateTeacherAcademicProfile(value)
    if (validation) { setError(validation); return }
    const current = generation.current
    lock.current = true; setSaving(true); setError(''); setSaved(false)
    try {
      const result = await repository.save(value)
      if (current !== generation.current) return
      setValue(result); setSaved(true); onSaved?.(result)
    } catch (failure) { if (current === generation.current) setError(teacherAcademicProfileError(failure)) }
    finally { lock.current = false; if (current === generation.current) setSaving(false) }
  }
  return <section className="rounded-2xl border border-border bg-background p-4 sm:p-5" aria-label="Профіль викладача та контакти">
    <header className="mb-5"><h3 className="flex items-center gap-2 font-semibold"><GraduationCap size={19} className="text-primary" />Профіль викладача та контакти</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Кафедра, посада, аспірантура, строк викладання та доступні студентам способи зв’язку.</p></header>
    {loading ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" />Завантаження налаштувань…</div> : ready ? <TeacherAcademicProfileEditor value={value} onChange={(next) => { setValue(next); setSaved(false) }} disabled={saving} showDepartment /> : <button type="button" onClick={() => setRefresh((value) => value + 1)} className="min-h-10 rounded-full border border-border px-4 text-sm">Спробувати завантажити ще раз</button>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {!loading && ready && <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" onClick={() => void save()} disabled={saving} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <ShieldCheck size={16} />}{saving ? 'Зберігаємо…' : 'Зберегти налаштування'}</button>{saved && <span role="status" className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-300"><Check size={15} />Збережено</span>}</div>}
    <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Eye size={14} className="mt-0.5 shrink-0" />Вимкніть відповідну позначку, щоб приховати контакт для обраної аудиторії.</p>
  </section>
}

export function TeacherAcademicApproval({ requestedUntil, approvedUntil, pending, onApprove, saving = false }: {
  requestedUntil: string | null; approvedUntil: string | null; pending: boolean
  onApprove(until: string | null): Promise<void> | void; saving?: boolean
}) {
  const [until, setUntil] = useState((pending ? requestedUntil : approvedUntil) || '')
  const [error, setError] = useState('')
  const id = useId()
  useEffect(() => { setUntil((pending ? requestedUntil : approvedUntil) || '') }, [requestedUntil, approvedUntil, pending])
  return <section className="space-y-3 rounded-2xl border border-border bg-muted/20 p-4">
    <h3 className="flex items-center gap-2 text-sm font-semibold"><CalendarClock size={17} />Строк викладання</h3>
    <p className="text-xs leading-relaxed text-muted-foreground">Запит: {requestedUntil || 'без обмеження строку'}. Чинне погодження: {approvedUntil || 'без обмеження строку'}.{pending ? ' Є зміна на розгляді.' : ''}</p>
    <button type="button" aria-pressed={!until} onClick={() => { setUntil(''); setError('') }} disabled={saving} className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium disabled:opacity-50 ${!until ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'}`}>Без обмеження строку</button>
    <label htmlFor={id} className="block text-sm">Погодити доступ до<input id={id} type="date" value={until} onChange={(event) => { setUntil(event.target.value); setError('') }} disabled={saving} className="mt-1.5 block min-h-11 w-full max-w-xs rounded-xl border border-border bg-background px-3 text-sm" /></label>
    <p role="status" className="text-sm font-medium text-primary">Обрано: {until ? `до ${until}` : 'без обмеження строку'}.</p>
    <p className="text-xs leading-relaxed text-muted-foreground">Оберіть «Без обмеження строку» або вкажіть кінцеву дату, потім натисніть «Погодити строк». Історія оцінок і матеріалів зберігається після завершення строку. Власник зможе відкликати свої матеріали.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <button type="button" disabled={saving} onClick={async () => { setError(''); try { await onApprove(until || null) } catch (failure) { setError(teacherAcademicProfileError(failure)) } }} className="min-h-10 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving ? 'Зберігаємо…' : 'Погодити строк'}</button>
  </section>
}
