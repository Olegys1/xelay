import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, ReactElement } from 'react'
import { X, BriefcaseBusiness } from 'lucide-react'
import { APPLICATION_LABELS, REVIEW_LABELS, ORDER_LABELS } from '../../lib/opportunities/types'
import type { Company } from '../../lib/opportunities/types'

export function CareerModal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId()
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus(); return () => { document.body.style.overflow = old; if (previous?.isConnected) previous.focus() } }, [])
  return <div className="op-overlay" onClick={event => { if (event.target === event.currentTarget) onClose() }}><div ref={ref} className={`op-modal ${wide ? 'op-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose() } if (event.key === 'Tab') { const controls = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])].filter(item => item.offsetParent !== null); const first = controls[0], last = controls[controls.length - 1]; if (!first) { event.preventDefault(); return } if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() } } }}>
    <header className="op-modal-head"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="op-icon-button" aria-label="Закрити вікно" onClick={onClose}><X size={20} /></button></header>{children}</div></div>
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const generated = useId(); const hintId = `${generated}-hint`; let controlId = ''
  const connect = (nodes: ReactNode): ReactNode => Children.map(nodes, node => {
    if (!isValidElement(node)) return node
    const element = node as ReactElement<any>
    if (typeof element.type === 'string' && ['input', 'textarea', 'select'].includes(element.type) && !controlId) { controlId = element.props.id || `${generated}-field`; return cloneElement(element, { id: controlId, name: element.props.name || controlId, 'aria-describedby': [element.props['aria-describedby'], hint ? hintId : ''].filter(Boolean).join(' ') || undefined }) }
    return element.props.children ? cloneElement(element, {}, connect(element.props.children)) : element
  })
  const content = connect(children)
  return <div className="op-field">{controlId ? <label htmlFor={controlId}>{label}</label> : <span>{label}</span>}{content}{hint && <small id={hintId}>{hint}</small>}</div>
}
export function StatusPill({ status }: { status: string }) { const labels: Record<string, string> = { ...REVIEW_LABELS, ...APPLICATION_LABELS, ...ORDER_LABELS }; return <span className={`op-status op-status-${status}`}>{labels[status] || status}</span> }
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <section className="op-empty"><BriefcaseBusiness size={30} /><h3>{title}</h3><p>{description}</p>{action}</section> }
export function CompanyMark({ company, size = 44 }: { company?: Company; size?: number }) { const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [company?.logo]); const logo = company?.logo && /^https:\/\//i.test(company.logo) ? company.logo : null; return <span className="op-company-mark" style={{ width: size, height: size, background: company?.color || '#f0e7ea', color: '#54162c' }}>{logo && !failed ? <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : company?.name.slice(0, 2).toUpperCase() || 'XL'}</span> }
export function dateLabel(value: string) { if (!value) return 'Без дати'; const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Kyiv' }).format(date) : 'Дата не вказана' }
export function money(value: number) { return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value) + ' грн' }
