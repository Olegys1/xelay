import { useState, useEffect } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Send } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { blink } from '../blink/client'
import { useAuth } from '../context/AuthContext'
import { Question, Answer } from '../types'
import { AnswerCard } from '../components/AnswerCard'
import { StarRating } from '../components/StarRating'
import { starsFromRating } from '../types'
import { AuthModal } from '../components/AuthModal'

export function QuestionDetailPage() {
  const { id } = useParams({ from: '/question/$id' })
  const navigate = useNavigate()
  const { isAuthenticated, blinkUser, xelayUser } = useAuth()

  const [question, setQuestion] = useState<Question | null>(null)
  const [answers, setAnswers] = useState<Answer[]>([])
  const [authorRating, setAuthorRating] = useState(0)
  const [loading, setLoading] = useState(true)
  const [answerText, setAnswerText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)

  const fetchData = async () => {
    try {
      const q = await blink.db.xelayQuestions.get(id)
      if (!q) {
        navigate({ to: '/' })
        return
      }
      const qData = q as unknown as Question
      setQuestion(qData)

      // Fetch author's rating from xelayUsers (authorId = Blink user ID = userId column in xelayUsers)
      const authorProfiles = await blink.db.xelayUsers.list({
        where: { userId: qData.authorId },
        limit: 1,
      })
      if (authorProfiles && authorProfiles.length > 0) {
        setAuthorRating(Number((authorProfiles[0] as Record<string, unknown>).rating) || 0)
      }

      // Fetch answers sorted oldest first
      const ans = await blink.db.xelayAnswers.list({
        where: { questionId: id },
        orderBy: { createdAt: 'asc' },
      })
      setAnswers((ans || []) as unknown as Answer[])
    } catch (err) {
      console.error('[Xelay] Failed to load question:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) fetchData()
  }, [id])

  const handleSubmitAnswer = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError('')

    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }
    if (!answerText.trim() || !question) return

    // xelayUser must be loaded — if not yet, trigger auth modal
    if (!xelayUser) {
      setShowAuthModal(true)
      return
    }

    setSubmitting(true)
    try {
      const newAnswer: Answer = {
        id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: blinkUser!.id,
        questionId: question.id,
        authorId: blinkUser!.id,
        authorName: xelayUser.name,
        authorRating: xelayUser.rating,
        text: answerText.trim(),
        likes: 0,
        createdAt: new Date().toISOString(),
      }
      await blink.db.xelayAnswers.create(newAnswer)
      setAnswers((prev) => [...prev, newAnswer])
      setAnswerText('')

      // Notify question author (only if different user)
      if (question.authorId !== blinkUser!.id) {
        try {
          await blink.db.xelayNotifications.create({
            id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId: question.authorId,
            recipientId: question.authorId,
            type: 'answer',
            message: `${xelayUser.name} answered your question: "${question.text.slice(0, 60)}${question.text.length > 60 ? '...' : ''}"`,
            questionId: question.id,
            answerId: newAnswer.id,
            isRead: 0,
            createdAt: new Date().toISOString(),
          })
        } catch {
          // Non-critical — don't fail the answer submit
        }
      }
    } catch (err) {
      console.error('[Xelay] Failed to submit answer:', err)
      setSubmitError('Failed to submit answer. Please try again.')
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
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}

      <main className="min-h-screen bg-background">
        <div className="max-w-2xl mx-auto px-6 py-10">
          <button
            onClick={() => navigate({ to: '/' })}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 xelay-btn"
          >
            <ArrowLeft size={16} />
            Back to feed
          </button>

          {/* Question */}
          <div className="xelay-card p-6 mb-8">
            <span className="text-xs font-medium px-2.5 py-1 bg-muted text-muted-foreground rounded-full uppercase tracking-wider">
              {question.category}
            </span>
            <h1 className="text-xl font-bold text-foreground mt-4 mb-6 leading-relaxed">
              {question.text}
            </h1>
            <div className="flex items-center justify-between text-sm text-muted-foreground pt-4 border-t border-border">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-bold text-foreground">
                  {question.authorName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="font-medium text-foreground text-sm">{question.authorName}</p>
                  <StarRating rating={starsFromRating(authorRating)} size="sm" />
                </div>
              </div>
              <span>{formatDistanceToNow(new Date(question.createdAt), { addSuffix: true })}</span>
            </div>
          </div>

          {/* Answers */}
          <div className="mb-8">
            <h2 className="text-lg font-bold text-foreground mb-4">
              {answers.length} {answers.length === 1 ? 'Answer' : 'Answers'}
            </h2>

            {answers.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <p>No answers yet. Be the first to answer!</p>
              </div>
            ) : (
              <div className="space-y-4">
                {answers.map((ans) => (
                  <AnswerCard
                    key={ans.id}
                    answer={ans}
                    questionAuthorId={question.authorId}
                    onLiked={fetchData}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Answer Form */}
          <div className="xelay-card p-6">
            <h3 className="text-base font-bold text-foreground mb-4">Write an Answer</h3>
            <form onSubmit={handleSubmitAnswer} className="space-y-3">
              <textarea
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                placeholder={isAuthenticated ? 'Share your knowledge...' : 'Sign in to answer'}
                rows={4}
                disabled={!isAuthenticated}
                className="w-full px-4 py-3 border border-border rounded-lg bg-background text-foreground text-sm resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors disabled:opacity-60"
              />
              {submitError && (
                <p className="text-xs text-destructive">{submitError}</p>
              )}
              <div className="flex items-center justify-between gap-3">
                {!isAuthenticated ? (
                  <button
                    type="button"
                    onClick={() => setShowAuthModal(true)}
                    className="text-sm text-foreground underline hover:text-muted-foreground transition-colors"
                  >
                    Sign in to answer
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="submit"
                  disabled={submitting || !answerText.trim() || !isAuthenticated}
                  className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background text-sm font-semibold rounded-lg hover:bg-foreground/85 transition-colors disabled:opacity-50 disabled:cursor-not-allowed xelay-btn"
                >
                  {submitting ? (
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                  ) : (
                    <>Submit <Send size={13} /></>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </>
  )
}
