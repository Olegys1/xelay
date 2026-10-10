import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { loadStudyGroupLongTermTasks, longTermTaskError, type StudyGroupLongTermTask } from '../lib/studyGroupLongTermTasks'

type TaskState = { scope: string; tasks: StudyGroupLongTermTask[]; loading: boolean; error: string }

// A workspace loads all subjects once; lesson cards only receive the result.
export function useStudyGroupLongTermTasks(groupId: string, currentUserId: string, enabled = true) {
  const scope = `${groupId}:${currentUserId}:${enabled}`
  const active = enabled && Boolean(groupId && currentUserId)
  const [state, setState] = useState<TaskState>({ scope, tasks: [], loading: active, error: '' })
  const mounted = useRef(false)
  const sequence = useRef(0)
  const currentScope = useRef(scope)
  currentScope.current = scope

  const reload = useCallback(async (): Promise<void> => {
    if (!mounted.current || currentScope.current !== scope) return
    const request = ++sequence.current
    if (!active) {
      if (mounted.current && currentScope.current === scope) setState({ scope, tasks: [], loading: false, error: '' })
      return
    }
    setState((previous) => ({ scope, tasks: previous.scope === scope ? previous.tasks : [], loading: true, error: '' }))
    try {
      const tasks = await loadStudyGroupLongTermTasks(groupId)
      if (!mounted.current || request !== sequence.current || currentScope.current !== scope) return
      setState({ scope, tasks, loading: false, error: '' })
    } catch (error) {
      if (!mounted.current || request !== sequence.current || currentScope.current !== scope) return
      // RLS may have changed while the workspace was open. Do not retain a
      // cached description after a failed access check.
      setState({ scope, tasks: [], loading: false, error: longTermTaskError(error) })
    }
  }, [active, groupId, currentUserId, scope])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false; sequence.current += 1 }
  }, [reload])

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      if (!mounted.current || currentScope.current !== scope) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void reload() }, 250)
    }
    const accessChanged = () => {
      if (!mounted.current || currentScope.current !== scope) return
      sequence.current += 1
      if (mounted.current && currentScope.current === scope) setState({ scope, tasks: [], loading: true, error: '' })
      changed()
    }
    const taskDeleted = (payload: { old: Record<string, unknown> }) => {
      const id = typeof payload.old?.id === 'string' ? payload.old.id : ''
      // DELETE cannot be group-filtered reliably with RLS. Reloading this
      // workspace is safe even when a different group's row was removed.
      if (id) changed()
    }
    const groupDeleted = (payload: { old: Record<string, unknown> }) => {
      if (payload.old?.id === groupId) accessChanged()
    }
    const channel = supabase.channel(`group-long-term-tasks:${groupId}:${currentUserId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_long_term_tasks', filter: `group_id=eq.${groupId}` }, changed)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_long_term_tasks' }, taskDeleted)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_members', filter: `group_id=eq.${groupId}` }, accessChanged)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_members' }, accessChanged)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_group_deputy_requests', filter: `group_id=eq.${groupId}` }, accessChanged)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_group_deputy_requests' }, accessChanged)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'study_groups', filter: `id=eq.${groupId}` }, accessChanged)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'study_groups' }, groupDeleted)
      .subscribe()
    const refresh = () => { void reload() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    const backstop = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 60_000)
    return () => {
      if (timer) clearTimeout(timer)
      clearInterval(backstop)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
      void supabase.removeChannel(channel).catch(() => undefined)
    }
  }, [active, groupId, currentUserId, scope, reload])

  // Mask the old workspace synchronously, before the effect for the new one.
  return {
    tasks: state.scope === scope && active ? state.tasks : [],
    loading: active && (state.scope !== scope || state.loading),
    error: state.scope === scope && active ? state.error : '',
    reload,
  }
}
