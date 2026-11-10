import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAuth } from '../context/AuthContext'
import { useNotificationPreferences } from '../context/NotificationPreferencesContext'
import { useBilling } from '../context/BillingContext'
import { openBirthdayGift } from '../lib/birthdayGifts'
import { openAppreciationGift } from '../lib/appreciationGifts'
import { groupTodayInKyiv } from '../lib/groupYearNavigation'
import { createNotificationCenterRepository, type NotificationCenterItem, type NotificationCenterTab } from '../lib/notificationCenter'
import { NotificationCenterContent, type NotificationEmailRuntimeState } from './NotificationCenterContent'
export { NotificationCenterContent } from './NotificationCenterContent'
export type { NotificationCenterContentProps } from './NotificationCenterContent'

type NotificationItem = NotificationCenterItem
interface NotificationPanelProps { userId: string; onClose: () => void; initialTab?: NotificationCenterTab }
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function teacherAlertHome(eventKey: NotificationItem['teaching_event_key']) {
  if (eventKey?.startsWith('classroom-submit:')) return 'assignments' as const
  if (eventKey?.startsWith('grade-request:')) return 'requests' as const
}
export function notificationPriority(notification: NotificationItem) {
  if (notification.delivery_priority != null) return notification.delivery_priority
  if (notification.type === 'teaching_update') {
    if (notification.teaching_event_key?.startsWith('teaching-extension:')) return 'urgent'
    if (teacherAlertHome(notification.teaching_event_key)) return 'attention'
  }
  if (notification.type === 'academic_deadline' || notification.type === 'teaching_followup') return 'attention'
  return 'normal'
}

export function NotificationPanel({ userId, onClose, initialTab = 'inbox' }: NotificationPanelProps) {
  const navigate = useNavigate()
  const { refreshBilling } = useBilling()
  const { authUser, refreshUser } = useAuth()
  const owner = useRef(authUser?.id); owner.current = authUser?.id
  const preferences = useNotificationPreferences()
  const repository = useRef(createNotificationCenterRepository()).current
  const panelRef = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement | null>(null)
  const close = useRef(onClose); close.current = onClose
  const [emailRuntime, setEmailRuntime] = useState<{ userId: string; state: NotificationEmailRuntimeState }>({ userId, state: 'checking' })
  const emailState = emailRuntime.userId === userId && owner.current === userId ? emailRuntime.state : 'checking'
  const closeWithFocus = () => {
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true })
    close.current()
  }
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null; panelRef.current?.focus({ preventScroll: true })
    const click = (event: MouseEvent) => { const panel = panelRef.current, target = event.target as Node; if (panel && !panel.contains(target) && !panel.parentElement?.contains(target)) close.current() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeWithFocus() } }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', click), 100)
    document.addEventListener('keydown', key)
    return () => { window.clearTimeout(timer); document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key) }
  }, [])
  useEffect(() => {
    let active = true, request: AbortController | null = null
    setEmailRuntime({ userId, state: 'checking' })
    const refresh = async () => {
      if (!active || owner.current !== userId || request || document.visibilityState !== 'visible') return
      const controller = new AbortController(); request = controller
      const timeout = window.setTimeout(() => controller.abort(), 10000)
      try {
        const response = await fetch('/api/notifications/email', { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw Error('status_unavailable')
        const status: unknown = await response.json()
        if (!active || owner.current !== userId) return
        if (!status || typeof status !== 'object' || !('state' in status) || !('available' in status) || typeof status.available !== 'boolean'
          || !['ready', 'limited', 'not_configured', 'unavailable'].includes(String(status.state)) || status.available !== (status.state === 'ready')) throw Error('invalid_status')
        setEmailRuntime({ userId, state: status.state as NotificationEmailRuntimeState })
      } catch { if (active && owner.current === userId) setEmailRuntime({ userId, state: 'unavailable' }) }
      finally { window.clearTimeout(timeout); if (request === controller) request = null }
    }
    const focus = () => { void refresh() }; void refresh()
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    const timer = window.setInterval(focus, 60000)
    return () => { active = false; request?.abort(); window.clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [userId, authUser?.id])

  const openNotification = (notification: NotificationItem) => {
    if (notification.type === 'notification_digest') {
      window.dispatchEvent(new CustomEvent('xelay-open-notifications', { detail: { tab: 'inbox' } }))
      return
    } else if (notification.type === 'group_birthday' && notification.study_group_id && CONVERSATION_ID.test(notification.study_group_id)) {
      navigate({ to: '/groups/$id', params: { id: notification.study_group_id }, search: { date: groupTodayInKyiv() }, hash: 'group-birthdays-area' })
    } else if (notification.type === 'birthday_gift') {
      openBirthdayGift(userId, notification.id)
    } else if (notification.type === 'appreciation_gift') {
      openAppreciationGift(userId, notification.id)
    } else if (notification.type === 'participant_lifetime_award') {
      void refreshBilling()
      navigate({ to: '/subscription' })
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
    } else if (notification.type === 'teaching_followup') {
      navigate({ to: '/teaching' })
    } else if (notification.type === 'teaching_update') {
      void refreshUser()
      const home = teacherAlertHome(notification.teaching_event_key)
      const course = notification.teaching_course_id && CONVERSATION_ID.test(notification.teaching_course_id) ? notification.teaching_course_id : undefined
      const group = notification.study_group_id && CONVERSATION_ID.test(notification.study_group_id) ? notification.study_group_id : undefined
      if (notification.teaching_event_key?.startsWith('teacher-request:')) navigate({ to: '/admin' })
      else if (home && course && group) navigate({ to: '/teaching', search: { home, course, group } })
      else if (group) navigate({ to: '/groups/$id', params: { id: group } })
      else navigate({ to: '/teaching', search: { course } })
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

  if (owner.current !== userId) return null
  return <div ref={panelRef} role="dialog" aria-label="Сповіщення та налаштування" aria-modal="false" tabIndex={-1} className="nc-panel">
    <NotificationCenterContent key={userId} userId={userId} repository={repository} preferences={preferences.preferences} preferencesLoading={preferences.loading} saving={preferences.saving} preferencesError={preferences.error} updatePreferences={preferences.updatePreferences} refreshPreferences={preferences.refreshPreferences} emailState={emailState} onOpen={openNotification} onClose={closeWithFocus} initialTab={initialTab} />
  </div>
}
