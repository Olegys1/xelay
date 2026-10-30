import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CalendarClock, Check, FileText, FolderOpen, Link2, RefreshCw, ShieldCheck, Trash2, Upload, UsersRound, X } from 'lucide-react'
import { teachingError, localDeadline, TEACHING_FILE_ACCEPT, TEACHING_MAX_FILE_BYTES, validateTeachingFile, validateTeachingPublicationLinks, type TeachingFile, type TeachingRepository } from '../../lib/teaching'
import { TEACHING_MATERIAL_TITLE_LIMIT, TEACHING_MATERIAL_BODY_LIMIT, type TeachingLibraryMaterial, type TeachingMaterialGrant, type TeachingMaterialLibraryData } from '../../lib/teachingMaterialLibrary'
import { canPreviewTeachingMaterial } from '../../lib/teachingMaterialPreview'
import { isStudyGroupListed } from '../../lib/studyGroupVisibility'
import { getResourceLinkTitles, MAX_RESOURCE_LINK_LABEL_LENGTH } from '../../lib/resourceLinkLabels'
import { TEACHING_MATERIAL_RIGHTS_CONFIRMATION, TEACHING_MATERIAL_TERMS_HREF, TEACHING_MATERIAL_TERMS_VERSION } from '../../lib/legal'
import { publicationTime, validatePublicationTiming } from './TeachingPublicationTimingFields'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-material-library-editor.css'

