import { useEffect, useState, useRef } from 'react'
import {
  ArrowRight,
  Paperclip,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { Question, CATEGORIES, categoryToSlug, slugToCategory } from '../types'
import { AuthModal } from './AuthModal'
import { categoryLabel } from '../translations/categories'

interface AskQuestionFormProps {
  lockedCategory?: string
  onPosted?: (question: Question) => void
}

export function AskQuestionForm({
  lockedCategory,
  onPosted,
}: AskQuestionFormProps) {
  const { isAuthenticated, authUser, xelayUser } = useAuth()
  const { notify, dismiss } = useToast()

  const [questionText, setQuestionText] = useState('')
  const [category, setCategory] = useState<string>(
    lockedCategory ?? ''
  )
  const selectedCategory = lockedCategory ?? category

  const [submitting, setSubmitting] = useState(false)
  const postingRef = useRef(false)
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')
  const [successNotice, setSuccessNotice] = useState('Запитання опубліковано!')
  const [invalidField, setInvalidField] = useState<'question' | 'category' | null>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const categoryRef = useRef<HTMLSelectElement>(null)

  const [selectedImages, setSelectedImages] =
  useState<File[]>([])

const fileInputRef =
  useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (successTimer.current) clearTimeout(successTimer.current) }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (postingRef.current) return
    if (successTimer.current) clearTimeout(successTimer.current)

    setError('')
    setSuccess(false)
    setInvalidField(null)
    dismiss('ask-question-feedback')

    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }

    if (
  !questionText.trim() &&
  selectedImages.length === 0
) {
  const message = 'Напишіть запитання або додайте фото чи відео.'
  setError(message)
  setInvalidField('question')
  textareaRef.current?.focus()
  notify({ id: 'ask-question-feedback', tone: 'warning', title: 'Додайте запитання', description: message })
  return
}

    if (!xelayUser || !authUser) {
      setShowAuthModal(true)
      return
    }

    const validCategory = lockedCategory
      ? slugToCategory(categoryToSlug(lockedCategory)) === lockedCategory
      : CATEGORIES.some((topic) => topic === selectedCategory)
    if (!validCategory) {
      setError('Оберіть категорію для запитання.')
      setInvalidField('category')
      categoryRef.current?.focus()
      notify({ id: 'ask-question-feedback', tone: 'warning', title: 'Оберіть категорію', description: 'Запитання буде опубліковано в обраній темі.' })
      return
    }

    postingRef.current = true
    setSubmitting(true)

    try {let uploadedImageUrls: string[] = []
      let attachmentFailed = false

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
        category: selectedCategory,
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
    attachmentFailed = true
    console.error(
      imageError
    )
  }
}
setQuestionText('')
if (!lockedCategory) setCategory('')

setSelectedImages([])

if (fileInputRef.current) {
  fileInputRef.current.value = ''
}

setSuccess(true)
setSuccessNotice(attachmentFailed ? 'Запитання опубліковано, але вкладення не збереглися.' : 'Запитання опубліковано!')
notify({ id: 'ask-question-feedback', tone: attachmentFailed ? 'warning' : 'success', title: attachmentFailed ? 'Запитання опубліковано без вкладень' : 'Запитання опубліковано', description: attachmentFailed ? 'Не вдалося додати вибрані файли.' : undefined })

      successTimer.current = setTimeout(() => {
        setSuccess(false)
      }, attachmentFailed ? 7000 : 3000)

      try { onPosted?.({
  ...(data as Question),
  images: attachmentFailed ? [] : uploadedImageUrls,
} as Question) } catch (refreshError) {
        console.error('[Xelay] Could not refresh the question list:', refreshError)
      }
    } catch (err) {
      console.error('[Xelay] Ask error:', err)

      setError('Не вдалося опублікувати запитання. Спробуйте ще раз.')
      notify({ id: 'ask-question-feedback', tone: 'error', title: 'Запитання не опубліковано', description: 'Ваш текст і файли залишилися у формі. Спробуйте ще раз.' })
    } finally {
      postingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <>
      {showAuthModal && (
        <AuthModal onClose={() => setShowAuthModal(false)} />
      )}

      <form onSubmit={handleSubmit} aria-busy={submitting} onChange={() => { setError(''); setInvalidField(null); setSuccess(false) }} className="space-y-3">
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
          ? `Поставте запитання у темі «${categoryLabel(lockedCategory)}»...`
          : 'Напишіть своє запитання...'
        : 'Увійдіть, щоб поставити запитання'
    }
    rows={3}
    disabled={!isAuthenticated || submitting}
    aria-label="Текст запитання"
    aria-invalid={invalidField === 'question' || undefined}
    className={`w-full px-4 py-3.5 pr-12 border border-border rounded-xl bg-background text-foreground text-sm resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors disabled:opacity-60 ${invalidField === 'question' ? 'xelay-field-invalid' : ''}`}
  />


  <input
    ref={fileInputRef}
    type="file"
    multiple
    disabled={submitting}
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
  disabled={submitting}
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
<p className="text-xs text-muted-foreground">
  Натисніть, щоб додати фото чи відео.
</p>
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
            disabled={submitting}
            aria-label={`Прибрати файл ${image.name}`}
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
        <div className="flex flex-wrap items-center gap-3">
          {!lockedCategory && (
            <select
              ref={categoryRef}
              value={category}
              aria-required="true"
              aria-label="Категорія запитання"
              aria-invalid={invalidField === 'category' || undefined}
              disabled={submitting}
              onChange={(e) => setCategory(e.target.value)}
              className={`flex-1 min-w-0 px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors cursor-pointer ${invalidField === 'category' ? 'xelay-field-invalid' : ''}`}
            >
              <option value="" disabled>Оберіть категорію</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {categoryLabel(cat)}
                </option>
              ))}
            </select>
          )}

          <button
            type="submit"
            disabled={submitting || !isAuthenticated}
            onClick={
              !isAuthenticated
                ? () => setShowAuthModal(true)
                : undefined
            }
            className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap text-sm xelay-btn"
          >
            {submitting ? (
              <><span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" aria-hidden="true" />Публікуємо…</>
            ) : (
              <>
                Запитати <ArrowRight size={14} />
              </>
            )}
          </button>

          {!isAuthenticated && (
            <button
              type="button"
              onClick={() => setShowAuthModal(true)}
              className="text-sm text-foreground underline hover:text-muted-foreground transition-colors whitespace-nowrap"
            >
              Увійти
            </button>
          )}
        </div>

        {isAuthenticated && !submitting && ((!questionText.trim() && selectedImages.length === 0) || !selectedCategory) && <p className="text-xs text-muted-foreground">{!questionText.trim() && selectedImages.length === 0 ? 'Напишіть запитання або додайте файл.' : 'Оберіть категорію, щоб опублікувати запитання.'}</p>}

        {success && (
          <p role="status" className="xelay-inline-feedback xelay-feedback-success text-sm font-medium">
            {successNotice}
          </p>
        )}

        {error && (
          <p role="alert" className="xelay-inline-feedback xelay-feedback-error text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </>
  )
}
