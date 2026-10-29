import { useId } from 'react'
import type { AssignmentDeadlineMode } from '../../lib/teachingAssignmentDeadline'
import { TeachingField, teachingInput } from './TeachingUI'

export function TeachingAssignmentDeadlineFields({ mode, deadline, onMode, onDeadline, disabled = false, name = 'assignment', min, max }: {
  mode: AssignmentDeadlineMode; deadline: string; onMode: (mode: AssignmentDeadlineMode) => void;
  onDeadline: (value: string) => void; disabled?: boolean; name?: string; min?: string; max?: string;
}) {
  const hintId = useId()
  return <fieldset className="space-y-3 rounded-xl border border-border p-4" disabled={disabled} aria-describedby={mode === 'free' ? hintId : undefined}>
    <legend className="px-1 text-sm font-semibold">Термін здачі</legend>
    <div className="flex flex-wrap gap-x-5 gap-y-3">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name={`${name}-deadline-mode`} value="fixed" checked={mode === 'fixed'} onChange={() => onMode('fixed')} />Визначена дата</label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name={`${name}-deadline-mode`} value="free" checked={mode === 'free'} onChange={() => onMode('free')} />Вільний термін здачі</label>
    </div>
    {mode === 'fixed' ? <TeachingField label="Дата й час здачі" hint="За київським часом. Для публікації оберіть дату або перемкніть на вільний термін."><input name={`${name}-deadline`} type="datetime-local" className={teachingInput} value={deadline} min={min} max={max} onChange={event => onDeadline(event.target.value)} /></TeachingField>
      : <p id={hintId} role="status" className="text-xs leading-relaxed text-muted-foreground">Студенти зможуть здати роботу без фіксованої дати. Остаточне закриття приймання, якщо потрібне, налаштовується окремо.</p>}
  </fieldset>
}