type EditorProps = {
  material: TeachingLibraryMaterial | null
  data: TeachingMaterialLibraryData
  repository: TeachingRepository
  userId: string
  initialSection?: 'content' | 'groups'
  onClose: () => void
  onSaved: () => Promise<void>
}
const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} МБ` : `${Math.max(1, Math.round(size / 1024))} КБ`

export function TeachingMaterialLibraryEditor({ material, data, repository, userId, initialSection = 'content', onClose, onSaved }: EditorProps) {
  const [expectedUserId] = useState(userId)
  const [expectedVersion] = useState(material?.version || 0)
  const actor = useRef(userId)
  actor.current = userId
  const [id] = useState(() => material?.id || crypto.randomUUID())
  const groupsOnly = Boolean(material && (initialSection === 'groups' || !material.can_edit && material.can_manage_groups))
  const editable = !groupsOnly && (!material || material.can_edit)
  const manageableGroups = !material || material.can_manage_groups
  const [courseId, setCourseId] = useState(material?.course_id || data.courses.find(item => !item.course.archived_at && item.course.permissions.includes('materials'))?.course.id || '')
  const course = data.courses.find(item => item.course.id === courseId)
  const groups = course?.groups.filter(group => group.status === 'accepted') || []
  const listedGroups = groups.filter(group => isStudyGroupListed(group.group_id, userId))
  const [selectedGroups, setSelectedGroups] = useState(material?.targets.map(target => target.group_id) || [])
  const [title, setTitle] = useState(material?.title || '')
  const [body, setBody] = useState(material?.body || '')
  const [links, setLinks] = useState(material?.links.length ? material.links : [''])
  const [linkTitles, setLinkTitles] = useState(() => getResourceLinkTitles(material?.links.length ? material.links : [''], material?.link_labels))
  const [attachments, setAttachments] = useState<TeachingFile[]>(material?.attachments || [])
  const [files, setFiles] = useState<File[]>([])
  const [replacements, setReplacements] = useState<Record<string, File>>({})
  const [allowDownload, setAllowDownload] = useState(material?.allow_download !== false)
  const [status, setStatus] = useState<'draft' | 'scheduled' | 'published'>(material?.status || 'draft')
  const [publishAt, setPublishAt] = useState(localDeadline(material?.publish_at))
  const [accessUntil, setAccessUntil] = useState(localDeadline(material?.access_until))
  const [rightsAccepted, setRightsAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [error, setError] = useState('')
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null)
  const [discard, setDiscard] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const groupSection = useRef<HTMLElement>(null)
  const fingerprint = JSON.stringify({ courseId, selectedGroups, title, body, links, linkTitles, attachments, allowDownload, status, publishAt, accessUntil })
  const initial = useRef(fingerprint)
  const dirty = !committed && (fingerprint !== initial.current || files.length > 0 || Object.keys(replacements).length > 0)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (initialSection !== 'groups') return
    const frame = requestAnimationFrame(() => { groupSection.current?.scrollIntoView({ block: 'center' }); groupSection.current?.focus({ preventScroll: true }) })
    return () => cancelAnimationFrame(frame)
  }, [initialSection])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function close() {
    if (lock.current) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  function chooseFiles(values: FileList | null, replacePath?: string) {
    if (!values || !editable || lock.current) return
    try {
      const selected = Array.from(values)
      selected.forEach(validateTeachingFile)
      if (replacePath) {
        if (selected.length !== 1) throw new Error('Для заміни оберіть один файл.')
        setReplacements(current => ({ ...current, [replacePath]: selected[0] }))
      } else {
        if (attachments.length + files.length + selected.length > 10) throw new Error('До одного матеріалу можна додати до 10 файлів.')
        setFiles(current => [...current, ...selected])
      }
      setError('')
    } catch (failure) { setError(teachingError(failure)) }
  }
  function assertActor() {
    if (actor.current !== expectedUserId) throw new Error('TEACHING_ACTOR_CHANGED')
  }
  async function refreshSaved() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await onSaved(); onClose() }
    catch { setError('Матеріал уже збережено. Не надсилайте його повторно. Спробуйте ще раз оновити список.') }
    finally { lock.current = false; setBusy(false) }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || committed) return
    lock.current = true; setBusy(true); setError('')
    const abort = new AbortController()
    controller.current = abort
    try {
      assertActor()
      if (!course || (!editable && !manageableGroups) || material?.withdrawn_at) throw new Error('TEACHING_FORBIDDEN')
      const payload: Record<string, unknown> = { id, version: expectedVersion, expected_user_id: expectedUserId, course_id: courseId }
      if (manageableGroups) payload.target_group_ids = selectedGroups.filter(groupId => groups.some(group => group.group_id === groupId))
      if (editable) {
        if (!title.trim()) throw new Error('Вкажіть назву матеріалу.')
        if (title.trim().length > TEACHING_MATERIAL_TITLE_LIMIT || body.length > TEACHING_MATERIAL_BODY_LIMIT) throw new Error(`Скоротіть назву до ${TEACHING_MATERIAL_TITLE_LIMIT} символів, а опис — до ${TEACHING_MATERIAL_BODY_LIMIT.toLocaleString('uk-UA')} символів.`)
        const normalized = validateTeachingPublicationLinks(links, linkTitles)
        if (status !== 'draft' && selectedGroups.length === 0 && !material?.hidden_target_count) throw new Error('Для публікації оберіть хоча б одну групу або збережіть чернетку.')
        if (status !== 'draft' && !rightsAccepted) throw new Error('TEACHING_MATERIAL_RIGHTS_REQUIRED')
        validatePublicationTiming(status === 'scheduled' ? 'scheduled' : 'now', publishAt, '', '')
        const unchangedExpiry = Boolean(material?.access_until && accessUntil === localDeadline(material.access_until))
        const until = unchangedExpiry ? material!.access_until! : publicationTime(accessUntil)
        const preserveExpiredAccess = unchangedExpiry && Boolean(until && Date.parse(until) <= Date.now())
        const publish = status === 'scheduled' ? publicationTime(publishAt) : null
        if (until && !preserveExpiredAccess && Date.parse(until) <= Math.max(Date.now(), publish ? Date.parse(publish) : 0)) throw new Error('Завершення доступу має бути пізніше публікації. Оберіть майбутню дату або приберіть обмеження.')
        const effectiveFiles = [...attachments.map(file => replacements[file.storage_path] || file), ...files]
        if (!allowDownload) {
          if (normalized.links.length) throw new Error('Для перегляду лише в Xelay приберіть зовнішні посилання або дозвольте завантаження. Доступ до Google Drive та інших сервісів налаштовується окремо.')
          const unsupported = effectiveFiles.filter(file => !canPreviewTeachingMaterial(file)).map(file => file.name)
          if (unsupported.length) throw new Error(`Для перегляду лише в Xelay потрібен PDF, JPG, PNG, WebP, TXT або CSV. Перетворіть ці файли на PDF або приберіть: ${unsupported.join(', ')}.`)
        }
        let uploaded = [...attachments]
        for (const [storagePath, file] of Object.entries(replacements)) {
          setUpload({ name: file.name, percent: 0 })
          const replacement = await repository.upload(courseId, expectedUserId, file, percent => setUpload({ name: file.name, percent }), abort.signal)
          assertActor(); abort.signal.throwIfAborted()
          uploaded = uploaded.map(previous => previous.storage_path === storagePath ? replacement : previous)
          setAttachments(uploaded)
          setReplacements(current => { const next = { ...current }; delete next[storagePath]; return next })
        }
        for (const file of files) {
          setUpload({ name: file.name, percent: 0 })
          const attachment = await repository.upload(courseId, expectedUserId, file, percent => setUpload({ name: file.name, percent }), abort.signal)
          assertActor(); abort.signal.throwIfAborted()
          uploaded = [...uploaded, attachment]
          setAttachments(uploaded); setFiles(current => current.filter(candidate => candidate !== file))
        }
        Object.assign(payload, { title: title.trim(), body: body.trim(), ...normalized, attachments: uploaded, status,
          publish_at: status === 'scheduled' ? publish : null, access_until: until, allow_download: allowDownload,
          ...(status === 'draft' ? {} : { rights_accepted: rightsAccepted, rights_terms_version: TEACHING_MATERIAL_TERMS_VERSION }) })
      }
      assertActor(); abort.signal.throwIfAborted(); setUpload(null)
      await repository.mutate('save_library_material', payload)
      setCommitted(true)
      try { await onSaved(); onClose() }
      catch { setError('Матеріал збережено, але список не вдалося оновити. Повторне збереження не потрібне.') }
    } catch (failure) { setError(teachingError(failure)) }
    finally { if (controller.current === abort) controller.current = null; lock.current = false; setBusy(false); setUpload(null) }
  }

  return <TeachingModal title={material ? editable ? 'Оновити матеріал' : 'Змінити групи матеріалу' : 'Додати матеріал'} description={material ? `${material.course_title} · Автор: ${material.author_name}` : 'Один матеріал — для всіх потрібних груп.'} onClose={close} busy={busy} wide={!groupsOnly}>
    {discard && <div className="teaching-note mb-5" role="alert"><p className="font-semibold text-foreground">Зміни ще не збережено</p><p className="mt-1">Залишитися в редакторі чи закрити без збереження?</p><div className="mt-3 flex flex-wrap gap-2"><TeachingButton primary disabled={busy} onClick={() => setDiscard(false)}>Продовжити редагування</TeachingButton><TeachingButton disabled={busy} onClick={onClose}>Закрити без збереження</TeachingButton></div></div>}
    <form className="teaching-form" onSubmit={event => void save(event)}>
      {error && <p className="teaching-error" role="alert">{error}</p>}
      {committed ? <div className="teaching-note" role="status"><p className="font-semibold text-foreground">Матеріал збережено</p><p className="mt-1">Зміни застосовано. Залишилося оновити список матеріалів.</p><div className="mt-3"><TeachingButton primary busy={busy} onClick={() => void refreshSaved()}><RefreshCw size={15} />Оновити список</TeachingButton></div></div> : <>
        {!editable && <div className="teaching-shared-notice"><ShieldCheck size={17} /><p>{material?.can_edit ? 'Зараз ви змінюєте лише вибір груп. Вміст і файли залишаться без змін. Для повного редагування відкрийте «Оновити матеріал».' : 'Автор дозволив вам змінювати лише групи. Вміст, файли, режим перегляду й публікацію змінює автор або колега з правом редагування.'}</p></div>}
        {material && editable && <div className="teaching-shared-notice"><RefreshCw size={17} /><p>Оновлюйте файл або посилання тут. Після збереження вибрані групи побачать нову версію цього матеріалу; повторно додавати його в кожну групу не потрібно.</p></div>}
        <div className={`material-editor-layout${groupsOnly ? ' material-editor-layout-groups' : ''}`}>
          {!groupsOnly && <section className="material-editor-main" aria-label="Вміст матеріалу">
            <TeachingField label="Предмет"><select className={teachingInput} name="library-material-course" value={courseId} onChange={event => { setCourseId(event.target.value); setSelectedGroups([]) }} disabled={busy || Boolean(material) || attachments.length > 0} required><option value="">Оберіть предмет</option>{data.courses.filter(item => !item.course.archived_at || item.course.id === material?.course_id).map(item => <option key={item.course.id} value={item.course.id}>{item.course.title} · {item.course.semester}</option>)}</select></TeachingField>
            <TeachingField label="Назва матеріалу"><input className={teachingInput} name="library-material-title" maxLength={TEACHING_MATERIAL_TITLE_LIMIT} value={title} onChange={event => setTitle(event.target.value)} placeholder="Наприклад, лекція 3 · Похідна та її застосування" required disabled={busy || !editable} /></TeachingField>
            <TeachingField label="Опис · необов’язково"><textarea className={`${teachingInput} min-h-32 resize-y`} name="library-material-body" rows={4} maxLength={TEACHING_MATERIAL_BODY_LIMIT} value={body} onChange={event => setBody(event.target.value)} placeholder="Що опрацювати та на що звернути увагу" disabled={busy || !editable} /></TeachingField>
            <section className="material-editor-section" aria-labelledby="material-editor-files-title"><div className="material-editor-section-heading"><h3 id="material-editor-files-title"><FileText size={17} />Файли матеріалу</h3><span>{attachments.length + files.length}/10</span></div>
              {attachments.map(file => <div className="material-editor-file" key={file.storage_path}><FileText size={19} aria-hidden="true" /><div><strong className={replacements[file.storage_path] ? 'line-through opacity-60' : ''}>{file.name}</strong><small>{fileSize(file.size)}{replacements[file.storage_path] ? ' · буде замінено після збереження' : ''}</small>{replacements[file.storage_path] && <p className="material-editor-replacement"><RefreshCw size={12} />{replacements[file.storage_path].name}</p>}</div>{editable && <div className="material-editor-file-actions"><label className={`material-editor-upload ${busy ? 'material-editor-upload-disabled' : ''}`}><RefreshCw size={14} /><span>Замінити</span><input type="file" accept={TEACHING_FILE_ACCEPT} aria-label={`Замінити файл ${file.name}`} disabled={busy} onChange={event => { chooseFiles(event.target.files, file.storage_path); event.target.value = '' }} /></label>{replacements[file.storage_path] && <button type="button" className="teaching-icon-button" aria-label={`Скасувати заміну ${file.name}`} disabled={busy} onClick={() => setReplacements(current => { const next = { ...current }; delete next[file.storage_path]; return next })}><X size={16} /></button>}<button type="button" className="teaching-icon-button" aria-label={`Прибрати файл ${file.name}`} disabled={busy} onClick={() => { setAttachments(current => current.filter(candidate => candidate.storage_path !== file.storage_path)); setReplacements(current => { const next = { ...current }; delete next[file.storage_path]; return next }) }}><Trash2 size={16} /></button></div>}</div>)}
              {files.map((file, index) => <div className="material-editor-file" key={`${index}:${file.name}:${file.lastModified}`}><Upload size={18} aria-hidden="true" /><div><strong>{file.name}</strong><small>{fileSize(file.size)} · новий файл</small></div><button type="button" className="teaching-icon-button" aria-label={`Прибрати новий файл ${file.name}`} disabled={busy} onClick={() => setFiles(current => current.filter((_, candidate) => candidate !== index))}><X size={16} /></button></div>)}
              {!attachments.length && !files.length && <p className="material-editor-hint">Додайте конспект, презентацію чи інший файл. Також можна залишити тільки текст або посилання.</p>}
              {editable && <label className={`material-editor-add-files ${busy ? 'material-editor-upload-disabled' : ''}`}><Upload size={19} /><span><strong>Додати файли</strong><small>До {TEACHING_MAX_FILE_BYTES / (1024 * 1024)} МБ кожен · для більшого файлу додайте посилання на Google Drive</small></span><input type="file" multiple accept={TEACHING_FILE_ACCEPT} aria-label="Додати файли матеріалу" disabled={busy || attachments.length + files.length >= 10} onChange={event => { chooseFiles(event.target.files); event.target.value = '' }} /></label>}
              {upload && <div role="status" className="material-editor-progress"><p>Завантажуємо {upload.name}<strong>{upload.percent}%</strong></p><progress max={100} value={upload.percent} aria-label={`Завантаження ${upload.name}`} /></div>}
            </section>
            <section className="material-editor-section" aria-labelledby="material-editor-links-title"><div className="material-editor-section-heading"><h3 id="material-editor-links-title"><Link2 size={17} />Посилання</h3></div>{links.map((link, index) => <div className="material-editor-link" key={index}><div><TeachingField label={`Посилання ${index + 1}`}><input type="url" name={`library-material-link-${index}`} className={teachingInput} value={link} maxLength={2000} placeholder="https://drive.google.com/…" disabled={busy || !editable} onChange={event => setLinks(current => current.map((value, candidate) => candidate === index ? event.target.value : value))} /></TeachingField><TeachingField label="Підпис · необов’язково"><input name={`library-material-link-label-${index}`} className={teachingInput} maxLength={MAX_RESOURCE_LINK_LABEL_LENGTH} value={linkTitles[index] || ''} placeholder="Наприклад, запис лекції" disabled={busy || !editable} onChange={event => setLinkTitles(current => current.map((value, candidate) => candidate === index ? event.target.value : value))} /></TeachingField></div>{editable && <button type="button" className="teaching-icon-button" aria-label={`Прибрати посилання ${index + 1}`} disabled={busy} onClick={() => { setLinks(current => current.filter((_, candidate) => candidate !== index)); setLinkTitles(current => current.filter((_, candidate) => candidate !== index)) }}><X size={16} /></button>}</div>)}{editable && links.length < 20 && <TeachingButton disabled={busy} onClick={() => { setLinks(current => [...current, '']); setLinkTitles(current => [...current, '']) }}><Link2 size={14} />Додати посилання</TeachingButton>}<p className="material-editor-hint">Замініть посилання на нове — у вибраних групах воно оновиться разом із матеріалом. Доступ до зовнішніх ресурсів налаштовується в їхньому сервісі.</p></section>
          </section>}
          <aside className="material-editor-side" aria-label="Доступ до матеріалу">
            <section ref={groupSection} tabIndex={-1} className="material-editor-section" aria-labelledby="material-editor-groups-title"><div className="material-editor-section-heading"><h3 id="material-editor-groups-title"><UsersRound size={17} />Де показувати</h3><span>{selectedGroups.filter(groupId => listedGroups.some(group => group.group_id === groupId)).length}</span></div><p className="material-editor-hint">Виберіть групи цього предмета. Чернетку можна зберегти без жодної групи.</p>{manageableGroups && listedGroups.length > 1 && <div className="material-editor-group-tools"><button type="button" disabled={busy} onClick={() => setSelectedGroups(current => [...current.filter(id => !isStudyGroupListed(id, userId)), ...listedGroups.map(group => group.group_id)])}>Усі групи</button><button type="button" disabled={busy} onClick={() => setSelectedGroups(current => current.filter(id => !isStudyGroupListed(id, userId)))}>Прибрати вибір</button></div>}{listedGroups.length ? <div className="material-editor-groups">{listedGroups.map(group => <label className="teaching-check" key={group.group_id}><input type="checkbox" name={`library-material-group-${group.group_id}`} checked={selectedGroups.includes(group.group_id)} disabled={busy || !manageableGroups} onChange={event => setSelectedGroups(current => event.target.checked ? [...current, group.group_id] : current.filter(id => id !== group.group_id))} /><span><strong>{group.group_name}</strong><small>{[group.study_year ? `${group.study_year} курс` : '', group.specialty || ''].filter(Boolean).join(' · ')}</small></span></label>)}</div> : <p className="teaching-note">Підключених груп ще немає. Матеріал можна зберегти як чернетку.</p>}{!manageableGroups && <p className="material-editor-hint">Вибір груп змінює автор або колега з відповідним дозволом.</p>}{Boolean(material?.hidden_target_count) && <p className="teaching-note">Ще {material!.hidden_target_count} груп поза вашим доступом. Їхній вибір збережеться без змін.</p>}</section>
            {!groupsOnly && <><section className="material-editor-section"><div className="material-editor-section-heading"><h3><ShieldCheck size={17} />Режим перегляду</h3></div><label className="material-editor-choice"><input type="radio" name="library-material-download" checked={allowDownload} disabled={busy || !editable} onChange={() => setAllowDownload(true)} /><span><strong>Перегляд і завантаження</strong><small>Студенти можуть зберегти файл собі.</small></span></label><label className="material-editor-choice"><input type="radio" name="library-material-download" checked={!allowDownload} disabled={busy || !editable} onChange={() => setAllowDownload(false)} /><span><strong>Лише перегляд у Xelay</strong><small>Без кнопки завантаження. Для PDF, зображень, TXT і CSV.</small></span></label>{!allowDownload && <p className="material-editor-hint">Зовнішні посилання й Word, Excel або PowerPoint для цього режиму не підходять. Скріншоти екрана технічно залишаються можливими.</p>}</section>
            <section className="material-editor-section"><div className="material-editor-section-heading"><h3><CalendarClock size={17} />Публікація й термін</h3></div><TeachingField label="Коли показати студентам"><select className={teachingInput} name="library-material-status" value={status} disabled={busy || !editable} onChange={event => setStatus(event.target.value as typeof status)}><option value="draft">Залишити чернеткою</option><option value="published">Опублікувати зараз</option><option value="scheduled">За розкладом</option></select></TeachingField>{status === 'scheduled' && <TeachingField label="Дата й час публікації"><input name="library-material-publish-at" type="datetime-local" className={teachingInput} value={publishAt} disabled={busy || !editable} onChange={event => setPublishAt(event.target.value)} /></TeachingField>}<TeachingField label="Доступ до · необов’язково"><input name="library-material-access-until" type="datetime-local" className={teachingInput} value={accessUntil} disabled={busy || !editable} onChange={event => setAccessUntil(event.target.value)} /></TeachingField><p className="material-editor-hint">Час за Києвом. Без кінцевої дати матеріал доступний до відкликання автором.</p></section></>}
          </aside>
        </div>
        {editable && status !== 'draft' && <label className="material-editor-rights"><input name="library-material-rights" type="checkbox" checked={rightsAccepted} disabled={busy} onChange={event => setRightsAccepted(event.target.checked)} /><span>{TEACHING_MATERIAL_RIGHTS_CONFIRMATION} <a href={repository.mode === 'local' ? `${window.location.pathname}?legal=terms#teacher-materials` : TEACHING_MATERIAL_TERMS_HREF} target="_blank" rel="noopener noreferrer">Умови розміщення</a>{material && !material.is_owner && <small>Ви дієте з дозволу автора. Авторство матеріалу залишиться за {material.author_name}.</small>}</span></label>}
        <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={close}>Скасувати</TeachingButton><TeachingButton type="submit" primary busy={busy} disabled={!course || (!editable && !manageableGroups)}>{material ? editable ? <RefreshCw size={16} /> : <UsersRound size={16} /> : <FolderOpen size={16} />}{busy ? upload ? 'Завантажуємо файл…' : 'Зберігаємо…' : material ? editable ? 'Оновити матеріал' : 'Зберегти вибір груп' : status === 'draft' ? 'Зберегти чернетку' : status === 'scheduled' ? 'Запланувати матеріал' : 'Опублікувати матеріал'}</TeachingButton></div>
      </>}
    </form>
  </TeachingModal>
}

