import { isHalloweenThemeAvailable, parseBaseTheme, type BaseTheme, type Theme } from './halloweenTheme'

export type ThemePreference = 'auto' | Theme
// New installations and existing installations start in auto once.
// Subsequent manual choices survive deployments and reloads.
export const THEME_PREFERENCE_KEY = 'xelay_theme_preference_v2'
export const parseThemePreference = (value: unknown): ThemePreference =>
  value === 'light' || value === 'dark' || value === 'halloween' ? value : 'auto'

export function automaticTheme(now = Date.now()): BaseTheme {
  const hour = new Date(now).getHours()
  return hour >= 7 && hour < 19 ? 'light' : 'dark'
}
export function resolveThemePreference(preference: ThemePreference, now = Date.now(), preview = false): Theme {
  if (preference === 'halloween' && (preview || isHalloweenThemeAvailable(now))) return 'halloween'
  return parseBaseTheme(preference) || automaticTheme(now)
}
export function nextDailyThemeBoundary(now = Date.now()): number {
  const date = new Date(now), hour = date.getHours()
  if (hour < 7) date.setHours(7, 0, 0, 0)
  else if (hour < 19) date.setHours(19, 0, 0, 0)
  else { date.setDate(date.getDate() + 1); date.setHours(7, 0, 0, 0) }
  return date.getTime()
}
