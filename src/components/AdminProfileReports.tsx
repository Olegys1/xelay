import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, ExternalLink, Flag, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ParticipantStatusEmojis } from './ParticipantStatusEmoji'
import {
  loadAdminProfileReport, loadAdminProfileReports, reviewProfileReport, profileReportError, getProfileReportReasonLabel,
  PROFILE_REPORT_STATUS_LABELS, type ProfileReport, type ProfileReportFilter, type ProfileReportStatus,
} from '../lib/profileReports'

type ReportDetail = Awaited<ReturnType<typeof loadAdminProfileReport>>
type Decision = { report: ProfileReport; status: ProfileReportStatus; clearStatus: boolean }
const PAGE_SIZE = 20
const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
const primary = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'
const input = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50 sm:text-sm'
const filters: [ProfileReportFilter, string][] = [['open', 'Нові'], ['in_review', 'У роботі'], ['resolved', 'Завершені'], ['dismissed', 'Відхилені'], ['all', 'Усі']]
const activeReport = (report: ProfileReport) => report.status === 'open' || report.status === 'in_review'
const formatTime = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Kyiv' }).format(new Date(value)) : 'Дата недоступна'

export function AdminProfileReports() {
  const { authUser, xelayUser, isLoading } = useAuth()
  const adminUserId = !isLoading && authUser?.id && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin ? authUser.id : null
  const owner = useRef(adminUserId); owner.current = adminUserId
  if (!adminUserId) return null
  return <ProfileReportQueue key={adminUserId} adminUserId={adminUserId} isCurrentAdmin={() => owner.current === adminUserId} />
}

