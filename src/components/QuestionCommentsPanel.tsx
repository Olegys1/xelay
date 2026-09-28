import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Loader2, MessageSquareText, Send } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'
import { useAuth } from '../context/AuthContext'
import { AuthModal } from './AuthModal'
import { supabase } from '../lib/supabase'

interface QuestionComment {
  id: string
  user_id: string
  body: string
  created_at: string
  authorName: string
  avatarUrl: string | null
}

export function QuestionCommentsPanel({ questionId }: { questionId: string }) {
  const { authUser, xelayUser } = useAuth()
  const [comments, setComments] = useState<QuestionComment[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)

  const loadComments = useCallback(async () => {
    const { data, error: commentsError } = await supabase.from('question_comments')
      .select('id, user_id, body, created_at')
      .eq('question_id', questionId)
      .order('created_at', { ascending: true })
    if (commentsError) {
      console.error('Could not load question comments:', commentsError)
      setError('Коментарі до запитань стануть доступними після оновлення бази даних.')
      setLoading(false)
      return
    }

    const rows = data || []
    const authorIds = [...new Set(rows.map((comment) => comment.user_id))]
    const profiles = authorIds.length
      ? await supabase.from('profiles').select('id, full_name, avatar_url').in('id', authorIds)
      : { data: [] }
    const profileById = new Map((profiles.data || []).map((profile: any) => [profile.id, profile]))
    setComments(rows.map((comment) => {
      const profile = profileById.get(comment.user_id) as { full_name?: string; avatar_url?: string | null } | undefined
      return {
        ...comment,
        authorName: profile?.full_name || 'Учасник Xelay',
        avatarUrl: profile?.avatar_url || null,
      }
    }))
    setError('')
    setLoading(false)
  }, [questionId])

  useEffect(() => {
    setLoading(true)
    void loadComments()
  }, [loadComments])

  const submitComment = async (event: FormEvent) => {
    event.preventDefault()
    const body = draft.trim()
    if (!authUser?.id) {
      setShowAuthModal(true)
      return
    }
    if (!body || sending) return

    setSending(true)
    setError('')
    const { data, error: commentError } = await supabase.from('question_comments')
      .insert({ question_id: questionId, user_id: authUser.id, body })
      .select('id, user_id, body, created_at')
      .single()

    if (commentError) {
      console.error('Could not add question comment:', commentError)
      setError('Не вдалося додати коментар. Спробуйте ще раз.')
    } else if (data) {
      setComments((current) => [...current, {
        ...data,
        authorName: xelayUser?.name || 'Учасник Xelay',
        avatarUrl: xelayUser?.avatarUrl || null,
      }])
      setDraft('')
    }
    setSending(false)
  }

  return (
    <>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      <section className="xelay-card mb-8 p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <MessageSquareText size={18} />
          <h2 className="text-base font-semibold">Коментарі до запитання</h2>
          <span className="text-sm text-muted-foreground">{comments.length}</span>
        </div>

        <form onSubmit={(event) => void submitComment(event)} className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={3000}
            rows={2}
            placeholder={authUser ? 'Напишіть коментар…' : 'Увійдіть, щоб коментувати'}
            disabled={!authUser}
            className="min-h-11 min-w-0 flex-1 resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
          {authUser ? (
            <button type="submit" disabled={sending || !draft.trim()} aria-label="Надіслати коментар" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40">
              {sending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
            </button>
          ) : (
            <button type="button" onClick={() => setShowAuthModal(true)} className="h-11 shrink-0 rounded-full bg-foreground px-4 text-sm font-medium text-background">Увійти</button>
          )}
        </form>

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-4 divide-y divide-border">
          {loading ? (
            <div className="py-5 text-center"><Loader2 size={18} className="mx-auto animate-spin text-muted-foreground" /></div>
          ) : comments.length ? comments.map((comment) => (
            <article key={comment.id} className="flex gap-3 py-4 first:pt-0 last:pb-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-semibold">
                {comment.avatarUrl ? <img src={comment.avatarUrl} alt="" className="h-full w-full object-cover" /> : comment.authorName.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-semibold">{comment.authorName}</span>
                  <time className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(comment.created_at), { addSuffix: true, locale: uk })}</time>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{comment.body}</p>
              </div>
            </article>
          )) : !error ? <p className="py-5 text-center text-sm text-muted-foreground">Поки немає коментарів. Будьте першими.</p> : null}
        </div>
      </section>
    </>
  )
}
