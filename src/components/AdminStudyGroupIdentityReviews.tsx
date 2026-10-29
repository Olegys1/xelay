import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, ClipboardCheck, Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { currentAcademicYear } from '../lib/studyYearProgression'
import { loadAdminGroupIdentityReviews, resolveGroupIdentityReview, type GroupIdentityReviewAdmin, type GroupStudyLevel } from '../lib/studyGroupCourse'
import { chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'

type QueueStatus = 'pending' | 'resolved' | 'closed' | 'all'
type Action = '' | 'confirm_identity' | 'distinct' | 'close'
const labels: Record<QueueStatus, string> = { pending: 'Очікують перевірки', resolved: 'Опрацьовані', closed: 'Закриті', all: 'Усі звернення' }
const levels: Record<GroupStudyLevel, string> = { bachelor: 'Бакалаврат', master: 'Магістратура', postgraduate: 'Аспірантура' }
const pageSize = 20
const message = (failure: unknown) => failure instanceof Error ? failure.message : 'Не вдалося перевірити результат. Оновіть список перед новою дією.'

export function AdminStudyGroupIdentityReviews() {
  const { authUser, xelayUser, isLoading } = useAuth()
  const actor = !isLoading && authUser?.id && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin ? authUser.id : null
  const latest = useRef(actor); latest.current = actor
  if (!actor) return null
  return <AdminStudyGroupIdentityReviewQueue key={actor} actor={actor} isCurrent={() => latest.current === actor} />
}

export function AdminStudyGroupIdentityReviewQueue({ actor, isCurrent }: { actor: string; isCurrent: () => boolean }) {
  const id = useId()
  const [scope, setScope] = useState<{ status: QueueStatus; offset: number }>({ status: 'pending', offset: 0 })
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<{ total: number; items: GroupIdentityReviewAdmin[] } | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const [selected, setSelected] = useState(''), [action, setAction] = useState<Action>(''), [groupId, setGroupId] = useState('')
  const [course, setCourse] = useState(''), [level, setLevel] = useState<GroupStudyLevel | ''>(''), [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false), [saving, setSaving] = useState(false)
  const generation = useRef(0), mounted = useRef(false), busy = useRef(false), mutationAbort = useRef<AbortController | null>(null)
  const currentActor = useRef(isCurrent); currentActor.current = isCurrent
  const current = () => mounted.current && currentActor.current()
  const year = currentAcademicYear()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++generation.current; mutationAbort.current?.abort() }
  }, [])
  useEffect(() => {
    const ticket = ++generation.current, controller = new AbortController()
    const valid = () => current() && ticket === generation.current && !controller.signal.aborted
    setLoading(true); setError(''); setPage(null)
    void loadAdminGroupIdentityReviews(actor, scope.status, scope.offset, controller.signal).then(result => {
      if (valid()) {
        if (!result.items.length && scope.offset > 0) setScope(previous => ({ ...previous, offset: Math.max(0, Math.ceil(result.total / pageSize) * pageSize - pageSize) }))
        else setPage(result)
      }
    }).catch(failure => { if (valid()) setError(message(failure)) }).finally(() => { if (valid()) setLoading(false) })
    return () => { controller.abort() }
  }, [actor, scope.status, scope.offset, revision])

  const resetDecision = () => {
    setSelected(''); setAction(''); setGroupId(''); setCourse(''); setLevel(''); setReason(''); setAcknowledged(false)
  }
  const reload = () => { if (!current() || busy.current) return; resetDecision(); setRevision(value => value + 1) }
  const changeScope = (status: QueueStatus, offset: number) => {
    if (!current() || busy.current) return
    resetDecision(); setSuccess(''); setPage(null); setScope({ status, offset })
  }
  const open = (review: GroupIdentityReviewAdmin) => {
    if (!current() || busy.current || loading) return
    resetDecision(); setSelected(review.id); setSuccess('')
  }
  const active = page?.items.find(review => review.id === selected)
  const collision = active?.collisionGroups.find(group => group.id === groupId)
  const unknown = Boolean(collision && collision.unchanged && collision.cohort === null && collision.level === null)
  const selfReview = active?.applicant.id === actor
  const allowed = Boolean(active?.status === 'pending' && (action === 'close'
    || !selfReview && unknown && (action === 'confirm_identity' && Number(course) >= 1 && Number(course) <= 6 && level !== ''
      || action === 'distinct' && active.kind === 'creation')))
  const canSubmit = allowed && reason.trim().length >= 10 && reason.trim().length <= 1000 && acknowledged && !saving && !loading

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!current() || busy.current || !canSubmit || !active || !action) return
    busy.current = true; setSaving(true); setSuccess('')
    const controller = new AbortController(); mutationAbort.current = controller
    const ticket = generation.current
    const valid = () => current() && ticket === generation.current && !controller.signal.aborted
    try {
      await resolveGroupIdentityReview(actor, active.id, action, reason, action === 'close' ? null : groupId,
        action === 'close' ? null : action === 'confirm_identity' ? { course: Number(course), level: level as GroupStudyLevel, academicYear: year }
          : { course: active.course, level: active.level, academicYear: active.academicYear }, controller.signal)
      if (!valid()) return
      resetDecision(); setSuccess('Рішення збережено. Староста побачить пояснення у своєму зверненні.')
      setRevision(value => value + 1)
    } catch (failure) {
      if (valid()) {
        resetDecision(); setPage(null)
        setError(`${message(failure)} Перед новою дією оновіть список і перевірте стан звернення.`)
      }
    } finally {
      if (mutationAbort.current === controller) mutationAbort.current = null
      busy.current = false
      if (current()) setSaving(false)
    }
  }

  return <section id="admin-group-identity-reviews" aria-labelledby={`${id}-title`} className="xelay-card mb-6 scroll-mt-28 overflow-hidden" aria-busy={loading || saving}>
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
      <div><h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold"><ClipboardCheck size={19} className="text-primary" aria-hidden="true" />Уточнення курсу навчальних груп</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">Звернення старост, коли дані груп збігаються або потребують перевірки. Для рішень потрібен підтверджений двоетапний вхід.</p></div>
      <button type="button" className={chatButton} disabled={loading || saving} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Оновити звернення</button>
    </header>
    <div className="px-5 py-4 sm:px-6"><label className="block max-w-sm space-y-1.5"><span className="text-xs font-medium">Статус звернення</span>
      <select className={chatInput} value={scope.status} disabled={saving} onChange={event => changeScope(event.target.value as QueueStatus, 0)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {error && <div className="mx-5 mb-4 rounded-xl bg-destructive/10 p-4 text-sm text-destructive" role="alert"><p>{error}</p><button type="button" className={`${chatButton} mt-3`} onClick={reload} disabled={loading}>Повторити перевірку</button></div>}
    {success && <p role="status" className="mx-5 mb-4 rounded-xl bg-primary/10 p-4 text-sm">{success}</p>}
    {loading && <p className="flex items-center gap-2 px-5 py-5 text-sm text-muted-foreground" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Завантажуємо звернення…</p>}
    {!loading && page?.items.length === 0 && <p className="px-5 py-6 text-sm text-muted-foreground">Звернень із таким статусом поки немає.</p>}
    <div className="divide-y divide-border">{page?.items.map(review => <article key={review.id} className="space-y-3 px-5 py-5 sm:px-6" aria-label={`Звернення щодо ${review.groupName}`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{review.groupName}</h3>
        <p className="mt-1 break-words text-sm text-muted-foreground">{review.specialty} · {review.course} курс · {levels[review.level]}</p>
        <p className="mt-1 break-words text-xs text-muted-foreground">{review.unit} · {review.university}</p>
        <p className="mt-2 text-sm">Староста: {review.applicant.name || 'Ім’я не вказано'}{review.applicant.username && <span className="ml-1 break-all text-muted-foreground">@{review.applicant.username.replace(/^@/, '')}</span>}</p>
      </div><span className="rounded-full bg-muted px-3 py-1 text-xs">{labels[review.status]}</span></div>
      {review.message && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{review.message}</p>}
      {review.resolutionReason && <p className="rounded-xl bg-muted p-3 text-sm">Рішення: {review.resolutionReason}</p>}
      {review.status === 'pending' && selected !== review.id && <button type="button" className={chatButton} disabled={saving || loading} onClick={() => open(review)}>Перевірити звернення<span className="sr-only"> щодо {review.groupName}</span></button>}
      {selected === review.id && review.status === 'pending' && <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-muted/30 p-4">
        <p className="text-sm leading-relaxed">Перевірте курс і навчальний рік за підтвердженням старости. Рішення не змінює власника, учасників або матеріали групи.</p>
        {selfReview && <p className="rounded-xl bg-primary/10 p-3 text-sm">Власне звернення має перевірити інший адміністратор. Ви можете лише закрити його з поясненням.</p>}
        <label className="block space-y-1.5"><span className="text-xs font-medium">Рішення</span><select className={chatInput} value={action} disabled={saving} onChange={event => { setAction(event.target.value as Action); setGroupId(''); setCourse(''); setLevel(''); setAcknowledged(false) }}>
          <option value="">Оберіть рішення</option><option value="close">Закрити звернення з поясненням</option>
          {!selfReview && <option value="confirm_identity">Уточнити невідомий курс існуючої групи</option>}
          {!selfReview && review.kind === 'creation' && <option value="distinct">Підтвердити, що це різні набори</option>}
        </select></label>
        {action && action !== 'close' && <>
          <label className="block space-y-1.5"><span className="text-xs font-medium">Існуюча група для перевірки</span><select className={chatInput} value={groupId} disabled={saving} onChange={event => { setGroupId(event.target.value); setAcknowledged(false) }}>
            <option value="">Оберіть групу після перевірки</option>{review.collisionGroups.map(group => <option key={group.id} value={group.id} disabled={!group.unchanged || group.cohort !== null || group.level !== null}>
              {group.name} · староста {group.representative || 'не вказано'}{!group.unchanged ? ' · дані змінилися' : group.cohort !== null ? ` · набір ${group.cohort}, зміна заборонена` : ' · курс не уточнено'}
            </option>)}</select></label>
          <p className="text-xs leading-relaxed text-muted-foreground">Групи з уже зафіксованим набором або зміненими даними не можна перепризначати. Якщо дані змінилися, оновіть список і перевірте звернення знову.</p>
          {action === 'distinct' && <p className="rounded-xl bg-primary/10 p-3 text-sm leading-relaxed">Це лише підтвердження різних наборів. Нову групу створить сам староста після повторної спроби. Курс і власник існуючої групи не зміняться.</p>}
          {action === 'confirm_identity' && <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5"><span className="text-xs font-medium">Підтверджений курс існуючої групи</span><select className={chatInput} value={course} disabled={saving} onChange={event => { setCourse(event.target.value); setAcknowledged(false) }}><option value="">Оберіть курс</option>{[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value} курс</option>)}</select></label>
            <label className="space-y-1.5"><span className="text-xs font-medium">Рівень освіти існуючої групи</span><select className={chatInput} value={level} disabled={saving} onChange={event => { setLevel(event.target.value as GroupStudyLevel); setAcknowledged(false) }}><option value="">Оберіть рівень</option>{Object.entries(levels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">Навчальний рік {year}/{year + 1}.{course && level && ` Буде збережено набір ${year - Number(course) + 1}, ${levels[level]}. Надалі курс змінюватиметься щороку автоматично.`}</p>
          </div>}
        </>}
        <label className="block space-y-1.5"><span className="text-xs font-medium">Пояснення рішення для старости</span><textarea className={`${chatInput} min-h-24 resize-y`} value={reason} minLength={10} maxLength={1000} disabled={saving} onChange={event => { setReason(event.target.value); setAcknowledged(false) }} placeholder="Що саме перевірено й що потрібно зробити далі" /><span className="block text-xs text-muted-foreground">Щонайменше 10 символів. Пояснення побачить лише автор звернення та адміністратори.</span></label>
        <label className="flex items-start gap-2 text-sm leading-relaxed"><input type="checkbox" className="mt-1 accent-primary" checked={acknowledged} disabled={saving || !allowed || reason.trim().length < 10} onChange={event => setAcknowledged(event.target.checked)} />Я перевірив дані та підтверджую обране рішення.</label>
        <div className="flex flex-wrap gap-2"><button type="submit" className={chatPrimary} disabled={!canSubmit}>{saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Зберегти рішення</button><button type="button" className={chatButton} disabled={saving} onClick={resetDecision}>Скасувати</button></div>
      </form>}
    </article>)}</div>
    <nav aria-label="Навігація зверненнями про курс" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4 text-xs text-muted-foreground">
      <span>{page && page.total > 0 ? `${scope.offset + 1}–${scope.offset + page.items.length} із ${page.total}` : 'По 20 звернень на сторінці'}</span>
      <div className="flex gap-2"><button type="button" className={chatButton} disabled={loading || saving || scope.offset === 0} onClick={() => changeScope(scope.status, Math.max(0, scope.offset - pageSize))}><ChevronLeft size={15} aria-hidden="true" />Попередні</button><button type="button" className={chatButton} disabled={loading || saving || !page || scope.offset + page.items.length >= page.total || scope.offset + pageSize > 100000} onClick={() => changeScope(scope.status, scope.offset + pageSize)}>Наступні<ChevronRight size={15} aria-hidden="true" /></button></div>
    </nav>
  </section>
}
