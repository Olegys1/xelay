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
import { ToastProvider } from './context/ToastContext'
import { LegalPage } from './pages/LegalPage'
import { SiteFooter } from './components/SiteFooter'
import { AdminSecurityGate } from './components/AdminSecurityGate'

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
  const { isPasswordRecovery, authUser } = useAuth()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  useEffect(() => {
    if (isPasswordRecovery && pathname !== '/reset-password' && pathname !== '/auth/callback') {
      setShowAuthModal(false)
      void navigate({ to: '/reset-password', replace: true })
    }
  }, [isPasswordRecovery, pathname, navigate])
  return (
    <>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <div className="flex min-h-screen w-full min-w-0 flex-col overflow-x-clip bg-background">
        <Header onAuthRequest={() => setShowAuthModal(true)} />
        {pathname === '/reset-password' || pathname === '/auth/callback' ? <Outlet /> : <AdminSecurityGate key={authUser?.id || 'guest'}><Outlet /></AdminSecurityGate>}
        <SiteFooter />
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
  validateSearch: (search: Record<string, unknown>): { space?: string; invite?: string; conversation?: string; kind?: 'personal' | 'groups' | 'channels' } => ({
    space: typeof search.space === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.space) ? search.space : undefined,
    invite: typeof search.invite === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(search.invite) ? search.invite : undefined,
    conversation: typeof search.conversation === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.conversation) ? search.conversation : undefined,
    kind: search.kind === 'personal' || search.kind === 'groups' || search.kind === 'channels' ? search.kind : undefined,
  }),
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
const termsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/terms', component: () => <LegalPage kind="terms" /> })
const refundPolicyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/refund-policy', component: () => <LegalPage kind="refund-policy" /> })
const contactsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/contacts', component: () => <LegalPage kind="contacts" /> })
const organizerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizer', component: OrganizerPageRoute })
const authCallbackRoute = createRoute({ getParentRoute: () => rootRoute, path: '/auth/callback', component: AuthCallbackPage })
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage })

const studyGroupDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/groups/$id',
  validateSearch: (search: Record<string, unknown>): { tab?: 'schedule' | 'seminars' | 'timetable'; date?: string; assignment?: string; kind?: 'seminar' | 'homework' } => {
    const kind = search.kind === 'seminar' || search.kind === 'homework' ? search.kind : undefined
    const tab = kind ? kind === 'seminar' ? 'seminars' : 'schedule'
      : search.tab === 'schedule' || search.tab === 'seminars' || search.tab === 'timetable' ? search.tab : undefined
    const date = typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      && Number.isFinite(Date.parse(`${search.date}T12:00:00Z`))
      && new Date(`${search.date}T12:00:00Z`).toISOString().slice(0, 10) === search.date ? search.date : undefined
    const assignment = typeof search.assignment === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.assignment)
      ? search.assignment : undefined
    return { tab, date, assignment, kind }
  },
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
  termsRoute,
  refundPolicyRoute,
  contactsRoute,
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
    <ToastProvider>
    <RouterProvider router={router} />
    </ToastProvider>
    </BillingProvider>
    </NotificationPreferencesProvider>
  </AuthProvider>
</LanguageProvider>
  )
}
