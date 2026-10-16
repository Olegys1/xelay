import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, GraduationCap, Loader2, RefreshCw, Search, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  adminStudyGroupsError, loadAdminStudyGroupMembers, loadAdminStudyGroups,
  type AdminStudyGroupSummary, type AdminStudyGroupMember, type AdminStudyGroupSort,
  type AdminStudyGroupMemberFilter, type AdminStudyGroupsPage, type AdminStudyGroupMembersPage,
} from '../lib/adminStudyGroups'
import { studyGroupIdentityLabel } from '../lib/studyGroupIdentity'
import { ChatDialog, chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'

const GROUP_PAGE_SIZE = 20
const MEMBER_PAGE_SIZE = 50
const FOCUS_REFRESH_MS = 15_000
const memberFilters: [AdminStudyGroupMemberFilter, string][] = [['accepted', 'У групі'], ['pending', 'Запрошення'], ['inactive', 'Неактивні']]
const statusLabels: Record<AdminStudyGroupMember['status'], string> = { accepted: 'У групі', pending: 'Очікує відповіді', rejected: 'Відхилено', removed: 'Видалено з групи' }
const accessDenied = (failure: unknown) => {
  const value = failure && typeof failure === 'object' ? failure as { code?: unknown; message?: unknown } : {}
  return value.code === '42501' || typeof value.message === 'string' && /ADMIN_MFA_REQUIRED/.test(value.message)
}
type GroupScope = { query: string; sort: AdminStudyGroupSort; offset: number }
type MemberScope = { query: string; status: AdminStudyGroupMemberFilter; offset: number }

export function AdminStudyGroups() {
  const { authUser, xelayUser, isLoading } = useAuth()
  const adminUserId = !isLoading && authUser?.id && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin ? authUser.id : null
  const owner = useRef(adminUserId); owner.current = adminUserId
  if (!adminUserId) return null
  return <StudyGroupDirectory key={adminUserId} isCurrentAdmin={() => owner.current === adminUserId} />
}

function StudyGroupDirectory({ isCurrentAdmin }: { isCurrentAdmin: () => boolean }) {
  const id = useId()
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<GroupScope>({ query: '', sort: 'name', offset: 0 })
  const [page, setPage] = useState<AdminStudyGroupsPage | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<AdminStudyGroupSummary | null>(null)
  const mounted = useRef(false), generation = useRef(0), busy = useRef<number | null>(null), lastRefresh = useRef(0)
  const currentOwner = useRef(isCurrentAdmin); currentOwner.current = isCurrentAdmin
  const scopeKey = JSON.stringify(scope), latestScope = useRef(scopeKey); latestScope.current = scopeKey
  const detailOpen = useRef(Boolean(selectedGroup)); detailOpen.current = Boolean(selectedGroup)
  const current = useCallback(() => mounted.current && currentOwner.current(), [])

  const load = useCallback(async () => {
    if (!current() || busy.current !== null) return
    const ticket = ++generation.current, requestedScope = scopeKey
    busy.current = ticket; lastRefresh.current = Date.now(); setLoading(true)
    const stillCurrent = () => current() && generation.current === ticket && latestScope.current === requestedScope
    try {
      const result = await loadAdminStudyGroups(scope.query, scope.sort, GROUP_PAGE_SIZE, scope.offset)
      if (!stillCurrent()) return
      setPage(result); setError(''); setStale(false)
    } catch (failure) {
      if (stillCurrent()) {
        setError(adminStudyGroupsError(failure)); setStale(!accessDenied(failure))
        if (accessDenied(failure)) { setPage(null); setSelectedGroup(null) }
      }
    } finally {
      if (busy.current === ticket) busy.current = null
      if (stillCurrent()) setLoading(false)
    }
  }, [current, scope, scopeKey])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++generation.current; busy.current = null }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && !detailOpen.current && Date.now() - lastRefresh.current >= FOCUS_REFRESH_MS) void load()
    }
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh)
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh) }
  }, [load])

  const changeScope = (next: GroupScope) => {
    if (!current()) return
    ++generation.current; busy.current = null
    latestScope.current = JSON.stringify(next)
    setPage(null); setError(''); setStale(false); setLoading(true); setScope(next)
  }
  const search = (event: FormEvent) => { event.preventDefault(); changeScope({ ...scope, query: draft.trim(), offset: 0 }) }
  const denyAccess = useCallback((failure: unknown) => {
    if (!current()) return
    ++generation.current; busy.current = null
    setPage(null); setSelectedGroup(null); setLoading(false); setStale(false); setError(adminStudyGroupsError(failure))
  }, [current])
  const updateGroup = useCallback((group: AdminStudyGroupSummary) => {
    if (!current()) return
    setPage(previous => previous ? { ...previous, items: previous.items.map(item => item.id === group.id ? group : item) } : previous)
    setSelectedGroup(previous => previous?.id === group.id ? group : previous)
  }, [current])

  return <section id="admin-study-groups" aria-labelledby={`${id}-title`} className="xelay-card mb-6 scroll-mt-28 overflow-hidden">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
      <div className="min-w-0"><h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold"><GraduationCap size={19} className="shrink-0 text-primary" aria-hidden="true" />Навчальні групи</h2><p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">Кількість учасників і склад кожної групи. Старосту враховано в кількості «У групі» один раз.</p></div>
      <button type="button" className={chatButton} disabled={loading} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />Оновити групи</button>
    </header>
    <form onSubmit={search} className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4 sm:px-6">
      <label className="min-w-0 flex-[2_1_15rem] space-y-1.5"><span className="block text-xs font-medium">Знайти групу або старосту</span><input type="search" maxLength={120} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Назва групи, ім’я або @нік старости" className={chatInput} /></label>
      <label className="min-w-0 flex-[1_1_12rem] space-y-1.5"><span className="block text-xs font-medium">Сортування</span><select value={scope.sort} onChange={event => changeScope({ ...scope, sort: event.target.value as AdminStudyGroupSort, offset: 0 })} className={chatInput}><option value="name">За назвою</option><option value="members_desc">Спочатку більше учасників</option><option value="members_asc">Спочатку менше учасників</option></select></label>
      <button type="submit" className={chatPrimary}><Search size={15} aria-hidden="true" />Знайти</button>
    </form>
    {error && <LoadError error={error} stale={Boolean(page) && stale} retry={() => void load()} disabled={loading} />}
    {loading && <Loading text="Завантажуємо навчальні групи…" />}
    {!loading && page?.items.length === 0 && !error && <p className="px-5 py-8 text-sm text-muted-foreground">{scope.query ? 'За цим запитом груп не знайдено. Спробуйте іншу назву або ім’я старости.' : 'Навчальних груп поки немає.'}</p>}
    <div className="divide-y divide-border" aria-busy={loading}>
      {page?.items.map(group => <article key={group.id} aria-label={`Група ${group.group_name}`} className={`space-y-4 px-5 py-5 sm:px-6 ${stale ? 'opacity-75' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-[1_1_16rem]"><GroupIdentity group={group} /><p className="mt-2 break-words text-sm text-muted-foreground">Староста: <span className="font-medium text-foreground">{group.representative.full_name || group.representative.username || 'Ім’я не вказано'}</span>{group.representative.username && <span className="ml-1 break-all">@{group.representative.username.replace(/^@/, '')}</span>}</p></div><GroupCounts group={group} /></div>
        <button type="button" className={chatButton} onClick={() => { if (current()) setSelectedGroup(group) }}><Users size={15} aria-hidden="true" />Переглянути склад<span className="sr-only"> групи {group.group_name}, {studyGroupIdentityLabel(group)}</span></button>
      </article>)}
    </div>
    <Pagination offset={scope.offset} count={page?.items.length ?? 0} total={page?.total ?? null} loading={loading} onPrevious={() => changeScope({ ...scope, offset: Math.max(0, scope.offset - GROUP_PAGE_SIZE) })} onNext={() => changeScope({ ...scope, offset: scope.offset + GROUP_PAGE_SIZE })} label="Навігація навчальними групами" />
    {selectedGroup && <StudyGroupMembers key={selectedGroup.id} initialGroup={selectedGroup} isCurrentAdmin={isCurrentAdmin} onAccessDenied={denyAccess} onGroupLoaded={updateGroup} onClose={() => setSelectedGroup(null)} />}
  </section>
}

function StudyGroupMembers({ initialGroup, isCurrentAdmin, onAccessDenied, onGroupLoaded, onClose }: { initialGroup: AdminStudyGroupSummary; isCurrentAdmin: () => boolean; onAccessDenied: (failure: unknown) => void; onGroupLoaded: (group: AdminStudyGroupSummary) => void; onClose: () => void }) {
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<MemberScope>({ query: '', status: 'accepted', offset: 0 })
  const [page, setPage] = useState<AdminStudyGroupMembersPage | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const mounted = useRef(false), generation = useRef(0), busy = useRef<number | null>(null), lastRefresh = useRef(0)
  const currentOwner = useRef(isCurrentAdmin); currentOwner.current = isCurrentAdmin
  const scopeKey = JSON.stringify(scope), latestScope = useRef(scopeKey); latestScope.current = scopeKey
  const current = useCallback(() => mounted.current && currentOwner.current(), [])

  const load = useCallback(async () => {
    if (!current() || busy.current !== null) return
    const ticket = ++generation.current, requestedScope = scopeKey
    busy.current = ticket; lastRefresh.current = Date.now(); setLoading(true)
    const stillCurrent = () => current() && generation.current === ticket && latestScope.current === requestedScope
    try {
      const result = await loadAdminStudyGroupMembers(initialGroup.id, scope.status, scope.query, MEMBER_PAGE_SIZE, scope.offset)
      if (!stillCurrent()) return
      setPage(result); setError(''); setStale(false); onGroupLoaded(result.group)
    } catch (failure) {
      if (stillCurrent()) {
        if (accessDenied(failure)) { onAccessDenied(failure); return }
        setError(adminStudyGroupsError(failure)); setStale(true)
      }
    } finally {
      if (busy.current === ticket) busy.current = null
      if (stillCurrent()) setLoading(false)
    }
  }, [current, initialGroup.id, onAccessDenied, onGroupLoaded, scope, scopeKey])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++generation.current; busy.current = null }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current >= FOCUS_REFRESH_MS) void load() }
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh)
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh) }
  }, [load])

  const changeScope = (next: MemberScope) => {
    if (!current()) return
    ++generation.current; busy.current = null
    latestScope.current = JSON.stringify(next)
    setPage(null); setError(''); setStale(false); setLoading(true); setScope(next)
  }
  const search = (event: FormEvent) => { event.preventDefault(); changeScope({ ...scope, query: draft.trim(), offset: 0 }) }
  const group = page?.group || initialGroup
  return <ChatDialog title={`Склад групи «${initialGroup.group_name}»`} onClose={onClose} wide>
    <div className="space-y-5">
      <GroupIdentity group={group} />
      <GroupCounts group={group} />
      <p className="rounded-xl bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">Показано учасників і надіслані запрошення. Щоб визначити, кого ще немає, порівняйте зі списком академічної групи.</p>
      <div role="group" aria-label="Фільтр складу групи" className="flex flex-wrap gap-2">{memberFilters.map(([value, label]) => <button type="button" key={value} className={`${chatButton} ${scope.status === value ? 'border-primary bg-primary/5 text-primary' : ''}`} aria-pressed={scope.status === value} onClick={() => { setDraft(''); changeScope({ query: '', status: value, offset: 0 }) }} disabled={scope.status === value}>{label}</button>)}</div>
      <form onSubmit={search} className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-[1_1_15rem] space-y-1.5"><span className="block text-xs font-medium">Знайти учасника за ім’ям або ніком</span><input type="search" value={draft} maxLength={120} onChange={event => setDraft(event.target.value)} className={chatInput} placeholder="Ім’я, прізвище або @нік" /></label><button type="submit" className={chatPrimary}><Search size={15} aria-hidden="true" />Знайти</button><button type="button" className={chatButton} disabled={loading} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />Оновити склад</button></form>
      {error && <LoadError error={error} stale={Boolean(page) && stale} retry={() => void load()} disabled={loading} />}
      {loading && <Loading text="Завантажуємо склад групи…" />}
      {!loading && page?.items.length === 0 && !error && <p className="py-4 text-sm text-muted-foreground">{scope.query ? 'За цим запитом учасників не знайдено.' : scope.status === 'pending' ? 'Запрошень, що очікують відповіді, немає.' : scope.status === 'inactive' ? 'Неактивних учасників немає.' : 'У цьому списку поки немає учасників.'}</p>}
      <ul className={`divide-y divide-border ${stale ? 'opacity-75' : ''}`} aria-label="Учасники групи" aria-busy={loading}>{page?.items.map(member => <MemberRow key={member.user_id} member={member} />)}</ul>
      <Pagination offset={scope.offset} count={page?.items.length ?? 0} total={page?.total ?? null} loading={loading} onPrevious={() => changeScope({ ...scope, offset: Math.max(0, scope.offset - MEMBER_PAGE_SIZE) })} onNext={() => changeScope({ ...scope, offset: scope.offset + MEMBER_PAGE_SIZE })} label="Навігація складом групи" />
    </div>
  </ChatDialog>
}

function GroupIdentity({ group }: { group: AdminStudyGroupSummary }) {
  return <div className="min-w-0"><h3 className="break-words text-base font-semibold">{group.group_name}</h3><p className="mt-1 break-words text-sm font-medium text-primary">{studyGroupIdentityLabel(group)}</p><p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{[group.university_name, group.unit_name].filter(Boolean).join(' · ') || 'Університет або факультет не вказано'}</p>{group.specialty && <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{group.specialty}</p>}</div>
}

function GroupCounts({ group }: { group: AdminStudyGroupSummary }) {
  return <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><div><dt className="text-xs text-muted-foreground">У групі</dt><dd className="mt-0.5 text-xl font-semibold tabular-nums text-primary">{group.accepted_count}</dd></div><div><dt className="text-xs text-muted-foreground">Очікують</dt><dd className="mt-0.5 text-xl font-semibold tabular-nums">{group.pending_count}</dd></div><div><dt className="text-xs text-muted-foreground">Неактивні</dt><dd className="mt-0.5 text-xl font-semibold tabular-nums text-muted-foreground">{group.inactive_count}</dd></div></dl>
}

function MemberRow({ member }: { member: AdminStudyGroupMember }) {
  const date = member.status === 'accepted' ? member.accepted_at : member.status === 'pending' ? member.invited_at : null
  return <li className="flex flex-wrap items-start justify-between gap-2 py-3"><div className="min-w-0 flex-[1_1_13rem]"><p className="break-words text-sm font-medium">{member.full_name || member.username || 'Ім’я не вказано'}{member.is_representative && <span className="ml-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">Староста</span>}</p>{member.username && <p className="mt-0.5 break-all text-xs text-muted-foreground">@{member.username.replace(/^@/, '')}</p>}</div><div className="text-xs text-muted-foreground"><p>{statusLabels[member.status]}</p>{date && Number.isFinite(Date.parse(date)) && <p className="mt-1">{member.status === 'accepted' ? 'Приєднання: ' : 'Запрошення: '}{new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeZone: 'Europe/Kyiv' }).format(new Date(date))}</p>}</div></li>
}

function Loading({ text }: { text: string }) {
  return <p role="status" className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground"><Loader2 size={17} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{text}</p>
}

function LoadError({ error, stale, retry, disabled }: { error: string; stale: boolean; retry: () => void; disabled: boolean }) {
  return <div role="alert" className="m-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive"><p>{error}</p>{stale && <p className="mt-1">Показані дані можуть бути застарілими.</p>}<button type="button" className="mt-2 font-medium underline underline-offset-4 disabled:opacity-50" disabled={disabled} onClick={retry}>Повторити завантаження</button></div>
}

function Pagination({ offset, count, total, loading, onPrevious, onNext, label }: { offset: number; count: number; total: number | null; loading: boolean; onPrevious: () => void; onNext: () => void; label: string }) {
  return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4"><p className="text-xs text-muted-foreground" role="status">{total === null ? loading ? 'Завантаження…' : 'Кількість недоступна' : count ? `${offset + 1}–${offset + count} із ${total}` : `Усього: ${total}`}</p><div className="flex flex-wrap gap-2"><button type="button" className={chatButton} disabled={loading || offset === 0} onClick={onPrevious}><ChevronLeft size={16} aria-hidden="true" />Назад</button><button type="button" className={chatButton} disabled={loading || total === null || offset + count >= total || !count} onClick={onNext}>Далі<ChevronRight size={16} aria-hidden="true" /></button></div></nav>
}
