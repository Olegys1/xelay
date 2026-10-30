import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, CheckCheck, MessageSquareText, Plus, RefreshCw, Send } from 'lucide-react'
import { teachingDate, teachingError, type TeachingGradeRequest, type TeachingGradeRequestActivity, type TeachingOwnGrade, type TeachingRepository } from '../../lib/teaching'
import { useTeachingVisibilityRefresh } from '../../lib/useTeachingVisibilityRefresh'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingVoiceRecorder } from './TeachingVoiceRecorder'
import { TeachingGradeVoicePlayer } from './TeachingGradeVoicePlayer'
import type { TeachingVoiceRecording } from '../../lib/teachingVoiceRecording'
import type { TeachingGradeVoice } from '../../lib/teachingGradeVoice'
import { isStudyGroupListed } from '../../lib/studyGroupVisibility'
import './teaching-workflow.css'

function useCurrentRequestScope(repository: TeachingRepository, key: string) {
  const scope = useRef({ repository, key }), mounted = useRef(true)
  scope.current = { repository, key }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return () => mounted.current && scope.current.repository === repository && scope.current.key === key
}

function GradeRequestComposer({ repository, activityId, title, onSaved, onClose, isCurrent = () => true }: { repository: TeachingRepository; activityId: string; title: string; onSaved: () => Promise<void>; onClose: () => void; isCurrent?: () => boolean }) {
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const [alreadyOpen, setAlreadyOpen] = useState(false)
  const requestId = useRef(crypto.randomUUID()), lock = useRef(false)
  async function send() {
    if (lock.current || saved || !isCurrent()) return
    if (message.trim().length < 2 || message.trim().length > 1000) { setError('Напишіть коротке пояснення від 2 до 1000 символів.'); return }
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await repository.requestGrade(activityId, message.trim(), requestId.current)
      if (!isCurrent()) return
      setAlreadyOpen(result.existing === true)
      setSaved(true)
      await onSaved()
    } catch (failure) { if (isCurrent()) setError(teachingError(failure)) }
    finally { lock.current = false; if (isCurrent()) setBusy(false) }
  }
  return <TeachingModal title="Попросити перевірити бали" description={title} onClose={onClose} busy={busy}>
    <p className="teaching-note">Запит побачать викладачі цього предмета з доступом до журналу. Поясніть, яка робота потребує перевірки або уточнення результату.</p>
    {error && <p role="alert" className="teaching-error mt-4">{error}</p>}
    {saved ? <p role="status" className="teaching-note mt-4">{alreadyOpen ? 'За цією роботою вже є запит у черзі викладача. Попередній текст збережено без змін.' : 'Запит надіслано. Відповідь з’явиться у ваших запитах щодо балів.'}</p> : <TeachingField label="Повідомлення викладачу"><textarea className={teachingInput} value={message} onChange={event => setMessage(event.target.value)} maxLength={1000} minLength={2} rows={4} disabled={busy} placeholder="Наприклад: здавав роботу на семінарі, але результат ще не з’явився." /></TeachingField>}
    <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{saved ? 'Готово' : 'Скасувати'}</TeachingButton>{!saved && <TeachingButton primary busy={busy} onClick={() => void send()}><Send size={15} />Надіслати запит</TeachingButton>}</div>
  </TeachingModal>
}

