import { FormEvent, useId, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Plus, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import { NEWS_TYPE_LABELS, NewsAttachment, NewsLink, NewsPostType, NewsScope, parseNewsDateTime, validateNewsLink, validateNewsLinks } from '../lib/news'
import { uploadNewsFiles, uploadNewsImage, removeNewsFiles, removeNewsImage, validateNewsFiles } from '../lib/newsMedia'
import { NewsAttachmentsPicker } from './NewsAttachmentsPicker'
import { NewsImagePicker } from './NewsImagePicker'
import { NewsLinksEditor } from './NewsLinksEditor'

type NewsField = 'title' | 'excerpt' | 'body' | 'organizer' | 'eventStartsAt' | 'registrationUrl'

function submissionErrorMessage(reason: unknown): string {
  if (reason instanceof Error && /^(Оберіть|Цей файл|Фото |Не вдалося завантажити фото|Увійдіть)/.test(reason.message)) return reason.message
  const code = typeof reason === 'object' && reason !== null && 'code' in reason ? String(reason.code) : ''
  if (code === '42501' || code === 'PGRST301') return 'Не вдалося надіслати пропозицію. Перевірте університет і факультет у профілі та увійдіть знову.'
  if (code === '23514') return 'Перевірте заголовок, текст і дані події та спробуйте ще раз.'
  return 'Не вдалося надіслати пропозицію. Перевірте з’єднання та спробуйте ще раз.'
}

export function NewsSubmissionForm({ scope = 'faculty' }: { scope?: NewsScope }) {
  const { authUser, xelayUser } = useAuth()
  const { notify } = useToast()
  const formRef = useRef<HTMLFormElement>(null)
  const submitLock = useRef(false)
  const errorId = useId()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<NewsPostType>('news')
  const [title, setTitle] = useState('')
  const [excerpt, setExcerpt] = useState('')
  const [body, setBody] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [links, setLinks] = useState<NewsLink[]>([])
  const [eventStartsAt, setEventStartsAt] = useState('')
  const [eventLocation, setEventLocation] = useState('')
  const [organizer, setOrganizer] = useState('')
  const [registrationUrl, setRegistrationUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [invalidField, setInvalidField] = useState<NewsField | null>(null)
  const feedbackId = `news-submission-${scope}`

  const validationError = (message: string, field?: NewsField) => {
    setError(message)
    setInvalidField(field || null)
    notify({ id: feedbackId, title: 'Перевірте пропозицію', description: message, tone: 'warning' })
    if (field) formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${field}"]`)?.focus()
  }
  const fieldProps = (name: NewsField) => ({ name, 'aria-invalid': invalidField === name || undefined, 'aria-describedby': invalidField === name ? errorId : undefined })
  const invalidClass = (name: NewsField) => invalidField === name ? 'xelay-field-invalid' : ''

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitLock.current) return
    if (!authUser?.id || !xelayUser?.universityId || (scope === 'faculty' && !xelayUser.academicUnitId)) {
      validationError('Спочатку збережіть університет і факультет у профілі.')
      return
    }
    if (title.trim().length < 3 || title.trim().length > 180) { validationError('Заголовок має містити від 3 до 180 символів.', 'title'); return }
    if (!excerpt.trim()) { validationError('Додайте короткий опис новини.', 'excerpt'); return }
    if (!body.trim()) { validationError('Додайте повний текст пропозиції.', 'body'); return }
    if (type === 'event' && !organizer.trim()) { validationError('Вкажіть організатора події.', 'organizer'); return }
    let nextLinks: NewsLink[]
    let eventDate: string | null = null
    let registrationLink: string | null = null
    try {
      nextLinks = validateNewsLinks(links)
      validateNewsFiles(files)
    } catch (validationReason) {
      validationError(validationReason instanceof Error ? validationReason.message : 'Перевірте файли та посилання.')
      return
    }
    if (type === 'event') {
      try { eventDate = parseNewsDateTime(eventStartsAt) }
      catch { validationError('Оберіть коректну дату й час події.', 'eventStartsAt'); return }
      try { registrationLink = validateNewsLink(registrationUrl) }
      catch { validationError('Вкажіть коректне посилання на реєстрацію з http:// або https://, до 2048 символів.', 'registrationUrl'); return }
    }
    submitLock.current = true
    setSubmitting(true)
    setError('')
    setInvalidField(null)
    let uploadedPath: string | null = null
    let uploadedFiles: NewsAttachment[] = []
    let committed = false
    let uploading = Boolean(imageFile || files.length)
    try {
      if (imageFile) uploadedPath = (await uploadNewsImage(authUser.id, imageFile)).path
      uploadedFiles = await uploadNewsFiles(authUser.id, files)
      uploading = false
      const { error: submitError } = await supabase.from('news_submissions').insert({
        user_id: authUser.id,
        university_id: xelayUser.universityId,
        academic_unit_id: scope === 'faculty' ? xelayUser.academicUnitId : null,
        post_type: type,
        title: title.trim(),
        excerpt: excerpt.trim(),
        body: body.trim(),
        image_url: null,
        ...(uploadedPath ? { image_path: uploadedPath } : {}),
        links: nextLinks,
        link_url: null,
        attachments: uploadedFiles,
        event_starts_at: eventDate,
        event_location: type === 'event' ? eventLocation.trim() || null : null,
        organizer: type === 'event' ? organizer.trim() || null : null,
        registration_url: registrationLink,
      })
      if (submitError) throw submitError
      committed = true
      setTitle('')
      setExcerpt('')
      setBody('')
      setImageFile(null)
      setFiles([])
      setLinks([])
      setEventStartsAt('')
      setEventLocation('')
      setOrganizer('')
      setRegistrationUrl('')
      setSubmitted(true)
      setOpen(false)
      notify({ id: feedbackId, title: 'Пропозицію надіслано', description: 'Редактор перевірить її перед публікацією.', tone: 'success' })
    } catch (submitError) {
      console.error('Could not submit official news suggestion:', submitError)
      if (!committed) {
        if (uploadedPath) await removeNewsImage(uploadedPath)
        await removeNewsFiles(uploadedFiles.map((file) => file.path))
      }
      const message = committed
        ? 'Пропозицію надіслано, але не вдалося оновити відображення. Оновіть сторінку.'
        : uploading && submitError instanceof Error ? submitError.message : submissionErrorMessage(submitError)
      setError(message)
      notify({ id: feedbackId, title: committed ? 'Пропозицію надіслано' : 'Пропозицію не надіслано', description: message, tone: committed ? 'warning' : 'error' })
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }
  }

  return (
    <section className="xelay-blue-panel mb-4 overflow-hidden rounded-2xl border border-border/50">
      <button type="button" disabled={submitting} aria-expanded={open} aria-controls="news-suggestion-form" onClick={() => { setOpen((value) => !value); setSubmitted(false) }} className="flex min-h-[92px] w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-card/10 disabled:opacity-60 sm:px-5">
        <span className="min-w-0"><span className="block text-sm font-semibold">Запропонувати новину</span><span className="mt-1.5 block max-w-xl text-[13px] leading-relaxed text-muted-foreground">{scope === 'university' ? 'Загальну новину перевірить редактор університету або адміністратор.' : 'Публікацію перевірить редактор вашого підрозділу або адміністратор.'}</span></span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-card/40 text-muted-foreground">{open ? <X size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}</span>
      </button>
      {submitted && !open && <p role="status" className="xelay-inline-feedback xelay-feedback-success flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-emerald-700"><CheckCircle2 size={16} aria-hidden="true" /> Пропозицію надіслано на модерацію.</p>}
      {open && <form ref={formRef} id="news-suggestion-form" aria-busy={submitting} onSubmit={(event) => void submit(event)} onChangeCapture={(event) => {
        if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && event.target.name === invalidField) { setInvalidField(null); setError('') }
      }} className="space-y-4 border-t border-border/60 bg-card p-4 sm:p-5">
        <fieldset disabled={submitting} className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
            <input {...fieldProps('title')} aria-label="Заголовок новини" value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={180} placeholder="Заголовок" className={`${invalidClass('title')} w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm`} />
            <select aria-label="Тип публікації" value={type} onChange={(event) => { setType(event.target.value as NewsPostType); setInvalidField(null); setError('') }} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm">
              {Object.entries(NEWS_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <textarea {...fieldProps('excerpt')} aria-label="Короткий опис новини" value={excerpt} onChange={(event) => setExcerpt(event.target.value)} required maxLength={500} rows={2} placeholder="Короткий опис для картки" className={`${invalidClass('excerpt')} w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm`} />
          <textarea {...fieldProps('body')} aria-label="Повний текст пропозиції" value={body} onChange={(event) => setBody(event.target.value)} required rows={6} placeholder="Повний текст пропозиції" className={`${invalidClass('body')} w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm`} />
          {type === 'event' && <div className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Дата й час<input {...fieldProps('eventStartsAt')} type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} required className={`${invalidClass('eventStartsAt')} mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal`} /></label>
            <label className="text-sm font-medium">Організатор<input {...fieldProps('organizer')} value={organizer} onChange={(event) => setOrganizer(event.target.value)} required maxLength={180} placeholder="Хто проводить подію" className={`${invalidClass('organizer')} mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal`} /></label>
            <label className="text-sm font-medium">Місце або формат<input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} maxLength={250} placeholder="Наприклад, онлайн або аудиторія" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Посилання на реєстрацію<input {...fieldProps('registrationUrl')} value={registrationUrl} onChange={(event) => setRegistrationUrl(event.target.value)} type="url" maxLength={2048} placeholder="https://…" className={`${invalidClass('registrationUrl')} mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal`} /></label>
          </div>}
          <NewsImagePicker file={imageFile} onChange={setImageFile} disabled={submitting} />
          <NewsAttachmentsPicker files={files} onChange={(nextFiles) => { setFiles(nextFiles); setError('') }} disabled={submitting} />
          <NewsLinksEditor links={links} onChange={(nextLinks) => { setLinks(nextLinks); setError('') }} disabled={submitting} />
          {error && <p id={errorId} role="alert" className="xelay-inline-feedback xelay-feedback-error text-sm text-destructive">{error}</p>}
          <button type="submit" disabled={submitting} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 sm:w-auto">{submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} <span role={submitting ? 'status' : undefined}>{submitting ? 'Надсилаємо…' : 'Надіслати на модерацію'}</span></button>
        </fieldset>
      </form>}
    </section>
  )
}
