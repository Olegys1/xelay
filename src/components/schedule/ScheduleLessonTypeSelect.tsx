import { LESSON_TYPES, type LessonType } from '../../lib/studyGroupTimetable'

export function ScheduleLessonTypeSelect({ lessonType, elective, onChange }: { lessonType: LessonType; elective: boolean; onChange(lessonType: LessonType, elective: boolean): void }) {
  return <label className="text-sm font-medium">Тип заняття<select value={elective ? 'elective' : lessonType} onChange={event => onChange(event.target.value === 'elective' ? 'other' : event.target.value as LessonType, event.target.value === 'elective')} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">{Object.entries(LESSON_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="elective">Вибіркові дисципліни</option></select>{elective && <span className="mt-1.5 block text-xs font-normal text-muted-foreground">Кожен студент зможе вказати свої предмети й час. Загальний блок буде замінений лише в його розкладі.</span>}</label>
}
