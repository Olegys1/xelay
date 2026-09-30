import { FormEvent, useState } from 'react'
import { CheckCircle2, Loader2, Plus, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { NEWS_TYPE_LABELS, NewsPostType, validateNewsLink } from '../lib/news'
import { uploadNewsImage, removeNewsImage } from '../lib/newsMedia'
import { NewsImagePicker } from './NewsImagePicker'

export function NewsSubmissionForm() {
  const { authUser, xelayUser } = useAuth()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<NewsPostType>('news')
  const [title, setTitle] = useState('')
  const [excerpt, setExcerpt] = useState('')
  const [body, setBody] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [eventStartsAt, setEventStartsAt] = useState('')
  const [eventLocation, setEventLocation] = useState('')
  const [organizer, setOrganizer] = useState('')
  const [registrationUrl, setRegistrationUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    if (!authUser?.id || !xelayUser?.universityId || !xelayUser.academicUnitId) {
      setError('Спочатку збережіть університет і факультет у профілі.')
      return
    }
    setSubmitting(true)
    setError('')
    let uploadedPath: string | null = null
    try {
      const resourceUrl = validateNewsLink(linkUrl)
      if (imageFile) uploadedPath = (await uploadNewsImage(authUser.id, imageFile)).path
      const { error: submitError } = await supabase.from('news_submissions').insert({
        user_id: authUser.id,
        university_id: xelayUser.universityId,
        academic_unit_id: xelayUser.academicUnitId,
        post_type: type,
        title: title.trim(),
        excerpt: excerpt.trim(),
        body: body.trim(),
        image_url: null,
        ...(uploadedPath ? { image_path: uploadedPath } : {}),
        ...(resourceUrl ? { link_url: resourceUrl } : {}),
        event_starts_at: type === 'event' && eventStartsAt ? new Date(eventStartsAt).toISOString() : null,
        event_location: type === 'event' ? eventLocation.trim() || null : null,
        organizer: type === 'event' ? organizer.trim() || null : null,
        registration_url: type === 'event' ? registrationUrl.trim() || null : null,
      })
      if (submitError) throw submitError
      setTitle('')
      setExcerpt('')
      setBody('')
      setImageFile(null)
      setLinkUrl('')
      setEventStartsAt('')
      setEventLocation('')
      setOrganizer('')
      setRegistrationUrl('')
      setSubmitted(true)
      setOpen(false)
    } catch (submitError) {
      console.error('Could not submit official news suggestion:', submitError)
      if (uploadedPath) await removeNewsImage(uploadedPath)
      setError(submitError instanceof Error ? submitError.message : 'Не вдалося надіслати пропозицію. Перевірте поля й налаштування новин у Supabase.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="xelay-card mb-5 overflow-hidden">
      <button type="button" disabled={submitting} onClick={() => { setOpen((value) => !value); setSubmitted(false) }} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
        <span><span className="block font-semibold">Запропонувати новину</span><span className="mt-0.5 block text-xs text-muted-foreground">Публікацію перевірить адміністратор вашого підрозділу.</span></span>
        {open ? <X size={19} /> : <Plus size={19} />}
      </button>
      {submitted && !open && <p role="status" className="flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-emerald-700"><CheckCircle2 size={16} /> Пропозицію надіслано на модерацію.</p>}
      {open && <form onSubmit={(event) => void submit(event)} className="space-y-4 border-t border-border p-5">
        <fieldset disabled={submitting} className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
            <input value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={180} placeholder="Заголовок" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
            <select value={type} onChange={(event) => setType(event.target.value as NewsPostType)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm">
              {Object.entries(NEWS_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <textarea value={excerpt} onChange={(event) => setExcerpt(event.target.value)} required maxLength={500} rows={2} placeholder="Короткий опис для картки" className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
          <textarea value={body} onChange={(event) => setBody(event.target.value)} required rows={6} placeholder="Повний текст пропозиції" className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
          {type === 'event' && <div className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Дата й час<input type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Організатор<input value={organizer} onChange={(event) => setOrganizer(event.target.value)} required maxLength={180} placeholder="Хто проводить подію" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Місце або формат<input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} maxLength={250} placeholder="Наприклад, онлайн або аудиторія" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Посилання на реєстрацію<input value={registrationUrl} onChange={(event) => setRegistrationUrl(event.target.value)} type="url" placeholder="https://…" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
          </div>}
          <NewsImagePicker file={imageFile} onChange={setImageFile} disabled={submitting} />
          <label className="block text-sm font-medium">Посилання на відео або матеріали
            <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} type="url" maxLength={2048} placeholder="https://… (необов’язково)" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            <span className="mt-1.5 block text-xs font-normal text-muted-foreground">Відкриватиметься окремим посиланням у публікації.</span>
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button type="submit" disabled={submitting} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background disabled:opacity-50">{submitting && <Loader2 size={16} className="animate-spin" />} {submitting ? 'Надсилаємо…' : 'Надіслати на модерацію'}</button>
        </fieldset>
      </form>}
    </section>
  )
}
