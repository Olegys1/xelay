import { useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { useNotificationPreferences } from '../context/NotificationPreferencesContext'
import { useToast } from '../context/ToastContext'
import { announceOrganizerUpdate, deliverOrganizerReminders } from '../lib/organizer'
import { clearOrganizerDraft } from '../lib/organizerDraft'
import { ordinaryNotificationAttentionEnabled, ordinaryNotificationEmailEnabled } from '../lib/notificationAttention'

// Reminder records are created by the authenticated database RPC. This bridge
// polls only while Xelay is visible. The server routes emitted events to each
// configured channel; this bridge itself only displays ordinary in-app toasts.
export function OrganizerReminders() {
  const { authUser, isLoading: authLoading, isPasswordRecovery } = useAuth()
  const { isPremium, isLoading: billingLoading, error: billingError } = useBilling()
  const { preferences, loading: preferencesLoading, error: preferencesError } = useNotificationPreferences()
  const { notify, dismiss } = useToast()
  const userId = authUser?.id ?? null
  const attentionEnabled = ordinaryNotificationAttentionEnabled(preferences, 'organizer')
  const mailEnabled = ordinaryNotificationEmailEnabled(preferences, 'organizer')
  const enabled = Boolean(userId && !authLoading && !isPasswordRecovery && isPremium
    && !billingLoading && !billingError && !preferencesLoading && !preferencesError
    && (attentionEnabled || mailEnabled))
  const currentOwner = useRef(userId)
  const currentlyEnabled = useRef(enabled)
  const currentlyAttentionEnabled = useRef(attentionEnabled)
  currentOwner.current = userId
  currentlyEnabled.current = enabled
  currentlyAttentionEnabled.current = attentionEnabled
  const previousOwner = useRef<string | null | undefined>(undefined)
  const inFlight = useRef<symbol | null>(null)

  // This component stays mounted even when the organizer route is closed.
  // Clear the previous account's private draft on identity change, not on
  // ordinary effect cleanup or React's development remount checks.
  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== userId) clearOrganizerDraft(previousOwner.current)
    previousOwner.current = userId
  }, [userId])

  useEffect(() => {
    if (!enabled || !userId) return
    let active = true
    const toastId = `organizer-reminders-${userId}`
    const poll = async () => {
      if (!active || inFlight.current || document.visibilityState !== 'visible'
        || currentOwner.current !== userId || !currentlyEnabled.current) return
      const request = Symbol('organizer-reminders')
      inFlight.current = request
      try {
        const count = await deliverOrganizerReminders(userId)
        if (!active || currentOwner.current !== userId || !currentlyEnabled.current
          || document.visibilityState !== 'visible' || !Number.isSafeInteger(count) || count <= 0) return
        announceOrganizerUpdate()
        window.dispatchEvent(new CustomEvent('xelay-notifications-updated', { detail: { userId } }))
        if (!currentlyAttentionEnabled.current) return
        notify({
          id: toastId,
          title: 'Нагадування про ваші завдання',
          description: `Нових нагадувань: ${count}. Відкрийте дзвіночок, щоб перейти до органайзера.`,
          tone: 'info',
          duration: 7000,
        })
      } catch {
        // A rollout may not have the new RPC yet. Keep ordinary navigation and
        // other notifications usable; retry only on the next bounded tick.
      } finally {
        if (inFlight.current === request) inFlight.current = null
      }
    }
    const onFocus = () => { void poll() }
    const onVisibility = () => { if (document.visibilityState === 'visible') void poll() }
    void poll()
    const interval = window.setInterval(() => { void poll() }, 60_000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      dismiss(toastId)
    }
  }, [enabled, userId, notify, dismiss])

  return null
}
