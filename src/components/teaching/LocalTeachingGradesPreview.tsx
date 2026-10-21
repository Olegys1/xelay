import { BarChart3, GraduationCap } from 'lucide-react'
import type { TeachingCourse, TeachingGroupData, TeachingOwnGrade } from '../../lib/teaching'
import { TeachingMyGrades } from './TeachingMyGrades'

// This view uses only its in-memory fictional projection. It does not create a
// repository or read, reset or write the existing teaching preview's saved data.
const demoId = (number: number) => `00000000-0000-4000-9000-${String(number).padStart(12, '0')}`
const GROUP_ID = demoId(701)
const semester = 'Осінній семестр 2026'

function course(id: number, title: string, gradingRules: TeachingCourse['grading_rules'], archived = false): TeachingCourse {
  return {
    id: demoId(id), owner_id: demoId(702), university_id: demoId(703), academic_unit_id: demoId(704),
    title, semester: archived ? 'Весняний семестр 2026' : semester,
    starts_on: archived ? '2026-02-01' : '2026-09-01', ends_on: archived ? '2026-06-30' : '2026-12-31',
    grading_rules: gradingRules, archived_at: archived ? '2026-09-01T09:00:00+03:00' : null,
    created_at: '2026-01-20T10:00:00+02:00', updated_at: '2026-10-20T10:00:00+03:00', version: 1, permissions: [],
  }
}

const economics = course(711, 'Економічна теорія', {
  total_max: 100, categories: [{ id: 'seminars', name: 'Семінари', max_points: 40 }, { id: 'exam', name: 'Підсумкова робота', max_points: 60 }],
})
const statistics = course(712, 'Статистика', {
  total_max: 100, categories: [{ id: 'practice', name: 'Практичні роботи', max_points: 60 }, { id: 'test', name: 'Контрольна робота', max_points: 40 }],
})
const mathematics = course(713, 'Вища математика', {
  total_max: 100, categories: [{ id: 'control', name: 'Модульна робота', max_points: 60 }, { id: 'homework', name: 'Домашні роботи', max_points: 40 }],
})
const management = course(714, 'Менеджмент', {
  total_max: 100, categories: [{ id: 'project', name: 'Навчальний проєкт', max_points: 60 }, { id: 'seminars', name: 'Семінари', max_points: 40 }],
})
// The same title in a different semester is a separate course, not a merged sum.
const archivedEconomics = course(715, 'Економічна теорія', {
  total_max: 80, categories: [{ id: 'practice', name: 'Практичні роботи', max_points: 80 }],
}, true)

function grade(id: number, subject: TeachingCourse, title: string, maxPoints: number, score: number | null, category: string, date: string, comment = ''): TeachingOwnGrade {
  return {
    id: demoId(id), course_id: subject.id, group_id: GROUP_ID, activity_id: demoId(id + 100), entry_id: demoId(900 + Number(subject.id.slice(-3))),
    published_score: score, published_comment: comment, published_at: `${date}T15:30:00+03:00`,
    activity_title: title, activity_date: date, max_points: maxPoints, category, course_title: subject.title, grading_rules: subject.grading_rules,
  }
}

const PREVIEW_DATA: TeachingGroupData = {
  courses: [economics, statistics, mathematics, management, archivedEconomics], pending_invites: [], assignments: [], materials: [],
  grades: [
    grade(721, economics, 'Попит і пропозиція', 25, 21, 'seminars', '2026-10-08', 'Добре пояснено, як зміна доходів впливає на попит. Додайте власний приклад.'),
    grade(722, economics, 'Ринкова рівновага', 25, 24, 'seminars', '2026-10-15', 'Переконливий аналіз і зрозумілий графік. Максимум категорії семінарів уже набрано.'),
    grade(723, economics, 'Підсумкова робота з мікроекономіки', 60, 54, 'exam', '2026-10-20'),
    grade(724, statistics, 'Описова статистика', 60, 39, 'practice', '2026-10-14', 'Розрахунки правильні. Варто детальніше пояснити зміст середнього значення.'),
    grade(725, statistics, 'Показники варіації', 40, 26, 'test', '2026-10-19'),
    grade(726, mathematics, 'Модуль: похідна та її застосування', 60, 18, 'control', '2026-10-13', 'Повторіть правила диференціювання. На консультації розберемо типові помилки.'),
    grade(727, mathematics, 'Домашня робота: границі', 20, 0, 'homework', '2026-10-16', 'За цю роботу опубліковано 0 балів. Уточніть із викладачем можливість доопрацювання.'),
    grade(728, mathematics, 'Домашня робота: похідні', 20, 12, 'homework', '2026-10-20'),
    grade(729, management, 'План командного проєкту', 20, null, 'project', '2026-10-18', 'План отримано. Уточніть мету проєкту й розподіл ролей. Числову оцінку ще не опубліковано.'),
    grade(730, archivedEconomics, 'Вступ до економічного аналізу', 20, 16, 'practice', '2026-05-12'),
    grade(731, archivedEconomics, 'Есе: економічні рішення', 20, 16, 'practice', '2026-05-26', 'Архівний результат попереднього семестру.'),
  ],
}

export function LocalTeachingGradesPreview() {
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-4"><span className="font-serif text-3xl tracking-tight">Xelay</span><span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">Локальний приклад · вигадані дані</span></div>
        <a href={window.location.pathname} className="teaching-button"><GraduationCap size={16} aria-hidden="true" />До прикладу викладання</a>
      </div>
    </header>
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6"><span className="teaching-eyebrow"><BarChart3 size={15} aria-hidden="true" />Моя успішність</span><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Усі предмети в одному огляді</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Приклад для однієї навчальної групи: опубліковані бали, відгуки, різні семестри й результати без числової оцінки.</p></div>
      <TeachingMyGrades data={PREVIEW_DATA} groupId={GROUP_ID} onRefresh={async () => {}} />
    </main>
    <footer className="mx-auto max-w-7xl px-4 pb-8 text-center text-xs leading-relaxed text-muted-foreground">Це вигаданий приклад. Дані робочої платформи та збережені дані інших локальних прикладів не змінюються.</footer>
  </div>
}
