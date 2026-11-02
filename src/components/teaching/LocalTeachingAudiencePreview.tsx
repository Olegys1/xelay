import { useEffect, useMemo, useState } from 'react'
import { GraduationCap, RotateCcw, Users } from 'lucide-react'
import { LOCAL_TEACHING_IDENTITIES, type LocalTeachingRole } from '../../lib/localTeachingRepository'
import { teachingError } from '../../lib/teaching'
import { createLocalTeachingAudienceRepository, prepareLocalTeachingAudiencePreview, resetLocalTeachingAudiencePreview, LOCAL_AUDIENCE_COURSE, LOCAL_AUDIENCE_GROUP } from '../../lib/localTeachingAudienceRepository'
import { TeachingWorkspace } from './TeachingWorkspace'
import { GroupTeachingPanel } from './GroupTeachingPanel'
import { TeachingButton } from './TeachingUI'
import './teaching.css'
import './teaching-workflow.css'

const ROLES: { id: LocalTeachingRole; label: string }[] = [
  { id: 'teacher', label: 'Викладачка' }, { id: 'student', label: 'Марія · підгрупа 1' },
  { id: 'head', label: 'Андрій · підгрупа 2' }, { id: 'colleague', label: 'Колега · одна група' },
]
export function LocalTeachingAudiencePreview() {
  const [role, setRole] = useState<LocalTeachingRole>('teacher'), [revision, setRevision] = useState(0), [confirmReset, setConfirmReset] = useState(false)
  const [view, setView] = useState<'schedule' | 'materials'>('schedule')
  const [preparation, setPreparation] = useState({ revision: -1, ready: false, error: '' })
  useEffect(() => {
    let active = true
    void prepareLocalTeachingAudiencePreview().then(() => { if (active) setPreparation({ revision, ready: true, error: '' }) }, error => { if (active) setPreparation({ revision, ready: false, error: teachingError(error) }) })
    return () => { active = false }
  }, [revision])
  const repository = useMemo(() => createLocalTeachingAudienceRepository(role), [role, revision])
  const identity = LOCAL_TEACHING_IDENTITIES[role], staff = role === 'teacher' || role === 'colleague'
  return <div className="min-h-screen bg-background text-foreground" data-local-audience-preview>
    <header className="border-b border-border bg-card">
      <div className="mx-auto max-w-7xl px-5 py-7">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary">Xelay · Локальний перегляд</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Предмет, групи та підгрупи</h1></div><TeachingButton onClick={() => setConfirmReset(value => !value)}><RotateCcw size={15} />Почати заново</TeachingButton></div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">Повідомлення для обраних груп, завдання для підгруп і спільна робота лабораторної команди. Усі імена й дані в цьому прикладі вигадані.</p>
        <nav aria-label="Перевірити роль" className="mt-5 flex flex-wrap gap-2">{ROLES.map(item => <TeachingButton key={item.id} primary={role === item.id} onClick={() => setRole(item.id)}>{item.id === 'teacher' || item.id === 'colleague' ? <GraduationCap size={16} /> : <Users size={16} />}{item.label}</TeachingButton>)}</nav>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Марія бачить матеріал для підгрупи 1, Андрій його не бачить. Обоє входять до лабораторної команди «Рівновага» й мають одну спільну роботу.</p>
        {confirmReset && <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border p-4"><p className="flex-1 text-sm">Відновити початкові дані тільки цього локального прикладу?</p><TeachingButton onClick={() => setConfirmReset(false)}>Скасувати</TeachingButton><TeachingButton primary onClick={() => { resetLocalTeachingAudiencePreview(); setRevision(n => n + 1); setConfirmReset(false) }}>Відновити приклад</TeachingButton></div>}
      </div>
    </header>
    {preparation.revision !== revision || !preparation.ready ? <main className="teaching-page"><p role="status">{preparation.error || 'Готуємо локальний приклад…'}</p></main> : staff ? <TeachingWorkspace key={`${role}:${revision}`} repository={repository} userId={identity.userId} fullName={identity.fullName} initialCourseId={LOCAL_AUDIENCE_COURSE} initialGroupId={LOCAL_AUDIENCE_GROUP} /> : <main className="teaching-page" key={`${role}:${revision}`}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm text-muted-foreground">{identity.fullName}</p><h2 className="mt-1 text-2xl font-semibold">Економіка · група 1</h2></div><div className="flex gap-2"><TeachingButton primary={view === 'schedule'} onClick={() => setView('schedule')}>Завдання та повідомлення</TeachingButton><TeachingButton primary={view === 'materials'} onClick={() => setView('materials')}>Матеріали</TeachingButton></div></div>
      <GroupTeachingPanel repository={repository} groupId={LOCAL_AUDIENCE_GROUP} userId={identity.userId} canInvite={false} view={view} />
    </main>}
    <footer className="mx-auto max-w-7xl px-5 pb-10 pt-5 text-center text-xs leading-relaxed text-muted-foreground">Збереження працює тільки в цьому браузері. Робочий Xelay, його база та справжні сповіщення не використовуються.</footer>
  </div>
}
