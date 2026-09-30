import { supabase } from './supabase'
import type { Discussion } from '../types'
import { getPublicProfiles } from './profiles'

export async function getDiscussions(answerId: string): Promise<Discussion[]> {
  const { data, error } = await supabase
    .from('answer_discussions')
    .select(`
      id,
      answer_id,
      user_id,
      text,
      created_at
    `)
    .eq('answer_id', answerId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error(error)
    return []
  }
  const rows = data || []
  const profiles = await getPublicProfiles(rows.map((item) => item.user_id))
  const authors = new Map(profiles.data.map((profile) => [profile.id, profile]))
  return rows.map((item: any) => ({
    id: item.id,
    answerId: item.answer_id,
    userId: item.user_id,
    text: item.text,
    createdAt: item.created_at,

    user: {
      id: item.user_id,
      name: authors.get(item.user_id)?.full_name || 'Учасник Xelay',
      avatarUrl: authors.get(item.user_id)?.avatar_url || '',
    },
  }))
}
export async function createDiscussion(
  answerId: string,
  userId: string,
  text: string
) {
  const { error } = await supabase
    .from("answer_discussions")
    .insert({
      answer_id: answerId,
      user_id: userId,
      text,
    })

  if (error) {
    console.error(error)
    throw error
  }
}
