import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Loader2, RefreshCw, Search, ShieldCheck, UserRoundPlus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  STUDY_GROUP_PERMISSIONS, assignStudyGroupDeputy, isStudyGroupDeputySchemaMissing,
  loadStudyGroupDeputies, revokeStudyGroupDeputy, studyGroupDeputyError, updateStudyGroupDeputyPermissions,
  type StudyGroupDeputyRequest, type StudyGroupPermission,
} from '../lib/studyGroupDeputies'
import type { StudyGroupMember } from '../lib/studyGroupMembers'

export type StudyGroupDeputiesProps = {
  groupId: string
  currentUserId: string
  isRepresentative: boolean
  representativeId: string
  members: StudyGroupMember[]
  onPermissionsChange?: () => void
}

const button = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50'
const primaryButton = `${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`
function ProfileLink({ member, currentUserId }: { member: Pick<StudyGroupMember, 'user_id' | 'profile'>; currentUserId: string }) {
  const name = member.profile?.full_name || (member.profile?.username ? `@${member.profile.username}` : 'Учасник Xelay')
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return <Link to="/user/$id" params={{ id: member.user_id }} aria-label={`Переглянути профіль: ${name}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-sm font-semibold text-primary">
      {member.profile?.avatar_url ? <img src={member.profile.avatar_url} alt="" loading="lazy" className="h-full w-full object-cover" /> : initials}
    </span>
    <span className="min-w-0"><span className="block truncate text-sm font-semibold">{name}{member.user_id === currentUserId && <span className="ml-1 font-normal text-muted-foreground">(ви)</span>}</span>
      <span className="block truncate text-xs text-muted-foreground">{member.profile?.username ? `@${member.profile.username}` : 'Відкрити профіль'}</span></span>
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

function DeputiesWorkspace({ groupId, currentUserId, isRepresentative, representativeId, members, onPermissionsChange }: StudyGroupDeputiesProps) {
  const [requests, setRequests] = useState<StudyGroupDeputyRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [schemaUnavailable, setSchemaUnavailable] = useState(false)
  const [profilesUnavailable, setProfilesUnavailable] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [showAssignmentForm, setShowAssignmentForm] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [selectedMemberId, setSelectedMemberId] = useState('')
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
      setEditingId((id) => result.requests.some((request) => request.id === id && request.status === 'approved') ? id : '')
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
    setShowAssignmentForm(false)
    setSelectedMemberId('')
    setMemberQuery('')
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

  const approved = useMemo(() => requests.filter((request) => request.status === 'approved' && request.user_id !== representativeId), [requests, representativeId])
  const eligibleMembers = useMemo(() => {
    const approvedIds = new Set(approved.map((deputy) => deputy.user_id))
    const unique = new Map(members.filter((member) => member.group_id === groupId && member.status === 'accepted'
      && member.user_id !== representativeId && !approvedIds.has(member.user_id)).map((member) => [member.user_id, member]))
    return [...unique.values()].sort((left, right) => (left.profile?.full_name || left.profile?.username || '').localeCompare(right.profile?.full_name || right.profile?.username || '', 'uk-UA'))
  }, [approved, members, groupId, representativeId])
  const visibleMembers = useMemo(() => {
    const query = memberQuery.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
    return eligibleMembers.filter((member) => !query || [member.profile?.full_name, member.profile?.username]
      .some((value) => value?.toLocaleLowerCase('uk-UA').includes(query)))
  }, [eligibleMembers, memberQuery])
  const selectedMember = eligibleMembers.find((member) => member.user_id === selectedMemberId)
  const own = approved.find((request) => request.user_id === currentUserId)
  const unavailable = loading || Boolean(loadError) || schemaUnavailable || Boolean(busy)

  useEffect(() => {
    if (selectedMemberId && !eligibleMembers.some((member) => member.user_id === selectedMemberId)) setSelectedMemberId('')
  }, [eligibleMembers, selectedMemberId])

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
      setShowAssignmentForm(false)
      setSelectedMemberId('')
      setMemberQuery('')
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
    if (!isRepresentative || unavailable || request.status !== 'approved') return
    setActionError('')
    setNotice('')
    setConfirmRevokeId('')
    setShowAssignmentForm(false)
    setSelectedPermissions([...request.permissions])
    setEditingId((id) => id === request.id ? '' : request.id)
  }

  const editor = (request: StudyGroupDeputyRequest) => editingId === request.id && isRepresentative && <div className="mt-4 rounded-xl border border-border bg-background p-3 sm:p-4">
    <PermissionPicker requestId={request.id} selected={selectedPermissions} onChange={setSelectedPermissions} disabled={unavailable} />
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" className={primaryButton} disabled={unavailable} onClick={() => void runAction(request.id,
        () => updateStudyGroupDeputyPermissions(request.id, selectedPermissions),
        'Права заступника збережено.')}>{busy === request.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Зберегти права</button>
      <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setEditingId('')}>Скасувати</button>
    </div>
  </div>

  return <section className="mt-6 rounded-2xl border border-border bg-background p-4 sm:p-5" aria-label="Заступники старости">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck size={18} className="text-primary" />Заступники старости</h3>
      <button type="button" className={button} disabled={loading || Boolean(busy)} onClick={() => { setLoading(true); void reload() }} aria-label="Оновити список заступників"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Оновити</button></div>
    <p className="mt-2 text-sm text-muted-foreground">Староста призначає заступників із учасників цієї групи та окремо обирає права кожного. Права можна змінити будь-коли.</p>
    {loadError && <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>}
    {profilesUnavailable && !loadError && <p className="mt-3 text-xs text-muted-foreground">Частину профілів не вдалося завантажити. Оновіть список, щоб побачити імена та фотографії.</p>}
    {actionError && <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>}
    {notice && <p role="status" className="mt-3 rounded-xl bg-primary/10 p-3 text-sm text-primary">{notice}</p>}
    {loading && !requests.length && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={15} className="animate-spin" />Завантаження заступників…</p>}

    {!isRepresentative && !loading && !loadError && <div className="mt-5 rounded-xl border border-border p-3 sm:p-4">
      {own ? <><p className="text-sm font-semibold text-primary">Ви — заступник старости цієї групи</p><p className="mt-1 text-xs text-muted-foreground">Ваші права:</p><div className="mt-3"><PermissionList permissions={own.permissions} /></div></>
        : <p className="text-sm text-muted-foreground">Заступника призначає староста. Після призначення ваші права з’являться тут.</p>}
    </div>}

    {isRepresentative && <div className="mt-5">
      <button type="button" className={primaryButton} disabled={unavailable} aria-expanded={showAssignmentForm} aria-controls={`deputy-assignment-${groupId}`} onClick={() => {
        setShowAssignmentForm((value) => !value)
        setEditingId('')
        setConfirmRevokeId('')
        setSelectedMemberId('')
        setSelectedPermissions([])
        setMemberQuery('')
        setActionError('')
        setNotice('')
      }}><UserRoundPlus size={15} />Призначити заступником</button>
      {showAssignmentForm && <form id={`deputy-assignment-${groupId}`} className="mt-4 rounded-xl border border-border p-3 sm:p-4" onSubmit={(event) => {
        event.preventDefault()
        if (!isRepresentative || !selectedMember || unavailable) return
        void runAction('assign', () => assignStudyGroupDeputy(groupId, selectedMember.user_id, selectedPermissions), 'Учасника призначено заступником. Права можна змінити у списку нижче.')
      }}>
        <h4 className="text-sm font-semibold">Оберіть учасника групи</h4>
        <p className="mt-1 text-xs text-muted-foreground">Можна призначити кількох заступників із різними правами.</p>
        <label className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2.5">
          <Search size={16} className="shrink-0 text-muted-foreground" /><span className="sr-only">Знайти учасника для призначення заступником</span>
          <input type="search" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} disabled={unavailable} placeholder="Ім’я або нік учасника" maxLength={120} className="min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-50" />
        </label>
        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto" role="group" aria-label="Учасники для призначення">
          {visibleMembers.map((member) => {
            const selected = member.user_id === selectedMemberId
            const name = member.profile?.full_name || (member.profile?.username ? `@${member.profile.username}` : 'Учасник Xelay')
            return <div key={member.user_id} className={`flex min-w-0 flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center ${selected ? 'border-primary bg-primary/5' : 'border-border'}`}>
              <ProfileLink member={member} currentUserId={currentUserId} />
              <button type="button" disabled={unavailable} aria-pressed={selected} aria-label={`${selected ? 'Обрано' : 'Обрати'}: ${name}`} className={`${button} shrink-0 ${selected ? 'border-primary text-primary' : ''}`} onClick={() => {
                if (!selected) setSelectedPermissions([])
                setSelectedMemberId(member.user_id)
                setActionError('')
              }}>{selected && <Check size={14} />}{selected ? 'Обрано' : 'Обрати'}</button>
            </div>
          })}
          {!visibleMembers.length && <p className="py-3 text-sm text-muted-foreground">{eligibleMembers.length ? 'Учасників за цим ім’ям чи ніком не знайдено.' : 'Усі доступні учасники вже є заступниками або ще не прийняли запрошення до групи.'}</p>}
        </div>
        {selectedMember && <div className="mt-4 border-t border-border pt-4"><p className="mb-3 text-sm font-medium">Права для: {selectedMember.profile?.full_name || (selectedMember.profile?.username ? `@${selectedMember.profile.username}` : 'Учасник Xelay')}</p><PermissionPicker requestId={`assign-${groupId}`} selected={selectedPermissions} onChange={setSelectedPermissions} disabled={unavailable} /></div>}
        <div className="mt-4 flex flex-wrap gap-2"><button type="submit" className={primaryButton} disabled={unavailable || !selectedMember}>{busy === 'assign' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Призначити заступником</button>
          <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { setShowAssignmentForm(false); setSelectedMemberId('') }}>Скасувати</button></div>
      </form>}
    </div>}

    <div className="mt-5"><h4 className="text-sm font-semibold">Заступники групи {approved.length > 0 && <span className="ml-1 text-muted-foreground">· {approved.length}</span>}</h4>
      {!loading && !approved.length && !loadError && <p className="mt-2 text-sm text-muted-foreground">Заступників ще не призначено.</p>}
      <div className="mt-3 space-y-3">{approved.map((request) => <article key={request.id} className="min-w-0 rounded-xl border border-border p-3 sm:p-4">
        <ProfileLink member={{ user_id: request.user_id, profile: request.profile || members.find((member) => member.user_id === request.user_id)?.profile }} currentUserId={currentUserId} />
        <div className="mt-3"><PermissionList permissions={request.permissions} /></div>
        {isRepresentative && <><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={unavailable} onClick={() => openEditor(request)}><ShieldCheck size={14} />Змінити права</button>
          <button type="button" className={`${button} text-destructive`} disabled={unavailable} onClick={() => { setShowAssignmentForm(false); setEditingId(''); setConfirmRevokeId(request.id); setActionError(''); setNotice('') }}><X size={14} />Припинити повноваження</button></div>
          {confirmRevokeId === request.id && <div className="mt-3 rounded-xl bg-destructive/10 p-3"><p className="text-sm">Припинити повноваження цього заступника? Він залишиться учасником групи.</p><div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={`${button} border-destructive text-destructive`} disabled={unavailable} onClick={() => void runAction(request.id, () => revokeStudyGroupDeputy(request.id), 'Повноваження заступника припинено.')}>{busy === request.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}Припинити</button>
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setConfirmRevokeId('')}>Залишити заступником</button>
          </div></div>}
          {editor(request)}</>}
      </article>)}</div>
    </div>
  </section>
}
