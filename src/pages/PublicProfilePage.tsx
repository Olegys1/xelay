import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Check, Loader2, MessageCircle, UserRoundPlus } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { Question, Answer } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { AuthModal } from '../components/AuthModal'
import { categoryLabel } from '../translations/categories'
import { experienceLabel } from '../lib/ukrainian'

type ConnectionState = 'loading' | 'none' | 'pending' | 'incoming' | 'accepted'

export function PublicProfilePage() {
  const { id } = useParams({ from: '/user/$id' })
  const navigate = useNavigate()
  const { authUser, isAuthenticated } = useAuth()
  const [profile, setProfile] = useState<any>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'questions' | 'answers'>('questions')
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading')
  const [sendingRequest, setSendingRequest] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)

  useEffect(() => {
    let active = true

    const loadProfile = async () => {
      setLoading(true)
      try {
        const [profileRes, questionsRes, answersRes] = await Promise.all([
          supabase.from('profiles').select('*').eq('id', id).maybeSingle(),
          supabase.from('questions').select('*').eq('user_id', id).order('created_at', { ascending: false }),
          supabase.from('answers').select('*').eq('user_id', id).order('created_at', { ascending: false }),
        ])
        if (!active) return
        setProfile(profileRes.data)
        setQuestions(questionsRes.data || [])
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
    return () => { document.title = 'Xelay — університетська спільнота' }
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
    setSendingRequest(true)
    setRequestError('')
    try {
      const { data: requestId, error } = await supabase.rpc('send_connection_request', { p_recipient_id: id })
      if (error) throw error
      const { data: request, error: lookupError } = await supabase
        .from('connection_requests')
        .select('requester_id, status')
        .eq('id', requestId)
        .single()
      if (lookupError) throw lookupError
      setConnectionState(request.status === 'accepted' ? 'accepted' : request.requester_id === id ? 'incoming' : 'pending')
    } catch (error) {
      console.error('Could not send connection request:', error)
      setRequestError('Не вдалося надіслати запит. Спробуйте ще раз.')
    } finally {
      setSendingRequest(false)
    }
  }

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map((part: string) => part[0]).join('').toUpperCase().slice(0, 2)
    : '?'
  const isOwnProfile = authUser?.id === id

  return (
    <main className="min-h-screen bg-background">
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {loading ? (
          <div className="text-center py-20 text-muted-foreground">Завантаження профілю…</div>
        ) : !profile ? (
          <div className="xelay-card p-8 text-center text-muted-foreground">Профіль не знайдено.</div>
        ) : (
          <>
            <section className="xelay-card p-5 sm:p-6 mb-8">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-16 h-16 rounded-full overflow-hidden bg-foreground flex items-center justify-center shrink-0">
                    {profile.avatar_url ? (
                      <img src={profile.avatar_url} alt={profile.full_name || 'Фото профілю'} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-background text-xl font-bold">{initials}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-xl font-bold text-foreground break-words">{profile.full_name || 'Учасник Xelay'}</h1>
                    <p className="text-sm text-muted-foreground">@{profile.username || 'учасник'}</p>
                    <p className="text-sm text-muted-foreground mt-1">
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
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-foreground text-background font-medium"
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
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-foreground text-background font-medium disabled:opacity-60"
                      >
                        {sendingRequest ? <Loader2 size={17} className="animate-spin" /> : <UserRoundPlus size={17} />}
                        Запросити спілкування
                      </button>
                    )}
                    {requestError && <p role="alert" className="text-xs text-red-600 mt-2 sm:max-w-56">{requestError}</p>}
                  </div>
                )}
                {!isAuthenticated && (
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="sm:shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-foreground text-background font-medium"
                  >
                    <UserRoundPlus size={17} /> Запросити спілкування
                  </button>
                )}
              </div>

              <div className="mt-5 pt-5 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <ProfileValue label="Факультет / інститут" value={profile.faculty} />
                <ProfileValue label="Спеціальність" value={profile.specialty} />
                <ProfileValue label="Курс" value={profile.study_year ? `${profile.study_year} курс` : ''} />
                <ProfileValue label="Досвід" value={profile.experience ? experienceLabel(profile.experience) : ''} />
                <ProfileValue label="Країна" value={profile.country} />
                <ProfileValue label="Місто" value={profile.city} />
                <ProfileList label="Навички" values={profile.skills} />
                <ProfileList label="Інтереси" values={profile.categories} mapCategory />
              </div>

              {profile.bio && <ProfileParagraph label="Про себе" value={profile.bio} />}
              {profile.help_with?.length > 0 && <ProfileList label="Можу допомогти з" values={profile.help_with} />}
              {profile.want_to_learn?.length > 0 && <ProfileList label="Хочу дізнатися" values={profile.want_to_learn} />}
            </section>

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
                  className={`flex-1 py-3 text-sm font-medium border-b-2 -mb-px ${tab === tabName ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {tabName === 'questions' ? `Запитання (${questions.length})` : `Відповіді (${answers.length})`}
                </button>
              ))}
            </div>
            {tab === 'questions' ? (
              questions.length ? (
                <div className="space-y-4">{questions.map((question) => <QuestionCard key={question.id} question={question} showAnswerButton={false} />)}</div>
              ) : <p className="text-center py-10 text-muted-foreground">Запитань поки немає.</p>
            ) : (
              answers.length ? (
                <div className="space-y-4">{answers.map((answer) => <div key={answer.id} className="xelay-card p-5"><p className="text-sm whitespace-pre-wrap">{answer.text}</p></div>)}</div>
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
    <div>
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className="font-medium text-foreground">{value || '—'}</p>
    </div>
  )
}

function ProfileList({ label, values, mapCategory = false }: { label: string; values?: string[]; mapCategory?: boolean }) {
  return (
    <div className="sm:col-span-2">
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">{label}</p>
      {values?.length ? (
        <div className="flex flex-wrap gap-2">
          {values.map((value) => <span key={value} className="px-2.5 py-1 text-xs rounded-full border border-border">{mapCategory ? categoryLabel(value) : value}</span>)}
        </div>
      ) : <p className="font-medium text-foreground">—</p>}
    </div>
  )
}

function ProfileParagraph({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-5 pt-5 border-t border-border">
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">{label}</p>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{value}</p>
    </div>
  )
}
