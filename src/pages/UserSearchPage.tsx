import { FormEvent, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Search, Users, UserRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

interface SearchProfile {
  id: string
  username: string
  full_name: string
  avatar_url: string | null
  faculty: string | null
  specialty: string | null
  study_year: number | null
}

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000'

export function UserSearchPage() {
  const navigate = useNavigate()
  const { authUser } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [searchedFor, setSearchedFor] = useState('')
  const [people, setPeople] = useState<SearchProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const searchPeople = async (event: FormEvent) => {
    event.preventDefault()
    const term = query.trim().replace(/^@+/, '').toLocaleLowerCase('uk-UA')
      .replace(/[^\p{L}\p{N}._-]/gu, '')

    setSearchedFor(term)
    setError('')
    setPeople([])
    if (term.length < 2) {
      setError('Введіть щонайменше 2 символи ніку.')
      inputRef.current?.focus()
      return
    }

    // Treat %, _ and backslashes as nickname characters, not SQL LIKE wildcards.
    const pattern = `%${term.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&')}%`
    setLoading(true)
    try {
      const { data, error: searchError } = await supabase
        .from('profiles')
        .select('id, username, full_name, avatar_url, faculty, specialty, study_year')
        .ilike('username', pattern)
        .neq('id', authUser?.id || EMPTY_UUID)
        .order('username', { ascending: true })
        .limit(30)

      if (searchError) throw searchError
      setPeople((data || []) as SearchProfile[])
    } catch (searchError) {
      console.error('Could not search profiles:', searchError)
      setError('Не вдалося виконати пошук. Переконайтеся, що міграцію ніків застосовано до Supabase.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-background">
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

        <form onSubmit={(event) => void searchPeople(event)} className="flex flex-col sm:flex-row gap-3 mb-6">
          <label className="relative flex-1">
            <span className="sr-only">Нік користувача</span>
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">@</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={30}
              placeholder="Введіть нік користувача"
              className="w-full h-12 rounded-full border border-border bg-background pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="h-12 rounded-full bg-foreground px-6 text-sm font-semibold text-background inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading ? <Loader2 size={17} className="animate-spin" /> : <Search size={17} />}
            Знайти
          </button>
        </form>

        {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

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

        {!loading && searchedFor && !error && people.length === 0 && (
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
                    <span className="block truncate font-semibold text-foreground">{person.full_name || 'Учасник Xelay'}</span>
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
