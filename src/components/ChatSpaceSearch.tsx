import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Loader2, Megaphone, Search, Users, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { searchChatSpaces, type ChatSpace, type ChatSpaceKind } from '../lib/chatSpaces'
import { AuthModal } from './AuthModal'

type SpaceSnapshot = { ownerId: string; term: string; spaces: ChatSpace[] }

function normalizeSpaceSearch(value: string) {
  return value.trim().replace(/^@+/, '').trim().toLocaleLowerCase('uk-UA')
}

function validSpaceSearch(value: string) {
  const length = Array.from(value).length
  return length >= 2 && length <= 80
}

export function ChatSpaceSearch({ kind, active }: { kind: ChatSpaceKind; active: boolean }) {
  const { authUser } = useAuth()
  const ownerId = authUser?.id
  const isChannel = kind === 'channel'
  const tabName = isChannel ? 'channels' : 'groups'
  const Icon = isChannel ? Megaphone : Users
  const [query, setQuery] = useState('')
  const [snapshot, setSnapshot] = useState<SpaceSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [showAuth, setShowAuth] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLAnchorElement | null>>([])
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const debounce = useRef<number | null>(null)
  const term = normalizeSpaceSearch(query)
  const ownerRef = useRef(ownerId)
  const termRef = useRef(term)
  const activeRef = useRef(active)
  const snapshotRef = useRef(snapshot)
  ownerRef.current = ownerId
  termRef.current = term
  activeRef.current = active
  snapshotRef.current = snapshot

  const cancelSearch = useCallback(() => {
    ++sequence.current
    controller.current?.abort()
    controller.current = null
    if (debounce.current !== null) window.clearTimeout(debounce.current)
    debounce.current = null
  }, [])

  useEffect(() => {
    cancelSearch()
    termRef.current = ''
    setQuery('')
    setSnapshot(null)
    setLoading(false)
    setWaiting(false)
    setError('')
    setShowAuth(false)
    return cancelSearch
  }, [ownerId, kind, cancelSearch])

  useEffect(() => {
    if (!active) {
      cancelSearch()
      setLoading(false)
      setWaiting(false)
    }
  }, [active, cancelSearch])

  const runSearch = useCallback(async (searchTerm: string) => {
    if (!activeRef.current || !ownerId || !validSpaceSearch(searchTerm)) return
    cancelSearch()
    const requestId = sequence.current
    const abort = new AbortController()
    controller.current = abort
    const isCurrent = () => activeRef.current && !abort.signal.aborted && sequence.current === requestId
      && ownerRef.current === ownerId && termRef.current === searchTerm
    setLoading(true)
    setWaiting(false)
    setError('')
    try {
      const spaces = await searchChatSpaces(searchTerm, kind, abort.signal)
      if (!isCurrent()) return
      setSnapshot({ ownerId, term: searchTerm, spaces: spaces.filter((space) => space.visibility === 'public' && space.kind === kind) })
    } catch (searchError) {
      if (!isCurrent()) return
      console.error('Could not discover public chat spaces:', searchError)
      setSnapshot(null)
      setError(isMissingDatabaseFunction(searchError as { code?: string })
        ? 'Пошук спільнот ще готується до запуску. Спробуйте пізніше.'
        : 'Не вдалося оновити результати. Спробуйте ще раз.')
    } finally {
      if (isCurrent()) {
        controller.current = null
        setLoading(false)
      }
    }
  }, [ownerId, kind, cancelSearch])

  useEffect(() => {
    if (!active || !ownerId || !validSpaceSearch(term) || termRef.current !== term
      || (snapshotRef.current?.ownerId === ownerId && snapshotRef.current.term === term)) {
      setWaiting(false)
      return
    }
    setWaiting(true)
    debounce.current = window.setTimeout(() => {
      debounce.current = null
      void runSearch(term)
    }, 320)
    return () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current)
      debounce.current = null
    }
  }, [active, ownerId, term, runSearch])

  const changeQuery = (value: string) => {
    const nextTerm = normalizeSpaceSearch(value)
    if (nextTerm === termRef.current) { setQuery(value); return }
    cancelSearch()
    termRef.current = nextTerm
    setQuery(value)
    setSnapshot(null)
    setLoading(false)
    setWaiting(Boolean(ownerId && active && validSpaceSearch(nextTerm)))
    setError('')
  }

  const clearSearch = () => {
    changeQuery('')
    inputRef.current?.focus()
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    if (!ownerId) { setShowAuth(true); return }
    if (controller.current) return
    if (!validSpaceSearch(term)) {
      setError('Введіть від 2 до 80 символів назви або нікнейму.')
      inputRef.current?.focus()
      return
    }
    void runSearch(term)
  }

  const pending = loading || waiting
  const currentSnapshot = snapshot && snapshot.ownerId === ownerId && snapshot.term === term ? snapshot : null
  const spaces = currentSnapshot?.spaces || []
  const completed = Boolean(currentSnapshot && !pending)

  const handleResultKeys = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && index === 0) { inputRef.current?.focus(); return }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? spaces.length - 1
      : Math.max(0, Math.min(spaces.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    resultRefs.current[next]?.focus()
  }

  return (
    <section id={`search-${tabName}-panel`} role="tabpanel" aria-labelledby={`search-${tabName}-tab`} hidden={!active}>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      <header className="mb-5 sm:mb-7">
        <div className="mb-3 flex items-center gap-3 sm:gap-4">
          <span className="xelay-soft-panel flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-primary/70 sm:h-12 sm:w-12"><Icon size={21} aria-hidden="true" /></span>
          <h2 className="text-base font-semibold tracking-tight sm:text-xl">{isChannel ? 'Знайти канал' : 'Знайти групу'}</h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{isChannel ? 'Шукайте відкриті канали за назвою або нікнеймом і стежте за публікаціями.' : 'Знаходьте відкриті групи за назвою або нікнеймом і приєднуйтеся до спілкування.'}</p>
      </header>

      <p className="mb-4 rounded-2xl border border-primary/10 bg-accent/40 px-4 py-3.5 text-[13px] leading-relaxed text-accent-foreground sm:mb-5 sm:px-5 sm:text-sm">Пошук спільнот без обмежень і без підписки. Приватні групи та канали не відображаються.</p>

      <form role="search" aria-label={isChannel ? 'Пошук відкритих каналів' : 'Пошук відкритих груп'} onSubmit={submitSearch} className="mb-2.5 flex flex-col gap-2.5 sm:flex-row sm:gap-3">
        <div className="relative min-w-0 flex-1">
          <label htmlFor={`chat-${tabName}-search`} className="sr-only">Назва або нікнейм {isChannel ? 'каналу' : 'групи'}</label>
          <Search size={19} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-primary/60" aria-hidden="true" />
          <input id={`chat-${tabName}-search`} ref={inputRef} type="text" inputMode="search" autoComplete="off" autoCapitalize="none" spellCheck={false}
            value={query} onChange={(event) => changeQuery(event.target.value)} maxLength={161}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); clearSearch() }
              if (event.key === 'ArrowDown' && spaces.length) { event.preventDefault(); resultRefs.current[0]?.focus() }
            }}
            placeholder={isChannel ? 'Назва каналу або @нікнейм' : 'Назва групи або @нікнейм'}
            aria-describedby={`chat-${tabName}-search-hint`} aria-controls={`chat-${tabName}-search-results`}
            className="xelay-search-input h-[52px] w-full min-w-0 rounded-2xl border border-border/60 pl-11 pr-12 text-base placeholder:text-muted-foreground/70 focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 sm:h-14" />
          {query && <button type="button" onClick={clearSearch} aria-label="Очистити пошук" className="absolute inset-y-0 right-1 my-auto flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"><X size={18} aria-hidden="true" /></button>}
        </div>
        <button type="submit" disabled={loading} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-7 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 sm:h-14 sm:rounded-2xl">
          {loading ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <Search size={17} aria-hidden="true" />} Знайти
        </button>
      </form>
      <p id={`chat-${tabName}-search-hint`} className="mb-6 px-1 text-[12px] leading-relaxed text-muted-foreground sm:mb-7 sm:text-xs">Результати оновлюються під час введення від 2 символів. Пошук охоплює відкриті спільноти всього Xelay.</p>

      {error && <p role="alert" className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
      <section id={`chat-${tabName}-search-results`} aria-label={isChannel ? 'Знайдені канали' : 'Знайдені групи'} aria-busy={pending}>
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{pending ? 'Оновлюємо результати пошуку' : completed ? `Знайдено: ${spaces.length}` : ''}</p>
        {!ownerId ? <SpaceEmpty Icon={Icon} title="Знайдіть свою спільноту" description="Увійдіть до акаунта, щоб шукати відкриті групи й канали та приєднуватися до них.">
          <button type="button" onClick={() => setShowAuth(true)} className="mt-5 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground">Увійти до Xelay</button>
        </SpaceEmpty> : <>
          {!validSpaceSearch(term) && !error && <SpaceEmpty Icon={Search} title={Array.from(term).length === 1 ? 'Додайте ще один символ' : isChannel ? 'Який канал шукаємо?' : 'Яку групу шукаємо?'} description="Введіть щонайменше 2 символи назви або нікнейму. Можна шукати з @ або без нього." />}
          {pending && spaces.length === 0 && <div aria-hidden="true" className="space-y-2">{[0, 1, 2].map((row) => <div key={row} className="flex items-center gap-3 rounded-2xl border border-border p-4"><span className="h-12 w-12 shrink-0 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" /><span className="min-w-0 flex-1 space-y-2"><span className="block h-3.5 w-2/5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" /><span className="block h-3 w-3/5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" /></span></div>)}</div>}
          {completed && !error && spaces.length === 0 && <SpaceEmpty Icon={Icon} title="Збігів поки немає" description="Перевірте написання або введіть коротшу частину назви. Приватні спільноти доступні за запрошенням." />}
          {spaces.length > 0 && !error && <>
            <div className="mb-3 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground"><span>Знайдено: {spaces.length}{spaces.length >= 20 ? '+' : ''}</span><span className="inline-flex items-center gap-1.5"><Check size={13} className="text-primary" aria-hidden="true" /> Відкриті спільноти</span></div>
            <ul className="space-y-2">{spaces.map((space, index) => <li key={space.id} className="animate-fade-in motion-reduce:animate-none">
              <Link ref={(element) => { resultRefs.current[index] = element }} to="/messages" search={{ space: space.id, kind: tabName }}
                onKeyDown={(event) => handleResultKeys(event, index)}
                className="group flex w-full min-w-0 items-center gap-3 rounded-2xl border border-border/75 bg-card p-3.5 text-left transition-colors hover:border-primary/25 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 sm:gap-4 sm:p-4">
                <SpaceAvatar space={space} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold sm:text-base">{space.name}</span>
                  {space.username && <span className="mt-0.5 block truncate text-sm text-muted-foreground">@{space.username}</span>}
                  {space.description && <span className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{space.description}</span>}
                  <span className="mt-1.5 block text-xs text-muted-foreground">{memberLabel(space.member_count, isChannel)}</span>
                </span>
                <span className="hidden shrink-0 text-xs font-medium text-primary sm:inline">Відкрити</span><ArrowRight size={17} className="shrink-0 text-primary/60" aria-hidden="true" />
              </Link>
            </li>)}</ul>
            {spaces.length >= 20 && <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">Додайте кілька символів, щоб уточнити результати.</p>}
          </>}
        </>}
      </section>
    </section>
  )
}

