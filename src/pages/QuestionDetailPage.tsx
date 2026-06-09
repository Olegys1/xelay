import { useState, useEffect } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Send } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

import type { Question, Answer } from '../types'

import { AnswerCard } from '../components/AnswerCard'
import { StarRating } from '../components/StarRating'
import { starsFromRating } from '../types'
import { AuthModal } from '../components/AuthModal'

export function QuestionDetailPage() {
  const { id } = useParams({
    from: '/question/$id',
  })

  const navigate = useNavigate()

  const {
    isAuthenticated,
    authUser,
    xelayUser,
  } = useAuth()

  const [question, setQuestion] =
    useState<Question | null>(null)

  const [answers, setAnswers] =
    useState<Answer[]>([])

  const [authorRating, setAuthorRating] =
    useState(0)

  const [loading, setLoading] =
    useState(true)

  const [answerText, setAnswerText] =
    useState('')

  const [submitting, setSubmitting] =
    useState(false)

  const [submitError, setSubmitError] =
    useState('')

  const [showAuthModal, setShowAuthModal] =
    useState(false)

  const fetchData = async () => {
    try {
      const {
        data: qData,
        error: qError,
      } = await supabase
        .from('questions')
        .select('*')
        .eq('id', id)
        .single()

      if (qError || !qData) {
        navigate({ to: '/' })
        return
      }

      setQuestion(qData as Question)

      const { data: profileData } =
        await supabase
          .from('profiles')
          .select('rating')
          .eq('id', qData.user_id)
          .single()

      setAuthorRating(
        Number(profileData?.rating) || 0
      )

      const {
        data: answersData,
        error: answersError,
      } = await supabase
        .from('answers')
        .select('*')
        .eq('question_id', id)
        .order('created_at', {
          ascending: true,
        })

      if (answersError) {
        console.error(answersError)
      }

const mappedAnswers: Answer[] = (
  answersData || []
).map((a: any) => ({
  id: a.id,

  userId: a.user_id,

  questionId: a.question_id,

  authorId: a.user_id,

  authorName:
    a.author_name || 'Anonymous',

  author_avatar:
    a.author_avatar || '',

  authorRating:
    a.author_rating || 0,

  text: a.content || '',

  likes: a.likes || 0,

  createdAt:
    a.created_at ||
    new Date().toISOString(),
}))

      setAnswers(mappedAnswers)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) {
      fetchData()
    }
  }, [id])
