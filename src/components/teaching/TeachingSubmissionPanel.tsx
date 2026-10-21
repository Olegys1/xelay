import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, ChevronDown, Download, ExternalLink, FileText, History, Paperclip, RefreshCw, RotateCcw, Save, Send, X } from 'lucide-react'
import {
  TEACHING_FILE_ACCEPT, TEACHING_MAX_FILE_BYTES, teachingDate, teachingError, validateTeachingFile, validateTeachingLinks,
  type TeachingFile, type TeachingPublication, type TeachingRepository, type TeachingSubmission,
  type TeachingSubmissionData, type TeachingSubmissionHistory, type TeachingSubmissionStatus,
} from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-submissions.css'

const STATUS_LABELS: Record<TeachingSubmissionStatus, string> = {
  draft: 'Чернетка', submitted: 'Здано · очікує перевірки', returned: 'На доопрацюванні', reviewed: 'Перевірено',
}
export function TeachingSubmissionStatusBadge({ status }: { status: TeachingSubmissionStatus | 'missing' }) {
  return <span className={'teaching-submission-status teaching-submission-status-' + status}>{status === 'missing' ? 'Не здано' : STATUS_LABELS[status]}</span>
}
export function teachingSubmissionError(error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  if (/CONFLICT/.test(message)) return 'Робота або її оцінка вже змінилася. Оновіть збережені дані перед наступною дією.'
  if (/ROSTER_LINK_REQUIRED/.test(message)) return 'Спочатку потрібно підтвердити прив’язку студента до запису журналу. Коментар можна опублікувати без балів.'
  if (/REVISION_REASON_REQUIRED/.test(message)) return 'Додайте причину зміни вже опублікованих балів — щонайменше два символи.'
  return teachingError(error)
}
export function TeachingSubmissionResources({ links, attachments, repository }: { links: string[]; attachments: TeachingFile[]; repository: TeachingRepository }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  async function download(file: TeachingFile) {
    if (busy) return
    setBusy(file.storage_path); setError('')
    try {
      const url = await repository.submissionFileUrl(file)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.download = file.name
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
    } catch (failure) { setError(teachingSubmissionError(failure)) } finally { setBusy('') }
  }
  return <>{(links.length > 0 || attachments.length > 0) && <div className="teaching-submission-resources">
    {links.map((url, index) => {
      let valid = false
      try { const parsed = new URL(url); valid = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password } catch {}
      return valid ? <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="teaching-resource"><ExternalLink size={14} />Посилання {index + 1}</a> : null
    })}
    {attachments.map(file => <button type="button" key={file.storage_path} className="teaching-resource" disabled={Boolean(busy)} onClick={() => void download(file)}><Download size={14} className="shrink-0" /><span className="truncate">{busy === file.storage_path ? 'Відкриваємо…' : file.name}</span></button>)}
  </div>}{error && <p role="alert" className="teaching-error mt-3">{error}</p>}</>
}
export function TeachingSubmissionHistoryList({ history, repository }: { history: TeachingSubmissionHistory[]; repository: TeachingRepository }) {
  if (!history.length) return null
  const events: Record<string, string> = { submitted: 'Роботу здано', withdrawn: 'Роботу відкликано', returned: 'Повернуто на доопрацювання', reviewed: 'Роботу перевірено', draft: 'Чернетка' }
  return <details className="teaching-submission-history"><summary><History size={16} />Історія роботи · {history.length}<ChevronDown size={15} /></summary><div className="teaching-submission-history-list">{[...history].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(item => {
    const event = item.event || item.action || item.status
    const score = item.published_score !== undefined ? item.published_score : item.score
    return <details className="teaching-submission-history-item" key={item.id}><summary><span><strong>{events[event || ''] || 'Оновлення роботи'}</strong><small>Спроба {item.attempt} · {teachingDate(item.created_at, true)}{item.actor_name ? ' · ' + item.actor_name : ''}</small></span><ChevronDown size={14} /></summary><div>
      {item.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>}
      <TeachingSubmissionResources links={item.links || []} attachments={item.attachments || []} repository={repository} />
      {item.feedback && <div className="teaching-submission-feedback"><strong>Коментар викладача</strong><p>{item.feedback}</p></div>}
      {score !== undefined && score !== null && <p className="mt-3 text-sm font-semibold">Опубліковано: {score} балів</p>}
    </div></details>
  })}</div></details>
}

