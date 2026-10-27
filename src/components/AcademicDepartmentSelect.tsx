import { useState } from 'react'
import type { AcademicDepartment } from '../lib/academicDepartments'

type Props = {
  id: string; name?: string; value: string; onChange(value: string): void
  options: AcademicDepartment[]; disabled?: boolean; required?: boolean; invalid?: boolean
}
export function AcademicDepartmentSelect({ id, name, value, onChange, options, disabled, required, invalid }: Props) {
  const [query, setQuery] = useState('')
  const filtered = options.filter(option => option.name.toLocaleLowerCase('uk-UA').includes(query.trim().toLocaleLowerCase('uk-UA')))
  const legacy = Boolean(value && !options.some(option => option.name === value))
  const input = `min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-60 ${invalid ? 'xelay-field-invalid' : ''}`
  return <div className="space-y-1.5" data-academic-department>
    <label htmlFor={id} className="block text-sm font-medium">Кафедра {required && <span className="text-destructive">*</span>}</label>
    {options.length ? <>
      <input type="search" aria-label="Знайти кафедру" value={query} onChange={event => setQuery(event.target.value)} placeholder="Пошук кафедри…" disabled={disabled} className={input} />
      <select id={id} name={name} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} required={required} aria-invalid={invalid || undefined} className={input}>
        <option value="">Оберіть кафедру</option>
        {legacy && <option value={value}>Збережена кафедра: {value}</option>}
        {options.filter(option => option.name === value || filtered.includes(option)).map(option => <option key={option.slug} value={option.name}>{option.name}</option>)}
      </select>
      {!filtered.length && <p role="status" className="text-xs text-muted-foreground">За цим запитом кафедр не знайдено. Змініть пошук.</p>}
      <p className="text-xs leading-relaxed text-muted-foreground">{options.length} кафедр вашого факультету · <a href={options[0].source_url} target="_blank" rel="noopener noreferrer" className="underline">офіційний список</a>.</p>
    </> : <>
      <input id={id} name={name} value={value} onChange={event => onChange(event.target.value)} maxLength={180} required={required} disabled={disabled} aria-invalid={invalid || undefined} className={input} placeholder="Назва вашої кафедри" />
      <p className="text-xs leading-relaxed text-muted-foreground">Для цього факультету довідник кафедр ще не додано. Вкажіть повну офіційну назву.</p>
    </>}
  </div>
}
