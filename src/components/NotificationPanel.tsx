import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Bell, BellOff, Loader2, Mail, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'

import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotificationPreferences, type NotificationPreferences } from '../context/NotificationPreferencesContext'
import { useToast } from '../context/ToastContext'

interface NotificationPanelProps {
  userId: string
  onClose: () => void
}

interface NotificationItem {
  id: string
  actor_name: string
  message: string
  created_at: string
  is_read: boolean
  question_id?: string
  answer_id?: string
  news_post_id?: string | null
  study_group_id?: string | null
  study_group_member_id?: string | null
  chat_space_id?: string | null
  organizer_task_id?: string | null
  type?: string
}

export function NotificationPanel({ userId, onClose }: NotificationPanelProps) {
  const navigate = useNavigate()
  const { notify } = useToast()
  const { refreshUser } = useAuth()
  const {
    preferences,
    loading: preferencesLoading,
    saving,
    error: preferencesError,
    updatePreferences,
    refreshPreferences,
  } = useNotificationPreferences()
  const panelRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const close = useRef(onClose); close.current = onClose
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [historyError, setHistoryError] = useState(false)
  const [readError, setReadError] = useState(false)

  const closeWithFocus = () => {
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true })
    close.current()
  }

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus({ preventScroll: true })
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      const panel = panelRef.current
      // Let the adjacent bell toggle the panel itself without reopening it on the following click.
      if (panel && !panel.contains(target) && !panel.parentElement?.contains(target)) close.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true })
        close.current()
      }
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', handler), 100)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    let active = true
    setNotifications([])
    setLoading(true)
    setHistoryError(false)
    setReadError(false)
    const fetchNotifications = async () => {
      try {
        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .eq('recipient_id', userId)
          .order('created_at', { ascending: false })

        if (!active) return
        if (error) {
          setHistoryError(true)
          return
        }
        setNotifications(data || [])
        setLoading(false)
        try {
          const { error: markError } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('recipient_id', userId)
            .eq('is_read', false)
          if (active && markError) setReadError(true)
        } catch {
          if (active) setReadError(true)
        }
      } catch {
        if (active) setHistoryError(true)
      } finally {
        if (active) setLoading(false)
      }
    }
    void fetchNotifications()
    return () => { active = false }
  }, [userId])

  const openNotification = (notification: NotificationItem) => {
    if (notification.type === 'organizer_reminder') {
      navigate({ to: '/organizer' })
    } else if (notification.chat_space_id) {
      navigate({ to: '/messages', search: { space: notification.chat_space_id } })
    } else if (notification.type === 'connection_request') {
      navigate({ to: '/profile' })
    } else if (notification.type === 'connection_accepted' || notification.type === 'message') {
      navigate({ to: '/messages' })
    } else if (notification.news_post_id) {
      navigate({ to: '/news/$id', params: { id: notification.news_post_id } })
    } else if (notification.type === 'editor_request_approved' || notification.type === 'editor_request_rejected') {
      navigate({ to: '/news' })
    } else if (notification.type === 'class_rep_approved' || notification.type === 'class_rep_rejected') {
      if (notification.type === 'class_rep_approved') void refreshUser()
      navigate({ to: '/profile' })
    } else if (notification.type === 'group_invite') {
      navigate({ to: '/groups' })
    } else if (notification.study_group_id) {
      navigate({ to: '/groups/$id', params: { id: notification.study_group_id } })
    } else if (notification.type === 'news_submission_rejected') {
      navigate({ to: '/news' })
    } else if (notification.question_id) {
      navigate({ to: '/question/$id', params: { id: notification.question_id } })
    } else {
      return
    }
    onClose()
  }

  const changePreferences = async (changes: Partial<NotificationPreferences>, title: string) => {
    const saved = await updatePreferences(changes)
    notify(saved
      ? { id: 'notification-preferences', title, tone: 'success' }
      : { id: 'notification-preferences', title: 'Не вдалося зберегти налаштування', description: 'Перевірте з’єднання та спробуйте ще раз.', tone: 'error' })
  }

  const controlsDisabled = preferencesLoading || saving || Boolean(preferencesError)
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Сповіщення та налаштування"
      aria-busy={loading || preferencesLoading || saving}
      tabIndex={-1}
      className="xelay-popover fixed inset-x-3 top-[72px] z-50 max-h-[calc(100dvh-5.25rem)] overflow-y-auto rounded-2xl border border-border bg-card shadow-[var(--shadow-xl)] outline-none sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[22rem] sm:max-w-[calc(100vw-2rem)]"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bell size={17} className="text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Сповіщення</h2>
        <button
          type="button"
          onClick={closeWithFocus}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          aria-label="Закрити сповіщення"
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-3 border-b border-border bg-muted/30 px-4 py-4">
        <button
          type="button"
          disabled={controlsDisabled}
          aria-pressed={preferences.notificationsEnabled}
          onClick={() => void changePreferences({ notificationsEnabled: !preferences.notificationsEnabled }, preferences.notificationsEnabled ? 'Сповіщення вимкнено' : 'Сповіщення увімкнено')}
          className="flex min-h-[2.5rem] w-full items-center justify-center gap-2 rounded-full border border-primary/20 bg-card px-3 py-2 text-sm font-semibold text-primary hover:bg-accent disabled:cursor-wait disabled:opacity-50"
        >
          {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            : preferences.notificationsEnabled ? <BellOff size={16} aria-hidden="true" /> : <Bell size={16} aria-hidden="true" />}
          {preferences.notificationsEnabled ? 'Вимкнути сповіщення' : 'Увімкнути сповіщення'}
        </button>

        <div className="flex items-center gap-3">
          <Mail size={17} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="notification-email-toggle" className="min-w-0 flex-1 text-sm text-foreground">
            Дублювати на пошту
          </label>
          <button
            id="notification-email-toggle"
            type="button"
            role="switch"
            aria-checked={preferences.notificationsEnabled && preferences.emailNotificationsEnabled}
            aria-label="Дублювати сповіщення на пошту"
            disabled={controlsDisabled || !preferences.notificationsEnabled}
            onClick={() => void changePreferences({ emailNotificationsEnabled: !preferences.emailNotificationsEnabled }, preferences.emailNotificationsEnabled ? 'Сповіщення на пошту вимкнено' : 'Сповіщення на пошту увімкнено')}
            className={`relative h-6 w-11 shrink-0 rounded-full border border-border transition-colors disabled:opacity-40 ${
              preferences.notificationsEnabled && preferences.emailNotificationsEnabled ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span className={`absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${
              preferences.notificationsEnabled && preferences.emailNotificationsEnabled ? 'translate-x-5' : ''
            }`} />
          </button>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
          {preferencesLoading ? 'Завантажуємо ваші налаштування…'
            : !preferences.notificationsEnabled
              ? 'Сповіщення та листи вимкнені. Історія залишається доступною тут.'
              : 'Листи для підтримуваних подій надходять на підтверджену пошту. Нагадування органайзера з’являються лише всередині Xelay. Налаштування не впливають на листи для входу й відновлення пароля.'}
        </p>
        {preferencesError && (
          <div className="xelay-inline-feedback space-y-2" role="alert">
            <p className="text-xs leading-relaxed text-destructive">{preferencesError}</p>
            <button type="button" onClick={() => void refreshPreferences()} className="text-xs font-semibold text-primary underline underline-offset-4">
              Спробувати ще раз
            </button>
          </div>
        )}
      </div>

      {readError && (
        <p className="xelay-inline-feedback mx-4 mt-3 rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground" role="status">
          Не вдалося позначити сповіщення прочитаними. Відкрийте панель ще раз, щоб повторити спробу.
        </p>
      )}
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground" role="status">Завантаження…</div>
      ) : historyError ? (
        <p className="xelay-inline-feedback px-4 py-8 text-center text-sm text-muted-foreground" role="alert">
          Не вдалося завантажити сповіщення. Закрийте панель і спробуйте ще раз.
        </p>
      ) : notifications.length === 0 ? (
        <div className="py-10 text-center">
          <Bell size={28} className="mx-auto mb-2 text-muted-foreground opacity-40" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Сповіщень поки немає.</p>
        </div>
      ) : (
        <div className="max-h-[min(50dvh,24rem)] overflow-y-auto overscroll-contain">
          {notifications.map((notification) => (
            <button
              key={notification.id}
              type="button"
              onClick={() => openNotification(notification)}
              className={`block w-full border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted ${!notification.is_read ? 'bg-muted/40' : ''}`}
            >
              <p className="break-words text-sm text-foreground">
                <span className="font-semibold">{notification.actor_name}</span>{' '}
                {notification.type === 'answer' ? 'відповів(-ла) на ваше запитання' : notification.message}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true, locale: uk })}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
