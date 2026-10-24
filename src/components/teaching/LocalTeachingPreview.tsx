import { useMemo, useState } from 'react'
import { BookOpen, GraduationCap, MessageCircle, RotateCcw, Settings2, ShieldCheck, UserRound, UsersRound } from 'lucide-react'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES, resetLocalTeachingPreview, type LocalTeachingRole } from '../../lib/localTeachingRepository'
import { TeachingWorkspace } from './TeachingWorkspace'
import { LocalTeachingSchedulePreview } from './LocalTeachingSchedulePreview'
import { LocalTeachingGradesPreview } from './LocalTeachingGradesPreview'
import { TeachingButton, TeachingModal, teachingInput } from './TeachingUI'
import { TeacherGroupPage } from './TeacherGroupPage'
import { GroupMaterials } from '../GroupMaterials'
import { ToastProvider } from '../../context/ToastContext'
import { LegalPage } from '../../pages/LegalPage'
import { TeacherAcademicApproval, TeacherAcademicSettings } from '../TeacherAcademicSettings'
import { TeacherPublicContacts } from '../TeacherPublicContacts'
import { createLocalTeacherAcademicRepository, teacherPositionLabel, type TeacherContactProjection } from '../../lib/teacherAcademicProfile'
import { createLocalAcademicContactRepository, type AcademicConversationContext } from '../../lib/academicContacts'
import { AcademicStudentIdentity, GroupTeacherContacts } from './GroupTeacherContacts'

const ROLES: { id: LocalTeachingRole; label: string; icon: typeof GraduationCap }[] = [
  { id: 'teacher', label: 'Викладач', icon: GraduationCap },
  { id: 'colleague', label: 'Інший викладач', icon: GraduationCap },
  { id: 'student', label: 'Студент', icon: UserRound },
  { id: 'head', label: 'Староста', icon: UsersRound },
]

export function LocalTeachingPreview() {
  const gradesView = new URLSearchParams(window.location.search).get('view') === 'grades'
  return <ToastProvider>{gradesView ? <LocalTeachingGradesPreview /> : <LocalTeachingPreviewContents />}</ToastProvider>
}

