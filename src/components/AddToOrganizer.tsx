import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CalendarPlus, Check, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useBilling } from '../context/BillingContext'
import { useToast } from '../context/ToastContext'
import { addOrganizerAssignment, announceOrganizerUpdate, organizerError } from '../lib/organizer'
import { supabase } from '../lib/supabase'
import type { StudyAssignmentShare } from '../lib/studyAssignmentSharing'

type Props = {
  assignment: StudyAssignmentShare
  questionId?: string
  currentUserId: string
}

export function AddToOrganizer({ assignment, questionId, currentUserId }: Props) {
  const navigate = useNavigate()
  const { authUser } = useAuth()
  const { isPremium, isLoading: billingLoading, error: billingError } = useBilling()
  const { notify } = useToast()
  const scope = `${currentUserId}:${authUser?.id || ''}:${assignment.kind}:${assignment.id}:${questionId || ''}`
  const latestScope = useRef(scope)
  latestScope.current = scope
  const alive = useRef(true)
  const sequence = useRef(0)
  const mutationLock = useRef<number | null>(null)
  const [action, setAction] = useState({ scope, busy: false, added: false })
  const busy = action.scope === scope && action.busy
  const added = action.scope === scope && action.added

  useEffect(() => {
    alive.current = true
    mutationLock.current = null
    setAction({ scope, busy: false, added: false })
    return () => { alive.current = false; ++sequence.current; mutationLock.current = null }
  }, [scope])

  const add = async () => {
    if (!authUser || authUser.id !== currentUserId || mutationLock.current !== null || billingLoading) return
    if (billingError) {
      notify({ id: 'organizer-assignment-access', tone: 'error', title: 'Не вдалося перевірити підписку', description: 'Повторіть перевірку підписки або спробуйте трохи пізніше. Завдання не змінено.' })
      return
    }
    if (!isPremium) {
      void navigate({ to: '/subscription' })
      return
    }
    const token = ++sequence.current
    mutationLock.current = token
    setAction({ scope, busy: true, added })
    const isCurrent = () => alive.current && latestScope.current === scope && sequence.current === token
    try {
      const session = await supabase.auth.getSession()
      if (!isCurrent()) return
      if (session.error || session.data.session?.user.id !== currentUserId) {
        notify({ id: 'organizer-assignment-access', tone: 'error', title: 'Перевірте вхід до акаунта', description: 'Оновіть сторінку й повторіть додавання завдання.' })
        return
      }
      await addOrganizerAssignment(assignment.kind, assignment.id, questionId, currentUserId)
      if (!isCurrent()) return
      setAction({ scope, busy: false, added: true })
      announceOrganizerUpdate()
      notify({ id: `organizer-assignment:${assignment.kind}:${assignment.id}:${questionId || ''}`, tone: 'success', title: 'Завдання є у вашому органайзері', description: 'Повторне додавання не створює копій.' })
    } catch (failure) {
      if (isCurrent()) notify({ id: `organizer-assignment:${assignment.kind}:${assignment.id}:${questionId || ''}`, tone: 'error', title: 'Не вдалося додати завдання', description: organizerError(failure) })
    } finally {
      if (mutationLock.current === token) mutationLock.current = null
      if (isCurrent()) setAction((current) => ({ ...current, busy: false }))
    }
  }

  if (!authUser || authUser.id !== currentUserId) return null
  return <button type="button" onClick={() => void add()} disabled={busy || billingLoading}
    aria-label={`Додати ${questionId ? 'вибране питання' : 'завдання'} до органайзера: ${assignment.title}`}
    aria-busy={busy || billingLoading}
    title={billingLoading ? 'Перевіряємо підписку' : added ? 'Завдання вже додано; повторне натискання не створить копії' : undefined}
    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none">
    {busy || billingLoading ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : added ? <Check size={15} aria-hidden="true" /> : <CalendarPlus size={15} aria-hidden="true" />}
    {busy ? 'Додаємо…' : 'До органайзера'}
  </button>
}
