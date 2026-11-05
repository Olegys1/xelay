import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ClipboardCheck, Copy, MessageSquareText, Pencil, Plus, Send, Trash2, UsersRound } from 'lucide-react'
import { teachingError, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { EMPTY_TEACHING_AUDIENCE, teachingAudienceLabel, type TeachingAnnouncement, type TeachingAudienceContext, type TeachingAudienceTarget, type TeachingLabTeam, type TeachingSubgroup } from '../../lib/teachingAudience'
import { TeachingAnnouncementComposer as AnnouncementForm } from './TeachingAnnouncementComposer'
import { TeachingAnnouncementReceipts } from './TeachingAnnouncementReceipts'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-audiences.css'

type Props = { repository: TeachingRepository; snapshot: TeachingSnapshot; groupId: string; userId: string; readonly?: boolean; section: 'messages' | 'subgroups' }
const announcementTime = (value: string) => new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
const participantsLabel = (count: number) => count + ' ' + ({ one: 'учасник', few: 'учасники', many: 'учасників', other: 'учасника' }[new Intl.PluralRules('uk').select(count)] || 'учасників')

type RosterEditor = { kind: 'subgroup' | 'team'; initial?: TeachingSubgroup | TeachingLabTeam; copy?: boolean }

export function TeachingAudiencePanel({ repository, snapshot, groupId, userId, readonly = false, section }: Props) {
  const [result, setResult] = useState<{ repository: TeachingRepository; key: string; data: TeachingAudienceContext; error: string; loading: boolean }>({ repository, key: '', data: EMPTY_TEACHING_AUDIENCE, error: '', loading: true })
  const [editor, setEditor] = useState<RosterEditor | null>(null)
  const [messageEditor, setMessageEditor] = useState<TeachingAnnouncement | 'new' | null>(null)
  const [deleting, setDeleting] = useState<{ kind: 'subgroup' | 'team' | 'announcement'; id: string; version: number; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipts, setReceipts] = useState<TeachingAnnouncement | null>(null)
  const alive = useRef(true)
  const key = `${userId}:${snapshot.course.id}:${groupId}`
  const actor = useRef({ repository, key, userId }); actor.current = { repository, key, userId }
  const load = useCallback(async () => {
    const source = { repository, key, userId }
    if (!repository.audiences) return
    try {
      const data = await repository.audiences.context(snapshot.course.id, groupId)
      if (alive.current && actor.current.repository === source.repository && actor.current.key === source.key && actor.current.userId === source.userId) setResult({ repository, key, data, error: '', loading: false })
    } catch (error) { if (alive.current && actor.current.key === source.key && actor.current.repository === repository) setResult({ repository, key, data: EMPTY_TEACHING_AUDIENCE, error: teachingError(error), loading: false }) }
  }, [repository, snapshot.course.id, groupId, key, userId])
  useEffect(() => { alive.current = true; setResult({ repository, key, data: EMPTY_TEACHING_AUDIENCE, error: '', loading: true }); setEditor(null); setMessageEditor(null); setDeleting(null); setReceipts(null); void load(); return () => { alive.current = false } }, [load, key])
  const data = result.key === key && result.repository === repository ? result.data : EMPTY_TEACHING_AUDIENCE
  const group = snapshot.groups.find(group => group.group_id === groupId)
  const canManage = !readonly && (group?.permissions || snapshot.course.permissions).some(permission => permission === 'manage' || permission === 'assignments')
  const subgroups = data.subgroups.filter(subgroup => subgroup.group_id === groupId)
  const teams = data.teams.filter(team => team.group_id === groupId)
  const messages = data.announcements.filter(message => message.targets.some(target => target.group_id === groupId))
  async function remove() {
    if (!deleting || !repository.audiences || busy) return
    setBusy(true)
    const source = actor.current
    try {
      await repository.audiences.mutate(`delete_${deleting.kind === 'team' ? 'lab_team' : deleting.kind}`, { id: deleting.id, version: deleting.version, course_id: snapshot.course.id, expected_user_id: userId })
      if (actor.current.repository !== source.repository || actor.current.key !== source.key || actor.current.userId !== source.userId) return
      setDeleting(null); await load()
    } catch (error) { setResult(value => ({ ...value, error: teachingError(error) })) } finally { setBusy(false) }
  }
  if (!repository.audiences) return <TeachingEmpty title="Розділ ще підключається" description="Повідомлення та підгрупи з’являться після оновлення платформи." />
  return <section className="teaching-audience-panel">
    <div className="teaching-section-heading"><div><h2>{section === 'messages' ? 'Повідомлення від викладача' : 'Підгрупи й лабораторні команди'}</h2><p>{section === 'messages' ? 'Одна публікація для потрібних груп або підгруп. Повідомлення не змінює розклад.' : 'Склад діє тільки в цьому предметі. Для кожної лабораторної можна створити власні команди.'}</p></div>{canManage && <TeachingButton primary onClick={() => section === 'messages' ? setMessageEditor('new') : setEditor({ kind: 'subgroup' })}>{section === 'messages' ? <Send size={16} /> : <Plus size={16} />}{section === 'messages' ? 'Написати групам' : 'Додати підгрупу'}</TeachingButton>}</div>
    {result.error && result.key === key && result.repository === repository && <div role="alert"><p className="teaching-error">{result.error}</p><TeachingButton onClick={() => void load()}>Повторити завантаження</TeachingButton></div>}
    {result.loading ? <p role="status">Завантажуємо…</p> : section === 'messages' ? messages.length ? <div className="teaching-audience-cards">{messages.map(message => <article key={message.id} className="teaching-card"><div className="teaching-audience-meta"><span><MessageSquareText size={15} />{message.author_name}</span><span>{snapshot.course.title}</span><time dateTime={message.created_at}>{announcementTime(message.created_at)}</time>{message.updated_at !== message.created_at && <span>Відредаговано</span>}</div><h3>{message.title}</h3>{message.requires_acknowledgement && <p className="teaching-announcement-count"><ClipboardCheck size={15} />Потрібне ознайомлення{repository.audiences?.receipts && <TeachingButton onClick={() => setReceipts(message)}>Хто ознайомився</TeachingButton>}</p>}<p className="whitespace-pre-wrap">{message.body}</p><div className="teaching-audience-meta">{message.targets.map(target => <span key={target.group_id}>{snapshot.groups.find(group => group.group_id === target.group_id)?.group_name || 'Навчальна група'} · {teachingAudienceLabel(target, data)}</span>)}</div>{canManage && message.created_by === userId && <div className="teaching-form-actions"><TeachingButton onClick={() => setMessageEditor(message)}><Pencil size={15} />Редагувати</TeachingButton><TeachingButton onClick={() => setDeleting({ kind: 'announcement', id: message.id, version: message.version, name: message.title })}><Trash2 size={15} />Видалити</TeachingButton></div>}</article>)}</div> : <TeachingEmpty icon={<MessageSquareText />} title="Повідомлень поки немає" description="Наприклад, повідомте про зміну формату заняття або свою відсутність." /> : <>
      <div className="teaching-audience-cards" data-teaching-guide="subgroups-manage">{subgroups.map(subgroup => <article key={subgroup.id} className="teaching-card"><h3>{subgroup.name}</h3><p>{participantsLabel(subgroup.user_ids.length)}</p><div className="teaching-audience-students">{subgroup.user_ids.map(id => <span key={id}>{(data.members || snapshot.members).find(member => member.group_id === groupId && member.user_id === id)?.full_name || 'Учасник групи'}</span>)}</div>{canManage && <div className="teaching-form-actions"><TeachingButton onClick={() => setEditor({ kind: 'subgroup', initial: subgroup })}><Pencil size={15} />Склад</TeachingButton><TeachingButton onClick={() => setDeleting({ kind: 'subgroup', id: subgroup.id, version: subgroup.version, name: subgroup.name })}><Trash2 size={15} />Видалити</TeachingButton></div>}</article>)}</div>
      {!subgroups.length && <TeachingEmpty icon={<UsersRound />} title="Уся група разом" description="Якщо іноземну мову чи лабораторну відвідує частина студентів, створіть для них підгрупу." />}
      <div className="teaching-section-heading mt-8" data-teaching-guide="teams-manage"><div><h3>Команди лабораторних</h3><p>Склад окремий для кожної роботи. Оцінки залишаються особистими.</p></div>{canManage && <TeachingButton onClick={() => setEditor({ kind: 'team' })}><Plus size={15} />Створити команду</TeachingButton>}</div>
      {teams.length ? <div className="teaching-audience-cards">{teams.map(team => <article key={team.id} className="teaching-card"><small>{snapshot.assignments.find(item => item.id === team.item_id)?.title || 'Лабораторна робота'}</small><h3>{team.name}</h3><p>{participantsLabel(team.user_ids.length)}</p><div className="teaching-audience-students">{team.user_ids.map(id => <span key={id}>{(data.members || snapshot.members).find(member => member.group_id === groupId && member.user_id === id)?.full_name || 'Учасник групи'}</span>)}</div>{canManage && <div className="teaching-form-actions"><TeachingButton onClick={() => setEditor({ kind: 'team', initial: team })}><Pencil size={15} />Склад</TeachingButton><TeachingButton onClick={() => setEditor({ kind: 'team', initial: team, copy: true })}><Copy size={15} />Копіювати до іншої роботи</TeachingButton><TeachingButton onClick={() => setDeleting({ kind: 'team', id: team.id, version: team.version, name: team.name })}><Trash2 size={15} />Видалити</TeachingButton></div>}</article>)}</div> : <p className="teaching-audience-hint">Збережіть роботу, оберіть її тут і розподіліть студентів вручну або з готової підгрупи.</p>}
    </>}
    {editor && canManage && result.key === key && result.repository === repository && <RosterForm key={`${editor.kind}:${editor.initial?.id || 'new'}:${editor.copy}`} editor={editor} repository={repository} snapshot={snapshot} groupId={groupId} userId={userId} context={data} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await load() }} />}
    {messageEditor && canManage && result.key === key && result.repository === repository && <AnnouncementForm initial={messageEditor === 'new' ? null : messageEditor} repository={repository} snapshot={snapshot} groupId={groupId} userId={userId} onClose={() => setMessageEditor(null)} onSaved={async () => { setMessageEditor(null); await load() }} />}
    {receipts && canManage && <TeachingAnnouncementReceipts key={`${key}:${receipts.id}:${receipts.version}`} announcement={receipts} repository={repository} userId={userId} onClose={() => setReceipts(null)} />}
    {deleting && <TeachingModal title={`Видалити «${deleting.name}»?`} description={deleting.kind === 'announcement' ? 'Повідомлення більше не відображатиметься студентам.' : 'Попередні роботи та оцінки залишаться. Якщо склад уже використовується, система не дозволить його видалити.'} onClose={() => { if (!busy) setDeleting(null) }} busy={busy}><div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setDeleting(null)}>Скасувати</TeachingButton><TeachingButton primary busy={busy} onClick={() => void remove()}>Видалити</TeachingButton></div></TeachingModal>}
  </section>
}