function ProfileReportQueue({ adminUserId, isCurrentAdmin }: { adminUserId: string; isCurrentAdmin: () => boolean }) {
  const id = useId()
  const [filter, setFilter] = useState<ProfileReportFilter>('open')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<{ items: ProfileReport[]; total: number; open_count: number }>({ items: [], total: 0, open_count: 0 })
  const [loading, setLoading] = useState(true), [stale, setStale] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [detailId, setDetailId] = useState(''), [detail, setDetail] = useState<ReportDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('')
  const [decision, setDecision] = useState<Decision | null>(null), [note, setNote] = useState(''), [decisionError, setDecisionError] = useState(''), [saving, setSaving] = useState(false)
  const mounted = useRef(false), listGeneration = useRef(0), detailGeneration = useRef(0), lock = useRef(false)
  const listBusy = useRef<number | null>(null)
  const noteDrafts = useRef(new Map<string, string>())
  const currentOwner = useRef(isCurrentAdmin); currentOwner.current = isCurrentAdmin
  const latestScope = useRef({ filter, offset }); latestScope.current = { filter, offset }
  const latestDetail = useRef(detailId); latestDetail.current = detailId
  const detailSnapshot = useRef(detail); detailSnapshot.current = detail
  const latestDecision = useRef(decision); latestDecision.current = decision
  const lastRefresh = useRef(0)
  const current = useCallback(() => mounted.current && currentOwner.current(), [])

  const load = useCallback(async () => {
    if (!current() || lock.current || listBusy.current !== null) return
    const ticket = ++listGeneration.current, scope = { filter, offset }
    listBusy.current = ticket
    const stillCurrent = () => current() && ticket === listGeneration.current
      && latestScope.current.filter === scope.filter && latestScope.current.offset === scope.offset
    setLoading(true); lastRefresh.current = Date.now()
    try {
      const result = await loadAdminProfileReports({ status: scope.filter, limit: PAGE_SIZE, offset: scope.offset })
      if (!stillCurrent()) return
      setPage(result); setError(''); setStale(false)
      const refreshed = result.items.find(item => item.id === latestDetail.current)
      if (refreshed && detailSnapshot.current?.report.id === refreshed.id && detailSnapshot.current.report.version !== refreshed.version) {
        setDetailError('Скаргу змінив інший адміністратор. Оновіть деталі перед рішенням.')
      }
    } catch (failure) {
      if (stillCurrent()) { setStale(true); setError(`${profileReportError(failure)} Збережена черга може бути застарілою. Оновіть її перед діями.`) }
    } finally { if (listBusy.current === ticket) listBusy.current = null; if (stillCurrent()) setLoading(false) }
  }, [current, filter, offset])

  const openDetail = useCallback(async (reportId: string) => {
    if (!current() || lock.current) return
    const ticket = ++detailGeneration.current
    latestDetail.current = reportId; setDetailId(reportId); setDetailLoading(true); setDetailError('')
    const stillCurrent = () => current() && ticket === detailGeneration.current && latestDetail.current === reportId
    try {
      const result = await loadAdminProfileReport(reportId)
      if (!stillCurrent()) return
      setDetail(result)
      setPage(previous => ({ ...previous, items: previous.items.map(item => item.id === result.report.id ? result.report : item) }))
    } catch (failure) { if (stillCurrent()) setDetailError(profileReportError(failure)) }
    finally { if (stillCurrent()) setDetailLoading(false) }
  }, [current])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++listGeneration.current; ++detailGeneration.current; listBusy.current = null }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current > 5000 && !lock.current && !latestDecision.current) void load()
    }
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh)
    const interval = window.setInterval(refresh, 60_000)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh) }
  }, [load])

  const closeDetail = () => { ++detailGeneration.current; latestDetail.current = ''; setDetailId(''); setDetail(null); setDetailError(''); setDetailLoading(false) }
  const changePage = (nextFilter: ProfileReportFilter, nextOffset: number) => {
    if (lock.current || !current()) return
    ++listGeneration.current; listBusy.current = null; closeDetail(); setDecision(null); setNotice(''); setError(''); setStale(false)
    setPage(previous => ({ ...previous, items: [], total: 0 })); setLoading(true); setFilter(nextFilter); setOffset(nextOffset)
  }
  const beginDecision = (report: ProfileReport, status: ProfileReportStatus, clearStatus = false) => {
    if (!current() || loading || stale || detailLoading || detailError || lock.current || !activeReport(report)) return
    setDecision({ report, status, clearStatus }); setNote(noteDrafts.current.get(decisionDraftKey(report.id, status, clearStatus)) || ''); setDecisionError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!decision || !current() || lock.current || loading || stale || detailLoading || detailError) return
    const saved = decision, trimmed = note.trim()
    const noteLength = Array.from(trimmed).length
    if (noteLength > 2000 || saved.status !== 'in_review' && noteLength < 10) { setDecisionError('Для завершення розгляду або відхилення додайте нотатку від 10 до 2000 символів.'); return }
    const actual = detail?.report
    if (!actual || actual.id !== saved.report.id || actual.version !== saved.report.version || !activeReport(actual)) { setDecisionError('Цю скаргу вже змінено. Закрийте дію й оновіть її перед рішенням.'); return }
    if (saved.clearStatus && !canClearReportedStatus(detail)) { setDecisionError('Поточний статус змінився або вже відсутній. Його не буде видалено. Оновіть деталі скарги.'); return }
    lock.current = true; setSaving(true); setDecisionError(''); setError('')
    try {
      await reviewProfileReport({ reportId: actual.id, expectedVersion: actual.version, status: saved.status, note: trimmed, action: saved.clearStatus ? 'clear_status' : 'none' })
      if (!current()) return
      noteDrafts.current.delete(decisionDraftKey(saved.report.id, saved.status, saved.clearStatus))
      setDecision(null); closeDetail()
      setNotice(saved.clearStatus ? 'Статус прибрано, розгляд завершено. Скарга та історія збережені.' : saved.status === 'in_review' ? 'Скаргу взято в роботу.' : saved.status === 'dismissed' ? 'Скаргу відхилено. Рішення збережене в історії.' : 'Розгляд завершено. Рішення збережене в історії.')
    } catch (failure) {
      if (current()) { setDecisionError(profileReportError(failure)); setStale(true); setError('Потрібно оновити чергу й деталі перед повторною дією. Нотатка збережеться для повторного відкриття цієї дії в поточній вкладці.') }
    } finally {
      lock.current = false
      if (current()) { setSaving(false); if (!latestDetail.current) void load() }
    }
  }

  const disabled = loading || stale || saving
  return <section id="admin-profile-reports" aria-labelledby={`${id}-title`} className="xelay-card mb-6 scroll-mt-28 overflow-hidden">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6"><div><h2 id={`${id}-title`} className="flex flex-wrap items-center gap-2 font-semibold"><Flag size={18} className="text-primary" aria-hidden="true" />Скарги на профілі та статуси<span aria-label={`Відкритих скарг: ${page.open_count}`} className={`rounded-full px-2.5 py-0.5 text-xs ${page.open_count ? 'bg-red-600 text-white' : 'bg-muted text-muted-foreground'}`}>{page.open_count}</span></h2><p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">Кожне звернення перевіряється окремо. Кількість скарг сама по собі не спричиняє блокування. Дії доступні адміністраторам із підтвердженим захистом акаунта.</p></div><button type="button" onClick={() => void load()} disabled={loading || saving} className={button}><RefreshCw size={15} aria-hidden="true" />Оновити чергу</button></header>
    <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3" role="group" aria-label="Фільтр скарг">{filters.map(([value, label]) => <button type="button" key={value} disabled={saving || value === filter && offset === 0} aria-pressed={filter === value} onClick={() => changePage(value, 0)} className={`${button} ${filter === value ? 'border-primary bg-primary/5 text-primary' : ''}`}>{label}</button>)}</div>
    {error && <p role="alert" className="m-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive">{error}</p>}
    {notice && <p role="status" className="m-4 rounded-xl bg-primary/5 p-3 text-sm">{notice}</p>}
    {loading && <p role="status" className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground"><Loader2 size={17} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Оновлюємо скарги…</p>}
    {!page.items.length && !loading && !error && <p className="px-5 py-8 text-sm text-muted-foreground">У цьому списку скарг немає.</p>}
    <div className="divide-y divide-border">{page.items.map(report => {
      const expanded = detailId === report.id, shown = detail?.report.id === report.id ? detail : null
      return <article key={report.id} className={`space-y-4 px-5 py-5 sm:px-6 ${stale ? 'opacity-75' : ''}`} aria-label={`Скарга на ${report.target_snapshot.full_name || 'учасника Xelay'}`}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><ProfileIdentity title="На кого скарга" userId={report.target_user_id} snapshot={report.target_snapshot} /><p className="mt-2 text-xs text-muted-foreground">{report.kind === 'status' ? 'Емодзі / текстовий статус' : 'Профіль'} · {formatTime(report.created_at)} · {PROFILE_REPORT_STATUS_LABELS[report.status]}</p></div><button type="button" onClick={() => expanded ? closeDetail() : void openDetail(report.id)} disabled={saving} aria-expanded={expanded} className={button}>{expanded ? 'Згорнути' : 'Переглянути скаргу'}</button></div>
        <div className="rounded-xl bg-muted/40 p-3"><ProfileIdentity title="Від кого" userId={report.reporter_id} snapshot={report.reporter_snapshot} /><p className="mt-3 text-sm font-medium">{getProfileReportReasonLabel(report.reason)}</p>{report.details && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{report.details}</p>}</div>
        {report.kind === 'status' && <StatusEvidence title="Статус на момент скарги" status={report.target_snapshot} />}
        {expanded && <div className="space-y-4 rounded-2xl border border-border p-4">
          {detailLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Завантажуємо деталі й поточний статус…</p>}
          {detailError && <p role="alert" className="text-sm text-destructive">{detailError}<button type="button" disabled={detailLoading || saving} onClick={() => void openDetail(report.id)} className="ml-2 underline underline-offset-4">Повторити</button></p>}
          {shown && <>
            <ProfileSnapshot report={report} />
            <StatusEvidence title="Поточний статус" status={shown.current_status} />
            {report.kind === 'status' && !canClearReportedStatus(shown) && <p className="rounded-xl bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">Поточний статус відсутній або відрізняється від збереженого. Новий статус не видаляється за старою скаргою; звернення можна розглянути й зберегти рішення.</p>}
            <ReportHistory history={shown.history} />
            {activeReport(shown.report) ? <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {shown.report.status === 'open' && <button type="button" disabled={disabled || detailLoading || Boolean(detailError)} className={button} onClick={() => beginDecision(shown.report, 'in_review')}>Взяти в роботу</button>}
              <button type="button" disabled={disabled || detailLoading || Boolean(detailError)} className={primary} onClick={() => beginDecision(shown.report, 'resolved')}><Check size={15} />Завершити розгляд</button>
              <button type="button" disabled={disabled || detailLoading || Boolean(detailError)} className={button} onClick={() => beginDecision(shown.report, 'dismissed')}>Відхилити</button>
              {shown.report.kind === 'status' && <button type="button" disabled={disabled || detailLoading || Boolean(detailError) || !canClearReportedStatus(shown)} className={`${button} text-destructive`} onClick={() => beginDecision(shown.report, 'resolved', true)}><Trash2 size={15} />Прибрати статус</button>}
            </div> : <p className="text-xs text-muted-foreground">Розгляд завершений. Скарга та історія залишаються доступними для перевірки.</p>}
          </>}
        </div>}
      </article>
    })}</div>
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4"><p className="text-xs text-muted-foreground">{page.items.length ? `${offset + 1}–${offset + page.items.length} із ${page.total}` : `Усього: ${page.total}`}{stale ? ' · Дані потребують оновлення' : ''}</p><div className="flex gap-2"><button type="button" className={button} disabled={loading || saving || offset === 0} onClick={() => changePage(filter, Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={16} />Назад</button><button type="button" className={button} disabled={loading || saving || offset + page.items.length >= page.total || !page.items.length} onClick={() => changePage(filter, offset + PAGE_SIZE)}>Далі<ChevronRight size={16} /></button></div></footer>
    {decision && <ReportDecisionDialog title={decision.clearStatus ? 'Прибрати статус і завершити розгляд?' : decision.status === 'in_review' ? 'Взяти скаргу в роботу?' : decision.status === 'dismissed' ? 'Відхилити скаргу?' : 'Завершити розгляд?'} danger={decision.clearStatus} busy={saving} onClose={() => { if (!lock.current) { setDecision(null); setDecisionError('') } }}>
      <form onSubmit={event => void submit(event)} className="space-y-4">
        <p className="break-words text-sm font-medium">{decision.report.target_snapshot.full_name || 'Учасник Xelay'}{decision.report.target_snapshot.username ? ` · @${decision.report.target_snapshot.username}` : ''}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{decision.clearStatus ? 'Буде прибрано тільки текст і емодзі цього збереженого статусу, якщо користувач їх не змінював. Скарга та історія збережуться. Це не блокує акаунт.' : decision.status === 'in_review' ? 'Позначте звернення для подальшої перевірки. Нотатка необов’язкова.' : 'Рішення й нотатка збережуться в історії. Завершення розгляду саме по собі не змінює профіль і не блокує акаунт.'}</p>
        {decision.clearStatus && <StatusEvidence title="Статус, який буде прибрано" status={decision.report.target_snapshot} />}
        <label className="block text-sm font-medium">Нотатка адміністратора {decision.status === 'in_review' ? '(необов’язково)' : '*'}<textarea autoFocus value={note} onChange={event => { setNote(event.target.value); noteDrafts.current.set(decisionDraftKey(decision.report.id, decision.status, decision.clearStatus), event.target.value) }} rows={4} maxLength={2000} minLength={decision.status === 'in_review' ? undefined : 10} required={decision.status !== 'in_review'} disabled={saving} className={`${input} mt-2`} /></label>
        <p className="text-xs text-muted-foreground">{Array.from(note.trim()).length}/2000 · {decision.status === 'in_review' ? 'Внутрішня інформація для розгляду.' : 'Мінімум 10 символів.'}</p>
        {decisionError && <p role="alert" className="text-sm text-destructive">{decisionError}</p>}
        {stale && <p role="alert" className="text-sm text-destructive">Дані змінилися або їх не вдалося перевірити. Закрийте це вікно й оновіть чергу перед новою дією.</p>}
        <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={saving} onClick={() => setDecision(null)} className={button}>Скасувати</button><button type="submit" disabled={saving || stale || loading || detailLoading || Boolean(detailError) || decision.status !== 'in_review' && Array.from(note.trim()).length < 10} className={decision.clearStatus ? `${button} border-destructive/30 text-destructive` : primary}>{saving && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />}{saving ? 'Зберігаємо…' : decision.clearStatus ? 'Прибрати статус і завершити' : 'Зберегти рішення'}</button></div>
      </form>
    </ReportDecisionDialog>}
  </section>
}

