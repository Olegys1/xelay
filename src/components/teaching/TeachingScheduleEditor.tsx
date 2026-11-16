import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Link2, Pencil, Send, X } from 'lucide-react'
import { kyivToday } from '../../lib/seminars'
import { teachingDate, teachingError, type TeachingCalendarLesson, type TeachingRepository } from '../../lib/teaching'
import type { TeachingScheduleChange, TeachingScheduleLinks } from '../../lib/teachingSchedule'
import { ScheduleAdditionalLinksFields } from '../schedule/ScheduleAdditionalLinksFields'
import { ScheduleConferenceAccessFields } from '../schedule/ScheduleConferenceAccessFields'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

export function TeachingScheduleEditor({ lesson, repository, userId, disabled, onSaved }: {
  lesson: TeachingCalendarLesson; repository: TeachingRepository; userId: string; disabled: boolean; onSaved: () => Promise<void>
}) {
  const [mode, setMode] = useState<'links' | 'change' | null>(null)
  const [links, setLinks] = useState<TeachingScheduleLinks>(() => ({ online_url: lesson.online_url || null, online_url_secondary: lesson.online_url_secondary || null, online_url_label: lesson.online_url_label || null, online_url_secondary_label: lesson.online_url_secondary_label || null, online_links_extra: lesson.online_links_extra || [], conference_id: lesson.conference_id || null, conference_access_code: lesson.conference_access_code || null }))
  const [change, setChange] = useState<TeachingScheduleChange>(() => ({ kind: 'move', date: lesson.lesson_date, starts_at: lesson.starts_at.slice(0, 5), ends_at: lesson.ends_at.slice(0, 5), reason: '' }))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const scopeKey = `${userId}:${lesson.course_id}:${lesson.group_id}:${lesson.id}:${lesson.lesson_date}:${lesson.schedule_updated_at || ''}`
  const scope = useRef({ repository, key: scopeKey })
  scope.current = { repository, key: scopeKey }
  const pending = useRef(false), alive = useRef(true)
  const isCurrent = () => alive.current && scope.current.repository === repository && scope.current.key === scopeKey
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  if (!lesson.can_edit_schedule || !lesson.schedule_updated_at || lesson.source !== 'timetable' || !repository.saveScheduleLinks || !repository.requestScheduleChange) return null
  const future = lesson.lesson_date >= kyivToday()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!isCurrent() || pending.current || disabled || !mode) return
    pending.current = true; setBusy(true); setError(''); setSuccess('')
    try {
      if (mode === 'links') await repository.saveScheduleLinks!(lesson, links, userId)
      else await repository.requestScheduleChange!(lesson, change.kind === 'cancel' ? { kind: 'cancel', reason: change.reason } : change, userId)
      if (!isCurrent()) return
      setSuccess(mode === 'links' ? 'Посилання оновлено в розкладі групи та у вашому календарі.' : 'Запит надіслано. До підтвердження старостою або заступником розклад не зміниться.')
      setMode(null)
      await onSaved()
    } catch (failure) { if (isCurrent()) setError(teachingError(failure)) }
    finally { pending.current = false; if (isCurrent()) setBusy(false) }
  }
  const status = lesson.schedule_change_status
  return <section className="teaching-schedule-editor mt-3 rounded-xl border border-primary/15 p-3" aria-label={`Зміни заняття ${lesson.subject_name}`}>
    <div className="flex flex-wrap gap-2"><TeachingButton disabled={busy || disabled} onClick={() => { setMode(mode === 'links' ? null : 'links'); setError(''); setSuccess('') }}><Link2 size={15} />Змінити посилання</TeachingButton><TeachingButton disabled={busy || disabled || !future || status === 'pending'} onClick={() => { setMode(mode === 'change' ? null : 'change'); setError(''); setSuccess('') }}><Pencil size={15} />Перенести або скасувати</TeachingButton></div>
    {status && <p className="teaching-note mt-2" role="status">{status === 'pending' ? 'Очікує підтвердження старости або заступника.' : status === 'rejected' ? 'Попередню заявку відхилено. Можна надіслати нову.' : status === 'stale' ? 'Після заявки розклад змінився. Перевірте його та створіть нову заявку.' : 'Попередню заявку підтверджено.'}</p>}
    {success && <p className="teaching-note mt-2" role="status"><Check size={14} className="inline" /> {success}</p>}
    {error && <p className="teaching-error mt-2" role="alert">{error}</p>}
    {mode && <form className="mt-4 space-y-4" onSubmit={event => void submit(event)}>
      <fieldset disabled={busy || disabled} className="space-y-4"><legend className="mb-2 font-semibold">{mode === 'links' ? 'Посилання цієї пари' : `Запит на зміну · ${teachingDate(lesson.lesson_date)}`}</legend>
        {mode === 'links' ? <>
          <p className="teaching-note">Збереження одразу оновить посилання цієї пари та її повторень у спільному розкладі групи. Дата й час залишаться без змін.</p>
          {[['online_url', 'online_url_label', 'Основне посилання'], ['online_url_secondary', 'online_url_secondary_label', 'Резервне посилання']].map(([url, label, title]) => <div key={url} className="grid gap-3 sm:grid-cols-2"><TeachingField label={title}><input type="url" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={2000} className={teachingInput} value={String(links[url as keyof TeachingScheduleLinks] || '')} placeholder="https://…" onChange={event => setLinks(value => ({ ...value, [url]: event.target.value }))} /></TeachingField><TeachingField label="Назва посилання"><input maxLength={80} className={teachingInput} value={String(links[label as keyof TeachingScheduleLinks] || '')} onChange={event => setLinks(value => ({ ...value, [label]: event.target.value }))} /></TeachingField></div>)}
          <ScheduleAdditionalLinksFields links={links.online_links_extra} onChange={online_links_extra => setLinks(value => ({ ...value, online_links_extra }))} disabled={busy || disabled} inputClass={teachingInput} />
          <ScheduleConferenceAccessFields value={{ conference_id: links.conference_id || '', conference_access_code: links.conference_access_code || '' }} onChange={patch => setLinks(value => ({ ...value, ...patch }))} inputClass={teachingInput} />
        </> : <>
          <p className="teaching-note">Лише це заняття зміниться після погодження. Інші повторення, збережені роботи та оцінки залишаться. Завдання й строки здачі за потреби відредагуйте окремо.</p>
          <TeachingField label="Що потрібно змінити"><select className={teachingInput} value={change.kind} onChange={event => setChange(value => ({ ...value, kind: event.target.value as TeachingScheduleChange['kind'] }))}><option value="move">Перенести заняття / змінити час</option><option value="cancel">Скасувати це заняття</option></select></TeachingField>
          {change.kind === 'move' && <div className="grid gap-3 sm:grid-cols-3"><TeachingField label="Нова дата"><input required min={kyivToday()} type="date" className={teachingInput} value={change.date} onChange={event => setChange(value => ({ ...value, date: event.target.value }))} /></TeachingField><TeachingField label="Початок"><input required type="time" className={teachingInput} value={change.starts_at} onChange={event => setChange(value => ({ ...value, starts_at: event.target.value }))} /></TeachingField><TeachingField label="Завершення"><input required type="time" className={teachingInput} value={change.ends_at} onChange={event => setChange(value => ({ ...value, ends_at: event.target.value }))} /></TeachingField></div>}
          <TeachingField label="Причина для старости або заступника"><textarea required maxLength={1000} rows={3} className={teachingInput} value={change.reason} onChange={event => setChange(value => ({ ...value, reason: event.target.value }))} /></TeachingField>
        </>}
      </fieldset>
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || disabled} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{mode === 'links' ? <Check size={15} /> : <Send size={15} />}{busy ? 'Зберігаємо…' : mode === 'links' ? 'Зберегти посилання' : 'Надіслати на погодження'}</button><TeachingButton disabled={busy} onClick={() => setMode(null)}><X size={15} />Закрити</TeachingButton></div>
    </form>}
  </section>
}
