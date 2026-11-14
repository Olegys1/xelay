import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Bell, BellOff, Check, Globe2, GraduationCap, Link2, Loader2, LockKeyhole, LogOut, Megaphone, Plus, RefreshCw, Search, Settings2, Users, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  announceChatUpdate, chatError, chatRpc, clearChatMediaCache, loadChatProfiles, loadFacultyChat, signChatSpaces,
  type ChatInbox, type ChatInvitation, type ChatProfile, type ChatSpaceDetail, type ChatSpaceKind, type FacultyChat,
} from '../lib/chatSpaces'
import { ChatAvatar, ChatDialog, ChatPerson, ChatSpinner, chatButton, chatIcon, chatInput, chatPrimary } from './CommunityChatPrimitives'
import { CommunityChatEditor, CommunityChatManagement } from './CommunityChatSettings'
import { CommunityChatTimeline } from './CommunityChatTimeline'
import { AuthModal } from './AuthModal'
import { chatAccessDenied, chatAuthRejected, chatEventAffectsSelected, chatMembershipAccessChanged, createChatReadCoordinator, type ChatReadContext, type ChatRealtimeChange } from '../lib/chatReadCoordinator'

export interface CommunityChatsProps {
  kind: ChatSpaceKind; initialSpaceId?: string; inviteToken?: string
  onOpenSpace?: (id: string, kind: ChatSpaceKind) => void
  onBackToList?: () => void
}
const emptyInbox: ChatInbox = { spaces: [], invitations: [] }

export function CommunityChats(props: CommunityChatsProps) {
  const { authUser, xelayUser, authReadEpoch = 0, authReadBlocked = false } = useAuth()
  const [showAuth, setShowAuth] = useState(false)
  if (authReadBlocked && authUser) return <section role="status" className="rounded-2xl border border-border p-6 text-center text-sm text-muted-foreground">Перевіряємо доступ до чатів…</section>
  if (!authUser) return <><section className="space-y-4 rounded-2xl border border-border p-6 text-center"><p className="text-sm text-muted-foreground">Увійдіть у профіль, щоб створювати групи, канали та приймати запрошення.</p><button className={chatPrimary} onClick={() => setShowAuth(true)}>Увійти або зареєструватися</button></section>{showAuth && <AuthModal onClose={() => setShowAuth(false)} />}</>
  return <CommunityChatsWorkspace key={`${authUser.id}:${authReadEpoch}:${props.kind}:${xelayUser?.universityId || ''}:${xelayUser?.academicUnitId || ''}:${Boolean(xelayUser?.isPlatformAdmin)}`} {...props} userId={authUser.id} platformAdmin={Boolean(xelayUser?.isPlatformAdmin)} />
}