export function canClearReportedStatus(detail: ReportDetail): boolean {
  const report = detail.report, status = detail.current_status
  return Boolean(report.kind === 'status' && activeReport(report) && status?.is_premium
    && (report.target_snapshot.status_text || report.target_snapshot.emoji_status)
    && status.status_text === report.target_snapshot.status_text && status.emoji_status === report.target_snapshot.emoji_status)
}

export const decisionDraftKey = (reportId: string, status: ProfileReportStatus, clearStatus: boolean) => `${reportId}:${status}:${clearStatus ? 'clear_status' : 'none'}`

export function safeReportAvatarUrl(value: string | null, storageUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined): string | null {
  if (!value || !storageUrl) return null
  try {
    const url = new URL(value), expected = new URL(storageUrl)
    const path = decodeURIComponent(url.pathname)
    if (url.protocol !== 'https:' || expected.protocol !== 'https:' || url.origin !== expected.origin
      || url.username || url.password || url.hash || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')
      || !path.startsWith('/storage/v1/object/public/avatars/') || path.endsWith('/')) return null
    return url.href
  } catch { return null }
}

function SnapshotAvatar({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false)
  return url && !failed ? <img src={url} alt="Фото профілю на момент скарги" width={80} height={80} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-20 w-20 rounded-xl object-cover" />
    : <p className="text-xs text-muted-foreground">Фото на момент скарги недоступне.</p>
}

