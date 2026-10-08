import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, Building2, Check, GraduationCap, Loader2, Newspaper, RefreshCw, Users, X } from 'lucide-react'
import { AuthModal } from '../components/AuthModal'
import { NewsComposer } from '../components/NewsComposer'
import { NewsModerationQueue } from '../components/NewsModerationQueue'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getPublicProfiles } from '../lib/profiles'
import { BillingAdminPanel } from '../components/BillingAdminPanel'

interface AdminStats {
  users: number
  universities: number
  published_news: number
  comments: number
  likes: number
  pending_editor_requests: number
  pending_news_submissions: number
}

interface EditorRequest {
  id: string
  user_id: string
  university_id: string
  academic_unit_id: string | null
  message: string
  created_at: string
  profileName: string
  username: string
  avatarUrl: string
  universityName: string
  unitName: string
}

type BasicOption = { id: string; name: string }

interface ClassRepresentativeRequest {
  id: string
  user_id: string
  full_name: string
  university_id: string
  academic_unit_id: string
  specialty: string
  group_name: string
  telegram_username: string | null
  phone: string | null
  created_at: string
  universityName: string
  unitName: string
}

export function AdminPage() {
  const { authUser, xelayUser, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const requestAnchor = useRouterState({ select: (state) => state.location.hash === 'class-representative-requests' })
  const adminUserId = authUser?.id && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin ? authUser.id : null
  const currentAdmin = useRef(adminUserId)
  currentAdmin.current = adminUserId
  const alive = useRef(true)
  const loadGeneration = useRef(0)
  const representativeGeneration = useRef(0)
  const representativeBusy = useRef(false)
  const representativeQueued = useRef(false)
  const requestAnchorHandled = useRef(false)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [requests, setRequests] = useState<EditorRequest[]>([])
  const [editorRequestScope, setEditorRequestScope] = useState<'faculty' | 'university'>('faculty')
  const [classRepresentativeRequests, setClassRepresentativeRequests] = useState<ClassRepresentativeRequest[]>([])
  const [classRepresentativeRequestsError, setClassRepresentativeRequestsError] = useState('')
  const [classRepresentativeRequestsLoading, setClassRepresentativeRequestsLoading] = useState(true)
  const [universities, setUniversities] = useState<BasicOption[]>([])
  const [units, setUnits] = useState<BasicOption[]>([])
  const [loading, setLoading] = useState(true)
  const [reviewingId, setReviewingId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [universityName, setUniversityName] = useState('')
  const [universitySlug, setUniversitySlug] = useState('')
  const [unitUniversityId, setUnitUniversityId] = useState('')
  const [unitName, setUnitName] = useState('')
  const [unitSlug, setUnitSlug] = useState('')
  const [unitType, setUnitType] = useState('faculty')
  const [savingStructure, setSavingStructure] = useState(false)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; loadGeneration.current += 1; representativeGeneration.current += 1 }
  }, [])

  const loadClassRepresentativeRequests = useCallback(async () => {
    if (!adminUserId) return
    if (representativeBusy.current) { representativeQueued.current = true; return }
    representativeBusy.current = true
    const generation = ++representativeGeneration.current
    const current = () => alive.current && currentAdmin.current === adminUserId && representativeGeneration.current === generation
    try {
      const result = await supabase.from('class_representative_requests')
        .select('id, user_id, full_name, university_id, academic_unit_id, specialty, group_name, telegram_username, phone, created_at')
        .eq('status', 'pending').order('created_at', { ascending: true })
      if (!current()) return
      if (result.error) throw result.error
      const rows = result.data || []
      const universityIds = [...new Set(rows.map((request) => request.university_id))]
      const unitIds = [...new Set(rows.map((request) => request.academic_unit_id))]
      const [requestUniversities, requestUnits] = await Promise.all([
        universityIds.length ? supabase.from('universities').select('id, name').in('id', universityIds) : Promise.resolve({ data: [], error: null }),
        unitIds.length ? supabase.from('academic_units').select('id, name').in('id', unitIds) : Promise.resolve({ data: [], error: null }),
      ])
      if (!current()) return
      if (requestUniversities.error || requestUnits.error) throw requestUniversities.error || requestUnits.error
      const universityMap = new Map<string, string>((requestUniversities.data || []).map((university) => [university.id, university.name] as const))
      const unitMap = new Map<string, string>((requestUnits.data || []).map((unit) => [unit.id, unit.name] as const))
      setClassRepresentativeRequests(rows.map((request) => ({
        ...request,
        universityName: universityMap.get(request.university_id) || 'Університет',
        unitName: unitMap.get(request.academic_unit_id) || 'Факультет або інститут',
      })))
      setClassRepresentativeRequestsError('')
    } catch {
      if (current()) setClassRepresentativeRequestsError('Не вдалося оновити заявки старост. Збережені дані можуть бути застарілими. Повторіть перевірку.')
    } finally {
      representativeBusy.current = false
      if (current()) setClassRepresentativeRequestsLoading(false)
    }
  }, [adminUserId])

  const loadAdminData = useCallback(async () => {
    const generation = ++loadGeneration.current
    const current = () => alive.current && currentAdmin.current === adminUserId && loadGeneration.current === generation
    if (!adminUserId) {
      setLoading(false)
      return
    }
    setLoading(true)
    const [statsResult, requestsResult, universitiesResult, unitsResult] = await Promise.all([
      supabase.rpc('xelay_admin_stats'),
      supabase.from('editor_access_requests').select('id, user_id, university_id, academic_unit_id, message, created_at').eq('status', 'pending').order('created_at', { ascending: true }),
      supabase.from('universities').select('id, name').order('name'),
      supabase.from('academic_units').select('id, name').order('name'),
    ])
    if (!current()) return
    if (statsResult.error || requestsResult.error || universitiesResult.error || unitsResult.error) {
      console.error('Could not load admin panel:', statsResult.error || requestsResult.error || universitiesResult.error || unitsResult.error)
      setError('Не вдалося завантажити адмінпанель. Перевірте, чи застосована міграція новин.')
      setLoading(false)
      return
    }
    const requestRows = requestsResult.data || []
    const userIds = [...new Set(requestRows.map((request: any) => request.user_id))]
    const universityIds = [...new Set([
      ...requestRows.map((request: any) => request.university_id),
    ])]
    const unitIds = [...new Set([
      ...requestRows.map((request: any) => request.academic_unit_id),
    ].filter(Boolean))]
    const [profilesResult, requestUniversitiesResult, requestUnitsResult] = await Promise.all([
      getPublicProfiles(userIds),
      universityIds.length ? supabase.from('universities').select('id, name').in('id', universityIds) : Promise.resolve({ data: [], error: null }),
      unitIds.length ? supabase.from('academic_units').select('id, name').in('id', unitIds) : Promise.resolve({ data: [], error: null }),
    ])
    if (!current()) return
    const profileMap = new Map((profilesResult.data || []).map((profile: any) => [profile.id, profile]))
    const universityMap = new Map((requestUniversitiesResult.data || []).map((university: any) => [university.id, university.name]))
    const unitMap = new Map((requestUnitsResult.data || []).map((unit: any) => [unit.id, unit.name]))
    setRequests(requestRows.map((request: any) => ({
      ...request,
      profileName: profileMap.get(request.user_id)?.full_name || 'Учасник Xelay',
      username: profileMap.get(request.user_id)?.username || '',
      avatarUrl: profileMap.get(request.user_id)?.avatar_url || '',
      universityName: universityMap.get(request.university_id) || 'Університет',
      unitName: request.academic_unit_id ? unitMap.get(request.academic_unit_id) || 'Факультет або інститут' : 'Загальні новини університету',
    })))
    setStats(statsResult.data as AdminStats)
    setUniversities((universitiesResult.data || []) as BasicOption[])
    setUnits((unitsResult.data || []) as BasicOption[])
    setUnitUniversityId((current) => current || universitiesResult.data?.[0]?.id || '')
    setError('')
    setLoading(false)
  }, [adminUserId])

  useEffect(() => { void loadAdminData() }, [loadAdminData])

  useEffect(() => {
    setClassRepresentativeRequests([])
    setClassRepresentativeRequestsError('')
    setClassRepresentativeRequestsLoading(Boolean(adminUserId))
    representativeGeneration.current += 1
    representativeQueued.current = false
    if (!adminUserId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      if (!active || document.visibilityState !== 'visible' || timer) return
      timer = setTimeout(async () => {
        timer = null
        if (!active) return
        await loadClassRepresentativeRequests()
        if (representativeQueued.current && active) { representativeQueued.current = false; refresh() }
      }, 200)
    }
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ userId?: string }>).detail?.userId === adminUserId) refresh()
    }
    refresh()
    const poll = setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('xelay:representative-requests-changed', onChanged)
    return () => {
      active = false
      representativeGeneration.current += 1
      clearInterval(poll)
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('xelay:representative-requests-changed', onChanged)
    }
  }, [adminUserId, loadClassRepresentativeRequests])

  useEffect(() => {
    if (!requestAnchor) { requestAnchorHandled.current = false; return }
    if (requestAnchorHandled.current || loading || !adminUserId) return
    const section = document.getElementById('class-representative-requests')
    if (!section) return
    requestAnchorHandled.current = true
    section?.scrollIntoView({ block: 'start' })
    section?.focus({ preventScroll: true })
  }, [requestAnchor, loading, adminUserId])

  const reviewRequest = async (requestId: string, approve: boolean) => {
    setReviewingId(requestId)
    setError('')
    setSuccess('')
    const { error: reviewError } = await supabase.rpc('xelay_review_editor_request', {
      p_request_id: requestId,
      p_approve: approve,
    })
    if (reviewError) {
      setError('Не вдалося обробити заявку. Оновіть сторінку та спробуйте ще раз.')
    } else {
      setSuccess(approve ? 'Редакторський доступ надано. Користувач отримає сповіщення.' : 'Заявку відхилено.')
      await loadAdminData()
    }
    setReviewingId('')
  }

  const reviewClassRepresentativeRequest = async (requestId: string, approve: boolean) => {
    setReviewingId(requestId)
    setError('')
    setSuccess('')
    const { error: reviewError } = await supabase.rpc('xelay_review_class_representative_request', {
      p_request_id: requestId,
      p_approve: approve,
    })
    if (reviewError) {
      console.error('Could not review class representative request:', reviewError)
      setClassRepresentativeRequestsError('Не вдалося обробити заявку старости. Перевірте міграцію та повторіть спробу.')
    } else {
      setSuccess(approve ? 'Статус старости підтверджено. Користувач отримає сповіщення.' : 'Заявку старости відхилено.')
      window.dispatchEvent(new CustomEvent('xelay:representative-requests-changed', { detail: { userId: adminUserId, source: 'review' } }))
      await loadClassRepresentativeRequests()
    }
    setReviewingId('')
  }

  const addUniversity = async (event: FormEvent) => {
    event.preventDefault()
    setSavingStructure(true)
    setError('')
    setSuccess('')
    const { error: addError } = await supabase.rpc('xelay_admin_add_university', {
      p_name: universityName.trim(),
      p_slug: universitySlug.trim().toLowerCase(),
    })
    if (addError) setError('Не вдалося додати університет. Перевірте назву й унікальний латинський код.')
    else {
      setUniversityName('')
      setUniversitySlug('')
      setSuccess('Університет додано.')
      await loadAdminData()
    }
    setSavingStructure(false)
  }

  const addUnit = async (event: FormEvent) => {
    event.preventDefault()
    setSavingStructure(true)
    setError('')
    setSuccess('')
    const { error: addError } = await supabase.rpc('xelay_admin_add_academic_unit', {
      p_university_id: unitUniversityId,
      p_name: unitName.trim(),
      p_slug: unitSlug.trim().toLowerCase(),
      p_unit_type: unitType,
    })
    if (addError) setError('Не вдалося додати підрозділ. Перевірте дані та чи не зайнятий цей код.')
    else {
      setUnitName('')
      setUnitSlug('')
      setSuccess('Підрозділ додано.')
      await loadAdminData()
    }
    setSavingStructure(false)
  }

  const universityRequests = requests.filter((request) => request.academic_unit_id === null)
  const facultyRequests = requests.filter((request) => request.academic_unit_id !== null)
  const visibleEditorRequests = editorRequestScope === 'university' ? universityRequests : facultyRequests

  if (authLoading) return <main className="flex min-h-[60vh] items-center justify-center"><Loader2 className="animate-spin" /></main>
  if (!isAuthenticated) return (
    <main className="flex min-h-[70vh] items-center justify-center px-4">
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <section className="xelay-card max-w-md p-8 text-center"><h1 className="text-xl font-bold">Адміністрування Xelay</h1><p className="mt-2 text-sm text-muted-foreground">Увійдіть із адміністраторським обліковим записом.</p><button onClick={() => setShowAuthModal(true)} className="mt-5 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background">Увійти</button></section>
    </main>
  )
  if (!adminUserId) return (
      <main className="min-h-[70vh] px-4 py-10"><section className="xelay-card mx-auto max-w-xl p-7 text-center"><h1 className="text-xl font-bold">Немає доступу</h1><p className="mt-2 text-sm text-muted-foreground">Ця панель доступна лише платформним адміністраторам. Подати окремі заявки на доступ до новин факультету та загальних новин університету можна у розділі «Новини».</p><button onClick={() => navigate({ to: '/news' })} className="mt-5 inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted"><ArrowLeft size={16} /> До новин</button></section></main>
  )

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-background px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Xelay · керування платформою</p><h1 className="mt-1 text-2xl font-bold sm:text-3xl">Адмінпанель</h1></div>
          <button onClick={() => navigate({ to: '/news' })} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted"><ArrowLeft size={16} /> До новин</button>
        </header>

        {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {success && <p role="status" className="mb-4 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">{success}</p>}

        {loading ? <div className="xelay-card flex min-h-40 items-center justify-center"><Loader2 className="animate-spin" /></div> : <>
          <section aria-label="Статистика платформи" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <StatCard label="Користувачі" value={stats?.users} icon={<Users size={17} />} />
            <StatCard label="Університети" value={stats?.universities} icon={<Building2 size={17} />} />
            <StatCard label="Опубліковані новини" value={stats?.published_news} icon={<Newspaper size={17} />} />
            <StatCard label="Коментарі" value={stats?.comments} />
            <StatCard label="Вподобання" value={stats?.likes} />
            <StatCard label="Заявки" value={stats?.pending_editor_requests} />
            <StatCard label="Новини на перевірці" value={stats?.pending_news_submissions} />
          </section>

          <BillingAdminPanel key={authUser?.id} />
          <NewsComposer key={authUser!.id} userId={authUser!.id} isPlatformAdmin universityId={xelayUser?.universityId} academicUnitId={xelayUser?.academicUnitId} onPublished={() => void loadAdminData()} />
          <NewsModerationQueue key={authUser!.id} isPlatformAdmin onReviewed={() => void loadAdminData()} />

          <section className="xelay-card mb-6 overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4 sm:px-6"><div><h2 className="font-semibold">Заявки на редакторський доступ</h2><p className="mt-0.5 text-xs text-muted-foreground">Доступ до загальних новин та новин факультету надається окремо. Адміністратори керують обома напрямами.</p></div><span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">{requests.length}</span></header>
            <div role="tablist" aria-label="Напрям редакторських заявок" className="flex flex-wrap gap-2 border-b border-border px-5 py-3 sm:px-6">
              {([['faculty', 'Новини факультетів', facultyRequests.length], ['university', 'Загальні новини', universityRequests.length]] as const).map(([scope, label, count]) => (
                <button key={scope} type="button" role="tab" id={`editor-requests-${scope}-tab`} aria-controls="editor-requests-panel" aria-selected={editorRequestScope === scope} onClick={() => setEditorRequestScope(scope)} className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${editorRequestScope === scope ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{label} <span className="ml-1 text-xs">· {count}</span></button>
              ))}
            </div>
            <div role="tabpanel" id="editor-requests-panel" aria-labelledby={`editor-requests-${editorRequestScope}-tab`}>
            {visibleEditorRequests.length ? <div className="divide-y divide-border">
              {visibleEditorRequests.map((request) => <article key={request.id} className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
                <div className="min-w-0 flex-1">
                  <Link to="/user/$id" params={{ id: request.user_id }} className="group inline-flex max-w-full items-center gap-3 rounded-xl text-foreground hover:text-primary" aria-label={`Відкрити профіль: ${request.profileName}`}>
                    {request.avatarUrl ? <img src={request.avatarUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-full object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{request.profileName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('')}</span>}
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold group-hover:underline">{request.profileName}</span>{request.username && <span className="block truncate text-xs text-muted-foreground">@{request.username}</span>}<span className="block text-[11px] text-primary">Відкрити профіль</span></span>
                  </Link>
                  <p className="mt-2 text-xs text-muted-foreground">{request.universityName} · {request.unitName}</p>
                  <p className="mt-1 text-xs font-semibold text-primary">{request.academic_unit_id === null ? 'Доступ до загальних новин університету' : 'Доступ лише до новин цього факультету'}</p>
                  {request.message && <p className="mt-2 whitespace-pre-wrap text-sm">{request.message}</p>}<time className="mt-2 block text-[11px] text-muted-foreground">{new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.created_at))}</time>
                </div>
                <div className="flex shrink-0 gap-2"><button onClick={() => void reviewRequest(request.id, true)} disabled={Boolean(reviewingId)} className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">{reviewingId === request.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Прийняти</button><button onClick={() => void reviewRequest(request.id, false)} disabled={Boolean(reviewingId)} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><X size={15} /> Відхилити</button></div>
              </article>)}
            </div> : <p className="px-6 py-10 text-center text-sm text-muted-foreground">{editorRequestScope === 'university' ? 'Немає заявок на доступ до загальних новин.' : 'Немає заявок на доступ до новин факультетів.'}</p>}
            </div>
          </section>

          <section id="class-representative-requests" tabIndex={-1} aria-labelledby="class-representative-requests-title" className="xelay-card mb-6 scroll-mt-28 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h2 id="class-representative-requests-title" className="flex items-center gap-2 font-semibold"><GraduationCap size={18} className="text-primary" /> Заявки старост</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Черга оновлюється автоматично. Перевірте дані заявника та підтвердьте його статус для вказаної групи.</p>
              </div>
              <div className="flex items-center gap-2"><button type="button" disabled={classRepresentativeRequestsLoading} onClick={() => void loadClassRepresentativeRequests()} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"><RefreshCw size={14} aria-hidden="true" /> Оновити</button><span aria-label="Кількість заявок старост" className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">{classRepresentativeRequestsLoading ? '…' : classRepresentativeRequests.length}</span></div>
            </header>
            {classRepresentativeRequestsError && <p role="alert" className="mx-5 mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive sm:mx-6">{classRepresentativeRequestsError}</p>}
            {classRepresentativeRequests.length ? (
              <div className="divide-y divide-border">
                {classRepresentativeRequests.map((request) => (
                  <article key={request.id} className="flex flex-col gap-4 px-5 py-4 sm:px-6 lg:flex-row lg:items-center">
                    <div className="min-w-0 flex-1">
                      <button type="button" onClick={() => navigate({ to: '/user/$id', params: { id: request.user_id } })} className="break-words text-left text-sm font-semibold text-foreground hover:text-primary hover:underline">
                        {request.full_name} · {request.group_name}
                      </button>
                      <p className="mt-1 break-words text-xs text-muted-foreground">{request.universityName} · {request.unitName} · {request.specialty}</p>
                      {request.telegram_username ? (
                        <a className="mt-1 inline-block text-sm text-primary hover:underline" href={`https://t.me/${request.telegram_username.replace(/^@/, '')}`} target="_blank" rel="noreferrer">Telegram: @{request.telegram_username.replace(/^@/, '')}</a>
                      ) : request.phone ? (
                        <a className="mt-1 inline-block text-sm text-primary hover:underline" href={`tel:${request.phone}`}>Телефон: {request.phone}</a>
                      ) : null}
                      <time className="mt-1 block text-[11px] text-muted-foreground">{new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.created_at))}</time>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => void reviewClassRepresentativeRequest(request.id, true)} disabled={Boolean(reviewingId)} className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                        {reviewingId === request.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Підтвердити
                      </button>
                      <button type="button" onClick={() => void reviewClassRepresentativeRequest(request.id, false)} disabled={Boolean(reviewingId)} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
                        <X size={15} /> Відхилити
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              !classRepresentativeRequestsError && <p className="px-6 py-10 text-center text-sm text-muted-foreground">{classRepresentativeRequestsLoading ? 'Перевіряємо заявки старост…' : 'Немає заявок, що очікують на розгляд.'}</p>
            )}
          </section>

          <section className="xelay-card p-5 sm:p-6">
            <div className="mb-4"><h2 className="font-semibold">Університети та підрозділи</h2><p className="mt-1 text-xs text-muted-foreground">Додавайте університети й факультети для подальшого масштабування.</p></div>
            <div className="grid gap-6 lg:grid-cols-2">
              <form onSubmit={(event) => void addUniversity(event)} className="space-y-3 rounded-2xl border border-border p-4">
                <h3 className="text-sm font-semibold">Додати університет</h3>
                <input value={universityName} onChange={(event) => setUniversityName(event.target.value)} required minLength={3} maxLength={180} placeholder="Повна назва університету" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
                <input value={universitySlug} onChange={(event) => setUniversitySlug(event.target.value.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase())} required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="Короткий код латиницею, наприклад knu" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
                <button disabled={savingStructure} className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Додати університет</button>
              </form>
              <form onSubmit={(event) => void addUnit(event)} className="space-y-3 rounded-2xl border border-border p-4">
                <h3 className="text-sm font-semibold">Додати факультет або інститут</h3>
                <select value={unitUniversityId} onChange={(event) => setUnitUniversityId(event.target.value)} required className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm"><option value="">Оберіть університет</option>{universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}</select>
                <input value={unitName} onChange={(event) => setUnitName(event.target.value)} required minLength={3} maxLength={180} placeholder="Назва підрозділу" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
                <div className="grid gap-3 sm:grid-cols-2"><input value={unitSlug} onChange={(event) => setUnitSlug(event.target.value.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase())} required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="Короткий код латиницею" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" /><select value={unitType} onChange={(event) => setUnitType(event.target.value)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm"><option value="faculty">Факультет</option><option value="institute">Інститут</option><option value="college">Коледж</option><option value="other">Інше</option></select></div>
                <button disabled={savingStructure || !universities.length} className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Додати підрозділ</button>
              </form>
            </div>
          </section>
        </>}
      </div>
    </main>
  )
}

function StatCard({ label, value, icon }: { label: string; value?: number; icon?: ReactNode }) {
  return <article className="xelay-card p-4"><div className="flex items-center justify-between gap-2 text-muted-foreground"><span className="text-[11px] font-medium leading-snug sm:text-xs">{label}</span>{icon}</div><p className="mt-3 text-2xl font-bold tabular-nums">{value ?? '—'}</p></article>
}
