import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'
export type ToastInput = { title: string; description?: string; tone?: ToastTone; id?: string; duration?: number }
type ToastEntry = Required<Pick<ToastInput, 'title' | 'tone' | 'id' | 'duration'>> & { description?: string; version: number; closing: boolean }
type ToastApi = { notify: (input: ToastInput) => string; dismiss: (id: string) => void }

const ToastContext = createContext<ToastApi | null>(null)
const DEFAULT_DURATION: Record<ToastTone, number> = { success: 4500, info: 5000, warning: 7000, error: 8000 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([])
  const [announcement, setAnnouncement] = useState({ version: 0, text: '' })
  const [hidden, setHidden] = useState(() => document.hidden)
  const sequence = useRef(0)
  const exitTimers = useRef(new Map<string, number>())
  const dismiss = useCallback((id: string) => {
    setEntries((current) => current.map((item) => item.id === id ? { ...item, closing: true } : item))
    const existing = exitTimers.current.get(id)
    if (existing) window.clearTimeout(existing)
    exitTimers.current.set(id, window.setTimeout(() => {
      setEntries((current) => current.filter((item) => item.id !== id || !item.closing))
      exitTimers.current.delete(id)
    }, 200))
  }, [])
  const notify = useCallback((input: ToastInput) => {
    const version = ++sequence.current
    const id = input.id || `xelay-toast-${version}`
    const tone = input.tone || 'info'
    const duration = input.duration === 0 ? 0 : Math.max(2500, Math.min(input.duration || DEFAULT_DURATION[tone], 15000))
    const timer = exitTimers.current.get(id)
    if (timer) { window.clearTimeout(timer); exitTimers.current.delete(id) }
    const entry: ToastEntry = { id, version, tone, duration, title: input.title, description: input.description, closing: false }
    const limit = window.matchMedia('(max-width: 639.98px)').matches ? 2 : 3
    setEntries((current) => [...current.filter((item) => item.id !== id && !item.closing).slice(-(limit - 1)), entry])
    setAnnouncement({ version, text: `${input.title}${input.description ? `. ${input.description}` : ''}` })
    return id
  }, [])
  useEffect(() => {
    const visibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => { document.removeEventListener('visibilitychange', visibility); exitTimers.current.forEach((timer) => window.clearTimeout(timer)); exitTimers.current.clear() }
  }, [])
  const api = useMemo(() => ({ notify, dismiss }), [notify, dismiss])
  return <ToastContext.Provider value={api}>
    <NativeFormFeedback />
    {children}
    {createPortal(<>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only"><span key={announcement.version}>{announcement.text}</span></div>
      <ol aria-label="Сповіщення про дії" className="xelay-toast-stack">
        {entries.map((entry) => <ToastCard key={entry.id} entry={entry} dismiss={dismiss} hidden={hidden} />)}
      </ol>
    </>, document.body)}
  </ToastContext.Provider>
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}

function ToastCard({ entry, dismiss, hidden }: { entry: ToastEntry; dismiss: ToastApi['dismiss']; hidden: boolean }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const remaining = useRef(entry.duration)
  const paused = hovered || focused || hidden
  useEffect(() => { remaining.current = entry.duration }, [entry.version, entry.duration])
  useEffect(() => {
    if (paused || entry.closing || !entry.duration) return
    const started = performance.now()
    const timer = window.setTimeout(() => dismiss(entry.id), remaining.current)
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - started)) }
  }, [entry.id, entry.version, entry.duration, entry.closing, paused, dismiss])
  const Icon = entry.tone === 'success' ? CheckCircle2 : entry.tone === 'error' ? CircleAlert : entry.tone === 'warning' ? TriangleAlert : Info
  return <li className={`xelay-toast xelay-toast--${entry.tone} ${entry.closing ? 'xelay-toast--closing' : ''}`}
    onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHovered(true) }} onPointerLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    <Icon size={20} className="xelay-toast-icon" aria-hidden="true" />
    <div className="min-w-0 flex-1"><p className="text-sm font-semibold leading-snug">{entry.title}</p>{entry.description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.description}</p>}</div>
    <button type="button" className="xelay-toast-close" aria-label="Закрити сповіщення" onClick={() => dismiss(entry.id)}><X size={16} aria-hidden="true" /></button>
    {entry.duration > 0 && <span key={entry.version} aria-hidden="true" className="xelay-toast-progress" style={{ animationDuration: `${entry.duration}ms`, animationPlayState: paused || entry.closing ? 'paused' : 'running' }} />}
  </li>
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
const isControl = (value: EventTarget | null): value is FormControl => value instanceof HTMLInputElement || value instanceof HTMLSelectElement || value instanceof HTMLTextAreaElement

