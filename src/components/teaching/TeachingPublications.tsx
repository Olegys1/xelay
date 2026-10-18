import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, Download, ExternalLink, FileText, Info, Loader2, Pencil, Plus, Send, Trash2, UsersRound, X } from 'lucide-react'
import { teachingDate, teachingError, kyivDeadline, localDeadline, TEACHING_FILE_ACCEPT, validateTeachingFile, validateTeachingPublicationLinks, type TeachingFile, type TeachingPublication, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { getResourceLinkTitles, MAX_RESOURCE_LINK_LABEL_LENGTH } from '../../lib/resourceLinkLabels'
import { clearTeachingPublicationDraft, readTeachingPublicationDraft, teachingPublicationDraftKey, writeTeachingPublicationDraft, type TeachingPublicationDraftFields } from '../../lib/teachingPublicationDraft'
import { teachingGroupDirectoryLabel } from '../../lib/teachingGroupDirectory'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { TeachingSubmissionReview } from './TeachingSubmissionReview'

export function TeachingResources({ publication, repository }: { publication: TeachingPublication; repository: TeachingRepository }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const lock = useRef(false)
  const linkTitles = getResourceLinkTitles(publication.links, publication.link_labels)
  async function download(file: TeachingFile) {
    if (lock.current) return
    lock.current = true; setBusy(file.storage_path); setError('')
    try {
      const url = await repository.fileUrl(file)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.download = file.name; anchor.click()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy('') }
  }
  return <>{(publication.links.length > 0 || publication.attachments.length > 0) && <div className="mt-4 flex flex-wrap gap-2">{publication.links.map((url, index) => {
    let valid = false
    try { const parsed = new URL(url); valid = ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password } catch { /* Unsupported links do not become clickable. */ }
    return valid ? <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="teaching-resource"><ExternalLink size={14} className="shrink-0" /><span className="min-w-0 break-words">{linkTitles[index] || `Посилання ${index + 1}`}</span></a> : null
  })}{publication.attachments.map(file => <button key={file.storage_path} type="button" className="teaching-resource" disabled={Boolean(busy)} onClick={() => void download(file)}><Download size={14} className="shrink-0" /><span className="truncate">{busy === file.storage_path ? 'Відкриваємо…' : file.name}</span></button>)}</div>}{error && <p role="alert" className="teaching-error mt-3">{error}</p>}</>
}

type PublicationProps = { kind: 'assignment' | 'material'; snapshot: TeachingSnapshot; repository: TeachingRepository; userId: string; onRefresh: () => Promise<void>; readonly?: boolean; groupId?: string }
export function TeachingPublications({ kind, snapshot, repository, userId, onRefresh, readonly = false, groupId }: PublicationProps) {
  const [editing, setEditing] = useState<TeachingPublication | 'new' | null>(null)
  const [copying, setCopying] = useState<TeachingPublication | null>(null)
  const [reviewing, setReviewing] = useState<TeachingPublication | null>(null)
  const [message, setMessage] = useState('')
  const canEdit = !readonly && !snapshot.course.archived_at && snapshot.course.permissions.includes(kind === 'assignment' ? 'assignments' : 'materials')
  const canReview = !readonly && kind === 'assignment' && (snapshot.course.permissions.includes('assignments') || snapshot.course.permissions.includes('grades'))
  const currentGroup = snapshot.groups.find(group => group.group_id === groupId && group.status === 'accepted')
  const otherGroups = snapshot.groups.filter(group => group.status === 'accepted' && group.group_id !== groupId)
  const items = (kind === 'assignment' ? snapshot.assignments : snapshot.materials).filter(item => (!readonly || item.status === 'published') && (!groupId || item.targets.some(target => target.group_id === groupId) || canEdit && item.status === 'draft' && !item.targets.length))
  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{kind === 'assignment' ? 'Завдання групи' : 'Матеріали групи'}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{kind === 'assignment' ? 'Додайте завдання для цієї групи. Здані роботи відкриваються під кожним завданням.' : 'Презентації, конспекти та посилання для цієї групи.'}</p></div>{canEdit && currentGroup && <TeachingButton primary onClick={() => { setMessage(''); setEditing('new') }}><Plus size={16} />{kind === 'assignment' ? 'Додати завдання' : 'Додати матеріал'}</TeachingButton>}</div>
    {message && <p role="status" className="teaching-note mb-4">{message}</p>}
    {!items.length ? <div className="teaching-card"><TeachingEmpty icon={<FileText size={24} />} title={kind === 'assignment' ? 'Для цієї групи ще немає завдань' : 'Матеріалів поки немає'} description={canEdit ? kind === 'assignment' ? 'Напишіть назву й умову. Термін, файли та оцінювання можна додати за потреби.' : 'Додайте файл, посилання або короткий конспект.' : 'Тут з’являться публікації вашого викладача.'}>{canEdit && currentGroup && <TeachingButton primary onClick={() => setEditing('new')}><Plus size={15} />{kind === 'assignment' ? 'Створити перше завдання' : 'Додати матеріал'}</TeachingButton>}</TeachingEmpty></div> : <div className="teaching-list">{items.map(item => <article key={item.id} className="teaching-card">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><span className={`teaching-badge ${item.status === 'published' ? 'teaching-badge-blue' : ''}`}>{item.status === 'published' ? 'Опубліковано' : 'Чернетка'}</span>{!item.targets.length && <span className="teaching-badge">Ще не додано до групи</span>}{kind === 'assignment' && item.max_points != null && <span className="teaching-badge">До {item.max_points} балів</span>}{item.targets.length > 1 && <span className="teaching-badge"><UsersRound size={12} />Спільна публікація</span>}</div><h3 className="mt-3 break-words text-lg font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted-foreground">{item.author_name}{kind === 'assignment' ? ` · ${teachingDate(item.targets.find(target => target.group_id === groupId)?.due_at, true)}` : item.published_at ? ` · ${teachingDate(item.published_at)}` : ''}</p></div></div>
      {item.body && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>}
      <TeachingResources publication={item} repository={repository} />
      {(canEdit || canReview) && <div className="teaching-publication-actions mt-5 border-t border-border pt-4">
        {canReview && groupId && item.targets.some(target => target.group_id === groupId) && <TeachingButton onClick={() => setReviewing(item)}><FileText size={15} />Здані роботи</TeachingButton>}
        {canEdit && <TeachingButton onClick={() => { setMessage(''); setEditing(item) }}><Pencil size={15} />{!item.targets.length ? 'Додати до цієї групи' : 'Редагувати'}{kind === 'material' && item.targets.length > 1 ? ' спільний матеріал' : ''}</TeachingButton>}
        {canEdit && kind === 'assignment' && item.targets.length > 0 && otherGroups.length > 0 && <TeachingButton onClick={() => { setMessage(''); setCopying(item) }}><Copy size={15} />Копія в іншу групу</TeachingButton>}
      </div>}
    </article>)}</div>}
    {editing && <PublicationEditor key={editing === 'new' ? 'new' : editing.id} kind={kind} initial={editing === 'new' ? null : editing} groupId={groupId} snapshot={snapshot} repository={repository} userId={userId} onClose={() => setEditing(null)} onRefresh={onRefresh} />}
    {copying && <AssignmentCopyEditor assignment={copying} snapshot={snapshot} repository={repository} currentGroupId={groupId} onRefresh={onRefresh} onClose={() => setCopying(null)} onCopied={name => setMessage(`Окрему чернетку створено для групи «${name}». Відкрийте цю групу, перевірте завдання та опублікуйте його.`)} />}
    {reviewing && groupId && <TeachingModal title={`${reviewing.title} · Здані роботи`} description={currentGroup?.group_name} onClose={() => setReviewing(null)}><TeachingSubmissionReview repository={repository} snapshot={snapshot} groupId={groupId} assignment={reviewing} userId={userId} onRefresh={onRefresh} /></TeachingModal>}
  </>
}

function PublicationEditor({ kind, initial, groupId, snapshot, repository, userId, onClose, onRefresh }: { kind: 'assignment' | 'material'; initial: TeachingPublication | null; groupId?: string; snapshot: TeachingSnapshot; repository: TeachingRepository; userId: string; onClose: () => void; onRefresh: () => Promise<void> }) {
  const sharedAssignment = kind === 'assignment' && Boolean(initial && initial.targets.length > 1)
  const defaults: TeachingPublicationDraftFields = { selectedGroup: groupId || initial?.targets[0]?.group_id || '', title: initial?.title || '', body: initial?.body || '',
    links: initial?.links.length ? initial.links : [''], linkTitles: getResourceLinkTitles(initial?.links.length ? initial.links : [''], initial?.link_labels), attachments: initial?.attachments || [],
    deadline: localDeadline(initial?.targets.find(target => target.group_id === (groupId || initial?.targets[0]?.group_id))?.due_at), assessed: initial?.max_points != null, maxPoints: String(initial?.max_points ?? 10), category: initial?.category || '' }
  const draftKey = teachingPublicationDraftKey(userId, snapshot.course.id, kind, initial?.id, groupId)
  const [recoveredDraft] = useState(() => readTeachingPublicationDraft(draftKey, initial?.version || 0))
  const restored = recoveredDraft?.fields || defaults
  const [id] = useState(() => sharedAssignment ? recoveredDraft?.editor_id || crypto.randomUUID() : initial?.id || recoveredDraft?.editor_id || crypto.randomUUID())
  const [selectedGroup, setSelectedGroup] = useState(restored.selectedGroup)
  const [title, setTitle] = useState(restored.title), [body, setBody] = useState(restored.body)
  const [links, setLinks] = useState(restored.links), [linkTitles, setLinkTitles] = useState(restored.linkTitles)
  const [attachments, setAttachments] = useState<TeachingFile[]>(restored.attachments), [files, setFiles] = useState<File[]>([])
  const [deadline, setDeadline] = useState(restored.deadline), [assessed, setAssessed] = useState(restored.assessed)
  const [maxPoints, setMaxPoints] = useState(restored.maxPoints), [category, setCategory] = useState(restored.category)
  const [missingFileNames, setMissingFileNames] = useState(recoveredDraft?.pending_file_names || [])
  const [draftStorageFailed, setDraftStorageFailed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState(''), [committed, setCommitted] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const discardNotice = useRef<HTMLDivElement>(null)
  const lock = useRef(false)
  const groups = snapshot.groups.filter(group => group.status === 'accepted')
  const currentGroup = groups.find(group => group.group_id === selectedGroup)
  const canGrade = snapshot.course.permissions.includes('grades')
  const preservedOtherMaterialTargets = kind === 'material' ? initial?.targets.filter(target => target.group_id !== selectedGroup) || [] : []
  const fields = { selectedGroup, title, body, links, linkTitles, attachments, deadline, assessed, maxPoints, category }
  const fingerprint = JSON.stringify(fields)
  const initialFingerprint = useRef(JSON.stringify(defaults))
  const dirty = !committed && (fingerprint !== initialFingerprint.current || files.length > 0 || missingFileNames.length > 0)
  useEffect(() => {
    if (committed || !dirty) { clearTeachingPublicationDraft(draftKey); return }
    setDraftStorageFailed(!writeTeachingPublicationDraft(draftKey, { version: 1, source_version: initial?.version || 0, editor_id: id, fields,
      pending_file_names: [...missingFileNames, ...files.map(file => file.name)].slice(0, 10) }))
  }, [draftKey, fingerprint, files, missingFileNames, dirty, committed, id, initial?.version])
  useEffect(() => {
    if (!dirty) return
    function warnBeforeLeaving(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [dirty])
  useEffect(() => { if (confirmDiscard) discardNotice.current?.focus() }, [confirmDiscard])
  function requestClose() {
    if (lock.current) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }
  function discardAndClose() { if (!lock.current) { clearTeachingPublicationDraft(draftKey); onClose() } }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || committed) return
    const status = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-intent') === 'published' ? 'published' : 'draft'
    lock.current = true; setBusy(true); setError('')
    try {
      if (!title.trim() || !currentGroup) throw new Error('Вкажіть назву та підтверджену групу.')
      if (missingFileNames.length) throw new Error('Повторно додайте незавантажені файли або натисніть «Продовжити без цих файлів».')
      const normalized = validateTeachingPublicationLinks(links, linkTitles)
      if (kind === 'assignment' && assessed && (!Number.isFinite(Number(maxPoints)) || Number(maxPoints) <= 0 || Number(maxPoints) > 10000 || Math.round(Number(maxPoints) * 100) / 100 !== Number(maxPoints))) throw new Error('Максимум — від 0,01 до 10 000 балів, до двох знаків після коми.')
      let uploaded = [...attachments]
      for (let index = 0; index < files.length; index++) {
        setProgress(`Завантаження файлу ${index + 1} з ${files.length}…`)
        uploaded = [...uploaded, await repository.upload(snapshot.course.id, userId, files[index])]
        setAttachments(uploaded); setFiles(current => current.filter(file => file !== files[index]))
      }
      setProgress(kind === 'assignment' ? 'Збереження завдання…' : 'Збереження матеріалу…')
      const payload = { course_id: snapshot.course.id, id, version: sharedAssignment ? 0 : initial?.version || 0, title: title.trim(), body: body.trim(), ...normalized, attachments: uploaded, targets: [...preservedOtherMaterialTargets, { group_id: selectedGroup, due_at: kind === 'assignment' ? kyivDeadline(deadline) : null }], status, material_date: initial?.material_date || null,
        ...(kind === 'assignment' ? { max_points: assessed ? Number(maxPoints) : null, category: assessed ? category : '', ...(sharedAssignment ? { source_item_id: initial!.id, source_version: initial!.version } : {}) } : {}),
      }
      if (kind === 'assignment') await repository.classroomMutate('save_group_assignment', payload)
      else await repository.mutate('save_material', payload)
      clearTeachingPublicationDraft(draftKey); setCommitted(true); await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false); setProgress('') }
  }
  async function remove() {
    if (!initial || lock.current || committed) return
    lock.current = true; setBusy(true); setError(''); setProgress('Видалення…')
    try {
      if (kind === 'assignment') await repository.classroomMutate('delete_group_assignment', { id: initial.id, version: initial.version, group_id: selectedGroup })
      else await repository.mutate('delete_material', { id: initial.id, version: initial.version })
      clearTeachingPublicationDraft(draftKey); setCommitted(true); await onRefresh(); onClose()
    }
    catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false); setProgress('') }
  }
  return <TeachingModal title={`${initial ? 'Редагувати' : 'Додати'} ${kind === 'assignment' ? 'завдання' : 'матеріал'}`} onClose={requestClose} busy={busy} description={currentGroup ? `${teachingGroupDirectoryLabel({ ...currentGroup, id: currentGroup.group_id })} · ${snapshot.course.title}` : snapshot.course.title}>
    {confirmDiscard && <div ref={discardNotice} tabIndex={-1} role="alert" className="mb-5 space-y-3 rounded-xl border border-border bg-background p-4"><p className="text-sm font-semibold">Зміни ще не збережено</p><p className="text-sm">Залишитися в редакторі чи закрити його й втратити незбережені зміни?</p><div className="flex flex-wrap gap-2"><TeachingButton primary disabled={busy} onClick={() => setConfirmDiscard(false)}>Продовжити редагування</TeachingButton><TeachingButton disabled={busy} onClick={discardAndClose}>Закрити без збереження</TeachingButton></div></div>}
    <form onSubmit={event => void save(event)} className="teaching-form">
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {recoveredDraft && !committed && <p role="status" className="teaching-note">Відновлено незбережені зміни з цієї вкладки. Перевірте їх і збережіть.</p>}
      {missingFileNames.length > 0 && !committed && <div role="status" className="teaching-note"><p>Повторно додайте файли, які ще не були завантажені: {missingFileNames.join(', ')}.</p><TeachingButton disabled={busy} onClick={() => setMissingFileNames([])}>Продовжити без цих файлів</TeachingButton></div>}
      {draftStorageFailed && !committed && <p role="status" className="teaching-error">Браузер не дозволяє відновлення чернетки після переходу. Збережіть зміни перед виходом зі сторінки.</p>}
      {committed ? <p role="status" className="teaching-note">Зміни збережено. Закрийте вікно й оновіть групу, якщо публікація ще не з’явилася.</p> : <>
        {sharedAssignment && <div className="teaching-shared-notice"><Info size={16} /><p>Зараз це завдання спільне для кількох груп. Після збереження ця група матиме окреме завдання; її здані роботи та бали збережуться. Для інших груп попереднє завдання залишиться.</p></div>}
        {initial && !initial.targets.length && <p className="teaching-note">Цю чернетку ще не додано до групи. Після збереження вона буде додана до групи «{currentGroup?.group_name || 'обраної групи'}». Перевірте термін здачі перед публікацією.</p>}
        {kind === 'material' && preservedOtherMaterialTargets.length > 0 && <div className="teaching-shared-notice"><Info size={16} /><p>Цей матеріал спільний для {initial!.targets.length} груп. Зміни будуть видимі всім цим групам.</p></div>}
        {!groupId && <TeachingField label="Група"><select name="publication-group" className={teachingInput} value={selectedGroup} required disabled={busy || Boolean(initial?.targets.length)} onChange={event => setSelectedGroup(event.target.value)}><option value="">Оберіть групу</option>{groups.map(group => <option key={group.group_id} value={group.group_id}>{teachingGroupDirectoryLabel({ ...group, id: group.group_id })}</option>)}</select></TeachingField>}
        <TeachingField label="Назва"><input name="publication-title" className={teachingInput} value={title} onChange={event => setTitle(event.target.value)} maxLength={240} required autoFocus disabled={busy} placeholder={kind === 'assignment' ? 'Наприклад, аналіз ринкової рівноваги' : 'Наприклад, презентація до лекції 3'} /></TeachingField>
        <TeachingField label={kind === 'assignment' ? 'Що потрібно зробити' : 'Опис · необов’язково'}><textarea name="publication-body" className={teachingInput} value={body} onChange={event => setBody(event.target.value)} maxLength={10000} rows={5} disabled={busy} placeholder={kind === 'assignment' ? 'Опишіть завдання та формат відповіді…' : 'Коротко поясніть, що містить матеріал…'} /></TeachingField>
        {kind === 'assignment' && <TeachingField label="Термін здачі · необов’язково" hint="За київським часом. Без терміну студент зможе здати роботу, коли її підготує."><input name="assignment-deadline" type="datetime-local" className={teachingInput} value={deadline} min={assessed ? `${snapshot.course.starts_on}T00:00` : undefined} max={assessed ? `${snapshot.course.ends_on}T23:59` : undefined} onChange={event => setDeadline(event.target.value)} disabled={busy} /></TeachingField>}
        <div className="teaching-simple-upload"><TeachingField label="Додати файли · необов’язково" hint="До 10 файлів по 20 МБ: PDF, документи, таблиці, презентації, зображення."><input name="publication-files" type="file" accept={TEACHING_FILE_ACCEPT} multiple disabled={busy} className={`${teachingInput} !text-sm`} onChange={event => {
          const incoming = [...(event.target.files || [])]; event.target.value = ''
          try { incoming.forEach(validateTeachingFile); if (files.length + attachments.length + incoming.length > 10) throw new Error('Можна додати до 10 файлів.'); setFiles(current => [...current, ...incoming]); setMissingFileNames(current => current.filter(name => !incoming.some(file => file.name === name))); setError('') } catch (failure) { setError(teachingError(failure)) }
        }} /></TeachingField>
        {(attachments.length > 0 || files.length > 0) && <div className="mt-3 space-y-2">{attachments.map(file => <div key={file.storage_path} className="flex items-center justify-between gap-3 rounded-xl bg-background px-3 py-2 text-xs"><span className="min-w-0 truncate">{file.name}</span><button type="button" className="teaching-icon-button shrink-0" aria-label={`Прибрати ${file.name}`} disabled={busy} onClick={() => setAttachments(current => current.filter(item => item.storage_path !== file.storage_path))}><X size={15} /></button></div>)}{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 rounded-xl bg-background px-3 py-2 text-xs"><span className="min-w-0 truncate">{file.name}</span><button type="button" className="teaching-icon-button shrink-0" aria-label={`Прибрати ${file.name}`} disabled={busy} onClick={() => setFiles(current => current.filter((_, position) => position !== index))}><X size={15} /></button></div>)}</div>}
        </div>
        <fieldset className="space-y-3"><legend className="mb-2 text-sm font-semibold">Посилання · необов’язково</legend>{links.map((link, index) => <div key={index} className="flex items-end gap-2"><div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2"><TeachingField label={`Посилання ${index + 1}`}><input name={`publication-link-${index}`} type="url" className={teachingInput} value={link} onChange={event => setLinks(current => current.map((value, position) => position === index ? event.target.value : value))} maxLength={2000} placeholder="https://…" disabled={busy} /></TeachingField><TeachingField label="Назва · необов’язково"><input name={`publication-link-title-${index}`} className={teachingInput} value={linkTitles[index] || ''} onChange={event => setLinkTitles(current => current.map((value, position) => position === index ? event.target.value : value))} maxLength={MAX_RESOURCE_LINK_LABEL_LENGTH * 2} placeholder="Наприклад, лекція або презентація" disabled={busy} /></TeachingField></div><button type="button" className="teaching-icon-button shrink-0" aria-label={`Прибрати посилання ${index + 1}`} disabled={busy} onClick={() => { setLinks(current => current.filter((_, position) => position !== index)); setLinkTitles(current => current.filter((_, position) => position !== index)) }}><X size={17} /></button></div>)}<TeachingButton disabled={busy || links.length >= 10} onClick={() => { setLinks(current => [...current, '']); setLinkTitles(current => [...current, '']) }}><Plus size={15} />Додати посилання</TeachingButton></fieldset>
        {kind === 'assignment' && <details className="teaching-simple-assessment" open={assessed}><summary>Оцінювання · за потреби</summary><label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={assessed} disabled={busy || !canGrade} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" onChange={event => setAssessed(event.target.checked)} /><span>Додати завдання до журналу балів</span></label>{assessed && <div className="mt-4 grid gap-4 sm:grid-cols-2"><TeachingField label="Максимальний бал"><input name="assignment-max-points" type="number" min="0.01" max="10000" step="0.01" required className={teachingInput} value={maxPoints} onChange={event => setMaxPoints(event.target.value)} disabled={busy || !canGrade} /></TeachingField><TeachingField label="Категорія"><select name="assignment-category" className={teachingInput} value={category} onChange={event => setCategory(event.target.value)} disabled={busy || !canGrade}><option value="">Без категорії</option>{snapshot.course.grading_rules.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></TeachingField></div>}<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{canGrade ? 'Після публікації це завдання з’явиться в журналі цієї групи. Бали можна виставити під час перевірки роботи та окремо опублікувати.' : 'Параметри оцінювання змінює викладач із дозволом на журнал.'}</p></details>}
        <p className="text-xs leading-relaxed text-muted-foreground">Чернетку бачать лише викладачі з відповідним дозволом. Після публікації {kind === 'assignment' ? 'завдання' : 'матеріал'} з’явиться у групі студентів.</p>
      </>}
      {progress && <p role="status" className="text-sm text-primary">{progress}</p>}
      {initial && !committed && <div className="border-t border-border pt-4">{confirmDelete ? <div className="space-y-3 rounded-xl bg-destructive/5 p-4"><p className="text-sm">Видалити {kind === 'assignment' ? 'завдання цієї групи' : preservedOtherMaterialTargets.length ? `спільний матеріал для всіх ${initial.targets.length} груп` : 'цей матеріал'}? {kind === 'assignment' ? 'Якщо студенти вже здавали роботи, видалення буде недоступне. Завдання інших груп залишаться.' : 'Публікація зникне.'} Виставлені бали й історія журналу збережуться.</p><div className="flex flex-wrap gap-2"><TeachingButton disabled={busy} onClick={() => setConfirmDelete(false)}>Залишити</TeachingButton><TeachingButton busy={busy} onClick={() => void remove()}><Trash2 size={15} />Так, видалити</TeachingButton></div></div> : <TeachingButton disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />Видалити {kind === 'assignment' ? 'завдання' : 'матеріал'}</TeachingButton>}</div>}
      <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={requestClose}>{committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{!committed && <>
        {initial?.status !== 'published' && <button type="submit" data-intent="draft" disabled={busy || !currentGroup} className="teaching-button">{busy && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />}Зберегти чернетку</button>}
        <button type="submit" data-intent="published" disabled={busy || !currentGroup} className="teaching-button teaching-button-primary">{busy ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Send size={15} />}{initial?.status === 'published' ? 'Зберегти й опублікувати' : 'Опублікувати'}</button>
        {initial?.status === 'published' && <button type="submit" data-intent="draft" disabled={busy || !currentGroup} className="teaching-button">Приховати як чернетку</button>}
      </>}</div>
    </form>
  </TeachingModal>
}

function AssignmentCopyEditor({ assignment, snapshot, repository, currentGroupId, onRefresh, onClose, onCopied }: { assignment: TeachingPublication; snapshot: TeachingSnapshot; repository: TeachingRepository; currentGroupId?: string; onRefresh: () => Promise<void>; onClose: () => void; onCopied: (groupName: string) => void }) {
  const [id] = useState(() => crypto.randomUUID())
  const [destination, setDestination] = useState(''), [deadline, setDeadline] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const lock = useRef(false)
  const groups = snapshot.groups.filter(group => group.status === 'accepted' && group.group_id !== currentGroupId)
  async function copy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || committed || !destination) return
    lock.current = true; setBusy(true); setError('')
    try {
      await repository.classroomMutate('copy_assignment', { id, source_item_id: assignment.id, source_version: assignment.version, destination_group_id: destination, due_at: kyivDeadline(deadline) })
      setCommitted(true); onCopied(groups.find(group => group.group_id === destination)?.group_name || 'вибраної групи'); await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title="Копія завдання в іншу групу" description={assignment.title} onClose={onClose} busy={busy}><form onSubmit={event => void copy(event)} className="teaching-form">
    {error && <p role="alert" className="teaching-error">{error}</p>}{committed ? <p className="teaching-note">Окрему чернетку створено. Закрийте вікно та відкрийте вибрану групу.</p> : <>
      <TeachingField label="Група"><select name="assignment-copy-group" className={teachingInput} value={destination} onChange={event => setDestination(event.target.value)} required disabled={busy}><option value="">Оберіть іншу групу</option>{groups.map(group => <option key={group.group_id} value={group.group_id}>{teachingGroupDirectoryLabel({ ...group, id: group.group_id })}</option>)}</select></TeachingField>
      <TeachingField label="Новий термін · необов’язково" hint="За київським часом."><input name="assignment-copy-deadline" type="datetime-local" className={teachingInput} value={deadline} min={assignment.max_points != null ? `${snapshot.course.starts_on}T00:00` : undefined} max={assignment.max_points != null ? `${snapshot.course.ends_on}T23:59` : undefined} onChange={event => setDeadline(event.target.value)} disabled={busy} /></TeachingField>
      <p className="teaching-note">Копія матиме власний термін і збережеться як чернетка. Опис, посилання, файли та правила оцінювання скопіюються. Здані роботи й бали студентів належать попередній групі та не переносяться.</p>
    </>}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{!committed && <TeachingButton primary type="submit" busy={busy} disabled={!destination}><Copy size={15} />Створити чернетку</TeachingButton>}</div>
  </form></TeachingModal>
}
