import type { Question } from '../types/index.ts'

export type HomeFeedQuestion = Question & { images?: string[]; is_pinned?: boolean }
export type HomeFeedImage = { question_id: string; image_url: string }
type Result<T> = { data: T | null; error: unknown }

export type HomeFeedSource = {
  questions: (signal: AbortSignal) => Promise<Result<HomeFeedQuestion[]>>
  images: (ids: string[], signal: AbortSignal) => Promise<Result<HomeFeedImage[]>>
  authors: (questions: HomeFeedQuestion[]) => Promise<HomeFeedQuestion[]>
}

export type HomeFeedStats = { questions: number; members: number }
export type HomeFeedStatsSource = {
  questionCount: (signal: AbortSignal) => Promise<Result<number>>
  memberCount: () => Promise<Result<number>>
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
}

/** Fetch only the photos belonging to the 50 displayed questions. A failed
 * photo refresh retains previously loaded photos while fresh text can appear. */
export async function loadHomeFeed(
  source: HomeFeedSource,
  previous: HomeFeedQuestion[],
  signal: AbortSignal,
): Promise<{ questions: HomeFeedQuestion[]; imagesError: boolean }> {
  const result = await source.questions(signal)
  assertActive(signal)
  if (result.error) throw result.error
  if (!Array.isArray(result.data)) throw new Error('Question feed response was incomplete.')
  const rows = result.data
  const ids = [...new Set(rows.map((question) => question.id))]
  const [authors, imageResult] = await Promise.all([
    source.authors(rows),
    ids.length
      ? source.images(ids, signal).catch((error) => ({ data: null, error }))
      : Promise.resolve({ data: [] as HomeFeedImage[], error: null }),
  ])
  assertActive(signal)
  const imagesError = Boolean(imageResult.error) || !Array.isArray(imageResult.data)
  const photosById = new Map<string, string[]>()
  if (!imagesError) {
    for (const image of imageResult.data || []) {
      const photos = photosById.get(image.question_id) || []
      photos.push(image.image_url)
      photosById.set(image.question_id, photos)
    }
  }
  const previousById = new Map(previous.map((question) => [question.id, question]))
  const questions = authors.map((question) => {
    const old = previousById.get(question.id)
    const next = {
      ...question,
      images: imagesError ? old?.images || [] : photosById.get(question.id) || [],
    }
    // Retain unchanged card props so refreshing counters does not rebuild cards.
    return old && JSON.stringify(old) === JSON.stringify(next) ? old : next
  })
  return { questions, imagesError }
}

/** Each counter can fail independently; zero is a valid result, not a fallback. */
export async function loadHomeFeedStats(
  source: HomeFeedStatsSource,
  previous: HomeFeedStats,
  signal: AbortSignal,
): Promise<HomeFeedStats> {
  const [questions, members] = await Promise.allSettled([
    source.questionCount(signal),
    source.memberCount(),
  ])
  assertActive(signal)
  const valid = (result: PromiseSettledResult<Result<number>>) =>
    result.status === 'fulfilled' && !result.value.error && result.value.data !== null
      && Number.isFinite(result.value.data) && result.value.data >= 0
  return {
    questions: valid(questions) && questions.status === 'fulfilled'
      ? questions.value.data as number : previous.questions,
    members: valid(members) && members.status === 'fulfilled'
      ? members.value.data as number : previous.members,
  }
}
