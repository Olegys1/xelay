import { useId, useState } from 'react'
import { BookOpen, ChevronDown, CheckCheck, ClipboardList, HelpCircle, UsersRound } from 'lucide-react'

const STEPS = [
  { icon: UsersRound, title: 'Оберіть групу', body: 'Відкрийте потрібну групу й предмет. Староста або викладач приймає запрошення до спільної роботи.' },
  { icon: ClipboardList, title: 'Дайте завдання', body: 'Додайте опис, термін, посилання чи файл. Студенти отримають його після публікації.' },
  { icon: BookOpen, title: 'Перевірте роботи', body: 'Відкрийте здані роботи під завданням. Внесіть коментар і бали, якщо завдання оцінюється.' },
  { icon: CheckCheck, title: 'Опублікуйте результат', body: 'Поверніть роботу з поясненням або опублікуйте коментар і бали. У журналі бали можна спочатку зберегти в чернетці; кожен студент бачить лише власні опубліковані результати.' },
]

export function TeachingClassroomGuide({ userId, local = false }: { userId: string; local?: boolean }) {
  const stepsId = useId()
  const key = `xelay-classroom-guide:${local ? 'local' : 'account'}:${userId}`
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) !== 'seen' } catch { return true }
  })
  function toggle() {
    setOpen(value => !value)
    if (open) try { localStorage.setItem(key, 'seen') } catch { /* Keep the guide usable if storage is unavailable. */ }
  }
  return <section className="teaching-classroom-guide" aria-label="Як працювати з навчальною групою">
    <button type="button" className="teaching-guide-toggle" aria-expanded={open} aria-controls={stepsId} onClick={toggle}>
      <span><HelpCircle size={17} aria-hidden="true" /><span>Викладання у чотири кроки</span></span><ChevronDown size={16} aria-hidden="true" className={open ? 'teaching-guide-chevron-open' : ''} />
    </button>
    {open && <ol id={stepsId} className="teaching-guide-steps">{STEPS.map((step, index) => <li key={step.title}>
      <span className="teaching-guide-step-number" aria-hidden="true">{index + 1}</span><div><h3><step.icon size={15} aria-hidden="true" />{step.title}</h3><p>{step.body}</p></div>
    </li>)}</ol>}
  </section>
}
