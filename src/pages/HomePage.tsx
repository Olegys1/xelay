import { useState, useEffect, useRef } from 'react'
import {
  Search,
  ArrowRight,
  ImageIcon
} from 'lucide-react'
import { useSearch } from '@tanstack/react-router'
import { OnboardingModal } from '../components/OnboardingModal'

import { supabase } from '../lib/supabase'
import { getMemberCount } from '../lib/profiles'
import { useAuth } from '../context/AuthContext'

import { Question, CATEGORIES } from '../types'

import { QuestionCard } from '../components/QuestionCard'
import { AuthModal } from '../components/AuthModal'
import { useTranslation } from '../hooks/useTranslation'
import { categoryLabel } from '../translations/categories'
import { addQuestionAuthors } from '../lib/questionAuthors'
import { publicMediaValidationError, publicContentError, uploadPublicMediaFiles, removePublicMedia, type PublicMediaUpload } from '../lib/publicMedia'

interface HomePageProps {
  onAuthRequest?: () => void
}

export function HomePage({
  onAuthRequest,
}: HomePageProps) {
   const { t } = useTranslation()
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
    useState<string>('')

  const [submitting, setSubmitting] =
    useState(false)
  const postingRef = useRef(false)

  const [questions, setQuestions] =
    useState<Question[]>([])
  const deletedQuestionIds = useRef(new Set<string>())
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
    } else {
      setCategory('')
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
const questionsWithAuthors = await addQuestionAuthors(questionsData || [])
const mappedQuestions =
  questionsWithAuthors.map(
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

setQuestions((mappedQuestions as Question[]).filter((question) => !deletedQuestionIds.current.has(question.id)))
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

      getMemberCount(),
    ])

    setStats({
      questions:
        questionsResult.count || 0,

      members:
        Number(membersResult.data) || 0,
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

  return () => clearInterval(interval)
}, [])

useEffect(() => {
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
    if (postingRef.current) return

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
        'Профіль ще завантажується…'
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

    if (!CATEGORIES.some((topic) => topic === category)) {
      setError('Оберіть категорію для запитання.')
      return
    }

    const mediaProblem = publicMediaValidationError(selectedImages, 'question-images')
    if (mediaProblem) { setError(mediaProblem); return }

    let uploaded: PublicMediaUpload[] = []
    let questionSaved = false

    try {
      postingRef.current = true
      setSubmitting(true)
      uploaded = await uploadPublicMediaFiles(authUser.id, 'questions', selectedImages, 'question-images')
      const uploadedImageUrls = uploaded.map((media) => media.url)

const payload = {
  user_id: authUser.id,

  title: questionText.trim().slice(0, 500),

  content: questionText.trim(),

  category,

  author_name:
    xelayUser?.name ||
    authUser.email ||
    'Анонім',

  author_avatar:
    xelayUser?.avatarUrl || '',

  created_at:
    new Date().toISOString(),
}
      const { data, error } =
        await supabase
          .from('questions')
          .insert(payload)
          .select()
          .single()

if (error || !data) {
  console.error('SUPABASE ERROR:', error)
  throw error || new Error('Question was not created')
}
      questionSaved = true

          if (
  uploadedImageUrls.length > 0
) {
  const { error: imageError } = await supabase
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
  if (imageError) {
    await removePublicMedia('question-images', uploaded)
    setError('Запитання опубліковано, але вкладення не збереглися.')
  }
}

await fetchQuestions()

setQuestionText('')
setCategory('')

setSelectedImages([])

if (fileInputRef.current) {
  fileInputRef.current.value = ''
}

setSuccess(true)

      setTimeout(() => {
        setSuccess(false)
      }, 3000)
    } catch (err) {
      if (!questionSaved) await removePublicMedia('question-images', uploaded)
      console.error(err)

      setError(publicContentError(err, 'Не вдалося опублікувати запитання. Спробуйте ще раз.'))
    } finally {
      postingRef.current = false
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
              Навчайся. Ділися. Знайомся.
            </h1>

            <p className="text-muted-foreground text-lg mb-10">
              {t('heroDescription')}
            </p>
<div className="flex justify-center gap-10 mb-6">
  <div className="text-center">
    <div className="text-2xl font-bold text-foreground">
      {stats.questions}
    </div>

    <div className="text-sm text-muted-foreground">
      {t('questions')}
    </div>
  </div>

  <div className="text-center">
    <div className="text-2xl font-bold text-foreground">
      {stats.members}
    </div>

    <div className="text-sm text-muted-foreground">
      {t('members')}
    </div>
  </div>
</div>
            <form
              onSubmit={handleAsk}
              className="space-y-3"
            >
              {category && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-foreground inline-block" />

                  Обрана тема:

                  <span className="font-semibold text-foreground">
                    {categoryLabel(category)}
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
    maxLength={50000}
    onChange={(e) =>
      setQuestionText(
        e.target.value
      )
    }
    placeholder={t('askQuestion')}
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

      const files = Array.from(e.target.files)
      const problem = publicMediaValidationError(files, 'question-images')
      if (problem) { setError(problem); e.target.value = ''; return }
      setSelectedImages(files)
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

              <div className="flex flex-col gap-3 sm:flex-row">
                <select
                  value={category}
                  required
                  aria-label="Категорія запитання"
                  disabled={submitting}
                  onChange={(e) =>
                    setCategory(
                      e.target.value
                    )
                  }
                  className="min-w-0 flex-1 px-4 py-3 border border-border rounded-xl bg-background text-foreground text-sm disabled:opacity-50"
                >
                  <option value="" disabled>Оберіть категорію</option>
                  {CATEGORIES.map((cat) => (
                    <option
                      key={cat}
                      value={cat}
                    >
                      {categoryLabel(cat)}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={
  submitting ||
  !category ||
  (
    !questionText.trim() &&
    selectedImages.length === 0
  )
}
                  className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 active:scale-[0.98] transition-all duration-150 disabled:opacity-50"
                >
                  {submitting ? (
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                  ) : (
                    <>
                      {t('ask')}

                      <ArrowRight
                        size={15}
                      />
                    </>
                  )}
                </button>
              </div>

              {success && (
                <p className="text-sm text-green-500">
                  ✓ Запитання опубліковано
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

        <section className="w-full min-w-0 max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
          <div className="mb-6 flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-xl font-bold text-foreground break-words">
              {t('recentQuestions')}
            </h2>

            <button
              onClick={fetchQuestions}
              className="inline-flex items-center gap-2 self-end whitespace-nowrap text-sm text-primary hover:text-primary/80 xelay-btn sm:self-auto"
            >
              <span aria-hidden="true">↻</span> {t('refresh')}
            </button>
          </div>

          {loading ? (
            <div className="text-center py-20">
             {t('loading')}
            </div>
          ) : questions.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-5xl mb-4">
                💬
              </p>

              <p className="text-muted-foreground">
                {t('noQuestions')}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  onDeleted={(questionId) => {
                    deletedQuestionIds.current.add(questionId)
                    setQuestions((previous) => previous.filter((question) => question.id !== questionId))
                    setStats((previous) => ({ ...previous, questions: Math.max(0, previous.questions - 1) }))
                  }}
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
