import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Bell, Check, CheckCheck, ChevronDown, ExternalLink, Filter, Inbox, Loader2, Mail, RefreshCw, Search, Settings2, ShieldCheck, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'
import type { NotificationPreferences } from '../context/NotificationPreferencesContext'
import { DEFAULT_NOTIFICATION_FILTERS, NOTIFICATION_CATEGORIES, mergeNotificationPage, notificationCategorySettings, notificationCenterError, notificationChanged, notificationDisplayPriority, outstandingNotification,
  type NotificationCategory, type NotificationCenterFeed, type NotificationCenterItem, type NotificationCenterRepository, type NotificationCenterTab, type NotificationFilters } from '../lib/notificationCenter'
import './notification-center.css'

export type NotificationEmailRuntimeState = 'checking' | 'ready' | 'limited' | 'not_configured' | 'unavailable'
export interface NotificationCenterContentProps {
  userId: string; repository: NotificationCenterRepository; preferences: NotificationPreferences
  preferencesLoading?: boolean; saving?: boolean; preferencesError?: string | null
  updatePreferences: (changes: Partial<NotificationPreferences>) => Promise<boolean>; refreshPreferences?: () => Promise<void>
  emailState?: NotificationEmailRuntimeState; onOpen: (item: NotificationCenterItem) => void; onClose?: () => void; initialTab?: NotificationCenterTab
}
const viewLabels = { all: 'Усі', unread: 'Непрочитані', required: 'Обов’язкові', urgent: 'Термінові' } as const
const filtersEmpty = (filters: NotificationFilters) => filters.view === 'all' && filters.category === 'all' && !filters.group_id && !filters.course_id && filters.period === 'all' && !filters.search

