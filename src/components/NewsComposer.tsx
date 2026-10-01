import { FormEvent, useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getUniversityNewsLabel, NEWS_TYPE_LABELS, NewsPostType, NewsScope, validateNewsLink } from '../lib/news'
import { uploadNewsImage, removeNewsImage } from '../lib/newsMedia'
import { NewsImagePicker } from './NewsImagePicker'

type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string }

export function NewsComposer({
  userId,
  isPlatformAdmin,
  universityId,
  academicUnitId,
  editorUnitIds = [],
  editorUniversityIds = [],
  scope,
  onPublished,
}: {
  userId: string
  isPlatformAdmin: boolean
  universityId?: string | null
  academicUnitId?: string | null
  editorUnitIds?: string[]
  editorUniversityIds?: string[]
  scope?: NewsScope
  onPublished: () => void
}) {
  const [open, setOpen] = useState(false)
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [units, setUnits] = useState<AcademicUnitOption[]>([])
  const [selectedUniversityId, setSelectedUniversityId] = useState(universityId || '')
  const [selectedUnitId, setSelectedUnitId] = useState(academicUnitId || '')
  const [selectedScope, setSelectedScope] = useState<NewsScope>(scope || 'faculty')
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
  const [pinned, setPinned] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [universityResult, unitResult] = await Promise.all([
        supabase.from('universities').select('id, name, slug').eq('is_active', true).order('name'),
        supabase.from('academic_units').select('id, university_id, name').eq('is_active', true).order('name'),
      ])
      if (cancelled) return
      if (universityResult.error || unitResult.error) {
        setError('Не вдалося завантажити підрозділи для публікації.')
      } else {
        const nextUniversities = (universityResult.data || []) as UniversityOption[]
        const nextUnits = (unitResult.data || []) as AcademicUnitOption[]
        setUniversities(nextUniversities)
        setUnits(nextUnits)
        if (isPlatformAdmin && !universityId) {
          const defaultUniversityId = nextUniversities[0]?.id || ''
          setSelectedUniversityId(defaultUniversityId)
          setSelectedUnitId(nextUnits.find((unit) => unit.university_id === defaultUniversityId)?.id || '')
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [isPlatformAdmin, universityId])

  useEffect(() => {
    if (scope) setSelectedScope(scope)
  }, [scope])

  const availableUnits = units.filter((unit) =>
    unit.university_id === selectedUniversityId && (isPlatformAdmin || editorUnitIds.includes(unit.id))
  )

  const publish = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    if (!userId || !selectedUniversityId || (selectedScope === 'faculty' && !selectedUnitId)) {
      setError('Оберіть університет і, для новин факультету, підрозділ для публікації.')
      return
    }
    setSaving(true)
    setError('')
    let uploadedPath: string | null = null
    try {
      const resourceUrl = validateNewsLink(linkUrl)
      if (imageFile) uploadedPath = (await uploadNewsImage(userId, imageFile)).path
      const { error: publishError } = await supabase.from('news_posts').insert({
        university_id: selectedUniversityId,
        academic_unit_id: selectedScope === 'faculty' ? selectedUnitId : null,
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
        is_pinned: pinned,
        published_by: userId,
        status: 'published',
      })
      if (publishError) throw publishError
      setTitle('')
      setExcerpt('')
      setBody('')
      setImageFile(null)
      setLinkUrl('')
      setEventStartsAt('')
      setEventLocation('')
      setOrganizer('')
      setRegistrationUrl('')
      setPinned(false)
      setOpen(false)
      onPublished()
    } catch (publishError) {
      console.error('Could not publish news:', publishError)
      if (uploadedPath) await removeNewsImage(uploadedPath)
      setError(publishError instanceof Error ? publishError.message : 'Не вдалося опублікувати. Перевірте права редактора та налаштування новин у Supabase.')
    } finally {
      setSaving(false)
    }
  }

  const canPublish = isPlatformAdmin || (selectedScope === 'university'
    ? editorUniversityIds.includes(selectedUniversityId)
    : editorUnitIds.includes(selectedUnitId))
  if (!canPublish) return null

  return (
    <section className="xelay-blue-panel mb-5 overflow-hidden">
      <button
        type="button"
        disabled={saving}
        aria-expanded={open}
        aria-controls="official-news-composer"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[92px] w-full items-center justify-between gap-4 px-4 py-4 text-left disabled:opacity-60 sm:px-5"
      >
        <span>
          <span className="block text-sm font-semibold">Керування новинами</span>
          <span className="mt-1.5 block text-[13px] leading-relaxed text-muted-foreground">Публікувати можуть лише підтверджені редактори й адміністратори.</span>
        </span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-card/40 text-muted-foreground">{open ? <X size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}</span>
      </button>
      {open && (
        <form id="official-news-composer" onSubmit={(event) => void publish(event)} className="space-y-4 border-t border-border/60 bg-card p-4 sm:p-5">
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            {isPlatformAdmin && <label className="block text-sm font-medium">Розділ новин
              <select value={selectedScope} onChange={(event) => { setSelectedScope(event.target.value as NewsScope); setError('') }} className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">
                <option value="faculty">Новини факультету</option>
                <option value="university">Загальні новини університету</option>
              </select>
            </label>}
            {isPlatformAdmin && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm font-medium">Університет
                  <select value={selectedUniversityId} onChange={(event) => { setSelectedUniversityId(event.target.value); setSelectedUnitId('') }} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">
                    <option value="">Оберіть університет</option>
                    {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
                  </select>
                </label>
                {selectedScope === 'faculty' && <label className="text-sm font-medium">Факультет або інститут
                  <select value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">
                    <option value="">Оберіть підрозділ</option>
                    {availableUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                  </select>
                </label>}
              </div>
            )}
            <p className="rounded-xl bg-muted px-4 py-3 text-sm">{selectedScope === 'university'
              ? `${getUniversityNewsLabel(universities.find((university) => university.id === selectedUniversityId))} · ${universities.find((university) => university.id === selectedUniversityId)?.name || 'Ваш університет'}`
              : units.find((unit) => unit.id === selectedUnitId)?.name || 'Ваш факультет'}</p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
              <input aria-label="Заголовок новини" value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={180} placeholder="Заголовок" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm" />
              <select aria-label="Тип публікації" value={type} onChange={(event) => setType(event.target.value as NewsPostType)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm">
                {Object.entries(NEWS_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <textarea aria-label="Короткий опис новини" value={excerpt} onChange={(event) => setExcerpt(event.target.value)} required maxLength={500} rows={2} placeholder="Короткий опис для картки" className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm" />
            <textarea aria-label="Повний текст публікації" value={body} onChange={(event) => setBody(event.target.value)} required rows={6} placeholder="Повний текст публікації" className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-base sm:text-sm" />
            {type === 'event' && <div className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Дата й час<input type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
              <label className="text-sm font-medium">Організатор<input value={organizer} onChange={(event) => setOrganizer(event.target.value)} required maxLength={180} placeholder="Хто проводить подію" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
              <label className="text-sm font-medium">Місце або формат<input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} maxLength={250} placeholder="Наприклад, онлайн або аудиторія" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
              <label className="text-sm font-medium">Посилання на реєстрацію<input value={registrationUrl} onChange={(event) => setRegistrationUrl(event.target.value)} type="url" placeholder="https://…" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            </div>}
            <NewsImagePicker file={imageFile} onChange={setImageFile} disabled={saving} />
            <label className="block text-sm font-medium">Посилання на відео або матеріали
              <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} type="url" maxLength={2048} placeholder="https://… (необов’язково)" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" />
              <span className="mt-1.5 block text-xs font-normal text-muted-foreground">Відкриватиметься окремим посиланням у публікації.</span>
            </label>
            {isPlatformAdmin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Закріпити публікацію</label>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <button type="submit" disabled={saving || !selectedUniversityId || (selectedScope === 'faculty' && !selectedUnitId)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? 'Публікуємо…' : 'Опублікувати'}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  )
}
