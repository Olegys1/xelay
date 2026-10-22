import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { BookOpen, CheckCircle2, ChevronRight, ClipboardCheck, Clock3, RefreshCw, RotateCcw, Search, Send } from 'lucide-react'
import {
  teachingDate, type TeachingPublication, type TeachingRepository, type TeachingSnapshot,
  type TeachingSubmission, type TeachingSubmissionData,
} from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import {
  TeachingSubmissionHistoryList, TeachingSubmissionResources, TeachingSubmissionStatusBadge, teachingSubmissionError,
} from './TeachingSubmissionPanel'
import './teaching-submissions.css'
import { TeachingSubmissionExtension } from './TeachingSubmissionExtension'
import { SUBMISSION_FORMATS, submissionFormat } from './TeachingPublicationTimingFields'

type ReviewProps = {
  repository: TeachingRepository; snapshot: TeachingSnapshot; groupId?: string; assignment?: TeachingPublication;
  userId?: string; onRefresh: () => Promise<void>;
}
type Filter = 'all' | 'missing' | 'submitted' | 'reviewed' | 'returned'
type ReviewRow = { userId: string; name: string; username?: string | null; submission?: TeachingSubmission }
const FILTERS: { id: Exclude<Filter, 'all'>; label: string }[] = [
  { id: 'missing', label: 'Не здано' }, { id: 'submitted', label: 'Очікують перевірки' },
  { id: 'reviewed', label: 'Перевірено' }, { id: 'returned', label: 'На доопрацюванні' },
]