function RosterForm({ editor, repository, snapshot, groupId, userId, context, onClose, onSaved }: { editor: RosterEditor; repository: TeachingRepository; snapshot: TeachingSnapshot; groupId: string; userId: string; context: TeachingAudienceContext; onClose: () => void; onSaved: () => Promise<void> }) {
  const [expectedUserId] = useState(userId)
  const actor = useRef(userId); actor.current = userId
  const [id] = useState(() => editor.initial && !editor.copy ? editor.initial.id : crypto.randomUUID())
  const [name, setName] = useState(editor.initial?.name || '')
  const [selected, setSelected] = useState(editor.initial?.user_ids || [])
  const [itemId, setItemId] = useState(!editor.copy && editor.kind === 'team' && editor.initial && 'item_id' in editor.initial ? editor.initial.item_id : '')
  const [seed, setSeed] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const members = (context.members || snapshot.members).filter(member => member.group_id === groupId)
  const assignments = snapshot.assignments.filter(item => item.targets.some(target => target.group_id === groupId))
  const selectedItem = assignments.find(item => item.id === itemId)
  const target = selectedItem?.targets.find(target => target.group_id === groupId)
  const allowed = target?.audience_mode === 'subgroups' ? new Set(context.subgroups.filter(subgroup => target.subgroup_ids?.includes(subgroup.id)).flatMap(subgroup => subgroup.user_ids)) : null
  const available = members.filter(member => !allowed || allowed.has(member.user_id))
  async function save(event: FormEvent) {
    event.preventDefault()
    if (lock.current || !repository.audiences) return
    if (actor.current !== expectedUserId) { setError('Акаунт змінився. Відкрийте форму знову.'); return }
    setError('')
    if (!name.trim() || !selected.length || editor.kind === 'team' && !itemId) { setError('Вкажіть назву, роботу та оберіть учасників.'); return }
    if (selected.some(id => !available.some(member => member.user_id === id))) { setError('Частина обраних студентів не має доступу до цієї роботи. Перевірте склад.'); return }
    lock.current = true; setBusy(true)
    try { await repository.audiences.mutate(`save_${editor.kind === 'team' ? 'lab_team' : 'subgroup'}`, { id, course_id: snapshot.course.id, group_id: groupId, name: name.trim(), user_ids: selected, ...(editor.kind === 'team' ? { item_id: itemId } : {}), version: editor.copy ? 0 : editor.initial?.version || 0, expected_user_id: userId }); await onSaved() } catch (error) { setError(teachingError(error)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title={editor.kind === 'team' ? editor.copy ? 'Команда для іншої роботи' : 'Команда лабораторної' : 'Навчальна підгрупа'} description="Лише прийняті учасники цієї навчальної групи та цього предмета." onClose={onClose} busy={busy}><form className="teaching-form" onSubmit={event => void save(event)}><TeachingField label="Назва"><input className={teachingInput} value={name} onChange={event => setName(event.target.value)} maxLength={120} required disabled={busy} placeholder={editor.kind === 'team' ? 'Команда 1' : 'Іноземна мова · підгрупа 1'} /></TeachingField>{editor.kind === 'team' && <><TeachingField label="Робота"><select className={teachingInput} required value={itemId} disabled={busy || Boolean(editor.initial && !editor.copy)} onChange={event => setItemId(event.target.value)}><option value="">Оберіть роботу</option>{assignments.filter(item => !editor.copy || item.id !== (editor.initial as TeachingLabTeam)?.item_id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></TeachingField><TeachingField label="Взяти склад із підгрупи" hint="Після вибору склад можна змінити вручну."><select className={teachingInput} value={seed} disabled={busy} onChange={event => { setSeed(event.target.value); const subgroup = context.subgroups.find(item => item.id === event.target.value); if (subgroup) setSelected(subgroup.user_ids.filter(id => available.some(member => member.user_id === id))) }}><option value="">Оберіть вручну</option>{context.subgroups.filter(item => item.group_id === groupId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></TeachingField></>}
    <fieldset className="teaching-audience-roster" disabled={busy}><legend>Учасники · обрано {selected.length}</legend>{available.map(member => <label key={member.user_id}><input type="checkbox" checked={selected.includes(member.user_id)} onChange={() => setSelected(value => value.includes(member.user_id) ? value.filter(id => id !== member.user_id) : [...value, member.user_id])} /><span>{member.full_name}{member.username && <small>@{member.username}</small>}</span></label>)}{!available.length && <p>У цій групі поки немає доступних учасників.</p>}</fieldset>{error && <p role="alert" className="teaching-error">{error}</p>}<div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>Скасувати</TeachingButton><TeachingButton primary type="submit" busy={busy}>Зберегти склад</TeachingButton></div></form></TeachingModal>
}
