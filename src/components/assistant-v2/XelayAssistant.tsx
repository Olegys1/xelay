import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronRight, FileText, FolderOpen, GraduationCap, History, Link, LoaderCircle, Maximize2, MessageCircle, Minimize2, Paperclip, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, Square, Users, WifiOff, X } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabase'
import { AssistantCloudError, createAssistantCloudClient, type AssistantCloudStatus, type AssistantActionForm, type AssistantChatChoices, type AssistantChatHistoryItem, type AssistantChatScope, type AssistantQueuedSchedule, type LiveCatalog, type LiveCourse, type LiveDraft, type LiveReadResult, type LiveReadTopic, type LiveReceipt, type LiveRecord } from '../../lib/assistant-v2/cloudClient'
import { ASSISTANT_REMINDER_OPTIONS, assistantGradeSummary, assistantImportBatchReady, assistantKyivInput, assistantKyivInstant, assistantRecurringDraftIssues, assistantRouteContext, assistantSourcePath, clearAssistantOffline, createAssistantOfflineCache, prepareAssistantFiles, prepareAssistantImportChunk, updateAssistantMaterialGrant, updateAssistantRecurringDraft } from '../../lib/assistant-v2/workspaceTools'
import { ASSISTANT_CONTEXT_EVENT, currentAssistantPageContext, validateAssistantPageContext } from '../../lib/assistant-v2/pageContext'
import './xelay-assistant.css'

