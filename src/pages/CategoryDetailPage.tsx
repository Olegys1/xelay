import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { blink } from '../blink/client'
import { Question, slugToCategory } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { AskQuestionForm } from '../components/AskQuestionForm'
import { CATEGORY_META } from '../lib/categoryMeta'

export function CategoryDetailPage() {
  const { slug } = useParams({ from: '/category/$slug' })
  const navigate = useNavigate()
  const [questions, setQuestions] = useState<Question[]>([])
  const [loading, setLoading] = useState(true)

  const categoryName = slugToCategory(slug || '') || slug || ''
  const meta = CATEGORY_META[categoryName]

  const fetchQuestions = useCallback(async () => {
    if (!categoryName) return
    try {
      const data = await blink.db.xelayQuestions.list({
        where: { category: categoryName },
        orderBy: { createdAt: 'desc' },
        limit: 50,
      })
      setQuestions((data || []) as unknown as Question[])
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [categoryName])

  useEffect(() => {
    setLoading(true)
    fetchQuestions()
  }, [fetchQuestions])

  /** Called by AskQuestionForm after a successful post — prepend optimistically */
  const handlePosted = (newQ: Question) => {
    setQuestions((prev) => [newQ, ...prev])
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-6 py-10">

        {/* Back nav */}
        <button
          onClick={() => navigate({ to: '/categories' })}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8 xelay-btn"
        >
          <ArrowLeft size={16} />
          All Categories
        </button>

        {/* Category header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            {meta?.icon && <span className="text-3xl leading-none">{meta.icon}</span>}
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{categoryName}</h1>
          </div>
          {meta?.description && (
            <p className="text-muted-foreground text-sm mt-1 mb-3 leading-relaxed">{meta.description}</p>
          )}
        </div>

        {/* Ask form — locked to this category */}
        <div className="xelay-card p-5 mb-8">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
            Ask in {categoryName}
          </p>
          <AskQuestionForm
            lockedCategory={categoryName}
            onPosted={handlePosted}
          />
        </div>

        {/* Feed header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-foreground">
            {loading ? 'Loading…' : `${questions.length} question${questions.length !== 1 ? 's' : ''}`}
          </h2>
          <button
            onClick={fetchQuestions}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted xelay-btn"
            title="Refresh"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        {/* Feed */}
        {loading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="xelay-card p-5 animate-pulse">
                <div className="h-3 bg-muted rounded w-20 mb-3" />
                <div className="h-4 bg-muted rounded w-3/4 mb-2" />
                <div className="h-3 bg-muted rounded w-32 mt-4" />
              </div>
            ))}
          </div>
        ) : questions.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-3xl mb-3">💬</p>
            <p className="text-muted-foreground text-sm">
              No questions yet — be the first to ask something in{' '}
              <span className="font-semibold text-foreground">{categoryName}</span>.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {questions.map((q) => (
              <QuestionCard key={q.id} question={q} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