// Native constraint validation stops onSubmit before React can display feedback.
// Batch its invalid events so one Save click produces one useful notification.
function NativeFormFeedback() {
  const { notify } = useToast()
  useEffect(() => {
    let pending: FormControl[] = []
    let queued = false
    let active = true
    const previousAria = new WeakMap<FormControl, string | null>()
    const clear = (target: FormControl) => {
      if (!target.hasAttribute('data-xelay-native-invalid')) return
      target.removeAttribute('data-xelay-native-invalid')
      const original = previousAria.get(target)
      if (original == null) target.removeAttribute('aria-invalid')
      else target.setAttribute('aria-invalid', original)
      previousAria.delete(target)
    }
    const invalid = (event: Event) => {
      if (!isControl(event.target) || !document.getElementById('root')?.contains(event.target)) return
      const target = event.target
      if (target.form?.hasAttribute('data-xelay-native-feedback-off')) return
      event.preventDefault()
      if (!target.hasAttribute('data-xelay-native-invalid')) previousAria.set(target, target.getAttribute('aria-invalid'))
      target.setAttribute('data-xelay-native-invalid', 'true'); target.setAttribute('aria-invalid', 'true')
      if (!pending.includes(target)) pending.push(target)
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!active) return
        const controls = pending.filter((control) => control.isConnected && !control.validity.valid)
        pending = []
        const first = controls[0]
        if (!first) return
        const labelled = first.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
        const labelClone = first.labels?.[0]?.cloneNode(true) as HTMLElement | undefined
        labelClone?.querySelectorAll('input,select,textarea,button,[role="status"],[role="alert"]').forEach((node) => node.remove())
        const label = (first.getAttribute('aria-label') || labelled || labelClone?.textContent || first.getAttribute('placeholder') || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim().slice(0, 100)
        const validity = first.validity
        let reason = validity.valueMissing ? first instanceof HTMLSelectElement ? 'зробіть вибір у списку' : first instanceof HTMLInputElement && first.type === 'checkbox' ? 'підтвердьте цей пункт' : 'заповніть це поле'
          : validity.typeMismatch && first instanceof HTMLInputElement && first.type === 'email' ? 'вкажіть коректну адресу електронної пошти'
            : validity.tooShort ? 'текст закороткий' : validity.tooLong ? 'скоротіть текст до дозволеної довжини'
              : validity.rangeUnderflow || validity.rangeOverflow ? 'значення виходить за дозволені межі' : 'перевірте формат значення'
        reason = `${label ? `${label}: ` : ''}${reason}.${controls.length > 1 ? ` Ще ${controls.length - 1} полів потребують уваги.` : ''}`
        notify({ id: 'native-form-validation', tone: 'warning', title: 'Перевірте поля форми', description: reason })
        first.focus({ preventScroll: true })
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        first.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
      })
    }
    const input = (event: Event) => { if (isControl(event.target) && event.target.validity.valid) clear(event.target) }
    const reset = (event: Event) => { if (event.target instanceof HTMLFormElement) event.target.querySelectorAll<FormControl>('[data-xelay-native-invalid]').forEach(clear) }
    document.addEventListener('invalid', invalid, true)
    document.addEventListener('input', input, true); document.addEventListener('change', input, true); document.addEventListener('reset', reset, true)
    return () => { active = false; document.removeEventListener('invalid', invalid, true); document.removeEventListener('input', input, true); document.removeEventListener('change', input, true); document.removeEventListener('reset', reset, true); document.querySelectorAll<FormControl>('[data-xelay-native-invalid]').forEach(clear) }
  }, [notify])
  return null
}
