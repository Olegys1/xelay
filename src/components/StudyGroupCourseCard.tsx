import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, GraduationCap, Loader2 } from 'lucide-react'
import { confirmGroupCourse, createStudyGroupWithCourse, groupCourseNeedsReview, loadGroupCourse, requestGroupIdentityReview, type GroupCourseChoice, type GroupCourseStatus, type GroupStudyLevel } from '../lib/studyGroupCourse'
import { currentAcademicYear } from '../lib/studyYearProgression'

export const groupLevelLabels: Record<GroupStudyLevel, string> = { bachelor: 'Бакалаврат', master: 'Магістратура', postgraduate: 'Аспірантура' }
const inputClass = 'min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm'
export type GroupCourseCardProps = {
  groupName: string; mode: 'create' | 'confirm'; academicYear: number; course: number | ''; level: GroupStudyLevel | '';
  onCourse(value: number | ''): void; onLevel(value: GroupStudyLevel | ''): void; checked: boolean; onChecked(value: boolean): void;
  busy?: boolean; error?: string; confirmed?: boolean; outsidePeriod?: boolean; reviewAvailable?: boolean; reviewSent?: boolean;
  onSubmit(): void; onReview?(): void;
}
export function GroupCourseCard(props: GroupCourseCardProps) {
  const { groupName, mode, academicYear, course, level, onCourse, onLevel, checked, onChecked, busy, error, confirmed, outsidePeriod, reviewAvailable, reviewSent, onSubmit, onReview } = props
  return <section className="xelay-card min-w-0 border-primary/25 p-5 sm:p-6" aria-label={`Курс групи ${groupName}`}>
    <div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-primary">{confirmed ? <CheckCircle2 size={22} /> : <GraduationCap size={22} />}</span><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-primary">{confirmed ? 'Дані підтверджено' : 'Обов’язкові дані групи'}</p><h2 className="mt-1 break-words text-lg font-semibold">{mode === 'create' ? `Створіть групу «${groupName}»` : `Курс групи «${groupName}»`}</h2><p className="mt-1 text-sm text-muted-foreground">{outsidePeriod ? 'Група поза поточним періодом навчання. Матеріали минулих років залишаються доступними.' : confirmed ? `${course} курс · ${level ? groupLevelLabels[level] : ''} · ${academicYear}/${academicYear + 1}` : 'Підтвердьте поточний курс і рівень навчання, щоб викладачі знаходили саме вашу групу.'}</p></div></div>
    {!confirmed && !outsidePeriod && <form onSubmit={event => { event.preventDefault(); if (!busy && !reviewSent && checked && course && level) onSubmit() }} className="mt-5 space-y-4">
      <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="sr-only">Дані навчання</legend><label className="space-y-1 text-sm font-medium"><span>Поточний курс</span><select aria-label="Поточний курс" required value={course} onChange={event => onCourse(event.target.value ? Number(event.target.value) : '')} className={inputClass}><option value="">Оберіть курс</option>{[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value} курс</option>)}</select></label><label className="space-y-1 text-sm font-medium"><span>Рівень навчання</span><select aria-label="Рівень навчання" required value={level} onChange={event => onLevel(event.target.value as GroupStudyLevel | '')} className={inputClass}><option value="">Оберіть рівень</option>{Object.entries(groupLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></fieldset>
      <p className="text-xs text-muted-foreground">Навчальний рік {academicYear}/{academicYear + 1}. Номер у назві групи може відрізнятися від її курсу.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} disabled={busy} onChange={event => onChecked(event.target.checked)} className="mt-1" /><span>Перевірив курс і рівень навчання своєї групи. Вони вказані правильно.</span></label>
      {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || !checked || !course || !level || reviewSent} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy && <Loader2 size={16} className="animate-spin" />}{mode === 'create' ? 'Створити безкоштовно' : 'Підтвердити курс'}</button>{reviewAvailable && !reviewSent && <button type="button" disabled={busy || !checked || !course || !level} onClick={onReview} className="min-h-11 rounded-full border border-border px-4 py-2 text-sm disabled:opacity-50">Передати на перевірку</button>}</div>
      {reviewSent && <p role="status" className="rounded-xl bg-accent p-3 text-sm">Звернення передано адміністратору. Дані та права наявних груп збережено. Після рішення оновіть сторінку.</p>}
      {mode === 'create' && <p className="text-xs text-muted-foreground">Розклад, ДЗ, семінари й матеріали безкоштовні для всієї групи.</p>}
    </form>}
  </section>
}

