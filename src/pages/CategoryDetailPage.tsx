import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
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
const { data, error } = await supabase
  .from('questions')
  .select('*')
  .eq('category', categoryName)
  .order('created_at', { ascending: false })
  .limit(50)

if (error) throw error

const questionsWithImages =
  await Promise.all(
    (data || []).map(
      async (question: any) => {
        const {
          data: images,
        } = await supabase
          .from('question_images')
          .select('image_url')
          .eq(
            'question_id',
            question.id
          )

        return {
          ...question,
          images:
            images?.map(
              (img) =>
                img.image_url
            ) || [],
        }
      }
    )
  )

setQuestions(
  questionsWithImages as Question[]
)
    } catch (err) {
      console.error('[Category questions]', err)
    } finally {
      setLoading(false)
    }
  }, [categoryName])

  useEffect(() => {
    setLoading(true)
    fetchQuestions()
  }, [fetchQuestions])

  const handlePosted = (newQ: Question) => {
    setQuestions((prev) => [newQ, ...prev])
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-6 py-10">

        {/* Back */}
        <button
          onClick={() => navigate({ to: '/categories' })}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8 xelay-btn"
        >
          <ArrowLeft size={16} />
          All Categories
        </button>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            {meta?.icon && (
              <span className="text-3xl leading-none">
                {meta.icon}
              </span>
            )}

            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              {categoryName}
            </h1>
          </div>

          {meta?.description && (
            <p className="text-muted-foreground text-sm mt-1 mb-3 leading-relaxed">
              {meta.description}
            </p>
          )}
        </div>

        {/* Ask */}
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
            {loading
              ? 'Loading...'
              : `${questions.length} question${questions.length !== 1 ? 's' : ''}`
            }
          </h2>

          <button
            onClick={fetchQuestions}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted xelay-btn"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        {/* Questions */}
        {loading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="xelay-card p-5 animate-pulse"
              >
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
              <span className="font-semibold text-foreground">
                {categoryName}
              </span>
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {questions.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}