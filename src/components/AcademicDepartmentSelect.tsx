import type { AcademicDepartment } from '../lib/academicDepartments'

type Props = {
  id: string; name?: string; value: string; onChange(value: string): void
  options: AcademicDepartment[]; disabled?: boolean; required?: boolean; invalid?: boolean
}
export function AcademicDepartmentSelect({ id, name, value, onChange, options, disabled, required, invalid }: Props) {
  const legacy = Boolean(value && !options.some(option => option.name === value))
  const input = `min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-60 ${invalid ? 'xelay-field-invalid' : ''}`
  return <div className="space-y-1.5" data-academic-department>
    <label htmlFor={id} className="block text-sm font-medium">Кафедра {required && <span className="text-destructive">*</span>}</label>
    {options.length ? <>
      <select id={id} name={name} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} required={required} aria-invalid={invalid || undefined} className={input}>
        <option value="">Оберіть кафедру</option>
        {legacy && <option value={value}>Збережена кафедра: {value}</option>}
        {options.map(option => <option key={option.slug} value={option.name}>{option.name}</option>)}
      </select>
      <p className="text-xs leading-relaxed text-muted-foreground">{options.length} кафедр вашого підрозділу · <a href={options[0].source_url} target="_blank" rel="noopener noreferrer" className="underline">офіційний список КНУ</a>.</p>
    </> : <>
      <input id={id} name={name} value={value} onChange={event => onChange(event.target.value)} maxLength={180} required={required} disabled={disabled} aria-invalid={invalid || undefined} className={input} placeholder="Назва вашої кафедри" />
      <p className="text-xs leading-relaxed text-muted-foreground">Для цього підрозділу поки немає підтвердженого довідника кафедр. Вкажіть повну офіційну назву.</p>
    </>}
  </div>
}