export function StudyGroupCourseCard({ actorId, groupId, applicationId, groupName, initialCohort, initialLevel, onReady, onCreated }: {
  actorId: string; groupId?: string; applicationId?: string; groupName: string; initialCohort?: number | null; initialLevel?: string | null;
  onReady?(value: boolean): void; onCreated?(id: string): void;
}) {
  const year = currentAcademicYear(), initialCourse = initialCohort ? year - initialCohort + 1 : null
  const scope = JSON.stringify([actorId, groupId || null, applicationId || null])
  const latestScope = useRef(scope); latestScope.current = scope
  const [preparedScope, setPreparedScope] = useState(scope)
  const [course, setCourse] = useState<number | ''>(initialCourse && initialCourse >= 1 && initialCourse <= 6 ? initialCourse : '')
  const [level, setLevel] = useState<GroupStudyLevel | ''>(initialLevel && Object.prototype.hasOwnProperty.call(groupLevelLabels, initialLevel) ? initialLevel as GroupStudyLevel : '')
  const [checked, setChecked] = useState(false), [loading, setLoading] = useState(Boolean(groupId)), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<GroupCourseStatus | null>(null), [error, setError] = useState(''), [reviewAvailable, setReviewAvailable] = useState(false), [reviewSent, setReviewSent] = useState(false)
  const lifecycle = useRef<AbortController | null>(null), lifecycleScope = useRef(scope), pending = useRef<AbortController | null>(null), ids = useRef(new Map<string, string>())
  const callbacks = useRef({ onReady, onCreated }); callbacks.current = { onReady, onCreated }
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller
    lifecycleScope.current = scope; pending.current = null
    setPreparedScope(scope); setStatus(null); setLoading(Boolean(groupId)); setBusy(false); setChecked(false); setError(''); setReviewAvailable(false); setReviewSent(false)
    setCourse(initialCourse && initialCourse >= 1 && initialCourse <= 6 ? initialCourse : '')
    setLevel(initialLevel && Object.prototype.hasOwnProperty.call(groupLevelLabels, initialLevel) ? initialLevel as GroupStudyLevel : '')
    const current = () => !controller.signal.aborted && latestScope.current === scope && lifecycle.current === controller
    callbacks.current.onReady?.(false)
    if (groupId) void loadGroupCourse(actorId, groupId, controller.signal).then(result => {
      if (!current()) return
      setStatus(result); setCourse(result.course || ''); setLevel(result.level || ''); setLoading(false)
      callbacks.current.onReady?.(result.confirmed && !result.outsideCurrentPeriod || result.archived || result.outsideCurrentPeriod)
    }).catch(failure => { if (current()) { setError(failure instanceof Error ? failure.message : 'Не вдалося перевірити курс.'); setLoading(false) } })
    return () => { controller.abort(); if (lifecycle.current === controller) lifecycle.current = null }
  }, [actorId, groupId, applicationId, year])
  const submit = async (review = false) => {
    const controller = lifecycle.current
    if (!controller || controller.signal.aborted || latestScope.current !== scope || lifecycleScope.current !== scope || pending.current || loading || reviewSent || status?.confirmed || status?.outsideCurrentPeriod || status?.archived || !course || !level || !checked) return
    pending.current = controller; setBusy(true); setError('')
    const current = () => !controller.signal.aborted && latestScope.current === scope && lifecycle.current === controller
    const choice: GroupCourseChoice = { course, level, academicYear: year }
    const key = JSON.stringify([actorId, groupId, applicationId, choice, review]), commandId = ids.current.get(key) || crypto.randomUUID(); ids.current.set(key, commandId)
    try {
      if (review) {
        await requestGroupIdentityReview(actorId, { groupId, applicationId }, choice, 'Прошу перевірити курс, рівень навчання та збіг назви групи.', commandId, controller.signal)
        if (current()) setReviewSent(true)
      } else if (groupId) {
        await confirmGroupCourse(actorId, groupId, choice, commandId, controller.signal)
        if (current()) { setStatus({ groupId, academicYear: year, cohortStartYear: year - course + 1, course, level, archived: false, outsideCurrentPeriod: false, confirmed: true, needsConfirmation: false }); callbacks.current.onReady?.(true) }
      } else if (applicationId) {
        const id = await createStudyGroupWithCourse(actorId, applicationId, choice, commandId, controller.signal)
        if (current()) callbacks.current.onCreated?.(id)
      }
    } catch (failure) { if (current()) { setError(failure instanceof Error ? failure.message : 'Не вдалося перевірити результат. Оновіть сторінку.'); setReviewAvailable(groupCourseNeedsReview(failure)) } }
    finally { if (pending.current === controller) pending.current = null; if (current()) setBusy(false) }
  }
  if (loading || preparedScope !== scope) return <section className="xelay-card flex items-center gap-2 p-5 text-sm" role="status"><Loader2 size={16} className="animate-spin" />Перевіряємо курс групи…</section>
  if (groupId && !status) return <section className="xelay-card p-5"><p role="alert" className="text-sm text-destructive">{error}</p><p className="mt-2 text-xs text-muted-foreground">Оновіть сторінку, щоб перевірити курс. Розклад і матеріали залишаються доступними для перегляду.</p></section>
  return <GroupCourseCard groupName={groupName} mode={groupId ? 'confirm' : 'create'} academicYear={year} course={course} level={level} onCourse={value => { setCourse(value); setChecked(false); setReviewAvailable(false); setError('') }} onLevel={value => { setLevel(value); setChecked(false); setReviewAvailable(false); setError('') }} checked={checked} onChecked={setChecked} busy={busy} error={error} confirmed={status?.confirmed} outsidePeriod={status?.archived || status?.outsideCurrentPeriod} reviewAvailable={reviewAvailable} reviewSent={reviewSent} onSubmit={() => void submit()} onReview={() => void submit(true)} />
}
