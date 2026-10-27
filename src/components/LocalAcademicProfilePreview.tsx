import { useMemo, useState } from 'react'
import { AcademicDepartmentSelect } from './AcademicDepartmentSelect'
import { TeacherAcademicSettings } from './TeacherAcademicSettings'
import { KNU_ECONOMICS_DEPARTMENTS } from '../lib/academicDepartments'
import { createLocalTeacherAcademicRepository } from '../lib/teacherAcademicProfile'

/** Fake identity and repository only; never creates an Auth account. */
export function LocalAcademicProfilePreview() {
  const [view, setView] = useState<'profile' | 'registration'>('profile')
  const [role, setRole] = useState<'student' | 'teacher'>('teacher')
  const [department, setDepartment] = useState('')
  const [method, setMethod] = useState<'email' | 'google'>('email')
  const repository = useMemo(() => createLocalTeacherAcademicRepository('local-academic-teacher', {
    department: KNU_ECONOMICS_DEPARTMENTS[3].name,
    department_options: KNU_ECONOMICS_DEPARTMENTS,
    position_code: 'associate_professor', contact_email: 'teacher@example.com',
  }), [])
  const input = 'min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm'
  return <section className="space-y-5" aria-label="Кафедри та профіль без країни">
    <div className="flex flex-wrap gap-2">
      <button type="button" className="teaching-button" aria-pressed={view === 'profile'} onClick={() => setView('profile')}>Профіль викладача</button>
      <button type="button" className="teaching-button" aria-pressed={view === 'registration'} onClick={() => setView('registration')}>Поля реєстрації</button>
    </div>
    <p className="teaching-note">Країну прибрано з реєстрації поштою й через Google, налаштувань та перегляду профілю для всіх користувачів. Старі дані не стираються цією зміною.</p>
    {view === 'profile' ? <TeacherAcademicSettings repository={repository} accountId="local-academic-teacher" /> : <div className="teaching-card space-y-4">
      <header><h3 className="text-lg font-semibold">Реєстрація у Xelay</h3><p className="mt-1 text-xs text-muted-foreground">Локальний приклад змінених полів. Обліковий запис не створюється.</p></header>
      <div className="flex flex-wrap gap-2">{(['email', 'google'] as const).map(value => <button key={value} className="teaching-button" type="button" aria-pressed={method === value} onClick={() => setMethod(value)}>{value === 'email' ? 'Через пошту' : 'Через Google'}</button>)}</div>
      <div className="flex flex-wrap gap-2">{(['student', 'teacher'] as const).map(value => <button key={value} className="teaching-button" type="button" aria-pressed={role === value} onClick={() => setRole(value)}>{value === 'student' ? 'Студент' : 'Викладач'}</button>)}</div>
      <label className="block space-y-1.5 text-sm font-medium">Ім’я та прізвище<input className={input} placeholder="Ваше ім’я та прізвище" /></label>
      <label className="block space-y-1.5 text-sm font-medium">Університет<select className={input} defaultValue="knu"><option value="knu">Київський національний університет імені Тараса Шевченка</option></select></label>
      <label className="block space-y-1.5 text-sm font-medium">Факультет<select className={input} defaultValue="economics"><option value="economics">Економічний факультет</option></select></label>
      {role === 'teacher' && <AcademicDepartmentSelect id="local-register-department" value={department} onChange={setDepartment} options={KNU_ECONOMICS_DEPARTMENTS} required />}
      <label className="block space-y-1.5 text-sm font-medium">{method === 'google' ? 'Пошта, підтверджена Google' : 'Електронна пошта'}<input className={input} type="email" placeholder="name@example.com" /></label>
      <label className="block space-y-1.5 text-sm font-medium">Місто · необов’язково<input className={input} placeholder="Місто" /></label>
      <p className="text-xs text-muted-foreground">В обох способах входу використовується спільна форма Xelay. Поля країни в ній більше немає.</p>
    </div>}
  </section>
}
