import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { BookOpen, CalendarDays, Download, ExternalLink, FileText, FolderOpen, Link2, Loader2, Paperclip, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import { formatMaterialDate, loadStudyGroupMaterials, materialError, materialToday, normalizeStudyGroupMaterial, validateMaterialDraft, type MaterialDraft, type MaterialSubject, type StudyGroupMaterial } from '../lib/studyGroupMaterials'
import { cleanupMaterialFiles, formatMaterialFileSize, getMaterialFileUrl, materialFileName, MATERIAL_FILES_ACCEPT, MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_SIZE, MAX_MATERIAL_FILES_TOTAL_SIZE, MAX_MATERIAL_LINKS, removeMaterialFiles, uploadMaterialFiles, validateMaterialFiles, validateMaterialLinks, type MaterialAttachment, type MaterialLink } from '../lib/studyGroupMaterialFiles'

export type GroupMaterialsProps = { groupId: string; currentUserId: string; canEdit: boolean; onLicenseRequired?: () => void }
const inputClass = 'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50 sm:text-sm motion-reduce:transition-none'
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const iconButton = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40 motion-reduce:transition-none'
const emptyDraft = (subjectId = ''): MaterialDraft => ({ subject_id: subjectId, title: '', material_date: materialToday(), body: '', links: [], attachments: [] })

export function GroupMaterials(props: GroupMaterialsProps) {
  return <MaterialsWorkspace key={`${props.groupId}:${props.currentUserId}`} {...props} />
}

function MaterialsWorkspace({ groupId, currentUserId, canEdit, onLicenseRequired }: GroupMaterialsProps) {
  const { notify } = useToast()
  const id = useId()
  const [subjects, setSubjects] = useState<MaterialSubject[]>([])
  const [materials, setMaterials] = useState<StudyGroupMaterial[]>([])
  const [selectedSubject, setSelectedSubject] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [showSubjects, setShowSubjects] = useState(false)
  const [subjectId, setSubjectId] = useState<string | null>(null)
  const [subjectName, setSubjectName] = useState('')
  const [subjectError, setSubjectError] = useState('')
  const [editing, setEditing] = useState<StudyGroupMaterial | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [draft, setDraft] = useState<MaterialDraft>(() => emptyDraft())
  const [files, setFiles] = useState<File[]>([])
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const generation = useRef(0)
  const mutation = useRef(false)
  const latestCanEdit = useRef(canEdit)
  latestCanEdit.current = canEdit

  const reload = useCallback(async (silent = false) => {
    const sequence = ++generation.current
    if (!silent) setLoading(true)
    try {
      const data = await loadStudyGroupMaterials(groupId, () => alive.current && sequence === generation.current)
      if (!alive.current || sequence !== generation.current) return
      setSubjects(data.subjects); setMaterials(data.materials); setLoadError('')
      setSelectedSubject((selected) => selected && !data.subjects.some((subject) => subject.id === selected) ? '' : selected)
    } catch (reason) {
      if (alive.current && sequence === generation.current) setLoadError(materialError(reason))
    } finally {
      if (alive.current && sequence === generation.current) setLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    alive.current = true
    void reload()
    const refresh = () => { if (document.visibilityState === 'visible') void reload(true) }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 45_000)
    return () => { alive.current = false; ++generation.current; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer) }
  }, [reload])

  useEffect(() => {
    if (!canEdit) { setShowEditor(false); setShowSubjects(false); setSubjectId(null); setSubjectName('') }
  }, [canEdit])

  useEffect(() => {
    // Retry only server-issued removal receipts; a fresh upload awaiting its
    // save in another tab is never selected by this cleanup call.
    void cleanupMaterialFiles(groupId).catch((error) => console.warn('Material file cleanup retry deferred:', error))
  }, [groupId, currentUserId, canEdit])

  const names = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects])
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    materials.forEach((material) => result.set(material.subject_id, (result.get(material.subject_id) || 0) + 1))
    return result
  }, [materials])
  const displayed = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('uk-UA')
    return materials.filter((material) => (!selectedSubject || material.subject_id === selectedSubject) && (!needle || `${material.title} ${material.body} ${names.get(material.subject_id) || ''}`.toLocaleLowerCase('uk-UA').includes(needle))).sort((a, b) => {
      const order = a.material_date.localeCompare(b.material_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      return sort === 'newest' ? -order : order
    })
  }, [materials, selectedSubject, query, sort, names])

  const report = (reason: unknown, title: string, inline?: (message: string) => void) => {
    if (!alive.current) return
    const message = materialError(reason)
    inline?.(message)
    notify({ id: `group-materials:${groupId}`, title, description: message, tone: 'error' })
    const text = reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : ''
    if (text.includes('GROUP_LICENSE_REQUIRED')) onLicenseRequired?.()
  }
  const beginMutation = () => {
    if (mutation.current || !alive.current || !latestCanEdit.current) return false
    mutation.current = true; setBusy(true); return true
  }
  const finishMutation = () => { mutation.current = false; if (alive.current) setBusy(false) }
  const requireCurrentPermission = () => {
    // Rights may be revoked while a file is uploading. The RPC also checks the
    // current membership, delegated permission and server-side group entitlement.
    if (!alive.current || !latestCanEdit.current) throw new Error('Дозвіл на редагування змінився. Оновіть сторінку або зверніться до старости.')
  }

  const saveSubject = async () => {
    const name = subjectName.trim()
    if (name.length < 2 || name.length > 180) { report(new Error('Назва предмета має містити від 2 до 180 символів.'), 'Перевірте назву предмета', setSubjectError); return }
    if (!beginMutation()) return
    setSubjectError('')
    try {
      requireCurrentPermission()
      const result = await supabase.rpc('xelay_save_material_subject', { p_group_id: groupId, p_subject_id: subjectId, p_name: name })
      if (result.error) throw result.error
      if (!alive.current) return
      setSubjectName(''); setSubjectId(null)
      await reload(true)
      if (alive.current) notify({ id: `group-materials:${groupId}`, title: subjectId ? 'Назву предмета оновлено' : 'Предмет додано', tone: 'success' })
    } catch (reason) { report(reason, 'Предмет не збережено', setSubjectError) }
    finally { finishMutation() }
  }

  const deleteSubject = async (subject: MaterialSubject) => {
    if (mutation.current || !latestCanEdit.current || !window.confirm(`Видалити предмет «${subject.name}»? Це можливо лише коли в ньому немає тем.`) || !beginMutation()) return
    try {
      requireCurrentPermission()
      const result = await supabase.rpc('xelay_delete_material_subject', { p_group_id: groupId, p_subject_id: subject.id })
      if (result.error) throw result.error
      if (!alive.current) return
      if (subjectId === subject.id) { setSubjectId(null); setSubjectName('') }
      await reload(true)
      if (alive.current) notify({ id: `group-materials:${groupId}`, title: 'Предмет видалено', tone: 'success' })
    } catch (reason) { report(reason, 'Не вдалося видалити предмет', setSubjectError) }
    finally { finishMutation() }
  }

  const openEditor = (material: StudyGroupMaterial | null = null) => {
    if (!latestCanEdit.current || mutation.current) return
    setEditing(material)
    setDraft(material ? { subject_id: material.subject_id, title: material.title, material_date: material.material_date, body: material.body, links: material.links.map((link) => ({ ...link })), attachments: [...material.attachments] } : emptyDraft(selectedSubject || (subjects.length === 1 ? subjects[0].id : '')))
    setFiles([]); setFormError(''); setShowEditor(true)
  }

  const saveMaterial = async () => {
    if (mutation.current || !latestCanEdit.current) return
    let links: MaterialLink[]
    try { validateMaterialDraft(draft); validateMaterialFiles(files, draft.attachments); links = validateMaterialLinks(draft.links) }
    catch (reason) { report(reason, 'Перевірте матеріал', setFormError); return }
    if (!beginMutation()) return
    setFormError('')
    let uploaded: MaterialAttachment[] = []
    let committed = false
    try {
      requireCurrentPermission()
      if (files.length) uploaded = await uploadMaterialFiles(groupId, currentUserId, files)
      requireCurrentPermission()
      const result = await supabase.rpc('xelay_save_study_group_material', {
        p_group_id: groupId, p_material_id: editing?.id || null, p_subject_id: draft.subject_id, p_title: draft.title.trim(), p_material_date: draft.material_date, p_body: draft.body,
        p_links: links, p_attachments: [...draft.attachments, ...uploaded],
      })
      if (result.error) throw result.error
      committed = true
      if (!alive.current) return
      const saved = normalizeStudyGroupMaterial(result.data, groupId)
      if (saved) setMaterials((items) => [saved, ...items.filter((item) => item.id !== saved.id)])
      setShowEditor(false); setEditing(null); setFiles([])
      // The server supplies cleanup receipts only after references have been
      // removed. A moderator never deletes a foreign owner's attached file.
      void cleanupMaterialFiles(groupId).catch((error) => console.warn('Material file cleanup deferred:', error))
      await reload(true)
      if (alive.current) notify({ id: `group-materials:${groupId}`, title: editing ? 'Матеріал оновлено' : 'Матеріал додано', tone: 'success' })
    } catch (reason) {
      if (!committed && uploaded.length) void removeMaterialFiles(groupId, uploaded.map((file) => file.path)).catch((error) => console.warn('Unused material file cleanup deferred:', error))
      report(reason, committed ? 'Матеріал збережено, але список не оновився' : 'Матеріал не збережено', setFormError)
    } finally { finishMutation() }
  }

  const deleteMaterial = async (material: StudyGroupMaterial) => {
    if (mutation.current || !latestCanEdit.current || !window.confirm(`Видалити тему «${material.title}» та її вкладення?`) || !beginMutation()) return
    try {
      requireCurrentPermission()
      const result = await supabase.rpc('xelay_delete_study_group_material', { p_group_id: groupId, p_material_id: material.id })
      if (result.error) throw result.error
      if (!alive.current) return
      setMaterials((items) => items.filter((item) => item.id !== material.id))
      void cleanupMaterialFiles(groupId).catch((error) => console.warn('Deleted material file cleanup deferred:', error))
      await reload(true)
      if (alive.current) notify({ id: `group-materials:${groupId}`, title: 'Матеріал видалено', tone: 'success' })
    } catch (reason) { report(reason, 'Не вдалося видалити матеріал') }
    finally { finishMutation() }
  }

  const subjectFilter = (subject: MaterialSubject | null) => <button key={subject?.id || 'all'} type="button" aria-pressed={selectedSubject === (subject?.id || '')} onClick={() => setSelectedSubject(subject?.id || '')} className={`flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors motion-reduce:transition-none ${selectedSubject === (subject?.id || '') ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'}`}><BookOpen size={16} className="shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 break-words">{subject?.name || 'Усі предмети'}</span><span className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-xs tabular-nums">{subject ? counts.get(subject.id) || 0 : materials.length}</span></button>

  return <section className="min-w-0 space-y-5" aria-labelledby={`${id}-title`}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="text-xl font-semibold">Матеріали групи</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">Теми, презентації, конспекти та посилання — за предметами.</p></div><div className="flex items-center gap-2"><button type="button" onClick={() => void reload()} disabled={loading || busy} className={iconButton} aria-label="Оновити матеріали"><RefreshCw size={18} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" /></button>{canEdit && <button type="button" onClick={() => subjects.length ? openEditor() : setShowSubjects(true)} disabled={busy || loading || Boolean(loadError)} className={primaryButton}><Plus size={17} aria-hidden="true" />{subjects.length ? 'Додати тему' : 'Додати предмет'}</button>}</div></header>
    {!canEdit && <p className="rounded-xl bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">Додавати й редагувати матеріали можуть староста та заступники з відповідним дозволом. Учасникам доступний перегляд і завантаження файлів.</p>}
    {loadError && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{loadError}<button type="button" onClick={() => void reload()} className="ml-2 underline underline-offset-4">Повторити</button></div>}
    {loading && !materials.length && !subjects.length ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 size={19} className="animate-spin" aria-hidden="true" />Завантажуємо матеріали…</div> : <div className="grid min-w-0 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="min-w-0"><div className="rounded-2xl border border-border bg-background p-3"><div className="mb-2 flex items-center justify-between gap-2 px-1"><h3 className="text-sm font-semibold">Предмети</h3>{canEdit && <button type="button" onClick={() => { setShowSubjects((value) => !value); setSubjectError('') }} disabled={busy} className="rounded-full px-3 py-2 text-xs font-medium text-primary hover:bg-primary/5" aria-expanded={showSubjects} aria-controls={`${id}-subjects`}>Керувати</button>}</div><div className="hidden space-y-1 lg:block">{subjectFilter(null)}{subjects.map((subject) => subjectFilter(subject))}</div><label className="block lg:hidden"><span className="sr-only">Фільтр за предметом</span><select value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} className={inputClass}><option value="">Усі предмети · {materials.length}</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name} · {counts.get(subject.id) || 0}</option>)}</select></label></div>
      {showSubjects && canEdit && <div id={`${id}-subjects`} className="mt-3 space-y-3 rounded-2xl border border-border bg-background p-4"><h3 className="text-sm font-semibold">{subjectId ? 'Перейменувати предмет' : 'Новий предмет'}</h3><form onSubmit={(event) => { event.preventDefault(); void saveSubject() }} className="space-y-2"><label className="block"><span className="sr-only">Назва предмета</span><input autoFocus required minLength={2} maxLength={180} value={subjectName} onChange={(event) => setSubjectName(event.target.value)} disabled={busy} placeholder="Наприклад, економічна теорія" className={inputClass} /></label><div className="flex flex-wrap gap-2"><button type="submit" disabled={busy} className={primaryButton}>{busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{subjectId ? 'Зберегти' : 'Додати'}</button>{subjectId && <button type="button" onClick={() => { setSubjectId(null); setSubjectName(''); setSubjectError('') }} disabled={busy} className={button}>Скасувати</button>}</div>{subjectError && <p role="alert" className="text-xs text-destructive">{subjectError}</p>}</form>{subjects.length > 0 && <ul className="space-y-1 border-t border-border pt-2">{subjects.map((subject) => <li key={subject.id} className="flex min-w-0 items-center gap-1"><span className="min-w-0 flex-1 break-words text-xs">{subject.name}</span><button type="button" disabled={busy} onClick={() => { setSubjectId(subject.id); setSubjectName(subject.name); setSubjectError('') }} aria-label={`Перейменувати предмет ${subject.name}`} className={iconButton}><Pencil size={14} /></button><button type="button" disabled={busy || Boolean(counts.get(subject.id))} onClick={() => void deleteSubject(subject)} title={counts.get(subject.id) ? 'Спочатку перенесіть або видаліть теми предмета' : 'Видалити порожній предмет'} aria-label={`Видалити предмет ${subject.name}`} className={iconButton}><Trash2 size={14} /></button></li>)}</ul>}<p className="text-xs leading-relaxed text-muted-foreground">Предмет можна видалити лише без тем. Назву можна змінити в будь-який момент.</p></div>}
      </aside>
      <div className="min-w-0 space-y-4"><div className="flex flex-wrap gap-2"><label className="relative min-w-0 flex-1"><span className="sr-only">Пошук матеріалів</span><Search size={17} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Знайти тему, текст або предмет" className={`${inputClass} pl-10`} /></label><label className="shrink-0"><span className="sr-only">Порядок тем за датою</span><select value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'oldest')} className={`${inputClass} h-full`}><option value="newest">Спочатку нові</option><option value="oldest">Спочатку старі</option></select></label></div>
      {displayed.length ? <><p className="text-xs text-muted-foreground">Тем: {displayed.length}{selectedSubject && ` · ${names.get(selectedSubject) || ''}`}</p><div className="space-y-4">{displayed.map((material) => <MaterialCard key={`${groupId}:${material.id}`} material={material} subject={names.get(material.subject_id) || 'Предмет'} canEdit={canEdit} disabled={busy} onEdit={() => openEditor(material)} onDelete={() => void deleteMaterial(material)} />)}</div></> : !loadError && <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border px-5 py-10 text-center"><FolderOpen size={32} className="mb-3 text-primary/50" aria-hidden="true" /><h3 className="font-medium">{query || selectedSubject ? 'Матеріалів не знайдено' : 'Матеріали з’являться тут'}</h3><p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{query || selectedSubject ? 'Спробуйте інший предмет або пошуковий запит.' : canEdit ? 'Створіть предмет, додайте тему й зберіть її файли та посилання в одному місці.' : 'Староста або заступник може додати предмети, теми, файли та посилання для групи.'}</p>{canEdit && !query && !selectedSubject && <button type="button" disabled={busy} onClick={() => subjects.length ? openEditor() : setShowSubjects(true)} className={`${button} mt-5`}><Plus size={16} />{subjects.length ? 'Додати першу тему' : 'Створити перший предмет'}</button>}</div>}</div>
    </div>}
    {showEditor && canEdit && <MaterialDialog title={editing ? 'Редагувати матеріал' : 'Додати матеріал'} busy={busy} onClose={() => setShowEditor(false)}><form onSubmit={(event) => { event.preventDefault(); void saveMaterial() }} className="space-y-5"><fieldset disabled={busy} className="space-y-5"><div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]"><label className="block text-sm font-medium">Предмет <span className="text-destructive">*</span><select required value={draft.subject_id} onChange={(event) => setDraft((value) => ({ ...value, subject_id: event.target.value }))} className={`${inputClass} mt-2`}><option value="">Оберіть предмет</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label><label className="block text-sm font-medium">Дата теми <span className="text-destructive">*</span><input required type="date" min="1900-01-01" max="2200-12-31" value={draft.material_date} onChange={(event) => setDraft((value) => ({ ...value, material_date: event.target.value }))} className={`${inputClass} mt-2`} /></label></div><label className="block text-sm font-medium">Назва теми <span className="text-destructive">*</span><input required minLength={3} maxLength={240} value={draft.title} onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} placeholder="Наприклад, попит і пропозиція" className={`${inputClass} mt-2`} /></label><label className="block text-sm font-medium">Текст або опис <span className="font-normal text-muted-foreground">(необов’язково)</span><textarea rows={6} maxLength={50_000} value={draft.body} onChange={(event) => setDraft((value) => ({ ...value, body: event.target.value }))} placeholder="Конспект, пояснення, нотатки до теми…" className={`${inputClass} mt-2 resize-y`} /></label><MaterialFilePicker files={files} existing={draft.attachments} disabled={busy} onChange={setFiles} onRemoveExisting={(path) => setDraft((value) => ({ ...value, attachments: value.attachments.filter((file) => file.path !== path) }))} /><MaterialLinksEditor links={draft.links} disabled={busy} onChange={(links) => setDraft((value) => ({ ...value, links }))} /></fieldset>{formError && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{formError}</p>}<div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><button type="button" disabled={busy} onClick={() => setShowEditor(false)} className={button}>Скасувати</button><button type="submit" disabled={busy} className={primaryButton}>{busy && <Loader2 size={17} className="animate-spin" aria-hidden="true" />}{busy ? 'Зберігаємо…' : editing ? 'Зберегти зміни' : 'Додати матеріал'}</button></div></form></MaterialDialog>}
  </section>
}

function MaterialDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; container.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-2 py-3 backdrop-blur-sm sm:px-4 sm:py-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><div ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl outline-none" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) onClose()
    if (event.key !== 'Tab') return
    const items = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []).filter((item) => item.offsetParent !== null)
    const first = items[0]; const last = items[items.length - 1]
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === container.current)) { event.preventDefault(); first.focus() }
  }}><header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6"><h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2><button type="button" disabled={busy} onClick={onClose} className={iconButton} aria-label="Закрити редактор матеріалу"><X size={20} /></button></header><div className="overflow-y-auto p-4 sm:p-6">{children}</div></div></div>
}