function CommunityChatsWorkspace({ kind, initialSpaceId, inviteToken, onOpenSpace, onBackToList, userId, platformAdmin }: CommunityChatsProps & { userId: string; platformAdmin: boolean }) {
  const [inbox, setInbox] = useState<ChatInbox>(emptyInbox)
  const [selectedId, setSelectedId] = useState(initialSpaceId || '')
  const [detail, setDetail] = useState<ChatSpaceDetail | null>(null)
  const [profiles, setProfiles] = useState<Record<string, ChatProfile>>({})
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null)
  const [management, setManagement] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [pendingJoin, setPendingJoin] = useState(false)
  const [faculty, setFaculty] = useState<FacultyChat | null>(null)
  const [facultyLoading, setFacultyLoading] = useState(kind === 'group')
  const [facultyEligible, setFacultyEligible] = useState<boolean | null>(null)
  const [facultyError, setFacultyError] = useState('')
  const [memberQuery, setMemberQuery] = useState('')
  const [memberLimit, setMemberLimit] = useState(50)
  const alive = useRef(true)
  const inboxSequence = useRef(0)
  const detailSequence = useRef(0)
  const acceptedDetailSequence = useRef(0)
  const mutation = useRef(false)
  const profileCache = useRef<Record<string, ChatProfile>>({})
  const loadedProfileIds = useRef(new Set<string>())
  const profileFlight = useRef<Promise<Record<string, ChatProfile>> | null>(null)
  const reads = useRef<ReturnType<typeof createChatReadCoordinator> | null>(null)
  if (!reads.current) reads.current = createChatReadCoordinator()
  const readCoordinator = reads.current
  const facultyRequested = useRef(false)
  const scheduled = useRef({ timer: undefined as ReturnType<typeof setTimeout> | undefined, inbox: false, detail: false, faculty: false })
  const facultySequence = useRef(0)
  const facultyRef = useRef(faculty); facultyRef.current = faculty
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId
  const routeRef = useRef({ id: initialSpaceId || '', token: inviteToken })
  const consumedInvite = useRef<string | undefined>(undefined)
  const tokenRef = useRef(inviteToken)
  if (routeRef.current.token !== inviteToken) tokenRef.current = inviteToken
  const activeToken = tokenRef.current
  const latestOpen = useRef(onOpenSpace); latestOpen.current = onOpenSpace
  const latestBack = useRef(onBackToList); latestBack.current = onBackToList
  const inboxRef = useRef(inbox); inboxRef.current = inbox
  const detailRef = useRef(detail); detailRef.current = detail

  const clearPrivateState = useCallback(() => {
    readCoordinator.invalidate()
    inboxSequence.current += 1; detailSequence.current += 1; facultySequence.current += 1
    inboxRef.current = emptyInbox; detailRef.current = null; facultyRef.current = null
    profileCache.current = {}; loadedProfileIds.current.clear(); profileFlight.current = null
    facultyRequested.current = true; clearChatMediaCache()
    setInbox(emptyInbox); setDetail(null); setProfiles({}); setFaculty(null)
    setLoading(false); setDetailLoading(false); setFacultyLoading(false)
    setMembersOpen(false); setManagement(false); setLeaveOpen(false); setEditor(null); setPendingJoin(false)
  }, [readCoordinator])
  const clearSelectedState = useCallback((failure?: unknown) => {
    readCoordinator.invalidate('detail:'); detailSequence.current += 1; detailRef.current = null
    setDetail(null); setDetailLoading(false); setDetailError(failure ? chatError(failure) : '')
    setProfiles({}); profileCache.current = {}; loadedProfileIds.current.clear(); clearChatMediaCache()
    setMembersOpen(false); setManagement(false); setLeaveOpen(false); setEditor(null); setPendingJoin(false)
  }, [readCoordinator])

  const loadFaculty = useCallback(async (context: ChatReadContext) => {
    if (!alive.current || !context.current() || kind !== 'group') return
    const sequence = ++facultySequence.current
    setFacultyLoading(true)
    try {
      const [profile, result] = await Promise.all([
        supabase.from('profiles').select('university_id, academic_unit_id').eq('id', userId).abortSignal(context.signal).maybeSingle(),
        loadFacultyChat(false, context.signal),
      ])
      if (!alive.current || !context.current() || sequence !== facultySequence.current) return
      const previousFaculty = facultyRef.current?.space?.id
      if (previousFaculty && previousFaculty !== result.space?.id && selectedRef.current === previousFaculty) {
        clearSelectedState()
      }
      facultyRef.current = result
      setFaculty(result)
      setFacultyEligible(profile.error ? Boolean(result.space) : Boolean(profile.data?.university_id && profile.data?.academic_unit_id))
      setFacultyError('')
    } catch (failure) {
      if (!alive.current || !context.current() || sequence !== facultySequence.current) return
      if (chatAuthRejected(failure)) clearPrivateState()
      else if (chatAccessDenied(failure) && facultyRef.current?.space?.id === selectedRef.current) {
        clearSelectedState(failure)
      }
      facultyRef.current = null; setFaculty(null)
      const code = (failure as { code?: string })?.code || ''
      setFacultyError(['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)
        ? 'Чат факультету поки недоступний. Спробуйте оновити сторінку пізніше.' : chatError(failure))
    } finally { if (alive.current && context.current() && sequence === facultySequence.current) setFacultyLoading(false) }
  }, [userId, kind, clearPrivateState, clearSelectedState])

  const checkSelectedAccess = useCallback(async (context: ChatReadContext): Promise<string | null> => {
    const current = detailRef.current
    const id = current?.space.id
    if (!alive.current || !context.current() || !id || id !== selectedRef.current) return null
    if (current.my_membership?.status !== 'active') {
      // Faculty moderation can legitimately have no membership row. Its
      // existing protected RPC remains the authority for that exceptional path.
      if (current.is_admin) await latestDetail.current(false, true)
      return null
    }
    const sequence = detailSequence.current
    const accepted = acceptedDetailSequence.current
    const row = await (async () => {
      try { return await supabase.from('chat_members').select('space_id,user_id,status,role,visible_from,muted')
        .eq('space_id', id).eq('user_id', userId).abortSignal(context.signal).maybeSingle() }
      catch (error) { return { data: null, error } }
    })()
    if (!alive.current || !context.current() || selectedRef.current !== id || detailRef.current?.space.id !== id || sequence !== detailSequence.current || accepted !== acceptedDetailSequence.current) return null
    if (row.error || !row.data || row.data.status !== 'active') {
      if (chatAuthRejected(row.error)) clearPrivateState()
      else clearSelectedState(row.error || new Error('CHAT_MEMBER_REQUIRED'))
      return id
    }
    if (chatMembershipAccessChanged({ new: row.data }, current.my_membership)) {
      clearSelectedState()
      void latestDetail.current(true, true)
    } else if (typeof row.data.muted === 'boolean' && row.data.muted !== current.my_membership.muted) {
      const muted = row.data.muted
      setDetail(value => value?.space.id === id && value.my_membership ? { ...value, my_membership: { ...value.my_membership, muted } } : value)
    }
    return null
  }, [userId, clearPrivateState, clearSelectedState])

  const loadInbox = useCallback(async (spinner = false, fresh = false, includeFaculty = spinner): Promise<void> => {
    if (!alive.current) return
    if (spinner) setLoading(true)
    facultyRequested.current ||= includeFaculty
    return readCoordinator.read('inbox', async (context) => {
    const sequence = ++inboxSequence.current
    const acceptedAtStart = acceptedDetailSequence.current
    try {
      const needsFaculty = facultyRequested.current
      facultyRequested.current = false
      if (needsFaculty) await loadFaculty(context)
      if (!alive.current || !context.current() || sequence !== inboxSequence.current) return
      const result = await chatRpc<ChatInbox>('xelay_chat_inbox', undefined, context.signal)
      if (!alive.current || !context.current() || sequence !== inboxSequence.current) return
      // The inbox already needs refreshing for unread counts. Check only our
      // own small membership row instead of loading the selected chat's entire
      // member list again. Never publish membership associations via Realtime.
      const revoked = acceptedAtStart === acceptedDetailSequence.current ? await checkSelectedAccess(context) : null
      if (!alive.current || !context.current() || sequence !== inboxSequence.current) return
      const [spaces, invitationSpaces] = await Promise.all([
        signChatSpaces((result.spaces || []).filter(space => space.id !== revoked)),
        signChatSpaces((result.invitations || []).map((item) => item.space).filter(Boolean) as NonNullable<ChatInvitation['space']>[]),
      ])
      const signed = new Map(invitationSpaces.map((space) => [space.id, space]))
      if (!alive.current || !context.current() || sequence !== inboxSequence.current) return
      setInbox({ spaces, invitations: (result.invitations || []).map((item) => ({ ...item, space: signed.get(item.space_id) || item.space })), join_requests: result.join_requests || [] }); setError('')
    } catch (failure) { if (alive.current && context.current() && sequence === inboxSequence.current) { if (chatAccessDenied(failure)) clearPrivateState(); setError(chatError(failure)) } }
    finally { if (alive.current && context.current() && sequence === inboxSequence.current) setLoading(false) }
    }, fresh || includeFaculty)
  }, [loadFaculty, readCoordinator, clearPrivateState, checkSelectedAccess])

  const loadDetail = useCallback(async (spinner = false, fresh = false): Promise<void> => {
    if (!alive.current) return
    const id = selectedRef.current
    const token = tokenRef.current
    if (!id && !token) { setDetail(null); return }
    if (spinner) setDetailLoading(true)
    return readCoordinator.read(`detail:${JSON.stringify([id, token || ''])}`, async (context) => {
    const sequence = ++detailSequence.current
    const current = () => alive.current && context.current() && sequence === detailSequence.current && token === tokenRef.current && id === selectedRef.current
    try {
      let result: ChatSpaceDetail
      if (token) {
        const preview = await chatRpc<{ space: ChatSpaceDetail['space']; my_membership?: ChatSpaceDetail['my_membership']; my_join_request?: { id: string; status: string; user_id: string; space_id: string; created_at: string } | null }>('xelay_chat_link_preview', { p_token: token }, context.signal)
        if (!current()) return
        // An invite grants a metadata preview, never permission to read private
        // history. Full data is requested only after membership is confirmed.
        const memberSpace = inboxRef.current.spaces.find((space) => space.id === preview.space.id)
        if (memberSpace || preview.my_membership?.status === 'active') result = await chatRpc<ChatSpaceDetail>('xelay_chat_get', { p_space_id: preview.space.id }, context.signal)
        else result = { space: preview.space, my_membership: preview.my_membership || null, members: [], invitations: [], join_requests: preview.my_join_request ? [preview.my_join_request] : [], invite_links: [], pins: [] }
      } else result = await chatRpc<ChatSpaceDetail>('xelay_chat_get', { p_space_id: id }, context.signal)
      if (!current()) return
      const [signed] = await signChatSpaces([result.space])
      if (profileFlight.current) await profileFlight.current.catch(() => {})
      if (!current()) return
      const ids = [...new Set([result.space.owner_id, ...(result.members || []).map((member) => member.user_id)].filter((value): value is string => Boolean(value)))]
      const missing = ids.filter((value) => !loadedProfileIds.current.has(value))
      if (missing.length) {
        const flight = loadChatProfiles(missing, context.signal)
        profileFlight.current = flight
        try {
          const found = await flight
          if (!current()) return
          profileCache.current = { ...profileCache.current, ...found }
          missing.forEach((value) => loadedProfileIds.current.add(value))
        } finally { if (profileFlight.current === flight) profileFlight.current = null }
      }
      const people = profileCache.current
      if (!current()) return
      acceptedDetailSequence.current += 1
      setDetail({ ...result, space: signed, members: result.members || [], invitations: result.invitations || [], join_requests: result.join_requests || [], invite_links: result.invite_links || [], pins: result.pins || [], personal_pins: result.personal_pins || [] }); setProfiles(people); setDetailError('')
      setPendingJoin((result.join_requests || []).some((item) => item.user_id === userId && item.status === 'pending'))
    } catch (failure) { if (current()) {
      if (chatAccessDenied(failure)) { clearPrivateState(); void latestInbox.current() }
      else { setDetail(null); setProfiles({}) }
      setDetailError(chatError(failure))
    } }
    finally { if (current()) setDetailLoading(false) }
    }, fresh)
  }, [userId, readCoordinator, clearPrivateState])
  const latestInbox = useRef(loadInbox); latestInbox.current = loadInbox
  const latestDetail = useRef(loadDetail); latestDetail.current = loadDetail

  const clearScheduled = useCallback(() => {
    if (scheduled.current.timer) clearTimeout(scheduled.current.timer)
    scheduled.current = { timer: undefined, inbox: false, detail: false, faculty: false }
  }, [])
  const flushScheduled = useCallback(() => {
    scheduled.current.timer = undefined
    if (!alive.current || mutation.current) return
    const next = scheduled.current
    scheduled.current = { timer: undefined, inbox: false, detail: false, faculty: false }
    if (next.inbox) void latestInbox.current(false, true, next.faculty)
    if (next.detail) void latestDetail.current(false, true)
  }, [])
  const scheduleRefresh = useCallback((inboxChange = true, detailChange = true, facultyChange = false) => {
    if (!alive.current) return
    const next = scheduled.current
    next.inbox ||= inboxChange; next.detail ||= detailChange; next.faculty ||= facultyChange
    // A fixed window, rather than an endlessly restarted debounce, still
    // refreshes a busy chat while merging duplicate subscriptions/focus events.
    if (!next.timer) next.timer = setTimeout(flushScheduled, 400)
  }, [flushScheduled])
  const refresh = useCallback(async () => {
    const includeFaculty = scheduled.current.faculty
    clearScheduled()
    await Promise.all([latestInbox.current(false, true, includeFaculty), latestDetail.current(false, true)])
  }, [clearScheduled])

  useEffect(() => {
    alive.current = true; clearChatMediaCache(); void loadInbox(true, false, true)
    return () => { alive.current = false; clearScheduled(); readCoordinator.invalidate(); inboxSequence.current += 1; detailSequence.current += 1; facultySequence.current += 1; profileCache.current = {}; loadedProfileIds.current.clear(); profileFlight.current = null; clearChatMediaCache() }
  }, [userId, loadInbox, clearScheduled, readCoordinator])
  useEffect(() => {
    const nextId = initialSpaceId || ''
    const changedToken = routeRef.current.token !== inviteToken
    const reflectedConsumedInvite = changedToken && !inviteToken && consumedInvite.current === routeRef.current.token
    routeRef.current = { id: nextId, token: inviteToken }
    if (changedToken) consumedInvite.current = undefined
    // A route update reflecting our own open() must not cancel the one detail
    // read already started by the selection effect.
    if ((!changedToken || reflectedConsumedInvite) && selectedRef.current === nextId) return
    readCoordinator.invalidate('detail:'); readCoordinator.invalidate('access:'); detailSequence.current += 1; selectedRef.current = nextId
    setSelectedId(nextId); setDetail(null); setProfiles({}); setDetailError(''); setNotice(''); setPendingJoin(false); setMembersOpen(false); setManagement(false); setLeaveOpen(false); setEditor(null)
  }, [initialSpaceId, inviteToken, readCoordinator])
  useEffect(() => { setMemberQuery(''); setMemberLimit(50) }, [selectedId, membersOpen])
  useEffect(() => { void loadDetail(true) }, [selectedId, activeToken, loadDetail])
  useEffect(() => {
    let connected = false, subscribed = false
    const changed = () => scheduleRefresh(true, true, true)
    const scoped = (table: 'chat_spaces' | 'chat_posts' | 'chat_invitations', payload: ChatRealtimeChange) => {
      if (table === 'chat_spaces' && payload.eventType === 'DELETE' && chatEventAffectsSelected(table, payload, selectedRef.current)) clearPrivateState()
      scheduleRefresh(true, chatEventAffectsSelected(table, payload, selectedRef.current))
    }
    const profileChanged = () => { clearPrivateState(); changed() }
    const localChanged = () => { if (!mutation.current) scheduleRefresh(true, false) }
    const channel = supabase.channel(`community-inbox:${userId}:${kind}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_spaces' }, payload => scoped('chat_spaces', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_invitations', filter: `user_id=eq.${userId}` }, payload => scoped('chat_invitations', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_posts' }, payload => scoped('chat_posts', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` }, profileChanged)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_roles', filter: `user_id=eq.${userId}` }, profileChanged)
      .subscribe(status => {
        if (status === 'SUBSCRIBED') { if (subscribed && !connected) changed(); connected = true; subscribed = true }
        else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) connected = false
      })
    const visible = () => { if (document.visibilityState === 'visible') changed() }
    const backstop = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (!connected) changed()
      else void readCoordinator.read('access:' + selectedRef.current, async context => {
        const revoked = await checkSelectedAccess(context)
        if (revoked && alive.current && context.current()) void latestInbox.current(false, true)
      }, true)
    }, 60_000)
    window.addEventListener('focus', changed)
    window.addEventListener('online', changed)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('xelay-chat-updated', localChanged)
    return () => { clearInterval(backstop); window.removeEventListener('focus', changed); window.removeEventListener('online', changed); document.removeEventListener('visibilitychange', visible); window.removeEventListener('xelay-chat-updated', localChanged); void supabase.removeChannel(channel) }
  }, [userId, kind, scheduleRefresh, clearPrivateState, checkSelectedAccess, readCoordinator])
  useEffect(() => {
    if (!selectedId) return
    const changed = () => scheduleRefresh(false, true)
    const channel = supabase.channel(`community-detail:${selectedId}:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_join_requests', filter: `space_id=eq.${selectedId}` }, changed)
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [selectedId, userId, scheduleRefresh])

  const open = (id: string, spaceKind: ChatSpaceKind) => { if (!alive.current || (selectedRef.current === id && !tokenRef.current)) return; if (tokenRef.current) consumedInvite.current = tokenRef.current; tokenRef.current = undefined; readCoordinator.invalidate('detail:'); readCoordinator.invalidate('access:'); selectedRef.current = id; detailSequence.current += 1; setSelectedId(id); setDetail(null); setProfiles({}); setDetailError(''); setNotice(''); setPendingJoin(false); setMembersOpen(false); setManagement(false); setLeaveOpen(false); latestOpen.current?.(id, spaceKind) }
  const back = () => { if (!alive.current) return; readCoordinator.invalidate('detail:'); readCoordinator.invalidate('access:'); tokenRef.current = undefined; selectedRef.current = ''; detailSequence.current += 1; setSelectedId(''); setDetail(null); setProfiles({}); setDetailError(''); setNotice(''); setMembersOpen(false); setManagement(false); latestBack.current?.() }
  const run = async (key: string, action: () => Promise<void>) => {
    if (!alive.current || mutation.current) return false
    mutation.current = true; setBusy(key); setNotice(''); setDetailError('')
    try { await action(); if (!alive.current) return false; announceChatUpdate(); await refresh(); return true }
    catch (failure) { if (alive.current) setDetailError(chatError(failure)); return false }
    finally { mutation.current = false; if (alive.current) { setBusy(''); if (scheduled.current.inbox || scheduled.current.detail) scheduleRefresh(false, false) } }
  }
  const acceptInvitation = (invitation: ChatInvitation, accept: boolean) => run(invitation.id, async () => {
    const id = await chatRpc<string>('xelay_chat_invitation', { p_invitation_id: invitation.id, p_accept: accept })
    if (accept && invitation.space) open(id, invitation.space.kind)
  })
  const openFaculty = () => {
    const current = facultyRef.current
    if (!current?.space || (current.my_membership?.status === 'banned' && !platformAdmin) || mutation.current) return
    if (current.my_membership?.status === 'active' || platformAdmin) { tokenRef.current = undefined; open(current.space.id, 'group'); return }
    void run('faculty', async () => {
      setFacultyError('')
      try {
        const joined = await loadFacultyChat(true)
        if (!alive.current) return
        if (!joined.space || joined.my_membership?.status !== 'active') throw new Error('CHAT_FACULTY_SCOPE_REQUIRED')
        facultyRef.current = joined; setFaculty(joined)
        tokenRef.current = undefined
        open(joined.space.id, 'group')
      } catch (failure) { if (alive.current) setFacultyError(chatError(failure)); throw failure }
    })
  }
  const join = () => {
    if (!detail) return
    if (detail.space.system_kind === 'faculty') { if (detail.space.id === facultyRef.current?.space?.id) openFaculty(); return }
    void run('join', async () => {
      const token = tokenRef.current
      const result = token ? await chatRpc<{ space_id: string; status: string }>('xelay_chat_join_link', { p_token: token }) : { space_id: detail.space.id, status: await chatRpc<string>('xelay_chat_join', { p_space_id: detail.space.id }) }
      if (result.status === 'pending') { setPendingJoin(true); setNotice('Заявку надіслано. Адміністратор підтвердить ваш вступ.'); return }
      tokenRef.current = undefined
      open(result.space_id, detail.space.kind)
    })
  }
  const isActive = detail?.my_membership?.status === 'active'
  const isFaculty = detail?.space.system_kind === 'faculty'
  const isAdmin = detail?.is_admin ?? Boolean(isActive && ['owner', 'admin'].includes(detail?.my_membership?.role || ''))
  const canReadContent = isActive || (isFaculty && isAdmin)
  const spaces = inbox.spaces.filter((space) => space.kind === kind)
  const invitations = inbox.invitations.filter((item) => item.space?.kind === kind)
  const showThread = Boolean(selectedId || activeToken)
  const matchedMembers = (detail?.members || []).filter((member) => {
    if (member.status !== 'active') return false
    const profile = profiles[member.user_id]
    return !memberQuery.trim() || `${profile?.full_name || ''} ${profile?.username || ''}`.toLocaleLowerCase('uk-UA').includes(memberQuery.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA'))
  })

  return <section className="space-y-4" aria-label={kind === 'group' ? 'Групові чати' : 'Канали'}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{kind === 'group' ? 'Ваші групи' : 'Ваші канали'}</h2><p className="mt-1 text-xs text-muted-foreground">{kind === 'group' ? 'Спілкуйтеся разом, діліться файлами та планами.' : 'Створюйте публікації та стежте за спільнотами.'}</p></div><button className={chatPrimary} onClick={() => setEditor('create')}><Plus size={17} />{kind === 'group' ? 'Створити групу' : 'Створити канал'}</button></div>
    {kind === 'group' && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3"><GraduationCap size={22} className="mt-0.5 shrink-0 text-primary" /><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{faculty?.space?.name || 'Чат факультету'}</h3>
        {facultyLoading && !faculty ? <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground" role="status"><Loader2 size={13} className="animate-spin" />Знаходимо чат вашого факультету…</p>
          : facultyError ? <p className="mt-1 text-xs text-muted-foreground" role="alert">{facultyError}</p>
          : faculty?.space ? <p className="mt-1 text-xs text-muted-foreground">{platformAdmin && faculty.my_membership?.status !== 'active' ? 'Доступ адміністратора платформи для модерації чату.' : faculty.my_membership?.status === 'banned' ? 'Адміністратор обмежив ваш доступ до цього чату.' : faculty.my_membership?.status === 'active' ? 'Спільний чат факультету з вашого профілю.' : 'Ви вийшли з чату. Можна повернутися у будь-який час.'}</p>
          : <p className="mt-1 text-xs text-muted-foreground">{facultyEligible === false ? 'Оберіть університет і факультет у профілі, щоб приєднатися до спільного чату.' : 'Чат факультету наразі недоступний. Перевірте університет і факультет у профілі.'}</p>}
      </div></div>
      {faculty?.space ? <button className={chatButton} disabled={Boolean(busy) || facultyLoading || (faculty.my_membership?.status === 'banned' && !platformAdmin)} onClick={openFaculty}>{busy === 'faculty' && <Loader2 size={15} className="animate-spin" />}{faculty.my_membership?.status === 'banned' && !platformAdmin ? 'Доступ обмежено' : faculty.my_membership?.status === 'active' || platformAdmin ? 'Відкрити чат факультету' : 'Повернутися до чату факультету'}</button>
        : facultyError ? <button className={chatButton} disabled={facultyLoading} onClick={() => void loadInbox(false, true, true)}><RefreshCw size={15} />Оновити</button>
        : !facultyLoading && <Link to="/profile" className={chatButton}>Оновити профіль</Link>}
    </div>}
    {error && <div className="rounded-xl border border-primary/20 bg-primary/5 p-4" role="alert"><p className="text-sm">{error}</p><button className={`${chatButton} mt-3`} onClick={() => void loadInbox(true)}><RefreshCw size={15} />Спробувати ще раз</button></div>}
    {invitations.length > 0 && <div className="space-y-2 rounded-2xl border border-primary/15 bg-primary/5 p-4"><h3 className="text-sm font-semibold">Запрошення</h3>{invitations.map((invitation) => <article className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background p-3" key={invitation.id}><button className="flex min-w-0 items-center gap-3 text-left" onClick={() => invitation.space && open(invitation.space.id, invitation.space.kind)}>{invitation.space && <ChatAvatar space={invitation.space} />}<span className="truncate text-sm font-medium">{invitation.space?.name || 'Спільнота Xelay'}</span></button><div className="flex gap-2"><button className={chatPrimary} disabled={Boolean(busy)} onClick={() => void acceptInvitation(invitation, true)}><Check size={16} />Прийняти</button><button className={chatButton} disabled={Boolean(busy)} onClick={() => void acceptInvitation(invitation, false)} aria-label="Відхилити запрошення"><X size={16} /></button></div></article>)}</div>}
    {(inbox.join_requests || []).some((request) => request.space?.kind === kind) && <div className="space-y-2 rounded-2xl border border-border p-4"><h3 className="text-sm font-semibold">Ваші заявки на вступ</h3>{(inbox.join_requests || []).filter((request) => request.space?.kind === kind).map((request) => <div key={request.id} className="flex items-center justify-between gap-3"><button className="min-w-0 truncate text-left text-sm" onClick={() => open(request.space_id, request.space.kind)}>{request.space.name}<span className="block text-xs text-muted-foreground">Очікує підтвердження</span></button><button className={chatButton} disabled={Boolean(busy)} onClick={() => run(`cancel:${request.id}`, async () => { await chatRpc('xelay_chat_cancel_request', { p_space_id: request.space_id }) })}>Скасувати</button></div>)}</div>}
    <div className="grid overflow-hidden rounded-2xl border border-border bg-[hsl(var(--canvas-inbox))] shadow-sm md:grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[330px_minmax(0,1fr)]">
      <aside className={`${showThread ? 'hidden md:block' : 'block'} min-w-0 border-border bg-card md:border-r`}>
        <div className="flex items-center justify-between border-b border-border p-4"><span className="text-sm font-semibold">{kind === 'group' ? 'Групи' : 'Канали'} · {spaces.length}</span><button className={chatIcon} aria-label="Оновити список" disabled={loading} onClick={() => void loadInbox(true)}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button></div>
        {loading ? <ChatSpinner /> : !spaces.length ? <div className="space-y-3 p-6 text-center text-sm text-muted-foreground">{kind === 'group' ? <Users className="mx-auto text-primary/50" /> : <Megaphone className="mx-auto text-primary/50" />}<p>{kind === 'group' ? 'Поки немає групових чатів.' : 'Ви поки не підписані на канали.'}</p><Link to="/search" className="inline-block font-medium text-primary">Знайти спільноту →</Link></div> : <div className="max-h-[70dvh] overflow-y-auto">{spaces.map((space) => <button className={`flex w-full items-center gap-3 border-b border-border p-4 text-left transition-colors hover:bg-muted ${selectedId === space.id ? 'bg-primary/5' : ''}`} key={space.id} onClick={() => open(space.id, space.kind)}><ChatAvatar space={space} /><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-sm font-semibold">{space.name}</span>{space.my_muted && <BellOff size={12} className="shrink-0 text-muted-foreground" />}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{space.last_post?.body || `${space.member_count || 0} ${space.kind === 'channel' ? 'підписників' : 'учасників'}`}</span></span>{Boolean(space.unread_count) && <span className="rounded-full bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground">{(space.unread_count || 0) > 99 ? '99+' : space.unread_count}</span>}</button>)}</div>}
      </aside>
      <div className={`${showThread ? 'flex' : 'hidden md:flex'} h-[min(76dvh,820px)] min-h-[420px] min-w-0 flex-col bg-background/70`}>
        {!showThread ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"><span className="rounded-2xl bg-primary/10 p-4 text-primary">{kind === 'group' ? <Users size={28} /> : <Megaphone size={28} />}</span><p className="text-sm">Оберіть {kind === 'group' ? 'групу' : 'канал'} або створіть власний.</p></div> : detailLoading && !detail ? <ChatSpinner /> : detail ? <>
          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-background p-3 sm:p-4">
            <button className={`${chatIcon} md:hidden`} aria-label="До списку чатів" onClick={back}><ArrowLeft size={19} /></button><button type="button" className="shrink-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/30" aria-label={`Фото й інформація про ${detail.space.name}`} onClick={() => setMembersOpen(true)}><ChatAvatar space={detail.space} /></button>
            <button className="min-w-0 flex-1 text-left" aria-label={`Інформація про ${detail.space.name}`} onClick={() => setMembersOpen(true)}><span className="block truncate text-sm font-semibold">{detail.space.name}</span><span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">{isFaculty ? <GraduationCap size={12} /> : detail.space.visibility === 'private' ? <LockKeyhole size={11} /> : <Globe2 size={11} />}{detail.space.member_count || 0} {detail.space.kind === 'channel' ? 'підписників' : 'учасників'}{detail.space.username && <span className="truncate">· @{detail.space.username}</span>}</span></button>
            {(isActive || isAdmin) && <>{isActive && <button className={chatIcon} disabled={Boolean(busy)} aria-label={detail.my_membership?.muted ? 'Увімкнути сповіщення' : 'Вимкнути сповіщення'} title={detail.my_membership?.muted ? 'Увімкнути сповіщення' : 'Вимкнути сповіщення'} onClick={() => run('mute', async () => { await chatRpc('xelay_chat_mute', { p_space_id: detail.space.id, p_muted: !detail.my_membership?.muted }) })}>{detail.my_membership?.muted ? <BellOff size={17} /> : <Bell size={17} />}</button>}
              {isAdmin && <button className={chatIcon} aria-label={isFaculty ? 'Модерація учасників' : 'Керувати учасниками й запрошеннями'} title={isFaculty ? 'Модерація учасників' : 'Учасники й запрошення'} onClick={() => setManagement(true)}><Users size={18} /></button>}
              {isAdmin && <button className={chatIcon} aria-label={isFaculty ? 'Змінити опис і фото чату' : 'Налаштування чату'} title={isFaculty ? 'Опис і фото' : 'Налаштування чату'} onClick={() => setEditor('edit')}><Settings2 size={18} /></button>}
              {isActive && <button className={chatIcon} aria-label="Вийти з чату" title="Вийти з чату" onClick={() => setLeaveOpen(true)}><LogOut size={17} /></button>}</>}
          </header>
          {notice && <p role="status" className="px-4 py-2 text-sm text-primary">{notice}</p>}
          {detailError && <p role="alert" className="px-4 py-2 text-sm text-destructive">{detailError}</p>}
          {canReadContent ? <CommunityChatTimeline key={`${detail.space.id}:${userId}`} detail={detail} userId={userId} knownProfiles={profiles} onRefresh={refresh} /> : <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center"><ChatAvatar space={detail.space} size="h-20 w-20" /><h3 className="text-xl font-semibold">{detail.space.name}</h3><p className="max-w-md whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{detail.space.description || (detail.space.kind === 'channel' ? 'Канал спільноти Xelay' : 'Груповий чат Xelay')}</p>
            {detail.my_membership?.status === 'banned' ? <p className="text-sm text-destructive">Адміністратор обмежив ваш доступ.</p>
              : isFaculty ? detail.space.id === faculty?.space?.id ? <button className={chatPrimary} disabled={Boolean(busy) || facultyLoading} onClick={openFaculty}>{busy === 'faculty' && <Loader2 size={16} className="animate-spin" />}Повернутися до чату факультету</button> : <p className="max-w-sm text-sm text-muted-foreground">Цей чат доступний учасникам відповідного факультету. Перевірте вибір у <Link to="/profile" className="font-medium text-primary hover:underline">профілі</Link>.</p>
              : pendingJoin ? <><p className="text-sm text-primary">Ваша заявка очікує підтвердження.</p><button className={chatButton} disabled={Boolean(busy)} onClick={() => run('cancel-request', async () => { await chatRpc('xelay_chat_cancel_request', { p_space_id: detail.space.id }); setPendingJoin(false) })}>Скасувати заявку</button></>
              : tokenRef.current || detail.space.visibility === 'public' ? <button className={chatPrimary} disabled={Boolean(busy)} onClick={join}>{busy === 'join' && <Loader2 size={16} className="animate-spin" />}{detail.space.join_approval ? 'Подати заявку на вступ' : detail.space.kind === 'channel' ? 'Підписатися' : 'Приєднатися'}</button>
              : <p className="max-w-sm text-sm text-muted-foreground">Цей чат приватний. Прийміть особисте запрошення або відкрийте посилання від адміністратора.</p>}
          </div>}
        </> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><p role="alert" className="text-sm text-muted-foreground">{detailError || 'Оберіть чат зі списку.'}</p><button className={chatButton} onClick={() => void loadDetail(true)}><RefreshCw size={15} />Оновити</button><button className={`${chatButton} md:hidden`} onClick={back}>До списку</button></div>}
      </div>
    </div>
    {(editor === 'create' || (editor === 'edit' && detail && isAdmin)) && <CommunityChatEditor key={`${userId}:${editor === 'edit' ? detail?.space.id : kind}`} userId={userId} kind={editor === 'edit' && detail ? detail.space.kind : kind} isOwner={editor === 'create' || detail?.my_membership?.role === 'owner'} space={editor === 'edit' ? detail?.space : undefined} onClose={() => setEditor(null)} onSaved={async (id, spaceKind) => { if (!alive.current) return; setEditor(null); open(id, spaceKind); announceChatUpdate(); await refresh() }} />}
    {management && detail && isAdmin && <CommunityChatManagement key={detail.space.id} detail={detail} userId={userId} profiles={profiles} onClose={() => setManagement(false)} onRefresh={refresh} onDeleted={() => { setManagement(false); back(); announceChatUpdate(); void loadInbox() }} />}
    {membersOpen && detail && <ChatDialog title={detail.space.kind === 'channel' ? 'Про канал' : 'Про групу'} onClose={() => setMembersOpen(false)}>
      <div className="mb-5 flex items-center gap-3"><ChatAvatar space={detail.space} /><div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{detail.space.name}</h3><p className="mt-1 text-xs text-muted-foreground">{isFaculty ? 'Спільний чат факультету' : detail.space.visibility === 'private' ? 'Приватна спільнота' : 'Публічна спільнота'}</p></div>{isAdmin && <button type="button" className={chatIcon} aria-label="Редагувати опис і фото" title="Редагувати опис і фото" onClick={() => { setMembersOpen(false); setEditor('edit') }}><Settings2 size={18} /></button>}</div>
      <h4 className="text-xs font-semibold text-muted-foreground">ОПИС</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{detail.space.description || 'Опис ще не додано.'}</p>
      {isFaculty && <p className="mt-3 text-xs text-muted-foreground">Приєднатися можуть люди з цим факультетом у профілі. Чат модерують призначені адміністратори й адміністратори платформи.</p>}
      {canReadContent ? <div className="mt-5 space-y-3"><h4 className="text-sm font-semibold">Учасники · {detail.space.member_count || matchedMembers.length}</h4><label className="relative block"><Search size={16} className="absolute left-3 top-3 text-muted-foreground" /><input value={memberQuery} onChange={(event) => { setMemberQuery(event.target.value); setMemberLimit(50) }} className={`${chatInput} pl-9`} placeholder="Ім’я або нік учасника" aria-label="Пошук серед учасників чату" maxLength={100} /></label>
        {matchedMembers.slice(0, memberLimit).map((member) => <div key={member.user_id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3"><ChatPerson id={member.user_id} profile={profiles[member.user_id]} /><span className="shrink-0 text-xs text-muted-foreground">{member.role === 'owner' ? 'Власник' : member.role === 'admin' ? 'Адмін' : ''}</span></div>)}
        {!matchedMembers.length && <p className="text-sm text-muted-foreground">{memberQuery.trim() ? 'Учасників не знайдено.' : 'Список учасників поки порожній.'}</p>}
        {matchedMembers.length > memberLimit && <button className={`${chatButton} w-full`} onClick={() => setMemberLimit((limit) => limit + 50)}>Показати ще · {matchedMembers.length - memberLimit}</button>}
      </div> : <p className="mt-5 text-sm text-muted-foreground">Список учасників доступний після приєднання до чату.</p>}
    </ChatDialog>}
    {leaveOpen && detail && <ChatDialog title="Вийти з чату?" busy={Boolean(busy)} onClose={() => setLeaveOpen(false)}><p className="mb-4 text-sm text-muted-foreground">{detail.my_membership?.role === 'owner' ? 'Перед виходом передайте право власності іншому учаснику в керуванні чатом.' : `Ви залишаєте «${detail.space.name}».`}</p><div className="flex justify-end gap-2"><button className={chatButton} disabled={Boolean(busy)} onClick={() => setLeaveOpen(false)}>Скасувати</button><button className={chatPrimary} disabled={Boolean(busy) || detail.my_membership?.role === 'owner'} onClick={() => run('leave', async () => { await chatRpc('xelay_chat_leave', { p_space_id: detail.space.id }); setLeaveOpen(false); back() })}>Вийти</button></div></ChatDialog>}
  </section>
}
