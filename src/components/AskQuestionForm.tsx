import { useState, useRef } from 'react'
import {
  ArrowRight,
  Paperclip,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { Question, CATEGORIES } from '../types'
import { AuthModal } from './AuthModal'

interface AskQuestionFormProps {
  lockedCategory?: string
  onPosted?: (question: Question) => void
}

export function AskQuestionForm({
  lockedCategory,
  onPosted,
}: AskQuestionFormProps) {
  const { isAuthenticated, authUser, xelayUser } = useAuth()

  const [questionText, setQuestionText] = useState('')
  const [category, setCategory] = useState<string>(
    lockedCategory ?? CATEGORIES[0]
  )

  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [selectedImages, setSelectedImages] =
  useState<File[]>([])

const fileInputRef =
  useRef<HTMLInputElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    setError('')

    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }

    if (
  !questionText.trim() &&
  selectedImages.length === 0
) {
  return
}

    if (!xelayUser || !authUser) {
      setShowAuthModal(true)
      return
    }

    setSubmitting(true)

    try {let uploadedImageUrls: string[] = []

for (const image of selectedImages) {
  const fileExt =
    image.name.split('.').pop()

  const filePath =
    `questions/${Date.now()}-${Math.random()}.${fileExt}`

  const { error: uploadError } =
    await supabase.storage
      .from('answer-media')
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
    .from('answer-media')
    .getPublicUrl(filePath)

  uploadedImageUrls.push(
    publicUrlData.publicUrl
  )
}
      const payload = {
        user_id: authUser.id,
        title: questionText.trim(),
        content: questionText.trim(),
        category: lockedCategory ?? category,
        created_at: new Date().toISOString(),
      }

      const { data, error } = await supabase
        .from('questions')
        .insert(payload)
        .select()
        .single()

      if (error) {
        throw error
      }
if (
  uploadedImageUrls.length > 0
) {
  const { error: imageError } =
    await supabase
      .from('question_images')
      .insert(
        uploadedImageUrls.map(
          (url) => ({
            question_id: data.id,
            image_url: url,
          })
        )
      )

  if (imageError) {
    console.error(
      imageError
    )
  }
}
setQuestionText('')

setSelectedImages([])

if (fileInputRef.current) {
  fileInputRef.current.value = ''
}

setSuccess(true)

      setTimeout(() => {
        setSuccess(false)
      }, 3000)

      onPosted?.({
  ...(data as Question),
  images: uploadedImageUrls,
} as Question)
    } catch (err) {
      console.error('[Xelay] Ask error:', err)

      setError('Failed to post question. Please try again.')

      setTimeout(() => {
        setError('')
      }, 4000)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {showAuthModal && (
        <AuthModal onClose={() => setShowAuthModal(false)} />
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
       <div className="relative">
  <textarea
    ref={textareaRef}
    value={questionText}
    onChange={(e) =>
      setQuestionText(
        e.target.value
      )
    }
    placeholder={
      isAuthenticated
        ? lockedCategory
          ? `Ask a question in ${lockedCategory}...`
          : 'Ask your question...'
        : 'Sign in to ask a question'
    }
    rows={3}
    disabled={!isAuthenticated}
    className="w-full px-4 py-3.5 pr-12 border border-border rounded-xl bg-background text-foreground text-sm resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors disabled:opacity-60"
  />


  <input
    ref={fileInputRef}
    type="file"
    multiple
    accept="image/*,video/*"
    className="hidden"
    onChange={(e) => {
      if (!e.target.files)
        return

      setSelectedImages(
        Array.from(
          e.target.files
        )
      )
    }}
  />
</div>
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
{selectedImages.length > 0 && (
  <div className="flex flex-wrap gap-2">
    {selectedImages.map(
      (image, index) => (
        <div
          key={index}
          className="relative"
        >
          {image.type.startsWith('video/') ? (
  <video
    src={URL.createObjectURL(image)}
    className="w-24 h-24 object-cover rounded-lg border border-border"
  />
) : (
  <img
    src={URL.createObjectURL(image)}
    alt=""
    className="w-24 h-24 object-cover rounded-lg border border-border"
  />
)}

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
            ×
          </button>
        </div>
      )
    )}
  </div>
)}
        <div className="flex items-center gap-3">
          {!lockedCategory && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors cursor-pointer"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          )}

          <button
            type="submit"
            disabled={
  submitting ||
  (
    !questionText.trim() &&
    selectedImages.length === 0
  ) ||
  !isAuthenticated
}
            onClick={
              !isAuthenticated
                ? () => setShowAuthModal(true)
                : undefined
            }
            className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-lg hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap text-sm xelay-btn"
          >
            {submitting ? (
              <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
            ) : (
              <>
                Ask <ArrowRight size={14} />
              </>
            )}
          </button>

          {!isAuthenticated && (
            <button
              type="button"
              onClick={() => setShowAuthModal(true)}
              className="text-sm text-foreground underline hover:text-muted-foreground transition-colors whitespace-nowrap"
            >
              Sign in
            </button>
          )}
        </div>

        {success && (
          <p className="text-sm text-foreground font-medium animate-fade-in">
            ✓ Question posted!
          </p>
        )}

        {error && (
          <p className="text-sm text-destructive animate-fade-in">
            {error}
          </p>
        )}
      </form>
    </>
  )
}