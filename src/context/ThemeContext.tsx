import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BASE_THEME_STORAGE_KEY, THEME_STORAGE_KEY, HALLOWEEN_THEME_CHOICE_KEY, isHalloweenThemeAvailable, nextHalloweenThemeBoundary, parseBaseTheme, parseHalloweenThemeChoice, resolveSavedTheme, type BaseTheme, type Theme, type HalloweenThemeChoice } from '../lib/halloweenTheme'
import '../styles/halloween-theme.css'

export type { Theme } from '../lib/halloweenTheme'

interface ThemeContextValue {
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
  halloweenAvailable: boolean
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)
type ThemeSnapshot = { theme: Theme; base: BaseTheme; choice: HalloweenThemeChoice | null }

function readSavedTheme(fallback?: ThemeSnapshot, preferMemory = false): ThemeSnapshot {
  if (typeof window === 'undefined') return { ...resolveSavedTheme(null, null, false), choice: null }
  let systemDark = false
  try { systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches } catch { /* Older web views use light. */ }
  const memory = (): ThemeSnapshot => {
    const rawChoice = fallback?.choice ? JSON.stringify(fallback.choice) : null
    return {
      ...resolveSavedTheme(fallback?.theme || document.documentElement.dataset.theme, fallback?.base || document.documentElement.dataset.baseTheme, systemDark, Date.now(), rawChoice),
      choice: fallback?.choice || null,
    }
  }
  if (preferMemory && fallback) return memory()
  try {
    const rawChoice = window.localStorage.getItem(HALLOWEEN_THEME_CHOICE_KEY)
    return {
      ...resolveSavedTheme(window.localStorage.getItem(THEME_STORAGE_KEY), window.localStorage.getItem(BASE_THEME_STORAGE_KEY), systemDark, Date.now(), rawChoice),
      choice: parseHalloweenThemeChoice(rawChoice),
    }
  } catch {
    // Keep an explicit opt-out for this open page even when storage is blocked.
    return memory()
  }
}

function ThemeProviderState({ children, previewTheme }: { children: ReactNode; previewTheme?: Theme }) {
  const [initial] = useState<ThemeSnapshot>(() => previewTheme ? { theme: previewTheme, base: parseBaseTheme(previewTheme) || 'light', choice: null } : readSavedTheme())
  const [theme, updateTheme] = useState<Theme>(initial.theme)
  const [halloweenAvailable, setHalloweenAvailable] = useState(() => Boolean(previewTheme) || isHalloweenThemeAvailable())
  const currentTheme = useRef(theme)
  const baseTheme = useRef<BaseTheme>(initial.base)
  const seasonalChoice = useRef<HalloweenThemeChoice | null>(initial.choice)
  const storageWriteFailed = useRef(false)

  const applyTheme = useCallback((next: Theme, persist = true) => {
    currentTheme.current = next
    if (next !== 'halloween') baseTheme.current = next
    updateTheme(next)
    // A local visual fixture never changes a visitor's real saved preference.
    if (previewTheme || !persist) return
    try {
      if (seasonalChoice.current && isHalloweenThemeAvailable()) window.localStorage.setItem(HALLOWEEN_THEME_CHOICE_KEY, JSON.stringify(seasonalChoice.current))
      // Preserve the normal preference before the seasonal default replaces its key.
      window.localStorage.setItem(BASE_THEME_STORAGE_KEY, baseTheme.current)
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
      storageWriteFailed.current = false
    } catch { storageWriteFailed.current = true }
  }, [previewTheme])

  const setTheme = useCallback((next: Theme) => {
    if (next !== 'light' && next !== 'dark' && next !== 'halloween') return
    const now = Date.now()
    if (next === 'halloween' && !previewTheme && !isHalloweenThemeAvailable(now)) return
    if (!previewTheme && isHalloweenThemeAvailable(now)) {
      const choice: HalloweenThemeChoice = { campaign: 'halloween-2026', theme: next, chosenAt: now }
      seasonalChoice.current = choice
    }
    applyTheme(next)
  }, [applyTheme, previewTheme])

  const toggleTheme = useCallback(() => setTheme(currentTheme.current === 'light' ? 'dark' : 'light'), [setTheme])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme !== 'light')
    root.dataset.theme = theme
    root.dataset.baseTheme = baseTheme.current
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
  }, [theme])

  useEffect(() => {
    if (previewTheme) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const reconcileSeason = () => {
      clearTimeout(timer)
      const now = Date.now()
      setHalloweenAvailable(isHalloweenThemeAvailable(now))
      const saved = readSavedTheme({ theme: currentTheme.current, base: baseTheme.current, choice: seasonalChoice.current }, storageWriteFailed.current)
      baseTheme.current = saved.base
      seasonalChoice.current = saved.choice
      // Covers the exact launch, expiry, a restored background tab and another tab's choice.
      applyTheme(saved.theme, isHalloweenThemeAvailable(now) || currentTheme.current === 'halloween')
      const boundary = nextHalloweenThemeBoundary(now)
      if (boundary !== null) timer = setTimeout(reconcileSeason, Math.min(Math.max(1, boundary - now), 2_147_483_647))
    }
    const visible = () => { if (document.visibilityState === 'visible') reconcileSeason() }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== BASE_THEME_STORAGE_KEY && event.key !== HALLOWEEN_THEME_CHOICE_KEY && event.key !== null) return
      try { if (event.storageArea !== window.localStorage) return } catch { return }
      storageWriteFailed.current = false
      if (event.key === null || event.key === HALLOWEEN_THEME_CHOICE_KEY && event.newValue === null) seasonalChoice.current = null
      reconcileSeason()
    }
    let system: MediaQueryList | undefined
    try { system = window.matchMedia?.('(prefers-color-scheme: dark)') } catch { /* Optional in older web views. */ }
    reconcileSeason()
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', reconcileSeason)
    document.addEventListener('visibilitychange', visible)
    system?.addEventListener?.('change', reconcileSeason)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', reconcileSeason)
      document.removeEventListener('visibilitychange', visible)
      system?.removeEventListener?.('change', reconcileSeason)
    }
  }, [applyTheme, previewTheme])

  const value = useMemo(() => ({ theme, toggleTheme, setTheme, halloweenAvailable }), [theme, toggleTheme, setTheme, halloweenAvailable])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** The production provider always uses real time; no URL or environment override. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeProviderState>{children}</ThemeProviderState>
}

/** Only for isolated local visual fixtures. The production entry point never imports this. */
export function SeasonalThemePreviewProvider({ children, initialTheme = 'halloween' }: { children: ReactNode; initialTheme?: Theme }) {
  return <ThemeProviderState previewTheme={initialTheme}>{children}</ThemeProviderState>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
