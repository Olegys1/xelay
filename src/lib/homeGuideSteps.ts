export type HomeGuideTarget = 'period' | 'group' | 'schedule' | 'join' | 'tasks' | 'management' | 'updates' | 'empty'
export interface HomeGuideStep { id: string; target: HomeGuideTarget; title: string; text: string; hint?: string }
export interface HomeGuideView {
  teaching: boolean
  management: boolean
  multipleGroups: boolean
  usable: boolean
  joinAvailable: boolean
  role: 'student' | 'headman' | 'teacher'
  state?: 'error' | 'pending'
}

export function homeGuideSteps(view: HomeGuideView): HomeGuideStep[] {
  if (view.state === 'error') return [{ id: 'retry', target: 'empty', title: 'Якщо дані не завантажилися', text: 'Спробуйте оновити сторінку. Без інтернету можна відкрити розклад і ДЗ, які ви заздалегідь зберегли у своїй групі.', hint: 'Після відновлення з’єднання підказки можна запустити ще раз.' }]
  if (view.state === 'pending') return [{ id: 'pending', target: 'empty', title: 'Чекаємо на підтвердження', text: 'Підключення групи ще не завершено. Перевірте стан запиту у своєму кабінеті. Після підтвердження розклад і завдання з’являться тут автоматично.' }]
  if (!view.usable) return [{
    id: 'first-group', target: 'empty', title: view.teaching ? 'Почнімо з ваших груп' : 'Ваш день з’явиться тут',
    text: view.teaching ? 'Відкрийте викладання, додайте предмет і підключіть групи. Після підтвердження їхні заняття й роботи з’являться на головній.'
      : view.role === 'headman' ? 'Створіть свою групу в розділі «Мої групи» та запросіть одногрупників за ніком. Тут з’являться її розклад і домашні завдання.'
      : 'Прийміть запрошення старости у сповіщеннях або в «Мої групи». Розклад, ДЗ та матеріали підтягнуться автоматично.',
    hint: 'Підказки можна повторити після підключення групи.',
  }]
  const steps: HomeGuideStep[] = [{
    id: 'period', target: 'period', title: 'Плануйте свій день',
    text: 'Перемикайте сьогодні, завтра або весь тиждень. Так одразу видно найближчі заняття й завдання.',
    hint: 'Час занять показано за Києвом.',
  }]
  if (view.multipleGroups) steps.push({ id: 'group', target: 'group', title: 'Обирайте потрібну групу', text: 'Залиште всі групи разом або оберіть одну. Розклад, завдання та оновлення нижче підлаштуються під ваш вибір.' })
  steps.push({ id: 'schedule', target: 'schedule', title: view.teaching ? 'Ваші заняття в одному місці' : 'Найближча пара під рукою', text: view.teaching ? 'Тут зібрані заняття ваших підключених груп і предметів. Натисніть «До заняття», щоб відкрити потрібний розділ викладання.' : 'Тут є час, предмет і місце заняття. «Відкрити заняття» покаже його деталі та ДЗ у вашій групі.' })
  if (view.joinAvailable) steps.push({ id: 'join', target: 'join', title: 'На пару одним натисканням', text: '«Приєднатися» одразу відкриває посилання на заняття. Якщо є лише ідентифікатор чи код доступу, їх можна переглянути й скопіювати прямо тут.', hint: 'Повертатися в групу для підключення не потрібно.' })
  steps.push({ id: 'tasks', target: 'tasks', title: view.teaching ? 'Що потребує вашої уваги' : 'Завдання, які важливо не пропустити', text: view.teaching ? 'Тут видно роботи, які чекають перевірки, та приватні звернення студентів про бали. Відкривайте потрібне одразу з картки.' : 'Тут зібрані найближчі ДЗ і терміни здачі. Натисніть на завдання, щоб прочитати умову або відкрити свою роботу.' })
  if (view.management) steps.push({ id: 'management', target: 'management', title: view.teaching ? 'Ваші робочі інструменти' : 'Керуйте групою без зайвих переходів', text: view.teaching ? 'Задавайте ДЗ, оновлюйте власні матеріали й відкривайте журнал. Ці кнопки ведуть до відповідних розділів вашого кабінету.' : 'Додавайте заняття, ДЗ і матеріали та запрошуйте учасників. Показані тільки дії, на які ви маєте дозвіл.' })
  steps.push({ id: 'updates', target: 'updates', title: 'Матеріали та зміни поруч', text: 'Нові матеріали, опубліковані результати та зміни розкладу з’являються тут. Картка відкриває відповідний розділ групи.', hint: 'Кнопка «Підказки» на головній завжди дозволяє пройти цей маршрут ще раз.' })
  return steps
}

export interface GuideRect { left: number; top: number; width: number; height: number }
export function placeHomeGuide(anchor: GuideRect, panel: { width: number; height: number }, viewport: { width: number; height: number; left?: number; top?: number }) {
  const gutter = 14, gap = 13
  const leftEdge = viewport.left || 0, topEdge = viewport.top || 0
  const width = Math.max(1, Math.min(panel.width, viewport.width - gutter * 2))
  const maxHeight = Math.max(1, viewport.height - gutter * 2)
  const height = Math.min(panel.height, maxHeight)
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)))
  const left = clamp(anchor.left + anchor.width / 2 - width / 2, leftEdge + gutter, leftEdge + viewport.width - width - gutter)
  const below = anchor.top + anchor.height + gap
  const above = anchor.top - height - gap
  const side = below + height <= topEdge + viewport.height - gutter || above < topEdge + gutter ? 'below' : 'above'
  const top = clamp(side === 'below' ? below : above, topEdge + gutter, topEdge + viewport.height - height - gutter)
  return { left, top, width, maxHeight: Math.min(maxHeight, topEdge + viewport.height - gutter - top), side, arrow: clamp(anchor.left + anchor.width / 2 - left, 22, width - 22) }
}