type StudentProps = { repository: TeachingRepository; assignment: TeachingPublication; groupId: string; userId: string; onRefresh?: () => Promise<void>; defaultExpanded?: boolean; onBusyChange?: (busy: boolean) => void }
export function TeachingSubmissionPanel({ repository, assignment, groupId, userId, onRefresh, defaultExpanded = false, onBusyChange }: StudentProps) {
  const [expanded, setExpanded] = useState(defaultExpanded), [loading, setLoading] = useState(false)
  const [data, setData] = useState<TeachingSubmissionData | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [withdraw, setWithdraw] = useState(false), [withdrawCommitted, setWithdrawCommitted] = useState(false)
  const generation = useRef(0), actionLock = useRef(false)
  const onBusyChangeRef = useRef(onBusyChange)
  onBusyChangeRef.current = onBusyChange
  const reportBusy = useCallback((value: boolean) => { setBusy(value); onBusyChangeRef.current?.(value) }, [])
  useEffect(() => () => { onBusyChangeRef.current?.(false) }, [])
  const currentKey = assignment.id + ':' + groupId + ':' + userId
  const [loadedKey, setLoadedKey] = useState('')
  const load = useCallback(async () => {
    const version = ++generation.current
    setLoading(true); setError('')
    try {
      const next = await repository.classroom(assignment.id, groupId)
      if (version !== generation.current) return
      setData(next); setLoadedKey(currentKey); setWithdrawCommitted(false); setWithdraw(false)
    } catch (failure) {
      if (version === generation.current) { setError(teachingSubmissionError(failure)); throw failure }
    } finally { if (version === generation.current) setLoading(false) }
  }, [repository, assignment.id, groupId, currentKey])
  useEffect(() => { generation.current++; setData(null); setLoadedKey(''); setExpanded(defaultExpanded); setError(''); setWithdraw(false); setWithdrawCommitted(false); if (defaultExpanded) void load().catch(() => {}); return () => { generation.current++ } }, [currentKey, defaultExpanded, load])
  async function open() {
    setExpanded(value => !value)
    if (!data || loadedKey !== currentKey) await load()
  }
  async function saved() { await load(); if (onRefresh) await onRefresh() }
  async function withdrawWork() {
    if (actionLock.current || !data?.my_submission || withdrawCommitted) return
    actionLock.current = true; reportBusy(true); setError('')
    try {
      await repository.classroomMutate('withdraw_submission', { id: data.my_submission.id, version: data.my_submission.version })
      setWithdrawCommitted(true); await saved()
    } catch (failure) { setError(teachingSubmissionError(failure)) } finally { actionLock.current = false; reportBusy(false) }
  }
  const current = loadedKey === currentKey ? data : null
  const submission = current?.my_submission?.user_id === userId ? current.my_submission : null
  return <section className="teaching-student-submission" aria-label="Моя робота">
    <div className="teaching-submission-heading"><div><span className="text-sm font-semibold">Моя робота</span>{current && <TeachingSubmissionStatusBadge status={submission?.status || 'missing'} />}</div><TeachingButton onClick={() => void open().catch(() => {})} disabled={loading || busy}><FileText size={15} />{expanded ? 'Згорнути' : submission ? 'Відкрити роботу' : 'Здати роботу'}<ChevronDown size={14} className={expanded ? 'rotate-180' : ''} /></TeachingButton></div>
    <div hidden={!expanded} className="teaching-submission-content">
      {loading && <p role="status" className="teaching-note">Завантажуємо вашу роботу…</p>}
      {error && <div role="alert" className="teaching-error"><p>{error}</p><TeachingButton onClick={() => void saved().catch(() => {})} disabled={loading || busy}><RefreshCw size={14} />Оновити збережену роботу</TeachingButton></div>}
      {current && <>
        {current.course_archived_at && <p className="teaching-note">Семестр у архіві. Ваші матеріали та результати збережено, нові зміни недоступні.</p>}
        {submission?.status === 'returned' && <div className="teaching-submission-feedback teaching-submission-feedback-returned"><strong>Викладач просить доопрацювати роботу</strong><p>{submission.feedback || 'Уточніть зміни з викладачем.'}</p>{submission.reviewer_name && <small>{submission.reviewer_name} · {teachingDate(submission.reviewed_at, true)}</small>}</div>}
        {(!submission || ['draft', 'returned'].includes(submission.status)) && current.can_submit ? <SubmissionComposer key={submission ? submission.id + ':' + submission.version : currentKey} submission={submission} repository={repository} assignment={current.item} groupId={groupId} userId={userId} onSaved={saved} onBusy={reportBusy} refreshing={loading} /> : submission ? <>
          <div className="teaching-submission-reading"><p className="text-xs text-muted-foreground">{submission.status === 'submitted' ? 'Робота надіслана викладачу. Змінити її можна після відкликання або повернення на доопрацювання.' : submission.status === 'reviewed' ? 'Викладач перевірив роботу. Опублікований коментар і ваш результат — нижче.' : 'Збережена робота доступна для перегляду.'}</p>{submission.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{submission.body}</p>}<TeachingSubmissionResources links={submission.links || []} attachments={submission.attachments || []} repository={repository} />{submission.submitted_at && <small className="text-muted-foreground">Здано {teachingDate(submission.submitted_at, true)} · спроба {submission.attempt}</small>}</div>
          {submission.status === 'reviewed' && <div className="teaching-submission-feedback"><strong><CheckCircle2 size={16} />Результат перевірки</strong><p>{submission.feedback || 'Роботу прийнято.'}</p>{submission.published_score !== null && submission.published_score !== undefined && <p className="font-semibold">Бали в журналі: {submission.published_score}{current.max_points ? ' / ' + current.max_points : ''}</p>}{submission.reviewer_name && <small>{submission.reviewer_name} · {teachingDate(submission.reviewed_at, true)}</small>}</div>}
          {submission.status === 'submitted' && current.can_submit && <TeachingButton onClick={() => setWithdraw(true)} disabled={busy}><RotateCcw size={15} />Відкликати для редагування</TeachingButton>}
        </> : <TeachingEmpty title="Здавання поки недоступне" description="Перевірте доступ до групи та чи відкритий семестр цього предмета." />}
        <TeachingSubmissionHistoryList history={submission ? (current.history || []).filter(item => item.submission_id === submission.id) : []} repository={repository} />
      </>}
    </div>
    {withdraw && <TeachingModal title="Відкликати роботу?" description="Викладач більше не бачитиме поточну чернетку. Після редагування надішліть роботу повторно. Попередні спроби залишаться в історії." onClose={() => setWithdraw(false)} busy={busy}>{error && <p role="alert" className="teaching-error">{error}</p>}{withdrawCommitted && <p role="status" className="teaching-note">Роботу відкликано. Залишилося оновити її відображення.</p>}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setWithdraw(false)}>{withdrawCommitted ? 'Закрити' : 'Скасувати'}</TeachingButton>{withdrawCommitted ? <TeachingButton primary busy={loading} onClick={() => void saved().catch(() => {})}>Оновити роботу</TeachingButton> : <TeachingButton primary busy={busy} onClick={() => void withdrawWork()}>Відкликати</TeachingButton>}</div></TeachingModal>}
  </section>
}

