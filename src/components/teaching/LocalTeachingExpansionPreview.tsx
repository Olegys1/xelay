import { useMemo, useState } from 'react'
import { ArrowLeft, GraduationCap, RotateCcw, UserRound } from 'lucide-react'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES, resetLocalTeachingPreview, type LocalTeachingRole } from '../../lib/localTeachingRepository'
import { TeachingWorkspace } from './TeachingWorkspace'
import { LocalTeachingSchedulePreview } from './LocalTeachingSchedulePreview'
import { TeachingButton } from './TeachingUI'

const GROUP = '00000000-0000-4000-8000-000000000011'
const COURSE = '00000000-0000-4000-8000-000000000021'

export function LocalTeachingExpansionPreview() {
  const [role, setRole] = useState<LocalTeachingRole>('teacher')
  const [revision, setRevision] = useState(0)
  const [opened, setOpened] = useState<{ groupId: string; courseId: string } | null>(null)
  const [resetting, setResetting] = useState(false)
  const repository = useMemo(() => createLocalTeachingRepository(role), [role, revision])
  const identity = LOCAL_TEACHING_IDENTITIES[role]
  const teacher = role === 'teacher' || role === 'colleague'
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5"><div><span className="font-serif text-3xl">Xelay</span><p className="mt-1 text-xs text-muted-foreground">Локальний перегляд · вигадані дані</p></div><TeachingButton onClick={() => setResetting(value => !value)}><RotateCcw size={15} />Скинути приклад</TeachingButton></div></header>
    <section className="mx-auto max-w-7xl px-5 pt-6" aria-label="Перевірка нових можливостей"><div className="rounded-2xl border border-border bg-card p-5"><h1 className="text-xl font-semibold">Менше повторень. Більше часу на викладання.</h1><p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Одне ДЗ для кількох груп, спільний розклад, доступ колег до вибраних груп і перехід від перевірки роботи до потрібного запису журналу.</p><div className="mt-4 flex flex-wrap gap-2">{([['teacher', 'Власник предмета'], ['colleague', 'Колега · група 1'], ['student', 'Студент групи 1']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={role === id} className={`teaching-button ${role === id ? 'teaching-button-primary' : ''}`} onClick={() => { setRole(id); setOpened(null) }}>{id === 'student' ? <UserRound size={15} /> : <GraduationCap size={15} />}{label}</button>)}</div><p className="mt-3 text-xs leading-relaxed text-muted-foreground">{role === 'colleague' ? 'У цьому прикладі колега має доступ лише до групи 1. Власник може змінити групи й дозволи в налаштуваннях предмета.' : role === 'student' ? 'Студент бачить свої завдання та результати; чернетки оцінок і роботи інших студентів закриті.' : 'У формі нового завдання відмітьте інші групи. Загальний календар відкривається кнопкою «Мій розклад».'}</p>{resetting && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><p className="text-sm">Відновити початкові вигадані дані?</p><div className="flex gap-2"><TeachingButton onClick={() => setResetting(false)}>Скасувати</TeachingButton><TeachingButton primary onClick={() => { resetLocalTeachingPreview(); setRevision(value => value + 1); setOpened(null); setResetting(false) }}>Відновити</TeachingButton></div></div>}</div></section>
    {teacher ? <>{opened && <div className="mx-auto max-w-7xl px-5 pt-5"><TeachingButton onClick={() => setOpened(null)}><ArrowLeft size={15} />До кабінету</TeachingButton><span className="ml-3 text-sm text-muted-foreground">Режим викладача у навчальній групі</span></div>}<TeachingWorkspace key={`${role}:${revision}:${opened?.groupId || ''}`} repository={repository} userId={identity.userId} fullName={identity.fullName} initialCourseId={opened?.courseId || COURSE} initialGroupId={opened?.groupId || GROUP} embedded={Boolean(opened)} onOpenGroup={(groupId, courseId) => setOpened({ groupId, courseId })} /></> : <main className="teaching-page" key={`${role}:${revision}`}><h2 className="mb-5 text-2xl font-semibold">{identity.groupName}</h2><LocalTeachingSchedulePreview groupId={identity.groupId!} userId={identity.userId} canInvite={false} repository={repository} /></main>}
    <footer className="mx-auto max-w-7xl px-5 pb-8 text-center text-xs leading-relaxed text-muted-foreground">Зміни залишаються у цьому браузері. Робоча база, справжні студенти й сповіщення не використовуються.</footer>
  </div>
}
