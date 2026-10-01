import { lazy, Suspense, useEffect, useState } from 'react'
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { AuthProvider, useAuth } from './context/AuthContext'
import { BillingProvider } from './context/BillingContext'
import { NotificationPreferencesProvider } from './context/NotificationPreferencesContext'
import { AuthCallbackPage } from './pages/AuthCallbackPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { Header } from './components/Header'
import { AuthModal } from './components/AuthModal'
import { HomePage } from './pages/HomePage'
import { CategoriesPage } from './pages/CategoriesPage'
import { CategoryDetailPage } from './pages/CategoryDetailPage'
import { QuestionDetailPage } from './pages/QuestionDetailPage'
import { ProfilePage } from './pages/ProfilePage'
import { PublicProfilePage } from './pages/PublicProfilePage'
import { MessagesPage } from './pages/MessagesPage'
import { UserSearchPage } from './pages/UserSearchPage'
import { NewsPage } from './pages/NewsPage'
import { NewsPostPage } from './pages/NewsPostPage'
import { AdminPage } from './pages/AdminPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { LanguageProvider } from './context/LanguageContext'

const StudyGroupsPage = lazy(() => import('./pages/StudyGroupsPage').then((module) => ({ default: module.StudyGroupsPage })))
const StudyGroupDetailPage = lazy(() => import('./pages/StudyGroupsPage').then((module) => ({ default: module.StudyGroupDetailPage })))
const SubscriptionPage = lazy(() => import('./pages/SubscriptionPage').then((module) => ({ default: module.SubscriptionPage })))
const OrganizerPage = lazy(() => import('./pages/OrganizerPage').then((module) => ({ default: module.OrganizerPage })))

function SubscriptionPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження підписки…</main>}><SubscriptionPage /></Suspense>
}

function OrganizerPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження органайзера…</main>}><OrganizerPage /></Suspense>
}

function StudyGroupsPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">Завантаження груп…</main>}><StudyGroupsPage /></Suspense>
}

function StudyGroupDetailPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">Завантаження розкладу…</main>}><StudyGroupDetailPage /></Suspense>
}

// Root layout with Header
function RootLayout() {
  const [showAuthModal, setShowAuthModal] = useState(false)
  const { isPasswordRecovery } = useAuth()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  useEffect(() => {
    if (isPasswordRecovery && pathname !== '/reset-password') {
      setShowAuthModal(false)
      void navigate({ to: '/reset-password', replace: true })
    }
  }, [isPasswordRecovery, pathname, navigate])
  return (
    <>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <div className="flex min-h-screen w-full min-w-0 flex-col overflow-x-clip bg-background">
        <Header onAuthRequest={() => setShowAuthModal(true)} />
        <Outlet />
        <footer className="border-t border-border py-8 mt-auto">
          <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
            <span className="font-bold text-foreground tracking-tight">Xelay</span>
            <span>© {new Date().getFullYear()} Xelay · Університетська спільнота</span>
            <span className="text-xs text-muted-foreground/50 font-mono">v1.1.3 · build 25.09.2026</span>
          </div>
        </footer>
      </div>
    </>
  )
}

// Routes
const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>) => ({
    category: typeof search.category === 'string' ? search.category : undefined,
  }),
  component: HomePage,
})

const categoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/categories',
  component: CategoriesPage,
})

const categoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/category/$slug',
  component: CategoryDetailPage,
})

const questionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/question/$id',
  component: QuestionDetailPage,
})

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: ProfilePage,
})

const publicProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/user/$id',
  component: PublicProfilePage,
})

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  component: MessagesPage,
})

const userSearchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  component: UserSearchPage,
})

const newsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/news',
  component: NewsPage,
})

const newsPostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/news/$id',
  component: NewsPostPage,
})

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminPage,
})

const studyGroupsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/groups',
  component: StudyGroupsPageRoute,
})

const subscriptionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/subscription', component: SubscriptionPageRoute })
const organizerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizer', component: OrganizerPageRoute })
const authCallbackRoute = createRoute({ getParentRoute: () => rootRoute, path: '/auth/callback', component: AuthCallbackPage })
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage })

const studyGroupDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/groups/$id',
  component: StudyGroupDetailPageRoute,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  categoriesRoute,
  categoryDetailRoute,
  questionDetailRoute,
  profileRoute,
  publicProfileRoute,
  messagesRoute,
  userSearchRoute,
  newsRoute,
  newsPostRoute,
  adminRoute,
  studyGroupsRoute,
  studyGroupDetailRoute,
  subscriptionRoute,
  organizerRoute,
  authCallbackRoute,
  resetPasswordRoute,
] as const)

const router = createRouter({
  routeTree: routeTree as any,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export default function App() {
  return (
    <LanguageProvider>
  <AuthProvider>
    <NotificationPreferencesProvider>
    <BillingProvider>
    <RouterProvider router={router} />
    </BillingProvider>
    </NotificationPreferencesProvider>
  </AuthProvider>
</LanguageProvider>
  )
}
