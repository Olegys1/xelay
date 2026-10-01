import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Check, Loader2, Megaphone, Search, Sparkles, Users, UserRound, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { isValidUserSearch, normalizeUserSearch, parseUserSearchResult, splitUsernameMatch, type SearchProfile } from '../lib/userSearch'
import { useBilling } from '../context/BillingContext'
import { AuthModal } from '../components/AuthModal'
import { PremiumBadge } from '../components/PremiumBadge'
import { ChatSpaceSearch } from '../components/ChatSpaceSearch'

type SearchMode = 'live' | 'manual'
type SearchSnapshot = { ownerId: string; term: string; people: SearchProfile[]; hasMore: boolean }
type SearchTab = 'people' | 'groups' | 'channels'

export function UserSearchPage() {
  const [activeTab, setActiveTab] = useState<SearchTab>('people')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const tabs = [
    { id: 'people', label: 'Люди', Icon: UserRound },
    { id: 'groups', label: 'Групи', Icon: Users },
    { id: 'channels', label: 'Канали', Icon: Megaphone },
  ] as const

  return (
    <main className="xelay-reference-page min-h-screen">
      <div className="mx-auto max-w-3xl px-4 pb-12 pt-7 sm:px-6 sm:pb-16 sm:pt-11 lg:px-8">
        <h1 className="mb-5 text-2xl font-bold tracking-tight sm:text-3xl">Пошук у Xelay</h1>
        <div role="tablist" aria-label="Що шукаємо" className="mb-6 grid grid-cols-3 gap-1.5 rounded-2xl border border-border/70 bg-muted/35 p-1.5">
          {tabs.map(({ id, label, Icon }, index) => (
            <button
              key={id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`search-${id}-tab`}
              type="button"
              role="tab"
              aria-controls={`search-${id}-panel`}
              aria-selected={activeTab === id}
              tabIndex={activeTab === id ? 0 : -1}
              onClick={() => setActiveTab(id)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
                setActiveTab(tabs[next].id)
                tabRefs.current[next]?.focus()
              }}
              className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-2 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${activeTab === id ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'}`}
            >
              <Icon size={17} className="shrink-0" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
        <PeopleSearch active={activeTab === 'people'} />
        <ChatSpaceSearch kind="group" active={activeTab === 'groups'} />
        <ChatSpaceSearch kind="channel" active={activeTab === 'channels'} />
      </div>
    </main>
  )
}

function PeopleSearch({ active }: { active: boolean }) {
  const navigate = useNavigate()
  const { authUser } = useAuth()
  const ownerId = authUser?.id
  const { isPremium, searchRemaining, isLoading: billingLoading, error: billingError, refreshBilling } = useBilling()
  const [showAuth, setShowAuth] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('live')
  const [snapshot, setSnapshot] = useState<SearchSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [limitReached, setLimitReached] = useState(false)
  const [premiumIdentities, setPremiumIdentities] = useState<Record<string, { is_premium: boolean; emoji_status: string | null }>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLAnchorElement | null>>([])
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const debounce = useRef<number | null>(null)
  const lastUsage = useRef<number | null>(null)
  const ownerRef = useRef(ownerId)
  const activeRef = useRef(active)
  const snapshotRef = useRef(snapshot)
  const term = normalizeUserSearch(query)
  const termRef = useRef(term)
  ownerRef.current = ownerId
  activeRef.current = active
  snapshotRef.current = snapshot
  termRef.current = term

  const cancelSearch = useCallback(() => {
    ++sequence.current
    controller.current?.abort()
    controller.current = null
    if (debounce.current !== null) window.clearTimeout(debounce.current)
    debounce.current = null
  }, [])

  useEffect(() => {
    if (!active) {
      cancelSearch()
      setLoading(false)
      setWaiting(false)
    }
  }, [active, cancelSearch])

  useEffect(() => {
    cancelSearch()
    termRef.current = ''
    setQuery('')
    setSnapshot(null)
    setPremiumIdentities({})
    setLoading(false)
    setWaiting(false)
    setError('')
    setLimitReached(false)
    lastUsage.current = null
    return cancelSearch
  }, [ownerId, cancelSearch])

  const searchPeople = useCallback(async (searchTerm: string, explicit = false) => {
    if (!activeRef.current || !ownerId || !isValidUserSearch(searchTerm)) return
    cancelSearch()
    const requestId = sequence.current
    const abort = new AbortController()
    controller.current = abort
    const isCurrent = () => activeRef.current && !abort.signal.aborted && sequence.current === requestId
      && ownerRef.current === ownerId && termRef.current === searchTerm
    setLoading(true)
    setWaiting(false)
    setError('')
    setLimitReached(false)
    try {
      let response = await supabase.rpc(mode === 'manual' ? 'xelay_search_users' : 'xelay_search_users_live', { p_query: searchTerm })
        .abortSignal(abort.signal)
      if (!isCurrent()) return
      if (mode === 'live' && isMissingDatabaseFunction(response.error)) {
        // Older databases retain manual search. Never spend their quota on typing.
        setMode('manual')
        if (!explicit) return
        response = await supabase.rpc('xelay_search_users', { p_query: searchTerm }).abortSignal(abort.signal)
        if (!isCurrent()) return
      }
      if (response.error) throw response.error
      const result = parseUserSearchResult(response.data)
      setLimitReached(result.limitReached)
      setSnapshot({ ownerId, term: searchTerm, people: result.profiles, hasMore: result.hasMore })
      if (lastUsage.current !== result.used) {
        lastUsage.current = result.used
        void refreshBilling()
      }
    } catch (searchError) {
      if (!isCurrent()) return
      console.error('Could not search profiles:', searchError)
      setSnapshot(null)
      setError(isMissingDatabaseFunction(searchError as { code?: string })
        ? 'Пошук ще готується до запуску. Спробуйте пізніше.'
        : 'Не вдалося оновити результати. Спробуйте ще раз.')
    } finally {
      if (isCurrent()) {
        controller.current = null
        setLoading(false)
      }
    }
  }, [ownerId, mode, cancelSearch, refreshBilling])

  useEffect(() => {
    if (!active || !ownerId || mode !== 'live' || !isValidUserSearch(term) || termRef.current !== term
      || (snapshotRef.current?.ownerId === ownerId && snapshotRef.current.term === term)) {
      setWaiting(false)
      return
    }
    setWaiting(true)
    debounce.current = window.setTimeout(() => {
      debounce.current = null
      void searchPeople(term)
    }, 320)
    return () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current)
      debounce.current = null
    }
  }, [active, ownerId, term, mode, searchPeople])

  const currentSnapshot = snapshot && snapshot.ownerId === ownerId ? snapshot : null
  const people = currentSnapshot && isValidUserSearch(term) && (mode === 'live' || currentSnapshot.term === term)
    ? currentSnapshot.people.filter((person) => person.username.toLocaleLowerCase('uk-UA').includes(term)) : []
  const pending = loading || waiting
  const completed = currentSnapshot?.term === term && !pending

  useEffect(() => {
    const results = snapshot && snapshot.ownerId === ownerId ? snapshot.people : []
    let active = true
    let busy = false
    setPremiumIdentities(Object.fromEntries(results.map((person) => [person.id, {
      is_premium: person.is_premium === true, emoji_status: person.emoji_status ?? null,
    }])))
    if (!active || !results.length) return
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { data, error: premiumError } = await supabase.rpc('xelay_public_premium', { p_user_ids: results.map((person) => person.id) })
        if (active && ownerRef.current === ownerId && !premiumError && Array.isArray(data)) {
          setPremiumIdentities(Object.fromEntries(data.map((identity) => [identity.user_id, identity])))
        }
      } finally { busy = false }
    }
    if (results.some((person) => typeof person.is_premium !== 'boolean')) void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(onFocus, 60_000)
    return () => { active = false; window.removeEventListener('focus', onFocus); window.clearInterval(interval) }
  }, [active, snapshot, ownerId])

  const changeQuery = (value: string) => {
    const nextTerm = normalizeUserSearch(value)
    if (nextTerm === termRef.current) { setQuery(value); return }
    // Invalidate before the debounce: old responses cannot replace new suggestions.
    cancelSearch()
    termRef.current = nextTerm
    setQuery(value)
    setLoading(false)
    setWaiting(Boolean(ownerId && mode === 'live' && isValidUserSearch(nextTerm)))
    setError('')
    setLimitReached(false)
    if (!isValidUserSearch(nextTerm)) setSnapshot(null)
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    if (!ownerId) { setShowAuth(true); return }
    if (controller.current) return
    if (!isValidUserSearch(term)) {
      setError('Введіть від 2 до 30 символів ніку: літери, цифри, крапку, підкреслення або дефіс.')
      inputRef.current?.focus()
      return
    }
    void searchPeople(term, true)
  }

  const clearSearch = () => {
    changeQuery('')
    setSnapshot(null)
    inputRef.current?.focus()
  }

  const handleResultKeys = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && index === 0) { inputRef.current?.focus(); return }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? people.length - 1
      : Math.max(0, Math.min(people.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    resultRefs.current[next]?.focus()
  }

  return (
    <section id="search-people-panel" role="tabpanel" aria-labelledby="search-people-tab" hidden={!active}>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
        <header className="mb-5 sm:mb-7">
          <div className="mb-3 flex items-center gap-3 sm:gap-4">
            <span className="xelay-soft-panel flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-primary/70 sm:h-12 sm:w-12"><Users size={21} aria-hidden="true" /></span>
            <h2 className="text-base font-semibold tracking-tight sm:text-xl">Знайти людей</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">Введіть нік або його частину — знайдіть людину, перегляньте профіль і запросіть спілкування.</p>
        </header>

        <div className="mb-4 flex flex-col items-start gap-2.5 rounded-2xl border border-primary/10 bg-accent/40 px-4 py-3.5 text-[13px] sm:mb-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-5 sm:text-sm">
          <span className="min-w-0 text-accent-foreground">
            {ownerId ? (isPremium ? 'Пошук без обмежень · Учасник' : `Доступно пошуків сьогодні: ${billingLoading || billingError ? '—' : searchRemaining} із 5`) : 'Безкоштовно — 5 пошуків на день'}
          </span>
          {!isPremium && <Link to="/subscription" className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-primary hover:underline"><Sparkles size={15} aria-hidden="true" /> Без обмежень</Link>}
        </div>

        <form onSubmit={submitSearch} role="search" aria-label="Пошук учасників Xelay" className="mb-2.5 flex flex-col gap-2.5 sm:flex-row sm:gap-3">
          <div className="relative min-w-0 flex-1">
            <label htmlFor="user-search" className="sr-only">Нік користувача</label>
            <Search size={19} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-primary/60" aria-hidden="true" />
            <input
              id="user-search"
              ref={inputRef}
              type="text"
              inputMode="search"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); clearSearch() }
                if (event.key === 'ArrowDown' && people.length) { event.preventDefault(); resultRefs.current[0]?.focus() }
              }}
              maxLength={31}
              placeholder="Нік користувача, наприклад @oleh"
              aria-describedby="user-search-hint"
              aria-controls="user-search-results"
              className="xelay-search-input h-[52px] w-full min-w-0 rounded-2xl border border-border/60 pl-11 pr-12 text-base placeholder:text-muted-foreground/70 focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 sm:h-14"
            />
            {query && <button type="button" onClick={clearSearch} aria-label="Очистити пошук" className="absolute inset-y-0 right-1 my-auto flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"><X size={18} aria-hidden="true" /></button>}
          </div>
          <button type="submit" disabled={loading} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-7 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 sm:h-14 sm:rounded-2xl">
            {loading ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <Search size={17} aria-hidden="true" />} Знайти
          </button>
        </form>
        <p id="user-search-hint" className="mb-6 px-1 text-[12px] leading-relaxed text-muted-foreground sm:mb-7 sm:text-xs">
          {mode === 'manual' ? 'Автоматичні підказки ще оновлюються. Введіть нік і натисніть «Знайти».'
            : 'Результати з’являються від 2 символів. Уточнення одного ніку протягом 10 хвилин — один пошук.'}
        </p>

        {error && <p role="alert" className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {limitReached && <div role="alert" className="mb-4 rounded-2xl border border-primary/10 bg-primary/5 p-5">
          <p className="font-semibold text-primary">Пошуки на сьогодні використано</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Нові пошуки будуть доступні завтра за київським часом. Підписка «Учасник» відкриває пошук без обмежень.</p>
          <button onClick={() => navigate({ to: '/subscription' })} className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"><Sparkles size={16} aria-hidden="true" /> Переглянути підписку</button>
        </div>}

        <section id="user-search-results" aria-label="Результати пошуку" aria-busy={pending}>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {pending ? 'Оновлюємо результати пошуку' : completed && !limitReached ? (people.length ? `Знайдено учасників: ${people.length}` : 'Нікого не знайдено') : ''}
          </p>
          {!ownerId && <SearchEmpty icon="people" title="Знайдіть свою університетську спільноту" description="Увійдіть до акаунта, щоб шукати людей і надсилати запити на спілкування.">
            <button onClick={() => setShowAuth(true)} className="mt-5 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground">Увійти до Xelay</button>
          </SearchEmpty>}

          {ownerId && !isValidUserSearch(term) && !error && <SearchEmpty icon="search" title={term.length === 1 ? 'Додайте ще один символ' : 'Кого шукаємо?'} description={term.length > 1 ? 'Використовуйте літери, цифри, крапку, підкреслення або дефіс.' : 'Введіть щонайменше 2 символи ніку. Можна шукати з @ або без нього.'} />}

          {ownerId && pending && people.length === 0 && <SearchSkeleton />}

          {ownerId && mode === 'manual' && isValidUserSearch(term) && !pending && !completed && !error && <SearchEmpty icon="search" title="Натисніть «Знайти»" description="Пошук за введеним ніком відкриється після натискання кнопки." />}

          {completed && !error && !limitReached && people.length === 0 && <SearchEmpty icon="people" title="Нікого не знайдено" description="Перевірте написання або введіть коротшу частину ніку." />}

          {people.length > 0 && !limitReached && !error && <>
            <div className="mb-3 flex min-h-[24px] items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
              <span>{pending ? 'Оновлюємо збіги…' : `Знайдено: ${people.length}${snapshot?.hasMore ? '+' : ''}`}</span>
              <span className="inline-flex items-center gap-1.5">{pending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} className="text-primary" aria-hidden="true" />} {pending ? 'Шукаємо' : mode === 'live' ? 'Найточніші збіги першими' : 'Збіги за ніком'}</span>
            </div>
            <ul className="space-y-2">
              {people.map((person, index) => <li key={person.id} className="animate-fade-in motion-reduce:animate-none">
                <Link
                  ref={(element) => { resultRefs.current[index] = element }}
                  to="/user/$id"
                  params={{ id: person.id }}
                  onKeyDown={(event) => handleResultKeys(event, index)}
                  className="group flex w-full min-w-0 items-center gap-3 rounded-2xl border border-border/75 bg-card p-3.5 text-left transition-colors hover:border-primary/25 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-primary/30 sm:gap-4 sm:p-4"
                >
                  <Avatar person={person} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold sm:text-base"><span className="truncate">{person.full_name || 'Учасник Xelay'}</span><PremiumBadge isPremium={Boolean(premiumIdentities[person.id]?.is_premium)} emojiStatus={premiumIdentities[person.id]?.emoji_status} compact /></span>
                    <span className="mt-0.5 block truncate text-sm text-muted-foreground">@<UsernameMatch username={person.username} term={term} /></span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{[person.faculty, person.specialty, person.study_year ? `${person.study_year} курс` : ''].filter(Boolean).join(' · ') || 'Учасник університетської спільноти'}</span>
                  </span>
                  <span className="hidden shrink-0 text-xs font-medium text-primary sm:inline">Профіль</span>
                  <ArrowRight size={17} className="shrink-0 text-primary/60 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden="true" />
                </Link>
              </li>)}
            </ul>
            {completed && snapshot?.hasMore && <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">Є ще збіги. Додайте кілька символів, щоб знайти потрібну людину.</p>}
          </>}
        </section>
    </section>
  )
}

