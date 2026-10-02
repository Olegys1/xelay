import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, Loader2, MessageCircle, RefreshCw, Search, UserRoundPlus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { loadMemberConnections, type MemberConnection, type StudyGroupMember } from '../lib/studyGroupMembers'

type Props = {
  groupId: string
  currentUserId: string
  representativeId: string
  members: StudyGroupMember[]
  canManage: boolean
  canViewInvitations?: boolean
  canRemoveMembers?: boolean
  deputyIds?: string[]
  onRemove: (member: StudyGroupMember) => Promise<void>
}

const actionButton = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50'

export function StudyGroupMembers({ groupId, currentUserId, representativeId, members, canManage, canViewInvitations = canManage, canRemoveMembers = canManage, deputyIds = [], onRemove }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [connections, setConnections] = useState<Record<string, MemberConnection>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const mounted = useRef(true)
  const sequence = useRef(0)
  const actionLock = useRef(false)
  const identity = `${groupId}:${currentUserId}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const memberIds = members.filter((member) => member.status === 'accepted').map((member) => member.user_id).sort().join(',')

  const reloadConnections = useCallback(async () => {
    const requestSequence = ++sequence.current
    const valid = () => mounted.current && identityRef.current === identity && requestSequence === sequence.current
    try {
      const result = await loadMemberConnections(currentUserId, memberIds ? memberIds.split(',') : [])
      if (!valid()) return
      setConnections(result)
      setError('')
    } catch {
      if (valid()) setError('Не вдалося завантажити стан спілкування. Спробуйте ще раз або відкрийте профіль учасника.')
    } finally {
      if (valid()) setLoading(false)
    }
  }, [currentUserId, identity, memberIds])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++sequence.current }
  }, [])

  useEffect(() => {
    setConnections({})
    setLoading(true)
    setError('')
    setActionError('')
    void reloadConnections()
    const refresh = () => { if (!actionLock.current) void reloadConnections() }
    const channel = supabase.channel(`study-group-connections:${identity}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'connection_requests', filter: `requester_id=eq.${currentUserId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'connection_requests', filter: `recipient_id=eq.${currentUserId}` }, refresh)
      .subscribe()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 60000)
    return () => { ++sequence.current; void supabase.removeChannel(channel); window.removeEventListener('focus', refresh); window.clearInterval(timer) }
  }, [currentUserId, identity, reloadConnections])

  const visibleMembers = useMemo(() => {
    const search = query.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
    return members.filter((member) => (member.status === 'accepted' || (canViewInvitations && member.status === 'pending'))
      && (!search || [member.profile?.full_name, member.profile?.username].some((value) => value?.toLocaleLowerCase('uk-UA').includes(search))))
      .sort((left, right) => {
        const roleOrder = Number(right.user_id === representativeId) - Number(left.user_id === representativeId)
        if (roleOrder) return roleOrder
        const deputyOrder = Number(deputyIds.includes(right.user_id)) - Number(deputyIds.includes(left.user_id))
        if (deputyOrder) return deputyOrder
        const statusOrder = Number(left.status === 'pending') - Number(right.status === 'pending')
        return statusOrder || (left.profile?.full_name || left.profile?.username || '').localeCompare(right.profile?.full_name || right.profile?.username || '', 'uk-UA')
      })
  }, [canViewInvitations, deputyIds, members, query, representativeId])

  const openChat = (conversationId?: string) => {
    void navigate({ to: '/messages', search: { kind: 'personal', ...(conversationId ? { conversation: conversationId } : {}) } })
  }

  const runAction = async (member: StudyGroupMember, action: 'send' | 'accept' | 'reject' | 'remove') => {
    if (actionLock.current || member.user_id === currentUserId || (action === 'remove' && (!canRemoveMembers || member.user_id === representativeId || (currentUserId !== representativeId && deputyIds.includes(member.user_id))))) return
    const owner = identity
    const valid = () => mounted.current && identityRef.current === owner
    actionLock.current = true
    ++sequence.current
    setBusy(member.user_id)
    setActionError('')
    try {
      if (action === 'remove') {
        await onRemove(member)
      } else if (action === 'send') {
        const { error: requestError } = await supabase.rpc('send_connection_request', { p_recipient_id: member.user_id })
        if (requestError) throw requestError
      } else {
        const requestId = connections[member.user_id]?.requestId
        if (!requestId) throw new Error('Запит уже змінився. Оновіть список.')
        const { data, error: responseError } = await supabase.rpc(action === 'accept' ? 'accept_connection_request' : 'reject_connection_request', { p_request_id: requestId })
        if (responseError) throw responseError
        if (action === 'accept' && valid()) openChat(typeof data === 'string' ? data : undefined)
      }
      if (valid()) await reloadConnections()
    } catch {
      if (valid()) setActionError('Не вдалося виконати дію. Оновіть список та спробуйте ще раз.')
    } finally {
      actionLock.current = false
      if (valid()) setBusy('')
    }
  }

  return <div className="mt-4">
    <label className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2.5">
      <Search size={16} className="shrink-0 text-muted-foreground" />
      <span className="sr-only">Знайти учасника у групі</span>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ім’я або нік учасника" maxLength={120} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
    </label>
    <p className="mt-2 text-xs text-muted-foreground">Профілі відкриваються за натисканням на ім’я. Пошук у списку групи безкоштовний.</p>
    {error && <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive"><span className="flex-1">{error}</span><button type="button" onClick={() => { setLoading(true); void reloadConnections() }} disabled={loading} className={actionButton}><RefreshCw size={14} />Повторити</button></div>}
    {actionError && <p role="alert" className="mt-3 text-xs text-destructive">{actionError}</p>}
    <div className="mt-4 divide-y divide-border">
      {visibleMembers.map((member) => {
        const name = member.profile?.full_name || (member.profile?.username ? `@${member.profile.username}` : 'Учасник Xelay')
        const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
        const connection = connections[member.user_id]
        const isSelf = member.user_id === currentUserId
        const isBusy = busy === member.user_id
        return <article key={member.id} className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
          <Link to="/user/$id" params={{ id: member.user_id }} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 hover:text-primary" aria-label={`Переглянути профіль: ${name}`}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-sm font-semibold text-primary">
              {member.profile?.avatar_url ? <img src={member.profile.avatar_url} alt="" loading="lazy" className="h-full w-full object-cover" /> : initials}
            </span>
            <span className="min-w-0"><span className="block truncate text-sm font-semibold">{name}{isSelf && <span className="ml-1 font-normal text-muted-foreground">(ви)</span>}</span><span className="block truncate text-xs text-muted-foreground">{member.profile?.username ? `@${member.profile.username}` : 'Учасник Xelay'}</span><span className={`block text-xs ${member.user_id === representativeId || deputyIds.includes(member.user_id) ? 'font-medium text-primary' : 'text-muted-foreground'}`}>{member.user_id === representativeId ? 'Староста' : member.status === 'pending' ? 'Запрошення очікує підтвердження' : deputyIds.includes(member.user_id) ? 'Заступник старости' : 'У групі'}</span></span>
          </Link>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {!isSelf && member.status === 'accepted' && !error && (loading ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />Завантаження…</span> : connection?.state === 'accepted' ?
              <button type="button" className={`${actionButton} text-primary`} onClick={() => openChat(connection.conversationId)}><MessageCircle size={15} />Чат</button> : connection?.state === 'incoming' ? <><button type="button" className={`${actionButton} text-primary`} disabled={Boolean(busy)} onClick={() => void runAction(member, 'accept')}>{isBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}Прийняти запит</button><button type="button" className={actionButton} disabled={Boolean(busy)} onClick={() => void runAction(member, 'reject')} aria-label={`Відхилити запит від ${name}`}><X size={15} /></button></> : connection?.state === 'outgoing' ? <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-2 text-xs text-muted-foreground"><Check size={14} />Запит надіслано</span> :
              <button type="button" className={actionButton} disabled={Boolean(busy)} onClick={() => void runAction(member, 'send')}>{isBusy ? <Loader2 size={15} className="animate-spin" /> : <UserRoundPlus size={15} />}Запит на спілкування</button>)}
            {canRemoveMembers && !isSelf && member.user_id !== representativeId && (currentUserId === representativeId || !deputyIds.includes(member.user_id)) && <button type="button" disabled={Boolean(busy)} onClick={() => void runAction(member, 'remove')} aria-label={member.status === 'pending' ? `Скасувати запрошення: ${name}` : `Видалити з групи: ${name}`} title={member.status === 'pending' ? 'Скасувати запрошення' : 'Видалити з групи'} className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"><X size={16} /></button>}
          </div>
        </article>
      })}
      {!visibleMembers.length && <p className="py-5 text-center text-sm text-muted-foreground">{query.trim() ? 'Учасників за цим ім’ям чи ніком не знайдено.' : 'Список учасників поки порожній.'}</p>}
    </div>
  </div>
}
