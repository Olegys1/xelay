import { FormEvent, useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { NEWS_TYPE_LABELS, NewsPostType } from '../lib/news'

type UniversityOption = { id: string; name: string }
type AcademicUnitOption = { id: string; university_id: string; name: string }

export function NewsComposer({
  userId,
  isPlatformAdmin,
  universityId,
  academicUnitId,
  editorUnitIds = [],
  onPublished,
}: {
  userId: string
  isPlatformAdmin: boolean
  universityId?: string | null
  academicUnitId?: string | null
  editorUnitIds?: string[]
  onPublished: () => void
}) {
  const [open, setOpen] = useState(false)
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [units, setUnits] = useState<AcademicUnitOption[]>([])
  const [selectedUniversityId, setSelectedUniversityId] = useState(universityId || '')
  const [selectedUnitId, setSelectedUnitId] = useState(academicUnitId || '')
  const [type, setType] = useState<NewsPostType>('news')
  const [title, setTitle] = useState('')
  const [excerpt, setExcerpt] = useState('')
  const [body, setBody] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [eventStartsAt, setEventStartsAt] = useState('')
  const [eventLocation, setEventLocation] = useState('')
  const [organizer, setOrganizer] = useState('')
  const [registrationUrl, setRegistrationUrl] = useState('')
  const [pinned, setPinned] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      const [universityResult, unitResult] = await Promise.all([
        supabase.from('universities').select('id, name').eq('is_active', true).order('name'),
        supabase.from('academic_units').select('id, university_id, name').eq('is_active', true).order('name'),
      ])
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
  }, [isPlatformAdmin, universityId])

  const availableUnits = units.filter((unit) =>
    unit.university_id === selectedUniversityId && (isPlatformAdmin || editorUnitIds.includes(unit.id))
  )

  const publish = async (event: FormEvent) => {
    event.preventDefault()
    if (!userId || !selectedUniversityId || !selectedUnitId) {
      setError('Оберіть підрозділ для публікації.')
      return
    }
    setSaving(true)
    setError('')
    const { error: publishError } = await supabase.from('news_posts').insert({
      university_id: selectedUniversityId,
      academic_unit_id: selectedUnitId,
      post_type: type,
      title: title.trim(),
      excerpt: excerpt.trim(),
      body: body.trim(),
      image_url: imageUrl.trim() || null,
      event_starts_at: type === 'event' && eventStartsAt ? new Date(eventStartsAt).toISOString() : null,
      event_location: type === 'event' ? eventLocation.trim() || null : null,
      organizer: type === 'event' ? organizer.trim() || null : null,
      registration_url: type === 'event' ? registrationUrl.trim() || null : null,
      is_pinned: pinned,
      published_by: userId,
      status: 'published',
    })
    setSaving(false)
    if (publishError) {
      console.error('Could not publish faculty news:', publishError)
      setError('Не вдалося опублікувати. Перевірте права редактора та обов’язкові поля.')
      return
    }
    setTitle('')
    setExcerpt('')
    setBody('')
    setImageUrl('')
    setEventStartsAt('')
    setEventLocation('')
    setOrganizer('')
    setRegistrationUrl('')
    setPinned(false)
    setOpen(false)
    onPublished()
  }

  const canPublish = isPlatformAdmin || editorUnitIds.includes(academicUnitId || '')
  if (!canPublish) return null

  return (
    <section className="xelay-card mb-5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span>
          <span className="block font-semibold">Керування новинами</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">Публікувати можуть лише підтверджені редактори й адміністратори.</span>
        </span>
        {open ? <X size={19} /> : <Plus size={19} />}
      </button>
      {open && (
        <form onSubmit={(event) => void publish(event)} className="space-y-4 border-t border-border p-5">
          {isPlatformAdmin && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Університет
                <select value={selectedUniversityId} onChange={(event) => { setSelectedUniversityId(event.target.value); setSelectedUnitId('') }} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">
                  <option value="">Оберіть університет</option>
                  {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium">Факультет або інститут
                <select value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5">
                  <option value="">Оберіть підрозділ</option>
                  {availableUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </label>
            </div>
          )}
          {!isPlatformAdmin && <p className="rounded-xl bg-muted px-4 py-3 text-sm">{units.find((unit) => unit.id === academicUnitId)?.name || 'Ваш факультет'}</p>}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
            <input value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={180} placeholder="Заголовок" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
            <select value={type} onChange={(event) => setType(event.target.value as NewsPostType)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm">
              {Object.entries(NEWS_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <textarea value={excerpt} onChange={(event) => setExcerpt(event.target.value)} required maxLength={500} rows={2} placeholder="Короткий опис для картки" className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
          <textarea value={body} onChange={(event) => setBody(event.target.value)} required rows={6} placeholder="Повний текст публікації" className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
          {type === 'event' && <div className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Дата й час<input type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} required className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Організатор<input value={organizer} onChange={(event) => setOrganizer(event.target.value)} required maxLength={180} placeholder="Хто проводить подію" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Місце або формат<input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} maxLength={250} placeholder="Наприклад, онлайн або аудиторія" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
            <label className="text-sm font-medium">Посилання на реєстрацію<input value={registrationUrl} onChange={(event) => setRegistrationUrl(event.target.value)} type="url" placeholder="https://…" className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal" /></label>
          </div>}
          <input value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} type="url" placeholder="Посилання на зображення (необов’язково)" className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm" />
          {isPlatformAdmin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Закріпити публікацію</label>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button type="submit" disabled={saving || !selectedUniversityId || !selectedUnitId} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background disabled:opacity-50">
            {saving && <Loader2 size={16} className="animate-spin" />}
            Опублікувати
          </button>
        </form>
      )}
    </section>
  )
}
