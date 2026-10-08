import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Check, Loader2, MessageCircle, UserRoundPlus } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getPublicProfile } from '../lib/profiles'
import { PremiumBadge } from '../components/PremiumBadge'
import { SupporterBadge } from '../components/SupporterBadge'
import { Question, Answer } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { OwnContentDeleteButton } from '../components/OwnContentDeleteButton'
import { deleteOwnAnswer } from '../lib/communityDeletion'
import { AuthModal } from '../components/AuthModal'
import { categoryLabel } from '../translations/categories'
import { academicStatusLabel } from '../lib/academicStatus'
import { addQuestionAuthors } from '../lib/questionAuthors'
import { profileText } from '../lib/profileText'
import { useBilling } from '../context/BillingContext'
import { connectionRequestError, loadConnectionQuota, type ConnectionQuota } from '../lib/connectionRequests'
import { ProfileCover } from '../components/ProfileCover'

type ConnectionState = 'loading' | 'none' | 'pending' | 'incoming' | 'accepted'

export function PublicProfilePage() {
  const { id } = useParams({ from: '/user/$id' })
  const navigate = useNavigate()
  const { authUser, isAuthenticated } = useAuth()
  const { isPremium, refreshBilling } = useBilling()
  const [profile, setProfile] = useState<any>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'questions' | 'answers'>('questions')
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading')
  const [sendingRequest, setSendingRequest] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [connectionQuota, setConnectionQuota] = useState<ConnectionQuota | null>(null)
  const [weeklyLimitReached, setWeeklyLimitReached] = useState(false)
  const requestLock = useRef(false)
  const profileOwner = `${authUser?.id ?? ''}:${id}`
  const profileOwnerRef = useRef(profileOwner)
  profileOwnerRef.current = profileOwner

  useEffect(() => {
    let active = true
    setConnectionQuota(null)
    setRequestError('')
    setSendingRequest(false)
    setWeeklyLimitReached(false)
    if (!authUser?.id || authUser.id === id) return
    const refresh = async () => {
      try {
        const quota = await loadConnectionQuota(id)
        if (active) setConnectionQuota(quota)
      } catch { if (active) setConnectionQuota(null) }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60_000)
    return () => { active = false; window.removeEventListener('focus', refresh); window.clearInterval(timer) }
  }, [authUser?.id, id, isPremium])

  useEffect(() => {
    let active = true

    const loadProfile = async () => {
      setLoading(true)
      try {
        const [profileRes, questionsRes, answersRes] = await Promise.all([
          getPublicProfile(id),
          supabase.from('questions').select('*').eq('user_id', id).order('created_at', { ascending: false }),
          supabase.from('answers').select('*').eq('user_id', id).order('created_at', { ascending: false }),
        ])
        if (!active) return
        setProfile(profileRes.data)
        setQuestions(await addQuestionAuthors(questionsRes.data || []))
        setAnswers((answersRes.data || []).map((answer: any) => ({
          id: answer.id,
          userId: answer.user_id,
          questionId: answer.question_id,
          authorId: answer.user_id,
          authorName: answer.author_name || '',
          text: answer.content || '',
          createdAt: answer.created_at,
        })))
      } catch (error) {
        console.error('Could not load public profile:', error)
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadProfile()
    return () => { active = false }
  }, [id])

  useEffect(() => {
    if (!profile) return
    const previousTitle = document.title
    const previousMeta = document.querySelector('meta[name="description"]')
    const previousDescription = previousMeta?.getAttribute('content') ?? null
    document.title = `${profile.full_name || 'Профіль'} | Xelay`
    const description = profile.bio
      ? profile.bio.slice(0, 150)
      : `Публічний профіль ${profile.full_name || 'учасника'} у Xelay`
    let meta = document.querySelector('meta[name="description"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'description')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', description)
    return () => {
      document.title = previousTitle
      if (!previousMeta) meta?.remove()
      else if (previousDescription === null) meta?.removeAttribute('content')
      else meta?.setAttribute('content', previousDescription)
    }
  }, [profile])

  useEffect(() => {
    let active = true
    const loadConnection = async () => {
      if (!authUser?.id || authUser.id === id) {
        setConnectionState('none')
        return
      }
      setConnectionState('loading')
      const [outgoing, incoming] = await Promise.all([
        supabase.from('connection_requests').select('id, status, created_at')
          .eq('requester_id', authUser.id).eq('recipient_id', id)
          .order('created_at', { ascending: false }).limit(1),
        supabase.from('connection_requests').select('id, status, created_at')
          .eq('requester_id', id).eq('recipient_id', authUser.id)
          .order('created_at', { ascending: false }).limit(1),
      ])
      if (!active) return
      const records = [outgoing.data?.[0], incoming.data?.[0]].filter(Boolean) as { status: string; requester_id?: string }[]
      if (records.some((request) => request.status === 'accepted')) {
        setConnectionState('accepted')
      } else if (outgoing.data?.[0]?.status === 'pending') {
        setConnectionState('pending')
      } else if (incoming.data?.[0]?.status === 'pending') {
        setConnectionState('incoming')
      } else {
        setConnectionState('none')
      }
    }
    void loadConnection()
    return () => { active = false }
  }, [authUser?.id, id, profile])

  const submitConnectionRequest = async () => {
    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }
    if (requestLock.current) return
    requestLock.current = true
    const owner = profileOwner
    const valid = () => profileOwnerRef.current === owner
    setSendingRequest(true)
    setRequestError('')
    setWeeklyLimitReached(false)
    try {
      const { data: requestId, error } = await supabase.rpc('send_connection_request', { p_recipient_id: id })
      if (error) throw error
      const { data: request, error: lookupError } = await supabase
        .from('connection_requests')
        .select('requester_id, status')
        .eq('id', requestId)
        .single()
      if (lookupError) throw lookupError
      if (valid()) setConnectionState(request.status === 'accepted' ? 'accepted' : request.requester_id === id ? 'incoming' : 'pending')
      void refreshBilling()
      const quota = await loadConnectionQuota(id).catch(() => null)
      if (valid()) setConnectionQuota(quota)
    } catch (error) {
      console.error('Could not send connection request:', error)
      const code = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : ''
      if (valid()) {
        setRequestError(connectionRequestError(error))
        setWeeklyLimitReached(code.includes('CONNECTION_REQUEST_WEEKLY_LIMIT'))
        void refreshBilling()
      }
    } finally {
      requestLock.current = false
      if (valid()) setSendingRequest(false)
    }
  }

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map((part: string) => part[0]).join('').toUpperCase().slice(0, 2)
    : '?'
  const isOwnProfile = authUser?.id === id

  return (
    <main className="min-h-screen bg-background">
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <div className="w-full min-w-0 max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {loading ? (
          <div className="text-center py-20 text-muted-foreground">Завантаження профілю…</div>
        ) : !profile ? (
          <div className="xelay-card p-8 text-center text-muted-foreground">Профіль не знайдено.</div>
        ) : (
          <>
            <div className="profile-mobile-background">
            <section className="xelay-card min-w-0 p-4 sm:p-6 mb-8">
              <ProfileCover userId={id} />
              <div className="flex min-w-0 flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-16 h-16 rounded-full overflow-hidden bg-primary flex items-center justify-center shrink-0">
                    {profile.avatar_url ? (
                      <img src={profile.avatar_url} alt={profile.full_name || 'Фото профілю'} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-primary-foreground text-xl font-bold">{initials}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-xl font-bold text-foreground break-words">{profile.full_name || 'Учасник Xelay'}</h1>
                      <PremiumBadge userId={id} />
                      <SupporterBadge userId={id} />
                    </div>
                    <p className="text-sm text-muted-foreground">@{profile.username || 'учасник'}</p>
                    <p className="break-words text-sm text-muted-foreground mt-1">
                      {[profile.faculty, profile.specialty, profile.study_year ? `${profile.study_year} курс` : '']
                        .filter(Boolean).join(' · ') || 'Учасник університетської спільноти'}
                    </p>
                  </div>
                </div>
                {isAuthenticated && !isOwnProfile && (
                  <div className="sm:shrink-0">
                    {connectionState === 'accepted' ? (
                      <button
                        onClick={() => navigate({ to: '/messages' })}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-primary text-primary-foreground font-medium"
                      >
                        <MessageCircle size={17} /> Повідомлення
                      </button>
                    ) : connectionState === 'pending' ? (
                      <button disabled className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-border text-muted-foreground cursor-default">
                        <Check size={17} /> Запит надіслано
                      </button>
                    ) : connectionState === 'incoming' ? (
                      <button disabled className="w-full sm:w-auto px-4 py-2.5 rounded-full border border-border text-muted-foreground cursor-default">
                        Є вхідний запит
                      </button>
                    ) : (
                      <button
                        onClick={() => void submitConnectionRequest()}
                        disabled={sendingRequest}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-primary text-primary-foreground font-medium disabled:opacity-60"
                      >
                        {sendingRequest ? <Loader2 size={17} className="animate-spin" /> : <UserRoundPlus size={17} />}
                        Запросити спілкування
                      </button>
                    )}
                    {connectionState === 'none' && connectionQuota && <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:max-w-56">{connectionQuota.recipientExempt ? 'Учасник вашої навчальної групи — запит безкоштовний і не витрачає ліміт.' : connectionQuota.unlimited ? 'Без тижневого ліміту · Учасник' : `Залишилося ${connectionQuota.remaining} із ${connectionQuota.limit} запитів на цей тиждень.`}</p>}
                    {requestError && <p role="alert" className="text-xs text-red-600 mt-2 sm:max-w-56">{requestError}</p>}
                    {weeklyLimitReached && <Link to="/subscription" className="mt-2 inline-flex text-xs font-semibold text-primary hover:underline">Запити без тижневого ліміту · Учасник</Link>}
                  </div>
                )}
                {!isAuthenticated && (
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="sm:shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-primary text-primary-foreground font-medium"
                  >
                    <UserRoundPlus size={17} /> Запросити спілкування
                  </button>
                )}
              </div>

              <div className="mt-5 pt-5 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <ProfileValue label="Факультет / інститут" value={profile.faculty} />
                <ProfileValue label="Спеціальність" value={profile.specialty} />
                <ProfileValue label="Курс" value={profile.study_year ? `${profile.study_year} курс` : ''} />
                <ProfileValue label="Навчальний статус" value={academicStatusLabel(profile.experience || '')} />
                <ProfileValue label="Країна" value={profile.country} />
                <ProfileValue label="Місто" value={profile.city} />
                <div className="min-w-0 sm:col-span-2">
                  <ProfileValue label="Навички" value={profileText(profile.skills)} />
                </div>
                <ProfileList label="Інтереси" values={profile.categories} mapCategory />
              </div>

              {profile.bio && <ProfileParagraph label="Про себе" value={profile.bio} />}
              {profile.help_with?.length > 0 && <ProfileParagraph label="Можу допомогти з" value={profileText(profile.help_with)} />}
              {profile.want_to_learn?.length > 0 && <ProfileParagraph label="Хочу дізнатися" value={profileText(profile.want_to_learn)} />}
            </section>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-8">
              <div className="xelay-card p-4 text-center">
                <p className="text-2xl font-bold text-foreground">{questions.length}</p>
                <p className="text-sm text-muted-foreground">Запитання</p>
              </div>
              <div className="xelay-card p-4 text-center">
                <p className="text-2xl font-bold text-foreground">{answers.length}</p>
                <p className="text-sm text-muted-foreground">Відповіді</p>
              </div>
            </div>

            <div className="flex border-b border-border mb-6">
              {(['questions', 'answers'] as const).map((tabName) => (
                <button
                  key={tabName}
                  onClick={() => setTab(tabName)}
                  className={`flex-1 py-3 text-sm font-medium border-b-2 -mb-px ${tab === tabName ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {tabName === 'questions' ? `Запитання (${questions.length})` : `Відповіді (${answers.length})`}
                </button>
              ))}
            </div>
            {tab === 'questions' ? (
              questions.length ? (
                <div className="space-y-4">{questions.map((question) => <QuestionCard key={question.id} question={question} showAnswerButton={false}
                  onDeleted={(questionId) => {
                    setQuestions((previous) => previous.filter((item) => item.id !== questionId))
                    setAnswers((previous) => previous.filter((answer) => answer.questionId !== questionId))
                  }} />)}</div>
              ) : <p className="text-center py-10 text-muted-foreground">Запитань поки немає.</p>
            ) : (
              answers.length ? (
                <div className="space-y-4">{answers.map((answer) => <div key={answer.id} className="relative xelay-card min-w-0 p-5 transition-colors hover:border-primary/25">
                  <Link to="/question/$id" params={{ id: String(answer.questionId) }} search={{ answer: String(answer.id) }} hash={`answer-${answer.id}`}
                    className="block break-words rounded-lg text-sm text-foreground leading-relaxed whitespace-pre-wrap after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2">
                    {answer.text.trim() || 'Переглянути відповідь із вкладенням'}
                    <span className="mt-2 block text-xs font-medium text-primary">Перейти до відповіді →</span>
                  </Link>
                  {authUser?.id === answer.userId && <div className="relative z-10 mt-3 flex justify-end"><OwnContentDeleteButton kind="answer" compact onDelete={async () => {
                    if (!authUser?.id || authUser.id !== answer.userId) throw { code: '42501' }
                    const answersCount = await deleteOwnAnswer(answer.id)
                    setAnswers((previous) => previous.filter((item) => item.id !== answer.id))
                    setQuestions((previous) => previous.map((question) => question.id === answer.questionId ? {
                      ...question,
                      answers_count: answersCount ?? Math.max(0, Number(question.answers_count || 0) - 1),
                    } : question))
                  }} /></div>}
                </div>)}</div>
              ) : <p className="text-center py-10 text-muted-foreground">Відповідей поки немає.</p>
            )}
          </>
        )}
      </div>
    </main>
  )
}

function ProfileValue({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className="break-words whitespace-pre-wrap font-medium text-foreground">{value?.trim() ? value : '—'}</p>
    </div>
  )
}

function ProfileList({ label, values, mapCategory = false }: { label: string; values?: string[]; mapCategory?: boolean }) {
  return (
    <div className="min-w-0 sm:col-span-2">
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">{label}</p>
      {values?.length ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          {values.map((value) => <span key={value} className="break-words px-2.5 py-1 text-xs rounded-full border border-border bg-accent text-accent-foreground">{mapCategory ? categoryLabel(value) : value}</span>)}
        </div>
      ) : <p className="font-medium text-foreground">—</p>}
    </div>
  )
}

function ProfileParagraph({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-5 min-w-0 pt-5 border-t border-border">
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">{label}</p>
      <p className="break-words text-sm text-foreground leading-relaxed whitespace-pre-wrap">{value}</p>
    </div>
  )
}
