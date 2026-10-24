import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, GraduationCap, Link2, Loader2, RefreshCw, Search, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  adminStudyGroupsError, loadAdminStudyGroupMembers, loadAdminStudyGroups,
  type AdminStudyGroupSummary, type AdminStudyGroupMember, type AdminStudyGroupSort,
  type AdminStudyGroupMemberFilter, type AdminStudyGroupsPage, type AdminStudyGroupMembersPage,
} from '../lib/adminStudyGroups'
import { studyGroupIdentityLabel } from '../lib/studyGroupIdentity'
import { ChatDialog, chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'
import { supabase } from '../lib/supabase'
import { LESSON_TYPES } from '../lib/studyGroupTimetable'

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
  const [scheduleRepairBusy, setScheduleRepairBusy] = useState(false)
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
  return <ChatDialog title={`Склад групи «${initialGroup.group_name}»`} onClose={onClose} busy={scheduleRepairBusy} wide>
    <div className="space-y-5">
      <GroupIdentity group={group} />
      <GroupCounts group={group} />
      <ScheduleCopyLinkRepair groupId={initialGroup.id} isCurrentAdmin={isCurrentAdmin} onAccessDenied={onAccessDenied} onBusyChange={setScheduleRepairBusy} />
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

type ScheduleLinkRepairPair = { source_id: string; target_id: string; subject: string; lesson_type: string; source_date: string; target_date: string; starts_at: string; ends_at: string }
type ScheduleLinkRepairPreview = { count: number; signature: string; pairs: ScheduleLinkRepairPair[]; repaired?: number }
const repairUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const repairDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
const repairDateLabel = (value: string) => new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' }).format(new Date(`${value}T12:00:00Z`))
function scheduleLinkRepairResult(value: unknown, applying: boolean): ScheduleLinkRepairPreview {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (!Number.isInteger(row.count) || Number(row.count) < 0 || Number(row.count) > 1000 || typeof row.signature !== 'string' || !row.signature || row.signature.length > 256 || !Array.isArray(row.pairs) || row.pairs.length !== row.count
    || applying && (!Number.isInteger(row.repaired) || row.repaired !== row.count)) throw new Error('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')
  const pairs = row.pairs.map(value => {
    const pair = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    if (typeof pair.source_id !== 'string' || !repairUuid.test(pair.source_id) || typeof pair.target_id !== 'string' || !repairUuid.test(pair.target_id) || pair.source_id === pair.target_id
      || typeof pair.subject !== 'string' || !pair.subject.trim() || pair.subject.length > 120 || typeof pair.lesson_type !== 'string'
      || !repairDate(pair.source_date) || !repairDate(pair.target_date) || typeof pair.starts_at !== 'string' || typeof pair.ends_at !== 'string'
      || !/^\d{2}:\d{2}(?::\d{2})?$/.test(pair.starts_at) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(pair.ends_at)) throw new Error('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')
    return pair as ScheduleLinkRepairPair
  })
  if (new Set(pairs.map(pair => pair.target_id)).size !== pairs.length) throw new Error('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')
  return { count: Number(row.count), signature: row.signature, pairs, ...(applying ? { repaired: Number(row.repaired) } : {}) }
}
function scheduleLinkRepairError(failure: unknown) {
  const row = failure && typeof failure === 'object' ? failure as { code?: string; message?: string } : {}
  const message = row.message || ''
  if (accessDenied(failure) || message.includes('SCHEDULE_COPY_LINK_REPAIR_ADMIN_REQUIRED')) return 'Потрібен чинний вхід адміністратора з двоетапним підтвердженням.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_CONFLICT') || row.code === '40001') return 'Розклад змінився після попереднього перегляду. Перегляньте пари ще раз перед відновленням.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_TOO_LARGE')) return 'У цій групі забагато відповідників для автоматичного відновлення. Зверніться до розробника.'
  if (row.code === 'PGRST202' || row.code === '42883') return 'Відновлення посилань ще підключається. Спробуйте трохи пізніше.'
  if (message.includes('SCHEDULE_COPY_LINK_REPAIR_RESPONSE_INVALID')) return 'Не вдалося перевірити результат сервера. Оновіть попередній перегляд; повторно не підтверджуйте зміну без перевірки.'
  return 'Не вдалося відновити посилання. Перевірте з’єднання й оновіть попередній перегляд.'
}

