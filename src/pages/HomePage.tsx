import { useState, useEffect, useRef } from 'react'
import { Search, ArrowRight } from 'lucide-react'
import { useSearch } from '@tanstack/react-router'

import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

import { Question, CATEGORIES } from '../types'

import { QuestionCard } from '../components/QuestionCard'
import { AuthModal } from '../components/AuthModal'

interface HomePageProps {
  onAuthRequest?: () => void
}

export function HomePage({
  onAuthRequest,
}: HomePageProps) {
  const {
    isAuthenticated,
    authUser,
    xelayUser,
    isLoading,
  } = useAuth()

  const { category: searchCategory } =
    useSearch({ from: '/' })

  const [questionText, setQuestionText] =
    useState('')

  const [category, setCategory] =
    useState<string>(
      searchCategory || CATEGORIES[0]
    )

  const [submitting, setSubmitting] =
    useState(false)

  const [questions, setQuestions] =
    useState<Question[]>([])

  const [loading, setLoading] =
    useState(true)

  const [showAuthModal, setShowAuthModal] =
    useState(false)

  const [success, setSuccess] =
    useState(false)

  const [error, setError] =
    useState('')

  const textareaRef =
    useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (
      searchCategory &&
      CATEGORIES.includes(
        searchCategory as
          (typeof CATEGORIES)[number]
      )
    ) {
      setCategory(searchCategory)

      setTimeout(() => {
        textareaRef.current?.focus()
      }, 200)
    }
  }, [searchCategory])

const fetchQuestions = async () => {
  console.log('FETCH QUESTIONS START')
  console.log('XELAY BUILD TEST 777')

  try {
    const result = await supabase
      .from('questions')
      .select('*')
      .order('created_at', {
        ascending: false,
      })
      .limit(50)

    console.log(
      'FETCH QUESTIONS RESULT:',
      result
    )

    const { data, error } = result

    console.log(
      'FETCH QUESTIONS DATA:',
      data
    )

    console.log(
      'FETCH QUESTIONS ERROR:',
      error
    )

    if (error) {
      setLoading(false)
      return
    }

    setQuestions(
      (data || []) as Question[]
    )
  } catch (err) {
    console.error(
      'FETCH QUESTIONS CRASH:',
      err
    )
  } finally {
    console.log(
      'FETCH QUESTIONS FINISH'
    )

    setLoading(false)
  }
}

  useEffect(() => {
    fetchQuestions()

    const interval = setInterval(() => {
      fetchQuestions()
    }, 5000)

    return () => {
      clearInterval(interval)
    }
  }, [])

  const handleAsk = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setError('')

    if (isLoading) {
      return
    }

    if (!isAuthenticated || !authUser) {
      setShowAuthModal(true)
      return
    }

    if (!xelayUser) {
      setError(
        'Profile is still loading...'
      )
      return
    }

    if (!questionText.trim()) {
      return
    }

    try {
      setSubmitting(true)

const payload = {
  user_id: authUser.id,

  title: questionText.trim(),

  content: questionText.trim(),

  category,

  author_name:
    xelayUser?.name ||
    authUser.email ||
    'Anonymous',

  author_avatar:
    xelayUser?.avatarUrl || '',

  created_at:
    new Date().toISOString(),
}
console.log('XELAY USER:', xelayUser)

console.log('PAYLOAD:', payload)
      const { data, error } =
        await supabase
          .from('questions')
          .insert(payload)
          .select()
          .single()

if (error) {
  console.error('SUPABASE ERROR:', error)

  alert(JSON.stringify(error))

  setError(error.message)

  return
}
      setQuestions((prev) => [
        data as Question,
        ...prev,
      ])

      setQuestionText('')

      setSuccess(true)

      setTimeout(() => {
        setSuccess(false)
      }, 3000)
    } catch (err) {
      console.error(err)

      setError(
        'Failed to post question'
      )
    } finally {
      setSubmitting(false)
    }
  }

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
        <section className="border-b border-border bg-background">
          <div className="max-w-2xl mx-auto px-6 py-16 text-center">
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground mb-3">
              Ask. Answer. Grow.
            </h1>

            <p className="text-muted-foreground text-lg mb-10">
              Exchange business knowledge
              with professionals worldwide.
            </p>

            <form
              onSubmit={handleAsk}
              className="space-y-3"
            >
              {searchCategory && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-foreground inline-block" />

                  Category pre-selected:

                  <span className="font-semibold text-foreground">
                    {searchCategory}
                  </span>
                </div>
              )}

              <div className="relative">
                <Search
                  size={18}
                  className="absolute left-4 top-4 text-muted-foreground pointer-events-none"
                />

                <textarea
                  ref={textareaRef}
                  value={questionText}
                  onChange={(e) =>
                    setQuestionText(
                      e.target.value
                    )
                  }
                  placeholder="Ask your question..."
                  rows={3}
                  className="w-full pl-11 pr-4 py-4 border border-border rounded-xl bg-background text-foreground text-base resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20"
                />
              </div>

              <div className="flex gap-3">
                <select
                  value={category}
                  onChange={(e) =>
                    setCategory(
                      e.target.value
                    )
                  }
                  className="flex-1 px-4 py-3 border border-border rounded-xl bg-background text-foreground text-sm"
                >
                  {CATEGORIES.map((cat) => (
                    <option
                      key={cat}
                      value={cat}
                    >
                      {cat}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={
                    submitting ||
                    !questionText.trim()
                  }
                  className="flex items-center gap-2 px-6 py-3 bg-foreground text-background font-semibold rounded-xl hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150 disabled:opacity-50"
                >
                  {submitting ? (
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                  ) : (
                    <>
                      Ask

                      <ArrowRight
                        size={15}
                      />
                    </>
                  )}
                </button>
              </div>

              {success && (
                <p className="text-sm text-green-500">
                  ✓ Question posted
                  successfully
                </p>
              )}

              {error && (
                <p className="text-sm text-red-500">
                  {error}
                </p>
              )}
            </form>
          </div>
        </section>

        <section className="max-w-2xl mx-auto px-6 py-10">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-foreground">
              Recent Questions
            </h2>

            <button
              onClick={fetchQuestions}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <div className="text-center py-20">
              Loading...
            </div>
          ) : questions.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-5xl mb-4">
                💬
              </p>

              <p className="text-muted-foreground">
                No questions yet
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  onAnswerClick={() => {
                    if (
                      !isAuthenticated
                    ) {
                      if (
                        onAuthRequest
                      ) {
                        onAuthRequest()
                      } else {
                        setShowAuthModal(
                          true
                        )
                      }
                    }
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  )
}