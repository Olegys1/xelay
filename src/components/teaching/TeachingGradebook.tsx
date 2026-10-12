import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BookOpen, Check, Download, History, Link2, Pencil, Plus, RefreshCw, Send, Users } from 'lucide-react'
import {
  exportTeachingJournal, gradeHasDraft, teachingDate, teachingError, teachingTotal,
  type TeachingActivity, type TeachingEntry, type TeachingGrade, type TeachingRepository, type TeachingSnapshot,
} from '../../lib/teaching'
import { kyivToday } from '../../lib/seminars'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingLaunchNotice } from './TeachingLaunchNotice'

type GradeTarget = { entry: TeachingEntry; activity: TeachingActivity; grade?: TeachingGrade }
type GradebookProps = { snapshot: TeachingSnapshot; repository: TeachingRepository; userId: string; onRefresh: () => Promise<void> }
const points = (value: number | null | undefined) => value === null || value === undefined ? '—' : new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value)
const draftScore = (grade?: TeachingGrade) => grade && 'draft_score' in grade ? grade.draft_score : grade?.published_score

export function TeachingGradebook({ snapshot, repository, userId, onRefresh }: GradebookProps) {
  const [selectedGroup, setSelectedGroup] = useState(''), [selectedActivity, setSelectedActivity] = useState('')
  const [gradeTarget, setGradeTarget] = useState<GradeTarget | null>(null)
  const [activityEditor, setActivityEditor] = useState<TeachingActivity | 'new' | null>(null)
  const [publishTarget, setPublishTarget] = useState<{ activity: TeachingActivity; grades: TeachingGrade[] } | null>(null)
  const [rosterOpen, setRosterOpen] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const actionLock = useRef(false)
  const isGrader = snapshot.course.permissions.includes('grades')
  const groups = snapshot.groups.filter(group => group.status === 'accepted' || snapshot.entries.some(entry => entry.group_id === group.group_id))
  const group = groups.find(item => item.group_id === selectedGroup) || groups[0]
  const groupId = group?.group_id || ''
  const canEdit = isGrader && !snapshot.course.archived_at && group?.status === 'accepted'
  const entries = snapshot.entries.filter(entry => entry.group_id === groupId && entry.active).sort((a, b) => a.full_name.localeCompare(b.full_name, 'uk'))
  const activities = snapshot.activities.filter(activity => activity.group_id === groupId).sort((a, b) => a.activity_date.localeCompare(b.activity_date) || a.title.localeCompare(b.title, 'uk'))
  const activity = activities.find(item => item.id === selectedActivity) || activities[0]
  const visibleActivities = selectedActivity && activities.some(item => item.id === selectedActivity) ? activities.filter(item => item.id === selectedActivity) : activities
  const drafts = activity ? snapshot.grades.filter(grade => grade.activity_id === activity.id && entries.some(entry => entry.id === grade.entry_id) && gradeHasDraft(grade)) : []
  const seminar = snapshot.seminars.seminars.find(item => item.id === activity?.seminar_id)
  const reservations = snapshot.seminars.reservations.filter(item => item.seminar_id === seminar?.id)

  useEffect(() => { setSelectedGroup(''); setSelectedActivity(''); setGradeTarget(null); setActivityEditor(null); setPublishTarget(null); setRosterOpen(false); setError(''); setMessage('') }, [snapshot.course.id, userId])
  async function refreshRoster() {
    if (actionLock.current || !canEdit) return
    actionLock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      await repository.mutate('sync_roster', { course_id: snapshot.course.id, group_id: groupId })
      await onRefresh(); setMessage('Склад групи оновлено. Раніше внесені результати збережено.')
    } catch (failure) { setError(teachingError(failure)) } finally { actionLock.current = false; setBusy(false) }
  }
  const gradeFor = (entry: TeachingEntry, item: TeachingActivity) => snapshot.grades.find(grade => grade.entry_id === entry.id && grade.activity_id === item.id)

  if (!isGrader) {
    const ownEntries = snapshot.entries.filter(entry => entry.user_id === userId)
    const ownGrades = snapshot.grades.filter(grade => grade.published_at && ownEntries.some(entry => entry.id === grade.entry_id))
    return <section aria-label="Мої бали"><div className="mb-5"><h2 className="text-lg font-semibold">Мої бали</h2><p className="mt-1 text-xs text-muted-foreground">Тільки ваші опубліковані результати й коментарі викладача.</p></div>
      <TeachingLaunchNotice />
      {ownEntries.length > 0 && <div className="mb-5 grid gap-3 sm:grid-cols-2">{ownEntries.map(entry => <div key={entry.id} className="teaching-card"><p className="text-xs text-muted-foreground">{snapshot.groups.find(item => item.group_id === entry.group_id)?.group_name || 'Моя група'}</p><p className="mt-2 text-3xl font-semibold text-primary">{points(teachingTotal(snapshot, entry))}<span className="ml-2 text-sm font-normal text-muted-foreground">{snapshot.course.grading_rules.total_max ? `із ${snapshot.course.grading_rules.total_max}` : 'балів'}</span></p><p className="mt-2 text-xs text-muted-foreground">Сума враховує правила й максимуми категорій предмета.</p></div>)}</div>}
      {!ownGrades.length ? <div className="teaching-card"><TeachingEmpty icon={<BookOpen size={24} />} title="Балів поки немає" description="Результати з’являться після публікації викладачем. Відсутність оцінки не означає нуль." /></div> : <div className="teaching-list">{ownGrades.map(grade => {
        const item = snapshot.activities.find(value => value.id === grade.activity_id)
        return <article key={grade.id} className="teaching-card"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="break-words font-semibold">{item?.title || 'Результат'}</h3><p className="mt-1 text-xs text-muted-foreground">{teachingDate(item?.activity_date)} · {snapshot.course.grading_rules.categories.find(category => category.id === item?.category)?.name || 'Оцінювання'}</p></div><span className="shrink-0 text-xl font-semibold text-primary">{points(grade.published_score)}<span className="ml-1 text-xs font-normal text-muted-foreground">{item ? `/ ${points(item.max_points)}` : ''}</span></span></div>{grade.published_comment && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{grade.published_comment}</p>}<p className="mt-3 text-xs text-muted-foreground">Опубліковано {teachingDate(grade.published_at, true)}</p></article>
      })}</div>}
    </section>
  }

  return <section aria-label="Журнал балів">
    <TeachingLaunchNotice />
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Журнал балів</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Спочатку чернетка, потім публікація. Студент бачить тільки власні результати.</p></div><div className="flex flex-wrap gap-2">{groupId && <TeachingButton disabled={busy} onClick={() => exportTeachingJournal(snapshot, groupId)}><Download size={15} />Експорт CSV</TeachingButton>}{canEdit && <TeachingButton primary disabled={busy} onClick={() => setActivityEditor('new')}><Plus size={16} />Додати роботу</TeachingButton>}</div></div>
    {snapshot.course.archived_at && <p className="teaching-note mb-4">Архів семестру: результати збережено, редагування вимкнено.</p>}
    {!groups.length ? <div className="teaching-card"><TeachingEmpty icon={<Users size={24} />} title="Спочатку підключіть групу" description="Після підтвердження групи з’явиться її приватний журнал." /></div> : <>
      <div className="mb-4 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <TeachingField label="Група"><select name="journal-group" className={teachingInput} value={groupId} disabled={busy} onChange={event => { setSelectedGroup(event.target.value); setSelectedActivity(''); setError(''); setMessage('') }}>{groups.map(item => <option key={item.id} value={item.group_id}>{item.group_name}{item.status !== 'accepted' ? ' · архів доступу' : ''}</option>)}</select></TeachingField>
        <TeachingField label="Робота"><select name="journal-activity" className={teachingInput} value={selectedActivity} onChange={event => setSelectedActivity(event.target.value)}><option value="">Усі роботи</option>{activities.map(item => <option key={item.id} value={item.id}>{item.title} · {teachingDate(item.activity_date)}</option>)}</select></TeachingField>
        <TeachingButton disabled={busy} onClick={() => setRosterOpen(true)}><Users size={15} />Склад групи · {entries.length}</TeachingButton>
      </div>
      {error && <p role="alert" className="teaching-error mb-4">{error}</p>}{message && <p role="status" className="teaching-note mb-4">{message}</p>}
      {!snapshot.course.grading_rules.categories.length && <p className="teaching-note mb-4">Можна почати зі звичайної суми балів. За потреби власник предмета налаштує категорії та їхні максимуми у правилах оцінювання.</p>}
      {!entries.length ? <div className="teaching-card"><TeachingEmpty icon={<Users size={24} />} title="У журналі ще немає студентів" description="Оновіть склад підтвердженої групи або додайте приватний запис для студента без акаунта.">{canEdit && <TeachingButton primary busy={busy} onClick={() => void refreshRoster()}><RefreshCw size={15} />Оновити склад</TeachingButton>}</TeachingEmpty></div> : !activities.length ? <div className="teaching-card"><TeachingEmpty icon={<BookOpen size={24} />} title="Додайте першу роботу" description="Вкажіть дату, категорію та максимальний бал. Порожня клітинка означає, що результат ще не виставлено." /></div> : <>
        <div className="teaching-desktop-grades teaching-table-wrap"><table className="teaching-table"><caption className="sr-only">Бали групи {group?.group_name}. Порожня клітинка — ще не оцінено, нуль — виставлений результат.</caption><thead><tr><th scope="col">Студент</th>{visibleActivities.map(item => <th scope="col" key={item.id}><button type="button" className="text-left" disabled={!canEdit || Boolean(item.item_id)} onClick={() => setActivityEditor(item)} title={item.item_id ? 'Параметри змінюються в редакторі завдання' : canEdit ? 'Редагувати роботу' : undefined}><span className="block max-w-48 truncate text-foreground">{item.title}{canEdit && !item.item_id && <Pencil size={11} className="ml-1 inline" />}</span><span className="mt-1 block text-[11px]">{teachingDate(item.activity_date)} · до {points(item.max_points)}</span>{item.item_id && <span className="mt-1 block text-[10px] font-normal text-primary">Із завдання</span>}</button></th>)}<th scope="col">Разом</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><th scope="row" className="!whitespace-normal !bg-background"><span className="block font-medium text-foreground">{entry.full_name}</span>{!entry.user_id && <span className="mt-1 block text-[10px] font-normal">Приватний запис · без акаунта</span>}</th>{visibleActivities.map(item => { const grade = gradeFor(entry, item); return <td key={item.id}><button type="button" className={`teaching-grade ${grade && gradeHasDraft(grade) ? 'teaching-grade-draft' : ''}`} disabled={busy} onClick={() => setGradeTarget({ entry, activity: item, grade })} aria-label={`${entry.full_name}, ${item.title}: ${points(draftScore(grade))}${grade && gradeHasDraft(grade) ? ', чернетка' : ''}`}>{points(draftScore(grade))}</button></td> })}<td><span className="font-semibold">{points(teachingTotal(snapshot, entry, true))}</span><span className="mt-1 block text-[10px] text-muted-foreground">Опубліковано: {points(teachingTotal(snapshot, entry))}</span></td></tr>)}</tbody></table></div>
        <div className="teaching-mobile-grades">{canEdit && activity && !activity.item_id && <div className="mb-3"><TeachingButton disabled={busy} onClick={() => setActivityEditor(activity)}><Pencil size={15} />Редагувати вибрану роботу</TeachingButton></div>}<TeachingField label="Робота для швидкого оцінювання"><select name="mobile-journal-activity" className={teachingInput} value={activity?.id || ''} onChange={event => setSelectedActivity(event.target.value)}>{activities.map(item => <option key={item.id} value={item.id}>{item.title} · до {points(item.max_points)}</option>)}</select></TeachingField><div className="mt-3 teaching-list">{activity && entries.map(entry => { const grade = gradeFor(entry, activity); return <div key={entry.id} className="teaching-list-row"><div className="min-w-0 flex-1"><h3 className="break-words">{entry.full_name}</h3><p>{grade && gradeHasDraft(grade) ? 'Є неопубліковані зміни' : grade?.published_at ? 'Опубліковано' : 'Ще не оцінено'}</p><p>Разом опубліковано: {points(teachingTotal(snapshot, entry))}</p></div><button type="button" className={`teaching-grade ${grade && gradeHasDraft(grade) ? 'teaching-grade-draft' : ''}`} disabled={busy} aria-label={`Переглянути бали: ${entry.full_name}`} onClick={() => setGradeTarget({ entry, activity, grade })}>{points(draftScore(grade))}</button></div> })}</div></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-relaxed text-muted-foreground">— ще не оцінено · 0 — результат · бордова клітинка — неопубліковані зміни</p>{activity && canEdit && <TeachingButton primary disabled={busy || !drafts.length} onClick={() => setPublishTarget({ activity, grades: drafts.map(grade => ({ ...grade })) })}><Send size={15} />Опублікувати «{activity.title}» · {drafts.length}</TeachingButton>}</div>
        {activity?.item_id && <p className="teaching-note mt-3"><Link2 size={14} className="mr-2 inline" />Робота пов’язана із завданням. Її назву, термін, категорію та максимальний бал змінюють у редакторі завдання; бали — у цьому журналі.</p>}{activity && <p className="teaching-note mt-3">Для публікації виберіть роботу. Публікуються тільки збережені зміни цієї роботи; чернетки інших робіт залишаються приватними.</p>}
        {seminar && <div className="teaching-card mt-5"><div className="mb-4"><span className="teaching-badge teaching-badge-blue">Пов’язаний семінар</span><h3 className="mt-3 font-semibold">{seminar.title || 'Семінар'} · {teachingDate(seminar.lesson_date)}</h3><p className="mt-1 text-xs text-muted-foreground">Вибір питання показує запис на виступ. Бали за виконану роботу виставляє викладач.</p></div>{!reservations.length ? <p className="text-sm text-muted-foreground">На цей семінар поки ніхто не записався.</p> : <div className="space-y-2">{reservations.map(reservation => {
          const entry = entries.find(item => item.user_id === reservation.user_id)
          const question = snapshot.seminars.questions.find(item => item.id === reservation.question_id)
          const team = snapshot.seminars.teams.find(item => item.id === reservation.team_id)
          const name = entry?.full_name || snapshot.seminars.profiles[reservation.user_id]?.full_name || snapshot.members.find(item => item.user_id === reservation.user_id)?.full_name || 'Учасник'
          const role = { primary: 'Основний доповідач', supplement: 'Доповнювач', team: 'Команда', booking: 'Бронювання питання' }[reservation.role]
          return <div key={reservation.id} className="teaching-list-row"><div className="min-w-0 flex-1"><h3 className="break-words">{name}</h3><p className="break-words">{role}{question ? ` · Питання ${question.position}: ${question.body}` : team ? ` · ${team.name}` : ''}</p>{!entry && <p>Спочатку оновіть склад групи, щоб пов’язати результат.</p>}</div>{canEdit && activity && <TeachingButton disabled={!entry || busy} onClick={() => entry && setGradeTarget({ entry, activity, grade: gradeFor(entry, activity) })}>Виставити бали</TeachingButton>}</div>
        })}</div>}</div>}
      </>}
    </>}
    {gradeTarget && isGrader && <GradeEditor key={`${gradeTarget.entry.id}:${gradeTarget.activity.id}`} target={gradeTarget} snapshot={snapshot} repository={repository} readonly={!canEdit} onRefresh={onRefresh} onClose={() => setGradeTarget(null)} onNext={canEdit && entries[entries.findIndex(entry => entry.id === gradeTarget.entry.id) + 1] ? () => { const next = entries[entries.findIndex(entry => entry.id === gradeTarget.entry.id) + 1]; if (next) setGradeTarget({ entry: next, activity: gradeTarget.activity, grade: gradeFor(next, gradeTarget.activity) }) } : undefined} />}
    {activityEditor && canEdit && (activityEditor === 'new' || !activityEditor.item_id) && <ActivityEditor key={activityEditor === 'new' ? 'new' : activityEditor.id} initial={activityEditor === 'new' ? null : activityEditor} groupId={groupId} snapshot={snapshot} repository={repository} onRefresh={onRefresh} onClose={() => setActivityEditor(null)} />}
    {publishTarget && canEdit && <PublishGrades target={publishTarget} snapshot={snapshot} repository={repository} onRefresh={onRefresh} onClose={() => setPublishTarget(null)} />}
    {rosterOpen && <RosterEditor groupId={groupId} canEdit={Boolean(canEdit)} snapshot={snapshot} repository={repository} onRefresh={onRefresh} onClose={() => setRosterOpen(false)} />}
  </section>
}

