import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, Mail, Send, ShieldCheck } from 'lucide-react'
import { teachingError, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { ALL_TEACHING_AUDIENCE, teachingAudienceIsValid, type TeachingAnnouncement, type TeachingAnnouncementAudience, type TeachingAudienceTarget } from '../../lib/teachingAudience'
import { TeachingAudienceFields } from './TeachingAudienceFields'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'

export function TeachingAnnouncementComposer({ initial, repository, snapshot, groupId, userId, onClose, onSaved }: {
  initial: TeachingAnnouncement | null; repository: TeachingRepository; snapshot: TeachingSnapshot; groupId: string; userId: string
  onClose: () => void; onSaved: () => Promise<void>
}) {
  const [id] = useState(() => initial?.id || crypto.randomUUID())
  const [title, setTitle] = useState(initial?.title || ''), [body, setBody] = useState(initial?.body || '')
  const [targets, setTargets] = useState<TeachingAudienceTarget[]>(initial?.targets || [ALL_TEACHING_AUDIENCE(groupId)])
  const [required, setRequired] = useState(Boolean(initial?.requires_acknowledgement))
  const [review, setReview] = useState<{ signature: string; audience: TeachingAnnouncementAudience } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(true), lock = useRef(false)
  const scope = useRef({ repository, userId, courseId: snapshot.course.id, groupId })
  if (scope.current.repository !== repository || scope.current.userId !== userId || scope.current.courseId !== snapshot.course.id || scope.current.groupId !== groupId) scope.current = { repository, userId, courseId: snapshot.course.id, groupId }
  const renderScope = scope.current, initialScope = useRef(renderScope)
  const signature = JSON.stringify({ title: title.trim(), body: body.trim(), targets, required, id, version: initial?.version || 0 })
  const current = useRef({ signature, review }); current.current = { signature, review }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const groups = snapshot.groups.filter(group => group.status === 'accepted' && (group.permissions || snapshot.course.permissions).some(permission => permission === 'assignments' || permission === 'manage'))
  const change = (action: () => void) => { if (!lock.current) { action(); setReview(null); setError('') } }
  async function send(event: FormEvent) {
    event.preventDefault()
    const source = repository.audiences
    if (!alive.current || lock.current || !source || scope.current !== renderScope || initialScope.current !== renderScope) return
    if (!title.trim() || !body.trim() || !targets.length || targets.some(target => !teachingAudienceIsValid(target) || !groups.some(group => group.group_id === target.group_id))) { setError('Додайте тему, текст і потрібних одержувачів.'); return }
    if (current.current.signature !== signature) return
    lock.current = true; setBusy(true); setError('')
    const valid = () => alive.current && scope.current === renderScope
    try {
      if (!current.current.review || current.current.review.signature !== signature) {
        if (!source.previewRecipients) throw Error('TEACHING_NOTIFICATION_PREVIEW_UNAVAILABLE')
        const audience = await source.previewRecipients(snapshot.course.id, targets, userId)
        if (!valid() || current.current.signature !== signature) return
        if (!Number.isSafeInteger(audience.recipient_count) || audience.recipient_count < 0 || !Array.isArray(audience.group_counts)) throw Error('TEACHING_INVALID_INPUT')
        setReview({ signature, audience }); return
      }
      await source.mutate('save_announcement', { id, course_id: snapshot.course.id, version: initial?.version || 0, title: title.trim(), body: body.trim(), targets, requires_acknowledgement: required, expected_user_id: userId })
      if (valid()) await onSaved()
    } catch (failure) {
      if (valid()) setError(failure instanceof Error && failure.message === 'TEACHING_NOTIFICATION_PREVIEW_UNAVAILABLE' ? 'Перевірка одержувачів ще не підключена. Оновіть платформу перед надсиланням.' : teachingError(failure))
    } finally { if (valid()) setBusy(false); lock.current = false }
  }
  if (initialScope.current !== renderScope) return <TeachingModal title="Акаунт або предмет змінився" onClose={onClose}><p>Повторно відкрийте повідомлення у потрібному кабінеті.</p></TeachingModal>
  return <TeachingModal title={initial ? 'Редагувати повідомлення' : 'Написати групам'} description="Спочатку перевірте одержувачів, потім підтвердьте надсилання." onClose={onClose} busy={busy}>
    <form className="teaching-form" onSubmit={event => void send(event)} data-teaching-guide="messages-compose">
      <fieldset disabled={busy} className="teaching-form">
        <TeachingField label="Тема"><input className={teachingInput} value={title} onChange={event => change(() => setTitle(event.target.value))} maxLength={160} required placeholder="Сьогодні працюємо самостійно" /></TeachingField>
        <TeachingField label="Повідомлення"><textarea className={teachingInput} value={body} onChange={event => change(() => setBody(event.target.value))} maxLength={10000} required rows={5} placeholder="Напишіть, що потрібно знати студентам…" /></TeachingField>
        <section className="teaching-announcement-required" data-teaching-guide="messages-required"><label className="teaching-check"><input type="checkbox" checked={required} onChange={event => change(() => setRequired(event.target.checked))} /><span><ShieldCheck size={16} className="mr-1 inline" />Потрібне підтвердження ознайомлення</span></label><p className="teaching-audience-hint">{required ? 'Повідомлення залишиться у важливих сповіщеннях до натискання «Ознайомився». Також надійде один безкоштовний лист на підтверджену пошту незалежно від звичайних налаштувань.' : 'Звичайне повідомлення. Кожен одержувач отримає його відповідно до своїх налаштувань.'}</p></section>
        <fieldset className="teaching-audience-group-picker" data-teaching-guide="messages-targets"><legend>Кому надіслати</legend>{groups.map(group => {
          const target = targets.find(target => target.group_id === group.group_id)
          return <div className="teaching-audience-target" key={group.group_id}><label className="teaching-audience-group-toggle"><input type="checkbox" checked={Boolean(target)} onChange={() => change(() => setTargets(target ? targets.filter(item => item.group_id !== group.group_id) : [...targets, ALL_TEACHING_AUDIENCE(group.group_id)]))} /><strong>{group.group_name}</strong></label>{target && <TeachingAudienceFields repository={repository} courseId={snapshot.course.id} groupId={group.group_id} value={target} onChange={value => change(() => setTargets(targets.map(item => item.group_id === group.group_id ? value : item)))} disabled={busy} />}</div>
        })}</fieldset>
      </fieldset>
      {review && review.signature === signature && <section role="status" className="teaching-audience-confirm"><strong><CheckCircle2 size={16} className="mr-1 inline" />Перевірте перед надсиланням</strong><p>Одержувачів зараз: <b>{review.audience.recipient_count}</b>. Склад і доступ буде перевірено ще раз під час публікації.</p>{review.audience.group_counts.map(group => <p key={group.group_id}>{groups.find(item => item.group_id === group.group_id)?.group_name || 'Обрана група'}: {group.count}</p>)}{required && <p><Mail size={15} className="mr-1 inline" />Обов’язкове сповіщення у Xelay та один лист. Ви побачите підтвердження кожного одержувача.</p>}{initial && <p>Одержувачам надійде оновлена версія. Для обов’язкового повідомлення потрібне нове підтвердження.</p>}</section>}
      {error && <p role="alert" className="teaching-error">{error}</p>}
      <div className="teaching-form-actions"><button type="button" className="teaching-button" data-teaching-guide-launch="messages" disabled={busy}>Підказки повідомлення</button><TeachingButton disabled={busy} onClick={onClose}>Скасувати</TeachingButton><TeachingButton primary type="submit" busy={busy}><Send size={16} />{review?.signature === signature ? initial ? 'Підтвердити зміни' : 'Підтвердити й надіслати' : 'Перевірити повідомлення'}</TeachingButton></div>
    </form>
  </TeachingModal>
}
