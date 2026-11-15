import { lazy, Suspense, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { AuthModal } from '../components/AuthModal'
import { GuestHomeDashboard } from '../components/home/GuestHomeDashboard'
import { LiveHomeDashboard } from '../components/home/LiveHomeDashboard'

const CommunityPage = lazy(() => import('./CommunityPage').then(module => ({ default: module.CommunityPage })))
const loading = <main role="status" className="flex min-h-[55vh] items-center justify-center text-sm text-muted-foreground">Завантажуємо ваш навчальний день…</main>

export function HomePage({ onAuthRequest }: { onAuthRequest?: () => void }) {
  const { authUser, xelayUser, isLoading, sessionUnavailable, refreshUser } = useAuth()
  const { theme } = useTheme()
  const [authOpen, setAuthOpen] = useState(false)
  const { category } = useSearch({ from: '/' })
  // Existing category links still open the complete community composer.
  if (category) return <Suspense fallback={loading}><CommunityPage onAuthRequest={onAuthRequest} /></Suspense>
  if (isLoading) return loading
  if (sessionUnavailable) return <main className="mx-auto max-w-xl px-6 py-16 text-center"><h1 className="text-xl font-semibold">Не вдалося перевірити вхід</h1><p className="mt-3 text-muted-foreground">Xelay не отримав відповідь від сервісу входу. Повторіть перевірку без перезавантаження сторінки.</p><button type="button" className="xelay-btn mt-5 min-h-11 rounded-xl bg-primary px-5 py-2 font-semibold text-primary-foreground" onClick={() => { void refreshUser() }}>Спробувати ще раз</button></main>
  if (!authUser) return <>
    <GuestHomeDashboard theme={theme} onAuthRequest={onAuthRequest ?? (() => setAuthOpen(true))} />
    {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
  </>
  if (!xelayUser || xelayUser.id !== authUser.id) return <main className="mx-auto max-w-xl px-6 py-16 text-center"><h1 className="text-xl font-semibold">Профіль ще не завантажено</h1><p className="mt-3 text-muted-foreground">Не вдалося отримати ваш профіль. Повторіть запит, щоб безпечно відкрити групи.</p><button type="button" className="xelay-btn mt-5 min-h-11 rounded-xl bg-primary px-5 py-2 font-semibold text-primary-foreground" onClick={() => { void refreshUser() }}>Завантажити профіль</button></main>
  return <LiveHomeDashboard key={authUser.id} profile={xelayUser} userId={authUser.id} />
}
