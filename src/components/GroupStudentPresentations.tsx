import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CalendarDays, Download, Eye, FileText, Loader2, Pencil, Plus, Presentation, RefreshCw, Search, Trash2, UsersRound, X } from 'lucide-react'
import { formatMaterialDate } from '../lib/studyGroupMaterials'
import { formatMaterialFileSize, type MaterialAttachment } from '../lib/studyGroupMaterialFiles'
import { createLocalGroupPresentationRepository, emptyGroupPresentationDraft, GROUP_PRESENTATION_ACCEPT, groupPresentationError, LOCAL_GROUP_PRESENTATION_IDS, seedLocalGroupPresentations, startGroupPresentationDownload, supabaseGroupPresentationRepository, validateGroupPresentationDraft, validateGroupPresentationFile, type GroupPresentation, type GroupPresentationDraft, type GroupPresentationRepository, type LocalGroupPresentationRole } from '../lib/studyGroupPresentations'
import { TeachingButton, TeachingModal, teachingInput } from './teaching/TeachingUI'
import { groupAcademicDateInYear } from '../lib/studyGroupAcademicYears'

type Props = { groupId: string; currentUserId: string; repository?: GroupPresentationRepository; academicYearStart?: number | null; archiveReadOnly?: boolean }
const GroupPresentationPdfPreview = lazy(() => import('./GroupPresentationPdfPreview').then(module => ({ default: module.GroupPresentationPdfPreview })))
type Editor = { id: string; version: number; original: GroupPresentation | null; draft: GroupPresentationDraft; files: File[] }