function UsernameMatch({ username, term }: { username: string; term: string }) {
  const [before, match, after] = splitUsernameMatch(username, term)
  return <>{before}{match && <mark className="rounded bg-primary/10 px-0.5 font-semibold text-primary">{match}</mark>}{after}</>
}

function Avatar({ person }: { person: SearchProfile }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const initials = person.full_name?.split(' ').filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || person.username[0]?.toUpperCase() || '?'
  return <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-muted text-primary/80 sm:h-14 sm:w-14">
    {person.avatar_url && failedUrl !== person.avatar_url ? <img src={person.avatar_url} alt="" loading="lazy" onError={() => setFailedUrl(person.avatar_url)} className="h-full w-full object-cover" /> : <span className="font-semibold">{initials}</span>}
  </span>
}

function SearchEmpty({ icon, title, description, children }: { icon: 'search' | 'people'; title: string; description: string; children?: ReactNode }) {
  const Icon = icon === 'search' ? Search : UserRound
  return <div className="rounded-3xl border border-dashed border-border bg-muted/20 px-5 py-11 text-center sm:py-14">
    <span className="xelay-soft-panel mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-primary/60"><Icon size={25} aria-hidden="true" /></span>
    <p className="font-semibold">{title}</p>
    <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
    {children}
  </div>
}

function SearchSkeleton() {
  return <div aria-hidden="true" className="space-y-2">
    {[0, 1, 2, 3].map((row) => <div key={row} className="flex items-center gap-3 rounded-2xl border border-border p-4 sm:gap-4">
      <span className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none sm:h-14 sm:w-14" />
      <span className="min-w-0 flex-1 space-y-2"><span className="block h-3.5 w-2/5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" /><span className="block h-3 w-1/3 animate-pulse rounded-full bg-muted motion-reduce:animate-none" /><span className="block h-2.5 w-3/5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" /></span>
    </div>)}
  </div>
}
