import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, Flag, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  PROFILE_REPORT_DETAILS_MAX, PROFILE_REPORT_DETAILS_MIN, PROFILE_REPORT_REASONS, PROFILE_REPORT_TARGETS,
  profileReportError, submitProfileReport, validateProfileReportDetails,
  type ProfileReportReason, type ProfileReportTargetKind,
} from '../lib/profileReports'
import { ChatDialog, chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'

type Props = { targetUserId: string; targetName: string; onClose: () => void }
type Receipt = Awaited<ReturnType<typeof submitProfileReport>>

export function ProfileReportDialog({ targetUserId, targetName, onClose }: Props) {
  const { authUser, isAuthenticated } = useAuth()
  const [targetKind, setTargetKind] = useState<ProfileReportTargetKind>('profile')
  const [reason, setReason] = useState<ProfileReportReason | ''>('')
  const [details, setDetails] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [invalidField, setInvalidField] = useState<'reason' | 'details' | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const reasonId = useId()
  const detailsId = useId()
  const targetId = useId()
  const hintId = useId()
  const errorId = useId()
  const reasonControl = useRef<HTMLSelectElement>(null)
  const detailsControl = useRef<HTMLTextAreaElement>(null)
  const reportForm = useRef<HTMLFormElement>(null)
  const successAction = useRef<HTMLButtonElement>(null)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const mutation = useRef(false)
  const completed = useRef(false)
  const attempt = useRef<{ payload: string; requestId: string } | null>(null)
  const scope = JSON.stringify([authUser?.id || '', targetUserId])
  const initialScope = useRef(scope)
  const canReport = Boolean(isAuthenticated && authUser?.id && targetUserId && authUser.id !== targetUserId)
  const invalidated = useRef(false)
  if (!canReport || scope !== initialScope.current) invalidated.current = true
  const current = useRef({ scope, allowed: canReport })
  current.current = { scope, allowed: canReport && !invalidated.current }
  const closeCallback = useRef(onClose)
  closeCallback.current = onClose

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current += 1 }
  }, [])

  useEffect(() => {
    // Disabled/replaced submit controls must not drop keyboard focus behind
    // the modal during submission or when the acknowledgement replaces it.
    if (saving) reportForm.current?.closest<HTMLElement>('[role="dialog"]')?.focus()
    else if (receipt) successAction.current?.focus()
  }, [saving, receipt])

  const close = () => {
    if (mutation.current) return
    mounted.current = false
    sequence.current += 1
    closeCallback.current()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!mounted.current || mutation.current || completed.current || !current.current.allowed || current.current.scope !== initialScope.current) return
    setError(''); setInvalidField(null)
    if (!PROFILE_REPORT_TARGETS.some((item) => item.value === targetKind)) {
      setError('Оберіть, на що ви скаржитеся: профіль або статус.')
      return
    }
    if (!PROFILE_REPORT_REASONS.some((item) => item.value === reason)) {
      setError('Оберіть причину скарги.'); setInvalidField('reason'); reasonControl.current?.focus()
      return
    }
    const validation = validateProfileReportDetails(details)
    if (validation) {
      setError(validation); setInvalidField('details'); detailsControl.current?.focus()
      return
    }
    const normalizedDetails = details.trim()
    const payload = JSON.stringify([initialScope.current, targetKind, reason, normalizedDetails])
    if (attempt.current?.payload !== payload) attempt.current = { payload, requestId: crypto.randomUUID() }
    const request = ++sequence.current
    const isCurrent = () => mounted.current && sequence.current === request && current.current.allowed && current.current.scope === initialScope.current
    mutation.current = true
    setSaving(true)
    try {
      const result = await submitProfileReport({ targetUserId, targetKind, reason: reason as ProfileReportReason, details: normalizedDetails, requestId: attempt.current.requestId })
      if (!isCurrent()) return
      completed.current = true
      setReceipt(result)
    } catch (failure) {
      if (isCurrent()) setError(profileReportError(failure))
    } finally {
      if (isCurrent()) { mutation.current = false; setSaving(false) }
    }
  }

  if (!canReport || invalidated.current || scope !== initialScope.current) return null
  const detailsLength = Array.from(details.trim()).length
  const detailsError = validateProfileReportDetails(details)
  const fieldClass = `${chatInput} focus-visible:ring-primary/30`

  return <ChatDialog title={receipt ? receipt.duplicate ? 'Скаргу вже передано' : 'Скаргу надіслано' : 'Поскаржитися'} busy={saving} onClose={close}>
    {receipt ? <div className="space-y-4">
      <CheckCircle2 size={36} className="text-primary" aria-hidden="true" />
      <div role="status" className="space-y-2 text-sm leading-relaxed">
        <p className="font-medium">{receipt.duplicate ? 'Таке звернення вже є в команди модерації. Повторну скаргу не створено.' : 'Дякуємо, звернення передано команді модерації.'}</p>
        <p className="text-muted-foreground">Ми перевіримо обставини. Подання скарги не означає автоматичного блокування акаунта.</p>
      </div>
      <button ref={successAction} type="button" onClick={close} className={`${chatPrimary} w-full`}>Зрозуміло</button>
    </div> : <form ref={reportForm} onSubmit={(event) => void submit(event)} aria-busy={saving} className="space-y-4">
      <div className="space-y-2 text-sm leading-relaxed">
        <p className="break-words [overflow-wrap:anywhere]">Профіль: <span className="font-medium">{targetName || 'Учасник Xelay'}</span></p>
        <p className="text-muted-foreground">Скаргу побачить лише команда модерації. Опишіть конкретне порушення, щоб ми могли його перевірити.</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={targetId} className="block text-sm font-medium">На що ви скаржитеся?</label>
        <select id={targetId} value={targetKind} disabled={saving} required className={fieldClass} onChange={(event) => { setTargetKind(event.target.value as ProfileReportTargetKind); setError(''); setInvalidField(null) }}>
          {PROFILE_REPORT_TARGETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <p className="text-xs leading-relaxed text-muted-foreground">Профіль — ім’я, фото чи інші дані. Статус — текст або емодзі біля ніку.</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={reasonId} className="block text-sm font-medium">Причина <span className="text-destructive">*</span></label>
        <select ref={reasonControl} id={reasonId} value={reason} disabled={saving} required className={fieldClass} aria-invalid={invalidField === 'reason' || undefined} aria-describedby={invalidField === 'reason' ? errorId : undefined} onChange={(event) => { setReason(event.target.value as ProfileReportReason | ''); setError(''); setInvalidField(null) }}>
          <option value="">Оберіть причину</option>
          {PROFILE_REPORT_REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={detailsId} className="block text-sm font-medium">Що сталося? <span className="text-destructive">*</span></label>
        <textarea ref={detailsControl} id={detailsId} value={details} disabled={saving} required minLength={PROFILE_REPORT_DETAILS_MIN} maxLength={PROFILE_REPORT_DETAILS_MAX} rows={5} className={`${fieldClass} min-h-32 resize-y`} aria-invalid={invalidField === 'details' || undefined} aria-describedby={`${hintId}${invalidField === 'details' ? ` ${errorId}` : ''}`} placeholder="Опишіть, що саме порушує правила. Не додавайте паролі чи інші зайві приватні дані." onChange={(event) => { setDetails(event.target.value); setError(''); setInvalidField(null) }} />
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">Від {PROFILE_REPORT_DETAILS_MIN} до {PROFILE_REPORT_DETAILS_MAX} символів · {detailsLength}/{PROFILE_REPORT_DETAILS_MAX}</p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">Переглянути <a href="/community-rules" target="_blank" rel="noopener noreferrer" className="rounded-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">правила спільноти<span className="sr-only"> (відкриється в новій вкладці)</span></a>. Команда розглядає звернення окремо; скарга не спричиняє автоматичного блокування.</p>
      {error && <p id={errorId} role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={close} disabled={saving} className={chatButton}>Скасувати</button>
        <button type="submit" disabled={saving || !reason || Boolean(detailsError)} className={chatPrimary}>{saving ? <Loader2 size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Flag size={16} aria-hidden="true" />}{saving ? 'Надсилаємо…' : error ? 'Повторити надсилання' : 'Надіслати скаргу'}</button>
      </div>
    </form>}
  </ChatDialog>
}
