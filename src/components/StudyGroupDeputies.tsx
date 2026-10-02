import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, ChevronDown, Loader2, RefreshCw, ShieldCheck, UserRoundPlus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  STUDY_GROUP_PERMISSIONS, cancelStudyGroupDeputyRequest, isStudyGroupDeputySchemaMissing,
  loadStudyGroupDeputies, reviewStudyGroupDeputyRequest, revokeStudyGroupDeputy,
  studyGroupDeputyError, submitStudyGroupDeputyRequest, updateStudyGroupDeputyPermissions,
  type StudyGroupDeputyRequest, type StudyGroupDeputyStatus, type StudyGroupPermission,
} from '../lib/studyGroupDeputies'

export type StudyGroupDeputiesProps = {
  groupId: string
  currentUserId: string
  isRepresentative: boolean
  onPermissionsChange?: () => void
}

const button = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50'
const primaryButton = `${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`
const statusLabels: Record<StudyGroupDeputyStatus, string> = {
  pending: 'Очікує рішення старости', approved: 'Призначено заступником', rejected: 'Заявку відхилено',
  cancelled: 'Заявку скасовано', revoked: 'Повноваження припинено',
}

function ProfileLink({ request, currentUserId }: { request: StudyGroupDeputyRequest; currentUserId: string }) {
  const name = request.profile?.full_name || (request.profile?.username ? `@${request.profile.username}` : 'Учасник Xelay')
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return <Link to="/user/$id" params={{ id: request.user_id }} aria-label={`Переглянути профіль: ${name}`} className="flex min-w-0 items-center gap-3 rounded-xl hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-sm font-semibold text-primary">
      {request.profile?.avatar_url ? <img src={request.profile.avatar_url} alt="" loading="lazy" className="h-full w-full object-cover" /> : initials}
    </span>
    <span className="min-w-0"><span className="block truncate text-sm font-semibold">{name}{request.user_id === currentUserId && <span className="ml-1 font-normal text-muted-foreground">(ви)</span>}</span>
      <span className="block truncate text-xs text-muted-foreground">{request.profile?.username ? `@${request.profile.username}` : 'Відкрити профіль'}</span></span>
  </Link>
}

function PermissionList({ permissions }: { permissions: StudyGroupPermission[] }) {
  return permissions.length ? <ul className="flex flex-wrap gap-1.5" aria-label="Призначені права">{STUDY_GROUP_PERMISSIONS.filter(({ key }) => permissions.includes(key)).map(({ key, label }) => <li key={key} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{label}</li>)}</ul>
    : <p className="text-xs text-muted-foreground">Староста ще не призначив права на редагування.</p>
}

function PermissionPicker({ selected, onChange, disabled, requestId }: {
  selected: StudyGroupPermission[]; onChange: (value: StudyGroupPermission[]) => void; disabled: boolean; requestId: string
}) {
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-sm font-medium">Що може робити заступник</legend>
    {STUDY_GROUP_PERMISSIONS.map(({ key, label, description }) => <label key={key} htmlFor={`deputy-${requestId}-${key}`} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-muted/50">
      <input id={`deputy-${requestId}-${key}`} type="checkbox" checked={selected.includes(key)} onChange={(event) => onChange(event.target.checked ? [...selected, key] : selected.filter((item) => item !== key))} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
      <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{description}</span></span>
    </label>)}
    <p className="text-xs text-muted-foreground">Права діють у цій групі. Їх можна змінити будь-коли або призначити заступника без прав на редагування.</p>
  </fieldset>
}

export function StudyGroupDeputies(props: StudyGroupDeputiesProps) {
  return <DeputiesWorkspace key={`${props.groupId}:${props.currentUserId}`} {...props} />
}

