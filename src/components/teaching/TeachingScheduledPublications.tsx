import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, FileText, Pencil, RefreshCw, Undo2 } from 'lucide-react'
import { teachingDate, teachingError, type TeachingRepository, type TeachingScheduledPublication, type TeachingSnapshot } from '../../lib/teaching'
import { PublicationEditor } from './TeachingPublications'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'

type Props = { repository: TeachingRepository; userId: string; onRefresh: () => Promise<void> }
function SchedulingNotice({ item }: { item: TeachingScheduledPublication }) {
  const failure = (item as TeachingScheduledPublication & { schedule_error?: string | null }).schedule_error
  return failure ? <p role="status" className="teaching-note mt-3">Публікацію потрібно перевірити. Відкрийте редагування, уточніть групу та час і заплануйте її знову.</p> : null
}
export function TeachingScheduledPublications({ repository, userId, onRefresh }: Props) {
  const [storedItems, setItems] = useState<TeachingScheduledPublication[]>([]), [groupId, setGroupId] = useState('')
  const [loadedScope, setLoadedScope] = useState<{ repository: TeachingRepository; userId: string } | null>(null)
  const [groupNames, setGroupNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [editing, setEditing] = useState<{ item: TeachingScheduledPublication; snapshot: TeachingSnapshot; groupId: string } | null>(null)
  const [cancel, setCancel] = useState<{ item: TeachingScheduledPublication; requestId: string } | null>(null), [cancelCommitted, setCancelCommitted] = useState(false)
  const generation = useRef(0), lock = useRef(false), alive = useRef(false)
  const scope = useRef({ repository, userId }); scope.current = { repository, userId }
  const currentScope = () => alive.current && scope.current.repository === repository && scope.current.userId === userId
  const loadedCurrent = loadedScope?.repository === repository && loadedScope.userId === userId
  const items = loadedCurrent ? storedItems : []
  const load = useCallback(async () => {
    if (!alive.current || scope.current.repository !== repository || scope.current.userId !== userId) return
    const request = ++generation.current
    setLoading(true); setError('')
    const current = () => alive.current && request === generation.current && scope.current.repository === repository && scope.current.userId === userId
    try { const [next, workspace] = await Promise.all([repository.scheduledItems(), repository.workspace()]); if (current()) { setLoadedScope({ repository, userId }); setGroupNames(Object.fromEntries(workspace.groups.map(group => [group.id, group.group_name]))); setItems(next.items.filter(item => item.status === 'scheduled').sort((a, b) => (a.publish_at || '').localeCompare(b.publish_at || ''))) } }
    catch (failure) { if (current()) setError(teachingError(failure)); throw failure }
    finally { if (current()) setLoading(false) }
  }, [repository, userId])
  useEffect(() => { alive.current = true; lock.current = false; setBusy(''); setItems([]); setGroupId(''); setEditing(null); setCancel(null); void load().catch(() => {}); return () => { alive.current = false; generation.current++ } }, [load])
  const groups = [...new Map(items.flatMap(item => item.targets.map(target => [target.group_id, { id: target.group_id, name: groupNames[target.group_id] || (target as typeof target & { group_name?: string }).group_name || 'Навчальна група' }] as const))).values()]
  const visible = items.filter(item => !groupId || item.targets.some(target => target.group_id === groupId))
  async function edit(item: TeachingScheduledPublication) {
    if (lock.current) return
    lock.current = true; setBusy(item.id); setError('')
    try {
      const snapshot = await repository.course(item.course_id)
      if (!currentScope()) return
      const latest = (item.kind === 'assignment' ? snapshot.assignments : snapshot.materials).find(row => row.id === item.id)
      if (!latest || latest.status !== 'scheduled' || latest.version !== item.version) throw new Error('TEACHING_CONFLICT')
      setEditing({ item: { ...item, ...latest }, snapshot, groupId: groupId || latest.targets[0]?.group_id || '' })
    } catch (failure) { if (currentScope()) setError(teachingError(failure)) }
    finally { if (currentScope()) { lock.current = false; setBusy('') } }
  }
  async function saved() { if (!currentScope()) return; await load(); if (currentScope()) await onRefresh() }
  async function cancelSchedule() {
    if (!cancel || lock.current || cancelCommitted) return
    lock.current = true; setBusy(cancel.item.id); setError('')
    try { await repository.mutate('cancel_scheduled_publication', { id: cancel.item.id, course_id: cancel.item.course_id, version: cancel.item.version, request_id: cancel.requestId }); if (!currentScope()) return; setCancelCommitted(true); await saved(); if (currentScope()) setCancel(null) }
    catch (failure) { if (currentScope()) setError(teachingError(failure)) }
    finally { if (currentScope()) { lock.current = false; setBusy('') } }
  }
  return <section aria-label="Заплановані публікації"><div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-xl font-semibold"><CalendarClock size={21} />Заплановані</h2><p className="mt-1 text-sm text-muted-foreground">Майбутні завдання й матеріали з усіх ваших предметів. Час публікації — київський.</p></div><TeachingButton disabled={loading || Boolean(busy)} onClick={() => void load().catch(() => {})}><RefreshCw size={15} />Оновити</TeachingButton></div>
    <TeachingField label="Навчальна група"><select name="scheduled-group-filter" className={teachingInput} value={groupId} onChange={event => setGroupId(event.target.value)} disabled={loading || Boolean(busy)}><option value="">Усі групи</option>{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></TeachingField>
    {error && <p role="alert" className="teaching-error my-4">{error}</p>}{loading && !items.length ? <p role="status" className="teaching-note mt-4">Завантажуємо заплановані публікації…</p> : !visible.length ? <TeachingEmpty icon={<CalendarClock size={25} />} title="Запланованих публікацій поки немає" description="У редакторі завдання чи матеріалу оберіть «Пізніше» та вкажіть дату публікації." /> : <div className="teaching-list mt-5">{visible.map(item => <article className="teaching-card" key={item.id}><div className="flex flex-wrap gap-2"><span className="teaching-badge"><CalendarClock size={13} />{teachingDate(item.publish_at, true)}</span><span className="teaching-badge">{item.kind === 'assignment' ? 'Завдання' : 'Матеріал'}</span></div><h3 className="mt-3 break-words text-lg font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted-foreground">{item.course_title} · {item.targets.map(target => groups.find(group => group.id === target.group_id)?.name || 'Навчальна група').join(', ')}</p>{item.body && <p className="mt-3 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.body}</p>}<SchedulingNotice item={item} /><div className="mt-4 flex flex-wrap gap-2"><TeachingButton disabled={Boolean(busy) || loading} onClick={() => void edit(item)}><Pencil size={14} />Редагувати</TeachingButton><TeachingButton disabled={Boolean(busy) || loading} onClick={() => { setError(''); setCancelCommitted(false); setCancel({ item, requestId: crypto.randomUUID() }) }}><Undo2 size={14} />Скасувати планування</TeachingButton></div></article>)}</div>}
    {loadedCurrent && editing && <PublicationEditor kind={editing.item.kind} initial={editing.item} groupId={editing.groupId} repository={repository} snapshot={editing.snapshot} userId={userId} onRefresh={saved} onClose={() => { if (currentScope()) setEditing(null) }} />}
    {loadedCurrent && cancel && <TeachingModal title="Скасувати планування?" description={cancel.item.title} busy={Boolean(busy)} onClose={() => { if (currentScope()) setCancel(null) }}><p className="teaching-note">Публікація залишиться чернеткою. Студенти її не побачать, а матеріали й текст збережуться.</p>{error && <p role="alert" className="teaching-error mt-3">{error}</p>}{cancelCommitted && <p role="status" className="teaching-note mt-3">Планування скасовано. Оновіть список, щоб побачити зміни.</p>}<div className="teaching-form-actions"><TeachingButton disabled={Boolean(busy)} onClick={() => { if (currentScope()) setCancel(null) }}>Закрити</TeachingButton>{cancelCommitted ? <TeachingButton primary onClick={() => void saved().then(() => { if (currentScope()) setCancel(null) }).catch(failure => { if (currentScope()) setError(teachingError(failure)) })}><RefreshCw size={14} />Оновити список</TeachingButton> : <TeachingButton primary busy={Boolean(busy)} onClick={() => void cancelSchedule()}><FileText size={14} />Повернути в чернетки</TeachingButton>}</div></TeachingModal>}
  </section>
}
