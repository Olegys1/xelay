import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Building2, Clock3, GraduationCap, Loader2, Newspaper, Plus, ShieldCheck, Settings2, X } from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { AcademicScopePicker } from '../components/AcademicScopePicker'
import { NewsComposer } from '../components/NewsComposer'
import { NewsModerationQueue } from '../components/NewsModerationQueue'
import { NewsSubmissionForm } from '../components/NewsSubmissionForm'
import { NewsCard } from '../components/NewsCard'
import { NewsCategoryManager } from '../components/NewsCategoryManager'
import { HalloweenPumpkin } from '../components/halloween/HalloweenPumpkin'
import { useAuth } from '../context/AuthContext'
import { useNewsUnread } from '../context/NewsUnreadContext'
import { MiniGuide } from '../components/MiniGuide'
import { NEWS_GUIDE } from '../lib/pageGuides'
import { supabase } from '../lib/supabase'
import { getPublicProfiles } from '../lib/profiles'
import { getUniversityNewsLabel, NEWS_TYPE_LABELS, NewsPost, NewsPostType, NewsScope } from '../lib/news'
import { createNewsCategory, listNewsCategorySettings, type NewsCategory, type NewsCategorySettings } from '../lib/newsCategories'

type NewsListItem = NewsPost & { likeCount: number; commentCount: number; likedByMe: boolean; authorName: string }
type UniversityInfo = { id: string; name: string; slug: string }
type NewsFilter = NewsPostType | typeof ALL_TYPES | `category:${string}`
const ALL_TYPES = 'all'
const hasVisibleModal = () => Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((element) => element.getClientRects().length > 0)

