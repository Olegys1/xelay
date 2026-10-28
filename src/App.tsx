import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
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
import { NewsUnreadProvider } from './context/NewsUnreadContext'
import { AuthCallbackPage } from './pages/AuthCallbackPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { Header } from './components/Header'
import { BirthdayGiftExperience } from './components/birthday/BirthdayGiftExperience'
import { PushAccountBinding } from './components/PushAccountBinding'
import { AuthModal } from './components/AuthModal'
import { HomePage } from './pages/HomePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { LanguageProvider } from './context/LanguageContext'
import { ToastProvider } from './context/ToastContext'
import { SiteFooter } from './components/SiteFooter'
import { AdminSecurityGate } from './components/AdminSecurityGate'
import { AdminRepresentativeAlerts } from './components/AdminRepresentativeAlerts'
import { OrganizerReminders } from './components/OrganizerReminders'
import { ApplicationOnboarding } from './context/OnboardingContext'
import { FreeGroupsAnnouncement } from './components/FreeGroupsAnnouncement'
import { SocialLaunchAnnouncement } from './components/SocialLaunchAnnouncement'
import { StudyGroupJoinReminder } from './components/StudyGroupJoinReminder'
import { PrivacyConsentNotice } from './components/PrivacyConsentNotice'
import { GoogleRegistrationGate } from './components/GoogleRegistrationGate'
import { HalloweenHuntProvider } from './context/HalloweenHuntContext'
import { HalloweenExperience } from './components/halloween/HalloweenExperience'
import { HalloweenCommunityTotal } from './components/halloween/HalloweenCommunityTotal'

const CommunityPage = lazy(() => import('./pages/CommunityPage').then((module) => ({ default: module.CommunityPage })))
const CategoriesPage = lazy(() => import('./pages/CategoriesPage').then((module) => ({ default: module.CategoriesPage })))
const CategoryDetailPage = lazy(() => import('./pages/CategoryDetailPage').then((module) => ({ default: module.CategoryDetailPage })))
const QuestionDetailPage = lazy(() => import('./pages/QuestionDetailPage').then((module) => ({ default: module.QuestionDetailPage })))
const ProfilePage = lazy(() => import('./pages/ProfilePage').then((module) => ({ default: module.ProfilePage })))
const PublicProfilePage = lazy(() => import('./pages/PublicProfilePage').then((module) => ({ default: module.PublicProfilePage })))
const MessagesPage = lazy(() => import('./pages/MessagesPage').then((module) => ({ default: module.MessagesPage })))
const UserSearchPage = lazy(() => import('./pages/UserSearchPage').then((module) => ({ default: module.UserSearchPage })))
const NewsPage = lazy(() => import('./pages/NewsPage').then((module) => ({ default: module.NewsPage })))
const NewsPostPage = lazy(() => import('./pages/NewsPostPage').then((module) => ({ default: module.NewsPostPage })))
const AdminPage = lazy(() => import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })))
const LegalPage = lazy(() => import('./pages/LegalPage').then((module) => ({ default: module.LegalPage })))
const OpportunitiesPage = lazy(() => import('./pages/OpportunitiesPage').then((module) => ({ default: module.OpportunitiesPage })))

// Keep the home page and password callbacks available in the initial bundle.
// Other pages load when opened; the surrounding header/providers stay mounted.
function PageSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<main role="status" className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження сторінки…</main>}>{children}</Suspense>
}

const StudyGroupsPage = lazy(() => import('./pages/StudyGroupsPage').then((module) => ({ default: module.StudyGroupsPage })))
const StudyGroupDetailPage = lazy(() => import('./pages/StudyGroupsPage').then((module) => ({ default: module.StudyGroupDetailPage })))
const SubscriptionPage = lazy(() => import('./pages/SubscriptionPage').then((module) => ({ default: module.SubscriptionPage })))
const TeamSupportPage = lazy(() => import('./pages/TeamSupportPage').then((module) => ({ default: module.TeamSupportPage })))
const OrganizerPage = lazy(() => import('./pages/OrganizerPage').then((module) => ({ default: module.OrganizerPage })))
const TeachingPage = lazy(() => import('./pages/TeachingPage').then((module) => ({ default: module.TeachingPage })))
const HalloweenPage = lazy(() => import('./pages/HalloweenPage').then((module) => ({ default: module.HalloweenPage })))

function TeachingPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження викладання…</main>}><TeachingPage /></Suspense>
}

function SubscriptionPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження підписки…</main>}><SubscriptionPage /></Suspense>
}

function TeamSupportPageRoute() {
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження підтримки…</main>}><TeamSupportPage /></Suspense>
}

function OrganizerPageRoute() {
  const search = useRouterState({ select: (state) => state.location.search }) as { view?: 'shared'; workspace?: string }
  return <Suspense fallback={<main className="flex min-h-[60vh] items-center justify-center text-muted-foreground">Завантаження органайзера…</main>}><OrganizerPage initialView={search.view === 'shared' ? 'shared' : 'personal'} initialWorkspaceId={search.workspace} /></Suspense>
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
        <HalloweenCommunityTotal hidden={pathname.startsWith('/admin') || pathname.startsWith('/auth/') || pathname === '/reset-password'} />
        <PushAccountBinding />
        {pathname === '/reset-password' || pathname === '/auth/callback' ? <Outlet /> : <AdminSecurityGate key={authUser?.id || 'guest'}><GoogleRegistrationGate><AdminRepresentativeAlerts blocked={showAuthModal} /><PrivacyConsentNotice /><ApplicationOnboarding><HalloweenExperience pathname={pathname} blocked={showAuthModal} onAuthRequest={() => setShowAuthModal(true)} /><Outlet /><StudyGroupJoinReminder blocked={showAuthModal} /><FreeGroupsAnnouncement blocked={showAuthModal} /><SocialLaunchAnnouncement blocked={showAuthModal} /><BirthdayGiftExperience blocked={showAuthModal} /></ApplicationOnboarding></GoogleRegistrationGate></AdminSecurityGate>}
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

const communityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/community',
  validateSearch: (search: Record<string, unknown>) => ({
    category: typeof search.category === 'string' ? search.category : undefined,
  }),
  component: () => <PageSuspense><CommunityPage /></PageSuspense>,
})

const categoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/categories',
  component: () => <PageSuspense><CategoriesPage /></PageSuspense>,
})

const categoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/category/$slug',
  component: () => <PageSuspense><CategoryDetailPage /></PageSuspense>,
})

const questionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/question/$id',
  validateSearch: (search: Record<string, unknown>): { answer?: string } => {
    // Legacy community IDs are text; normalize UUIDs without excluding older IDs.
    const answer = typeof search.answer === 'string' && search.answer.trim().length > 0
      && search.answer.length <= 128 && !/[\u0000-\u001f\u007f]/.test(search.answer) ? search.answer : undefined
    return { answer: answer && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(answer) ? answer.toLowerCase() : answer }
  },
  component: () => <PageSuspense><QuestionDetailPage /></PageSuspense>,
})

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: () => <PageSuspense><ProfilePage /></PageSuspense>,
})

const publicProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/user/$id',
  component: () => <PageSuspense><PublicProfilePage /></PageSuspense>,
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
  component: () => <PageSuspense><MessagesPage /></PageSuspense>,
})

const userSearchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  component: () => <PageSuspense><UserSearchPage /></PageSuspense>,
})

const newsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/news',
  component: () => <PageSuspense><NewsPage /></PageSuspense>,
})

const opportunitiesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/opportunities', component: () => <PageSuspense><OpportunitiesPage /></PageSuspense> })

const newsPostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/news/$id',
  component: () => <PageSuspense><NewsPostPage /></PageSuspense>,
})

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: () => <PageSuspense><AdminPage /></PageSuspense>,
})

const studyGroupsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/groups',
  component: StudyGroupsPageRoute,
})

const subscriptionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/subscription', component: SubscriptionPageRoute })
const teamSupportRoute = createRoute({ getParentRoute: () => rootRoute, path: '/support', component: TeamSupportPageRoute })
const halloweenRoute = createRoute({ getParentRoute: () => rootRoute, path: '/halloween', component: () => <PageSuspense><HalloweenPage /></PageSuspense> })
const termsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/terms', component: () => <PageSuspense><LegalPage kind="terms" /></PageSuspense> })
const communityRulesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/community-rules', component: () => <PageSuspense><LegalPage kind="community-rules" /></PageSuspense> })
const refundPolicyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/refund-policy', component: () => <PageSuspense><LegalPage kind="refund-policy" /></PageSuspense> })
const contactsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/contacts', component: () => <PageSuspense><LegalPage kind="contacts" /></PageSuspense> })
const privacyPolicyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/privacy-policy', component: () => <PageSuspense><LegalPage kind="privacy-policy" /></PageSuspense> })
const personalDataConsentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/personal-data-consent', component: () => <PageSuspense><LegalPage kind="personal-data-consent" /></PageSuspense> })
const organizerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizer',
  validateSearch: (search: Record<string, unknown>): { view?: 'shared'; workspace?: string } => {
    const view = search.view === 'shared' ? 'shared' : undefined
    const workspace = view && typeof search.workspace === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.workspace)
      ? search.workspace.toLowerCase() : undefined
    return { view, workspace }
  },
  component: OrganizerPageRoute,
})
const authCallbackRoute = createRoute({ getParentRoute: () => rootRoute, path: '/auth/callback', component: AuthCallbackPage })
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage })

const studyGroupDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/groups/$id',
  validateSearch: (search: Record<string, unknown>): { tab?: 'schedule' | 'seminars' | 'timetable' | 'materials' | 'guides'; date?: string; assignment?: string; kind?: 'seminar' | 'homework'; teaching?: string; home?: 'journal' | 'assignments' | 'materials' } => {
    const kind = search.kind === 'seminar' || search.kind === 'homework' ? search.kind : undefined
    const tab = kind ? kind === 'seminar' ? 'seminars' : 'schedule'
      : search.tab === 'schedule' || search.tab === 'seminars' || search.tab === 'timetable' || search.tab === 'materials' || search.tab === 'guides' ? search.tab : undefined
    const date = typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      && Number.isFinite(Date.parse(`${search.date}T12:00:00Z`))
      && new Date(`${search.date}T12:00:00Z`).toISOString().slice(0, 10) === search.date ? search.date : undefined
    const assignment = typeof search.assignment === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.assignment)
      ? search.assignment : undefined
    const teaching = typeof search.teaching === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.teaching) ? search.teaching : undefined
    const home = teaching && (search.home === 'journal' || search.home === 'assignments' || search.home === 'materials') ? search.home : undefined
    return { tab, date, assignment, kind, teaching, home }
  },
  component: StudyGroupDetailPageRoute,
})

const teachingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/teaching',
  validateSearch: (search: Record<string, unknown>): { course?: string; home?: 'calendar' | 'scheduled' | 'requests' | 'materials' | 'journal' | 'assignments'; group?: string; date?: string } => {
    const course = typeof search.course === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.course) ? search.course : undefined
    const home = search.home === 'calendar' || search.home === 'scheduled' || search.home === 'requests' || search.home === 'materials' || search.home === 'journal' || search.home === 'assignments' ? search.home : undefined
    const group = typeof search.group === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.group) ? search.group.toLowerCase() : undefined
    const date = typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      && Number.isFinite(Date.parse(`${search.date}T12:00:00Z`))
      && new Date(`${search.date}T12:00:00Z`).toISOString().slice(0, 10) === search.date ? search.date : undefined
    return { course, home, group, date }
  },
  component: TeachingPageRoute,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  communityRoute,
  categoriesRoute,
  categoryDetailRoute,
  questionDetailRoute,
  profileRoute,
  publicProfileRoute,
  messagesRoute,
  userSearchRoute,
  newsRoute,
  opportunitiesRoute,
  newsPostRoute,
  adminRoute,
  studyGroupsRoute,
  studyGroupDetailRoute,
  subscriptionRoute,
  teamSupportRoute,
  halloweenRoute,
  termsRoute,
  communityRulesRoute,
  refundPolicyRoute,
  contactsRoute,
  privacyPolicyRoute,
  personalDataConsentRoute,
  organizerRoute,
  teachingRoute,
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
    <HalloweenHuntProvider>
    <NewsUnreadProvider>
    <OrganizerReminders />
    <RouterProvider router={router} />
    </NewsUnreadProvider>
    </HalloweenHuntProvider>
    </ToastProvider>
    </BillingProvider>
    </NotificationPreferencesProvider>
  </AuthProvider>
</LanguageProvider>
  )
}
