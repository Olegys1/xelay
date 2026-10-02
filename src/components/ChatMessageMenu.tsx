import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

export type ChatMessageMenuItem = {
  label: string
  icon: ReactNode
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

type Props = {
  items: ChatMessageMenuItem[]
  align?: 'left' | 'right'
  disabled?: boolean
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  anchorRef?: RefObject<HTMLElement | null>
  hideTrigger?: boolean
}

export function ChatMessageMenu({ items, align = 'right', disabled = false, className = '', open: controlledOpen, onOpenChange, anchorRef, hideTrigger = false }: Props) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }, [controlledOpen, onOpenChange])
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const itemCount = items.length
  const restoreFocus = () => (hideTrigger ? anchorRef?.current : trigger.current)?.focus({ preventScroll: true })

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const anchor = (anchorRef?.current || trigger.current)?.getBoundingClientRect()
    const bounds = menu.current?.getBoundingClientRect()
    if (!anchor || !bounds) return
    const viewport = window.visualViewport
    const leftEdge = (viewport?.offsetLeft || 0) + 8
    const topEdge = (viewport?.offsetTop || 0) + 8
    const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16
    const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16
    const desiredLeft = align === 'right' ? anchor.right - bounds.width : anchor.left
    const below = anchor.bottom + 4
    const desiredTop = below + bounds.height <= bottomEdge ? below : anchor.top - bounds.height - 4
    setPosition({
      left: Math.max(leftEdge, Math.min(desiredLeft, rightEdge - bounds.width)),
      top: Math.max(topEdge, Math.min(desiredTop, bottomEdge - bounds.height)),
    })
  }, [open, align, itemCount, anchorRef])

  useLayoutEffect(() => {
    if (open && position) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target
      if (target instanceof Node && (anchorRef?.current?.contains(target) || trigger.current?.contains(target) || menu.current?.contains(target))) return
      setOpen(false)
    }
    const close = () => setOpen(false)
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.visualViewport?.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.visualViewport?.removeEventListener('resize', close)
    }
  }, [open, setOpen, anchorRef])

  useEffect(() => { if (disabled && open) setOpen(false) }, [disabled, open, setOpen])

  if (!items.length) return null
  // Keep menus in a containing dialog so its focus handling includes them.
  const portalRoot = (anchorRef?.current || trigger.current)?.closest('[role="dialog"]') || document.body
  const maxHeight = Math.min(320, Math.max(0, (window.visualViewport?.height || window.innerHeight) - 16))
  const maxWidth = Math.max(0, (window.visualViewport?.width || window.innerWidth) - 16)
  return <span className={`chat-message-actions ${className}`} data-open={open}>
    {!hideTrigger && <button
      ref={trigger}
      type="button"
      disabled={disabled}
      className="chat-message-menu-trigger flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40"
      aria-label="Дії з повідомленням"
      title="Дії з повідомленням"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }
      }}
    ><MoreHorizontal size={17} aria-hidden="true" /></button>}
    {open && createPortal(<div
      ref={menu}
      id={id}
      role="menu"
      aria-label="Дії з повідомленням"
      className="fixed z-[110] w-52 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ top: position?.top || 0, left: position?.left || 0, maxHeight, maxWidth, visibility: position ? 'visible' : 'hidden' }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
          restoreFocus()
        } else if (event.key === 'Tab') {
          setOpen(false)
          restoreFocus()
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
          if (!buttons.length) return
          const active = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (active + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          const button = buttons[next]
          button?.focus({ preventScroll: true })
          if (button && menu.current) {
            const bounds = button.getBoundingClientRect()
            const visible = menu.current.getBoundingClientRect()
            if (bounds.top < visible.top + 4) menu.current.scrollTop -= visible.top + 4 - bounds.top
            else if (bounds.bottom > visible.bottom - 4) menu.current.scrollTop += bounds.bottom - visible.bottom + 4
          }
        }
      }}
    >{items.map((item) => <button
      key={item.label}
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={item.disabled}
      className={`chat-message-menu-item flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-40 ${item.destructive ? 'text-destructive' : ''}`}
      onClick={() => {
        setOpen(false)
        restoreFocus()
        item.onSelect()
      }}
    ><span className="shrink-0" aria-hidden="true">{item.icon}</span><span>{item.label}</span></button>)}</div>, portalRoot)}
  </span>
}