function memberLabel(value: number | undefined, channel: boolean) {
  const count = Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
  const words = channel ? ['підписник', 'підписники', 'підписників'] : ['учасник', 'учасники', 'учасників']
  const lastTwo = count % 100
  const last = count % 10
  const word = lastTwo >= 11 && lastTwo <= 14 ? words[2] : last === 1 ? words[0] : last >= 2 && last <= 4 ? words[1] : words[2]
  return `${count.toLocaleString('uk-UA')} ${word}`
}

function SpaceAvatar({ space }: { space: ChatSpace }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const Icon = space.kind === 'channel' ? Megaphone : Users
  return <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border/70 bg-muted text-primary/70 sm:h-14 sm:w-14">
    {space.avatar_url && failedUrl !== space.avatar_url ? <img src={space.avatar_url} alt="" loading="lazy" onError={() => setFailedUrl(space.avatar_url || null)} className="h-full w-full object-cover" /> : <Icon size={24} aria-hidden="true" />}
  </span>
}

function SpaceEmpty({ Icon, title, description, children }: { Icon: typeof Search; title: string; description: string; children?: ReactNode }) {
  return <div className="rounded-3xl border border-dashed border-border bg-muted/20 px-5 py-11 text-center sm:py-14">
    <span className="xelay-soft-panel mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-primary/60"><Icon size={25} aria-hidden="true" /></span>
    <p className="font-semibold">{title}</p><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>{children}
  </div>
}
