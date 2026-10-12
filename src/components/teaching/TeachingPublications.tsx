import { useState, type FormEvent } from 'react'
import { Download, ExternalLink, FileText, Pencil, Plus, Trash2, X } from 'lucide-react'
import { teachingDate, teachingError, kyivDeadline, localDeadline, TEACHING_FILE_ACCEPT, validateTeachingFile, validateTeachingLinks, type TeachingFile, type TeachingPublication, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'

export function TeachingResources({ publication, repository }: { publication: TeachingPublication; repository: TeachingRepository }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  async function download(file: TeachingFile) {
    if (busy) return
    setBusy(file.storage_path); setError('')
    try {
      const url = await repository.fileUrl(file)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.download = file.name; anchor.click()
    } catch (failure) { setError(teachingError(failure)) } finally { setBusy('') }
  }
  return <>{(publication.links.length > 0 || publication.attachments.length > 0) && <div className="mt-4 flex flex-wrap gap-2">{publication.links.map((url, index) => { let valid = false; try { valid = ['http:', 'https:'].includes(new URL(url).protocol) } catch {} return valid ? <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="teaching-resource"><ExternalLink size={14} />Посилання {index + 1}</a> : null })}{publication.attachments.map(file => <button key={file.storage_path} type="button" className="teaching-resource" disabled={Boolean(busy)} onClick={() => void download(file)}><Download size={14} className="shrink-0" /><span className="truncate">{busy === file.storage_path ? 'Відкриваємо…' : file.name}</span></button>)}</div>}{error && <p role="alert" className="teaching-error mt-3">{error}</p>}</>
}
export function TeachingPublications({ kind, snapshot, repository, userId, onRefresh, readonly = false, groupId }: { kind: 'assignment' | 'material'; snapshot: TeachingSnapshot; repository: TeachingRepository; userId: string; onRefresh: () => Promise<void>; readonly?: boolean; groupId?: string }) {
  const [editing, setEditing] = useState<TeachingPublication | 'new' | null>(null)
  const canEdit = !readonly && !snapshot.course.archived_at && snapshot.course.permissions.includes(kind === 'assignment' ? 'assignments' : 'materials')
  const items = (kind === 'assignment' ? snapshot.assignments : snapshot.materials).filter(item => (!readonly || item.status === 'published') && (!groupId || item.targets.some(target => target.group_id === groupId)))
  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{kind === 'assignment' ? 'Завдання' : 'Матеріали'}</h2><p className="mt-1 text-xs text-muted-foreground">{kind === 'assignment' ? 'Одне завдання для кількох груп з окремими термінами.' : 'Презентації, конспекти та посилання для підключених груп.'}</p></div>{canEdit && <TeachingButton primary onClick={() => setEditing('new')}><Plus size={16} />{kind === 'assignment' ? 'Додати завдання' : 'Додати матеріал'}</TeachingButton>}</div>
    {!items.length ? <div className="teaching-card"><TeachingEmpty icon={<FileText size={24} />} title={kind === 'assignment' ? 'Завдань поки немає' : 'Матеріалів поки немає'} description={canEdit ? 'Створіть публікацію та оберіть групи, які мають її отримати.' : 'Тут з’являться публікації вашого викладача.'} /></div> : <div className="teaching-list">{items.map(item => <article key={item.id} className="teaching-card"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className={`teaching-badge ${item.status === 'published' ? 'teaching-badge-blue' : ''}`}>{item.status === 'published' ? 'Опубліковано' : 'Чернетка'}</span><h3 className="mt-3 break-words text-lg font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted-foreground">{item.author_name}{item.published_at ? ` · ${teachingDate(item.published_at)}` : ''}</p></div>{canEdit && <button className="teaching-icon-button" type="button" aria-label={`Редагувати ${item.title}`} onClick={() => setEditing(item)}><Pencil size={17} /></button>}</div>{item.body && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>}<TeachingResources publication={item} repository={repository} /><div className="mt-4 flex flex-wrap gap-2">{item.targets.filter(t => !groupId || t.group_id === groupId).map(target => <span key={target.group_id} className="text-xs text-muted-foreground">{snapshot.groups.find(g => g.group_id === target.group_id)?.group_name || 'Група'}{kind === 'assignment' ? ` · ${teachingDate(target.due_at, true)}` : ''}</span>)}</div></article>)}</div>}
    {editing && <PublicationEditor key={editing === 'new' ? 'new' : editing.id} kind={kind} initial={editing === 'new' ? null : editing} snapshot={snapshot} repository={repository} userId={userId} onClose={() => setEditing(null)} onRefresh={onRefresh} />}
  </>
}
function PublicationEditor({ kind, initial, snapshot, repository, userId, onClose, onRefresh }: { kind: 'assignment' | 'material'; initial: TeachingPublication | null; snapshot: TeachingSnapshot; repository: TeachingRepository; userId: string; onClose: () => void; onRefresh: () => Promise<void> }) {
  const [id] = useState(initial?.id || crypto.randomUUID())
  const [title, setTitle] = useState(initial?.title || ''), [body, setBody] = useState(initial?.body || '')
  const [links, setLinks] = useState(initial?.links.length ? initial.links : [''])
  const [attachments, setAttachments] = useState<TeachingFile[]>(initial?.attachments || [])
  const [files, setFiles] = useState<File[]>([])
  const [selected, setSelected] = useState(initial?.targets.map(t => t.group_id) || [])
  const [deadlines, setDeadlines] = useState<Record<string, string>>(Object.fromEntries(initial?.targets.map(t => [t.group_id, localDeadline(t.due_at)]) || []))
  const [status, setStatus] = useState<'draft' | 'published'>(initial?.status || 'draft')
  const [assessed, setAssessed] = useState(initial?.max_points != null)
  const [maxPoints, setMaxPoints] = useState(String(initial?.max_points ?? 10))
  const [category, setCategory] = useState(initial?.category || '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState(''), [committed, setCommitted] = useState(false)
  const groups = snapshot.groups.filter(g => g.status === 'accepted')
  const canGrade = snapshot.course.permissions.includes('grades')
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || committed) return
    setBusy(true); setError('')
    try {
      const normalized = validateTeachingLinks(links)
      if (!selected.length) throw new Error('Оберіть хоча б одну підтверджену групу.')
      if (kind === 'assignment' && assessed && (!Number.isFinite(Number(maxPoints)) || Number(maxPoints) <= 0 || Number(maxPoints) > 10000)) throw new Error('Максимальний бал має бути більшим за 0 і не перевищувати 10 000.')
      let uploaded = [...attachments]
      for (let index = 0; index < files.length; index++) {
        setProgress(`Завантаження ${index + 1} з ${files.length}`)
        uploaded = [...uploaded, await repository.upload(snapshot.course.id, userId, files[index])]
        setAttachments(uploaded)
        setFiles(current => current.filter(file => file !== files[index]))
      }
      setProgress('Збереження…')
      await repository.mutate(`save_${kind}`, { course_id: snapshot.course.id, id, version: initial?.version || 0, title: title.trim(), body: body.trim(), links: normalized, attachments: uploaded, targets: selected.map(group_id => ({ group_id, due_at: kind === 'assignment' ? kyivDeadline(deadlines[group_id] || '') : null })), status, ...(kind === 'assignment' ? { max_points: assessed ? Number(maxPoints) : null, category: assessed ? category : '' } : {}) })
      setCommitted(true); await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { setBusy(false); setProgress('') }
  }
  async function remove() {
    if (!initial || busy || committed) return
    setBusy(true); setError(''); setProgress('Видалення…')
    try {
      await repository.mutate(`delete_${kind}`, { id: initial.id, version: initial.version })
      setCommitted(true); await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { setBusy(false); setProgress('') }
  }
  return <TeachingModal title={`${initial ? 'Редагувати' : 'Нове'} ${kind === 'assignment' ? 'завдання' : 'матеріал'}`} onClose={onClose} busy={busy} description="Студенти бачать лише опубліковані записи. Файли доступні учасникам вибраних груп.">
    <form onSubmit={save} className="teaching-form">
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {committed ? <p role="status" className="teaching-note">Публікацію збережено. Оновіть список, якщо вона ще не відображається.</p> : <>
      <TeachingField label="Назва"><input name="publication-title" className={teachingInput} value={title} onChange={e => setTitle(e.target.value)} maxLength={240} required autoFocus disabled={busy} /></TeachingField>
      <TeachingField label="Опис"><textarea name="publication-body" className={teachingInput} value={body} onChange={e => setBody(e.target.value)} maxLength={10000} rows={5} disabled={busy} /></TeachingField>
      {kind === 'assignment' && <fieldset className="rounded-xl border border-border p-4"><legend className="px-1 text-sm font-semibold">Оцінювання</legend><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={assessed} disabled={busy || !canGrade} className="h-4 w-4 accent-primary" onChange={e => setAssessed(e.target.checked)} />Додати завдання до журналу</label>{assessed && <div className="mt-4 grid gap-4 sm:grid-cols-2"><TeachingField label="Максимальний бал"><input name="assignment-max-points" type="number" min="0.01" max="10000" step="0.01" required className={teachingInput} value={maxPoints} onChange={e => setMaxPoints(e.target.value)} disabled={busy || !canGrade} /></TeachingField><TeachingField label="Категорія"><select name="assignment-category" className={teachingInput} value={category} onChange={e => setCategory(e.target.value)} disabled={busy || !canGrade}><option value="">Без категорії</option>{snapshot.course.grading_rules.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></TeachingField></div>}<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{canGrade ? 'Після публікації колонка з’явиться в журналі кожної вибраної групи. Виставлення та публікація балів — окремий крок.' : 'Параметри оцінювання змінює викладач із дозволом на журнал.'}</p></fieldset>}
      <fieldset className="space-y-3"><legend className="mb-2 text-sm font-semibold">Групи та терміни</legend>{groups.map(g => <div key={g.group_id} className="rounded-xl border border-border p-3"><label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={selected.includes(g.group_id)} disabled={busy} onChange={e => setSelected(e.target.checked ? [...selected, g.group_id] : selected.filter(id => id !== g.group_id))} />{g.group_name}</label>{kind === 'assignment' && selected.includes(g.group_id) && <div className="mt-3"><TeachingField label="Термін — за київським часом" hint="Необов’язково. Для кожної групи можна вибрати інший термін."><input name={`deadline-${g.group_id}`} type="datetime-local" className={teachingInput} value={deadlines[g.group_id] || ''} onChange={e => setDeadlines({ ...deadlines, [g.group_id]: e.target.value })} disabled={busy} /></TeachingField></div>}</div>)}{!groups.length && <p className="teaching-note">Спочатку підключіть хоча б одну групу й дочекайтеся підтвердження старости.</p>}</fieldset>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold">Посилання</legend>{links.map((link, index) => <div key={index} className="flex items-end gap-2"><div className="min-w-0 flex-1"><TeachingField label={`Посилання ${index + 1}`}><input name={`link-${index}`} type="url" className={teachingInput} value={link} onChange={e => setLinks(links.map((v, i) => i === index ? e.target.value : v))} maxLength={2048} placeholder="https://…" disabled={busy} /></TeachingField></div><button type="button" className="teaching-icon-button" aria-label={`Прибрати посилання ${index + 1}`} disabled={busy} onClick={() => setLinks(links.filter((_, i) => i !== index))}><X size={17} /></button></div>)}<TeachingButton disabled={busy || links.length >= 10} onClick={() => setLinks([...links, ''])}><Plus size={15} />Додати посилання</TeachingButton></fieldset>
      <TeachingField label="Файли" hint="До 10 файлів, до 20 МБ кожен. PDF, документи, таблиці, презентації та зображення."><input name="publication-files" type="file" accept={TEACHING_FILE_ACCEPT} multiple disabled={busy} className={teachingInput} onChange={e => { const incoming = [...(e.target.files || [])]; e.target.value = ''; try { incoming.forEach(validateTeachingFile); if (files.length + attachments.length + incoming.length > 10) throw new Error('Можна додати до 10 файлів.'); setFiles([...files, ...incoming]); setError('') } catch (failure) { setError(teachingError(failure)) } }} /></TeachingField>
      {(attachments.length > 0 || files.length > 0) && <div className="space-y-2">{attachments.map(file => <div key={file.storage_path} className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2 text-xs"><span className="truncate">{file.name}</span><button type="button" className="teaching-icon-button" aria-label={`Прибрати ${file.name}`} disabled={busy} onClick={() => setAttachments(attachments.filter(f => f.storage_path !== file.storage_path))}><X size={15} /></button></div>)}{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2 text-xs"><span className="truncate">{file.name}</span><button type="button" className="teaching-icon-button" aria-label={`Прибрати ${file.name}`} disabled={busy} onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={15} /></button></div>)}</div>}
      <TeachingField label="Доступність"><select name="publication-status" className={teachingInput} value={status} onChange={e => setStatus(e.target.value as 'draft' | 'published')} disabled={busy}><option value="draft">Чернетка — лише викладачі з дозволом</option><option value="published">Опублікувати для вибраних груп</option></select></TeachingField>
      </>}
      {progress && <p role="status" className="text-sm text-primary">{progress}</p>}
      {initial && !committed && <div className="border-t border-border pt-4">{confirmDelete ? <div className="space-y-3 rounded-xl bg-destructive/5 p-4"><p className="text-sm">Видалити цю публікацію? Вона зникне з груп. Виставлені бали та історія журналу збережуться.</p><div className="flex flex-wrap gap-2"><TeachingButton disabled={busy} onClick={() => setConfirmDelete(false)}>Залишити</TeachingButton><TeachingButton busy={busy} onClick={() => void remove()}><Trash2 size={15} />Так, видалити</TeachingButton></div></div> : <TeachingButton disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />Видалити {kind === 'assignment' ? 'завдання' : 'матеріал'}</TeachingButton>}</div>}
      <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>{committed ? 'Закрити' : 'Скасувати'}</TeachingButton>{!committed && <TeachingButton primary type="submit" busy={busy} disabled={!groups.length}>{status === 'published' ? 'Зберегти й опублікувати' : 'Зберегти чернетку'}</TeachingButton>}</div>
    </form>
  </TeachingModal>
}
