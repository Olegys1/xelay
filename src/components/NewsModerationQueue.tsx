import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, Loader2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getPublicProfiles } from '../lib/profiles'
import { formatNewsDate, NEWS_TYPE_LABELS, NewsPostType } from '../lib/news'

interface Submission {
  id: string
  user_id: string
  university_id: string
  academic_unit_id: string
  post_type: NewsPostType
  title: string
  excerpt: string
  body: string
  image_url: string | null
  event_starts_at: string | null
  event_location: string | null
  organizer: string | null
  registration_url: string | null
  created_at: string
  authorName: string
  universityName: string
  unitName: string
}

export function NewsModerationQueue({
  isPlatformAdmin,
  academicUnitId,
  onReviewed,
}: {
  isPlatformAdmin: boolean
  academicUnitId?: string | null
  onReviewed?: () => void
}) {
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [loading, setLoading] = useState(true)
  const [reviewingId, setReviewingId] = useState('')
  const [error, setError] = useState('')

  const loadQueue = useCallback(async () => {
    let query = supabase.from('news_submissions')
      .select('id, user_id, university_id, academic_unit_id, post_type, title, excerpt, body, image_url, event_starts_at, event_location, organizer, registration_url, created_at')
      .eq('status', 'pending').order('created_at', { ascending: true })
    if (!isPlatformAdmin && academicUnitId) query = query.eq('academic_unit_id', academicUnitId)
    const { data, error: queueError } = await query
    if (queueError) {
      console.error('Could not load news moderation queue:', queueError)
      setError('Не вдалося завантажити пропозиції. Перевірте, чи застосована міграція новин.')
      setLoading(false)
      return
    }
    const userIds = [...new Set((data || []).map((item: any) => item.user_id))]
    const universityIds = [...new Set((data || []).map((item: any) => item.university_id))]
    const unitIds = [...new Set((data || []).map((item: any) => item.academic_unit_id))]
    const [profilesResult, universitiesResult, unitsResult] = await Promise.all([
      getPublicProfiles(userIds),
      universityIds.length ? supabase.from('universities').select('id, name').in('id', universityIds) : Promise.resolve({ data: [] }),
      unitIds.length ? supabase.from('academic_units').select('id, name').in('id', unitIds) : Promise.resolve({ data: [] }),
    ])
    const names = new Map((profilesResult.data || []).map((profile: any) => [profile.id, profile.full_name]))
    const universityNames = new Map((universitiesResult.data || []).map((university: any) => [university.id, university.name]))
    const unitNames = new Map((unitsResult.data || []).map((unit: any) => [unit.id, unit.name]))
    setSubmissions((data || []).map((item: any) => ({
      ...item,
      authorName: names.get(item.user_id) || 'Учасник Xelay',
      universityName: universityNames.get(item.university_id) || 'Університет',
      unitName: unitNames.get(item.academic_unit_id) || 'Факультет або інститут',
    })))
    setError('')
    setLoading(false)
  }, [isPlatformAdmin, academicUnitId])

  useEffect(() => { void loadQueue() }, [loadQueue])

  const review = async (submissionId: string, action: 'publish' | 'reject') => {
    setReviewingId(submissionId)
    setError('')
    const { error: reviewError } = await supabase.rpc('xelay_review_news_submission', {
      p_submission_id: submissionId,
      p_action: action,
    })
    if (reviewError) {
      console.error('Could not review news submission:', reviewError)
      setError('Не вдалося обробити пропозицію. Оновіть сторінку та спробуйте ще раз.')
    } else {
      await loadQueue()
      onReviewed?.()
    }
    setReviewingId('')
  }

  return (
    <section className="xelay-card mb-5 overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div><h2 className="font-semibold">Пропозиції новин</h2><p className="mt-0.5 text-xs text-muted-foreground">{isPlatformAdmin ? 'Для всіх університетів і підрозділів' : 'Для вашого підрозділу'}</p></div>
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">{loading ? '…' : submissions.length}</span>
      </header>
      {error && <p role="alert" className="mx-5 mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
      {loading ? <div className="flex min-h-24 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div> : submissions.length ? (
        <div className="divide-y divide-border">
          {submissions.map((submission) => <article key={submission.id} className="px-5 py-4 sm:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2"><span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">{NEWS_TYPE_LABELS[submission.post_type]}</span><time className="text-xs text-muted-foreground">{formatNewsDate(submission.created_at)}</time></div>
                <h3 className="text-sm font-semibold">{submission.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{submission.excerpt}</p>
                <p className="mt-2 text-xs text-muted-foreground">Від: <span className="font-medium text-foreground">{submission.authorName}</span> · {submission.universityName} · {submission.unitName}</p>
                <details className="group mt-3">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"><ChevronDown size={14} className="transition-transform group-open:rotate-180" /> Повний текст</summary>
                  <div className="mt-3 rounded-xl bg-muted/60 p-3 text-sm leading-relaxed">
                    {submission.post_type === 'event' && <p className="mb-3 text-xs text-muted-foreground">{submission.event_starts_at ? `${formatNewsDate(submission.event_starts_at)} · ${new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(new Date(submission.event_starts_at))}` : ''}{submission.event_location ? ` · ${submission.event_location}` : ''}{submission.organizer ? ` · ${submission.organizer}` : ''}</p>}
                    <p className="whitespace-pre-wrap break-words">{submission.body}</p>
                    {submission.registration_url && <a href={submission.registration_url} target="_blank" rel="noreferrer" className="mt-3 block underline">Посилання на реєстрацію</a>}
                    {submission.image_url && <a href={submission.image_url} target="_blank" rel="noreferrer" className="mt-3 block underline">Відкрити зображення</a>}
                  </div>
                </details>
              </div>
              <div className="flex shrink-0 gap-2 sm:flex-col">
                <button onClick={() => void review(submission.id, 'publish')} disabled={Boolean(reviewingId)} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">{reviewingId === submission.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Опублікувати</button>
                <button onClick={() => void review(submission.id, 'reject')} disabled={Boolean(reviewingId)} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><X size={15} /> Відхилити</button>
              </div>
            </div>
          </article>)}
        </div>
      ) : <p className="px-6 py-8 text-center text-sm text-muted-foreground">Немає пропозицій, що очікують на розгляд.</p>}
    </section>
  )
}
