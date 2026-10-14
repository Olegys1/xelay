import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getMemberCount } from '../lib/profiles'
import { addQuestionAuthors } from '../lib/questionAuthors'
import { loadHomeFeed, loadHomeFeedStats, type HomeFeedQuestion, type HomeFeedStats } from '../lib/homeFeedData'
import { createHomeFeedRefresh } from '../lib/homeFeedRefresh'

type FeedState = {
  scope: string
  questions: HomeFeedQuestion[]
  stats: HomeFeedStats
  loading: boolean
  refreshing: boolean
  error: string
}
type Refresh = ReturnType<typeof createHomeFeedRefresh>

const emptyStats = { questions: 0, members: 0 }
const initialState = (scope: string): FeedState => ({
  scope, questions: [], stats: emptyStats, loading: true, refreshing: false, error: '',
})

export function useHomeFeed(userId?: string) {
  const scope = userId || 'anonymous'
  const currentScope = useRef(scope)
  currentScope.current = scope
  const [state, setState] = useState<FeedState>(() => initialState(scope))
  const currentQuestions = useRef<HomeFeedQuestion[]>([])
  const currentStats = useRef<HomeFeedStats>(emptyStats)
  const deletedIds = useRef(new Set<string>())
  const controllers = useRef<{ scope: string; feed: Refresh; stats: Refresh } | null>(null)

  useEffect(() => {
    let active = true
    const inScope = () => active && currentScope.current === scope
    currentQuestions.current = []
    currentStats.current = emptyStats
    deletedIds.current.clear()
    setState(initialState(scope))

    const feed = createHomeFeedRefresh({
      initialVisible: document.visibilityState === 'visible',
      fallbackMs: 60_000,
      load: (signal) => loadHomeFeed({
        questions: async (abortSignal) => {
          const result = await supabase.from('questions').select('*')
            .order('is_pinned', { ascending: false })
            .order('created_at', { ascending: false }).limit(50).abortSignal(abortSignal)
          return { data: result.data as HomeFeedQuestion[] | null, error: result.error }
        },
        images: async (ids, abortSignal) => {
          const result = await supabase.from('question_images')
            .select('question_id, image_url').in('question_id', ids).abortSignal(abortSignal)
          return { data: result.data, error: result.error }
        },
        authors: addQuestionAuthors,
      }, currentQuestions.current, signal),
      onStart: () => {
        if (inScope()) setState((previous) => ({ ...previous, refreshing: true }))
      },
      onData: ({ questions, imagesError }) => {
        if (!inScope()) return
        const visibleQuestions = questions.filter((question) => !deletedIds.current.has(question.id))
        currentQuestions.current = visibleQuestions
        setState((previous) => ({
          ...previous,
          questions: visibleQuestions,
          error: imagesError ? 'Не вдалося оновити фото. Попередні зображення збережено — спробуйте оновити стрічку.' : '',
        }))
      },
      onError: () => {
        if (inScope()) setState((previous) => ({
          ...previous,
          error: 'Не вдалося оновити запитання. Перевірте з’єднання та спробуйте ще раз.',
        }))
      },
      onSettled: () => {
        if (inScope()) setState((previous) => ({ ...previous, loading: false, refreshing: false }))
      },
    })
    const stats = createHomeFeedRefresh({
      initialVisible: document.visibilityState === 'visible',
      fallbackMs: 300_000,
      reconcileMs: 60_000,
      debounceMs: 750,
      load: (signal) => loadHomeFeedStats({
        questionCount: async (abortSignal) => {
          const result = await supabase.from('questions').select('id', { count: 'exact', head: true })
            .abortSignal(abortSignal)
          return { data: result.count, error: result.error }
        },
        memberCount: getMemberCount,
      }, currentStats.current, signal),
      onData: (nextStats) => {
        if (!inScope()) return
        currentStats.current = nextStats
        setState((previous) => previous.stats.questions === nextStats.questions
          && previous.stats.members === nextStats.members ? previous : { ...previous, stats: nextStats })
      },
      onError: () => undefined,
    })
    controllers.current = { scope, feed, stats }
    void feed.request()
    void stats.request()

    const channel = supabase.channel(`home-feed:${scope}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, (payload) => {
        if (!inScope()) return
        feed.invalidate()
        if (payload.eventType === 'INSERT' || payload.eventType === 'DELETE') stats.invalidate()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'question_images' }, () => {
        if (inScope()) feed.invalidate()
      })
      .subscribe((status) => {
        if (inScope() && status === 'SUBSCRIBED') feed.reconcile()
      })

    const visibilityChanged = () => {
      const visible = document.visibilityState === 'visible'
      feed.setVisible(visible)
      stats.setVisible(visible)
    }
    const reconcile = () => { feed.reconcile(); stats.reconcile() }
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('focus', reconcile)
    window.addEventListener('online', reconcile)
    return () => {
      active = false
      feed.dispose()
      stats.dispose()
      if (controllers.current?.scope === scope) controllers.current = null
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('focus', reconcile)
      window.removeEventListener('online', reconcile)
      void supabase.removeChannel(channel).catch(() => undefined)
    }
  }, [scope])

  const refresh = useCallback(async (afterWrite = false) => {
    const current = controllers.current
    if (!current || current.scope !== scope || currentScope.current !== scope) return
    // Counter delays must not keep a successfully published question's form
    // disabled. They have their own serial loader and update independently.
    const feedRequest = current.feed.request(afterWrite)
    void current.stats.request(afterWrite)
    await feedRequest
  }, [scope])

  const removeQuestion = useCallback((id: string) => {
    if (currentScope.current !== scope || controllers.current?.scope !== scope) return
    deletedIds.current.add(id)
    currentQuestions.current = currentQuestions.current.filter((question) => question.id !== id)
    // The DELETE Realtime event may already have refreshed the count. Reading
    // the authoritative counter avoids decrementing it twice in that race.
    setState((previous) => ({ ...previous, questions: currentQuestions.current }))
    controllers.current.stats.invalidate()
  }, [scope])

  return { ...(state.scope === scope ? state : initialState(scope)), refresh, removeQuestion }
}
