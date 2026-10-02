import { Link } from '@tanstack/react-router'
import { ArrowUpRight, BookOpen, CalendarDays } from 'lucide-react'
import { parseStudyAssignmentLink } from '../lib/studyAssignmentSharing'

export function StudyAssignmentMessageCard({ body, own = false }: { body: string; own?: boolean }) {
  const assignment = parseStudyAssignmentLink(body)
  if (!assignment) return null
  const seminar = assignment.kind === 'seminar'
  return (
    <Link to="/groups/$id" params={{ id: assignment.groupId }}
      search={{ tab: seminar ? 'seminars' : 'schedule', kind: assignment.kind, date: assignment.date, assignment: assignment.id }}
      className={`mt-3 flex min-h-11 min-w-0 items-start gap-2.5 rounded-xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${own ? 'border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20' : 'border-primary/20 bg-background text-primary hover:bg-primary/5'}`}>
      {seminar ? <BookOpen size={18} aria-hidden="true" className="mt-0.5 shrink-0" /> : <CalendarDays size={18} aria-hidden="true" className="mt-0.5 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{seminar ? 'Відкрити завдання семінару' : 'Відкрити домашнє завдання'}</span>
        <span className={`mt-1 block text-xs ${own ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>Матеріали доступні учасникам навчальної групи.</span>
      </span>
      <ArrowUpRight size={17} aria-hidden="true" className="mt-0.5 shrink-0" />
    </Link>
  )
}
