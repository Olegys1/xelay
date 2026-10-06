import { MiniGuide, type GuideStep } from './MiniGuide'
import type { StudyGroupPermission } from '../lib/studyGroupDeputies'

export type GroupGuideRole = 'representative' | 'deputy' | 'member'
interface StudyGroupGuideProps {
  userId: string
  groupId: string
  role: GroupGuideRole
  permissions: StudyGroupPermission[]
  accessActive: boolean
  onAction: (target: string) => void
}

export function StudyGroupGuide({ userId, groupId, role, permissions, accessActive, onAction }: StudyGroupGuideProps) {
  const leader = role === 'representative'
  const deputy = role === 'deputy'
  const can = (permission: StudyGroupPermission) => accessActive && permissions.includes(permission)
  const steps: GuideStep[] = [{
    id: 'role', title: leader ? 'Ваша група починається з людей' : deputy ? 'Ви — заступник старости' : 'Ваша навчальна група вже поруч',
    text: leader ? 'Запросіть одногрупників за ніком у блоці «Учасники групи». Вони отримають доступ після прийняття запрошення.'
      : deputy ? 'Ви працюєте лише з тими розділами, які дозволила староста. Вона може змінити ваші права будь-коли; доступні кнопки оновляться разом із ними.'
      : 'Переглядайте пари, ДЗ, семінари та матеріали. Змінювати розклад, домашку й завдання можуть староста та заступники з відповідними правами.',
    target: leader ? 'members' : undefined, action: leader ? 'До учасників' : undefined,
  }]
  if (leader) steps.push({ id: 'delegation', title: 'Передайте частину роботи заступникам', text: 'У блоці «Заступники старости» оберіть учасника й конкретні права. Заявка від нього не потрібна. Надалі ви можете змінити дозволи або скасувати призначення.', target: 'deputies', action: 'Показати заступників' })
  if (deputy && (permissions.includes('invite_members') || permissions.includes('remove_members'))) steps.push({ id: 'people', title: 'Ваші права щодо учасників',
    text: [permissions.includes('invite_members') ? 'Ви можете запрошувати одногрупників за ніком, коли доступ групи активний.' : '', permissions.includes('remove_members') ? 'Староста також дозволила вам видаляти учасників і скасовувати запрошення.' : 'Видалення учасників вам не дозволено.'].filter(Boolean).join(' '), target: 'members', action: 'До учасників' })
  steps.push({ id: 'schedule', title: can('schedule') ? 'Налаштуйте пари один раз' : 'Розклад і домашка за датою',
    text: can('schedule') ? 'У «Розклад і ДЗ» додавайте пари з повторенням на власні дати, семестр або рік. На суботу чи неділю можна скопіювати розклад іншого дня. «Наш розклад» показує таблицю тижнів.'
      : 'Оберіть дату для пар і домашніх завдань. «Наш розклад» показує таблицю верхнього й нижнього тижнів. Кнопка поширення дає змогу надіслати ДЗ у чат.', target: 'schedule', action: 'Показати розклад' })
  if (can('homework')) steps.push({ id: 'homework', title: 'Домашка прив’язана до конкретної дати', text: 'Під потрібною парою додайте тему, текст, файли та кілька посилань. Перевіряйте обрану дату: повторення пари не копіює домашнє завдання на весь семестр.', target: 'schedule', action: 'До розкладу і ДЗ' })
  steps.push({ id: 'seminars', title: can('seminars') ? 'Підготуйте семінар для групи' : 'Готуйтеся до семінарів разом',
    text: can('seminars') ? 'У «Семінари» налаштуйте предмет, заняття та питання або командне завдання. Керування файлами й посиланнями семінару — окремий дозвіл для заступників.'
      : can('seminar_resources') ? 'Ви можете додавати файли й посилання до семінарів. Це окреме право: воно не дозволяє змінювати самі питання та розклад.'
      : 'У «Семінари» відкривайте завдання, питання, команди й матеріали. Запис на питання чи до команди доступний, поки діє пробний або оплачений доступ групи.', target: 'seminars', action: 'Відкрити семінари' })
  steps.push({ id: 'materials', title: can('materials') ? 'Зберіть матеріали за предметами' : 'Знаходьте потрібні матеріали',
    text: can('materials') ? 'У «Матеріали» створіть предмет, додайте тему й дату. До теми можна прикріпити презентації, інші файли, посилання та відеопосилання.'
      : 'У «Матеріали» оберіть предмет або знайдіть тему пошуком. Файли й посилання зібрані разом із датою заняття; редагують їх учасники з відповідним дозволом.', target: 'materials', action: 'До матеріалів' })
  steps.push({ id: 'access', title: 'Доступ спільний для всієї групи', text: 'У згорнутому блоці доступу видно залишок пробного періоду або оплачену дату. Розгорніть його для умов і продовження. Особиста підписка «Учасник» для групи не потрібна; після завершення доступу дані залишаються для перегляду.' })
  return <MiniGuide userId={userId} topic={`study-group:${groupId}:${role}`} label={leader ? 'Підказки для старости' : deputy ? 'Підказки для заступника' : 'Підказки для учасника'} steps={steps} onAction={onAction} />
}