export function TeachingGradeRequestButton({ repository, grade }: { repository: TeachingRepository; grade: TeachingOwnGrade }) {
  const [open, setOpen] = useState(false), [sent, setSent] = useState(false)
  const [existing, setExisting] = useState<TeachingGradeRequest | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const isCurrent = useCurrentRequestScope(repository, `${grade.entry_id}:${grade.activity_id}`)
  useEffect(() => { setOpen(false); setSent(false); setExisting(null); setLoading(false); setError('') }, [grade.activity_id, grade.entry_id, repository])
  async function openRequest() {
    if (loading || !isCurrent()) return
    setLoading(true); setError('')
    try {
      const result = await repository.gradeRequests(grade.course_id)
      if (!isCurrent()) return
      const prior = result.requests.find(row => row.activity_id === grade.activity_id && row.entry_id === grade.entry_id && row.status === 'open')
      if (prior) setExisting(prior)
      else setOpen(true)
    } catch (failure) { if (isCurrent()) setError(teachingError(failure)) }
    finally { if (isCurrent()) setLoading(false) }
  }
  return <div className="teaching-grade-request"><TeachingButton busy={loading} onClick={() => void openRequest()}><MessageSquareText size={14} />{sent ? 'Переглянути запит' : 'Попросити перевірити'}</TeachingButton>{error && <p role="alert" className="teaching-error mt-3">{error}</p>}{open && <GradeRequestComposer key={`${grade.entry_id}:${grade.activity_id}`} repository={repository} activityId={grade.activity_id} title={`${grade.course_title} · ${grade.activity_title}`} isCurrent={isCurrent} onSaved={async () => { if (isCurrent()) setSent(true) }} onClose={() => setOpen(false)} />}{existing && <TeachingModal title="Запит уже очікує відповіді" description={`${grade.course_title} · ${grade.activity_title}`} onClose={() => setExisting(null)}><p className="teaching-note">Ваш попередній запит надіслано {teachingDate(existing.created_at, true)}. Він залишається в черзі викладача.</p><p className="mt-4 whitespace-pre-wrap break-words text-sm">{existing.message}</p><div className="teaching-form-actions"><TeachingButton onClick={() => setExisting(null)}>Готово</TeachingButton></div></TeachingModal>}</div>
}

