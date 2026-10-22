import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { BookOpen, Check, GraduationCap, Plus } from 'lucide-react'
import { defaultTeachingSemester, supabaseTeachingRepository, teachingDate, teachingError, type TeachingGroupData, type TeachingPublication, type TeachingRepository, type TeachingWorkspaceData } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingResources } from './TeachingPublications'
import { TeachingMyGrades } from './TeachingMyGrades'
import { TeachingLaunchNotice } from './TeachingLaunchNotice'
import { TeachingSubmissionPanel } from './TeachingSubmissionPanel'
import { TeacherSourceBadge } from './TeacherSourceBadge'
import { TeachingGradeRequests } from './TeachingGradeRequests'

export function GroupTeachingPanel({ groupId, userId, canInvite, view = 'schedule', showAssignments = true, repository = supabaseTeachingRepository }: { groupId: string; userId: string; canInvite: boolean; view?: 'schedule' | 'materials'; showAssignments?: boolean; repository?: TeachingRepository }) {
  const [storedData, setData] = useState<TeachingGroupData | null>(null), [workspace, setWorkspace] = useState<TeachingWorkspaceData | null>(null)
  const scopeKey = `${groupId}:${userId}`
  const [loadedScope, setLoadedScope] = useState('')
  const data = loadedScope === scopeKey ? storedData : null
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [invite, setInvite] = useState(false)
  const [selectedCourse, setSelectedCourse] = useState(''), [journalOpen, setJournalOpen] = useState(false)
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [selectedAssignment, setSelectedAssignment] = useState<TeachingPublication | null>(null)
  const [submissionBusy, setSubmissionBusy] = useState(false)
  const [claims, setClaims] = useState<TeachingWorkspaceData['roster_claims']>([])
  const generation = useRef(0)
  const load = useCallback(async () => {
    const version = ++generation.current
    try {
      const [next, directory] = await Promise.all([repository.group(groupId), repository.workspace()])
      if (version !== generation.current) return
      setData(next); setLoadedScope(scopeKey); setClaims(directory.roster_claims || []); setWorkspace(directory); setError('')
    } catch (failure) {
      if (version === generation.current) throw failure
    }
  }, [groupId, repository, scopeKey])
  useEffect(() => { setData(null); setLoadedScope(''); setWorkspace(null); setClaims([]); setError(''); setInvite(false); setJournalOpen(false); setRequestsOpen(false); setSelectedCourse(''); setSelectedAssignment(null); void load().catch(failure => { setError(teachingError(failure)) }); return () => { generation.current++ } }, [load, userId])
  async function act(action: string, payload: Record<string, unknown>) {
    if (busy) return
    setBusy(action); setError('')
    try { await repository.mutate(action, payload); await load() } catch (failure) { setError(teachingError(failure)) } finally { setBusy('') }
  }
  if (!data) return error ? <div className="teaching-note mb-5"><p role="status">{error}</p><button type="button" className="mt-2 min-h-9 text-xs font-semibold text-primary" onClick={() => void load().catch(failure => setError(teachingError(failure)))}>Оновити викладання</button></div> : null
  const items = (view === 'schedule' ? data.assignments : data.materials).filter(item => !selectedCourse || item.course_id === selectedCourse)
  const relevantClaims = claims?.filter(claim => claim.status === 'pending' && (!claim.group_id || claim.group_id === groupId)) || []
  return <section className="teaching-card mb-5" aria-label={view === 'schedule' ? 'Викладачі та їхні завдання' : 'Матеріали викладачів'}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><span className="teaching-eyebrow"><GraduationCap size={14} />Викладання</span><h2 className="text-base font-semibold">{view === 'schedule' ? showAssignments ? 'Завдання викладачів і мої бали' : 'Викладачі та мої бали' : 'Матеріали викладачів'}</h2></div><div className="flex flex-wrap gap-2">{view === 'schedule' && !data.courses.length && <TeachingButton onClick={() => setJournalOpen(true)}><BookOpen size={16} />Мої бали</TeachingButton>}{canInvite && <TeachingButton onClick={() => setInvite(true)}><Plus size={15} />Запросити викладача</TeachingButton>}</div></div>
    {!data.courses.length && <TeachingLaunchNotice />}
    {error && <p role="alert" className="teaching-error mb-4">{error}</p>}
    {data.pending_invites.map(link => <div className="teaching-list-row mb-3" key={link.id}><div><h3>{link.teacher_name} · {link.title}</h3><p>{link.semester} · {link.status === 'pending_teacher' ? 'Очікуємо підтвердження викладача' : 'Викладач запрошує вашу групу'}</p></div>{canInvite && link.status === 'pending_group' && <div className="flex gap-2"><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_group', { link_id: link.id, accept: true })}><Check size={15} />Підключити</TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_group', { link_id: link.id, accept: false })}>Відхилити</TeachingButton></div>}</div>)}
    {relevantClaims.map(claim => <div className="teaching-list-row mb-3" key={claim.id}><div><h3>Підтвердіть свій запис у журналі</h3><p>{claim.full_name} · {claim.course_title}</p><p>Підтвердьте лише якщо цей запис справді стосується вас.</p></div><div className="flex gap-2"><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_roster_link', { claim_id: claim.id, accept: true })}>Це я</TeachingButton><TeachingButton disabled={Boolean(busy)} onClick={() => void act('respond_roster_link', { claim_id: claim.id, accept: false })}>Не я</TeachingButton></div></div>)}
    {!!data.courses.length && <div className="mb-4 flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><TeachingField label="Предмет"><select name="group-teaching-course" className={teachingInput} value={selectedCourse} onChange={e => setSelectedCourse(e.target.value)}><option value="">Усі предмети</option>{data.courses.map(course => <option value={course.id} key={course.id}>{course.title} · {course.semester}</option>)}</select></TeachingField></div>{view === 'schedule' && <TeachingButton disabled={Boolean(busy)} onClick={() => setJournalOpen(true)}><BookOpen size={16} />Мої бали</TeachingButton>}</div>}
    {showAssignments && (!items.length ? <p className="text-sm leading-relaxed text-muted-foreground">{!data.courses.length ? canInvite ? 'Підключіть викладача до предмета. Його завдання й матеріали з’являтимуться тут.' : 'Коли викладач підключиться до групи, тут з’являться його публікації та ваші результати.' : view === 'schedule' ? 'Опублікованих завдань ще немає.' : 'Опублікованих матеріалів ще немає.'}</p> : <div className="space-y-4">{items.map(item => <article key={item.id} className="rounded-xl border border-border p-4"><TeacherSourceBadge /><span className="ml-2 teaching-badge teaching-badge-blue">{data.courses.find(c => c.id === item.course_id)?.title || 'Предмет'}</span><h3 className="mt-3 break-words text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted-foreground">Викладач: {item.author_name}{view === 'schedule' ? ` · Термін: ${teachingDate(item.targets.find(t => t.group_id === groupId)?.due_at, true)}` : ''}</p>{item.body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>}<TeachingResources publication={item} repository={repository} kind={view === 'materials' ? 'material' : 'assignment'} />{view === 'schedule' && <div className="mt-4"><TeachingButton onClick={() => setSelectedAssignment(item)}>Моя робота</TeachingButton></div>}</article>)}</div>)}
    {selectedAssignment && <TeachingModal title={selectedAssignment.title} description="Вашу роботу бачите лише ви та викладачі цього предмета з відповідним дозволом." onClose={() => setSelectedAssignment(null)} busy={submissionBusy}><TeachingSubmissionPanel assignment={selectedAssignment} groupId={groupId} userId={userId} repository={repository} onRefresh={load} defaultExpanded onBusyChange={setSubmissionBusy} /></TeachingModal>}
    {invite && workspace && <GroupTeacherInvitation repository={repository} groupId={groupId} workspace={workspace} onClose={() => setInvite(false)} onSaved={load} />}
    {view === 'schedule' && data.courses.length > 0 && <div className="mt-4"><TeachingButton onClick={() => setRequestsOpen(true)}>Запити щодо балів</TeachingButton></div>}
    {requestsOpen && <TeachingModal wide title="Мої запити щодо балів" onClose={() => setRequestsOpen(false)}><TeachingGradeRequests key={scopeKey} repository={repository} userId={userId} groupId={groupId} mode="student" /></TeachingModal>}
    {journalOpen && <TeachingModal wide title="Мої бали" description="Ваша успішність за предметами поточної групи. Лише опубліковані результати." onClose={() => setJournalOpen(false)}><TeachingMyGrades key={scopeKey} data={data} groupId={groupId} repository={repository} initialCourseId={selectedCourse} onRefresh={load} /></TeachingModal>}
  </section>
}
function GroupTeacherInvitation({ repository, groupId, workspace, onClose, onSaved }: { repository: TeachingRepository; groupId: string; workspace: TeachingWorkspaceData; onClose: () => void; onSaved: () => Promise<void> }) {
  const defaults = defaultTeachingSemester()
  const [id] = useState(crypto.randomUUID())
  const [teacher, setTeacher] = useState(''), [title, setTitle] = useState(''), [semester, setSemester] = useState(defaults.semester), [starts, setStarts] = useState(defaults.starts_on), [ends, setEnds] = useState(defaults.ends_on), [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const subjects = workspace.groups.find(g => g.id === groupId)?.subjects || []
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || committed) return
    setBusy(true); setError('')
    try {
      if (starts > ends) throw new Error('Дата завершення має бути після початку.')
      await repository.mutate('invite_teacher_from_group', { id, teacher_id: teacher, group_id: groupId, title: title.trim(), semester: semester.trim(), starts_on: starts, ends_on: ends, subject_id: subject || null })
      setCommitted(true); await onSaved(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { setBusy(false) }
  }
  return <TeachingModal title="Запросити викладача" description="Викладач підтвердить запрошення. Доступ буде лише до вказаного предмета й семестру." onClose={onClose} busy={busy}><TeachingLaunchNotice /><form className="teaching-form" onSubmit={submit}>{error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p className="teaching-note">Запрошення збережено. Оновіть список, якщо його ще не видно.</p> : <>
    <TeachingField label="Підтверджений викладач"><select name="group-teacher" className={teachingInput} required value={teacher} onChange={e => setTeacher(e.target.value)} disabled={busy}><option value="">Оберіть викладача</option>{workspace.teacher_directory.map(t => <option key={t.user_id || t.id} value={t.user_id || t.id}>{t.full_name} · {t.department}</option>)}</select></TeachingField>
    {!!subjects.length && <TeachingField label="Предмет у семінарах"><select name="group-teacher-subject" className={teachingInput} value={subject} onChange={e => { setSubject(e.target.value); const name = subjects.find(s => s.id === e.target.value)?.name; if (name) setTitle(name) }} disabled={busy}><option value="">Інший предмет</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></TeachingField>}
    <TeachingField label="Назва предмета"><input name="group-teacher-title" className={teachingInput} required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} /></TeachingField><TeachingField label="Семестр"><input name="group-teacher-semester" className={teachingInput} required maxLength={100} value={semester} onChange={e => setSemester(e.target.value)} disabled={busy} /></TeachingField>
    <div className="grid grid-cols-2 gap-3"><TeachingField label="Початок"><input name="group-teacher-start" type="date" className={teachingInput} value={starts} onChange={e => setStarts(e.target.value)} required disabled={busy} /></TeachingField><TeachingField label="Завершення"><input name="group-teacher-end" type="date" className={teachingInput} value={ends} onChange={e => setEnds(e.target.value)} min={starts} required disabled={busy} /></TeachingField></div>
    {!workspace.teacher_directory.length && <TeachingEmpty title="Підтверджених викладачів поки немає" description="Викладач має зареєструватися та підтвердити свій статус у Xelay." />}</>}
    <div className="teaching-form-actions"><TeachingButton onClick={onClose} disabled={busy}>{committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{!committed && <TeachingButton primary type="submit" busy={busy} disabled={!workspace.teacher_directory.length}>Надіслати запрошення</TeachingButton>}</div>
  </form></TeachingModal>
}
