import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { Question, Answer } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { StarRating } from '../components/StarRating'
import { starsFromRating } from '../types'
import { AuthModal } from '../components/AuthModal'
import { ProfileSettingsModal } from '../components/ProfileSettingsModal'

import {
  LogOut,
  MessageCircle,
  HelpCircle,
  Settings,
} from 'lucide-react'

export function ProfilePage() {
  const {
    isAuthenticated,
    authUser,
    xelayUser,
    signOut,
    isLoading,
  } = useAuth()
  console.log(
  'PROFILE PAGE USER:',
  xelayUser
)

  const [tab, setTab] =
    useState<'questions' | 'answers'>(
      'questions'
    )

  const [questions, setQuestions] =
    useState<Question[]>([])

  const [answers, setAnswers] =
    useState<Answer[]>([])

  const [dataLoading, setDataLoading] =
    useState(true)

  const [showAuthModal, setShowAuthModal] =
    useState(false)

  const [showSettings, setShowSettings] =
    useState(false)

    const [badges, setBadges] =
  useState<any[]>([])

  useEffect(() => {
    if (!authUser?.id) {
      setDataLoading(false)
      return
    }

    const fetchProfileData = async () => {
      try {
        const [questionsRes, answersRes] =
          await Promise.all([
            supabase
              .from('questions')
              .select('*')
              .eq('user_id', authUser.id)
              .order('created_at', {
                ascending: false,
              }),

              

            supabase
              .from('answers')
              .select('*')
              .eq('user_id', authUser.id)
              .order('created_at', {
                ascending: false,
              }),
          ])

       const { data: badgesData } =
  await supabase
    .from('user_badges')
    .select('*')

console.log('ALL BADGES', badgesData)

setBadges(
  badgesData || []
)

        if (questionsRes.error) {
          console.error(
            'Questions error:',
            questionsRes.error
          )
        }

        if (answersRes.error) {
          console.error(
            'Answers error:',
            answersRes.error
          )
        }
const mappedQuestions: Question[] =
  (questionsRes.data || []).map(
    (q: any) => ({
      id: q.id,

      user_id: q.user_id,

      author_name:
        q.author_name || 'Anonymous',

      author_avatar:
        q.author_avatar || '',

      title: q.title || '',

      content: q.content || '',

      category:
        q.category || 'General',

      likes: q.likes || 0,

      created_at:
        q.created_at ||
        new Date().toISOString(),
    })
  )

        const mappedAnswers: Answer[] =
          (answersRes.data || []).map(
            (a: any) => ({
              id: a.id,
              userId: a.user_id,
              questionId: a.question_id,
              authorId: a.user_id,
              authorName:
                a.author_name || 'Anonymous',
              authorRating:
                a.author_rating || 0,
              text: a.content || '',
              likes: a.likes || 0,
              createdAt: a.created_at,
            })
          )

        setQuestions(mappedQuestions)
        setAnswers(mappedAnswers)
      } catch (err) {
        console.error(err)
      } finally {
        setDataLoading(false)
      }
    }

    fetchProfileData()
  }, [authUser?.id])

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
        {showAuthModal && (
          <AuthModal
            onClose={() =>
              setShowAuthModal(false)
            }
          />
        )}

        <main className="min-h-screen bg-background flex items-center justify-center">
          <div className="text-center px-6">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl text-muted-foreground">
                👤
              </span>
            </div>

            <h1 className="text-2xl font-bold text-foreground mb-2">
              Your Profile
            </h1>

            <p className="text-muted-foreground mb-6">
              Sign in to view your profile
            </p>

            <button
              onClick={() =>
                setShowAuthModal(true)
              }
              className="px-6 py-3 bg-foreground text-background font-semibold rounded-lg hover:bg-foreground/85 transition-colors"
            >
              Sign In
            </button>
          </div>
        </main>
      </>
    )
  }

  const initials = xelayUser?.name
    ? xelayUser.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : authUser?.email
        ?.charAt(0)
        .toUpperCase() || '?'

  return (
    <>
      {showSettings && (
        <ProfileSettingsModal
          onClose={() =>
            setShowSettings(false)
          }
        />
      )}

      <main className="min-h-screen bg-background">
        <div className="max-w-2xl mx-auto px-6 py-12">
          <div className="xelay-card p-6 mb-8">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full overflow-hidden bg-foreground flex items-center justify-center shrink-0">
                  {xelayUser?.avatarUrl ? (
                    <img
                      src={xelayUser.avatarUrl}
                      alt={
                        xelayUser.name ||
                        'Avatar'
                      }
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-background text-xl font-bold">
                      {initials}
                    </span>
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2 flex-wrap">
  <h1 className="text-xl font-bold text-foreground">
    {xelayUser?.name || 'User'}
  </h1>

  {badges.map((badge) => (
    <span
      key={badge.id}
      className="text-lg"
      title={badge.badge_type}
    >
      {badge.badge_type === 'pioneer' &&
        '🚀'}

      {badge.badge_type === 'expert' &&
        '🔥'}

      {badge.badge_type === 'authority' &&
        '👑'}

      {badge.badge_type ===
        'community_favorite' &&
        '❤️'}
    </span>
  ))}
</div>
                  <p className="text-sm text-muted-foreground">
                    {authUser?.email}
                  </p>

                  {xelayUser && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <StarRating
                        rating={starsFromRating(
                          xelayUser.rating || 0
                        )}
                        size="md"
                      />

                      <span className="text-xs text-muted-foreground">
                        (
                        {xelayUser.rating ||
                          0}{' '}
                        pts)
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-end gap-2">
                <button
                  onClick={() =>
                    setShowSettings(true)
                  }
                  className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-muted-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted"
                >
                  <Settings size={15} />
                  Edit
                </button>

                <button
                  onClick={async () => {
                    try {
                      await signOut()
                      window.location.href =
                        '/'
                    } catch (err) {
                      console.error(err)
                    }
                  }}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted"
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </div>
            </div>

            {xelayUser && (
  <>
    <div className="mt-5 pt-5 border-t border-border grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                    Country
                  </p>

                  <p className="font-medium text-foreground">
                    {xelayUser.country ||
                      '—'}
                  </p>
                </div>

                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                    City
                  </p>

                  <p className="font-medium text-foreground">
                    {xelayUser.city || '—'}
                  </p>
                </div>

                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                    Experience
                  </p>

                  <p className="font-medium text-foreground">
                    {xelayUser.experience ||
                      '—'}
                  </p>
                </div>
                <div>
  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">
    Categories
  </p>

  <div className="flex flex-wrap gap-1">
    {xelayUser.categories &&
    xelayUser.categories.length > 0 ? (
      xelayUser.categories.map(
        (category) => (
          <span
            key={category}
            className="px-2 py-1 text-xs rounded-full border border-border"
          >
            {category}
          </span>
        )
      )
    ) : (
      <span className="text-foreground">
        —
      </span>
    )}
  </div>
</div>
              </div>
            
            {xelayUser?.bio && (
  <div className="mt-5 pt-5 border-t border-border">
    <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">
      About
    </p>

    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
      {xelayUser.bio}
    </p>
  </div>
)}
</>
)}
          </div>

          <div className="grid grid-cols-2 gap-4 mb-8">
            <div className="xelay-card p-4 text-center">
              <HelpCircle
                size={20}
                className="mx-auto mb-1 text-muted-foreground"
              />

              <p className="text-2xl font-bold text-foreground">
                {questions.length}
              </p>

              <p className="text-sm text-muted-foreground">
                Questions
              </p>
            </div>

            <div className="xelay-card p-4 text-center">
              <MessageCircle
                size={20}
                className="mx-auto mb-1 text-muted-foreground"
              />

              <p className="text-2xl font-bold text-foreground">
                {answers.length}
              </p>

              <p className="text-sm text-muted-foreground">
                Answers
              </p>
            </div>
          </div>

          <div className="flex border-b border-border mb-6">
            {(
              ['questions', 'answers'] as const
            ).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'questions'
                  ? `Questions (${questions.length})`
                  : `Answers (${answers.length})`}
              </button>
            ))}
          </div>

          {dataLoading ? (
            <div className="text-center py-20">
              Loading...
            </div>
          ) : tab === 'questions' ? (
            questions.length === 0 ? (
              <p className="text-center py-10 text-muted-foreground">
                No questions asked yet
              </p>
            ) : (
              <div className="space-y-4">
                {questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    showAnswerButton={false}
                  />
                ))}
              </div>
            )
          ) : answers.length === 0 ? (
            <p className="text-center py-10 text-muted-foreground">
              No answers given yet
            </p>
          ) : (
            <div className="space-y-4">
              {answers.map((ans) => (
                <div
                  key={ans.id}
                  className="xelay-card p-5"
                >
                  <p className="text-sm text-foreground leading-relaxed">
                    {ans.text}
                  </p>

                  <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {ans.likes || 0} likes
                    </span>

                    <span>
                      {new Date(
                        ans.createdAt
                      ).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  )
}