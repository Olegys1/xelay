import { ExternalLink } from 'lucide-react'
import { getStudyGroupLessonLinks, type StudyGroupLessonLinkSource } from '../lib/studyGroupLinks'

type StudyGroupLessonLinksProps = {
  lesson: StudyGroupLessonLinkSource & { subject: string }
  variant?: 'default' | 'compact'
  className?: string
}

export function StudyGroupLessonLinks({ lesson, variant = 'default', className = '' }: StudyGroupLessonLinksProps) {
  const links = getStudyGroupLessonLinks(lesson)
  if (!links.length) return null
  return <div className={`flex flex-wrap gap-x-4 gap-y-1 ${className}`}>
    {links.map((link) => <a key={link.slot} href={link.url} target="_blank" rel="noopener noreferrer"
      aria-label={`${link.label} на заняття «${lesson.subject}» (відкриється в новій вкладці)`}
      className={`inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${variant === 'compact' ? 'text-xs' : 'text-sm'}`}>
      {variant === 'compact' && <ExternalLink size={12} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{link.label}</span>
    </a>)}
  </div>
}
