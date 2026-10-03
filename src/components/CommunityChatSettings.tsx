import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Check, Copy, ImagePlus, Link2, Loader2, Plus, Search, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import {
  CHAT_AVATAR_BUCKET, chatError, chatInviteUrl, chatRpc, loadChatContacts, loadChatProfiles, searchChatInvitees,
  type ChatInviteLink, type ChatProfile, type ChatSpace, type ChatSpaceDetail, type ChatSpaceKind,
} from '../lib/chatSpaces'
import { supabase } from '../lib/supabase'
import { useToast } from '../context/ToastContext'
import { isValidUserSearch, normalizeUserSearch } from '../lib/userSearch'
import { ChatDialog, ChatField, ChatPerson, chatButton, chatInput, chatPrimary } from './CommunityChatPrimitives'

type Props = { userId: string; kind: ChatSpaceKind; space?: ChatSpace; isOwner?: boolean; onClose: () => void; onSaved: (id: string, kind: ChatSpaceKind) => Promise<void> }
export function CommunityChatEditor({ userId, kind, space, isOwner = true, onClose, onSaved }: Props) {
  const { notify, dismiss } = useToast()
  const feedbackId = `chat-editor-${space?.id || kind}`
  const errorId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const avatarRef = useRef<HTMLInputElement>(null)
  const [invalidField, setInvalidField] = useState<'name' | 'username' | 'avatar' | null>(null)
  const [name, setName] = useState(space?.name || '')
  const [description, setDescription] = useState(space?.description || '')
  const [visibility, setVisibility] = useState<'public' | 'private'>(space?.visibility || 'private')
  const [username, setUsername] = useState(space?.username || '')
  const [comments, setComments] = useState(space?.comments_enabled ?? true)
  const [approval, setApproval] = useState(space?.join_approval ?? false)
  const [history, setHistory] = useState(space?.history_visible ?? true)
  const [avatar, setAvatar] = useState<File | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const [avatarPreview, setAvatarPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const alive = useRef(true)
  const faculty = space?.system_kind === 'faculty'
  const previewUrl = avatar ? avatarPreview : (!removeAvatar ? space?.avatar_url : null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!avatar) { setAvatarPreview(''); return }
    const url = URL.createObjectURL(avatar)
    setAvatarPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [avatar])
  const chooseAvatar = (file: File | null) => {
    if (file && (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024)) { validationError('Аватар: JPG, PNG, WebP або GIF до 5 МБ.', 'avatar'); return }
    setAvatar(file); setRemoveAvatar(false); setError(''); setInvalidField(null)
  }
  const validationError = (message: string, field: 'name' | 'username' | 'avatar') => {
    setError(message); setInvalidField(field)
    notify({ id: feedbackId, tone: 'warning', title: 'Перевірте налаштування', description: message })
    const input = { name: nameRef, username: usernameRef, avatar: avatarRef }[field]
    input.current?.focus()
  }
  const discardAvatar = async (path: string) => {
    try {
      const result = await supabase.storage.from(CHAT_AVATAR_BUCKET).remove([path])
      if (result.error) throw result.error
      return true
    } catch (failure) { console.error('[Xelay] Could not remove unused chat avatar:', failure); return false }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!alive.current || working.current) return
    if (!name.trim()) { validationError('Вкажіть назву.', 'name'); return }
    if (!faculty && visibility === 'public' && !/^[a-z][a-z0-9_]{3,31}$/i.test(username.replace(/^@/, ''))) { validationError('Публічна адреса: 4–32 латинські літери, цифри або _. Перший символ — літера.', 'username'); return }
    if (avatar && (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(avatar.type) || avatar.size > 5 * 1024 * 1024)) { validationError('Аватар: JPG, PNG, WebP або GIF до 5 МБ.', 'avatar'); return }
    working.current = true; setBusy(true); setError(''); setInvalidField(null); dismiss(feedbackId)
    let uploaded = ''
    let committed = false
    try {
      let avatarPath = removeAvatar ? null : space?.avatar_path || null
      if (avatar) {
        uploaded = `${userId}/${crypto.randomUUID()}/avatar.${avatar.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'png'}`
        const result = await supabase.storage.from(CHAT_AVATAR_BUCKET).upload(uploaded, avatar, { contentType: avatar.type, upsert: false })
        if (result.error) throw result.error
        avatarPath = uploaded
      }
      if (!alive.current) { if (uploaded) await discardAvatar(uploaded); uploaded = ''; return }
      const fields = { visibility, name: name.trim(), username: visibility === 'public' ? username.replace(/^@/, '').toLowerCase() : null, description, avatar_path: avatarPath, comments_enabled: comments, join_approval: approval, history_visible: kind === 'channel' ? true : history }
      let id = space?.id || ''
      if (space) {
        const changes: Record<string, unknown> = faculty ? { description, avatar_path: avatarPath } : { ...fields }
        if (!faculty && !isOwner) delete changes.comments_enabled
        await chatRpc('xelay_chat_update', { p_space_id: space.id, p_changes: changes })
      }
      else id = await chatRpc<string>('xelay_chat_create', { p_kind: kind, p_visibility: fields.visibility, p_name: fields.name, p_username: fields.username, p_description: fields.description, p_avatar_path: fields.avatar_path, p_comments_enabled: fields.comments_enabled, p_join_approval: fields.join_approval, p_history_visible: fields.history_visible })
      committed = true
      uploaded = ''
      if (!alive.current) return
      await onSaved(id, kind)
      notify({ id: feedbackId, tone: 'success', title: space ? 'Налаштування збережено' : kind === 'channel' ? 'Канал створено' : 'Групу створено' })
      onClose()
    } catch (failure) {
      if (committed) {
        notify({ id: feedbackId, tone: 'warning', title: space ? 'Налаштування збережено' : kind === 'channel' ? 'Канал створено' : 'Групу створено', description: 'Не вдалося оновити перегляд. Оновіть сторінку, щоб побачити зміни; повторювати збереження не потрібно.' })
        if (alive.current) onClose()
      } else {
        const cleaned = !uploaded || await discardAvatar(uploaded)
        const message = `${chatError(failure)}${cleaned ? '' : ' Не вдалося прибрати невикористане фото.'}`
        if (alive.current) {
          setError(message)
          notify({ id: feedbackId, tone: 'error', title: space ? 'Налаштування не збережено' : 'Не вдалося створити чат', description: message })
        }
      }
    } finally { working.current = false; if (alive.current) setBusy(false) }
  }
  return <ChatDialog title={space ? `Налаштування ${kind === 'channel' ? 'каналу' : 'групи'}` : `Створити ${kind === 'channel' ? 'канал' : 'групу'}`} busy={busy} onClose={onClose}>
    <form onSubmit={submit} aria-busy={busy} onChangeCapture={() => { setError(''); setInvalidField(null) }} className="space-y-4">
      <ChatField label="Назва"><input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required aria-invalid={invalidField === 'name' || undefined} aria-describedby={invalidField === 'name' ? errorId : undefined} className={`${chatInput} ${invalidField === 'name' ? 'xelay-field-invalid' : ''}`} disabled={busy || faculty} /></ChatField>
      {faculty && <p className="text-xs text-muted-foreground">Назва й доступ пов’язані з факультетом. Адміністратори чату можуть змінювати опис і фото.</p>}
      <ChatField label="Опис"><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={3} className={chatInput} disabled={busy} /></ChatField>
      <ChatField label="Фото"><span className="flex flex-wrap items-center gap-3">{previewUrl ? <img src={previewUrl} alt="Попередній перегляд фото чату" className="h-20 w-20 shrink-0 rounded-2xl object-cover" /> : <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><ImagePlus size={26} /></span>}<span className="min-w-0 flex-1"><input ref={avatarRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-invalid={invalidField === 'avatar' || undefined} aria-describedby={invalidField === 'avatar' ? errorId : undefined} disabled={busy} onChange={(event) => { chooseAvatar(event.target.files?.[0] || null); event.target.value = '' }} className={`block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-muted file:px-4 file:py-2 file:font-medium ${invalidField === 'avatar' ? 'xelay-field-invalid' : ''}`} /><span className="mt-1.5 block text-xs text-muted-foreground">JPG, PNG, WebP або GIF до 5 МБ.{avatar && <span className="block truncate">{avatar.name}</span>}</span></span></span></ChatField>
      {space?.avatar_path && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={removeAvatar} onChange={(event) => { setRemoveAvatar(event.target.checked); setAvatar(null) }} disabled={busy} />Прибрати поточне фото</label>}
      {avatar && <button type="button" className={`${chatButton} text-xs`} disabled={busy} onClick={() => setAvatar(null)}>Скасувати вибір фото</button>}
      {!faculty && <>
        <ChatField label="Доступ"><select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)} className={chatInput} disabled={busy}><option value="private">Приватний — лише за запрошенням</option><option value="public">Публічний — доступний у пошуку</option></select></ChatField>
        {visibility === 'public' && <ChatField label="Публічний адрес"><div className="relative"><span className="absolute left-3 top-2.5 text-muted-foreground">@</span><input ref={usernameRef} value={username} onChange={(event) => setUsername(event.target.value.replace(/^@/, ''))} aria-invalid={invalidField === 'username' || undefined} aria-describedby={invalidField === 'username' ? errorId : undefined} className={`${chatInput} pl-8 ${invalidField === 'username' ? 'xelay-field-invalid' : ''}`} maxLength={32} required disabled={busy} autoCapitalize="none" autoCorrect="off" /></div></ChatField>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approval} onChange={(event) => setApproval(event.target.checked)} disabled={busy} className="mt-1" /><span>Підтверджувати заявки на вступ<span className="block text-xs text-muted-foreground">Для публічного вступу й посилань. Особисті запрошення приймаються одразу.</span></span></label>
        {kind === 'channel' ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={comments} onChange={(event) => setComments(event.target.checked)} disabled={busy || !isOwner} />Дозволити коментарі до публікацій{!isOwner && <span className="text-xs text-muted-foreground">(лише власник)</span>}</label> : <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} disabled={busy} className="mt-1" /><span>Показувати попередню історію новим учасникам</span></label>}
      </>}
      {error && <p id={errorId} role="alert" className="xelay-inline-feedback xelay-feedback-error text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={onClose} disabled={busy} className={chatButton}>Скасувати</button><button type="submit" disabled={busy} className={chatPrimary}>{busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}{busy ? space ? 'Зберігаємо…' : 'Створюємо…' : space ? 'Зберегти' : 'Створити'}</button></div>
    </form>
  </ChatDialog>
}