export function GroupStudentPresentations(props: Props) {
  return <PresentationContents key={`${props.groupId}:${props.currentUserId}:${props.academicYearStart ?? 'all'}:${Boolean(props.archiveReadOnly)}`} {...props} />
}
function PresentationContents({ groupId, currentUserId, repository = supabaseGroupPresentationRepository, academicYearStart, archiveReadOnly = false }: Props) {
  const [items, setItems] = useState<GroupPresentation[]>([]), [subjects, setSubjects] = useState<string[]>([])
  const [canModerate, setCanModerate] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [query, setQuery] = useState(''), [subject, setSubject] = useState(''), [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState(''), [progress, setProgress] = useState<{ name: string; percent: number } | null>(null)
  const [deleting, setDeleting] = useState<GroupPresentation | null>(null)
  const [preview, setPreview] = useState<{ file: MaterialAttachment; url: string } | null>(null), [opening, setOpening] = useState('')
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null)
  const alive = useRef(false), generation = useRef(0), lock = useRef(false), uploadController = useRef<AbortController | null>(null)
  const scope = useRef({ repository, groupId, currentUserId }); scope.current = { repository, groupId, currentUserId }
  const current = useCallback(() => alive.current && scope.current.repository === repository && scope.current.groupId === groupId && scope.current.currentUserId === currentUserId, [repository, groupId, currentUserId])
  const fileInput = useRef<HTMLInputElement>(null), unique = useId()
  const load = useCallback(async () => {
    const sequence = ++generation.current
    setLoading(true)
    try { const next = await repository.list(groupId); if (current() && sequence === generation.current) { setItems(next.presentations); setSubjects(next.subjects); setCanModerate(next.can_moderate); setError('') } }
    catch (reason) { if (current() && sequence === generation.current) { setItems([]); setError(groupPresentationError(reason)) } }
    finally { if (current() && sequence === generation.current) setLoading(false) }
  }, [repository, groupId, current])
  useEffect(() => { alive.current = true; setItems([]); setSubjects([]); setEditor(null); setDeleting(null); setPreview(null); setDownloadReady(null); lock.current = false; setBusy(false); void load(); return () => { alive.current = false; ++generation.current; uploadController.current?.abort() } }, [load])
  const yearItems = items.filter(item => groupAcademicDateInYear(item.lesson_date, academicYearStart))
  const visibleSubjects = [...new Set([...(archiveReadOnly ? [] : subjects), ...yearItems.map(item => item.subject)])].sort((a, b) => a.localeCompare(b, 'uk-UA'))
  const shown = yearItems.filter(item => (!subject || item.subject === subject) && `${item.title} ${item.subject} ${item.author_name} ${item.description}`.toLocaleLowerCase('uk-UA').includes(query.trim().toLocaleLowerCase('uk-UA'))).sort((a, b) => b.lesson_date.localeCompare(a.lesson_date) || b.created_at.localeCompare(a.created_at))
  function openEditor(item: GroupPresentation | null = null) {
    if (archiveReadOnly) return
    setFormError(''); setProgress(null)
    setEditor({ id: item?.id || crypto.randomUUID(), version: item?.version || 0, original: item, draft: item ? { subject: item.subject, title: item.title, lesson_date: item.lesson_date, description: item.description, links: item.links, attachments: item.attachments } : emptyGroupPresentationDraft(subject), files: [] })
  }
  function patchDraft(patch: Partial<GroupPresentationDraft>) { setEditor(value => value ? { ...value, draft: { ...value.draft, ...patch } } : null) }
  function selectFiles(selected: FileList | null) {
    if (archiveReadOnly || !editor || !selected) return
    try {
      const added = [...editor.files, ...Array.from(selected)].filter((file, index, list) => list.findIndex(candidate => candidate.name === file.name && candidate.size === file.size && candidate.lastModified === file.lastModified) === index)
      if (added.length + editor.draft.attachments.length > 4) throw new Error('Додайте до 4 файлів до однієї презентації.')
      added.forEach(validateGroupPresentationFile)
      setEditor({ ...editor, files: added }); setFormError('')
    } catch (reason) { setFormError(groupPresentationError(reason)) }
  }
  async function save() {
    if (archiveReadOnly || !editor || lock.current) return
    lock.current = true; setBusy(true); setFormError('')
    const activeEditor = editor, added: MaterialAttachment[] = []
    const controller = new AbortController(); uploadController.current = controller
    let committed = false
    try {
      // Validate textual fields before starting an upload. Selected files count as the required resource.
      const validationFiles = activeEditor.draft.attachments.length ? activeEditor.draft.attachments : activeEditor.files.map((file, index) => { const format = validateGroupPresentationFile(file); return { path: `${groupId}/${currentUserId}/00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}.${format.extension}`, file_name: file.name, mime_type: format.mime, file_size: file.size } })
      validateGroupPresentationDraft({ ...activeEditor.draft, attachments: validationFiles })
      for (const file of activeEditor.files) {
        const attached = await repository.upload(groupId, currentUserId, file, percent => { if (current()) setProgress({ name: file.name, percent }) }, controller.signal)
        added.push(attached)
      }
      if (!current() || controller.signal.aborted) throw new DOMException('Завантаження скасовано.', 'AbortError')
      const result = await repository.save(groupId, activeEditor.id, activeEditor.version, { ...activeEditor.draft, attachments: [...activeEditor.draft.attachments, ...added] })
      committed = true
      const removed = activeEditor.original?.attachments.filter(file => !result.attachments.some(attached => attached.path === file.path)).map(file => file.path) || []
      void repository.removeFiles(removed).catch(() => {})
      if (current()) { setEditor(null); setProgress(null); await load() }
    } catch (reason) {
      if (!committed) void repository.removeFiles(added.map(file => file.path)).catch(() => {})
      if (current() && !(reason instanceof DOMException && reason.name === 'AbortError')) setFormError(groupPresentationError(reason))
    } finally { if (current()) { lock.current = false; setBusy(false); setProgress(null) }; if (uploadController.current === controller) uploadController.current = null }
  }
  async function remove() {
    if (archiveReadOnly || !deleting || lock.current) return
    lock.current = true; setBusy(true); setFormError('')
    try { await repository.delete(groupId, deleting.id, deleting.version); void repository.removeFiles(deleting.attachments.map(file => file.path)).catch(() => {}); if (current()) { setDeleting(null); await load() } }
    catch (reason) { if (current()) setFormError(groupPresentationError(reason)) }
    finally { if (current()) { lock.current = false; setBusy(false) } }
  }
  async function openFile(file: MaterialAttachment, download: boolean) {
    if (opening) return
    setOpening(file.path); setError('')
    try {
      const url = await repository.fileUrl(file, download)
      if (!current()) return
      if (download) { setDownloadReady({ url, name: file.file_name }); await startGroupPresentationDownload(url, file.file_name) }
      else setPreview({ file, url })
    } catch (reason) { if (current()) setError(groupPresentationError(reason)) }
    finally { if (current()) setOpening('') }
  }
  return <section className="space-y-5" aria-label="Презентації групи">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary"><UsersRound size={14} />Від своїх — своїм</p><h2 className="text-2xl font-semibold">Презентації після пар</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Підготували виступ? Поділіться презентацією тут, щоб одногрупники могли переглянути її та завантажити. Кожен керує власними файлами.</p></div><div className="flex gap-2"><TeachingButton disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16} />Оновити</TeachingButton>{!archiveReadOnly && <TeachingButton primary disabled={loading || busy || Boolean(error)} onClick={() => openEditor()}><Plus size={16} />Поділитися презентацією</TeachingButton>}</div></header>
    <p className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{archiveReadOnly ? 'Архів навчання: переглядайте й завантажуйте презентації своєї групи. Додавання та оновлення доступні в поточному навчальному році. ' : 'Це спільна поличка вашої групи. '}PDF та зображення відкриваються прямо у Xelay. До PowerPoint або Word додайте PDF-копію для онлайн-перегляду; оригінал можна завантажити.</p>
    <div className="flex flex-wrap gap-3"><label className="relative min-w-[13rem] flex-1"><Search size={17} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" /><input className={teachingInput} style={{ paddingLeft: 40 }} aria-label="Пошук презентацій" placeholder="Тема, предмет або автор…" value={query} onChange={event => setQuery(event.target.value)} /></label><select className={teachingInput} style={{ width: 'auto', minWidth: 176 }} aria-label="Предмет презентації" value={subject} onChange={event => setSubject(event.target.value)}><option value="">Усі предмети</option>{visibleSubjects.map(name => <option key={name}>{name}</option>)}</select></div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {downloadReady && !preview && <p role="status" className="text-xs text-muted-foreground">Файл готовий: <a className="font-medium text-primary underline underline-offset-4" href={downloadReady.url} download={downloadReady.name}>Завантажити {downloadReady.name}</a></p>}
    {loading && !items.length ? <p role="status" className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 size={18} className="animate-spin" />Завантажуємо презентації…</p> : !shown.length && !error ? <div className="rounded-2xl border border-dashed border-border p-10 text-center"><Presentation size={34} className="mx-auto text-primary/60" /><h3 className="mt-4 font-semibold">{query || subject ? 'За цими умовами презентацій немає' : archiveReadOnly ? 'Презентацій за цей період поки немає' : 'Перша презентація може бути вашою'}</h3><p className="mt-2 text-sm text-muted-foreground">{query || subject ? 'Спробуйте інший предмет або пошук.' : archiveReadOnly ? 'Оберіть інший навчальний рік або перегляньте всі роки групи.' : 'Додайте файл чи посилання, оберіть предмет і дату заняття.'}</p></div> : <div className="grid gap-4 lg:grid-cols-2">{shown.map(item => <article className="rounded-2xl border border-border bg-card p-5" key={item.id}><div className="flex items-start gap-3"><span className="rounded-xl bg-primary/10 p-3 text-primary"><Presentation size={24} /></span><div className="min-w-0 flex-1"><p className="text-xs font-medium text-primary">{item.subject}</p><h3 className="mt-1 break-words text-lg font-semibold">{item.title}</h3><p className="mt-2 text-xs text-muted-foreground">{item.author_name}{item.created_by === currentUserId && ' · Ви автор'}</p></div></div><p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays size={13} />{formatMaterialDate(item.lesson_date)}</p>{item.description && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.description}</p>}<div className="mt-4 space-y-2">{item.attachments.map(file => { const canPreview = file.mime_type === 'application/pdf' || file.mime_type.startsWith('image/'); return <div key={file.path} className="rounded-xl border border-border bg-background p-3"><p className="break-words text-sm font-medium">{file.file_name}</p><p className="mt-1 text-xs text-muted-foreground">{formatMaterialFileSize(file.file_size)}{!canPreview && ' · Для онлайн-перегляду додайте PDF-копію'}</p><div className="mt-3 flex flex-wrap gap-2">{canPreview && <TeachingButton disabled={Boolean(opening)} onClick={() => void openFile(file, false)}><Eye size={14} />Переглянути</TeachingButton>}<TeachingButton disabled={Boolean(opening)} onClick={() => void openFile(file, true)}>{opening === file.path ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}Завантажити</TeachingButton></div></div> })}{item.links.map(link => <a key={link.url} className="teaching-button max-w-full break-words text-primary" href={link.url} target="_blank" rel="noopener noreferrer">{link.label || 'Відкрити презентацію'}</a>)}</div>{!archiveReadOnly && (item.created_by === currentUserId || canModerate) && <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">{item.created_by === currentUserId && <TeachingButton disabled={busy} onClick={() => openEditor(item)}><Pencil size={14} />Оновити</TeachingButton>}<TeachingButton disabled={busy} onClick={() => { setFormError(''); setDeleting(item) }}><Trash2 size={14} />Видалити</TeachingButton></div>}</article>)}</div>}
    {!archiveReadOnly && editor && <TeachingModal title={editor.original ? 'Оновити свою презентацію' : 'Поділитися презентацією'} description="Після збереження її побачать учасники вашої навчальної групи." busy={busy} onClose={() => setEditor(null)}><form className="space-y-4" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={busy} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium">Предмет<input required minLength={2} maxLength={180} className={`${teachingInput} mt-2`} list={`${unique}-subjects`} value={editor.draft.subject} onChange={event => patchDraft({ subject: event.target.value })} placeholder="Оберіть або впишіть предмет" /><datalist id={`${unique}-subjects`}>{subjects.map(name => <option key={name} value={name} />)}</datalist></label><label className="block text-sm font-medium">Дата заняття<input required type="date" min="1900-01-01" max="2200-12-31" className={`${teachingInput} mt-2`} value={editor.draft.lesson_date} onChange={event => patchDraft({ lesson_date: event.target.value })} /></label></div><label className="block text-sm font-medium">Назва презентації<input name="group-presentation-title" required minLength={3} maxLength={180} className={`${teachingInput} mt-2`} value={editor.draft.title} onChange={event => patchDraft({ title: event.target.value })} placeholder="Наприклад, аналіз ринкової рівноваги" /></label><label className="block text-sm font-medium">Короткий опис <span className="font-normal text-muted-foreground">· необов’язково</span><textarea rows={3} maxLength={5000} className={`${teachingInput} mt-2 resize-y`} value={editor.draft.description} onChange={event => patchDraft({ description: event.target.value })} /></label><div className="space-y-3"><p className="text-sm font-medium">Файли презентації</p><p className="text-xs leading-relaxed text-muted-foreground">До 4 файлів по 50 МБ. Для перегляду в Xelay додайте PDF. Більшу презентацію можна завантажити в Google Drive та прикріпити посилання з доступом для одногрупників.</p>{editor.draft.attachments.map(file => <div key={file.path} className="flex items-center gap-2 rounded-xl border border-border p-3"><FileText size={16} /><span className="min-w-0 flex-1 break-words text-sm">{file.file_name}</span><button type="button" onClick={() => patchDraft({ attachments: editor.draft.attachments.filter(item => item.path !== file.path) })} aria-label={`Прибрати ${file.file_name}`}><X size={16} /></button></div>)}{editor.files.map((file, index) => <div key={`${file.name}:${index}`} className="flex items-center gap-2 rounded-xl border border-border p-3"><FileText size={16} /><span className="min-w-0 flex-1 break-words text-sm">{file.name} · {formatMaterialFileSize(file.size)}</span><button type="button" onClick={() => setEditor({ ...editor, files: editor.files.filter((_, position) => position !== index) })} aria-label={`Прибрати новий файл ${file.name}`}><X size={16} /></button></div>)}<input ref={fileInput} className="hidden" type="file" multiple accept={GROUP_PRESENTATION_ACCEPT} onChange={event => { selectFiles(event.currentTarget.files); event.currentTarget.value = '' }} /><TeachingButton disabled={editor.files.length + editor.draft.attachments.length >= 4} onClick={() => fileInput.current?.click()}><Plus size={14} />Додати файли</TeachingButton></div><div className="space-y-2"><p className="text-sm font-medium">Посилання</p>{editor.draft.links.map((link, index) => <div className="flex items-start gap-2" key={index}><div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2"><input className={teachingInput} aria-label={`Назва посилання ${index + 1}`} maxLength={120} value={link.label} placeholder="Назва · необов’язково" onChange={event => patchDraft({ links: editor.draft.links.map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} /><input className={teachingInput} aria-label={`Адреса посилання ${index + 1}`} type="url" maxLength={2048} value={link.url} placeholder="https://…" onChange={event => patchDraft({ links: editor.draft.links.map((item, position) => position === index ? { ...item, url: event.target.value } : item) })} /></div><button className="p-3" type="button" aria-label={`Прибрати посилання ${index + 1}`} onClick={() => patchDraft({ links: editor.draft.links.filter((_, position) => position !== index) })}><X size={16} /></button></div>)}<TeachingButton disabled={editor.draft.links.length >= 4} onClick={() => patchDraft({ links: [...editor.draft.links, { label: '', url: '' }] })}><Plus size={14} />Додати посилання</TeachingButton></div></fieldset>{progress && <div role="status" className="rounded-xl border border-border p-3"><p className="mb-2 break-words text-sm">{progress.name} · {progress.percent}%</p><progress className="h-2 w-full accent-primary" max={100} value={progress.percent} /></div>}{formError && <p role="alert" className="teaching-error">{formError}</p>}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setEditor(null)}>Скасувати</TeachingButton><TeachingButton primary type="submit" busy={busy}>{busy ? 'Зберігаємо…' : editor.original ? 'Зберегти оновлення' : 'Поділитися з групою'}</TeachingButton></div></form></TeachingModal>}
    {!archiveReadOnly && deleting && <TeachingModal title="Видалити презентацію?" description={deleting.title} busy={busy} onClose={() => setDeleting(null)}><p className="teaching-note">Презентація й вкладення більше не будуть доступні одногрупникам.</p>{formError && <p role="alert" className="teaching-error mt-3">{formError}</p>}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setDeleting(null)}>Залишити</TeachingButton><TeachingButton primary busy={busy} onClick={() => void remove()}>Видалити</TeachingButton></div></TeachingModal>}
    {preview && <TeachingModal title={preview.file.file_name} onClose={() => setPreview(null)}>{preview.file.mime_type === 'application/pdf' ? <Suspense fallback={<p role="status">Відкриваємо переглядач…</p>}><GroupPresentationPdfPreview url={preview.url} name={preview.file.file_name} /></Suspense> : <img src={preview.url} alt={preview.file.file_name} className="mx-auto max-h-[65dvh] max-w-full rounded-xl object-contain" />}{downloadReady?.name === preview.file.file_name && <p role="status" className="mt-3 text-xs text-muted-foreground">Файл готовий. <a className="font-medium text-primary underline underline-offset-4" href={downloadReady.url} download={downloadReady.name}>Завантажити файл ще раз</a></p>}<div className="teaching-form-actions"><TeachingButton onClick={() => setPreview(null)}>Закрити</TeachingButton><TeachingButton primary onClick={() => void openFile(preview.file, true)}><Download size={15} />Завантажити</TeachingButton></div></TeachingModal>}
  </section>
}

export function LocalGroupPresentationsPreview({ downloadTransport }: { downloadTransport?: (file: MaterialAttachment, blobURL: string) => Promise<string> } = {}) {
  const [role, setRole] = useState<LocalGroupPresentationRole>('author'), [revision, setRevision] = useState(0)
  const repositories = useMemo(() => {
    const create = (role: LocalGroupPresentationRole): GroupPresentationRepository => {
      const repository = createLocalGroupPresentationRepository(role)
      return !downloadTransport ? repository : { ...repository, async fileUrl(file, download = false) { const url = await repository.fileUrl(file, download); return download ? downloadTransport(file, url) : url } }
    }
    return { author: create('author'), classmate: create('classmate'), head: create('head'), teacher: create('teacher') }
  }, [downloadTransport])
  useEffect(() => { seedLocalGroupPresentations(); setRevision(value => value + 1) }, [])
  return <div className="space-y-5"><div className="flex flex-wrap gap-2" aria-label="Роль у прикладі презентацій">{([['author', 'Студент · автор'], ['classmate', 'Одногрупник'], ['head', 'Староста'], ['teacher', 'Тільки викладач']] as const).map(([value, label]) => <TeachingButton key={value} primary={role === value} onClick={() => setRole(value)}>{label}</TeachingButton>)}</div><p className="text-xs leading-relaxed text-muted-foreground">Вигадана група. Завантажте свій файл, змініть роль і перевірте перегляд. Файли прикладу залишаються тільки на цьому комп’ютері.</p><GroupStudentPresentations key={`${role}:${revision}`} groupId={LOCAL_GROUP_PRESENTATION_IDS.group} currentUserId={LOCAL_GROUP_PRESENTATION_IDS[role]} repository={repositories[role]} /></div>
}
