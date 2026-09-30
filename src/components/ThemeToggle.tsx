import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'
  const label = isDark ? 'Увімкнути світлу тему' : 'Увімкнути темну тему'
  const Icon = isDark ? Sun : Moon

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      aria-pressed={isDark}
      title={label}
      className={`group inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary hover:bg-accent xelay-btn ${className}`}
    >
      <Icon size={20} aria-hidden="true" className="transition-transform duration-200 group-hover:rotate-12 motion-reduce:transition-none" />
    </button>
  )
}
