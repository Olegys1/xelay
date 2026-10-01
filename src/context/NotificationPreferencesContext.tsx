import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

export interface NotificationPreferences {
  notificationsEnabled: boolean
  emailNotificationsEnabled: boolean
}

interface NotificationPreferencesState {
  preferences: NotificationPreferences
  loading: boolean
  saving: boolean
  error: string | null
  refreshPreferences: () => Promise<void>
  updatePreferences: (changes: Partial<NotificationPreferences>) => Promise<boolean>
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  notificationsEnabled: true,
  emailNotificationsEnabled: true,
}
const SYNC_KEY = 'xelay_notification_preferences_changed'
const NotificationPreferencesContext = createContext<NotificationPreferencesState | null>(null)

function preferenceError(error: { code?: string }): string {
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return 'Налаштування сповіщень ще не підключені. Потрібно застосувати міграцію бази даних.'
  }
  if (error.code === '42501' || error.code === 'PGRST301') {
    return 'Не вдалося зберегти налаштування. Оновіть сторінку та увійдіть знову.'
  }
  return 'Не вдалося оновити налаштування сповіщень. Перевірте з’єднання та спробуйте ще раз.'
}

export function NotificationPreferencesProvider({ children }: { children: ReactNode }) {
  const { authUser, isLoading: authLoading } = useAuth()
  const userId = authUser?.id || null
  const currentUserId = useRef(userId)
  currentUserId.current = userId
  const requestVersion = useRef(0)
  const savingUser = useRef<string | null>(null)
  const mounted = useRef(false)

  const [state, setState] = useState<{
    userId: string | null
    preferences: NotificationPreferences
    loading: boolean
    error: string | null
  }>({ userId: null, preferences: DEFAULT_PREFERENCES, loading: true, error: null })
  const [savingUserId, setSavingUserId] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestVersion.current += 1
    }
  }, [])

  const refreshPreferences = useCallback(async () => {
    if (userId && savingUser.current === userId) return
    const version = ++requestVersion.current
    if (!userId) {
      setState({ userId: null, preferences: DEFAULT_PREFERENCES, loading: false, error: null })
      return
    }
    setState((previous) => ({
      userId,
      preferences: previous.userId === userId ? previous.preferences : DEFAULT_PREFERENCES,
      loading: true,
      error: null,
    }))

    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('notifications_enabled, email_notifications_enabled')
        .eq('user_id', userId)
        .maybeSingle()

      if (!mounted.current || currentUserId.current !== userId || requestVersion.current !== version) return
      if (error) {
        setState((previous) => ({ ...previous, loading: false, error: preferenceError(error) }))
        return
      }

      setState({
        userId,
        preferences: data ? {
          notificationsEnabled: data.notifications_enabled,
          emailNotificationsEnabled: data.email_notifications_enabled,
        } : DEFAULT_PREFERENCES,
        loading: false,
        error: null,
      })
    } catch {
      if (mounted.current && currentUserId.current === userId && requestVersion.current === version) {
        setState((previous) => ({ ...previous, loading: false, error: preferenceError({}) }))
      }
    }
  }, [userId])

  useEffect(() => {
    void refreshPreferences()
    const onFocus = () => { void refreshPreferences() }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SYNC_KEY || !event.newValue) return
      try {
        if (JSON.parse(event.newValue).userId === userId) void refreshPreferences()
      } catch { /* Ignore unrelated or malformed cross-tab signals. */ }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    return () => {
      requestVersion.current += 1
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('storage', onStorage)
    }
  }, [refreshPreferences, userId])

  const updatePreferences = useCallback(async (changes: Partial<NotificationPreferences>) => {
    if (!userId || state.userId !== userId || state.loading || state.error || savingUser.current === userId) return false
    const version = ++requestVersion.current
    const next = { ...state.preferences, ...changes }
    savingUser.current = userId
    setSavingUserId(userId)

    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .upsert({
          user_id: userId,
          notifications_enabled: next.notificationsEnabled,
          email_notifications_enabled: next.emailNotificationsEnabled,
        }, { onConflict: 'user_id' })
        .select('notifications_enabled, email_notifications_enabled')
        .single()

      if (!mounted.current || currentUserId.current !== userId || requestVersion.current !== version) return false
      if (error) {
        setState((previous) => ({ ...previous, error: preferenceError(error) }))
        return false
      }

      setState({
        userId,
        preferences: {
          notificationsEnabled: data.notifications_enabled,
          emailNotificationsEnabled: data.email_notifications_enabled,
        },
        loading: false,
        error: null,
      })
      try {
        localStorage.setItem(SYNC_KEY, JSON.stringify({ userId, changedAt: Date.now() }))
      } catch { /* Database persistence still succeeds when local storage is unavailable. */ }
      return true
    } catch {
      if (mounted.current && currentUserId.current === userId && requestVersion.current === version) {
        setState((previous) => ({ ...previous, error: preferenceError({}) }))
      }
      return false
    } finally {
      if (savingUser.current === userId) savingUser.current = null
      if (mounted.current) setSavingUserId((previous) => previous === userId ? null : previous)
    }
  }, [userId, state])

  const scoped = state.userId === userId
  return (
    <NotificationPreferencesContext.Provider value={{
      preferences: scoped ? state.preferences : DEFAULT_PREFERENCES,
      loading: authLoading || (Boolean(userId) && (!scoped || state.loading)),
      saving: Boolean(userId && savingUserId === userId),
      error: scoped ? state.error : null,
      refreshPreferences,
      updatePreferences,
    }}>
      {children}
    </NotificationPreferencesContext.Provider>
  )
}

export function useNotificationPreferences() {
  const context = useContext(NotificationPreferencesContext)
  if (!context) throw new Error('NotificationPreferencesProvider is required')
  return context
}