export function CommunityChatManagement({ detail, userId, profiles, onClose, onRefresh, onDeleted }: { detail: ChatSpaceDetail; userId: string; profiles: Record<string, ChatProfile>; onClose: () => void; onRefresh: () => Promise<void>; onDeleted: () => void }) {
  const { notify, dismiss } = useToast()
  const feedbackId = `chat-management-${detail.space.id}`
  const errorId = useId()
  const queryRef = useRef<HTMLInputElement>(null)
  const daysRef = useRef<HTMLInputElement>(null)
  const usesRef = useRef<HTMLInputElement>(null)
  const linkRef = useRef<HTMLInputElement>(null)
  const [invalidField, setInvalidField] = useState<'query' | 'days' | 'uses' | null>(null)
  const [tab, setTab] = useState<'members' | 'invite' | 'requests' | 'links'>('members')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [contacts, setContacts] = useState<ChatProfile[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatProfile[]>([])
  const [searchDone, setSearchDone] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [expiresDays, setExpiresDays] = useState('7')
  const [uses, setUses] = useState('')
  const [newLink, setNewLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState<{ text: string; action: () => Promise<void> } | null>(null)
  const [extraProfiles, setExtraProfiles] = useState<Record<string, ChatProfile>>({})
  const [memberLimit, setMemberLimit] = useState(50)
  const working = useRef(false)
  const mounted = useRef(true)
  const faculty = detail.space.system_kind === 'faculty'
  const owner = !faculty && detail.my_membership?.role === 'owner'
  const canManageAdmins = faculty ? detail.can_manage_admins === true : (detail.can_manage_admins ?? owner)
  const knownProfiles = { ...profiles, ...extraProfiles }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let alive = true
    if (!faculty) void loadChatContacts(userId).then((value) => { if (alive) setContacts(value) }).catch(() => {})
    const ids = [...(detail.invitations || []).flatMap((item) => [item.user_id, item.invited_by]), ...(detail.join_requests || []).map((item) => item.user_id)]
    void loadChatProfiles(ids).then((value) => { if (alive) setExtraProfiles(value) }).catch(() => {})
    return () => { alive = false }
  }, [userId, detail.space.id, detail.invitations, detail.join_requests, faculty])
  const filteredMembers = (detail.members || []).filter((member) => {
    if (member.status === 'left') return false
    const person = knownProfiles[member.user_id]
    return !faculty || !query.trim() || `${person?.full_name || ''} ${person?.username || ''}`.toLocaleLowerCase('uk-UA').includes(query.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA'))
  })
  const run = async (key: string, action: () => Promise<unknown>, successTitle?: string) => {
    if (!mounted.current || working.current) return false
    const titles: Record<string, string> = { promote: 'Адміністратора призначено', demote: 'Права адміністратора знято', transfer: 'Право власності передано', kick: 'Учасника виключено', ban: 'Учасника заблоковано', unban: 'Учасника розблоковано', invite: 'Запрошення надіслано', revoke: 'Запрошення скасовано', 'create-link': 'Посилання створено', delete: detail.space.kind === 'channel' ? 'Канал видалено' : 'Групу видалено' }
    const title = successTitle || titles[key.split(':')[0]] || 'Зміни збережено'
    working.current = true; setBusy(key); setError(''); setInvalidField(null); dismiss(feedbackId)
    let committed = false
    try {
      await action(); committed = true
      await onRefresh()
      notify({ id: feedbackId, tone: 'success', title })
      return true
    } catch (failure) {
      if (committed) {
        const message = 'Дію виконано, але не вдалося оновити перегляд. Оновіть сторінку; повторювати дію не потрібно.'
        if (mounted.current) setError(message)
        notify({ id: feedbackId, tone: 'warning', title, description: message })
        return true
      }
      if (mounted.current) { const message = chatError(failure); setError(message); notify({ id: feedbackId, tone: 'error', title: 'Не вдалося виконати дію', description: message }) }
      return false
    } finally { working.current = false; if (mounted.current) setBusy('') }
  }
  const validationError = (message: string, field: 'query' | 'days' | 'uses') => {
    setError(message); setInvalidField(field)
    notify({ id: feedbackId, tone: 'warning', title: 'Перевірте дані', description: message })
    const input = { query: queryRef, days: daysRef, uses: usesRef }[field]
    input.current?.focus()
  }
  const memberAction = (id: string, action: string, text: string) => setConfirm({ text, action: async () => { await run(`${action}:${id}`, () => chatRpc('xelay_chat_member', { p_space_id: detail.space.id, p_user_id: id, p_action: action })); setConfirm(null) } })
  const search = async (event: FormEvent) => {
    event.preventDefault()
    if (searchBusy) return
    if (!isValidUserSearch(normalizeUserSearch(query))) { validationError('Вкажіть нік із 2–30 літер, цифр, крапок, дефісів або підкреслень.', 'query'); return }
    setSearchBusy(true); setError(''); setInvalidField(null); setSearchDone(false); dismiss(feedbackId); dismiss(`${feedbackId}-search`)
    try {
      const result = await searchChatInvitees(query)
      if (!mounted.current) return
      setResults(result.profiles); setLimitReached(result.limitReached); setSearchDone(true)
      if (result.limitReached) notify({ id: `${feedbackId}-search`, tone: 'warning', title: 'Ліміт пошуків вичерпано', description: 'Скористайтеся контактами нижче або посиланням-запрошенням.' })
      else if (!result.profiles.length) notify({ id: `${feedbackId}-search`, tone: 'info', title: 'Користувачів не знайдено', description: 'Перевірте нік і спробуйте ще раз.' })
    } catch (failure) { if (mounted.current) { const message = chatError(failure); setError(message); notify({ id: `${feedbackId}-search`, tone: 'error', title: 'Пошук не виконано', description: message }) } } finally { if (mounted.current) setSearchBusy(false) }
  }
  const createLink = () => {
    const days = expiresDays ? Number(expiresDays) : null
    const maxUses = uses ? Number(uses) : null
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) { validationError('Вкажіть цілу кількість днів від 1 до 365 або залиште поле порожнім.', 'days'); return }
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000)) { validationError('Вкажіть цілу кількість вступів від 1 до 10 000 або залиште поле порожнім.', 'uses'); return }
    return run('create-link', async () => {
      const link = await chatRpc<ChatInviteLink>('xelay_chat_create_link', { p_space_id: detail.space.id, p_expires_at: days ? new Date(Date.now() + days * 86400000).toISOString() : null, p_max_uses: maxUses })
      if (!link.token) throw new Error('CHAT_INVALID_INPUT')
      setNewLink(chatInviteUrl(link.token)); setCopied(false)
    })
  }
  return <ChatDialog title={detail.space.kind === 'channel' ? 'Керування каналом' : 'Керування групою'} onClose={onClose} busy={Boolean(busy)}>
    {faculty ? <div className="mb-5 space-y-3"><p className="text-sm text-muted-foreground">Спільний чат факультету. Адміністратори чату модерують учасників{canManageAdmins ? ' і призначають інших адміністраторів' : ''}. Вступ залежить від факультету в профілі.</p><input className={chatInput} value={query} onChange={(event) => { setQuery(event.target.value); setMemberLimit(50) }} placeholder="Ім’я або нік учасника" aria-label="Пошук учасника для модерації" maxLength={100} /></div>
      : <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Керування чатом">{([['members', 'Учасники'], ['invite', 'Запросити'], ['requests', `Заявки${detail.join_requests?.length ? ` · ${detail.join_requests.length}` : ''}`], ['links', 'Посилання']] as const).map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} key={key} className={tab === key ? chatPrimary : chatButton} onClick={() => setTab(key)}>{label}</button>)}</div>}
    {error && <p id={errorId} role="alert" className="xelay-inline-feedback xelay-feedback-error mb-4 text-sm text-destructive">{error}</p>}
    {(faculty || tab === 'members') && <div className="space-y-3">
      {(faculty ? filteredMembers.slice(0, memberLimit) : filteredMembers).map((member) => <div key={member.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
        <div className="min-w-0"><ChatPerson id={member.user_id} profile={knownProfiles[member.user_id]} /><span className="ml-11 text-xs text-muted-foreground">{faculty && member.is_platform_admin ? 'Адміністратор платформи' : member.status === 'banned' ? 'Заблокований' : member.role === 'owner' ? 'Власник' : member.role === 'admin' ? 'Адміністратор' : 'Учасник'}</span></div>
        {member.user_id !== userId && member.role !== 'owner' && (!faculty || !member.is_platform_admin) && <div className="flex flex-wrap gap-1">
          {member.status === 'banned' ? <button className={chatButton} disabled={Boolean(busy)} onClick={() => memberAction(member.user_id, 'unban', 'Дозволити цій людині знову вступити до чату?')}>Розблокувати</button> : <>
            {canManageAdmins && <button className={chatButton} disabled={Boolean(busy)} onClick={() => memberAction(member.user_id, member.role === 'admin' ? 'demote' : 'promote', member.role === 'admin' ? 'Зняти права адміністратора?' : 'Призначити адміністратором? Людина зможе модерувати учасників, змінювати опис і фото чату.')}><ShieldCheck size={14} />{member.role === 'admin' ? 'Зняти права' : 'Призначити адміном'}</button>}
            {owner && <button className={chatButton} disabled={Boolean(busy)} onClick={() => memberAction(member.user_id, 'transfer', 'Передати цій людині право власності? Ви станете адміністратором.')}>Передати</button>}
            {(faculty || owner || member.role !== 'admin') && <><button className={chatButton} disabled={Boolean(busy)} onClick={() => memberAction(member.user_id, 'kick', 'Виключити учасника з чату?')}>Виключити</button><button className={`${chatButton} text-destructive`} disabled={Boolean(busy)} onClick={() => memberAction(member.user_id, 'ban', 'Заблокувати учасника? Він не зможе вступити повторно до розблокування.')}>Блок</button></>}
          </>}
        </div>}
      </div>)}
      {faculty && !filteredMembers.length && <p className="text-sm text-muted-foreground">Учасників не знайдено.</p>}
      {faculty && filteredMembers.length > memberLimit && <button className={`${chatButton} w-full`} onClick={() => setMemberLimit((limit) => limit + 50)}>Показати ще · {filteredMembers.length - memberLimit}</button>}
      {owner && <button className={`${chatButton} mt-5 text-destructive`} disabled={Boolean(busy)} onClick={() => setConfirm({ text: `Видалити «${detail.space.name}» разом з усіма повідомленнями? Цю дію неможливо скасувати.`, action: async () => { if (await run('delete', () => chatRpc('xelay_chat_delete', { p_space_id: detail.space.id }))) onDeleted() } })}><Trash2 size={16} />Видалити {detail.space.kind === 'channel' ? 'канал' : 'групу'}</button>}
    </div>}
    {!faculty && tab === 'invite' && <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Людина отримає запрошення та сама підтвердить вступ.</p>
      <form onSubmit={search} aria-busy={searchBusy} className="space-y-2"><div className="flex gap-2"><input ref={queryRef} className={`${chatInput} ${invalidField === 'query' ? 'xelay-field-invalid' : ''}`} value={query} onChange={(event) => { setQuery(event.target.value); setResults([]); setSearchDone(false); if (invalidField === 'query') { setError(''); setInvalidField(null) } }} placeholder="Нік користувача" maxLength={30} aria-label="Нік для запрошення" aria-invalid={invalidField === 'query' || undefined} aria-describedby={invalidField === 'query' ? errorId : undefined} disabled={searchBusy} /><button type="submit" className={chatPrimary} disabled={searchBusy}>{searchBusy ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <Search size={17} aria-hidden="true" />}<span className="sr-only sm:not-sr-only">{searchBusy ? 'Шукаємо…' : 'Знайти'}</span></button></div><p className="text-xs text-muted-foreground">Пошук за ніком використовує звичайний ліміт пошуків людей. Контакти нижче доступні без пошуку.</p></form>
      {limitReached && <p className="text-sm text-primary">Ліміт пошуків на сьогодні вичерпано.</p>}
      <h3 className="text-sm font-semibold">{searchDone ? 'Результати пошуку' : 'Ваші контакти'}</h3>
      {(searchDone ? results : contacts).filter((person) => person.id !== userId).map((person) => {
        const already = detail.members?.some((member) => member.user_id === person.id && member.status === 'active')
        const pending = detail.invitations?.some((item) => item.user_id === person.id && item.status === 'pending')
        return <div key={person.id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3"><ChatPerson id={person.id} profile={person} /><button className={chatButton} disabled={Boolean(busy) || already || pending} onClick={() => run(`invite:${person.id}`, () => chatRpc('xelay_chat_invite', { p_space_id: detail.space.id, p_user_id: person.id }))}>{busy === `invite:${person.id}` ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}{already ? 'У чаті' : pending ? 'Надіслано' : 'Запросити'}</button></div>
      })}
      {searchDone && !results.length && !limitReached && <p className="text-sm text-muted-foreground">Користувачів не знайдено.</p>}
      {!searchDone && !contacts.length && <p className="text-sm text-muted-foreground">Поки немає особистих чатів. Знайдіть людину за ніком або надішліть посилання.</p>}
      {(detail.invitations || []).filter((item) => item.status === 'pending').map((invitation) => <div key={invitation.id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3"><ChatPerson id={invitation.user_id} profile={knownProfiles[invitation.user_id]} /><button className={`${chatButton} text-destructive`} disabled={Boolean(busy)} onClick={() => run(`revoke:${invitation.id}`, () => chatRpc('xelay_chat_revoke_invitation', { p_invitation_id: invitation.id }))}>Скасувати запрошення</button></div>)}
    </div>}
    {!faculty && tab === 'requests' && <div className="space-y-3">{!(detail.join_requests || []).length && <p className="text-sm text-muted-foreground">Нових заявок немає.</p>}{(detail.join_requests || []).map((request) => <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"><ChatPerson id={request.user_id} profile={knownProfiles[request.user_id]} /><div className="flex gap-2"><button className={chatPrimary} disabled={Boolean(busy)} onClick={() => run(request.id, () => chatRpc('xelay_chat_join_request', { p_request_id: request.id, p_accept: true }), 'Заявку прийнято')}><Check size={16} />Прийняти</button><button className={chatButton} disabled={Boolean(busy)} onClick={() => run(request.id, () => chatRpc('xelay_chat_join_request', { p_request_id: request.id, p_accept: false }), 'Заявку відхилено')}>Відхилити</button></div></div>)}</div>}
    {!faculty && tab === 'links' && <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Посилання можна переслати друзям. Для приватного чату це спосіб запросити нових учасників.</p>
      <div className="grid grid-cols-2 gap-3"><ChatField label="Діє, днів"><input ref={daysRef} type="number" value={expiresDays} onChange={(event) => { setExpiresDays(event.target.value); if (invalidField === 'days') { setError(''); setInvalidField(null) } }} min={1} max={365} placeholder="Без строку" aria-invalid={invalidField === 'days' || undefined} aria-describedby={invalidField === 'days' ? errorId : undefined} className={`${chatInput} ${invalidField === 'days' ? 'xelay-field-invalid' : ''}`} /></ChatField><ChatField label="Кількість вступів"><input ref={usesRef} type="number" value={uses} onChange={(event) => { setUses(event.target.value); if (invalidField === 'uses') { setError(''); setInvalidField(null) } }} min={1} max={10000} placeholder="Без ліміту" aria-invalid={invalidField === 'uses' || undefined} aria-describedby={invalidField === 'uses' ? errorId : undefined} className={`${chatInput} ${invalidField === 'uses' ? 'xelay-field-invalid' : ''}`} /></ChatField></div>
      <button className={chatPrimary} disabled={Boolean(busy)} onClick={createLink}><Plus size={16} />Створити посилання</button>
      {newLink && <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3"><input ref={linkRef} className={chatInput} value={newLink} readOnly aria-label="Нове посилання-запрошення" onFocus={(event) => event.target.select()} /><button className={chatButton} onClick={async () => { try { await navigator.clipboard.writeText(newLink); if (mounted.current) { setCopied(true); setError('') } notify({ id: `${feedbackId}-copy`, tone: 'success', title: 'Посилання скопійовано' }) } catch { const message = 'Виділіть і скопіюйте посилання вручну.'; if (mounted.current) { setCopied(false); setError(message); linkRef.current?.focus(); linkRef.current?.select() } notify({ id: `${feedbackId}-copy`, tone: 'warning', title: 'Не вдалося скопіювати посилання', description: message }) } }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Скопійовано' : 'Копіювати'}</button><p className="text-xs text-muted-foreground">Збережіть це посилання. З міркувань безпеки воно показується після створення.</p></div>}
      {(detail.invite_links || []).filter((link) => !link.revoked_at).map((link) => <div key={link.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"><div className="min-w-0 text-sm"><span className="flex items-center gap-2 font-medium"><Link2 size={16} />Посилання</span><span className="block text-xs text-muted-foreground">Вступів: {link.used_count || 0}{link.max_uses ? ` / ${link.max_uses}` : ''} · {link.expires_at ? `до ${new Date(link.expires_at).toLocaleDateString('uk-UA')}` : 'Без строку'}</span></div><button className={`${chatButton} text-destructive`} disabled={Boolean(busy)} onClick={() => run(link.id, () => chatRpc('xelay_chat_revoke_link', { p_link_id: link.id }), 'Посилання вимкнено')}>Вимкнути</button></div>)}
    </div>}
    {confirm && <div className="mt-5 space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4" role="alertdialog" aria-label="Підтвердження дії"><p className="text-sm">{confirm.text}</p><div className="flex gap-2"><button className={chatPrimary} disabled={Boolean(busy)} onClick={() => void confirm.action()}>Підтвердити</button><button className={chatButton} disabled={Boolean(busy)} onClick={() => setConfirm(null)}>Скасувати</button></div></div>}
  </ChatDialog>
}
