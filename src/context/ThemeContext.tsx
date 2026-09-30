import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'xelay_theme'

interface ThemeContextValue {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function parseTheme(value: string | null | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light'
}

function readSavedTheme(): Theme {
  if (typeof window === 'undefined') return 'light'

  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return parseTheme(document.documentElement.dataset.theme)
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readSavedTheme)
  const currentTheme = useRef(theme)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.dataset.theme = theme
    root.style.colorScheme = theme
  }, [theme])

  const toggleTheme = useCallback(() => {
    const nextTheme = currentTheme.current === 'light' ? 'dark' : 'light'
    currentTheme.current = nextTheme
    setTheme(nextTheme)

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch {
      // Theme switching still works when browser storage is unavailable.
    }
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return

      try {
        if (event.storageArea !== window.localStorage) return
      } catch {
        return
      }

      const nextTheme = parseTheme(event.newValue)
      currentTheme.current = nextTheme
      setTheme(nextTheme)
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
