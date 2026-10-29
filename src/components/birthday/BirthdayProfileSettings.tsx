import { useId } from 'react'
import { Check, Gift, LoaderCircle, LockKeyhole, Trash2, Users } from 'lucide-react'
import './birthdayProfile.css'

export interface BirthdayProfileValue { day: number | null; month: number | null; showToGroup: boolean }
export interface BirthdayProfileSettingsProps {
  value: BirthdayProfileValue
  onChange: (value: BirthdayProfileValue) => void
  onSave?: () => void | Promise<void>
  onRemove?: () => void | Promise<void>
  loading?: boolean
  saving?: boolean
  error?: string
  saved?: boolean
}
const MONTHS = ['Січня', 'Лютого', 'Березня', 'Квітня', 'Травня', 'Червня', 'Липня', 'Серпня', 'Вересня', 'Жовтня', 'Листопада', 'Грудня']
const monthDays = (month: number | null) => month === 2 ? 29 : month && [4, 6, 9, 11].includes(month) ? 30 : 31

/** Controlled fields only. The application owns validation, loading and saving. */
export function BirthdayProfileSettings({ value, onChange, onSave, onRemove, loading = false, saving = false, error, saved = false }: BirthdayProfileSettingsProps) {
  const id = useId()
  const complete = Boolean(value.day && value.month && Number.isInteger(value.day) && Number.isInteger(value.month) && value.month >= 1 && value.month <= 12 && value.day >= 1 && value.day <= monthDays(value.month))
  return <section className="bp-settings" aria-labelledby={`${id}-heading`} aria-busy={loading || saving}>
    <header className="bp-settings-heading"><span className="bp-settings-icon"><Gift size={21} strokeWidth={1.6} aria-hidden="true" /></span><div><h3 id={`${id}-heading`}>Твій особливий день</h3><p>Залиш дату, а ми подбаємо про маленький сюрприз.</p></div><span className="bp-optional">Необов’язково</span></header>
    {loading ? <div className="bp-loading" role="status"><LoaderCircle size={17} className="bp-spinner" aria-hidden="true" />Завантажуємо налаштування…</div> : <>
      <fieldset className="bp-date-fields" disabled={saving}><legend className="bp-sr-only">День народження</legend><label htmlFor={`${id}-day`}>День<select id={`${id}-day`} value={value.day ?? ''} aria-describedby={`${id}-privacy`} onChange={event => onChange({ ...value, day: event.target.value ? Number(event.target.value) : null })}><option value="">Обери день</option>{Array.from({ length: monthDays(value.month) }, (_, day) => <option key={day + 1} value={day + 1}>{day + 1}</option>)}</select></label><label htmlFor={`${id}-month`}>Місяць<select id={`${id}-month`} value={value.month ?? ''} aria-describedby={`${id}-privacy`} onChange={event => { const month = event.target.value ? Number(event.target.value) : null; onChange({ ...value, month, day: value.day && value.day > monthDays(month) ? null : value.day }) }}><option value="">Обери місяць</option>{MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label></fieldset>
      <p className="bp-privacy-note" id={`${id}-privacy`}><LockKeyhole size={13} aria-hidden="true" />Лише день і місяць. Рік народження та вік не запитуємо.</p>
      {value.day === 29 && value.month === 2 && <p className="bp-leap-note">У роки без 29 лютого привітаємо тебе 28 лютого.</p>}
      <label className={`bp-visibility ${value.showToGroup ? 'bp-visibility--on' : ''}`}><span className="bp-visibility-icon"><Users size={18} strokeWidth={1.6} aria-hidden="true" /></span><span className="bp-visibility-copy"><strong>Дозволити одногрупникам привітати мене</strong><span>Показувати день народження лише в моїх навчальних групах.</span></span><input type="checkbox" checked={value.showToGroup} disabled={saving} onChange={event => onChange({ ...value, showToGroup: event.target.checked })} /><span className="bp-toggle" aria-hidden="true"><span /></span></label>
      <div className="bp-gift-footnote"><span className="bp-small-spark" aria-hidden="true">✦</span><p>Щороку у свій день народження можна забрати <strong>місяць «Учасника»</strong> від Xelay. Видимість для групи на подарунок не впливає.</p></div>
      {error && <p className="bp-error" role="alert">{error}</p>}
      {onSave && <p className="bp-save-note">Дата та видимість зберігаються кнопкою «Зберегти дату».</p>}
      {(onSave || onRemove || saved) && <div className="bp-settings-actions">{onSave && <button type="button" className="bp-primary" disabled={saving || !complete} onClick={() => { void onSave() }}>{saving ? <><LoaderCircle size={15} className="bp-spinner" aria-hidden="true" />Зберігаємо…</> : <>Зберегти дату<Check size={15} aria-hidden="true" /></>}</button>}{saved && !saving && !error && <span className="bp-saved" role="status"><Check size={14} aria-hidden="true" />Збережено</span>}{onRemove && <button type="button" className="bp-remove" disabled={saving} onClick={() => { void onRemove() }}><Trash2 size={14} aria-hidden="true" />Видалити дату</button>}</div>}
    </>}
  </section>
}