function LocalTeachingPreviewContents() {
  const [role, setRole] = useState<LocalTeachingRole>('teacher')
  const [revision, setRevision] = useState(0)
  const [section, setSection] = useState<'workspace' | 'profile' | 'contacts' | 'approval'>('profile')
  const [, refreshAcademic] = useState(0)
  const [conversation, setConversation] = useState<AcademicConversationContext | null>(null)
  const academicRepository = useMemo(() => createLocalTeacherAcademicRepository(LOCAL_TEACHING_IDENTITIES.teacher.userId, {
    position_code: 'assistant', is_postgraduate: true,
    contact_email: 'teacher@example.org', email_visible_to_groups: true,
    contact_telegram: 'xelay_teacher_demo', requested_valid_until: '2026-12-31',
    approved_valid_until: null, access_period_pending: true,
  }, () => refreshAcademic(value => value + 1)), [revision])
  const academic = academicRepository.snapshot()
  const contactRepository = useMemo(() => createLocalAcademicContactRepository([{
    user_id: academic.user_id, full_name: LOCAL_TEACHING_IDENTITIES.teacher.fullName,
    position: teacherPositionLabel(academic), is_postgraduate: academic.is_postgraduate,
    contact_email: academic.email_visible_to_groups ? academic.contact_email || null : null,
    contact_phone: academic.phone_visible_to_groups ? academic.contact_phone || null : null,
    contact_telegram: academic.telegram_visible_to_groups ? academic.contact_telegram || null : null,
    courses: [{ id: '00000000-0000-4000-8000-000000000021', title: 'Економічна теорія', semester: 'Осінній семестр 2026' }],
  }]), [academic.updated_at, revision])
  const publicContacts = useMemo(() => async (): Promise<TeacherContactProjection> => ({
    user_id: academic.user_id, verified: true, position_code: academic.position_code,
    position: teacherPositionLabel(academic), is_postgraduate: academic.is_postgraduate,
    contact_email: academic.email_visible_public ? academic.contact_email || null : null,
    contact_phone: academic.phone_visible_public ? academic.contact_phone || null : null,
    contact_telegram: academic.telegram_visible_public ? academic.contact_telegram || null : null,
  }), [academic.updated_at, revision])
  const [view, setView] = useState<'schedule' | 'materials'>('schedule')
  const [resetOpen, setResetOpen] = useState(false)
  const [openedGroup, setOpenedGroup] = useState<{ groupId: string; courseId: string } | null>(null)
  const repository = useMemo(() => createLocalTeachingRepository(role), [role, revision])
  const identity = LOCAL_TEACHING_IDENTITIES[role]
  const isTeacher = role === 'teacher' || role === 'colleague'
  if (new URLSearchParams(window.location.search).get('legal') === 'terms') return <LegalPage kind="terms" backHref={window.location.pathname} backLabel="До локального прикладу" />
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-4"><span className="font-serif text-3xl tracking-tight">Xelay</span><span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">Локальний приклад · вигадані дані</span></div>
        <TeachingButton onClick={() => setResetOpen(!resetOpen)}><RotateCcw size={15} />Скинути приклад</TeachingButton>
      </div>
    </header>
    <section className="mx-auto max-w-7xl px-4 pb-2 pt-6 sm:px-6" aria-label="Перегляд ролей">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Переглянути як</p><div className="mt-2 flex flex-wrap gap-2">{ROLES.map(item => <button key={item.id} type="button" aria-pressed={role === item.id} onClick={() => { setRole(item.id); setView('schedule'); setSection('workspace'); setOpenedGroup(null) }} className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${role === item.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}><item.icon size={16} />{item.label}</button>)}</div></div>
        <div className="max-w-md text-xs leading-relaxed text-muted-foreground"><p className="font-medium text-foreground">{identity.fullName}</p><p className="mt-1">{role === 'colleague' ? 'Запросіть цього викладача з основного акаунта, потім прийміть запрошення тут і перевірте вибрані дозволи.' : role === 'teacher' ? 'Відкрийте групу: ДЗ групи 1 і групи 2 вже різне. Перегляньте здані роботи, матеріали й журнал. Потім перемкніться на студента, щоб відкрити його власну роботу.' : role === 'head' ? 'Староста підключає викладача та бачить свої результати. Приклад власної роботи повернуто на доопрацювання.' : 'Відкрийте «Моя робота»: тут є зданий приклад. Чернетки, роботи та бали інших студентів приховані.'}</p></div>
      </div>
      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Нові можливості викладання">
        {([
          ['workspace', 'Завдання та журнал', BookOpen], ['profile', 'Профіль і контакти', Settings2],
          ['contacts', 'Зв’язок у групі', MessageCircle], ['approval', 'Погодження строку', ShieldCheck],
        ] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium ${section === id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card hover:bg-muted'}`}><Icon size={16} />{label}</button>)}
      </nav>
      {resetOpen && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-4"><p className="text-sm">Відновити початкові вигадані дані? Локальні зміни та завантажені файли буде прибрано.</p><div className="flex gap-2"><TeachingButton onClick={() => setResetOpen(false)}>Скасувати</TeachingButton><TeachingButton primary onClick={() => { resetLocalTeachingPreview(); setRevision(value => value + 1); setConversation(null); setResetOpen(false) }}>Відновити приклад</TeachingButton></div></div>}
    </section>
    {section === 'profile' && <main className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <TeacherAcademicSettings key={revision} repository={academicRepository} accountId={academic.user_id} />
      <aside className="space-y-5"><section className="teaching-card"><span className="teaching-eyebrow"><UserRound size={15} />Відкритий профіль</span><h2 className="mt-2 text-lg font-semibold">{LOCAL_TEACHING_IDENTITIES.teacher.fullName}</h2><p className="mt-1 text-xs text-muted-foreground">Кафедра економічної теорії · КНУ</p><TeacherPublicContacts teacherId={academic.user_id} load={publicContacts} /><p className="mt-4 text-xs leading-relaxed text-muted-foreground">Збережіть налаштування ліворуч. Тут з’являться тільки контакти з дозволом для відкритого профілю.</p></section><section className="teaching-card"><h2 className="font-semibold">Як це побачить група</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Контакти для групи можуть відрізнятися від відкритого профілю. Перейдіть у «Зв’язок у групі», щоб переглянути їх.</p><div className="mt-4"><TeachingButton onClick={() => setSection('contacts')}>Відкрити зв’язок у групі</TeachingButton></div></section></aside>
    </main>}
    {section === 'contacts' && <main className="teaching-page"><header className="teaching-heading"><div><span className="teaching-eyebrow"><UsersRound size={15} />Економіка · група 1</span><h1>Зв’язок із викладачами</h1><p>Так цей блок виглядатиме для студента у своїй навчальній групі.</p></div></header><GroupTeacherContacts groupId={LOCAL_TEACHING_IDENTITIES.student.groupId!} userId={LOCAL_TEACHING_IDENTITIES.student.userId} repository={contactRepository} onOpenConversation={(_id, context) => setConversation({ ...context, contexts: context.contexts.map(item => ({ ...item, student_name: LOCAL_TEACHING_IDENTITIES.student.fullName, student_id: LOCAL_TEACHING_IDENTITIES.student.userId, group_name: LOCAL_TEACHING_IDENTITIES.student.groupName!, study_year: 1 })) })} /></main>}
    {section === 'approval' && <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6"><header className="mb-5"><span className="teaching-eyebrow"><ShieldCheck size={15} />Перегляд адміністратора</span><h1 className="mt-2 text-2xl font-semibold">Погодження строку викладання</h1><p className="mt-2 text-sm text-muted-foreground">{LOCAL_TEACHING_IDENTITIES.teacher.fullName} · {teacherPositionLabel(academic)}{academic.is_postgraduate ? ' · Аспірант' : ''}</p></header><TeacherAcademicApproval requestedUntil={academic.requested_valid_until} approvedUntil={academic.approved_valid_until} pending={academic.access_period_pending} onApprove={async until => { await academicRepository.approve(until) }} /><p className="mt-4 text-xs leading-relaxed text-muted-foreground">У цьому прикладі рішення змінює лише вигаданий профіль. У робочій платформі погодження доступне адміністратору.</p></main>}
    {section === 'workspace' && (isTeacher ? openedGroup ? <TeacherGroupPage key={`${role}:${revision}:${openedGroup.groupId}:${openedGroup.courseId}`} repository={repository} userId={identity.userId} fullName={identity.fullName} groupId={openedGroup.groupId} courseId={openedGroup.courseId} onBack={() => setOpenedGroup(null)} /> : <TeachingWorkspace key={`${role}:${revision}`} repository={repository} userId={identity.userId} fullName={identity.fullName} onOpenGroup={(groupId, courseId) => setOpenedGroup({ groupId, courseId })} /> : <main className="teaching-page" key={`${role}:${revision}`}>
      <header className="teaching-heading"><div><span className="teaching-eyebrow"><UsersRound size={15} />Навчальна група</span><h1>{identity.groupName}</h1><p>Економічна теорія · осінній семестр · локальний приклад</p></div></header>
      <div className="teaching-tabs mb-5" aria-label="Розділи навчальної групи">{([['schedule', 'Розклад і ДЗ', BookOpen], ['materials', 'Матеріали', GraduationCap]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}><Icon size={16} />{label}</button>)}</div>
      {view === 'materials' ? <GroupMaterials groupId={identity.groupId!} currentUserId={identity.userId} canEdit={false} teachingRepository={repository} /> : <LocalTeachingSchedulePreview groupId={identity.groupId!} userId={identity.userId} canInvite={role === 'head'} repository={repository} />}
    </main>)}
    {conversation && <LocalAcademicChat context={conversation} onClose={() => setConversation(null)} />}
    <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-center text-xs leading-relaxed text-muted-foreground">Зміни зберігаються тільки в цьому браузері. Цей приклад не створює акаунтів, не надсилає сповіщень і не змінює робочий Xelay.</footer>
  </div>
}

function LocalAcademicChat({ context, onClose }: { context: AcademicConversationContext; onClose: () => void }) {
  const [text, setText] = useState('')
  const [messages, setMessages] = useState<string[]>([])
  const identity = context.contexts[0]
  return <TeachingModal title="Звернення до викладача" description="Локальний приклад переписки на вигаданих даних." onClose={onClose}>
    {identity && <><p className="mb-3 text-sm text-muted-foreground">Викладач: {identity.teacher_name}. Так виглядатимуть відомості про студента у переписці:</p><AcademicStudentIdentity context={identity} /></>}
    <div className="my-4 space-y-2" aria-live="polite">{messages.map((message, index) => <p key={index} className="ml-6 whitespace-pre-wrap break-words rounded-xl bg-primary/10 p-3 text-sm">{message}</p>)}</div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (text.trim()) { setMessages(current => [...current, text.trim()]); setText('') } }}>
      <label className="block text-sm font-medium">Повідомлення<textarea className={`${teachingInput} mt-2`} rows={3} maxLength={2000} value={text} onChange={event => setText(event.target.value)} placeholder="Добрий день! Підкажіть, будь ласка…" /></label>
      <TeachingButton primary type="submit" disabled={!text.trim()}>Надіслати у локальному прикладі</TeachingButton>
      <p className="text-xs text-muted-foreground">Повідомлення залишається тільки тут і нікому не надсилається.</p>
    </form>
  </TeachingModal>
}