type Props = { repository: TeachingRepository; userId: string; mode: 'teacher' | 'student'; groupId?: string; courseId?: string; onOpenJournal?: (courseId: string, groupId: string) => void; refreshKey?: number }
export function TeachingGradeRequests({ repository, userId, mode, groupId, courseId, onOpenJournal, refreshKey }: Props) {
  const [requests, setRequests] = useState<TeachingGradeRequest[]>([]), [activities, setActivities] = useState<TeachingGradeRequestActivity[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [filter, setFilter] = useState('open'), [group, setGroup] = useState(groupId || '')
  const [compose, setCompose] = useState<TeachingGradeRequestActivity | null>(null), [activityId, setActivityId] = useState(''), [reply, setReply] = useState<TeachingGradeRequest | null>(null)
  const generation = useRef(0)
  const scopeKey = `${userId}:${mode}:${groupId || ''}:${courseId || ''}`
  const isCurrent = useCurrentRequestScope(repository, scopeKey)
  const [loadedScope, setLoadedScope] = useState<{ key: string; repository: TeachingRepository } | null>(null)
  const load = useCallback(async () => {
    if (!isCurrent()) return
    const version = ++generation.current
    setLoading(true); setError('')
    try {
      const data = await repository.gradeRequests(courseId)
      if (version === generation.current && isCurrent()) { setRequests(data.requests); setActivities(data.available_activities || []); setLoadedScope({ key: scopeKey, repository }) }
    } catch (failure) { if (version === generation.current && isCurrent()) { setRequests([]); setActivities([]); setLoadedScope(null); setError(teachingError(failure)) } }
    finally { if (version === generation.current && isCurrent()) setLoading(false) }
  }, [repository, scopeKey])
  useEffect(() => { setRequests([]); setActivities([]); setCompose(null); setReply(null); setGroup(groupId || ''); void load(); return () => { generation.current++ } }, [load, groupId])
  const refreshBlocked = loading || Boolean(compose || reply)
  useTeachingVisibilityRefresh(load, { enabled: mode === 'teacher', blocked: refreshBlocked })
  const previousRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return
    previousRefreshKey.current = refreshKey
    if (!refreshBlocked) void load()
  }, [refreshKey, refreshBlocked, load])
  const scopeLoaded = loadedScope?.key === scopeKey && loadedScope.repository === repository
  const currentRequests = scopeLoaded ? requests : [], currentActivities = scopeLoaded ? activities : []
  const visible = currentRequests.filter(row => (mode !== 'teacher' || row.can_manage === true) && (!group || row.group_id === group) && (!filter || row.status === filter))
  const available = currentActivities.filter(row => (!group || row.group_id === group) && !currentRequests.some(request => request.activity_id === row.activity_id && request.status === 'open'))
  const groups = [...new Map([...currentRequests, ...currentActivities].filter(row => isStudyGroupListed(row.group_id)).map(row => [row.group_id, row.group_name || 'Моя група'])).entries()]
  return <section aria-label="Запити щодо балів">
    <div className="teaching-workflow-heading"><div><span className="teaching-eyebrow"><MessageSquareText size={15} />Приватно між студентом і викладачем</span><h2>Запити щодо балів</h2><p>{mode === 'teacher' ? 'Нагадування про неперевірені роботи та запитання щодо результатів.' : 'Попросіть перевірити роботу або уточнити вже опублікований результат.'}</p></div><TeachingButton onClick={() => void load()} disabled={loading}><RefreshCw size={15} />Оновити</TeachingButton></div>
    <div className="mb-5 grid gap-3 sm:grid-cols-2"><TeachingField label="Стан"><select className={teachingInput} value={filter} onChange={event => setFilter(event.target.value)}><option value="open">Очікують відповіді</option><option value="resolved">Із відповіддю</option><option value="">Усі запити</option></select></TeachingField><TeachingField label="Група"><select className={teachingInput} value={group} onChange={event => setGroup(event.target.value)} disabled={Boolean(groupId)}><option value="">Усі групи</option>{groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></TeachingField></div>
    {mode === 'student' && <div className="teaching-card mb-5"><h3 className="font-semibold">Роботу ще не оцінено?</h3><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Можна надіслати запит, навіть якщо бал ще не опублікований.</p><div className="mt-4 flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><TeachingField label="Оберіть роботу"><select className={teachingInput} value={activityId} onChange={event => setActivityId(event.target.value)}><option value="">Оберіть роботу зі свого журналу</option>{available.map(row => <option key={row.activity_id} value={row.activity_id}>{row.course_title} · {row.activity_title} · {teachingDate(row.activity_date)}</option>)}</select></TeachingField></div><TeachingButton disabled={!available.some(row => row.activity_id === activityId)} onClick={() => setCompose(available.find(row => row.activity_id === activityId) || null)}><Plus size={15} />Створити запит</TeachingButton></div></div>}
    {error && <p role="alert" className="teaching-error mb-4">{error}</p>}
    {loading ? <p className="teaching-note" aria-busy="true">Завантажуємо запити…</p> : !visible.length ? <TeachingEmpty icon={<MessageSquareText size={25} />} title="Запитів поки немає" description="Тут з’являться запитання й відповіді щодо робіт і балів." /> : <div className="teaching-list">{visible.map(row => <article key={`${scopeKey}:${row.id}`} className="teaching-card">
      <div className="flex flex-wrap items-center justify-between gap-3"><span className={`teaching-badge ${row.status === 'resolved' ? 'teaching-badge-blue' : ''}`}>{row.status === 'resolved' ? 'Відповідь надано' : 'Очікує відповіді'}</span><span className="text-xs text-muted-foreground">{teachingDate(row.created_at, true)}</span></div>
      <h3 className="mt-3 font-semibold">{row.activity_title}</h3><p className="mt-1 text-xs text-muted-foreground">{row.course_title}{row.group_name && isStudyGroupListed(row.group_id) ? ` · ${row.group_name}` : ''}{mode === 'teacher' ? ` · ${row.student_name}` : ''}</p>
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{row.message}</p>
      {row.response && <div className="teaching-note mt-4"><strong>Відповідь викладача</strong><p className="mt-2 whitespace-pre-wrap break-words">{row.response}</p></div>}
      {row.response_voice && row.status === 'resolved' && <TeachingGradeVoicePlayer repository={repository} requestId={row.id} voice={row.response_voice} userId={userId} />}
      {mode === 'teacher' && <div className="mt-4 flex flex-wrap gap-2">{onOpenJournal && <TeachingButton onClick={() => onOpenJournal(row.course_id, row.group_id)}><BookOpen size={15} />До журналу</TeachingButton>}{row.status === 'open' && row.can_resolve && <TeachingButton primary onClick={() => setReply(row)}><CheckCheck size={15} />Відповісти</TeachingButton>}</div>}
    </article>)}</div>}
    {compose && scopeLoaded && <GradeRequestComposer key={`${scopeKey}:${compose.activity_id}`} repository={repository} activityId={compose.activity_id} title={`${compose.course_title} · ${compose.activity_title}`} isCurrent={isCurrent} onSaved={load} onClose={() => setCompose(null)} />}
    {reply && scopeLoaded && mode === 'teacher' && reply.can_resolve && <GradeRequestReply key={`${scopeKey}:${reply.id}:${reply.version}`} repository={repository} userId={userId} request={reply} isCurrent={isCurrent} onSaved={load} onClose={() => setReply(null)} />}
  </section>
}

function GradeRequestReply({ repository, userId, request, onSaved, onClose, isCurrent }: { repository: TeachingRepository; userId: string; request: TeachingGradeRequest; onSaved: () => Promise<void>; onClose: () => void; isCurrent: () => boolean }) {
  const [response, setResponse] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const [recording, setRecording] = useState<TeachingVoiceRecording | null>(null), [recordingBusy, setRecordingBusy] = useState(false), [progress, setProgress] = useState<number | null>(null)
  const lock = useRef(false)
  const uploaded = useRef<{ recording: TeachingVoiceRecording; voice: TeachingGradeVoice } | null>(null)
  const abort = useRef<AbortController | null>(null), completed = useRef(false)
  useEffect(() => () => {
    abort.current?.abort()
    const candidate = uploaded.current
    // The server permits cleanup only while the blob is unused. If an uncertain
    // send actually succeeded, cleanup must never remove its published reply.
    if (candidate && !completed.current) void repository.discardGradeVoice?.(request.id, candidate.voice).catch(() => {})
  }, [repository, request.id])
  function changeRecording(next: TeachingVoiceRecording | null) {
    if (busy) return
    const prior = uploaded.current
    if (prior && prior.recording !== next) {
      uploaded.current = null
      void repository.discardGradeVoice?.(request.id, prior.voice).catch(() => {})
    }
    setRecording(next); setProgress(null); setError('')
  }
  async function submit() {
    if (lock.current || saved || recordingBusy || !isCurrent()) return
    if (response.trim().length > 2000 || (!recording && response.trim().length < 2)) { setError('Напишіть відповідь або запишіть голосове повідомлення.'); return }
    if (recording && !repository.uploadGradeVoice) { setError('Голосові відповіді ще підключаються. Поки можна надіслати текст.'); return }
    lock.current = true; setBusy(true); setError('')
    abort.current = new AbortController()
    try {
      let voice: TeachingGradeVoice | null = null
      if (recording) {
        if (uploaded.current?.recording === recording) voice = uploaded.current.voice
        else {
          voice = await repository.uploadGradeVoice!(request.id, userId, recording, percent => { if (isCurrent()) setProgress(percent) }, abort.current.signal)
          if (!isCurrent()) {
            void repository.discardGradeVoice?.(request.id, voice).catch(() => {})
            return
          }
          uploaded.current = { recording, voice }
        }
      }
      if (!isCurrent()) return
      await repository.resolveGradeRequest(request.id, request.version, response.trim(), voice)
      completed.current = true
      if (!isCurrent()) return
      setSaved(true); await onSaved()
    }
    catch (failure) { if (isCurrent()) setError(teachingError(failure)) }
    finally { lock.current = false; if (isCurrent()) setBusy(false) }
  }
  return <TeachingModal title="Відповісти студенту" description={`${request.student_name} · ${request.activity_title}`} busy={busy} onClose={onClose}>
    <p className="teaching-note">Відповідь закриє запит. Можна надіслати текст, голосове або обидва. Якщо потрібна зміна балів, збережіть та опублікуйте її в журналі.</p>
    {error && <p className="teaching-error mt-4" role="alert">{error}</p>}
    {saved ? <p className="teaching-note mt-4" role="status">Відповідь збережено. Студент отримає сповіщення{recording ? ' та зможе прослухати запис у своєму запиті' : ''}.</p> : <>
      <TeachingField label="Текст відповіді · необов’язково з голосовим"><textarea className={teachingInput} rows={3} maxLength={2000} value={response} disabled={busy} onChange={event => setResponse(event.target.value)} placeholder="Пояснення щодо роботи або балів…" /></TeachingField>
      {repository.uploadGradeVoice && <TeachingVoiceRecorder value={recording} onChange={changeRecording} disabled={busy} onRecordingChange={setRecordingBusy} />}
      {busy && progress !== null && <div className="mt-4" role="status"><p className="mb-2 text-sm">Завантаження голосового: {progress}%</p><progress className="w-full accent-sky-500" value={progress} max={100} aria-label="Завантаження голосового повідомлення" /></div>}
    </>}
    <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{saved ? 'Готово' : 'Скасувати'}</TeachingButton>{!saved && <TeachingButton primary busy={busy} disabled={recordingBusy || (!recording && response.trim().length < 2)} onClick={() => void submit()}>Надіслати відповідь</TeachingButton>}</div>
  </TeachingModal>
}
