import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'

export function ThemeToggle({ className = '', showCaption = false }: { className?: string; showCaption?: boolean }) {
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
      className={`group inline-flex w-10 shrink-0 items-center justify-center text-primary hover:bg-accent xelay-btn ${showCaption ? 'h-11 flex-col gap-1 rounded-xl' : 'h-10 rounded-full'} ${className}`}
    >
      <Icon size={20} aria-hidden="true" className="transition-transform duration-200 group-hover:rotate-12 motion-reduce:transition-none" />
      {showCaption && <span aria-hidden="true" className="text-[10px] font-medium leading-none text-muted-foreground">Тема</span>}
    </button>
  )
}
