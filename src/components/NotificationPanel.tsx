import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Bell, BellOff, Loader2, Mail, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'

import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotificationPreferences, type NotificationPreferences } from '../context/NotificationPreferencesContext'
import { useToast } from '../context/ToastContext'
import { useBilling } from '../context/BillingContext'
import { openBirthdayGift } from '../lib/birthdayGifts'
import { openAppreciationGift } from '../lib/appreciationGifts'
import { groupTodayInKyiv } from '../lib/groupYearNavigation'

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
  direct_conversation_id?: string | null
  teaching_course_id?: string | null
  teaching_event_key?: string | null
  academic_tab?: string | null
  shared_organizer_workspace_id?: string | null
  shared_organizer_invitation_id?: string | null
  type?: string
}

type EmailRuntimeState = 'checking' | 'ready' | 'limited' | 'not_configured' | 'unavailable'
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HISTORY_PAGE_SIZE = 100
const filterValue = (value: string) => JSON.stringify(value)

export function NotificationPanel({ userId, onClose }: NotificationPanelProps) {
  const navigate = useNavigate()
  const { notify } = useToast()
  const { refreshBilling } = useBilling()
  const { authUser, refreshUser } = useAuth()
  const owner = useRef(authUser?.id); owner.current = authUser?.id
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [readError, setReadError] = useState(false)
  const historyCursor = useRef<{ createdAt: string; id: string } | null>(null)
  const historyVersion = useRef(0)
  const historyRequest = useRef<AbortController | null>(null)
  const [emailRuntime, setEmailRuntime] = useState<{ userId: string; state: EmailRuntimeState }>({ userId, state: 'checking' })
  const emailState = emailRuntime.userId === userId && owner.current === userId ? emailRuntime.state : 'checking'

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
    let request: AbortController | null = null
    setEmailRuntime({ userId, state: 'checking' })
    const current = () => active && owner.current === userId
    const refresh = async () => {
      if (!current() || request || document.visibilityState !== 'visible') return
      const controller = new AbortController()
      request = controller
      const timeout = window.setTimeout(() => controller.abort(), 10000)
      try {
        const response = await fetch('/api/notifications/email', {
          method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error('status_unavailable')
        const status: unknown = await response.json()
        if (!current()) return
        if (!status || typeof status !== 'object' || !('state' in status) || !('available' in status)
          || typeof status.available !== 'boolean'
          || !['ready', 'limited', 'not_configured', 'unavailable'].includes(String(status.state))
          || status.available !== (status.state === 'ready')) throw new Error('invalid_status')
        setEmailRuntime({ userId, state: status.state as EmailRuntimeState })
      } catch {
        if (current()) setEmailRuntime({ userId, state: 'unavailable' })
      } finally {
        window.clearTimeout(timeout)
        if (request === controller) request = null
      }
    }
    const onFocus = () => { void refresh() }
    void refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const interval = window.setInterval(onFocus, 30000)
    return () => {
      active = false
      request?.abort()
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [userId, authUser?.id])

  const fetchNotifications = useCallback(async (append: boolean) => {
    if (owner.current !== userId || historyRequest.current || (append && !historyCursor.current)) return
    const version = historyVersion.current
    const controller = new AbortController()
    historyRequest.current = controller
    const current = () => historyVersion.current === version && owner.current === userId && !controller.signal.aborted
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    let pageLoaded = false
    if (append) setLoadingMore(true)
    else setLoading(true)
    setHistoryError(false)
    setReadError(false)
    try {
      let query = supabase.from('notifications').select('*').eq('recipient_id', userId)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(HISTORY_PAGE_SIZE).abortSignal(controller.signal)
      const cursor = append ? historyCursor.current : null
      if (cursor) {
        query = query.or(`created_at.lt.${filterValue(cursor.createdAt)},and(created_at.eq.${filterValue(cursor.createdAt)},id.lt.${filterValue(cursor.id)})`)
      }
      const { data, error } = await query
      if (!current()) return
      if (error) {
        setHistoryError(true)
        return
      }
      const page = (data || []) as NotificationItem[]
      const last = page[page.length - 1]
      if (last) historyCursor.current = { createdAt: last.created_at, id: last.id }
      setHasMore(page.length === HISTORY_PAGE_SIZE)
      setNotifications((previous) => {
        if (!append) return page
        const known = new Set(previous.map((item) => item.id))
        return [...previous, ...page.filter((item) => !known.has(item.id))]
      })
      pageLoaded = true
      setLoading(false)
      const unreadIds = page.filter((item) => !item.is_read).map((item) => item.id)
      if (!unreadIds.length) return
      try {
        // Only acknowledge this loaded page; unseen history and incoming events
        // keep their unread status until the user opens them.
        const { error: markError } = await supabase
          .from('notifications')
          .update({ is_read: true })
          .eq('recipient_id', userId)
          .eq('is_read', false)
          .in('id', unreadIds)
          .abortSignal(controller.signal)
        if (current() && markError) setReadError(true)
        if (current() && !markError) {
          window.dispatchEvent(new CustomEvent('xelay-notifications-updated', { detail: { userId } }))
        }
      } catch {
        if (current()) setReadError(true)
      }
    } catch {
      if (historyVersion.current === version && owner.current === userId) {
        if (pageLoaded) setReadError(true)
        else setHistoryError(true)
      }
    } finally {
      window.clearTimeout(timeout)
      if (historyRequest.current === controller) historyRequest.current = null
      if (historyVersion.current === version && owner.current === userId) {
        setLoading(false)
        setLoadingMore(false)
        if (controller.signal.aborted) {
          if (pageLoaded) setReadError(true)
          else setHistoryError(true)
        }
      }
    }
  }, [userId])

  useEffect(() => {
    historyVersion.current += 1
    historyCursor.current = null
    setNotifications([])
    setHasMore(false)
    setLoadingMore(false)
    setLoading(true)
    void fetchNotifications(false)
    return () => {
      historyVersion.current += 1
      historyRequest.current?.abort()
      historyRequest.current = null
    }
  }, [fetchNotifications])

  const openNotification = (notification: NotificationItem) => {
    if (notification.type === 'group_birthday' && notification.study_group_id && CONVERSATION_ID.test(notification.study_group_id)) {
      navigate({ to: '/groups/$id', params: { id: notification.study_group_id }, search: { date: groupTodayInKyiv() }, hash: 'group-birthdays-area' })
    } else if (notification.type === 'birthday_gift') {
      openBirthdayGift(userId, notification.id)
    } else if (notification.type === 'appreciation_gift') {
      openAppreciationGift(userId, notification.id)
    } else if (notification.type === 'halloween_reward') {
      void refreshBilling()
      navigate({ to: '/halloween' })
    } else if (notification.type === 'shared_organizer_invite' || notification.type === 'shared_organizer_update') {
      const workspace = notification.shared_organizer_workspace_id
      navigate({ to: '/organizer', search: { view: 'shared', workspace: workspace && CONVERSATION_ID.test(workspace) ? workspace : undefined } })
    } else if (notification.type === 'study_group_update' && notification.study_group_id && CONVERSATION_ID.test(notification.study_group_id)) {
      const tab = notification.academic_tab === 'schedule' || notification.academic_tab === 'seminars'
        || notification.academic_tab === 'timetable' || notification.academic_tab === 'materials'
        ? notification.academic_tab : undefined
      navigate({ to: '/groups/$id', params: { id: notification.study_group_id }, search: { tab } })
    } else if (notification.type === 'teaching_update') {
      void refreshUser()
      if (notification.teaching_event_key?.startsWith('teacher-request:')) navigate({ to: '/admin' })
      else if (notification.study_group_id && CONVERSATION_ID.test(notification.study_group_id)) navigate({ to: '/groups/$id', params: { id: notification.study_group_id } })
      else navigate({ to: '/teaching', search: { course: notification.teaching_course_id && CONVERSATION_ID.test(notification.teaching_course_id) ? notification.teaching_course_id : undefined } })
    } else if (notification.type === 'organizer_reminder') {
      navigate({ to: '/organizer' })
    } else if (notification.chat_space_id) {
      navigate({ to: '/messages', search: { space: notification.chat_space_id } })
    } else if (notification.type === 'connection_request') {
      navigate({ to: '/profile' })
    } else if (notification.type === 'connection_accepted' || notification.type === 'message') {
      const conversation = notification.direct_conversation_id
      navigate({ to: '/messages', search: conversation && CONVERSATION_ID.test(conversation)
        ? { kind: 'personal', conversation } : { kind: 'personal' } })
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
    const actor = userId
    const saved = await updatePreferences(changes)
    if (owner.current !== actor) return
    const enablesEmail = changes.emailNotificationsEnabled === true
      || (changes.notificationsEnabled === true && preferences.emailNotificationsEnabled)
    const emailUnavailable = enablesEmail && emailState !== 'ready'
    notify(saved
      ? { id: 'notification-preferences', title: emailUnavailable ? 'Налаштування сповіщень збережено' : title,
        ...(emailUnavailable ? { description: emailState === 'not_configured'
          ? 'Листи надходитимуть після підключення пошти. Ваш вибір збережено.'
          : emailState === 'limited' ? 'Досягнуто ліміту поштового сервісу. Листи збережено в черзі та буде надіслано після відновлення доступного ліміту.'
          : emailState === 'checking' ? 'Ваш вибір збережено. Перевіряємо доступність пошти.'
            : 'Статус пошти зараз недоступний. Ваш вибір збережено.' } : {}), tone: 'success' }
      : { id: 'notification-preferences', title: 'Не вдалося зберегти налаштування', description: 'Перевірте з’єднання та спробуйте ще раз.', tone: 'error' })
  }

  const controlsDisabled = preferencesLoading || saving || Boolean(preferencesError)
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Сповіщення та налаштування"
      aria-busy={loading || loadingMore || preferencesLoading || saving}
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
            <span className="block">Дублювати на пошту</span>
            <span className={`mt-1 flex items-center gap-1.5 text-[11px] leading-tight ${emailState === 'ready' ? 'text-primary' : 'text-muted-foreground'}`} role="status" aria-live="polite">
              {emailState === 'checking' ? <Loader2 size={11} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${emailState === 'ready' ? 'bg-primary' : 'bg-muted-foreground/50'}`} aria-hidden="true" />}
              {emailState === 'ready' ? 'Пошта підключена'
                : emailState === 'limited' ? 'Досягнуто ліміту пошти'
                : emailState === 'not_configured' ? 'Пошта ще не підключена'
                  : emailState === 'unavailable' ? 'Статус пошти недоступний' : 'Перевіряємо підключення…'}
            </span>
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
              : !preferences.emailNotificationsEnabled ? 'Дублювання на пошту вимкнено. Сповіщення всередині Xelay залишаються доступними.'
                : emailState === 'not_configured' ? 'Ваш вибір збережено. Листи надходитимуть на підтверджену пошту після підключення сервісу.'
                  : emailState === 'limited' ? 'Досягнуто ліміту поштового сервісу. Листи збережено в черзі та буде надіслано після відновлення доступного ліміту.'
                  : emailState === 'ready' ? 'Кожне нове сповіщення дублюємо окремим листом на підтверджену пошту, навіть якщо ви вже прочитали його в Xelay.'
                    : emailState === 'checking' ? 'Перевіряємо підключення пошти. Ваші налаштування залишаються збереженими.'
                      : 'Ваш вибір збережено. Зараз не вдалося підтвердити доступність поштових сповіщень.'}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Листи про повідомлення, відповіді й коментарі, новини, ДЗ, семінари, матеріали, дії викладачів, запрошення та статуси заявок доступні всім без підписки. Приватний текст розмов, робіт і вкладення в листи не додаємо. Дублювання на пошту можна вимкнути тут.
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Нагадування органайзера також надходять на пошту. Push для цього пристрою вмикаються окремо в профілі з підпискою «Учасник». Підтвердження пошти й відновлення пароля працюють незалежно від цих налаштувань.
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
      ) : historyError && notifications.length === 0 ? (
        <div className="xelay-inline-feedback space-y-2 px-4 py-8 text-center text-sm text-muted-foreground" role="alert">
          <p>Не вдалося завантажити сповіщення.</p>
          <button type="button" onClick={() => void fetchNotifications(false)} className="font-semibold text-primary underline underline-offset-4">Спробувати ще раз</button>
        </div>
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
          {historyError && <p className="px-4 py-3 text-xs text-destructive" role="alert">Не вдалося завантажити наступні сповіщення. Спробуйте ще раз.</p>}
          {hasMore && <div className="px-4 py-3 text-center">
            <button type="button" disabled={loadingMore} onClick={() => void fetchNotifications(true)} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-primary/20 px-4 py-2 text-sm font-semibold text-primary hover:bg-accent disabled:opacity-50">
              {loadingMore && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {loadingMore ? 'Завантажуємо…' : 'Показати ще'}
            </button>
          </div>}
        </div>
      )}
    </div>
  )
}
