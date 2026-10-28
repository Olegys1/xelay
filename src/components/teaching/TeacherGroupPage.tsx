import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, GraduationCap } from 'lucide-react'
import { AuthModal } from '../AuthModal'
import { useAuth } from '../../context/AuthContext'
import { supabaseTeachingRepository, teachingError, type TeachingGroupContext, type TeachingRepository } from '../../lib/teaching'
import { TeachingWorkspace } from './TeachingWorkspace'
import { TeachingButton, TeachingEmpty } from './TeachingUI'
import { useSearch } from '@tanstack/react-router'
import { parseTeachingHomeTarget } from '../../lib/teachingHomeNavigation'

export function TeacherGroupPage({ groupId, courseId, repository = supabaseTeachingRepository, userId: previewUserId, fullName: previewName, onBack }: { groupId: string; courseId?: string; repository?: TeachingRepository; userId?: string; fullName?: string; onBack?: () => void }) {
  const { authUser, xelayUser } = useAuth()
  const target = parseTeachingHomeTarget(useSearch({ strict: false }) as Record<string, unknown>)
  const userId = previewUserId || authUser?.id
  const fullName = previewName || xelayUser?.name || 'Викладач'
  const [context, setContext] = useState<TeachingGroupContext | null>(null)
  const [error, setError] = useState(''), [showAuth, setShowAuth] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setContext(null); setError('')
    if (!userId) return
    void repository.groupContext(groupId).then(data => {
      if (generation.current !== current) return
      if (!data.courses.length || courseId && !data.courses.some(course => course.id === courseId)) throw new Error('TEACHING_FORBIDDEN')
      setContext(data)
    }).catch(failure => { if (generation.current === current) setError(teachingError(failure)) })
    return () => { generation.current++ }
  }, [repository, groupId, courseId, userId, revision])
  if (!userId) return <main className="teaching-page"><TeachingEmpty icon={<GraduationCap size={24} />} title="Група для викладача" description="Увійдіть до свого акаунта викладача. Доступ до предмета відкривається після підтвердження підключення старостою."><TeachingButton primary onClick={() => setShowAuth(true)}>Увійти</TeachingButton></TeachingEmpty>{showAuth && <AuthModal onClose={() => setShowAuth(false)} />}</main>
  return <div className="teaching-page">
    <div className="flex flex-wrap items-center gap-3">{onBack ? <TeachingButton onClick={onBack}><ArrowLeft size={16} />Мої групи</TeachingButton> : <a href="/teaching" className="teaching-button"><ArrowLeft size={16} />Мої групи</a>}<span className="teaching-badge teaching-badge-blue"><GraduationCap size={14} />Режим викладача</span></div>
    {error ? <div className="teaching-card mt-5"><p role="alert" className="teaching-error">{error}</p><div className="mt-4"><TeachingButton onClick={() => setRevision(value => value + 1)}>Оновити доступ</TeachingButton></div></div> : !context ? <div className="mt-5 h-40 animate-pulse rounded-2xl bg-muted/50" role="status" aria-label="Завантаження групи викладача" /> : <>
      <TeachingWorkspace key={`${userId}:${groupId}:${courseId || ''}:${target.home || ''}:${target.date || ''}`} repository={repository} userId={userId} fullName={fullName} initialGroupId={groupId} initialCourseId={courseId || context.courses[0].id} initialHome={target.home} initialDate={target.date} embedded />
    </>}
  </div>
}