function MaterialCard({ material, subject, canEdit, disabled, onEdit, onDelete }: { material: StudyGroupMaterial; subject: string; canEdit: boolean; disabled: boolean; onEdit: () => void; onDelete: () => void }) {
  return <article className="min-w-0 rounded-2xl border border-border bg-background p-4 sm:p-5"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="mb-2 text-xs font-medium text-primary [overflow-wrap:anywhere]">{subject}</p><h3 className="break-words text-base font-semibold [overflow-wrap:anywhere] sm:text-lg">{material.title}</h3><p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays size={13} aria-hidden="true" /><time dateTime={material.material_date}>{formatMaterialDate(material.material_date)}</time></p></div>{canEdit && <div className="flex shrink-0"><button type="button" disabled={disabled} onClick={onEdit} className={iconButton} aria-label={`Редагувати тему ${material.title}`}><Pencil size={16} /></button><button type="button" disabled={disabled} onClick={onDelete} className={iconButton} aria-label={`Видалити тему ${material.title}`}><Trash2 size={16} /></button></div>}</div>{material.body && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{material.body}</p>}{material.attachments.length > 0 && <ul aria-label="Файли до теми" className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2">{material.attachments.map((file) => <MaterialDownload key={file.path} attachment={file} />)}</ul>}{material.links.length > 0 && <ul aria-label="Посилання до теми" className="mt-4 flex flex-wrap gap-2">{material.links.map((link, index) => <li key={`${link.url}:${index}`} className="min-w-0 max-w-full"><a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-sm text-primary transition-colors hover:bg-primary/10 motion-reduce:transition-none"><ExternalLink size={15} className="shrink-0" aria-hidden="true" /><span className="min-w-0 break-words [overflow-wrap:anywhere]">{link.label || new URL(link.url).hostname}</span><span className="sr-only"> (відкриється в новій вкладці)</span></a></li>)}</ul>}</article>
}

