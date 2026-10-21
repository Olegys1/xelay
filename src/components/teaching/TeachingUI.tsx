import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X, Loader2 } from 'lucide-react'
import './teaching.css'

export const teachingInput = 'teaching-input'
export function TeachingButton({ children, onClick, disabled, busy, primary, type = 'button', title }: { children: ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; type?: 'button' | 'submit'; title?: string }) {
  return <button type={type} onClick={onClick} disabled={disabled || busy} title={title} className={`teaching-button ${primary ? 'teaching-button-primary' : ''}`}>{busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}{children}</button>
}
export function TeachingField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="teaching-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}
export function TeachingEmpty({ icon, title, description, children }: { icon?: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="teaching-empty">{icon && <span className="teaching-empty-icon" aria-hidden="true">{icon}</span>}<h3>{title}</h3><p>{description}</p>{children && <div className="mt-5">{children}</div>}</div>
}
export function TeachingModal({ title, description, children, onClose, busy = false, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const dialog = ref.current!
    const focus = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); focus?.focus() }
  }, [])
  return <dialog ref={ref} className={`teaching-modal${wide ? ' teaching-modal-wide' : ''}`} aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!busy) onCloseRef.current() }}>
    <div className="teaching-modal-heading"><div><h2 id={heading}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" aria-label="Закрити" className="teaching-icon-button" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <div className="teaching-modal-body">{children}</div>
  </dialog>
}
