import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import type { ReferralCampaign, ReferralCampaignState, ReferralGroupState, ReferralPrize } from '../../lib/groupReferralTypes'

export const referralCampaignLabels: Record<ReferralCampaignState, string> = { draft: 'Готуємо запуск', open: 'Приймаємо групи', frozen: 'Учасників зафіксовано', drawn: 'Результати готуються', published: 'Переможців оголошено', cancelled: 'Акцію скасовано' }
export function referralCampaignDisplayLabel(campaign: ReferralCampaign | null | undefined, now: number): string {
  if (!campaign || campaign.state === 'draft') return referralCampaignLabels.draft
  if (campaign.state !== 'open') return referralCampaignLabels[campaign.state]
  if (campaign.startsAt && now < Date.parse(campaign.startsAt)) return 'Незабаром'
  if (campaign.qualifiesUntil && now > Date.parse(campaign.qualifiesUntil)) return 'Очікуємо розіграшу'
  if (campaign.joinsUntil && now > Date.parse(campaign.joinsUntil)) return 'Групи виконують умови'
  return referralCampaignLabels.open
}
export const referralGroupLabels: Record<ReferralGroupState, string> = { collecting: 'Виконуємо умови', pending: 'На перевірці', approved: 'Групу підтверджено', rejected: 'Потрібні уточнення' }
export const referralInterviewLabels = { pending: 'Ще не узгоджено', invited: 'Запрошення підготовлено', declined: 'Участь відхилено', completed: 'Інтерв’ю відбулося' }
export function referralCount(value: number, forms: readonly [string, string, string]) { const n = Math.abs(value) % 100, last = n % 10; return `${value} ${n >= 11 && n <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2]}` }
export function referralTimeRemaining(deadline: string, now: number): string {
  const remaining = Date.parse(deadline) - now
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Час вичерпано'
  const minutes = Math.ceil(remaining / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60)
  if (days > 0) return `${referralCount(days, ['день', 'дні', 'днів'])} ${referralCount(hours, ['година', 'години', 'годин'])}`
  if (hours > 0) return `${referralCount(hours, ['година', 'години', 'годин'])} ${referralCount(minutes % 60, ['хвилина', 'хвилини', 'хвилин'])}`
  return referralCount(minutes, ['хвилина', 'хвилини', 'хвилин'])
}
export function referralPrizeTerm(prize: ReferralPrize) { return prize.months === null ? 'Строк уточнюється' : referralCount(prize.months, ['місяць', 'місяці', 'місяців']) }
export function referralDate(value: string | null | undefined, withTime = true) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Дату уточнюємо'
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value))
}
export function referralKyivInput(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
  const part = (type: string) => parts.find(item => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}
export function referralKyivIso(value: string): string | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('Оберіть коректну дату й час за Києвом.')
  const [, year, month, day, hour, minute] = match.map(Number)
  const base = Date.UTC(year, month - 1, day, hour, minute)
  const matches: string[] = []
  for (let offset = -14; offset <= 14; offset++) { const date = new Date(base - offset * 3_600_000).toISOString(); if (referralKyivInput(date) === value) matches.push(date) }
  if (matches.length !== 1) throw new Error('Цей час припадає на переведення годинника або не існує. Оберіть інший час за Києвом.')
  return matches[0]
}
export function referralSafeLink(path: string, origin: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(path)) return null
  try { const url = new URL(path, origin); return url.origin === origin ? url.href : null } catch { return null }
}
export function ReferralButton({ children, primary, busy, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; busy?: boolean; children: ReactNode }) {
  return <button type="button" {...props} disabled={props.disabled || busy} className={`gr-button ${primary ? 'gr-button-primary' : 'gr-button-outline'} ${className}`} aria-busy={busy || undefined}>{busy && <Loader2 size={16} className="gr-spin" />}{children}</button>
}
export function ReferralConfirmDialog({ title, text, busy, onConfirm, onClose, children, confirmDisabled = false }: { title: string; text: string; busy: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode; confirmDisabled?: boolean }) {
  const id = useId(), dialog = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; cancel.current?.focus(); return () => { if (previous?.isConnected) previous.focus() } }, [])
  return <div className="gr-modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}><div ref={dialog} className="gr-modal" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
    if (event.key !== 'Tab') return
    const controls = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') || []]
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}><div className="gr-modal-heading"><h2 id={`${id}-title`}>{title}</h2><button type="button" className="gr-icon-button" disabled={busy} onClick={onClose} aria-label="Закрити підтвердження"><X size={19} /></button></div><p id={`${id}-text`}>{text}</p>{children}<div className="gr-actions"><button ref={cancel} type="button" className="gr-button gr-button-outline" disabled={busy} onClick={onClose}>Повернутися</button><ReferralButton primary busy={busy} disabled={confirmDisabled} onClick={onConfirm}>Підтвердити</ReferralButton></div></div></div>
}
