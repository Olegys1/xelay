import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'type' | 'title'> & {
  label: string; description: string; children: ReactNode
}

/** Small anchored explanation. No overlay, body lock or modal focus trap. */
export function BadgeInfo({ label, description, children, ...props }: Props) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 8 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 16)
    const height = panel.current.getBoundingClientRect().height
    const below = rect.bottom + 8
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 8) })
    panel.current.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    const moved = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', moved); window.addEventListener('scroll', moved, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', moved); window.removeEventListener('scroll', moved, true) }
  }, [open])
  return <><button {...props} ref={trigger} type="button" title={`${label} — натисніть, щоб дізнатися більше`}
    aria-label={props['aria-label'] || `${label} — про бейдж`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value) }}>
    {children}
  </button>{open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={`Про бейдж «${label}»`} aria-describedby={`${id}-description`} tabIndex={-1}
    style={{ position: 'fixed', ...position, width: 'min(300px, calc(100vw - 16px))' }}
    className="z-[150] rounded-2xl border border-border bg-card p-4 text-left text-foreground shadow-xl outline-none">
    <div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold">{label}</p>
      <button type="button" aria-label="Закрити пояснення бейджа" onClick={(event) => { event.stopPropagation(); close() }} className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={15} /></button></div>
    <p id={`${id}-description`} className="mt-2 text-xs leading-6 text-muted-foreground">{description}</p>
  </div>, document.body)}</>
}
