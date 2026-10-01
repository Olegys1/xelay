import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Bell, BellOff, Check, Globe2, Link2, Loader2, LockKeyhole, LogOut, Megaphone, Plus, RefreshCw, Settings2, Users, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  announceChatUpdate, chatError, chatRpc, clearChatMediaCache, loadChatProfiles, signChatSpaces,
  type ChatInbox, type ChatInvitation, type ChatProfile, type ChatSpaceDetail, type ChatSpaceKind,
} from '../lib/chatSpaces'
import { ChatAvatar, ChatDialog, ChatPerson, ChatSpinner, chatButton, chatIcon, chatPrimary } from './CommunityChatPrimitives'
import { CommunityChatEditor, CommunityChatManagement } from './CommunityChatSettings'
import { CommunityChatTimeline } from './CommunityChatTimeline'
import { AuthModal } from './AuthModal'

export interface CommunityChatsProps {
  kind: ChatSpaceKind; initialSpaceId?: string; inviteToken?: string
  onOpenSpace?: (id: string, kind: ChatSpaceKind) => void
  onBackToList?: () => void
}
const emptyInbox: ChatInbox = { spaces: [], invitations: [] }

export function CommunityChats(props: CommunityChatsProps) {
  const { authUser } = useAuth()
  const [showAuth, setShowAuth] = useState(false)
  if (!authUser) return <><section className="space-y-4 rounded-2xl border border-border p-6 text-center"><p className="text-sm text-muted-foreground">Увійдіть у профіль, щоб створювати групи, канали та приймати запрошення.</p><button className={chatPrimary} onClick={() => setShowAuth(true)}>Увійти або зареєструватися</button></section>{showAuth && <AuthModal onClose={() => setShowAuth(false)} />}</>
  return <CommunityChatsWorkspace key={`${authUser.id}:${props.kind}`} {...props} userId={authUser.id} />
}

