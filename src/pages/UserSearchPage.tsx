import { FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Search, Sparkles, Users, UserRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingDatabaseFunction } from '../lib/databaseCompatibility'
import { useBilling } from '../context/BillingContext'
import { AuthModal } from '../components/AuthModal'
import { PremiumBadge } from '../components/PremiumBadge'

interface SearchProfile {
  id: string
  username: string
  full_name: string
  avatar_url: string | null
  faculty: string | null
  specialty: string | null
  study_year: number | null
}

export function UserSearchPage() {
  const navigate = useNavigate()
  const { authUser } = useAuth()
  const { isPremium, searchRemaining, isLoading: billingLoading, error: billingError, refreshBilling } = useBilling()
  const [showAuth, setShowAuth] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [searchedFor, setSearchedFor] = useState('')
  const [peopleData, setPeople] = useState<SearchProfile[]>([])
  const [resultOwnerId, setResultOwnerId] = useState(authUser?.id)
  const people = resultOwnerId === authUser?.id ? peopleData : []
  const [premiumIdentities, setPremiumIdentities] = useState<Record<string, { is_premium: boolean; emoji_status: string | null }>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [limitReached, setLimitReached] = useState(false)
  const submitting = useRef(false)
  const ownerRef = useRef(authUser?.id)
  ownerRef.current = authUser?.id
  const requestSequence = useRef(0)

  useEffect(() => {
    ++requestSequence.current
    submitting.current = false
    setLoading(false)
    setQuery('')
    setResultOwnerId(authUser?.id)
    setPeople([])
    setSearchedFor('')
    setError('')
    setLimitReached(false)
    return () => { ++requestSequence.current }
  }, [authUser?.id])

  useEffect(() => {
    if (limitReached && !billingLoading && !billingError && (isPremium || searchRemaining > 0)) {
      setLimitReached(false)
    }
  }, [limitReached, billingLoading, billingError, isPremium, searchRemaining])

  useEffect(() => {
    let active = true
    let busy = false
    setPremiumIdentities({})
    if (resultOwnerId !== authUser?.id || !peopleData.length) return
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { data, error } = await supabase.rpc('xelay_public_premium', { p_user_ids: peopleData.map((person) => person.id) })
        if (active) setPremiumIdentities(!error && Array.isArray(data) ? Object.fromEntries(data.map((identity) => [identity.user_id, identity])) : {})
      } finally { busy = false }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    const interval = window.setInterval(() => void refresh(), 60_000)
    return () => { active = false; window.removeEventListener('focus', refresh); window.clearInterval(interval) }
  }, [peopleData, resultOwnerId, authUser?.id])

  const searchPeople = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting.current) return
    if (!authUser) { setShowAuth(true); return }
    const ownerId = authUser.id
    const term = query.trim().replace(/^@+/, '').toLocaleLowerCase('uk-UA')

    setSearchedFor(term)
    setError('')
    setPeople([])
    setLimitReached(false)
    if (term.length < 2 || term.length > 30 || !/^[\p{L}\p{N}._-]+$/u.test(term)) {
      setError('Введіть від 2 до 30 символів ніку: літери, цифри, крапку, підкреслення або дефіс.')
      inputRef.current?.focus()
      return
    }

    submitting.current = true
    const sequence = ++requestSequence.current
    const isCurrent = () => ownerRef.current === ownerId && sequence === requestSequence.current
    setLoading(true)
    try {
      const { data, error: searchError } = await supabase.rpc('xelay_search_users', { p_query: term })
      if (!isCurrent()) return
      if (searchError) throw searchError
      if (!data || typeof data !== 'object' || !Array.isArray(data.profiles)) throw new Error('Invalid search result')
      await refreshBilling()
      if (!isCurrent()) return
      if (data.limit_reached === true) setLimitReached(true)
      else setPeople(data.profiles as SearchProfile[])
    } catch (searchError) {
      if (!isCurrent()) return
      console.error('Could not search profiles:', searchError)
      setError(isMissingDatabaseFunction(searchError as { code?: string })
        ? 'Оновлений пошук ще готується до запуску. Спробуйте пізніше.'
        : 'Не вдалося виконати пошук. Спробуйте ще раз трохи пізніше.')
    } finally {
      if (isCurrent()) {
        setLoading(false)
        submitting.current = false
      }
    }
  }

  return (
    <main className="min-h-screen bg-background">
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <header className="mb-7">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center">
              <Users size={21} />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold">Знайти людей</h1>
          </div>
          <p className="text-sm text-muted-foreground sm:ml-14">
            Знайдіть учасників Xelay за ніком і відкрийте їхній профіль.
          </p>
        </header>

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/10 bg-accent/60 px-4 py-3 text-sm">
          <span className="text-accent-foreground">
            {authUser ? (isPremium ? 'Пошук без обмежень · Учасник' : `Доступно пошуків сьогодні: ${billingLoading || billingError ? '—' : searchRemaining} із 5`) : 'Увійдіть, щоб шукати людей. Безкоштовно — 5 пошуків на день.'}
          </span>
          {!isPremium && <button onClick={() => navigate({ to: '/subscription' })} className="inline-flex items-center gap-1.5 font-semibold text-primary"><Sparkles size={15} /> Без обмежень</button>}
        </div>

        <form onSubmit={(event) => void searchPeople(event)} className="flex flex-col sm:flex-row gap-3 mb-6">
          <label className="relative flex-1">
            <span className="sr-only">Нік користувача</span>
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">@</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={31}
              placeholder="Введіть нік користувача"
              className="w-full h-12 rounded-full border border-border bg-background pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="h-12 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading ? <Loader2 size={17} className="animate-spin" /> : <Search size={17} />}
            Знайти
          </button>
        </form>

        {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {limitReached && <p role="alert" className="mb-4 rounded-xl bg-primary/5 px-4 py-3 text-sm text-primary">Ви використали 5 пошуків на сьогодні. Нові пошуки будуть доступні завтра за київським часом.</p>}
        {limitReached && <button onClick={() => navigate({ to: '/subscription' })} className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground"><Sparkles size={16} /> Підписка Учасник · 100 грн/місяць</button>}

        {!searchedFor && !loading && (
          <div className="xelay-card px-6 py-12 text-center">
            <Search size={28} className="mx-auto mb-3 text-muted-foreground/60" />
            <p className="font-medium">Пошукайте за ніком</p>
            <p className="mt-1 text-sm text-muted-foreground">Можна ввести повний нік або його частину.</p>
          </div>
        )}

        {loading && (
          <div className="py-14 text-center text-muted-foreground">
            <Loader2 size={24} className="mx-auto animate-spin mb-3" />
            Шукаємо учасників…
          </div>
        )}

        {!loading && searchedFor && !error && !limitReached && people.length === 0 && (
          <div className="xelay-card px-6 py-12 text-center">
            <UserRound size={28} className="mx-auto mb-3 text-muted-foreground/60" />
            <p className="font-medium">Нікого не знайдено</p>
            <p className="mt-1 text-sm text-muted-foreground">Спробуйте іншу частину ніку.</p>
          </div>
        )}

        {!loading && people.length > 0 && (
          <section aria-label="Результати пошуку">
            <p className="mb-3 text-sm text-muted-foreground">Знайдено: {people.length}</p>
            <div className="space-y-3">
              {people.map((person) => (
                <button
                  key={person.id}
                  onClick={() => navigate({ to: '/user/$id', params: { id: person.id } })}
                  className="xelay-card w-full p-4 sm:p-5 flex items-center gap-4 text-left hover:border-foreground/30"
                >
                  <Avatar person={person} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 font-semibold text-foreground"><span className="truncate">{person.full_name || 'Учасник Xelay'}</span><PremiumBadge isPremium={Boolean(premiumIdentities[person.id]?.is_premium)} emojiStatus={premiumIdentities[person.id]?.emoji_status} compact /></span>
                    <span className="mt-0.5 block truncate text-sm text-muted-foreground">@{person.username}</span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {[person.faculty, person.specialty, person.study_year ? `${person.study_year} курс` : '']
                        .filter(Boolean).join(' · ') || 'Учасник університетської спільноти'}
                    </span>
                  </span>
                  <span className="hidden sm:inline-flex shrink-0 items-center gap-1 text-sm font-medium text-foreground">
                    Переглянути профіль <span aria-hidden="true">→</span>
                  </span>
                  <span className="sm:hidden text-muted-foreground" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
            {people.length === 30 && <p className="mt-4 text-center text-xs text-muted-foreground">Показані перші 30 результатів. Уточніть нік, щоб звузити пошук.</p>}
          </section>
        )}
      </div>
    </main>
  )
}

function Avatar({ person }: { person: SearchProfile }) {
  const initials = person.full_name?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?'
  return (
    <span className="w-14 h-14 shrink-0 overflow-hidden rounded-full bg-muted flex items-center justify-center">
      {person.avatar_url ? <img src={person.avatar_url} alt="" className="h-full w-full object-cover" /> : <span className="font-semibold">{initials}</span>}
    </span>
  )
}
