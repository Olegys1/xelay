import { useEffect, useMemo, useState } from 'react'
import { BookOpen, GraduationCap, Mail, Presentation, UserRound } from 'lucide-react'
import { TeachingWorkspace } from './TeachingWorkspace'
import { createLocalTeachingRepository, enableLocalTeachingSemesterPreview, LOCAL_TEACHING_IDENTITIES } from '../../lib/localTeachingRepository'
import { LocalAcademicProfilePreview } from '../LocalAcademicProfilePreview'
import { LocalGroupPresentationsPreview } from '../LocalGroupPresentationsPreview'
import { AuthModal } from '../AuthModal'
import type { MaterialAttachment } from '../../lib/studyGroupMaterialFiles'

async function localPresentationDownload(file: MaterialAttachment, blobUrl: string): Promise<string> {
  const bytes = await (await fetch(blobUrl)).arrayBuffer()
  const response = await fetch('/__xelay-preview-download', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Xelay-File-Name': encodeURIComponent(file.file_name) } })
  if (!response.ok) throw new Error('Не вдалося підготувати локальний файл. Повторіть спробу.')
  const result = await response.json() as { url: string }
  return new URL(result.url, window.location.origin).href
}

export function LocalAcademicUsabilityPreview() {
  const [view, setView] = useState<'teaching' | 'profile' | 'presentations'>('teaching')
  const [registration, setRegistration] = useState<'email' | 'google' | null>(null)
  const repository = useMemo(() => { enableLocalTeachingSemesterPreview(); return createLocalTeachingRepository('teacher') }, [])
  const identity = LOCAL_TEACHING_IDENTITIES.teacher
  useEffect(() => { document.documentElement.classList.add('dark') }, [])
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card px-5 py-5"><div className="mx-auto max-w-[1180px]">
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="font-serif text-3xl">Xelay</span><span className="text-xs text-muted-foreground">Локальний приклад · вигадані дані</span></div>
      <h1 className="mt-5 text-2xl font-semibold">Усе потрібне для занять — ближче</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Кафедри, зрозумілі семестри, відомість за балами, надіслані запити та презентації одногрупників.</p>
      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Нові можливості Xelay">
        {([['teaching', 'Кабінет викладача', GraduationCap], ['profile', 'Профіль і кафедра', UserRound], ['presentations', 'Презентації групи', Presentation]] as const).map(([id, title, Icon]) => <button key={id} type="button" className={`teaching-button ${view === id ? 'teaching-button-primary' : ''}`} aria-pressed={view === id} onClick={() => setView(id)}><Icon size={16} />{title}</button>)}
      </nav>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4"><p className="text-xs text-muted-foreground">Переглянути реальну форму реєстрації без країни:</p><button type="button" className="teaching-button" onClick={() => setRegistration('email')}><Mail size={15} />Email</button><button type="button" className="teaching-button" onClick={() => setRegistration('google')}>Google</button></div>
    </div></header>
    {view === 'teaching' ? <><div className="mx-auto max-w-[1180px] px-5 pt-5"><p className="teaching-note"><BookOpen size={15} className="mr-2 inline" />У журналі відкрийте «Для відомості». Попередній семестр і надіслані запити можна відкрити окремими кнопками.</p></div><TeachingWorkspace repository={repository} userId={identity.userId} fullName={identity.fullName} /></> : <main className="mx-auto max-w-[1180px] px-5 py-7">{view === 'profile' ? <LocalAcademicProfilePreview /> : <LocalGroupPresentationsPreview downloadTransport={localPresentationDownload} />}</main>}
    <footer className="mx-auto max-w-[1180px] px-5 py-7 text-center text-xs text-muted-foreground">Робоча база відключена. Нові акаунти тут не створюються. Зміни прикладу залишаються на цьому комп’ютері.</footer>
    {registration && <AuthModal key={registration} onClose={() => setRegistration(null)} {...(registration === 'google' ? { googleCompletion: { userId: '00000000-0000-4000-8000-000000000991', email: 'student@example.test', name: 'Марія Прикладенко' } } : {})} />}
  </div>
}
