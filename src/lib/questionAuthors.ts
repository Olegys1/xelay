import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'

type QuestionAuthorFields = {
  user_id?: string | null
  author_name?: string | null
  author_avatar?: string | null
}

type QuestionAuthorProfile = {
  id: string
  full_name: string | null
  avatar_url: string | null
}

const isAnonymousPlaceholder = (name?: string | null) => {
  const normalizedName = name?.trim().toLocaleLowerCase('uk-UA')
  return !normalizedName || normalizedName === 'анонім' || normalizedName === 'anonymous'
}

export async function addQuestionAuthors<T extends QuestionAuthorFields>(
  questions: T[],
): Promise<Array<T & { author_name: string; author_avatar: string }>> {
  const profileIds = [...new Set(
    questions
      .filter((question) => isAnonymousPlaceholder(question.author_name) && question.user_id)
      .map((question) => question.user_id as string),
  )]

  const profilesResult = profileIds.length
    ? await getPublicProfiles(profileIds)
    : { data: [], error: null }

  if (profilesResult.error) {
    console.error('Could not load question authors:', profilesResult.error)
  }

  const profilesById = new Map(
    ((profilesResult.data || []) as QuestionAuthorProfile[]).map((profile) => [profile.id, profile]),
  )

  return questions.map((question) => {
    const profile = question.user_id ? profilesById.get(question.user_id) : undefined
    const authorName = isAnonymousPlaceholder(question.author_name)
      ? profile?.full_name?.trim() || question.author_name?.trim() || 'Анонім'
      : question.author_name?.trim() || profile?.full_name?.trim() || 'Анонім'

    return {
      ...question,
      author_name: authorName,
      author_avatar: question.author_avatar || profile?.avatar_url || '',
    }
  })
}