function SubmissionComposer({ submission, repository, assignment, groupId, userId, onSaved, onBusy, refreshing }: { submission: TeachingSubmission | null; repository: TeachingRepository; assignment: TeachingPublication; groupId: string; userId: string; onSaved: () => Promise<void>; onBusy: (busy: boolean) => void; refreshing: boolean }) {
  const [body, setBody] = useState(submission?.body || '')
  const [links, setLinks] = useState(submission?.links.length ? submission.links : [''])
  const [attachments, setAttachments] = useState<TeachingFile[]>(submission?.attachments || [])
  const [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false), [progress, setProgress] = useState('')
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [error, setError] = useState(''), [committed, setCommitted] = useState<'draft' | 'submitted' | null>(null), [needsRefresh, setNeedsRefresh] = useState(false)
  const id = useRef(submission?.id || crypto.randomUUID()), version = useRef(submission?.version || 0)
  const reserved = useRef(Boolean(submission)), actionLock = useRef(false), intent = useRef<'draft' | 'submitted'>('draft')
  const uploadController = useRef<AbortController | null>(null)
  useEffect(() => () => uploadController.current?.abort(), [])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (actionLock.current || committed || needsRefresh || refreshing) return
    actionLock.current = true; setBusy(true); onBusy(true); setError('')
    const nextStatus = intent.current
    intent.current = 'draft'
    const controller = new AbortController()
    uploadController.current = controller
    let phase = 'validation'
    try {
      const normalized = validateTeachingLinks(links)
      if (!body.trim() && !normalized.length && !attachments.length && !files.length) throw new Error('Додайте текст, посилання або файл до своєї роботи.')
      if (!reserved.current) {
        phase = 'reserving'; setProgress('Готуємо вашу роботу…')
        const result = await repository.classroomMutate('reserve_submission', { id: id.current, item_id: assignment.id, group_id: groupId })
        if (!result.id || !Number.isSafeInteger(result.version)) throw new Error('Не вдалося підтвердити створення роботи. Оновіть збережені дані.')
        if (result.id !== id.current) { setNeedsRefresh(true); throw new Error('Знайдено раніше збережену роботу. Спочатку оновіть її, щоб переглянути поточну версію.') }
        id.current = result.id; version.current = result.version!; reserved.current = true
      }
      let uploaded = [...attachments]
      for (let index = 0; index < files.length; index++) {
        phase = 'upload'; setProgress('Завантажуємо файл ' + (index + 1) + ' з ' + files.length); setUploadPercent(0)
        uploaded = [...uploaded, await repository.uploadSubmission(id.current, userId, files[index], setUploadPercent, controller.signal)]
        setUploadPercent(100)
        setAttachments(uploaded); setFiles(current => current.filter(file => file !== files[index]))
      }
      if (controller.signal.aborted) throw new DOMException('Завантаження скасовано.', 'AbortError')
      setUploadPercent(null)
      phase = 'saving'; setProgress('Зберігаємо роботу…')
      const result = await repository.classroomMutate('save_submission', { id: id.current, item_id: assignment.id, group_id: groupId, version: version.current, body: body.trim(), links: normalized, attachments: uploaded })
      if (!Number.isSafeInteger(result.version)) throw new Error('Не вдалося підтвердити версію роботи. Оновіть збережені дані.')
      version.current = result.version!
      if (nextStatus === 'submitted') {
        phase = 'submitting'; setProgress('Надсилаємо викладачу…')
        await repository.classroomMutate('submit_submission', { id: id.current, version: version.current })
      }
      setCommitted(nextStatus); phase = 'refresh'; await onSaved()
    } catch (failure) {
      const uploadError = failure && typeof failure === 'object' ? failure as { message?: unknown; code?: unknown; statusCode?: unknown; status?: unknown } : null
      const uploadDenied = phase === 'upload' && uploadError && (
        String(uploadError.statusCode ?? uploadError.status ?? '') === '403'
        || uploadError.code === '42501'
        || /row[- ]level security|violates.*security policy/i.test(String(uploadError.message || ''))
      )
      setError(uploadDenied
        ? 'Не вдалося завантажити файл через налаштування доступу. Текст і вибрані файли залишаються у цій формі. Спробуйте ще раз або зверніться до підтримки.'
        : teachingSubmissionError(failure))
      if (['saving', 'submitting'].includes(phase)) setNeedsRefresh(true)
    } finally { if (uploadController.current === controller) uploadController.current = null; actionLock.current = false; setBusy(false); onBusy(false); setProgress(''); setUploadPercent(null) }
  }
  return <form className="teaching-form" onSubmit={save}>
    <p className="teaching-note">Чернетку бачите лише ви. Викладач отримає роботу після натискання «Здати роботу». Надіслані спроби зберігаються в історії.</p>
    {error && <div role="alert" className="teaching-error"><p>{error}</p>{needsRefresh && <p className="mt-2 text-xs">Оновлення завантажить збережену версію й замінить незбережені правки.</p>}</div>}
    {committed ? <div role="status" className="teaching-submission-feedback"><strong><CheckCircle2 size={16} />{committed === 'submitted' ? 'Роботу здано' : 'Чернетку збережено'}</strong><p>Якщо список ще не оновився, повторіть тільки оновлення.</p></div> : <>
      <TeachingField label="Текст роботи" hint="Можна залишити порожнім, якщо додаєте посилання або файл."><textarea name="submission-body" className={teachingInput} value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={10000} disabled={busy || needsRefresh || refreshing} placeholder="Напишіть відповідь або коротке пояснення до файлу…" /></TeachingField>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold">Посилання</legend>{links.map((link, index) => <div key={index} className="flex items-end gap-2"><div className="min-w-0 flex-1"><TeachingField label={'Посилання ' + (index + 1)}><input name={'submission-link-' + index} type="url" className={teachingInput} value={link} onChange={event => setLinks(current => current.map((value, position) => position === index ? event.target.value : value))} maxLength={2000} placeholder="https://…" disabled={busy || needsRefresh || refreshing} /></TeachingField></div><button type="button" className="teaching-icon-button" aria-label={'Прибрати посилання ' + (index + 1)} disabled={busy || needsRefresh || refreshing} onClick={() => setLinks(current => current.filter((_, position) => position !== index))}><X size={16} /></button></div>)}<TeachingButton disabled={busy || needsRefresh || refreshing || links.length >= 10} onClick={() => setLinks(current => [...current, ''])}><Paperclip size={15} />Додати посилання</TeachingButton></fieldset>
      <TeachingField label="Файли роботи" hint={`До 10 файлів, до ${TEACHING_MAX_FILE_BYTES / (1024 * 1024)} МБ кожен. PDF, документи, презентації, таблиці або зображення.`}><input name="submission-files" className={teachingInput} type="file" accept={TEACHING_FILE_ACCEPT} multiple disabled={busy || needsRefresh || refreshing} onChange={event => {
        const incoming = [...(event.target.files || [])]; event.target.value = ''
        try { incoming.forEach(validateTeachingFile); if (incoming.length + attachments.length + files.length > 10) throw new Error('До роботи можна додати до 10 файлів.'); setFiles(current => [...current, ...incoming]); setError('') } catch (failure) { setError(teachingSubmissionError(failure)) }
      }} /></TeachingField>
      <p className="text-xs leading-relaxed text-muted-foreground">Більші файли завантажуйте в <a href="https://drive.google.com/" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">Google Drive</a> та додавайте посилання до роботи. Надайте доступ своєму викладачу.</p>
      {(attachments.length > 0 || files.length > 0) && <div className="space-y-2">{attachments.map(file => <div className="teaching-submission-file" key={file.storage_path}><FileText size={14} /><span>{file.name}</span><button type="button" className="teaching-icon-button" disabled={busy || needsRefresh || refreshing} aria-label={'Прибрати ' + file.name} onClick={() => setAttachments(current => current.filter(item => item.storage_path !== file.storage_path))}><X size={15} /></button></div>)}{files.map((file, index) => <div className="teaching-submission-file" key={file.name + ':' + index}><Paperclip size={14} /><span>{file.name}</span><small>Ще не завантажено</small><button type="button" className="teaching-icon-button" disabled={busy || needsRefresh || refreshing} aria-label={'Прибрати ' + file.name} onClick={() => setFiles(current => current.filter((_, position) => position !== index))}><X size={15} /></button></div>)}</div>}
    </>}
    {progress && <div className="space-y-2"><p role="status" className="text-sm text-primary">{progress}{uploadPercent !== null ? ` · ${uploadPercent}%` : ''}</p>{uploadPercent !== null && <progress aria-label={progress} className="h-2 w-full accent-primary" max={100} value={uploadPercent}>{uploadPercent}%</progress>}</div>}
    <div className="teaching-form-actions">{committed || needsRefresh ? <TeachingButton primary busy={busy || refreshing} onClick={() => { setBusy(true); onBusy(true); void onSaved().catch(failure => setError(teachingSubmissionError(failure))).finally(() => { setBusy(false); onBusy(false) }) }}><RefreshCw size={15} />Оновити збережену роботу</TeachingButton> : <><TeachingButton type="submit" disabled={busy || refreshing} onClick={() => { intent.current = 'draft' }}><Save size={15} />Зберегти чернетку</TeachingButton><TeachingButton primary type="submit" busy={busy || refreshing} onClick={() => { intent.current = 'submitted' }}><Send size={15} />{submission?.status === 'returned' ? 'Здати повторно' : 'Здати роботу'}</TeachingButton></>}</div>
  </form>
}
