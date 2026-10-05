import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, CalendarDays, Heart, Loader2, MessageCircle, Send, Share2, X } from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getPublicProfile, getPublicProfiles } from '../lib/profiles'
import { formatNewsDate, getNewsAttachments, getNewsLink, NEWS_TYPE_LABELS, NewsPost } from '../lib/news'
import { NewsImage } from '../components/NewsImage'
import { NewsEditor } from '../components/NewsEditor'
import { NewsManagementActions } from '../components/NewsManagementActions'
import { NewsResources } from '../components/NewsResources'
import { removeNewsFiles, removeNewsImage } from '../lib/newsMedia'

interface NewsComment {
  id: string
  user_id: string
  body: string
  created_at: string
  authorName: string
  avatarUrl: string | null
}

interface ShareDestination {
  id: string
  name: string
  avatarUrl: string | null
  recipientId?: string
  kind: 'personal' | 'group' | 'channel'
}

export function NewsPostPage() {
  const { id } = useParams({ from: '/news/$id' })
  const navigate = useNavigate()
  const { authUser, xelayUser, isAuthenticated, isLoading: authLoading } = useAuth()
  const [post, setPost] = useState<NewsPost | null>(null)
  const [authorName, setAuthorName] = useState('')
  const [comments, setComments] = useState<NewsComment[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sendingComment, setSendingComment] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareSendingTo, setShareSendingTo] = useState('')
  const [shareDestinations, setShareDestinations] = useState<ShareDestination[]>([])
  const [shareError, setShareError] = useState('')
  const [editing, setEditing] = useState(false)
  const loadSequence = useRef(0)
  const shareSequence = useRef(0)
  const shareOperation = useRef(0)
  const shareLock = useRef(false)

  useEffect(() => {
    setShareOpen(false)
    setShareDestinations([])
    setShareLoading(false)
    setShareSendingTo('')
    setShareError('')
    shareLock.current = false
    shareOperation.current += 1
    return () => { shareSequence.current += 1 }
  }, [authUser?.id, id])

  useEffect(() => { setEditing(false) }, [id, authUser?.id, xelayUser?.universityId, xelayUser?.academicUnitId])

  const loadPost = useCallback(async () => {
    const sequence = ++loadSequence.current
    if (!authUser?.id) return
    setLoading(true)
    const { data, error: postError } = await supabase.from('news_posts')
      .select('*')
      .eq('id', id).maybeSingle()
    if (sequence !== loadSequence.current) return
    if (postError || !data) {
      setPost(null)
      setError('Не вдалося відкрити цю публікацію. Можливо, вона не належить вашому університету або факультету.')
      setLoading(false)
      return
    }
    setPost(data as NewsPost)
    const [authorResult, commentsResult, likesResult, ownLikeResult] = await Promise.all([
      getPublicProfile(data.published_by),
      supabase.from('news_comments').select('id, user_id, body, created_at')
        .eq('post_id', id).order('created_at', { ascending: true }),
      supabase.from('news_likes').select('post_id', { count: 'exact', head: true }).eq('post_id', id),
      supabase.from('news_likes').select('post_id').eq('post_id', id).eq('user_id', authUser.id).maybeSingle(),
    ])
    if (sequence !== loadSequence.current) return
    if (authorResult.error) console.error('Could not load news publisher:', authorResult.error)
    if (commentsResult.error) console.error('Could not load news comments:', commentsResult.error)
    if (likesResult.error) console.error('Could not count news likes:', likesResult.error)
    setAuthorName(authorResult.data?.full_name || (data.academic_unit_id ? 'Адміністрація факультету' : 'Адміністрація університету'))
    const commentProfiles = await getPublicProfiles((commentsResult.data || []).map((comment: any) => comment.user_id))
    if (sequence !== loadSequence.current) return
    const commentAuthors = new Map(commentProfiles.data.map((profile: any) => [profile.id, profile]))
    setComments((commentsResult.data || []).map((comment: any) => ({
      id: comment.id,
      user_id: comment.user_id,
      body: comment.body,
      created_at: comment.created_at,
      authorName: commentAuthors.get(comment.user_id)?.full_name || 'Учасник Xelay',
      avatarUrl: commentAuthors.get(comment.user_id)?.avatar_url || null,
    })))
    setLikeCount(likesResult.count || 0)
    setLiked(Boolean(ownLikeResult.data))
    setError('')
    setLoading(false)
  }, [authUser?.id, id, xelayUser?.universityId, xelayUser?.academicUnitId])

  useEffect(() => { void loadPost(); return () => { loadSequence.current += 1 } }, [loadPost])

  const toggleLike = async () => {
    if (!authUser?.id || !post) return
    const wasLiked = liked
    setLiked(!wasLiked)
    setLikeCount((count) => Math.max(0, count + (wasLiked ? -1 : 1)))
    const result = wasLiked
      ? await supabase.from('news_likes').delete().eq('post_id', post.id).eq('user_id', authUser.id)
      : await supabase.from('news_likes').insert({ post_id: post.id, user_id: authUser.id })
    if (result.error) {
      setLiked(wasLiked)
      setLikeCount((count) => Math.max(0, count + (wasLiked ? 1 : -1)))
      setError('Не вдалося оновити реакцію.')
    }
  }

  const submitComment = async (event: FormEvent) => {
    event.preventDefault()
    const body = commentDraft.trim()
    if (!body || !authUser?.id || !post || sendingComment) return
    setSendingComment(true)
    setError('')
    const { error: commentError } = await supabase.from('news_comments').insert({ post_id: post.id, user_id: authUser.id, body })
    if (commentError) {
      console.error('Could not add news comment:', commentError)
      setError('Не вдалося додати коментар. Спробуйте ще раз.')
    } else {
      setCommentDraft('')
      await loadPost()
    }
    setSendingComment(false)
  }

  const openShare = async () => {
    if (!authUser?.id || !post) return
    const sequence = ++shareSequence.current
    setShareOpen(true)
    setShareLoading(true)
    setShareError('')
    setShareDestinations([])
    try {
    const [personal, community] = await Promise.all([
      supabase.from('conversations').select('id, user_one_id, user_two_id')
        .or(`user_one_id.eq.${authUser.id},user_two_id.eq.${authUser.id}`),
      supabase.rpc('xelay_chat_inbox'),
    ])
    if (sequence !== shareSequence.current) return
    const conversationRows = personal.data
    const destinations: ShareDestination[] = (community.data?.spaces || [])
      .filter((space: any) => space.kind === 'group' || ['owner', 'admin'].includes(space.my_role))
      .map((space: any) => ({ id: space.id, name: space.name, avatarUrl: null, kind: space.kind }))
    if (personal.error) setShareError('Не вдалося завантажити особисті чати.')
    else if (community.error && !['PGRST202', '42883'].includes(community.error.code)) setShareError('Не вдалося завантажити групи та канали.')
    const peers = (conversationRows || []).map((row: any) => ({
      conversationId: row.id,
      peerId: row.user_one_id === authUser.id ? row.user_two_id : row.user_one_id,
    }))
    if (peers.length) {
      const { data: profiles, error: profilesError } = await getPublicProfiles(peers.map((peer) => peer.peerId))
      if (sequence !== shareSequence.current) return
      if (profilesError) setShareError('Не вдалося завантажити учасників особистих чатів.')
      const profileMap = new Map((profiles || []).map((profile: any) => [profile.id, profile]))
      destinations.unshift(...peers.flatMap((peer): ShareDestination[] => {
        const profile = profileMap.get(peer.peerId)
        return profile ? [{ id: peer.conversationId, name: profile.full_name || 'Учасник Xelay', avatarUrl: profile.avatar_url, recipientId: profile.id, kind: 'personal' }] : []
      }))
    }
    setShareDestinations(destinations)
    } catch {
      if (sequence === shareSequence.current) setShareError('Не вдалося завантажити список чатів. Спробуйте ще раз.')
    } finally {
      if (sequence === shareSequence.current) setShareLoading(false)
    }
  }

  const shareToConversation = async (destination: ShareDestination) => {
    if (!authUser?.id || !post || shareLock.current) return
    shareLock.current = true
    const sequence = shareSequence.current
    const operation = ++shareOperation.current
    setShareSendingTo(destination.id)
    setShareError('')
    try {
      const body = `Поділився(-лася) новиною: ${post.title}`
      const { error: sendError } = destination.kind === 'personal' ? await supabase.from('messages').insert({
        conversation_id: destination.id,
        sender_id: authUser.id,
        recipient_id: destination.recipientId,
        body,
        shared_post_id: post.id,
      }) : await supabase.rpc('xelay_chat_send', { p_space_id: destination.id, p_body: body, p_shared_news_post_id: post.id })
      if (sequence !== shareSequence.current || operation !== shareOperation.current) return
      if (sendError) throw sendError
      setShareOpen(false)
      window.dispatchEvent(new Event('xelay-chat-updated'))
    } catch (sendError) {
      if (sequence === shareSequence.current && operation === shareOperation.current) {
        console.error('Could not share news in chat:', sendError)
        setShareError(String((sendError as { message?: string })?.message || '').includes('CHAT_NEWS_ACCESS_DENIED')
          ? 'У спільноти можна пересилати новини вашого університету або факультету, а також новини, які ви маєте право редагувати.'
          : 'Не вдалося надіслати публікацію в цей чат.')
      }
    } finally {
      if (operation === shareOperation.current) {
        shareLock.current = false
        setShareSendingTo('')
      }
    }
  }

  if (authLoading) return <main className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin" /></main>

  if (!isAuthenticated) {
    return (
      <main className="flex min-h-[70vh] items-center justify-center px-4">
        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
        <section className="xelay-card max-w-md p-8 text-center">
          <h1 className="text-xl font-bold">Вхід потрібен для перегляду новин</h1>
          <button onClick={() => setShowAuthModal(true)} className="mt-5 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background">Увійти</button>
        </section>
      </main>
    )
  }

  if (loading) return <main className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin" /></main>

  if (!post) {
    return <main className="mx-auto max-w-3xl px-4 py-12"><p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error || 'Публікацію не знайдено.'}</p><button onClick={() => navigate({ to: '/news' })} className="mt-5 inline-flex items-center gap-2 text-sm font-medium"><ArrowLeft size={16} /> До новин</button></main>
  }

  const registrationUrl = getNewsLink(post.registration_url)
  const canManage = Boolean(authUser?.id && (xelayUser?.isPlatformAdmin || (post.academic_unit_id
    ? xelayUser?.editorUnitIds?.includes(post.academic_unit_id)
    : xelayUser?.editorUniversityIds?.includes(post.university_id))))

  const deletePost = async () => {
    if (!authUser?.id || !canManage) throw new Error('News management permission required.')
    const ownAttachmentPaths = getNewsAttachments(post.attachments)
      .filter((attachment) => attachment.path.startsWith(`${authUser.id}/`))
      .map((attachment) => attachment.path)
    const { error: deleteError } = await supabase.rpc('xelay_delete_news_post', { p_post_id: post.id })
    if (deleteError) throw deleteError
    if (post.image_path?.startsWith(`${authUser.id}/`)) await removeNewsImage(post.image_path)
    if (ownAttachmentPaths.length) await removeNewsFiles(ownAttachmentPaths)
    navigate({ to: '/news' })
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-background px-4 py-6 sm:py-10">
      <article className="mx-auto max-w-3xl">
        <button onClick={() => navigate({ to: '/news' })} className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowLeft size={17} /> До новин</button>
        {canManage && !editing && <NewsManagementActions title={post.title} onEdit={() => setEditing(true)} onDelete={deletePost} />}
        {canManage && editing && <NewsEditor key={post.id} post={post} userId={authUser!.id} onCancel={() => setEditing(false)} onSaved={(updated) => { setPost(updated); setEditing(false) }} />}
        {!editing && <section className="xelay-card overflow-hidden">
          <NewsImage imagePath={post.image_path} imageUrl={post.image_url} className="block h-auto w-full object-contain" />
          <div className="p-5 sm:p-8">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">{NEWS_TYPE_LABELS[post.post_type]}</span>
              <span className="rounded-full bg-primary/5 px-3 py-1 text-xs font-medium text-primary">{post.academic_unit_id ? 'Новини факультету' : 'Загальні новини університету'}</span>
              {post.is_pinned && <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700">Закріплено</span>}
            </div>
            <h1 className="break-words text-2xl font-bold leading-tight sm:text-3xl">{post.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{authorName}</span>
              <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} />Опубліковано {formatNewsDate(post.published_at)}</span>
            </div>
            {post.post_type === 'event' && <dl className="mt-5 grid gap-2 rounded-2xl bg-muted/60 p-4 text-sm sm:grid-cols-2">
              {post.event_starts_at && <div><dt className="text-xs text-muted-foreground">Дата й час події</dt><dd className="mt-0.5 font-medium">{formatNewsDate(post.event_starts_at)} · {new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(new Date(post.event_starts_at))}</dd></div>}
              {post.event_location && <div><dt className="text-xs text-muted-foreground">Місце / формат</dt><dd className="mt-0.5 font-medium">{post.event_location}</dd></div>}
              {post.organizer && <div><dt className="text-xs text-muted-foreground">Організатор</dt><dd className="mt-0.5 font-medium">{post.organizer}</dd></div>}
              {registrationUrl && <div className="sm:col-span-2"><a href={registrationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background">Зареєструватися</a></div>}
            </dl>}
            <p className="mt-6 border-l-2 border-border pl-4 text-base font-medium leading-relaxed text-muted-foreground">{post.excerpt}</p>
            <div className="mt-6 whitespace-pre-wrap break-words text-sm leading-7 sm:text-base">{post.body}</div>
            <NewsResources attachments={post.attachments} links={post.links} linkUrl={post.link_url} className="mt-5" />
            <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-border pt-5">
              <button onClick={() => void toggleLike()} aria-pressed={liked} className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${liked ? 'border-rose-300 bg-rose-500/10 text-rose-600' : 'border-border hover:bg-muted'}`}>
                <Heart size={17} fill={liked ? 'currentColor' : 'none'} /> {likeCount}
              </button>
              <span className="inline-flex min-h-10 items-center gap-2 px-3 text-sm text-muted-foreground"><MessageCircle size={17} /> {comments.length}</span>
              <button onClick={() => void openShare()} className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted"><Share2 size={16} /> Переслати в чат</button>
            </div>
          </div>
        </section>}

        {!editing && <section className="xelay-card mt-5 p-5 sm:p-7">
          <h2 className="text-lg font-semibold">Коментарі <span className="text-sm font-normal text-muted-foreground">{comments.length}</span></h2>
          <form onSubmit={(event) => void submitComment(event)} className="mt-4 flex items-end gap-2">
            <textarea value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} maxLength={3000} rows={2} placeholder="Напишіть коментар…" className="min-h-11 flex-1 resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20" />
            <button type="submit" disabled={!commentDraft.trim() || sendingComment} aria-label="Надіслати коментар" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40">
              {sendingComment ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
            </button>
          </form>
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
          <div className="mt-5 divide-y divide-border">
            {comments.length ? comments.map((comment) => (
              <article key={comment.id} className="flex gap-3 py-4 first:pt-0 last:pb-0">
                <Avatar name={comment.authorName} url={comment.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="text-sm font-semibold">{comment.authorName}</span><time className="text-xs text-muted-foreground">{new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(comment.created_at))}</time></div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{comment.body}</p>
                </div>
              </article>
            )) : <p className="py-8 text-center text-sm text-muted-foreground">Поки немає коментарів. Будьте першими.</p>}
          </div>
        </section>}
      </article>

      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button aria-label="Закрити" onClick={() => setShareOpen(false)} className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" />
          <section role="dialog" aria-modal="true" aria-labelledby="share-news-title" className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="share-news-title" className="text-lg font-semibold">Переслати в чат</h2><p className="mt-1 text-sm text-muted-foreground">Оберіть особистий чат, вашу групу або канал, у якому ви можете публікувати.</p></div><button aria-label="Закрити" onClick={() => setShareOpen(false)} className="rounded-full p-2 hover:bg-muted"><X size={18} /></button></div>
            {shareLoading ? <div className="py-10 text-center"><Loader2 className="mx-auto animate-spin" /></div> : shareDestinations.length ? (
              <div className="mt-4 max-h-[55vh] overflow-y-auto">
                {shareDestinations.map((destination) => <button key={`${destination.kind}-${destination.id}`} onClick={() => void shareToConversation(destination)} disabled={Boolean(shareSendingTo)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted disabled:opacity-60">
                  <Avatar name={destination.name} url={destination.avatarUrl} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{destination.name}</span><span className="text-xs text-muted-foreground">{destination.kind === 'personal' ? 'Особистий чат' : destination.kind === 'group' ? 'Група' : 'Канал'}</span></span>
                  {shareSendingTo === destination.id ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} className="text-muted-foreground" />}
                </button>)}
              </div>
            ) : <p className="py-8 text-center text-sm text-muted-foreground">Поки немає чатів для пересилання. Прийміть запит на спілкування або долучіться до групи.</p>}
            {shareError && <p role="alert" className="mt-3 text-sm text-destructive">{shareError}</p>}
          </section>
        </div>
      )}
    </main>
  )
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-semibold">{url ? <img src={url} alt="" className="h-full w-full object-cover" /> : initials}</span>
}
