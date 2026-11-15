import { useEffect, useMemo, useState } from 'react'
import { BookOpen, GraduationCap, Moon, Sun, Users } from 'lucide-react'
import { useTheme } from '../../context/ThemeContext'
import { supabaseTeachingRepository } from '../../lib/teaching'
import { createSupabaseTeachingTestRepository } from '../../lib/teachingTests'
import { createSupabaseTeachingCourseModuleRepository, lectureVideoDuration } from '../../lib/teachingCourseModules'
import { AcademicReleaseNotice } from './AcademicReleaseNotice'
import { TeachingWorkspace } from './TeachingWorkspace'
import { GroupTeachingPanel } from './GroupTeachingPanel'
import { TeachingButton } from './TeachingUI'
import { TeachingGroupTests } from './TeachingTestRunner'
import './teaching.css'
import './teaching-workflow.css'

type Role = 'teacher' | 'student' | 'head' | 'other'
type Configuration = { courseId: string; groupId: string; otherGroupId: string; examControls?: boolean; lectureCourse?: boolean; richTests?: boolean; roles: Record<Role, { userId: string; fullName: string }> }
const labels: Record<Role, string> = { teacher: 'Викладачка', student: 'Марія · починає курс', head: 'Андрій · є перевірена робота', other: 'Данило · інша група' }
export function LocalTeachingCourseModulesPreview() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null), [error, setError] = useState('')
  const [role, setRole] = useState<Role>(() => { const value = sessionStorage.getItem('xelay-course-modules-preview-role'); return value && value in labels ? value as Role : 'teacher' })
  const { theme, toggleTheme } = useTheme()
  const repository = useMemo(() => ({ ...supabaseTeachingRepository, mode: 'local' as const }), [])
  const tests = useMemo(() => createSupabaseTeachingTestRepository(), [])
  const identity = configuration?.roles[role]
  const actor = identity?.userId
  const modules = useMemo(() => {
    const base = createSupabaseTeachingCourseModuleRepository()
    if (!configuration?.lectureCourse || !actor) return base
    return {
      ...base,
      async uploadLecture(courseId, userId, file, onProgress, signal) {
        if (courseId !== configuration.courseId || userId !== actor || role !== 'teacher') throw Error('LOCAL_PREVIEW_ONLY')
        const duration_seconds = await lectureVideoDuration(file, signal)
        onProgress?.(10)
        const query = new URLSearchParams({ actor, name: file.name })
        const response = await fetch(`/__course-modules/lecture-upload?${query}`, { method: 'POST', body: file, signal })
        const data = await response.json()
        if (!response.ok || !data.file) throw Error('Не вдалося завантажити локальне відео.')
        onProgress?.(100)
        return { file: data.file, duration_seconds }
      },
      async lectureUrl(file) {
        const response = await fetch('/__course-modules/lecture-url', { method: 'POST', body: JSON.stringify({ actor, storagePath: file.storage_path }) })
        const data = await response.json()
        if (!response.ok || typeof data.url !== 'string') throw Error('COURSE_LECTURE_LOCKED')
        return data.url
      },
    } satisfies ReturnType<typeof createSupabaseTeachingCourseModuleRepository>
  }, [configuration?.lectureCourse, configuration?.courseId, actor, role])
  useEffect(() => {
    let active = true
    void fetch('/__course-modules/config').then(response => { if (!response.ok) throw Error('Не вдалося відкрити локальний приклад.'); return response.json() }).then(data => { if (active) setConfiguration(data) }).catch(failure => { if (active) setError(failure.message) })
    return () => { active = false }
  }, [])
  function choose(next: Role) { sessionStorage.setItem('xelay-course-modules-preview-role', next); setRole(next) }
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto max-w-7xl px-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-primary">Xelay · Локальний перегляд</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{configuration?.richTests ? 'Тести з формулами, фото й звітами' : configuration?.lectureCourse ? 'Від лекції до результату' : configuration?.examControls ? 'Тести з кодом і випадковими варіантами' : 'Курс, який веде крок за кроком'}</h1></div><TeachingButton onClick={toggleTheme}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}{theme === 'light' ? 'Темна тема' : 'Світла тема'}</TeachingButton></div>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">{configuration?.richTests ? 'Як викладачка відкрийте чернетку для вставки з Word або «Результати · дві здані роботи» для експорту. Як Марія відкрийте «Математика · формули та графіки» і почніть тест на весь екран.' : configuration?.lectureCourse ? 'Подивіться статистику як викладачка або оберіть Марію, щоб переглянути коротке відео, пройти тест і відкрити другу лекцію.' : configuration?.examControls ? 'У «Контрольна · код і випадкові варіанти» відкрийте «Код доступу». Потім оберіть Марію або Андрія, відкрийте ту саму контрольну та введіть код.' : 'Модулі з наявних матеріалів, завдань і тестів. Прогрес кожного студента та зрозумілі умови переходу.'} Усі люди, роботи й оцінки тут вигадані.</p>
      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Роль у локальному прикладі">{(Object.keys(labels) as Role[]).map(key => <TeachingButton key={key} primary={role === key} onClick={() => choose(key)}>{key === 'teacher' ? <GraduationCap size={16} /> : <Users size={16} />}{configuration?.richTests && key !== 'teacher' ? configuration.roles[key].fullName : labels[key]}</TeachingButton>)}</nav>
      {!configuration?.examControls && !configuration?.richTests && <details className="mt-4 text-sm"><summary className="cursor-pointer text-primary">Як спробувати</summary><div className="mt-3 max-w-4xl space-y-2 rounded-xl border border-border p-4 leading-relaxed">{configuration?.lectureCourse ? <><p>У «Модулі й прогрес» відкрийте статистику першої лекції. Андрій уже переглянув її, здав тест і помилився в одному запитанні.</p><p>Щоб побачити імпорт, відкрийте «Тести», створіть тест і додайте текст або фото. ШІ тут повертає демонстраційне розпізнавання.</p></> : <><p>Як Марія відкрийте конспект і позначте його прочитаним. З’явиться практичне завдання. Напишіть відповідь і здайте роботу.</p><p>Як викладачка відкрийте «Завдання», перевірте відповідь і опублікуйте бал. Від 6 з 10 балів Марії відкриється контрольний тест. Чернетка оцінки доступ не відкриває.</p><p>Андрій уже має опубліковані 8 з 10 і може пройти тест. Данило з іншої групи не бачить цих модулів. У «Модулі й прогрес» можна змінити структуру та подивитися результати окремо для кожного студента.</p></>}</div></details>}
      {error && <p role="alert" className="teaching-error mt-3">{error}</p>}
    </div></header>
    {!configuration || !identity ? <main className="teaching-page"><p role="status">{error || 'Готуємо приклад…'}</p></main> : role === 'teacher'
      ? <TeachingWorkspace key={role} repository={repository} testRepository={tests} moduleRepository={modules} userId={identity.userId} fullName={identity.fullName} initialCourseId={configuration.courseId} initialGroupId={configuration.groupId} initialTab={configuration.examControls || configuration.richTests ? 'tests' : 'modules'} />
      : configuration.richTests ? <main className="teaching-page" key={role}><TeachingGroupTests repository={tests} groupId={role === 'other' ? configuration.otherGroupId : configuration.groupId} userId={identity.userId} /></main>
      : <main className="teaching-page" key={role}><div className="mb-5"><p className="text-sm text-muted-foreground">{identity.fullName}</p><h2 className="mt-1 flex items-center gap-2 text-xl font-semibold"><BookOpen size={20} />{role === 'other' ? 'Інша навчальна група' : 'ЕУБ · навчальний приклад'}</h2></div>{configuration.lectureCourse && <AcademicReleaseNotice userId={identity.userId} audience="student" />}<GroupTeachingPanel view={configuration.lectureCourse ? 'course' : 'schedule'} showAssignments={!configuration.lectureCourse} repository={repository} testRepository={tests} moduleRepository={modules} initialModulesOpen={!configuration.examControls && !configuration.lectureCourse} groupId={role === 'other' ? configuration.otherGroupId : configuration.groupId} userId={identity.userId} canInvite={false} /></main>}
    <footer className="mx-auto max-w-7xl px-5 py-8 text-center text-xs leading-relaxed text-muted-foreground">Це окрема локальна база. Оновлення сторінки зберігає прогрес, доки цей перегляд працює. Робочий Xelay не змінюється.</footer>
  </div>
}
