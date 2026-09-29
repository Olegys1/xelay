import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Building2, CalendarDays, Loader2, Newspaper, Pin, ShieldCheck, Settings2 } from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { AcademicScopePicker } from '../components/AcademicScopePicker'
import { NewsComposer } from '../components/NewsComposer'
import { NewsModerationQueue } from '../components/NewsModerationQueue'
import { NewsSubmissionForm } from '../components/NewsSubmissionForm'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatNewsDate, NEWS_TYPE_LABELS, NewsPost, NewsPostType } from '../lib/news'

type NewsListItem = NewsPost & { likeCount: number; commentCount: number; likedByMe: boolean; authorName: string }
const ALL_TYPES = 'all'

export function NewsPage() {
  const { authUser, xelayUser, isAuthenticated, isLoading: authLoading, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [posts, setPosts] = useState<NewsListItem[]>([])
  const [selectedType, setSelectedType] = useState<NewsPostType | typeof ALL_TYPES>(ALL_TYPES)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editorRequest, setEditorRequest] = useState<string | null>(null)
  const [requestingEditor, setRequestingEditor] = useState(false)
  const [requestError, setRequestError] = useState('')

  const loadNews = useCallback(async () => {
    if (!authUser?.id || !xelayUser?.universityId || !xelayUser.academicUnitId) {
      setPosts([])
      setLoading(false)
      return
    }
    setLoading(true)
    const { data, error: newsError } = await supabase
      .from('news_posts')
      .select('id, university_id, academic_unit_id, post_type, title, excerpt, body, image_url, event_starts_at, event_location, organizer, registration_url, status, is_pinned, published_by, published_at, news_likes(count), news_comments(count)')
      .eq('university_id', xelayUser.universityId)
      .eq('academic_unit_id', xelayUser.academicUnitId)
      .eq('status', 'published')
      .order('is_pinned', { ascending: false })
      .order('published_at', { ascending: false })

    if (newsError) {
      console.error('Could not load faculty news:', newsError)
      setError('Не вдалося завантажити стрічку новин. Переконайтеся, що міграцію застосовано.')
      setLoading(false)
      return
    }

    const rows = (data || []) as any[]
    const postIds = rows.map((post) => post.id)
    const authorIds = [...new Set(rows.map((post) => post.published_by))]
    const [likesResult, authorsResult] = await Promise.all([
      postIds.length
        ? supabase.from('news_likes').select('post_id').eq('user_id', authUser.id).in('post_id', postIds)
        : Promise.resolve({ data: [], error: null }),
      authorIds.length
        ? supabase.from('profiles').select('id, full_name').in('id', authorIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    const likedIds = new Set((likesResult.data || []).map((like: any) => like.post_id))
    const authorNames = new Map((authorsResult.data || []).map((author: any) => [author.id, author.full_name]))
    setPosts(rows.map((post) => ({
      ...post,
      likeCount: post.news_likes?.[0]?.count || 0,
      commentCount: post.news_comments?.[0]?.count || 0,
      likedByMe: likedIds.has(post.id),
      authorName: authorNames.get(post.published_by) || xelayUser.faculty || 'Адміністрація факультету',
    })))
    setError('')
    setLoading(false)
  }, [authUser?.id, xelayUser?.universityId, xelayUser?.academicUnitId, xelayUser?.faculty])

  useEffect(() => { void loadNews() }, [loadNews])

  useEffect(() => {
    if (!authUser?.id || xelayUser?.isPlatformAdmin || xelayUser?.editorUnitIds?.includes(xelayUser.academicUnitId || '')) return
    const loadRequest = async () => {
      const { data } = await supabase.from('editor_access_requests')
        .select('status').eq('user_id', authUser.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      setEditorRequest(data?.status || null)
    }
    void loadRequest()
  }, [authUser?.id, xelayUser?.isPlatformAdmin, xelayUser?.editorUnitIds, xelayUser?.academicUnitId])

  const visiblePosts = useMemo(
    () => selectedType === ALL_TYPES ? posts : posts.filter((post) => post.post_type === selectedType),
    [posts, selectedType]
  )

  const requestEditorAccess = async () => {
    setRequestingEditor(true)
    setRequestError('')
    const { error: submitError } = await supabase.rpc('xelay_submit_editor_request', { p_message: '' })
    setRequestingEditor(false)
    if (submitError) {
      setRequestError('Не вдалося подати заявку. Можливо, вона вже очікує на розгляд.')
    } else {
      setEditorRequest('pending')
    }
  }

  if (authLoading) return <main className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin" /></main>

  if (!isAuthenticated) {
    return (
      <main className="flex min-h-[70vh] items-center justify-center px-4">
        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
        <section className="xelay-card max-w-md p-8 text-center">
          <Newspaper size={34} className="mx-auto mb-3 text-muted-foreground" />
          <h1 className="text-xl font-bold">Новини вашого факультету</h1>
          <p className="mt-2 text-sm text-muted-foreground">Увійдіть, щоб читати офіційні новини свого університету.</p>
          <button onClick={() => setShowAuthModal(true)} className="mt-5 rounded-full bg-foreground px-5 py-2.5 font-medium text-background">Увійти</button>
        </section>
      </main>
    )
  }

  if (!xelayUser?.universityId || !xelayUser.academicUnitId) {
    return (
      <main className="min-h-[70vh] bg-background px-4 py-10 sm:py-16">
        <AcademicScopePicker
          initialUniversityId={xelayUser?.universityId}
          initialAcademicUnitId={xelayUser?.academicUnitId}
          onSave={async (universityId, academicUnitId, academicUnitName) => {
            const { error: profileError } = await supabase.from('profiles').update({
              university_id: universityId,
              academic_unit_id: academicUnitId,
              faculty: academicUnitName,
            }).eq('id', authUser!.id)
            if (profileError) throw profileError
            await refreshUser()
          }}
        />
      </main>
    )
  }

  const isFacultyEditor = Boolean(xelayUser.editorUnitIds?.includes(xelayUser.academicUnitId))

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-background">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Building2 size={14} /> Офіційна інформація університету</p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Новини</h1>
            <p className="mt-1 text-sm text-muted-foreground">{xelayUser.faculty || 'Ваш факультет'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(xelayUser.isPlatformAdmin || isFacultyEditor) && <span className="inline-flex w-fit items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-medium"><ShieldCheck size={15} /> Редакторський доступ</span>}
            {xelayUser.isPlatformAdmin && <button onClick={() => navigate({ to: '/admin' })} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"><Settings2 size={14} /> Адмінпанель</button>}
          </div>
        </header>

        <NewsComposer
          userId={authUser!.id}
          isPlatformAdmin={Boolean(xelayUser.isPlatformAdmin)}
          universityId={xelayUser.universityId}
          academicUnitId={xelayUser.academicUnitId}
          editorUnitIds={xelayUser.editorUnitIds}
          onPublished={() => void loadNews()}
        />

        {isFacultyEditor && <NewsModerationQueue isPlatformAdmin={false} academicUnitId={xelayUser.academicUnitId} onReviewed={() => void loadNews()} />}
        {!xelayUser.isPlatformAdmin && !isFacultyEditor && <NewsSubmissionForm />}

        {!xelayUser.isPlatformAdmin && !isFacultyEditor && (
          <section className="xelay-card mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div><p className="text-sm font-semibold">Хочете публікувати офіційні новини?</p><p className="mt-1 text-xs text-muted-foreground">Надішліть заявку. Адміністратор розгляне її та надасть доступ до вашого підрозділу.</p></div>
            {editorRequest === 'pending' ? <span className="shrink-0 text-sm text-muted-foreground">Заявка очікує на розгляд</span> : <button onClick={() => void requestEditorAccess()} disabled={requestingEditor} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">{requestingEditor && <Loader2 size={15} className="animate-spin" />} Подати заявку</button>}
            {requestError && <p role="alert" className="text-sm text-destructive sm:basis-full">{requestError}</p>}
          </section>
        )}

        <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Фільтр новин за типом">
          {([[ALL_TYPES, 'Усі'], ...Object.entries(NEWS_TYPE_LABELS)] as [string, string][]).map(([type, label]) => (
            <button key={type} type="button" role="tab" aria-selected={selectedType === type} onClick={() => setSelectedType(type as NewsPostType | typeof ALL_TYPES)}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${selectedType === type ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-accent hover:text-accent-foreground'}`}>
              {label}
            </button>
          ))}
        </div>

        {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {loading ? (
          <div className="xelay-card flex min-h-52 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
        ) : visiblePosts.length === 0 ? (
          <section className="xelay-card px-6 py-14 text-center">
            <Newspaper size={34} className="mx-auto mb-3 text-muted-foreground/60" />
            <h2 className="font-semibold">Поки немає публікацій</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Офіційні новини вашого підрозділу з’являться тут після публікації редактором.</p>
          </section>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {visiblePosts.map((post) => (
              <button key={post.id} type="button" onClick={() => navigate({ to: '/news/$id', params: { id: post.id } })}
                className="xelay-card group overflow-hidden text-left transition-all hover:-translate-y-0.5 hover:shadow-lg">
                {post.image_url ? <img src={post.image_url} alt="" loading="lazy" className="aspect-[16/8] w-full object-cover" /> : <div className="flex aspect-[16/6] items-center justify-center bg-muted"><Newspaper size={32} className="text-muted-foreground/40" /></div>}
                <div className="p-5 sm:p-6">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">{NEWS_TYPE_LABELS[post.post_type]}</span>
                    {post.is_pinned && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700"><Pin size={12} /> Закріплено</span>}
                  </div>
                  <h2 className="text-lg font-semibold leading-snug group-hover:underline">{post.title}</h2>
                  <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{post.excerpt}</p>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                    <span className="truncate font-medium text-foreground">{post.authorName}</span>
                    <span className="inline-flex shrink-0 items-center gap-1.5"><CalendarDays size={13} />{formatNewsDate(post.event_starts_at || post.published_at)}</span>
                  </div>
                  <span className="mt-4 inline-flex items-center rounded-full bg-foreground px-4 py-2 text-xs font-semibold text-background">Детальніше</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
