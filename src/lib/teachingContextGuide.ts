export const TEACHING_GUIDE_VERSION = '20261105.1'
export const TEACHING_GUIDE_TOPICS = ['overview', 'assignments', 'materials', 'publication-editor', 'tests', 'test-editor', 'test-review', 'grades', 'messages', 'subgroups', 'calendar', 'modules', 'my-materials', 'scheduled', 'requests', 'connections', 'videos'] as const
export type TeachingGuideTopic = typeof TEACHING_GUIDE_TOPICS[number]
export type TeachingGuideProgress = { status: 'active' | 'paused' | 'complete'; step: number }
export type TeachingGuideStep = { id: string; target: string; title: string; text: string; hint?: string }
const progressCache = new Map<string, TeachingGuideProgress | null>()
export const teachingGuideTopic = (value: unknown): value is TeachingGuideTopic => typeof value === 'string' && (TEACHING_GUIDE_TOPICS as readonly string[]).includes(value)
export function teachingGuideKey(userId: string, topic: TeachingGuideTopic, local = false) { return `xelay:teaching-help:${local ? 'preview' : 'account'}:${encodeURIComponent(userId)}:${TEACHING_GUIDE_VERSION}:${topic}` }
export function normalizeTeachingGuideProgress(value: unknown): TeachingGuideProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<TeachingGuideProgress>
  return ['active', 'paused', 'complete'].includes(candidate.status || '') && Number.isInteger(candidate.step) && candidate.step! >= 0 && candidate.step! < 30
    ? { status: candidate.status!, step: candidate.step! } : null
}
export function readTeachingGuideProgress(key: string): TeachingGuideProgress | null {
  if (progressCache.has(key)) return progressCache.get(key) || null
  try { const value = normalizeTeachingGuideProgress(JSON.parse(localStorage.getItem(key) || 'null')); progressCache.set(key, value); return value } catch { return null }
}
export function saveTeachingGuideProgress(key: string, value: TeachingGuideProgress) {
  const valid = normalizeTeachingGuideProgress(value)
  if (!valid) return false
  progressCache.set(key, valid)
  try { localStorage.setItem(key, JSON.stringify(valid)) } catch { /* The current session still remembers the choice. */ }
  return true
}
export const TEACHING_GUIDE_LABELS: Record<TeachingGuideTopic, string> = {
  overview: 'Знайомство з кабінетом', assignments: 'Завдання без плутанини', materials: 'Матеріали для групи', 'publication-editor': 'Підготовка публікації', tests: 'Підготовка тесту', 'test-editor': 'Правила вашого тесту', 'test-review': 'Від відповідей до балів',
  grades: 'Ваш журнал', messages: 'Зв’язок із групами', subgroups: 'Підгрупи та команди', calendar: 'Ваші заняття', modules: 'Навчальний маршрут',
  'my-materials': 'Власна бібліотека', scheduled: 'Заплановані публікації', requests: 'Звернення про бали', connections: 'Підключення груп', videos: 'Відеоуроки',
}
const anchor = (name: string) => `[data-teaching-guide="${name}"]`
const step = (id: string, target: string, title: string, text: string, hint?: string): TeachingGuideStep => ({ id, target, title, text, ...(hint ? { hint } : {}) })
export function teachingGuideSteps(topic: TeachingGuideTopic): TeachingGuideStep[] {
  switch (topic) {
    case 'overview': return [
      step('navigation', anchor('navigation'), 'Усе викладання тут', 'Групи, власні матеріали, розклад і запити мають окремі розділи. Оберіть потрібний, щоб працювати з ним без зайвих переходів.'),
      step('groups', `${anchor('group-list')},${anchor('context')}`, 'Почніть із групи та предмета', 'Одна картка веде до підключеної групи. Усередині оберіть свій предмет: його завдання, тести й журнал залишаються окремими.'),
      step('subject', `${anchor('new-subject')},${anchor('context')}`, 'Предмет створюється один раз', 'Створіть предмет і підключіть до нього потрібні групи. Якщо предмет уже є в картці, відкрийте його замість повторного створення.', 'Підключення почне діяти після прийняття запрошення.'),
      step('roles', anchor('lesson-roles'), 'Вкажіть, які заняття ведете', 'Оберіть лекції, семінари або обидва типи для цього предмета й групи. Тоді ваші пари буде легше відрізнити в особистому розкладі.'),
      step('tools', anchor('classroom-tabs'), 'Далі оберіть свою задачу', 'Дайте завдання, підготуйте тест або відкрийте журнал. У кожному розділі кнопка «Підказки» пояснить саме його дії.'),
    ]
    case 'assignments': return [
      step('create', `${anchor('publication-heading')},${anchor('panel')}`, 'Дайте завдання з чіткою умовою', 'Додайте, що зробити, до якої дати та в якому форматі здати. За потреби прив’яжіть роботу до заняття з розкладу.'),
      step('recipients', `${anchor('publication-list')},${anchor('panel')}`, 'Перевірте отримувачів', 'Групу обрано вище. У редакторі можна уточнити підгрупу чи команду. Завдання й файли отримають лише вибрані студенти.'),
      step('publish', `${anchor('publication-list')},${anchor('publication-heading')}`, 'Чернетка ще не видима студентам', 'Спочатку збережіть чернетку й перевірте умову, термін і файли. Після окремої публікації студенти побачать роботу та зможуть здати відповідь.'),
    ]
    case 'materials': return [
      step('library', `${anchor('publication-heading')},${anchor('panel')}`, 'Додайте матеріал до цієї групи', 'Прикріпіть файл або посилання й коротко поясніть, до якої теми він потрібен. Матеріал можна спочатку залишити чернеткою.'),
      step('files', `${anchor('publication-list')},${anchor('panel')}`, 'Перевірте доступ перед публікацією', 'У редакторі оберіть отримувачів і чи дозволяєте завантаження. Файл стане доступним після перевірки вмісту та збереження матеріалу.'),
      step('reuse', `${anchor('publication-list')},${anchor('publication-heading')}`, 'Група побачить опубліковану версію', 'Опублікуйте підготовлений матеріал або заплануйте показ. Особиста бібліотека у «Мої матеріали» дозволяє використовувати власні ресурси повторно.'),
    ]
    case 'tests': return [
      step('bank', `${anchor('test-bank')},${anchor('test-heading')}`, 'Візьміть готові запитання', 'Відкрийте банк або імпортуйте файл. Перегляньте розпізнані запитання та правильні відповіді перед додаванням до тесту.'),
      step('rules', anchor('test-heading'), 'Задайте зрозумілі правила', 'У конструкторі оберіть час доступу, тривалість, повернення до запитань і особистий допуск. Ці правила студент побачить до початку.'),
      step('variant', `${anchor('test-list')},${anchor('test-heading')}`, 'Кожному можна видати свій варіант', 'Підготуйте, наприклад, 20 запитань і вкажіть видати 3 випадкових. Після початку особиста добірка зберігається та не змінюється від оновлення сторінки.'),
      step('review', `${anchor('test-list')},${anchor('test-heading')}`, 'Бали спочатку перевіряєте ви', 'Після здавання відкрийте «Відповіді й перевірка». Там є окремі підказки: відповіді, бонуси, чернетки журналу та публікація.'),
    ]
    case 'publication-editor': return [
      step('condition', '[name="publication-body"],[name="publication-title"]', 'Опишіть очікуваний результат', 'Напишіть тему й зрозумілу умову. Студент має одразу зрозуміти, що опрацювати або що саме потрібно здати.'),
      step('audience', '.teaching-audience-fields,[name="publication-group"],.teaching-form', 'Перевірте групу, отримувачів і строк', 'Групу видно в заголовку редактора. За потреби уточніть підгрупи, команди та термін здавання. Вільний термін обирається окремо.'),
      step('files', '.teaching-simple-upload', 'Додайте потрібні файли', 'Файл спочатку завантажується й проходить перевірку вмісту. Зовнішнє посилання можна додати для матеріалів, які зберігаються на Диску чи іншому сервісі.'),
      step('save', '.teaching-form-actions', 'Збережіть або опублікуйте свідомо', 'Чернетка залишиться у вас. Публікація відкриє запис вибраним студентам, а запланований показ відбудеться у вказаний час. Перевірте отримувачів перед підтвердженням.'),
    ]
    case 'test-editor': return [
      step('targets', anchor('test-editor-targets'), 'Оберіть отримувачів тесту', 'Позначте потрібні групи або підгрупи. У допуску можна окремо обмежити початок для конкретного студента до його першої спроби.'),
      step('rules', anchor('test-editor-rules'), 'Два різні часові обмеження', 'Вікно доступу визначає, коли можна зайти в роботу. Тривалість визначає, скільки часу студент має після натискання «Почати тест». Окремі запитання теж можуть мати таймер.'),
      step('variant', anchor('test-editor-variants'), 'З набору можна видати лише частину', 'Впишіть кількість випадкових запитань, наприклад 3 із набору 20. Можна також перемішати запитання й відповіді. Особистий варіант фіксується після початку.'),
      step('publish', anchor('test-editor-save'), 'Перевірте тест перед запуском', 'Збережіть чернетку або перегляньте підтвердження публікації. Після початку студентських спроб запитання фіксуються. Оцінки опублікуєте окремо після перевірки.'),
    ]
    case 'test-review': return [
      step('answers', anchor('review-answers'), 'Звірте відповіді та свої правки', 'Перегляньте попередні бали й відповіді. За потреби змініть оцінку питання та збережіть пояснення. Відкриті відповіді потребують вашої перевірки.'),
      step('close', `${anchor('review-readiness')},${anchor('review-approve')}`, 'Спочатку закінчується приймання', 'Затвердження доступне після останнього терміну тесту, включно з особистими продовженнями. Власник може окремо закрити приймання раніше, коли активних спроб немає.'),
      step('approve', anchor('review-approve'), 'Затвердьте перевірку та бонуси', 'Коли всі правки збережено, підтвердьте перевірку. За остаточними балами й часом Xelay перерахує рейтинг і бонуси, не перевищуючи максимум тесту.'),
      step('transfer', anchor('review-transfer'), 'Передайте й опублікуйте результат', 'Перенесення записує перевірені оцінки в чернетки журналу. Відкрийте журнал і окремо опублікуйте їх: кожен студент побачить свій результат.'),
    ]
    case 'grades': return [
      step('columns', '[aria-label="Заняття з розкладу в журналі"],section[aria-label="Журнал балів"]', 'Заняття підтягуються з розкладу', 'Колонки лекцій і семінарів додаються з розкладу групи. Окремі завдання й тести також мають свої колонки. Наявні бали зберігаються під час звірки.'),
      step('view', '.teaching-journal-view-settings>summary', 'Зробіть журнал зручним для себе', 'Можна приховати лекції або відкрити окремі журнали лекцій і семінарів. Цей вигляд і порядок колонок зберігаються особисто для вас.'),
      step('marks', '.teaching-journal-table,.teaching-mobile-grades', 'Бал, нуль і «Н» означають різне', 'Порожньо означає «ще не оцінено», 0 є результатом, «Н» замінює бал і позначає відсутність. Натисніть клітинку, щоб внести оцінку та особистий коментар.'),
      step('publication', `${anchor('journal-publication')},${anchor('panel')}`, 'Збереження й публікація окремі', 'Чернетку бачать викладачі з доступом до журналу. Оберіть роботу й натисніть «Опублікувати», щоб кожен студент отримав лише свій результат.'),
    ]
    case 'messages': return [
      step('compose', `${anchor('messages-compose')},${anchor('panel')}`, 'Одне повідомлення потрібним групам', 'Напишіть, що змінилося: наприклад, скасування заняття або пояснення до роботи. Оберіть групи, які мають отримати саме це повідомлення.'),
      step('recipients', `${anchor('messages-targets')},${anchor('panel')}`, 'Отримувачів можна уточнити', 'Повідомлення можна адресувати доступній групі чи підгрупі. Перед надсиланням перевірте список, щоб студенти інших занять не отримали зайвого.'),
      step('required', `${anchor('messages-required')},${anchor('panel')}`, 'Важливе можна підтвердити', 'Якщо потрібне обов’язкове ознайомлення, увімкніть відповідну позначку перед надсиланням. Потім перегляньте підтвердження. Відкриття листа саме по собі підтвердженням не є.'),
    ]
    case 'subgroups': return [
      step('subgroups', `${anchor('subgroups-manage')},${anchor('panel')}`, 'Підгрупа визначає отримувачів', 'Об’єднайте студентів, які навчаються у вас разом, наприклад з іноземної мови. Потім обирайте цю підгрупу в завданнях, тестах і повідомленнях.'),
      step('teams', `${anchor('teams-manage')},${anchor('panel')}`, 'Команда працює над конкретною роботою', 'Для лабораторної оберіть завдання й розподіліть студентів по командах. У командному форматі вони зможуть працювати зі спільною здачею.'),
      step('private', `${anchor('panel')}`, 'Перевірте склад перед збереженням', 'До підгруп і команд додаються учасники цієї групи. Спільна робота не робить особисті оцінки відкритими для одногрупників.'),
    ]
    case 'calendar': return [
      step('roles', '.teaching-lesson-role-settings,.teaching-calendar', 'Позначте, що ведете особисто', 'Для предмета й групи оберіть лекції, семінари або обидва типи. Відповідні пари отримають позначку «Веду я».'),
      step('filters', '.teaching-calendar-toolbar', 'Дивіться потрібний тиждень', 'Змінюйте дату, предмет і групу. «Лише пари, які веду я» залишає ваші заняття, а загальний розклад студентів від цього не змінюється.'),
      step('homework', '.teaching-calendar-lesson,.teaching-calendar', 'Завдання видно поруч із парою', 'Під заняттям показуються опубліковані завдання групи. Звідси можна відкрити журнал цієї пари без повторного пошуку групи.'),
    ]
    case 'modules': return [
      step('structure', '.tcm-heading', 'Складіть маршрут із готових ресурсів', 'Додайте модуль і приєднайте вже створені матеріали, завдання й тести. Xelay використовує наявні записи, тому окремі копії створювати не потрібно.'),
      step('conditions', '.tcm-builder,.tcm-heading', 'Задайте умови переходу', 'Наступний крок може відкриватися після читання, здавання роботи чи потрібного опублікованого результату. Чернетка оцінки не зараховується як підтверджений бал.'),
      step('progress', '[aria-label="Прогрес студентів"],.tcm-workspace', 'Прогрес рахується для кожного студента', 'У блоці прогресу видно завершені кроки доступних вам груп. Публікація модуля не публікує автоматично чернетки його матеріалів або тестів.'),
    ]
    case 'my-materials': return [
      step('library', anchor('view-content'), 'Зберігайте власні ресурси тут', 'Додайте матеріал до своєї бібліотеки, щоб використовувати його в різних предметах і групах. Саме збереження не надсилає його студентам.'),
      step('share', anchor('view-content'), 'Оберіть, кому відкрити матеріал', 'Перевірте групи, файли та дозвіл на завантаження. Після публікації ресурс з’явиться у вибраних отримувачів.'),
    ]
    case 'scheduled': return [
      step('queue', anchor('view-content'), 'Перегляньте майбутні публікації', 'Тут зібрані роботи й матеріали з відкладеним показом. Перевірте дату та групу перед запланованим часом.'),
      step('edit', anchor('view-content'), 'Змінюйте план до публікації', 'Відкрийте потрібний запис, щоб уточнити умову чи час. Збережіть зміни, а після публікації шукайте його у відповідному розділі групи.'),
    ]
    case 'requests': return [
      step('request', anchor('view-content'), 'Студент може уточнити свій результат', 'Тут зібрані звернення про бали з ваших доступних груп. Відкрийте звернення, щоб звірити роботу та залишити відповідь.'),
      step('journal', anchor('view-content'), 'Оцінка змінюється через журнал', 'Якщо результат потрібно виправити, перейдіть до відповідної клітинки журналу. Пояснення зміни залишиться в історії, а студент побачить опублікований результат.'),
    ]
    case 'connections': return [
      step('pending', anchor('view-content'), 'Перевірте стан запрошень', 'Поки староста чи викладач не прийняв запит, робота з групою ще не почалася. Відкрийте предмет, щоб перевірити отримувача й підключення.'),
      step('next', anchor('view-content'), 'Не створюйте предмет повторно', 'Ваш предмет уже збережено. Дочекайтеся підтвердження або скасуйте помилковий запит і надішліть новий потрібній групі.'),
    ]
    case 'videos': return [
      step('lessons', anchor('view-content'), 'Короткі відео за вашою задачею', 'Оберіть урок про предмети, завдання, команди, матеріали чи журнал. Можна одразу перейти до потрібної теми.'),
      step('instructions', anchor('view-content'), 'Інструкція залишається поруч', 'У картці уроку є пов’язані актуальні інструкції. Підказки в самому кабінеті можна повторити в будь-який момент.'),
    ]
  }
}