function CommunityChatsWorkspace({ kind, initialSpaceId, inviteToken, onOpenSpace, onBackToList, userId }: CommunityChatsProps & { userId: string }) {
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
  const alive = useRef(true)
  const inboxSequence = useRef(0)
  const detailSequence = useRef(0)
  const mutation = useRef(false)
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId
  const tokenRef = useRef(inviteToken); tokenRef.current = inviteToken
  const latestOpen = useRef(onOpenSpace); latestOpen.current = onOpenSpace
  const latestBack = useRef(onBackToList); latestBack.current = onBackToList
  const inboxRef = useRef(inbox); inboxRef.current = inbox

  const loadInbox = useCallback(async (spinner = false) => {
    const sequence = ++inboxSequence.current
    if (spinner) setLoading(true)
    try {
      const result = await chatRpc<ChatInbox>('xelay_chat_inbox')
      const spaces = await signChatSpaces(result.spaces || [])
      const invitationSpaces = await signChatSpaces((result.invitations || []).map((item) => item.space).filter(Boolean) as NonNullable<ChatInvitation['space']>[])
      const signed = new Map(invitationSpaces.map((space) => [space.id, space]))
      if (!alive.current || sequence !== inboxSequence.current) return
      setInbox({ spaces, invitations: (result.invitations || []).map((item) => ({ ...item, space: signed.get(item.space_id) || item.space })), join_requests: result.join_requests || [] }); setError('')
    } catch (failure) { if (alive.current && sequence === inboxSequence.current) setError(chatError(failure)) }
    finally { if (alive.current && sequence === inboxSequence.current) setLoading(false) }
  }, [userId])

  const loadDetail = useCallback(async (spinner = false) => {
    const id = selectedRef.current
    const token = tokenRef.current
    if (!id && !token) { setDetail(null); return }
    const sequence = ++detailSequence.current
    if (spinner) setDetailLoading(true)
    try {
      let result: ChatSpaceDetail
      if (token) {
        const preview = await chatRpc<{ space: ChatSpaceDetail['space']; my_membership?: ChatSpaceDetail['my_membership']; my_join_request?: { id: string; status: string; user_id: string; space_id: string; created_at: string } | null }>('xelay_chat_link_preview', { p_token: token })
        // An invite grants a metadata preview, never permission to read private
        // history. Full data is requested only after membership is confirmed.
        const memberSpace = inboxRef.current.spaces.find((space) => space.id === preview.space.id)
        if (memberSpace || preview.my_membership?.status === 'active') result = await chatRpc<ChatSpaceDetail>('xelay_chat_get', { p_space_id: preview.space.id })
        else result = { space: preview.space, my_membership: preview.my_membership || null, members: [], invitations: [], join_requests: preview.my_join_request ? [preview.my_join_request] : [], invite_links: [], pins: [] }
      } else result = await chatRpc<ChatSpaceDetail>('xelay_chat_get', { p_space_id: id })
      const [signed] = await signChatSpaces([result.space])
      const people = await loadChatProfiles([result.space.owner_id, ...(result.members || []).map((member) => member.user_id)])
      if (!alive.current || sequence !== detailSequence.current || token !== tokenRef.current || id !== selectedRef.current) return
      setDetail({ ...result, space: signed, members: result.members || [], invitations: result.invitations || [], join_requests: result.join_requests || [], invite_links: result.invite_links || [], pins: result.pins || [] }); setProfiles(people); setDetailError('')
      setPendingJoin((result.join_requests || []).some((item) => item.user_id === userId && item.status === 'pending'))
    } catch (failure) { if (alive.current && sequence === detailSequence.current) { setDetail(null); setDetailError(chatError(failure)) } }
    finally { if (alive.current && sequence === detailSequence.current) setDetailLoading(false) }
  }, [userId])
  const latestInbox = useRef(loadInbox); latestInbox.current = loadInbox
  const latestDetail = useRef(loadDetail); latestDetail.current = loadDetail
  const refresh = async () => { await Promise.all([latestInbox.current(), latestDetail.current()]) }

  useEffect(() => { alive.current = true; clearChatMediaCache(); void loadInbox(true); return () => { alive.current = false; inboxSequence.current += 1; detailSequence.current += 1; clearChatMediaCache() } }, [userId])
  useEffect(() => { setSelectedId(initialSpaceId || ''); setDetail(null); setDetailError(''); setNotice(''); setPendingJoin(false) }, [initialSpaceId, inviteToken])
  useEffect(() => { void loadDetail(true) }, [selectedId, inviteToken, loadDetail])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (!alive.current || mutation.current) return; void latestInbox.current(); void latestDetail.current() }, 500)
    }
    const channel = supabase.channel(`community-inbox:${userId}:${kind}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_spaces' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_invitations', filter: `user_id=eq.${userId}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_posts' }, changed)
      .subscribe()
    window.addEventListener('focus', changed)
    window.addEventListener('xelay-chat-updated', changed)
    return () => { if (timer) clearTimeout(timer); window.removeEventListener('focus', changed); window.removeEventListener('xelay-chat-updated', changed); void supabase.removeChannel(channel) }
  }, [userId, kind])
  useEffect(() => {
    if (!selectedId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (!mutation.current) void latestDetail.current() }, 300) }
    const channel = supabase.channel(`community-detail:${selectedId}:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_spaces', filter: `id=eq.${selectedId}` }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_join_requests', filter: `space_id=eq.${selectedId}` }, changed)
      .subscribe()
    return () => { if (timer) clearTimeout(timer); void supabase.removeChannel(channel) }
  }, [selectedId, userId])

  const open = (id: string, spaceKind: ChatSpaceKind) => { setSelectedId(id); setDetail(null); setDetailError(''); setNotice(''); latestOpen.current?.(id, spaceKind) }
  const back = () => { tokenRef.current = undefined; setSelectedId(''); setDetail(null); setDetailError(''); setNotice(''); latestBack.current?.() }
  const run = async (key: string, action: () => Promise<void>) => {
    if (mutation.current) return false
    mutation.current = true; setBusy(key); setNotice(''); setDetailError('')
    try { await action(); announceChatUpdate(); await refresh(); return true }
    catch (failure) { if (alive.current) setDetailError(chatError(failure)); return false }
    finally { mutation.current = false; if (alive.current) setBusy('') }
  }
  const acceptInvitation = (invitation: ChatInvitation, accept: boolean) => run(invitation.id, async () => {
    const id = await chatRpc<string>('xelay_chat_invitation', { p_invitation_id: invitation.id, p_accept: accept })
    if (accept && invitation.space) open(id, invitation.space.kind)
  })
  const join = () => {
    if (!detail) return
    void run('join', async () => {
      const token = tokenRef.current
      const result = token ? await chatRpc<{ space_id: string; status: string }>('xelay_chat_join_link', { p_token: token }) : { space_id: detail.space.id, status: await chatRpc<string>('xelay_chat_join', { p_space_id: detail.space.id }) }
      if (result.status === 'pending') { setPendingJoin(true); setNotice('Заявку надіслано. Адміністратор підтвердить ваш вступ.'); return }
      tokenRef.current = undefined
      open(result.space_id, detail.space.kind)
    })
  }
  const isActive = detail?.my_membership?.status === 'active'
  const isAdmin = isActive && ['owner', 'admin'].includes(detail?.my_membership?.role || '')
  const spaces = inbox.spaces.filter((space) => space.kind === kind)
  const invitations = inbox.invitations.filter((item) => item.space?.kind === kind)
  const showThread = Boolean(selectedId || inviteToken)

  return <section className="space-y-4" aria-label={kind === 'group' ? 'Групові чати' : 'Канали'}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{kind === 'group' ? 'Ваші групи' : 'Ваші канали'}</h2><p className="mt-1 text-xs text-muted-foreground">{kind === 'group' ? 'Спілкуйтеся разом, діліться файлами та планами.' : 'Створюйте публікації та стежте за спільнотами.'}</p></div><button className={chatPrimary} onClick={() => setEditor('create')}><Plus size={17} />{kind === 'group' ? 'Створити групу' : 'Створити канал'}</button></div>
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
          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-background p-3 sm:p-4"><button className={`${chatIcon} md:hidden`} aria-label="До списку чатів" onClick={back}><ArrowLeft size={19} /></button><ChatAvatar space={detail.space} /><button className="min-w-0 flex-1 text-left" onClick={() => isActive && detail.members.length && setMembersOpen(true)}><span className="block truncate text-sm font-semibold">{detail.space.name}</span><span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">{detail.space.visibility === 'private' ? <LockKeyhole size={11} /> : <Globe2 size={11} />}{detail.space.member_count || 0} {detail.space.kind === 'channel' ? 'підписників' : 'учасників'}{detail.space.username && <span className="truncate">· @{detail.space.username}</span>}</span></button>{isActive && <><button className={chatIcon} disabled={Boolean(busy)} aria-label={detail.my_membership?.muted ? 'Увімкнути сповіщення' : 'Вимкнути сповіщення'} title={detail.my_membership?.muted ? 'Увімкнути сповіщення' : 'Вимкнути сповіщення'} onClick={() => run('mute', async () => { await chatRpc('xelay_chat_mute', { p_space_id: detail.space.id, p_muted: !detail.my_membership?.muted }) })}>{detail.my_membership?.muted ? <BellOff size={17} /> : <Bell size={17} />}</button>{isAdmin && <button className={chatIcon} aria-label="Керувати учасниками й запрошеннями" title="Учасники й запрошення" onClick={() => setManagement(true)}><Users size={18} /></button>}{isAdmin && <button className={chatIcon} aria-label="Налаштування чату" onClick={() => setEditor('edit')}><Settings2 size={18} /></button>}<button className={chatIcon} aria-label="Вийти з чату" title="Вийти з чату" onClick={() => setLeaveOpen(true)}><LogOut size={17} /></button></>}</header>
          {notice && <p role="status" className="px-4 py-2 text-sm text-primary">{notice}</p>}
          {detailError && <p role="alert" className="px-4 py-2 text-sm text-destructive">{detailError}</p>}
          {isActive ? <CommunityChatTimeline key={`${detail.space.id}:${userId}`} detail={detail} userId={userId} onRefresh={refresh} /> : <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center"><ChatAvatar space={detail.space} size="h-20 w-20" /><h3 className="text-xl font-semibold">{detail.space.name}</h3><p className="max-w-md whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{detail.space.description || (detail.space.kind === 'channel' ? 'Канал спільноти Xelay' : 'Груповий чат Xelay')}</p>{detail.my_membership?.status === 'banned' ? <p className="text-sm text-destructive">Адміністратор обмежив ваш доступ.</p> : pendingJoin ? <><p className="text-sm text-primary">Ваша заявка очікує підтвердження.</p><button className={chatButton} disabled={Boolean(busy)} onClick={() => run('cancel-request', async () => { await chatRpc('xelay_chat_cancel_request', { p_space_id: detail.space.id }); setPendingJoin(false) })}>Скасувати заявку</button></> : tokenRef.current || detail.space.visibility === 'public' ? <button className={chatPrimary} disabled={Boolean(busy)} onClick={join}>{busy === 'join' && <Loader2 size={16} className="animate-spin" />}{detail.space.join_approval ? 'Подати заявку на вступ' : detail.space.kind === 'channel' ? 'Підписатися' : 'Приєднатися'}</button> : <p className="max-w-sm text-sm text-muted-foreground">Цей чат приватний. Прийміть особисте запрошення або відкрийте посилання від адміністратора.</p>}</div>}
        </> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><p role="alert" className="text-sm text-muted-foreground">{detailError || 'Оберіть чат зі списку.'}</p><button className={chatButton} onClick={() => void loadDetail(true)}><RefreshCw size={15} />Оновити</button><button className={`${chatButton} md:hidden`} onClick={back}>До списку</button></div>}
      </div>
    </div>
    {editor && <CommunityChatEditor userId={userId} kind={editor === 'edit' && detail ? detail.space.kind : kind} isOwner={editor === 'create' || detail?.my_membership?.role === 'owner'} space={editor === 'edit' ? detail?.space : undefined} onClose={() => setEditor(null)} onSaved={async (id, spaceKind) => { open(id, spaceKind); announceChatUpdate(); await refresh() }} />}
    {management && detail && isAdmin && <CommunityChatManagement detail={detail} userId={userId} profiles={profiles} onClose={() => setManagement(false)} onRefresh={refresh} onDeleted={() => { setManagement(false); back(); announceChatUpdate(); void loadInbox() }} />}
    {membersOpen && detail && <ChatDialog title="Учасники" onClose={() => setMembersOpen(false)}><div className="space-y-3">{detail.members.filter((member) => member.status === 'active').map((member) => <div key={member.user_id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3"><ChatPerson id={member.user_id} profile={profiles[member.user_id]} /><span className="text-xs text-muted-foreground">{member.role === 'owner' ? 'Власник' : member.role === 'admin' ? 'Адмін' : ''}</span></div>)}</div></ChatDialog>}
    {leaveOpen && detail && <ChatDialog title="Вийти з чату?" busy={Boolean(busy)} onClose={() => setLeaveOpen(false)}><p className="mb-4 text-sm text-muted-foreground">{detail.my_membership?.role === 'owner' ? 'Перед виходом передайте право власності іншому учаснику в керуванні чатом.' : `Ви залишаєте «${detail.space.name}».`}</p><div className="flex justify-end gap-2"><button className={chatButton} disabled={Boolean(busy)} onClick={() => setLeaveOpen(false)}>Скасувати</button><button className={chatPrimary} disabled={Boolean(busy) || detail.my_membership?.role === 'owner'} onClick={() => run('leave', async () => { await chatRpc('xelay_chat_leave', { p_space_id: detail.space.id }); setLeaveOpen(false); back() })}>Вийти</button></div></ChatDialog>}
  </section>
}
