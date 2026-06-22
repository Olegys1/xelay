import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  Send,
  Paperclip,
  X
} from 'lucide-react'
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
const {
  data: answerImages,
} = await supabase
  .from('answer_images')
  .select('*')
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

images:
  answerImages
    ?.filter(
      (img) =>
        img.answer_id === a.id
    )
    .map((img) => ({
      url: img.image_url,
      type:
        img.media_type ||
        'image',
    })) || []
}))

      setAnswers(mappedAnswers)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
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

  fetchData()
  incrementView()

}, [id])
  useEffect(() => {
  if (!question) return

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
    document.title =
      'Xelay — Knowledge Exchange Platform'
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

    setSubmitting(true)
    console.log(
  'SUBMIT START'
)
    let uploadedMedia: {
  url: string
  type: string
}[] = []

    try {
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
  author_rating:
    xelayUser.rating || 0,
  likes: 0,

  media_url:
    uploadedMedia.length > 0
      ? uploadedMedia[0].url
      : null,

  media_type:
    uploadedMedia.length > 0
      ? uploadedMedia[0].type
      : null,
}
if (selectedImages.length > 0) {
  console.log(
  'SELECTED IMAGES:',
  selectedImages.length
)
  for (const image of selectedImages) {
    const fileExt =
      image.name.split('.').pop()

      const mediaType =
  image.type.startsWith('video/')
    ? 'video'
    : 'image'
console.log('FILE NAME:', image.name)
console.log('FILE TYPE:', image.type)
console.log('FILE SIZE BYTES:', image.size)
console.log(
  'FILE SIZE MB:',
  (image.size / 1024 / 1024).toFixed(2)
)
console.log(
  'MEDIA TYPE:',
  mediaType
)

    const fileName =
      `${Date.now()}-${Math.random()}.${
        fileExt || 'jpg'
      }`

    const filePath =
      `answers/${fileName}`

    const { error: uploadError } =
await supabase.storage
  .from('answer-media')
  .upload(filePath, image)

    if (uploadError) {
      throw uploadError
    }

const { data: publicUrlData } =
  supabase.storage
    .from('answer-media')
    .getPublicUrl(filePath)

    uploadedMedia.push({
  url: publicUrlData.publicUrl,
  type: mediaType,
})
    console.log(
  'IMAGE UPLOADED:',
  publicUrlData.publicUrl
)

  }
  
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
if (
  uploadedMedia.length > 0
) {
await supabase
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

images: uploadedMedia,
},
])

setAnswerText('')
setSelectedImages([])
    } catch (err) {
  console.error(
    'ANSWER ERROR:',
    err
  )

  alert(
    JSON.stringify(err)
  )

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
            Back to feed
          </button>

          <div className="xelay-card p-6 mb-8">
            <span className="text-xs font-medium px-2.5 py-1 bg-muted text-muted-foreground rounded-full uppercase tracking-wider">
              {question.category}
            </span>

            <h1 className="text-lg font-normal text-foreground mt-4 mb-6 leading-relaxed">
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
                  <p
  onClick={() =>
    navigate({
      to: '/user/$id',
      params: {
        id: String(question.user_id),
      },
    })
  }
  className="font-medium text-foreground text-sm cursor-pointer hover:underline"
>
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

              <div className="text-right">
  <div>
    {formatDistanceToNow(
      new Date(question.created_at),
      {
        addSuffix: true,
      }
    )}
  </div>

  <div className="text-xs">
    {question.views || 0} views
  </div>
</div>
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
              <div className="relative">
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
    ? `${selectedImages.length} file(s) selected`
    : 'Add photo or video'}
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
      const MAX_FILE_SIZE =
  50 * 1024 * 1024

for (const file of files) {
  if (file.size > MAX_FILE_SIZE) {
    alert(
      `${file.name} exceeds 50 MB`
    )
    return
  }
}

      const total =
        selectedImages.length +
        files.length

     if (total > 5) {
  alert('Maximum 5 files')
  return
}

      setSelectedImages(
        (prev) => [
          ...prev,
          ...files,
        ]
      )
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