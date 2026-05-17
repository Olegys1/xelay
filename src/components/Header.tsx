import { useState, useEffect } from 'react'
import { Bell, User } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { BurgerMenu } from './BurgerMenu'
import { NotificationPanel } from './NotificationPanel'
import { useAuth } from '../context/AuthContext'
import { blink } from '../blink/client'

interface HeaderProps {
  onAuthRequest?: () => void
}

const ONBOARDING_KEY = 'xelay_menu_opened'

export function Header({ onAuthRequest }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const { isAuthenticated, blinkUser, xelayUser } = useAuth()
  const navigate = useNavigate()

  // Show hint only for first-time visitors, after a short delay
  useEffect(() => {
    const hasOpened = localStorage.getItem(ONBOARDING_KEY)
    if (!hasOpened) {
      const timer = setTimeout(() => setShowHint(true), 1200)
      return () => clearTimeout(timer)
    }
  }, [])

  const handleMenuOpen = () => {
    setMenuOpen(true)
    setShowHint(false)
    localStorage.setItem(ONBOARDING_KEY, '1')
  }

  const handleProfileClick = () => {
    if (!isAuthenticated) {
      onAuthRequest?.()
    } else {
      navigate({ to: '/profile' })
    }
  }

  const handleNotifClick = () => {
    if (!isAuthenticated) {
      onAuthRequest?.()
      return
    }
    setNotifOpen((v) => !v)
  }

  // Avatar initials
  const initials = xelayUser?.name
    ? xelayUser.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : blinkUser?.email?.charAt(0).toUpperCase() || '?'

  return (
    <>
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-16">
          {/* Logo / Burger trigger + onboarding hint */}
          <div className="relative">
            <button
              onClick={handleMenuOpen}
              className="group flex items-center gap-3 xelay-btn"
              aria-label="Open navigation menu"
            >
              <div className="flex flex-col gap-[5px] justify-center">
                <span className="block w-6 h-[2px] bg-foreground rounded-full transition-transform duration-200 group-hover:scale-x-90" />
                <span className="block w-4 h-[2px] bg-foreground rounded-full transition-all duration-200 group-hover:w-6" />
                <span className="block w-6 h-[2px] bg-foreground rounded-full transition-transform duration-200 group-hover:scale-x-90" />
              </div>
              <span className="text-2xl font-bold tracking-tight text-foreground select-none transition-opacity duration-200 group-hover:opacity-70">
                Xelay
              </span>
            </button>

            {/* Onboarding hint */}
            {showHint && (
              <div
                className="absolute left-0 top-full mt-3 flex items-center gap-1.5 pointer-events-none animate-fade-in"
                aria-hidden="true"
              >
                {/* Arrow pointing up-left toward the burger button */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="text-foreground flex-shrink-0 -mt-0.5"
                >
                  <path
                    d="M8 14 L8 2 M8 2 L3 7 M8 2 L13 7"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-xs font-medium text-foreground whitespace-nowrap tracking-wide">
                  Tap here
                </span>
              </div>
            )}
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-1">
            {/* Notifications */}
            <div className="relative">
              <button
                onClick={handleNotifClick}
                className="relative p-2.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
                aria-label="Notifications"
              >
                <Bell size={20} className="text-foreground" />
                {isAuthenticated && blinkUser && (
                  <NotificationDot userId={blinkUser.id} />
                )}
              </button>
              {notifOpen && isAuthenticated && blinkUser && (
                <NotificationPanel
                  userId={blinkUser.id}
                  onClose={() => setNotifOpen(false)}
                />
              )}
            </div>

            {/* Profile / Avatar */}
            <button
              onClick={handleProfileClick}
              className="flex items-center gap-2 px-2 py-1.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
              aria-label="Profile"
            >
              {isAuthenticated && xelayUser?.avatarUrl ? (
                <img
                  src={xelayUser.avatarUrl}
                  alt={xelayUser.name}
                  className="w-7 h-7 rounded-full object-cover ring-2 ring-border"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              ) : isAuthenticated ? (
                <div className="w-7 h-7 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-bold">
                  {initials}
                </div>
              ) : (
                <User size={20} className="text-foreground" />
              )}
              <span className="hidden sm:block text-sm font-medium text-foreground">
                {isAuthenticated ? (xelayUser?.name?.split(' ')[0] || 'Profile') : 'Sign In'}
              </span>
            </button>
          </div>
        </div>
      </header>

      <BurgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  )
}

function NotificationDot({ userId }: { userId: string }) {
  const [hasUnread, setHasUnread] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const notifs = await blink.db.xelayNotifications.list({
          where: { recipientId: userId, isRead: '0' },
          limit: 1,
        })
        if (!cancelled) setHasUnread(notifs && notifs.length > 0)
      } catch {
        // silent
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [userId])

  if (!hasUnread) return null
  return (
    <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-foreground ring-2 ring-background" />
  )
}
