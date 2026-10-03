import { useId } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { AcademicSpecialtySelection } from '../lib/academicSpecialties'

export function AcademicSpecialtySelect({ selection, disabled = false, legacyName, className = '', id: suppliedId, error, onClearError }: {
  selection: AcademicSpecialtySelection
  disabled?: boolean
  legacyName?: string | null
  className?: string
  id?: string
  error?: string
  onClearError?: () => void
}) {
  const generatedId = useId()
  const id = suppliedId || generatedId
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const unavailable = selection.hasScope && !selection.loading && !selection.error && selection.options.length === 0
  return <div className={className}>
    <label className="mb-1.5 block text-sm font-medium text-foreground" htmlFor={id}>Освітня програма <span className="text-destructive">*</span></label>
    <select id={id} value={selection.value} onChange={(event) => { selection.choose(event.target.value); onClearError?.() }} required
      disabled={disabled || !selection.hasScope || selection.loading || Boolean(selection.error) || unavailable}
      aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`} aria-invalid={Boolean(error || selection.error) || undefined}
      className={`w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 ${error ? 'xelay-field-invalid' : ''}`}>
      <option value="">{selection.loading ? 'Завантажуємо освітні програми…' : 'Оберіть освітню програму'}</option>
      {selection.options.map((program) => <option key={program.id} value={program.id}>{program.name}{program.code || program.specialty_name ? ` · ${[program.code, program.specialty_name].filter(Boolean).join(' — ')}` : ''}</option>)}
    </select>
    {error && <p id={errorId} className="xelay-inline-feedback mt-1.5 text-xs text-destructive">{error}</p>}
    <div id={hintId} className="mt-1.5 space-y-1 text-xs text-muted-foreground">
      {!selection.hasScope && <p>Спочатку оберіть університет і факультет або інститут.</p>}
      {selection.loading && <p role="status" className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />Завантаження списку…</p>}
      {selection.error && <p role="alert" className="text-destructive">{selection.error}</p>}
      {unavailable && <p role="status">Для цього факультету ще немає доступних освітніх програм. Оновіть список або зверніться до підтримки.</p>}
      {legacyName?.trim() && !selection.selected && !selection.loading && <p>Раніше у профілі: «{legacyName.trim()}». Оберіть відповідну освітню програму зі списку.</p>}
      {selection.selected && <p>{[selection.selected.code, selection.selected.specialty_name].filter(Boolean).join(' · ')}</p>}
    </div>
    {(selection.error || unavailable) && <button type="button" onClick={selection.retry} disabled={disabled || selection.loading} className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-primary hover:bg-muted disabled:opacity-50"><RefreshCw size={13} />Оновити список</button>}
  </div>
}
