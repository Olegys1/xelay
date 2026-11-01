import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Plus, Trash2, X, Loader2, GraduationCap } from 'lucide-react'
import { LESSON_TYPES, academicPeriodDates, academicYearForDate, type TimetableLesson } from '../../lib/studyGroupTimetable'
import { studentElectiveSetupState, studentElectiveError, type StudentElectiveMeeting, type StudentElectivePlan } from '../../lib/studentElectiveTimetable'
import { studentElectiveTimetableRepository, type StudentElectiveRepository } from '../../lib/studentElectiveTimetableRepository'

const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя']
const inputClass = 'mt-1 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm'
export function useStudentElectivePlans(userId: string | undefined, groupId: string | undefined, enabled: boolean, repository: StudentElectiveRepository = studentElectiveTimetableRepository) {
  const [revision, setRevision] = useState(0)
  const scope = enabled && userId && groupId ? `${userId}:${groupId}` : ''
  const [result, setResult] = useState<{ scope: string; plans: StudentElectivePlan[]; error: string; loading: boolean }>({ scope: '', plans: [], error: '', loading: false })
  useEffect(() => {
    const controller = new AbortController()
    if (!scope || !userId || !groupId) { setResult({ scope: '', plans: [], error: '', loading: false }); return }
    setResult({ scope, plans: [], error: '', loading: true })
    void repository.load(userId, groupId, controller.signal).then(plans => {
      if (!controller.signal.aborted) setResult({ scope, plans, error: '', loading: false })
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ scope, plans: [], error: 'Не вдалося завантажити ваші вибіркові. Загальний розклад залишається доступним.', loading: false })
    })
    return () => controller.abort()
  }, [scope, userId, groupId, revision, repository])
  return { plans: result.scope === scope ? result.plans : [], error: result.scope === scope ? result.error : '', loading: !!scope && (result.scope !== scope || result.loading), reload: () => setRevision(value => value + 1) }
}

export function StudentElectivePrompt({ schedule, plans, userId, groupId, date, onConfigure }: { schedule: TimetableLesson[]; plans: StudentElectivePlan[]; userId: string; groupId: string; date: string; onConfigure(): void }) {
  const state = studentElectiveSetupState(schedule, plans, userId, groupId, date)
  if (!state.hasElectiveBlocks) return null
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/20 bg-accent/35 p-4">
    <div className="flex items-start gap-3"><GraduationCap className="mt-0.5 shrink-0 text-primary" size={20} /><div><p className="text-sm font-semibold">Мої вибіркові дисципліни</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{state.configured ? 'Ваші предмети та час уже у вашому розкладі. Одногруппники налаштовують свої окремо.' : 'Оберіть свої предмети, дні та час. Вони замінять загальний блок лише у вашому розкладі.'}</p></div></div>
    <button type="button" onClick={onConfigure} className="min-h-11 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">{state.configured ? 'Змінити мої заняття' : 'Налаштувати свої заняття'}</button>
  </div>
}

