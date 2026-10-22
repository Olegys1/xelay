import { Clock3, Link2, Plus } from 'lucide-react'
import { useState } from 'react'
import { kyivDeadline, localDeadline, type TeachingPublication } from '../../lib/teaching'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

export const SUBMISSION_FORMATS = [
  { id: 'written', label: 'Письмова робота', description: 'Студент надсилає текст, посилання або файл.' },
  { id: 'oral', label: 'Усна відповідь', description: 'Студент може позначити готовність без файлу. Викладач оцінює відповідь на занятті.' },
  { id: 'defense', label: 'Робота із захистом', description: 'Матеріали можна надіслати заздалегідь або позначити готовність без файлу. Захист проходить на семінарі; викладач може виставити бали до чи після нього.' },
] as const
export type SubmissionFormat = typeof SUBMISSION_FORMATS[number]['id']
export const submissionFormat = (item: Pick<TeachingPublication, 'submission_format'>): SubmissionFormat => item.submission_format === 'oral' || item.submission_format === 'defense' ? item.submission_format : 'written'
export function fiveDaysAfter(deadline: string) {
  const date = new Date(`${deadline.slice(0, 10)}T12:00:00Z`)
  if (!deadline || !Number.isFinite(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + 5)
  return `${date.toISOString().slice(0, 10)}T${deadline.slice(11, 16) || '23:59'}`
}
export function publicationTime(value: string) {
  if (!value) return null
  try { const result = kyivDeadline(value); if (!result || localDeadline(result) !== value.slice(0, 16)) throw new Error(); return result }
  catch { throw new Error('Перевірте дату й час за Києвом. Оберіть коректне значення у календарі.') }
}
export function validatePublicationTiming(mode: 'now' | 'scheduled', publishAt: string, due: string, closes: string) {
  const publish = mode === 'scheduled' ? publicationTime(publishAt) : null
  const dueAt = publicationTime(due)
  const closesAt = publicationTime(closes)
  if (mode === 'scheduled' && (!publish || !Number.isFinite(Date.parse(publish)) || Date.parse(publish) <= Date.now())) throw new Error('Оберіть майбутню дату й час публікації за Києвом.')
  if (due && !dueAt || closes && !closesAt) throw new Error('Перевірте термін здачі та дату завершення приймання.')
  if (dueAt && closesAt && Date.parse(closesAt) < Date.parse(dueAt)) throw new Error('Остаточне закриття не може бути раніше терміну здачі.')
  if (mode === 'scheduled' && publish && (dueAt && Date.parse(dueAt) < Date.parse(publish) || closesAt && Date.parse(closesAt) < Date.parse(publish))) throw new Error('Термін здачі та закриття мають бути після публікації.')
}
export function TeachingPublicationTimingFields({ mode, publishAt, onMode, onPublishAt, disabled = false }: { mode: 'now' | 'scheduled'; publishAt: string; onMode: (value: 'now' | 'scheduled') => void; onPublishAt: (value: string) => void; disabled?: boolean }) {
  return <fieldset className="teaching-note space-y-3" disabled={disabled}><legend className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground"><Clock3 size={16} />Коли опублікувати</legend><div className="flex flex-wrap gap-x-5 gap-y-2"><label className="flex items-center gap-2 text-sm"><input type="radio" name="publication-timing" checked={mode === 'now'} onChange={() => onMode('now')} />Зараз</label><label className="flex items-center gap-2 text-sm"><input type="radio" name="publication-timing" checked={mode === 'scheduled'} onChange={() => onMode('scheduled')} />Пізніше</label></div>{mode === 'scheduled' && <TeachingField label="Дата й час публікації" hint="За київським часом. До цього моменту студенти не бачитимуть публікацію."><input type="datetime-local" name="publication-publish-at" className={teachingInput} value={publishAt} min={localDeadline(new Date().toISOString())} onChange={event => onPublishAt(event.target.value)} disabled={disabled} /></TeachingField>}<p className="text-xs">Заплановані публікації доступні окремою кнопкою «Заплановані» у викладанні.</p></fieldset>
}
export function TeachingClosingFields({ deadline, closesAt, onClosesAt, disabled = false }: { deadline: string; closesAt: string; onClosesAt: (value: string) => void; disabled?: boolean }) {
  return <div className="space-y-2"><TeachingField label="Остаточно закрити приймання · необов’язково" hint="Після цієї дати студент не зможе надіслати нову спробу. Перевірка та виставлення балів залишаються доступними."><input type="datetime-local" name="assignment-closes-at" className={teachingInput} value={closesAt} min={deadline || undefined} onChange={event => onClosesAt(event.target.value)} disabled={disabled} /></TeachingField><div className="flex flex-wrap gap-2"><TeachingButton disabled={disabled || !deadline} onClick={() => onClosesAt(fiveDaysAfter(deadline))}>Доздача протягом 5 днів</TeachingButton>{closesAt && <TeachingButton disabled={disabled} onClick={() => onClosesAt('')}>Без остаточного закриття</TeachingButton>}</div></div>
}
export function TeachingResourceLinkEntry({ disabled = false, onAdd }: { disabled?: boolean; onAdd: (url: string) => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  return <div className="space-y-2 rounded-xl border border-border p-3"><TeachingField label="Google Drive / відео" hint="Вставте посилання на файл, папку чи відео. Доступ налаштовується у сервісі, де зберігається ресурс."><input className={teachingInput} name="publication-resource-url" type="url" value={url} onChange={event => { setUrl(event.target.value); setError('') }} maxLength={2000} placeholder="https://drive.google.com/… або посилання на відео" disabled={disabled} /></TeachingField><TeachingButton disabled={disabled || !url.trim()} onClick={() => {
    try { const parsed = new URL(url.trim()); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); onAdd(parsed.toString()); setUrl(''); setError('') } catch { setError('Вставте коректне посилання, що починається з https:// або http://.') }
  }}><Link2 size={14} /><Plus size={13} />Додати посилання до публікації</TeachingButton>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div>
}
