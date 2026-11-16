import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowDown, ArrowUpRight, BarChart3, CalendarDays, ChevronDown, ChevronRight, Clock3, RefreshCw, UsersRound, X } from 'lucide-react'
import { ACTIVITY_ROLE_LABELS, activityKyivClock, activityRange, buildSeminarActivity, individualActivityCount, type SeminarActivityData, type SeminarActivityPeriod, type SeminarActivityRange } from '../lib/seminarActivity'
import { loadSeminarActivityData } from '../lib/seminarActivityData'
import './seminarActivity.css'

type Props = {
  groupId: string; currentUserId?: string; fixture?: SeminarActivityData; now?: Date; defaultOpen?: boolean; revision?: unknown
  loadData?: (groupId: string, range: SeminarActivityRange, signal?: AbortSignal) => Promise<SeminarActivityData>
}
const shortDate = (value: string) => new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))

export function SeminarActivityPanel({ groupId, currentUserId, fixture, now, defaultOpen = false, revision, loadData = loadSeminarActivityData }: Props) {
  const [open, setOpen] = useState(defaultOpen), [period, setPeriod] = useState<SeminarActivityPeriod>('30')
  const [subject, setSubject] = useState(''), [selectedUser, setSelectedUser] = useState('')
  const [clock, setClock] = useState(() => now || new Date())
  const today = activityKyivClock(now || clock).date
  const [custom, setCustom] = useState<SeminarActivityRange>(() => activityRange('30', now || clock))
  const [data, setData] = useState<SeminarActivityData | null>(fixture?.groupId === groupId ? fixture : null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const panelId = useId()
  const detailsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selectedUser) return
    detailsRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }, [selectedUser])
  const rangeResult = useMemo(() => {
    try { return { range: activityRange(period, new Date(`${today}T12:00:00Z`), custom), error: '' } }
    catch (error) { return { range: null, error: error instanceof Error ? error.message : 'Перевірте період.' } }
  }, [period, today, custom.from, custom.to])
  useEffect(() => {
    if (now || !open) return
    const timer = setInterval(() => setClock(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [now, open])
  useEffect(() => { setSubject(''); setSelectedUser(''); setData(fixture?.groupId === groupId ? fixture : null) }, [groupId, fixture])
  useEffect(() => {
    if (!open || !rangeResult.range) return
    const controller = new AbortController()
    if (fixture) { setLoading(false); setData(fixture.groupId === groupId ? fixture : null); setError(fixture.groupId === groupId ? '' : 'Не вдалося підтвердити групу для цих даних.'); return }
    setLoading(true); setData(null); setError('')
    void loadData(groupId, rangeResult.range, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.groupId !== groupId) throw new Error('Не вдалося підтвердити групу для цих даних.')
      setData(result)
    }).catch(error => {
      if (!controller.signal.aborted) { setData(null); setError(error instanceof Error ? error.message : 'Не вдалося завантажити статистику. Спробуйте ще раз.') }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, groupId, fixture, rangeResult.range?.from, rangeResult.range?.to, refresh, revision, loadData])
  const safeData = data?.groupId === groupId ? data : null
  const rows = useMemo(() => safeData && rangeResult.range ? buildSeminarActivity(safeData, rangeResult.range, subject, now || clock) : [], [safeData, rangeResult.range?.from, rangeResult.range?.to, subject, now, clock])
  const subjects = safeData?.subjects.filter(item => item.groupId === groupId && (!subject || item.id === subject)) || []
  const totals = rows.reduce((result, row) => ({ individual: result.individual + individualActivityCount(row.counts), team: result.team + row.counts.team, booking: result.booking + row.counts.booking, planned: result.planned + row.counts.planned }), { individual: 0, team: 0, booking: 0, planned: 0 })
  const selected = rows.find(row => row.member.id === selectedUser)
  return <section className={`seminar-activity ${open ? 'seminar-activity--open' : ''}`} aria-label="Активність у семінарах">
    <button type="button" className="seminar-activity__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span className="seminar-activity__mark"><BarChart3 size={20} /></span>
      <span className="seminar-activity__heading"><strong>Активність групи</strong><span>Хто й на що записувався · за предметами та датами</span></span>
      <span className="seminar-activity__peek">Записи на участь</span><ChevronDown size={18} className="seminar-activity__chevron" />
    </button>
    {open && <div id={panelId} className="seminar-activity__body">
      <div className="seminar-activity__toolbar">
        <div className="seminar-activity__periods" role="group" aria-label="Період статистики">{([['7', '7 днів'], ['30', '30 днів'], ['semester', 'Семестр'], ['custom', 'Свій період']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={period === id} onClick={() => { setPeriod(id); setSelectedUser('') }}>{label}</button>)}</div>
        <div className="seminar-activity__filters"><label><span className="sr-only">Предмет</span><select value={subject} onChange={event => { setSubject(event.target.value); setSelectedUser('') }}><option value="">Усі предмети</option>{safeData?.subjects.filter(item => item.groupId === groupId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="button" className="seminar-activity__refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)} aria-label="Оновити активність"><RefreshCw size={16} className={loading ? 'seminar-activity__spin' : ''} /></button></div>
      </div>
      {period === 'custom' && <div className="seminar-activity__dates"><label>Від<input type="date" value={custom.from} onChange={event => setCustom(value => ({ ...value, from: event.target.value }))} /></label><span>—</span><label>До<input type="date" value={custom.to} onChange={event => setCustom(value => ({ ...value, to: event.target.value }))} /></label></div>}
      <div className="seminar-activity__explanation"><CalendarDays size={15} /><p>Рахуємо записи на заняття, які вже почалися, за київським часом. Це <strong>не підтвердження виступу</strong>. Команди та бронювання показуємо окремо.</p></div>
      {(rangeResult.error || error) && <div className="seminar-activity__error" role="alert">{rangeResult.error || error}</div>}
      {loading && <div className="seminar-activity__loading" role="status"><span /><span /><span />Збираємо записи групи…</div>}
      {!loading && !error && !rangeResult.error && safeData && <>
        <div className="seminar-activity__summary" aria-live="polite"><div><strong>{totals.individual}</strong><span>основних записів і доповнень</span></div><div><strong>{totals.team}</strong><span>командних записів</span></div><div><strong>{totals.booking}</strong><span>бронювань</span></div><div><strong>{totals.planned}</strong><span>ще заплановано в періоді</span></div></div>
        {selected && <div ref={detailsRef} id={`${panelId}-details`} role="region" className="seminar-activity__details" aria-label={`Записи: ${selected.member.name}`}><header><div><span>Деталі участі</span><h4>{selected.member.name}</h4></div><button type="button" onClick={() => setSelectedUser('')} aria-label="Закрити деталі"><X size={16} /></button></header>{selected.entries.length ? <ul>{selected.entries.map(entry => <li key={`${entry.seminarId}:${entry.role}`}><span className="seminar-activity__entry-icon">{entry.planned ? <Clock3 size={16} /> : entry.role === 'team' ? <UsersRound size={16} /> : <ArrowUpRight size={16} />}</span><div><strong>{entry.subjectName}</strong><span>{entry.title}</span></div><span className="seminar-activity__entry-role">{entry.planned ? 'Заплановано' : ACTIVITY_ROLE_LABELS[entry.role]}<small>{shortDate(entry.date)}</small></span></li>)}</ul> : <p>У вибраному періоді записів немає. Тут з’явиться історія після першого вибору питання або команди.</p>}</div>}
        <div className="seminar-activity__table-scroll" tabIndex={0} role="region" aria-label="Таблиця записів групи, прокручується горизонтально"><table className="seminar-activity__table"><caption>Записи на участь · {rangeResult.range ? `${shortDate(rangeResult.range.from)} — ${shortDate(rangeResult.range.to)}` : ''}</caption><thead><tr><th scope="col">Учасник</th>{subjects.map(item => <th scope="col" key={item.id}>{item.name}<span>основні + доповнення</span></th>)}<th scope="col">Окремо<span>команди / бронювання</span></th><th scope="col">Разом<span>індивідуальні записи</span></th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.member.id} className={currentUserId === row.member.id ? 'seminar-activity__self' : ''} style={{ '--row-delay': `${Math.min(index, 9) * 20}ms` } as CSSProperties}>
          <th scope="row"><button type="button" onClick={() => setSelectedUser(selectedUser === row.member.id ? '' : row.member.id)} aria-expanded={selectedUser === row.member.id} aria-controls={selectedUser === row.member.id ? `${panelId}-details` : undefined}><span className="seminar-activity__avatar" aria-hidden="true">{row.member.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><span>{row.member.name}{currentUserId === row.member.id && <small>Ви</small>}</span><ChevronRight size={14} /></button></th>
          {subjects.map(item => { const count = row.subjects[item.id]; return <td key={item.id}><span className={`seminar-activity__count ${count && individualActivityCount(count) > 0 ? 'seminar-activity__count--active' : ''}`} title={`${count?.primary || 0} основних; ${count?.supplement || 0} доповнень`}>{count ? individualActivityCount(count) : 0}</span>{count && count.supplement > 0 && <small>+{count.supplement} доп.</small>}</td> })}
          <td><span className="seminar-activity__separate"><UsersRound size={12} />{row.counts.team}<i />{row.counts.booking}</span></td><td><strong className="seminar-activity__total">{individualActivityCount(row.counts)}</strong></td>
        </tr>)}</tbody></table></div>
        {!rows.length && <p className="seminar-activity__empty">У цій групі поки немає підтверджених учасників.</p>}
        <footer className="seminar-activity__footer"><span><UsersRound size={13} />{rows.length} учасників · видно всій групі</span><span><ArrowDown size={12} /> Натисніть на ім’я, щоб побачити деталі</span></footer>
      </>}
    </div>}
  </section>
}
