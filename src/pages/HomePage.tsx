import { useState, useEffect, useRef, useCallback, memo } from 'react'
import {
  Search,
  ArrowRight,
  ImageIcon
} from 'lucide-react'
import { useSearch } from '@tanstack/react-router'

import { supabase } from '../lib/supabase'
import { useHomeFeed } from '../hooks/useHomeFeed'
import { createHomeImagePreviews } from '../lib/homeFeedImages'
import { useAuth } from '../context/AuthContext'

import { CATEGORIES } from '../types'

import { QuestionCard } from '../components/QuestionCard'
import { AuthModal } from '../components/AuthModal'
import { useTranslation } from '../hooks/useTranslation'
import { categoryLabel } from '../translations/categories'
import { publicMediaValidationError, publicContentError, uploadPublicMediaFiles, removePublicMedia, type PublicMediaUpload } from '../lib/publicMedia'

interface HomePageProps {
  onAuthRequest?: () => void
}

const FeedQuestionCard = memo(QuestionCard)

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

  const { questions, stats, loading, refreshing, error: feedError, refresh: fetchQuestions, removeQuestion } = useHomeFeed(authUser?.id)
  const [imagePreviews, setImagePreviews] = useState<Array<{ file: File; url: string }>>([])

  useEffect(() => {
    const previews = createHomeImagePreviews(selectedImages)
    setImagePreviews(previews.previews)
    return previews.dispose
  }, [selectedImages])

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

      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 200)
      return () => clearTimeout(timer)
    } else {
      setCategory('')
    }
  }, [searchCategory])


  const handleAnswerClick = useCallback(() => {
    if (!isAuthenticated) {
      if (onAuthRequest) onAuthRequest()
      else setShowAuthModal(true)
    }
  }, [isAuthenticated, onAuthRequest])

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

await fetchQuestions(true)

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
    aria-label="Додати фото"
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
            key={`${image.name}:${image.lastModified}:${index}`}
            className="relative"
          >
            <img
              src={imagePreviews.find((preview) => preview.file === image)?.url}
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
              aria-label="Прибрати фото"
              className="absolute top-1 right-1 bg-black text-white w-5 h-5 rounded-full text-xs flex items-center justify-center"
            >
              ×
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
              onClick={() => { void fetchQuestions() }}
              disabled={refreshing}
              aria-busy={refreshing}
              className="inline-flex items-center gap-2 self-end whitespace-nowrap text-sm text-primary hover:text-primary/80 xelay-btn sm:self-auto disabled:opacity-60"
            >
              <span aria-hidden="true" className={refreshing ? 'animate-spin' : undefined}>↻</span> {t('refresh')}
            </button>
          </div>

          {feedError && (
            <p role="status" className="mb-4 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              {feedError}
            </p>
          )}

          {loading ? (
            <div className="text-center py-20">
             {t('loading')}
            </div>
          ) : questions.length === 0 && feedError ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              Стрічка з’явиться після відновлення з’єднання.
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
                <FeedQuestionCard
                  key={q.id}
                  question={q}
                  onDeleted={removeQuestion}
                  onAnswerClick={handleAnswerClick}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  )
}
