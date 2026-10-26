import { Phone } from 'lucide-react'
import { normalizeTeacherVerificationContact, type TeacherVerificationContact as Contact, type TeacherVerificationContactSnapshot } from '../lib/teacherVerificationContact'
import { TelegramContact } from './TelegramContact'

export function TeacherVerificationContactField({ id, value, onChange, disabled = false, reusableValue = '' }: {
  id: string; value: Contact; onChange(value: Contact): void; disabled?: boolean; reusableValue?: string
}) {
  const telegram = value.kind === 'telegram'
  const helpId = `${id}-help`
  const inputClass = 'mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-60'
  return <fieldset className="space-y-3 rounded-2xl border border-border bg-background p-4">
    <legend className="px-1 text-sm font-semibold">Контакт для перевірки <span className="text-destructive" aria-hidden="true">*</span></legend>
    <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">Вкажіть Telegram або телефон, щоб адміністрація Xelay могла зв’язатися з вами щодо заявки. Контакт бачать лише ви та адміністратори; у профілі та групах він не публікується.</p>
    <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
      <label htmlFor={`${id}-kind`} className="block text-sm font-medium">Спосіб зв’язку<select id={`${id}-kind`} name="teacher-verification-contact-kind" className={inputClass} disabled={disabled} value={value.kind} onChange={event => onChange({ kind: event.target.value as Contact['kind'], value: '' })}><option value="telegram">Telegram</option><option value="phone">Телефон</option></select></label>
      <label htmlFor={`${id}-value`} className="block text-sm font-medium">{telegram ? 'Telegram-нік' : 'Номер телефону'}<input id={`${id}-value`} name="teacher-verification-contact" type={telegram ? 'text' : 'tel'} inputMode={telegram ? 'text' : 'tel'} autoComplete="off" autoCapitalize="none" spellCheck={false} required aria-describedby={helpId} value={value.value} onChange={event => onChange({ ...value, value: event.target.value })} disabled={disabled} maxLength={telegram ? 128 : 40} className={inputClass} placeholder={telegram ? '@username або t.me/username' : '+380…'} /></label>
    </div>
    {!telegram && <p className="text-xs leading-relaxed text-muted-foreground">Телефон із кодом країни, наприклад +380…</p>}
    {reusableValue.trim() && reusableValue.trim() !== value.value.trim() && <button type="button" disabled={disabled} onClick={() => onChange({ ...value, value: reusableValue })} className="min-h-9 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50">Використати {telegram ? 'Telegram' : 'телефон'} із налаштувань</button>}
  </fieldset>
}

export function TeacherVerificationContactDetails({ request }: { request: TeacherVerificationContactSnapshot }) {
  const telegram = request.contact_telegram?.trim() || ''
  const phone = request.contact_phone?.trim() || ''
  const validPhone = normalizeTeacherVerificationContact({ kind: 'phone', value: phone })
  return <div className="rounded-xl border border-border bg-background p-3">
    <p className="text-xs font-medium text-muted-foreground">Контакт для перевірки · приватно</p>
    {telegram && <TelegramContact value={telegram} />}
    {phone && <div className="mt-2 text-sm">{validPhone ? <a href={`tel:${validPhone.value.replace(/[^\d+]/g, '')}`} className="inline-flex min-h-10 items-center gap-2 break-all font-medium text-primary hover:underline"><Phone size={15} className="shrink-0" aria-hidden="true" />{phone}</a> : <p className="select-text break-all">Телефон: {phone.slice(0, 40)}</p>}</div>}
    {!telegram && !phone && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">У цій заявці контакт для перевірки не вказано.</p>}
  </div>
}
