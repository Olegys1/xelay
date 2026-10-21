import { BadgeCheck } from 'lucide-react'

export function TeacherSourceBadge() {
  return <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300"><BadgeCheck size={14} className="shrink-0" aria-hidden="true" />Від викладача</span>
}
