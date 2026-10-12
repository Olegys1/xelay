import { Info } from 'lucide-react'
import './teaching.css'

export function TeachingLaunchNotice() {
  return <aside className="teaching-launch-notice" aria-label="Підключення викладачів">
    <Info size={16} aria-hidden="true" />
    <div><p className="teaching-launch-notice-title">Викладачі — на наступному етапі</p><p>Підключення викладачів заплановано разом з офіційним запуском Xelay в університеті.</p></div>
  </aside>
}
