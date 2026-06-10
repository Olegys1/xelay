import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  X,
  Home,
  LayoutGrid,
  HelpCircle,
  User,
  ChevronRight,
  Lightbulb,
} from 'lucide-react'
import { CATEGORIES, categoryToSlug } from '../types'
import { CATEGORY_META } from '../lib/categoryMeta'

interface BurgerMenuProps {
  isOpen: boolean
  onClose: () => void
}

const mainMenuItems = [
  {
    label: 'Home',
    icon: Home,
    path: '/',
  },

  {
    label: 'Categories',
    icon: LayoutGrid,
    path: '/categories',
  },

  {
    label: 'FAQ',
    icon: HelpCircle,
    path: '/faq',
  },

  {
    label: 'Profile',
    icon: User,
    path: '/profile',
  },

  {
    label: 'Suggest Feature',
    icon: Lightbulb,
    path: 'feature-request',
  },
]

export function BurgerMenu({ isOpen, onClose }: BurgerMenuProps) {
  const navigate = useNavigate()

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

const handleNav = (path: string) => {
  if (path === 'feature-request') {
    window.open(
      'https://t.me/xelay10',
      '_blank'
    )

    onClose()

    return
  }

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
        className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Menu Panel */}
      <aside
        className="fixed inset-y-0 left-0 z-50 w-80 bg-background border-r border-border flex flex-col animate-slide-in overflow-y-auto"
        role="dialog"
        aria-label="Navigation menu"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-border sticky top-0 bg-background z-10">
          <span
            className="text-2xl font-bold tracking-tight text-foreground cursor-pointer"
            onClick={() => handleNav('/')}
          >
            Xelay
          </span>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-muted transition-colors xelay-btn"
            aria-label="Close menu"
          >
            <X size={20} className="text-foreground" />
          </button>
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
        </nav>

        {/* Categories section */}
        <div className="px-6 pb-4">
          <div className="flex items-center justify-between px-4 mb-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Categories
            </p>
            <button
              onClick={() => handleNav('/categories')}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              All →
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {CATEGORIES.map((cat) => {
              const meta = CATEGORY_META[cat]
              return (
                <button
                  key={cat}
                  onClick={() => handleCategoryNav(cat)}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-left
                             text-foreground hover:bg-muted transition-colors group w-full xelay-btn"
                >
                  {meta?.icon ? (
                    <span className="text-base w-5 text-center flex-shrink-0">{meta.icon}</span>
                  ) : (
                    <span className="w-5 flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium flex-1 truncate">{cat}</span>
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
            Knowledge Exchange Platform
          </p>
        </div>
      </aside>
    </>
  )
}
