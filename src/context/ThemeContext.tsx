import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BASE_THEME_STORAGE_KEY, THEME_STORAGE_KEY, isHalloweenThemeAvailable, nextHalloweenThemeBoundary, parseBaseTheme, type Theme } from '../lib/halloweenTheme'
import { THEME_PREFERENCE_KEY, automaticTheme, nextDailyThemeBoundary, parseThemePreference, resolveThemePreference, type ThemePreference } from '../lib/dailyTheme'
import '../styles/halloween-theme.css'

export type { Theme } from '../lib/halloweenTheme'
export type { ThemePreference } from '../lib/dailyTheme'
interface ThemeContextValue {
  theme: Theme
  preference: ThemePreference
  toggleTheme: () => void
  setTheme: (theme: ThemePreference) => void
  halloweenAvailable: boolean
}
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)
function readPreference(fallback: ThemePreference = 'auto'): ThemePreference {
  try { return parseThemePreference(window.localStorage.getItem(THEME_PREFERENCE_KEY)) }
  catch { return fallback }
}
function ThemeProviderState({ children, previewTheme }: { children: ReactNode; previewTheme?: Theme }) {
  const [preference, updatePreference] = useState<ThemePreference>(() => previewTheme || readPreference())
  const [theme, updateTheme] = useState<Theme>(() => resolveThemePreference(preference, Date.now(), Boolean(previewTheme)))
  const [halloweenAvailable, setHalloweenAvailable] = useState(() => Boolean(previewTheme) || isHalloweenThemeAvailable())
  const currentPreference = useRef(preference), currentTheme = useRef(theme), storageWriteFailed = useRef(false)
  const applyTheme = useCallback((next: ThemePreference) => {
    const resolved = resolveThemePreference(next, Date.now(), Boolean(previewTheme))
    currentPreference.current = next
    currentTheme.current = resolved
    updatePreference(next)
    updateTheme(resolved)
    // A visual fixture never changes a visitor's saved preference.
    if (previewTheme) return
    try {
      window.localStorage.setItem(THEME_PREFERENCE_KEY, next)
      window.localStorage.setItem(THEME_STORAGE_KEY, resolved)
      window.localStorage.setItem(BASE_THEME_STORAGE_KEY, parseBaseTheme(resolved) || automaticTheme())
      storageWriteFailed.current = false
    } catch { storageWriteFailed.current = true }
  }, [previewTheme])
  const setTheme = useCallback((next: ThemePreference) => {
    if (!['auto', 'light', 'dark', 'halloween'].includes(next)) return
    const now = Date.now()
    if (next === 'halloween' && !previewTheme && !isHalloweenThemeAvailable(now)) return
    applyTheme(next)
  }, [applyTheme, previewTheme])
  const toggleTheme = useCallback(() => setTheme(currentTheme.current === 'light' ? 'dark' : 'light'), [setTheme])
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme !== 'light')
    root.dataset.theme = theme
    root.dataset.themePreference = preference
    root.dataset.baseTheme = parseBaseTheme(theme) || automaticTheme()
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
  }, [theme, preference])
  useEffect(() => {
    if (previewTheme) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const reconcile = () => {
      clearTimeout(timer)
      const now = Date.now()
      setHalloweenAvailable(isHalloweenThemeAvailable(now))
      const next = storageWriteFailed.current ? currentPreference.current : readPreference(currentPreference.current)
      applyTheme(next)
      // One timer at the next boundary; no polling or database requests.
      const boundaries = [nextHalloweenThemeBoundary(now)]
      if (next === 'auto' || next === 'halloween') boundaries.push(nextDailyThemeBoundary(now))
      const boundary = Math.min(...boundaries.filter((value): value is number => value !== null))
      if (Number.isFinite(boundary)) timer = setTimeout(reconcile, Math.min(Math.max(1, boundary - now), 2_147_483_647))
    }
    const visible = () => { if (document.visibilityState === 'visible') reconcile() }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_PREFERENCE_KEY && event.key !== null) return
      try { if (event.storageArea !== window.localStorage) return } catch { return }
      storageWriteFailed.current = false
      reconcile()
    }
    reconcile()
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', reconcile)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', reconcile)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [applyTheme, previewTheme, preference])
  const value = useMemo(() => ({ theme, preference, toggleTheme, setTheme, halloweenAvailable }), [theme, preference, toggleTheme, setTheme, halloweenAvailable])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
/** The production provider uses the device's real local time. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeProviderState>{children}</ThemeProviderState>
}
/** Only for isolated local visual fixtures. */
export function SeasonalThemePreviewProvider({ children, initialTheme = 'halloween' }: { children: ReactNode; initialTheme?: Theme }) {
  return <ThemeProviderState previewTheme={initialTheme}>{children}</ThemeProviderState>
}
export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