const topics: Record<string, string> = { study: 'Розклад і ДЗ', materials: 'Матеріали', results: 'Мої бали', teaching: 'Мої заняття', gradebook: 'Журнал', seminars: 'Семінари', organizer: 'Мої справи', community: 'Спільнота', news: 'Новини', opportunities: 'Можливості', help: 'Допомога' }
const topicIcons: Record<string, typeof CalendarDays> = { study: CalendarDays, materials: FolderOpen, results: GraduationCap, teaching: CalendarDays, gradebook: BookOpen, seminars: Users, organizer: Check, community: MessageCircle, news: FileText, opportunities: Sparkles, help: BookOpen }
const actions: Record<string, string> = { 'schedule.create': 'Додати пару', 'schedule.update': 'Змінити пару', 'schedule.move': 'Перенести пару', 'schedule.copy': 'Скопіювати день', 'homework.upsert': 'Додати або оновити ДЗ', 'homework.batch': 'Кілька ДЗ з повідомлення', 'seminar.subject.upsert': 'Предмет семінарів', 'seminar.schedule.upsert': 'Розклад семінарів', 'organizer.task.create': 'Особиста справа', 'seminar.prepare': 'Підготувати семінар', 'seminar.reopen': 'Знову відкрити запис', 'seminar.book': 'Забронювати питання', 'seminar.team.join': 'Приєднатися до команди', 'teaching.assignment.upsert': 'Завдання для груп', 'teaching.publication.schedule': 'Запланувати публікацію', 'teaching.material.upsert': 'Додати або оновити матеріал', 'teaching.material.visibility': 'Групи показу матеріалу', 'teaching.material.ai': 'Дозвіл на пояснення ШІ', 'teaching.material.collaborators': 'Права колег на матеріал', 'teaching.grades.save': 'Внести вказані бали', 'teaching.grading.save': 'Правила й коефіцієнти' }
const statuses: Record<LiveDraft['status'], string> = { pending: 'Очікує підтвердження', committing: 'Зберігається', confirmed: 'Збережено', cancelled: 'Скасовано', stale: 'Потребує оновлення', unknown: 'Перевірте результат' }
const labels: Record<string, string> = { date: 'Дата заняття', subject: 'Назва предмета', startsAt: 'Початок', endsAt: 'Завершення', lessonType: 'Тип заняття', location: 'Аудиторія або місце', teacherName: 'Ім’я викладача', links: 'Посилання, кожне з нового рядка', conferenceId: 'Ідентифікатор конференції', accessCode: 'Код доступу', topic: 'Тема домашнього завдання', body: 'Повний текст завдання', title: 'Назва справи', notes: 'Нотатки' }
const maxLengths: Record<string, number> = { subject: 120, location: 160, teacherName: 180, conferenceId: 120, accessCode: 120, topic: 240, title: 200, body: 10000, notes: 10000, links: 44021 }
const lessonTypes = [['lecture', 'Лекція'], ['seminar', 'Семінар'], ['practical', 'Практичне заняття'], ['lab', 'Лабораторна'], ['other', 'Інше заняття']]
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function dateLabel(value?: string) {
  if (!value) return ''
  try { return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', ...(value.length > 10 ? { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' } : {}) }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)) }
  catch { return 'Дата не вказана' }
}
const isTeaching = (course: LiveCourse) => course.teaching === true && Array.isArray(course.teachingGroupIds) && course.teachingGroupIds.length > 0
const errorLabel = (error: unknown) => error instanceof AssistantCloudError ? error.message : 'Не вдалося виконати запит. Перевірте з’єднання й оновіть дані.'
function meetingHref(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
function platformHref(path?: string) {
  if (!path || !/^\/(?:groups|organizer|teaching)(?:[/?#]|$)/.test(path) || /[\\\u0000-\u0020]/.test(path)) return null
  return path
}
function routeGroup(pathname: string) { return /^\/groups\/([a-f\d-]{36})(?:\/|$)/i.exec(pathname)?.[1] || '' }
type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string; draft?: LiveDraft; drafts?: LiveDraft[]; read?: LiveReadResult; choices?: AssistantChatChoices; sources?: { title: string; path?: string; sourcePath?: string }[] }
const browserStorage = () => { try { return window.localStorage } catch { return undefined } }
const requiresTopicSubject = (value: string) => ['study', 'materials', 'results', 'seminars'].includes(value)
/** Only an authorized regular learning group may be selected automatically. */
export function assistantLearningDefault(catalog: LiveCatalog) {
  const regular = catalog.groups.filter(group => group.learning && !(group as typeof group & { testGroup?: boolean }).testGroup)
  const declared = (catalog as LiveCatalog & { defaultLearningGroupId?: string }).defaultLearningGroupId
  return regular.find(group => group.id === declared) || (regular.length === 1 ? regular[0] : undefined)
}
export function manualTeachingCourse(courses: LiveCourse[], selectedId: string) {
  return courses.find(course => course.id === selectedId) || (!selectedId && courses.length === 1 ? courses[0] : undefined)
}
export function ManualTeachingContext({ courses, selectedId, disabled, onChange }: { courses: LiveCourse[]; selectedId: string; disabled?: boolean; onChange(courseId: string): void }) {
  const selected = manualTeachingCourse(courses, selectedId)
  return <section className="xai-manual-context" aria-label="Предмет для ручних дій"><label>Предмет для змін<select aria-label="Предмет для ручних дій" value={selected?.id || ''} disabled={disabled || !courses.length} onChange={event => onChange(event.target.value)}><option value="">Оберіть свій предмет</option>{courses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label><p className="xai-note">{selected ? !selectedId && courses.length === 1 ? 'Ваш єдиний доступний предмет обрано для цих дій. Загальний календар лишається без змін.' : 'Нижче показані дії, дозволені вам для цього предмета. Групи й права ще раз перевіряє сервер.' : courses.length ? 'Оберіть предмет, щоб додати завдання чи матеріал, запланувати публікацію або відкрити журнал. Особисті справи доступні окремо.' : 'Підключені предмети з’являться після підтвердження викладання. Зараз можна підготувати особисту справу.'}</p></section>
}
export function RecurringScheduleReview({ payload, disabled = false, onChange }: { payload: Record<string, unknown>; disabled?: boolean; onChange(payload: Record<string, unknown>): void }) {
  const recurring = payload.recurring === true, issues = assistantRecurringDraftIssues(payload)
  const pattern = String(payload.weekPattern ?? (payload.week === 'upper' || payload.week === 'lower' ? payload.week : 'every'))
  const firstDate = typeof payload.date === 'string' ? payload.date : '', inferredDay = Number.isFinite(Date.parse(firstDate + 'T12:00:00Z')) ? new Date(firstDate + 'T12:00:00Z').getUTCDay() || 7 : NaN
  const change = (field: Parameters<typeof updateAssistantRecurringDraft>[1], value: string | boolean) => onChange(updateAssistantRecurringDraft(payload, field, value))
  const weekdayNames = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя']
  return <section className="xai-recurrence-review" aria-label="Повторення імпортованої пари">
    <h4>Коли відбувається ця пара</h4>
    <label>{recurring ? 'Дата першої пари' : 'Дата пари'}<input aria-label="Дата першої пари" type="date" disabled={disabled} value={String(payload.date || '')} onChange={event => change('date', event.target.value)} /></label>
    <p className="xai-note">{weekdayNames[Number(payload.weekday ?? inferredDay) - 1] || 'День тижня визначиться за датою'}. Зміна першої дати також оновить день тижня та початок періоду.</p>
    <label className="xai-acknowledgement"><input type="checkbox" aria-label="Повторювати пару" disabled={disabled} checked={recurring} onChange={event => change('recurring', event.target.checked)} /><span>Повторювати пару протягом періоду</span></label>
    {recurring && <>
      <div className="xai-two-fields"><label>Період з<input aria-label="Початок періоду" type="date" disabled={disabled} value={String(payload.validFrom || payload.date || '')} onChange={event => change('validFrom', event.target.value)} /></label><label>Період до<input aria-label="Кінець періоду" type="date" disabled={disabled} min={String(payload.validFrom || payload.date || '')} value={String(payload.validUntil || '')} onChange={event => change('validUntil', event.target.value)} /></label></div>
      <label>Чергування тижнів<select aria-label="Чергування тижнів" disabled={disabled} value={pattern} onChange={event => change('weekPattern', event.target.value)}><option value="every">Щотижня</option><option value="upper">Верхній тиждень</option><option value="lower">Нижній тиждень</option></select></label>
      {pattern !== 'every' && <label>Понеділок верхнього тижня<input aria-label="Понеділок верхнього тижня" type="date" disabled={disabled} value={String(payload.weekAnchorDate || '')} onChange={event => change('weekAnchorDate', event.target.value)} /><span className="xai-note">Це початок верхнього тижня для всього чергування, навіть якщо сама пара відбувається нижнього.</span></label>}
    </>}
    {issues.length > 0 && <div className="xai-error" role="alert">{issues.map(issue => <p key={issue}>{issue}</p>)}</div>}
    <p className="xai-note">Після виправлень оновіть перегляд змін. Сервер ще раз перевірить період, тижні та перетини перед підтвердженням.</p>
  </section>
}

function RecordCard({ record, groupName, canHomework, onHomework, onAction, onExplain, canManageSeminars = false, disabled = false }: { record: LiveRecord; groupName?: string; canHomework: boolean; onHomework(record: LiveRecord): void; onAction?(action: string, payload: Record<string, unknown>, scope?: LiveDraft['scope']): void; onExplain?(record: LiveRecord): void; canManageSeminars?: boolean; disabled?: boolean }) {
  const extra = record as LiveRecord & Record<string, any>, source = assistantSourcePath(extra.sourcePath)
  const recordLabels: Record<string, string> = { lesson: 'Заняття', homework: 'Домашнє завдання', material: 'Матеріал', grade: 'Результат', seminar: 'Семінар', task: 'Особиста справа', question: 'Обговорення', news: 'Новина', opportunity: 'Можливість', help: 'Інструкція' }
  return <article className="xai-record">
    <div className="xai-record-kind"><FileText size={14} /><span>{record.personalElective ? 'Моя вибіркова дисципліна' : recordLabels[record.kind] || 'Запис'}</span>{record.kind === 'material' && !record.allowAi && <ShieldCheck size={14} aria-label="Вміст не передається ШІ" />}</div>
    <h3>{record.title}</h3>
    {groupName && <p className="xai-note">{groupName}</p>}{extra.teacherName && <p className="xai-note">Викладач: {extra.teacherName}</p>}
    {extra.studentName && <p className="xai-note">Студент: <strong>{extra.studentName}</strong></p>}
    {record.date && <p className="xai-meta">{dateLabel(record.date)}{record.startsAt ? ` · ${record.startsAt}${record.endsAt ? ` до ${record.endsAt}` : ''}` : ''}{record.location ? ` · ${record.location}` : ''}</p>}
    {record.body && <p className="xai-body">{record.body}</p>}
    {record.bodyTruncated && <p className="xai-note">Повний текст доступний у групі.</p>}
    {record.kind === 'grade' && <div className="xai-score"><strong>{record.points ?? '—'}</strong><span>із {record.maxPoints ?? '—'} балів</span>{record.coefficient !== undefined && <small>Коефіцієнт {record.coefficient}</small>}</div>}
    {record.dueAt && <p className="xai-note">Термін: {dateLabel(record.dueAt)}</p>}
    {record.kind === 'task' && <p className="xai-note">{record.completed ? 'Виконано' : 'Ще потрібно виконати'}{record.space === 'shared' ? ' · Спільний органайзер' : ''}</p>}
    {record.links?.map((value, index) => { const href = meetingHref(value); return href ? <a className="xai-link" key={index} href={href} target="_blank" rel="noopener noreferrer">Відкрити посилання{record.links!.length > 1 ? ` ${index + 1}` : ''}<ArrowUpRight size={14} /></a> : null })}
    {record.conferenceId && <p className="xai-note">Ідентифікатор: <strong>{record.conferenceId}</strong></p>}
    {record.accessCode && <p className="xai-note">Код доступу: <strong>{record.accessCode}</strong></p>}
    {record.fileName && <p className="xai-meta"><FileText size={14} />{record.fileName}</p>}
    {record.kind === 'material' && <><p className="xai-note">{record.allowDownload ? 'Завантаження дозволене автором.' : 'Перегляд на платформі.'}</p><a className="xai-link" href={`/groups/${encodeURIComponent(record.groupId)}?tab=materials`}>Відкрити матеріали<ChevronRight size={14} /></a></>}
    {record.kind === 'material' && record.allowAi && onExplain && <button className="xai-text-button" disabled={disabled} onClick={() => onExplain(record)}><Sparkles size={15} />Пояснити матеріал</button>}
    {source && <a className="xai-link" href={source}>До джерела<ArrowUpRight size={14} /></a>}
    {extra.kind === 'seminar' && onAction && <div className="xai-seminar-choices">{extra.myReservation && <p className="xai-info">Ви вже обрали участь: {extra.myReservation.role === 'team' ? 'команда' : extra.myReservation.role === 'supplement' ? 'доповнення' : 'доповідь'}. Зміна пройде через перегляд.</p>}{Array.isArray(extra.questions) && extra.questions.map((question: any) => <div className="xai-seminar-question" key={question.id}><strong>{question.position}. {question.body}</strong><div>{question.primaryCapacity > 0 && <button className="xai-button" disabled={disabled} onClick={() => onAction('seminar.book', { id: record.id, questionId: question.id, role: extra.format === 'booking' ? 'booking' : 'primary' }, { groupId: record.groupId })}>Доповідь {question.occupiedPrimary}/{question.primaryCapacity}</button>}{question.supplementCapacity > 0 && <button className="xai-button" disabled={disabled} onClick={() => onAction('seminar.book', { id: record.id, questionId: question.id, role: 'supplement' }, { groupId: record.groupId })}>Доповнення {question.occupiedSupplement}/{question.supplementCapacity}</button>}</div></div>)}{Array.isArray(extra.teams) && extra.teams.map((team: any) => <button className="xai-button" key={team.id} disabled={disabled} onClick={() => onAction('seminar.team.join', { id: record.id, teamId: team.id }, { groupId: record.groupId })}>{team.name} · {team.occupied}/{team.capacity}</button>)}{canManageSeminars && <button className="xai-text-button" disabled={disabled} onClick={() => onAction('seminar.reopen', { id: record.id }, { groupId: record.groupId })}>Знову відкрити запис</button>}</div>}
    {record.kind === 'lesson' && !record.personalElective && record.scheduleId && canHomework && <button className="xai-text-button" type="button" onClick={() => onHomework(record)}><Plus size={15} />Додати або змінити ДЗ</button>}
  </article>
}

/** The account is supplied by Xelay's existing auth provider. A new account gets
 * a new component tree so no previous user's records or confirmations survive. */
export default function XelayAssistant({ pathname = typeof window === 'undefined' ? '/' : window.location.pathname }: { pathname?: string }) {
  const { authUser, isAuthenticated, isLoading, isPasswordRecovery, googleRegistrationStatus } = useAuth()
  useEffect(() => {
    const listener = supabase.auth.onAuthStateChange?.(event => { if (event === 'SIGNED_OUT') clearAssistantOffline(browserStorage()) })
    return () => listener?.data.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (isLoading) return
    const owner = isAuthenticated && authUser ? authUser.id : null
    if (!owner) clearAssistantOffline(browserStorage())
    else clearAssistantOffline(browserStorage(), owner)
  }, [authUser?.id, isAuthenticated, isLoading])
  if (isLoading || !isAuthenticated || !authUser || isPasswordRecovery || googleRegistrationStatus !== 'ready') return null
  return <AssistantDrawer key={authUser.id} ownerId={authUser.id} pathname={pathname} />
}

function AssistantDrawer({ ownerId, pathname }: { ownerId: string; pathname: string }) {
  const titleId = useId(), panelId = useId()
  const ownerRef = useRef<string | null>(ownerId), alive = useRef(true), generation = useRef(0)
  const launcher = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null)
  const readRequest = useRef<AbortController | null>(null), loadRequest = useRef<AbortController | null>(null), chatRequest = useRef<AbortController | null>(null), catalogAttempted = useRef(false)
  const toolRequest = useRef<AbortController | null>(null), catalogLoading = useRef(false), networkOnline = useRef(navigator.onLine !== false)
  const recurringReviewIds = useRef(new Set<string>())
  const chatSelectedGroup = useRef(''), chatSelectedDate = useRef(''), chatSequence = useRef(0), chatEpoch = useRef(0), conversationEnd = useRef<HTMLDivElement>(null)
  const api = useMemo(() => createAssistantCloudClient({
    currentUserId: () => ownerRef.current,
    session: async () => { const { data, error } = await supabase.auth.getSession(); if (error) throw new AssistantCloudError('session_unavailable', 401); return data.session ? { userId: data.session.user.id, accessToken: data.session.access_token } : null },
  }), [])
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<'chat' | 'data' | 'change' | 'drafts'>('chat')
  const [status, setStatus] = useState<AssistantCloudStatus | null>(null), [catalog, setCatalog] = useState<LiveCatalog | null>(null), [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'learning' | 'teaching'>('learning'), [topic, setTopic] = useState<LiveReadTopic>('study')
  const [groupId, setGroupId] = useState(''), [subjectId, setSubjectId] = useState(''), [courseId, setCourseId] = useState('')
  const [date, setDate] = useState(today), [period, setPeriod] = useState<'current' | 'archive' | 'all'>('current')
  const [queryInput, setQueryInput] = useState(''), [query, setQuery] = useState(''), [organizerSpace, setOrganizerSpace] = useState<'personal' | 'shared' | 'all'>('personal')
  const [readResult, setReadResult] = useState<LiveReadResult | null>(null), [reading, setReading] = useState(false), [error, setError] = useState('')
  const [history, setHistory] = useState<{ draft: LiveDraft; receipt?: LiveReceipt }[]>([]), [historyBusy, setHistoryBusy] = useState(false)
  const [action, setAction] = useState('schedule.create'), [formOpen, setFormOpen] = useState(false), [formValues, setFormValues] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<LiveDraft | null>(null), [draftPayload, setDraftPayload] = useState<Record<string, unknown>>({}), [receipt, setReceipt] = useState<LiveReceipt | null>(null)
  const [writing, setWriting] = useState(false), [draftError, setDraftError] = useState(''), [acknowledged, setAcknowledged] = useState(false)
  const [materialRightsAccepted, setMaterialRightsAccepted] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([]), [message, setMessage] = useState(''), [teacherMessage, setTeacherMessage] = useState(''), [showTeacherMessage, setShowTeacherMessage] = useState(false)
  const [chatBusy, setChatBusy] = useState(false), [chatError, setChatError] = useState(''), [continuation, setContinuation] = useState<string | undefined>()
  const offlineCache = useMemo(() => createAssistantOfflineCache(browserStorage(), ownerId), [ownerId])
  const [offline, setOffline] = useState(() => navigator.onLine === false), [cachedAt, setCachedAt] = useState<number | null>(null)
  const [actionForm, setActionForm] = useState<AssistantActionForm | null>(null), [actionValues, setActionValues] = useState<Record<string, unknown>>({}), [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [editingDraft, setEditingDraft] = useState<LiveDraft | null>(null)
  const [importOpen, setImportOpen] = useState(false), [importFiles, setImportFiles] = useState<File[]>([]), [sheetUrl, setSheetUrl] = useState(''), [importHints, setImportHints] = useState({ groupHint: '', courseHint: '', weekHint: '', columnHint: '' }), [toolBusy, setToolBusy] = useState(false), [toolError, setToolError] = useState('')
  const [importPeriod, setImportPeriod] = useState({ validFrom: today(), validUntil: '', weekAnchorDate: '' })
  const [preparedDrafts, setPreparedDrafts] = useState<LiveDraft[]>([]), [explanation, setExplanation] = useState<{ text: string; sources: { title: string; sourcePath?: string; path?: string }[] } | null>(null)
  const [remainingImports, setRemainingImports] = useState<AssistantQueuedSchedule[]>([])
  const [uploadProgress, setUploadProgress] = useState(0)

  useEffect(() => {
    alive.current = true; ownerRef.current = ownerId
    return () => { alive.current = false; ownerRef.current = null; generation.current++; api.clear(); readRequest.current?.abort(); loadRequest.current?.abort(); chatRequest.current?.abort(); toolRequest.current?.abort() }
  }, [api, ownerId])
  useEffect(() => {
    const abort = new AbortController(), started = generation.current
    void api.bootstrap(abort.signal).then(config => { if (alive.current && !abort.signal.aborted && started === generation.current) setStatus(config) }).catch(() => { if (alive.current && !abort.signal.aborted && offlineCache.catalog()) setStatus({ available: true, modelConnected: false, writesAvailable: false }) })
    return () => abort.abort()
  }, [api, offlineCache])
  useEffect(() => {
    const disconnected = () => { networkOnline.current = false; setOffline(true); chatRequest.current?.abort(); setChatBusy(false); setAcknowledged(false) }
    const connected = () => { if (networkOnline.current) return; networkOnline.current = true; catalogAttempted.current = false; setOffline(false); void api.bootstrap().then(config => { if (alive.current) setStatus(config) }).catch(() => {}) }
    window.addEventListener('offline', disconnected); window.addEventListener('online', connected)
    return () => { window.removeEventListener('offline', disconnected); window.removeEventListener('online', connected) }
  }, [api])
  function close() { setOpen(false); setAcknowledged(false); readRequest.current?.abort(); setReading(false); requestAnimationFrame(() => launcher.current?.focus()) }
  useEffect(() => {
    if (!open) return
    closeButton.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); setAcknowledged(false); launcher.current?.focus() }
      if (event.key === 'Tab' && window.matchMedia('(max-width: 640px)').matches && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter(item => item.getClientRects().length)
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const loadCatalog = useCallback(async () => {
    if (catalogLoading.current) return
    catalogLoading.current = true
    loadRequest.current?.abort(); const abort = new AbortController(); loadRequest.current = abort; const started = generation.current
    setLoading(true); setError('')
    try {
      const result = offline ? offlineCache.catalog() : await api.catalog(abort.signal)
      if (!result) throw new AssistantCloudError('cloud_unavailable', 503)
      if (!alive.current || abort.signal.aborted || started !== generation.current) return
      if (!Array.isArray(result.groups) || !Array.isArray(result.courses) || !Array.isArray(result.subjects)) throw new AssistantCloudError('repository_invalid_response')
      setCatalog(result); if (!offline) offlineCache.saveCatalog(result)
      const context = validateAssistantPageContext(currentAssistantPageContext(ownerId), ownerId, result) || assistantRouteContext(pathname, window.location.search, result)
      const routed = result.groups.find(group => group.id === routeGroup(pathname))
      const teachingAvailable = result.courses.some(isTeaching), routedTeaching = !!routed && result.courses.some(course => isTeaching(course) && course.teachingGroupIds.includes(routed.id))
      const learning = routed ? routed.learning || !routedTeaching : !pathname.startsWith('/teaching') && result.groups.some(group => group.learning) || !teachingAvailable
      const target = routed && (learning ? routed.learning : result.courses.some(course => isTeaching(course) && course.teachingGroupIds.includes(routed.id))) ? routed : learning ? assistantLearningDefault(result) : result.groups.find(group => result.courses.some(course => isTeaching(course) && course.teachingGroupIds.includes(group.id)))
      chatSelectedGroup.current = context.groupId || routed?.id || (learning ? target?.id : '') || ''; chatSelectedDate.current = context.date || ''
      const nextMode = context.mode === 'teaching' || context.courseId || pathname.startsWith('/teaching') ? 'teaching' : learning ? 'learning' : 'teaching'
      setMode(nextMode); setTopic('topic' in context && typeof context.topic === 'string' ? context.topic as LiveReadTopic : nextMode === 'learning' ? 'study' : 'teaching'); setGroupId(context.groupId || target?.id || ''); setSubjectId(context.subjectId || ''); setCourseId(context.courseId || ''); if (context.date) setDate(context.date); setReadResult(null); setAcknowledged(false)
    } catch (failure) { if (alive.current && !abort.signal.aborted && started === generation.current) { const saved = offlineCache.catalog(); if (saved) { setCatalog(saved); setGroupId(assistantLearningDefault(saved)?.id || ''); chatSelectedGroup.current = assistantLearningDefault(saved)?.id || ''; setMode(saved.groups.some(group => group.learning) ? 'learning' : 'teaching'); setTopic(saved.groups.some(group => group.learning) ? 'study' : 'teaching'); } else setError(errorLabel(failure)) } }
    finally { catalogLoading.current = false; if (alive.current && !abort.signal.aborted && started === generation.current) setLoading(false) }
  }, [api, pathname, offline, offlineCache, ownerId])
  useEffect(() => {
    if (!catalog) return
    const changed = (event: Event) => {
      const context = validateAssistantPageContext((event as CustomEvent).detail, ownerId, catalog)
      if (!context) return
      resetChatScope(); readRequest.current?.abort(); setReadResult(null); setAcknowledged(false)
      setMode(context.mode); setGroupId(context.groupId || ''); setCourseId(context.courseId || ''); setSubjectId(context.subjectId || ''); setTopic(context.topic || (context.mode === 'teaching' ? 'teaching' : 'study'))
      chatSelectedGroup.current = context.groupId || ''; chatSelectedDate.current = context.date || ''; if (context.date) setDate(context.date)
    }
    window.addEventListener(ASSISTANT_CONTEXT_EVENT, changed)
    return () => window.removeEventListener(ASSISTANT_CONTEXT_EVENT, changed)
  }, [catalog, ownerId])

  useEffect(() => { if (open && status?.available && !catalogAttempted.current) { catalogAttempted.current = true; void loadCatalog() } }, [open, status?.available, loadCatalog])
  // Route changes may select only a group already authorized by the catalog.
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname; readRequest.current?.abort(); setReadResult(null); setFormOpen(false); setFormValues({}); setAcknowledged(false); setError(''); resetChatScope(); chatSelectedGroup.current = ''; chatSelectedDate.current = ''
    const candidate = catalog?.groups.find(group => group.id === routeGroup(pathname))
    if (candidate && (mode === 'learning' ? candidate.learning : catalog?.courses.some(course => isTeaching(course) && course.teachingGroupIds.includes(candidate.id)))) { setGroupId(candidate.id); setSubjectId(''); setCourseId(''); chatSelectedGroup.current = candidate.id }
  }, [pathname, catalog, mode])

  const groups = catalog?.groups.filter(group => mode === 'learning' ? group.learning : catalog.courses.some(course => isTeaching(course) && course.teachingGroupIds.includes(group.id))) || []
  const courses = catalog?.courses.filter(course => isTeaching(course) && (!groupId || course.teachingGroupIds.includes(groupId))) || []
  const selectedGroup = groups.find(group => group.id === groupId), selectedCourse = courses.find(course => course.id === courseId)
  const subjects = catalog?.subjects.filter(subject => subject.groupId === groupId && subject.kind === (topic === 'materials' ? 'materials' : 'study')) || []
  const canHomework = mode === 'learning' && !!selectedGroup?.permissions.includes('homework')
  const teacherPermissions = selectedCourse?.permissions || []
  const manualCourse = manualTeachingCourse(courses, courseId), manualTeacherPermissions = manualCourse?.permissions || []
  const availableActions = [...(mode === 'learning' && selectedGroup?.permissions.includes('schedule') ? ['schedule.create', 'schedule.update', 'schedule.move', 'schedule.copy'] : []), ...(canHomework ? ['homework.upsert', 'homework.batch'] : []), ...(mode === 'learning' && selectedGroup?.permissions.includes('seminars') ? ['seminar.subject.upsert', 'seminar.schedule.upsert', 'seminar.prepare', 'seminar.reopen'] : []), ...(mode === 'teaching' && manualTeacherPermissions.includes('assignments') ? ['teaching.assignment.upsert', 'teaching.publication.schedule'] : []), ...(mode === 'teaching' && manualTeacherPermissions.includes('materials') ? ['teaching.material.upsert', 'teaching.material.visibility', 'teaching.material.ai', 'teaching.material.collaborators'] : []), ...(mode === 'teaching' && manualTeacherPermissions.includes('grades') ? ['teaching.grades.save'] : []), ...(mode === 'teaching' && manualTeacherPermissions.includes('manage') ? ['teaching.grading.save'] : []), 'organizer.task.create']
  const allowedTopics = (mode === 'learning' ? ['study', 'materials', 'results', 'seminars', 'organizer', 'community', 'news', 'opportunities', 'help'] : ['teaching', 'materials', 'gradebook', 'organizer', 'community', 'news', 'opportunities', 'help']) as LiveReadTopic[]
  const hasLearning = !!catalog?.groups.some(group => group.learning), hasTeaching = !!catalog?.courses.some(isTeaching)
  const teacherSubjectId = selectedCourse?.subjects.find(subject => subject.groupId === groupId)?.subjectId

  function resetChatScope() { chatEpoch.current++; chatRequest.current?.abort(); chatRequest.current = null; setChatBusy(false); setContinuation(undefined); setMessages([]); setChatError('') }
  function resetContext() { readRequest.current?.abort(); toolRequest.current?.abort(); setToolBusy(false); setReadResult(null); setError(''); setReading(false); setFormOpen(false); setFormValues({}); setAcknowledged(false); resetChatScope() }
  function changeMode(next: 'learning' | 'teaching') {
    resetContext(); setMode(next); setTopic(next === 'learning' ? 'study' : 'teaching'); setSubjectId(''); setCourseId(''); setContinuation(undefined); chatSelectedGroup.current = ''; chatSelectedDate.current = ''
    const nextGroup = catalog ? next === 'learning' ? assistantLearningDefault(catalog)?.id || '' : catalog.groups.find(group => catalog.courses.some(course => isTeaching(course) && course.teachingGroupIds.includes(group.id)))?.id || '' : ''
    setGroupId(nextGroup); if (next === 'learning') chatSelectedGroup.current = nextGroup
  }
  const readData = useCallback(async () => {
    if (!open || view !== 'data' || !catalog || !status?.available || !groupId && ['study', 'materials', 'results', 'seminars', 'gradebook'].includes(topic) || mode === 'teaching' && ['materials', 'gradebook'].includes(topic) && !courseId) return
    readRequest.current?.abort(); const abort = new AbortController(); readRequest.current = abort; const started = generation.current
    setReading(true); setError('')
    try {
      const scoped = { ...(!['organizer', 'community', 'news', 'opportunities', 'help'].includes(topic) && groupId ? { groupId } : {}), ...(mode === 'teaching' && courseId && ['teaching', 'materials', 'gradebook'].includes(topic) ? { courseId } : {}), ...(mode === 'learning' && subjectId && requiresTopicSubject(topic) ? { subjectId } : mode === 'teaching' && teacherSubjectId && ['teaching', 'materials', 'gradebook'].includes(topic) ? { subjectId: teacherSubjectId } : {}), ...(['study', 'teaching', 'seminars'].includes(topic) ? { from: date, to: date } : {}), ...(query ? { query } : {}), ...(topic === 'organizer' ? { space: organizerSpace } : {}), period }
      const saved = offlineCache.read(topic, scoped)
      if (offline && !saved) { setReadResult(null); setCachedAt(null); setError('Цей розділ ще не збережено. Без інтернету можна відкрити розклад і ДЗ, які ви вже переглядали протягом 14 днів.'); return }
      let result: LiveReadResult, restored = offline
      try { result = offline ? saved!.result : await api.read(topic, scoped, abort.signal); setCachedAt(offline ? saved!.capturedAt : null) }
      catch (failure) { if (!saved || abort.signal.aborted) throw failure; result = saved.result; restored = true; setCachedAt(saved.capturedAt) }
      if (!alive.current || abort.signal.aborted || started !== generation.current) return
      if (!Array.isArray(result.records)) throw new AssistantCloudError('repository_invalid_response')
      setReadResult(result); if (!restored) offlineCache.saveRead(topic, scoped, result)
    } catch (failure) { if (alive.current && !abort.signal.aborted && started === generation.current) { setError(errorLabel(failure)); setReadResult(null) } }
    finally { if (alive.current && !abort.signal.aborted && started === generation.current) setReading(false) }
  }, [api, open, view, catalog, status?.available, groupId, topic, mode, courseId, subjectId, teacherSubjectId, date, period, offline, offlineCache, query, organizerSpace])
  useEffect(() => { void readData(); return () => readRequest.current?.abort() }, [readData])

  useEffect(() => { if (open) conversationEnd.current?.scrollIntoView({ block: 'nearest' }) }, [messages.length, chatBusy, view, draft?.id, actionForm, importOpen, explanation, open])
  async function sendChat(suggested?: string) {
    const content = (suggested ?? message).trim()
    if (!content || !status?.modelConnected || chatBusy || writing || loading || offline) return
    const started = generation.current, requestScope = chatEpoch.current, abort = new AbortController(); chatRequest.current = abort
    const copied = suggested === undefined && showTeacherMessage ? teacherMessage : ''
    const history: AssistantChatHistoryItem[] = []
    let characters = 0
    for (const previous of messages.filter(entry => entry.role === 'user').slice(-6).reverse()) { if (previous.content.length > 6000) continue; if (characters + previous.content.length > 18000) break; history.unshift({ role: previous.role, content: previous.content }); characters += previous.content.length }
    const scope: AssistantChatScope = { period, mode, ...(chatSelectedGroup.current ? { groupId: chatSelectedGroup.current } : {}), ...(chatSelectedDate.current ? { date: chatSelectedDate.current } : {}), ...(mode === 'teaching' && courseId ? { courseId } : {}), ...(mode === 'learning' && subjectId ? topic === 'materials' ? { materialSubjectId: subjectId } : { subjectId } : {}) }
    const id = ++chatSequence.current
    setMessages(current => [...current.slice(-19), { id, role: 'user', content: copied ? `${content}\n\nПовідомлення викладача:\n${copied}` : content }]); setMessage(''); setTeacherMessage(''); setShowTeacherMessage(false); setChatBusy(true); setChatError('')
    try {
      const result = await api.chat({ message: content, history, scope, ...(copied ? { teacherMessage: copied } : {}), ...(continuation ? { continuation } : {}) }, abort.signal)
      if (!alive.current || abort.signal.aborted || started !== generation.current || requestScope !== chatEpoch.current) return
      setContinuation(result.continuation)
      if (result.read) { const source = result.read as LiveReadResult & { topic?: LiveReadTopic; scope?: Parameters<typeof offlineCache.saveRead>[1] }; if (source.topic && source.scope) offlineCache.saveRead(source.topic, source.scope, source) }
      setMessages(current => [...current.slice(-19).map(({ choices: _previousChoices, ...entry }) => entry), { id: ++chatSequence.current, role: 'assistant', content: result.text, ...(result.draft ? { draft: result.draft } : {}), ...(result.drafts ? { drafts: result.drafts } : {}), ...(result.read ? { read: result.read } : {}), ...(result.choices ? { choices: result.choices } : {}), ...(result.sources ? { sources: result.sources } : {}) }])
      if (result.drafts?.length) { setPreparedDrafts(result.drafts); selectDraft(result.drafts[0]) }
      else if (result.draft) selectDraft(result.draft)
      if (result.form) openActionForm(result.form)
      if (result.tool?.type === 'schedule-import' && applyReturnedToolScope(result.tool.scope)) { setActionForm(null); setEditingDraft(null); setFormOpen(false); setImportOpen(true); setView('change') }
      if (result.tool?.type === 'material-explain' && applyReturnedToolScope(result.tool.scope)) { setTopic('materials'); setView('data') }
    } catch (failure) {
      if (alive.current && !abort.signal.aborted && started === generation.current && requestScope === chatEpoch.current) {
        if (failure instanceof AssistantCloudError && ['chat_context_expired', 'chat_continuation_invalid'].includes(failure.code)) {
          resetChatScope(); setMessage(content); setTeacherMessage(copied); setShowTeacherMessage(Boolean(copied))
          setChatError('Час уточнення минув. Текст залишився у полі: напишіть повний запит і надішліть його знову. Автоматичного повтору немає. Перед повторенням зміни перевірте «Історія змін».')
        } else setChatError(errorLabel(failure))
      }
    } finally { if (alive.current && started === generation.current && chatRequest.current === abort) { setChatBusy(false); chatRequest.current = null } }
  }
  function applyReturnedToolScope(scope?: LiveDraft['scope']) {
    if (!scope) return true
    if (!catalog) return false
    const context = validateAssistantPageContext({ source: 'assistant-tool', ownerId, mode: scope.courseId ? 'teaching' : mode, ...scope }, ownerId, catalog)
    if (!context) { setChatError('Доступ до вибраної групи або предмета змінився. Оновіть дані.'); return false }
    if (scope.groupId !== undefined) { setGroupId(context.groupId || ''); chatSelectedGroup.current = context.groupId || '' }
    if (scope.courseId !== undefined) setCourseId(context.courseId || '')
    if (context.date) { setDate(context.date); chatSelectedDate.current = context.date }
    setMode(context.mode); setReadResult(null); setAcknowledged(false)
    return true
  }

  const loadHistory = useCallback(async () => {
    const started = generation.current; setHistoryBusy(true); setDraftError('')
    try {
      const result = await api.drafts()
      if (!alive.current || started !== generation.current) return
      if (!Array.isArray(result.drafts)) throw new AssistantCloudError('repository_invalid_response')
      setHistory(result.drafts)
      setPreparedDrafts(current => current.map(draft => result.drafts.find(entry => entry.draft.id === draft.id)?.draft || draft))
      setDraft(current => current ? result.drafts.find(entry => entry.draft.id === current.id)?.draft || current : current)
    } catch (failure) { if (alive.current && started === generation.current) setDraftError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setHistoryBusy(false) }
  }, [api])
  useEffect(() => { if (open && view === 'drafts' && status?.available && !offline) void loadHistory() }, [open, view, status?.available, loadHistory, offline])

  function selectDraft(next: LiveDraft, saved?: LiveReceipt) {
    const recent = (draft?.id === next.id ? draft : undefined) || preparedDrafts.find(item => item.id === next.id) || history.find(entry => entry.draft.id === next.id)?.draft
    if (next.status === 'pending' && recent && (recent.status !== 'pending' || recent.revision > next.revision)) next = recent
    if (next.action === 'schedule.create' && next.payload.recurring === true) recurringReviewIds.current.add(next.id)
    setDraft(next); setDraftPayload(structuredClone(next.payload)); setReceipt(saved || history.find(entry => entry.draft.id === next.id)?.receipt || null); setFormOpen(false); setActionForm(null); setImportOpen(false); setEditingDraft(null); setAcknowledged(false); setMaterialRightsAccepted(false); setDraftError(''); setView('change')
  }
  function openActionForm(next: AssistantActionForm) { setImportOpen(false); setActionForm(next); setActionValues(structuredClone(next.payload)); setFieldErrors({}); setFormOpen(false); setDraft(null); setDraftPayload({}); setAcknowledged(false); setEditingDraft(null); setView('change') }
  async function requestActionForm(nextAction: string, payload: Record<string, unknown> = {}, scope: LiveDraft['scope'] = { ...(groupId ? { groupId } : {}), ...(mode === 'teaching' && nextAction.startsWith('teaching.') && manualCourse ? { courseId: manualCourse.id } : {}), date }) {
    if (writing || offline) return
    setWriting(true); setDraftError(''); const started = generation.current
    try { const result = await api.form(nextAction, scope, payload); if (alive.current && started === generation.current) openActionForm(result.form) }
    catch (failure) { if (alive.current && started === generation.current) setDraftError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setWriting(false) }
  }
  async function prepareActionForm(event: FormEvent) {
    event.preventDefault(); if (!actionForm || writing || offline || Object.values(fieldErrors).some(Boolean)) return
    setWriting(true); setDraftError(''); const started = generation.current
    try {
      if (actionForm.action === 'homework.batch') {
        if (!status?.modelConnected) throw new AssistantCloudError('model_not_connected', 409)
        const result = await api.batchHomework(actionForm.scope, String(actionValues.source || actionValues.body || ''))
        if (alive.current && started === generation.current) { setActionForm(result.form || null); if (result.form) setActionValues(structuredClone(result.form.payload)); if (result.drafts.length) { setPreparedDrafts(result.drafts); selectDraft(result.drafts[0]) } }
        return
      }
      const result = editingDraft ? await api.edit(editingDraft, actionValues) : await api.prepare(actionForm.action, actionForm.scope, actionValues); if (alive.current && started === generation.current) { setActionForm(null); setEditingDraft(null); selectDraft(result.draft, result.receipt) }
    }
    catch (failure) { if (alive.current && started === generation.current) setDraftError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setWriting(false) }
  }
  async function editStructuredDraft() {
    if (!draft || offline || writing) return
    const target = draft, started = generation.current; setWriting(true); setDraftError('')
    try { const result = await api.form(target.action, target.scope, target.payload); if (alive.current && started === generation.current) { openActionForm(result.form); setEditingDraft(target) } }
    catch (failure) { if (alive.current && started === generation.current) setDraftError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setWriting(false) }
  }
  async function refreshActionForm() {
    if (!actionForm || offline || writing || toolBusy) return
    const original = editingDraft, started = generation.current; setWriting(true); setDraftError('')
    try { const result = await api.form(actionForm.action, actionForm.scope, actionValues); if (alive.current && started === generation.current) { openActionForm(result.form); setEditingDraft(original) } }
    catch (failure) { if (alive.current && started === generation.current) setDraftError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setWriting(false) }
  }
  async function importSchedule(event: FormEvent) {
    event.preventDefault(); if (toolBusy || offline || !status?.modelConnected || !groupId || !importFiles.length && !sheetUrl.trim()) return
    if (remainingImports.length) { setToolError('Спочатку завершіть поточний імпорт або відкиньте його непідготовлену чергу.'); return }
    setToolBusy(true); setToolError(''); const started = generation.current, abort = new AbortController(); toolRequest.current = abort
    try {
      const files = importFiles.length ? await prepareAssistantFiles(importFiles) : []
      if (!alive.current || started !== generation.current || abort.signal.aborted) return
      const result = await api.importSchedule({ scope: { groupId, date }, files, ...(sheetUrl.trim() ? { googleSheetUrl: sheetUrl.trim() } : {}), ...importHints, validFrom: importPeriod.validFrom, validUntil: importPeriod.validUntil, ...(importPeriod.weekAnchorDate ? { weekAnchorDate: importPeriod.weekAnchorDate } : {}) }, abort.signal)
      if (!alive.current || started !== generation.current) return
      if (result.form) openActionForm(result.form)
      setRemainingImports(result.remaining || [])
      if (result.clarifications?.length) setToolError(result.clarifications.join('\n'))
      if (result.drafts?.length) { setPreparedDrafts(result.drafts); selectDraft(result.drafts[0]); setImportOpen(false); setImportFiles([]); setSheetUrl('') }
      setMessages(current => [...current.slice(-19), { id: ++chatSequence.current, role: 'assistant', content: result.text, ...(result.drafts ? { drafts: result.drafts } : {}) }])
    } catch (failure) { if (alive.current && started === generation.current) setToolError(failure instanceof AssistantCloudError ? failure.message : failure instanceof Error ? failure.message : 'Не вдалося підготувати розклад.') }
    finally { if (alive.current && started === generation.current) setToolBusy(false) }
  }
  async function prepareNextImportChunk() {
    if (writing || offline || !status?.writesAvailable || !remainingImports.length || !assistantImportBatchReady(preparedDrafts) || draft && !assistantImportBatchReady([draft])) return
    const started = generation.current, expectedOwner = ownerId
    setWriting(true); setDraftError(''); setToolError('')
    const result = await prepareAssistantImportChunk(remainingImports, { current: () => alive.current && generation.current === started && ownerRef.current === expectedOwner,
      prepare: row => api.prepare(row.action, row.scope, row.payload) })
    if (!alive.current || generation.current !== started || ownerRef.current !== expectedOwner) return
    setRemainingImports(result.remaining)
    if (result.drafts.length) { setPreparedDrafts(result.drafts); selectDraft(result.drafts[0]) }
    if (result.error) setDraftError(`${errorLabel(result.error)} Уже підготовлені чернетки збережено в історії змін. Перевірте їх перед повторною спробою; автоматичного повтору не було.`)
    setWriting(false)
  }
  async function renewExpiredImportDraft() {
    if (!draft || draft.status !== 'stale' || draft.action !== 'schedule.create' || writing || offline || !status?.writesAvailable) return
    const target = draft, started = generation.current; setWriting(true); setDraftError('')
    try { const result = await api.prepare('schedule.create', target.scope, target.payload); if (alive.current && generation.current === started) { setPreparedDrafts(current => current.map(item => item.id === target.id ? result.draft : item)); selectDraft(result.draft, result.receipt) } }
    catch (error) { if (alive.current && generation.current === started) setDraftError(errorLabel(error)) }
    finally { if (alive.current && generation.current === started) setWriting(false) }
  }
  async function explainMaterial(record: LiveRecord) {
    if (toolBusy || offline || !status?.modelConnected || !record.allowAi) return
    setToolBusy(true); setToolError(''); setExplanation(null); setUploadProgress(0); const started = generation.current, abort = new AbortController(); toolRequest.current = abort
    try { const result = await api.explainMaterial({ groupId: record.groupId, ...((record as any).courseId ? { courseId: (record as any).courseId } : {}) }, (record as any).materialId || record.id, undefined, abort.signal); if (alive.current && started === generation.current && !abort.signal.aborted) setExplanation(result) }
    catch (failure) { if (alive.current && started === generation.current) setToolError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setToolBusy(false) }
  }
  async function uploadMaterialFiles(files: File[]) {
    if (!actionForm || !files.length || offline || toolBusy) return
    if (files.length + (Array.isArray(actionValues.attachments) ? actionValues.attachments.length : 0) > 20) { setToolError('До матеріалу можна прикріпити до 20 файлів.'); return }
    const targetCourse = actionForm.scope.courseId || courseId
    if (!targetCourse) { setToolError('Спочатку оберіть предмет викладання.'); return }
    const started = generation.current, abort = new AbortController(); toolRequest.current = abort; setToolBusy(true); setToolError(''); setUploadProgress(0)
    try {
      const { supabaseTeachingRepository, validateTeachingFile } = await import('../../lib/teaching')
      for (const file of files) validateTeachingFile(file)
      const uploaded: Awaited<ReturnType<typeof supabaseTeachingRepository.upload>>[] = []
      for (let index = 0; index < files.length; index++) { if (!alive.current || started !== generation.current || abort.signal.aborted) return; uploaded.push(await supabaseTeachingRepository.upload(targetCourse, ownerId, files[index], percent => { if (alive.current && started === generation.current && !abort.signal.aborted) setUploadProgress(Math.round((index * 100 + percent) / files.length)) }, abort.signal)) }
      if (alive.current && started === generation.current && !abort.signal.aborted) setActionValues(current => ({ ...current, attachments: [...(Array.isArray(current.attachments) ? current.attachments : []), ...uploaded] }))
    } catch (failure) { if (alive.current && started === generation.current && !abort.signal.aborted) setToolError(failure instanceof Error ? failure.message : 'Не вдалося перевірити й завантажити файл.') }
    finally { if (alive.current && started === generation.current) setToolBusy(false) }
  }
  function startForm(nextAction = availableActions[0], record?: LiveRecord) {
    if(record?.personalElective&&(nextAction.startsWith('schedule.')||nextAction.startsWith('homework.')))return
    if (offline || writing || draft?.status === 'pending' || draft?.status === 'committing' || draft?.status === 'unknown') { setView('change'); return }
    setActionForm(null)
    if (nextAction === 'homework.batch') { openActionForm({ action: 'homework.batch', title: 'Кілька ДЗ з одного повідомлення', scope: { groupId, date }, payload: { source: '' }, fields: [{ key: 'source', label: 'Повне повідомлення викладача', type: 'textarea', required: true }] }); return }
    void requestActionForm(nextAction, record ? nextAction === 'homework.upsert' ? { lessonId: record.scheduleId, date: record.date } : nextAction.startsWith('schedule.') ? { id: record.scheduleId, sourceDate: record.date, date: record.date } : { id: record.id } : {}, record ? { groupId: record.groupId, date: record.date } : undefined); return
    setAction(nextAction); setFormOpen(true); setView('change'); setDraft(null); setDraftPayload({}); setReceipt(null); setDraftError(''); setAcknowledged(false)
    setFormValues({ date: record?.date || date, subject: record?.title || '', startsAt: '08:30', endsAt: '09:50', lessonType: 'lecture', lessonId: record?.scheduleId || '', topic: '', body: '', title: '', notes: '', location: '', teacherName: '', links: '', conferenceId: '', accessCode: '' })
  }
  async function prepare(event: FormEvent) {
    event.preventDefault(); if (writing || !status?.writesAvailable || !availableActions.includes(action)) return
    setWriting(true); setDraftError(''); const started = generation.current
    try {
      let payload: Record<string, unknown>, scope: LiveDraft['scope']
      if (action === 'schedule.create') {
        payload = { date: formValues.date, subject: formValues.subject, startsAt: formValues.startsAt, endsAt: formValues.endsAt, lessonType: formValues.lessonType, location: formValues.location || '', teacherName: formValues.teacherName || '', links: (formValues.links || '').split('\n').map(value => value.trim()).filter(Boolean), conferenceId: formValues.conferenceId || '', accessCode: formValues.accessCode || '', recurring: false, week: 'both' }; scope = { groupId, date: formValues.date }
      } else if (action === 'homework.upsert') {
        payload = { lessonId: formValues.lessonId, date: formValues.date, topic: formValues.topic, body: formValues.body, dueAt: null }; scope = { groupId, date: formValues.date }
      } else { payload = { title: formValues.title, notes: formValues.notes || '', space: 'personal', dueAt: null }; scope = {} }
      const result = await api.prepare(action, scope, payload)
      if (alive.current && started === generation.current) selectDraft(result.draft, result.receipt)
    } catch (failure) { if (alive.current && started === generation.current) setDraftError(errorLabel(failure)) }
    finally { if (alive.current && started === generation.current) setWriting(false) }
  }
  const dirty = !!draft && JSON.stringify(draftPayload) !== JSON.stringify(draft.payload)
  async function draftOperation(operation: 'edit' | 'confirm' | 'cancel') {
    if (!draft || writing || offline || draft.status !== 'pending' || !status?.writesAvailable || operation === 'confirm' && (!acknowledged || dirty || (draft as any).requiresMaterialRights && !materialRightsAccepted)) return
    if (operation !== 'cancel' && draft.action === 'schedule.create' && recurringReviewIds.current.has(draft.id) && assistantRecurringDraftIssues(draftPayload).length) return
    setWriting(true); setDraftError(''); setAcknowledged(false); const started = generation.current; const target = draft
    try {
      const result = operation === 'edit' ? await api.edit(target, draftPayload) : operation === 'cancel' ? await api.cancel(target) : await api.confirm(target, undefined, materialRightsAccepted)
      if (!alive.current || started !== generation.current) return
      selectDraft(result.draft, result.receipt)
      setPreparedDrafts(current => current.map(item => item.id === result.draft.id ? result.draft : item))
      if (result.receipt) void readData()
    } catch (failure) {
      if (alive.current && started === generation.current) {
        setDraftError(errorLabel(failure))
        // A lost confirmation response is never an invitation to submit again.
        // The durable journal can be checked from the secondary history.
        if (operation === 'confirm') setDraft({ ...target, status: 'unknown' })
      }
    } finally { if (alive.current && started === generation.current) setWriting(false) }
  }
  function formInput(key: string, label = labels[key], type = 'text', required = false) {
    return <label key={key}>{label}<input value={formValues[key] || ''} type={type} required={required} maxLength={maxLengths[key]} onChange={event => setFormValues(current => ({ ...current, [key]: event.target.value }))} /></label>
  }
  function boundedPaste(event: { clipboardData: DataTransfer; currentTarget: HTMLTextAreaElement; preventDefault(): void }, maximum: number) {
    const target = event.currentTarget, retained = target.value.length - Math.max(0, (target.selectionEnd || 0) - (target.selectionStart || 0))
    if (retained + event.clipboardData.getData('text/plain').length > maximum) { event.preventDefault(); setToolError(`Повідомлення перевищує ${maximum} символів. Розділіть його на частини: текст не обрізано й не надіслано.`) }
  }
  function draftField(key: string, value: unknown) {
    if (!(key in labels) || key === 'date' && draft?.action === 'homework.upsert') return null
    if (key === 'date' && draft?.action === 'schedule.create' && recurringReviewIds.current.has(draft.id)) return null
    const text = Array.isArray(value) ? value.join('\n') : value === null || value === undefined ? '' : String(value)
    const update = (input: string) => { setAcknowledged(false); setMaterialRightsAccepted(false); setDraftPayload(current => ({ ...current, [key]: Array.isArray(value) ? input.split('\n').map(line => line.trim()).filter(Boolean) : input })) }
    return <label key={key}>{labels[key]}{['body', 'notes', 'links'].includes(key) ? <textarea rows={key === 'links' ? 2 : 4} maxLength={maxLengths[key]} value={text} onChange={event => update(event.target.value)} /> : key === 'lessonType' ? <select value={text} onChange={event => update(event.target.value)}>{lessonTypes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select> : <input type={key === 'date' ? 'date' : ['startsAt', 'endsAt'].includes(key) ? 'time' : 'text'} maxLength={maxLengths[key]} value={text} onChange={event => update(event.target.value)} />}</label>
  }
  function structuredField(field: AssistantActionForm['fields'][number]) {
    const value = actionValues[field.key] ?? (['questions', 'teams', 'rows', 'targets', 'slotAssignments', 'links', 'attachments'].includes(field.key) ? [] : undefined), options = Array.isArray(field.options) ? field.options : []
    const update = (next: unknown) => { try { const normalized = field.type === 'datetime-local' && typeof next === 'string' ? assistantKyivInstant(next) : next; setAcknowledged(false); setActionValues(current => { const values = { ...current, [field.key]: normalized }; if (field.key === 'timeMode' && normalized === 'original') { delete values.firstShiftStart; delete values.rememberFirstShiftStart; delete values.slotAssignments } if (field.key === 'sourceDate') { delete values.slotAssignments; if (actionForm?.action === 'schedule.move') delete values.id } return values }); setFieldErrors(current => ({ ...current, [field.key]: '' })) } catch { setFieldErrors(current => ({ ...current, [field.key]: 'Перевірте дату й час за Києвом.' })) } }
    if (actionForm?.action === 'schedule.copy' && actionValues.timeMode !== 'first_shift' && ['firstShiftStart', 'rememberFirstShiftStart', 'slotAssignments'].includes(field.key)) return null
    if (field.type === 'material-grants') return <fieldset className="xai-material-grants" key={field.key}><legend>{field.label}</legend><p className="xai-note">Автор зберігає повний контроль. Оберіть окремі дозволи колег; якщо зняти всі, доступ буде відкликано після підтвердження.</p>{options.map(option => { const grants = Array.isArray(value) ? value : [], granted = grants.find((grant: any) => grant.userId === option.value); return <div className="xai-edit-row" key={option.value}><strong>{option.label}</strong>{([['canEdit', 'Редагувати й оновлювати файли'], ['canDelete', 'Видаляти матеріал'], ['canManageGroups', 'Обирати групи показу']] as const).map(([permission, label]) => <label className="xai-acknowledgement" key={permission}><input type="checkbox" checked={granted?.[permission] === true} onChange={event => update(updateAssistantMaterialGrant(grants, option.value, permission, event.target.checked))} /><span>{label}</span></label>)}</div> })}{!options.length && <p className="xai-note">Немає доступних колег для делегування.</p>}</fieldset>
    if (field.key === 'reminderOffsetsMinutes' || field.type === 'reminder-offsets') return <fieldset className="xai-multiselect" key={field.key}><legend>{field.label}</legend>{ASSISTANT_REMINDER_OPTIONS.map(option => <label className="xai-acknowledgement" key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => update(event.target.checked ? [...(Array.isArray(value) ? value : []), option.value] : (Array.isArray(value) ? value : []).filter(offset => offset !== option.value))} /><span>{option.label}</span></label>)}<p className="xai-note">Нагадування рахуються від указаного терміну.</p></fieldset>
    if (field.key === 'links') return <label key={field.key}>{field.label}<textarea rows={3} value={Array.isArray(value) ? value.join('\n') : ''} placeholder="Кожне посилання з нового рядка" onChange={event => update(event.target.value.split('\n').map(line => line.trim()).filter(Boolean))} /></label>
    if (field.type === 'files' || field.key === 'attachments') return <fieldset className="xai-file-editor" key={field.key}><legend>{field.label}</legend>{Array.isArray(value) && value.map((file: any, index) => <div className="xai-file-row" key={index}><FileText size={15} /><span>{file.name}</span><button type="button" className="xai-text-button xai-danger" disabled={toolBusy} onClick={() => update(value.filter((_, offset) => offset !== index))}>Прибрати</button></div>)}<label>Додати або замінити файли<input type="file" multiple disabled={toolBusy || offline} onChange={event => void uploadMaterialFiles([...(event.target.files || [])])} /></label>{toolBusy && <p className="xai-note">Перевіряємо та завантажуємо: {uploadProgress}%</p>}<p className="xai-note">Для заміни приберіть попередній файл і додайте новий. Студенти побачать оновлення після підтвердження чернетки. Один файл до 50 МБ; для більшого додайте посилання Google Drive.</p></fieldset>
    if (field.key === 'rules') {
      const rules = value && typeof value === 'object' ? value as Record<string, any> : { categories: [] }, categories = Array.isArray(rules.categories) ? rules.categories : []
      const categoryChange = (index: number, key: string, next: unknown) => update({ ...rules, categories: categories.map((category: any, offset: number) => offset === index ? { ...category, [key]: next } : category) })
      return <fieldset className="xai-row-editor" key={field.key}><legend>{field.label}</legend>{categories.map((category: any, index: number) => <div className="xai-edit-row" key={category.id || index}><label>Категорія<input value={category.name || ''} required maxLength={180} onChange={event => categoryChange(index, 'name', event.target.value)} /></label><div className="xai-two-fields"><label>Максимум балів<input type="number" min="0.01" max="10000" step="0.01" required value={category.max_points ?? ''} onChange={event => categoryChange(index, 'max_points', Number(event.target.value))} /></label><label>Коефіцієнт<input type="number" min="0" max="100" step="0.0001" required value={category.coefficient ?? 1} onChange={event => categoryChange(index, 'coefficient', Number(event.target.value))} /></label></div><button type="button" className="xai-text-button xai-danger" onClick={() => update({ ...rules, categories: categories.filter((_: unknown, offset: number) => offset !== index) })}>Прибрати категорію</button></div>)}<button type="button" className="xai-text-button" onClick={() => update({ ...rules, categories: [...categories, { id: crypto.randomUUID(), name: '', max_points: 100, coefficient: 1 }] })}><Plus size={14} />Додати категорію</button><div className="xai-two-fields"><label>Загальний максимум<input type="number" min="0.01" max="10000" step="0.01" value={rules.total_max ?? ''} onChange={event => update({ ...rules, total_max: event.target.value ? Number(event.target.value) : undefined })} /></label><label>Округлення<select value={rules.rounding || 'none'} onChange={event => update({ ...rules, rounding: event.target.value })}><option value="none">Без округлення</option><option value="integer">До цілого бала</option><option value="hundredth">До сотих</option></select></label></div><p className="xai-note">Коефіцієнт застосовується до суми категорії, потім враховується її максимум і загальний ліміт. Оцінки робіт самі не змінюються.</p></fieldset>
    }
    if (['checkbox', 'boolean'].includes(field.type)) return <label className="xai-acknowledgement" key={field.key}><input type="checkbox" checked={value === true} onChange={event => update(event.target.checked)} /><span>{field.label}</span></label>
    if (field.type === 'multiselect') return <fieldset className="xai-multiselect" key={field.key}><legend>{field.label}</legend>{options.map(option => <label className="xai-acknowledgement" key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => { const selected = event.target.checked ? [...(Array.isArray(value) ? value : []), option.value] : (Array.isArray(value) ? value : []).filter(item => item !== option.value); update(selected); if (field.key === 'groupIds' && ['teaching.assignment.upsert', 'teaching.publication.schedule'].includes(actionForm?.action || '')) setActionValues(current => ({ ...current, targets: selected.map(group => (Array.isArray(current.targets) ? current.targets : []).find((target: any) => target.groupId === group) || { groupId: group, lessonDate: actionForm?.scope.date || date, placementMode: 'unplaced', lessonId: null, dueAt: null, closesAt: null }) })) }} /><span>{option.label}</span></label>)}</fieldset>
    if (field.key === 'targets' && Array.isArray(value)) {
      const changeRow = (index: number, key: string, input: string) => { try { const next = ['dueAt', 'closesAt'].includes(key) ? assistantKyivInstant(input) : input; update(value.map((row: any, offset) => offset === index ? { ...row, [key]: next, ...(['groupId', 'lessonDate', 'placementMode'].includes(key) ? { lessonId: null } : {}) } : row)) } catch { setFieldErrors(current => ({ ...current, [field.key]: 'Перевірте час за Києвом.' })) } }
      return <fieldset className="xai-row-editor" key={field.key}><legend>{field.label}</legend>{value.map((entry: any, index) => <div className="xai-edit-row" key={entry.groupId || index}><strong>{options.find(option => option.value === entry.groupId)?.label || 'Група'}</strong><label>Дата заняття<input type="date" required value={entry.lessonDate || ''} onChange={event => changeRow(index, 'lessonDate', event.target.value)} /></label><label>Де показувати<select value={entry.placementMode || 'unplaced'} onChange={event => changeRow(index, 'placementMode', event.target.value)}><option value="unplaced">Окремо на вибрану дату</option><option value="lesson">Під конкретною парою</option></select></label>{entry.placementMode === 'lesson' && <label>Пара<select value={entry.lessonId || ''} required onChange={event => changeRow(index, 'lessonId', event.target.value)}><option value="">Після зміни дати натисніть «Підібрати пари»</option>{field.lessonOptions?.filter(lesson => lesson.groupId === entry.groupId && lesson.date === entry.lessonDate).map(lesson => <option key={lesson.value} value={lesson.value}>{lesson.label}</option>)}</select></label>}<div className="xai-two-fields"><label>Термін здачі, за Києвом<input type="datetime-local" value={assistantKyivInput(entry.dueAt)} onChange={event => changeRow(index, 'dueAt', event.target.value)} /></label><label>Закриття прийому, за Києвом<input type="datetime-local" value={assistantKyivInput(entry.closesAt)} onChange={event => changeRow(index, 'closesAt', event.target.value)} /></label></div></div>)}<p className="xai-note">Порожній термін означає вільний строк. Групи обираються вище.</p></fieldset>
    }
    if (['questions', 'teams', 'rows', 'targets', 'slotAssignments'].includes(field.key) && Array.isArray(value)) {
      const columns = field.key === 'questions' ? [['body', 'Питання', 'textarea'], ['primaryCapacity', 'Доповідачів', 'number'], ['supplementCapacity', 'Доповнень', 'number']] : field.key === 'teams' ? [['name', 'Назва команди', 'text'], ['capacity', 'Учасників', 'number']] : field.key === 'rows' ? [['entryId', 'Студент', 'select'], ['score', 'Бали', 'number'], ['comment', 'Коментар', 'textarea'], ['reason', 'Причина зміни оприлюдненого бала', 'textarea']] : field.key === 'targets' ? [['groupId', 'Група', 'select'], ['lessonDate', 'Дата заняття', 'date'], ['dueAt', 'Термін здачі', 'datetime-local']] : [['source_starts_at', 'Було: початок', 'time'], ['source_ends_at', 'Було: кінець', 'time'], ['target_lesson_number', 'Номер пари після переносу', 'number'], ['target_starts_at', 'Новий початок', 'time'], ['target_ends_at', 'Новий кінець', 'time']]
      return <fieldset className="xai-row-editor" key={field.key}><legend>{field.label}</legend>{value.map((entry: any, index) => <div className="xai-edit-row" key={index}>{columns.map(([key, label, type]) => <label key={key}>{label}{type === 'select' ? <select value={entry[key] || ''} onChange={event => update(value.map((row, offset) => offset === index ? { ...row, [key]: event.target.value } : row))}><option value="">Оберіть</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : type === 'textarea' ? <textarea rows={2} maxLength={10000} value={entry[key] ?? ''} onChange={event => update(value.map((row, offset) => offset === index ? { ...row, [key]: event.target.value } : row))} /> : <input type={type} step={type === 'number' ? '0.01' : undefined} value={entry[key] ?? ''} onChange={event => update(value.map((row, offset) => offset === index ? { ...row, [key]: type === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value } : row))} />}</label>)}<button className="xai-text-button xai-danger" type="button" onClick={() => update(value.filter((_, offset) => offset !== index))}>Прибрати</button></div>)}<button type="button" className="xai-text-button" onClick={() => update([...value, field.key === 'questions' ? { body: '', primaryCapacity: 1, supplementCapacity: 0 } : field.key === 'teams' ? { name: '', capacity: 4 } : field.key === 'rows' ? { entryId: '', score: null, comment: '' } : field.key === 'slotAssignments' ? { source_starts_at: '', source_ends_at: '', target_lesson_number: value.length + 1, target_starts_at: '', target_ends_at: '' } : {}])}><Plus size={15} />Додати рядок</button></fieldset>
    }
    if (field.type === 'json' || value !== null && typeof value === 'object') return <label key={field.key}>{field.label}<textarea rows={7} defaultValue={JSON.stringify(value ?? null, null, 2)} onChange={event => { try { update(JSON.parse(event.target.value)) } catch { setFieldErrors(current => ({ ...current, [field.key]: 'Перевірте формат значень.' })) } }} />{fieldErrors[field.key] && <span className="xai-error">{fieldErrors[field.key]}</span>}</label>
    if (field.type === 'select' || options.length) return <label key={field.key}>{field.label}<select required={field.required} value={String(value ?? '')} onChange={event => { const selected = event.target.value; update(selected); if (selected && actionForm && (field.key === 'activityId' || field.key === 'id' && ['teaching.material.upsert', 'teaching.material.visibility', 'teaching.material.ai', 'teaching.material.collaborators', 'schedule.update', 'schedule.move', 'seminar.book', 'seminar.team.join'].includes(actionForm.action))) void requestActionForm(actionForm.action, { [field.key]: selected, ...(actionForm.action.startsWith('schedule.') ? { date: actionValues.date || actionForm.scope.date, sourceDate: actionValues.sourceDate || actionForm.scope.date } : {}) }, actionForm.scope) }}><option value="">Оберіть</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    return <label key={field.key}>{field.label}{field.type === 'textarea' ? <textarea rows={4} required={field.required} maxLength={10000} onPaste={event => boundedPaste(event, 10000)} value={String(value ?? '')} onChange={event => update(event.target.value)} /> : <input type={['date', 'time', 'datetime-local', 'number', 'url'].includes(field.type) ? field.type : 'text'} step={field.type === 'number' ? '0.01' : undefined} required={field.required} value={field.type === 'datetime-local' ? assistantKyivInput(value) : String(value ?? '')} maxLength={10000} onChange={event => update(field.type === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value)} />}</label>
  }
  function openFromRoute() {
    if (catalog) { const context = validateAssistantPageContext(currentAssistantPageContext(ownerId), ownerId, catalog) || assistantRouteContext(pathname, window.location.search, catalog); if (context.groupId) { setGroupId(context.groupId); chatSelectedGroup.current = context.groupId } if (context.courseId) setCourseId(context.courseId); if (context.subjectId) setSubjectId(context.subjectId); if (context.date) { setDate(context.date); chatSelectedDate.current = context.date } if (context.groupId || context.courseId || pathname.startsWith('/teaching')) { setMode(context.mode); setTopic('topic' in context && typeof context.topic === 'string' ? context.topic as LiveReadTopic : context.mode === 'teaching' ? 'teaching' : 'study') } }
    setOpen(true)
  }
  const draftGroupName = catalog?.groups.find(group => group.id === draft?.scope.groupId)?.name || 'Вибрана група'
  const reviewedDraftDate = typeof draft?.payload.date === 'string' ? draft.payload.date : draft?.scope.date
  const lockedDraft = draft && ['pending', 'committing', 'unknown'].includes(draft.status)
  const contextDifferent = !!draft?.scope.groupId && draft.scope.groupId !== groupId
  const showRecurrenceReview = draft?.action === 'schedule.create' && recurringReviewIds.current.has(draft.id)
  const recurrenceIssues = showRecurrenceReview ? assistantRecurringDraftIssues(draftPayload) : []
  const importQueueReady = assistantImportBatchReady(preparedDrafts) && (!draft || assistantImportBatchReady([draft]))
  const gradeSummaries = (readResult as any)?.gradeSummary as { title: string; points: number; maxPoints: number; weightedPoints: number; weightedMaxPoints: number; formula: string; partial?: boolean; categories?: { id: string; name: string; raw: number; coefficient: number; weighted: number; capped: number; maximum: number }[] }[] | undefined
  const shownGrades = readResult && ['results', 'gradebook'].includes(topic) ? assistantGradeSummary(readResult.records, catalog || undefined) : []
  const requiresGroup = ['study', 'materials', 'results', 'seminars', 'gradebook'].includes(topic)

  if (!status?.available) return null
  return <div className="xai-root">
    <button className={`xai-launcher${open ? ' xai-launcher-hidden' : ''}`} type="button" ref={launcher} aria-controls={panelId} aria-expanded={open} onClick={openFromRoute}><Sparkles size={21} /><span>Помічник</span></button>
    {open && <><button className="xai-mobile-backdrop" aria-label="Закрити помічника" onClick={close} tabIndex={-1} /><section ref={panel} className={`xai-drawer${expanded ? ' xai-expanded' : ''}`} id={panelId} role="dialog" aria-labelledby={titleId}>
      <header className="xai-heading"><div className="xai-heading-title"><span className="xai-mark"><Sparkles size={19} /></span><div><h2 id={titleId}>Помічник Xelay</h2><span>Ваш навчальний простір</span></div></div><div className="xai-heading-actions"><button className="xai-icon-button" type="button" aria-label="Історія змін" aria-expanded={view === 'drafts'} disabled={writing || offline} onClick={() => setView(value => value === 'drafts' ? 'chat' : 'drafts')}><History size={17} /></button><button className="xai-icon-button xai-expand-button" type="button" aria-label={expanded ? 'Зменшити помічника' : 'Розгорнути помічника'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button className="xai-icon-button" ref={closeButton} type="button" aria-label="Закрити помічника" onClick={close}><X size={20} /></button></div></header>
      {!status.modelConnected && <div className="xai-model-notice"><span className="xai-status-dot" /><div><strong>{status.modelConnected ? 'Напишіть своїми словами' : 'Працюємо з даними'}</strong><p>{status.modelConnected ? 'Знайду потрібний запис і підготую зміни. Перед збереженням ви все перевірите.' : 'Чат поки недоступний. Розклад і збережені ДЗ можна відкрити в параметрах розмови.'}</p></div></div>}
      <div className="xai-content xai-content-conversation">
        {offline && <p className="xai-offline" role="status"><WifiOff size={17} />Немає інтернету. Доступні збережені розклад і ДЗ. Нові відповіді та зміни запрацюють після підключення.</p>}
        {loading ? <div className="xai-empty" role="status"><LoaderCircle className="xai-spin" size={25} /><h3>Відкриваємо ваш простір</h3><p>Перевіряємо доступні вам групи й предмети.</p></div> : status && !status.available ? <div className="xai-empty"><Sparkles size={28} /><h3>Готуємо помічника до запуску</h3><p>Звичайні розділи Xelay працюють як завжди.</p><button className="xai-button" onClick={() => void loadCatalog()}>Перевірити знову</button></div> : <>
          {error && <div className="xai-error" role="alert"><p>{error}</p><button className="xai-text-button" onClick={() => void loadCatalog()}>Оновити доступ</button></div>}
          {catalog && <div className="xai-chat-view">
            <div className="xai-chat-context">
              <span><GraduationCap size={14} /><strong>{selectedGroup?.name || (mode === 'teaching' ? 'Ваші навчальні групи' : 'Ваш помічник')}</strong>{mode === 'learning' && selectedGroup?.id === assistantLearningDefault(catalog)?.id && <small>підключено автоматично</small>}</span>
              <div className="xai-context-actions"><details className="xai-context-settings"><summary aria-label="Параметри розмови"><SlidersHorizontal size={16} /></summary><div className="xai-context-options">
                {hasLearning && hasTeaching && <label>Режим<select value={mode} disabled={chatBusy || writing} onChange={event => changeMode(event.target.value as 'learning' | 'teaching')}><option value="learning">Моє навчання</option><option value="teaching">Викладання</option></select></label>}
                {groups.length > 1 && <label>Група для розмови<select aria-label="Група для розмови" value={chatSelectedGroup.current} disabled={chatBusy || writing} onChange={event => { resetContext(); chatSelectedGroup.current = event.target.value; setGroupId(event.target.value); setSubjectId(''); setCourseId('') }}><option value="">Уточнити в повідомленні</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}{group.studyYear ? ' · '+group.studyYear+' курс' : ''}</option>)}</select></label>}
                <button type="button" className="xai-text-button" disabled={chatBusy || writing} onClick={() => setView(value => value === 'data' ? 'chat' : 'data')}>{offline ? 'Збережені розклад і ДЗ' : 'Уточнити пошук'}<ChevronRight size={14} /></button>
              </div></details>{!!messages.length && <button type="button" disabled={chatBusy} className="xai-icon-button" aria-label="Нова розмова" onClick={() => { resetChatScope(); setMessage(''); setTeacherMessage(''); setShowTeacherMessage(false); setView('chat') }}><Plus size={17} /></button>}</div>
            </div>
            {(courseId || subjectId || chatSelectedDate.current) && <div className="xai-context-stamp"><span>{selectedCourse?.name || catalog.subjects.find(subject => subject.id === subjectId)?.name || topics[topic]}</span>{chatSelectedDate.current && <time dateTime={chatSelectedDate.current}>{dateLabel(chatSelectedDate.current)}</time>}<button type="button" className="xai-text-button" onClick={() => setView('data')}>Змінити контекст</button></div>}
            <div className="xai-chat-messages" aria-live="polite" aria-relevant="additions text">
              {!messages.length && <div className="xai-chat-welcome"><span className="xai-chat-spark"><Sparkles size={27} /></span><h3>Що зробимо сьогодні?</h3><p>{mode === 'teaching' ? 'Запитайте про свої заняття, матеріали або журнал підключених груп.' : canHomework ? 'Напишіть запит і вставте повідомлення викладача. Знайду предмет, дату та пару, а потім покажу чернетку.' : 'Запитайте про розклад, ДЗ, матеріали чи власні бали. Також можу підготувати особисту справу.'}</p><p className="xai-chat-example">Наприклад: «Які в мене завтра пари?»</p></div>}
              {messages.map((entry, index) => <article key={entry.id} className={`xai-chat-message xai-chat-${entry.role}`}><span className="xai-chat-speaker">{entry.role === 'user' ? 'Ви' : 'Xelay'}</span><p>{entry.content}</p>
                {entry.sources?.map((source, offset) => { const path = assistantSourcePath(source.sourcePath || source.path); return path ? <a className="xai-link" key={offset} href={path}>{source.title}<ArrowUpRight size={14} /></a> : <span className="xai-note" key={offset}>{source.title}</span> })}
                {entry.sources?.some(source => source.path === '/community') && <button className="xai-text-button" type="button" onClick={() => { void navigator.clipboard.writeText(entry.content).catch(() => setChatError('Не вдалося скопіювати. Виділіть текст повідомлення вручну.')) }}>Скопіювати текст питання</button>}
                {entry.draft && <button type="button" className="xai-chat-draft-link" disabled={writing} onClick={() => selectDraft(entry.draft!)}><FileText size={19} /><span><strong>{entry.draft.title}</strong><small>Переглянути чернетку перед збереженням</small></span><ChevronRight size={17} /></button>}
                {entry.drafts?.map(item => <button type="button" key={item.id} className="xai-chat-draft-link" disabled={writing || offline} onClick={() => selectDraft(item)}><FileText size={19} /><span><strong>{item.title}</strong><small>Перевірити й підтвердити окремо</small></span><ChevronRight size={17} /></button>)}
                {entry.read && <div className="xai-chat-records">{entry.read.records.slice(0, 8).map(record => <RecordCard key={record.kind + record.id} record={record} groupName={catalog.groups.find(group => group.id === record.groupId)?.name} canHomework={false} onHomework={() => {}} onAction={(nextAction, payload, scoped) => void requestActionForm(nextAction, payload, scoped)} onExplain={status.modelConnected ? record => void explainMaterial(record) : undefined} canManageSeminars={mode === 'learning' && !!selectedGroup?.permissions.includes('seminars')} disabled={writing || offline} />)}{entry.read.records.length > 8 || entry.read.truncated ? <p className="xai-note">Показано перші {Math.min(entry.read.records.length, 8)} записів. Уточніть предмет або дату, щоб звузити відповідь.</p> : null}</div>}
                {entry.choices && index === messages.length - 1 && <div className="xai-chat-choices">{entry.choices.items.map(choice => <button key={choice.id} type="button" disabled={chatBusy || writing || !status.modelConnected} onClick={() => void sendChat(choice.label)}>{choice.label}<ChevronRight size={14} /></button>)}</div>}
              </article>)}
              {chatBusy && <div className="xai-chat-thinking" role="status"><Sparkles size={16} /><span>Розбираємо повідомлення</span><span className="xai-chat-dots" aria-hidden="true"><i /><i /><i /></span></div>}
              {chatError && <p className="xai-error" role="alert">{chatError}</p>}

            </div>

          </div>}
          {catalog && view === 'data' && <section className="xai-inline-context" aria-label="Уточнення пошуку"><div className="xai-inline-heading"><h3>Уточнення пошуку</h3><button type="button" className="xai-icon-button" aria-label="Закрити уточнення пошуку" onClick={() => setView('chat')}><X size={17} /></button></div>
            {hasLearning && hasTeaching && <div className="xai-mode-switch" aria-label="Режим перегляду"><button className={mode === 'learning' ? 'active' : ''} onClick={() => changeMode('learning')}>Навчання</button><button className={mode === 'teaching' ? 'active' : ''} onClick={() => changeMode('teaching')}>Викладання</button></div>}
            <label>Де шукати<select value={topic} onChange={event => { resetContext(); setTopic(event.target.value as LiveReadTopic); setSubjectId(''); setQuery(''); setQueryInput('') }}>{allowedTopics.map(item => <option key={item} value={item}>{topics[item]}</option>)}</select></label>
            {['community', 'news', 'opportunities', 'help', 'materials'].includes(topic) && <form className="xai-search" onSubmit={event => { event.preventDefault(); setQuery(queryInput.trim()) }}><label><span className="xai-sr-only">Що знайти</span><input value={queryInput} maxLength={180} onChange={event => setQueryInput(event.target.value)} placeholder={topic === 'help' ? 'Наприклад як додати групу' : 'Слово або тема для пошуку'} /></label><button className="xai-button" type="submit" disabled={reading || offline}>Знайти</button></form>}
            {topic === 'organizer' && <label className="xai-space-choice">Органайзер<select value={organizerSpace} onChange={event => setOrganizerSpace(event.target.value as typeof organizerSpace)}><option value="personal">Мої особисті справи</option><option value="shared">Доступні спільні справи</option><option value="all">Усі доступні</option></select></label>}
            <div className="xai-filters"><label>Група<select value={groupId} onChange={event => { resetContext(); setGroupId(event.target.value); setSubjectId(''); setCourseId(''); chatSelectedGroup.current = event.target.value; setContinuation(undefined) }}>{mode === 'teaching' && topic === 'teaching' ? <option value="">Усі підключені групи</option> : !groups.length ? <option value="">Поки немає груп</option> : null}{groups.map(group => <option key={group.id} value={group.id}>{group.name}{group.studyYear ? ` · ${group.studyYear} курс` : ''}</option>)}</select></label>
              {mode === 'teaching' ? <label>Ваш предмет<select value={courseId} onChange={event => { resetContext(); setCourseId(event.target.value) }}><option value="">{topic === 'teaching' ? 'Усі мої предмети' : 'Оберіть предмет'}</option>{courses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label> : <label>Предмет<select value={subjectId} onChange={event => { resetContext(); setSubjectId(event.target.value) }}><option value="">Усі предмети</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>}
              {['study', 'teaching', 'seminars'].includes(topic) && <label>Дата заняття<input type="date" value={date} onChange={event => { resetContext(); setDate(event.target.value); chatSelectedDate.current = event.target.value; setContinuation(undefined) }} /></label>}
              <label>Період<select value={period} onChange={event => { resetContext(); setPeriod(event.target.value as typeof period) }}><option value="current">Актуальне</option><option value="archive">Минулі семестри</option><option value="all">Усі записи</option></select></label>
            </div>
            <div className="xai-results-heading"><div><h3>{topics[topic]}</h3><p>{readResult ? `${readResult.records.length} записів · ${dateLabel(readResult.readAt)}` : selectedGroup?.program || 'Тільки доступні вашому акаунту записи'}</p></div><button className="xai-icon-button" aria-label="Оновити записи" disabled={reading} onClick={() => void readData()}><RefreshCw size={18} className={reading ? 'xai-spin' : ''} /></button></div>
            {cachedAt && <p className="xai-info"><WifiOff size={15} />Збережено {dateLabel(new Date(cachedAt).toISOString())}. Це копія до 14 днів; розклад і ваш доступ могли змінитися. Нові дії потребують перевірки через інтернет.</p>}
            {!!gradeSummaries?.length && <div className="xai-grade-overview">{gradeSummaries.map((summary, index) => <article className="xai-grade-summary" key={index}><h3>{summary.title}</h3><strong>{summary.weightedPoints} <small>із {summary.weightedMaxPoints ?? 'без ліміту'}</small></strong><p>{summary.formula}</p>{summary.partial && <p className="xai-note">Підсумок лише за показаними роботами. Уточніть період для повного розрахунку.</p>}<details><summary>Як пораховано</summary><p>Сума без коефіцієнтів: {summary.points} із {summary.maxPoints}.</p>{summary.categories?.map(category => <p key={category.id}>{category.name}: {category.raw} × {category.coefficient} = {category.weighted}; з урахуванням максимуму {category.capped} із {category.maximum}.</p>)}</details></article>)}</div>}
            {!gradeSummaries?.length && shownGrades.length > 0 && <div className="xai-grade-overview">{shownGrades.map(summary => <article className="xai-grade-summary" key={summary.id}><h3>{summary.title}</h3><strong>{summary.points} <small>із {summary.maximum}</small></strong><p>Сума {summary.count} показаних робіт. Підсумкові обмеження категорій та округлення перевіряйте в журналі.</p></article>)}</div>}
            {reading ? <div className="xai-loading" role="status"><LoaderCircle size={20} className="xai-spin" />Завантажуємо записи…</div> : <div className="xai-records">{readResult?.records.map(record => <div key={record.kind + record.id}><RecordCard record={record} groupName={!groupId ? catalog.groups.find(group => group.id === record.groupId)?.name : undefined} canHomework={canHomework && !!status?.writesAvailable && !offline && !cachedAt} onHomework={record => startForm('homework.upsert', record)} onAction={(nextAction, payload, scoped) => void requestActionForm(nextAction, payload, scoped)} onExplain={status.modelConnected ? record => void explainMaterial(record) : undefined} canManageSeminars={mode === 'learning' && !!selectedGroup?.permissions.includes('seminars')} disabled={writing || toolBusy || offline || !!cachedAt} />{mode === 'teaching' && record.kind === 'material' && teacherPermissions.includes('materials') && <button className="xai-text-button" disabled={writing || offline} onClick={() => void requestActionForm('teaching.material.upsert', { id: (record as any).materialId || record.id, version: (record as any).version }, { groupId: record.groupId, courseId, date })}>Оновити матеріал</button>}</div>)}</div>}
            {!reading && !error && (!groups.length && requiresGroup ? <div className="xai-empty"><FolderOpen size={28} /><h3>Підключених груп поки немає</h3><p>Вони з’являться після прийняття запрошення або підключення викладання.</p></div> : mode === 'teaching' && !courseId && ['materials', 'gradebook'].includes(topic) ? <div className="xai-empty"><BookOpen size={28} /><h3>Оберіть свій предмет</h3><p>Покажемо записи тільки його доступних груп.</p></div> : readResult && !readResult.records.length ? <div className="xai-empty"><CalendarDays size={28} /><h3>Записів поки немає</h3><p>Спробуйте іншу дату, предмет або період.</p></div> : null)}
            {topic === 'study' && readResult?.records.some(record => record.kind === 'homework') && <section className="xai-preparation"><h3>План підготовки</h3><p className="xai-note">За доступними завданнями на обрану дату. Перевірте умови викладача перед початком.</p>{readResult.records.filter(record => record.kind === 'homework').map(record => <article key={record.id}><h4>{record.title}</h4><ol><li>Прочитайте повні умови та випишіть, що потрібно здати.</li><li>Перегляньте матеріали предмета й підготуйте виконання.</li><li>Перевірте результат{record.dueAt ? ` до ${dateLabel(record.dueAt)}` : ' до відповідного заняття, якщо так вказав викладач'}.</li></ol><button className="xai-text-button" disabled={writing || offline} onClick={() => void requestActionForm('organizer.task.create', { title: `Підготувати: ${record.title}`, notes: record.body || '', dueAt: record.dueAt || null, space: 'personal' }, {})}>Додати до моїх справ<Plus size={14} /></button></article>)}</section>}
            {readResult?.truncated && <p className="xai-note">Показано перші 30 записів. Уточніть предмет або період.</p>}
            {status?.writesAvailable && !offline && <button className="xai-button xai-primary xai-create" onClick={() => startForm()}><Plus size={17} />Підготувати зміну</button>}
          </section>}
            {explanation && <section className="xai-explanation"><h3>Пояснення матеріалу</h3><p className="xai-body">{explanation.text}</p>{explanation.sources.map((source, index) => assistantSourcePath(source.sourcePath || source.path) ? <a className="xai-link" key={index} href={assistantSourcePath(source.sourcePath || source.path)!}>{source.title}<ArrowUpRight size={14} /></a> : <p key={index} className="xai-note">{source.title}</p>)}</section>}
          {catalog && view === 'change' && (draft || actionForm || importOpen || remainingImports.length > 0 || formOpen) && <section className="xai-inline-workflow" aria-label="Підготовка зміни у розмові">
            {preparedDrafts.length > 1 && <section className="xai-prepared-list"><h3>{preparedDrafts.length} окремих чернеток</h3><p className="xai-note">Кожну зміну перегляньте та підтвердьте окремо. Непідтверджені записи не зберігаються.</p>{preparedDrafts.map(item => <button type="button" className="xai-history-item" key={item.id} disabled={writing || offline} onClick={() => selectDraft(item)}><FileText size={16} /><span>{typeof item.payload.subject === "string" ? item.payload.subject : item.title} · {statuses[item.status]}<small>{item.items.find(row => row.id === "authoritative-lesson")?.after || `${catalog.groups.find(group => group.id === item.scope.groupId)?.name || "Особиста справа"} · ${dateLabel(item.scope.date)}`}</small></span><ChevronRight size={15} /></button>)}</section>}
            {remainingImports.length > 0 && <section className="xai-import-queue"><h3>Ще {remainingImports.length} пар чекають підготовки</h3><p className="xai-note">Для групи «{catalog.groups.find(group => group.id === remainingImports[0].scope.groupId)?.name || 'Вибрана група'}». Спочатку підтвердьте або скасуйте поточну пачку. Наступні пари вже розпізнані: повторного звернення до моделі не буде. Кожна матиме свій перегляд і підтвердження.</p><button type="button" className="xai-button xai-primary" disabled={writing || offline || !status?.writesAvailable || !importQueueReady} onClick={() => void prepareNextImportChunk()}>{writing ? <LoaderCircle size={16} className="xai-spin" /> : <Plus size={16} />}Підготувати наступні {Math.min(10, remainingImports.length)}</button><button className="xai-text-button" type="button" disabled={writing || offline} onClick={() => setView('drafts')}>Перевірити стан чернеток</button><button className="xai-text-button xai-danger" type="button" disabled={writing} onClick={() => { setRemainingImports([]); setToolError('Непідготовлену чергу відкинуто. Уже створені чернетки залишилися в історії змін.') }}>Відкинути непідготовлену чергу</button><p className="xai-note">Закриття помічника збереже чергу. Не перезавантажуйте сторінку до завершення імпорту.</p></section>}
            {importOpen && <fieldset className="xai-import-form"><legend>Період розкладу</legend><div className="xai-two-fields"><label>Діє з<input type="date" form="xai-import-form" value={importPeriod.validFrom} required onChange={event => setImportPeriod(current => ({ ...current, validFrom: event.target.value }))} /></label><label>Діє до<input type="date" form="xai-import-form" value={importPeriod.validUntil} min={importPeriod.validFrom} required onChange={event => setImportPeriod(current => ({ ...current, validUntil: event.target.value }))} /></label></div><label>Понеділок верхнього тижня, якщо є чергування<input type="date" form="xai-import-form" value={importPeriod.weekAnchorDate} onChange={event => setImportPeriod(current => ({ ...current, weekAnchorDate: event.target.value }))} /></label><p className="xai-note">Ці дати задаєте ви. Помічник не підставляє тривалість семестру навмання.</p></fieldset>}
            {importOpen && <form id="xai-import-form" className="xai-import-form xai-form" onSubmit={event => void importSchedule(event)}><h3>Розклад із фото або таблиці</h3><label>Група, куди додати<select value={groupId} required onChange={event => setGroupId(event.target.value)}><option value="">Оберіть групу</option>{catalog.groups.filter(group => group.learning && group.permissions.includes('schedule')).map(group => <option key={group.id} value={group.id}>{group.name} · {group.studyYear} курс</option>)}</select></label><label>Фото або таблиці<input type="file" accept=".png,.jpg,.jpeg,.webp,.xlsx,.csv,.tsv" multiple disabled={toolBusy || offline} onChange={event => { const files = [...(event.target.files || [])]; setImportFiles(files); setToolError(files.length > 10 ? 'Додайте до 10 файлів.' : '') }} /></label>{importFiles.length > 0 && <ul className="xai-file-list">{importFiles.map((file, index) => <li key={index}><FileText size={14} /><span>{file.name}</span><button type="button" className="xai-icon-button" disabled={toolBusy} aria-label={`Прибрати ${file.name}`} onClick={() => setImportFiles(current => current.filter((_, offset) => offset !== index))}><X size={14} /></button></li>)}</ul>}<label><span><Link size={13} /> Або посилання на Google-таблицю</span><input type="url" value={sheetUrl} disabled={toolBusy} onChange={event => setSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></label><div className="xai-two-fields"><label>Група у файлі<input value={importHints.groupHint} onChange={event => setImportHints(current => ({ ...current, groupHint: event.target.value }))} placeholder={selectedGroup?.name || 'Наприклад ЕУБ-1'} maxLength={180} /></label><label>Курс та ОП<input value={importHints.courseHint} onChange={event => setImportHints(current => ({ ...current, courseHint: event.target.value }))} placeholder="1 курс, ЕУБ" maxLength={180} /></label></div><label>Як розміщені групи<select value={importHints.columnHint} onChange={event => setImportHints(current => ({ ...current, columnHint: event.target.value }))}><option value="">Нехай уточнить, якщо незрозуміло</option><option value="left">Моя група ліворуч усередині кожного дня</option><option value="right">Моя група праворуч усередині кожного дня</option></select></label><label>Тижні<select value={importHints.weekHint} onChange={event => setImportHints(current => ({ ...current, weekHint: event.target.value }))}><option value="">Уточнити за таблицею</option><option value="horizontal-upper-lower">Горизонтальне ділення: зверху верхній, знизу нижній тиждень</option><option value="upper">Увесь файл: верхній тиждень</option><option value="lower">Увесь файл: нижній тиждень</option><option value="both">Щотижня</option></select></label><p className="xai-note">До 10 файлів. Фото зменшуються перед відправленням; таблиця до 2 МБ. Google-таблиця має бути доступна за посиланням. Зміни з’являться лише після окремого підтвердження кожної чернетки. Лише за кнопкою вибрані файли, текст Google-таблиці та ці підказки передаються OpenAI для розпізнавання.</p><button className="xai-button xai-primary" disabled={toolBusy || offline || !status.modelConnected || !groupId || !importPeriod.validFrom || !importPeriod.validUntil || importFiles.length > 10 || !importFiles.length && !sheetUrl.trim()}>{toolBusy ? <LoaderCircle className="xai-spin" size={17} /> : <Sparkles size={17} />}Розпізнати й переглянути</button><button type="button" className="xai-text-button" disabled={toolBusy} onClick={() => { setImportOpen(false); setView('chat') }}>Закрити імпорт</button></form>}
            {actionForm && <form className="xai-form xai-structured-form" onSubmit={event => void prepareActionForm(event)}><h3>{actionForm.title}</h3>{actionForm.scope.groupId && <p className="xai-target">Група: <strong>{catalog.groups.find(group => group.id === actionForm.scope.groupId)?.name || "Вибрана група"}</strong>{actionForm.scope.courseId ? ` · ${catalog.courses.find(course => course.id === actionForm.scope.courseId)?.name || "Ваш предмет"}` : ""}</p>}<p className="xai-note">Варіанти завантажені після перевірки ваших прав. Тут ще нічого не зберігається.</p><fieldset className="xai-draft-fields" disabled={writing || toolBusy || offline}>{actionForm.fields.map(field => structuredField(field))}</fieldset>{['schedule.copy', 'schedule.move', 'schedule.update', 'homework.upsert', 'teaching.material.upsert', 'teaching.material.visibility', 'teaching.grades.save', 'teaching.assignment.upsert', 'teaching.publication.schedule'].includes(actionForm.action) && <button type="button" className="xai-button" disabled={writing || toolBusy || offline} onClick={() => void refreshActionForm()}><RefreshCw size={15} />{actionForm.action === 'teaching.grades.save' ? 'Показати студентів вибраної роботи' : actionForm.action.startsWith('teaching.material.') ? 'Завантажити вибраний матеріал' : 'Підібрати пари за датою'}</button>}<button className="xai-button xai-primary" disabled={writing || toolBusy || offline || actionForm.action === 'homework.batch' && !status.modelConnected || Object.values(fieldErrors).some(Boolean)}>{writing ? <LoaderCircle size={17} className="xai-spin" /> : <FileText size={17} />}{editingDraft ? 'Оновити перегляд чернетки' : 'Показати чернетку'}</button><button className="xai-text-button" type="button" disabled={writing || toolBusy} onClick={() => { setActionForm(null); if (editingDraft) selectDraft(editingDraft); setEditingDraft(null); if (!editingDraft) setView('chat') }}>Скасувати підготовку</button></form>}
            {formOpen && status?.writesAvailable && <form className="xai-form" onSubmit={event => void prepare(event)}><label>Що підготувати<select value={action} onChange={event => startForm(event.target.value)}>{availableActions.map(item => <option key={item} value={item}>{actions[item]}</option>)}</select></label>
              {action !== 'organizer.task.create' && <div className="xai-target">Група: <strong>{selectedGroup?.name || 'Оберіть групу в параметрах розмови'}</strong></div>}
              {action === 'schedule.create' ? <>{formInput('date', 'Дата', 'date', true)}{formInput('subject', labels.subject, 'text', true)}<div className="xai-two-fields">{formInput('startsAt', labels.startsAt, 'time', true)}{formInput('endsAt', labels.endsAt, 'time', true)}</div><label>Тип заняття<select value={formValues.lessonType || 'lecture'} onChange={event => setFormValues(current => ({ ...current, lessonType: event.target.value }))}>{lessonTypes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>{formInput('location')}{formInput('teacherName')}<label>{labels.links}<textarea rows={2} maxLength={maxLengths.links} value={formValues.links || ''} onChange={event => setFormValues(current => ({ ...current, links: event.target.value }))} /></label>{formInput('conferenceId')}{formInput('accessCode')}<p className="xai-note">Створиться одна пара на вибрану дату без повторення.</p></> : action === 'homework.upsert' ? <><label>Пара<select value={formValues.lessonId || ''} required onChange={event => { const record = readResult?.records.find(item => item.kind === 'lesson' && item.scheduleId === event.target.value); setFormValues(current => ({ ...current, lessonId: event.target.value, date: record?.date || date })) }}><option value="">Оберіть пару з відкритого розкладу</option>{readResult?.records.filter(record => record.kind === 'lesson' && record.scheduleId && record.groupId === groupId).map(record => <option key={record.id} value={record.scheduleId}>{record.startsAt} · {record.title}</option>)}</select></label>{formInput('topic', labels.topic, 'text', true)}<label>{labels.body}<textarea rows={5} maxLength={maxLengths.body} required value={formValues.body || ''} onChange={event => setFormValues(current => ({ ...current, body: event.target.value }))} /></label><p className="xai-note">ДЗ до пари {dateLabel(formValues.date)}. Щоб обрати іншу дату, уточніть дату в розмові.</p></> : <>{formInput('title', labels.title, 'text', true)}<label>{labels.notes}<textarea rows={4} maxLength={maxLengths.notes} value={formValues.notes || ''} onChange={event => setFormValues(current => ({ ...current, notes: event.target.value }))} /></label><p className="xai-note">Особиста справа у вашому органайзері. Доступ за підпискою перевіряється на сервері.</p></>}
              <button className="xai-button xai-primary" disabled={writing || action !== 'organizer.task.create' && !groupId}>{writing ? <LoaderCircle className="xai-spin" size={17} /> : <FileText size={17} />}Показати чернетку</button><button type="button" className="xai-text-button" disabled={writing} onClick={() => { setFormOpen(false); setFormValues({}) }}>Скасувати підготовку</button>
            </form>}
            {draft && <section className="xai-draft" aria-label="Перегляд чернетки"><div className="xai-draft-heading"><FileText size={18} /><h3>{draft.title}</h3><span>{statuses[draft.status]}</span></div>
              {draft.status === 'pending' && (draft as any).requiresMaterialRights && <label className="xai-acknowledgement"><input type="checkbox" checked={materialRightsAccepted} disabled={writing || dirty || offline} onChange={event => setMaterialRightsAccepted(event.target.checked)} /><span>Я маю право розміщувати ці матеріали та надавати до них доступ вибраним групам.</span></label>}
              {draft.status === 'pending' && !['schedule.create', 'homework.upsert', 'organizer.task.create'].includes(draft.action) && <button type="button" className="xai-button" disabled={writing || offline} onClick={() => void editStructuredDraft()}>Редагувати чернетку</button>}
              {draft.status === 'stale' && draft.action === 'schedule.create' && <button type="button" className="xai-button" disabled={writing || offline} onClick={() => void renewExpiredImportDraft()}>Повторно підготувати цю пару</button>}
              {draft.scope.groupId && <p className="xai-target"><strong>{draftGroupName}</strong>{reviewedDraftDate ? ` · ${dateLabel(reviewedDraftDate)}` : ''}</p>}
              {contextDifferent && <p className="xai-info">Ця чернетка залишається для групи «{draftGroupName}», навіть якщо ви відкрили іншу групу.</p>}
              {draft.status === 'pending' ? <><p className="xai-note">Дійсна до {dateLabel(draft.expiresAt)}. Перевірте всі поля.</p><fieldset disabled={writing} className="xai-draft-fields">{Object.entries(draftPayload).map(([key, value]) => draftField(key, value))}{showRecurrenceReview && <RecurringScheduleReview payload={draftPayload} disabled={writing || offline} onChange={next => { setDraftPayload(next); setAcknowledged(false); setMaterialRightsAccepted(false) }} />}</fieldset>{draft.items.map(item => <div className="xai-summary" key={item.id}><strong>{item.label}</strong>{item.before && <p>Зараз: {item.before}</p>}<p>Після збереження: {item.after}</p></div>)}{dirty && <button className="xai-button" disabled={writing || recurrenceIssues.length > 0} onClick={() => void draftOperation('edit')}>Оновити перегляд змін</button>}<div className="xai-confirm-warning"><ShieldCheck size={18} /><p>{draft.scope.groupId ? `Підтвердження збереже зміни у справжній групі «${draftGroupName}».` : 'Підтвердження збереже справу у вашому справжньому органайзері.'}</p></div><label className="xai-acknowledgement"><input type="checkbox" checked={acknowledged} disabled={writing || dirty || offline || recurrenceIssues.length > 0 || !status?.writesAvailable} onChange={event => setAcknowledged(event.target.checked)} /><span>Я перевірив групу, дату й зміст змін</span></label><button className="xai-button xai-primary" disabled={!acknowledged || dirty || writing || offline || recurrenceIssues.length > 0 || (draft as any).requiresMaterialRights && !materialRightsAccepted || !status?.writesAvailable} onClick={() => void draftOperation('confirm')}>{writing ? <LoaderCircle size={17} className="xai-spin" /> : <Check size={17} />}Підтвердити й зберегти</button><button className="xai-text-button xai-danger" disabled={writing || offline || !status?.writesAvailable} onClick={() => void draftOperation('cancel')}>Скасувати чернетку</button></> : draft.status === 'unknown' || draft.status === 'committing' ? <div className="xai-info"><p>Результат запису ще перевіряється. Не створюйте цю зміну повторно. Відкрийте «Історія змін», щоб перевірити стан, або звірте записи на платформі.</p><button className="xai-text-button" onClick={() => setView('drafts')}>Перевірити чернетки<ChevronRight size={14} /></button></div> : <p className="xai-note">{draft.status === 'confirmed' ? 'Збереження підтверджене сервером.' : draft.status === 'cancelled' ? 'Чернетку скасовано. Запис у групі не змінювався.' : 'Дані змінилися або час підтвердження минув. Оновіть записи перед новою чернеткою.'}</p>}
              {receipt && <div className="xai-receipt"><Check size={20} /><div><strong>Збережено {dateLabel(receipt.savedAt)}</strong>{platformHref(receipt.path) && <a className="xai-link" href={platformHref(receipt.path)!}>Переглянути на платформі<ArrowUpRight size={14} /></a>}</div></div>}
            </section>}
          </section>}
          {view === 'drafts' && status?.available && <section className="xai-inline-history" aria-label="Історія змін"><button type="button" className="xai-text-button" onClick={() => setView('chat')}>Закрити історію<X size={14} /></button><div className="xai-results-heading"><div><h3>Історія змін</h3><p>Збережені у Xelay тільки для вашого акаунта</p></div><button className="xai-icon-button" disabled={historyBusy || writing || offline} onClick={() => void loadHistory()} aria-label="Оновити чернетки"><RefreshCw size={18} className={historyBusy ? 'xai-spin' : ''} /></button></div>{historyBusy ? <div className="xai-loading" role="status"><LoaderCircle size={20} className="xai-spin" />Перевіряємо стан чернеток…</div> : history.length ? <div className="xai-history">{history.map(entry => <button key={entry.draft.id} type="button" className="xai-history-item" disabled={writing} onClick={() => selectDraft(entry.draft, entry.receipt)}><FileText size={18} /><div><strong>{entry.draft.title}</strong><span>{statuses[entry.draft.status]} · {dateLabel(entry.draft.createdAt)}</span>{entry.draft.scope.groupId && <small>{catalog?.groups.find(group => group.id === entry.draft.scope.groupId)?.name || 'Навчальна група'}</small>}</div><ChevronRight size={17} /></button>)}</div> : <div className="xai-empty"><FileText size={28} /><h3>Чернеток поки немає</h3><p>Підготуйте зміну й перевірте її перед збереженням.</p></div>}</section>}
          {draftError && view !== 'data' && <p className="xai-error" role="alert">{draftError}</p>}
          {toolError && <p className="xai-error" role="alert">{toolError}</p>}
          <div ref={conversationEnd} />
          {toolBusy && !importOpen && <p className="xai-loading" role="status"><LoaderCircle size={17} className="xai-spin" />{uploadProgress > 0 ? `Перевіряємо файли: ${uploadProgress}%` : 'Опрацьовуємо запит…'}</p>}
        </>}
      </div>
      {catalog && <form className="xai-chat-composer" onSubmit={event => { event.preventDefault(); void sendChat() }}>
              {showTeacherMessage && <label className="xai-teacher-message">Повідомлення викладача<textarea rows={4} maxLength={10000} onPaste={event => boundedPaste(event, 10000)} value={teacherMessage} disabled={chatBusy} onChange={event => setTeacherMessage(event.target.value)} placeholder="Вставте повний текст. Умови, винятки й посилання залишаться в чернетці." /></label>}
              <div className="xai-chat-input"><label><span className="xai-sr-only">Повідомлення помічнику</span><textarea rows={3} maxLength={6000} onPaste={event => boundedPaste(event, 6000)} value={message} disabled={chatBusy || offline || !status.modelConnected} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={status.modelConnected ? 'Напишіть, що потрібно зробити…' : 'Чат ще не підключено'} /></label>{chatBusy ? <button type="button" className="xai-chat-send" aria-label="Зупинити відповідь" onClick={() => { chatRequest.current?.abort(); setChatBusy(false); setChatError('Відповідь зупинено. Запит автоматично не повторювався. Перевірте «Історія змін», перш ніж надсилати зміну знову.') }}><Square size={15} fill="currentColor" /></button> : <button type="submit" className="xai-chat-send" aria-label="Надіслати повідомлення" disabled={!message.trim() || offline || !status.modelConnected || writing || loading}><ArrowUp size={20} /></button>}</div>
              <div className="xai-composer-meta"><button type="button" aria-label={showTeacherMessage ? 'Сховати вкладений текст' : 'Додати повідомлення викладача'} title={showTeacherMessage ? 'Сховати вкладений текст' : 'Додати повідомлення викладача'} disabled={chatBusy || offline || !status.modelConnected} onClick={() => setShowTeacherMessage(value => !value)}><Paperclip size={15} /><span className="xai-sr-only">{showTeacherMessage ? 'Сховати вкладений текст' : 'Додати повідомлення викладача'}</span></button><small>Enter надіслати · Shift + Enter новий рядок</small></div>
              {status.modelConnected && <details className="xai-chat-privacy"><summary>Як обробляються повідомлення</summary><p>Лише після натискання «Надіслати» ваш запит, вставлений текст, назви предметів і до шести останніх ваших повідомлень передаються OpenAI. Відповіді помічника, списки студентів, оцінки й файли автоматично не надсилаються. <a href="/privacy-policy#assistant-model" target="_blank" rel="noopener noreferrer">Докладніше</a></p></details>}
            </form>}
      <footer className="xai-footer"><ShieldCheck size={14} /><span>Тільки ваш доступ. Зміни після підтвердження.</span></footer>
    </section></>}
  </div>
}
