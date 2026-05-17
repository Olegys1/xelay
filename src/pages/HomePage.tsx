import { useState, useEffect, useRef } from 'react'
import { Search, ArrowRight } from 'lucide-react'
import { useSearch } from '@tanstack/react-router'
import { blink } from '../blink/client'
import { useAuth } from '../context/AuthContext'
import { Question, CATEGORIES } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { AuthModal } from '../components/AuthModal'

interface HomePageProps {
  onAuthRequest?: () => void
}

export function HomePage({ onAuthRequest }: HomePageProps) {
  const { isAuthenticated, blinkUser, xelayUser } = useAuth()
  const { category: searchCategory } = useSearch({ from: '/' })

  const [questionText, setQuestionText] = useState('')
  const [category, setCategory] = useState<string>(searchCategory || CATEGORIES[0])
  const [submitting, setSubmitting] = useState(false)
  const [questions, setQuestions] = useState<Question[]>([])
  const [loading, setLoading] = useState(true)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // When a category arrives from search param, apply it and scroll + focus
  useEffect(() => {
    if (searchCategory && CATEGORIES.includes(searchCategory as typeof CATEGORIES[number])) {
      setCategory(searchCategory)
      // Focus the textarea so user can start typing immediately
      setTimeout(() => textareaRef.current?.focus(), 200)
    }
  }, [searchCategory])

  const fetchQuestions = async () => {
    try {
      const data = await blink.db.xelayQuestions.list({
        orderBy: { createdAt: 'desc' },
        limit: 50,
      })
      setQuestions((data || []) as unknown as Question[])
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchQuestions()
    // Poll every 30s for new questions from other users
    const interval = setInterval(fetchQuestions, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }
    if (!questionText.trim()) return
    if (!xelayUser) {
      setShowAuthModal(true)
      return
    }

    setSubmitting(true)
    try {
      const newQ: Question = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: blinkUser!.id,
        authorId: blinkUser!.id,
        authorName: xelayUser.name,
        text: questionText.trim(),
        category,
        likes: 0,
        createdAt: new Date().toISOString(),
      }
      await blink.db.xelayQuestions.create(newQ)
      setQuestions((prev) => [newQ, ...prev])
      setQuestionText('')
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      console.error('Ask error:', err)
      setError('Failed to post question. Please try again.')
      setTimeout(() => setError(''), 4000)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {showAuthModal && (
        <AuthModal onClose={() => setShowAuthModal(false)} />
      )}

      <main className="min-h-screen bg-background">
        {/* Hero Ask Section */}
        <section className="border-b border-border bg-background">
          <div className="max-w-2xl mx-auto px-6 py-16 text-center">
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground mb-3">
              Ask. Answer. Grow.
            </h1>
            <p className="text-muted-foreground text-lg mb-10">
              Exchange business knowledge with professionals worldwide.
            </p>

            <form onSubmit={handleAsk} className="space-y-3">
              {/* Category indicator when pre-selected */}
              {searchCategory && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground animate-fade-in">
                  <span className="w-1.5 h-1.5 rounded-full bg-foreground inline-block" />
                  Category pre-selected: <span className="font-semibold text-foreground">{searchCategory}</span>
                </div>
              )}

              {/* Question input */}
              <div className="relative">
                <Search
                  size={18}
                  className="absolute left-4 top-4 text-muted-foreground pointer-events-none"
                />
                <textarea
                  ref={textareaRef}
                  value={questionText}
                  onChange={(e) => setQuestionText(e.target.value)}
                  placeholder="Ask your question..."
                  rows={3}
                  className="w-full pl-11 pr-4 py-4 border border-border rounded-xl bg-background text-foreground text-base resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors"
                />
              </div>

              <div className="flex gap-3">
                {/* Category select */}
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="flex-1 px-4 py-3 border border-border rounded-xl bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors cursor-pointer"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>

                {/* Ask button */}
                <button
                  type="submit"
                  disabled={submitting || !questionText.trim()}
                  className="flex items-center gap-2 px-6 py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap text-sm xelay-btn"
                >
                  {submitting ? (
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                  ) : (
                    <>
                      Ask <ArrowRight size={15} />
                    </>
                  )}
                </button>
              </div>

              {success && (
                <p className="text-sm text-foreground font-medium animate-fade-in">
                  ✓ Question posted successfully!
                </p>
              )}
              {error && (
                <p className="text-sm text-destructive animate-fade-in">{error}</p>
              )}
            </form>
          </div>
        </section>

        {/* Feed */}
        <section className="max-w-2xl mx-auto px-6 py-10">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-foreground">Recent Questions</h2>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{questions.length} questions</span>
              <button
                onClick={fetchQuestions}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted xelay-btn"
                title="Refresh questions"
              >
                ↻ Refresh
              </button>
            </div>
          </div>

          {loading ? (
            <div className="space-y-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="xelay-card p-5 animate-pulse">
                  <div className="h-3 bg-muted rounded w-20 mb-3" />
                  <div className="h-4 bg-muted rounded w-3/4 mb-2" />
                  <div className="h-4 bg-muted rounded w-1/2 mb-4" />
                  <div className="h-3 bg-muted rounded w-32" />
                </div>
              ))}
            </div>
          ) : questions.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-5xl mb-4">💬</p>
              <p className="text-muted-foreground">No questions yet. Be the first to ask!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  onAnswerClick={() => !isAuthenticated && (onAuthRequest?.() ?? setShowAuthModal(true))}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  )
}
