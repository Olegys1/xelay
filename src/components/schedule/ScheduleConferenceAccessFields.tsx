import { SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH } from '../../lib/studyGroupLinks'

type Access = { conference_id: string; conference_access_code: string }

export function ScheduleConferenceAccessFields({ value, onChange, inputClass = '', compact = false }: {
  value: Access; onChange: (patch: Partial<Access>) => void; inputClass?: string; compact?: boolean
}) {
  const style = inputClass || 'mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base'
  return <fieldset className={compact ? 'space-y-2' : 'space-y-3 sm:col-span-2'}>
    <legend className="text-sm font-medium">Вхід за ID та кодом <span className="font-normal text-muted-foreground">(необов’язково)</span></legend>
    <p className="text-xs font-normal leading-relaxed text-muted-foreground">Можна додати без посилання. Студенти зможуть скопіювати дані та приєднатися у застосунку конференції.</p>
    <div className={compact ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2'}>
      <label className="block min-w-0 text-sm font-medium">ID конференції<input type="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH} value={value.conference_id} onChange={event => onChange({ conference_id: event.target.value })} placeholder="Наприклад, 123 456 7890" className={style} /></label>
      <label className="block min-w-0 text-sm font-medium">Код доступу<input type="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={SCHEDULE_CONFERENCE_FIELD_MAX_LENGTH} value={value.conference_access_code} onChange={event => onChange({ conference_access_code: event.target.value })} placeholder="Код або пароль конференції" className={style} /></label>
    </div>
  </fieldset>
}