export function NotificationCenterContent({ userId, repository, preferences, preferencesLoading = false, saving = false, preferencesError, updatePreferences, refreshPreferences, emailState = 'checking', onOpen, onClose, initialTab = 'inbox' }: NotificationCenterContentProps) {
  const [tab, setTab] = useState<NotificationCenterTab>(initialTab), [filters, setFilters] = useState<NotificationFilters>({ ...DEFAULT_NOTIFICATION_FILTERS })
  const [search, setSearch] = useState(''), [expandedFilters, setExpandedFilters] = useState(false)
  const [feedResult, setFeedResult] = useState<{ scope: { userId: string; repository: NotificationCenterRepository }; data: NotificationCenterFeed } | null>(null), [loading, setLoading] = useState(true), [moreBusy, setMoreBusy] = useState(false)
  const [error, setError] = useState(''), [feedback, setFeedback] = useState(''), [actionBusy, setActionBusy] = useState('')
  const request = useRef<AbortController | null>(null), sequence = useRef(0), actionLock = useRef(false), alive = useRef(true)
  const scope = useRef({ userId, repository })
  if (scope.current.userId !== userId || scope.current.repository !== repository) scope.current = { userId, repository }
  const renderScope = scope.current
  const feed = feedResult?.scope === renderScope ? feedResult.data : null
  const [directory, setDirectory] = useState<{ scope: typeof renderScope; groups: NotificationCenterFeed['groups']; courses: NotificationCenterFeed['courses'] } | null>(null)
  const groups = directory?.scope === renderScope ? directory.groups : [], courses = directory?.scope === renderScope ? directory.courses : []
  const latestFilters = useRef(filters); latestFilters.current = filters
  const currentFeed = useRef(feed); currentFeed.current = feed
  const filterKey = JSON.stringify(filters)
  const load = useCallback(async (append = false) => {
    if (!alive.current || scope.current !== renderScope || JSON.stringify(latestFilters.current) !== filterKey) return
    if (append && (request.current || !currentFeed.current?.has_more || !currentFeed.current.next_cursor)) return
    request.current?.abort()
    const controller = new AbortController(), captured = ++sequence.current
    request.current = controller
    if (append) setMoreBusy(true); else setLoading(true)
    setError('')
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    try {
      const next = await repository.feed(userId, filters, append ? currentFeed.current?.next_cursor : null, controller.signal)
      if (!alive.current || controller.signal.aborted || scope.current !== renderScope || captured !== sequence.current) return
      setFeedResult(previous => ({ scope: renderScope, data: mergeNotificationPage(append && previous?.scope === renderScope ? previous.data : null, next, append) }))
      setDirectory({ scope: renderScope, groups: next.groups, courses: next.courses })
    } catch (failure) {
      if (alive.current && scope.current === renderScope && captured === sequence.current) setError(controller.signal.aborted ? 'Сповіщення завантажуються довше звичайного. Спробуйте ще раз.' : notificationCenterError(failure))
    } finally {
      window.clearTimeout(timeout)
      if (request.current === controller) request.current = null
      if (alive.current && scope.current === renderScope && captured === sequence.current) { setLoading(false); setMoreBusy(false) }
    }
  }, [repository, userId, filterKey, renderScope])
  useEffect(() => {
    alive.current = true; setError(''); setFeedback(''); setFeedResult(null)
    void load()
    return () => { alive.current = false; sequence.current++; request.current?.abort(); request.current = null }
  }, [load])
  useEffect(() => { actionLock.current = false; setActionBusy(''); setFeedback('') }, [renderScope])
  useEffect(() => {
    let timer: number | undefined
    const refresh = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (document.visibilityState === 'visible') void load() }, 250) }
    const local = (event: Event) => { if ((event as CustomEvent<{ userId?: string }>).detail?.userId === userId) refresh() }
    const unsubscribe = repository.subscribe?.(userId, refresh)
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); window.addEventListener('xelay-notifications-updated', local)
    return () => { window.clearTimeout(timer); unsubscribe?.(); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); window.removeEventListener('xelay-notifications-updated', local) }
  }, [repository, userId, load])
  useEffect(() => { setTab(initialTab) }, [initialTab, userId])

  function chooseFilters(changes: Partial<NotificationFilters>) { setFilters(previous => ({ ...previous, ...changes })); setFeedback('') }
  function submitSearch(event: FormEvent) { event.preventDefault(); chooseFilters({ search: search.trim().slice(0, 160) }) }
  const shown = [...feed?.required_items || [], ...feed?.items || []]
  const unreadShown = [...new Set(shown.filter(item => !item.is_read).map(item => item.id))]
  async function mutate(kind: 'read' | 'ack', item?: NotificationCenterItem) {
    if (actionLock.current || !alive.current || scope.current !== renderScope) return
    const ids = item ? [item.id] : unreadShown
    if (!ids.length || kind === 'ack' && (!item || !outstandingNotification(item))) return
    actionLock.current = true; setActionBusy(kind === 'ack' ? item!.id : 'read'); setError(''); setFeedback('')
    try {
      if (kind === 'ack') await repository.acknowledge(userId, item!.id)
      else await repository.markRead(userId, ids)
      if (!alive.current || scope.current !== renderScope) return
      notificationChanged(userId)
      setFeedback(kind === 'ack' ? 'Ознайомлення підтверджено.' : 'Показані повідомлення позначено прочитаними. Обов’язкові підтверджуються окремо.')
      await load()
    } catch (failure) { if (alive.current && scope.current === renderScope) setError(notificationCenterError(failure)) }
    finally { if (scope.current === renderScope) { actionLock.current = false; if (alive.current) setActionBusy('') } }
  }
  function open(item: NotificationCenterItem) {
    if (!alive.current || actionLock.current || scope.current !== renderScope) return
    if (!item.is_read) void repository.markRead(userId, [item.id]).then(() => { notificationChanged(userId) }).catch(() => { /* Opening the source must not depend on an acknowledgement write. */ })
    onOpen(item)
  }
  const reset = () => { setSearch(''); setFilters({ ...DEFAULT_NOTIFICATION_FILTERS }); setFeedback('') }
  const allRequired = () => { setSearch(''); chooseFilters({ view: 'required', category: 'all', group_id: null, course_id: null, period: 'all', search: '' }) }
  const requiredFiltered = filters.view === 'required' && (filters.category !== 'all' || filters.group_id || filters.course_id || filters.period !== 'all' || filters.search)
  return <div className="nc-root">
    <header className="nc-heading"><span className="nc-heading-icon"><Bell size={21} /></span><div><h2>Сповіщення</h2><p>{feed?.required_count ? `Чекають на ваше ознайомлення: ${feed.required_count}` : 'Важливе для вашого навчання'}</p></div>{onClose && <button type="button" className="nc-icon" aria-label="Закрити сповіщення" onClick={onClose}><X size={19} /></button>}</header>
    <div className="nc-main-tabs" role="tablist" aria-label="Центр сповіщень"><button type="button" role="tab" aria-selected={tab === 'inbox'} onClick={() => setTab('inbox')}><Inbox size={16} />Вхідні{Boolean(feed?.badge_count) && <span>{feed!.badge_count}</span>}</button><button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}><Settings2 size={16} />Мої налаштування</button></div>
    {tab === 'settings' ? <NotificationCenterSettings key={userId} preferences={preferences} loading={preferencesLoading} saving={saving} error={preferencesError} update={updatePreferences} refresh={refreshPreferences} emailState={emailState} isCurrent={() => alive.current && scope.current === renderScope} /> : <div role="tabpanel" aria-label="Вхідні" className="nc-inbox">
      <div className="nc-filters"><div className="nc-views" aria-label="Які сповіщення показати">{Object.entries(viewLabels).map(([view, label]) => <button key={view} type="button" aria-pressed={filters.view === view} onClick={() => chooseFilters({ view: view as NotificationFilters['view'] })}>{label}{view === 'required' && Boolean(feed?.required_count) && <span>{feed!.required_count}</span>}</button>)}</div>
        <div className="nc-filter-line"><label className="nc-sr" htmlFor="nc-category">Категорія сповіщень</label><select id="nc-category" aria-label="Категорія сповіщень" value={filters.category} onChange={event => chooseFilters({ category: event.target.value as NotificationFilters['category'] })}><option value="all">Усі категорії</option>{NOTIFICATION_CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.title}</option>)}</select><button type="button" className="nc-filter-toggle" aria-expanded={expandedFilters} onClick={() => setExpandedFilters(value => !value)}><Filter size={15} />Фільтри<ChevronDown size={14} /></button><button type="button" className="nc-icon" aria-label="Оновити сповіщення" disabled={loading} onClick={() => void load()}><RefreshCw size={16} className={loading ? 'nc-spin' : ''} /></button></div>
        {expandedFilters && <div className="nc-extra-filters"><label>Група<select value={filters.group_id || ''} onChange={event => chooseFilters({ group_id: event.target.value || null })}><option value="">Усі мої групи</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label>Предмет<select value={filters.course_id || ''} onChange={event => chooseFilters({ course_id: event.target.value || null })}><option value="">Усі мої предмети</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><label>Період<select value={filters.period} onChange={event => chooseFilters({ period: event.target.value as NotificationFilters['period'] })}><option value="all">За весь час</option><option value="today">Сьогодні</option><option value="week">Останні 7 днів</option><option value="month">Останні 30 днів</option></select></label><form className="nc-search" onSubmit={submitSearch}><label className="nc-sr" htmlFor="nc-search">Пошук у сповіщеннях</label><input id="nc-search" value={search} onChange={event => setSearch(event.target.value)} maxLength={160} placeholder="Знайти повідомлення" /><button type="submit" className="nc-icon" aria-label="Знайти сповіщення"><Search size={16} /></button></form></div>}
        {!filtersEmpty(filters) && <button type="button" className="nc-text-button" onClick={reset}>Скинути фільтри</button>}
      </div>
      {error && <div className="nc-feedback nc-error" role="alert"><p>{error}</p><button type="button" onClick={() => void load()}>Спробувати ще раз</button></div>}
      {feedback && <p className="nc-feedback" role="status">{feedback}</p>}
      {Boolean(feed?.required_count && requiredFiltered) && <div className="nc-feedback" role="status"><p>Потребують ознайомлення: {feed!.required_count}. Частина може не відповідати цим фільтрам.</p><button type="button" onClick={allRequired}>Показати всі обов’язкові</button></div>}
      {loading && !feed ? <p className="nc-empty" role="status"><Loader2 size={21} className="nc-spin" />Завантажуємо сповіщення…</p> : <>
        {Boolean(feed?.required_items.length) && <section className="nc-required" aria-label="Потрібно підтвердити ознайомлення"><div className="nc-section-heading"><ShieldCheck size={17} /><h3>Потребують ознайомлення</h3><span>{feed!.required_count}</span></div><p>Залишаються тут незалежно від фільтрів, доки ви не підтвердите ознайомлення.</p>{feed!.required_items.map(item => <NotificationCard key={item.id} item={item} busy={actionBusy === item.id} disabled={Boolean(actionBusy)} onOpen={() => open(item)} onAcknowledge={() => void mutate('ack', item)} />)}{feed!.required_count > feed!.required_items.length && <button type="button" className="nc-text-button" onClick={allRequired}>Усі обов’язкові повідомлення · {feed!.required_count}</button>}</section>}
        <section className="nc-history" aria-label="Історія сповіщень"><div className="nc-history-heading"><h3>{filtersEmpty(filters) ? 'Останні повідомлення' : viewLabels[filters.view] === 'Усі' ? 'За вашими фільтрами' : viewLabels[filters.view]}</h3><button type="button" className="nc-text-button" disabled={Boolean(actionBusy) || !unreadShown.length} onClick={() => void mutate('read')}><CheckCheck size={14} />Прочитано</button></div><p className="nc-read-explanation">«Прочитано» стосується лише показаних повідомлень. Ознайомлення підтверджується окремою кнопкою.</p>
          {!feed?.items.length ? <div className="nc-empty"><Inbox size={27} /><h4>{filtersEmpty(filters) ? 'Усе важливе буде тут' : 'За цими фільтрами повідомлень немає'}</h4><p>{feed?.required_items.length ? 'Обов’язкові повідомлення залишаються вище.' : 'Спробуйте інші фільтри або поверніться пізніше.'}</p></div> : feed.items.map(item => <NotificationCard key={item.id} item={item} busy={actionBusy === item.id} disabled={Boolean(actionBusy)} onOpen={() => open(item)} onAcknowledge={() => void mutate('ack', item)} />)}
          {feed?.has_more && <button type="button" className="nc-button nc-more" disabled={moreBusy || loading} onClick={() => void load(true)}>{moreBusy && <Loader2 size={15} className="nc-spin" />}Показати ще</button>}
        </section>
      </>}
    </div>}
  </div>
}

