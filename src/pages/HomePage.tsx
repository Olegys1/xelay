import { lazy, Suspense } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useAuth } from '../context/AuthContext'
import { LiveHomeDashboard } from '../components/home/LiveHomeDashboard'

const CommunityPage = lazy(() => import('./CommunityPage').then(module => ({ default: module.CommunityPage })))
const loading = <main role="status" className="flex min-h-[55vh] items-center justify-center text-sm text-muted-foreground">Завантажуємо ваш навчальний день…</main>

export function HomePage({ onAuthRequest }: { onAuthRequest?: () => void }) {
  const { authUser, xelayUser, isLoading } = useAuth()
  const { category } = useSearch({ from: '/' })
  // Existing category links still open the complete community composer.
  if (category) return <Suspense fallback={loading}><CommunityPage onAuthRequest={onAuthRequest} /></Suspense>
  if (isLoading) return loading
  if (!authUser) return <Suspense fallback={loading}><CommunityPage onAuthRequest={onAuthRequest} communityOnly={false} /></Suspense>
  if (!xelayUser || xelayUser.id !== authUser.id) return <main className="mx-auto max-w-xl px-6 py-16 text-center"><h1 className="text-xl font-semibold">Профіль ще не завантажено</h1><p className="mt-3 text-muted-foreground">Оновіть сторінку, щоб безпечно відкрити ваші групи.</p></main>
  return <LiveHomeDashboard key={authUser.id} profile={xelayUser} userId={authUser.id} />
}