function GradeEditor({ target, snapshot, repository, onRefresh, onClose, onNext, readonly = false }: { target: GradeTarget; snapshot: TeachingSnapshot; repository: TeachingRepository; onRefresh: () => Promise<void>; onClose: () => void; onNext?: () => void; readonly?: boolean }) {
  const { entry, activity, grade } = target
  const [score, setScore] = useState(draftScore(grade)?.toString() || '')
  const [comment, setComment] = useState(grade && 'draft_comment' in grade ? grade.draft_comment || '' : grade?.published_comment || '')
  const [reason, setReason] = useState(''), [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const lock = useRef(false)
  const nextAfterSave = useRef(false)
  const audit = snapshot.audit.filter(item => item.entry_id === entry.id && item.activity_id === activity.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
  async function save(event: FormEvent) {
    event.preventDefault(); if (lock.current || committed || readonly) return
    lock.current = true; setBusy(true); setError('')
    try {
      const trimmed = score.trim(), parsed = trimmed ? Number(trimmed.replace(',', '.')) : null
      if (trimmed && (!/^\d+(?:[.,]\d{1,2})?$/.test(trimmed) || !Number.isFinite(parsed) || parsed! < 0 || parsed! > activity.max_points)) throw new Error(`Вкажіть від 0 до ${activity.max_points} балів, до двох знаків після коми, або залиште поле порожнім.`)
      if (grade && parsed === draftScore(grade) && comment.trim() === (grade.draft_comment ?? grade.published_comment)) { onClose(); if (nextAfterSave.current) onNext?.(); return }
      if (grade?.published_at && (parsed !== grade.published_score || comment.trim() !== grade.published_comment) && reason.trim().length < 2) throw new Error('Вкажіть причину зміни опублікованого результату — щонайменше два символи.')
      await repository.mutate('save_grade', { course_id: snapshot.course.id, activity_id: activity.id, entry_id: entry.id, score: parsed, comment: comment.trim(), reason: reason.trim(), version: grade?.version || 0 })
      setCommitted(true); await onRefresh(); onClose(); if (nextAfterSave.current) onNext?.()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title={entry.full_name} description={`${activity.title} · до ${points(activity.max_points)} балів`} onClose={onClose} busy={busy}><form onSubmit={save} className="teaching-form">
    {error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p role="status" className="teaching-note">Чернетку збережено. Оновіть журнал, щоб побачити поточний результат.</p> : <>
      <TeachingField label="Бали" hint="Порожнє поле — ще не оцінено. Нуль — виставлений результат."><input name="grade-score" className={teachingInput} inputMode="decimal" autoFocus value={score} onChange={event => setScore(event.target.value)} maxLength={12} disabled={busy || readonly} placeholder="—" /></TeachingField>
      <TeachingField label="Особистий коментар" hint="Після публікації його побачить тільки цей студент і викладачі з доступом до журналу."><textarea name="grade-comment" className={teachingInput} value={comment} onChange={event => setComment(event.target.value)} rows={3} maxLength={2000} disabled={busy || readonly} /></TeachingField>
      {!readonly && <TeachingField label={grade?.published_at ? 'Причина зміни опублікованого результату' : 'Примітка до зміни — необов’язково'} hint="Зберігається в історії журналу. Причина обов’язкова при зміні опублікованих балів або коментаря."><input name="grade-reason" className={teachingInput} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} /></TeachingField>}
      {grade?.published_at && <p className="teaching-note">Зараз студент бачить: {points(grade.published_score)} балів. Чернетка змінить результат тільки після окремої публікації.</p>}
    </>}
    <button type="button" className="flex items-center gap-2 text-left text-xs font-semibold text-primary" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History size={15} />Історія змін · {audit.length}</button>{historyOpen && <div className="space-y-2">{audit.length ? audit.map(item => <div key={item.id} className="rounded-xl border border-border p-3 text-xs"><p className="font-medium">{points(item.old_score)} → {points(item.new_score)}</p><p className="mt-1 text-muted-foreground">{item.actor_name} · {teachingDate(item.created_at, true)}</p>{item.reason && <p className="mt-2 whitespace-pre-wrap break-words">{item.reason}</p>}</div>) : <p className="text-xs text-muted-foreground">Змін ще немає.</p>}</div>}
    <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{readonly || committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{!readonly && (committed ? <TeachingButton primary busy={busy} onClick={() => { setBusy(true); void onRefresh().then(onClose).catch(failure => setError(teachingError(failure))).finally(() => setBusy(false)) }}>Оновити журнал</TeachingButton> : <><TeachingButton primary type="submit" busy={busy} onClick={() => { nextAfterSave.current = false }}>Зберегти чернетку</TeachingButton>{onNext && <TeachingButton type="submit" disabled={busy} onClick={() => { nextAfterSave.current = true }}>Зберегти й далі</TeachingButton>}</>)}</div>
  </form></TeachingModal>
}

function ActivityEditor({ initial, groupId, snapshot, repository, onRefresh, onClose }: { initial: TeachingActivity | null; groupId: string; snapshot: TeachingSnapshot; repository: TeachingRepository; onRefresh: () => Promise<void>; onClose: () => void }) {
  const [id] = useState(initial?.id || crypto.randomUUID())
  const [title, setTitle] = useState(initial?.title || ''), [category, setCategory] = useState(initial?.category || snapshot.course.grading_rules.categories[0]?.id || '')
  const [date, setDate] = useState(initial?.activity_date || kyivToday()), [maximum, setMaximum] = useState(initial?.max_points.toString() || '5')
  const [seminarId, setSeminarId] = useState(initial?.seminar_id || '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const lock = useRef(false)
  const seminars = snapshot.seminars.seminars.filter(item => item.group_id === groupId)
  async function save(event: FormEvent) {
    event.preventDefault(); if (lock.current || committed) return
    lock.current = true; setBusy(true); setError('')
    try {
      const max = Number(maximum.replace(',', '.'))
      if (!title.trim() || !date || !/^\d+(?:[.,]\d{1,2})?$/.test(maximum.trim()) || !Number.isFinite(max) || max <= 0 || max > 10000) throw new Error('Вкажіть назву, дату й максимальний бал від 0,01 до 10 000.')
      if (date < snapshot.course.starts_on || date > snapshot.course.ends_on) throw new Error('Дата роботи має бути в межах семестру цього предмета.')
      await repository.mutate('save_activity', { course_id: snapshot.course.id, group_id: groupId, id, version: initial?.version || 0, title: title.trim(), category, activity_date: date, max_points: max, seminar_id: seminarId || null })
      setCommitted(true); await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title={initial ? 'Редагувати роботу' : 'Нова робота для оцінювання'} onClose={onClose} busy={busy} description="Ця робота стане окремою колонкою журналу вибраної групи."><form onSubmit={save} className="teaching-form">
    {error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p role="status" className="teaching-note">Роботу збережено. Оновіть журнал, якщо вона ще не відображається.</p> : <>
      <TeachingField label="Назва"><input name="activity-title" className={teachingInput} value={title} onChange={event => setTitle(event.target.value)} maxLength={180} autoFocus required disabled={busy} placeholder="Наприклад, Семінар 1" /></TeachingField>
      <div className="grid gap-4 sm:grid-cols-2"><TeachingField label="Категорія"><select name="activity-category" className={teachingInput} value={category} onChange={event => setCategory(event.target.value)} disabled={busy}><option value="">Без категорії — звичайна сума</option>{snapshot.course.grading_rules.categories.map(item => <option key={item.id} value={item.id}>{item.name} · до {points(item.max_points)} загалом</option>)}</select></TeachingField><TeachingField label="Максимальний бал"><input name="activity-max" className={teachingInput} inputMode="decimal" value={maximum} onChange={event => setMaximum(event.target.value)} maxLength={12} required disabled={busy} /></TeachingField></div>
      <TeachingField label="Дата"><input name="activity-date" type="date" className={teachingInput} value={date} min={snapshot.course.starts_on} max={snapshot.course.ends_on} onChange={event => setDate(event.target.value)} required disabled={busy} /></TeachingField>
      <TeachingField label="Пов’язаний семінар — необов’язково" hint="Показуватиме записаних доповідачів, доповнювачів і команди поруч із журналом."><select name="activity-seminar" className={teachingInput} value={seminarId} disabled={busy} onChange={event => { setSeminarId(event.target.value); const item = seminars.find(value => value.id === event.target.value); if (item) { setDate(item.lesson_date); if (!title.trim()) setTitle(item.title || 'Семінар') } }}><option value="">Без прив’язки до семінару</option>{seminars.map(item => <option key={item.id} value={item.id}>{teachingDate(item.lesson_date)} · {item.title || 'Семінар'}</option>)}</select></TeachingField>
      {initial && <p className="teaching-note">Зміна роботи зберігає оцінки й історію. Максимум не можна зменшувати нижче вже виставлених балів.</p>}
    </>}
    <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{committed ? <TeachingButton primary busy={busy} onClick={() => { setBusy(true); void onRefresh().then(onClose).catch(failure => setError(teachingError(failure))).finally(() => setBusy(false)) }}>Оновити журнал</TeachingButton> : <TeachingButton primary type="submit" busy={busy}>Зберегти роботу</TeachingButton>}</div>
  </form></TeachingModal>
}

function PublishGrades({ target, snapshot, repository, onRefresh, onClose }: { target: { activity: TeachingActivity; grades: TeachingGrade[] }; snapshot: TeachingSnapshot; repository: TeachingRepository; onRefresh: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const lock = useRef(false)
  async function publish() {
    if (lock.current || committed) return
    lock.current = true; setBusy(true); setError('')
    try {
      await repository.mutate('publish_grades', { course_id: snapshot.course.id, activity_id: target.activity.id, expected_versions: target.grades.map(grade => ({ entry_id: grade.entry_id, version: grade.version })) })
      setCommitted(true); await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title="Опублікувати бали?" description={`${target.activity.title} · змінено результатів: ${target.grades.length}`} busy={busy} onClose={onClose}><div className="teaching-form">
    {error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p role="status" className="teaching-note">Бали опубліковано. Оновіть журнал, щоб побачити результат.</p> : <><p className="text-sm leading-relaxed">Кожен студент побачить тільки власний результат і коментар. Зареєстровані студенти отримають сповіщення; приватні записи без акаунта залишаться в журналі.</p><div className="max-h-64 overflow-auto space-y-2">{target.grades.map(grade => <div key={grade.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 p-3 text-sm"><span className="min-w-0 break-words">{snapshot.entries.find(entry => entry.id === grade.entry_id)?.full_name || 'Студент'}</span><span className="shrink-0 font-semibold">{points(draftScore(grade))} / {points(target.activity.max_points)}</span></div>)}</div><p className="teaching-note">Перед публікацією сервер перевіряє версії результатів. Якщо інший викладач уже змінив бал, потрібно оновити журнал і перевірити зміни.</p></>}
    <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{committed ? 'Закрити' : 'Перевірити ще раз'}</TeachingButton>{committed ? <TeachingButton primary busy={busy} onClick={() => { setBusy(true); void onRefresh().then(onClose).catch(failure => setError(teachingError(failure))).finally(() => setBusy(false)) }}>Оновити журнал</TeachingButton> : <TeachingButton primary busy={busy} onClick={() => void publish()}><Send size={15} />Опублікувати</TeachingButton>}</div>
  </div></TeachingModal>
}

function RosterEditor({ groupId, canEdit, snapshot, repository, onRefresh, onClose }: { groupId: string; canEdit: boolean; snapshot: TeachingSnapshot; repository: TeachingRepository; onRefresh: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [entryDraftId, setEntryDraftId] = useState(() => crypto.randomUUID())
  const [linkEntry, setLinkEntry] = useState<TeachingEntry | null>(null), [linkedUser, setLinkedUser] = useState('')
  const lock = useRef(false)
  const entries = snapshot.entries.filter(entry => entry.group_id === groupId && entry.active).sort((a, b) => a.full_name.localeCompare(b.full_name, 'uk'))
  const candidates = snapshot.members.filter(member => member.group_id === groupId && !snapshot.entries.some(entry => entry.group_id === groupId && entry.user_id === member.user_id && snapshot.grades.some(grade => grade.entry_id === entry.id)))
  async function run(action: string, payload: Record<string, unknown>, success: string) {
    if (lock.current || !canEdit) return
    lock.current = true; setBusy(action); setError(''); setMessage('')
    let saved = false
    try { await repository.mutate(action, { course_id: snapshot.course.id, group_id: groupId, ...payload }); saved = true; if (action === 'save_entry') { setName(''); setEntryDraftId(crypto.randomUUID()) } setLinkEntry(null); setLinkedUser(''); await onRefresh(); setMessage(success) }
    catch (failure) { setError(`${saved ? 'Зміну збережено. Оновіть список перед наступною дією. ' : ''}${teachingError(failure)}`) }
    finally { lock.current = false; setBusy('') }
  }
  async function add(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || name.trim().length > 160) { setError('Вкажіть ім’я та прізвище до 160 символів.'); return }
    await run('save_entry', { id: entryDraftId, version: 0, full_name: name.trim(), active: true }, 'Приватний запис додано. Його результати доступні викладачам із правом на журнал.')
  }
  return <TeachingModal title="Склад групи" description="Приватний список журналу. Запис без акаунта можна пов’язати зі студентом тільки після його підтвердження." busy={Boolean(busy)} onClose={onClose}><div className="teaching-form">
    {error && <p role="alert" className="teaching-error">{error}</p>}{message && <p role="status" className="teaching-note">{message}</p>}
    {canEdit && <><TeachingButton busy={busy === 'sync_roster'} disabled={Boolean(busy)} onClick={() => void run('sync_roster', {}, 'Склад підтвердженої групи оновлено.')}><RefreshCw size={15} />Оновити з навчальної групи</TeachingButton><form onSubmit={add} className="space-y-3 rounded-xl border border-border p-4"><TeachingField label="Студент без акаунта" hint="Запис дозволяє вести журнал, навіть якщо людина ще не зареєструвалася."><input name="roster-name" className={teachingInput} value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={Boolean(busy)} required placeholder="Ім’я та прізвище" /></TeachingField><TeachingButton primary type="submit" disabled={Boolean(busy)} busy={busy === 'save_entry'}><Plus size={15} />Додати приватний запис</TeachingButton></form></>}
    <div className="space-y-2">{entries.map(entry => { const claim = snapshot.roster_claims.find(item => item.entry_id === entry.id && item.status === 'pending'); return <div key={entry.id} className="teaching-list-row"><div className="min-w-0 flex-1"><h3 className="break-words">{entry.full_name}</h3><p>{entry.user_id ? 'Акаунт підтверджено' : claim ? `Очікує підтвердження: ${claim.full_name}` : 'Приватний запис без акаунта'}</p></div>{entry.user_id ? <Check size={16} className="shrink-0 text-primary" aria-label="Підтверджено" /> : canEdit && !claim && <TeachingButton disabled={Boolean(busy) || !candidates.length} onClick={() => { setLinkEntry(entry); setLinkedUser(''); setError('') }}><Link2 size={15} />Прив’язати</TeachingButton>}</div> })}{!entries.length && <p className="text-sm text-muted-foreground">Список поки порожній.</p>}</div>
    {linkEntry && canEdit && <div className="space-y-3 rounded-xl border border-primary/20 p-4"><h3 className="text-sm font-semibold">Прив’язати запис «{linkEntry.full_name}»</h3><TeachingField label="Підтверджений учасник цієї групи" hint="Оберіть конкретний акаунт. Збіг імені сам по собі не відкриває оцінки."><select name="roster-account" className={teachingInput} value={linkedUser} disabled={Boolean(busy)} onChange={event => setLinkedUser(event.target.value)}><option value="">Оберіть акаунт</option>{candidates.map(member => <option key={member.user_id} value={member.user_id}>{member.full_name}{member.username ? ` · @${member.username}` : ''}</option>)}</select></TeachingField><p className="text-xs leading-relaxed text-muted-foreground">Студент отримає запит і сам підтвердить, що цей запис належить йому. До підтвердження результати не відкриваються.</p><div className="flex flex-wrap gap-2"><TeachingButton disabled={Boolean(busy)} onClick={() => setLinkEntry(null)}>Скасувати</TeachingButton><TeachingButton primary disabled={Boolean(busy) || !linkedUser} busy={busy === 'request_roster_link'} onClick={() => void run('request_roster_link', { entry_id: linkEntry.id, user_id: linkedUser, version: linkEntry.version }, 'Запит на прив’язку надіслано. Дочекайтеся підтвердження студента.')}>Надіслати запит</TeachingButton></div></div>}
    <div className="teaching-form-actions"><TeachingButton disabled={Boolean(busy)} onClick={onClose}>Закрити</TeachingButton></div>
  </div></TeachingModal>
}