export function StudentElectiveEditor({ userId, groupId, date, plan, onClose, onSaved, repository = studentElectiveTimetableRepository }: { userId: string; groupId: string; date: string; plan?: StudentElectivePlan; onClose(): void; onSaved(plan: StudentElectivePlan | null): void; repository?: StudentElectiveRepository }) {
  const dates = academicPeriodDates(Number(date.slice(5, 7)) >= 2 && Number(date.slice(5, 7)) <= 6 ? 'semester2' : 'semester1', academicYearForDate(date))
  const [from, setFrom] = useState(plan?.valid_from || dates.valid_from)
  const [until, setUntil] = useState(plan?.valid_until || dates.valid_until)
  const [lessons, setLessons] = useState<StudentElectiveMeeting[]>(() => plan?.lessons.map(item => ({ ...item })) || [])
  const [emptyConfirmed, setEmptyConfirmed] = useState(!!plan && plan.lessons.length === 0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), lock = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const patch = (id: string, values: Partial<StudentElectiveMeeting>) => setLessons(current => current.map(item => item.id === id ? { ...item, ...values } : item))
  const add = () => { setEmptyConfirmed(false); setLessons(current => [...current, { id: crypto.randomUUID(), subject: '', weekday: 1, starts_at: '09:40', ends_at: '11:00', lesson_type: 'lecture', teacher_name: '', location: '', online_url: null, online_url_secondary: null, online_links_extra: [], conference_id: null, conference_access_code: null, week_pattern: 'every', week_anchor_date: null }]) }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current || (!lessons.length && !emptyConfirmed)) return
    lock.current = true; setBusy(true); setError('')
    try {
      const saved = await repository.save(userId, { groupId, planId: plan?.id, validFrom: from, validUntil: until, lessons, configured: true, expectedVersion: plan?.version })
      if (mounted.current) onSaved(saved)
    } catch (failure) { if (mounted.current) setError(studentElectiveError(failure)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const reset = async () => {
    if (!plan || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await repository.remove(userId, plan.id, plan.version); if (mounted.current) onSaved(null) }
    catch (failure) { if (mounted.current) setError(studentElectiveError(failure)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="xelay-dialog-backdrop fixed inset-0 z-[80] flex items-end justify-center bg-black/45 p-0 backdrop-blur-sm sm:items-center sm:p-4">
    <form onSubmit={event => void save(event)} className="max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border bg-background p-5 shadow-2xl sm:rounded-3xl sm:p-6" aria-labelledby="elective-title">
      <div className="flex items-start justify-between gap-3"><div><h2 id="elective-title" className="text-xl font-semibold">Мої вибіркові</h2><p className="mt-2 text-sm text-muted-foreground">Додайте свої заняття один раз на семестр. Розклад групи та інших студентів залишиться без змін.</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="Закрити" className="shrink-0 rounded-full p-2 hover:bg-accent"><X size={20} /></button></div>
      <fieldset disabled={busy} className="mt-5 min-w-0 space-y-4">
        <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium">Початок періоду<input required type="date" value={from} onChange={event => setFrom(event.target.value)} className={inputClass} /></label><label className="text-xs font-medium">Кінець періоду<input required type="date" value={until} min={from} onChange={event => setUntil(event.target.value)} className={inputClass} /></label></div>
        {lessons.map((item, index) => <section key={item.id} className="min-w-0 rounded-2xl border border-border bg-accent/15 p-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Заняття {index + 1}</h3><button type="button" onClick={() => setLessons(current => current.filter(row => row.id !== item.id))} aria-label={`Прибрати заняття ${index + 1}`} className="rounded-full p-2 text-muted-foreground hover:text-destructive"><Trash2 size={16} /></button></div>
          <label className="block text-xs font-medium">Предмет<input required maxLength={120} value={item.subject} onChange={event => patch(item.id, { subject: event.target.value })} placeholder="Наприклад, Психологія спілкування" className={inputClass} /></label>
          <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs font-medium">День<select value={item.weekday} onChange={event => patch(item.id, { weekday: Number(event.target.value) })} className={inputClass}>{DAYS.map((day, dayIndex) => <option key={day} value={dayIndex + 1}>{day}</option>)}</select></label><label className="text-xs font-medium">Тип<select value={item.lesson_type} onChange={event => patch(item.id, { lesson_type: event.target.value as StudentElectiveMeeting['lesson_type'] })} className={inputClass}>{Object.entries(LESSON_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-xs font-medium">Початок<input required type="time" value={item.starts_at} onChange={event => patch(item.id, { starts_at: event.target.value })} className={inputClass} /></label><label className="text-xs font-medium">Завершення<input required type="time" min={item.starts_at} value={item.ends_at} onChange={event => patch(item.id, { ends_at: event.target.value })} className={inputClass} /></label></div>
          <label className="mt-3 block text-xs font-medium">Повторення<select value={item.week_pattern} onChange={event => patch(item.id, { week_pattern: event.target.value as StudentElectiveMeeting['week_pattern'], week_anchor_date: null })} className={inputClass}><option value="every">Щотижня</option><option value="upper">Верхній тиждень</option><option value="lower">Нижній тиждень</option></select></label>
          {item.week_pattern !== 'every' && <label className="mt-3 block text-xs font-medium">Понеділок відомого верхнього тижня<input required type="date" value={item.week_anchor_date || ''} onChange={event => patch(item.id, { week_anchor_date: event.target.value })} className={inputClass} /></label>}
          <details className="mt-3"><summary className="cursor-pointer py-2 text-xs font-semibold text-primary">Викладач, аудиторія та підключення</summary><div className="space-y-3 pt-2"><label className="block text-xs">Викладач<input maxLength={180} value={item.teacher_name} onChange={event => patch(item.id, { teacher_name: event.target.value })} className={inputClass} /></label><label className="block text-xs">Аудиторія<input maxLength={160} value={item.location} onChange={event => patch(item.id, { location: event.target.value })} className={inputClass} /></label><label className="block text-xs">Посилання<input type="url" value={item.online_url || ''} onChange={event => patch(item.id, { online_url: event.target.value || null })} placeholder="https://" className={inputClass} /></label><div className="grid grid-cols-2 gap-3"><label className="text-xs">ID конференції<input maxLength={80} value={item.conference_id || ''} onChange={event => patch(item.id, { conference_id: event.target.value || null })} className={inputClass} /></label><label className="text-xs">Код доступу<input maxLength={80} value={item.conference_access_code || ''} onChange={event => patch(item.id, { conference_access_code: event.target.value || null })} className={inputClass} /></label></div></div></details>
        </section>)}
        <button type="button" disabled={lessons.length >= 20} onClick={add} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50"><Plus size={16} />Додати заняття</button>
        {!lessons.length && <label className="flex items-start gap-2 text-sm text-muted-foreground"><input type="checkbox" className="mt-1" checked={emptyConfirmed} onChange={event => setEmptyConfirmed(event.target.checked)} />У мене немає вибіркових занять у цьому періоді. Приховати загальний блок.</label>}
      </fieldset>
      {error && <p role="alert" className="mt-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{plan && <button type="button" disabled={busy} onClick={() => void reset()} className="mr-auto min-h-11 rounded-full px-3 text-xs text-muted-foreground">Повернути загальний блок</button>}<button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-full border border-border px-4 text-sm">Скасувати</button><button disabled={busy || (!lessons.length && !emptyConfirmed)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy && <Loader2 size={16} className="animate-spin" />}Зберегти мій розклад</button></div>
    </form>
  </div>
}
