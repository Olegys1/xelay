import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  X,
  Home,
  Newspaper,
  CalendarCheck,
  Sparkles,
  Heart,
  User,
  ChevronRight,
  CircleHelp,
  UsersRound,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { openPlatformGuide } from '../lib/onboarding'
import { CATEGORIES, categoryToSlug } from '../types'
import { CategoryIcon } from './CategoryIcon'
import { ThemeToggle } from './ThemeToggle'
import { XelayLogo } from './XelayLogo'
import { categoryLabel } from '../translations/categories'
import { useTranslation }
  from '../hooks/useTranslation'

interface BurgerMenuProps {
  isOpen: boolean
  onClose: () => void
}



export function BurgerMenu({ isOpen, onClose }: BurgerMenuProps) {
  const menuRef = useRef<HTMLElement>(null)
  const { isAuthenticated } = useAuth()
  const { t } =
  useTranslation()
  const mainMenuItems = [
  {
    label: t('home'),
    icon: Home,
    path: '/',
  },

  {
    label: 'Новини',
    icon: Newspaper,
    path: '/news',
  },

  {
    label: t('profile'),
    icon: User,
    path: '/profile',
  },
  { label: 'Органайзер', icon: CalendarCheck, path: '/organizer' },
  { label: 'Навчальні групи', icon: UsersRound, path: '/groups' },
  { label: 'Підписка Учасник', icon: Sparkles, path: '/subscription' },
  { label: 'Підтримати команду', icon: Heart, path: '/support' },

]
  const navigate = useNavigate()

  useEffect(() => {
    if (!isOpen) return
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    menuRef.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = previousOverflow
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [isOpen])

const handleNav = (path: string) => {
  navigate({ to: path })

  onClose()
}

const handleCategoryNav = (cat: string) => {
  navigate({
    to: `/category/${categoryToSlug(cat)}`,
  })

  onClose()
}

  if (!isOpen) return null

  return (
    <>
      {/* Overlay */}
      <div
        className="xelay-dialog-backdrop fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Menu Panel */}
      <aside
        ref={menuRef}
        tabIndex={-1}
        className="xelay-drawer fixed inset-y-0 left-0 z-50 w-80 bg-background border-r border-border flex flex-col overflow-y-auto outline-none"
        role="dialog"
        aria-modal="true"
        aria-label="Меню навігації"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]') || [])
            .filter((item) => item.tabIndex >= 0 && item.offsetParent !== null)
          const first = items[0]; const last = items[items.length - 1]
          if (!first) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === menuRef.current)) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === menuRef.current)) {
            event.preventDefault(); first.focus()
          }
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-border sticky top-0 bg-background z-10">
          <button
            type="button"
            className="shrink-0 transition-opacity hover:opacity-70 xelay-btn"
            onClick={() => handleNav('/')}
            aria-label="Xelay — на головну"
          >
            <XelayLogo className="h-12 w-[120px]" />
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-muted transition-colors xelay-btn"
              aria-label="Закрити меню"
            >
              <X size={20} className="text-foreground" />
            </button>
          </div>
        </div>

        {/* Main nav items */}
        <nav className="py-4 px-6 flex flex-col gap-1">
          {mainMenuItems.map((item) => (
            <button
              key={item.path}
              onClick={() => handleNav(item.path)}
              className="flex items-center gap-5 px-4 py-3.5 rounded-lg text-left
                         text-foreground hover:bg-muted transition-colors group w-full xelay-btn"
            >
              <item.icon
                size={20}
                className="text-muted-foreground group-hover:text-foreground transition-colors"
              />
              <span className="text-base font-medium">{item.label}</span>
            </button>
          ))}
          {isAuthenticated && <button type="button" onClick={() => { onClose(); openPlatformGuide() }} className="flex min-h-11 items-center gap-5 rounded-lg px-4 py-3.5 text-left text-foreground hover:bg-muted">
            <CircleHelp size={20} className="text-muted-foreground" /><span className="text-base font-medium">Як користуватися Xelay</span>
          </button>}
        </nav>

        {/* Categories section */}
        <div className="px-6 pb-4">
          <div className="flex items-center justify-between px-4 mb-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Теми спільноти
            </p>
            <button
              onClick={() => handleNav('/categories')}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('all')} →
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {CATEGORIES.map((cat) => {
              return (
                <button
                  key={cat}
                  onClick={() => handleCategoryNav(cat)}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-left
                             text-foreground hover:bg-muted transition-colors group w-full xelay-btn"
                >
                  <CategoryIcon category={cat} className="h-6 w-6 text-base" />
                  <span className="min-w-0 text-sm font-medium flex-1 break-words leading-snug">{categoryLabel(cat)}</span>
                  <ChevronRight
                    size={14}
                    className="text-muted-foreground/0 group-hover:text-muted-foreground transition-colors flex-shrink-0"
                  />
                </button>
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-6 border-t border-border mt-auto">
          <p className="text-xs text-muted-foreground tracking-wide uppercase">
            {t('knowledgePlatform')}
          </p>
        </div>
      </aside>
    </>
  )
}
