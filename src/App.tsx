import { useState } from 'react'
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router'
import { AuthProvider } from './context/AuthContext'
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
import { NotFoundPage } from './pages/NotFoundPage'
import { LanguageProvider } from './context/LanguageContext'
// Root layout with Header
function RootLayout() {
  const [showAuthModal, setShowAuthModal] = useState(false)
  return (
    <>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <div className="flex flex-col min-h-screen bg-background">
        <Header onAuthRequest={() => setShowAuthModal(true)} />
        <Outlet />
        <footer className="border-t border-border py-8 mt-auto">
          <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
            <span className="font-bold text-foreground tracking-tight">Xelay</span>
            <span>© {new Date().getFullYear()} Xelay · Університетська спільнота</span>
            <span className="text-xs text-muted-foreground/50 font-mono">v1.1.3 · build 2026-05-10</span>
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  categoriesRoute,
  categoryDetailRoute,
  questionDetailRoute,
  profileRoute,
  publicProfileRoute,
  messagesRoute,
  userSearchRoute,
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
    <RouterProvider router={router} />
  </AuthProvider>
</LanguageProvider>
  )
}
