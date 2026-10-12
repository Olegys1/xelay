import { useMemo, useState } from 'react'
import { BookOpen, GraduationCap, RotateCcw, UserRound, UsersRound } from 'lucide-react'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES, resetLocalTeachingPreview, type LocalTeachingRole } from '../../lib/localTeachingRepository'
import { TeachingWorkspace } from './TeachingWorkspace'
import { GroupTeachingPanel } from './GroupTeachingPanel'
import { TeachingButton } from './TeachingUI'

const ROLES: { id: LocalTeachingRole; label: string; icon: typeof GraduationCap }[] = [
  { id: 'teacher', label: 'Викладач', icon: GraduationCap },
  { id: 'colleague', label: 'Інший викладач', icon: GraduationCap },
  { id: 'student', label: 'Студент', icon: UserRound },
  { id: 'head', label: 'Староста', icon: UsersRound },
]

export function LocalTeachingPreview() {
  const [role, setRole] = useState<LocalTeachingRole>('teacher')
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<'schedule' | 'materials'>('schedule')
  const [resetOpen, setResetOpen] = useState(false)
  const repository = useMemo(() => createLocalTeachingRepository(role), [role, revision])
  const identity = LOCAL_TEACHING_IDENTITIES[role]
  const isTeacher = role === 'teacher' || role === 'colleague'
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-4"><span className="font-serif text-3xl tracking-tight">Xelay</span><span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">Локальний приклад · вигадані дані</span></div>
        <TeachingButton onClick={() => setResetOpen(!resetOpen)}><RotateCcw size={15} />Скинути приклад</TeachingButton>
      </div>
    </header>
    <section className="mx-auto max-w-7xl px-4 pb-2 pt-6 sm:px-6" aria-label="Перегляд ролей">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Переглянути як</p><div className="mt-2 flex flex-wrap gap-2">{ROLES.map(item => <button key={item.id} type="button" aria-pressed={role === item.id} onClick={() => { setRole(item.id); setView('schedule') }} className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${role === item.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}><item.icon size={16} />{item.label}</button>)}</div></div>
        <div className="max-w-md text-xs leading-relaxed text-muted-foreground"><p className="font-medium text-foreground">{identity.fullName}</p><p className="mt-1">{role === 'colleague' ? 'Запросіть цього викладача з основного акаунта, потім прийміть запрошення тут і перевірте вибрані дозволи.' : role === 'teacher' ? 'Відкрийте предмет, додайте завдання або виставте бали в журналі. Потім перемкніться на студента, щоб побачити лише опубліковані результати.' : role === 'head' ? 'Староста підключає викладача та бачить свої результати. Чужі бали залишаються приватними.' : 'Студент отримує опубліковані завдання, матеріали й власні бали. Чернетки викладача приховані.'}</p></div>
      </div>
      {resetOpen && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-4"><p className="text-sm">Відновити початкові вигадані дані? Локальні зміни та завантажені файли буде прибрано.</p><div className="flex gap-2"><TeachingButton onClick={() => setResetOpen(false)}>Скасувати</TeachingButton><TeachingButton primary onClick={() => { resetLocalTeachingPreview(); setRevision(value => value + 1); setResetOpen(false) }}>Відновити приклад</TeachingButton></div></div>}
    </section>
    {isTeacher ? <TeachingWorkspace key={`${role}:${revision}`} repository={repository} userId={identity.userId} fullName={identity.fullName} /> : <main className="teaching-page" key={`${role}:${revision}`}>
      <header className="teaching-heading"><div><span className="teaching-eyebrow"><UsersRound size={15} />Навчальна група</span><h1>{identity.groupName}</h1><p>Економічна теорія · осінній семестр · локальний приклад</p></div></header>
      <div className="teaching-tabs mb-5" aria-label="Розділи навчальної групи">{([['schedule', 'Розклад і ДЗ', BookOpen], ['materials', 'Матеріали', GraduationCap]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}><Icon size={16} />{label}</button>)}</div>
      <GroupTeachingPanel groupId={identity.groupId!} userId={identity.userId} canInvite={role === 'head'} view={view} repository={repository} />
    </main>}
    <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-center text-xs leading-relaxed text-muted-foreground">Зміни зберігаються тільки в цьому браузері. Цей приклад не створює акаунтів, не надсилає сповіщень і не змінює робочий Xelay.</footer>
  </div>
}
