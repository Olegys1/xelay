import { useEffect, useRef } from 'react'
import { RepresentativeTransferPanel } from './representative-transfer/RepresentativeTransferPanel'
import { transferStudyGroupRepresentative, type StudyGroupRepresentativeTransfer } from '../lib/studyGroupRepresentativeTransfer'
import type { StudyGroupMember } from '../lib/studyGroupMembers'

export function StudyGroupRepresentativeTransfer({ groupId, groupName, currentUserId, representativeId, members, loading = false, disabled = false, onTransferred, onRefresh }: {
  groupId: string; groupName: string; currentUserId: string; representativeId: string; members: StudyGroupMember[]; loading?: boolean; disabled?: boolean
  onTransferred: (receipt: StudyGroupRepresentativeTransfer) => void
  onRefresh: () => void
}) {
  const identity = `${groupId}:${currentUserId}:${representativeId}`
  const current = useRef(identity); current.current = identity
  const alive = useRef(false)
  const pending = useRef<{ identity: string; target: string; requestId: string } | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const callbacks = useRef({ onTransferred, onRefresh }); callbacks.current = { onTransferred, onRefresh }
  useEffect(() => { alive.current = true; return () => { alive.current = false; inFlight.current?.abort() } }, [])
  useEffect(() => { pending.current = null; return () => { inFlight.current?.abort() } }, [identity])
  async function transfer(target: string) {
    if (loading || disabled || currentUserId !== representativeId || inFlight.current || !members.some(member => member.user_id === target && member.group_id === groupId && member.status === 'accepted')) throw new Error('Оновіть групу перед передачею прав.')
    if (!pending.current || pending.current.identity !== identity || pending.current.target !== target) pending.current = { identity, target, requestId: crypto.randomUUID() }
    const attempt = pending.current, request = new AbortController(), scope = identity
    inFlight.current = request
    try {
      const receipt = await transferStudyGroupRepresentative(currentUserId, groupId, target, representativeId, attempt.requestId, request.signal)
      if (alive.current && current.current === scope && !request.signal.aborted) callbacks.current.onTransferred(receipt)
    } catch (error) {
      if (alive.current && current.current === scope && !request.signal.aborted) callbacks.current.onRefresh()
      throw error instanceof Error ? error : new Error('Оновіть групу, щоб перевірити результат передачі.')
    } finally { if (inFlight.current === request) inFlight.current = null }
  }
  return <RepresentativeTransferPanel groupId={groupId} groupName={groupName} currentUserId={currentUserId} representativeId={representativeId} loading={loading} disabled={disabled}
    members={members.filter(member => member.status === 'accepted').map(member => ({ id: member.user_id, groupId: member.group_id, status: 'accepted' as const,
      name: member.profile?.full_name || '', username: member.profile?.username || undefined, avatarUrl: member.profile?.avatar_url }))}
    onTransfer={transfer} />
}
