import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { blink } from '../blink/client'
import { Question, Answer } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { StarRating } from '../components/StarRating'
import { starsFromRating } from '../types'
import { AuthModal } from '../components/AuthModal'
import { ProfileSettingsModal } from '../components/ProfileSettingsModal'
import { LogOut, MessageCircle, HelpCircle, Settings } from 'lucide-react'

export function ProfilePage() {
  const { isAuthenticated, blinkUser, xelayUser, signOut, isLoading } = useAuth()
  const [tab, setTab] = useState<'questions' | 'answers'>('questions')
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    if (!blinkUser?.id) { setDataLoading(false); return }
    const fetchProfileData = async () => {
      try {
        const [qs, ans] = await Promise.all([
          blink.db.xelayQuestions.list({
            where: { authorId: blinkUser.id },
            orderBy: { createdAt: 'desc' },
          }),
          blink.db.xelayAnswers.list({
            where: { authorId: blinkUser.id },
            orderBy: { createdAt: 'desc' },
          }),
        ])
        setQuestions((qs || []) as unknown as Question[])
        setAnswers((ans || []) as unknown as Answer[])
      } catch {
        // silent
      } finally {
        setDataLoading(false)
      }
    }
    fetchProfileData()
  }, [blinkUser?.id])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-foreground/20 border-t-foreground rounded-full animate-spin" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <>
        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
        <main className="min-h-screen bg-background flex items-center justify-center">
          <div className="text-center px-6">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl text-muted-foreground">👤</span>
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">Your Profile</h1>
            <p className="text-muted-foreground mb-6">Sign in to view your profile and track your activity</p>
            <button
              onClick={() => setShowAuthModal(true)}
              className="px-6 py-3 bg-foreground text-background font-semibold rounded-lg hover:bg-foreground/85 transition-colors xelay-btn"
            >
              Sign In
            </button>
          </div>
        </main>
      </>
    )
  }

  const initials = xelayUser?.name
    ? xelayUser.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : blinkUser?.email?.charAt(0).toUpperCase() || '?'

  return (
    <>
      {showSettings && (
        <ProfileSettingsModal onClose={() => setShowSettings(false)} />
      )}

      <main className="min-h-screen bg-background">
        <div className="max-w-2xl mx-auto px-6 py-12">
          {/* Profile header */}
          <div className="xelay-card p-6 mb-8">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                {/* Avatar */}
                <div className="w-16 h-16 rounded-full overflow-hidden bg-foreground flex items-center justify-center shrink-0">
                  {xelayUser?.avatarUrl ? (
                    <img
                      src={xelayUser.avatarUrl}
                      alt={xelayUser.name}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  ) : (
                    <span className="text-background text-xl font-bold">{initials}</span>
                  )}
                </div>
                <div>
                  <h1 className="text-xl font-bold text-foreground">
                    {xelayUser?.name || 'User'}
                  </h1>
                  <p className="text-sm text-muted-foreground">{blinkUser?.email}</p>
                  {xelayUser && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <StarRating rating={starsFromRating(xelayUser.rating)} size="md" />
                      <span className="text-xs text-muted-foreground">
                        ({xelayUser.rating} pts)
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-col items-end gap-2">
                <button
                  onClick={() => setShowSettings(true)}
                  className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-muted-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted xelay-btn"
                >
                  <Settings size={15} />
                  Edit
                </button>
                <button
                  onClick={signOut}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted xelay-btn"
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </div>
            </div>

            {xelayUser && (
              <div className="mt-5 pt-5 border-t border-border grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Country</p>
                  <p className="font-medium text-foreground">{xelayUser.country}</p>
                </div>
                {xelayUser.city && (
                  <div>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">City</p>
                    <p className="font-medium text-foreground">{xelayUser.city}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Experience</p>
                  <p className="font-medium text-foreground">{xelayUser.experience}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Expertise</p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {xelayUser.categories.map((cat) => (
                      <span key={cat} className="text-xs px-2 py-0.5 bg-muted text-foreground rounded-full">
                        {cat}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-4 mb-8">
            <div className="xelay-card p-4 text-center">
              <HelpCircle size={20} className="mx-auto mb-1 text-muted-foreground" />
              <p className="text-2xl font-bold text-foreground">{questions.length}</p>
              <p className="text-sm text-muted-foreground">Questions</p>
            </div>
            <div className="xelay-card p-4 text-center">
              <MessageCircle size={20} className="mx-auto mb-1 text-muted-foreground" />
              <p className="text-2xl font-bold text-foreground">{answers.length}</p>
              <p className="text-sm text-muted-foreground">Answers</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border mb-6">
            {(['questions', 'answers'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'questions' ? `Questions (${questions.length})` : `Answers (${answers.length})`}
              </button>
            ))}
          </div>

          {/* Content */}
          {dataLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="xelay-card p-5 animate-pulse">
                  <div className="h-4 bg-muted rounded w-3/4 mb-2" />
                  <div className="h-3 bg-muted rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : tab === 'questions' ? (
            questions.length === 0 ? (
              <p className="text-center py-10 text-muted-foreground">No questions asked yet</p>
            ) : (
              <div className="space-y-4">
                {questions.map((q) => <QuestionCard key={q.id} question={q} showAnswerButton={false} />)}
              </div>
            )
          ) : (
            answers.length === 0 ? (
              <p className="text-center py-10 text-muted-foreground">No answers given yet</p>
            ) : (
              <div className="space-y-4">
                {answers.map((ans) => (
                  <div key={ans.id} className="xelay-card p-5">
                    <p className="text-sm text-foreground leading-relaxed">{ans.text}</p>
                    <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{ans.likes} likes received</span>
                      <span>{new Date(ans.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </main>
    </>
  )
}