alert('HANDLE SUBMIT FIRED')
  const handleSubmitAnswer = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setSubmitError('')

    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }

    if (!answerText.trim()) return

    if (
      !authUser ||
      !xelayUser ||
      !question
    ) {
      return
    }

    setSubmitting(true)

    try {
const insertData = {
  question_id: question.id,

  user_id: authUser.id,

  content: answerText.trim(),

  author_name:
    xelayUser.name ||
    authUser.email ||
    'Anonymous',

  author_avatar:
    xelayUser.avatarUrl || '',

  author_rating:
    xelayUser.rating || 0,

  likes: 0,
}


const {
  data: insertedAnswer,
  error: insertError,
} = await supabase
  .from('answers')
  .insert(insertData)
  .select()
  .single()

if (insertError) {
  console.error(insertError)
  throw insertError
}
if (
  question.user_id !== authUser.id
) {
  await supabase
    .from('notifications')
    .insert({
      recipient_id:
        question.user_id,

      actor_id:
        authUser.id,

      actor_name:
        xelayUser.name ||
        authUser.email ||
        'Anonymous',

      type: 'answer',

      message:
        'answered your question',

      question_id:
        question.id,

      answer_id:
        insertedAnswer.id,
    })
}

const currentCount =
  Number(question.answers_count || 0)

const newCount =
  currentCount + 1

const {
  error: updateError,
} = await supabase
  .from('questions')
  .update({
    answers_count: newCount,
  })
  .eq('id', question.id)

if (updateError) {
  console.error(updateError)
}

setQuestion((prev) =>
  prev
    ? {
        ...prev,
        answers_count: newCount,
      }
    : prev
)

setAnswers((prev) => [
  ...prev,
  {
  id: insertedAnswer.id,

  userId:
    insertedAnswer.user_id,

  questionId:
    insertedAnswer.question_id,

  authorId:
    insertedAnswer.user_id,

  authorName:
    insertedAnswer.author_name ||
    'Anonymous',

  author_avatar:
    insertedAnswer.author_avatar || '',

  authorRating:
    insertedAnswer.author_rating || 0,

  text:
    insertedAnswer.content || '',

  likes:
    insertedAnswer.likes || 0,

  createdAt:
    insertedAnswer.created_at,
},
])

setAnswerText('')
    } catch (err) {
      console.error(err)

      setSubmitError(
        'Failed to submit answer'
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-foreground/20 border-t-foreground rounded-full animate-spin" />
      </div>
    )
  }

  if (!question) return null

  return (
    <>
      {showAuthModal && (
        <AuthModal
          onClose={() =>
            setShowAuthModal(false)
          }
        />
      )}

      <main className="min-h-screen bg-background">
        <div className="max-w-2xl mx-auto px-6 py-10">
          <button
            onClick={() =>
              navigate({ to: '/' })
            }
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft size={16} />
            Back to feed
          </button>

          <div className="xelay-card p-6 mb-8">
            <span className="text-xs font-medium px-2.5 py-1 bg-muted text-muted-foreground rounded-full uppercase tracking-wider">
              {question.category}
            </span>

            <h1 className="text-xl font-bold text-foreground mt-4 mb-6 leading-relaxed">
              {question.content}
            </h1>

            <div className="flex items-center justify-between text-sm text-muted-foreground pt-4 border-t border-border">
              <div className="flex items-center gap-2">
<div className="w-8 h-8 rounded-full overflow-hidden bg-muted flex items-center justify-center text-sm font-bold text-foreground">
  {question.author_avatar ? (
    <img
      src={question.author_avatar}
      alt={question.author_name || 'Avatar'}
      className="w-full h-full object-cover"
    />
  ) : (
    question.author_name
      ?.charAt(0)
      ?.toUpperCase() || '?'
  )}
</div>

                <div>
                  <p className="font-medium text-foreground text-sm">
                    {question.author_name}
                  </p>

                  <StarRating
                    rating={starsFromRating(
                      authorRating
                    )}
                    size="sm"
                  />
                </div>
              </div>

              <span>
                {formatDistanceToNow(
                  new Date(
                    question.created_at
                  ),
                  {
                    addSuffix: true,
                  }
                )}
              </span>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-lg font-bold text-foreground mb-4">
              {question.answers_count || 0}{' '}
              {(question.answers_count || 0) === 1
                ? 'Answer'
                : 'Answers'}
            </h2>

            {answers.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                No answers yet
              </div>
            ) : (
              <div className="space-y-4">
                {answers.map((ans) => (
                  <AnswerCard
                    key={ans.id}
                    answer={ans}
                    questionAuthorId={
                      question.user_id
                    }
                    onLiked={fetchData}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="xelay-card p-6">
            <h3 className="text-base font-bold text-foreground mb-4">
              Write an Answer
            </h3>

            <form
              onSubmit={handleSubmitAnswer}
              className="space-y-3"
            >
              <textarea
                value={answerText}
                onChange={(e) =>
                  setAnswerText(
                    e.target.value
                  )
                }
                placeholder={
                  isAuthenticated
                    ? 'Share your knowledge...'
                    : 'Sign in to answer'
                }
                rows={4}
                disabled={!isAuthenticated}
                className="w-full px-4 py-3 border border-border rounded-lg bg-background text-foreground text-sm resize-none"
              />

              {submitError && (
                <p className="text-xs text-red-500">
                  {submitError}
                </p>
              )}

              <button
                type="submit"
                disabled={
                  submitting ||
                  !answerText.trim() ||
                  !isAuthenticated
                }
                className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background text-sm font-semibold rounded-lg"
              >
                {submitting ? (
                  'Sending...'
                ) : (
                  <>
                    Submit
                    <Send size={13} />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </main>
    </>
  )
}