function ProfileSnapshot({ report }: { report: ProfileReport }) {
  const snapshot = report.target_snapshot, avatar = safeReportAvatarUrl(snapshot.avatar_url)
  const fields = [
    ['Ім’я', snapshot.full_name], ['Нік', snapshot.username], ['Факультет / інститут', snapshot.faculty],
    ['Освітня програма', snapshot.specialty], ['Курс', snapshot.study_year ? `${snapshot.study_year} курс` : null],
    ['Навчальний статус', ({ bachelor: 'Студент бакалаврату', master: 'Студент магістратури', postgraduate: 'Аспірант / аспірантка', graduate: 'Випускник / випускниця' } as Record<string, string>)[snapshot.experience || ''] || snapshot.experience],
    ['Підписка на момент скарги', snapshot.is_premium ? 'Учасник' : 'Без підписки'],
  ]
  return <section className="space-y-3" aria-label="Збережений профіль"><h3 className="text-sm font-semibold">Профіль на момент скарги</h3><SnapshotAvatar key={avatar || 'unavailable'} url={avatar} /><dl className="grid gap-3 text-xs sm:grid-cols-2">{fields.map(([label, value]) => <div key={label}><dt className="font-medium text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{value || 'Не зазначено'}</dd></div>)}</dl><div><h4 className="text-xs font-medium text-muted-foreground">Про себе</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm">{snapshot.bio || 'Не зазначено'}</p></div>{report.kind === 'profile' && <StatusEvidence title="Статус на момент скарги" status={snapshot} />}</section>
}

function ProfileIdentity({ title, userId, snapshot }: { title: string; userId: string | null; snapshot: { user_id: string; full_name: string | null; username: string | null } }) {
  return <div className="min-w-0"><p className="text-[11px] font-medium text-muted-foreground">{title}</p>{userId ? <a href={`/user/${encodeURIComponent(userId)}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-words text-sm font-semibold text-primary underline-offset-4 hover:underline"><span className="min-w-0 break-words">{snapshot.full_name || 'Учасник Xelay'}{snapshot.username ? ` · @${snapshot.username}` : ''}</span><ExternalLink size={13} className="shrink-0" aria-hidden="true" /><span className="sr-only"> (відкриється в новій вкладці)</span></a> : <p className="mt-1 text-sm font-semibold">{snapshot.full_name || 'Учасник Xelay'} · акаунт видалено</p>}<p className="mt-1 break-all text-[10px] text-muted-foreground">ID: {userId || snapshot.user_id}</p></div>
}

function StatusEvidence({ title, status }: { title: string; status: { status_text: string | null; emoji_status: string | null } | null | undefined }) {
  return <div className="rounded-xl border border-border bg-background p-3"><h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>{status && (status.status_text || status.emoji_status) ? <div className="mt-2 flex flex-wrap items-center gap-2">{status.emoji_status && <ParticipantStatusEmojis status={status.emoji_status} label={title} />}{status.status_text && <p className="min-w-0 whitespace-pre-wrap break-words text-sm">{status.status_text}</p>}</div> : <p className="mt-2 text-xs text-muted-foreground">Статус відсутній або профіль недоступний.</p>}</div>
}

function ReportHistory({ history }: { history: ReportDetail['history'] }) {
  return <details className="rounded-xl bg-muted/30 p-3"><summary className="cursor-pointer text-sm font-medium">Історія розгляду · {history.length}</summary>{history.length ? <ol className="mt-3 space-y-3">{history.map(item => <li key={item.id} className="border-l-2 border-border pl-3 text-xs"><p className="font-medium">{item.action === 'submit' ? 'Подання скарги' : PROFILE_REPORT_STATUS_LABELS[item.to_status]}{item.action === 'clear_status' ? ' · Статус прибрано' : ''} · {formatTime(item.created_at)}</p>{item.note && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{item.note}</p>}<p className="mt-1 break-all text-[10px] text-muted-foreground">{item.action === 'submit' ? 'Автор скарги' : 'Адміністратор'}: {item.actor_id || 'Недоступний'}</p></li>)}</ol> : <p className="mt-2 text-xs text-muted-foreground">Рішень ще немає.</p>}</details>
}

function ReportDecisionDialog({ title, children, danger, busy, onClose }: { title: string; children: ReactNode; danger: boolean; busy: boolean; onClose: () => void }) {
  const id = useId(), dialog = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; dialog.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="xelay-dialog-backdrop fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-3 backdrop-blur-sm" onMouseDown={event => { if (event.currentTarget === event.target && !busy) close.current() }}><div ref={dialog} tabIndex={-1} role={danger ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy} className="xelay-dialog-panel max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl outline-none" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close.current(); return }
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href]') || []).filter(item => item.tabIndex >= 0 && item.offsetParent !== null)
    const first = controls[0], last = controls[controls.length - 1]
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
  }}><header className="mb-4 flex items-start justify-between gap-3"><h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Закрити дію" className="rounded-full p-2 hover:bg-muted disabled:opacity-50"><X size={19} /></button></header>{children}</div></div>
}