function ScheduleCopyLinkRepair({ groupId, isCurrentAdmin, onAccessDenied, onBusyChange }: { groupId: string; isCurrentAdmin: () => boolean; onAccessDenied: (failure: unknown) => void; onBusyChange: (busy: boolean) => void }) {
  const { authUser } = useAuth()
  const [expectedAdminId] = useState(authUser?.id || '')
  const [preview, setPreview] = useState<ScheduleLinkRepairPreview | null>(null)
  const [open, setOpen] = useState(false), [working, setWorking] = useState<'preview' | 'apply' | ''>('')
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const mounted = useRef(false), lock = useRef<symbol | null>(null)
  const currentContext = useRef({ groupId, adminId: authUser?.id || '', isCurrentAdmin })
  currentContext.current = { groupId, adminId: authUser?.id || '', isCurrentAdmin }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lock.current = null } }, [])
  const current = () => mounted.current && Boolean(expectedAdminId) && currentContext.current.adminId === expectedAdminId && currentContext.current.groupId === groupId && currentContext.current.isCurrentAdmin()
  async function request(previewOnly: boolean) {
    if (!current() || lock.current || !previewOnly && (!preview || !preview.count)) return
    const token = Symbol('schedule-copy-link-repair'), expectedGroupId = groupId
    const signature = previewOnly ? null : preview!.signature
    lock.current = token; setOpen(true); setWorking(previewOnly ? 'preview' : 'apply'); onBusyChange(true); setError(''); setMessage('')
    if (previewOnly) setPreview(null)
    try {
      const { data, error: failure } = await supabase.rpc('xelay_admin_schedule_copy_link_repair', { p_group_id: expectedGroupId, p_preview: previewOnly, p_signature: signature, p_expected_admin_id: expectedAdminId })
      if (!current() || lock.current !== token) return
      if (failure) throw failure
      const result = scheduleLinkRepairResult(data, !previewOnly)
      if (previewOnly && result.count) setPreview(result)
      else { setOpen(false); setPreview(null); setMessage(previewOnly ? 'Порожніх суботніх копій з однозначним джерелом не знайдено. Наявні посилання залишаються без змін.' : `Посилання відновлено для пар: ${result.repaired}. Суботні копії отримуватимуть подальші зміни посилань із вихідних пар.`) }
    } catch (failure) {
      if (!current() || lock.current !== token) return
      setPreview(null); setError(scheduleLinkRepairError(failure))
      if (accessDenied(failure) || (failure as { message?: string })?.message?.includes('SCHEDULE_COPY_LINK_REPAIR_ADMIN_REQUIRED')) onAccessDenied(failure)
    } finally { if (lock.current === token) { lock.current = null; if (current()) { setWorking(''); onBusyChange(false) } } }
  }
  return <section aria-label="Відновлення посилань суботніх копій" className="space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h4 className="text-sm font-semibold">Посилання у скопійованих парах</h4><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Попередній перегляд знаходить старі порожні суботні копії з одним відповідним джерелом у цій групі. Лекції й семінари перевіряються окремо; наявні власні посилання не змінюються.</p></div><button type="button" className={chatButton} disabled={Boolean(working)} onClick={() => void request(true)}>{working === 'preview' ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}Відновити посилання суботніх копій</button></div>
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {open && <div className="space-y-3 border-t border-primary/15 pt-3">
      {working === 'preview' ? <p role="status" className="text-sm text-muted-foreground">Перевіряємо відповідники в розкладі…</p> : preview && <><p className="text-sm font-medium">Буде відновлено пар: {preview.count}</p><ul className="max-h-72 space-y-2 overflow-auto" aria-label="Пари для відновлення посилань">{preview.pairs.map(pair => <li key={pair.target_id} className="rounded-xl border border-border bg-background p-3 text-sm"><p className="font-medium">{pair.subject} · {LESSON_TYPES[pair.lesson_type as keyof typeof LESSON_TYPES] || 'Заняття'}</p><p className="mt-1 text-xs text-muted-foreground">{repairDateLabel(pair.source_date)} → {repairDateLabel(pair.target_date)} · {pair.starts_at.slice(0, 5)}–{pair.ends_at.slice(0, 5)}</p></li>)}</ul><p className="text-xs leading-relaxed text-muted-foreground">Будуть перенесені обидва посилання та їхні назви. Дати, час, предмети й домашні завдання залишаються незмінними.</p></>}
      <div className="flex flex-wrap gap-2"><button type="button" className={chatButton} disabled={Boolean(working)} onClick={() => { setOpen(false); setPreview(null); setError('') }}>Скасувати</button>{preview && <button type="button" className={chatPrimary} disabled={Boolean(working)} onClick={() => void request(false)}>{working === 'apply' && <Loader2 size={15} className="animate-spin" />}Підтягнути посилання · {preview.count}</button>}{error && <button type="button" className={chatButton} disabled={Boolean(working)} onClick={() => void request(true)}>Оновити попередній перегляд</button>}</div>
    </div>}
  </section>
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