function DeputiesWorkspace({ groupId, currentUserId, isRepresentative, onPermissionsChange }: StudyGroupDeputiesProps) {
  const [requests, setRequests] = useState<StudyGroupDeputyRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [schemaUnavailable, setSchemaUnavailable] = useState(false)
  const [profilesUnavailable, setProfilesUnavailable] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [editingId, setEditingId] = useState('')
  const [selectedPermissions, setSelectedPermissions] = useState<StudyGroupPermission[]>([])
  const [confirmRevokeId, setConfirmRevokeId] = useState('')
  const mounted = useRef(true)
  const sequence = useRef(0)
  const actionLock = useRef(false)
  const accessSignature = useRef<string | null>(null)
  const permissionsCallback = useRef(onPermissionsChange)
  permissionsCallback.current = onPermissionsChange

  const reload = useCallback(async () => {
    const requestSequence = ++sequence.current
    const valid = () => mounted.current && sequence.current === requestSequence
    try {
      const result = await loadStudyGroupDeputies(groupId)
      if (!valid()) return
      setRequests(result.requests)
      setProfilesUnavailable(result.profilesUnavailable)
      setLoadError('')
      setSchemaUnavailable(false)
      const signature = result.requests.filter((request) => request.status === 'approved')
        .map((request) => `${request.id}:${request.user_id}:${request.permissions.join(',')}`).sort().join('|')
      const changed = accessSignature.current !== null && accessSignature.current !== signature
      accessSignature.current = signature
      if (changed) permissionsCallback.current?.()
      setEditingId((id) => result.requests.some((request) => request.id === id && ['pending', 'approved'].includes(request.status)) ? id : '')
      setConfirmRevokeId((id) => result.requests.some((request) => request.id === id && request.status === 'approved') ? id : '')
    } catch (error) {
      if (!valid()) return
      setLoadError(studyGroupDeputyError(error))
      setSchemaUnavailable(isStudyGroupDeputySchemaMissing(error))
    } finally {
      if (valid()) setLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++sequence.current }
  }, [])

  useEffect(() => {
    setLoading(true)
    setEditingId('')
    setConfirmRevokeId('')
    setActionError('')
    setNotice('')
    void reload()
    const refresh = () => { if (!actionLock.current) void reload() }
    const channel = supabase.channel(`study-group-deputies:${groupId}:${currentUserId}:${isRepresentative}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_deputy_requests', filter: `group_id=eq.${groupId}` }, refresh)
      .subscribe()
    window.addEventListener('focus', refresh)
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 60000)
    return () => { ++sequence.current; void supabase.removeChannel(channel); window.removeEventListener('focus', refresh); window.clearInterval(interval) }
  }, [groupId, currentUserId, isRepresentative, reload])

  const approved = requests.filter((request) => request.status === 'approved')
  const pending = isRepresentative ? requests.filter((request) => request.status === 'pending') : []
  const own = requests.find((request) => request.user_id === currentUserId)
  const unavailable = loading || Boolean(loadError) || schemaUnavailable || Boolean(busy)

  const runAction = async (key: string, perform: () => Promise<unknown>, success: string) => {
    if (actionLock.current || unavailable) return
    actionLock.current = true
    ++sequence.current
    setBusy(key)
    setActionError('')
    setNotice('')
    try {
      await perform()
      if (!mounted.current) return
      setEditingId('')
      setConfirmRevokeId('')
      setMessage('')
      setNotice(success)
      permissionsCallback.current?.()
      await reload()
    } catch (error) {
      if (!mounted.current) return
      setActionError(studyGroupDeputyError(error))
      const missingSchema = isStudyGroupDeputySchemaMissing(error)
      if (missingSchema) { setSchemaUnavailable(true); setLoadError(studyGroupDeputyError(error)) }
      permissionsCallback.current?.()
      if (!missingSchema) await reload()
    } finally {
      actionLock.current = false
      if (mounted.current) setBusy('')
    }
  }

  const openEditor = (request: StudyGroupDeputyRequest) => {
    if (!isRepresentative || unavailable) return
    setActionError('')
    setNotice('')
    setConfirmRevokeId('')
    setSelectedPermissions(request.status === 'approved' ? [...request.permissions] : [])
    setEditingId((id) => id === request.id ? '' : request.id)
  }

  const editor = (request: StudyGroupDeputyRequest) => editingId === request.id && isRepresentative && <div className="mt-4 rounded-xl border border-border bg-background p-3 sm:p-4">
    <PermissionPicker requestId={request.id} selected={selectedPermissions} onChange={setSelectedPermissions} disabled={unavailable} />
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" className={primaryButton} disabled={unavailable} onClick={() => void runAction(request.id,
        () => request.status === 'pending' ? reviewStudyGroupDeputyRequest(request.id, true, selectedPermissions) : updateStudyGroupDeputyPermissions(request.id, selectedPermissions),
        request.status === 'pending' ? 'Учасника призначено заступником.' : 'Права заступника збережено.')}>{busy === request.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}{request.status === 'pending' ? 'Призначити заступником' : 'Зберегти права'}</button>
      <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setEditingId('')}>Скасувати</button>
    </div>
  </div>

  return <section className="mt-6 rounded-2xl border border-border bg-background p-4 sm:p-5" aria-label="Заступники старости">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck size={18} className="text-primary" />Заступники старости</h3>
      <button type="button" className={button} disabled={loading || Boolean(busy)} onClick={() => { setLoading(true); void reload() }} aria-label="Оновити список заступників"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Оновити</button></div>
    <p className="mt-2 text-sm text-muted-foreground">У групі може бути кілька заступників. Староста розглядає заявки й окремо обирає права кожного.</p>
    {loadError && <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>}
    {profilesUnavailable && !loadError && <p className="mt-3 text-xs text-muted-foreground">Частину профілів не вдалося завантажити. Оновіть список, щоб побачити імена та фотографії.</p>}
    {actionError && <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>}
    {notice && <p role="status" className="mt-3 rounded-xl bg-primary/10 p-3 text-sm text-primary">{notice}</p>}
    {loading && !requests.length && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={15} className="animate-spin" />Завантаження заявок…</p>}

    {!isRepresentative && !loading && !loadError && <div className="mt-5 rounded-xl border border-border p-3 sm:p-4">
      {own?.status === 'pending' ? <><p className="text-sm font-semibold">Ваша заявка очікує рішення старости</p><p className="mt-1 text-xs text-muted-foreground">Після призначення ви побачите свої права у цьому розділі.</p>
        {own.message && <p className="mt-3 whitespace-pre-wrap break-words text-sm">{own.message}</p>}
        <button type="button" disabled={unavailable} className={`${button} mt-3`} onClick={() => void runAction(own.id, () => cancelStudyGroupDeputyRequest(own.id), 'Заявку скасовано. Ви можете подати нову.')}>{busy === own.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}Скасувати заявку</button></>
        : own?.status === 'approved' ? <><p className="text-sm font-semibold text-primary">Ви — заступник старости цієї групи</p><p className="mt-1 text-xs text-muted-foreground">Ваші права:</p><div className="mt-3"><PermissionList permissions={own.permissions} /></div></>
          : <form onSubmit={(event) => { event.preventDefault(); void runAction('submit', () => submitStudyGroupDeputyRequest(groupId, message), 'Заявку надіслано старості.') }}>
            <p className="text-sm font-semibold">Стати заступником старости</p>
            {own && <p className="mt-1 text-xs text-muted-foreground">{statusLabels[own.status]}. Ви можете подати нову заявку.</p>}
            <label htmlFor={`deputy-request-${groupId}`} className="mt-3 block text-xs font-medium">Повідомлення старості (необов’язково)</label>
            <textarea id={`deputy-request-${groupId}`} value={message} onChange={(event) => setMessage(event.target.value)} disabled={unavailable} maxLength={1000} rows={3} placeholder="Напишіть, з чим хочете допомагати групі" className="mt-1 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50" />
            <span className="block text-right text-xs text-muted-foreground">{message.length}/1000</span>
            <button type="submit" disabled={unavailable} className={`${primaryButton} mt-3`}>{busy === 'submit' ? <Loader2 size={14} className="animate-spin" /> : <UserRoundPlus size={14} />}Подати заявку</button>
          </form>}
    </div>}

    {isRepresentative && <div className="mt-5"><h4 className="text-sm font-semibold">Заявки на розгляд {pending.length > 0 && <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{pending.length}</span>}</h4>
      {!loading && !pending.length && !loadError && <p className="mt-2 text-sm text-muted-foreground">Нових заявок поки немає.</p>}
      <div className="mt-3 space-y-3">{pending.map((request) => <article key={request.id} className="min-w-0 rounded-xl border border-border p-3 sm:p-4">
        <ProfileLink request={request} currentUserId={currentUserId} />
        <p className="mt-2 text-xs text-muted-foreground">{new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(request.created_at))}</p>
        {request.message && <p className="mt-3 whitespace-pre-wrap break-words text-sm">{request.message}</p>}
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={unavailable} onClick={() => openEditor(request)}><ShieldCheck size={14} />Обрати права<ChevronDown size={14} className={editingId === request.id ? 'rotate-180' : ''} /></button>
          <button type="button" className={`${button} text-destructive`} disabled={unavailable} onClick={() => void runAction(request.id, () => reviewStudyGroupDeputyRequest(request.id, false, []), 'Заявку відхилено.')}>{busy === request.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}Відхилити</button></div>
        {editor(request)}
      </article>)}</div>
    </div>}

    <div className="mt-5"><h4 className="text-sm font-semibold">Заступники групи {approved.length > 0 && <span className="ml-1 text-muted-foreground">· {approved.length}</span>}</h4>
      {!loading && !approved.length && !loadError && <p className="mt-2 text-sm text-muted-foreground">Заступників ще не призначено.</p>}
      <div className="mt-3 space-y-3">{approved.map((request) => <article key={request.id} className="min-w-0 rounded-xl border border-border p-3 sm:p-4">
        <ProfileLink request={request} currentUserId={currentUserId} />
        <div className="mt-3"><PermissionList permissions={request.permissions} /></div>
        {isRepresentative && <><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={unavailable} onClick={() => openEditor(request)}><ShieldCheck size={14} />Змінити права</button>
          <button type="button" className={`${button} text-destructive`} disabled={unavailable} onClick={() => { setEditingId(''); setConfirmRevokeId(request.id); setActionError(''); setNotice('') }}><X size={14} />Припинити повноваження</button></div>
          {confirmRevokeId === request.id && <div className="mt-3 rounded-xl bg-destructive/10 p-3"><p className="text-sm">Припинити повноваження цього заступника? Він залишиться учасником групи.</p><div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={`${button} border-destructive text-destructive`} disabled={unavailable} onClick={() => void runAction(request.id, () => revokeStudyGroupDeputy(request.id), 'Повноваження заступника припинено.')}>{busy === request.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}Припинити</button>
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setConfirmRevokeId('')}>Залишити заступником</button>
          </div></div>}
          {editor(request)}</>}
      </article>)}</div>
    </div>
  </section>
}
