import { supabase } from './supabase'

export type StudyGroupMemberProfile = {
  id: string
  full_name: string | null
  username: string | null
  avatar_url: string | null
}

export type StudyGroupMember = {
  id: string
  group_id: string
  user_id: string
  status: 'pending' | 'accepted' | 'rejected' | 'removed'
  profile?: StudyGroupMemberProfile
}

export type MemberConnection = {
  state: 'none' | 'outgoing' | 'incoming' | 'accepted'
  requestId?: string
  conversationId?: string
}

export async function loadMemberConnections(currentUserId: string, memberIds: string[]): Promise<Record<string, MemberConnection>> {
  const ids = [...new Set(memberIds.filter((id) => id && id !== currentUserId))]
  const connections: Record<string, MemberConnection> = Object.fromEntries(ids.map((id) => [id, { state: 'none' }]))
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    const results = await Promise.all([
      supabase.from('connection_requests').select('id, requester_id, recipient_id, status')
        .eq('requester_id', currentUserId).in('recipient_id', batch).in('status', ['pending', 'accepted']),
      supabase.from('connection_requests').select('id, requester_id, recipient_id, status')
        .eq('recipient_id', currentUserId).in('requester_id', batch).in('status', ['pending', 'accepted']),
      supabase.from('conversations').select('id, user_one_id, user_two_id')
        .eq('user_one_id', currentUserId).in('user_two_id', batch),
      supabase.from('conversations').select('id, user_one_id, user_two_id')
        .eq('user_two_id', currentUserId).in('user_one_id', batch),
    ])
    for (const result of results) if (result.error) throw result.error
    for (const request of [...(results[0].data || []), ...(results[1].data || [])]) {
      const peerId = request.requester_id === currentUserId ? request.recipient_id : request.requester_id
      if (connections[peerId]?.state === 'accepted') continue
      connections[peerId] = {
        state: request.status === 'accepted' ? 'accepted' : request.requester_id === currentUserId ? 'outgoing' : 'incoming',
        requestId: request.id,
      }
    }
    for (const conversation of [...(results[2].data || []), ...(results[3].data || [])]) {
      const peerId = conversation.user_one_id === currentUserId ? conversation.user_two_id : conversation.user_one_id
      if (connections[peerId]?.state === 'accepted') connections[peerId] = { ...connections[peerId], conversationId: conversation.id }
    }
  }
  return connections
}
