import { useState, useEffect, useRef } from 'react'
import {
  Search,
  ArrowRight,
  ImageIcon
} from 'lucide-react'
import { useSearch } from '@tanstack/react-router'
import { OnboardingModal } from '../components/OnboardingModal'

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

    const [selectedImages, setSelectedImages] =
  useState<File[]>([])

const fileInputRef =
  useRef<HTMLInputElement>(null)

  const [category, setCategory] =
    useState<string>(
      searchCategory || CATEGORIES[0]
    )

  const [submitting, setSubmitting] =
    useState(false)

  const [questions, setQuestions] =
    useState<Question[]>([])
const [showOnboarding, setShowOnboarding] =
  useState(false)
const [stats, setStats] = useState({
  questions: 0,
  members: 0,
})

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
  try {
    const [
      questionsResult,
      imagesResult,
    ] = await Promise.all([
      supabase
  .from('questions')
  .select('*')
  .order('is_pinned', {
    ascending: false,
  })
  .order('created_at', {
    ascending: false,
  })
  .limit(50),

      supabase
        .from('question_images')
        .select('*'),
    ])

    const {
      data: questionsData,
      error: questionsError,
    } = questionsResult

    const {
      data: imagesData,
    } = imagesResult

    if (questionsError) {
      setLoading(false)
      return
    }

    const mappedQuestions =
  (questionsData || []).map(
    (question) => ({
      ...question,

      images:
        imagesData
          ?.filter(
            (img) =>
              img.question_id ===
              question.id
          )
          .map(
            (img) =>
              img.image_url
          ) || [],
    })
  )


setQuestions(
  mappedQuestions as Question[]
)
  } catch (err) {
    console.error(
      'FETCH QUESTIONS CRASH:',
      err
    )
  } finally {
    setLoading(false)
  }
}
const fetchStats = async () => {
  try {
    const [
      questionsResult,
      membersResult,
    ] = await Promise.all([
      supabase
        .from('questions')
        .select('*', {
          count: 'exact',
          head: true,
        }),

      supabase
        .from('profiles')
        .select('*', {
          count: 'exact',
          head: true,
        }),
    ])

    setStats({
      questions:
        questionsResult.count || 0,

      members:
        membersResult.count || 0,
    })
  } catch (err) {
    console.error(
      'FETCH STATS ERROR:',
      err
    )
  }
}
 useEffect(() => {
  fetchQuestions()
  fetchStats()

  const interval = setInterval(() => {
    fetchQuestions()
    fetchStats()
  }, 5000)

    return () => {
      clearInterval(interval)
    }
  }, [])

useEffect(() => {
  console.log(
  'ONBOARDING CHECK',
  xelayUser
)
  if (
    isAuthenticated &&
    xelayUser &&
    !(xelayUser as any).has_seen_onboarding
  ) {
    setShowOnboarding(true)
  }
}, [
  isAuthenticated,
  xelayUser,
])

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

   if (
  !questionText.trim() &&
  selectedImages.length === 0
) 
{
  return
}

    try {
      setSubmitting(true)
      let uploadedImageUrls: string[] = []

for (const image of selectedImages) {
  const fileExt =
    image.name.split('.').pop()

  const filePath =
    `questions/${Date.now()}-${Math.random()}.${fileExt}`

  const { error: uploadError } =
    await supabase.storage
      .from('question-images')
      .upload(
        filePath,
        image
      )

  if (uploadError) {
    throw uploadError
  }


  
  const {
    data: publicUrlData,
  } = supabase.storage
    .from('question-images')
    .getPublicUrl(filePath)

  uploadedImageUrls.push(
    publicUrlData.publicUrl
  )
}

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

          if (
  uploadedImageUrls.length > 0
) {
  await supabase
    .from('question_images')
    .insert(
      uploadedImageUrls.map(
        (url) => ({
          question_id:
            data.id,

          image_url: url,
        })
      )
    )
}

if (error) {
  console.error('SUPABASE ERROR:', error)

  alert(JSON.stringify(error))

  setError(error.message)

  return
}
await fetchQuestions()

setQuestionText('')

setSelectedImages([])

if (fileInputRef.current) {
  fileInputRef.current.value = ''
}

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
const finishOnboarding =
  async () => {
    if (!authUser) return

    await supabase
      .from('profiles')
      .update({
        has_seen_onboarding: true,
      })
      .eq(
        'id',
        authUser.id
      )

    setShowOnboarding(false)
  }
  return (
    <>
    {showOnboarding && (
  <OnboardingModal
    onFinish={finishOnboarding}
  />
)}
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
              Ask.Answer.Grow
            </h1>

            <p className="text-muted-foreground text-lg mb-10">
              Learn directly from founders, professionals and experts worldwide.
            </p>
<div className="flex justify-center gap-10 mb-6">
  <div className="text-center">
    <div className="text-2xl font-bold text-foreground">
      {stats.questions}
    </div>

    <div className="text-sm text-muted-foreground">
      Questions
    </div>
  </div>

  <div className="text-center">
    <div className="text-2xl font-bold text-foreground">
      {stats.members}
    </div>

    <div className="text-sm text-muted-foreground">
      Members
    </div>
  </div>
</div>
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
    className="w-full pl-11 pr-12 py-4 border border-border rounded-xl bg-background text-foreground text-base resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20"
  />

  <button
    type="button"
    onClick={() =>
      fileInputRef.current?.click()
    }
    className="absolute bottom-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
  >
    <ImageIcon size={18} />
  </button>

  <input
    ref={fileInputRef}
    type="file"
    multiple
    accept="image/*"
    className="hidden"
    onChange={(e) => {
      if (!e.target.files) return

      setSelectedImages(
        Array.from(
          e.target.files
        )
      )
    }}
  />

  {selectedImages.length > 0 && (
    <div className="flex flex-wrap gap-2 mt-3">
      {selectedImages.map(
        (image, index) => (
          <div
            key={index}
            className="relative"
          >
            <img
              src={URL.createObjectURL(
                image
              )}
              alt=""
              className="w-24 h-24 object-cover rounded-lg border border-border"
            />

            <button
              type="button"
              onClick={() =>
                setSelectedImages(
                  selectedImages.filter(
                    (_, i) =>
                      i !== index
                  )
                )
              }
              className="absolute top-1 right-1 bg-black text-white w-5 h-5 rounded-full text-xs flex items-center justify-center"
            >
              
            </button>
          </div>
        )
      )}
    </div>
  )}
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
  (
    !questionText.trim() &&
    selectedImages.length === 0
  )
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