function MaterialDownload({ attachment }: { attachment: MaterialAttachment }) {
  const { notify } = useToast()
  const [loading, setLoading] = useState(false)
  const active = useRef(true)
  const lock = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const download = async () => {
    if (lock.current) return
    lock.current = true; setLoading(true)
    try {
      const url = await getMaterialFileUrl(attachment)
      if (!active.current) return
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = materialFileName(attachment.file_name); anchor.rel = 'noopener noreferrer'
      document.body.append(anchor); anchor.click(); anchor.remove()
    } catch (reason) {
      if (active.current) notify({ id: `material-file:${attachment.path}`, title: 'Не вдалося завантажити файл', description: materialError(reason), tone: 'error' })
    } finally { lock.current = false; if (active.current) setLoading(false) }
  }
  return <li className="min-w-0"><button type="button" onClick={() => void download()} disabled={loading} aria-busy={loading} className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-muted/20 p-3 text-left transition-colors hover:bg-muted disabled:opacity-60 motion-reduce:transition-none"><FileText size={20} className="shrink-0 text-primary" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">{materialFileName(attachment.file_name)}</span><span className="mt-1 block text-xs text-muted-foreground">{formatMaterialFileSize(attachment.file_size)}</span></span>{loading ? <Loader2 size={16} className="shrink-0 animate-spin" aria-hidden="true" /> : <Download size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}</button></li>
}

