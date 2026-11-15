import video01 from '../assets/guides/teacher-course-20261104/01.mp4'
import video02 from '../assets/guides/teacher-course-20261104/02.mp4'
import video03 from '../assets/guides/teacher-course-20261104/03.mp4'
import video04 from '../assets/guides/teacher-course-20261104/04.mp4'
import video05 from '../assets/guides/teacher-course-20261104/05.mp4'
import video06 from '../assets/guides/teacher-course-20261104/06.mp4'
import poster01 from '../assets/guides/teacher-course-20261104/01.webp'
import poster02 from '../assets/guides/teacher-course-20261104/02.webp'
import poster03 from '../assets/guides/teacher-course-20261104/03.webp'
import poster04 from '../assets/guides/teacher-course-20261104/04.webp'
import poster05 from '../assets/guides/teacher-course-20261104/05.webp'
import poster06 from '../assets/guides/teacher-course-20261104/06.webp'

export type TeacherVideoGuide = {
  id: string; title: string; description: string; videoUrl: string; posterUrl: string
  durationSeconds: number; manualId: string; steps: readonly string[]; update: string
}

export const TEACHER_VIDEO_GUIDES: readonly TeacherVideoGuide[] = [
  { id: 'course-and-groups', title: 'Створення предмета та додавання груп', description: 'Почніть із предмета, знайдіть потрібні групи та надішліть запрошення.', videoUrl: video01, posterUrl: poster01, durationSeconds: 108, manualId: 'teacher-create-course', steps: ['Створіть предмет і вкажіть навчальний період.', 'Знайдіть групу за назвою та курсом. Звірте старосту.', 'Надішліть запрошення та дочекайтеся підтвердження.'], update: 'Стан надісланих запрошень видно окремо у вкладці «Надіслані запити».' },
  { id: 'assignments-and-materials', title: 'Додавання завдань та матеріалів', description: 'Зберіть умову, файли, строки здачі та адресатів в одному завданні.', videoUrl: video02, posterUrl: poster02, durationSeconds: 214, manualId: 'teacher-assignment-draft', steps: ['Оберіть групу та свій предмет.', 'Додайте завдання, умову, файли або посилання.', 'Перевірте адресатів, строк здачі та бали перед публікацією.'], update: 'Опубліковане ДЗ, прив’язане до пари, також з’являється в «Мій розклад». Файли проходять перевірку вмісту.' },
  { id: 'subgroups-and-labs', title: 'Підгрупи та лабораторні', description: 'Розділіть студентів на підгрупи й команди та надавайте завдання потрібним людям.', videoUrl: video03, posterUrl: poster03, durationSeconds: 128, manualId: 'teacher-audiences', steps: ['Відкрийте «Підгрупи й команди» у потрібній групі.', 'Створіть підгрупи або лабораторні команди та додайте учасників.', 'Під час публікації виберіть адресатів і перевірте склад.'], update: 'Для командної роботи доступна спільна здача. Оцінки кожного студента залишаються особистими.' },
  { id: 'scheduled-publications', title: 'Публікація запланованих завдань', description: 'Підготуйте роботу заздалегідь і задайте час її появи у студентів.', videoUrl: video04, posterUrl: poster04, durationSeconds: 50, manualId: 'teacher-publish-schedule', steps: ['Підготуйте чернетку та перевірте групи.', 'Вкажіть час запланованої публікації.', 'Перевірте стан у «Заплановані» та за потреби змініть план.'], update: 'Час публікації та кінцевий строк здачі є різними налаштуваннями. Перевіряйте обидва.' },
  { id: 'personal-materials', title: 'Додавання власних матеріалів', description: 'Зберігайте свої навчальні файли та відкривайте їх обраним групам.', videoUrl: video05, posterUrl: poster05, durationSeconds: 87, manualId: 'teacher-material-create', steps: ['Відкрийте «Мої матеріали» та додайте матеріал.', 'Завантажте файли або вставте посилання.', 'Налаштуйте доступ обраним групам і перевірте публікацію.'], update: 'Бібліотека «Мої матеріали» доступна окремо від завдань конкретної групи.' },
  { id: 'gradebook', title: 'Робота з журналом', description: 'Виставляйте та перевіряйте бали, а потім публікуйте результати студентам.', videoUrl: video06, posterUrl: poster06, durationSeconds: 63, manualId: 'teacher-journal-create', steps: ['Відкрийте журнал потрібної групи та предмета.', 'Перевірте колонки, внесіть бали або позначку «Н».', 'Збережіть, звірте результати та окремо опублікуйте оцінки.'], update: 'Колонки з розкладу тепер додаються автоматично при відкритті журналу. Їх порядок особистий, попередні бали зберігаються.' },
]

export const TEACHER_GUIDE_UPDATES = [
  { title: 'Тести та банк запитань', text: 'Імпорт готових запитань, випадкові варіанти, індивідуальні умови та пробне проходження.', manualId: 'teacher-tests-bank-import', tag: 'Тести' },
  { title: 'Перевірка та бонуси', text: 'Перегляньте відповіді, виправте попередні бали й затвердьте бонуси. Студент бачить результат після публікації.', manualId: 'teacher-tests-review', tag: 'Оцінювання' },
  { title: 'Пари та ДЗ разом', text: 'У «Мій розклад» видно опубліковане ДЗ конкретної пари. З розкладу можна перейти до її колонки журналу.', manualId: 'teacher-calendar', tag: 'Розклад' },
  { title: 'Повідомлення групам', text: 'Повідомте обрані групи про зміни або скасування пари без повторного надсилання кожній людині.', manualId: 'teacher-announcements', tag: 'Спілкування' },
  { title: 'Оцінювання за критеріями', text: 'Додайте критерії до завдання та перевіряйте роботи за спільними правилами.', manualId: 'teacher-rubrics', tag: 'Критерії' },
  { title: 'Листи про важливе', text: 'Нагадування про строки, термінові зміни та викладацькі зведення можна ввімкнути без підписки.', manualId: 'teacher-notifications', tag: 'Безкоштовно' },
] as const

export function teacherGuideManualUrl(id: string) { return `/guides/#teacher/${encodeURIComponent(id)}` }
export function teacherGuideDuration(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` }

export type TeacherGuideProgress = { completed: string[]; lastLesson: string | null }
type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>
const validIds = new Set(TEACHER_VIDEO_GUIDES.map(guide => guide.id))
function progressKey(userId: string) { return `xelay:teacher-guides:v1:${encodeURIComponent(userId)}` }
export function readTeacherGuideProgress(storage: StorageReader | undefined, userId: string): TeacherGuideProgress {
  const empty = { completed: [], lastLesson: null }
  if (!storage || !userId) return empty
  try {
    const raw = storage.getItem(progressKey(userId))
    if (!raw || raw.length > 4096) return empty
    const value = JSON.parse(raw)
    const completed: string[] = Array.isArray(value?.completed) ? value.completed.filter((id: unknown): id is string => typeof id === 'string' && validIds.has(id)) : []
    return { completed: [...new Set(completed)], lastLesson: typeof value?.lastLesson === 'string' && validIds.has(value.lastLesson) ? value.lastLesson : null }
  } catch { return empty }
}
export function saveTeacherGuideProgress(storage: StorageWriter | undefined, userId: string, value: TeacherGuideProgress): boolean {
  if (!storage || !userId) return false
  try { storage.setItem(progressKey(userId), JSON.stringify({ completed: [...new Set(value.completed.filter(id => validIds.has(id)))], lastLesson: value.lastLesson && validIds.has(value.lastLesson) ? value.lastLesson : null })); return true } catch { return false }
}
