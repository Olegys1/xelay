import type { NotificationPreferences } from '../context/NotificationPreferencesContext'
import type { NotificationCategory } from './notificationCenter'

// These helpers govern ordinary attention only. Required delivery is enforced
// by the server and is intentionally independent of either ordinary switch.
export function ordinaryNotificationAttentionEnabled(preferences: NotificationPreferences, category: NotificationCategory): boolean {
  return preferences.notificationsEnabled && preferences.categorySettings?.[category]?.in_app !== false
}

export function ordinaryNotificationEmailEnabled(preferences: NotificationPreferences, category: NotificationCategory): boolean {
  return preferences.emailNotificationsEnabled && preferences.categorySettings?.[category]?.email !== 'off'
}
