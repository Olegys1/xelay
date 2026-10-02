import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Building2, Clock3, GraduationCap, Loader2, Newspaper, ShieldCheck, Settings2 } from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { AcademicScopePicker } from '../components/AcademicScopePicker'
import { NewsComposer } from '../components/NewsComposer'
import { NewsModerationQueue } from '../components/NewsModerationQueue'
import { NewsSubmissionForm } from '../components/NewsSubmissionForm'
import { NewsCard } from '../components/NewsCard'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getPublicProfiles } from '../lib/profiles'
import { getUniversityNewsLabel, NEWS_TYPE_LABELS, NewsPost, NewsPostType, NewsScope } from '../lib/news'

type NewsListItem = NewsPost & { likeCount: number; commentCount: number; likedByMe: boolean; authorName: string }
type UniversityInfo = { id: string; name: string; slug: string }
const ALL_TYPES = 'all'

export function NewsPage() {
  const { authUser, xelayUser, isAuthenticated, isLoading: authLoading, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [posts, setPosts] = useState<NewsListItem[]>([])
  const [selectedScope, setSelectedScope] = useState<NewsScope>('faculty')
  const [selectedType, setSelectedType] = useState<NewsPostType | typeof ALL_TYPES>(ALL_TYPES)
  const [university, setUniversity] = useState<UniversityInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadedFeedKey, setLoadedFeedKey] = useState('')
  const [error, setError] = useState('')
  const [editorRequest, setEditorRequest] = useState<string | null>(null)
  const [requestingEditor, setRequestingEditor] = useState(false)
  const [requestError, setRequestError] = useState('')
  const feedSequence = useRef(0)
  const requestSequence = useRef(0)
  const universityId = xelayUser?.universityId
  const academicUnitId = xelayUser?.academicUnitId
  const feedKey = `${authUser?.id || ''}:${universityId || ''}:${academicUnitId || ''}:${selectedScope}`
  const canReadScope = Boolean(universityId && (selectedScope === 'university' || academicUnitId))
  const isScopeEditor = selectedScope === 'university'
    ? Boolean(xelayUser?.editorUniversityIds?.includes(universityId || ''))
    : Boolean(xelayUser?.editorUnitIds?.includes(academicUnitId || ''))
  const universityLabel = getUniversityNewsLabel(university?.id === universityId ? university : null)
  const scopeLabel = selectedScope === 'university' ? universityLabel : 'Новини факультету'

  useEffect(() => {
    let cancelled = false
    setUniversity(null)
    if (!universityId) return
    const load = async () => {
      const { data } = await supabase.from('universities').select('id, name, slug').eq('id', universityId).maybeSingle()
      if (!cancelled) setUniversity(data as UniversityInfo | null)
    }
    void load()
    return () => { cancelled = true }
  }, [universityId])

  const loadNews = useCallback(async () => {
    const sequence = ++feedSequence.current
    setError('')
    setLoading(true)
    if (!authUser?.id || !universityId || (selectedScope === 'faculty' && !academicUnitId)) {
      setPosts([])
      setLoadedFeedKey(feedKey)
      setLoading(false)
      return
    }
    try {
      let query = supabase.from('news_posts')
        .select('*, news_likes(count), news_comments(count)')
        .eq('university_id', universityId).eq('status', 'published')
        .order('is_pinned', { ascending: false }).order('published_at', { ascending: false })
      query = selectedScope === 'university' ? query.is('academic_unit_id', null) : query.eq('academic_unit_id', academicUnitId!)
      const { data, error: newsError } = await query
      if (sequence !== feedSequence.current) return
      if (newsError) throw newsError
      const rows = (data || []) as any[]
      const postIds = rows.map((post) => post.id)
      const authorIds = [...new Set(rows.map((post) => post.published_by))]
      const [likesResult, authorsResult] = await Promise.all([
        postIds.length ? supabase.from('news_likes').select('post_id').eq('user_id', authUser.id).in('post_id', postIds) : Promise.resolve({ data: [], error: null }),
        authorIds.length ? getPublicProfiles(authorIds) : Promise.resolve({ data: [], error: null }),
      ])
      if (sequence !== feedSequence.current) return
      const likedIds = new Set((likesResult.data || []).map((like: any) => like.post_id))
      const authorNames = new Map((authorsResult.data || []).map((author: any) => [author.id, author.full_name]))
      setPosts(rows.map((post) => ({
        ...post,
        likeCount: post.news_likes?.[0]?.count || 0,
        commentCount: post.news_comments?.[0]?.count || 0,
        likedByMe: likedIds.has(post.id),
        authorName: authorNames.get(post.published_by) || (selectedScope === 'university' ? 'Адміністрація університету' : xelayUser?.faculty || 'Адміністрація факультету'),
      })))
    } catch (newsError) {
      if (sequence !== feedSequence.current) return
      console.error('Could not load news:', newsError)
      setPosts([])
      setError('Не вдалося завантажити стрічку новин. Перевірте, чи застосовано міграцію новин у Supabase.')
    }
    if (sequence === feedSequence.current) {
      setLoadedFeedKey(feedKey)
      setLoading(false)
    }
  }, [authUser?.id, universityId, academicUnitId, selectedScope, feedKey, xelayUser?.faculty])

  useEffect(() => { void loadNews(); return () => { feedSequence.current += 1 } }, [loadNews])

  useEffect(() => {
    const sequence = ++requestSequence.current
    setEditorRequest(null)
    setRequestError('')
    setRequestingEditor(false)
    if (!authUser?.id || !universityId || !canReadScope || xelayUser?.isPlatformAdmin || isScopeEditor) return
    const loadRequest = async () => {
      let query = supabase.from('editor_access_requests').select('status')
        .eq('user_id', authUser.id).eq('university_id', universityId)
        .order('created_at', { ascending: false }).limit(1)
      query = selectedScope === 'university' ? query.is('academic_unit_id', null) : query.eq('academic_unit_id', academicUnitId!)
      const { data, error: loadError } = await query.maybeSingle()
      if (sequence !== requestSequence.current) return
      if (loadError) setRequestError('Не вдалося перевірити стан заявки. Оновіть сторінку.')
      else setEditorRequest(data?.status || null)
    }
    void loadRequest()
    return () => { requestSequence.current += 1 }
  }, [authUser?.id, universityId, academicUnitId, selectedScope, canReadScope, xelayUser?.isPlatformAdmin, isScopeEditor])

  const visiblePosts = useMemo(() => {
    if (loadedFeedKey !== feedKey) return []
    return selectedType === ALL_TYPES ? posts : posts.filter((post) => post.post_type === selectedType)
  }, [posts, selectedType, loadedFeedKey, feedKey])

  const requestEditorAccess = async () => {
    if (requestingEditor || editorRequest === 'pending' || !canReadScope) return
    const sequence = ++requestSequence.current
    setRequestingEditor(true)
    setRequestError('')
    try {
      const { error: submitError } = await supabase.rpc('xelay_request_editor_access', { p_message: '', p_scope: selectedScope })
      if (sequence !== requestSequence.current) return
      if (submitError) throw submitError
      setEditorRequest('pending')
    } catch (submitError) {
      if (sequence !== requestSequence.current) return
      console.error('Could not request news editor access:', submitError)
      setRequestError('Не вдалося подати заявку. Можливо, вона вже очікує на розгляд. Перевірте міграцію новин і спробуйте ще раз.')
    } finally {
      if (sequence === requestSequence.current) setRequestingEditor(false)
    }
  }

  const scopePicker = <AcademicScopePicker
    initialUniversityId={universityId} initialAcademicUnitId={academicUnitId}
    initialSpecialtyId={xelayUser?.specialtyId} initialSpecialtyName={xelayUser?.specialty}
    onSave={async (nextUniversityId, nextAcademicUnitId, academicUnitName, specialtyId, specialtyName) => {
      const { error: profileError } = await supabase.from('profiles').update({
        university_id: nextUniversityId, academic_unit_id: nextAcademicUnitId, faculty: academicUnitName,
        specialty_id: specialtyId, specialty: specialtyName,
      }).eq('id', authUser!.id)
      if (profileError) throw profileError
      await refreshUser()
    }}
  />

  if (authLoading) return <main className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin" /></main>
  if (!isAuthenticated) {
    return (
      <main className="xelay-reference-page flex min-h-[70vh] items-center justify-center px-4">
        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
        <section className="xelay-card max-w-md p-8 text-center">
          <Newspaper size={34} className="mx-auto mb-3 text-muted-foreground" />
          <h1 className="text-xl font-bold">Новини вашого університету</h1>
          <p className="mt-2 text-sm text-muted-foreground">Увійдіть, щоб читати загальні новини університету та новини свого факультету.</p>
          <button onClick={() => setShowAuthModal(true)} className="mt-5 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground">Увійти</button>
        </section>
      </main>
    )
  }
  if (!universityId) return <main className="xelay-reference-page min-h-[70vh] px-4 py-10 sm:py-16">{scopePicker}</main>

  return (
    <main className="xelay-reference-page min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-5xl px-4 pb-12 pt-7 sm:px-6 sm:pb-16 sm:pt-11 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 sm:mb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:text-xs"><Building2 size={13} className="shrink-0" /> Офіційна інформація університету</p>
            <h1 className="text-[32px] font-bold leading-tight tracking-tight text-primary sm:text-4xl">Новини</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{selectedScope === 'faculty' ? xelayUser?.faculty || 'Ваш факультет' : university?.id === universityId ? university.name : 'Ваш університет'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(xelayUser?.isPlatformAdmin || isScopeEditor) && <span className="inline-flex w-fit items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-medium"><ShieldCheck size={15} /> {xelayUser?.isPlatformAdmin ? 'Адміністратор' : selectedScope === 'university' ? 'Редактор університету' : 'Редактор факультету'}</span>}
            {xelayUser?.isPlatformAdmin && <button onClick={() => navigate({ to: '/admin' })} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"><Settings2 size={14} /> Адмінпанель</button>}
          </div>
        </header>

        <div className="mb-6 grid grid-cols-1 gap-2 rounded-2xl border border-border/70 bg-muted/35 p-1.5 sm:grid-cols-2" role="tablist" aria-label="Розділ новин">
          {([['faculty', 'Новини факультету', GraduationCap], ['university', universityLabel, Building2]] as const).map(([scope, label, Icon]) => <button
            key={scope} id={`news-${scope}-tab`} type="button" role="tab" aria-selected={selectedScope === scope}
            aria-controls="news-scope-panel" disabled={requestingEditor}
            onClick={() => { setSelectedScope(scope); setSelectedType(ALL_TYPES) }}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${selectedScope === scope ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'}`}>
            <Icon size={17} className="shrink-0" />{label}
          </button>)}
        </div>

        <section id="news-scope-panel" role="tabpanel" aria-labelledby={`news-${selectedScope}-tab`}>
          {!canReadScope ? scopePicker : <>
            <NewsComposer key={`composer:${feedKey}`} userId={authUser!.id} isPlatformAdmin={Boolean(xelayUser?.isPlatformAdmin)}
              universityId={universityId} academicUnitId={academicUnitId} scope={selectedScope}
              editorUnitIds={xelayUser?.editorUnitIds} editorUniversityIds={xelayUser?.editorUniversityIds}
              onPublished={() => void loadNews()} />

            {isScopeEditor && <NewsModerationQueue key={`moderation:${feedKey}`} isPlatformAdmin={false} universityId={universityId}
              academicUnitId={academicUnitId} scope={selectedScope} onReviewed={() => void loadNews()} />}
            {!xelayUser?.isPlatformAdmin && !isScopeEditor && <NewsSubmissionForm key={`suggestion:${feedKey}`} scope={selectedScope} />}

            {!xelayUser?.isPlatformAdmin && !isScopeEditor && <section className="xelay-soft-panel mb-6 flex flex-col gap-3 rounded-2xl border border-border/60 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
              <div className="min-w-0 sm:flex-1">
                <p className="text-sm font-semibold">Хочете публікувати офіційні новини?</p>
                <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground">{selectedScope === 'university'
                  ? 'Подайте окрему заявку на загальні новини університету. Цей доступ не надає права редагувати новини факультету.'
                  : 'Подайте заявку на новини свого факультету. Доступ до загальних новин університету запитується окремо.'}</p>
              </div>
              {editorRequest === 'pending' ? <span className="inline-flex shrink-0 items-center gap-2 text-xs leading-relaxed text-muted-foreground"><Clock3 size={15} className="shrink-0" aria-hidden="true" /> Заявка очікує на розгляд</span>
                : <button onClick={() => void requestEditorAccess()} disabled={requestingEditor} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-start rounded-full border border-border bg-card/75 px-4 py-2 text-xs font-semibold transition-colors hover:bg-card disabled:opacity-50 sm:self-auto">{requestingEditor && <Loader2 size={15} className="animate-spin" />} {selectedScope === 'university' ? 'Доступ до загальних новин' : 'Доступ до новин факультету'}</button>}
              {requestError && <p role="alert" className="text-sm text-destructive sm:basis-full">{requestError}</p>}
            </section>}

            <div className="xelay-news-filters -mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1.5 sm:mb-6" role="tablist" aria-label={`Тип публікації: ${scopeLabel}`}>
              {([[ALL_TYPES, 'Усі'], ...Object.entries(NEWS_TYPE_LABELS)] as [string, string][]).map(([type, label]) => <button
                key={type} type="button" role="tab" aria-selected={selectedType === type} onClick={() => setSelectedType(type as NewsPostType | typeof ALL_TYPES)}
                className={`min-h-10 shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${selectedType === type ? 'border-primary bg-primary text-primary-foreground' : 'border-border/80 bg-card hover:border-primary/20 hover:bg-accent hover:text-accent-foreground'}`}>
                {label}
              </button>)}
            </div>

            {error && loadedFeedKey === feedKey && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
            {loading || loadedFeedKey !== feedKey ? <div className="xelay-card flex min-h-52 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
              : visiblePosts.length === 0 ? <section className="rounded-3xl border border-dashed border-border bg-muted/20 px-6 py-14 text-center sm:py-16">
                <span className="xelay-soft-panel mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-primary/70"><Newspaper size={25} /></span>
                <h2 className="font-semibold">Поки немає публікацій</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{selectedScope === 'university' ? 'Загальні новини університету з’являться тут після публікації редактором.' : 'Офіційні новини вашого підрозділу з’являться тут після публікації редактором.'}</p>
              </section> : <div className="grid items-start gap-4 md:grid-cols-2 lg:gap-5">
                {visiblePosts.map((post) => <NewsCard key={post.id} post={post} onOpen={() => navigate({ to: '/news/$id', params: { id: post.id } })} />)}
              </div>}
          </>}
        </section>
      </div>
    </main>
  )
}
