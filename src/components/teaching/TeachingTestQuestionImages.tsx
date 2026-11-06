import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import type { TeachingTestQuestionImage } from '../../lib/teachingTests'
import {
  loadTeachingTestQuestionImage, MAX_TEST_QUESTION_IMAGE_ALT, MAX_TEST_QUESTION_IMAGES, readableTeachingTestQuestionImages,
  prepareTeachingTestImage, uploadTeachingTestQuestionImage,
} from '../../lib/teachingTestQuestionImages'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

function QuestionImage({ image, eager = false, compact = false }: { image: TeachingTestQuestionImage; eager?: boolean; compact?: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(eager)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (eager || !element.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, { rootMargin: '120px' })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [eager])

  useEffect(() => {
    if (!visible) return
    const request = new AbortController()
    void loadTeachingTestQuestionImage(image.id, request.signal).then(
      value => { if (!request.signal.aborted) setUrl(value) },
      () => { if (!request.signal.aborted) setFailed(true) },
    )
    return () => request.abort()
  }, [image.id, retry, visible])

  return <div ref={element} className="overflow-hidden rounded-xl border border-border bg-background p-2">
    {failed
      ? <div className="flex flex-wrap items-center gap-2 p-2 text-sm text-muted-foreground">
        <span>Зображення недоступне.</span>
        <TeachingButton onClick={() => { setFailed(false); setUrl(''); setRetry(value => value + 1) }}>Спробувати ще раз</TeachingButton>
      </div>
      : url
        ? <img src={url} alt={image.alt || (compact ? 'Зображення варіанта відповіді' : 'Зображення до запитання')} draggable={false} decoding="async"
          className={`mx-auto max-w-full object-contain ${compact ? 'max-h-44' : 'max-h-[32rem]'}`} onError={() => setFailed(true)} />
        : <p className="p-2 text-sm text-muted-foreground" role="status">Завантажуємо зображення…</p>}
  </div>
}

export function TeachingTestQuestionImages({ images, eager = false, compact = false }: { images?: TeachingTestQuestionImage[]; eager?: boolean; compact?: boolean }) {
  const visible = readableTeachingTestQuestionImages(images)
  if (!visible.length) return null
  return <div className={compact ? 'my-1 grid gap-2' : 'my-3 grid gap-3'}>{visible.map(image => <QuestionImage key={image.id} image={image} eager={eager} compact={compact} />)}</div>
}

export function TeachingTestQuestionImageEditor({ images: sourceImages, imageUpload, onChange, onBusyChange, canStartUpload, option, capacityReached = false, children }: {
  images?: TeachingTestQuestionImage[]
  imageUpload?: { courseId: string; userId: string }
  onChange: (images: TeachingTestQuestionImage[]) => void
  onBusyChange?: (busy: boolean) => void
  canStartUpload?: () => boolean
  option?: number
  capacityReached?: boolean
  children?: (onImagePaste?: (files: File[]) => void) => ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  const upload = useRef<AbortController | null>(null)
  const encodings = useRef(new Map<string, string>())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const images = readableTeachingTestQuestionImages(sourceImages)
  const limit = option ? 1 : MAX_TEST_QUESTION_IMAGES
  useEffect(() => () => upload.current?.abort(), [])

  async function addImages(files: File[]) {
    if (!imageUpload || upload.current || !files.length || canStartUpload?.() === false) return
    const limitMessage = option ? 'До варіанта відповіді можна додати одне фото.' : `До запитання можна додати до ${limit} зображень.`
    if (files.length > limit) {
      setError(limitMessage)
      return
    }
    const request = new AbortController()
    upload.current = request
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    const next = [...images]
    try {
      const existing = await Promise.all(images.map(async image => {
        const cached = encodings.current.get(image.id)
        if (cached) return cached
        const url = await loadTeachingTestQuestionImage(image.id, request.signal)
        const encoded = url.slice(url.indexOf(',') + 1)
        encodings.current.set(image.id, encoded)
        return encoded
      }))
      const additions = new Set<string>()
      for (const file of files) {
        request.signal.throwIfAborted()
        const encoded = await prepareTeachingTestImage(file)
        if (!existing.includes(encoded)) additions.add(encoded)
      }
      if (images.length + additions.size > limit) throw new Error(limitMessage)
      if (!additions.size) {
        if (!request.signal.aborted) setError(option ? 'Це фото вже додано до варіанта.' : 'Це фото вже додано до запитання.')
        return
      }
      if (capacityReached) throw new Error('До варіантів одного запитання можна додати до 12 фото.')
      for (const encoded of additions) {
        const image = await uploadTeachingTestQuestionImage(imageUpload.courseId, imageUpload.userId, encoded, request.signal)
        if (request.signal.aborted) return
        encodings.current.set(image.id, encoded)
        next.push(image)
        onChange([...next])
      }
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : 'Не вдалося додати зображення.')
    } finally {
      upload.current = null
      if (!request.signal.aborted) setBusy(false)
      onBusyChange?.(false)
    }
  }

  if (!imageUpload && !images.length) return children?.() ?? null
  return <div className={option ? 'teaching-test-option-image-editor' : 'teaching-test-section'}>
    {children?.(imageUpload ? files => void addImages(files) : undefined)}
    {!option && <h3>Зображення до запитання</h3>}
    {images.map((image, index) => <div key={image.id} className="rounded-xl border border-border p-3">
      <QuestionImage image={image} compact={Boolean(option)} />
      <div className="mt-2 flex items-end gap-2">
        <div className="min-w-0 flex-1"><TeachingField label={option ? `Опис фото варіанта ${option}, необов’язково` : `Опис зображення ${index + 1}, необов’язково`}>
          <input className={teachingInput} maxLength={MAX_TEST_QUESTION_IMAGE_ALT} value={image.alt} disabled={busy}
            onChange={event => onChange(images.map(item => item.id === image.id ? { ...item, alt: event.target.value } : item))} />
        </TeachingField></div>
        <button type="button" className="teaching-icon-button" disabled={busy} aria-label={option ? `Видалити фото варіанта ${option}` : `Видалити зображення ${index + 1}`}
          onClick={() => { encodings.current.delete(image.id); onChange(images.filter(item => item.id !== image.id)) }}><Trash2 size={16} /></button>
      </div>
    </div>)}
    {imageUpload && <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple={!option} hidden
        onChange={event => {
          const files = Array.from(event.currentTarget.files || [])
          event.currentTarget.value = ''
          void addImages(files)
        }} />
      <div className="teaching-test-actions">
        <TeachingButton busy={busy} disabled={images.length >= limit || capacityReached} onClick={() => input.current?.click()}>
          <ImagePlus size={16} aria-hidden="true" />{option ? `Фото варіанта ${option}` : 'Додати фото'}
        </TeachingButton>
        {!option && <span className="text-xs text-muted-foreground">До 3 зображень JPG, PNG або WebP, до 12 МБ кожне.</span>}
      </div>
    </>}
    {error && <p className="teaching-error" role="alert">{error}</p>}
  </div>
}
