import { useState, useEffect } from 'react'
import { Bell, User } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { BurgerMenu } from './BurgerMenu'
import { NotificationPanel } from './NotificationPanel'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../context/LanguageContext'
import { LANGUAGES } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'

import { Globe } from 'lucide-react'

interface HeaderProps {
  onAuthRequest?: () => void
}

const ONBOARDING_KEY = 'xelay_menu_opened'

export function Header({ onAuthRequest }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [unreadCount, setUnreadCount] =
  useState(0)
const { language, setLanguage } =
  useLanguage()
  const { t } = useTranslation()
  const [showLanguages, setShowLanguages] =
  useState(false)
  const { isAuthenticated, authUser, xelayUser } = useAuth()
  console.log('HEADER USER:', xelayUser)
  

  const navigate = useNavigate()

  useEffect(() => {
    const hasOpened = localStorage.getItem(ONBOARDING_KEY)

    if (!hasOpened) {
      const timer = setTimeout(() => setShowHint(true), 1200)
      return () => clearTimeout(timer)
    }
  }, [])

useEffect(() => {
  if (!authUser) return

  const fetchUnread = async () => {
    const { count } = await supabase
      .from('notifications')
      .select('*', {
        count: 'exact',
        head: true,
      })
      .eq(
        'recipient_id',
        authUser.id
      )
      .eq(
        'is_read',
        false
      )

    setUnreadCount(count || 0)
  }

  fetchUnread()

  const interval = setInterval(
    fetchUnread,
    3000
  )

  return () =>
    clearInterval(interval)
}, [authUser])
  
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

  const initials = xelayUser?.name
    ? xelayUser.name
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : authUser?.email?.charAt(0).toUpperCase() || '?'

  return (
    <>
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-16">
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

            {showHint && (
              <div
                className="absolute left-0 top-full mt-3 flex items-center gap-1.5 pointer-events-none animate-fade-in"
                aria-hidden="true"
              >
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

          <div className="flex items-center gap-1">
            <div className="relative">

  <button
    onClick={() =>
      setShowLanguages(
        !showLanguages
      )
    }
    className="
      p-2.5
      rounded-full
      hover:bg-muted
      transition-colors
      duration-150
      xelay-btn
    "
  >
    <Globe
      size={20}
      className="text-foreground"
    />
  </button>

  {showLanguages && (
    <div
      className="
        absolute
        top-12
        right-0
        w-52
        bg-background
        border
        border-border
        rounded-xl
        shadow-xl
        overflow-hidden
        z-50
      "
    >
      {LANGUAGES.map(
        (lang) => (
          <button
            key={lang.code}
            onClick={() => {
              setLanguage(
                lang.code
              )

              setShowLanguages(
                false
              )
            }}
            className={`
              w-full
              text-left
              px-4
              py-3
              text-sm
              hover:bg-muted
              transition-colors
              ${
                language ===
                lang.code
                  ? 'bg-muted font-semibold'
                  : ''
              }
            `}
          >
            {lang.flag}{' '}
            {lang.label}
          </button>
        )
      )}
    </div>
  )}

</div>
            <div className="relative">
              <button
  onClick={handleNotifClick}
  className="relative p-2.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
  aria-label="Notifications"
>
  <Bell
    size={20}
    className="text-foreground"
  />

  {unreadCount > 0 && (
    <div
      className="
        absolute
        top-1
        right-1
        w-3
        h-3
        bg-red-500
        rounded-full
      "
    />
  )}
</button>

              {notifOpen && isAuthenticated && authUser && (
                <NotificationPanel
                  userId={authUser.id}
                  onClose={() => setNotifOpen(false)}
                />
              )}
            </div>

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
                />
              ) : isAuthenticated ? (
                <div className="w-7 h-7 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-bold">
                  {initials}
                </div>
              ) : (
                <User size={20} className="text-foreground" />
              )}

             <span className="hidden sm:block text-sm font-medium text-foreground">
  {isAuthenticated
    ? xelayUser?.name?.split(' ')[0] || t('profile')
    : t('signIn')}
</span>
            </button>
          </div>
        </div>
      </header>

      <BurgerMenu
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}