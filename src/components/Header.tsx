import { useState, useEffect } from 'react'
import { Bell, MessageCircle, Search, Sparkles, User, UsersRound } from 'lucide-react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { BurgerMenu } from './BurgerMenu'
import { NotificationPanel } from './NotificationPanel'
import { ThemeToggle } from './ThemeToggle'
import { XelayLogo } from './XelayLogo'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { supabase } from '../lib/supabase'
import { useTranslation } from '../hooks/useTranslation'
import { useNotificationPreferences } from '../context/NotificationPreferencesContext'
import { guideKey, hasSeenGuide, rememberGuide } from '../lib/onboarding'

interface HeaderProps {
  onAuthRequest?: () => void
}

const headerIconButton = 'xelay-header-icon relative inline-flex h-11 w-9 shrink-0 flex-col items-center justify-center gap-1 rounded-xl px-0 py-1 hover:bg-muted transition-colors duration-150 xelay-btn sm:w-10'
const headerIconCaption = 'whitespace-nowrap text-[9px] font-medium leading-none text-muted-foreground sm:text-[10px]'

export function Header({ onAuthRequest }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [unreadCount, setUnreadCount] =
  useState(0)
  const [unreadMessageCount, setUnreadMessageCount] = useState(0)
  const { t } = useTranslation()
  const { isAuthenticated, authUser, xelayUser } = useAuth()
  const { isPremium } = useBilling()
  const { preferences, loading: preferencesLoading } = useNotificationPreferences()
  const notificationsEnabled = preferences.notificationsEnabled && !preferencesLoading
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  

  const navigate = useNavigate()

  useEffect(() => {
    if (isAuthenticated && new URLSearchParams(searchStr).get('notifications') === 'settings') {
      setNotifOpen(true)
      void navigate({ to: '/', replace: true })
    }
  }, [isAuthenticated, searchStr, navigate])

  useEffect(() => {
    setShowHint(false)
    if (!authUser?.id || !xelayUser?.has_seen_onboarding) return
    if (!hasSeenGuide(guideKey(authUser.id, 'navigation'))) {
      const timer = setTimeout(() => setShowHint(true), 1200)
      return () => clearTimeout(timer)
    }
  }, [authUser?.id, xelayUser?.has_seen_onboarding])

useEffect(() => {
  setUnreadCount(0)
  if (!authUser?.id) { setNotifOpen(false); return }
  if (!notificationsEnabled) return
  let active = true
  let busy = false

  const fetchUnread = async () => {
    if (busy || document.visibilityState !== 'visible') return
    busy = true
    try {
    const { count, error } = await supabase
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

    if (active && !error) setUnreadCount(count || 0)
    } finally { busy = false }
  }

  fetchUnread()

  const onFocus = () => { void fetchUnread() }
  window.addEventListener('focus', onFocus)
  const interval = setInterval(fetchUnread, 5000)

  return () => {
    active = false
    window.removeEventListener('focus', onFocus)
    clearInterval(interval)
  }
}, [authUser?.id, notificationsEnabled])

  useEffect(() => {
    setUnreadMessageCount(0)
    if (!authUser?.id) {
      return
    }
    let active = true
    let busy = false
    let communityUnread = 0
    let communityAvailable = true
    let refreshTimer: number | undefined
    let refreshPending = false
    let realtimeReady = false

    const fetchUnreadMessages = async () => {
      if (!active || document.visibilityState !== 'visible') return
      if (busy) { refreshPending = true; return }
      busy = true
      try {
      const [personal, community] = await Promise.all([
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('recipient_id', authUser.id).is('read_at', null),
        communityAvailable ? supabase.rpc('xelay_chat_unread_count') : Promise.resolve(null),
      ])
      if (community && !community.error) communityUnread = Number(community.data) || 0
      if (community?.error && ['PGRST202', '42883'].includes(community.error.code)) communityAvailable = false
      if (active && !personal.error) setUnreadMessageCount((personal.count || 0) + communityUnread)
      } catch (error) {
        if (active) console.error('Could not refresh unread messages:', error)
      } finally {
        busy = false
        if (active && refreshPending) {
          refreshPending = false
          window.clearTimeout(refreshTimer)
          refreshTimer = window.setTimeout(() => void fetchUnreadMessages(), 250)
        }
      }
    }

    void fetchUnreadMessages()
    const onFocus = () => { void fetchUnreadMessages() }
    const scheduleRefresh = () => {
      if (!active) return
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void fetchUnreadMessages(), 250)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('xelay-chat-updated', scheduleRefresh)
    const channel = supabase.channel(`header-direct-${authUser.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `recipient_id=eq.${authUser.id}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_posts' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_spaces' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members', filter: `user_id=eq.${authUser.id}` }, scheduleRefresh)
      .subscribe((status) => {
        if (!active) return
        realtimeReady = status === 'SUBSCRIBED'
        if (realtimeReady) scheduleRefresh()
      })
    // A slow reconciliation also covers an older database without every table
    // in Realtime; normal updates arrive through the scoped subscriptions.
    let lastReconciliation = Date.now()
    const interval = window.setInterval(() => {
      if (realtimeReady && Date.now() - lastReconciliation < 60_000) return
      lastReconciliation = Date.now()
      void fetchUnreadMessages()
    }, 30_000)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('xelay-chat-updated', scheduleRefresh)
      window.clearTimeout(refreshTimer)
      window.clearInterval(interval)
      void supabase.removeChannel(channel)
    }
  }, [authUser?.id])
  
  const handleMenuOpen = () => {
    setMenuOpen(true)
    setShowHint(false)
    if (authUser?.id) rememberGuide(guideKey(authUser.id, 'navigation'))
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
      <header className="xelay-app-header sticky top-0 z-30 w-full border-b backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full min-w-0 max-w-6xl items-center justify-between px-2 sm:px-6">
          <div className="relative min-w-0">
            <button
              onClick={handleMenuOpen}
              className="group flex items-center gap-2 sm:gap-3 xelay-btn"
              aria-label="Відкрити меню навігації"
            >
              <div className="flex flex-col gap-[5px] justify-center">
                <span className="block w-6 h-[2px] bg-current text-primary rounded-full transition-transform duration-200 group-hover:scale-x-90" />
                <span className="block w-4 h-[2px] bg-current text-primary rounded-full transition-all duration-200 group-hover:w-6" />
                <span className="block w-6 h-[2px] bg-current text-primary rounded-full transition-transform duration-200 group-hover:scale-x-90" />
              </div>

              <XelayLogo className="h-10 w-[100px] transition-opacity duration-200 group-hover:opacity-70 max-[359px]:h-[31px] max-[359px]:w-[76px] sm:h-12 sm:w-[120px]" />
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

          <div className="xelay-header-actions flex shrink-0 items-center gap-0 sm:gap-1">
            <div className="hidden md:block"><ThemeToggle showCaption /></div>
            <button
              onClick={() => navigate({ to: '/subscription' })}
              className="inline-flex h-9 w-9 sm:w-auto shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary text-primary-foreground sm:px-3 text-xs font-semibold shadow-sm hover:bg-primary/90"
              aria-label={isPremium ? 'Моя підписка Учасник' : 'Підписка Учасник — 100 гривень на місяць'}
              title={isPremium ? 'Моя підписка' : 'Підписка Учасник · 100 грн/місяць'}
            >
              <Sparkles size={17} aria-hidden="true" />
              <span className="hidden md:inline">{isPremium ? 'Учасник' : 'Підписка'}</span>
            </button>
            {(xelayUser?.isClassRepresentative || (xelayUser?.studyGroupIds?.length || 0) > 0) && (
              <button
                onClick={() => navigate({ to: '/groups' })}
                className={headerIconButton}
                aria-label={xelayUser?.isClassRepresentative ? 'Мої групи та створення групи' : 'Мої навчальні групи'}
                title={xelayUser?.isClassRepresentative ? 'Мої групи та створення групи' : 'Мої навчальні групи'}
              >
                <UsersRound size={20} className="text-primary" aria-hidden="true" />
                <span aria-hidden="true" className={headerIconCaption}>Групи</span>
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
              className={headerIconButton}
              aria-label={unreadMessageCount ? `Повідомлення, непрочитаних: ${unreadMessageCount}` : 'Повідомлення'}
              title="Повідомлення"
            >
              <span className="relative inline-flex h-5 w-5 shrink-0">
              <MessageCircle size={20} className="text-primary" aria-hidden="true" />
              {unreadMessageCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center">
                  {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                </span>
              )}
              </span>
              <span aria-hidden="true" className={headerIconCaption}>Чати</span>
            </button>

            <button
              onClick={() => navigate({ to: '/search' })}
              className={headerIconButton}
              aria-label="Пошук людей, груп і каналів"
              title="Знайти людей, групи або канали"
            >
              <Search size={20} className="text-primary" aria-hidden="true" />
              <span aria-hidden="true" className={headerIconCaption}>Пошук</span>
            </button>

            <div className="relative">
              <button
  onClick={handleNotifClick}
  className={headerIconButton}
  aria-label="Сповіщення"
>
  <span className="relative inline-flex h-5 w-5 shrink-0">
  <Bell
    size={20}
    className="text-primary"
    aria-hidden="true"
  />

  {notificationsEnabled && unreadCount > 0 && (
    <div
      className="
        absolute
        -top-1
        -right-1
        w-3
        h-3
        bg-red-500
        rounded-full
      "
    />
  )}
  </span>
  <span aria-hidden="true" className={headerIconCaption}>Сповіщ.</span>
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
              className="flex items-center gap-2 p-1 sm:px-2 sm:py-1.5 rounded-full hover:bg-muted transition-colors duration-150 xelay-btn"
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
