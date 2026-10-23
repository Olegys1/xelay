import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, CloudOff, FileText, GraduationCap, Link2, Loader2, MapPin, RefreshCw, ShieldCheck, Trash2, Wifi, WifiOff, X } from 'lucide-react'
import {
  OFFLINE_STUDY_CHANGED, OFFLINE_STUDY_DAYS, getOfflineOwner, listOfflineGroups, loadOfflineGroup,
  offlineStudyError, removeOfflineGroupSnapshot,
  type OfflineAssignment, type OfflineGroupSnapshot, type OfflineGroupSummary, type OfflineHomework, type OfflineLesson, type OfflineResourceLink,
} from '../lib/offlineStudy'

type OfflineStudyReaderProps = {
  ownerId?: string
  initialGroupId?: string
  onClose?: () => void
  onReconnect?: () => void
  /** Design-only fixture input. It is never written to account storage. */
  previewSnapshots?: OfflineGroupSnapshot[]
  previewOwnerName?: string
}
const DAY = 86_400_000
const types: Record<string, string> = { lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне', practice: 'Практичне', lab: 'Лабораторна', other: 'Заняття', makeup: 'Відпрацювання', replacement: 'Заміна', module: 'Модуль', final_assessment: 'Підсумкова робота', test: 'Контрольна робота' }
const actionClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'

function kyivToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value || '').join('-')
}
function plusDays(date: string, count: number): string { return new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10) }
function dateLabel(date: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }): string {
  return new Intl.DateTimeFormat('uk-UA', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
}
function timestampLabel(date: string): string {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date))
}
function summary(item: OfflineGroupSnapshot): OfflineGroupSummary {
  return { groupId: item.groupId, groupName: item.groupName, rangeStart: item.rangeStart, rangeEnd: item.rangeEnd, savedAt: item.savedAt, expiresAt: item.expiresAt, lessonCount: item.lessons.length, homeworkCount: item.homework.length, assignmentCount: item.assignments.length }
}

function SavedResources({ links = [], fileNames = [] }: { links?: OfflineResourceLink[]; fileNames?: string[] }) {
  if (!links.length && !fileNames.length) return null
  return <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
    {links.map((link, index) => <div key={`${index}:${link.label}`} className="flex items-start gap-2 text-sm text-muted-foreground"><Link2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{link.label || `Посилання ${index + 1}`} <span className="text-xs">· потрібен інтернет</span></span></div>)}
    {fileNames.map((name, index) => <div key={`${index}:${name}`} className="flex items-start gap-2 text-sm text-muted-foreground"><FileText size={15} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{name} <span className="text-xs">· файл не збережено офлайн</span></span></div>)}
    <p className="text-xs leading-relaxed text-muted-foreground">Збережено текст завдання. Файли, Google Drive та зовнішні посилання відкриваються на платформі після підключення.</p>
  </div>
}

function HomeworkCard({ item }: { item: OfflineHomework }) {
  return <article className="rounded-2xl border border-primary/15 bg-primary/5 p-4">
    <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary"><BookOpen size={14} aria-hidden="true" />ДЗ групи</p>
    {item.title && <h4 className="mb-2 break-words text-base font-semibold">{item.title}</h4>}
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{item.body || 'Текст завдання не додано. Перевірте прикріплені ресурси після підключення.'}</p>
    <SavedResources links={item.links} fileNames={item.fileNames} />
  </article>
}

function AssignmentCard({ item }: { item: OfflineAssignment }) {
  return <article className="rounded-2xl border border-sky-300/60 bg-sky-50 p-4 dark:border-sky-800/70 dark:bg-sky-950/25">
    <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300"><ShieldCheck size={14} aria-hidden="true" />Від викладача{item.teacherName ? ` · ${item.teacherName}` : ''}</p>
    <h4 className="break-words text-base font-semibold">{item.title}</h4>
    {!item.date && <p className="mt-1 text-xs text-muted-foreground">{item.subject} · без прив’язки до пари</p>}
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{item.body || 'Опис не додано.'}</p>
    {item.dueAt && <p className="mt-3 flex items-center gap-1.5 text-xs font-medium"><Clock3 size={13} aria-hidden="true" />Здати до {timestampLabel(item.dueAt)} · Київ</p>}
    <SavedResources links={item.links} fileNames={item.fileNames} />
  </article>
}

