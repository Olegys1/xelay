import { FormEvent, useRef, useState } from 'react'
import { Loader2, Save, Trash2, Undo2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  NEWS_TYPE_LABELS,
  NewsAttachment,
  NewsLink,
  NewsPost,
  NewsPostType,
  getNewsAttachments,
  getNewsLinks,
  parseNewsDateTime,
  toNewsDateTimeInput,
  validateNewsLink,
  validateNewsLinks,
} from '../lib/news'
import { removeNewsFiles, removeNewsImage, uploadNewsFiles, uploadNewsImage, validateNewsFiles } from '../lib/newsMedia'
import { NewsAttachmentsPicker } from './NewsAttachmentsPicker'
import { NewsImage } from './NewsImage'
import { NewsImagePicker } from './NewsImagePicker'
import { NewsLinksEditor } from './NewsLinksEditor'

type NewsEditorProps = {
  post: NewsPost
  userId: string
  onSaved: (post: NewsPost) => void
  onCancel: () => void
}

export function NewsEditor({ post, userId, onSaved, onCancel }: NewsEditorProps) {
  const [title, setTitle] = useState(post.title)
  const [excerpt, setExcerpt] = useState(post.excerpt)
  const [body, setBody] = useState(post.body)
  const [type, setType] = useState<NewsPostType>(post.post_type)
  const [publishedAt, setPublishedAt] = useState(() => toNewsDateTimeInput(post.published_at))
  const [links, setLinks] = useState<NewsLink[]>(() => getNewsLinks(post))
  const [attachments, setAttachments] = useState<NewsAttachment[]>(() => getNewsAttachments(post.attachments))
  const [files, setFiles] = useState<File[]>([])
  const [eventStartsAt, setEventStartsAt] = useState(() => post.event_starts_at ? toNewsDateTimeInput(post.event_starts_at) : '')
  const [organizer, setOrganizer] = useState(post.organizer || '')
  const [eventLocation, setEventLocation] = useState(post.event_location || '')
  const [registrationUrl, setRegistrationUrl] = useState(post.registration_url || '')
  const [pinned, setPinned] = useState(post.is_pinned)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)

  const hasCurrentImage = Boolean(post.image_path || post.image_url)

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || savingRef.current) return
    setError('')

    let changes: Partial<NewsPost>
    try {
      if (!userId) throw new Error('Увійдіть в обліковий запис, щоб редагувати новину.')
      const nextTitle = title.trim()
      const nextExcerpt = excerpt.trim()
      const nextBody = body.trim()
      const nextOrganizer = organizer.trim()
      const nextLocation = eventLocation.trim()
      if (nextTitle.length < 3 || nextTitle.length > 180) {
        throw new Error('Заголовок має містити від 3 до 180 символів.')
      }
      if (!nextExcerpt || nextExcerpt.length > 500) {
        throw new Error('Короткий опис має містити від 1 до 500 символів.')
      }
      if (!nextBody) throw new Error('Додайте повний текст публікації.')
      if (type === 'event' && (!nextOrganizer || nextOrganizer.length > 180)) {
        throw new Error('Вкажіть організатора події — до 180 символів.')
      }
      if (type === 'event' && nextLocation.length > 250) {
        throw new Error('Місце або формат події має містити не більше 250 символів.')
      }
      const parsedPublishedAt = parseNewsDateTime(publishedAt)
      const parsedEventStartsAt = type === 'event' ? parseNewsDateTime(eventStartsAt) : null
      const nextLinks = validateNewsLinks(links)
      validateNewsFiles(files, attachments)

      changes = {
        post_type: type,
        title: nextTitle,
        excerpt: nextExcerpt,
        body: nextBody,
        published_at: publishedAt === toNewsDateTimeInput(post.published_at) ? post.published_at : parsedPublishedAt,
        links: nextLinks,
        link_url: null,
        attachments,
        is_pinned: pinned,
        event_starts_at: type === 'event' && post.event_starts_at && eventStartsAt === toNewsDateTimeInput(post.event_starts_at)
          ? post.event_starts_at
          : parsedEventStartsAt,
        organizer: type === 'event' ? nextOrganizer : null,
        event_location: type === 'event' ? nextLocation || null : null,
        registration_url: validateNewsLink(type === 'event' ? registrationUrl : ''),
      }
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Перевірте обов’язкові поля та посилання.')
      return
    }

    savingRef.current = true
    setSaving(true)
    let uploadedPath: string | null = null
    let uploadedFiles: NewsAttachment[] = []
    let committed = false
    let uploading = Boolean(imageFile || files.length)
    try {
      if (imageFile) {
        uploadedPath = (await uploadNewsImage(userId, imageFile)).path
        changes.image_path = uploadedPath
        changes.image_url = null
      } else if (removeImage) {
        changes.image_path = null
        changes.image_url = null
      }
      uploadedFiles = await uploadNewsFiles(userId, files)
      changes.attachments = [...attachments, ...uploadedFiles]
      uploading = false

      const { data, error: saveError } = await supabase.rpc('xelay_update_news_post', {
        p_post_id: post.id,
        p_changes: changes,
      })
      if (saveError) throw saveError
      committed = true
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== post.id) {
        throw new Error('News update returned an unexpected row.')
      }

      const photoChanged = Boolean(uploadedPath) || removeImage
      if (photoChanged && post.image_path?.startsWith(`${userId}/`) && post.image_path !== data.image_path) {
        await removeNewsImage(post.image_path)
      }
      const savedPaths = new Set(getNewsAttachments(data.attachments).map((file) => file.path))
      const removedPaths = getNewsAttachments(post.attachments)
        .filter((file) => file.path.startsWith(`${userId}/`) && !savedPaths.has(file.path))
        .map((file) => file.path)
      await removeNewsFiles(removedPaths)
      onSaved(data as NewsPost)
    } catch (saveError) {
      console.error('Could not save edited news post:', saveError)
      if (!committed) {
        if (uploadedPath) await removeNewsImage(uploadedPath)
        await removeNewsFiles(uploadedFiles.map((file) => file.path))
      }
      setError(committed
        ? 'Зміни збережено, але не вдалося оновити відображення новини. Оновіть сторінку.'
        : uploading && saveError instanceof Error
          ? saveError.message
          : 'Не вдалося зберегти новину. Перевірте права редактора й спробуйте ще раз.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <section className="xelay-card min-w-0 overflow-hidden">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold">Редагувати новину</h2>
      </div>
      <form onSubmit={(event) => void save(event)} className="p-5 sm:p-6">
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
            <label className="min-w-0 text-sm font-medium">Заголовок
              <input value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={180} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            </label>
            <label className="text-sm font-medium">Тип публікації
              <select value={type} onChange={(event) => setType(event.target.value as NewsPostType)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal">
                {Object.entries(NEWS_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <label className="block text-sm font-medium">Дата й час публікації
            <input type="datetime-local" value={publishedAt} onInput={(event) => setPublishedAt(event.currentTarget.value)} onChange={(event) => setPublishedAt(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            <span className="mt-1.5 block text-xs font-normal text-muted-foreground">Дата впливає на порядок у стрічці; публікація залишається доступною одразу.</span>
          </label>
          <label className="block text-sm font-medium">Короткий опис
            <textarea value={excerpt} onChange={(event) => setExcerpt(event.target.value)} required minLength={1} maxLength={500} rows={2} className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
          </label>
          <label className="block text-sm font-medium">Повний текст публікації
            <textarea value={body} onChange={(event) => setBody(event.target.value)} required minLength={1} rows={7} className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
          </label>

          {type === 'event' && <div className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Дата й час події
              <input type="datetime-local" value={eventStartsAt} onInput={(event) => setEventStartsAt(event.currentTarget.value)} onChange={(event) => setEventStartsAt(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            </label>
            <label className="text-sm font-medium">Організатор
              <input value={organizer} onChange={(event) => setOrganizer(event.target.value)} required maxLength={180} placeholder="Хто проводить подію" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            </label>
            <label className="text-sm font-medium">Місце або формат
              <input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} maxLength={250} placeholder="Наприклад, онлайн або аудиторія" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            </label>
            <label className="text-sm font-medium">Посилання на реєстрацію <span className="font-normal text-muted-foreground">(необов’язково)</span>
              <input type="url" value={registrationUrl} onChange={(event) => setRegistrationUrl(event.target.value)} maxLength={2048} placeholder="https://…" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
            </label>
          </div>}

          {hasCurrentImage && !removeImage && !imageFile && <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium">Поточне фото</p>
            <NewsImage imagePath={post.image_path} imageUrl={post.image_url} alt="Поточне фото новини" className="block max-h-64 w-auto max-w-full rounded-xl border border-border object-contain" />
            <button type="button" onClick={() => setRemoveImage(true)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
              <Trash2 size={16} aria-hidden="true" /> Видалити поточне фото
            </button>
          </div>}
          {removeImage && !imageFile && <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm">
            <p className="min-w-0 flex-1">Фото буде видалено після збереження.</p>
            <button type="button" onClick={() => setRemoveImage(false)} className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 py-2 font-medium hover:bg-background">
              <Undo2 size={15} aria-hidden="true" /> Повернути фото
            </button>
          </div>}
          <NewsImagePicker file={imageFile} onChange={(file) => { setImageFile(file); if (file) setRemoveImage(false) }} disabled={saving} />
          <NewsAttachmentsPicker files={files} onChange={setFiles} existing={attachments} onRemoveExisting={(path) => setAttachments((current) => current.filter((file) => file.path !== path))} disabled={saving} />
          <NewsLinksEditor links={links} onChange={setLinks} disabled={saving} />
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Закріпити публікацію
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={saving} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {saving ? 'Зберігаємо…' : 'Зберегти зміни'}
            </button>
            <button type="button" onClick={onCancel} disabled={saving} className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-5 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Скасувати</button>
          </div>
        </fieldset>
      </form>
    </section>
  )
}
