import { useEffect, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'

interface IncomingRequest {
  id: string
  requester_id: string
  created_at: string
  profile: {
    full_name: string
    avatar_url: string | null
    faculty: string | null
    specialty: string | null
  }
}

export function ConnectionRequestsPanel({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const [requests, setRequests] = useState<IncomingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [error, setError] = useState('')

  const loadRequests = async () => {
    const { data, error: requestError } = await supabase
      .from('connection_requests')
      .select('id, requester_id, created_at')
      .eq('recipient_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (requestError) {
      console.error('Could not load connection requests:', requestError)
      setError('Не вдалося завантажити запити на спілкування.')
      setLoading(false)
      return
    }

    const profiles = data?.length
      ? await supabase.from('profiles')
        .select('id, full_name, avatar_url, faculty, specialty')
        .in('id', data.map((request) => request.requester_id))
      : { data: [] }
    const profileById = new Map((profiles.data || []).map((profile: any) => [profile.id, profile]))

    setRequests((data || []).map((request) => ({
      ...request,
      profile: (profileById.get(request.requester_id) as IncomingRequest['profile']) || {
        full_name: 'Учасник Xelay', avatar_url: null, faculty: '', specialty: '',
      },
    })))
    setLoading(false)
  }

  useEffect(() => {
    void loadRequests()
  }, [userId])

  const respond = async (request: IncomingRequest, accept: boolean) => {
    setWorkingId(request.id)
    setError('')
    try {
      if (accept) {
        const { data: conversationId, error: acceptError } = await supabase
          .rpc('accept_connection_request', { p_request_id: request.id })
        if (acceptError) throw acceptError
        setRequests((current) => current.filter((item) => item.id !== request.id))
        if (conversationId) navigate({ to: '/messages' })
      } else {
        const { error: rejectError } = await supabase
          .rpc('reject_connection_request', { p_request_id: request.id })
        if (rejectError) throw rejectError
        setRequests((current) => current.filter((item) => item.id !== request.id))
      }
    } catch (responseError) {
      console.error('Could not respond to connection request:', responseError)
      setError('Не вдалося оновити запит. Оновіть сторінку та спробуйте ще раз.')
    } finally {
      setWorkingId('')
    }
  }

  if (loading || (!requests.length && !error)) return null

  return (
    <section className="xelay-card p-5 sm:p-6 mb-8">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold">Запити на спілкування</h2>
        {requests.length > 0 && <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">{requests.length}</span>}
      </div>
      {error && <p role="alert" className="text-sm text-red-600 mb-3">{error}</p>}
      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">Нових запитів немає.</p>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => {
            const initials = request.profile.full_name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
            const isWorking = workingId === request.id
            return (
              <article key={request.id} className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-border p-3">
                <button
                  onClick={() => navigate({ to: '/user/$id', params: { id: request.requester_id } })}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="w-11 h-11 overflow-hidden rounded-full bg-muted flex items-center justify-center shrink-0">
                    {request.profile.avatar_url ? <img src={request.profile.avatar_url} alt="" className="w-full h-full object-cover" /> : <span className="text-sm font-semibold">{initials}</span>}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{request.profile.full_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{[request.profile.faculty, request.profile.specialty].filter(Boolean).join(' · ') || 'Хоче поспілкуватися з вами'}</span>
                  </span>
                </button>
                <div className="flex gap-2 sm:shrink-0">
                  <button
                    onClick={() => void respond(request, false)}
                    disabled={isWorking}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-2 text-sm disabled:opacity-50"
                  >
                    <X size={15} /> Відхилити
                  </button>
                  <button
                    onClick={() => void respond(request, true)}
                    disabled={isWorking}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-full bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
                  >
                    {isWorking ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                    Прийняти
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
