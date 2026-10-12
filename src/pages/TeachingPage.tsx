import { useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { AuthModal } from '../components/AuthModal'
import { TeacherStatusCard } from '../components/TeacherStatusCard'
import { TeachingWorkspace } from '../components/teaching/TeachingWorkspace'
import { TeachingButton, TeachingEmpty } from '../components/teaching/TeachingUI'
import { useAuth } from '../context/AuthContext'
import { supabaseTeachingRepository } from '../lib/teaching'

export function TeachingPage() {
  const { authUser, xelayUser: user } = useAuth()
  const [showAuth, setShowAuth] = useState(false)
  const search = useSearch({ strict: false }) as { course?: string }
  if (!authUser) return <main className="teaching-page"><TeachingEmpty title="Викладання у Xelay" description="Увійдіть, щоб підключити групи, публікувати завдання та вести журнал балів."><TeachingButton primary onClick={() => setShowAuth(true)}>Увійти</TeachingButton></TeachingEmpty>{showAuth && <AuthModal onClose={() => setShowAuth(false)} />}</main>
  return <>{!user?.isTeacher && <div className="mx-auto w-full max-w-[1180px] px-5 pt-6"><TeacherStatusCard showWorkspaceLink={false} /></div>}<TeachingWorkspace key={`${authUser.id}:${search.course || ''}`} repository={supabaseTeachingRepository} userId={authUser.id} fullName={user?.name || 'Викладач'} initialCourseId={search.course} /></>
}
