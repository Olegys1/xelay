import { useEffect, useMemo, useState } from 'react'
import { GraduationCap, Moon, RefreshCw, Sun, Users } from 'lucide-react'
import { useTheme } from '../../context/ThemeContext'
import { supabaseTeachingRepository } from '../../lib/teaching'
import { createSupabaseTeachingTestRepository } from '../../lib/teachingTests'
import { TeachingWorkspace } from './TeachingWorkspace'
import { GroupTeachingPanel } from './GroupTeachingPanel'
import { TeachingButton } from './TeachingUI'
import './teaching.css'
import './teaching-workflow.css'

type Role = 'teacher' | 'student' | 'head' | 'other'
type Configuration = { assessment?: boolean; importVariants?: boolean; journalSchedule?: boolean; courseId: string; groupId: string; otherGroupId: string; roles: Record<Role, { userId: string; fullName: string }> }
const labels: Record<Role, string> = { teacher: 'Викладачка', student: 'Марія · студентка', head: 'Андрій · староста', other: 'Студент іншої групи' }

export function LocalTeachingTestsPreview() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [role, setRole] = useState<Role>(() => {
    const saved = sessionStorage.getItem('xelay-test-preview-role')
    return saved && saved in labels ? saved as Role : 'teacher'
  })
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [closing, setClosing] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const repository = useMemo(() => ({ ...supabaseTeachingRepository, mode: 'local' as const }), [])
  const testRepository = useMemo(() => createSupabaseTeachingTestRepository(), [])
  useEffect(() => {
    let active = true
    void fetch('/__test-preview/config').then(response => {
      if (!response.ok) throw new Error('Не вдалося відкрити локальний приклад.')
      return response.json()
    }).then(data => { if (active) setConfiguration(data) }).catch(failure => { if (active) setError(failure.message) })
    return () => { active = false }
  }, [])
  function choose(next: Role) { sessionStorage.setItem('xelay-test-preview-role', next); setRole(next) }
  async function closeExample() {
    setClosing(true); setError('')
    try {
      const response = await fetch('/__test-preview/close', { method: 'POST' })
      if (!response.ok) throw new Error('Не вдалося завершити час прикладу.')
      const result = await response.json()
      if (!result.ok) throw new Error(result.error?.message || 'Спробуйте ще раз.')
      setRevision(value => value + 1)
    } catch (failure) { setError((failure as Error).message) }
    finally { setClosing(false) }
  }
  const identity = configuration?.roles[role]
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card">
      <div className="mx-auto max-w-7xl px-5 py-7">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary">Xelay · Локальний приклад</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{configuration?.journalSchedule ? 'Журнал і завдання з розкладу' : configuration?.assessment ? 'Банк запитань і нові можливості тестів' : 'Тести та журнал викладача'}</h1></div><TeachingButton onClick={toggleTheme}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}{theme === 'light' ? 'Темна тема' : 'Світла тема'}</TeachingButton></div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">{configuration?.journalSchedule ? 'Відкрийте «Журнал»: заняття з розкладу стануть колонками з датою, часом і типом. У «Моєму розкладі» біля кожної пари видно, що задано групі. Для семінарів є шаблон до 7 балів, для решти початковий максимум 5; параметри можна змінювати. Усі люди й дані вигадані.' : configuration?.assessment ? 'Відкрийте «Тести»: у банку вже є вісім прикладів. Можна зібрати особисті варіанти, імпортувати запитання та перевірити розгорнуту відповідь за критеріями. Для Марії налаштовано 30 хвилин замість 20. Усі акаунти й роботи вигадані.' : 'У вкладці «Тести» вже є МКР з 11 зданими роботами для перевірки балів і бонусів. Інший тест можна пройти як студентка. Усі акаунти й роботи цього прикладу вигадані.'}</p>
        {configuration?.importVariants && <section className="mt-4 rounded-xl border border-primary/20 bg-accent/30 p-4">
          <h2 className="font-semibold">Імпорт без ключа, окремі варіанти та послідовність із зайвими елементами</h2>
          <p className="mt-2 text-sm">У тесті «Новий тип і два варіанти · приклад» можна перевірити вибір 3 елементів із 5. Одна вигадана робота вже здана для перегляду назви варіанта. Марія може пройти власну спробу. У редакторі імпортуйте окремий варіант або вставте приклад нижче й самостійно позначте правильні відповіді.</p>
          <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-primary">Текст без правильних відповідей для перевірки імпорту</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-background p-3">{'1. Що допомагає спланувати виконання проєкту?\nА) Список кроків і строків\nБ) Відмова від мети\nВ) Випадковий вибір\nГ) Відкладання без строку\n\n2. Ресурси для виконання роботи можуть бути обмеженими.\nТак / Ні'}</pre>
          </details>
        </section>}
        {configuration?.assessment && <p className="mt-3 flex flex-wrap gap-4 text-sm text-primary"><a href="/assessment-import-example.gift" download>Завантажити приклад GIFT</a><a href="/assessment-import-example.xml" download>Завантажити приклад Moodle XML</a></p>}
        <nav className="mt-5 flex flex-wrap gap-2" aria-label="Роль у локальному прикладі">{(Object.keys(labels) as Role[]).map(item => <TeachingButton key={item} primary={role === item} onClick={() => choose(item)}>{item === 'teacher' ? <GraduationCap size={16} /> : <Users size={16} />}{labels[item]}</TeachingButton>)}</nav>
        <details className="mt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Як перевірити весь шлях за кілька хвилин</summary><div className="mt-3 space-y-3 rounded-xl border border-border p-4"><p>Як викладачка відкрийте «Тести», потім «Відповіді й перевірка» у МКР. Перевірте запитання, підтвердьте перевірку з бонусами та перенесіть результати в чернетки журналу. У журналі можна змінити бал на «Н», переставити колонки й окремо опублікувати оцінки. Марія побачить лише власний опублікований результат.</p><p>Для перевірки здачі перейдіть до Марії та пройдіть відкритий тест з чотирма типами запитань. Коли захочете перевірити й ці відповіді, завершіть час доступу кнопкою нижче.</p><TeachingButton busy={closing} onClick={() => void closeExample()}><RefreshCw size={15} />Завершити час доступу в прикладі</TeachingButton><p className="text-xs text-muted-foreground">Кнопка змінює час лише у вигаданій локальній базі. Нові тести можна створювати далі.</p></div></details>
        {error && <p role="alert" className="teaching-error mt-3">{error}</p>}
      </div>
    </header>
    {!configuration || !identity ? <main className="teaching-page"><p role="status">{error || 'Готуємо приклад…'}</p></main> : role === 'teacher' ? <TeachingWorkspace key={`${role}:${revision}`} repository={repository} testRepository={testRepository} userId={identity.userId} fullName={identity.fullName} initialCourseId={configuration.courseId} initialGroupId={configuration.groupId} /> : <main className="teaching-page" key={`${role}:${revision}`}><div className="mb-5"><p className="text-sm text-muted-foreground">{identity.fullName}</p><h2 className="mt-1 text-2xl font-semibold">{role === 'other' ? 'Інша навчальна група' : 'ЕУБ · навчальний приклад'}</h2></div><GroupTeachingPanel repository={repository} testRepository={testRepository} groupId={role === 'other' ? configuration.otherGroupId : configuration.groupId} userId={identity.userId} canInvite={false} showAssignments={false} /></main>}
    <footer className="mx-auto max-w-7xl px-5 py-8 text-center text-xs leading-relaxed text-muted-foreground">Дані зберігаються в локальній базі, поки цей перегляд запущений. Оновлення сторінки продовжує вашу спробу.</footer>
  </div>
}