export function TeachingMaterialCollaboratorsDialog({ material, data, repository, userId, onClose, onSaved }: Omit<EditorProps, 'material'> & { material: TeachingLibraryMaterial }) {
  const [expectedUserId] = useState(userId)
  const [expectedVersion] = useState(material.version)
  const actor = useRef(userId)
  actor.current = userId
  const [grants, setGrants] = useState<TeachingMaterialGrant[]>(() => material.collaborators.map(grant => ({ ...grant })))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false)
  const lock = useRef(false)
  const active = data.courses.find(item => item.course.id === material.course_id)?.colleagues.filter(colleague => colleague.status === 'accepted' && colleague.user_id !== material.created_by) || []
  const people = [...active.map(person => ({ user_id: person.user_id, full_name: person.full_name, active: true })), ...material.collaborators.filter(person => !active.some(candidate => candidate.user_id === person.user_id)).map(person => ({ user_id: person.user_id, full_name: person.full_name || 'Колега', active: false }))]
  const value = (userId: string): TeachingMaterialGrant => grants.find(grant => grant.user_id === userId) || { user_id: userId, can_edit: false, can_delete: false, can_manage_groups: false }
  function toggle(personId: string, right: 'can_edit' | 'can_delete' | 'can_manage_groups', checked: boolean) {
    if (lock.current) return
    setGrants(current => [...current.filter(grant => grant.user_id !== personId), { ...value(personId), full_name: people.find(person => person.user_id === personId)?.full_name, [right]: checked }])
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || committed || !material.can_manage_collaborators) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (actor.current !== expectedUserId) throw new Error('TEACHING_ACTOR_CHANGED')
      await repository.mutate('set_material_collaborators', { id: material.id, version: expectedVersion, expected_user_id: expectedUserId, grants: grants.filter(grant => grant.can_edit || grant.can_delete || grant.can_manage_groups) })
      setCommitted(true)
      try { await onSaved(); onClose() } catch { setError('Права збережено, але список не вдалося оновити. Повторне збереження не потрібне.') }
    } catch (failure) { setError(teachingError(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  async function refresh() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await onSaved(); onClose() } catch { setError('Права вже збережено. Спробуйте ще раз оновити список.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title="Права колег на матеріал" description={material.title} busy={busy} onClose={onClose} wide>
    <form className="teaching-form" onSubmit={event => void save(event)}>
      {error && <p className="teaching-error" role="alert">{error}</p>}
      <div className="teaching-shared-notice"><ShieldCheck size={18} /><p>Ви залишаєтеся автором і маєте повний контроль. Для кожного колеги окремо оберіть, що дозволено з цим матеріалом. Доступ діє лише в межах його підключених груп.</p></div>
      {committed ? <div className="teaching-note" role="status"><p>Права збережено.</p><div className="mt-3"><TeachingButton primary busy={busy} onClick={() => void refresh()}><RefreshCw size={15} />Оновити список</TeachingButton></div></div> : <>
        {people.length ? <div className="material-colleague-list">{people.map(person => { const grant = value(person.user_id); return <section className="material-colleague-card" key={person.user_id}><div className="material-colleague-heading"><div><h3>{person.full_name}</h3><p>{person.active ? 'Колега цього предмета' : 'Активний доступ до предмета відсутній'}</p></div>{(grant.can_edit || grant.can_delete || grant.can_manage_groups) && <TeachingButton disabled={busy} onClick={() => setGrants(current => current.filter(candidate => candidate.user_id !== person.user_id))}><X size={14} />Забрати всі права</TeachingButton>}</div><div className="material-colleague-rights">{([['can_edit', 'Оновлювати матеріал', 'Змінювати опис, посилання та файли.'], ['can_delete', 'Видаляти матеріал', 'Відкликати матеріал з усіх груп.'], ['can_manage_groups', 'Вибирати групи', 'Змінювати групи в межах свого доступу.']] as const).map(([right, label, hint]) => <label className="material-editor-choice" key={right}><input type="checkbox" name={`material-grant-${person.user_id}-${right}`} checked={grant[right]} disabled={busy || !person.active || !material.can_manage_collaborators} onChange={event => toggle(person.user_id, right, event.target.checked)} /><span><strong>{label}</strong><small>{hint}</small></span></label>)}</div></section> })}</div> : <div className="teaching-note">Спочатку додайте колегу до цього предмета й дочекайтеся прийняття запрошення. Потім тут можна буде надати права на конкретний матеріал.</div>}
        <p className="material-editor-hint">Зніміть усі позначки, щоб забрати доступ до матеріалу. Колеги не можуть передавати ці права іншим.</p>
        <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>Скасувати</TeachingButton><TeachingButton type="submit" primary busy={busy} disabled={!material.can_manage_collaborators}><Check size={15} />Зберегти права</TeachingButton></div>
      </>}
    </form>
  </TeachingModal>
}
