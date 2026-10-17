import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '../context/ThemeContext'

/** Small friendly decoration, never a click target or a wallpaper. */
export function HalloweenDecorativeMark({ className = '', size = 28, hat = true }: { className?: string; size?: number; hat?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true" focusable="false">
    <path d="M25 18c1-5 4-7 8-7" stroke="#9BAA79" strokeWidth="3" strokeLinecap="round" />
    <path d="M23 19c-7-5-18 1-17 11 0 10 10 14 18 11 8 3 18-1 18-11 1-10-11-16-18-11Z" fill="#F9A44E" stroke="#AC5D2E" strokeWidth="1.8" />
    <path d="M23 20c-8 3-8 17 0 21M26 20c8 3 8 17 0 21" stroke="#D77B37" strokeWidth="1.7" strokeLinecap="round" />
    <path d="m13 28 4-3 2 5m10 0 2-5 4 3" stroke="#623C46" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19 34c3 3 7 3 10 0" stroke="#623C46" strokeWidth="2.2" strokeLinecap="round" />
    <ellipse cx="12" cy="32" rx="2.2" ry="1.1" fill="#E37666" opacity=".6" />
    <ellipse cx="36" cy="32" rx="2.2" ry="1.1" fill="#E37666" opacity=".6" />
    {hat && <><path d="m13 18 9-14 5 8 7 4-5 5-16-3Z" fill="#B7A1E3" stroke="#74618D" strokeWidth="1.6" strokeLinejoin="round" /><path d="m15 14 13 4-2 3-13-3 2-4Z" fill="#6E537C" /><path d="M8 19c7-2 19 2 27 5" stroke="#74618D" strokeWidth="3.4" strokeLinecap="round" /><path d="m23 15 3 1-1 3-3-1 1-3Z" fill="#FFD685" /></>}
  </svg>
}

const options: { value: Theme; title: string; description: string }[] = [
  { value: 'light', title: 'Світла', description: 'Звичний світлий Xelay' },
  { value: 'dark', title: 'Темна', description: 'Спокійна вечірня палітра' },
  { value: 'halloween', title: 'Гарбузовий вечір', description: 'Тепло, магія і трішки осені' },
]

export function ThemeToggle({ className = '', showCaption = false, textLabel }: { className?: string; showCaption?: boolean; textLabel?: string }) {
  const { theme, toggleTheme, setTheme, halloweenAvailable } = useTheme()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 8 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const isDark = theme !== 'light'
  const label = halloweenAvailable ? 'Обрати тему оформлення' : isDark ? 'Увімкнути світлу тему' : 'Увімкнути темну тему'
  const Icon = isDark ? Sun : Moon
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(304, window.innerWidth - 16)
    const height = panel.current.getBoundingClientRect().height
    const below = rect.bottom + 8
    setPosition({
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      top: below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 8),
    })
    items.current[options.findIndex((option) => option.value === theme)]?.focus({ preventScroll: true })
  }, [open, theme])

  useEffect(() => {
    if (!halloweenAvailable) setOpen(false)
  }, [halloweenAvailable])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    const moved = (event: Event) => {
      // On a short screen the menu itself can scroll; only page movement dismisses it.
      if (event.type === 'scroll' && event.target instanceof Node && panel.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', moved)
    window.addEventListener('scroll', moved, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', moved)
      window.removeEventListener('scroll', moved, true)
    }
  }, [open])

  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { close(); return }
    const current = items.current.indexOf(document.activeElement as HTMLButtonElement)
    let target: number | null = null
    if (event.key === 'ArrowDown') target = (current + 1) % options.length
    if (event.key === 'ArrowUp') target = (current - 1 + options.length) % options.length
    if (event.key === 'Home') target = 0
    if (event.key === 'End') target = options.length - 1
    if (target !== null) { event.preventDefault(); items.current[target]?.focus({ preventScroll: true }) }
  }

  return <><button ref={trigger}
    type="button"
    onClick={() => halloweenAvailable ? setOpen((value) => !value) : toggleTheme()}
    onKeyDown={(event) => { if (halloweenAvailable && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true) } }}
    aria-label={textLabel || label}
    aria-pressed={halloweenAvailable ? undefined : isDark}
    aria-haspopup={halloweenAvailable ? 'menu' : undefined}
    aria-expanded={halloweenAvailable ? open : undefined}
    aria-controls={open ? id : undefined}
    title={theme === 'halloween' ? 'Гарбузовий вечір — обрати тему' : label}
    className={`group inline-flex shrink-0 items-center justify-center text-primary hover:bg-accent xelay-btn ${textLabel ? 'min-h-10 gap-2 rounded-full px-3 py-2 text-xs font-semibold' : showCaption ? 'h-11 w-10 flex-col gap-1 rounded-xl' : 'h-10 w-10 rounded-full'} ${className}`}
  >
    {theme === 'halloween' ? <HalloweenDecorativeMark size={showCaption ? 24 : 27} className="xelay-theme-mark" /> : <Icon size={20} aria-hidden="true" className="transition-transform duration-200 group-hover:rotate-12 motion-reduce:transition-none" />}
    {textLabel ? <span>{textLabel}</span> : showCaption && <span aria-hidden="true" className="text-[10px] font-medium leading-none text-muted-foreground">Тема</span>}
  </button>{open && halloweenAvailable && createPortal(<div ref={panel} id={id} role="menu" aria-label="Тема оформлення" onKeyDown={menuKeys}
    style={{ position: 'fixed', ...position, width: 'min(304px, calc(100vw - 16px))', maxHeight: 'calc(100dvh - 16px)' }}
    className="xelay-theme-selector z-[160] overflow-y-auto rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-xl">
    <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2"><span className="text-xs font-semibold">Ваш настрій у Xelay</span><span className="xelay-theme-season-label">До кінця 2 листопада</span></div>
    {options.map((option, index) => <button key={option.value} ref={(element) => { items.current[index] = element }} type="button" role="menuitemradio"
      aria-checked={theme === option.value} tabIndex={theme === option.value ? 0 : -1}
      onClick={(event) => { event.stopPropagation(); setTheme(option.value); close() }}
      className={`xelay-theme-option flex min-h-[72px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${theme === option.value ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}>
      <span className={`xelay-theme-swatch xelay-theme-swatch-${option.value}`} aria-hidden="true">
        {option.value === 'halloween' ? <HalloweenDecorativeMark size={29} /> : option.value === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
      </span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{option.title}</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{option.description}</span></span>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{theme === option.value && <Check size={16} aria-hidden="true" />}</span>
    </button>)}
    <p className="px-3 pb-2 pt-2 text-[10px] leading-4 text-muted-foreground">Оформлення можна змінити будь-коли. На роботу платформи це не впливає.</p>
  </div>, document.body)}</>
}