function LessonCard({ lesson, homework, assignments }: { lesson: OfflineLesson; homework: OfflineHomework[]; assignments: OfflineAssignment[] }) {
  return <article className="relative rounded-3xl border border-border bg-card p-4 sm:p-5">
    <header className="mb-3 flex items-start gap-3">
      <div className="w-14 shrink-0 rounded-xl bg-muted py-2 text-center"><p className="text-sm font-bold tabular-nums">{lesson.startsAt}</p><p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{lesson.endsAt}</p></div>
      <div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{types[lesson.lessonType] || lesson.lessonType}</p><h3 className="mt-1 break-words text-lg font-semibold leading-snug">{lesson.subject}</h3>
        {lesson.teacherName && <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"><GraduationCap size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{lesson.teacherName}</p>}
        {lesson.location && <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"><MapPin size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{lesson.location}</p>}
      </div>
    </header>
    {(homework.length > 0 || assignments.length > 0) ? <div className="space-y-3">{homework.map(item => <HomeworkCard key={item.id} item={item} />)}{assignments.map(item => <AssignmentCard key={item.id} item={item} />)}</div> : <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">У цій копії немає ДЗ до пари. Нові завдання можуть з’явитися після оновлення з інтернетом.</p>}
  </article>
}

/** Independent saved-data view: no auth provider, RPCs, writes, or submission controls. */
export function OfflineStudyReader({ ownerId, initialGroupId, onClose, onReconnect, previewSnapshots, previewOwnerName }: OfflineStudyReaderProps) {
  const [groups, setGroups] = useState<OfflineGroupSummary[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState(initialGroupId || '')
  const [snapshot, setSnapshot] = useState<OfflineGroupSnapshot | null>(null)
  const [selectedDate, setSelectedDate] = useState(kyivToday)
  const [name, setName] = useState(previewOwnerName || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(typeof navigator !== 'undefined' && navigator.onLine)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [photoOpen, setPhotoOpen] = useState(false)
  const loadVersion = useRef(0)

  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh) }
  }, [])

  useEffect(() => {
    let active = true
    const read = async () => {
      const version = ++loadVersion.current
      setLoading(true)
      setError('')
      try {
        const owner = previewSnapshots ? null : await getOfflineOwner()
        if (!active || version !== loadVersion.current) return
        if (!previewSnapshots && (!owner || (ownerId && owner.id !== ownerId))) {
          setGroups([]); setSnapshot(null); setName(''); setLoading(false); return
        }
        const list = previewSnapshots ? previewSnapshots.map(summary) : await listOfflineGroups(owner!.id)
        if (!active || version !== loadVersion.current) return
        const groupId = list.some(item => item.groupId === selectedGroupId) ? selectedGroupId : list[0]?.groupId || ''
        const item = previewSnapshots ? previewSnapshots.find(value => value.groupId === groupId) || null : groupId ? await loadOfflineGroup(owner!.id, groupId) : null
        // A logout/account change may have completed while a group read was pending.
        const finalOwner = previewSnapshots ? null : await getOfflineOwner()
        if (!active || version !== loadVersion.current) return
        if (!previewSnapshots && finalOwner?.sessionId !== owner?.sessionId) { setGroups([]); setSnapshot(null); setName(''); setLoading(false); return }
        setGroups(list); setSnapshot(item); setSelectedGroupId(groupId); setName(previewOwnerName || owner?.displayName || '')
        if (item) setSelectedDate(previous => previous >= item.rangeStart && previous <= item.rangeEnd ? previous : item.rangeStart)
      } catch (cause) {
        if (active && version === loadVersion.current) { setError(offlineStudyError(cause)); setGroups([]); setSnapshot(null) }
      } finally { if (active && version === loadVersion.current) setLoading(false) }
    }
    void read()
    const changed = () => { setSnapshot(null); void read() }
    window.addEventListener(OFFLINE_STUDY_CHANGED, changed)
    return () => { active = false; ++loadVersion.current; window.removeEventListener(OFFLINE_STUDY_CHANGED, changed) }
  }, [ownerId, selectedGroupId, previewSnapshots, previewOwnerName])

  const dates = useMemo(() => {
    if (!snapshot) return []
    const count = Math.min(OFFLINE_STUDY_DAYS, Math.round((Date.parse(`${snapshot.rangeEnd}T00:00:00Z`) - Date.parse(`${snapshot.rangeStart}T00:00:00Z`)) / DAY) + 1)
    return Array.from({ length: count }, (_, index) => plusDays(snapshot.rangeStart, index))
  }, [snapshot])
  const lessons = snapshot?.lessons.filter(item => item.date === selectedDate).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.subject.localeCompare(b.subject, 'uk')) || []
  const homework = snapshot?.homework.filter(item => item.date === selectedDate) || []
  const assignments = snapshot?.assignments.filter(item => item.date === selectedDate) || []
  const undatedAssignments = snapshot?.assignments.filter(item => !item.date) || []
  const matchedHomework = new Set(lessons.flatMap(lesson => homework.filter(item => item.scheduleItemId === lesson.id).map(item => item.id)))
  const matchedAssignments = new Set(lessons.flatMap(lesson => assignments.filter(item => item.scheduleItemId === lesson.id).map(item => item.id)))
  const separateHomework = homework.filter(item => !matchedHomework.has(item.id))
  const separateAssignments = assignments.filter(item => !matchedAssignments.has(item.id))
  const hasDayItems = lessons.length + homework.length + assignments.length > 0
  const dateIndex = dates.indexOf(selectedDate)

  const clearCurrent = async () => {
    if (previewSnapshots || !snapshot) return
    setClearing(true); setError('')
    try {
      const owner = await getOfflineOwner()
      if (!owner || (ownerId && owner.id !== ownerId)) throw new Error('OFFLINE_OWNER_CHANGED')
      await removeOfflineGroupSnapshot(owner.id, snapshot.groupId, owner.sessionId)
      setConfirmClear(false)
    } catch (cause) { setError(offlineStudyError(cause)) } finally { setClearing(false) }
  }

  return <main className="mx-auto w-full max-w-6xl px-4 py-6 text-foreground sm:px-6 sm:py-10" aria-label="Збережені розклад і ДЗ">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><CloudOff size={25} aria-hidden="true" /></div><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Xelay · завжди під рукою</p><h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Розклад і ДЗ офлайн</h1></div></div>
      <div className="flex items-center gap-2">{onReconnect && <button type="button" onClick={onReconnect} className={actionClass}><RefreshCw size={15} aria-hidden="true" /><span>{online ? 'На платформу' : 'Перевірити зв’язок'}</span></button>}{onClose && <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-border hover:bg-muted" aria-label="Закрити збережений розклад"><X size={18} /></button>}</div>
    </header>

    <section className="mb-6 rounded-3xl border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-700/50 dark:bg-amber-950/20 sm:p-5" aria-label="Стан збереженої копії">
      <p className="flex items-center gap-2 text-sm font-semibold">{online ? <Wifi size={17} className="text-amber-700 dark:text-amber-300" aria-hidden="true" /> : <WifiOff size={17} className="text-amber-700 dark:text-amber-300" aria-hidden="true" />}{previewSnapshots ? 'Локальний приклад · демонстраційні дані' : online ? 'Переглядаєте копію на цьому пристрої' : 'Без інтернету · збережене доступне'}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{snapshot ? <>Оновлено {timestampLabel(snapshot.savedAt)}. </> : ''}Це останні збережені дані. Нові ДЗ, перенесення пар і зміни дедлайнів з’являться після оновлення на платформі.</p>
      {name && <p className="mt-2 text-xs text-muted-foreground">Особиста копія: {name}. На спільному пристрої виходьте зі свого акаунта.</p>}
    </section>

    {error && <p role="alert" className="mb-5 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
    {loading ? <div role="status" className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground"><Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Відкриваємо збережене…</div> : !groups.length || !snapshot ? <section className="rounded-3xl border border-dashed border-border bg-card p-8 text-center sm:p-12"><div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><BookOpen size={28} aria-hidden="true" /></div><h2 className="mt-5 text-xl font-semibold">Ще немає збережених розкладу й ДЗ</h2><p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">Коли є інтернет, увійдіть у Xelay та відкрийте свою навчальну групу. Платформа збереже розклад і текст завдань на найближчі 14 днів. Копія доступна на цьому пристрої до 14 днів; вихід з акаунта її видаляє.</p>{onReconnect && <button type="button" onClick={onReconnect} className={`${actionClass} mt-6`}><RefreshCw size={15} aria-hidden="true" />Відкрити платформу</button>}</section> : <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="rounded-3xl border border-border bg-card p-4"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Збережені групи</h2><div className="space-y-2">{groups.map(group => <button type="button" key={group.groupId} onClick={() => { setSelectedGroupId(group.groupId); setConfirmClear(false); setPhotoOpen(false) }} aria-pressed={selectedGroupId === group.groupId} className={`flex w-full items-start gap-2 rounded-2xl border px-3 py-3 text-left ${selectedGroupId === group.groupId ? 'border-primary/25 bg-primary/5' : 'border-transparent hover:bg-muted'}`}><CalendarDays size={18} className={`mt-0.5 shrink-0 ${selectedGroupId === group.groupId ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{group.groupName}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{dateLabel(group.rangeStart, { day: 'numeric', month: 'short' })} – {dateLabel(group.rangeEnd, { day: 'numeric', month: 'short' })}</span></span>{selectedGroupId === group.groupId && <Check size={15} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />}</button>)}</div></section>
        <section className="rounded-3xl border border-border bg-muted/35 p-4"><p className="text-sm font-semibold">Що доступно офлайн</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Пари, аудиторії, імена викладачів і повний текст збережених ДЗ. Здача робіт, оцінки та файли потребують інтернету.</p><p className="mt-3 text-xs leading-relaxed text-muted-foreground">Копія дійсна до {timestampLabel(snapshot.expiresAt)}. Браузер може очистити її, якщо на пристрої бракуватиме місця.</p></section>
        {!previewSnapshots && <div className="px-1">{confirmClear ? <div className="rounded-2xl border border-border p-3"><p className="text-xs leading-relaxed">Прибрати копію «{snapshot.groupName}» з цього пристрою? Дані групи на платформі збережуться.</p><div className="mt-3 flex gap-2"><button type="button" onClick={clearCurrent} disabled={clearing} className="rounded-full bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground">{clearing ? 'Видаляємо…' : 'Прибрати'}</button><button type="button" onClick={() => setConfirmClear(false)} disabled={clearing} className="rounded-full border border-border px-3 py-2 text-xs">Залишити</button></div></div> : <button type="button" onClick={() => setConfirmClear(true)} className="flex min-h-10 items-center gap-2 text-xs text-muted-foreground hover:text-destructive"><Trash2 size={14} aria-hidden="true" />Прибрати копію групи</button>}</div>}
      </aside>
      <section className="min-w-0">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{snapshot.groupName}</h2><p className="mt-1 text-xs text-muted-foreground">{snapshot.lessons.length} пар · {snapshot.homework.length + snapshot.assignments.length} завдань у копії</p></div><span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground"><Check size={13} aria-hidden="true" />На пристрої</span></header>
        {snapshot.timetablePhoto && <section className="mb-5 overflow-hidden rounded-3xl border border-border bg-card"><button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold" onClick={() => setPhotoOpen(value => !value)} aria-expanded={photoOpen}>Фото розкладу<span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">{photoOpen ? 'Згорнути' : 'Показати'}<ChevronDown size={15} className={photoOpen ? 'rotate-180' : ''} aria-hidden="true" /></span></button>{(photoOpen || !snapshot.lessons.length) && <div className="border-t border-border bg-white p-2"><img src={snapshot.timetablePhoto.dataUrl} alt={`Збережене фото розкладу групи ${snapshot.groupName}`} className="h-auto w-full rounded-xl object-contain" /></div>}</section>}
        <nav aria-label="Дні збереженого розкладу" className="mb-5 flex gap-2 overflow-x-auto pb-2">{dates.map(date => { const itemCount = snapshot.lessons.filter(item => item.date === date).length + snapshot.homework.filter(item => item.date === date).length + snapshot.assignments.filter(item => item.date === date).length; return <button key={date} type="button" onClick={() => setSelectedDate(date)} aria-current={date === selectedDate ? 'date' : undefined} className={`flex min-h-20 w-[68px] shrink-0 flex-col items-center justify-center rounded-2xl border text-sm ${date === selectedDate ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted'}`}><span className={`text-[11px] ${date === selectedDate ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>{dateLabel(date, { weekday: 'short' })}</span><span className="mt-1 text-xl font-semibold tabular-nums">{date.slice(8)}</span><span className={`mt-1 h-1 w-1 rounded-full ${itemCount ? date === selectedDate ? 'bg-primary-foreground' : 'bg-primary' : 'bg-transparent'}`} /></button> })}</nav>
        <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-lg font-semibold capitalize">{dateLabel(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}{selectedDate === kyivToday() && <span className="ml-2 text-xs font-normal text-primary">Сьогодні</span>}</h3><div className="flex gap-1"><button type="button" aria-label="Попередній день" disabled={dateIndex <= 0} onClick={() => setSelectedDate(dates[dateIndex - 1])} className="flex h-9 w-9 items-center justify-center rounded-full border border-border disabled:opacity-35"><ChevronLeft size={17} /></button><button type="button" aria-label="Наступний день" disabled={dateIndex < 0 || dateIndex >= dates.length - 1} onClick={() => setSelectedDate(dates[dateIndex + 1])} className="flex h-9 w-9 items-center justify-center rounded-full border border-border disabled:opacity-35"><ChevronRight size={17} /></button></div></div>
        {!hasDayItems && <div className="rounded-3xl border border-dashed border-border px-5 py-9 text-center"><CalendarDays size={27} className="mx-auto text-muted-foreground" aria-hidden="true" /><p className="mt-3 text-sm font-medium">На цей день у копії немає пар і ДЗ</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{snapshot.timetablePhoto && !snapshot.lessons.length ? 'Перевірте фото розкладу вище. ' : ''}Зміни після останнього збереження тут ще не відображаються.</p></div>}
        <div className="space-y-4">{lessons.map((lesson, index) => <LessonCard key={`${lesson.date}:${lesson.id}:${index}`} lesson={lesson} homework={homework.filter(item => item.scheduleItemId === lesson.id)} assignments={assignments.filter(item => item.scheduleItemId === lesson.id)} />)}
          {separateHomework.map(item => <section key={`homework:${item.id}`} className="space-y-2"><h3 className="text-sm font-semibold">{item.subject}</h3><HomeworkCard item={item} /></section>)}
          {separateAssignments.map(item => <section key={`assignment:${item.id}`} className="space-y-2"><h3 className="text-sm font-semibold">{item.subject}</h3><AssignmentCard item={item} /></section>)}
        </div>
        {undatedAssignments.length > 0 && <section className="mt-7 space-y-3"><h3 className="text-base font-semibold">Інші завдання викладачів</h3><p className="text-xs text-muted-foreground">Збережені завдання без дати пари. Термін здачі зазначено в кожній картці.</p>{undatedAssignments.map(item => <AssignmentCard key={`undated:${item.id}`} item={item} />)}</section>}
      </section>
    </div>}
    <footer className="mt-9 border-t border-border pt-4 text-center text-xs leading-relaxed text-muted-foreground">Офлайн-копія доступна лише в цьому браузері на цьому пристрої. Вона не замінює актуальний розклад і не надсилає зміни на платформу.</footer>
  </main>
}
