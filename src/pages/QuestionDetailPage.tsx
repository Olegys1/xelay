import { useState, useEffect, useRef } from 'react'
import { Link, useParams, useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowLeft,
  Send,
  Paperclip,
  X
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'

import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

import type { Question, Answer } from '../types'

import { AnswerCard } from '../components/AnswerCard'
import { AuthModal } from '../components/AuthModal'
import { categoryLabel } from '../translations/categories'
import { ukrainianCount } from '../lib/ukrainian'
import { addQuestionAuthors } from '../lib/questionAuthors'
import { deleteOwnQuestion } from '../lib/communityDeletion'
import { OwnContentDeleteButton } from '../components/OwnContentDeleteButton'
import { publicMediaValidationError, publicContentError, uploadPublicMediaFiles, removePublicMedia, type PublicMediaUpload } from '../lib/publicMedia'

export function QuestionDetailPage() {
  const { id } = useParams({
    from: '/question/$id',
  })
  const { answer: targetAnswer } = useSearch({ from: '/question/$id' })

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

  const [loading, setLoading] =
    useState(true)
  const [questionError, setQuestionError] = useState('')
  const [answersLoadError, setAnswersLoadError] = useState(false)
  const [highlightedAnswer, setHighlightedAnswer] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const focusedAnswer = useRef<string | null>(null)

  const [answerText, setAnswerText] =
    useState('')

    const [selectedImages, setSelectedImages] =
  useState<File[]>([])

  const [isDragging, setIsDragging] =
  useState(false)

const fileInputRef =
  useRef<HTMLInputElement>(null)

  const [submitting, setSubmitting] =
    useState(false)

  const [submitError, setSubmitError] =
    useState('')

  const [showAuthModal, setShowAuthModal] =
    useState(false)

  const fetchData = async () => {
    const generation = ++loadGeneration.current
    let questionLoaded = false
    setLoading(true)
    setQuestion(null)
    setAnswers([])
    setQuestionError('')
    setAnswersLoadError(false)
    setHighlightedAnswer(null)
    focusedAnswer.current = null
    try {
      const {
        data: qData,
        error: qError,
      } = await supabase
        .from('questions')
        .select('*')
        .eq('id', id)
        .single()
      if (generation !== loadGeneration.current) return

      if (qError || !qData) {
        setQuestionError(qError && qError.code !== 'PGRST116'
          ? 'Не вдалося завантажити запитання. Перевірте з’єднання та спробуйте ще раз.'
          : 'Це запитання вже видалено або воно недоступне.')
        return
      }

      const [questionWithAuthor] = await addQuestionAuthors([qData])
      if (generation !== loadGeneration.current) return
      setQuestion(questionWithAuthor as Question)
      questionLoaded = true

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
      if (generation !== loadGeneration.current) return
      if (answersError) {
        console.error(answersError)
        setAnswersLoadError(true)
        return
      }
const {
  data: answerImages,
} = answersData?.length ? await supabase
  .from('answer_images')
  .select('*')
  .in('answer_id', answersData.map((answer) => answer.id)) : { data: [] }
      if (generation !== loadGeneration.current) return

const mappedAnswers: Answer[] = (
  answersData || []
).map((a: any) => ({
  id: a.id,

  userId: a.user_id,

  questionId: a.question_id,

  authorId: a.user_id,

  authorName:
    a.author_name || 'Анонім',

  author_avatar:
    a.author_avatar || '',

  text: a.content || '',

  createdAt:
    a.created_at ||
    new Date().toISOString(),

images: (() => {
  const images = answerImages
    ?.filter(
      (img) =>
        img.answer_id === a.id
    )
    .map((img) => ({
      url: img.image_url,
      type:
        img.media_type ||
        'image',
    }))?.filter((media) => media.url) || []
  return images.length ? images : (a.media_url ? [{ url: a.media_url, type: a.media_type || 'image' }] : [])
})(),
}))

      setAnswers(mappedAnswers)
    } catch (err) {
      if (generation !== loadGeneration.current) return
      console.error(err)
      if (questionLoaded) setAnswersLoadError(true)
      else setQuestionError('Не вдалося завантажити запитання. Перевірте з’єднання та спробуйте ще раз.')
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

useEffect(() => {
  if (!id) return

  const incrementView = async () => {
    console.log(
      'VIEW INCREMENT',
      id
    )

    const { error } =
      await supabase.rpc(
        'increment_question_views',
        {
          question_id: id,
        }
      )

    console.log(
      'VIEW RPC ERROR:',
      error
    )
  }

  focusedAnswer.current = null
  void fetchData()
  void incrementView()
  return () => { loadGeneration.current += 1 }

}, [id])
  useEffect(() => {
    if (!targetAnswer) {
      focusedAnswer.current = null
      return
    }
    if (loading || question?.id !== id || answersLoadError || !answers.some((answer) => answer.id === targetAnswer)) return
    const focusKey = `${id}:${targetAnswer}`
    if (focusedAnswer.current === focusKey) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`answer-${targetAnswer}`)
      if (!target) return
      focusedAnswer.current = focusKey
      setHighlightedAnswer(targetAnswer)
      target.focus({ preventScroll: true })
      target.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [id, question?.id, targetAnswer, answers, loading, answersLoadError])

  useEffect(() => {
    if (!highlightedAnswer) return
    const timer = window.setTimeout(() => setHighlightedAnswer(null), 3500)
    return () => window.clearTimeout(timer)
  }, [highlightedAnswer])
  useEffect(() => {
  if (!question) return

  const previousTitle = document.title
  const previousMeta = document.querySelector('meta[name="description"]')
  const previousDescription = previousMeta?.getAttribute('content') ?? null

  document.title =
    `${question.content.slice(
      0,
      60
    )} | Xelay`

  const description =
    question.content.slice(
      0,
      150
    )

  let meta =
    document.querySelector(
      'meta[name="description"]'
    )

  if (!meta) {
    meta =
      document.createElement(
        'meta'
      )

    meta.setAttribute(
      'name',
      'description'
    )

    document.head.appendChild(
      meta
    )
  }

  meta.setAttribute(
    'content',
    description
  )

  return () => {
    document.title = previousTitle
    if (!previousMeta) meta?.remove()
    else if (previousDescription === null) meta?.removeAttribute('content')
    else meta?.setAttribute('content', previousDescription)
  }
}, [question])
  const handleSubmitAnswer = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setSubmitError('')

if (!isAuthenticated) {
  setShowAuthModal(true)
  return
}

if (
  !answerText.trim() &&
  selectedImages.length === 0
) {
  return
}

if (
  !authUser ||
  !xelayUser ||
  !question
) {
  return
}

    const mediaProblem = publicMediaValidationError(selectedImages, 'answer-media')
    if (mediaProblem) { setSubmitError(mediaProblem); return }
    setSubmitting(true)
    let uploadedMedia: PublicMediaUpload[] = []
    let answerSaved = false

    try {
uploadedMedia = await uploadPublicMediaFiles(authUser.id, 'answers', selectedImages)
const insertData: any = {
  question_id: question.id,
  user_id: authUser.id,
  content: answerText.trim() || ' ',
  author_name:
    xelayUser.name ||
    authUser.email ||
    'Anonymous',
  author_avatar:
    xelayUser.avatarUrl || '',
  media_url:
    uploadedMedia.length > 0
      ? uploadedMedia[0].url
      : null,

  media_type:
    uploadedMedia.length > 0
      ? uploadedMedia[0].type
      : null,
}
if (uploadedMedia.length > 0) {
  insertData.media_url =
    uploadedMedia[0].url

  insertData.media_type =
    uploadedMedia[0].type
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
answerSaved = true

// The database creates the notification atomically with the answer.
if (
  uploadedMedia.length > 0
) {
const { error: imageError } = await supabase
  .from('answer_images')
  .insert(
    uploadedMedia.map(
      (media) => ({
        answer_id:
          insertedAnswer.id,

        image_url: media.url,

        media_type:
          media.type,
      })
    )
  )
if (imageError) {
  // The first file is also referenced by answers.media_url. Keep it valid;
  // remove only unattached extras and render that primary media as fallback.
  await removePublicMedia('answer-media', uploadedMedia.slice(1))
  uploadedMedia = uploadedMedia.slice(0, 1)
  setSubmitError('Відповідь опубліковано, але частина вкладень не збереглася.')
}
}
// The database maintains the shared counter; this updates the current view only.
setQuestion((prev) =>
  prev
    ? {
        ...prev,
        answers_count: Number(prev.answers_count || 0) + 1,
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
    'Анонім',

  author_avatar:
    insertedAnswer.author_avatar || '',

  text:
    insertedAnswer.content || '',

  createdAt:
    insertedAnswer.created_at,

images: uploadedMedia,
},
])

setAnswerText('')
setSelectedImages([])
    } catch (err) {
  if (!answerSaved) await removePublicMedia('answer-media', uploadedMedia)
  console.error(
    'ANSWER ERROR:',
    err
  )

  setSubmitError(publicContentError(err, 'Не вдалося надіслати відповідь. Спробуйте ще раз.'))
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

  if (!question) return <main className="min-h-[60vh] bg-background"><div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
    <div className="xelay-card p-6"><h1 className="text-lg font-semibold">Запитання недоступне</h1>
      <p role="status" className="mt-3 text-sm text-muted-foreground">{questionError || 'Це запитання вже видалено або воно недоступне.'}</p>
      <div className="mt-5 flex flex-wrap gap-3"><Link to="/" className="rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground">До стрічки запитань</Link>
        <button type="button" onClick={() => void fetchData()} className="rounded-full border border-border px-4 py-2.5 text-sm font-medium">Спробувати ще раз</button></div>
    </div></div></main>

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
        <div className="max-w-2xl mx-auto px-4 py-10 sm:px-6">
          <button
            onClick={() =>
              navigate({ to: '/' })
            }
            className="
  inline-flex
  items-center
  gap-2
  px-3
  py-2
  rounded-lg
  border
  border-border
  bg-background
  text-sm
  text-muted-foreground
  hover:bg-muted
  hover:text-foreground
  transition-all
"
          >
            <ArrowLeft size={16} />
            До стрічки запитань
          </button>

          <div className="xelay-card p-4 sm:p-6 mb-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium px-2.5 py-1 bg-muted text-muted-foreground rounded-full uppercase tracking-wider">
              {categoryLabel(question.category)}
            </span>
            {authUser?.id === question.user_id && <OwnContentDeleteButton kind="question" disabled={submitting} onDelete={async () => {
              if (!authUser?.id || authUser.id !== question.user_id) throw { code: '42501' }
              await deleteOwnQuestion(question.id)
              void navigate({ to: '/' })
            }} />}
            </div>

            <h1 className="break-words text-lg font-normal text-foreground mt-4 mb-6 leading-relaxed">
  {question.content}
</h1>

            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground pt-4 border-t border-border">
              <div className="flex min-w-0 items-center gap-2">
<div className="w-8 h-8 shrink-0 rounded-full overflow-hidden bg-muted flex items-center justify-center text-sm font-bold text-foreground">
  {question.author_avatar ? (
    <img
      src={question.author_avatar}
      alt={question.author_name || 'Аватар'}
      className="w-full h-full object-cover"
    />
  ) : (
    question.author_name
      ?.charAt(0)
      ?.toUpperCase() || '?'
  )}
</div>

                <div>
                  <p
  onClick={() =>
    navigate({
      to: '/user/$id',
      params: {
        id: String(question.user_id),
      },
    })
  }
  className="break-words font-medium text-foreground text-sm cursor-pointer hover:underline"
>
  {question.author_name}
</p>
                </div>
              </div>

              <div className="text-right">
  <div>
    {formatDistanceToNow(
      new Date(question.created_at),
      {
        addSuffix: true,
        locale: uk,
      }
    )}
  </div>

  <div className="text-xs">
    {ukrainianCount(question.views || 0, ['перегляд', 'перегляди', 'переглядів'])}
  </div>
</div>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-lg font-bold text-foreground mb-4">
              {ukrainianCount(question.answers_count || 0, ['відповідь', 'відповіді', 'відповідей'])}
            </h2>

            {answersLoadError ? (
              <div role="status" className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                Не вдалося завантажити відповіді. <button type="button" onClick={() => void fetchData()} className="font-medium text-primary underline underline-offset-2">Спробувати ще раз</button>
              </div>
            ) : <>
            {targetAnswer && !answers.some((answer) => answer.id === targetAnswer) && (
              <p role="status" className="mb-4 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">Цю відповідь уже видалено або вона недоступна. Ви можете переглянути інші відповіді нижче.</p>
            )}
            {answers.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                Відповідей поки немає.
              </div>
            ) : (
              <div className="space-y-4">
                {answers.map((ans) => (
                  <AnswerCard
                    key={ans.id}
                    answer={ans}
                    highlighted={highlightedAnswer === ans.id}
                    deletionDisabled={submitting}
                    onDeleted={(answerId, answersCount) => {
                      setAnswers((previous) => previous.filter((answer) => answer.id !== answerId))
                      setQuestion((previous) => previous ? {
                        ...previous,
                        answers_count: answersCount ?? Math.max(0, Number(previous.answers_count || 0) - 1),
                      } : previous)
                    }}
                  />
                ))}
              </div>
            )}
            </>}
          </div>

          <div className="xelay-card p-6">
            <h3 className="text-base font-bold text-foreground mb-4">
              Напишіть відповідь
            </h3>

            <form
              onSubmit={handleSubmitAnswer}
              className="space-y-3"
            >
              <div className="relative">
  <textarea
    value={answerText}
    maxLength={50000}
    onChange={(e) =>
      setAnswerText(
        e.target.value
      )
    }
    placeholder={
      isAuthenticated
        ? 'Поділіться своїми знаннями...'
        : 'Увійдіть, щоб відповісти'
    }
    rows={4}
    disabled={!isAuthenticated}
    className="w-full px-4 py-3 border border-border rounded-lg bg-background text-foreground text-sm resize-none"
  />
<button
  type="button"
  onClick={() =>
    fileInputRef.current?.click()
  }
  className="
    flex
    items-center
    gap-2
    text-sm
    text-muted-foreground
    hover:text-foreground
    transition-colors
  "
>
  <Paperclip size={16} />

  {selectedImages.length > 0
    ? `Вибрано файлів: ${selectedImages.length}`
    : 'Додати фото або відео'}
</button>

  <input
    ref={fileInputRef}
    type="file"
    accept="image/*,video/*"
    multiple
    className="hidden"
    onChange={(e) => {
      const files = Array.from(
        e.target.files || []
      )
      const combined = [...selectedImages, ...files]
      const problem = publicMediaValidationError(combined, 'answer-media')
      if (problem) { setSubmitError(problem); e.target.value = ''; return }
      setSelectedImages(combined)
    }}
  />

</div>
{selectedImages.length > 0 && (
  <div className="flex flex-wrap gap-2">
    {selectedImages.map(
      (file, index) => (
        <div
          key={index}
          className="relative"
        >
{file.type.startsWith('video/') ? (
  <video
    src={URL.createObjectURL(file)}
    className="w-20 h-20 rounded-lg object-cover border border-border"
    controls
  />
) : (
  <img
    src={URL.createObjectURL(file)}
    alt=""
    className="w-20 h-20 rounded-lg object-cover border border-border"
  />
)}
<p className="text-xs text-muted-foreground mt-1">
  {(file.size / 1024 / 1024).toFixed(1)}
  MB
</p>
          <button
            type="button"
            onClick={() =>
              setSelectedImages(
                (prev) =>
                  prev.filter(
                    (_, i) =>
                      i !== index
                  )
              )
            }
            className="absolute -top-2 -right-2 bg-black text-white rounded-full p-1"
          >
            <X size={10} />
          </button>
        </div>
      )
    )}
  </div>
)}
              {submitError && (
                <p className="text-xs text-red-500">
                  {submitError}
                </p>
              )}

              <button
                type="submit"
                disabled={
  submitting ||
  (
    !answerText.trim() &&
    selectedImages.length === 0
  ) ||
  !isAuthenticated
}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-lg"
              >
                {submitting ? (
                  'Надсилання...'
                ) : (
                  <>
                    Надіслати
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
