import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createSupabaseTeachingTestArchiveRepository, teachingTestArchiveError, type TeachingTestArchiveRepository, type TeachingTestArchiveState } from '../../lib/teachingTestArchive'

type Scope = { key: string; repository: TeachingTestArchiveRepository; epoch: number }
type Result = Scope & { data: TeachingTestArchiveState | null; error: string; loading: boolean }

export function useTeachingTestArchive({ userId, courseId, groupId, enabled, repository: injectedRepository }: {
  userId: string; courseId: string; groupId?: string; enabled: boolean; repository?: TeachingTestArchiveRepository
}) {
  const repository = useMemo(() => injectedRepository || createSupabaseTeachingTestArchiveRepository(), [injectedRepository])
  const key = `${userId}:${courseId}:${groupId || ''}:${enabled}`
  const current = useRef<Scope>({ key, repository, epoch: 0 })
  if (current.current.key !== key || current.current.repository !== repository) current.current = { key, repository, epoch: current.current.epoch + 1 }
  const epoch = current.current.epoch
  const [result, setResult] = useState<Result | null>(null)
  const [pending, setPending] = useState<(Scope & { testId: string }) | null>(null)
  const request = useRef(0), mounted = useRef(true)
  const mutation = useRef<(Scope & { testId: string }) | null>(null)
  const data = result?.key === key && result.repository === repository && result.epoch === epoch ? result.data : null
  const error = result?.key === key && result.repository === repository && result.epoch === epoch ? result.error : ''
  const isCurrent = useCallback((scope: Scope) => mounted.current && current.current.key === scope.key && current.current.repository === scope.repository && current.current.epoch === scope.epoch, [])
  const busyId = pending?.key === key && pending.repository === repository && pending.epoch === epoch ? pending.testId : ''
  const loading = enabled && (result?.key !== key || result.repository !== repository || result.epoch !== epoch || result.loading)

  const reload = useCallback(async () => {
    if (!enabled || mutation.current?.key === key && mutation.current.repository === repository && mutation.current.epoch === epoch) return
    const scope = { key, repository, epoch }, revision = ++request.current
    setResult(previous => ({ ...scope, data: previous?.key === key && previous.repository === repository && previous.epoch === epoch ? previous.data : null, error: '', loading: true }))
    try {
      const next = await repository.state(courseId, groupId || undefined)
      if (next.userId !== userId) throw new Error('TEST_ARCHIVE_ACTOR_CHANGED')
      if (isCurrent(scope) && request.current === revision) setResult({ ...scope, data: next, error: '', loading: false })
    } catch (failure) {
      if (isCurrent(scope) && request.current === revision) setResult(previous => ({ ...scope, data: previous?.key === key && previous.repository === repository && previous.epoch === epoch ? previous.data : null, error: teachingTestArchiveError(failure), loading: false }))
    }
  }, [courseId, enabled, epoch, groupId, isCurrent, key, repository, userId])

  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; request.current++ } }, [reload])

  const change = useCallback(async (testId: string, archived: boolean) => {
    const scope = { key, repository, epoch }
    if (!enabled || !data || data.userId !== userId || !isCurrent(scope)
      || mutation.current?.key === key && mutation.current.repository === repository && mutation.current.epoch === epoch
      || archived && !data.canArchive) return false
    const entry = data.items.find(item => item.testId === testId)
    if (!archived && !entry?.archivedAt) return false
    const token = { ...scope, testId }
    mutation.current = token; request.current++; setPending(token)
    setResult(previous => previous?.key === key && previous.repository === repository && previous.epoch === epoch ? { ...previous, error: '' } : previous)
    try {
      const updated = await repository.set({ testId, courseId, ...(groupId ? { groupId } : {}), archived, expectedVersion: entry?.version || 0, expectedUserId: userId })
      if (!isCurrent(scope) || mutation.current !== token) return false
      setResult(previous => previous?.key === key && previous.repository === repository && previous.epoch === epoch && previous.data
        ? { ...previous, error: '', loading: false, data: { ...previous.data, items: [...previous.data.items.filter(item => item.testId !== testId), updated] } } : previous)
      return true
    } catch (failure) {
      if (isCurrent(scope) && mutation.current === token) setResult(previous => previous?.key === key && previous.repository === repository && previous.epoch === epoch
        ? { ...previous, error: teachingTestArchiveError(failure), loading: false } : previous)
      return false
    } finally {
      if (mutation.current === token) mutation.current = null
      if (isCurrent(scope)) setPending(null)
    }
  }, [courseId, data, enabled, epoch, groupId, isCurrent, key, repository, userId])

  return { data: enabled ? data : null, error, loading, busyId, reload, change, scopeId: `${key}:${epoch}` }
}
