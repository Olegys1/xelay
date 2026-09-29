import { useState, useEffect } from 'react'
import { Bell, MessageCircle, Plus, Search, User, UsersRound } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { BurgerMenu } from './BurgerMenu'
import { NotificationPanel } from './NotificationPanel'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { useTranslation } from '../hooks/useTranslation'

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
  const [unreadMessageCount, setUnreadMessageCount] = useState(0)
  const { t } = useTranslation()
  const { isAuthenticated, authUser, xelayUser } = useAuth()
  

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

  useEffect(() => {
    if (!authUser?.id) {
      setUnreadMessageCount(0)
      return
    }

    const fetchUnreadMessages = async () => {
      const { count, error } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', authUser.id)
        .is('read_at', null)

      if (!error) setUnreadMessageCount(count || 0)
    }

    void fetchUnreadMessages()
    const interval = window.setInterval(() => void fetchUnreadMessages(), 5000)
    return () => window.clearInterval(interval)
  }, [authUser?.id])
  
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
      <header className="sticky top-0 z-30 w-full border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full min-w-0 max-w-6xl items-center justify-between px-3 sm:px-6">
          <div className="relative min-w-0">
            <button
              onClick={handleMenuOpen}
              className="group flex items-center gap-3 xelay-btn"
              aria-label="Відкрити меню навігації"
            >
              <div className="flex flex-col gap-[5px] justify-center">
                <span className="block w-6 h-[2px] bg-primary rounded-full transition-transform duration-200 group-hover:scale-x-90" />
                <span className="block w-4 h-[2px] bg-primary rounded-full transition-all duration-200 group-hover:w-6" />
                <span className="block w-6 h-[2px] bg-primary rounded-full transition-transform duration-200 group-hover:scale-x-90" />
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
                  Натисніть тут
                </span>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            {(xelayUser?.isClassRepresentative || (xelayUser?.studyGroupIds?.length || 0) > 0) && (
              <button
                onClick={() => navigate({ to: '/groups' })}
                className="relative p-2.5 rounded-full hover:bg-accent transition-colors duration-150 xelay-btn"
                aria-label={xelayUser?.isClassRepresentative ? 'Мої групи та створення групи' : 'Мої навчальні групи'}
                title={xelayUser?.isClassRepresentative ? 'Мої групи та створення групи' : 'Мої навчальні групи'}
              >
                {xelayUser?.isClassRepresentative
                  ? <Plus size={20} className="text-primary" />
                  : <UsersRound size={20} className="text-primary" />}
              </button>
            )}
            <button
              onClick={() => {
                if (!isAuthenticated) {
                  onAuthRequest?.()
                  return
                }
                navigate({ to: '/messages' })
              }}
              className="relative p-2.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
              aria-label={unreadMessageCount ? `Повідомлення, непрочитаних: ${unreadMessageCount}` : 'Повідомлення'}
              title="Повідомлення"
            >
              <MessageCircle size={20} className="text-primary" />
              {unreadMessageCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center">
                  {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                </span>
              )}
            </button>

            <button
              onClick={() => navigate({ to: '/search' })}
              className="relative p-2.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
              aria-label="Пошук людей"
              title="Знайти людей"
            >
              <Search size={20} className="text-primary" />
            </button>

            <div className="relative">
              <button
  onClick={handleNotifClick}
  className="relative p-2.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
  aria-label="Сповіщення"
>
  <Bell
    size={20}
    className="text-primary"
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
              aria-label="Профіль"
            >
              {isAuthenticated && xelayUser?.avatarUrl ? (
                <img
                  src={xelayUser.avatarUrl}
                  alt={xelayUser.name}
                  className="w-7 h-7 rounded-full object-cover ring-2 ring-border"
                />
              ) : isAuthenticated ? (
                <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
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
