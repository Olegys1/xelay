import { useEffect, useMemo, useRef, useState } from 'react'
import type { TeachingDirectoryGroup } from '../../lib/teaching'
import { emptyTeachingGroupFilters, teachingGroupDirectoryFullLabel, teachingGroupDirectoryLabel, teachingGroupIdentityReady,
  teachingGroupMatchesFilters, teachingGroupProgramOptions, type TeachingGroupDirectoryFilters } from '../../lib/teachingGroupDirectory'
import { TeachingField, teachingInput } from './TeachingUI'
const levelLabels: Record<string, string> = { bachelor: 'Бакалавр', master: 'Магістр', postgraduate: 'Аспірантура' }

export function TeachingGroupDirectoryPicker({ groups, groupId, disabled = false, onSelect }: {
  groups: TeachingDirectoryGroup[]; groupId: string; disabled?: boolean; onSelect: (id: string) => void
}) {
  const [filters, setFilters] = useState(emptyTeachingGroupFilters)
  const callback = useRef(onSelect); callback.current = onSelect
  const programs = useMemo(() => teachingGroupProgramOptions(groups), [groups])
  const visible = useMemo(() => groups.filter(group => teachingGroupMatchesFilters(group, filters))
    .sort((a, b) => Number(teachingGroupIdentityReady(b)) - Number(teachingGroupIdentityReady(a)) || a.group_name.localeCompare(b.group_name, 'uk-UA') || Number(a.study_year) - Number(b.study_year)), [groups, filters])
  const ready = visible.filter(teachingGroupIdentityReady), waiting = visible.filter(group => !teachingGroupIdentityReady(group))
  const selected = ready.find(group => group.id === groupId)
  // A removed target or a changed filter must never leave a hidden selection.
  useEffect(() => { if (groupId && !selected) callback.current('') }, [groupId, selected?.id])
  function filter(next: Partial<TeachingGroupDirectoryFilters>) {
    if (disabled) return
    const combined = { ...filters, ...next }; setFilters(combined)
    if (groupId && !groups.some(group => group.id === groupId && teachingGroupIdentityReady(group) && teachingGroupMatchesFilters(group, combined))) onSelect('')
  }
  const active = Object.values(filters).some(Boolean)
  return <section aria-label="Пошук навчальної групи" className="space-y-4">
    <TeachingField label="Знайти групу" hint="Наприклад: ЕУБ 1 курс, ЕБ 2, ЕУБ-4 або прізвище старости. ЕБ і ЕУБ знаходяться разом лише в програмах економфаку КНУ.">
      <input name="group-directory-search" type="search" className={teachingInput} value={filters.query} onChange={event => filter({ query: event.target.value })}
        disabled={disabled} placeholder="ОП, курс, назва групи або староста" autoComplete="off" />
    </TeachingField>
    <div className="grid gap-3 sm:grid-cols-2">
      <TeachingField label="Освітня програма"><select name="group-directory-program" className={teachingInput} value={filters.program} disabled={disabled}
        onChange={event => filter({ program: event.target.value })}><option value="">Усі ОП</option>{programs.map(program => <option key={program.value} value={program.value}>{program.label}</option>)}</select></TeachingField>
      <TeachingField label="Курс групи"><select name="group-directory-course" className={teachingInput} value={filters.course} disabled={disabled}
        onChange={event => filter({ course: event.target.value })}><option value="">Усі курси</option>{[1, 2, 3, 4, 5, 6].map(course => <option key={course} value={course}>{course} курс</option>)}</select></TeachingField>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-48 flex-1"><TeachingField label="Рівень навчання"><select name="group-directory-level" className={teachingInput} value={filters.level} disabled={disabled}
        onChange={event => filter({ level: event.target.value })}><option value="">Усі рівні</option><option value="bachelor">Бакалавр</option><option value="master">Магістр</option><option value="postgraduate">Аспірантура</option></select></TeachingField></div>
      {active && <button type="button" disabled={disabled} className="min-h-10 rounded-full border border-border px-4 py-2 text-sm" onClick={() => filter(emptyTeachingGroupFilters())}>Скинути фільтри</button>}
    </div>
    <p className="teaching-note" role="status">Знайдено груп: {ready.length}{waiting.length ? ` · Потребують уточнення: ${waiting.length}` : ''}</p>
    <TeachingField label="Навчальна група" hint="ЕФ означає економічний факультет, бак. це бакалавр, маг. це магістр. Староста й курс вказані для кожної групи.">
      <select name="group" className={teachingInput} required value={selected?.id || ''} disabled={disabled || !ready.length}
        onChange={event => { if (disabled) return; if (ready.some(group => group.id === event.target.value)) onSelect(event.target.value); else onSelect('') }}>
        <option value="">{ready.length ? 'Оберіть групу зі списку' : 'Немає доступних груп за цими фільтрами'}</option>
        {ready.map(group => <option key={group.id} value={group.id} title={teachingGroupDirectoryFullLabel(group)}>{teachingGroupDirectoryLabel(group)}</option>)}
        {!!waiting.length && <optgroup label="Старості потрібно уточнити курс">{waiting.map(group => <option key={group.id} value={group.id} disabled>{teachingGroupDirectoryLabel(group)}</option>)}</optgroup>}
      </select>
    </TeachingField>
    {!ready.length && !!groups.length && <p className="teaching-note">Спробуйте іншу ОП або скиньте фільтри. Групи без підтвердженого курсу стануть доступні після уточнення старостою.</p>}
    {selected && <div className="rounded-xl border border-border bg-muted/30 p-4" role="status" aria-label="Вибрана група">
      <p className="font-semibold">{selected.group_name} · {selected.study_year} курс</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Освітня програма</dt><dd>{selected.specialty || 'Не вказана'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Факультет або інститут</dt><dd>{selected.academic_unit_name || 'Не вказаний'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Староста</dt><dd>{selected.representative_name || 'Не вказаний'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Рівень навчання</dt><dd>{levelLabels[selected.study_level || ''] || 'Не вказаний'}</dd></div>
      </dl>
    </div>}
  </section>
}
