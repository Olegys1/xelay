import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { Question, Answer } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { OwnContentDeleteButton } from '../components/OwnContentDeleteButton'
import { deleteOwnAnswer } from '../lib/communityDeletion'
import { AuthModal } from '../components/AuthModal'
import { ProfileSettingsModal } from '../components/ProfileSettingsModal'
import { ConnectionRequestsPanel } from '../components/ConnectionRequestsPanel'
import { useTranslation } from '../hooks/useTranslation'
import { categoryLabel } from '../translations/categories'
import { experienceLabel } from '../lib/ukrainian'
import { addQuestionAuthors } from '../lib/questionAuthors'
import { ClassRepresentativeRequestCard } from '../components/ClassRepresentativeRequestCard'
import { ParticipantProfileCard } from '../components/ParticipantProfileCard'
import { PremiumBadge } from '../components/PremiumBadge'
import { useBilling } from '../context/BillingContext'
import { profileText } from '../lib/profileText'

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
  const { t } = useTranslation()
  const { isPremium, emojiStatus, textStatus } = useBilling()

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
const questionRows = await addQuestionAuthors(questionsRes.data || [])
const mappedQuestions: Question[] =
  questionRows.map(
    (q: any) => ({
      id: q.id,

      user_id: q.user_id,

      author_name:
        q.author_name || 'Анонім',

      author_avatar:
        q.author_avatar || '',

      title: q.title || '',

      content: q.content || '',

      category:
        q.category || 'Інше',

      answers_count: Number(q.answers_count || 0),
      views: Number(q.views || 0),

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
                a.author_name || 'Анонім',
              text: a.content || '',
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
              {t('yourProfile')}
            </h1>

            <p className="text-muted-foreground mb-6">
              {t('signInToViewProfile')}
            </p>

            <button
              onClick={() =>
                setShowAuthModal(true)
              }
              className="px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors"
            >
              {t('signIn')}
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
        <div className="w-full min-w-0 max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
          <ParticipantProfileCard />
          <div className="profile-mobile-background">
          <div className="xelay-card mb-8 min-w-0 p-4 sm:p-6">
            <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                <div className="w-16 h-16 rounded-full overflow-hidden bg-primary flex items-center justify-center shrink-0">
                  {xelayUser?.avatarUrl ? (
                    <img
                      src={xelayUser.avatarUrl}
                      alt={
                        xelayUser.name ||
                        'Аватар'
                      }
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-primary-foreground text-xl font-bold">
                      {initials}
                    </span>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
  <h1 className="text-xl font-bold text-foreground">
    {xelayUser?.name || 'Користувач'}
  </h1>
  <PremiumBadge isPremium={isPremium} emojiStatus={emojiStatus} textStatus={textStatus} />

</div>
                    <p className="break-words text-sm text-muted-foreground">
                    @{xelayUser?.username || 'нік не задано'}
                  </p>
                  <p className="break-all text-xs text-muted-foreground/80">
                    {authUser?.email}
                  </p>

                </div>
              </div>

              <div className="flex w-full items-center justify-end gap-2 sm:w-auto sm:flex-col sm:items-end sm:gap-2">
                <button
                  onClick={() =>
                    setShowSettings(true)
                  }
                  title={t('edit')}
                  aria-label={t('edit')}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full px-2 text-sm font-medium text-primary transition-colors hover:bg-accent sm:h-auto sm:w-auto sm:gap-1.5 sm:rounded-lg sm:px-3 sm:py-1.5"
                >
                  <Settings size={15} />
                  <span className="hidden sm:inline">{t('edit')}</span>
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
                  title={t('signOut')}
                  aria-label={t('signOut')}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full px-2 text-sm text-primary transition-colors hover:bg-accent sm:h-auto sm:w-auto sm:gap-1.5 sm:rounded-lg sm:px-3 sm:py-1.5"
                >
                  <LogOut size={15} />
                  <span className="hidden sm:inline">{t('signOut')}</span>
                </button>
              </div>
            </div>

            {xelayUser && (
  <>
    <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-5 text-sm sm:gap-4">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Факультет / інститут</p>
                  <p className="break-words font-medium text-foreground">{xelayUser.faculty || '—'}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Спеціальність</p>
                  <p className="break-words font-medium text-foreground">{xelayUser.specialty || '—'}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Курс</p>
                  <p className="font-medium text-foreground">{xelayUser.studyYear ? `${xelayUser.studyYear} курс` : '—'}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                    {t('country')}
                  </p>

                  <p className="break-words font-medium text-foreground">
                    {xelayUser.country ||
                      '—'}
                  </p>
                </div>

                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                    {t('city')}
                  </p>

                  <p className="break-words font-medium text-foreground">
                    {xelayUser.city || '—'}
                  </p>
                </div>

                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                    {t('experience')}
                  </p>

                  <p className="break-words font-medium text-foreground">
                    {xelayUser.experience
                      ? experienceLabel(xelayUser.experience)
                      : '—'}
                  </p>
                </div>
                <div className="min-w-0">
  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">Інтереси</p>

  <div className="flex flex-wrap gap-1">
    {xelayUser.categories &&
    xelayUser.categories.length > 0 ? (
      xelayUser.categories.map(
        (category) => (
          <span
            key={category}
            className="break-words rounded-full border border-border bg-accent px-2 py-1 text-xs text-accent-foreground"
          >
            {categoryLabel(category)}
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
      {t('about')}
    </p>

    <p className="break-words text-sm text-foreground leading-relaxed whitespace-pre-wrap">
      {xelayUser.bio}
    </p>
  </div>
)}
            <ProfileText label="Навички" values={xelayUser.skills} />
            <ProfileText label="Можу допомогти з" values={xelayUser.helpWith} />
            <ProfileText label="Хочу дізнатися" values={xelayUser.wantToLearn} />
</>
)}
          </div>
          </div>

          <ClassRepresentativeRequestCard onEditProfile={() => setShowSettings(true)} />

          {authUser?.id && <ConnectionRequestsPanel userId={authUser.id} />}

          <div className="grid grid-cols-2 gap-4 mb-8">
            <div className="xelay-card p-4 text-center">
              <HelpCircle
                size={20}
                className="mx-auto mb-1 text-primary"
              />

              <p className="text-2xl font-bold text-foreground">
                {questions.length}
              </p>

              <p className="text-sm text-muted-foreground">
                {t('questions')}
              </p>
            </div>

            <div className="xelay-card p-4 text-center">
              <MessageCircle
                size={20}
                className="mx-auto mb-1 text-primary"
              />

              <p className="text-2xl font-bold text-foreground">
                {answers.length}
              </p>

              <p className="text-sm text-muted-foreground">
                {t('answers')}
              </p>
            </div>
          </div>

          <div className="flex border-b border-border mb-6">
          {(['questions', 'answers'] as const).map((tabName) => (
  <button
    key={tabName}
    onClick={() => setTab(tabName)}
    className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
      tab === tabName
        ? 'border-primary text-primary'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`}
  >
    {tabName === 'questions'
      ? `${t('questions')} (${questions.length})`
      : `${t('answers')} (${answers.length})`}
  </button>
))}

          </div>

          {dataLoading ? (
            <div className="text-center py-20">
              {t('loading')}
            </div>
          ) : tab === 'questions' ? (
            questions.length === 0 ? (
              <p className="text-center py-10 text-muted-foreground">
                {t('noQuestionsAskedYet')}
              </p>
            ) : (
              <div className="space-y-4">
                {questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    showAnswerButton={false}
                    onDeleted={(questionId) => {
                      setQuestions((previous) => previous.filter((question) => question.id !== questionId))
                      setAnswers((previous) => previous.filter((answer) => answer.questionId !== questionId))
                    }}
                  />
                ))}
              </div>
            )
          ) : answers.length === 0 ? (
            <p className="text-center py-10 text-muted-foreground">
              {t('noAnswersGivenYet')}
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

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {new Date(
                        ans.createdAt
                    ).toLocaleDateString('uk-UA')}
                    </span>
                    {authUser?.id === ans.userId && <OwnContentDeleteButton kind="answer" compact onDelete={async () => {
                      if (!authUser?.id || authUser.id !== ans.userId) throw { code: '42501' }
                      const answersCount = await deleteOwnAnswer(ans.id)
                      setAnswers((previous) => previous.filter((answer) => answer.id !== ans.id))
                      setQuestions((previous) => previous.map((question) => question.id === ans.questionId ? {
                        ...question,
                        answers_count: answersCount ?? Math.max(0, Number(question.answers_count || 0) - 1),
                      } : question))
                    }} />}
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

function ProfileText({ label, values }: { label: string; values?: string[] }) {
  const text = profileText(values)
  return (
    <div className="mt-5 min-w-0 pt-5 border-t border-border">
      <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">{label}</p>
      <p className="break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground">{text.trim() ? text : '—'}</p>
    </div>
  )
}
