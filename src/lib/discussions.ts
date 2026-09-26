import { supabase } from './supabase'
import type { Discussion } from '../types'

export async function getDiscussions(answerId: string): Promise<Discussion[]> {
  const { data, error } = await supabase
    .from('answer_discussions')
    .select(`
      id,
      answer_id,
      user_id,
      text,
      created_at,
      profiles (
        id,
        full_name,
        avatar_url
      )
    `)
    .eq('answer_id', answerId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error(error)
    return []
  }
console.log(data)
  return (data || []).map((item: any) => ({
    id: item.id,
    answerId: item.answer_id,
    userId: item.user_id,
    text: item.text,
    createdAt: item.created_at,

    user: {
      id: item.profiles.id,
      name: item.profiles.full_name,
      avatarUrl: item.profiles.avatar_url || '',
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