function NotificationCard({ item, busy, disabled, onOpen, onAcknowledge }: { item: NotificationCenterItem; busy: boolean; disabled: boolean; onOpen: () => void; onAcknowledge: () => void }) {
  const required = outstandingNotification(item), priority = notificationDisplayPriority(item)
  const category = NOTIFICATION_CATEGORIES.find(value => value.id === item.category_key)?.title
  const date = new Date(item.created_at)
  return <article className={`nc-card${!item.is_read ? ' nc-unread' : ''}${required ? ' nc-needs-ack' : ''}`}>
    <div className="nc-card-meta">{category && <span>{category}</span>}{priority === 'urgent' && <strong className="nc-urgent">Терміново</strong>}{priority === 'attention' && <span>Потребує уваги</span>}{item.acknowledgement_required && <strong className="nc-required-label"><ShieldCheck size={12} />Обов’язкове</strong>}{!item.is_read && <i aria-label="Непрочитане" />}</div>
    <p className="nc-card-copy"><strong>{item.actor_name}</strong>{item.actor_name ? ' ' : ''}{item.type === 'answer' ? 'відповів(-ла) на ваше запитання' : item.message}</p>
    <div className="nc-card-context">{[item.group_name, item.course_title].filter(Boolean).join(' · ')}</div>
    <div className="nc-card-footer"><time dateTime={item.created_at}>{Number.isNaN(date.getTime()) ? 'Щойно' : formatDistanceToNow(date, { addSuffix: true, locale: uk })}</time><button type="button" className="nc-text-button" disabled={disabled} onClick={onOpen}>Відкрити<ExternalLink size={12} /></button></div>
    {required && <div className="nc-ack-row"><p>Підтвердьте, що ознайомилися з повідомленням.</p><button type="button" className="nc-button nc-primary" disabled={disabled} onClick={onAcknowledge}>{busy ? <Loader2 size={15} className="nc-spin" /> : <Check size={15} />}Ознайомився</button></div>}
    {item.acknowledged_at && <p className="nc-confirmed"><CheckCheck size={14} />Ознайомлення підтверджено</p>}
  </article>
}