function MaterialFilePicker({ files, existing, disabled, onChange, onRemoveExisting }: { files: File[]; existing: MaterialAttachment[]; disabled: boolean; onChange: (files: File[]) => void; onRemoveExisting: (path: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const [error, setError] = useState('')
  const select = (event: ChangeEvent<HTMLInputElement>) => {
    const next = [...files]
    for (const file of Array.from(event.currentTarget.files || [])) if (!next.some((existingFile) => existingFile.name === file.name && existingFile.size === file.size && existingFile.lastModified === file.lastModified)) next.push(file)
    event.currentTarget.value = ''
    try { validateMaterialFiles(next, existing); setError(''); onChange(next) }
    catch (reason) { setError(materialError(reason)) }
  }
  return <div className="min-w-0 space-y-2"><p id={`${id}-label`} className="text-sm font-medium">Файли <span className="font-normal text-muted-foreground">(необов’язково)</span></p><p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">Презентації, PDF, документи, таблиці, архіви, фото, аудіо та відео. До {MAX_MATERIAL_FILES} файлів, кожен до {formatMaterialFileSize(MAX_MATERIAL_FILE_SIZE)}, разом до {formatMaterialFileSize(MAX_MATERIAL_FILES_TOTAL_SIZE)}.</p><input ref={input} type="file" multiple accept={MATERIAL_FILES_ACCEPT} disabled={disabled} onChange={select} className="hidden" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} />{existing.length + files.length > 0 && <ul className="space-y-2">{existing.map((file) => <li key={file.path} className="flex min-w-0 items-center gap-2 rounded-xl border border-border px-3 py-2"><FileText size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate text-sm" title={file.file_name}>{materialFileName(file.file_name)}</span><span className="text-xs text-muted-foreground">{formatMaterialFileSize(file.file_size)}</span></span><button type="button" disabled={disabled} onClick={() => { setError(''); onRemoveExisting(file.path) }} className={iconButton} aria-label={`Прибрати вкладення ${file.file_name}`}><X size={16} /></button></li>)}{files.map((file, index) => <li key={`${file.name}:${file.lastModified}:${index}`} className="flex min-w-0 items-center gap-2 rounded-xl border border-border px-3 py-2"><FileText size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate text-sm" title={file.name}>{materialFileName(file.name)}</span><span className="text-xs text-muted-foreground">{formatMaterialFileSize(file.size)} · Новий файл</span></span><button type="button" disabled={disabled} onClick={() => { setError(''); onChange(files.filter((_, item) => item !== index)) }} className={iconButton} aria-label={`Прибрати новий файл ${file.name}`}><X size={16} /></button></li>)}</ul>}<button type="button" onClick={() => input.current?.click()} disabled={disabled || existing.length + files.length >= MAX_MATERIAL_FILES} className={button} aria-describedby={`${id}-hint`}><Paperclip size={16} aria-hidden="true" />Додати файли{existing.length + files.length > 0 ? ` · ${existing.length + files.length}/${MAX_MATERIAL_FILES}` : ''}</button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
}

function MaterialLinksEditor({ links, disabled, onChange }: { links: MaterialLink[]; disabled: boolean; onChange: (links: MaterialLink[]) => void }) {
  const update = (index: number, key: keyof MaterialLink, value: string) => onChange(links.map((link, item) => index === item ? { ...link, [key]: value } : link))
  return <div className="min-w-0 space-y-2"><p className="text-sm font-medium">Посилання <span className="font-normal text-muted-foreground">(необов’язково)</span></p><p className="text-xs text-muted-foreground">Відео, онлайн-документи та інші ресурси. До {MAX_MATERIAL_LINKS} посилань; назву можна залишити порожньою.</p>{links.map((link, index) => <div key={index} className="flex min-w-0 items-start gap-2 rounded-xl border border-border p-3"><Link2 size={16} className="mt-3 hidden shrink-0 text-muted-foreground sm:block" aria-hidden="true" /><div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2"><label className="min-w-0"><span className="sr-only">Назва посилання {index + 1}</span><input maxLength={120} value={link.label} onChange={(event) => update(index, 'label', event.target.value)} disabled={disabled} placeholder="Наприклад, відеолекція" className={inputClass} /></label><label className="min-w-0"><span className="sr-only">Адреса посилання {index + 1}</span><input type="url" maxLength={2048} value={link.url} onChange={(event) => update(index, 'url', event.target.value)} disabled={disabled} placeholder="https://…" className={inputClass} /></label></div><button type="button" disabled={disabled} onClick={() => onChange(links.filter((_, item) => item !== index))} className={iconButton} aria-label={`Прибрати посилання ${index + 1}`}><X size={16} /></button></div>)}<button type="button" disabled={disabled || links.length >= MAX_MATERIAL_LINKS} onClick={() => onChange([...links, { label: '', url: '' }])} className={button}><Plus size={16} aria-hidden="true" />Додати посилання</button></div>
}