export function NewsPage() {
  const { authUser, xelayUser, isAuthenticated, isLoading: authLoading, refreshUser } = useAuth()
  const { unreadByScope, newsRevision, markRead } = useNewsUnread()
  const navigate = useNavigate()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [posts, setPosts] = useState<NewsListItem[]>([])
  const [selectedScope, setSelectedScope] = useState<NewsScope>('faculty')
  const [selectedType, setSelectedType] = useState<NewsFilter>(ALL_TYPES)
  const [categorySnapshot, setCategorySnapshot] = useState<{ scope: string; items: NewsCategory[]; hiddenTypes: NewsPostType[]; version: number; confirmed: boolean; error: boolean }>({ scope: '', items: [], hiddenTypes: [], version: 0, confirmed: false, error: false })
  const [categoryDialog, setCategoryDialog] = useState(false)
  const [categoryManager, setCategoryManager] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [university, setUniversity] = useState<UniversityInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadedFeedKey, setLoadedFeedKey] = useState('')
  const [error, setError] = useState('')
  const [editorRequest, setEditorRequest] = useState<string | null>(null)
  const [requestingEditor, setRequestingEditor] = useState(false)
  const [requestError, setRequestError] = useState('')
  const feedSequence = useRef(0)
  const requestSequence = useRef(0)
  const categorySequence = useRef(0)
  const categorySaveSequence = useRef(0)
  const categorySavingRef = useRef(false)
  const categoryDialogRef = useRef<HTMLDialogElement>(null)
  const feedGridRef = useRef<HTMLDivElement>(null)
  const activeViewRef = useRef('')
  const categoryScopeRef = useRef('')
  const universityId = xelayUser?.universityId
  const academicUnitId = xelayUser?.academicUnitId
  const feedKey = `${authUser?.id || ''}:${universityId || ''}:${academicUnitId || ''}:${selectedScope}`
  const canReadScope = selectedScope === 'platform' || Boolean(universityId && (selectedScope === 'university' || academicUnitId))
  const isScopeEditor = selectedScope === 'platform'
    ? Boolean(xelayUser?.isPlatformNewsEditor)
    : selectedScope === 'university'
      ? Boolean(xelayUser?.editorUniversityIds?.includes(universityId || ''))
      : Boolean(xelayUser?.editorUnitIds?.includes(academicUnitId || ''))
  const universityLabel = getUniversityNewsLabel(university?.id === universityId ? university : null)
  const scopeLabel = selectedScope === 'platform' ? 'Новини платформи' : selectedScope === 'university' ? universityLabel : 'Новини факультету'
  const categoryUniversityId = selectedScope === 'platform' ? null : universityId || null
  const categoryUnitId = selectedScope === 'faculty' ? academicUnitId || null : null
  const categories = categorySnapshot.scope === feedKey ? categorySnapshot.items : []
  const hiddenTypes = categorySnapshot.scope === feedKey ? categorySnapshot.hiddenTypes : []
  categoryScopeRef.current = feedKey
  const viewKey = `${feedKey}:${selectedType}`
  activeViewRef.current = !authLoading && isAuthenticated && !loading && !error && loadedFeedKey === feedKey ? viewKey : ''

  useEffect(() => {
    if (!authLoading && isAuthenticated && !universityId) setSelectedScope('platform')
  }, [authLoading, isAuthenticated, universityId])

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
    if (!authUser?.id || !canReadScope) {
      setPosts([])
      setLoadedFeedKey(feedKey)
      setLoading(false)
      return
    }
    try {
      let query = supabase.from('news_posts')
        .select('*, news_likes(count), news_comments(count)')
        .eq('status', 'published')
        .order('is_pinned', { ascending: false }).order('published_at', { ascending: false })
      query = selectedScope === 'platform'
        ? query.is('university_id', null).is('academic_unit_id', null)
        : selectedScope === 'university'
          ? query.eq('university_id', universityId!).is('academic_unit_id', null)
          : query.eq('university_id', universityId!).eq('academic_unit_id', academicUnitId!)
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
        authorName: authorNames.get(post.published_by) || (selectedScope === 'platform' ? 'Команда Xelay' : selectedScope === 'university' ? 'Адміністрація університету' : xelayUser?.faculty || 'Адміністрація факультету'),
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
  }, [authUser?.id, universityId, academicUnitId, selectedScope, canReadScope, feedKey, xelayUser?.faculty])

  useEffect(() => { void loadNews(); return () => { feedSequence.current += 1 } }, [loadNews, newsRevision])

  const applyCategorySettings = useCallback((settings: NewsCategorySettings) => {
    if (categoryScopeRef.current !== feedKey) return
    setCategorySnapshot({ scope: feedKey, items: settings.categories, hiddenTypes: settings.hidden_types, version: settings.version, confirmed: true, error: false })
    setSelectedType(current => current.startsWith('category:')
      ? settings.categories.some(category => category.id === current.slice('category:'.length) && !category.archived_at) ? current : ALL_TYPES
      : current !== ALL_TYPES && settings.hidden_types.includes(current as NewsPostType) ? ALL_TYPES : current)
  }, [feedKey])

  const loadCategories = useCallback(async () => {
    const sequence = ++categorySequence.current
    if (!authUser?.id || !canReadScope) { setCategorySnapshot({ scope: feedKey, items: [], hiddenTypes: [], version: 0, confirmed: false, error: false }); return }
    try {
      const settings = await listNewsCategorySettings(categoryUniversityId, categoryUnitId)
      if (sequence === categorySequence.current) applyCategorySettings(settings)
    } catch {
      if (sequence === categorySequence.current && categoryScopeRef.current === feedKey) setCategorySnapshot(previous => ({ scope: feedKey, items: previous.scope === feedKey ? previous.items : [], hiddenTypes: previous.scope === feedKey ? previous.hiddenTypes : [], version: previous.scope === feedKey ? previous.version : 0, confirmed: previous.scope === feedKey && previous.confirmed, error: true }))
    }
  }, [authUser?.id, canReadScope, feedKey, categoryUniversityId, categoryUnitId, applyCategorySettings])

  useEffect(() => {
    setCategoryDialog(false); setCategoryManager(false); setCategoryName(''); setCategoryError(''); setCreatingCategory(false)
    categorySavingRef.current = false
    categorySaveSequence.current += 1
    void loadCategories()
    return () => { categorySequence.current += 1; categorySaveSequence.current += 1 }
  }, [loadCategories])

  useEffect(() => {
    if (categoryDialog && !xelayUser?.isPlatformAdmin && !isScopeEditor) { setCategoryDialog(false); return }
    if (categoryDialog && categoryDialogRef.current && !categoryDialogRef.current.open) categoryDialogRef.current.showModal()
  }, [categoryDialog, xelayUser?.isPlatformAdmin, isScopeEditor])

  useEffect(() => { if (!xelayUser?.isPlatformAdmin && !isScopeEditor) setCategoryManager(false) }, [xelayUser?.isPlatformAdmin, isScopeEditor])

  const addCategory = async () => {
    if (categorySavingRef.current || (!xelayUser?.isPlatformAdmin && !isScopeEditor) || !canReadScope) return
    const name = categoryName.trim().replace(/\s+/g, ' ')
    if (name.length < 2 || name.length > 50) { setCategoryError('Назва має містити від 2 до 50 символів.'); return }
    const sequence = ++categorySaveSequence.current
    categorySavingRef.current = true
    setCreatingCategory(true); setCategoryError('')
    try {
      const category = await createNewsCategory(name, categoryUniversityId, categoryUnitId)
      if (sequence !== categorySaveSequence.current || categoryScopeRef.current !== feedKey) return
      categorySequence.current += 1
      try {
        const settings = await listNewsCategorySettings(categoryUniversityId, categoryUnitId)
        if (sequence !== categorySaveSequence.current || categoryScopeRef.current !== feedKey) return
        applyCategorySettings(settings)
      } catch {
        if (sequence !== categorySaveSequence.current || categoryScopeRef.current !== feedKey) return
        setCategorySnapshot(previous => ({ scope: feedKey, items: [...(previous.scope === feedKey ? previous.items : []).filter(item => item.id !== category.id), category].sort((left, right) => left.name.localeCompare(right.name, 'uk')), hiddenTypes: previous.scope === feedKey ? previous.hiddenTypes : [], version: previous.scope === feedKey ? previous.version : 0, confirmed: previous.scope === feedKey && previous.confirmed, error: true }))
      }
      setSelectedType(`category:${category.id}`)
      categoryDialogRef.current?.close(); setCategoryDialog(false); setCategoryName('')
    } catch (creationError) {
      if (sequence === categorySaveSequence.current) setCategoryError(creationError instanceof Error ? creationError.message : 'Не вдалося створити категорію. Спробуйте ще раз.')
    } finally {
      if (sequence === categorySaveSequence.current) { categorySavingRef.current = false; setCreatingCategory(false) }
    }
  }

  useEffect(() => {
    const sequence = ++requestSequence.current
    setEditorRequest(null)
    setRequestError('')
    setRequestingEditor(false)
    if (!authUser?.id || !canReadScope || xelayUser?.isPlatformAdmin || isScopeEditor) return
    const loadRequest = async () => {
      let query = supabase.from('editor_access_requests').select('status')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false }).limit(1)
      query = selectedScope === 'platform'
        ? query.is('university_id', null).is('academic_unit_id', null)
        : selectedScope === 'university'
          ? query.eq('university_id', universityId!).is('academic_unit_id', null)
          : query.eq('university_id', universityId!).eq('academic_unit_id', academicUnitId!)
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
    return selectedType === ALL_TYPES ? posts : selectedType.startsWith('category:')
      ? posts.filter((post) => post.category_id === selectedType.slice('category:'.length))
      : posts.filter((post) => post.post_type === selectedType)
  }, [posts, selectedType, loadedFeedKey, feedKey])

  useEffect(() => {
    if (activeViewRef.current !== viewKey || !visiblePosts.length || !feedGridRef.current || typeof IntersectionObserver === 'undefined') return
    let active = true
    let inFlight = false
    let timer: number | undefined
    const visible = new Map<string, { element: Element; since: number }>()
    const confirmed = new Set<string>()
    const loadedIds = new Set(visiblePosts.map((post) => post.id))
    const isCurrent = () => active && activeViewRef.current === viewKey && document.visibilityState === 'visible' && !hasVisibleModal()
    const clearTimer = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined }
    const schedule = () => {
      clearTimer()
      visible.forEach((item, postId) => { if (!item.element.isConnected) visible.delete(postId) })
      if (!isCurrent() || inFlight || !visible.size) return
      const earliest = Math.min(...Array.from(visible.values(), (item) => item.since + 700))
      timer = window.setTimeout(() => { timer = undefined; void recordViewed() }, Math.max(30, earliest - Date.now()))
    }
    const recordViewed = async () => {
      if (!isCurrent() || inFlight) return
      const ids = Array.from(visible.entries()).filter(([, item]) => item.element.isConnected && Date.now() - item.since >= 700).map(([postId]) => postId)
      if (!ids.length) { schedule(); return }
      inFlight = true
      let recorded = false
      try { recorded = await markRead(ids) } catch { /* A failed receipt keeps the news unread and is retried. */ }
      if (!active) return
      inFlight = false
      if (recorded) {
        ids.forEach((postId) => {
          confirmed.add(postId)
          const item = visible.get(postId)
          if (item) observer.unobserve(item.element)
          visible.delete(postId)
        })
      } else {
        ids.forEach((postId) => { const item = visible.get(postId); if (item) item.since = Date.now() + 4300 })
      }
      schedule()
    }
    const observer = new IntersectionObserver((entries) => {
      if (!active || activeViewRef.current !== viewKey) return
      entries.forEach((entry) => {
        const postId = (entry.target as HTMLElement).dataset.newsPostId
        if (!postId || !loadedIds.has(postId) || confirmed.has(postId)) return
        if (entry.isIntersecting && entry.intersectionRatio >= 0.15) {
          if (!visible.has(postId)) visible.set(postId, { element: entry.target, since: Date.now() })
        } else visible.delete(postId)
      })
      schedule()
    }, { threshold: 0.15 })
    feedGridRef.current.querySelectorAll<HTMLElement>('[data-news-post-id]').forEach((element) => observer.observe(element))
    const onVisibility = () => {
      clearTimer()
      visible.forEach((item) => { item.since = Date.now() })
      schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    let covered = hasVisibleModal()
    const modalObserver = new MutationObserver(() => {
      const nextCovered = hasVisibleModal()
      if (nextCovered === covered) return
      covered = nextCovered
      clearTimer()
      visible.forEach((item) => { item.since = Date.now() })
      schedule()
    })
    modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'hidden'] })
    return () => { active = false; clearTimer(); observer.disconnect(); modalObserver.disconnect(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [authLoading, isAuthenticated, loading, error, loadedFeedKey, feedKey, viewKey, visiblePosts, markRead])

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
    academicStatus={xelayUser?.experience || ''}
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
          <h1 className="text-xl font-bold">Новини Xelay і вашого університету</h1>
          <p className="mt-2 text-sm text-muted-foreground">Увійдіть, щоб читати оновлення платформи, загальні новини університету та новини свого факультету.</p>
          <button onClick={() => setShowAuthModal(true)} className="mt-5 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground">Увійти</button>
        </section>
      </main>
    )
  }
  return (
    <main className="xelay-reference-page min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-5xl px-4 pb-12 pt-7 sm:px-6 sm:pb-16 sm:pt-11 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 sm:mb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:text-xs">{selectedScope === 'platform' ? <Newspaper size={13} className="shrink-0" /> : <Building2 size={13} className="shrink-0" />} {selectedScope === 'platform' ? 'Оновлення та оголошення Xelay' : 'Офіційна інформація університету'}</p>
            <h1 className="text-[32px] font-bold leading-tight tracking-tight text-primary sm:text-4xl">Новини</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{selectedScope === 'platform' ? 'Нові можливості, важливі зміни та плани команди' : selectedScope === 'faculty' ? xelayUser?.faculty || 'Ваш факультет' : university && university.id === universityId ? university.name : 'Ваш університет'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(xelayUser?.isPlatformAdmin || isScopeEditor) && <span className="inline-flex w-fit items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-medium"><ShieldCheck size={15} /> {xelayUser?.isPlatformAdmin ? 'Адміністратор' : selectedScope === 'platform' ? 'Редактор платформи' : selectedScope === 'university' ? 'Редактор університету' : 'Редактор факультету'}</span>}
            {xelayUser?.isPlatformAdmin && <button onClick={() => navigate({ to: '/admin' })} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"><Settings2 size={14} /> Адмінпанель</button>}
          </div>
        </header>

        <HalloweenPumpkin pumpkinId="news" perch="left" className="mb-3" />
        <div className="mb-6 grid grid-cols-1 gap-2 rounded-2xl border border-border/70 bg-muted/35 p-1.5 sm:grid-cols-3" role="tablist" aria-label="Розділ новин">
          {([['faculty', 'Новини факультету', GraduationCap], ['university', universityLabel, Building2], ['platform', 'Новини платформи', Newspaper]] as const).map(([scope, label, Icon]) => <button
            key={scope} id={`news-${scope}-tab`} type="button" role="tab" aria-selected={selectedScope === scope}
            aria-controls="news-scope-panel" disabled={requestingEditor}
            onClick={() => { setSelectedScope(scope); setSelectedType(ALL_TYPES) }}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${selectedScope === scope ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'}`}>
            <Icon size={17} className="shrink-0" />{label}{unreadByScope[scope] && <span className="inline-flex shrink-0 items-center" title="Є непрочитані новини"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" /><span className="sr-only"> — є нові непрочитані новини</span></span>}
          </button>)}
        </div>

        {authUser && <MiniGuide userId={authUser.id} topic="news" label="Підказки для новин" steps={NEWS_GUIDE} />}
        <section id="news-scope-panel" role="tabpanel" aria-labelledby={`news-${selectedScope}-tab`}>
          {!canReadScope ? scopePicker : <>
            <NewsComposer key={`composer:${feedKey}`} userId={authUser!.id} isPlatformAdmin={Boolean(xelayUser?.isPlatformAdmin)}
              isPlatformNewsEditor={Boolean(xelayUser?.isPlatformNewsEditor)}
              categoryRevision={`${categorySnapshot.version}:${categories.map(category => `${category.id}:${category.version || 0}:${category.archived_at || ''}`).join(':')}`}
              universityId={universityId} academicUnitId={academicUnitId} scope={selectedScope}
              editorUnitIds={xelayUser?.editorUnitIds} editorUniversityIds={xelayUser?.editorUniversityIds}
              onPublished={() => void loadNews()} />

            {selectedScope !== 'platform' && isScopeEditor && <NewsModerationQueue key={`moderation:${feedKey}`} isPlatformAdmin={false} universityId={universityId}
              academicUnitId={academicUnitId} scope={selectedScope} onReviewed={() => void loadNews()} />}
            {selectedScope !== 'platform' && !xelayUser?.isPlatformAdmin && !isScopeEditor && <NewsSubmissionForm key={`suggestion:${feedKey}`} scope={selectedScope} />}

            {!xelayUser?.isPlatformAdmin && !isScopeEditor && <section className="xelay-soft-panel mb-6 flex flex-col gap-3 rounded-2xl border border-border/60 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
              <div className="min-w-0 sm:flex-1">
                <p className="text-sm font-semibold">{selectedScope === 'platform' ? 'Хочете долучитися до новин Xelay?' : 'Хочете публікувати офіційні новини?'}</p>
                <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground">{selectedScope === 'platform'
                  ? 'Редакторський доступ до цього розділу запитується окремо. Редактор факультету чи університету не отримує його автоматично. Заявку розгляне адміністрація Xelay.'
                  : selectedScope === 'university'
                  ? 'Подайте окрему заявку на загальні новини університету. Цей доступ не надає права редагувати новини факультету.'
                  : 'Подайте заявку на новини свого факультету. Доступ до загальних новин університету запитується окремо.'}</p>
              </div>
              {editorRequest === 'pending' ? <span className="inline-flex shrink-0 items-center gap-2 text-xs leading-relaxed text-muted-foreground"><Clock3 size={15} className="shrink-0" aria-hidden="true" /> Заявка очікує на розгляд</span>
                : <button onClick={() => void requestEditorAccess()} disabled={requestingEditor} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-start rounded-full border border-border bg-card/75 px-4 py-2 text-xs font-semibold transition-colors hover:bg-card disabled:opacity-50 sm:self-auto">{requestingEditor && <Loader2 size={15} className="animate-spin" />} {selectedScope === 'platform' ? 'Запросити доступ до новин Xelay' : selectedScope === 'university' ? 'Доступ до загальних новин' : 'Доступ до новин факультету'}</button>}
              {requestError && <p role="alert" className="text-sm text-destructive sm:basis-full">{requestError}</p>}
            </section>}

            <div className="xelay-news-filters -mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1.5 sm:mb-6" role="tablist" aria-label={`Тип публікації: ${scopeLabel}`}>
              {([[ALL_TYPES, 'Усі'], ...(categorySnapshot.scope === feedKey && categorySnapshot.confirmed ? Object.entries(NEWS_TYPE_LABELS).filter(([type]) => !hiddenTypes.includes(type as NewsPostType)) : []), ...categories.filter(category => !category.archived_at).map(category => [`category:${category.id}`, category.name])] as [string, string][]).map(([type, label]) => <button
                key={type} type="button" role="tab" aria-selected={selectedType === type} onClick={() => setSelectedType(type as NewsFilter)}
                className={`min-h-10 shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${selectedType === type ? 'border-primary bg-primary text-primary-foreground' : 'border-border/80 bg-card hover:border-primary/20 hover:bg-accent hover:text-accent-foreground'}`}>
                {label}
              </button>)}
              {(xelayUser?.isPlatformAdmin || isScopeEditor) && <button type="button" onClick={() => { setCategoryName(''); setCategoryError(''); setCategoryDialog(true) }} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border bg-card px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary"><Plus size={15} aria-hidden="true" /> Категорія</button>}
              {(xelayUser?.isPlatformAdmin || isScopeEditor) && <button type="button" onClick={() => setCategoryManager(true)} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"><Settings2 size={15} aria-hidden="true" />Керувати категоріями</button>}
            </div>
            {categorySnapshot.scope === feedKey && categorySnapshot.error && <p role="status" className="mb-4 text-xs text-muted-foreground">Не вдалося оновити категорії. Публікації залишаються доступними у вкладці «Усі». <button type="button" onClick={() => void loadCategories()} className="font-medium text-primary underline">Спробувати ще раз</button></p>}

            {error && loadedFeedKey === feedKey && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
            {loading || loadedFeedKey !== feedKey ? <div className="xelay-card flex min-h-52 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
              : visiblePosts.length === 0 ? <section className="rounded-3xl border border-dashed border-border bg-muted/20 px-6 py-14 text-center sm:py-16">
                <span className="xelay-soft-panel mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-primary/70"><Newspaper size={25} /></span>
                <h2 className="font-semibold">Поки немає публікацій</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{selectedScope === 'platform' ? 'Оновлення та оголошення команди Xelay з’являться тут після публікації.' : selectedScope === 'university' ? 'Загальні новини університету з’являться тут після публікації редактором.' : 'Офіційні новини вашого підрозділу з’являться тут після публікації редактором.'}</p>
              </section> : <div ref={feedGridRef} className="grid items-start gap-4 md:grid-cols-2 lg:gap-5">
                {visiblePosts.map((post) => <div key={post.id} data-news-post-id={post.id} className="min-w-0 [&>button]:w-full"><NewsCard post={{ ...post, categoryName: categories.find((category) => category.id === post.category_id)?.name }} onOpen={() => navigate({ to: '/news/$id', params: { id: post.id } })} /></div>)}
              </div>}
          </>}
        </section>
        {categoryManager && (xelayUser?.isPlatformAdmin || isScopeEditor) && <NewsCategoryManager key={`manage:${feedKey}`} universityId={categoryUniversityId} academicUnitId={categoryUnitId} scopeLabel={selectedScope === 'faculty' ? `${scopeLabel} · ${xelayUser?.faculty || 'ваш підрозділ'}` : scopeLabel} onChanged={settings => { categorySequence.current += 1; applyCategorySettings(settings) }} onClose={() => setCategoryManager(false)} />}
        {categoryDialog && (xelayUser?.isPlatformAdmin || isScopeEditor) && <dialog ref={categoryDialogRef} role="dialog" aria-modal="true" aria-labelledby="news-category-title" aria-describedby="news-category-description"
          onCancel={(event) => { event.preventDefault(); if (!creatingCategory) { categoryDialogRef.current?.close(); setCategoryDialog(false) } }}
          onClose={() => { if (!creatingCategory) setCategoryDialog(false) }}
          className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl backdrop:bg-foreground/45 backdrop:backdrop-blur-sm sm:p-6">
          <div className="flex items-start justify-between gap-3"><h2 id="news-category-title" className="text-lg font-bold">Нова категорія</h2><button type="button" disabled={creatingCategory} onClick={() => { categoryDialogRef.current?.close(); setCategoryDialog(false) }} aria-label="Закрити створення категорії" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50"><X size={18} /></button></div>
          <p id="news-category-description" className="mt-2 text-sm text-muted-foreground">Категорія з’явиться лише в розділі «{scopeLabel}»{selectedScope === 'platform' ? '.' : ` для ${selectedScope === 'faculty' ? xelayUser?.faculty || 'вашого факультету' : university?.name || 'вашого університету'}.`}</p>
          <form onSubmit={(event) => { event.preventDefault(); void addCategory() }} className="mt-4 space-y-4">
            <label className="block text-sm font-medium">Назва<input autoFocus value={categoryName} onChange={(event) => setCategoryName(event.target.value)} minLength={2} maxLength={50} required disabled={creatingCategory} placeholder="Наприклад, Оновлення" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            {categoryError && <p role="alert" className="text-sm text-destructive">{categoryError}</p>}
            {categoryError.includes('Відновіть') && <button type="button" disabled={creatingCategory} onClick={() => { categoryDialogRef.current?.close(); setCategoryDialog(false); setCategoryManager(true) }} className="text-sm font-semibold text-primary underline">Відкрити керування категоріями</button>}
            <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={creatingCategory} onClick={() => { categoryDialogRef.current?.close(); setCategoryDialog(false) }} className="min-h-11 rounded-full border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">Скасувати</button><button type="submit" disabled={creatingCategory} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{creatingCategory && <Loader2 size={15} className="animate-spin" />}Створити категорію</button></div>
          </form>
        </dialog>}
      </div>
    </main>
  )
}