function NotificationCenterSettings({ preferences, loading, saving, error, update, refresh, emailState, isCurrent }: { preferences: NotificationPreferences; loading: boolean; saving: boolean; error?: string | null; update: NotificationCenterContentProps['updatePreferences']; refresh?: NotificationCenterContentProps['refreshPreferences']; emailState: NotificationEmailRuntimeState; isCurrent: () => boolean }) {
  const [draft, setDraft] = useState(() => ({ ...preferences, categorySettings: notificationCategorySettings(preferences.categorySettings) })), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const sourceKey = JSON.stringify({ ...preferences, categorySettings: notificationCategorySettings(preferences.categorySettings) })
  const mounted = useRef(true), locked = useRef(false), savedPreferences = useRef(sourceKey)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (savedPreferences.current !== sourceKey) {
      const prior = savedPreferences.current; savedPreferences.current = sourceKey
      setDraft(previous => {
        if (JSON.stringify(previous) === prior) return { ...preferences, categorySettings: notificationCategorySettings(preferences.categorySettings) }
        return previous
      })
    }
  }, [preferences, sourceKey])
  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...preferences, categorySettings: notificationCategorySettings(preferences.categorySettings) })
  async function save() {
    if (locked.current || loading || saving || !dirty || !mounted.current || !isCurrent()) return
    locked.current = true; setBusy(true); setMessage('')
    try { const ok = await update(draft); if (mounted.current && isCurrent()) setMessage(ok ? 'Ваші налаштування збережено.' : 'Не вдалося зберегти налаштування. Спробуйте ще раз.') }
    catch { if (mounted.current && isCurrent()) setMessage('Не вдалося зберегти налаштування. Спробуйте ще раз.') }
    finally { locked.current = false; if (mounted.current && isCurrent()) setBusy(false) }
  }
  function category(id: NotificationCategory, fields: Partial<(typeof draft.categorySettings)[NotificationCategory]>) { setDraft(previous => ({ ...previous, categorySettings: { ...previous.categorySettings, [id]: { ...previous.categorySettings[id], ...fields } } })); setMessage('') }
  return <div className="nc-settings" role="tabpanel" aria-label="Мої налаштування">
    <section className="nc-mandatory-rule"><ShieldCheck size={20} /><div><h3>Обов’язкові повідомлення надходять завжди</h3><p>Вони з’являються в Xelay та на підтвердженій пошті незалежно від перемикачів нижче. Ознайомлення підтверджується тільки вашою кнопкою.</p></div></section>
    <div className="nc-settings-intro"><h3>Оберіть, що важливо саме вам</h3><p>Ці налаштування керують звичайними повідомленнями. Історія зберігається, навіть якщо ви вимкнули нагадування.</p></div>
    {loading && <p className="nc-feedback" role="status">Завантажуємо ваші налаштування…</p>}
    {error && <div className="nc-feedback nc-error" role="alert"><p>{error}</p>{refresh && <button type="button" onClick={() => void refresh()}>Спробувати ще раз</button>}</div>}
    <fieldset disabled={loading || saving || busy || Boolean(error)}>
      <label className="nc-toggle-row"><span><strong>Звертати увагу на звичайні події в Xelay</strong><small>Позначка на дзвіночку та звичайні нагадування. Історія залишається доступною.</small></span><input type="checkbox" checked={draft.notificationsEnabled} onChange={event => { setDraft(previous => ({ ...previous, notificationsEnabled: event.target.checked })); setMessage('') }} /></label>
      <label className="nc-toggle-row"><span><strong>Звичайні повідомлення на пошту</strong><small>Безкоштовно, без підписки. Частоту оберіть окремо для кожної категорії.</small></span><input type="checkbox" checked={draft.emailNotificationsEnabled} onChange={event => { setDraft(previous => ({ ...previous, emailNotificationsEnabled: event.target.checked })); setMessage('') }} /></label>
      <div className="nc-category-settings">{NOTIFICATION_CATEGORIES.map(item => <section key={item.id} className="nc-category-row"><div><h4>{item.title}</h4><p>{item.description}</p></div><div className="nc-category-controls"><label><input type="checkbox" disabled={!draft.notificationsEnabled} checked={draft.categorySettings[item.id].in_app} onChange={event => category(item.id, { in_app: event.target.checked })} />У Xelay</label><label><span className="nc-sr">Листи: {item.title}</span><select aria-label={`Листи: ${item.title}`} disabled={!draft.emailNotificationsEnabled} value={draft.categorySettings[item.id].email} onChange={event => category(item.id, { email: event.target.value as 'immediate' | 'daily' | 'off' })}><option value="immediate">Пошта: одразу</option><option value="daily">Пошта: підсумком за день</option><option value="off">Без листів</option></select></label></div></section>)}</div>
    </fieldset>
    <div className="nc-email-status" role="status"><Mail size={16} /><p>{emailState === 'ready' ? 'Пошта підключена. Листи надходять на підтверджену адресу акаунта.' : emailState === 'checking' ? 'Перевіряємо доступність пошти…' : emailState === 'limited' ? 'Досягнуто ліміту поштового сервісу. Доставка відновиться після появи доступного ліміту; повідомлення залишаються у Xelay.' : emailState === 'not_configured' ? 'Пошта зараз не підключена. Вибір збережеться, а повідомлення залишаються у Xelay.' : 'Статус пошти зараз недоступний. Ви можете зберегти свій вибір.'}</p></div>
    <p className="nc-settings-footnote">Приватні тексти розмов, робіт і вкладення в листи не додаємо. Підтвердження пошти та відновлення пароля працюють окремо. Особистий органайзер і його push-нагадування входять до підписки «Учасник». Поштові сповіщення безкоштовні.</p>
    {message && <p className="nc-feedback" role="status">{message}</p>}
    <div className="nc-settings-save"><span>{dirty ? 'Є незбережені зміни' : 'Ваші поточні налаштування'}</span><button type="button" className="nc-button nc-primary" disabled={!dirty || loading || saving || busy || Boolean(error)} onClick={() => void save()}>{(busy || saving) && <Loader2 size={15} className="nc-spin" />}Зберегти налаштування</button></div>
  </div>
}
