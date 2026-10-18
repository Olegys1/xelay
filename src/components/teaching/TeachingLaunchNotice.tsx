import { Info } from 'lucide-react'
import './teaching.css'

export function TeachingLaunchNotice() {
  return <aside className="teaching-launch-notice" aria-label="Підключення викладачів">
    <Info size={16} aria-hidden="true" />
    <div><p className="teaching-launch-notice-title">Ранній доступ до викладання</p><p>Для роботи з групою потрібні підтверджений статус викладача та прийняте підключення. Xelay поки не має статусу офіційної платформи університету.</p></div>
  </aside>
}
