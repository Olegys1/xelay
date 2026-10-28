import { Archive, ArrowRight, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { groupAcademicYearForDate } from '../lib/studyGroupAcademicYears'
import { groupDateInAcademicYear, groupYearChoices } from '../lib/groupYearNavigation'

type Props = { selectedDate: string; today: string; cohortStartYear?: number | null; createdAt?: string; dates?: string[]; onDateChange: (date: string) => void }

export function GroupAcademicYearPicker({ selectedDate, today, cohortStartYear, createdAt, dates, onDateChange }: Props) {
  const year = groupAcademicYearForDate(selectedDate) ?? groupAcademicYearForDate(today)!
  const current = groupAcademicYearForDate(today)!
  const choices = groupYearChoices({ today, selectedDate, cohortStartYear, createdAt, dates })
  const archived = year < current
  const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40'
  return <section aria-label="Навчальні роки групи" className={`mb-5 min-w-0 rounded-2xl border p-4 sm:p-5 ${archived ? 'border-primary/25 bg-primary/5' : 'border-border bg-card'}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-semibold">{archived ? <Archive size={17} className="text-primary" /> : <CalendarDays size={17} className="text-primary" />}Навчальний рік <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">{archived ? 'Архів' : year === current ? 'Поточний' : 'Майбутній'}</span></p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Розклад, ДЗ, семінари та матеріали вашої групи за обраний рік.</p></div>
      <div className="flex max-w-full items-center gap-1 rounded-xl border border-border bg-background p-1">
        <button type="button" aria-label="Попередній навчальний рік" className={button} disabled={year <= 1900} onClick={() => onDateChange(groupDateInAcademicYear(selectedDate, year - 1))}><ChevronLeft size={17} /></button>
        <label className="min-w-0"><span className="sr-only">Навчальний рік групи</span><select aria-label="Навчальний рік групи" value={year} onChange={event => onDateChange(groupDateInAcademicYear(selectedDate, Number(event.target.value)))} className="min-h-11 max-w-full bg-transparent px-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary/40">{choices.map(value => <option value={value} key={value}>{value} / {value + 1}{value === current ? ' · поточний' : ''}</option>)}</select></label>
        <button type="button" aria-label="Наступний навчальний рік" className={button} disabled={year >= 2199} onClick={() => onDateChange(groupDateInAcademicYear(selectedDate, year + 1))}><ChevronRight size={17} /></button>
      </div>
    </div>
    {archived && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-primary/15 pt-3"><p role="status" className="max-w-2xl text-xs leading-relaxed text-muted-foreground">Ви переглядаєте збережені записи за {year} / {year + 1} рік. Архів доступний для перегляду; файли відкриваються за дозволами автора. Уже видалені матеріали тут не відновлюються.</p><button type="button" onClick={() => onDateChange(today)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-background px-4 text-xs font-semibold text-primary hover:bg-muted">До поточного року<ArrowRight size={15} /></button></div>}
  </section>
}