export function TeachingSubmissionReview({ repository, snapshot, groupId: fixedGroup, assignment: fixedAssignment, userId, onRefresh }: ReviewProps) {
  const [groupChoice, setGroupChoice] = useState(''), [assignmentChoice, setAssignmentChoice] = useState('')
  const [data, setData] = useState<TeachingSubmissionData | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all'), [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TeachingSubmission | null>(null)
  const [extending, setExtending] = useState(false)
  const generation = useRef(0)
  const hasAccess = snapshot.course.permissions.includes('assignments') || snapshot.course.permissions.includes('grades')
  const groups = snapshot.groups.filter(group => group.status === 'accepted' && (!fixedAssignment || fixedAssignment.targets.some(target => target.group_id === group.group_id)))
  const groupId = fixedGroup || groups.find(group => group.group_id === groupChoice)?.group_id || groups[0]?.group_id || ''
  const assignments = snapshot.assignments.filter(item => item.status === 'published' && item.targets.some(target => target.group_id === groupId))
  const assignment = fixedAssignment || assignments.find(item => item.id === assignmentChoice) || assignments[0]
  const contextKey = snapshot.course.id + ':' + groupId + ':' + (assignment?.id || '') + ':' + (userId || '')
  const scope = useRef({ key: contextKey, repository }); scope.current = { key: contextKey, repository }
  const alive = useRef(true)
  const currentScope = () => alive.current && scope.current.key === contextKey && scope.current.repository === repository
  const [loadedKey, setLoadedKey] = useState('')
  const load = useCallback(async () => {
    if (!assignment || !groupId || !hasAccess || !alive.current || scope.current.key !== contextKey || scope.current.repository !== repository) return
    const version = ++generation.current
    const valid = () => alive.current && version === generation.current && scope.current.key === contextKey && scope.current.repository === repository
    setLoading(true); setError('')
    try {
      const next = await repository.classroom(assignment.id, groupId)
      if (!valid()) return
      setData(next); setLoadedKey(contextKey)
    } catch (failure) {
      if (valid()) { setError(teachingSubmissionError(failure)); throw failure }
    } finally { if (valid()) setLoading(false) }
  }, [repository, assignment?.id, groupId, contextKey, hasAccess])
  useEffect(() => {
    alive.current = true
    setData(null); setLoadedKey(''); setSelected(null); setExtending(false); setFilter('all'); setQuery('')
    void load().catch(() => {})
    return () => { alive.current = false; generation.current++ }
  }, [load, contextKey])
  const current = loadedKey === contextKey ? data : null
  const canReview = Boolean(current && current.can_review !== false && !current.course_archived_at && !snapshot.course.archived_at &&
    (current.permissions.includes('assignments') || current.permissions.includes('grades')))
  const submissions = (current?.submissions || []).filter(item => item.status !== 'draft')
  const members = current?.students || snapshot.members.filter(member => member.group_id === groupId)
  const rows: ReviewRow[] = members.map(member => ({
    userId: member.user_id, name: member.full_name, username: member.username,
    submission: submissions.find(item => item.user_id === member.user_id),
  }))
  for (const item of submissions) {
    if (!rows.some(row => row.userId === item.user_id)) rows.push({ userId: item.user_id, name: item.student_name || 'Студент', submission: item })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'uk'))
  const statusOf = (row: ReviewRow) => row.submission?.status || 'missing'
  const visible = rows.filter(row => (filter === 'all' || statusOf(row) === filter) && (!query.trim() ||
    (row.name + ' ' + (row.username || '')).toLocaleLowerCase('uk').includes(query.trim().toLocaleLowerCase('uk'))))
  async function reviewed() { if (!currentScope()) return; await load(); if (!currentScope()) return; await onRefresh(); if (currentScope()) setSelected(null) }

  if (!hasAccess) return <TeachingEmpty icon={<BookOpen size={24} />} title="Немає дозволу на перевірку робіт" description="Власник предмета може надати дозвіл на завдання або оцінювання." />
  return <section aria-label="Перевірка студентських робіт" className="teaching-classroom-pane">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Здані роботи</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Відкрийте роботу, додайте коментар і прийміть її або поверніть на доопрацювання. Чернетки студентів приватні.</p></div><TeachingButton onClick={() => void load().catch(() => {})} disabled={loading || !assignment || !groupId}><RefreshCw size={15} />Оновити</TeachingButton></div>
    {(!fixedGroup || !fixedAssignment) && <div className="mb-4 grid gap-3 sm:grid-cols-2">{!fixedGroup && <TeachingField label="Навчальна група"><select name="review-group" className={teachingInput} value={groupId} disabled={loading} onChange={event => { setGroupChoice(event.target.value); setAssignmentChoice('') }}>{groups.map(group => <option key={group.id} value={group.group_id}>{group.group_name}</option>)}</select></TeachingField>}{!fixedAssignment && <TeachingField label="Завдання"><select name="review-assignment" className={teachingInput} value={assignment?.id || ''} disabled={loading} onChange={event => setAssignmentChoice(event.target.value)}>{assignments.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></TeachingField>}</div>}
    {fixedAssignment && <div className="teaching-note mb-4"><strong className="text-foreground">{fixedAssignment.title}</strong><p>{snapshot.groups.find(group => group.group_id === groupId)?.group_name || current?.group.group_name}</p></div>}
    {error && <p role="alert" className="teaching-error mb-4">{error}</p>}
    {!assignment || !groupId ? <TeachingEmpty icon={<ClipboardCheck size={24} />} title="Опублікуйте завдання для групи" description="Здані роботи з’являться після того, як студенти надішлють відповідь на опубліковане завдання." /> : loading && !current ? <p role="status" className="teaching-note">Завантажуємо роботи групи…</p> : current && <>
      {(current.course_archived_at || snapshot.course.archived_at) && <p className="teaching-note">Архів семестру. Роботи, коментарі й опубліковані бали доступні для перегляду.</p>}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-relaxed text-muted-foreground">{SUBMISSION_FORMATS.find(item => item.id === submissionFormat(current.item))?.label}. Усні відповіді й захист можна оцінювати без завантаженого файлу та без запису на питання — у журналі всіх студентів групи.</p>{canReview && current.permissions.includes('assignments') && current.students.length > 0 && <TeachingButton onClick={() => setExtending(true)}><Clock3 size={14} />Індивідуальний термін</TeachingButton>}</div>
      <div className="teaching-submission-review-stats" aria-label="Стани виконання">{FILTERS.map(item => <button type="button" key={item.id} className="teaching-submission-review-stat" aria-pressed={filter === item.id} onClick={() => setFilter(value => value === item.id ? 'all' : item.id)}><strong>{rows.filter(row => statusOf(row) === item.id).length}</strong><span>{item.label}</span></button>)}</div>
      <div className="mb-4 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"><TeachingField label="Знайти студента"><div className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" /><input type="search" name="review-student-search" className={teachingInput + ' !pl-9'} value={query} onChange={event => setQuery(event.target.value)} placeholder="Ім’я або нік…" /></div></TeachingField><TeachingButton onClick={() => { setFilter('all'); setQuery('') }} disabled={filter === 'all' && !query}>Показати всіх</TeachingButton></div>
      {!visible.length ? <TeachingEmpty title={rows.length ? 'Тут поки немає робіт' : 'У групі ще немає учасників'} description={rows.length ? 'Оберіть інший стан або змініть пошук.' : 'Після приєднання студентів можна буде бачити, хто здав роботу.'} /> : <div className="teaching-list">{visible.map(row => <button type="button" key={row.userId} className="teaching-submission-review-row" disabled={!row.submission} onClick={() => row.submission && setSelected(row.submission)} aria-label={row.name + ': ' + (row.submission ? 'відкрити роботу' : 'роботу ще не здано')}>
        <div><h3>{row.name}</h3><p>{row.username ? '@' + row.username + ' · ' : ''}{row.submission?.submitted_at ? teachingDate(row.submission.submitted_at, true) + ' · спроба ' + row.submission.attempt : 'Викладач не бачить приватні чернетки'}</p>{row.submission?.published_score !== null && row.submission?.published_score !== undefined && <p>У журналі: {row.submission.published_score}{current.max_points ? ' / ' + current.max_points : ''}</p>}{row.submission?.submitted_at && assignment.targets.find(target => target.group_id === groupId)?.due_at && Date.parse(row.submission.submitted_at) > Date.parse(assignment.targets.find(target => target.group_id === groupId)!.due_at!) && <p className="!text-primary">Здано після терміну</p>}</div><div className="flex items-center gap-2"><TeachingSubmissionStatusBadge status={statusOf(row)} format={submissionFormat(current.item)} />{row.submission && <ChevronRight size={16} />}</div>
      </button>)}</div>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">«Не здано» означає, що викладач не отримав поточну роботу. Студент міг зберегти власну чернетку.</p>
    </>}
    {selected && current && <SubmissionReviewDialog key={selected.id + ':' + selected.version} submission={selected} data={current} repository={repository} canReview={canReview} onSaved={reviewed} onClose={() => { if (currentScope()) setSelected(null) }} />}
    {extending && current && <TeachingSubmissionExtension repository={repository} data={current} groupId={groupId} onSaved={async () => { if (!currentScope()) return; await load(); if (currentScope()) await onRefresh() }} onClose={() => { if (currentScope()) setExtending(false) }} />}
  </section>
}

function SubmissionReviewDialog({ submission, data, repository, canReview, onSaved, onClose }: { submission: TeachingSubmission; data: TeachingSubmissionData; repository: TeachingRepository; canReview: boolean; onSaved: () => Promise<void>; onClose: () => void }) {
  const returnOnly = submission.status === 'reviewed'
  const actionable = canReview && ['submitted', 'reviewed'].includes(submission.status)
  const [decision, setDecision] = useState<'reviewed' | 'returned'>(returnOnly ? 'returned' : 'reviewed')
  const [feedback, setFeedback] = useState(''), [publishScore, setPublishScore] = useState(false)
  const [score, setScore] = useState(submission.published_score !== null ? String(submission.published_score) : ''), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [committed, setCommitted] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false), [error, setError] = useState('')
  const actionLock = useRef(false)
  const canGrade = data.permissions.includes('grades') && data.is_assessed && Boolean(data.activity_id) && Number(data.max_points) > 0
  const hasPublishedGrade = Boolean(submission.grade_published_at) || (submission.grade_published_at === undefined && (submission.published_score !== null || Boolean(submission.published_comment)))
  async function save(event: FormEvent) {
    event.preventDefault()
    if (actionLock.current || committed || needsRefresh || !actionable) return
    actionLock.current = true; setBusy(true); setError('')
    let writing = false
    try {
      if (decision === 'returned' && Array.from(feedback.trim()).length < 2) throw new Error('Поясніть, що потрібно доопрацювати — щонайменше два символи.')
      const payload: Record<string, unknown> = { id: submission.id, version: submission.version, status: decision, feedback: feedback.trim() }
      if (decision === 'reviewed' && publishScore) {
        if (!canGrade) throw new Error('Для публікації балів потрібен дозвіл на журнал і оцінюване завдання.')
        const entered = score.trim().replace(',', '.')
        if (entered && (!/^\d{1,5}([.]\d{1,2})?$/.test(entered) || Number(entered) > Number(data.max_points))) throw new Error('Вкажіть бал від 0 до ' + data.max_points + ', до двох знаків після коми.')
        const value = entered ? Number(entered) : null
        if (hasPublishedGrade && (value !== submission.published_score || feedback.trim() !== submission.published_comment) && Array.from(reason.trim()).length < 2) throw new Error('Додайте причину зміни вже опублікованого результату — щонайменше два символи.')
        payload.score = value; payload.grade_version = submission.grade_version; payload.reason = reason.trim()
      }
      writing = true
      await repository.classroomMutate('review_submission', payload)
      setCommitted(true); await onSaved()
    } catch (failure) {
      setError(teachingSubmissionError(failure))
      if (writing && !committed) setNeedsRefresh(true)
    } finally { actionLock.current = false; setBusy(false) }
  }
  async function refresh() {
    if (actionLock.current) return
    actionLock.current = true; setBusy(true); setError('')
    try { await onSaved() } catch (failure) { setError(teachingSubmissionError(failure)) } finally { actionLock.current = false; setBusy(false) }
  }
  return <TeachingModal title={submission.student_name || 'Робота студента'} description={data.item.title + ' · спроба ' + submission.attempt} onClose={onClose} busy={busy}>
    <div className="teaching-submission-heading mb-4"><TeachingSubmissionStatusBadge status={submission.status} format={submissionFormat(data.item)} /><span className="text-xs text-muted-foreground">{teachingDate(submission.submitted_at, true)}</span></div>
    <div className="teaching-submission-reading"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{submission.body || (submissionFormat(data.item) === 'oral' ? 'Студент позначив готовність до усної відповіді. Оцініть її після заняття.' : submissionFormat(data.item) === 'defense' ? 'Студент позначив готовність до захисту. Матеріали можна обговорити на занятті.' : 'Відповідь у вкладених матеріалах.')}</p><TeachingSubmissionResources links={submission.links || []} attachments={submission.attachments || []} repository={repository} /></div>
    {submission.feedback && <div className="teaching-submission-feedback mt-4"><strong>Попередній коментар викладача</strong><p>{submission.feedback}</p><small>{submission.reviewer_name} · {teachingDate(submission.reviewed_at, true)}</small></div>}
    <TeachingSubmissionHistoryList history={(data.history || []).filter(item => item.submission_id === submission.id)} repository={repository} />
    {!actionable ? <div className="teaching-note mt-4">{submission.status === 'returned' ? 'Роботу повернуто на доопрацювання. Перевірка стане доступною після нової спроби студента.' : 'Перегляд роботи. Для змін потрібен відкритий семестр і дозвіл на перевірку.'}</div> : <form className="teaching-form mt-5" onSubmit={save}>
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {committed ? <div role="status" className="teaching-submission-feedback"><strong><CheckCircle2 size={16} />{decision === 'returned' ? 'Роботу повернуто на доопрацювання' : 'Перевірку опубліковано'}</strong><p>Студент отримає сповіщення. Якщо список ще не оновився, повторіть тільки оновлення.</p></div> : <>
        {returnOnly ? <p className="teaching-note">Результати в журналі зберігаються. Повернення відкриє студенту редагування та можливість здати нову спробу.</p> : <TeachingField label="Результат перевірки"><select name="submission-review-decision" className={teachingInput} value={decision} disabled={busy || needsRefresh} onChange={event => setDecision(event.target.value as 'reviewed' | 'returned')}><option value="reviewed">Прийняти роботу</option><option value="returned">Повернути на доопрацювання</option></select></TeachingField>}
        <TeachingField label={decision === 'returned' ? 'Що потрібно доопрацювати' : 'Коментар студенту'} hint="Коментар опублікується після підтвердження перевірки. Його бачать студент і викладачі з відповідним дозволом."><textarea name="submission-review-feedback" className={teachingInput} value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={2000} rows={4} required={decision === 'returned'} disabled={busy || needsRefresh} placeholder={decision === 'returned' ? 'Наприклад, додайте пояснення до другого розрахунку…' : 'Дайте зворотний зв’язок щодо роботи…'} /></TeachingField>
        {decision === 'reviewed' && canGrade && <div className="teaching-simple-assessment"><label className="teaching-check"><input type="checkbox" checked={publishScore} onChange={event => setPublishScore(event.target.checked)} disabled={busy || needsRefresh} />Опублікувати бали в журналі разом із перевіркою</label>{publishScore && <div className="mt-4 space-y-3"><TeachingField label={'Бали · максимум ' + data.max_points} hint="0 — виставлений результат. Порожнє поле прибере бал; відсутність оцінки не означає нуль."><input name="submission-review-score" className={teachingInput} inputMode="decimal" value={score} onChange={event => setScore(event.target.value)} maxLength={12} disabled={busy || needsRefresh} placeholder="—" /></TeachingField>{hasPublishedGrade && <TeachingField label="Причина зміни результату" hint="Обов’язково, якщо змінюєте вже опублікований бал або його коментар."><input name="submission-review-reason" className={teachingInput} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy || needsRefresh} /></TeachingField>}</div>}</div>}
        {decision === 'reviewed' && !canGrade && <p className="teaching-note">Можна прийняти роботу та опублікувати коментар. Бали виставляють викладачі з дозволом на журнал для оцінюваних завдань.</p>}
        {needsRefresh && <p className="teaching-note">Оновіть роботу перед повторною дією. Нові коментарі та бали не замінять іншу версію без підтвердження.</p>}
      </>}
      <div className="teaching-form-actions"><TeachingButton onClick={onClose} disabled={busy}>Закрити</TeachingButton>{committed || needsRefresh ? <TeachingButton primary busy={busy} onClick={() => void refresh()}><RefreshCw size={15} />Оновити список</TeachingButton> : <TeachingButton primary type="submit" busy={busy}>{decision === 'returned' ? <RotateCcw size={15} /> : <Send size={15} />}{decision === 'returned' ? 'Повернути на доопрацювання' : publishScore ? 'Прийняти й опублікувати бали' : 'Прийняти й опублікувати коментар'}</TeachingButton>}</div>
    </form>}
  </TeachingModal>
}
