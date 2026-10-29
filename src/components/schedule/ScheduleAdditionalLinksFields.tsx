import { Plus, Trash2 } from 'lucide-react'
import { STUDY_GROUP_EXTRA_LINK_MAX_COUNT, STUDY_GROUP_LESSON_LINK_MAX_COUNT, STUDY_GROUP_LINK_LABEL_MAX_LENGTH, type ScheduleExtraLink } from '../../lib/studyGroupLinks'

export function ScheduleAdditionalLinksFields({ links, onChange, disabled = false, inputClass = 'mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base' }: {
  links: ScheduleExtraLink[]; onChange: (links: ScheduleExtraLink[]) => void; disabled?: boolean; inputClass?: string
}) {
  return <div className="space-y-3 sm:col-span-2">
    {links.map((link, index) => <div key={index} className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2"><strong className="text-sm">Посилання {index + 3}</strong><button type="button" disabled={disabled} onClick={() => onChange(links.filter((_, row) => row !== index))} aria-label={`Прибрати посилання ${index + 3}`} className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"><Trash2 size={15} aria-hidden="true" /></button></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm font-medium">Адреса<input disabled={disabled} type="url" inputMode="url" autoCapitalize="none" spellCheck={false} value={link.url} maxLength={2000} onChange={event => onChange(links.map((row, at) => at === index ? { ...row, url: event.target.value } : row))} className={inputClass} placeholder="https://…" /></label>
      <label className="min-w-0 text-sm font-medium">Назва <span className="font-normal text-muted-foreground">(необов’язково)</span><input disabled={disabled} value={link.label} maxLength={STUDY_GROUP_LINK_LABEL_MAX_LENGTH} onChange={event => onChange(links.map((row, at) => at === index ? { ...row, label: event.target.value } : row))} className={inputClass} placeholder="Наприклад, Резервний Zoom" /></label></div>
    </div>)}
    <button type="button" disabled={disabled || links.length >= STUDY_GROUP_EXTRA_LINK_MAX_COUNT} onClick={() => onChange([...links, { url: '', label: '' }])} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/30 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50"><Plus size={16} aria-hidden="true" />Додати посилання</button>
    <p className="text-xs leading-relaxed text-muted-foreground">Основні посилання залишаються першими. За потреби додавайте ще, до {STUDY_GROUP_LESSON_LINK_MAX_COUNT} на одне заняття.</p>
  </div>
}
